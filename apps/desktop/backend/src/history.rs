use git2::{
    DiffOptions, IndexAddOption, ObjectType, Oid, Repository, RepositoryState, Signature,
    StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use crate::project_storage::{resolve_project_storage, ProjectStoragePaths};

const HISTORY_SETTINGS_SCHEMA_VERSION: u32 = 1;
const DEFAULT_HISTORY_STORAGE_LIMIT_BYTES: u64 = 250 * 1024 * 1024;
const MIN_HISTORY_STORAGE_LIMIT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_HISTORY_STORAGE_LIMIT_BYTES: u64 = 100 * 1024 * 1024 * 1024;
const HISTORY_RECENT_SNAPSHOT_FLOOR: usize = 50;
const HISTORY_LOOSE_OBJECT_MAINTENANCE_THRESHOLD: usize = 256;

static HISTORY_OPERATION_LOCK: Mutex<()> = Mutex::new(());

// ─── Types ───

#[derive(Serialize, Clone)]
pub struct SnapshotInfo {
    pub id: String,
    pub message: String,
    pub timestamp: i64,
    pub labels: Vec<String>,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStorageInfo {
    pub usage_bytes: u64,
    pub limit_bytes: u64,
    pub snapshot_count: u64,
    pub protected_snapshot_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistorySettings {
    version: u32,
    storage_limit_bytes: u64,
}

#[derive(Clone, Copy)]
struct HistoryMaintenancePolicy {
    storage_limit_bytes: u64,
    recent_snapshot_floor: usize,
    loose_object_threshold: usize,
    force_compaction: bool,
}

#[derive(Debug, Default)]
struct HistoryMaintenanceOutcome {
    rewritten_oids: HashMap<Oid, Oid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HistoryMaintenanceStage {
    BeforeReferenceUpdate,
    BeforeGarbageCollection,
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            version: HISTORY_SETTINGS_SCHEMA_VERSION,
            storage_limit_bytes: DEFAULT_HISTORY_STORAGE_LIMIT_BYTES,
        }
    }
}

#[derive(Serialize)]
pub struct FileDiff {
    pub file_path: String,
    pub status: String, // "added" | "modified" | "deleted"
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

#[derive(Serialize)]
pub struct GitHeadFileContent {
    pub repo_found: bool,
    pub head_content: Option<String>,
    pub ignored: bool,
}

#[derive(Serialize)]
pub struct GitConflictFileContent {
    pub conflicted: bool,
    pub ancestor_content: Option<String>,
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_contents: Option<Vec<crate::text_merge::ConflictSegment>>,
    pub current_content: Option<String>,
    pub incoming_content: Option<String>,
}

#[derive(Serialize)]
pub struct GitPanelStatus {
    pub repo_found: bool,
    pub branch: Option<String>,
    pub upstream_branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub operation: Option<String>,
    pub can_push: bool,
}

#[derive(Serialize)]
pub struct GitCommandResult {
    pub success: bool,
    pub message: String,
}

#[derive(Serialize)]
pub struct GitUpstreamStatus {
    pub remote_name: Option<String>,
    pub remote_url: Option<String>,
    pub upstream_branch: Option<String>,
    pub local_branch: Option<String>,
}

#[derive(Serialize)]
pub struct GitRemoteInspection {
    pub branches: Vec<String>,
}

#[derive(Serialize)]
pub struct GitRemoteEntry {
    pub name: String,
    pub url: String,
    pub local_branch: Option<String>,
    pub remote_branch: Option<String>,
}

#[derive(Serialize)]
pub struct GitRemoteConfiguration {
    pub remotes: Vec<GitRemoteEntry>,
    pub local_branches: Vec<String>,
    pub current_branch: Option<String>,
}

#[derive(Serialize)]
pub struct GitPullStatus {
    pub can_pull: bool,
    pub behind: u32,
    pub behind_commits: Vec<String>,
}

#[derive(Serialize)]
pub struct GitPushRecoveryPreview {
    pub remote_name: String,
    pub remote_branch: String,
    pub conflicted_files: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct GitStashEntry {
    pub reference: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
pub struct GitChangedFile {
    pub path: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Serialize)]
pub struct GitHistoryEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub refs: Vec<String>,
    pub is_head: bool,
}

#[derive(Serialize)]
pub struct GitGraphCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub committed_at: i64,
    pub refs: Vec<String>,
    pub parents: Vec<String>,
    pub is_head: bool,
}

#[derive(Serialize)]
pub struct GitFileLineStats {
    pub file_path: String,
    pub added: u32,
    pub deleted: u32,
}

#[derive(Serialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub is_current: bool,
}

// ─── Helpers ───

fn open_repo_at(project_root: &str, paths: &ProjectStoragePaths) -> Result<Repository, String> {
    let repo = Repository::open(&paths.history_dir)
        .map_err(|e| format!("Failed to open history repo: {}", e))?;
    repo.set_workdir(Path::new(project_root), false)
        .map_err(|e| format!("Failed to bind history repo to project: {}", e))?;
    Ok(repo)
}

fn open_project_repo(project_root: &str) -> Result<Repository, String> {
    Repository::discover(project_root)
        .map_err(|e| format!("Failed to open project git repo: {}", e))
}

fn repository_operation(state: RepositoryState) -> Option<&'static str> {
    match state {
        RepositoryState::Clean => None,
        RepositoryState::Merge => Some("merge"),
        RepositoryState::Revert | RepositoryState::RevertSequence => Some("revert"),
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => Some("cherry-pick"),
        RepositoryState::Bisect => Some("bisect"),
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => Some("rebase"),
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => Some("am"),
    }
}

fn merge_operation_touched_paths(repo: &Repository) -> Result<HashSet<String>, String> {
    if repo.state() != RepositoryState::Merge {
        return Ok(HashSet::new());
    }

    let head = repo
        .head()
        .and_then(|reference| reference.peel_to_commit())
        .map_err(|error| format!("Failed to read merge HEAD: {error}"))?;
    let merge_heads = fs::read_to_string(repo.path().join("MERGE_HEAD"))
        .map_err(|error| format!("Failed to read MERGE_HEAD: {error}"))?;
    let mut paths = HashSet::new();

    for raw_oid in merge_heads
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let merge_oid = Oid::from_str(raw_oid)
            .map_err(|error| format!("Invalid MERGE_HEAD object ID: {error}"))?;
        let incoming = repo
            .find_commit(merge_oid)
            .map_err(|error| format!("Failed to read incoming merge commit: {error}"))?;
        let incoming_tree = incoming
            .tree()
            .map_err(|error| format!("Failed to read incoming merge tree: {error}"))?;
        let base_tree = repo
            .merge_base(head.id(), incoming.id())
            .ok()
            .and_then(|oid| repo.find_commit(oid).ok())
            .and_then(|commit| commit.tree().ok());
        let diff = repo
            .diff_tree_to_tree(base_tree.as_ref(), Some(&incoming_tree), None)
            .map_err(|error| format!("Failed to read incoming merge changes: {error}"))?;

        for delta in diff.deltas() {
            let path = if delta.status() == git2::Delta::Deleted {
                delta.old_file().path()
            } else {
                delta.new_file().path().or_else(|| delta.old_file().path())
            };
            let Some(path) = path else {
                continue;
            };
            let normalized = path.to_string_lossy().replace('\\', "/");
            if !normalized.is_empty() {
                paths.insert(normalized);
            }
        }
    }

    Ok(paths)
}

fn repository_conflicted_paths(repo: &Repository) -> Result<Vec<String>, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to read git conflicts: {}", e))?;
    let mut paths: Vec<String> = statuses
        .iter()
        .filter(|entry| entry.status().is_conflicted())
        .filter_map(|entry| entry.path().map(|path| path.replace('\\', "/")))
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn conflict_message(count: usize) -> &'static str {
    if count == 1 {
        "Conflict detected. Resolve it to continue."
    } else {
        "Conflicts detected. Resolve them to continue."
    }
}

fn conflict_result(project_root: &str, _context: &str) -> Result<Option<GitCommandResult>, String> {
    let repo = open_project_repo(project_root)?;
    let paths = repository_conflicted_paths(&repo)?;
    if paths.is_empty() {
        return Ok(None);
    }

    Ok(Some(GitCommandResult {
        success: false,
        message: conflict_message(paths.len()).to_string(),
    }))
}

fn run_git(project_root: &str, args: &[&str]) -> Result<std::process::Output, String> {
    crate::git_credentials::run(project_root, args)
}

fn run_git_dynamic(project_root: &str, args: &[String]) -> Result<std::process::Output, String> {
    run_git(
        project_root,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )
}

fn run_git_without_editor(
    project_root: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    Command::new("git")
        .current_dir(project_root)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git {:?}: {}", args, e))
}

fn parse_overleaf_clone_command(command: &str) -> Result<(String, String), String> {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != "git" || parts[1] != "clone" {
        return Err(
            "Enter the complete Overleaf command in the form: git clone https://git@git.overleaf.com/PROJECT_ID"
                .to_string(),
        );
    }

    let clone_url = parts[2];
    let location = clone_url
        .strip_prefix("https://")
        .ok_or_else(|| "The Overleaf clone URL must use HTTPS".to_string())?;
    let (authority, path) = location
        .split_once('/')
        .ok_or_else(|| "The Overleaf clone URL is missing a project ID".to_string())?;
    if authority != "git@git.overleaf.com" && authority != "git.overleaf.com" {
        return Err("The clone URL must point to git.overleaf.com".to_string());
    }
    if path.contains(['?', '#']) {
        return Err("The Overleaf clone URL cannot contain a query or fragment".to_string());
    }

    let project_name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .strip_suffix(".git")
        .unwrap_or_else(|| {
            path.trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or_default()
        });
    if project_name.is_empty()
        || !project_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("The Overleaf clone URL has an invalid project ID".to_string());
    }

    Ok((clone_url.to_string(), project_name.to_string()))
}

fn normalize_unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut unique_paths = Vec::new();
    let mut seen = HashSet::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.replace('\\', "/");
        if seen.insert(normalized.clone()) {
            unique_paths.push(normalized);
        }
    }
    unique_paths
}

fn delta_project_relative_path(
    delta: &git2::DiffDelta<'_>,
    repo_workdir: &Path,
    project_root: &Path,
) -> Option<String> {
    let repo_relative = delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())?;
    let absolute = repo_workdir.join(repo_relative);
    let project_relative = absolute.strip_prefix(project_root).ok()?;
    Some(project_relative.to_string_lossy().replace('\\', "/"))
}

fn default_signature() -> Result<Signature<'static>, String> {
    Signature::now(env!("APP_BRAND_NAME"), "history@catalex.local")
        .map_err(|e| format!("Failed to create signature: {}", e))
}

const LABEL_PREFIX: &str = "catalex-labels-v1/";

fn display_label(name: &str) -> Option<String> {
    let Some(encoded) = name.strip_prefix(LABEL_PREFIX) else {
        return Some(name.to_string());
    };
    let (encoded_text, association) = encoded.rsplit_once('/')?;
    let hex = encoded_text.strip_suffix("/at")?.replace('/', "");
    if association.len() != 40
        || !association.bytes().all(|b| b.is_ascii_hexdigit())
        || hex.len() % 2 != 0
    {
        return None;
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<_>>>()?;
    String::from_utf8(bytes)
        .ok()
        .filter(|text| !text.is_empty())
}

fn label_name(label: &str, oid: Oid) -> String {
    let encoded: String = label
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let chunks = encoded
        .as_bytes()
        .chunks(120)
        .map(|chunk| std::str::from_utf8(chunk).expect("hex is ASCII"))
        .collect::<Vec<_>>()
        .join("/");
    format!("{LABEL_PREFIX}{chunks}/at/{oid}")
}

fn validate_label(label: &str) -> Result<&str, String> {
    let label = label.trim();
    if label.is_empty() || label.len() > 256 || label.chars().any(char::is_control) {
        return Err("Use a label of 1–256 UTF-8 bytes without control characters".into());
    }
    if matches!(label, "Agent" | "Comments") {
        return Err(format!("{label} is reserved for automatic labels"));
    }
    Ok(label)
}

pub fn history_label_counts(
    app: crate::host::ServiceContext,
    project_root: String,
) -> Result<std::collections::BTreeMap<String, usize>, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    let _guard = lock_history_operations();
    let repo = open_repo_at(&project_root, &paths)?;
    let mut counts = std::collections::BTreeMap::new();
    for labels in tag_map(&repo).values() {
        for label in labels {
            if !matches!(label.trim(), "Agent" | "Comments") {
                *counts.entry(label.clone()).or_insert(0) += 1;
            }
        }
    }
    Ok(counts)
}

/// Decode custom labels and group unique assignments by their current commit.
fn tag_map(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(tags) = repo.tag_names(None) {
        for tag_name in tags.iter().flatten() {
            if let Ok(reference) = repo.revparse_single(&format!("refs/tags/{tag_name}")) {
                let oid = reference
                    .peel_to_commit()
                    .map(|c| c.id())
                    .unwrap_or(reference.id());
                if let Some(label) = display_label(tag_name) {
                    let labels = map.entry(oid).or_default();
                    if !labels.contains(&label) {
                        labels.push(label);
                    }
                }
            }
        }
    }
    map
}
const NON_TEXT_EDITOR_SUFFIXES: &[&str] = &[
    // Images and document media use a dedicated viewer rather than the text editor.
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".bmp", ".webp", ".tif", ".tiff", ".heic", ".avif",
    ".ico", ".eps", ".pdf", // Office and design binaries.
    ".hwp", ".hwpx", ".doc", ".docx", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx", ".accdb", ".mdb",
    ".psd", ".ai", ".sketch", ".fig", // Archives and executables.
    ".zip", ".rar", ".7z", ".tar", ".gz", ".exe", ".dll", ".so", ".dylib", ".o", ".obj", ".bin",
    ".dat", ".iso", ".dmg", ".msi", ".wasm", ".class", ".jar",
    // Audio, video, fonts, and databases.
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac", ".ttf", ".otf", ".woff", ".woff2",
    ".sqlite", ".db",
];

fn has_text_editor_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().to_ascii_lowercase();
    !NON_TEXT_EDITOR_SUFFIXES
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

// Stored only in the private snapshot tree, never written into the project.
const HISTORY_COVERAGE_PATH: &str = ".catalex/history-format";
const HISTORY_COMMENTS_PATH: &str = ".catalex/comments.json";
const HISTORY_COVERAGE: &[u8] = b"project-assets-v1\n";

fn is_history_internal_path(path: &Path) -> bool { crate::private_files::internal(path) }

fn history_tracks_assets(repo: &Repository, tree: &git2::Tree<'_>) -> bool {
    tree.get_path(Path::new(HISTORY_COVERAGE_PATH))
        .ok()
        .and_then(|entry| repo.find_blob(entry.id()).ok())
        .is_some_and(|blob| blob.content() == HISTORY_COVERAGE)
}

fn rebuild_history_index(repo: &Repository, paths: &ProjectStoragePaths) -> Result<Oid, String> {
    let workdir = repo.workdir().ok_or("No automatic history workdir")?;
    let mut index = repo
        .index()
        .map_err(|error| format!("Failed to get automatic history index: {error}"))?;
    index
        .clear()
        .map_err(|error| format!("Failed to reset automatic history index: {error}"))?;
    let mut include_project_files = |relative_path: &Path, _pathspec: &[u8]| {
        let full_path = workdir.join(relative_path);
        if !crate::private_files::excluded(workdir, relative_path)
            && fs::symlink_metadata(&full_path).is_ok_and(|metadata| {
                !metadata.file_type().is_symlink() && (metadata.is_file() || metadata.is_dir())
            })

        {
            0
        } else {
            1
        }
    };
    index
        .add_all(
            ["*"].iter(),
            IndexAddOption::FORCE,
            Some(&mut include_project_files),
        )
        .map_err(|error| format!("Failed to add project files to automatic history: {error}"))?;
    index
        .write()
        .map_err(|error| format!("Failed to write automatic history index: {error}"))?;
    let tree_oid = index
        .write_tree()
        .map_err(|error| format!("Failed to write automatic history tree: {error}"))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|error| error.to_string())?;
    let marker = repo
        .blob(HISTORY_COVERAGE)
        .map_err(|error| error.to_string())?;
    let mut metadata = repo.treebuilder(None).map_err(|error| error.to_string())?;
    metadata
        .insert("history-format", marker, 0o100644)
        .map_err(|error| error.to_string())?;
    let storage = paths.data_dir.join("comments");
    let comments = crate::comments::capture_reconciled_history(workdir, &storage)?;
    let bytes = serde_json::to_vec(&comments).map_err(|error| error.to_string())?;
    let blob = repo.blob(&bytes).map_err(|error| error.to_string())?;
    metadata.insert("comments.json", blob, 0o100644).map_err(|error| error.to_string())?;
    let metadata_oid = metadata.write().map_err(|error| error.to_string())?;
    let mut builder = repo
        .treebuilder(Some(&tree))
        .map_err(|error| error.to_string())?;
    builder
        .insert(".catalex", metadata_oid, 0o040000)
        .map_err(|error| error.to_string())?;
    builder.write().map_err(|error| error.to_string())
}

fn collect_tree_files(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    prefix: &Path,
    assets: bool,
    files: &mut HashMap<PathBuf, (Oid, i32)>,
) -> Result<(), String> {
    for entry in tree.iter() {
        let name = entry
            .name()
            .ok_or("History contains an invalid file name")?;
        let relative_path = prefix.join(name);
        if is_history_internal_path(&relative_path) {
            continue;
        }
        match entry.kind() {
            Some(ObjectType::Tree) => {
                let child = repo
                    .find_tree(entry.id())
                    .map_err(|error| error.to_string())?;
                collect_tree_files(repo, &child, &relative_path, assets, files)?;
            }
            Some(ObjectType::Blob) if entry.filemode() != 0o120000 => {
                if assets {
                    files.insert(relative_path, (entry.id(), entry.filemode()));
                } else if has_text_editor_path(&relative_path) {
                    let blob = repo
                        .find_blob(entry.id())
                        .map_err(|error| error.to_string())?;
                    if !blob.is_binary() && std::str::from_utf8(blob.content()).is_ok() {
                        files.insert(relative_path, (entry.id(), entry.filemode()));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn tree_history_files(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    assets: bool,
) -> Result<HashMap<PathBuf, (Oid, i32)>, String> {
    let mut files = HashMap::new();
    collect_tree_files(repo, tree, Path::new(""), assets, &mut files)?;
    Ok(files)
}

fn restore_tree_history_files(
    repo: &Repository,
    target_tree: &git2::Tree<'_>,
) -> Result<(), String> {
    restore_tree_history_files_with_partial(repo, target_tree, None)
}

fn restore_tree_history_files_with_partial(
    repo: &Repository,
    target_tree: &git2::Tree<'_>,
    partially_restored: Option<&git2::Tree<'_>>,
) -> Result<(), String> {
    let workdir = repo.workdir().ok_or("No automatic history workdir")?;
    // Older snapshots do not claim to cover assets, even if a legacy tree
    // happens to contain one. Preserve current media when restoring those trees.
    let assets = history_tracks_assets(repo, target_tree);
    let target_files = tree_history_files(repo, target_tree, assets)?;
    let mut current_files = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .and_then(|commit| commit.tree().ok())
        .map(|tree| tree_history_files(repo, &tree, assets))
        .transpose()?
        .unwrap_or_default();
    if let Some(partial) = partially_restored {
        current_files.extend(tree_history_files(repo, partial, assets)?);
    }

    // Validate all paths before any mutation; never traverse a symlink into
    // another directory or overwrite a directory with a historical file.
    for relative_path in target_files.keys().chain(current_files.keys()) {
        let mut full_path = workdir.to_path_buf();
        for component in relative_path.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err("Invalid history path".into());
            }
            full_path.push(component);
            if fs::symlink_metadata(&full_path)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(format!(
                    "Cannot restore through a symbolic link: {}",
                    full_path.display()
                ));
            }
        }
        if target_files.contains_key(relative_path) && full_path.is_dir() {
            return Err(format!(
                "Cannot restore file because a directory exists at {}",
                full_path.display()
            ));
        }
    }
    for relative_path in current_files.keys() {
        if target_files.contains_key(relative_path) {
            continue;
        }
        let full_path = workdir.join(relative_path);
        if full_path.is_file() {
            fs::remove_file(&full_path).map_err(|error| {
                format!(
                    "Failed to remove restored file {}: {error}",
                    full_path.display()
                )
            })?;
        }
    }
    for (relative_path, (oid, mode)) in target_files {
        let full_path = workdir.join(&relative_path);
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create restored directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let blob = repo.find_blob(oid).map_err(|error| error.to_string())?;
        fs::write(&full_path, blob.content())
            .map_err(|error| format!("Failed to restore file {}: {error}", full_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &full_path,
                fs::Permissions::from_mode(if mode == 0o100755 { 0o755 } else { 0o644 }),
            )
            .map_err(|error| format!("Failed to restore file permissions: {error}"))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(())
}

fn ensure_excludes(paths: &ProjectStoragePaths, repo: &Repository) -> Result<(), String> {
    let excludes_path = &paths.history_exclude_file;
    let content = crate::private_files::git_excludes();
    let existing = match fs::read_to_string(excludes_path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Failed to read history exclusions: {error}")),
    };
    let updated = if let Some(existing) = existing.as_ref() {
        let mut updated = existing
            .lines()
            .filter(|line| {
                !matches!(
                    line.trim(),
                    "/comments.json"
                        | "# Catalex project comments"
                        | "# Output"
                        | "# Files shown outside Catalex's text editor"
                ) && !NON_TEXT_EDITOR_SUFFIXES
                    .iter()
                    .any(|suffix| line.trim() == format!("*{suffix}"))
            })
            .collect::<Vec<_>>()
            .join("\n");
        updated.push('\n');
        for required in content
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            if !updated.lines().any(|line| line.trim() == required) {
                updated.push_str(&format!("\n{required}\n"));
            }
        }
        updated
    } else {
        content.to_string()
    };
    if existing.as_ref() != Some(&updated) {
        fs::write(excludes_path, updated)
            .map_err(|error| format!("Failed to update history exclusions: {error}"))?;
    }
    repo.config()
        .and_then(|mut config| {
            config.set_str("core.excludesFile", &excludes_path.to_string_lossy())
        })
        .map_err(|error| format!("Failed to configure history exclusions: {error}"))?;
    Ok(())
}

fn load_history_settings(paths: &ProjectStoragePaths) -> Result<HistorySettings, String> {
    if !paths.history_settings_file.exists() {
        return Ok(HistorySettings::default());
    }

    let raw = fs::read_to_string(&paths.history_settings_file).map_err(|error| {
        format!(
            "Failed to read automatic history settings {}: {error}",
            paths.history_settings_file.display()
        )
    })?;
    let settings: HistorySettings = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Failed to parse automatic history settings {}: {error}",
            paths.history_settings_file.display()
        )
    })?;
    if settings.version != HISTORY_SETTINGS_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported automatic history settings version: {}",
            settings.version
        ));
    }
    validate_history_storage_limit(settings.storage_limit_bytes)?;
    Ok(settings)
}

fn save_history_settings(
    paths: &ProjectStoragePaths,
    settings: &HistorySettings,
) -> Result<(), String> {
    fs::create_dir_all(&paths.data_dir).map_err(|error| {
        format!("Failed to create automatic history settings directory: {error}")
    })?;
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize automatic history settings: {error}"))?;
    fs::write(&paths.history_settings_file, format!("{serialized}\n")).map_err(|error| {
        format!(
            "Failed to write automatic history settings {}: {error}",
            paths.history_settings_file.display()
        )
    })
}

fn validate_history_storage_limit(limit_bytes: u64) -> Result<(), String> {
    if !(MIN_HISTORY_STORAGE_LIMIT_BYTES..=MAX_HISTORY_STORAGE_LIMIT_BYTES).contains(&limit_bytes) {
        return Err(format!(
            "Automatic history storage limit must be between {} MB and {} GB",
            MIN_HISTORY_STORAGE_LIMIT_BYTES / 1024 / 1024,
            MAX_HISTORY_STORAGE_LIMIT_BYTES / 1024 / 1024 / 1024
        ));
    }
    Ok(())
}

fn directory_size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0u64;
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        total = total
            .checked_add(directory_size(&entry.path())?)
            .ok_or_else(|| "Automatic history size exceeds the supported range".to_string())?;
    }
    Ok(total)
}

// Shared by rewind and agent storage: pruning must not race an agent writing
// objects before it publishes their protecting refs. Acquire this after any
// project/comment gates; never acquire those gates while holding this guard.
pub(crate) fn lock_history_operations() -> MutexGuard<'static, ()> {
    HISTORY_OPERATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn loose_history_object_count(repo: &Repository) -> Result<usize, String> {
    let objects_dir = repo.path().join("objects");
    if !objects_dir.exists() {
        return Ok(0);
    }

    let mut count = 0usize;
    for prefix in fs::read_dir(&objects_dir)
        .map_err(|error| format!("Failed to inspect automatic history objects: {error}"))?
    {
        let prefix = prefix
            .map_err(|error| format!("Failed to inspect automatic history objects: {error}"))?;
        let prefix_name = prefix.file_name();
        let prefix_name = prefix_name.to_string_lossy();
        if prefix_name.len() != 2
            || !prefix_name
                .chars()
                .all(|character| character.is_ascii_hexdigit())
            || !prefix
                .file_type()
                .map_err(|error| format!("Failed to inspect automatic history objects: {error}"))?
                .is_dir()
        {
            continue;
        }

        for object in fs::read_dir(prefix.path())
            .map_err(|error| format!("Failed to inspect automatic history objects: {error}"))?
        {
            let object = object
                .map_err(|error| format!("Failed to inspect automatic history objects: {error}"))?;
            let name = object.file_name();
            let name = name.to_string_lossy();
            if name.len() == 38
                && name.chars().all(|character| character.is_ascii_hexdigit())
                && object
                    .file_type()
                    .map_err(|error| {
                        format!("Failed to inspect automatic history objects: {error}")
                    })?
                    .is_file()
            {
                count = count.saturating_add(1);
            }
        }
    }
    Ok(count)
}

