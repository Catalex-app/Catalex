//! Accepted file changes outlive their draft. Keep only comment continuity
//! evidence here; replay never writes project files or reopens acceptance.
use super::*;
use identity::FileRevision;

pub(crate) type FileRevisions = BTreeMap<String, Option<Vec<FileRevision>>>;

#[derive(Serialize, Deserialize)]
struct Recovery {
    order: u128,
    settlement: PathBuf,
    changes: Vec<CommentPathChange>,
    #[serde(default)]
    before: FileRevisions,
    files: FileRevisions,
}

pub(super) fn directory(storage: &Path) -> PathBuf {
    storage.with_extension("recovery")
}

pub(crate) fn defer(
    root: &Path,
    storage: &Path,
    settlement: &Path,
    id: &str,
    paths: &[String],
    changes: &[CommentPathChange],
    before: &FileRevisions,
) -> Result<(), String> {
    let dir = directory(storage);
    let path = dir.join(format!("{id}.json"));
    if path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let files = capture(root, paths)?;
    let pending = Recovery {
        order: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
        settlement: settlement.to_path_buf(),
        changes: changes.to_vec(),
        before: before.clone(),
        files,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::project_files::replace_file(
        &path,
        &serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )
}

/// Save the actual replacement content revision while it is still a temporary file.
/// Publication must stop if this durable update fails.
pub(crate) fn record_file(
    storage: &Path,
    id: &str,
    relative: &str,
    prepared: Option<&Path>,
) -> Result<(), String> {
    let path = directory(storage).join(format!("{id}.json"));
    let mut job: Recovery = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if !job.files.contains_key(relative) {
        return Ok(());
    }
    let ids = prepared.map(|file| identity::file_revision(file).into_iter().collect());
    if job.files.get(relative) == Some(&ids) {
        return Ok(());
    }
    job.files.insert(relative.to_owned(), ids);
    crate::project_files::replace_file(&path, &serde_json::to_vec(&job).map_err(|e| e.to_string())?)
}

/// A cancelled publication may have recorded a temporary revision which was
/// never installed. Reset to the actual files before publishing the rollback.
pub(crate) fn prepare_rollback(
    root: &Path,
    storage: &Path,
    id: &str,
    paths: &[String],
) -> Result<(), String> {
    let path = directory(storage).join(format!("{id}.json"));
    let mut job: Recovery = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    job.changes.clear();
    job.files = capture(root, paths)?;
    crate::project_files::replace_file(&path, &serde_json::to_vec(&job).map_err(|e| e.to_string())?)
}

pub(crate) fn capture(root: &Path, paths: &[String]) -> Result<FileRevisions, String> {
    let mut files = BTreeMap::new();
    for relative in paths {
        let file = root.join(relative_path(relative)?);
        let ids = if file.try_exists().map_err(|e| e.to_string())? {
            Some(identity::file_revision(&file).into_iter().collect())
        } else {
            None
        };
        files.insert(relative.clone(), ids);
    }
    Ok(files)
}

fn disconnect(side: &mut AuthorSnapshot, path: &str) {
    if let Some(comments) = side.files.remove(path) {
        let mut key = path.to_owned();
        let mut number = 2;
        while side.orphaned.contains_key(&key) {
            key = format!("{path} [disconnected {number}]");
            number += 1;
        }
        if let Some(revisions) = side.revisions.get(path) {
            side.orphaned_revisions
                .insert(key.clone(), revisions.clone());
        }
        side.orphaned.insert(key, comments);
    }
    side.revisions.remove(path);
}

pub(crate) fn recover(root: &Path, storage: &Path) -> Result<Vec<CommentPathChange>, String> {
    // Retire already-consumed acceptance jobs before replaying pending work.
    // Both author snapshots were committed atomically with the consumed-job rows.
    identity::cleanup_jobs(storage)?;
    let dir = directory(storage);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut jobs = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let job: Recovery = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if job.settlement.try_exists().map_err(|e| e.to_string())? {
            return Err(
                "Comment recovery is waiting for interrupted file acceptance to finish".into(),
            );
        }
        jobs.push((path, job));
    }
    if jobs.is_empty() {
        return Ok(Vec::new());
    }
    jobs.sort_by_key(|(_, job)| job.order);
    let mut sides = identity::read_both(root, storage)?;
    let mut changes = Vec::new();
    let mut external = std::collections::BTreeSet::new();
    let mut touched = std::collections::BTreeSet::new();
    for (_, job) in &jobs {
        // Do not bridge an external replacement between two accepted edits.
        // A newer app-owned replacement only continues the file it actually saw.
        for (path, before) in &job.before {
            for side in &mut sides {
                let known = side.revisions.get(path);
                let unrelated = match before {
                    None => side.files.contains_key(path),
                    Some(ids) => known.is_some_and(|known| {
                        !known.is_empty()
                            && !ids.is_empty()
                            && !known.iter().any(|id| ids.contains(id))
                    }),
                };
                if unrelated {
                    // Preserve the old anchor sources for text recovery at the
                    // final path. Do not bless an external change as app-owned.
                    external.insert(path.clone());
                    side.revisions.insert(path.clone(), Vec::new());
                }
            }
        }
        for change in &job.changes {
            relative_path(&change.old_path)?;
            relative_path(&change.new_path)?;
            for side in &mut sides {
                if let Some(comments) = side.files.remove(&change.old_path) {
                    disconnect(side, &change.new_path);
                    side.files.insert(change.new_path.clone(), comments);
                    side.revisions.remove(&change.old_path);
                }
            }
            if external.remove(&change.old_path) {
                external.insert(change.new_path.clone());
            }
            changes.push(change.clone());
        }
        for (path, ids) in &job.files {
            touched.insert(path.clone());
            relative_path(path)?;
            for side in &mut sides {
                if let Some(ids) = ids {
                    if side.files.contains_key(path) {
                        side.revisions.insert(
                            path.clone(),
                            if external.contains(path) {
                                Vec::new()
                            } else {
                                ids.clone()
                            },
                        );
                    }
                } else {
                    disconnect(side, path);
                }
            }
        }
    }
    // Only the exact accepted disk revision is an app-owned text update.
    // A subsequent external edit must use conservative contextual recovery.
    let mut owned = std::collections::BTreeSet::new();
    for side in &sides {
        for (path, revisions) in &side.revisions {
            if touched.contains(path) && !external.contains(path) && identity::file_revision(&root.join(path)).is_some_and(|r| revisions.contains(&r)) { owned.insert(path.clone()); }
        }
    }
    identity::reconcile_known_snapshots(root, &mut sides, &owned)?;
    for side in &mut sides {
        identity::prune_sources(side);
    }
    identity::commit_recovery(
        storage,
        &sides,
        jobs.iter()
            .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect(),
    )?;
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let storage = temp.path().join("comments");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&storage).unwrap();
        fs::write(root.join("old.tex"), "source").unwrap();
        for agent in [false, true] {
            crate::comments::test_write(storage.join(if agent { "agent.json" } else { "human.json" }), json!({
                "version":1, "counter":1, "files":{"old.tex":[{"id":if agent {"A-1"} else {"H-1"},"from":0,"to":6,"line":1,"text":"Keep","anchorRevision":format!("{:x}",Sha1::digest(b"source")),"resolved":false,"origin":if agent { json!({"provider":"codex","sessionId":"test"}) } else { Value::Null }}]}, "sources":{format!("{:x}",Sha1::digest(b"source")):"source"}
            }).to_string()).unwrap();
        }
        identity::refresh_revisions(&root, &storage, &["old.tex".into()]).unwrap();
        (temp, root, storage)
    }
    fn rename_job(root: &Path, storage: &Path, id: &str, old: &str, new: &str) {
        let before = capture(root, &[old.into(), new.into()]).unwrap();
        fs::rename(root.join(old), root.join(new)).unwrap();
        defer(
            root,
            storage,
            &root.join("finished-settlement"),
            id,
            &[old.into(), new.into()],
            &[CommentPathChange {
                old_path: old.into(),
                new_path: new.into(),
                folder: false,
            }],
            &before,
        )
        .unwrap();
    }
    #[test]
    fn storage_failure_preserves_jobs_and_both_authors_then_retries() {
        let (_temp, root, storage) = fixture();
        rename_job(&root, &storage, "one", "old.tex", "new.tex");
        let human = crate::comments::test_read(storage.join("human.json")).unwrap();
        crate::comments::test_write(storage.join("human.json"), "broken").unwrap();
        assert!(recover(&root, &storage).is_err());
        assert!(directory(&storage).join("one.json").exists());
        crate::comments::test_write(storage.join("human.json"), human).unwrap();
        assert_eq!(paths::reconcile(&root, &storage).unwrap().len(), 1);
        assert!(recover(&root, &storage).unwrap().is_empty());
        for side in identity::read_both(&root, &storage).unwrap() {
            assert_eq!(side.files["new.tex"][0].text, "Keep");
            assert!(side.orphaned.is_empty());
        }
    }
    #[test]
    fn accepted_file_does_not_remap_an_unrelated_unsaved_anchor() {
        let (_temp, root, storage) = fixture();
        fs::write(root.join("other.tex"), "source").unwrap();
        let mut sides = identity::read_both(&root, &storage).unwrap();
        for side in &mut sides {
            let mut comment = side.files["old.tex"][0].clone();
            comment.id.push_str("-other");
            comment.number = Some(2);
            side.counter = 2;
            comment.from = 7; comment.to = 13;
            let revision = format!("{:x}", Sha1::digest(b"unsavedsource"));
            comment.anchor_revision = Some(revision.clone());
            side.sources.insert(revision, "unsavedsource".into());
            side.files.insert("other.tex".into(), vec![comment]);
            identity::remember(&root, side, "other.tex");
        }
        identity::commit_recovery(&storage, &sides, Vec::new()).unwrap();
        rename_job(&root, &storage, "one", "old.tex", "new.tex");
        recover(&root, &storage).unwrap();
        for side in identity::read_both(&root, &storage).unwrap() {
            let comment = &side.files["other.tex"][0];
            assert_eq!((comment.from, comment.to), (7,13));
            assert_eq!(side.sources[comment.anchor_revision.as_ref().unwrap()], "unsavedsource");
        }
    }

    #[test]
    fn missing_target_disconnects_but_replacement_keeps_a_lost_anchor() {
        for replace in [false, true] {
            let (_temp, root, storage) = fixture();
            rename_job(&root, &storage, "one", "old.tex", "new.tex");
            fs::remove_file(root.join("new.tex")).unwrap();
            if replace {
                fs::write(root.join("new.tex"), "unrelated").unwrap();
            }
            paths::reconcile(&root, &storage).unwrap();
            for side in identity::read_both(&root, &storage).unwrap() {
                if replace {
                    assert!(side.orphaned.is_empty());
                    assert!(side.files["new.tex"][0].position_reset);
                    assert_eq!(side.files["new.tex"][0].text, "Keep");
                } else {
                    assert!(side.files.is_empty());
                    assert_eq!(side.orphaned["new.tex"][0].text, "Keep");
                }
            }
            if replace {
                assert_eq!(
                    fs::read_to_string(root.join("new.tex")).unwrap(),
                    "unrelated"
                );
            }
        }
    }
    #[test]
    fn multiple_pending_renames_compose_before_identity_reconciliation() {
        let (_temp, root, storage) = fixture();
        rename_job(&root, &storage, "one", "old.tex", "middle.tex");
        rename_job(&root, &storage, "two", "middle.tex", "last.tex");
        paths::reconcile(&root, &storage).unwrap();
        for side in identity::read_both(&root, &storage).unwrap() {
            assert_eq!(side.files["last.tex"][0].text, "Keep");
            assert!(side.orphaned.is_empty());
        }
    }
    #[test]
    fn external_replacement_between_queued_edits_keeps_comments_lost_at_the_final_path() {
        let (_temp, root, storage) = fixture();
        rename_job(&root, &storage, "one", "old.tex", "middle.tex");
        fs::remove_file(root.join("middle.tex")).unwrap();
        fs::write(root.join("middle.tex"), "unrelated file").unwrap();
        rename_job(&root, &storage, "two", "middle.tex", "last.tex");
        paths::reconcile(&root, &storage).unwrap();
        for side in identity::read_both(&root, &storage).unwrap() {
            assert!(side.orphaned.is_empty());
            assert!(side.files["last.tex"][0].position_reset);
            assert_eq!(side.files["last.tex"][0].text, "Keep");
        }
        assert_eq!(
            fs::read_to_string(root.join("last.tex")).unwrap(),
            "unrelated file"
        );
    }

    #[test]
    fn committed_acceptance_consumes_jobs_before_new_reconciliation() {
        let (_temp, root, storage) = fixture();
        rename_job(&root, &storage, "one", "old.tex", "new.tex");
        let mut sides = identity::read_both(&root, &storage).unwrap();
        for side in &mut sides {
            let comments = side.files.remove("old.tex").unwrap();
            side.files.insert("new.tex".into(), comments);
            side.revisions.clear();
            identity::remember(&root, side, "new.tex");
        }
        // Simulate an interruption after the database commit but before cleanup.
        store::write(&storage, &[(false, &sides[0]), (true, &sides[1])], &["one.json".into()]).unwrap();
        // A legacy JSON journal must never overwrite the committed database.
        fs::write(storage.join("identity-transaction.json"), "obsolete journal").unwrap();
        paths::reconcile(&root, &storage).unwrap();
        assert!(!directory(&storage).join("one.json").exists());
        assert_eq!(fs::read_to_string(storage.join("identity-transaction.json")).unwrap(), "obsolete journal");
        for side in identity::read_both(&root, &storage).unwrap() {
            assert!(side.files.contains_key("new.tex"));
            assert!(side.orphaned.is_empty());
        }
    }
}
