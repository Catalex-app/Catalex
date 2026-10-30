//! Whole-file conflict recovery. Text hunk editing remains in history.rs.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use git2::{IndexConflict, IndexEntry, Repository, RepositoryState};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
pub struct ConflictSide {
    path: String,
    binary: bool,
    size: usize,
    text: Option<String>,
    preview_url: Option<String>,
    supported: bool,
}

#[derive(Serialize)]
pub struct ConflictFile {
    path: String,
    document_path: Option<String>,
    version: String,
    ancestor: Option<ConflictSide>,
    current: Option<ConflictSide>,
    incoming: Option<ConflictSide>,
}

#[derive(Serialize)]
pub struct ConflictOverview {
    rebasing: bool,
    files: Vec<ConflictFile>,
}

fn repo(root: &str) -> Result<Repository, String> {
    Repository::discover(root).map_err(|e| format!("Could not open Git repository: {e}"))
}

fn entry_path(entry: &IndexEntry) -> Result<&str, String> {
    std::str::from_utf8(&entry.path).map_err(|_| "This conflict has a non-UTF-8 file name".into())
}

fn conflict_path(conflict: &IndexConflict) -> Result<&str, String> {
    entry_path(
        conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .ok_or("The conflict has no file path")?,
    )
}

fn version(repo: &Repository, conflict: &IndexConflict) -> String {
    let entries = [&conflict.ancestor, &conflict.our, &conflict.their].map(|side| {
        side.as_ref()
            .map(|e| format!("{}:{}:{}", e.id, e.mode, String::from_utf8_lossy(&e.path)))
            .unwrap_or_else(|| "deleted".into())
    });
    format!(
        "{:?}:{}:{}",
        repo.state(),
        repo.head()
            .ok()
            .and_then(|h| h.target())
            .map(|id| id.to_string())
            .unwrap_or_default(),
        entries.join("|")
    )
}

/// Text review is bound to both the index stages and the on-disk result. The
/// latter may already contain manual resolutions that must not be overwritten.
pub(crate) fn text_version(repo: &Repository, conflict: &IndexConflict) -> Result<String, String> {
    let root = repo
        .workdir()
        .ok_or("This repository has no working directory")?;
    let path = checked_worktree_path(root, conflict_path(conflict)?)?;
    let content = match fs::read(path) {
        Ok(bytes) => git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
            .map_err(|error| error.to_string())?
            .to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "absent".into(),
        Err(error) => return Err(error.to_string()),
    };
    Ok(format!("{}:{content}", version(repo, conflict)))
}

fn side(repo: &Repository, entry: Option<&IndexEntry>) -> Result<Option<ConflictSide>, String> {
    let Some(entry) = entry else { return Ok(None) };
    let path = entry_path(entry)?.to_string();
    let supported = entry.mode == 0o100644 || entry.mode == 0o100755;
    if !supported {
        return Ok(Some(ConflictSide {
            path,
            binary: true,
            size: 0,
            text: None,
            preview_url: None,
            supported,
        }));
    }
    let blob = repo
        .find_blob(entry.id)
        .map_err(|e| format!("Could not read {path}: {e}"))?;
    let bytes = blob.content();
    let binary = blob.is_binary() || std::str::from_utf8(bytes).is_err();
    // Only passive raster formats are embedded. Cap previews, never the resolution bytes.
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    };
    let preview_url = mime
        .filter(|_| bytes.len() <= 2 * 1024 * 1024)
        .map(|mime| format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
    let text = if binary {
        None
    } else {
        let content = std::str::from_utf8(bytes).unwrap();
        let mut preview: String = content.chars().take(4000).collect();
        if preview.len() < content.len() {
            preview.push_str("\n… Preview truncated");
        }
        Some(preview)
    };
    Ok(Some(ConflictSide {
        path,
        binary,
        size: bytes.len(),
        text,
        preview_url,
        supported,
    }))
}

pub fn git_panel_conflicts(project_root: String) -> Result<ConflictOverview, String> {
    let repo = repo(&project_root)?;
    let workdir = repo
        .workdir()
        .ok_or("This repository has no working directory")?;
    let project = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let workdir = fs::canonicalize(workdir).map_err(|e| e.to_string())?;
    let index = repo.index().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for conflict in index.conflicts().map_err(|e| e.to_string())? {
        let conflict = conflict.map_err(|e| e.to_string())?;
        let path = conflict_path(&conflict)?.to_string();
        let document_path = workdir
            .join(&path)
            .strip_prefix(&project)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        files.push(ConflictFile {
            path,
            document_path,
            version: version(&repo, &conflict),
            ancestor: side(&repo, conflict.ancestor.as_ref())?,
            current: side(&repo, conflict.our.as_ref())?,
            incoming: side(&repo, conflict.their.as_ref())?,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ConflictOverview {
        rebasing: matches!(
            repo.state(),
            RepositoryState::Rebase
                | RepositoryState::RebaseInteractive
                | RepositoryState::RebaseMerge
        ),
        files,
    })
}

struct IndexLock {
    path: PathBuf,
    owned: bool,
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        if self.owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn checked_worktree_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid conflict path".into());
    }
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        if part
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")
        {
            return Err("Invalid conflict path".into());
        }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Resolve symbolic-link conflicts outside this dialog".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not inspect {relative}: {e}")),
        }
    }
    Ok(path)
}