fn run_history_git_gc(project_root: &str, paths: &ProjectStoragePaths) -> Result<(), String> {
    let repository = Repository::open(&paths.history_dir)
        .map_err(|error| format!("Failed to open automatic history for maintenance: {error}"))?;
    let git_dir = repository.path().to_path_buf();
    drop(repository);

    let output = Command::new("git")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .arg("--git-dir")
        .arg(&git_dir)
        .arg("--work-tree")
        .arg(project_root)
        .args([
            "-c",
            "gc.reflogExpire=now",
            "-c",
            "gc.reflogExpireUnreachable=now",
            "gc",
            "--prune=now",
            "--quiet",
        ])
        .output()
        .map_err(|error| format!("Failed to start automatic history maintenance: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Automatic history Git maintenance failed".to_string()
    } else {
        format!("Automatic history Git maintenance failed: {stderr}")
    })
}

fn first_parent_history(repo: &Repository) -> Result<Vec<Oid>, String> {
    let mut commit = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|error| format!("Failed to read automatic history HEAD: {error}"))?;
    let mut commits = Vec::new();

    loop {
        commits.push(commit.id());
        if commit.parent_count() == 0 {
            break;
        }
        commit = commit
            .parent(0)
            .map_err(|error| format!("Failed to read automatic history ancestry: {error}"))?;
    }

    Ok(commits)
}

fn history_tag_targets(repo: &Repository) -> Result<Vec<(String, Oid)>, String> {
    let mut targets = Vec::new();
    let references = repo
        .references_glob("refs/tags/*")
        .map_err(|error| format!("Failed to read protected history labels: {error}"))?;
    for reference in references {
        let reference = reference
            .map_err(|error| format!("Failed to read protected history label: {error}"))?;
        let Some(name) = reference.name() else {
            continue;
        };
        let commit = reference
            .peel_to_commit()
            .map_err(|error| format!("Failed to read protected history snapshot: {error}"))?;
        targets.push((name.to_string(), commit.id()));
    }
    Ok(targets)
}

fn rewrite_retained_history<F>(
    repo: &Repository,
    recent_snapshot_floor: usize,
    mut stage_hook: F,
) -> Result<HistoryMaintenanceOutcome, String>
where
    F: FnMut(HistoryMaintenanceStage) -> Result<(), String>,
{
    let head_history = first_parent_history(repo)?;
    let head_set = head_history.iter().copied().collect::<HashSet<_>>();
    let tags = history_tag_targets(repo)?;

    let mut keep = head_history
        .iter()
        .take(recent_snapshot_floor.max(1))
        .copied()
        .collect::<HashSet<_>>();
    keep.extend(tags.iter().map(|(_, oid)| *oid));

    if keep.len() == head_history.len() && tags.iter().all(|(_, oid)| head_set.contains(oid)) {
        return Ok(HistoryMaintenanceOutcome::default());
    }

    // The first-parent chain is the authoritative order. Commit timestamps
    // have one-second precision and can be identical (or move slightly
    // backwards after a clock adjustment), so sorting the main chain by time
    // would scramble undo order. Only protected commits left off the current
    // chain by an interrupted earlier rewrite need timestamp-based placement.
    let mut retained = head_history
        .iter()
        .rev()
        .filter(|oid| keep.contains(oid))
        .copied()
        .collect::<Vec<_>>();
    let mut off_chain = keep
        .into_iter()
        .filter(|oid| !head_set.contains(oid))
        .collect::<Vec<_>>();
    off_chain.sort_by(|left, right| {
        let left_time = repo
            .find_commit(*left)
            .ok()
            .map(|commit| commit.time().seconds());
        let right_time = repo
            .find_commit(*right)
            .ok()
            .map(|commit| commit.time().seconds());
        left_time
            .cmp(&right_time)
            .then_with(|| left.as_bytes().cmp(right.as_bytes()))
    });
    for oid in off_chain {
        let timestamp = repo
            .find_commit(oid)
            .map(|commit| commit.time().seconds())
            .unwrap_or(i64::MIN);
        let insertion_index = retained
            .iter()
            .position(|existing| {
                repo.find_commit(*existing)
                    .map(|commit| commit.time().seconds() > timestamp)
                    .unwrap_or(false)
            })
            .unwrap_or(retained.len());
        retained.insert(insertion_index, oid);
    }

    let mut outcome = HistoryMaintenanceOutcome::default();
    let mut previous = None;
    for original_oid in &retained {
        let original = repo.find_commit(*original_oid).map_err(|error| {
            format!("Failed to read retained automatic history snapshot: {error}")
        })?;
        let tree = original
            .tree()
            .map_err(|error| format!("Failed to read retained history tree: {error}"))?;
        let author = original.author();
        let committer = original.committer();
        let message = original.message().unwrap_or("[history] Snapshot");
        let parent = previous
            .map(|oid| repo.find_commit(oid))
            .transpose()
            .map_err(|error| format!("Failed to build retained history ancestry: {error}"))?;
        let parents = parent.iter().collect::<Vec<_>>();
        let rewritten_oid = repo
            .commit(None, &author, &committer, message, &tree, &parents)
            .map_err(|error| format!("Failed to rewrite retained history snapshot: {error}"))?;
        outcome.rewritten_oids.insert(*original_oid, rewritten_oid);
        previous = Some(rewritten_oid);
    }

    stage_hook(HistoryMaintenanceStage::BeforeReferenceUpdate)?;

    // Labels move first. If the process is interrupted during the reference
    // update, both the old HEAD and every already-moved label still point to
    // complete commit trees. Garbage collection does not begin until all
    // references have been updated successfully.
    for (reference_name, original_oid) in &tags {
        let rewritten_oid = outcome
            .rewritten_oids
            .get(original_oid)
            .ok_or_else(|| format!("Protected history label {reference_name} was not retained"))?;
        repo.reference(
            reference_name,
            *rewritten_oid,
            true,
            concat!(env!("APP_BRAND_NAME"), " automatic history retention"),
        )
        .map_err(|error| format!("Failed to preserve history label {reference_name}: {error}"))?;
    }

    let original_head = *head_history
        .first()
        .ok_or("Automatic history has no HEAD snapshot")?;
    let rewritten_head = *outcome
        .rewritten_oids
        .get(&original_head)
        .ok_or("Recent automatic history HEAD was not retained")?;
    let head_name = repo
        .head()
        .ok()
        .and_then(|head| head.name().map(ToOwned::to_owned))
        .ok_or("Automatic history HEAD is not a named branch")?;
    repo.reference(
        &head_name,
        rewritten_head,
        true,
        concat!(env!("APP_BRAND_NAME"), " automatic history retention"),
    )
    .map_err(|error| format!("Failed to activate retained automatic history: {error}"))?;

    stage_hook(HistoryMaintenanceStage::BeforeGarbageCollection)?;
    Ok(outcome)
}

fn maintain_history_with_policy<F>(
    project_root: &str,
    paths: &ProjectStoragePaths,
    policy: HistoryMaintenancePolicy,
    mut stage_hook: F,
) -> Result<HistoryMaintenanceOutcome, String>
where
    F: FnMut(HistoryMaintenanceStage) -> Result<(), String>,
{
    let repository = open_repo_at(project_root, paths)?;
    let loose_objects = loose_history_object_count(&repository)?;
    let usage_bytes = directory_size(&paths.history_dir)?;
    drop(repository);

    if !policy.force_compaction
        && usage_bytes <= policy.storage_limit_bytes
        && loose_objects < policy.loose_object_threshold
    {
        return Ok(HistoryMaintenanceOutcome::default());
    }

    // Git performs the pack replacement atomically. Running it before any
    // ancestry rewrite gives size enforcement an accurate delta-compressed
    // baseline and keeps routine loose-object maintenance inexpensive.
    run_history_git_gc(project_root, paths)?;
    let packed_usage_bytes = directory_size(&paths.history_dir)?;
    if !policy.force_compaction && packed_usage_bytes <= policy.storage_limit_bytes {
        return Ok(HistoryMaintenanceOutcome::default());
    }

    let repository = open_repo_at(project_root, paths)?;
    let outcome =
        rewrite_retained_history(&repository, policy.recent_snapshot_floor, &mut stage_hook)?;
    drop(repository);

    if !outcome.rewritten_oids.is_empty() {
        run_history_git_gc(project_root, paths)?;
        let repository = open_repo_at(project_root, paths)?;
        first_parent_history(&repository)?;
        history_tag_targets(&repository)?;
    }

    Ok(outcome)
}

fn maintain_history(
    project_root: &str,
    paths: &ProjectStoragePaths,
) -> Result<HistoryMaintenanceOutcome, String> {
    let settings = load_history_settings(paths)?;
    maintain_history_with_policy(
        project_root,
        paths,
        HistoryMaintenancePolicy {
            storage_limit_bytes: settings.storage_limit_bytes,
            recent_snapshot_floor: HISTORY_RECENT_SNAPSHOT_FLOOR,
            loose_object_threshold: HISTORY_LOOSE_OBJECT_MAINTENANCE_THRESHOLD,
            force_compaction: false,
        },
        |_| Ok(()),
    )
}

fn snapshot_oid_after_maintenance_error(
    project_root: &str,
    paths: &ProjectStoragePaths,
    original_oid: Oid,
) -> Oid {
    let Ok(repository) = open_repo_at(project_root, paths) else {
        return original_oid;
    };
    let head_history = first_parent_history(&repository).unwrap_or_default();
    if head_history.contains(&original_oid) {
        return original_oid;
    }
    head_history.first().copied().unwrap_or(original_oid)
}

fn history_storage_info_at(paths: &ProjectStoragePaths) -> Result<HistoryStorageInfo, String> {
    let settings = load_history_settings(paths)?;
    let usage_bytes = directory_size(&paths.history_dir)?;

    if !paths.history_dir.exists() {
        return Ok(HistoryStorageInfo {
            usage_bytes,
            limit_bytes: settings.storage_limit_bytes,
            snapshot_count: 0,
            protected_snapshot_count: 0,
        });
    }

    let repo = Repository::open(&paths.history_dir)
        .map_err(|error| format!("Failed to inspect automatic history: {error}"))?;
    // Private agent revisions may be reachable through additional parents.
    // Rewind exposes only the main project's first-parent timeline.
    let snapshot_count = first_parent_history(&repo)?.len() as u64;
    let protected_snapshot_count = tag_map(&repo).len() as u64;

    Ok(HistoryStorageInfo {
        usage_bytes,
        limit_bytes: settings.storage_limit_bytes,
        snapshot_count,
        protected_snapshot_count,
    })
}

pub fn history_storage_info(
    app: crate::host::ServiceContext,
    project_root: String,
) -> Result<HistoryStorageInfo, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_storage_info_at(&paths)
}

pub fn history_set_storage_limit(
    app: crate::host::ServiceContext,
    project_root: String,
    limit_bytes: u64,
) -> Result<HistoryStorageInfo, String> {
    validate_history_storage_limit(limit_bytes)?;
    let paths = resolve_project_storage(&app, &project_root)?;
    let _history_guard = lock_history_operations();
    save_history_settings(
        &paths,
        &HistorySettings {
            version: HISTORY_SETTINGS_SCHEMA_VERSION,
            storage_limit_bytes: limit_bytes,
        },
    )?;
    if paths.history_dir.exists() {
        maintain_history(&project_root, &paths)?;
    }
    history_storage_info_at(&paths)
}

fn history_clear_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
) -> Result<HistoryStorageInfo, String> {
    let _history_guard = lock_history_operations();
    if paths.history_dir.parent() != Some(paths.data_dir.as_path())
        || paths.history_dir.file_name().and_then(|name| name.to_str()) != Some("history.git")
    {
        return Err("Refusing to clear an unexpected automatic history path".to_string());
    }

    if paths.history_dir.exists() {
        let metadata = fs::symlink_metadata(&paths.history_dir).map_err(|error| {
            format!("Failed to inspect automatic history before clearing: {error}")
        })?;
        if metadata.file_type().is_symlink() {
            return Err("Refusing to clear a symlinked automatic history directory".to_string());
        }
    }

    history_init_unlocked_at(project_root, paths)?;
    let repo = open_repo_at(project_root, paths)?;
    let tree_oid = rebuild_history_index(&repo, paths)?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|error| format!("Failed to read current project snapshot: {error}"))?;
    let signature = default_signature()?;
    // Start a fresh main timeline without deleting the shared object database.
    // Private agent refs and linked worktrees continue to protect their exact
    // starting checkpoints, even when those checkpoints disappear from Rewind.
    let oid = repo
        .commit(
            None,
            &signature,
            &signature,
            "[init] Project opened",
            &tree,
            &[],
        )
        .map_err(|error| format!("Failed to reset automatic history: {error}"))?;
    let mut head = repo
        .head()
        .map_err(|error| format!("Failed to read automatic history HEAD: {error}"))?;
    head.set_target(oid, concat!(env!("APP_BRAND_NAME"), " clear automatic history"))
        .map_err(|error| format!("Failed to activate fresh automatic history: {error}"))?;
    for (name, _) in history_tag_targets(&repo)? {
        repo.find_reference(&name)
            .and_then(|mut reference| reference.delete())
            .map_err(|error| format!("Failed to remove history label {name}: {error}"))?;
    }
    drop(head);
    drop(tree);
    drop(repo);
    // Git retains all private refs and linked-worktree heads. Reclamation is
    // best effort; clearing history must not destroy an active draft to meet
    // its storage budget.
    if let Err(error) = run_history_git_gc(project_root, paths) {
        eprintln!("[history] Automatic history maintenance deferred: {error}");
    }
    history_storage_info_at(paths)
}

pub fn history_clear(
    app: crate::host::ServiceContext,
    project_root: String,
) -> Result<HistoryStorageInfo, String> {
    let _comment_guard = app.comments.lock_project_blocking(&project_root)?;
    let paths = resolve_project_storage(&app, &project_root)?;
    history_clear_at(&project_root, &paths)
}

// ─── Tauri Commands ───

pub fn git_project_init(project_root: String) -> Result<(), String> {
    let root = Path::new(&project_root);
    if !root.is_dir() {
        return Err("Project location does not exist or is not a directory".to_string());
    }

    let output = run_git(&project_root, &["init", "-b", "main"])?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to initialize Git repository".to_string()
    } else {
        format!("Failed to initialize Git repository: {stderr}")
    })
}

pub fn git_project_complete_setup(
    project_root: String,
    gitignore_content: Option<String>,
) -> Result<GitCommandResult, String> {
    git_project_init(project_root.clone())?;

    if let Some(content) = gitignore_content {
        let mut content = content.replace("\r\n", "\n");
        if !content.ends_with('\n') {
            content.push('\n');
        }
        fs::write(Path::new(&project_root).join(".gitignore"), content)
            .map_err(|error| format!("Failed to write .gitignore: {error}"))?;
    }

    Ok(GitCommandResult {
        success: true,
        message: "Git repository initialized on main".to_string(),
    })
}

pub fn git_project_connect_remote(
    project_root: String,
    remote_url: String,
    remote_name: Option<String>,
    upstream_branch: Option<String>,
) -> Result<GitCommandResult, String> {
    let root = Path::new(&project_root);
    if !root.is_dir() {
        return Err("Project location does not exist or is not a directory".to_string());
    }

    let remote_url = remote_url.trim();
    if remote_url.is_empty() {
        return Err("Repository URL is required".to_string());
    }
    if remote_url.contains(['\0', '\n', '\r']) {
        return Err("Repository URL contains invalid characters".to_string());
    }
    let remote_name = remote_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("origin");
    if remote_name.starts_with('-')
        || remote_name
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("Git remote name is invalid".to_string());
    }

    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => {
            git_project_init(project_root.clone())?;
            Repository::open(root)
                .map_err(|error| format!("Failed to open initialized Git repository: {error}"))?
        }
    };

    match repo.find_remote(remote_name) {
        Ok(_) => repo
            .remote_set_url(remote_name, remote_url)
            .map_err(|error| format!("Failed to update the {remote_name} remote: {error}"))?,
        Err(error) if error.code() == git2::ErrorCode::NotFound => {
            repo.remote(remote_name, remote_url)
                .map_err(|error| format!("Failed to add the {remote_name} remote: {error}"))?;
        }
        Err(error) => return Err(format!("Failed to inspect Git remotes: {error}")),
    }

    if let Some(upstream_branch) = upstream_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
    {
        let full_branch_ref = format!("refs/heads/{upstream_branch}");
        if !git2::Reference::is_valid_name(&full_branch_ref) {
            return Err("Remote branch name is invalid".to_string());
        }
        let local_branch_output = run_git(&project_root, &["branch", "--show-current"])?;
        let local_branch = String::from_utf8_lossy(&local_branch_output.stdout)
            .trim()
            .to_string();
        if !local_branch_output.status.success() || local_branch.is_empty() {
            return Err("Check out a local branch before setting its upstream".to_string());
        }

        let remote_tracking_ref = format!("refs/remotes/{remote_name}/{upstream_branch}");
        let fetch_refspec = format!("{full_branch_ref}:{remote_tracking_ref}");
        let fetch_output = run_git_dynamic(
            &project_root,
            &["fetch".to_string(), remote_name.to_string(), fetch_refspec],
        )?;
        if !fetch_output.status.success() {
            let combined = parse_git_output(&fetch_output);
            return Err(if combined.trim().is_empty() {
                format!("Failed to fetch {remote_name}/{upstream_branch}")
            } else {
                combined
            });
        }

        if repo
            .find_branch(&local_branch, git2::BranchType::Local)
            .is_ok()
        {
            let tracking_branch = format!("{remote_name}/{upstream_branch}");
            let set_upstream_output = run_git_dynamic(
                &project_root,
                &[
                    "branch".to_string(),
                    "--set-upstream-to".to_string(),
                    tracking_branch,
                    local_branch.clone(),
                ],
            )?;
            if !set_upstream_output.status.success() {
                let combined = parse_git_output(&set_upstream_output);
                return Err(if combined.trim().is_empty() {
                    "Failed to set the tracking branch".to_string()
                } else {
                    combined
                });
            }
        } else {
            let mut config = repo
                .config()
                .map_err(|error| format!("Failed to open Git configuration: {error}"))?;
            config
                .set_str(&format!("branch.{local_branch}.remote"), remote_name)
                .map_err(|error| format!("Failed to record the upstream remote: {error}"))?;
            config
                .set_str(&format!("branch.{local_branch}.merge"), &full_branch_ref)
                .map_err(|error| format!("Failed to record the upstream branch: {error}"))?;
        }
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Git upstream {remote_name} configured"),
    })
}

pub fn git_project_upstream_status(project_root: String) -> Result<GitUpstreamStatus, String> {
    let repo = open_project_repo(&project_root)?;
    let upstream_output = run_git(
        &project_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    let upstream_branch = upstream_output
        .status
        .success()
        .then(|| {
            String::from_utf8_lossy(&upstream_output.stdout)
                .trim()
                .to_string()
        })
        .filter(|branch| !branch.is_empty());

    let mut remote_names = repo
        .remotes()
        .map_err(|error| format!("Failed to list Git remotes: {error}"))?
        .iter()
        .flatten()
        .map(str::to_string)
        .collect::<Vec<_>>();
    remote_names.sort_by_key(|name| std::cmp::Reverse(name.len()));

    let remote_name = upstream_branch
        .as_ref()
        .and_then(|branch| {
            remote_names
                .iter()
                .find(|name| branch.starts_with(&format!("{name}/")))
                .cloned()
        })
        .or_else(|| {
            remote_names
                .iter()
                .find(|name| name.as_str() == "origin")
                .cloned()
        })
        .or_else(|| remote_names.first().cloned());
    let remote_url = remote_name
        .as_deref()
        .and_then(|name| repo.find_remote(name).ok())
        .and_then(|remote| remote.url().map(str::to_string));
    let local_branch_output = run_git(&project_root, &["branch", "--show-current"])?;
    let local_branch = local_branch_output
        .status
        .success()
        .then(|| {
            String::from_utf8_lossy(&local_branch_output.stdout)
                .trim()
                .to_string()
        })
        .filter(|branch| !branch.is_empty());

    Ok(GitUpstreamStatus {
        remote_name,
        remote_url,
        upstream_branch,
        local_branch,
    })
}

pub fn git_project_remote_configuration(
    project_root: String,
) -> Result<GitRemoteConfiguration, String> {
    let repo = open_project_repo(&project_root)?;
    let current_branch = repo
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().map(str::to_string));

    let mut local_branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|error| format!("Failed to list local branches: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|(branch, _)| branch.name().ok().flatten().map(str::to_string))
        .collect::<Vec<_>>();
    local_branches.sort();

    let mut remote_names = repo
        .remotes()
        .map_err(|error| format!("Failed to list Git remotes: {error}"))?
        .iter()
        .flatten()
        .map(str::to_string)
        .collect::<Vec<_>>();
    remote_names.sort_by(|left, right| match (left.as_str(), right.as_str()) {
        ("origin", "origin") => std::cmp::Ordering::Equal,
        ("origin", _) => std::cmp::Ordering::Less,
        (_, "origin") => std::cmp::Ordering::Greater,
        _ => left.to_lowercase().cmp(&right.to_lowercase()),
    });
    let mut remote_names_by_length = remote_names.clone();
    remote_names_by_length.sort_by_key(|name| std::cmp::Reverse(name.len()));

    let tracking_branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|error| format!("Failed to inspect local branches: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|(branch, _)| {
            let local_branch = branch.name().ok().flatten()?.to_string();
            let upstream = branch.upstream().ok()?;
            let upstream_name = upstream.name().ok().flatten()?.to_string();
            let remote_name = remote_names_by_length
                .iter()
                .find(|name| upstream_name.starts_with(&format!("{name}/")))?
                .clone();
            let remote_branch = upstream_name
                .strip_prefix(&format!("{remote_name}/"))?
                .to_string();
            Some((remote_name, local_branch, remote_branch))
        })
        .collect::<Vec<_>>();

    let remotes = remote_names
        .into_iter()
        .map(|name| {
            let url = repo
                .find_remote(&name)
                .map_err(|error| format!("Failed to inspect the {name} remote: {error}"))?
                .url()
                .unwrap_or_default()
                .to_string();
            let tracking = tracking_branches
                .iter()
                .find(|(remote, local, _)| {
                    remote == &name && Some(local) == current_branch.as_ref()
                })
                .or_else(|| {
                    tracking_branches
                        .iter()
                        .find(|(remote, _, _)| remote == &name)
                });
            Ok(GitRemoteEntry {
                name,
                url,
                local_branch: tracking.map(|(_, local, _)| local.clone()),
                remote_branch: tracking.map(|(_, _, remote)| remote.clone()),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(GitRemoteConfiguration {
        remotes,
        local_branches,
        current_branch,
    })
}

pub fn git_project_save_remote(
    project_root: String,
    original_remote_name: Option<String>,
    remote_name: String,
    remote_url: String,
    local_branch: Option<String>,
    upstream_branch: Option<String>,
) -> Result<GitCommandResult, String> {
    let remote_name = remote_name.trim();
    if remote_name.is_empty() {
        return Err("Remote name is required".to_string());
    }
    if remote_name.starts_with('-')
        || !git2::Reference::is_valid_name(&format!("refs/remotes/{remote_name}/placeholder"))
    {
        return Err("Git remote name is invalid".to_string());
    }
    let remote_url = remote_url.trim();
    if remote_url.is_empty() {
        return Err("Remote URL is required".to_string());
    }
    if remote_url.contains(['\0', '\n', '\r']) {
        return Err("Remote URL contains invalid characters".to_string());
    }

    let repo = open_project_repo(&project_root)?;
    match original_remote_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(original_name) => {
            repo.find_remote(original_name)
                .map_err(|_| format!("The {original_name} remote no longer exists"))?;
            if original_name != remote_name {
                let rename_output = run_git_dynamic(
                    &project_root,
                    &[
                        "remote".to_string(),
                        "rename".to_string(),
                        original_name.to_string(),
                        remote_name.to_string(),
                    ],
                )?;
                if !rename_output.status.success() {
                    let combined = parse_git_output(&rename_output);
                    return Err(if combined.trim().is_empty() {
                        format!("Failed to rename {original_name} to {remote_name}")
                    } else {
                        combined
                    });
                }
            }
            repo.remote_set_url(remote_name, remote_url)
                .map_err(|error| format!("Failed to update the {remote_name} remote: {error}"))?;
        }
        None => {
            if repo.find_remote(remote_name).is_ok() {
                return Err(format!("A remote named {remote_name} already exists"));
            }
            repo.remote(remote_name, remote_url)
                .map_err(|error| format!("Failed to add the {remote_name} remote: {error}"))?;
        }
    }

    match (
        local_branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty()),
        upstream_branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty()),
    ) {
        (Some(local_branch), Some(upstream_branch)) => {
            if !git2::Reference::is_valid_name(&format!("refs/heads/{local_branch}")) {
                return Err("Local branch name is invalid".to_string());
            }
            if !git2::Reference::is_valid_name(&format!("refs/heads/{upstream_branch}")) {
                return Err("Remote branch name is invalid".to_string());
            }
            repo.find_branch(local_branch, git2::BranchType::Local)
                .map_err(|_| format!("The local branch {local_branch} does not exist"))?;

            let full_branch_ref = format!("refs/heads/{upstream_branch}");
            let remote_tracking_ref = format!("refs/remotes/{remote_name}/{upstream_branch}");
            let fetch_refspec = format!("{full_branch_ref}:{remote_tracking_ref}");
            let fetch_output = run_git_dynamic(
                &project_root,
                &["fetch".to_string(), remote_name.to_string(), fetch_refspec],
            )?;
            if !fetch_output.status.success() {
                let combined = parse_git_output(&fetch_output);
                return Err(if combined.trim().is_empty() {
                    format!("Failed to fetch {remote_name}/{upstream_branch}")
                } else {
                    combined
                });
            }

            let tracking_branch = format!("{remote_name}/{upstream_branch}");
            let set_upstream_output = run_git_dynamic(
                &project_root,
                &[
                    "branch".to_string(),
                    "--set-upstream-to".to_string(),
                    tracking_branch,
                    local_branch.to_string(),
                ],
            )?;
            if !set_upstream_output.status.success() {
                let combined = parse_git_output(&set_upstream_output);
                return Err(if combined.trim().is_empty() {
                    "Failed to set the tracking branch".to_string()
                } else {
                    combined
                });
            }
        }
        (None, None) => {}
        _ => return Err("Choose both a local branch and a remote branch".to_string()),
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Git remote {remote_name} saved"),
    })
}

