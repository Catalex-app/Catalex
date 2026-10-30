use crate::branding::PRODUCT_NAME;
use crate::host::ServiceContext;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const STORAGE_SCHEMA_VERSION: u32 = 1;
const PROJECTS_DIR_NAME: &str = "projects";
const REGISTRY_FILE_NAME: &str = "project-registry.json";
const PROJECT_METADATA_FILE_NAME: &str = "project.json";

// Compilations share this gate from registration through their final cache read.
// Cleanup never waits for a build: an open-project pass can retry later.
pub(crate) static COMPILATION_STORAGE_GATE: tokio::sync::RwLock<()> =
    tokio::sync::RwLock::const_new(());

static REGISTRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStoragePaths {
    pub project_id: String,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub history_dir: PathBuf,
    pub history_exclude_file: PathBuf,
    pub history_settings_file: PathBuf,
    pub sessions_dir: PathBuf,
    pub agent_workspaces_dir: PathBuf,
    pub latex_build_dir: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProjectRegistry {
    version: u32,
    projects: Vec<ProjectRegistryEntry>,
}

impl Default for ProjectRegistry {
    fn default() -> Self {
        Self {
            version: STORAGE_SCHEMA_VERSION,
            projects: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRegistryEntry {
    id: String,
    paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMetadata<'a> {
    version: u32,
    project_id: &'a str,
    current_path: &'a str,
}

pub fn resolve_project_storage(
    app: &ServiceContext,
    project_root: &str,
) -> Result<ProjectStoragePaths, String> {
    resolve_project_storage_in_roots(&app.data_dir, &app.cache_dir, project_root)
}

pub fn prepare_project_storage(
    app: ServiceContext,
    project_root: String,
) -> Result<String, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    cleanup_missing_draft_storage(&app, &paths);
    Ok(paths.project_id)
}

/// Best effort only: cache cleanup must not fail project opening or acceptance.
/// Retained session directories (including recovery journals) are never touched.
pub(crate) fn cleanup_missing_draft_storage(app: &ServiceContext, owner: &ProjectStoragePaths) {
    let Ok(_build_guard) = COMPILATION_STORAGE_GATE.try_write() else {
        return;
    };
    if let Err(error) = cleanup_missing_draft_storage_in_roots(&app.data_dir, &app.cache_dir, owner)
    {
        eprintln!("Draft cache cleanup deferred: {error}");
    }
}

fn cleanup_missing_draft_storage_in_roots(
    app_data_dir: &Path,
    app_cache_dir: &Path,
    owner: &ProjectStoragePaths,
) -> Result<(), String> {
    let _guard = REGISTRY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| concat!(env!("APP_BRAND_NAME"), " project registry lock is poisoned").to_string())?;
    // Do not let a redirected storage root turn cleanup into deletion outside
    // the app-owned tree. Match the Electron storage manager's boundary checks.
    for root in [app_data_dir, app_cache_dir] {
        if !plain_directory_or_missing(root)?
            || !plain_directory_or_missing(&root.join(PROJECTS_DIR_NAME))?
        {
            return Ok(());
        }
    }
    let data_projects =
        fs::canonicalize(app_data_dir.join(PROJECTS_DIR_NAME)).map_err(|e| e.to_string())?;
    let cache_projects =
        fs::canonicalize(app_cache_dir.join(PROJECTS_DIR_NAME)).map_err(|e| e.to_string())?;
    if uuid::Uuid::parse_str(&owner.project_id).is_err() {
        return Ok(());
    }
    let owner_dir = data_projects.join(&owner.project_id);
    let workspaces = owner_dir.join("agent-workspaces");
    if !plain_directory_or_missing(&owner_dir)? || !plain_directory_or_missing(&workspaces)? {
        return Ok(());
    }
    let registry_path = app_data_dir.join(REGISTRY_FILE_NAME);
    let mut registry = load_registry(&registry_path)?;
    if registry.version != STORAGE_SCHEMA_VERSION {
        return Err("Unsupported project registry version".into());
    }
    // An alias or an unexpected registry relationship is not a cleanup target.
    let mut removed = Vec::new();
    for entry in &registry.projects {
        if entry.id == owner.project_id
            || uuid::Uuid::parse_str(&entry.id).is_err()
            || entry.paths.len() != 1
            || registry
                .projects
                .iter()
                .filter(|other| other.id == entry.id)
                .count()
                != 1
        {
            continue;
        }
        let candidate = Path::new(&entry.paths[0]);
        let Some(session) = candidate.parent() else {
            continue;
        };
        let Some(session_id) = session.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if uuid::Uuid::parse_str(session_id).is_err()
            || candidate != workspaces.join(session_id).join("candidate")
            || !path_is_missing(session)?
        {
            continue;
        }
        let data_dir = data_projects.join(&entry.id);
        let cache_dir = cache_projects.join(&entry.id);
        if !plain_directory_or_missing(&data_dir)? || !plain_directory_or_missing(&cache_dir)? {
            continue;
        }
        if !path_is_missing(&data_dir)? {
            let children = fs::read_dir(&data_dir)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            // Empty/missing metadata is allowed after interrupted cleanup. Any
            // history, chat, comments, or other unexpected data is preserved.
            if children
                .iter()
                .any(|child| child.file_name() != PROJECT_METADATA_FILE_NAME)
            {
                continue;
            }
            if let Some(child) = children.first() {
                if !child.file_type().map_err(|e| e.to_string())?.is_file() {
                    continue;
                }
                let metadata: serde_json::Value = match fs::read(child.path())
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                {
                    Some(value) => value,
                    None => continue,
                };
                if metadata["version"] != STORAGE_SCHEMA_VERSION
                    || metadata["projectId"] != entry.id
                    || metadata["currentPath"] != entry.paths[0]
                {
                    continue;
                }
            }
        }
        // Keep the registry entry until both deletions succeed, making retries
        // safe even if the process exits between these operations.
        if !path_is_missing(&cache_dir)? {
            fs::remove_dir_all(&cache_dir).map_err(|e| e.to_string())?;
        }
        let metadata_path = data_dir.join(PROJECT_METADATA_FILE_NAME);
        if !path_is_missing(&metadata_path)? {
            fs::remove_file(&metadata_path).map_err(|e| e.to_string())?;
        }
        if !path_is_missing(&data_dir)? {
            fs::remove_dir(&data_dir).map_err(|e| e.to_string())?;
        }
        removed.push(entry.id.clone());
    }
    if !removed.is_empty() {
        registry
            .projects
            .retain(|entry| !removed.contains(&entry.id));
        write_json(&registry_path, &registry)?;
    }
    Ok(())
}

fn path_is_missing(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

fn plain_directory_or_missing(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_dir()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

fn resolve_project_storage_in_roots(
    app_data_dir: &Path,
    app_cache_dir: &Path,
    project_root: &str,
) -> Result<ProjectStoragePaths, String> {
    let registry_lock = REGISTRY_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = registry_lock
        .lock()
        .map_err(|_| concat!(env!("APP_BRAND_NAME"), " project registry lock is poisoned").to_string())?;

    let canonical_path = canonical_project_path(project_root)?;
    let canonical_path_string = canonical_path.to_string_lossy().to_string();
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("Failed to create {PRODUCT_NAME} app-data directory: {error}"))?;

    let registry_path = app_data_dir.join(REGISTRY_FILE_NAME);
    let mut registry = load_registry(&registry_path)?;
    if registry.version != STORAGE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported {PRODUCT_NAME} project registry version: {}",
            registry.version
        ));
    }

    let project_id = match registry.projects.iter_mut().find(|entry| {
        entry
            .paths
            .iter()
            .any(|path| path == &canonical_path_string)
    }) {
        Some(entry) => entry.id.clone(),
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            registry.projects.push(ProjectRegistryEntry {
                id: id.clone(),
                paths: vec![canonical_path_string.clone()],
            });
            write_json(&registry_path, &registry)?;
            id
        }
    };

    let data_dir = app_data_dir.join(PROJECTS_DIR_NAME).join(&project_id);
    let cache_dir = app_cache_dir.join(PROJECTS_DIR_NAME).join(&project_id);
    let paths = ProjectStoragePaths {
        project_id,
        history_dir: data_dir.join("history.git"),
        history_exclude_file: data_dir.join("history-exclude"),
        history_settings_file: data_dir.join("history-settings.json"),
        sessions_dir: data_dir.join("sessions"),
        agent_workspaces_dir: data_dir.join("agent-workspaces"),
        latex_build_dir: cache_dir.join("latex-build"),
        data_dir,
        cache_dir,
    };

    fs::create_dir_all(&paths.data_dir)
        .map_err(|error| format!("Failed to create project app-data directory: {error}"))?;
    fs::create_dir_all(&paths.cache_dir)
        .map_err(|error| format!("Failed to create project cache directory: {error}"))?;

    write_project_metadata(&paths, &canonical_path_string)?;
    remove_legacy_source_gitlink(&canonical_path, &paths)?;
    Ok(paths)
}

