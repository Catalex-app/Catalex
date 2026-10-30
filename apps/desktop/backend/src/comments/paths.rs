//! Explicit path migrations are journaled before source changes. Replaying the
//! journal is idempotent; both authors commit in one database transaction.
use super::*;
const JOURNAL: &str = "path-change.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentPathChange {
    pub old_path: String,
    pub new_path: String,
    #[serde(default)]
    pub folder: bool,
}
impl CommentPathChange {
    fn remap(&self, path: &str) -> Option<String> {
        if path == self.old_path {
            return Some(self.new_path.clone());
        }
        if self.folder {
            return path
                .strip_prefix(&format!("{}/", self.old_path))
                .map(|suffix| format!("{}/{suffix}", self.new_path));
        }
        None
    }
}

pub(crate) fn prepare(
    root: &Path,
    storage: &Path,
    changes: &[CommentPathChange],
) -> Result<(), String> {
    fs::create_dir_all(storage).map_err(|error| error.to_string())?;
    recover(root, storage)?;
    for change in changes {
        relative_path(&change.old_path)?;
        relative_path(&change.new_path)?;
        if change.old_path == change.new_path {
            return Err("Rename paths must differ".into());
        }
    }
    // Validate both before modifying either. Ordinary manuscript saves do not
    // depend on this metadata transaction.
    identity::read_both(root, storage)?;
    if changes.is_empty() {
        return Ok(());
    }
    let bytes = serde_json::to_vec(changes).map_err(|e| e.to_string())?;
    let temp = storage.join(format!(".paths-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, storage.join(JOURNAL))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|e| format!("Could not prepare comment path recovery: {e}"))
}

pub(crate) fn recover(root: &Path, storage: &Path) -> Result<Vec<CommentPathChange>, String> {
    let journal = storage.join(JOURNAL);
    let bytes = match fs::read(&journal) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let changes: Vec<CommentPathChange> =
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut applied = Vec::new();
    for change in changes {
        let old = root.join(relative_path(&change.old_path)?);
        let new = root.join(relative_path(&change.new_path)?);
        match (old.try_exists(), new.try_exists()) {
            (Ok(false), Ok(true)) => applied.push(change),
            (Ok(true), Ok(false)) => {}, // Source operation did not commit.
            _ => return Err("Comment path recovery is ambiguous; original metadata is preserved. Restore the source/target paths before retrying.".into()),
        }
    }
    remap(root, storage, &applied)?;
    fs::remove_file(journal).map_err(|e| e.to_string())?;
    Ok(applied)
}

pub(crate) fn remap(
    root: &Path,
    storage: &Path,
    changes: &[CommentPathChange],
) -> Result<(), String> {
    let mut sides = identity::read_both(root, storage)?;
    let mut changed = false;
    for snapshot in &mut sides {
        let moved: Vec<_> = snapshot
            .files
            .keys()
            .filter_map(|path| {
                changes
                    .iter()
                    .find_map(|change| change.remap(path))
                    .filter(|target| target != path)
                    .map(|target| (path.clone(), target))
            })
            .collect();
        if moved.is_empty() {
            continue;
        }
        let mut destinations = std::collections::BTreeSet::new();
        if moved.iter().any(|(_, target)| !destinations.insert(target)) {
            return Err("Comment path mappings have overlapping destinations".into());
        }
        let entries: Vec<_> = moved
            .into_iter()
            .map(|(old, target)| (target, snapshot.files.remove(&old).unwrap_or_default()))
            .collect();
        for (target, comments) in entries {
            // Stale comments already stored at a reused destination belong to a
            // different file; preserve them separately rather than merging them.
            if let Some(previous) = snapshot.files.remove(&target) {
                let unrelated: Vec<_> = previous
                    .into_iter()
                    .filter(|old| !comments.iter().any(|new| new.id == old.id))
                    .collect();
                if !unrelated.is_empty() {
                    if let Some(revisions) = snapshot.revisions.get(&target) {
                        snapshot.orphaned_revisions.entry(target.clone()).or_default().extend(revisions.iter().cloned());
                    }
                    snapshot
                        .orphaned
                        .entry(target.clone())
                        .or_default()
                        .extend(unrelated);
                }
            }
            snapshot.files.insert(target.clone(), comments);
            super::identity::remember(root, snapshot, &target);
        }
        snapshot
            .revisions
            .retain(|path, _| snapshot.files.contains_key(path));
        super::identity::prune_sources(snapshot);
        changed = true;
    }
    if changed { store::write(storage, &[(false, &sides[0]), (true, &sides[1])], &[])?; }
    Ok(())
}

/// Replay app-owned path changes before checking relative paths and contents.
pub(crate) fn reconcile(root: &Path, storage: &Path) -> Result<Vec<CommentPathChange>, String> {
    Ok(read_reconciled(root, storage)?.1)
}

pub(super) fn read_reconciled(root: &Path, storage: &Path) -> Result<([AuthorSnapshot; 2], Vec<CommentPathChange>), String> {
    let mut changes = recover_pending(root, storage)?;
    let (sides, reconciled) = identity::read_reconciled(root, storage)?;
    changes.extend(reconciled);
    Ok((sides, changes))
}

// Pending app operations must be replayed even when a routine write checks only
// one file. Full project reads still reconcile every commented path.
pub(super) fn recover_pending(root: &Path, storage: &Path) -> Result<Vec<CommentPathChange>, String> {
    let mut changes = super::recovery::recover(root, storage)?;
    changes.extend(recover(root, storage)?);
    Ok(changes)
}

pub fn rename_project_path(
    service: &crate::host::ServiceContext,
    project_root: String,
    change: CommentPathChange,
) -> Result<Value, String> {
    let _comments = service.comments.lock_project_blocking(&project_root)?;
    let project_lock = crate::agent_workspace::project_apply_lock(&project_root)?;
    let _project = project_lock
        .lock()
        .map_err(|_| "Project lock unavailable")?;
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let old = root.join(relative_path(&change.old_path)?);
    let new = root.join(relative_path(&change.new_path)?);
    let source = fs::canonicalize(&old).map_err(|e| e.to_string())?;
    let parent = fs::canonicalize(new.parent().ok_or("Missing target parent")?)
        .map_err(|e| e.to_string())?;
    if !source.starts_with(&root) || !parent.starts_with(&root) || new.exists() {
        return Err("Rename must stay inside the project and use an unused target path".into());
    }
    let storage = comment_directory(service, &project_root)?;
    prepare(&root, &storage, std::slice::from_ref(&change))?;
    if let Err(error) = fs::rename(&old, &new) {
        let _ = fs::remove_file(storage.join(JOURNAL));
        return Err(error.to_string());
    }
    // Source rename is committed. A metadata failure must not misreport it as
    // rejected; the durable journal will finish on the next comment read.
    let warning = recover(&root, &storage).err();
    Ok(json!({ "pathChanges": [change], "commentWarning": warning }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path, storage: &Path) {
        fs::create_dir_all(root.join("chapter")).unwrap();
        fs::write(root.join("chapter/notes.md"), "a passage").unwrap();
        fs::create_dir_all(storage).unwrap();
        for agent in [false, true] {
            let value = json!({ "version": 1, "counter": 1,
                "files": { "chapter/notes.md": [{ "id": if agent { "A-1" } else { "H-1" },
                    "number": 1, "from": 2, "to": 9, "line": 1, "text": "Preserve this", "resolved": true,
                    "anchorRevision": "reference", "origin": if agent { json!({ "provider": "codex", "sessionId": "session" }) } else { Value::Null } }] },
                "sources": { "reference": "a passage" } });
            crate::comments::test_write(storage.join(if agent { "agent.json" } else { "human.json" }), value.to_string()).unwrap();
        }
    }
    fn mapping() -> CommentPathChange {
        CommentPathChange {
            old_path: "chapter".into(),
            new_path: "section".into(),
            folder: true,
        }
    }
    #[test]
    fn recovers_both_origins_and_references_after_partial_publication() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        fixture(root.path(), storage.path());
        let before = read_author_snapshot(root.path(), storage.path(), false)
            .unwrap()
            .files["chapter/notes.md"]
            .clone();
        prepare(root.path(), storage.path(), &[mapping()]).unwrap();
        fs::rename(root.path().join("chapter"), root.path().join("section")).unwrap();
        // Simulate interruption after only the human snapshot was published.
        let mut human = read_author_snapshot(root.path(), storage.path(), false).unwrap();
        let comments = human.files.remove("chapter/notes.md").unwrap();
        human.files.insert("section/notes.md".into(), comments);
        write_author_snapshot(storage.path(), false, &human).unwrap();
        recover(root.path(), storage.path()).unwrap();
        for agent in [false, true] {
            let data = read_author_snapshot(root.path(), storage.path(), agent).unwrap();
            assert!(!data.files.contains_key("chapter/notes.md"));
            let moved = &data.files["section/notes.md"][0];
            assert_eq!(moved.from, 2);
            assert_eq!(moved.to, 9);
            assert!(moved.resolved);
            assert_eq!(data.sources["reference"], "a passage");
            assert_eq!(moved.origin.is_some(), agent);
        }
        assert_eq!(
            read_author_snapshot(root.path(), storage.path(), false)
                .unwrap()
                .files["section/notes.md"],
            before
        );
        assert!(recover(root.path(), storage.path()).unwrap().is_empty());
        fs::create_dir(root.path().join("chapter")).unwrap();
        fs::write(root.path().join("chapter/notes.md"), "unrelated").unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        assert!(!read_author_snapshot(root.path(), storage.path(), false)
            .unwrap()
            .files
            .contains_key("chapter/notes.md"));
    }
    #[test]
    fn missing_external_files_are_archived_and_never_reattached_to_reused_paths() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        fixture(root.path(), storage.path());
        fs::rename(root.path().join("chapter"), root.path().join("unknown")).unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        fs::create_dir(root.path().join("chapter")).unwrap();
        fs::write(root.path().join("chapter/notes.md"), "a passage").unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        for agent in [false, true] {
            let data = read_author_snapshot(root.path(), storage.path(), agent).unwrap();
            assert!(data.files.is_empty());
            assert_eq!(data.orphaned["chapter/notes.md"].len(), 1);
            assert_eq!(data.sources["reference"], "a passage");
            let comment = data.orphaned["chapter/notes.md"][0].clone();
            let patch = CommentPatch {
                file_path: "chapter/notes.md".into(),
                id: comment.id.clone(),
                before: None,
                after: Some(comment),
            };
            assert!(replay_patch(root.path(), storage.path(), patch)
                .unwrap_err()
                .contains("orphaned"));
        }
    }
    #[test]
    fn canceled_and_ambiguous_renames_keep_metadata() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        fixture(root.path(), storage.path());
        prepare(root.path(), storage.path(), &[mapping()]).unwrap();
        assert!(recover(root.path(), storage.path()).unwrap().is_empty());
        prepare(root.path(), storage.path(), &[mapping()]).unwrap();
        fs::create_dir(root.path().join("section")).unwrap();
        assert!(recover(root.path(), storage.path())
            .unwrap_err()
            .contains("ambiguous"));
        assert!(storage.path().join(JOURNAL).exists());
        assert!(read_author_snapshot(root.path(), storage.path(), false)
            .unwrap()
            .files
            .contains_key("chapter/notes.md"));
    }
    #[test]
    fn external_git_rename_waits_for_explicit_relink() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        fixture(root.path(), storage.path());
        reconcile(root.path(), storage.path()).unwrap();
        let repo = git2::Repository::init(root.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("chapter/notes.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .unwrap();
        fs::rename(root.path().join("chapter"), root.path().join("section")).unwrap();
        index.remove_path(Path::new("chapter/notes.md")).unwrap();
        index.add_path(Path::new("section/notes.md")).unwrap();
        index.write().unwrap();
        assert!(reconcile(root.path(), storage.path()).unwrap().is_empty());
        assert!(read_author_snapshot(root.path(), storage.path(), false)
            .unwrap()
            .orphaned
            .contains_key("chapter/notes.md"));
        assert!(reconcile(root.path(), storage.path()).unwrap().is_empty());
    }
    #[test]
    fn history_retains_pending_path_recovery_and_reused_targets_stay_separate() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        fixture(root.path(), storage.path());
        let mut data = read_author_snapshot(root.path(), storage.path(), false).unwrap();
        let mut unrelated = data.files["chapter/notes.md"][0].clone();
        unrelated.id = "H-2".into();
        unrelated.number = Some(2);
        unrelated.text = "Other file".into();
        data.counter = 2;
        data.files
            .insert("section/notes.md".into(), vec![unrelated.clone()]);
        write_author_snapshot(storage.path(), false, &data).unwrap();
        prepare(root.path(), storage.path(), &[mapping()]).unwrap();
        fs::rename(root.path().join("chapter"), root.path().join("section")).unwrap();
        let snapshot = capture_history(storage.path()).unwrap();
        recover(root.path(), storage.path()).unwrap();
        let moved = read_author_snapshot(root.path(), storage.path(), false).unwrap();
        assert_eq!(moved.files["section/notes.md"].len(), 1);
        assert_eq!(moved.files["section/notes.md"][0].id, "H-1");
        assert_eq!(moved.orphaned["section/notes.md"], vec![unrelated]);
        restore_history(storage.path(), &snapshot).unwrap();
        assert!(storage.path().join(JOURNAL).exists());
        recover(root.path(), storage.path()).unwrap();
        assert_eq!(
            read_author_snapshot(root.path(), storage.path(), false)
                .unwrap()
                .files["section/notes.md"][0]
                .id,
            "H-1"
        );
    }
}