pub fn git_project_delete_remote(
    project_root: String,
    remote_name: String,
) -> Result<GitCommandResult, String> {
    let remote_name = remote_name.trim();
    if remote_name.is_empty() {
        return Err("Remote name is required".to_string());
    }
    if remote_name.starts_with('-')
        || !git2::Reference::is_valid_name(&format!("refs/remotes/{remote_name}/placeholder"))
    {
        return Err("Git remote name is invalid".to_string());
    }

    let repo = open_project_repo(&project_root)?;
    repo.find_remote(remote_name)
        .map_err(|_| format!("The {remote_name} remote no longer exists"))?;
    let output = run_git_dynamic(
        &project_root,
        &[
            "remote".to_string(),
            "remove".to_string(),
            remote_name.to_string(),
        ],
    )?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            format!("Failed to delete the {remote_name} remote")
        } else {
            combined
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Git remote {remote_name} deleted"),
    })
}

pub(crate) fn git_remote_inspect_impl(remote_url: &str) -> Result<GitRemoteInspection, String> {
    let remote_url = remote_url.trim();
    if remote_url.is_empty() {
        return Err("Upstream URL is required".to_string());
    }
    if remote_url.contains(['\0', '\n', '\r']) {
        return Err("Upstream URL contains invalid characters".to_string());
    }

    let output =
        crate::git_credentials::run(".", &["ls-remote", "--heads", "--refs", "--", remote_url])?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            "The Git upstream could not be reached".to_string()
        } else {
            combined
        });
    }

    let mut branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .filter_map(|reference| reference.strip_prefix("refs/heads/"))
        .map(str::to_string)
        .collect::<Vec<_>>();
    branches.sort();
    branches.dedup();

    Ok(GitRemoteInspection { branches })
}

pub fn git_overleaf_token_detect() -> Result<Option<String>, String> {
    if let Some(token) = std::env::var("OVERLEAF_TOKEN")
        .ok()
        .or_else(|| std::env::var("OVERLEAF_ACCESS_TOKEN").ok())
        .filter(|token| !token.trim().is_empty())
    {
        return Ok(Some(token));
    }

    let mut child = Command::new("git")
        .args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to check Git credentials: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(b"protocol=https\nhost=git.overleaf.com\nusername=git\n\n")
            .map_err(|error| format!("Failed to query Git credentials: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Failed to read Git credentials: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }

    let token = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    Ok(token)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafCloneResult {
    project_path: String,
    credential_warning: Option<String>,
}

fn save_overleaf_credential(project_root: &Path, token: &str) -> Result<(), String> {
    // Use Git's own helper protocol. Never put the token in argv or repository config.
    let failure = "The project was cloned, but Git could not remember the token. Configure a Git credential helper before your next pull or push.";
    let query = "protocol=https\nhost=git.overleaf.com\nusername=git\n";
    let run = |action: &str, input: &str| -> Result<std::process::Output, String> {
        let mut child = Command::new("git")
            .current_dir(project_root)
            .args(["credential", action])
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| failure.to_string())?;
        let written = child
            .stdin
            .take()
            .ok_or_else(|| failure.to_string())?
            .write_all(input.as_bytes());
        let output = child.wait_with_output().map_err(|_| failure.to_string())?;
        written.map_err(|_| failure.to_string())?;
        Ok(output)
    };
    let approved = run("approve", &format!("{query}password={token}\n\n"))?;
    if !approved.status.success() {
        return Err(failure.to_string());
    }
    // approve can succeed with no helper, or even when a helper fails to store.
    let filled = run("fill", &format!("{query}\n"))?;
    if filled.status.success()
        && String::from_utf8_lossy(&filled.stdout)
            .lines()
            .any(|line| line.strip_prefix("password=") == Some(token))
    {
        Ok(())
    } else {
        Err(failure.to_string())
    }
}

pub fn git_overleaf_clone(
    clone_command: String,
    access_token: String,
    local_name: String,
    local_path: String,
) -> Result<OverleafCloneResult, String> {
    let token = access_token.trim();
    if token.is_empty() {
        return Err("Enter your Overleaf access token".to_string());
    }

    if token.contains(['\n', '\r', '\0']) {
        return Err("The access token contains invalid characters".to_string());
    }

    let (clone_url, _) = parse_overleaf_clone_command(&clone_command)?;
    let project_name = local_name.trim();
    if project_name.is_empty()
        || matches!(project_name, "." | "..")
        || project_name.contains(['/', '\\'])
    {
        return Err("Local name cannot contain path separators".to_string());
    }
    let local_root = PathBuf::from(local_path.trim());
    if local_root.as_os_str().is_empty() {
        return Err("Choose a local path for the cloned project".to_string());
    }
    fs::create_dir_all(&local_root)
        .map_err(|error| format!("Failed to create the local path: {error}"))?;
    if !local_root.is_dir() {
        return Err("The local path is not a directory".to_string());
    }

    let project_root = local_root.join(project_name);
    if project_root.exists() {
        return Err(format!(
            "A folder named {project_name} already exists at this location"
        ));
    }

    let authorization = BASE64_STANDARD.encode(format!("git:{token}"));
    let output = Command::new("git")
        .current_dir(&local_root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env(
            "GIT_CONFIG_KEY_0",
            "http.https://git.overleaf.com/.extraheader",
        )
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("Authorization: Basic {authorization}"),
        )
        .args(["clone", clone_url.as_str(), project_name])
        .output()
        .map_err(|error| format!("Failed to run Git clone: {error}"))?;

    if output.status.success() {
        return Ok(OverleafCloneResult {
            project_path: project_root.to_string_lossy().to_string(),
            credential_warning: save_overleaf_credential(&project_root, token).err(),
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to clone the Overleaf project".to_string()
    } else {
        format!("Failed to clone the Overleaf project: {stderr}")
    })
}

pub fn history_init(app: crate::host::ServiceContext, project_root: String) -> Result<(), String> {
    let _comment_guard = app.comments.lock_project_blocking(&project_root)?;
    let paths = resolve_project_storage(&app, &project_root)?;
    history_init_at(&project_root, &paths)
}

// Acquires the shared repository lock internally. Call before acquiring a
// mutation guard through lock_history_operations, never while holding one.
pub(crate) fn history_init_at(project_root: &str, paths: &ProjectStoragePaths) -> Result<(), String> {
    let _history_guard = lock_history_operations();
    history_init_unlocked_at(project_root, paths)
}

fn history_init_unlocked_at(project_root: &str, paths: &ProjectStoragePaths) -> Result<(), String> {
    let git_dir = &paths.history_dir;

    if git_dir.exists() {
        match Repository::open(git_dir) {
            Ok(repo) => {
                repo.set_workdir(Path::new(project_root), false)
                    .map_err(|e| format!("Failed to bind history repo to project: {}", e))?;
                ensure_excludes(paths, &repo)?;
                drop(repo);
                if let Err(error) = maintain_history(project_root, paths) {
                    eprintln!("[history] Automatic history maintenance deferred: {error}");
                }
                return Ok(());
            }
            Err(error) if directory_tree_is_empty(git_dir)? => {
                // libgit2 can leave an empty directory tree behind when
                // initialization is interrupted. It contains no history to
                // preserve, so it is safe to rebuild automatically.
                fs::remove_dir_all(git_dir).map_err(|remove_error| {
                    format!(
                        "Failed to remove incomplete history repo after {error}: {remove_error}"
                    )
                })?;
            }
            Err(error) => return Err(format!("Corrupt history repo: {error}")),
        }
    }

    fs::create_dir_all(&paths.data_dir)
        .map_err(|e| format!("Failed to create project history directory: {}", e))?;

    // Initialize the private repository completely inside Catalex app data.
    // Binding the source project as workdir in RepositoryInitOptions would
    // make libgit2 create a `.git` gitlink in the source tree, colliding with
    // projects that already use Git. set_workdir(..., false) updates only the
    // private repo configuration and never touches the source `.git` path.
    let repo =
        Repository::init(git_dir).map_err(|e| format!("Failed to init history repo: {}", e))?;
    repo.set_workdir(Path::new(project_root), false)
        .map_err(|e| format!("Failed to bind history repo to project: {}", e))?;

    // Set up excludes file
    ensure_excludes(paths, &repo)?;

    // Capture source and assets in the private repository.
    let tree_oid = rebuild_history_index(&repo, paths)?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "[init] Project opened",
        &tree,
        &[],
    )
    .map_err(|e| format!("Failed to create initial commit: {}", e))?;

    drop(tree);
    drop(repo);
    if let Err(error) = maintain_history(project_root, paths) {
        eprintln!("[history] Automatic history maintenance deferred: {error}");
    }

    Ok(())
}

fn directory_tree_is_empty(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if !metadata.file_type().is_dir() {
        return Ok(false);
    }

    for entry in fs::read_dir(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        if !entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", entry.path().display()))?
            .is_dir()
            || !directory_tree_is_empty(&entry.path())?
        {
            return Ok(false);
        }
    }

    Ok(true)
}

pub fn history_snapshot(
    app: crate::host::ServiceContext,
    project_root: String,
    message: String,
) -> Result<Option<SnapshotInfo>, String> {
    let _comment_guard = app.comments.lock_project_blocking(&project_root)?;
    let paths = resolve_project_storage(&app, &project_root)?;
    history_snapshot_at(&project_root, &paths, message)
}

fn history_snapshot_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    message: String,
) -> Result<Option<SnapshotInfo>, String> {
    let _history_guard = lock_history_operations();
    history_snapshot_unlocked_at(project_root, paths, message)
}

/// Called with the history gate held by native agent acceptance/recovery.
pub(crate) fn history_snapshot_unlocked_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    message: String,
) -> Result<Option<SnapshotInfo>, String> {
    let repo = open_repo_at(project_root, paths)?;

    ensure_excludes(paths, &repo)?;
    let tree_oid = rebuild_history_index(&repo, paths)?;

    // Check if there are actual changes vs HEAD
    if let Ok(head) = repo.head() {
        if let Ok(head_commit) = head.peel_to_commit() {
            if head_commit.tree().map(|t| t.id()).unwrap_or(Oid::zero()) == tree_oid {
                // No changes — skip snapshot
                return Ok(None);
            }
        }
    }

    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| format!("Failed to create commit: {}", e))?;

    // Collect changed file paths
    let changed_files = if let Some(parent_commit) = parent.as_ref() {
        let parent_tree = parent_commit.tree().ok();
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .map(|d| {
                d.deltas()
                    .filter_map(|delta| {
                        delta
                            .new_file()
                            .path()
                            .or_else(|| delta.old_file().path())
                            .filter(|path| !is_history_internal_path(path))
                            .map(|p| p.to_string_lossy().to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    drop(parents);
    drop(parent);
    drop(tree);
    drop(repo);

    let maintained_oid = match maintain_history(project_root, paths) {
        Ok(outcome) => outcome.rewritten_oids.get(&oid).copied().unwrap_or(oid),
        Err(error) => {
            // Snapshot creation is the editing safeguard. Maintenance is
            // best-effort and must never discard an otherwise valid snapshot.
            eprintln!("[history] Automatic history maintenance deferred: {error}");
            snapshot_oid_after_maintenance_error(project_root, paths, oid)
        }
    };

    Ok(Some(SnapshotInfo {
        id: maintained_oid.to_string(),
        message,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files,
    }))
}

pub fn history_list(
    app: crate::host::ServiceContext,
    project_root: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<SnapshotInfo>, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_list_at(&project_root, &paths, limit, offset)
}

fn history_list_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    limit: u32,
    offset: u32,
) -> Result<Vec<SnapshotInfo>, String> {
    let repo = open_repo_at(project_root, paths)?;
    let tags = tag_map(&repo);

    let mut snapshots = Vec::new();
    for oid in first_parent_history(&repo)?
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
    {
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;

        let message = commit.message().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let labels = tags.get(&oid).cloned().unwrap_or_default();

        // Collect changed file paths (vs parent)
        let changed_files = if let Some(parent) = commit.parents().next() {
            let old_tree = parent.tree().ok();
            let new_tree = commit.tree().ok();
            repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), None)
                .map(|d| {
                    d.deltas()
                        .filter_map(|delta| {
                            delta
                                .new_file()
                                .path()
                                .or_else(|| delta.old_file().path())
                                .filter(|path| !is_history_internal_path(path))
                                .map(|p| p.to_string_lossy().to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            vec![]
        };

        snapshots.push(SnapshotInfo {
            id: oid.to_string(),
            message,
            timestamp,
            labels,
            changed_files,
        });
    }

    Ok(snapshots)
}

pub fn history_diff(
    app: crate::host::ServiceContext,
    project_root: String,
    from_id: String,
    to_id: String,
) -> Result<Vec<FileDiff>, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_diff_at(&project_root, &paths, from_id, to_id)
}

fn history_diff_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    from_id: String,
    to_id: String,
) -> Result<Vec<FileDiff>, String> {
    let repo = open_repo_at(project_root, paths)?;

    let from_oid = Oid::from_str(&from_id).map_err(|e| format!("Invalid from_id: {}", e))?;
    let to_oid = Oid::from_str(&to_id).map_err(|e| format!("Invalid to_id: {}", e))?;

    let from_commit = repo
        .find_commit(from_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let to_commit = repo
        .find_commit(to_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    let from_tree = from_commit
        .tree()
        .map_err(|e| format!("Tree error: {}", e))?;
    let to_tree = to_commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    let mut diff_opts = DiffOptions::new();
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut diff_opts))
        .map_err(|e| format!("Diff error: {}", e))?;

    let mut results = Vec::new();

    for delta in diff.deltas() {
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if is_history_internal_path(Path::new(&file_path))
            || (!history_tracks_assets(&repo, &to_tree)
                && !has_text_editor_path(Path::new(&file_path)))
        {
            continue;
        }

        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            _ => "modified",
        }
        .to_string();

        let old_content = if delta.status() != git2::Delta::Added {
            let old_blob = repo.find_blob(delta.old_file().id()).ok();
            old_blob.and_then(|b| {
                if b.is_binary() || !has_text_editor_path(Path::new(&file_path)) {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        let new_content = if delta.status() != git2::Delta::Deleted {
            let new_blob = repo.find_blob(delta.new_file().id()).ok();
            new_blob.and_then(|b| {
                if b.is_binary() || !has_text_editor_path(Path::new(&file_path)) {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        results.push(FileDiff {
            file_path,
            status,
            old_content,
            new_content,
        });
    }

    Ok(results)
}

pub fn git_head_file_content(
    project_root: String,
    file_path: String,
) -> Result<GitHeadFileContent, String> {
    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => {
            return Ok(GitHeadFileContent {
                repo_found: false,
                head_content: None,
                ignored: false,
            })
        }
    };

    let ignored = repo
        .status_file(Path::new(&file_path))
        .map(|status| status.is_ignored())
        .unwrap_or(false);

    let head = match repo.head() {
        Ok(head) => head,
        Err(_) => {
            return Ok(GitHeadFileContent {
                repo_found: true,
                head_content: None,
                ignored,
            })
        }
    };

    let commit = match head.peel_to_commit() {
        Ok(commit) => commit,
        Err(_) => {
            return Ok(GitHeadFileContent {
                repo_found: true,
                head_content: None,
                ignored,
            })
        }
    };

    let tree = commit
        .tree()
        .map_err(|e| format!("Failed to read HEAD tree: {}", e))?;

    let entry = match tree.get_path(Path::new(&file_path)) {
        Ok(entry) => entry,
        Err(_) => {
            return Ok(GitHeadFileContent {
                repo_found: true,
                head_content: None,
                ignored,
            })
        }
    };

    let object = entry
        .to_object(&repo)
        .map_err(|e| format!("Failed to read HEAD object: {}", e))?;
    let blob = match object.as_blob() {
        Some(blob) => blob,
        None => {
            return Ok(GitHeadFileContent {
                repo_found: true,
                head_content: None,
                ignored,
            })
        }
    };

    if blob.is_binary() {
        return Ok(GitHeadFileContent {
            repo_found: true,
            head_content: None,
            ignored,
        });
    }

    Ok(GitHeadFileContent {
        repo_found: true,
        head_content: Some(String::from_utf8_lossy(blob.content()).to_string()),
        ignored,
    })
}

fn index_entry_text(
    repo: &Repository,
    entry: Option<&git2::IndexEntry>,
) -> Result<Option<String>, String> {
    let Some(entry) = entry else {
        return Ok(None);
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|e| format!("Failed to read conflict version: {}", e))?;
    if blob.is_binary() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(blob.content()).to_string()))
}

fn parse_conflict_marker_versions(content: &str) -> Option<(String, String)> {
    #[derive(Clone, Copy, PartialEq)]
    enum ConflictSection {
        Common,
        Current,
        Base,
        Incoming,
    }

    let mut section = ConflictSection::Common;
    let mut current = String::with_capacity(content.len());
    let mut incoming = String::with_capacity(content.len());
    let mut found_conflict = false;

    for line in content.split_inclusive('\n') {
        let marker = line.trim_end_matches(&['\r', '\n'][..]);
        match section {
            ConflictSection::Common if marker.starts_with("<<<<<<<") => {
                section = ConflictSection::Current;
                found_conflict = true;
            }
            ConflictSection::Common => {
                current.push_str(line);
                incoming.push_str(line);
            }
            ConflictSection::Current if marker.starts_with("|||||||") => {
                section = ConflictSection::Base;
            }
            ConflictSection::Current if marker == "=======" => {
                section = ConflictSection::Incoming;
            }
            ConflictSection::Current => current.push_str(line),
            ConflictSection::Base if marker == "=======" => {
                section = ConflictSection::Incoming;
            }
            ConflictSection::Base => {}
            ConflictSection::Incoming if marker.starts_with(">>>>>>>") => {
                section = ConflictSection::Common;
            }
            ConflictSection::Incoming => incoming.push_str(line),
        }
    }

    if found_conflict && section == ConflictSection::Common {
        Some((current, incoming))
    } else {
        None
    }
}

pub fn git_conflict_file_content(
    project_root: String,
    file_path: String,
) -> Result<GitConflictFileContent, String> {
    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => {
            return Ok(GitConflictFileContent {
                conflicted: false,
                ancestor_content: None,
                version: None,
                conflict_contents: None,
                current_content: None,
                incoming_content: None,
            })
        }
    };
    let requested_path = file_path.trim().replace('\\', "/");
    let index = repo
        .index()
        .map_err(|e| format!("Failed to read git index: {}", e))?;
    let conflicts = index
        .conflicts()
        .map_err(|e| format!("Failed to read git conflicts: {}", e))?;

    for conflict in conflicts {
        let conflict = conflict.map_err(|e| format!("Failed to read git conflict: {}", e))?;
        let conflict_path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .map(|entry| String::from_utf8_lossy(&entry.path).replace('\\', "/"));
        if conflict_path.as_deref() != Some(requested_path.as_str()) {
            continue;
        }

        let version = crate::git_conflicts::text_version(&repo, &conflict)?;
        let marker_versions = repo
            .workdir()
            .and_then(|workdir| fs::read_to_string(workdir.join(&requested_path)).ok())
            .and_then(|content| parse_conflict_marker_versions(&content));
        let (current_content, incoming_content) = match marker_versions {
            Some((current, incoming)) => (Some(current), Some(incoming)),
            None => (
                index_entry_text(&repo, conflict.our.as_ref())?,
                index_entry_text(&repo, conflict.their.as_ref())?,
            ),
        };

        let ancestor_content = index_entry_text(&repo, conflict.ancestor.as_ref())?;
        let conflict_contents = match (&ancestor_content, &current_content, &incoming_content) {
            (Some(ancestor), Some(current), Some(incoming)) => {
                let (_, segments) = crate::text_merge::merge(
                    &repo,
                    ancestor.as_bytes(),
                    current.as_bytes(),
                    incoming.as_bytes(),
                )?;
                Some(segments)
            }
            _ => None,
        };
        if crate::git_conflicts::text_version(&repo, &conflict)? != version {
            return Err("Conflict file changed while preparing review; refresh it".into());
        }
        return Ok(GitConflictFileContent {
            conflicted: true,
            ancestor_content,
            version: Some(version),
            conflict_contents,
            current_content,
            incoming_content,
        });
    }

    Ok(GitConflictFileContent {
        conflicted: false,
        ancestor_content: None,
        version: None,
        conflict_contents: None,
        current_content: None,
        incoming_content: None,
    })
}

pub fn git_panel_resolve_conflict_review(
    project_root: String,
    file_path: String,
    expected_version: Option<String>,
    content: Option<String>,
) -> Result<GitCommandResult, String> {
    match (expected_version, content) {
        (Some(version), Some(content)) => {
            crate::git_conflicts::resolve_conflict_text(
                project_root,
                file_path.clone(),
                version,
                content,
            )?;
            Ok(GitCommandResult {
                success: true,
                message: format!("Resolved {file_path}"),
            })
        }
        (None, None) => git_panel_resolve_conflict(project_root, file_path),
        _ => {
            Err("Text conflict resolution requires both reviewed version and result content".into())
        }
    }
}

pub fn git_panel_resolve_conflict(
    project_root: String,
    file_path: String,
) -> Result<GitCommandResult, String> {
    let conflict = git_conflict_file_content(project_root.clone(), file_path.clone())?;
    if !conflict.conflicted {
        return Err(format!("{} is not currently conflicted", file_path));
    }

    let output = run_git(&project_root, &["add", "--", file_path.as_str()])?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            format!("Failed to mark {} as resolved", file_path)
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Resolved {}", file_path),
    })
}

pub fn git_panel_reopen_conflict(
    project_root: String,
    file_path: String,
) -> Result<GitCommandResult, String> {
    let repo = open_project_repo(&project_root)?;
    if repo.state() != RepositoryState::Merge {
        return Err("There is no merge in progress".to_string());
    }
    drop(repo);

    let output = run_git(&project_root, &["checkout", "-m", "--", file_path.as_str()])?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            format!("Failed to reopen the conflict in {}", file_path)
        } else {
            combined.trim().to_string()
        });
    }

    let conflict = git_conflict_file_content(project_root, file_path.clone())?;
    if !conflict.conflicted {
        return Err(format!(
            "Git could not reopen the conflict in {}",
            file_path
        ));
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Reopened conflict in {}", file_path),
    })
}

pub fn git_panel_status(project_root: String) -> Result<GitPanelStatus, String> {
    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => {
            return Ok(GitPanelStatus {
                repo_found: false,
                branch: None,
                upstream_branch: None,
                ahead: 0,
                behind: 0,
                staged: 0,
                unstaged: 0,
                untracked: 0,
                conflicted: 0,
                operation: None,
                can_push: false,
            })
        }
    };

    let branch = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(|name| name.to_string()));
    let upstream_comparison = branch.as_ref().and_then(|name| {
        let local_branch = repo.find_branch(name, git2::BranchType::Local).ok()?;
        let upstream_branch = local_branch.upstream().ok()?;
        let local_oid = local_branch.get().target()?;
        let upstream_oid = upstream_branch.get().target()?;
        let upstream_name = upstream_branch.name().ok().flatten()?.to_string();
        let (ahead, behind) = repo.graph_ahead_behind(local_oid, upstream_oid).ok()?;
        Some((
            upstream_name,
            u32::try_from(ahead).unwrap_or(u32::MAX),
            u32::try_from(behind).unwrap_or(u32::MAX),
        ))
    });
    let (upstream_branch, ahead, behind) = upstream_comparison
        .map(|(name, ahead, behind)| (Some(name), ahead, behind))
        .unwrap_or((None, 0, 0));
    let can_push = branch.is_some() && (upstream_branch.is_none() || ahead > 0);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to read git status: {}", e))?;

    let mut staged = 0_u32;
    let mut unstaged = 0_u32;
    let mut untracked = 0_u32;
    let mut conflicted = 0_u32;

    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_conflicted() {
            conflicted = conflicted.saturating_add(1);
            continue;
        }
        if status.is_wt_new() {
            untracked = untracked.saturating_add(1);
            continue;
        }
        if status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_index_renamed()
            || status.is_index_typechange()
        {
            staged = staged.saturating_add(1);
        }
        if status.is_wt_modified()
            || status.is_wt_deleted()
            || status.is_wt_renamed()
            || status.is_wt_typechange()
        {
            unstaged = unstaged.saturating_add(1);
        }
    }

    Ok(GitPanelStatus {
        repo_found: true,
        branch,
        upstream_branch,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicted,
        operation: repository_operation(repo.state()).map(str::to_string),
        can_push,
    })
}

pub fn git_panel_branches(project_root: String) -> Result<Vec<GitBranchInfo>, String> {
    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => return Ok(Vec::new()),
    };

    let mut branches = Vec::new();
    let branch_iter = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| format!("Failed to list branches: {}", e))?;

    for branch_result in branch_iter {
        let (branch, _) =
            branch_result.map_err(|e| format!("Failed to read branch entry: {}", e))?;
        let name = branch
            .name()
            .map_err(|e| format!("Failed to read branch name: {}", e))?
            .map(|value| value.to_string())
            .or_else(|| branch.get().shorthand().map(|value| value.to_string()));
        if let Some(name) = name {
            branches.push(GitBranchInfo {
                name,
                is_current: branch.is_head(),
            });
        }
    }

    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(branches)
}

pub fn git_panel_checkout_branch(
    project_root: String,
    branch: String,
) -> Result<GitCommandResult, String> {
    let target = branch.trim();
    if target.is_empty() {
        return Err("Branch name is required".to_string());
    }

    let repo = open_project_repo(&project_root)?;
    repo.find_branch(target, git2::BranchType::Local)
        .map_err(|_| format!("Branch '{}' not found", target))?;

    let output = run_git(&project_root, &["checkout", target])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        return Err(if combined.trim().is_empty() {
            "Failed to switch branch".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Switched to {}", target),
    })
}