/// Remove the `.git` gitfile created by older automatic-history initializers.
///
/// Those versions placed the repository elsewhere, but told libgit2 that the
/// source project was its worktree. libgit2 consequently wrote a `.git` file
/// into the source root, making a non-Git project look like a user repository.
/// Only exact, known Catalex history targets are removed; all other Git
/// metadata is left untouched.
fn remove_legacy_source_gitlink(
    canonical_project_root: &Path,
    paths: &ProjectStoragePaths,
) -> Result<bool, String> {
    let source_git_path = canonical_project_root.join(".git");
    let metadata = match fs::symlink_metadata(&source_git_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to inspect source Git metadata at {}: {error}",
                source_git_path.display()
            ))
        }
    };

    // A real repository uses a directory. Git worktrees and user-created
    // layouts can use symlinks. Neither belongs to this migration.
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Ok(false);
    }

    let contents = match fs::read_to_string(&source_git_path) {
        Ok(contents) => contents,
        Err(_) => return Ok(false),
    };
    let Some(raw_target) = parse_gitdir_file(&contents) else {
        return Ok(false);
    };
    let target = PathBuf::from(raw_target);
    let resolved_target = if target.is_absolute() {
        target
    } else {
        canonical_project_root.join(target)
    };

    let recognized = paths_refer_to_same_location(&resolved_target, &paths.history_dir)
        || paths_refer_to_same_location(&resolved_target, &paths.history_dir.join(".git"));
    if !recognized {
        return Ok(false);
    }

    fs::remove_file(&source_git_path).map_err(|error| {
        format!(
            "{PRODUCT_NAME} found its legacy source .git link at {}, but could not remove it: {error}. Remove that file manually; automatic history at {} was not changed.",
            source_git_path.display(),
            resolved_target.display()
        )
    })?;
    Ok(true)
}

