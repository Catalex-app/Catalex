use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use crate::host::WindowContext;

struct ProjectWatch {
    id: String,
    _watcher: RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}
impl ProjectFiles {
    pub fn close_window(&self, window_id: &str) {
        if let Ok(mut watches) = self.watches.lock() {
            watches.remove(window_id);
        }
    }
}

impl Drop for ProjectWatch {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct ProjectFiles {
    watches: Mutex<HashMap<String, ProjectWatch>>,
    writes: Mutex<()>,
}

pub(crate) fn ignored(path: &Path) -> bool {
    path.components().any(|part| {
        matches!(
            part.as_os_str().to_str(),
            Some(".git" | ".catalex" | ".prism" | "node_modules" | "target" | "dist")
        )
    }) || matches!(
        path.extension().and_then(|s| s.to_str()),
        Some(
            "aux"
                | "log"
                | "out"
                | "toc"
                | "fls"
                | "fdb_latexmk"
                | "synctex"
                | "gz"
                | "bbl"
                | "blg"
                | "bcf"
                | "tmp"
        )
    )
}

fn review_git_metadata(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('\\', "/");
    matches!(text.as_str(), "" | "HEAD" | "index" | "index.lock" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD")
        || text.starts_with("refs/heads/") || text.starts_with("rebase-")
        || text.starts_with("sequencer/")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChanges {
    project_root: String,
    watch_id: String,
    paths: Vec<String>,
    rescan: bool,
}

pub fn watch_project_files(
    window: WindowContext,
    project_root: String,
    watch_id: String,
) -> Result<(), String> {
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Project folder does not exist".into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // Git can live outside the project, particularly for linked worktrees and
    // projects opened below a repository root. Only relevant metadata triggers refresh.
    let mut git_roots = Vec::new();
    if let Ok(repo) = git2::Repository::discover(&root) {
        git_roots.push(repo.path().to_path_buf());
        if let Ok(common) = fs::read_to_string(repo.path().join("commondir")) {
            if let Ok(common) = fs::canonicalize(repo.path().join(common.trim())) {
                if !git_roots.contains(&common) { git_roots.push(common); }
            }
        }
    }
    for git_root in &git_roots {
        if !git_root.starts_with(&root) {
            watcher.watch(git_root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
        }
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let entry = ProjectWatch {
        id: watch_id.clone(),
        _watcher: watcher,
        stopped: stopped.clone(),
    };
    window.service.project_files
        .watches
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window.label().into(), entry);
    std::thread::spawn(move || {
        let mut paths = BTreeSet::new();
        let mut rescan = false;
        let mut reconcile_all = false;
        let mut first = None;
        while !stopped.load(Ordering::Relaxed) {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(event)) if !matches!(event.kind, EventKind::Access(_)) => {
                    if event.need_rescan() {
                        rescan = true;
                        reconcile_all = true;
                        first.get_or_insert_with(Instant::now);
                    }
                    let mut relevant = false;
                    for path in event.paths {
                        if git_roots.iter().any(|git_root| path.strip_prefix(git_root).is_ok_and(review_git_metadata)) {
                            relevant = true;
                            rescan = true;
                            reconcile_all = true;
                        }
                        if let Ok(relative) = path.strip_prefix(&root) {
                            if !ignored(relative) {
                                paths.insert(relative.to_string_lossy().replace('\\', "/"));
                                relevant = true;
                            }
                        }
                    }
                    if relevant {
                        rescan |= matches!(
                            event.kind,
                            EventKind::Create(_)
                                | EventKind::Remove(_)
                                | EventKind::Modify(notify::event::ModifyKind::Name(_))
                                | EventKind::Any
                                | EventKind::Other
                        );
                        first.get_or_insert_with(Instant::now);
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) => {
                    rescan = true;
                    reconcile_all = true;
                    first.get_or_insert_with(Instant::now);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if first.is_some() {
                        rescan |= paths.is_empty();
                    }
                }
            }
            // Bound latency even during a continuous build or Git operation.
            if first.is_some_and(|at| at.elapsed() >= Duration::from_millis(200)) {
                if stopped.load(Ordering::Relaxed) {
                    break;
                }
                let _ = window.emit(
                    "project-files-changed",
                    FileChanges {
                        project_root: project_root.clone(),
                        watch_id: watch_id.clone(),
                        paths: if reconcile_all {
                            vec![]
                        } else {
                            paths.iter().cloned().collect()
                        },
                        rescan,
                    },
                );
                paths.clear();
                rescan = false;
                reconcile_all = false;
                first = None;
            }
        }
    });
    Ok(())
}

pub fn unwatch_project_files(window: WindowContext, watch_id: String) -> Result<(), String> {
    let state = &window.service.project_files;
    let mut watches = state.watches.lock().map_err(|e| e.to_string())?;
    if watches
        .get(window.label())
        .is_some_and(|watch| watch.id == watch_id)
    {
        watches.remove(window.label());
    }
    Ok(())
}

fn project_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid project file path".into());
    }
    let path = root.join(relative);
    let canonical = if fs::symlink_metadata(&path).is_ok() {
        fs::canonicalize(&path)
    } else {
        fs::canonicalize(path.parent().ok_or("Missing parent")?)
    }
    .map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("File is outside the project".into());
    }
    Ok(path)
}