pub fn git_panel_changed_files(project_root: String) -> Result<Vec<GitChangedFile>, String> {
    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => return Ok(Vec::new()),
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to read git status: {}", e))?;

    let mut by_path: HashMap<String, GitChangedFile> = HashMap::new();
    for entry in statuses.iter() {
        let Some(raw_path) = entry.path() else {
            continue;
        };
        let path = raw_path.replace('\\', "/");
        if path.is_empty() {
            continue;
        }
        let status = entry.status();
        let item = by_path.entry(path.clone()).or_insert(GitChangedFile {
            path,
            staged: false,
            unstaged: false,
            untracked: false,
            conflicted: false,
        });

        if status.is_conflicted() {
            item.conflicted = true;
        }
        if status.is_wt_new() {
            item.untracked = true;
        }
        if status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_index_renamed()
            || status.is_index_typechange()
        {
            item.staged = true;
        }
        if status.is_wt_modified()
            || status.is_wt_deleted()
            || status.is_wt_renamed()
            || status.is_wt_typechange()
        {
            item.unstaged = true;
        }
    }

    for path in merge_operation_touched_paths(&repo)? {
        by_path.entry(path.clone()).or_insert(GitChangedFile {
            path,
            staged: false,
            unstaged: false,
            untracked: false,
            conflicted: false,
        });
    }

    let mut files: Vec<GitChangedFile> = by_path.into_values().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

pub fn git_panel_graph(
    project_root: String,
    limit: Option<u32>,
) -> Result<Vec<GitGraphCommit>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let limit_str = limit.to_string();
    let output = run_git(
        &project_root,
        &[
            "--no-pager",
            "log",
            "--all",
            "--date-order",
            "--decorate=short",
            "--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ct%x1f%D",
            "-n",
            &limit_str,
        ],
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if stderr.contains("does not have any commits yet") {
            return Ok(Vec::new());
        }
        return Err(if stderr.trim().is_empty() {
            "Failed to read git graph".to_string()
        } else {
            stderr
        });
    }

    let mut commits = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.split('\x1f');
        let hash = parts.next().unwrap_or("").trim().to_string();
        let short_hash = parts.next().unwrap_or("").trim().to_string();
        let parents = parts
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let subject = parts.next().unwrap_or("").trim().to_string();
        let author = parts.next().unwrap_or("").trim().to_string();
        let committed_at = parts
            .next()
            .unwrap_or("")
            .trim()
            .parse::<i64>()
            .unwrap_or(0);
        let refs = parts
            .next()
            .unwrap_or("")
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>();
        if hash.is_empty() {
            continue;
        }
        let is_head = refs
            .iter()
            .any(|item| item == "HEAD" || item.starts_with("HEAD -> "));
        commits.push(GitGraphCommit {
            hash,
            short_hash,
            subject,
            author,
            committed_at,
            refs,
            parents,
            is_head,
        });
    }

    Ok(commits)
}

pub fn git_panel_rebase_onto(
    project_root: String,
    target_commit: String,
) -> Result<GitCommandResult, String> {
    let target = target_commit.trim();
    if target.is_empty() {
        return Err("Select a rebase target".to_string());
    }

    let repo = open_project_repo(&project_root)?;
    if repo.state() != RepositoryState::Clean {
        return Err("Finish or abort the current Git operation before rebasing".to_string());
    }
    let has_changes = {
        let statuses = repo
            .statuses(None)
            .map_err(|error| format!("Failed to read Git status: {error}"))?;
        !statuses.is_empty()
    };
    if has_changes {
        return Err("Commit or stash local changes before rebasing".to_string());
    }

    let target_oid = Oid::from_str(target).map_err(|_| "Invalid rebase target".to_string())?;
    repo.find_commit(target_oid)
        .map_err(|_| "The selected rebase target no longer exists".to_string())?;
    let head_oid = repo
        .head()
        .and_then(|reference| reference.peel_to_commit())
        .map_err(|error| format!("Failed to read HEAD: {error}"))?
        .id();
    if head_oid == target_oid {
        return Ok(GitCommandResult {
            success: true,
            message: "The current branch is already at the selected commit".to_string(),
        });
    }
    let branch = repo
        .head()
        .ok()
        .and_then(|reference| reference.shorthand().map(str::to_string))
        .unwrap_or_else(|| "current branch".to_string());
    drop(repo);

    let output = run_git_without_editor(&project_root, &["rebase", target])?;
    if !output.status.success() {
        if let Some(conflict) = conflict_result(&project_root, "Rebase")? {
            return Ok(conflict);
        }
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            "Rebase failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Rebased {} onto {}", branch, &target[..target.len().min(8)]),
    })
}

pub fn git_panel_continue_rebase(project_root: String) -> Result<GitCommandResult, String> {
    let repo = open_project_repo(&project_root)?;
    if !matches!(
        repo.state(),
        RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge
    ) {
        return Err("No rebase is currently in progress".to_string());
    }
    let conflicts = repository_conflicted_paths(&repo)?;
    if !conflicts.is_empty() {
        return Ok(GitCommandResult {
            success: false,
            message: conflict_message(conflicts.len()).to_string(),
        });
    }
    drop(repo);

    let output = run_git_without_editor(&project_root, &["rebase", "--continue"])?;
    if !output.status.success() {
        if let Some(conflict) = conflict_result(&project_root, "Rebase")? {
            return Ok(conflict);
        }
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            "Failed to continue rebase".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: "Rebase completed".to_string(),
    })
}

pub fn git_panel_history(
    project_root: String,
    limit: Option<u32>,
) -> Result<Vec<GitHistoryEntry>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let limit_str = limit.to_string();
    let output = run_git(
        &project_root,
        &[
            "--no-pager",
            "log",
            "--decorate=short",
            "--pretty=format:%h%x1f%s%x1f%an%x1f%D",
            "-n",
            &limit_str,
        ],
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if stderr.contains("does not have any commits yet") {
            return Ok(Vec::new());
        }
        return Err(if stderr.trim().is_empty() {
            "Failed to read git history".to_string()
        } else {
            stderr
        });
    }

    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.split('\x1f');
        let hash = parts.next().unwrap_or("").trim().to_string();
        let subject = parts.next().unwrap_or("").trim().to_string();
        let author = parts.next().unwrap_or("").trim().to_string();
        let refs_raw = parts.next().unwrap_or("").trim().to_string();
        if hash.is_empty() {
            continue;
        }
        let refs: Vec<String> = refs_raw
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect();
        let is_head = refs
            .iter()
            .any(|item| item == "HEAD" || item.starts_with("HEAD -> "));

        entries.push(GitHistoryEntry {
            hash,
            subject,
            author,
            refs,
            is_head,
        });
    }

    Ok(entries)
}

pub fn git_panel_commit(
    project_root: String,
    message: String,
    include_unstaged: Option<bool>,
) -> Result<GitCommandResult, String> {
    let commit_message = message.trim();
    if commit_message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    if include_unstaged.unwrap_or(true) {
        let add_output = run_git(&project_root, &["add", "-A"])?;
        if !add_output.status.success() {
            let err = String::from_utf8_lossy(&add_output.stderr).to_string();
            return Err(if err.trim().is_empty() {
                "Failed to stage changes".to_string()
            } else {
                err
            });
        }
    }

    let commit_output = run_git(&project_root, &["commit", "-m", commit_message])?;
    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&commit_output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        if combined.contains("nothing to commit") {
            return Ok(GitCommandResult {
                success: true,
                message: "Nothing to commit".to_string(),
            });
        }
        return Err(if combined.trim().is_empty() {
            "Commit failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: "Commit created".to_string(),
    })
}

pub fn git_panel_commit_all(
    project_root: String,
    message: String,
) -> Result<GitCommandResult, String> {
    git_panel_commit(project_root, message, Some(true))
}

pub fn git_panel_commit_selected(
    project_root: String,
    message: String,
    selected_files: Vec<String>,
) -> Result<GitCommandResult, String> {
    let commit_message = message.trim();
    if commit_message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    let repository_state = open_project_repo(&project_root)?.state();
    if repository_state != RepositoryState::Clean && repository_state != RepositoryState::Merge {
        let operation = repository_operation(repository_state).unwrap_or("Git operation");
        return Err(format!(
            "Finish the current {} with Git before creating another commit",
            operation
        ));
    }

    let unique_paths = normalize_unique_paths(selected_files);
    if unique_paths.is_empty() && repository_state != RepositoryState::Merge {
        return Err("Select at least one file to commit".to_string());
    }

    if !unique_paths.is_empty() {
        let mut add_args = vec!["add".to_string(), "--".to_string()];
        add_args.extend(unique_paths.iter().cloned());
        let add_output = run_git_dynamic(&project_root, &add_args)?;
        if !add_output.status.success() {
            let err = String::from_utf8_lossy(&add_output.stderr).to_string();
            return Err(if err.trim().is_empty() {
                "Failed to stage selected files".to_string()
            } else {
                err
            });
        }
    }

    let mut commit_args = vec![
        "commit".to_string(),
        "-m".to_string(),
        commit_message.to_string(),
    ];
    if repository_state == RepositoryState::Clean {
        commit_args.push("--".to_string());
        commit_args.extend(unique_paths.iter().cloned());
    } else {
        commit_args.push("--allow-empty".to_string());
    }
    let commit_output = run_git_dynamic(&project_root, &commit_args)?;
    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&commit_output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        if combined.contains("nothing to commit") {
            return Ok(GitCommandResult {
                success: true,
                message: "Nothing to commit".to_string(),
            });
        }
        if let Some(conflict) = conflict_result(&project_root, "Commit")? {
            return Err(conflict.message);
        }
        return Err(if combined.trim().is_empty() {
            "Commit failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: if repository_state == RepositoryState::Clean {
            "Commit created".to_string()
        } else {
            format!(
                "{} completed",
                repository_operation(repository_state).unwrap_or("Git operation")
            )
        },
    })
}

pub fn git_panel_add_all(project_root: String) -> Result<GitCommandResult, String> {
    let add_output = run_git(&project_root, &["add", "-A"])?;
    if !add_output.status.success() {
        let err = String::from_utf8_lossy(&add_output.stderr).to_string();
        return Err(if err.trim().is_empty() {
            "Failed to stage changes".to_string()
        } else {
            err
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: "Staged all changes".to_string(),
    })
}

pub fn git_panel_pull(project_root: String) -> Result<GitCommandResult, String> {
    let output = run_git(&project_root, &["pull", "--no-rebase"])?;
    if !output.status.success() {
        if let Some(conflict) = conflict_result(&project_root, "Pull")? {
            return Ok(conflict);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        return Err(if combined.trim().is_empty() {
            "Pull failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: "Pull complete".to_string(),
    })
}

pub fn git_panel_stash(
    project_root: String,
    message: Option<String>,
) -> Result<GitCommandResult, String> {
    let mut args = vec!["stash".to_string(), "push".to_string(), "-u".to_string()];
    let trimmed = message.as_deref().map(str::trim).unwrap_or("");
    if !trimmed.is_empty() {
        args.push("-m".to_string());
        args.push(trimmed.to_string());
    }
    run_stash_push(&project_root, &args)
}

fn parse_git_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    format!("{}\n{}", stdout, stderr)
}

fn latest_stash_reference(project_root: &str) -> Result<Option<String>, String> {
    let output = run_git(project_root, &["stash", "list", "-n", "1", "--format=%gd"])?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            "Failed to read stash list".to_string()
        } else {
            combined.trim().to_string()
        });
    }
    let reference = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string);
    Ok(reference)
}

fn run_stash_push(project_root: &str, args: &[String]) -> Result<GitCommandResult, String> {
    let output = run_git_dynamic(project_root, args)?;
    let combined = parse_git_output(&output);
    if !output.status.success() {
        if combined.contains("No local changes to save") {
            return Ok(GitCommandResult {
                success: true,
                message: "No local changes to stash".to_string(),
            });
        }
        return Err(if combined.trim().is_empty() {
            "Stash failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }
    Ok(GitCommandResult {
        success: true,
        message: "Changes stashed".to_string(),
    })
}

fn parse_stash_list(project_root: &str) -> Result<Vec<GitStashEntry>, String> {
    let output = run_git(project_root, &["stash", "list", "--format=%gd%x1f%gs"])?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            "Failed to list stashes".to_string()
        } else {
            combined.trim().to_string()
        });
    }
    let entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let mut parts = trimmed.splitn(2, '\u{1f}');
            let reference = parts.next()?.trim();
            if reference.is_empty() {
                return None;
            }
            let message = parts.next().unwrap_or("").trim();
            Some(GitStashEntry {
                reference: reference.to_string(),
                message: message.to_string(),
            })
        })
        .collect();
    Ok(entries)
}

fn run_pull(project_root: &str) -> Result<Option<GitCommandResult>, String> {
    let output = run_git(project_root, &["pull", "--no-rebase"])?;
    if !output.status.success() {
        if let Some(conflict) = conflict_result(project_root, "Pull")? {
            return Ok(Some(conflict));
        }
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            "Pull failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }
    Ok(None)
}

pub fn git_panel_pull_flow(
    project_root: String,
    message: Option<String>,
    stash_selected_files: Vec<String>,
    reapply_mode: Option<String>,
) -> Result<GitCommandResult, String> {
    let unique_paths = normalize_unique_paths(stash_selected_files);
    let mut created_stash_ref: Option<String> = None;
    if !unique_paths.is_empty() {
        let mut args = vec!["stash".to_string(), "push".to_string()];
        let trimmed = message.as_deref().map(str::trim).unwrap_or("");
        if !trimmed.is_empty() {
            args.push("-m".to_string());
            args.push(trimmed.to_string());
        }
        args.push("--".to_string());
        args.extend(unique_paths);
        let stash_result = run_stash_push(&project_root, &args)?;
        if stash_result.message != "No local changes to stash" {
            created_stash_ref = latest_stash_reference(&project_root)?;
        }
    }

    match run_pull(&project_root) {
        Ok(Some(mut conflict)) => {
            if let Some(stash_ref) = created_stash_ref.as_deref() {
                conflict.message.push_str(&format!(
                    " The selected local changes remain safely stored in {} and were not reapplied.",
                    stash_ref
                ));
            }
            return Ok(conflict);
        }
        Ok(None) => {}
        Err(pull_error) => {
            if let Some(stash_ref) = created_stash_ref.as_deref() {
                let restore_output = run_git(&project_root, &["stash", "pop", stash_ref])?;
                if !restore_output.status.success() {
                    if let Some(conflict) =
                        conflict_result(&project_root, "Restoring changes after the failed pull")?
                    {
                        return Ok(conflict);
                    }
                    let restore_error = parse_git_output(&restore_output);
                    return Err(format!(
                        "{}. The selected changes remain in {} because restoring them also failed: {}",
                        pull_error,
                        stash_ref,
                        restore_error.trim()
                    ));
                }
                return Err(format!(
                    "{}. The selected local changes were restored.",
                    pull_error
                ));
            }
            return Err(pull_error);
        }
    }

    let mode = reapply_mode.unwrap_or_else(|| "none".to_string());
    let mut message_parts = vec!["Pull complete".to_string()];
    if let Some(stash_ref) = created_stash_ref {
        if mode == "pop" || mode == "apply" {
            let output = run_git(&project_root, &["stash", mode.as_str(), stash_ref.as_str()])?;
            if !output.status.success() {
                if let Some(conflict) =
                    conflict_result(&project_root, "Pull completed, but reapplying the stash")?
                {
                    return Ok(conflict);
                }
                let combined = parse_git_output(&output);
                return Err(if combined.trim().is_empty() {
                    format!("Pull succeeded but stash {} failed", mode)
                } else {
                    combined.trim().to_string()
                });
            }
            message_parts.push(format!("Stash {} complete", mode));
        } else {
            message_parts.push("Stash kept".to_string());
        }
    }

    Ok(GitCommandResult {
        success: true,
        message: message_parts.join(". "),
    })
}

pub fn git_panel_stash_list(project_root: String) -> Result<Vec<GitStashEntry>, String> {
    parse_stash_list(&project_root)
}

pub fn git_panel_stash_files(
    project_root: String,
    stash_ref: String,
) -> Result<Vec<String>, String> {
    let trimmed_ref = stash_ref.trim();
    if trimmed_ref.is_empty() {
        return Err("stash_ref is required".to_string());
    }
    let output = run_git(
        &project_root,
        &["stash", "show", "--name-only", "--format=", trimmed_ref],
    )?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            "Failed to read stash files".to_string()
        } else {
            combined.trim().to_string()
        });
    }
    let files = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.replace('\\', "/"))
        .collect();
    Ok(files)
}

fn run_stash_action(
    project_root: &str,
    action: &str,
    stash_ref: &str,
) -> Result<GitCommandResult, String> {
    let output = run_git(project_root, &["stash", action, stash_ref])?;
    if !output.status.success() {
        if let Some(conflict) = conflict_result(project_root, "Stash update")? {
            return Ok(conflict);
        }
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            format!("Failed to {} stash", action)
        } else {
            combined.trim().to_string()
        });
    }
    Ok(GitCommandResult {
        success: true,
        message: format!("Stash {} complete", action),
    })
}

pub fn git_panel_stash_apply(
    project_root: String,
    stash_ref: String,
) -> Result<GitCommandResult, String> {
    let trimmed_ref = stash_ref.trim();
    if trimmed_ref.is_empty() {
        return Err("stash_ref is required".to_string());
    }
    run_stash_action(&project_root, "apply", trimmed_ref)
}

pub fn git_panel_stash_pop(
    project_root: String,
    stash_ref: String,
) -> Result<GitCommandResult, String> {
    let trimmed_ref = stash_ref.trim();
    if trimmed_ref.is_empty() {
        return Err("stash_ref is required".to_string());
    }
    run_stash_action(&project_root, "pop", trimmed_ref)
}

pub fn git_panel_stash_drop(
    project_root: String,
    stash_ref: String,
) -> Result<GitCommandResult, String> {
    let trimmed_ref = stash_ref.trim();
    if trimmed_ref.is_empty() {
        return Err("stash_ref is required".to_string());
    }
    run_stash_action(&project_root, "drop", trimmed_ref)
}

pub fn git_panel_abort_operation(project_root: String) -> Result<GitCommandResult, String> {
    let repo = open_project_repo(&project_root)?;
    let state = repo.state();
    let Some(operation) = repository_operation(state) else {
        return Err("No Git operation is currently in progress".to_string());
    };

    let args: &[&str] = match state {
        RepositoryState::Merge => &["merge", "--abort"],
        RepositoryState::Revert | RepositoryState::RevertSequence => &["revert", "--abort"],
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            &["cherry-pick", "--abort"]
        }
        RepositoryState::Bisect => &["bisect", "reset"],
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => &["rebase", "--abort"],
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => &["am", "--abort"],
        RepositoryState::Clean => unreachable!(),
    };
    let output = run_git(&project_root, args)?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        return Err(if combined.trim().is_empty() {
            format!("Failed to abort {}", operation)
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: format!("Aborted {}", operation),
    })
}