fn parse_gitdir_file(contents: &str) -> Option<&str> {
    let mut lines = contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    let target = line.strip_prefix("gitdir:")?.trim();
    (!target.is_empty()).then_some(target)
}

fn paths_refer_to_same_location(left: &Path, right: &Path) -> bool {
    if let (Ok(left), Ok(right)) = (fs::canonicalize(left), fs::canonicalize(right)) {
        return left == right;
    }

    let left = normalize_path(left);
    let right = normalize_path(right);
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn canonical_project_path(project_root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(project_root);
    fs::canonicalize(&path)
        .map_err(|error| format!("Failed to resolve project path {}: {error}", path.display()))
}

fn load_registry(path: &Path) -> Result<ProjectRegistry, String> {
    if !path.exists() {
        return Ok(ProjectRegistry::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {PRODUCT_NAME} project registry: {error}"))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse {PRODUCT_NAME} project registry: {error}"))
}

fn write_project_metadata(
    paths: &ProjectStoragePaths,
    canonical_project_path: &str,
) -> Result<(), String> {
    let metadata = ProjectMetadata {
        version: STORAGE_SCHEMA_VERSION,
        project_id: &paths.project_id,
        current_path: canonical_project_path,
    };
    write_json(&paths.data_dir.join(PROJECT_METADATA_FILE_NAME), &metadata)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    crate::project_files::replace_file(path, format!("{serialized}\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, RepositoryInitOptions, Signature};
    use tempfile::TempDir;

    struct DraftStorageFixture {
        _temp: TempDir,
        app: ServiceContext,
        owner: ProjectStoragePaths,
        candidate: PathBuf,
        draft: ProjectStoragePaths,
    }

    impl DraftStorageFixture {
        fn new() -> Self {
            let temp = TempDir::new().unwrap();
            let app = std::sync::Arc::new(crate::host::ServiceState {
                data_dir: temp.path().join("data"),
                cache_dir: temp.path().join("cache"),
                resource_dir: temp.path().join("resources"),
                claude: Default::default(),
                codex: Default::default(),
                pi: Default::default(),
                latex: Default::default(),
                verification: Default::default(),
                comments: Default::default(),
                project_files: Default::default(),
                questions: Default::default(),
                zotero: Default::default(),
            });
            let source = temp.path().join("source");
            fs::create_dir(&source).unwrap();
            let owner = resolve_project_storage(&app, source.to_str().unwrap()).unwrap();
            let candidate = owner
                .agent_workspaces_dir
                .join(uuid::Uuid::new_v4().to_string())
                .join("candidate");
            fs::create_dir_all(&candidate).unwrap();
            let draft = resolve_project_storage(&app, candidate.to_str().unwrap()).unwrap();
            fs::create_dir_all(&draft.latex_build_dir).unwrap();
            fs::write(draft.latex_build_dir.join("main.pdf"), "cached PDF").unwrap();
            Self {
                _temp: temp,
                app,
                owner,
                candidate,
                draft,
            }
        }
        fn cleanup(&self) {
            cleanup_missing_draft_storage_in_roots(
                &self.app.data_dir,
                &self.app.cache_dir,
                &self.owner,
            )
            .unwrap();
        }
        fn remove_session(&self) {
            fs::remove_dir_all(self.candidate.parent().unwrap()).unwrap();
        }
        fn registered(&self) -> bool {
            load_registry(&self.app.data_dir.join(REGISTRY_FILE_NAME))
                .unwrap()
                .projects
                .iter()
                .any(|entry| entry.id == self.draft.project_id)
        }
    }

    #[test]
    fn draft_cleanup_preserves_live_and_recoverable_sessions() {
        let fixture = DraftStorageFixture::new();
        for status in [
            "active",
            "review",
            "failed",
            "cancelled",
            "resume-backup",
            "settled",
        ] {
            fs::write(
                fixture.candidate.parent().unwrap().join("session.json"),
                status,
            )
            .unwrap();
            fixture.cleanup();
            assert!(fixture.registered());
            assert!(fixture.draft.latex_build_dir.join("main.pdf").exists());
        }
        // Missing worktree alone is insufficient: recovery metadata still exists.
        fs::remove_dir_all(&fixture.candidate).unwrap();
        fixture.cleanup();
        assert!(fixture.registered());
        assert!(fixture.draft.cache_dir.exists());
    }

    #[test]
    fn draft_cleanup_removes_only_missing_draft_storage_and_is_repeatable() {
        let fixture = DraftStorageFixture::new();
        fs::create_dir_all(&fixture.owner.history_dir).unwrap();
        fs::write(fixture.owner.history_dir.join("keep"), "accepted history").unwrap();
        fs::create_dir_all(&fixture.owner.sessions_dir).unwrap();
        fs::write(fixture.owner.sessions_dir.join("chat.json"), "chat record").unwrap();
        fs::write(fixture.owner.cache_dir.join("keep.pdf"), "source PDF").unwrap();
        fixture.remove_session();
        fixture.cleanup();
        fixture.cleanup();
        assert!(!fixture.registered());
        assert!(!fixture.draft.data_dir.exists());
        assert!(!fixture.draft.cache_dir.exists());
        assert!(fixture.owner.history_dir.join("keep").exists());
        assert!(fixture.owner.sessions_dir.join("chat.json").exists());
        assert!(fixture.owner.cache_dir.join("keep.pdf").exists());
    }

    #[test]
    fn draft_cleanup_retries_partial_deletion() {
        for remove_data in [false, true] {
            let fixture = DraftStorageFixture::new();
            fixture.remove_session();
            fs::remove_dir_all(&fixture.draft.cache_dir).unwrap();
            fs::remove_file(fixture.draft.data_dir.join(PROJECT_METADATA_FILE_NAME)).unwrap();
            if remove_data {
                fs::remove_dir(&fixture.draft.data_dir).unwrap();
            }
            assert!(fixture.registered());
            fixture.cleanup();
            assert!(!fixture.registered());
            assert!(!fixture.draft.data_dir.exists());
        }
    }

    #[test]
    fn draft_cleanup_preserves_unexpected_data_and_metadata_mismatch() {
        let fixture = DraftStorageFixture::new();
        fixture.remove_session();
        let extra = fixture.draft.data_dir.join("sessions");
        fs::create_dir(&extra).unwrap();
        fixture.cleanup();
        assert!(fixture.registered());
        assert!(fixture.draft.cache_dir.exists());
        fs::remove_dir(extra).unwrap();
        fs::write(
            fixture.draft.data_dir.join(PROJECT_METADATA_FILE_NAME),
            "{}",
        )
        .unwrap();
        fixture.cleanup();
        assert!(fixture.registered());
        assert!(fixture.draft.cache_dir.exists());
    }

    #[test]
    fn draft_cleanup_is_scoped_to_owner_and_rejects_aliases() {
        let fixture = DraftStorageFixture::new();
        fixture.remove_session();
        let other = fixture._temp.path().join("other");
        fs::create_dir(&other).unwrap();
        let other = resolve_project_storage(&fixture.app, other.to_str().unwrap()).unwrap();
        cleanup_missing_draft_storage_in_roots(
            &fixture.app.data_dir,
            &fixture.app.cache_dir,
            &other,
        )
        .unwrap();
        assert!(fixture.registered());
        let path = fixture.app.data_dir.join(REGISTRY_FILE_NAME);
        let mut registry = load_registry(&path).unwrap();
        registry
            .projects
            .iter_mut()
            .find(|entry| entry.id == fixture.draft.project_id)
            .unwrap()
            .paths
            .push("/some/other/project".into());
        write_json(&path, &registry).unwrap();
        fixture.cleanup();
        assert!(fixture.registered());
        assert!(fixture.draft.cache_dir.exists());
    }

    #[tokio::test]
    async fn draft_cleanup_skips_in_flight_compilation() {
        let fixture = DraftStorageFixture::new();
        fixture.remove_session();
        let build = COMPILATION_STORAGE_GATE.read().await;
        cleanup_missing_draft_storage(&fixture.app, &fixture.owner);
        assert!(fixture.registered());
        assert!(fixture.draft.cache_dir.exists());
        drop(build);
        // Exercise the retry without a global gate shared by concurrent tests.
        fixture.cleanup();
        assert!(!fixture.registered());
    }

    #[cfg(unix)]
    #[test]
    fn draft_cleanup_preserves_redirected_storage_roots() {
        use std::os::unix::fs::symlink;
        for target in ["data", "cache", "data-projects", "cache-projects"] {
            let fixture = DraftStorageFixture::new();
            fixture.remove_session();
            let root = match target {
                "data" => fixture.app.data_dir.clone(),
                "cache" => fixture.app.cache_dir.clone(),
                "data-projects" => fixture.app.data_dir.join(PROJECTS_DIR_NAME),
                _ => fixture.app.cache_dir.join(PROJECTS_DIR_NAME),
            };
            let outside = fixture._temp.path().join("redirected");
            fs::rename(&root, &outside).unwrap();
            symlink(&outside, &root).unwrap();
            fixture.cleanup();
            assert!(fixture.registered(), "{target}");
            assert!(
                fixture
                    .draft
                    .cache_dir
                    .join("latex-build/main.pdf")
                    .exists(),
                "{target}"
            );
            assert!(
                fixture
                    .draft
                    .data_dir
                    .join(PROJECT_METADATA_FILE_NAME)
                    .exists(),
                "{target}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn draft_cleanup_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        for target in ["session", "cache", "data", "workspaces"] {
            let fixture = DraftStorageFixture::new();
            fixture.remove_session();
            let outside = fixture._temp.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("keep"), "keep").unwrap();
            let link = match target {
                "session" => fixture.candidate.parent().unwrap(),
                "cache" => &fixture.draft.cache_dir,
                "data" => &fixture.draft.data_dir,
                _ => &fixture.owner.agent_workspaces_dir,
            };
            if link.exists() {
                fs::remove_dir_all(link).unwrap();
            }
            symlink(&outside, link).unwrap();
            fixture.cleanup();
            assert!(fixture.registered(), "{target}");
            assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "keep");
        }
    }

    #[test]
    fn assigns_stable_ids_and_separates_data_from_cache() {
        let app_data = TempDir::new().unwrap();
        let app_cache = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();

        let first = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project.path().to_string_lossy(),
        )
        .unwrap();
        let second = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project.path().to_string_lossy(),
        )
        .unwrap();

        assert_eq!(first.project_id, second.project_id);
        assert!(first.data_dir.starts_with(app_data.path()));
        assert!(first.cache_dir.starts_with(app_cache.path()));
        assert_eq!(first.history_dir, first.data_dir.join("history.git"));
        assert_eq!(
            first.history_settings_file,
            first.data_dir.join("history-settings.json")
        );
        assert_eq!(
            first.agent_workspaces_dir,
            first.data_dir.join("agent-workspaces")
        );
        assert_eq!(first.latex_build_dir, first.cache_dir.join("latex-build"));
    }

    #[test]
    fn gives_distinct_projects_distinct_ids() {
        let app_data = TempDir::new().unwrap();
        let app_cache = TempDir::new().unwrap();
        let project_a = TempDir::new().unwrap();
        let project_b = TempDir::new().unwrap();

        let a = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project_a.path().to_string_lossy(),
        )
        .unwrap();
        let b = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project_b.path().to_string_lossy(),
        )
        .unwrap();

        assert_ne!(a.project_id, b.project_id);
    }

    #[test]
    fn leaves_existing_project_contents_untouched() {
        let app_data = TempDir::new().unwrap();
        let app_cache = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let existing_file = project.path().join(".texbuddy/legacy.txt");
        fs::create_dir_all(existing_file.parent().unwrap()).unwrap();
        fs::write(&existing_file, "leave me alone").unwrap();

        resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project.path().to_string_lossy(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(existing_file).unwrap(), "leave me alone");
    }

    #[test]
    fn removes_legacy_app_history_gitlink_and_preserves_snapshots_and_labels() {
        let app_data = TempDir::new().unwrap();
        let app_cache = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "legacy snapshot").unwrap();

        let paths = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project.path().to_string_lossy(),
        )
        .unwrap();

        // Reproduce the old initializer: the repository lives in app data,
        // while libgit2 writes a gitdir link into the source worktree.
        let mut options = RepositoryInitOptions::new();
        options
            .bare(false)
            .workdir_path(project.path())
            .no_reinit(true);
        let repo = Repository::init_opts(&paths.history_dir, &options).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("main.tex")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = Signature::now("Catalex", "history@catalex.local").unwrap();
        let commit_oid = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "legacy snapshot",
                &tree,
                &[],
            )
            .unwrap();
        let commit = repo.find_commit(commit_oid).unwrap();
        repo.tag_lightweight("keep-me", commit.as_object(), false)
            .unwrap();
        drop(commit);
        drop(tree);
        drop(index);
        drop(repo);

        assert!(project.path().join(".git").is_file());
        let resolved = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project.path().to_string_lossy(),
        )
        .unwrap();

        assert!(!project.path().join(".git").exists());
        assert!(Repository::discover(project.path()).is_err());
        let preserved_repo = Repository::open(&resolved.history_dir).unwrap();
        assert_eq!(preserved_repo.head().unwrap().target(), Some(commit_oid));
        assert_eq!(
            preserved_repo
                .find_reference("refs/tags/keep-me")
                .unwrap()
                .target(),
            Some(commit_oid)
        );
    }

    #[test]
    fn removes_app_history_gitlink_even_when_history_is_missing() {
        let app_data = TempDir::new().unwrap();
        let app_cache = TempDir::new().unwrap();

        let app_history_project = TempDir::new().unwrap();
        let paths = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &app_history_project.path().to_string_lossy(),
        )
        .unwrap();
        fs::write(
            app_history_project.path().join(".git"),
            format!("gitdir: {}\n", paths.history_dir.display()),
        )
        .unwrap();

        resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &app_history_project.path().to_string_lossy(),
        )
        .unwrap();

        assert!(!app_history_project.path().join(".git").exists());
    }

    #[test]
    fn preserves_real_git_directory_and_unrecognized_gitdir_file() {
        let app_data = TempDir::new().unwrap();
        let app_cache = TempDir::new().unwrap();
        let repository_project = TempDir::new().unwrap();
        Repository::init(repository_project.path()).unwrap();

        resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &repository_project.path().to_string_lossy(),
        )
        .unwrap();

        assert!(repository_project.path().join(".git").is_dir());
        assert!(Repository::open(repository_project.path()).is_ok());

        let linked_project = TempDir::new().unwrap();
        let user_gitdir = linked_project.path().join("user-owned.git");
        fs::write(
            linked_project.path().join(".git"),
            format!("gitdir: {}\n", user_gitdir.display()),
        )
        .unwrap();

        resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &linked_project.path().to_string_lossy(),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(linked_project.path().join(".git")).unwrap(),
            format!("gitdir: {}\n", user_gitdir.display())
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_symlinked_git_metadata_even_when_it_targets_history() {
        use std::os::unix::fs::symlink;

        let app_data = TempDir::new().unwrap();
        let app_cache = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let paths = resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project.path().to_string_lossy(),
        )
        .unwrap();
        fs::write(&paths.history_dir, "not a repository").unwrap();
        symlink(&paths.history_dir, project.path().join(".git")).unwrap();

        resolve_project_storage_in_roots(
            app_data.path(),
            app_cache.path(),
            &project.path().to_string_lossy(),
        )
        .unwrap();

        assert!(fs::symlink_metadata(project.path().join(".git"))
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