pub fn git_panel_resolve_conflict_side(
    project_root: String,
    file_path: String,
    choice: String,
    expected_version: String,
) -> Result<(), String> {
    if !matches!(choice.as_str(), "ancestor" | "current" | "incoming") {
        return Err("Choose a conflict version".into());
    }
    resolve_conflict(project_root, file_path, choice, expected_version, None)
}

pub(crate) fn resolve_conflict_text(
    project_root: String,
    file_path: String,
    expected_version: String,
    content: String,
) -> Result<(), String> {
    resolve_conflict(
        project_root,
        file_path,
        "result".into(),
        expected_version,
        Some(content),
    )
}

fn resolve_conflict(
    project_root: String,
    file_path: String,
    choice: String,
    expected_version: String,
    content: Option<String>,
) -> Result<(), String> {
    let repo = repo(&project_root)?;
    let workdir = repo
        .workdir()
        .ok_or("This repository has no working directory")?;
    let path = checked_worktree_path(workdir, &file_path)?;
    let index_path = repo.path().join("index");
    let lock_path = repo.path().join("index.lock");
    // Hold Git's normal index lock throughout the worktree change. Git commands
    // operate on this temporary index; publish it only after resolution succeeds.
    let mut lock_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|e| {
            format!("Could not lock the Git index. Wait for other Git operations, then retry: {e}")
        })?;
    let mut lock = IndexLock {
        path: lock_path,
        owned: true,
    };
    let index_bytes = fs::read(&index_path).map_err(|e| e.to_string())?;
    lock_file
        .write_all(&index_bytes)
        .map_err(|e| e.to_string())?;
    drop(lock_file);
    let index = repo.index().map_err(|e| e.to_string())?;
    let conflict = index
        .conflict_get(Path::new(&file_path))
        .map_err(|_| "This file is no longer conflicted. Refresh the conflict list.".to_string())?;
    let actual_version = if content.is_some() {
        text_version(&repo, &conflict)?
    } else {
        version(&repo, &conflict)
    };
    if actual_version != expected_version {
        return Err(
            "The conflict changed. Refresh the conflict list before choosing a version.".into(),
        );
    }
    let selected = match choice.as_str() {
        "ancestor" => &conflict.ancestor,
        "current" => &conflict.our,
        _ => &conflict.their,
    };
    for entry in [&conflict.ancestor, &conflict.our, &conflict.their]
        .into_iter()
        .flatten()
    {
        if entry_path(entry)? != file_path {
            return Err(
                "Resolve the related rename paths before choosing a whole-file version".into(),
            );
        }
        if entry.mode != 0o100644 && entry.mode != 0o100755 {
            return Err("This file type cannot be resolved in this dialog".into());
        }
    }
    let backup = match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => Some((
            fs::read(&path).map_err(|e| e.to_string())?,
            metadata.permissions(),
        )),
        Ok(_) => {
            return Err("A directory occupies this conflict path. Move it before retrying.".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let git = |args: &[&str]| -> Result<(), String> {
        let output = Command::new("git")
            .current_dir(workdir)
            .env("GIT_INDEX_FILE", &lock.path)
            .arg("--literal-pathspecs")
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .trim()
            .to_string())
        }
    };
    let result = (|| {
        if let Some(content) = &content {
            // The preview was validated before any write. Reuse the same index
            // lock and rollback path as whole-file selection.
            crate::project_files::replace_file(&path, content.as_bytes())?;
            git(&["add", "--", &file_path])?;
        } else if selected.is_some() {
            if choice == "ancestor" {
                git(&["checkout-index", "--force", "--stage=1", "--", &file_path])?;
            } else {
                git(&[
                    "checkout",
                    if choice == "current" {
                        "--ours"
                    } else {
                        "--theirs"
                    },
                    "--",
                    &file_path,
                ])?;
            }
            git(&["add", "--", &file_path])?;
        } else {
            git(&["rm", "--force", "--", &file_path])?;
        }
        fs::rename(&lock.path, &index_path)
            .map_err(|e| format!("Could not save the resolved index: {e}"))
    })();
    if result.is_ok() {
        lock.owned = false;
    }
    if let Err(error) = result {
        let restored = if let Some((bytes, permissions)) = backup {
            fs::write(&path, bytes).and_then(|_| fs::set_permissions(&path, permissions))
        } else if path.exists() {
            fs::remove_file(&path)
        } else {
            Ok(())
        };
        return Err(match restored {
            Ok(()) => error,
            Err(e) => format!("{error}. Restoring the previous file also failed: {e}"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn git(root: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_EDITOR", "true")
            .output()
            .unwrap()
    }
    fn ok(root: &Path, args: &[&str]) {
        let out = git(root, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn fixture(ours: Option<&[u8]>, theirs: Option<&[u8]>, rebase: bool) -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        ok(root, &["init", "-b", "main"]);
        ok(root, &["config", "user.name", "Conflict test"]);
        ok(root, &["config", "user.email", "test@example.invalid"]);
        ok(root, &["config", "commit.gpgsign", "false"]);
        ok(root, &["config", "core.hooksPath", "/dev/null"]);
        fs::write(root.join("figure.bin"), b"base\0").unwrap();
        ok(root, &["add", "."]);
        ok(root, &["commit", "-m", "Base"]);
        for (branch, content) in [("incoming", theirs), ("main", ours)] {
            if branch == "incoming" {
                ok(root, &["checkout", "-b", branch]);
            } else {
                ok(root, &["checkout", branch]);
            }
            if let Some(bytes) = content {
                fs::write(root.join("figure.bin"), bytes).unwrap();
            } else {
                fs::remove_file(root.join("figure.bin")).unwrap();
            }
            ok(root, &["add", "--", "figure.bin"]);
            ok(root, &["commit", "-m", branch]);
        }
        let output = git(root, &[if rebase { "rebase" } else { "merge" }, "incoming"]);
        assert!(!output.status.success(), "expected a conflict");
        dir
    }
    fn overview(dir: &TempDir) -> ConflictOverview {
        git_panel_conflicts(dir.path().to_string_lossy().into()).unwrap()
    }
    fn resolve(dir: &TempDir, choice: &str) -> Result<(), String> {
        let file = overview(dir).files.remove(0);
        git_panel_resolve_conflict_side(
            dir.path().to_string_lossy().into(),
            file.path,
            choice.into(),
            file.version,
        )
    }

    #[test]
    fn binary_choices_preserve_exact_bytes_and_other_staged_files() {
        for (choice, expected) in [
            ("ancestor", b"base\0"),
            ("current", b"ours\0"),
            ("incoming", b"them\0"),
        ] {
            let dir = fixture(Some(b"ours\0"), Some(b"them\0"), false);
            let view = overview(&dir);
            assert!(view.files[0].ancestor.as_ref().unwrap().binary);
            assert!(view.files[0].current.as_ref().unwrap().binary);
            assert!(view.files[0].incoming.as_ref().unwrap().binary);
            fs::write(dir.path().join("unrelated.tex"), b"preserve").unwrap();
            ok(dir.path(), &["add", "unrelated.tex"]);
            resolve(&dir, choice).unwrap();
            assert_eq!(fs::read(dir.path().join("figure.bin")).unwrap(), expected);
            assert_eq!(git(dir.path(), &["show", ":figure.bin"]).stdout, expected);
            assert_eq!(
                git(dir.path(), &["show", ":unrelated.tex"]).stdout,
                b"preserve"
            );
            assert!(overview(&dir).files.is_empty());
            ok(dir.path(), &["commit", "--allow-empty", "-m", "Resolved"]);
        }
    }

    #[test]
    fn modify_delete_both_directions_can_keep_file_or_deletion() {
        for deleted_current in [true, false] {
            for choice in ["ancestor", "current", "incoming"] {
                let (ours, theirs) = if deleted_current {
                    (None, Some(b"them\0".as_slice()))
                } else {
                    (Some(b"ours\0".as_slice()), None)
                };
                let dir = fixture(ours, theirs, false);
                let view = overview(&dir);
                assert_eq!(view.files[0].current.is_none(), deleted_current);
                assert_eq!(view.files[0].incoming.is_none(), !deleted_current);
                resolve(&dir, choice).unwrap();
                let expected = match choice {
                    "ancestor" => Some(b"base\0".as_slice()),
                    "current" => ours,
                    _ => theirs,
                };
                assert_eq!(dir.path().join("figure.bin").exists(), expected.is_some());
                if let Some(bytes) = expected {
                    assert_eq!(fs::read(dir.path().join("figure.bin")).unwrap(), bytes);
                }
                assert!(overview(&dir).files.is_empty());
                ok(dir.path(), &["commit", "--allow-empty", "-m", "Resolved"]);
            }
        }
    }

    #[test]
    fn add_add_conflict_has_absent_ancestor_and_can_restore_absence() {
        let dir = fixture(Some(b"ours\0"), Some(b"them\0"), false);
        let repository = repo(&dir.path().to_string_lossy()).unwrap();
        let mut index = repository.index().unwrap();
        index.remove(Path::new("figure.bin"), 1).unwrap();
        index.write().unwrap();
        assert!(overview(&dir).files[0].ancestor.is_none());
        resolve(&dir, "ancestor").unwrap();
        assert!(!dir.path().join("figure.bin").exists());
        assert!(overview(&dir).files.is_empty());
    }

    #[test]
    fn rebase_sides_are_target_and_replayed_commit_and_can_continue() {
        for (choice, expected) in [("current", b"them\0"), ("incoming", b"ours\0")] {
            let dir = fixture(Some(b"ours\0"), Some(b"them\0"), true);
            assert!(overview(&dir).rebasing);
            resolve(&dir, choice).unwrap();
            assert_eq!(fs::read(dir.path().join("figure.bin")).unwrap(), expected);
            ok(dir.path(), &["rebase", "--continue"]);
            assert_eq!(
                repo(&dir.path().to_string_lossy()).unwrap().state(),
                RepositoryState::Clean
            );
        }
    }

    #[test]
    fn stale_preview_and_busy_index_leave_conflict_untouched() {
        let dir = fixture(Some(b"ours\0"), Some(b"them\0"), false);
        let root = dir.path().to_string_lossy().to_string();
        let before = fs::read(dir.path().join(".git/index")).unwrap();
        assert!(git_panel_resolve_conflict_side(
            root,
            "figure.bin".into(),
            "incoming".into(),
            "stale".into()
        )
        .unwrap_err()
        .contains("changed"));
        fs::write(dir.path().join(".git/index.lock"), b"someone else's lock").unwrap();
        assert!(resolve(&dir, "incoming").unwrap_err().contains("lock"));
        assert_eq!(
            fs::read(dir.path().join(".git/index.lock")).unwrap(),
            b"someone else's lock"
        );
        assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(), before);
        assert_eq!(fs::read(dir.path().join("figure.bin")).unwrap(), b"ours\0");
    }

    #[test]
    fn staging_failure_restores_worktree_and_keeps_original_conflicted_index() {
        let dir = fixture(Some(b"ours\0"), Some(b"them\0"), false);
        fs::write(dir.path().join(".gitattributes"), "*.bin filter=broken\n").unwrap();
        ok(dir.path(), &["config", "filter.broken.clean", "false"]);
        ok(dir.path(), &["config", "filter.broken.smudge", "cat"]);
        ok(dir.path(), &["config", "filter.broken.required", "true"]);
        let before = fs::read(dir.path().join(".git/index")).unwrap();
        assert!(resolve(&dir, "incoming").is_err());
        assert_eq!(fs::read(dir.path().join("figure.bin")).unwrap(), b"ours\0");
        assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(), before);
        assert!(!dir.path().join(".git/index.lock").exists());
        assert_eq!(overview(&dir).files.len(), 1);
    }

    #[test]
    fn text_resolution_staging_failure_restores_file_and_index() {
        let dir = fixture(Some(b"ours\0"), Some(b"them\0"), false);
        let repository = repo(&dir.path().to_string_lossy()).unwrap();
        let index = repository.index().unwrap();
        let conflict = index.conflict_get(Path::new("figure.bin")).unwrap();
        let version = text_version(&repository, &conflict).unwrap();
        fs::write(dir.path().join(".gitattributes"), "*.bin filter=broken\n").unwrap();
        ok(dir.path(), &["config", "filter.broken.clean", "false"]);
        ok(dir.path(), &["config", "filter.broken.required", "true"]);
        let before = fs::read(dir.path().join(".git/index")).unwrap();
        assert!(resolve_conflict_text(
            dir.path().to_string_lossy().into(),
            "figure.bin".into(),
            version,
            "resolved\n".into()
        )
        .is_err());
        assert_eq!(fs::read(dir.path().join("figure.bin")).unwrap(), b"ours\0");
        assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(), before);
        assert!(!dir.path().join(".git/index.lock").exists());
    }

    #[test]
    fn image_metadata_and_nested_project_paths_are_distinct_from_absent_sides() {
        let dir = fixture(
            Some(b"\x89PNG\r\n\x1a\nours\0"),
            Some(b"\x89PNG\r\n\x1a\nthem\0"),
            false,
        );
        let view = overview(&dir);
        assert!(view.files[0]
            .current
            .as_ref()
            .unwrap()
            .preview_url
            .as_ref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(view.files[0].document_path.as_deref(), Some("figure.bin"));
        fs::create_dir(dir.path().join("paper")).unwrap();
        let nested =
            git_panel_conflicts(dir.path().join("paper").to_string_lossy().into()).unwrap();
        assert!(nested.files[0].document_path.is_none());
    }
}