pub fn git_panel_reset_selected(
    project_root: String,
    selected_files: Vec<String>,
    untracked_files: Vec<String>,
) -> Result<GitCommandResult, String> {
    let head_output = run_git(&project_root, &["rev-parse", "--verify", "HEAD"])?;
    if !head_output.status.success() {
        return Err("Cannot reset: repository has no commits yet".to_string());
    }

    let unique_paths = normalize_unique_paths(selected_files);
    if unique_paths.is_empty() {
        return Err("Select at least one file to reset".to_string());
    }

    let reported_untracked: HashSet<String> = normalize_unique_paths(untracked_files)
        .into_iter()
        .collect();

    let mut explicitly_untracked = Vec::new();
    let mut tracked_candidates = Vec::new();
    for path in &unique_paths {
        if reported_untracked.contains(path) {
            explicitly_untracked.push(path.clone());
        } else {
            tracked_candidates.push(path.clone());
        }
    }

    let mut staged_additions = Vec::new();
    if !tracked_candidates.is_empty() {
        let mut added_args = vec![
            "diff".to_string(),
            "--cached".to_string(),
            "--name-only".to_string(),
            "--diff-filter=A".to_string(),
            "--".to_string(),
        ];
        added_args.extend(tracked_candidates.iter().cloned());
        let added_output = run_git_dynamic(&project_root, &added_args)?;
        if !added_output.status.success() {
            let stderr = String::from_utf8_lossy(&added_output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&added_output.stdout).to_string();
            let combined = format!("{}\n{}", stdout, stderr);
            return Err(if combined.trim().is_empty() {
                "Failed to inspect staged files for reset".to_string()
            } else {
                combined.trim().to_string()
            });
        }
        let added_set: HashSet<String> = String::from_utf8_lossy(&added_output.stdout)
            .lines()
            .map(|line| line.trim().replace('\\', "/"))
            .filter(|line| !line.is_empty())
            .collect();
        staged_additions.extend(
            tracked_candidates
                .iter()
                .filter(|path| added_set.contains(*path))
                .cloned(),
        );
    }

    let staged_additions_set: HashSet<String> = staged_additions.iter().cloned().collect();
    let restore_paths: Vec<String> = tracked_candidates
        .into_iter()
        .filter(|path| !staged_additions_set.contains(path))
        .collect();

    if !restore_paths.is_empty() {
        let mut restore_args = vec![
            "restore".to_string(),
            "--source=HEAD".to_string(),
            "--staged".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        restore_args.extend(restore_paths.iter().cloned());
        let restore_output = run_git_dynamic(&project_root, &restore_args)?;
        if !restore_output.status.success() {
            let stderr = String::from_utf8_lossy(&restore_output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&restore_output.stdout).to_string();
            let combined = format!("{}\n{}", stdout, stderr);
            return Err(if combined.trim().is_empty() {
                "Failed to reset selected tracked files".to_string()
            } else {
                combined.trim().to_string()
            });
        }
    }

    if !staged_additions.is_empty() {
        let mut unstage_args = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
        unstage_args.extend(staged_additions.iter().cloned());
        let unstage_output = run_git_dynamic(&project_root, &unstage_args)?;
        if !unstage_output.status.success() {
            let stderr = String::from_utf8_lossy(&unstage_output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&unstage_output.stdout).to_string();
            let combined = format!("{}\n{}", stdout, stderr);
            return Err(if combined.trim().is_empty() {
                "Failed to unstage selected new files".to_string()
            } else {
                combined.trim().to_string()
            });
        }
    }

    let mut cleanup_targets = explicitly_untracked;
    cleanup_targets.extend(staged_additions);
    if !cleanup_targets.is_empty() {
        let mut clean_args = vec!["clean".to_string(), "-fd".to_string(), "--".to_string()];
        clean_args.extend(cleanup_targets);
        let clean_output = run_git_dynamic(&project_root, &clean_args)?;
        if !clean_output.status.success() {
            let stderr = String::from_utf8_lossy(&clean_output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&clean_output.stdout).to_string();
            let combined = format!("{}\n{}", stdout, stderr);
            return Err(if combined.trim().is_empty() {
                "Failed to remove selected untracked files".to_string()
            } else {
                combined.trim().to_string()
            });
        }
    }

    let file_count = unique_paths.len();
    let noun = if file_count == 1 { "file" } else { "files" };
    Ok(GitCommandResult {
        success: true,
        message: format!("Reset {} {} to last commit", file_count, noun),
    })
}

pub fn git_panel_reset_all(project_root: String) -> Result<GitCommandResult, String> {
    let head_output = run_git(&project_root, &["rev-parse", "--verify", "HEAD"])?;
    if !head_output.status.success() {
        return Err("Cannot reset: repository has no commits yet".to_string());
    }

    let reset_output = run_git(&project_root, &["reset", "--hard", "HEAD"])?;
    if !reset_output.status.success() {
        let stderr = String::from_utf8_lossy(&reset_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&reset_output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        return Err(if combined.trim().is_empty() {
            "Reset failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    let clean_output = run_git(&project_root, &["clean", "-fd"])?;
    if !clean_output.status.success() {
        let stderr = String::from_utf8_lossy(&clean_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&clean_output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        return Err(if combined.trim().is_empty() {
            "Failed to remove untracked files".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: "Reset to last commit".to_string(),
    })
}

pub(crate) fn git_panel_pull_status_impl(project_root: &str) -> Result<GitPullStatus, String> {
    if open_project_repo(project_root).is_err() {
        return Ok(GitPullStatus {
            can_pull: false,
            behind: 0,
            behind_commits: Vec::new(),
        });
    }

    let upstream_output = run_git(
        project_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    if !upstream_output.status.success() {
        return Ok(GitPullStatus {
            can_pull: false,
            behind: 0,
            behind_commits: Vec::new(),
        });
    }

    let upstream = String::from_utf8_lossy(&upstream_output.stdout)
        .trim()
        .to_string();
    if upstream.is_empty() {
        return Ok(GitPullStatus {
            can_pull: false,
            behind: 0,
            behind_commits: Vec::new(),
        });
    }

    let remote = upstream
        .split('/')
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("origin");

    let fetch_output = run_git(project_root, &["fetch", remote])?;
    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&fetch_output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        return Err(if combined.trim().is_empty() {
            format!("Failed to fetch {}", remote)
        } else {
            combined.trim().to_string()
        });
    }

    let behind_output = run_git(project_root, &["rev-list", "--count", "HEAD..@{u}"])?;
    if !behind_output.status.success() {
        let stderr = String::from_utf8_lossy(&behind_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&behind_output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        return Err(if combined.trim().is_empty() {
            "Failed to determine pull status".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    let behind = String::from_utf8_lossy(&behind_output.stdout)
        .trim()
        .parse::<u32>()
        .unwrap_or(0);

    let behind_commits = if behind > 0 {
        let log_output = run_git(
            project_root,
            &["log", "--format=%h %s", "--max-count", "20", "HEAD..@{u}"],
        )?;
        if !log_output.status.success() {
            let stderr = String::from_utf8_lossy(&log_output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&log_output.stdout).to_string();
            let combined = format!("{}\n{}", stdout, stderr);
            return Err(if combined.trim().is_empty() {
                "Failed to list incoming commits".to_string()
            } else {
                combined.trim().to_string()
            });
        }
        String::from_utf8_lossy(&log_output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };

    Ok(GitPullStatus {
        can_pull: behind > 0,
        behind,
        behind_commits,
    })
}

fn run_panel_push(
    project_root: &str,
    force_with_lease: bool,
) -> Result<std::process::Output, String> {
    let upstream_output = run_git(
        project_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    if upstream_output.status.success() {
        let upstream_status = git_project_upstream_status(project_root.to_string())?;
        let explicit_target = upstream_status
            .remote_name
            .as_deref()
            .zip(upstream_status.local_branch.as_deref())
            .zip(upstream_status.upstream_branch.as_deref())
            .and_then(|((remote_name, local_branch), upstream_branch)| {
                upstream_branch
                    .strip_prefix(&format!("{remote_name}/"))
                    .filter(|remote_branch| *remote_branch != local_branch)
                    .map(|remote_branch| {
                        (
                            remote_name.to_string(),
                            format!("HEAD:refs/heads/{remote_branch}"),
                        )
                    })
            });
        if let Some((remote_name, refspec)) = explicit_target {
            let mut args = vec!["push".to_string()];
            if force_with_lease {
                args.push("--force-with-lease".to_string());
            }
            args.extend([remote_name, refspec]);
            run_git_dynamic(project_root, &args)
        } else {
            if force_with_lease {
                run_git(project_root, &["push", "--force-with-lease"])
            } else {
                run_git(project_root, &["push"])
            }
        }
    } else {
        let branch_output = run_git(project_root, &["branch", "--show-current"])?;
        let branch = String::from_utf8_lossy(&branch_output.stdout)
            .trim()
            .to_string();
        let remote_name = git_project_upstream_status(project_root.to_string())
            .ok()
            .and_then(|status| status.remote_name)
            .unwrap_or_else(|| "origin".to_string());
        let remote_output = run_git(project_root, &["remote", "get-url", &remote_name])?;
        if branch_output.status.success() && !branch.is_empty() && remote_output.status.success() {
            let mut args = vec!["push"];
            if force_with_lease {
                args.push("--force-with-lease");
            }
            args.extend(["--set-upstream", remote_name.as_str(), branch.as_str()]);
            run_git(project_root, &args)
        } else {
            if force_with_lease {
                run_git(project_root, &["push", "--force-with-lease"])
            } else {
                run_git(project_root, &["push"])
            }
        }
    }
}

fn fetch_tracked_upstream(project_root: &str) -> Result<(String, String, String), String> {
    let upstream = git_project_upstream_status(project_root.to_string())?;
    let remote_name = upstream
        .remote_name
        .ok_or_else(|| "No Git remote is configured for the current branch".to_string())?;
    let upstream_branch = upstream
        .upstream_branch
        .ok_or_else(|| "No upstream branch is configured for the current branch".to_string())?;
    let remote_branch = upstream_branch
        .strip_prefix(&format!("{remote_name}/"))
        .unwrap_or(upstream_branch.as_str())
        .to_string();
    let fetch_output = run_git(project_root, &["fetch", remote_name.as_str()])?;
    if !fetch_output.status.success() {
        return Err(
            "Could not fetch the remote changes. Check the connection and try again.".to_string(),
        );
    }
    Ok((remote_name, upstream_branch, remote_branch))
}

pub fn git_panel_push_recovery_preview(
    project_root: String,
) -> Result<GitPushRecoveryPreview, String> {
    let (remote_name, upstream_branch, remote_branch) = fetch_tracked_upstream(&project_root)?;
    let repo = open_project_repo(&project_root)?;
    let local = repo
        .head()
        .and_then(|reference| reference.peel_to_commit())
        .map_err(|error| format!("Failed to read the local commit: {error}"))?;
    let remote_reference = repo
        .find_reference(&format!("refs/remotes/{upstream_branch}"))
        .map_err(|error| format!("Failed to read the remote branch: {error}"))?;
    let remote = remote_reference
        .peel_to_commit()
        .map_err(|error| format!("Failed to read the remote commit: {error}"))?;
    let merge_index = repo
        .merge_commits(&local, &remote, None)
        .map_err(|error| format!("Failed to preview the merge: {error}"))?;
    let mut conflicted_files = HashSet::new();
    let conflicts = merge_index
        .conflicts()
        .map_err(|error| format!("Failed to inspect predicted conflicts: {error}"))?;
    for conflict in conflicts {
        let conflict =
            conflict.map_err(|error| format!("Failed to inspect a predicted conflict: {error}"))?;
        for entry in [&conflict.our, &conflict.their, &conflict.ancestor]
            .into_iter()
            .flatten()
        {
            let path = String::from_utf8_lossy(&entry.path).replace('\\', "/");
            if !path.is_empty() {
                conflicted_files.insert(path);
            }
        }
    }
    let mut conflicted_files = conflicted_files.into_iter().collect::<Vec<_>>();
    conflicted_files.sort();

    Ok(GitPushRecoveryPreview {
        remote_name,
        remote_branch,
        conflicted_files,
    })
}

pub fn git_panel_push(project_root: String) -> Result<GitCommandResult, String> {
    let output = run_panel_push(&project_root, false)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let combined = format!("{}\n{}", stdout, stderr);
        return Err(if combined.trim().is_empty() {
            "Push failed".to_string()
        } else {
            combined.trim().to_string()
        });
    }

    Ok(GitCommandResult {
        success: true,
        message: "Push complete".to_string(),
    })
}

pub fn git_panel_force_push(project_root: String) -> Result<GitCommandResult, String> {
    fetch_tracked_upstream(&project_root)?;
    let output = run_panel_push(&project_root, true)?;
    if !output.status.success() {
        let combined = parse_git_output(&output);
        let lower = combined.to_lowercase();
        return Err(
            if lower.contains("stale info") || lower.contains("force-with-lease") {
                "The remote changed again. Review the latest remote changes before force pushing."
                    .to_string()
            } else if combined.trim().is_empty() {
                "Force push failed".to_string()
            } else {
                combined.trim().to_string()
            },
        );
    }

    Ok(GitCommandResult {
        success: true,
        message: "Force push complete".to_string(),
    })
}

pub fn git_worktree_file_line_stats(project_root: String) -> Result<Vec<GitFileLineStats>, String> {
    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => return Ok(Vec::new()),
    };

    let repo_workdir = match repo.workdir() {
        Some(path) => path.to_path_buf(),
        None => return Ok(Vec::new()),
    };
    let project_root_path = PathBuf::from(&project_root);

    let head_tree = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .and_then(|commit| commit.tree().ok());

    let mut diff_options = DiffOptions::new();
    diff_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true);

    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut diff_options))
        .map_err(|e| format!("Failed to diff worktree: {}", e))?;

    let mut line_counts: HashMap<String, (u32, u32)> = HashMap::new();

    diff.foreach(
        &mut |_delta, _| true,
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            if let Some(path) =
                delta_project_relative_path(&delta, &repo_workdir, &project_root_path)
            {
                let entry = line_counts.entry(path).or_insert((0, 0));
                match line.origin() {
                    '+' => entry.0 = entry.0.saturating_add(1),
                    '-' => entry.1 = entry.1.saturating_add(1),
                    _ => {}
                }
            }
            true
        }),
    )
    .map_err(|e| format!("Failed to compute line stats: {}", e))?;

    let mut results: Vec<GitFileLineStats> = line_counts
        .into_iter()
        .filter_map(|(file_path, (added, deleted))| {
            if added == 0 && deleted == 0 {
                None
            } else {
                Some(GitFileLineStats {
                    file_path,
                    added,
                    deleted,
                })
            }
        })
        .collect();
    results.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    Ok(results)
}

pub fn git_ignored_paths(project_root: String) -> Result<Vec<String>, String> {
    let repo = match open_project_repo(&project_root) {
        Ok(repo) => repo,
        Err(_) => return Ok(Vec::new()),
    };

    let repo_workdir = match repo.workdir() {
        Some(path) => path.to_path_buf(),
        None => return Ok(Vec::new()),
    };
    let project_root_path = PathBuf::from(&project_root);

    let mut opts = StatusOptions::new();
    opts.include_ignored(true)
        .recurse_ignored_dirs(true)
        .include_untracked(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to read ignored paths: {}", e))?;

    let mut ignored = HashSet::new();
    for entry in statuses.iter() {
        if !entry.status().is_ignored() {
            continue;
        }
        let Some(repo_relative) = entry.path() else {
            continue;
        };
        let absolute = repo_workdir.join(repo_relative);
        let Ok(project_relative) = absolute.strip_prefix(&project_root_path) else {
            continue;
        };
        let mut normalized = project_relative.to_string_lossy().replace('\\', "/");
        while normalized.ends_with('/') {
            normalized.pop();
        }
        if normalized.is_empty() {
            continue;
        }
        ignored.insert(normalized);
    }

    let mut result: Vec<String> = ignored.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Return every recorded project file, including files unchanged in this commit.
pub fn history_snapshot_files(
    app: crate::host::ServiceContext,
    project_root: String,
    snapshot_id: String,
) -> Result<Vec<String>, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_snapshot_files_at(&project_root, &paths, &snapshot_id)
}

fn history_snapshot_files_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    snapshot_id: &str,
) -> Result<Vec<String>, String> {
    // Retention can rewrite and prune commits. Keep the selected tree alive
    // until its complete recorded file list has been collected.
    let _history_guard = lock_history_operations();
    let repo = open_repo_at(project_root, paths)?;
    let oid =
        Oid::from_str(snapshot_id).map_err(|error| format!("Invalid snapshot_id: {error}"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|error| format!("Snapshot not found: {error}"))?;
    let tree = commit
        .tree()
        .map_err(|error| format!("Tree error: {error}"))?;
    let mut names = tree_history_files(&repo, &tree, history_tracks_assets(&repo, &tree))?
        .into_keys()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>();
    names.sort();
    Ok(names)
}

pub fn history_file_at(
    app: crate::host::ServiceContext,
    project_root: String,
    snapshot_id: String,
    file_path: String,
) -> Result<String, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_file_at_with_paths(&project_root, &paths, snapshot_id, file_path)
}

fn history_file_at_with_paths(
    project_root: &str,
    paths: &ProjectStoragePaths,
    snapshot_id: String,
    file_path: String,
) -> Result<String, String> {
    if !has_text_editor_path(Path::new(&file_path)) {
        return Err("File is not part of text-editor history".to_string());
    }
    let repo = open_repo_at(project_root, paths)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;
    let entry = tree
        .get_path(Path::new(&file_path))
        .map_err(|e| format!("File not found in snapshot: {}", e))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| format!("Blob error: {}", e))?;

    if blob.is_binary() {
        return Err("Binary file".into());
    }

    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

/// Read recorded bytes without touching the source project or its Git index.
pub fn history_file_bytes(
    app: crate::host::ServiceContext,
    project_root: String,
    snapshot_id: String,
    file_path: String,
) -> Result<String, String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_file_bytes_at(&project_root, &paths, &snapshot_id, &file_path)
}

fn history_file_bytes_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    snapshot_id: &str,
    file_path: &str,
) -> Result<String, String> {
    let _history_guard = lock_history_operations();
    let repo = open_repo_at(project_root, paths)?;
    let oid = Oid::from_str(snapshot_id).map_err(|error| error.to_string())?;
    let tree = repo
        .find_commit(oid)
        .and_then(|commit| commit.tree())
        .map_err(|error| error.to_string())?;
    if !history_tracks_assets(&repo, &tree) {
        return Err("This snapshot does not record assets".into());
    }
    let path = Path::new(file_path);
    if is_history_internal_path(path)
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Invalid history file path".into());
    }
    let entry = tree.get_path(path).map_err(|error| error.to_string())?;
    if entry.filemode() == 0o120000 {
        return Err("Symbolic links are not recorded".into());
    }
    let blob = repo
        .find_blob(entry.id())
        .map_err(|error| error.to_string())?;
    Ok(BASE64_STANDARD.encode(blob.content()))
}

pub fn history_restore(
    app: crate::host::ServiceContext,
    project_root: String,
    snapshot_id: String,
) -> Result<SnapshotInfo, String> {
    let _comment_guard = app.comments.lock_project_blocking(&project_root)?;
    let paths = resolve_project_storage(&app, &project_root)?;
    let result = history_restore_at(&project_root, &paths, snapshot_id);
    app.comments.invalidate_agent_creations(&project_root)?;
    result
}

fn history_restore_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    snapshot_id: String,
) -> Result<SnapshotInfo, String> {
    let _history_guard = lock_history_operations();
    let repo = open_repo_at(project_root, paths)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    // Older snapshots have no local-comment coverage. Preserve current comments
    // in that case; the renderer remaps them against restored source text.
    let target_comments: Option<crate::comments::HistoryComments> = match tree.get_path(Path::new(HISTORY_COMMENTS_PATH)) {
        Ok(entry) => {
            let blob = repo.find_blob(entry.id()).map_err(|error| error.to_string())?;
            Some(serde_json::from_slice(blob.content()).map_err(|error| format!("Invalid comment history: {error}"))?)
        }
        Err(error) if error.code() == git2::ErrorCode::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let comment_directory = paths.data_dir.join("comments");
    if let Some(comments) = &target_comments {
        crate::comments::validate_history(&comment_directory, comments)?;
    }
    let before_comments = crate::comments::capture_reconciled_history(Path::new(project_root), &comment_directory)?;

    // Capture the current working tree before overwriting anything. Keep this
    // under the same operation lock, and do not run retention between commits:
    // maintenance could otherwise prune or rewrite the selected restore target.
    ensure_excludes(paths, &repo)?;
    let before_oid = rebuild_history_index(&repo, paths)?;
    let head = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if head.as_ref().map(|commit| commit.tree_id()) != Some(before_oid) {
        let before_tree = repo
            .find_tree(before_oid)
            .map_err(|error| format!("Pre-restore tree error: {error}"))?;
        let sig = default_signature()?;
        let parents: Vec<&git2::Commit> = head.iter().collect();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "[before-restore] Before restoring history",
            &before_tree,
            &parents,
        )
        .map_err(|error| format!("Could not save current work before restoring: {error}"))?;
    }
    drop(head);

    // Restore the file coverage declared by the selected snapshot.
    let restored = restore_tree_history_files(&repo, &tree).and_then(|()| {
        // A source-only rewind is still an app-owned edit. Preserve today's
        // comments and reset their disk baseline, just like a covered rewind.
        crate::comments::restore_history(&comment_directory, target_comments.as_ref().unwrap_or(&before_comments))?;
        Ok(())
    });
    if let Err(error) = restored {
        let before_tree = repo.find_tree(before_oid).map_err(|e| e.to_string())?;
        let source_rollback = restore_tree_history_files_with_partial(&repo, &before_tree, Some(&tree));
        let comment_rollback = crate::comments::restore_history(&comment_directory, &before_comments);
        return Err(format!("History restore failed: {error}. Source rollback: {source_rollback:?}; comment rollback: {comment_rollback:?}. The before-restore snapshot preserves your previous work."));
    }

    // Create a new "restore" commit on HEAD (not moving HEAD to old commit)
    let new_tree_oid = rebuild_history_index(&repo, paths)?;
    let new_tree = repo
        .find_tree(new_tree_oid)
        .map_err(|e| format!("Find tree error: {}", e))?;

    let sig = default_signature()?;
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = head_commit.iter().collect();

    let short_id = &snapshot_id[..8.min(snapshot_id.len())];
    let msg = format!("[restore] Restored to {}", short_id);
    let new_oid = repo
        .commit(Some("HEAD"), &sig, &sig, &msg, &new_tree, &parents)
        .map_err(|e| format!("Commit error: {}", e))?;

    drop(parents);
    drop(head_commit);
    drop(new_tree);
    drop(tree);
    drop(commit);
    drop(repo);
    let maintained_oid = match maintain_history(project_root, paths) {
        Ok(outcome) => outcome
            .rewritten_oids
            .get(&new_oid)
            .copied()
            .unwrap_or(new_oid),
        Err(error) => {
            eprintln!("[history] Automatic history maintenance deferred: {error}");
            snapshot_oid_after_maintenance_error(project_root, paths, new_oid)
        }
    };

    Ok(SnapshotInfo {
        id: maintained_oid.to_string(),
        message: msg,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files: vec![],
    })
}

pub fn history_add_label(
    app: crate::host::ServiceContext,
    project_root: String,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_add_label_at(&project_root, &paths, snapshot_id, label)
}

fn history_add_label_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    let _history_guard = lock_history_operations();
    let repo = open_repo_at(project_root, paths)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    let label = validate_label(&label)?;
    if tag_map(&repo)
        .get(&oid)
        .is_some_and(|labels| labels.iter().any(|value| value == label))
    {
        return Ok(());
    }
    repo.tag_lightweight(&label_name(label, oid), commit.as_object(), false)
        .map_err(|e| format!("Failed to create label: {}", e))?;

    Ok(())
}

pub fn history_remove_label(
    app: crate::host::ServiceContext,
    project_root: String,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    let paths = resolve_project_storage(&app, &project_root)?;
    history_remove_label_at(&project_root, &paths, snapshot_id, label)
}

fn history_remove_label_at(
    project_root: &str,
    paths: &ProjectStoragePaths,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    let _guard = lock_history_operations();
    let repo = open_repo_at(project_root, paths)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| e.to_string())?;
    let mut found = false;
    for (name, target) in history_tag_targets(&repo)? {
        if target == oid
            && display_label(name.strip_prefix("refs/tags/").unwrap_or(&name)).as_deref()
                == Some(label.as_str())
        {
            repo.find_reference(&name)
                .and_then(|mut reference| reference.delete())
                .map_err(|e| e.to_string())?;
            found = true;
        }
    }
    if !found {
        return Err("Label not found on this checkpoint".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Create a temp project dir with the given files.
    fn setup_project(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (name, content) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, content).unwrap();
        }
        dir
    }

    fn root(dir: &TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    fn test_paths(project_root: &str) -> ProjectStoragePaths {
        let data_dir = Path::new(project_root).join(".catalex");
        test_paths_in(data_dir)
    }

    fn test_paths_in(data_dir: PathBuf) -> ProjectStoragePaths {
        ProjectStoragePaths {
            project_id: "test-project".to_string(),
            history_dir: data_dir.join("history.git"),
            history_exclude_file: data_dir.join("history-exclude"),
            history_settings_file: data_dir.join("history-settings.json"),
            sessions_dir: data_dir.join("sessions"),
            agent_workspaces_dir: data_dir.join("agent-workspaces"),
            latex_build_dir: data_dir.join("latex-build"),
            cache_dir: data_dir.join("cache"),
            data_dir,
        }
    }

    fn history_init(project_root: String) -> Result<(), String> {
        history_init_at(&project_root, &test_paths(&project_root))
    }

    fn run_test_git(project_root: &str, args: &[&str]) {
        let output = run_git(project_root, args).unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn setup_conflicted_merge() -> TempDir {
        let dir = setup_project(&[("main.tex", "base\n")]);
        let project_root = root(&dir);
        git_project_init(project_root.clone()).unwrap();
        run_test_git(&project_root, &["config", "user.name", "Catalex Test"]);
        run_test_git(
            &project_root,
            &["config", "user.email", "test@catalex.local"],
        );
        run_test_git(&project_root, &["add", "main.tex"]);
        run_test_git(&project_root, &["commit", "-m", "Base"]);
        run_test_git(&project_root, &["checkout", "-b", "incoming"]);
        fs::write(dir.path().join("main.tex"), "incoming\n").unwrap();
        run_test_git(&project_root, &["commit", "-am", "Incoming"]);
        run_test_git(&project_root, &["checkout", "main"]);
        fs::write(dir.path().join("main.tex"), "local\n").unwrap();
        run_test_git(&project_root, &["commit", "-am", "Local"]);

        let merge = run_git(&project_root, &["merge", "incoming"]).unwrap();
        assert!(!merge.status.success(), "merge should create a conflict");
        dir
    }

    #[test]
    fn test_git_panel_reports_conflicts_and_operation() {
        let dir = setup_conflicted_merge();
        let project_root = root(&dir);

        let status = git_panel_status(project_root.clone()).unwrap();
        assert_eq!(status.conflicted, 1);
        assert_eq!(status.operation.as_deref(), Some("merge"));

        let files = git_panel_changed_files(project_root.clone()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "main.tex");
        assert!(files[0].conflicted);

        let result = conflict_result(&project_root, "Pull").unwrap().unwrap();
        assert!(!result.success);
        assert_eq!(result.message, "Conflict detected. Resolve it to continue.");
    }

    #[test]
    fn test_git_head_file_content_distinguishes_ignored_and_untracked_files() {
        let dir = setup_project(&[
            (".gitignore", "*.aux\n"),
            ("main.tex", "tracked\n"),
            ("build.aux", "ignored\n"),
            ("draft.tex", "untracked\n"),
        ]);
        let project_root = root(&dir);
        git_project_init(project_root.clone()).unwrap();
        run_test_git(&project_root, &["config", "user.name", "Catalex Test"]);
        run_test_git(
            &project_root,
            &["config", "user.email", "test@catalex.local"],
        );
        run_test_git(&project_root, &["add", ".gitignore", "main.tex"]);
        run_test_git(&project_root, &["commit", "-m", "Initial"]);

        let ignored = git_head_file_content(project_root.clone(), "build.aux".to_string()).unwrap();
        assert!(ignored.repo_found);
        assert!(ignored.ignored);
        assert_eq!(ignored.head_content, None);

        let untracked =
            git_head_file_content(project_root.clone(), "draft.tex".to_string()).unwrap();
        assert!(untracked.repo_found);
        assert!(!untracked.ignored);
        assert_eq!(untracked.head_content, None);

        let tracked = git_head_file_content(project_root, "main.tex".to_string()).unwrap();
        assert!(tracked.repo_found);
        assert!(!tracked.ignored);
        assert_eq!(tracked.head_content.as_deref(), Some("tracked\n"));
    }

    #[test]
    fn test_conflict_message_uses_singular_and_plural_copy() {
        assert_eq!(
            conflict_message(1),
            "Conflict detected. Resolve it to continue."
        );
        assert_eq!(
            conflict_message(2),
            "Conflicts detected. Resolve them to continue."
        );
    }

    #[test]
    fn test_git_panel_reads_and_resolves_conflict_versions() {
        let dir = setup_conflicted_merge();
        let project_root = root(&dir);

        let conflict =
            git_conflict_file_content(project_root.clone(), "main.tex".to_string()).unwrap();
        assert!(conflict.conflicted);
        assert_eq!(conflict.ancestor_content.as_deref(), Some("base\n"));
        assert_eq!(conflict.current_content.as_deref(), Some("local\n"));
        assert_eq!(conflict.incoming_content.as_deref(), Some("incoming\n"));

        fs::write(dir.path().join("main.tex"), "incoming\n").unwrap();
        let result =
            git_panel_resolve_conflict(project_root.clone(), "main.tex".to_string()).unwrap();
        assert!(result.success);

        let resolved = git_conflict_file_content(project_root, "main.tex".to_string()).unwrap();
        assert!(!resolved.conflicted);
    }

    #[test]
    fn test_git_panel_reopens_the_last_resolved_conflict() {
        let dir = setup_conflicted_merge();
        let project_root = root(&dir);

        fs::write(dir.path().join("main.tex"), "incoming\n").unwrap();
        git_panel_resolve_conflict(project_root.clone(), "main.tex".to_string()).unwrap();
        assert!(
            !git_conflict_file_content(project_root.clone(), "main.tex".to_string())
                .unwrap()
                .conflicted
        );

        let result =
            git_panel_reopen_conflict(project_root.clone(), "main.tex".to_string()).unwrap();
        assert!(result.success);

        let reopened = git_conflict_file_content(project_root, "main.tex".to_string()).unwrap();
        assert!(reopened.conflicted);
        assert_eq!(reopened.current_content.as_deref(), Some("local\n"));
        assert_eq!(reopened.incoming_content.as_deref(), Some("incoming\n"));
    }

    #[test]
    fn test_conflict_versions_preserve_already_merged_content() {
        let raw = "shared before\n<<<<<<< HEAD\ncurrent choice\n||||||| base\nbase choice\n=======\nincoming choice\n>>>>>>> incoming\nalready merged after\n";

        let (current, incoming) = parse_conflict_marker_versions(raw).unwrap();
        assert_eq!(
            current,
            "shared before\ncurrent choice\nalready merged after\n"
        );
        assert_eq!(
            incoming,
            "shared before\nincoming choice\nalready merged after\n"
        );
    }

    #[test]
    fn text_conflict_review_preserves_context_and_guards_worktree_changes() {
        let dir = setup_conflicted_merge();
        let project_root = root(&dir);
        let raw = "retained intro\n\n<<<<<<< HEAD\nlocal\n=======\nincoming\n>>>>>>> incoming\n\nretained end\n";
        fs::write(dir.path().join("main.tex"), raw).unwrap();
        let preview = git_conflict_file_content(project_root.clone(), "main.tex".into()).unwrap();
        let segments = preview.conflict_contents.as_ref().unwrap();
        assert!(segments
            .iter()
            .any(|segment| matches!(segment, crate::text_merge::ConflictSegment::Conflict { .. })));
        let selected = segments
            .iter()
            .map(|segment| match segment {
                crate::text_merge::ConflictSegment::Resolved { content } => content.as_str(),
                crate::text_merge::ConflictSegment::Conflict { ancestor, .. } => ancestor.as_str(),
            })
            .collect::<String>();
        assert!(selected.contains("retained intro"));
        assert!(selected.contains("base"));
        assert!(selected.contains("retained end"));
        fs::write(dir.path().join("main.tex"), "newer manual edit\n").unwrap();
        assert!(git_panel_resolve_conflict_review(
            project_root.clone(),
            "main.tex".into(),
            preview.version.clone(),
            Some(selected.clone())
        )
        .err()
        .unwrap()
        .contains("changed"));
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "newer manual edit\n"
        );
        fs::write(dir.path().join("main.tex"), raw).unwrap();
        let index_path = dir.path().join(".git/index");
        let original_index = fs::read(&index_path).unwrap();
        let repository = Repository::open(dir.path()).unwrap();
        let mut index = repository.index().unwrap();
        let mut changed_conflict = index.conflict_get(Path::new("main.tex")).unwrap();
        let current_entry = changed_conflict.our.as_mut().unwrap();
        current_entry.mode = 0o100755;
        index.add(current_entry).unwrap();
        index.write().unwrap();
        assert!(git_panel_resolve_conflict_review(
            project_root.clone(),
            "main.tex".into(),
            preview.version.clone(),
            Some(selected.clone())
        )
        .err()
        .unwrap()
        .contains("changed"));
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            raw
        );
        fs::write(index_path, original_index).unwrap();
        assert!(
            git_panel_resolve_conflict_review(
                project_root.clone(),
                "main.tex".into(),
                preview.version,
                Some(selected.clone())
            )
            .unwrap()
            .success
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            selected
        );
        assert!(
            !git_conflict_file_content(project_root.clone(), "main.tex".into())
                .unwrap()
                .conflicted
        );
        // The existing Git resolve-undo path remains available after staging.
        assert!(
            git_panel_reopen_conflict(project_root.clone(), "main.tex".into())
                .unwrap()
                .success
        );
        assert!(
            git_conflict_file_content(project_root, "main.tex".into())
                .unwrap()
                .conflicted
        );
    }

    #[test]
    fn test_git_panel_commit_selected_completes_merge() {
        let dir = setup_conflicted_merge();
        let project_root = root(&dir);
        fs::write(dir.path().join("main.tex"), "resolved\n").unwrap();

        let result = git_panel_commit_selected(
            project_root.clone(),
            "Resolve incoming changes".to_string(),
            vec!["main.tex".to_string()],
        )
        .unwrap();

        assert!(result.success);
        assert_eq!(result.message, "merge completed");
        let repo = Repository::open(&project_root).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "resolved\n"
        );
    }

    #[test]
    fn test_git_panel_commit_selected_completes_zero_diff_merge() {
        let dir = setup_conflicted_merge();
        let project_root = root(&dir);
        fs::write(dir.path().join("main.tex"), "local\n").unwrap();
        git_panel_resolve_conflict(project_root.clone(), "main.tex".to_string()).unwrap();

        let status = git_panel_status(project_root.clone()).unwrap();
        assert_eq!(status.conflicted, 0);
        assert_eq!(status.staged, 0);
        assert_eq!(status.operation.as_deref(), Some("merge"));

        let touched_files = git_panel_changed_files(project_root.clone()).unwrap();
        assert_eq!(touched_files.len(), 1);
        assert_eq!(touched_files[0].path, "main.tex");
        assert!(!touched_files[0].staged);
        assert!(!touched_files[0].unstaged);
        assert!(!touched_files[0].untracked);
        assert!(!touched_files[0].conflicted);

        let result = git_panel_commit_selected(
            project_root.clone(),
            "Keep current content".to_string(),
            vec![],
        )
        .unwrap();

        assert!(result.success);
        assert_eq!(result.message, "merge completed");
        let repo = Repository::open(&project_root).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "local\n"
        );
    }

    #[test]
    fn test_git_panel_abort_operation_restores_pre_merge_state() {
        let dir = setup_conflicted_merge();
        let project_root = root(&dir);

        let result = git_panel_abort_operation(project_root.clone()).unwrap();

        assert!(result.success);
        assert_eq!(result.message, "Aborted merge");
        let status = git_panel_status(project_root).unwrap();
        assert_eq!(status.conflicted, 0);
        assert_eq!(status.operation, None);
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "local\n"
        );
    }

    #[test]
    fn test_git_panel_graph_supports_selectable_rebase_targets() {
        let dir = setup_project(&[("main.tex", "base\n")]);
        let project_root = root(&dir);
        git_project_init(project_root.clone()).unwrap();
        run_test_git(&project_root, &["config", "user.name", "Catalex Test"]);
        run_test_git(
            &project_root,
            &["config", "user.email", "test@catalex.local"],
        );
        run_test_git(&project_root, &["add", "main.tex"]);
        run_test_git(&project_root, &["commit", "-m", "Base"]);
        run_test_git(&project_root, &["checkout", "-b", "feature"]);
        fs::write(dir.path().join("feature.tex"), "feature\n").unwrap();
        run_test_git(&project_root, &["add", "feature.tex"]);
        run_test_git(&project_root, &["commit", "-m", "Feature"]);
        run_test_git(&project_root, &["checkout", "main"]);
        fs::write(dir.path().join("remote.tex"), "remote\n").unwrap();
        run_test_git(&project_root, &["add", "remote.tex"]);
        run_test_git(&project_root, &["commit", "-m", "Main target"]);
        let main_target = Repository::open(&project_root)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        run_test_git(&project_root, &["checkout", "feature"]);

        let graph = git_panel_graph(project_root.clone(), Some(20)).unwrap();
        let target = graph
            .iter()
            .find(|commit| commit.hash == main_target.to_string())
            .unwrap();
        assert!(target.refs.iter().any(|reference| reference == "main"));
        assert!(target.committed_at > 0);
        assert!(graph.iter().any(|commit| commit.is_head));
        assert!(graph.iter().any(|commit| !commit.parents.is_empty()));

        let result = git_panel_rebase_onto(project_root.clone(), main_target.to_string()).unwrap();
        assert!(result.success);
        let repo = Repository::open(&project_root).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_id(0).unwrap(), main_target);
        assert!(dir.path().join("feature.tex").exists());
        assert!(dir.path().join("remote.tex").exists());
    }

    #[test]
    fn test_git_panel_rebase_conflicts_can_be_resolved_and_continued() {
        let dir = setup_project(&[("main.tex", "base\n")]);
        let project_root = root(&dir);
        git_project_init(project_root.clone()).unwrap();
        run_test_git(&project_root, &["config", "user.name", "Catalex Test"]);
        run_test_git(
            &project_root,
            &["config", "user.email", "test@catalex.local"],
        );
        run_test_git(&project_root, &["add", "main.tex"]);
        run_test_git(&project_root, &["commit", "-m", "Base"]);
        run_test_git(&project_root, &["checkout", "-b", "feature"]);
        fs::write(dir.path().join("main.tex"), "feature\n").unwrap();
        run_test_git(&project_root, &["commit", "-am", "Feature"]);
        run_test_git(&project_root, &["checkout", "main"]);
        fs::write(dir.path().join("main.tex"), "main\n").unwrap();
        run_test_git(&project_root, &["commit", "-am", "Main target"]);
        let main_target = Repository::open(&project_root)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        run_test_git(&project_root, &["checkout", "feature"]);

        let stopped = git_panel_rebase_onto(project_root.clone(), main_target.to_string()).unwrap();
        assert!(!stopped.success);
        let status = git_panel_status(project_root.clone()).unwrap();
        assert_eq!(status.operation.as_deref(), Some("rebase"));
        assert_eq!(status.conflicted, 1);

        fs::write(dir.path().join("main.tex"), "resolved\n").unwrap();
        git_panel_resolve_conflict(project_root.clone(), "main.tex".to_string()).unwrap();
        let continued = git_panel_continue_rebase(project_root.clone()).unwrap();
        assert!(continued.success);
        assert_eq!(continued.message, "Rebase completed");
        let repo = Repository::open(&project_root).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "resolved\n"
        );
    }

    #[test]
    fn test_git_project_init_creates_repository_in_project_root() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        let project_root = root(&dir);

        git_project_init(project_root.clone()).unwrap();

        let repo = Repository::open(project_root).unwrap();
        assert!(!repo.is_bare());
        assert_eq!(
            repo.find_reference("HEAD").unwrap().symbolic_target(),
            Some("refs/heads/main")
        );
    }

    #[test]
    fn test_git_project_complete_setup_writes_gitignore() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        let project_root = root(&dir);

        git_project_complete_setup(project_root.clone(), Some("*.aux\r\n*.log".to_string()))
            .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "*.aux\n*.log\n"
        );
        let repo = Repository::open(project_root).unwrap();
        assert_eq!(
            repo.find_reference("HEAD").unwrap().symbolic_target(),
            Some("refs/heads/main")
        );
    }

    #[test]
    fn test_git_project_connect_remote_records_upstream_for_unborn_main() {
        let remote_dir = TempDir::new().unwrap();
        let remote_repo = Repository::init_bare(remote_dir.path()).unwrap();
        let blob_oid = remote_repo.blob(b"remote").unwrap();
        let mut tree_builder = remote_repo.treebuilder(None).unwrap();
        tree_builder.insert("main.tex", blob_oid, 0o100644).unwrap();
        let tree_oid = tree_builder.write().unwrap();
        let tree = remote_repo.find_tree(tree_oid).unwrap();
        let signature = Signature::now("Catalex", "test@catalex.local").unwrap();
        remote_repo
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "Initial remote commit",
                &tree,
                &[],
            )
            .unwrap();

        let dir = setup_project(&[("main.tex", "local")]);
        let project_root = root(&dir);
        git_project_connect_remote(
            project_root.clone(),
            remote_dir.path().to_string_lossy().to_string(),
            Some("origin".to_string()),
            Some("main".to_string()),
        )
        .unwrap();

        let config = Repository::open(project_root).unwrap().config().unwrap();
        assert_eq!(config.get_string("branch.main.remote").unwrap(), "origin");
        assert_eq!(
            config.get_string("branch.main.merge").unwrap(),
            "refs/heads/main"
        );
    }

    #[test]
    fn test_git_project_connect_remote_initializes_and_sets_origin() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        let project_root = root(&dir);

        git_project_connect_remote(
            project_root.clone(),
            "https://github.com/example/paper.git".to_string(),
            None,
            None,
        )
        .unwrap();

        let repo = Repository::open(project_root).unwrap();
        let remote = repo.find_remote("origin").unwrap();
        assert_eq!(remote.url(), Some("https://github.com/example/paper.git"));
    }

    #[test]
    fn test_git_project_connect_remote_updates_existing_origin() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        let project_root = root(&dir);
        git_project_init(project_root.clone()).unwrap();

        git_project_connect_remote(
            project_root.clone(),
            "https://github.com/example/first.git".to_string(),
            None,
            None,
        )
        .unwrap();
        git_project_connect_remote(
            project_root.clone(),
            "git@github.com:example/second.git".to_string(),
            None,
            None,
        )
        .unwrap();

        let repo = Repository::open(project_root).unwrap();
        let remote = repo.find_remote("origin").unwrap();
        assert_eq!(remote.url(), Some("git@github.com:example/second.git"));

        let status = git_project_upstream_status(root(&dir)).unwrap();
        assert_eq!(status.remote_name.as_deref(), Some("origin"));
        assert_eq!(
            status.remote_url.as_deref(),
            Some("git@github.com:example/second.git")
        );
        assert_eq!(status.upstream_branch, None);
    }

    #[test]
    fn test_git_remote_inspection_and_different_named_tracking_branch() {
        let remote_dir = TempDir::new().unwrap();
        let remote_repo = Repository::init_bare(remote_dir.path()).unwrap();
        let blob_oid = remote_repo.blob(b"\\documentclass{article}").unwrap();
        let mut tree_builder = remote_repo.treebuilder(None).unwrap();
        tree_builder.insert("main.tex", blob_oid, 0o100644).unwrap();
        let tree_oid = tree_builder.write().unwrap();
        let tree = remote_repo.find_tree(tree_oid).unwrap();
        let signature = Signature::now("Catalex", "test@catalex.local").unwrap();
        remote_repo
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "Initial remote commit",
                &tree,
                &[],
            )
            .unwrap();
        remote_repo
            .reference_symbolic("HEAD", "refs/heads/main", true, "Set default branch")
            .unwrap();

        let remote_url = remote_dir.path().to_string_lossy().to_string();
        let inspection = git_remote_inspect_impl(&remote_url).unwrap();
        assert_eq!(inspection.branches, vec!["main"]);

        let checkout_parent = TempDir::new().unwrap();
        let project_path = checkout_parent.path().join("project");
        let clone_output = Command::new("git")
            .args([
                "clone",
                "--",
                remote_url.as_str(),
                project_path.to_string_lossy().as_ref(),
            ])
            .output()
            .unwrap();
        assert!(clone_output.status.success());
        let project_root = project_path.to_string_lossy().to_string();
        let rename_output = run_git(&project_root, &["branch", "-m", "dev"]).unwrap();
        assert!(rename_output.status.success());

        git_project_connect_remote(
            project_root.clone(),
            remote_url,
            Some("origin".to_string()),
            Some("main".to_string()),
        )
        .unwrap();

        let status = git_project_upstream_status(project_root.clone()).unwrap();
        assert_eq!(status.local_branch.as_deref(), Some("dev"));
        assert_eq!(status.upstream_branch.as_deref(), Some("origin/main"));

        fs::write(project_path.join("main.tex"), "\\documentclass{book}").unwrap();
        assert!(run_git(&project_root, &["add", "main.tex"])
            .unwrap()
            .status
            .success());
        assert!(run_git(
            &project_root,
            &[
                "-c",
                "user.name=Catalex",
                "-c",
                "user.email=test@catalex.local",
                "commit",
                "-m",
                "Update document",
            ],
        )
        .unwrap()
        .status
        .success());

        git_panel_push(project_root.clone()).unwrap();

        let local_repo = Repository::open(&project_root).unwrap();
        let local_head = local_repo.head().unwrap().target().unwrap();
        let remote_main = remote_repo
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(remote_main, local_head);
        assert!(remote_repo.find_reference("refs/heads/dev").is_err());

        git_project_save_remote(
            project_root.clone(),
            None,
            "backup".to_string(),
            remote_dir.path().to_string_lossy().to_string(),
            None,
            None,
        )
        .unwrap();
        let configuration = git_project_remote_configuration(project_root.clone()).unwrap();
        assert_eq!(configuration.current_branch.as_deref(), Some("dev"));
        assert_eq!(configuration.local_branches, vec!["dev"]);
        assert_eq!(configuration.remotes.len(), 2);
        assert_eq!(configuration.remotes[0].name, "origin");
        assert_eq!(
            configuration.remotes[0].local_branch.as_deref(),
            Some("dev")
        );
        assert_eq!(
            configuration.remotes[0].remote_branch.as_deref(),
            Some("main")
        );
        assert_eq!(configuration.remotes[1].name, "backup");
        assert_eq!(configuration.remotes[1].local_branch, None);

        git_project_save_remote(
            project_root.clone(),
            Some("backup".to_string()),
            "github".to_string(),
            remote_dir.path().to_string_lossy().to_string(),
            Some("dev".to_string()),
            Some("main".to_string()),
        )
        .unwrap();
        let configuration = git_project_remote_configuration(project_root.clone()).unwrap();
        assert!(configuration
            .remotes
            .iter()
            .any(|remote| remote.name == "origin" && remote.local_branch.is_none()));
        assert!(configuration.remotes.iter().any(|remote| {
            remote.name == "github"
                && remote.local_branch.as_deref() == Some("dev")
                && remote.remote_branch.as_deref() == Some("main")
        }));
        assert!(!configuration
            .remotes
            .iter()
            .any(|remote| remote.name == "backup"));

        git_project_delete_remote(project_root.clone(), "github".to_string()).unwrap();
        let configuration = git_project_remote_configuration(project_root).unwrap();
        assert_eq!(configuration.remotes.len(), 1);
        assert_eq!(configuration.remotes[0].name, "origin");
    }

    #[test]
    fn test_git_panel_push_sets_upstream_for_a_new_remote() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        let project_root = root(&dir);
        git_project_init(project_root.clone()).unwrap();

        let repo = Repository::open(&project_root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("main.tex")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = Signature::now("Catalex", "test@catalex.local").unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Initial commit",
            &tree,
            &[],
        )
        .unwrap();

        let remote_dir = TempDir::new().unwrap();
        Repository::init_bare(remote_dir.path()).unwrap();
        git_project_connect_remote(
            project_root.clone(),
            remote_dir.path().to_string_lossy().to_string(),
            Some("upstream".to_string()),
            None,
        )
        .unwrap();

        git_panel_push(project_root.clone()).unwrap();

        let upstream = run_git(
            &project_root,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .unwrap();
        assert!(upstream.status.success());
        assert!(String::from_utf8_lossy(&upstream.stdout).starts_with("upstream/"));

        let status = git_project_upstream_status(project_root).unwrap();
        assert_eq!(status.remote_name.as_deref(), Some("upstream"));
        assert!(status
            .upstream_branch
            .as_deref()
            .is_some_and(|branch| branch.starts_with("upstream/")));
    }

    #[test]
    fn test_push_recovery_previews_conflicts_and_force_pushes_with_lease() {
        let remote_dir = TempDir::new().unwrap();
        let remote_repo = Repository::init_bare(remote_dir.path()).unwrap();
        let blob_oid = remote_repo.blob(b"base\n").unwrap();
        let mut tree_builder = remote_repo.treebuilder(None).unwrap();
        tree_builder.insert("main.tex", blob_oid, 0o100644).unwrap();
        let tree_oid = tree_builder.write().unwrap();
        let tree = remote_repo.find_tree(tree_oid).unwrap();
        let signature = Signature::now("Catalex", "test@catalex.local").unwrap();
        remote_repo
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "Initial remote commit",
                &tree,
                &[],
            )
            .unwrap();
        remote_repo
            .reference_symbolic("HEAD", "refs/heads/main", true, "Set default branch")
            .unwrap();

        let clones = TempDir::new().unwrap();
        let remote_url = remote_dir.path().to_string_lossy().to_string();
        let overleaf_path = clones.path().join("overleaf");
        let local_path = clones.path().join("local");
        for path in [&overleaf_path, &local_path] {
            let clone = Command::new("git")
                .args([
                    "clone",
                    "--",
                    remote_url.as_str(),
                    path.to_string_lossy().as_ref(),
                ])
                .output()
                .unwrap();
            assert!(clone.status.success());
            let project_root = path.to_string_lossy();
            run_test_git(&project_root, &["config", "user.name", "Catalex Test"]);
            run_test_git(
                &project_root,
                &["config", "user.email", "test@catalex.local"],
            );
        }

        fs::write(overleaf_path.join("main.tex"), "overleaf\n").unwrap();
        let overleaf_root = overleaf_path.to_string_lossy().to_string();
        run_test_git(&overleaf_root, &["add", "main.tex"]);
        run_test_git(&overleaf_root, &["commit", "-m", "Overleaf update"]);
        run_test_git(&overleaf_root, &["push"]);

        fs::write(local_path.join("main.tex"), "local\n").unwrap();
        let local_root = local_path.to_string_lossy().to_string();
        run_test_git(&local_root, &["add", "main.tex"]);
        run_test_git(&local_root, &["commit", "-m", "Local update"]);

        let push_error = match git_panel_push(local_root.clone()) {
            Ok(_) => panic!("divergent push should be rejected"),
            Err(error) => error,
        };
        assert!(
            push_error.contains("fetch first")
                || push_error.contains("non-fast-forward")
                || push_error.contains("[rejected]")
        );

        let preview = git_panel_push_recovery_preview(local_root.clone()).unwrap();
        assert_eq!(preview.remote_name, "origin");
        assert_eq!(preview.remote_branch, "main");
        assert_eq!(preview.conflicted_files, vec!["main.tex"]);
        let divergent_status = git_panel_status(local_root.clone()).unwrap();
        assert_eq!(
            divergent_status.upstream_branch.as_deref(),
            Some("origin/main")
        );
        assert_eq!(divergent_status.ahead, 1);
        assert_eq!(divergent_status.behind, 1);
        assert!(divergent_status.can_push);

        let result = git_panel_force_push(local_root.clone()).unwrap();
        assert!(result.success);
        assert_eq!(result.message, "Force push complete");
        let local_head = Repository::open(local_root)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        let remote_head = remote_repo
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(remote_head, local_head);
    }

    #[test]
    fn test_parse_overleaf_clone_command_extracts_project_id() {
        let (url, project_name) = parse_overleaf_clone_command(
            "git clone https://git@git.overleaf.com/6a60d23e3849ddde7938c854",
        )
        .unwrap();

        assert_eq!(url, "https://git@git.overleaf.com/6a60d23e3849ddde7938c854");
        assert_eq!(project_name, "6a60d23e3849ddde7938c854");
    }

    #[test]
    fn test_parse_overleaf_clone_command_rejects_arbitrary_commands() {
        let result = parse_overleaf_clone_command("git clone https://example.com/project");
        assert!(result.unwrap_err().contains("git.overleaf.com"));

        let result = parse_overleaf_clone_command("rm -rf project");
        assert!(result.unwrap_err().contains("git clone"));
    }

    #[test]
    fn test_overleaf_credential_round_trip_and_missing_helper() {
        let temp = TempDir::new().unwrap();
        let project_root = root(&temp);
        run_test_git(&project_root, &["init"]);
        // Reset inherited helpers, so the test never reads or writes real credentials.
        run_test_git(&project_root, &["config", "credential.helper", ""]);
        assert!(save_overleaf_credential(temp.path(), "fake-test-token").is_err());
        let credential_file = temp.path().join("test-credentials");
        let helper = format!("store --file='{}'", credential_file.display());
        run_test_git(
            &project_root,
            &["config", "--add", "credential.helper", &helper],
        );
        save_overleaf_credential(temp.path(), "fake-test-token").unwrap();
        save_overleaf_credential(temp.path(), "replacement-test-token").unwrap();
        let stored = fs::read_to_string(credential_file).unwrap();
        assert!(stored.contains("replacement-test-token"));
        assert!(!stored.contains("fake-test-token"));
    }

    #[test]
    fn test_overleaf_clone_rejects_credential_protocol_injection() {
        let temp = TempDir::new().unwrap();
        let result = git_overleaf_clone(
            "git clone https://git@git.overleaf.com/project".into(),
            "token\npassword=injected".into(),
            "project".into(),
            root(&temp),
        );
        assert!(result.unwrap_err().contains("invalid characters"));
        assert!(!temp.path().join("project").exists());
    }

    #[test]
    fn test_overleaf_clone_rejects_local_name_with_path_separator() {
        let local_root = TempDir::new().unwrap();
        let result = git_overleaf_clone(
            "git clone https://git@git.overleaf.com/6a60d23e3849ddde7938c854".to_string(),
            "test-token".to_string(),
            "../other-folder".to_string(),
            root(&local_root),
        );

        assert!(result.unwrap_err().contains("Local name"));
    }

    fn history_snapshot(
        project_root: String,
        message: String,
    ) -> Result<Option<SnapshotInfo>, String> {
        history_snapshot_at(&project_root, &test_paths(&project_root), message)
    }

    fn history_list(
        project_root: String,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SnapshotInfo>, String> {
        history_list_at(&project_root, &test_paths(&project_root), limit, offset)
    }

    fn history_diff(
        project_root: String,
        from_id: String,
        to_id: String,
    ) -> Result<Vec<FileDiff>, String> {
        history_diff_at(&project_root, &test_paths(&project_root), from_id, to_id)
    }

    fn history_file_at(
        project_root: String,
        snapshot_id: String,
        file_path: String,
    ) -> Result<String, String> {
        history_file_at_with_paths(
            &project_root,
            &test_paths(&project_root),
            snapshot_id,
            file_path,
        )
    }

    fn history_restore(project_root: String, snapshot_id: String) -> Result<SnapshotInfo, String> {
        history_restore_at(&project_root, &test_paths(&project_root), snapshot_id)
    }

    fn history_add_label(
        project_root: String,
        snapshot_id: String,
        label: String,
    ) -> Result<(), String> {
        history_add_label_at(
            &project_root,
            &test_paths(&project_root),
            snapshot_id,
            label,
        )
    }

    fn history_remove_label(project_root: String, label: String) -> Result<(), String> {
        {
            let paths = test_paths(&project_root);
            let repo = open_repo_at(&project_root, &paths)?;
            let oid = tag_map(&repo).into_iter().find(|(_, labels)| labels.contains(&label)).map(|(oid, _)| oid).ok_or("Label not found")?;
            history_remove_label_at(&project_root, &paths, oid.to_string(), label)
        }
    }

    fn forced_history_maintenance<F>(
        project_root: &str,
        recent_snapshot_floor: usize,
        stage_hook: F,
    ) -> Result<HistoryMaintenanceOutcome, String>
    where
        F: FnMut(HistoryMaintenanceStage) -> Result<(), String>,
    {
        maintain_history_with_policy(
            project_root,
            &test_paths(project_root),
            HistoryMaintenancePolicy {
                storage_limit_bytes: u64::MAX,
                recent_snapshot_floor,
                loose_object_threshold: usize::MAX,
                force_compaction: true,
            },
            stage_hook,
        )
    }

    fn create_numbered_history(project: &TempDir, count: usize) -> Vec<SnapshotInfo> {
        let project_root = root(project);
        let mut snapshots = Vec::new();
        for index in 0..count {
            fs::write(project.path().join("main.tex"), format!("version {index}")).unwrap();
            snapshots.push(
                history_snapshot(project_root.clone(), format!("edit {index}"))
                    .unwrap()
                    .unwrap(),
            );
        }
        snapshots
    }

    fn open_repo(project_root: &str) -> Result<Repository, String> {
        open_repo_at(project_root, &test_paths(project_root))
    }

    fn ensure_excludes(project_root: &str, repo: &Repository) {
        super::ensure_excludes(&test_paths(project_root), repo).unwrap();
    }

    // ─── history_init ───

    #[test]
    fn test_history_init_creates_repo() {
        let dir = setup_project(&[
            ("main.tex", "\\documentclass{article}"),
            ("comments.json", "{\"version\":1,\"files\":{}}"),
        ]);
        history_init(root(&dir)).unwrap();

        let git_dir = dir.path().join(".catalex").join("history.git");
        assert!(git_dir.exists(), "history.git should be created");

        // Should have an initial commit
        let repo = Repository::open(&git_dir).unwrap();
        let head = repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert!(commit.message().unwrap().contains("[init]"));
        let tree = commit.tree().unwrap();
        assert!(tree.get_path(Path::new("comments.json")).is_ok());
    }

    #[test]
    fn test_history_init_idempotent() {
        let dir = setup_project(&[("main.tex", "hello")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        // Second call should succeed without error
        history_init(r).unwrap();
    }

    #[test]
    fn test_history_init_outside_source_does_not_create_project_gitlink() {
        let project = setup_project(&[("main.tex", "hello")]);
        let app_data = TempDir::new().unwrap();
        let paths = test_paths_in(app_data.path().join("project-state"));

        history_init_at(&root(&project), &paths).unwrap();

        assert!(!project.path().join(".git").exists());
        let history_repo = open_repo_at(&root(&project), &paths).unwrap();
        assert_eq!(
            fs::canonicalize(history_repo.workdir().unwrap()).unwrap(),
            fs::canonicalize(project.path()).unwrap()
        );
        let history_tree = history_repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(history_tree.get_path(Path::new("main.tex")).is_ok());
        assert!(history_tree.get_path(Path::new(".git")).is_err());
    }

    #[test]
    fn test_history_init_coexists_with_project_git_repo() {
        let project = setup_project(&[("main.tex", "hello")]);
        Repository::init(project.path()).unwrap();
        let app_data = TempDir::new().unwrap();
        let paths = test_paths_in(app_data.path().join("project-state"));

        history_init_at(&root(&project), &paths).unwrap();

        assert!(project.path().join(".git").is_dir());
        assert!(Repository::open(project.path()).is_ok());
        let history_repo = open_repo_at(&root(&project), &paths).unwrap();
        assert_eq!(
            fs::canonicalize(history_repo.workdir().unwrap()).unwrap(),
            fs::canonicalize(project.path()).unwrap()
        );
        let history_tree = history_repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(history_tree.get_path(Path::new("main.tex")).is_ok());
        assert!(history_tree.get_path(Path::new(".git")).is_err());
    }

    #[test]
    fn test_history_init_tracks_source_and_assets() {
        let project = setup_project(&[
            ("main.tex", "hello"),
            ("README.md", "notes"),
            ("data.csv", "x,y\n1,2\n"),
            ("figure.svg", "<svg></svg>"),
            ("paper.pdf", "%PDF fake input"),
        ]);
        fs::write(project.path().join("figure.png"), [0, 1, 2, 3]).unwrap();

        history_init(root(&project)).unwrap();

        let repo = open_repo(&root(&project)).unwrap();
        let tree = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(tree.get_path(Path::new("main.tex")).is_ok());
        assert!(tree.get_path(Path::new("README.md")).is_ok());
        assert!(tree.get_path(Path::new("data.csv")).is_ok());
        assert!(tree.get_path(Path::new("figure.svg")).is_ok());
        assert!(tree.get_path(Path::new("figure.png")).is_ok());
        assert!(tree.get_path(Path::new("paper.pdf")).is_ok());
    }

    #[test]
    fn test_history_init_repairs_empty_partial_repo() {
        let project = setup_project(&[("main.tex", "hello")]);
        let app_data = TempDir::new().unwrap();
        let paths = test_paths_in(app_data.path().join("project-state"));
        fs::create_dir_all(paths.history_dir.join(".git")).unwrap();

        history_init_at(&root(&project), &paths).unwrap();

        let history_repo = open_repo_at(&root(&project), &paths).unwrap();
        assert_eq!(
            fs::canonicalize(history_repo.workdir().unwrap()).unwrap(),
            fs::canonicalize(project.path()).unwrap()
        );
        assert!(history_repo.head().is_ok());
    }

    #[test]
    fn test_history_init_preserves_nonempty_corrupt_repo() {
        let project = setup_project(&[("main.tex", "hello")]);
        let app_data = TempDir::new().unwrap();
        let paths = test_paths_in(app_data.path().join("project-state"));
        let sentinel = paths.history_dir.join(".git/sentinel");
        fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        fs::write(&sentinel, "preserve me").unwrap();

        let error = history_init_at(&root(&project), &paths).unwrap_err();

        assert!(error.contains("Corrupt history repo"));
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "preserve me");
    }

    #[test]
    fn test_history_init_creates_excludes() {
        let dir = setup_project(&[("main.tex", "doc")]);
        history_init(root(&dir)).unwrap();

        let excludes = dir.path().join(".catalex").join("history-exclude");
        assert!(excludes.exists());
        let content = fs::read_to_string(&excludes).unwrap();
        assert!(content.contains("*.aux"));
        assert!(!content.contains("*.png"));
        assert!(!content.contains("*.svg"));
        assert!(!content.contains("/comments.json"));
        assert!(content.contains(".catalex/"));
        assert!(content.contains(".prism/"));
    }

    #[test]
    fn automatic_label_names_are_reserved_exactly() {
        assert!(validate_label("Agent").is_err());
        assert!(validate_label(" Comments ").is_err());
        assert!(validate_label("comments").is_ok());
        assert!(validate_label("agent").is_ok());
    }

    #[test]
    fn reusable_labels_roundtrip_remove_and_survive_retention() {
        let dir = setup_project(&[("main.tex", "one")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        let paths = test_paths(&r);
        let first = history_list(r.clone(), 100, 0).unwrap()[0].id.clone();
        fs::write(dir.path().join("main.tex"), "two").unwrap();
        let second = history_snapshot(r.clone(), "second".into())
            .unwrap()
            .unwrap()
            .id;
        let long_label = "初".repeat(80);
        history_add_label(r.clone(), first.clone(), long_label.clone()).unwrap();
        assert_eq!(display_label(&label_name(&long_label, Oid::from_str(&first).unwrap())), Some(long_label.clone()));
        history_remove_label_at(&r, &paths, first.clone(), long_label).unwrap();
        for custom in ["agent", "AGENT"] {
            history_add_label(r.clone(), first.clone(), custom.into()).unwrap();
            history_remove_label_at(&r, &paths, first.clone(), custom.into()).unwrap();
        }
        let label = "First draft / 初稿 ✨";
        for id in [&first, &second] {
            history_add_label(r.clone(), id.clone(), label.into()).unwrap();
            history_add_label(r.clone(), id.clone(), label.into()).unwrap();
        }
        let repo = open_repo_at(&r, &paths).unwrap();
        assert_eq!(
            tag_map(&repo)
                .values()
                .filter(|labels| labels.contains(&label.to_string()))
                .count(),
            2
        );
        assert_eq!(
            display_label(&label_name(label, Oid::from_str(&first).unwrap())).as_deref(),
            Some(label)
        );
        assert!(display_label("catalex-labels-v1/invalid/nope").is_none());
        assert!(history_add_label(r.clone(), first.clone(), " Agent ".into()).is_err());
        drop(repo);
        history_remove_label_at(&r, &paths, first.clone(), label.into()).unwrap();
        let repo = open_repo_at(&r, &paths).unwrap();
        assert!(!tag_map(&repo).contains_key(&Oid::from_str(&first).unwrap()));
        assert_eq!(
            tag_map(&repo)[&Oid::from_str(&second).unwrap()],
            vec![label]
        );
        repo.tag_lightweight(
            "legacy",
            repo.find_commit(Oid::from_str(&first).unwrap())
                .unwrap()
                .as_object(),
            false,
        )
        .unwrap();
        drop(repo);
        history_remove_label_at(&r, &paths, first, "legacy".into()).unwrap();
        let repo = open_repo_at(&r, &paths).unwrap();
        rewrite_retained_history(&repo, 1, &mut |_| Ok(())).unwrap();
        assert!(tag_map(&repo)
            .values()
            .any(|labels| labels.contains(&label.to_string())));
    }

    // ─── history_snapshot ───

    #[test]
    fn test_history_snapshot_after_modification() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Modify a file
        fs::write(dir.path().join("main.tex"), "v2").unwrap();

        let result = history_snapshot(r, "edited main.tex".into()).unwrap();
        assert!(result.is_some());
        let snap = result.unwrap();
        assert_eq!(snap.message, "edited main.tex");
        assert!(snap.changed_files.contains(&"main.tex".to_string()));
    }

    #[test]
    fn test_history_snapshot_detects_comment_changes() {
        let dir = setup_project(&[("main.tex", "v1"), ("comments.json", "{\"version\":1}")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(
            dir.path().join("comments.json"),
            "{\"version\":1,\"files\":{\"main.tex\":[]}}",
        )
        .unwrap();

        let snapshot = history_snapshot(r, "updated comments".into())
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.message, "updated comments");
        assert!(snapshot
            .changed_files
            .contains(&"comments.json".to_string()));
    }

    #[test]
    fn test_history_snapshot_no_change_returns_none() {
        let dir = setup_project(&[("main.tex", "same")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // No modification → None
        let result = history_snapshot(r, "no-op".into()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_history_snapshot_records_media_only_changes() {
        let dir = setup_project(&[("main.tex", "same"), ("figure.svg", "<svg>old</svg>")]);
        fs::write(dir.path().join("figure.png"), [0, 1, 2, 3]).unwrap();
        let project_root = root(&dir);
        history_init(project_root.clone()).unwrap();

        fs::write(dir.path().join("figure.svg"), "<svg>new</svg>").unwrap();
        fs::write(dir.path().join("figure.png"), [9, 8, 7, 6]).unwrap();
        fs::write(dir.path().join("appendix.pdf"), b"%PDF changed").unwrap();

        let result = history_snapshot(project_root.clone(), "media changed".into())
            .unwrap()
            .unwrap();
        assert_eq!(
            result.changed_files,
            ["appendix.pdf", "figure.png", "figure.svg"]
        );
        let snapshots = history_list(project_root.clone(), 10, 0).unwrap();
        let changes = history_diff(project_root, snapshots[1].id.clone(), result.id).unwrap();
        assert_eq!(changes.len(), 3);
        assert!(changes
            .iter()
            .all(|change| change.old_content.is_none() && change.new_content.is_none()));
    }

    #[test]
    fn test_history_snapshot_detects_new_file() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Add a new file
        fs::write(dir.path().join("chapter1.tex"), "new chapter").unwrap();

        let snap = history_snapshot(r, "add chapter".into()).unwrap().unwrap();
        assert!(snap.changed_files.contains(&"chapter1.tex".to_string()));
    }

    // ─── history_list ───

    #[test]
    fn test_history_list_after_snapshots() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "v2").unwrap();
        history_snapshot(r.clone(), "snap 1".into()).unwrap();

        fs::write(dir.path().join("main.tex"), "v3").unwrap();
        history_snapshot(r.clone(), "snap 2".into()).unwrap();

        let list = history_list(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3); // init + 2 snapshots
        let msgs: Vec<&str> = list.iter().map(|s| s.message.as_str()).collect();
        assert!(msgs.contains(&"snap 1"));
        assert!(msgs.contains(&"snap 2"));
        assert!(msgs.iter().any(|m| m.contains("[init]")));
    }

    #[test]
    fn test_history_list_pagination() {
        let dir = setup_project(&[("a.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("a.tex"), "y").unwrap();
        history_snapshot(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "z").unwrap();
        history_snapshot(r.clone(), "s2".into()).unwrap();

        // limit=1 → returns exactly 1 entry
        let page1 = history_list(r.clone(), 1, 0).unwrap();
        assert_eq!(page1.len(), 1);

        // offset=1 → returns a different entry
        let page2 = history_list(r.clone(), 1, 1).unwrap();
        assert_eq!(page2.len(), 1);
        assert_ne!(page1[0].id, page2[0].id);

        // All 3 entries accessible
        let all = history_list(r, 10, 0).unwrap();
        assert_eq!(all.len(), 3);
    }

    // ─── history_diff ───

    #[test]
    fn test_history_diff_shows_changes() {
        let dir = setup_project(&[("main.tex", "old content")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "new content").unwrap();
        let snap = history_snapshot(r.clone(), "update".into())
            .unwrap()
            .unwrap();

        let list = history_list(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id.clone();

        let diffs = history_diff(r, from_id, to_id).unwrap();
        assert!(!diffs.is_empty());
        let d = diffs.iter().find(|d| d.file_path == "main.tex").unwrap();
        assert_eq!(d.status, "modified");
        assert_eq!(d.old_content.as_deref(), Some("old content"));
        assert_eq!(d.new_content.as_deref(), Some("new content"));
    }

    #[test]
    fn test_history_diff_added_file() {
        let dir = setup_project(&[("a.tex", "a")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("b.tex"), "new file").unwrap();
        let snap = history_snapshot(r.clone(), "add b".into())
            .unwrap()
            .unwrap();

        let list = history_list(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id;

        let diffs = history_diff(r, from_id, to_id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "added");
        assert!(d.old_content.is_none());
        assert_eq!(d.new_content.as_deref(), Some("new file"));
    }

    // ─── history_file_at ───

    #[test]
    fn test_history_file_at_returns_content() {
        let dir = setup_project(&[("main.tex", "version one")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        let content = history_file_at(r, init_id, "main.tex".into()).unwrap();
        assert_eq!(content, "version one");
    }

    #[test]
    fn test_history_file_at_nonexistent_file_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        let result = history_file_at(r, id, "nonexistent.tex".into());
        assert!(result.is_err());
    }

    #[test]
    fn history_snapshot_files_lists_complete_recorded_text() {
        let dir = setup_project(&[
            ("main.tex", "historical main"),
            ("chapters/unchanged.tex", "unchanged source"),
            ("chapters/removed.tex", "historical removed chapter"),
            ("figure.svg", "<svg>media</svg>"),
        ]);
        let project_root = root(&dir);
        history_init(project_root.clone()).unwrap();
        let first = history_list(project_root.clone(), 1, 0).unwrap()[0]
            .id
            .clone();
        fs::write(dir.path().join("main.tex"), "current main").unwrap();
        fs::remove_file(dir.path().join("chapters/removed.tex")).unwrap();
        fs::write(dir.path().join("new.tex"), "current added source").unwrap();
        let latest = history_snapshot(project_root.clone(), "Changed source".into())
            .unwrap()
            .unwrap();
        let paths = test_paths(&project_root);
        assert_eq!(
            history_snapshot_files_at(&project_root, &paths, &first).unwrap(),
            [
                "chapters/removed.tex",
                "chapters/unchanged.tex",
                "figure.svg",
                "main.tex"
            ]
        );
        assert_eq!(
            history_snapshot_files_at(&project_root, &paths, &latest.id).unwrap(),
            [
                "chapters/unchanged.tex",
                "figure.svg",
                "main.tex",
                "new.tex"
            ]
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "current main"
        );
        assert!(!dir.path().join("chapters/removed.tex").exists());
        assert!(dir.path().join("new.tex").exists());
    }

    #[test]
    fn history_snapshot_files_rejects_missing_or_invalid_snapshot() {
        let dir = setup_project(&[("main.tex", "source")]);
        let project_root = root(&dir);
        history_init(project_root.clone()).unwrap();
        let paths = test_paths(&project_root);
        assert!(history_snapshot_files_at(&project_root, &paths, "invalid").is_err());
        assert!(history_snapshot_files_at(&project_root, &paths, &"0".repeat(40)).is_err());
    }

    // ─── history_restore ───

    #[test]
    fn local_comments_rewind_with_source_and_preserve_before_restore_work() {
        let dir = setup_project(&[("main.tex", "old source")]);
        let r = root(&dir);
        let paths = test_paths(&r);
        let comments = paths.data_dir.join("comments");
        fs::create_dir_all(&comments).unwrap();
        let human = r#"{"version":1,"counter":7,"files":{"main.tex":[{"id":"H-7","from":0,"to":3,"line":1,"text":"old human","resolved":true}]},"sources":{"old":"old source"}}"#;
        let agent = r#"{"version":1,"counter":9,"files":{"main.tex":[{"id":"A-9","from":0,"to":0,"line":1,"text":"old agent","positionReset":true,"origin":{"provider":"codex","sessionId":"test"}}]},"sources":{}}"#;
        crate::comments::test_write(comments.join("human.json"), human).unwrap();
        crate::comments::test_write(comments.join("agent.json"), agent).unwrap();
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 100, 0).unwrap()[0].id.clone();
        fs::write(dir.path().join("main.tex"), "new source").unwrap();
        let new_human = human.replace("old human", "new human");
        crate::comments::test_write(comments.join("human.json"), &new_human).unwrap();
        crate::comments::test_write(comments.join("agent.json"), r#"{"version":1,"files":{}}"#).unwrap();
        history_restore(r.clone(), initial).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("main.tex")).unwrap(), "old source");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&crate::comments::test_read(comments.join("human.json")).unwrap()).unwrap()["files"]["main.tex"][0]["text"], "old human");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&crate::comments::test_read(comments.join("agent.json")).unwrap()).unwrap()["files"]["main.tex"][0]["text"], "old agent");
        let snapshots = history_list(r.clone(), 100, 0).unwrap();
        let before = snapshots.iter().find(|s| s.message.starts_with("[before-restore]")).unwrap();
        history_restore(r.clone(), before.id.clone()).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("main.tex")).unwrap(), "new source");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&crate::comments::test_read(comments.join("human.json")).unwrap()).unwrap()["files"]["main.tex"][0]["text"], "new human");
        assert!(serde_json::from_slice::<serde_json::Value>(&crate::comments::test_read(comments.join("agent.json")).unwrap()).unwrap()["files"].as_object().unwrap().is_empty());
        assert!(!dir.path().join(".catalex/comments.json").exists());
    }

    #[test]
    fn corrupt_comments_are_preserved_in_before_restore_history() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 100, 0).unwrap()[0].id.clone();
        fs::write(dir.path().join("main.tex"), "edited").unwrap();
        let storage = test_paths(&r).data_dir.join("comments");
        fs::create_dir_all(&storage).unwrap();
        crate::comments::test_write(storage.join("human.json"), "broken metadata").unwrap();
        let restored = history_restore(r.clone(), initial);
        assert!(restored.is_ok(), "A valid Rewind snapshot was blocked: {:?}", restored.err());
        assert_eq!(fs::read_to_string(dir.path().join("main.tex")).unwrap(), "original");
        let before = history_list(r.clone(), 100, 0).unwrap().into_iter().find(|s| s.message.starts_with("[before-restore]")).unwrap();
        history_restore(r, before.id).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("main.tex")).unwrap(), "edited");
        assert_eq!(String::from_utf8(crate::comments::test_read(storage.join("human.json")).unwrap()).unwrap(), "broken metadata");
    }

    #[test]
    fn malformed_author_does_not_bypass_other_authors_anchor_recovery() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        let storage = test_paths(&r).data_dir.join("comments");
        fs::create_dir_all(&storage).unwrap();
        crate::comments::test_write(storage.join("human.json"), r#"{"version":1,"counter":1,"files":{"main.tex":[{"id":"H-1","from":0,"to":1,"line":1,"text":"Keep","resolved":false}]}}"#).unwrap();
        history_init(r.clone()).unwrap();
        fs::rename(dir.path().join("main.tex"), test_paths(&r).data_dir.join("old-inode")).unwrap();
        fs::write(dir.path().join("main.tex"), "unrelated replacement").unwrap();
        crate::comments::test_write(storage.join("agent.json"), "broken agent metadata").unwrap();
        let snapshot = history_snapshot(r.clone(), "mixed metadata".into()).unwrap().unwrap();
        history_restore(r, snapshot.id).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&crate::comments::test_read(storage.join("human.json")).unwrap()).unwrap();
        assert!(saved["orphaned"].as_object().is_none_or(|files| files.is_empty()));
        assert_eq!(saved["files"]["main.tex"][0]["text"], "Keep");
        assert_eq!(saved["files"]["main.tex"][0]["positionReset"], true);
        assert_eq!(String::from_utf8(crate::comments::test_read(storage.join("agent.json")).unwrap()).unwrap(), "broken agent metadata");
    }

    #[test]
    fn comment_storage_failure_does_not_publish_a_file_only_checkpoint() {
        let dir = setup_project(&[("main.tex", "before")]);
        let r = root(&dir);
        let paths = test_paths(&r);
        history_init(r.clone()).unwrap();
        let before = history_list(r.clone(), 100, 0).unwrap();
        fs::write(dir.path().join("main.tex"), "accepted").unwrap();
        let storage = paths.data_dir.join("comments");
        fs::rename(storage.join("comments.polodb"), storage.join("saved.polodb")).unwrap();
        fs::write(storage.join("comments.polodb"), "blocked").unwrap();
        assert!(history_snapshot_unlocked_at(&r, &paths, "[agent] Applied reviewed changes".into()).is_err());
        assert_eq!(history_list(r.clone(), 100, 0).unwrap().len(), before.len());
        fs::remove_file(storage.join("comments.polodb")).unwrap();
        fs::rename(storage.join("saved.polodb"), storage.join("comments.polodb")).unwrap();
        let saved = history_snapshot_unlocked_at(&r, &paths, "[agent] Applied reviewed changes".into()).unwrap().unwrap();
        let repo = open_repo_at(&r, &paths).unwrap();
        let tree = repo.find_commit(Oid::from_str(&saved.id).unwrap()).unwrap().tree().unwrap();
        assert!(tree.get_path(Path::new(HISTORY_COMMENTS_PATH)).is_ok());
    }

    #[test]
    fn agent_checkpoint_reconciles_replaced_file_before_rewind_captures_comments() {
        let dir = setup_project(&[("old.tex", "original")]);
        let r = root(&dir);
        let paths = test_paths(&r);
        let storage = paths.data_dir.join("comments");
        fs::create_dir_all(&storage).unwrap();
        crate::comments::test_write(storage.join("human.json"), r#"{"version":1,"counter":1,"files":{"old.tex":[{"id":"H-1","from":0,"to":1,"line":1,"text":"Keep","resolved":false}]}}"#).unwrap();
        history_init(r.clone()).unwrap();
        let changed = vec!["old.tex".into(), "new.tex".into()];
        let before = crate::comments::recovery::capture(dir.path(), &changed).unwrap();
        fs::rename(dir.path().join("old.tex"), dir.path().join("new.tex")).unwrap();
        crate::comments::recovery::defer(dir.path(), &storage, &paths.data_dir.join("finished-settlement"), "rename", &changed, &[crate::comments::CommentPathChange {
            old_path: "old.tex".into(), new_path: "new.tex".into(), folder: false,
        }], &before).unwrap();
        // Keep the original inode alive to ensure this is a distinct file.
        fs::rename(dir.path().join("new.tex"), paths.data_dir.join("external-original")).unwrap();
        fs::write(dir.path().join("new.tex"), "unrelated replacement").unwrap();
        let snapshot = history_snapshot_unlocked_at(&r, &paths, "after acceptance".into()).unwrap().unwrap();
        history_restore(r, snapshot.id).unwrap();
        crate::comments::reconcile_paths(dir.path(), &storage).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&crate::comments::test_read(storage.join("human.json")).unwrap()).unwrap();
        assert!(saved["orphaned"].as_object().is_none_or(|files| files.is_empty()));
        assert_eq!(saved["files"]["new.tex"][0]["text"], "Keep");
        assert_eq!(saved["files"]["new.tex"][0]["positionReset"], true);
    }

    #[test]
    fn private_history_keeps_gitignored_sources_and_assets_but_not_generated_files() {
        let dir = setup_project(&[(".gitignore", "notes.tex\nreference.pdf\n"), ("notes.tex", "source"), ("reference.pdf", "asset"), ("main.aux", "generated"), ("main.pdf", "compiled"), ("main.fls", "OUTPUT main.pdf"), ("data.gz", "archive")]);
        let r = root(&dir); history_init(r.clone()).unwrap();
        let repo = open_repo_at(&r, &test_paths(&r)).unwrap();
        let tree = repo.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
        for path in ["notes.tex", "reference.pdf", "data.gz"] { assert!(tree.get_path(Path::new(path)).is_ok(), "{path}"); }
        for path in ["main.aux", "main.pdf", "main.fls"] { assert!(tree.get_path(Path::new(path)).is_err(), "{path}"); }
    }

    #[test]
    fn local_comment_only_changes_create_snapshots_and_empty_groups_rewind() {
        let dir = setup_project(&[("main.tex", "source")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 100, 0).unwrap()[0].id.clone();
        let comments = test_paths(&r).data_dir.join("comments");
        fs::create_dir_all(&comments).unwrap();
        crate::comments::test_write(comments.join("human.json"), r#"{"version":1,"counter":1,"files":{"main.tex":[{"id":"H-1","from":0,"to":1,"line":1,"text":"saved comment","resolved":false}]}}"#).unwrap();
        let snapshot = history_snapshot(r.clone(), "comment only".into()).unwrap().unwrap();
        assert!(snapshot.changed_files.is_empty()); // private metadata is not a project file
        history_restore(r.clone(), initial).unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&crate::comments::test_read(comments.join("human.json")).unwrap()).unwrap()["files"].as_object().unwrap().is_empty());
        history_restore(r.clone(), snapshot.id).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&crate::comments::test_read(comments.join("human.json")).unwrap()).unwrap()["files"]["main.tex"][0]["text"], "saved comment");
    }

    #[test]
    fn snapshots_without_local_comment_coverage_preserve_current_comments() {
        let dir = setup_project(&[("main.tex", "old")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        let paths = test_paths(&r);
        let repo = open_repo_at(&r, &paths).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        let mut builder = repo.treebuilder(Some(&tree)).unwrap();
        builder.remove(".catalex").unwrap();
        let old_tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let sig = default_signature().unwrap();
        let old = repo.commit(Some("HEAD"), &sig, &sig, "old snapshot", &old_tree, &[&head]).unwrap();
        let comments = paths.data_dir.join("comments");
        fs::create_dir_all(&comments).unwrap();
        crate::comments::test_write(comments.join("human.json"), r#"{"version":1,"counter":1,"files":{"main.tex":[{"id":"H-1","from":0,"to":1,"line":1,"text":"present-day comment","resolved":false}]}}"#).unwrap();
        fs::write(dir.path().join("main.tex"), "new").unwrap();
        history_restore(r.clone(), old.to_string()).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("main.tex")).unwrap(), "old");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&crate::comments::test_read(comments.join("human.json")).unwrap()).unwrap()["files"]["main.tex"][0]["text"], "present-day comment");
    }

    #[test]
    fn invalid_comment_restore_destination_leaves_source_untouched() {
        let dir = setup_project(&[("main.tex", "old")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 100, 0).unwrap()[0].id.clone();
        fs::write(dir.path().join("main.tex"), "new unsaved snapshot work").unwrap();
        fs::remove_dir_all(test_paths(&r).data_dir.join("comments/comments.polodb")).unwrap();
        fs::write(test_paths(&r).data_dir.join("comments/comments.polodb"), "blocked").unwrap();
        assert!(history_restore(r.clone(), initial).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("main.tex")).unwrap(), "new unsaved snapshot work");
    }

    #[test]
    fn test_history_restore_reverts_content() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        // Modify
        fs::write(dir.path().join("main.tex"), "modified").unwrap();
        history_snapshot(r.clone(), "modify".into()).unwrap();

        // Restore to init
        let restore_info = history_restore(r.clone(), init_id).unwrap();
        assert!(restore_info.message.contains("[restore]"));

        // Working directory should have original content
        let content = fs::read_to_string(dir.path().join("main.tex")).unwrap();
        assert_eq!(content, "original");
    }

    #[test]
    fn test_restore_preserves_later_snapshots_and_unsnapshotted_work() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 1, 0).unwrap()[0].id.clone();
        fs::write(dir.path().join("main.tex"), "later version").unwrap();
        let later = history_snapshot(r.clone(), "later".into())
            .unwrap()
            .unwrap();
        fs::write(dir.path().join("main.tex"), "latest unsnapshotted work").unwrap();
        fs::write(dir.path().join("new.tex"), "new file").unwrap();
        let restored = history_restore(r.clone(), initial.clone()).unwrap();
        let snapshots = history_list(r.clone(), 20, 0).unwrap();
        assert_eq!(snapshots.len(), 4);
        assert_eq!(snapshots[0].id, restored.id);
        assert!(snapshots[1].message.starts_with("[before-restore]"));
        assert_eq!(snapshots[2].id, later.id);
        assert_eq!(snapshots[3].id, initial);
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "original"
        );
        assert!(!dir.path().join("new.tex").exists());
        history_restore(r.clone(), snapshots[1].id.clone()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "latest unsnapshotted work"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("new.tex")).unwrap(),
            "new file"
        );
        // Restoring an already snapshotted tree needs no duplicate safeguard.
        assert_eq!(history_list(r, 20, 0).unwrap().len(), 5);
    }

    #[test]
    fn test_history_restore_leaves_media_untouched_even_for_legacy_snapshots() {
        let dir = setup_project(&[("main.tex", "original")]);
        fs::write(dir.path().join("figure.png"), b"old image").unwrap();
        let project_root = root(&dir);
        history_init(project_root.clone()).unwrap();

        // Simulate a snapshot created by an older Catalex version that still
        // included media in the private history tree.
        let legacy_snapshot_id = {
            let repo = open_repo(&project_root).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("figure.png")).unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            let signature = default_signature().unwrap();
            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                "legacy media snapshot",
                &tree,
                &[&parent],
            )
            .unwrap()
            .to_string()
        };

        fs::write(dir.path().join("main.tex"), "modified").unwrap();
        fs::write(dir.path().join("figure.png"), b"current image").unwrap();
        history_snapshot(project_root.clone(), "text edit".into()).unwrap();

        history_restore(project_root, legacy_snapshot_id).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read(dir.path().join("figure.png")).unwrap(),
            b"current image"
        );
    }

    #[test]
    fn asset_history_restores_bytes_deletions_and_pre_restore_work() {
        let project = setup_project(&[("main.tex", "original"), ("figure.svg", "<svg>old</svg>")]);
        let r = root(&project);
        let original = [0, 255, 3, 19];
        fs::write(project.path().join("figure.png"), original).unwrap();
        fs::write(project.path().join("paper.pdf"), b"%PDF\0original").unwrap();
        fs::write(project.path().join("dataset.zip"), [0, 9, 255]).unwrap();
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 1, 0).unwrap()[0].id.clone();
        fs::remove_file(project.path().join("figure.png")).unwrap();
        fs::write(project.path().join("paper.pdf"), b"%PDF\0new").unwrap();
        fs::write(project.path().join("new.png"), [3, 2, 1]).unwrap();
        history_restore(r.clone(), initial.clone()).unwrap();
        assert_eq!(
            fs::read(project.path().join("figure.png")).unwrap(),
            original
        );
        assert_eq!(
            fs::read(project.path().join("paper.pdf")).unwrap(),
            b"%PDF\0original"
        );
        assert!(!project.path().join("new.png").exists());
        let snapshots = history_list(r.clone(), 10, 0).unwrap();
        let before = snapshots
            .iter()
            .find(|snapshot| snapshot.message.starts_with("[before-restore]"))
            .unwrap();
        history_restore(r.clone(), before.id.clone()).unwrap();
        assert!(!project.path().join("figure.png").exists());
        assert_eq!(
            fs::read(project.path().join("paper.pdf")).unwrap(),
            b"%PDF\0new"
        );
        assert_eq!(fs::read(project.path().join("new.png")).unwrap(), [3, 2, 1]);
        assert_eq!(
            BASE64_STANDARD
                .decode(history_file_bytes_at(&r, &test_paths(&r), &initial, "figure.png").unwrap())
                .unwrap(),
            original
        );
        assert!(
            history_file_bytes_at(&r, &test_paths(&r), &initial, HISTORY_COVERAGE_PATH).is_err()
        );
    }

    #[test]
    fn asset_history_migrates_exclusions_and_excludes_only_recorded_pdf_output() {
        let project = setup_project(&[
            ("main.tex", "source"),
            ("main.pdf", "%PDF output"),
            ("main.fls", "OUTPUT main.pdf\n"),
            ("figure.pdf", "%PDF input"),
            ("node_modules/package/code.js", "dependency"),
            (".cache/item", "cache"),
            (".prism/settings", "internal"),
            ("main.aux", "generated"),
        ]);
        let r = root(&project);
        let paths = test_paths(&r);
        fs::create_dir_all(&paths.data_dir).unwrap();
        fs::write(
            &paths.history_exclude_file,
            "*.pdf\n*.png\n*.aux\n.catalex/\n",
        )
        .unwrap();
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 1, 0).unwrap()[0].id.clone();
        assert_eq!(
            history_snapshot_files_at(&r, &paths, &initial).unwrap(),
            ["figure.pdf", "main.tex"]
        );
        assert_eq!(
            fs::read_to_string(project.path().join("main.pdf")).unwrap(),
            "%PDF output"
        );
    }

    #[test]
    fn asset_retention_preserves_complete_trees_and_user_git_state() {
        let project = setup_project(&[("main.tex", "original")]);
        let r = root(&project);
        let user_repo = Repository::init(project.path()).unwrap();
        user_repo
            .remote("origin", "https://github.com/example/paper.git")
            .unwrap();
        user_repo
            .remote("overleaf", "https://git.overleaf.com/example")
            .unwrap();
        let mut user_index = user_repo.index().unwrap();
        user_index.add_path(Path::new("main.tex")).unwrap();
        user_index.write().unwrap();
        let tree_id = user_index.write_tree().unwrap();
        let tree = user_repo.find_tree(tree_id).unwrap();
        let sig = default_signature().unwrap();
        let head = user_repo
            .commit(Some("HEAD"), &sig, &sig, "user commit", &tree, &[])
            .unwrap();
        fs::write(project.path().join("main.tex"), "staged work").unwrap();
        user_index.add_path(Path::new("main.tex")).unwrap();
        user_index.write().unwrap();
        let git_index = fs::read(user_repo.path().join("index")).unwrap();
        let git_config = fs::read(user_repo.path().join("config")).unwrap();
        let app_data = TempDir::new().unwrap();
        let paths = test_paths_in(app_data.path().join("history"));
        fs::write(project.path().join("figure.png"), [0, 255, 7]).unwrap();
        history_init_at(&r, &paths).unwrap();
        for i in 0..4 {
            fs::write(project.path().join("main.tex"), format!("revision {i}")).unwrap();
            history_snapshot_at(&r, &paths, format!("edit {i}")).unwrap();
        }
        maintain_history_with_policy(
            &r,
            &paths,
            HistoryMaintenancePolicy {
                storage_limit_bytes: 1,
                recent_snapshot_floor: 1,
                loose_object_threshold: usize::MAX,
                force_compaction: true,
            },
            |_| Ok(()),
        )
        .unwrap();
        let kept = history_list_at(&r, &paths, 10, 0).unwrap();
        assert_eq!(kept.len(), 1);
        fs::remove_file(project.path().join("figure.png")).unwrap();
        history_restore_at(&r, &paths, kept[0].id.clone()).unwrap();
        assert_eq!(
            fs::read(project.path().join("figure.png")).unwrap(),
            [0, 255, 7]
        );
        assert_eq!(user_repo.head().unwrap().target(), Some(head));
        assert_eq!(fs::read(user_repo.path().join("index")).unwrap(), git_index);
        assert_eq!(
            fs::read(user_repo.path().join("config")).unwrap(),
            git_config
        );
    }

    #[cfg(unix)]
    #[test]
    fn asset_restore_rejects_symlink_parent_without_touching_external_files() {
        let project = setup_project(&[
            ("main.tex", "original"),
            ("figures/image.png", "original figure"),
        ]);
        let outside = TempDir::new().unwrap();
        let r = root(&project);
        history_init(r.clone()).unwrap();
        let initial = history_list(r.clone(), 1, 0).unwrap()[0].id.clone();
        fs::remove_dir_all(project.path().join("figures")).unwrap();
        fs::write(outside.path().join("image.png"), "outside data").unwrap();
        std::os::unix::fs::symlink(outside.path(), project.path().join("figures")).unwrap();
        assert!(history_restore(r, initial)
            .err()
            .unwrap()
            .contains("symbolic link"));
        assert_eq!(
            fs::read_to_string(outside.path().join("image.png")).unwrap(),
            "outside data"
        );
    }

    // ─── labels ───

    #[test]
    fn test_history_add_and_remove_label() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        // Add label
        history_add_label(r.clone(), id.clone(), "v1.0".into()).unwrap();

        // Verify label appears in list
        let list = history_list(r.clone(), 1, 0).unwrap();
        assert!(list[0].labels.contains(&"v1.0".to_string()));

        // Remove label
        history_remove_label(r.clone(), "v1.0".into()).unwrap();

        // Verify label gone
        let list = history_list(r.clone(), 1, 0).unwrap();
        assert!(!list[0].labels.contains(&"v1.0".to_string()));
    }

    #[test]
    fn test_history_remove_nonexistent_label_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let result = history_remove_label(r, "nope".into());
        assert!(result.is_err());
    }

    // ─── tag_map ───

    #[test]
    fn test_tag_map_groups_by_oid() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label(r.clone(), id.clone(), "alpha".into()).unwrap();
        history_add_label(r.clone(), id.clone(), "beta".into()).unwrap();

        let repo = open_repo(&r).unwrap();
        let map = tag_map(&repo);
        let oid = Oid::from_str(&id).unwrap();
        let labels = map.get(&oid).unwrap();
        assert!(labels.contains(&"alpha".to_string()));
        assert!(labels.contains(&"beta".to_string()));
    }

    // ─── ensure_excludes ───

    #[test]
    fn test_ensure_excludes_updates_managed_entries() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Simulate an older managed file that excluded project comments and
        // did not yet contain the legacy .prism/ entry.
        let excludes_path = dir.path().join(".catalex").join("history-exclude");
        fs::write(
            &excludes_path,
            "*.aux\n*.log\n# Catalex project comments\n/comments.json\n.catalex/\n",
        )
        .unwrap();

        let repo = open_repo(&r).unwrap();
        ensure_excludes(&r, &repo);

        let content = fs::read_to_string(&excludes_path).unwrap();
        assert!(
            !content.contains("/comments.json"),
            "should include project comments in automatic history"
        );
        assert!(
            content.contains(".catalex/"),
            "should include current .catalex/ internal state"
        );
        assert!(
            content.contains(".prism/"),
            "should keep legacy .prism/ internal state excluded"
        );
    }

    // ─── automatic history storage management ───

    #[test]
    fn test_history_storage_info_reports_usage_and_protected_snapshots() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let project_root = root(&dir);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        fs::write(dir.path().join("main.tex"), "v2").unwrap();
        let snapshot = history_snapshot(project_root.clone(), "edit".into())
            .unwrap()
            .unwrap();
        history_add_label(project_root, snapshot.id, "protected".into()).unwrap();

        let info = history_storage_info_at(&paths).unwrap();

        assert!(info.usage_bytes > 0);
        assert_eq!(info.limit_bytes, DEFAULT_HISTORY_STORAGE_LIMIT_BYTES);
        assert_eq!(info.snapshot_count, 2);
        assert_eq!(info.protected_snapshot_count, 1);
    }

    #[test]
    fn test_history_storage_limit_is_persisted_per_project() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let project_root = root(&dir);
        let paths = test_paths(&project_root);
        history_init(project_root).unwrap();
        let custom_limit = 512 * 1024 * 1024;

        save_history_settings(
            &paths,
            &HistorySettings {
                version: HISTORY_SETTINGS_SCHEMA_VERSION,
                storage_limit_bytes: custom_limit,
            },
        )
        .unwrap();

        assert_eq!(
            history_storage_info_at(&paths).unwrap().limit_bytes,
            custom_limit
        );
    }

    #[test]
    fn test_history_maintenance_packs_loose_objects_and_accounts_for_repository_bytes() {
        let project = setup_project(&[("main.tex", "initial")]);
        let project_root = root(&project);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        create_numbered_history(&project, 8);

        let repository = open_repo_at(&project_root, &paths).unwrap();
        let loose_before = loose_history_object_count(&repository).unwrap();
        assert!(loose_before > 0);
        drop(repository);

        maintain_history_with_policy(
            &project_root,
            &paths,
            HistoryMaintenancePolicy {
                storage_limit_bytes: u64::MAX,
                recent_snapshot_floor: HISTORY_RECENT_SNAPSHOT_FLOOR,
                loose_object_threshold: 0,
                force_compaction: false,
            },
            |_| Ok(()),
        )
        .unwrap();

        let repository = open_repo_at(&project_root, &paths).unwrap();
        let loose_after = loose_history_object_count(&repository).unwrap();
        assert!(loose_after < loose_before);
        let pack_dir = repository.path().join("objects/pack");
        assert!(fs::read_dir(pack_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(
                |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("pack")
            ));
        drop(repository);

        let info = history_storage_info_at(&paths).unwrap();
        assert_eq!(
            info.usage_bytes,
            directory_size(&paths.history_dir).unwrap()
        );
        assert_eq!(info.snapshot_count, 9);
    }

    #[test]
    fn test_history_retention_keeps_the_recent_snapshot_floor() {
        let project = setup_project(&[("main.tex", "initial")]);
        let project_root = root(&project);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        let snapshots = create_numbered_history(&project, 7);
        let dropped_oid = Oid::from_str(&snapshots[1].id).unwrap();

        forced_history_maintenance(&project_root, 3, |_| Ok(())).unwrap();

        let retained = history_list(project_root.clone(), 100, 0).unwrap();
        assert_eq!(retained.len(), 3);
        assert_eq!(
            retained
                .iter()
                .map(|snapshot| snapshot.message.as_str())
                .collect::<Vec<_>>(),
            vec!["edit 6", "edit 5", "edit 4"]
        );
        let repository = open_repo_at(&project_root, &paths).unwrap();
        assert!(repository.find_commit(dropped_oid).is_err());
    }

    #[test]
    fn test_history_storage_limit_triggers_retention_after_packing() {
        let project = setup_project(&[("main.tex", "initial")]);
        let project_root = root(&project);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        create_numbered_history(&project, 6);

        maintain_history_with_policy(
            &project_root,
            &paths,
            HistoryMaintenancePolicy {
                storage_limit_bytes: 1,
                recent_snapshot_floor: 2,
                loose_object_threshold: usize::MAX,
                force_compaction: false,
            },
            |_| Ok(()),
        )
        .unwrap();

        let retained = history_list(project_root, 100, 0).unwrap();
        assert_eq!(retained.len(), 2);
        assert_eq!(retained[0].message, "edit 5");
        assert_eq!(retained[1].message, "edit 4");
    }

    #[test]
    fn test_history_retention_preserves_labeled_snapshots() {
        let project = setup_project(&[("main.tex", "initial")]);
        let project_root = root(&project);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        let snapshots = create_numbered_history(&project, 7);
        let labeled_oid = Oid::from_str(&snapshots[0].id).unwrap();
        let dropped_oid = Oid::from_str(&snapshots[2].id).unwrap();
        history_add_label(
            project_root.clone(),
            snapshots[0].id.clone(),
            "milestone".into(),
        )
        .unwrap();

        forced_history_maintenance(&project_root, 2, |_| Ok(())).unwrap();

        let retained = history_list(project_root.clone(), 100, 0).unwrap();
        assert_eq!(retained.len(), 3);
        assert!(retained
            .iter()
            .any(|snapshot| snapshot.message == "edit 0" && snapshot.labels == vec!["milestone"]));
        assert_eq!(
            retained
                .iter()
                .map(|snapshot| snapshot.message.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["edit 0", "edit 5", "edit 6"])
        );

        let repository = open_repo_at(&project_root, &paths).unwrap();
        let label_commit = repository
            .find_reference(&format!("refs/tags/{}", label_name("milestone", Oid::from_str(&snapshots[0].id).unwrap())))
            .unwrap()
            .peel_to_commit()
            .unwrap();
        let label_tree = label_commit.tree().unwrap();
        let label_blob = repository
            .find_blob(label_tree.get_path(Path::new("main.tex")).unwrap().id())
            .unwrap();
        assert_eq!(label_blob.content(), b"version 0");
        assert_ne!(label_commit.id(), labeled_oid);
        assert!(repository.find_commit(dropped_oid).is_err());
    }

    #[test]
    fn test_history_retention_interruption_before_reference_update_keeps_original_history() {
        let project = setup_project(&[("main.tex", "initial")]);
        let project_root = root(&project);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        let snapshots = create_numbered_history(&project, 6);
        history_add_label(
            project_root.clone(),
            snapshots[0].id.clone(),
            "milestone".into(),
        )
        .unwrap();
        let repository = open_repo_at(&project_root, &paths).unwrap();
        let original_head = repository.head().unwrap().target().unwrap();
        let original_label = repository
            .find_reference(&format!("refs/tags/{}", label_name("milestone", Oid::from_str(&snapshots[0].id).unwrap())))
            .unwrap()
            .target()
            .unwrap();
        drop(repository);

        let error = forced_history_maintenance(&project_root, 2, |stage| {
            if stage == HistoryMaintenanceStage::BeforeReferenceUpdate {
                Err("simulated interruption".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(error.contains("simulated interruption"));

        let repository = open_repo_at(&project_root, &paths).unwrap();
        assert_eq!(repository.head().unwrap().target(), Some(original_head));
        assert_eq!(
            repository
                .find_reference(&format!("refs/tags/{}", label_name("milestone", Oid::from_str(&snapshots[0].id).unwrap())))
                .unwrap()
                .target(),
            Some(original_label)
        );
        assert_eq!(first_parent_history(&repository).unwrap().len(), 7);
    }

    #[test]
    fn test_history_retention_recovers_after_interruption_before_garbage_collection() {
        let project = setup_project(&[("main.tex", "initial")]);
        let project_root = root(&project);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        let snapshots = create_numbered_history(&project, 6);
        let dropped_oid = Oid::from_str(&snapshots[2].id).unwrap();
        let original_head = Oid::from_str(&snapshots[5].id).unwrap();
        history_add_label(
            project_root.clone(),
            snapshots[0].id.clone(),
            "milestone".into(),
        )
        .unwrap();

        let error = forced_history_maintenance(&project_root, 2, |stage| {
            if stage == HistoryMaintenanceStage::BeforeGarbageCollection {
                Err("simulated interruption".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(error.contains("simulated interruption"));

        let repository = open_repo_at(&project_root, &paths).unwrap();
        assert_eq!(first_parent_history(&repository).unwrap().len(), 3);
        let rewritten_head = repository.head().unwrap().target().unwrap();
        assert_ne!(rewritten_head, original_head);
        assert_eq!(
            snapshot_oid_after_maintenance_error(&project_root, &paths, original_head),
            rewritten_head
        );
        assert!(repository.find_commit(dropped_oid).is_ok());
        assert!(repository
            .find_reference(&format!("refs/tags/{}", label_name("milestone", Oid::from_str(&snapshots[0].id).unwrap())))
            .unwrap()
            .peel_to_commit()
            .is_ok());
        drop(repository);

        forced_history_maintenance(&project_root, 2, |_| Ok(())).unwrap();

        let repository = open_repo_at(&project_root, &paths).unwrap();
        assert_eq!(first_parent_history(&repository).unwrap().len(), 3);
        assert!(repository.find_commit(dropped_oid).is_err());
        assert!(repository
            .find_reference(&format!("refs/tags/{}", label_name("milestone", Oid::from_str(&snapshots[0].id).unwrap())))
            .unwrap()
            .peel_to_commit()
            .is_ok());
    }

    #[test]
    fn test_history_clear_starts_fresh_without_touching_source_git_or_settings() {
        let dir = setup_project(&[("main.tex", "v1")]);
        Repository::init(dir.path()).unwrap();
        let project_root = root(&dir);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        fs::write(dir.path().join("main.tex"), "v2").unwrap();
        let snapshot = history_snapshot(project_root.clone(), "edit".into())
            .unwrap()
            .unwrap();
        history_add_label(project_root.clone(), snapshot.id, "milestone".into()).unwrap();
        let custom_limit = 512 * 1024 * 1024;
        save_history_settings(
            &paths,
            &HistorySettings {
                version: HISTORY_SETTINGS_SCHEMA_VERSION,
                storage_limit_bytes: custom_limit,
            },
        )
        .unwrap();

        let info = history_clear_at(&project_root, &paths).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "v2"
        );
        assert!(Repository::open(dir.path()).is_ok());
        assert_eq!(info.snapshot_count, 1);
        assert_eq!(info.protected_snapshot_count, 0);
        assert_eq!(info.limit_bytes, custom_limit);
        let history_repo = Repository::open(&paths.history_dir).unwrap();
        assert_eq!(history_repo.tag_names(None).unwrap().len(), 0);
    }

    #[test]
    fn history_clear_preserves_private_agent_worktree_and_checkpoint() {
        let dir = setup_project(&[("main.tex", "starting project")]);
        let project_root = root(&dir);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        let repo = open_repo(&project_root).unwrap();
        let start = repo.head().unwrap().peel_to_commit().unwrap();
        let source_ref = "refs/catalex/agents/example/source";
        repo.reference(source_ref, start.id(), false, "agent baseline")
            .unwrap();
        let branch = repo
            .branch("catalex-agent-example", &start, false)
            .unwrap();
        let mut options = git2::WorktreeAddOptions::new();
        options.reference(Some(branch.get()));
        let worktree_path = paths.data_dir.join("agent-draft");
        repo.worktree("agent-example", &worktree_path, Some(&options))
            .unwrap();
        fs::write(worktree_path.join("main.tex"), "unfinished agent changes").unwrap();
        fs::write(dir.path().join("main.tex"), "new project state").unwrap();
        history_snapshot(project_root.clone(), "user edit".into()).unwrap();
        history_restore_at(&project_root, &paths, start.id().to_string()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "starting project"
        );
        assert_eq!(
            fs::read_to_string(worktree_path.join("main.tex")).unwrap(),
            "unfinished agent changes"
        );
        fs::write(dir.path().join("main.tex"), "new project state").unwrap();

        let info = history_clear_at(&project_root, &paths).unwrap();

        assert_eq!(info.snapshot_count, 1);
        assert_eq!(
            repo.find_reference(source_ref).unwrap().target(),
            Some(start.id())
        );
        assert!(repo.find_commit(start.id()).is_ok());
        assert!(repo
            .find_worktree("agent-example")
            .unwrap()
            .validate()
            .is_ok());
        assert_eq!(
            fs::read_to_string(worktree_path.join("main.tex")).unwrap(),
            "unfinished agent changes"
        );
        let draft_repo = Repository::open(&worktree_path).unwrap();
        assert_eq!(draft_repo.head().unwrap().target(), Some(start.id()));
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "new project state"
        );
    }

    #[test]
    fn history_timeline_hides_agent_second_parent_and_retention_preserves_private_refs() {
        let dir = setup_project(&[("main.tex", "initial")]);
        let project_root = root(&dir);
        let paths = test_paths(&project_root);
        history_init(project_root.clone()).unwrap();
        let repo = open_repo(&project_root).unwrap();
        let start = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = start.tree().unwrap();
        let sig = default_signature().unwrap();
        let agent_oid = repo
            .commit(
                Some("refs/catalex/agents/example/revision"),
                &sig,
                &sig,
                "private proposal",
                &tree,
                &[&start],
            )
            .unwrap();
        create_numbered_history(&dir, 4);
        let main = repo.head().unwrap().peel_to_commit().unwrap();
        let agent = repo.find_commit(agent_oid).unwrap();
        let applied_oid = repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "applied agent proposal",
                &main.tree().unwrap(),
                &[&main, &agent],
            )
            .unwrap();

        let snapshots = history_list(project_root.clone(), 100, 0).unwrap();
        assert_eq!(snapshots.len(), 6);
        assert_eq!(snapshots[0].id, applied_oid.to_string());
        assert!(!snapshots
            .iter()
            .any(|snapshot| snapshot.id == agent_oid.to_string()));
        assert_eq!(history_storage_info_at(&paths).unwrap().snapshot_count, 6);

        forced_history_maintenance(&project_root, 2, |_| Ok(())).unwrap();
        assert_eq!(history_list(project_root.clone(), 100, 0).unwrap().len(), 2);
        assert_eq!(
            repo.find_reference("refs/catalex/agents/example/revision")
                .unwrap()
                .target(),
            Some(agent_oid)
        );
        assert_eq!(
            repo.find_commit(agent_oid).unwrap().parent_id(0).unwrap(),
            start.id()
        );
        assert!(repo.find_commit(start.id()).is_ok());
    }

    // ─── edge cases ───

    #[test]
    fn test_history_snapshot_deleted_file() {
        let dir = setup_project(&[("a.tex", "aaa"), ("b.tex", "bbb")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Delete a file
        fs::remove_file(dir.path().join("b.tex")).unwrap();

        let snap = history_snapshot(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();
        assert!(!snap.changed_files.is_empty());
    }

    #[test]
    fn test_history_diff_deleted_file() {
        let dir = setup_project(&[("a.tex", "keep"), ("b.tex", "remove me")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        fs::remove_file(dir.path().join("b.tex")).unwrap();
        let snap = history_snapshot(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();

        let diffs = history_diff(r, init_id, snap.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "deleted");
        assert_eq!(d.old_content.as_deref(), Some("remove me"));
        assert!(d.new_content.is_none());
    }

    #[test]
    fn test_history_diff_nonadjacent_snapshots() {
        let dir = setup_project(&[("a.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list0 = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list0[0].id.clone();

        fs::write(dir.path().join("a.tex"), "v2").unwrap();
        history_snapshot(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "v3").unwrap();
        let snap3 = history_snapshot(r.clone(), "s2".into()).unwrap().unwrap();

        // Diff from init directly to s2 (skipping s1)
        let diffs = history_diff(r, init_id, snap3.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "a.tex").unwrap();
        assert_eq!(d.old_content.as_deref(), Some("v1"));
        assert_eq!(d.new_content.as_deref(), Some("v3"));
    }

    #[test]
    fn test_history_add_duplicate_label_is_idempotent() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label(r.clone(), id.clone(), "dup".into()).unwrap();
        // Adding the same association again is harmless
        let result = history_add_label(r, id, "dup".into());
        assert!(result.is_ok());
    }

    #[test]
    fn test_history_restore_creates_restore_commit() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let init_list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = init_list[0].id.clone();

        fs::write(dir.path().join("main.tex"), "changed").unwrap();
        history_snapshot(r.clone(), "change".into()).unwrap();

        history_restore(r.clone(), init_id).unwrap();

        // Should now have 4 entries: init, change, restore
        let list = history_list(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().any(|s| s.message.contains("[restore]")));
    }
}