#[derive(Serialize)]
pub struct SaveResult {
    written: bool,
    current: Option<String>,
    #[serde(rename = "commentWarning", skip_serializing_if = "Option::is_none")]
    comment_warning: Option<String>,
}

/// Publish a complete replacement only after writing succeeds. A failed write
/// leaves the previous file intact, including on Windows.
pub(crate) fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    replace_file_prepared(path, bytes, None, |_| Ok(()))
}

/// Recovery publishes saved content and its Git executable bit together.
/// None preserves the old byte-only journal behavior.
pub(crate) fn replace_file_prepared(path: &Path, bytes: &[u8], mode: Option<u32>, mut prepared: impl FnMut(&Path) -> Result<(), String>) -> Result<(), String> {
    if mode.is_some_and(|mode| !matches!(mode, 0o100644 | 0o100755)) {
        return Err("Unsupported recovery file mode".into());
    }
    use std::io::Write;
    let parent = path.parent().ok_or("Missing parent directory")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    if let Ok(metadata) = fs::metadata(path) {
        temporary.as_file().set_permissions(metadata.permissions()).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        let permissions = temporary.as_file().metadata().map_err(|e| e.to_string())?.permissions().mode();
        let executable = mode == 0o100755;
        let permissions = if (permissions & 0o111 != 0) == executable { permissions }
            else if executable { permissions | 0o111 } else { permissions & !0o111 };
        temporary.as_file().set_permissions(fs::Permissions::from_mode(permissions)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    prepared(temporary.path())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
fn checked_save(path: &Path, expected: Option<&str>, content: &str) -> Result<SaveResult, String> {
    checked_save_prepared(path, expected, content, |_| {})
}

fn checked_save_prepared(path: &Path, expected: Option<&str>, content: &str, mut prepared: impl FnMut(&Path)) -> Result<SaveResult, String> {
    let current = match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if current.as_deref() != expected {
        return Ok(SaveResult {
            comment_warning: None,
            written: false,
            current,
        });
    }
    if current.as_deref() != Some(content) {
        // Keep existing symlink semantics: publish to the validated target,
        // rather than replacing the link itself.
        let target = if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            fs::canonicalize(path).map_err(|e| e.to_string())?
        } else {
            path.to_path_buf()
        };
        replace_file_prepared(&target, content.as_bytes(), None, |path| { prepared(path); Ok(()) })?;
    }
    Ok(SaveResult {
        comment_warning: None,
        written: true,
        current: Some(content.into()),
    })
}

pub fn save_file_if_unchanged(
    service: &crate::host::ServiceContext,
    project_root: String,
    file_path: String,
    expected: Option<String>,
    content: String,
) -> Result<SaveResult, String> {
    let _comments = service.comments.lock_project_blocking(&project_root)?;
    let _guard = service.project_files.writes.lock().map_err(|e| e.to_string())?;
    let project_lock = crate::agent_workspace::project_apply_lock(&project_root)?;
    let _project_guard = project_lock.lock().map_err(|e| e.to_string())?;
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let mut warning = None;
    let mut result = checked_save_prepared(
        &project_path(&root, &file_path)?, expected.as_deref(), &content,
        |temporary| {
            let prepared = crate::comments::prepare_project_save(service, &project_root, &root, &file_path, temporary);
            if let Err(error) = prepared { warning = Some(error); }
        },
    )?;
    result.comment_warning = warning;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_watcher_reports_a_json_write() {
        let root = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let _ = tx.send(event);
            })
            .unwrap();
        watcher
            .watch(root.path(), RecursiveMode::Recursive)
            .unwrap();
        let path = root.path().join("comments.json");
        fs::write(&path, "[]").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Ok(event)) = rx.recv_timeout(Duration::from_millis(250)) {
                if !matches!(event.kind, EventKind::Access(_))
                    && event
                        .paths
                        .iter()
                        .any(|changed| changed.file_name() == path.file_name())
                {
                    return;
                }
            }
        }
        panic!("No native notification for comments.json");
    }
    #[test]
    fn stale_saves_and_external_deletions_preserve_disk() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.json");
        fs::write(&path, "external").unwrap();
        assert!(!checked_save(&path, Some("base"), "local").unwrap().written);
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        fs::remove_file(&path).unwrap();
        assert!(!checked_save(&path, Some("base"), "local").unwrap().written);
        assert!(!path.exists());
        assert!(checked_save(&path, None, "recovered").unwrap().written);
    }
    #[cfg(unix)]
    #[test]
    fn replacement_preserves_symlinks_and_file_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.tex");
        let link = root.path().join("linked.tex");
        fs::write(&target, "before").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&target, &link).unwrap();
        assert!(checked_save(&link, Some("before"), "after").unwrap().written);
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o640);
    }

    #[test]
    fn rejects_traversal_and_filters_generated_events() {
        let root = tempfile::tempdir().unwrap();
        assert!(project_path(root.path(), "../other").is_err());
        assert!(ignored(Path::new(".git/index")));
        assert!(ignored(Path::new("build/main.aux")));
        assert!(!ignored(Path::new("comments.json")));
    }
}
