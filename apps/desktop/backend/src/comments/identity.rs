//! Project-relative comment tracking with content-based recovery.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub(crate) struct FileRevision(String);

fn revision(source: &str) -> FileRevision {
    FileRevision(format!("{:x}", Sha1::digest(source.as_bytes())))
}

// Also used for prepared app saves and acceptance journals. No platform IDs.
pub(crate) fn file_revision(path: &Path) -> Option<FileRevision> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return None;
    }
    Some(revision(&catalex_document_core::normalize_document_text(&fs::read_to_string(path).ok()?)))
}

fn project_source(root: &Path, path: &str) -> Result<Option<String>, String> {
    let candidate = root.join(relative_path(path)?);
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || !exact_spelling(root, path) {
        return Ok(None);
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical = fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Ok(None);
    }
    // Transient I/O failures preserve records and are retried, not disconnections.
    read_document(&canonical_root, &relative_path(path)?).map(Some)
}

// Sparse line indices keep UTF-16 conversion cheap without allocating an entry
// for every character. Each saved source version is indexed once per operation.
pub(super) struct SourceIndex<'a> {
    text: &'a str,
    lines: Vec<(usize, usize)>,
    checkpoints: Vec<(usize, usize)>,
    paragraphs: Vec<std::ops::Range<usize>>,
}
impl<'a> SourceIndex<'a> {
    pub(super) fn new(text: &'a str) -> Self {
        let mut lines = vec![(0, 0)];
        let mut checkpoints = vec![(0, 0)];
        let mut units = 0;
        for (offset, ch) in text.char_indices() {
            if units - checkpoints.last().unwrap().1 >= 256 { checkpoints.push((offset, units)); }
            units += ch.len_utf16();
            if ch == '\n' {
                lines.push((offset + 1, units));
            }
        }
        Self {
            text,
            lines,
            checkpoints,
            paragraphs: paragraphs(text),
        }
    }
    pub(super) fn byte_offset(&self, units: usize) -> Option<usize> {
        let checkpoint = self.checkpoints.partition_point(|(_, count)| *count <= units).saturating_sub(1);
        let (start, mut seen) = self.checkpoints[checkpoint];
        for (offset, ch) in self.text[start..].char_indices() {
            if seen == units {
                return Some(start + offset);
            }
            seen += ch.len_utf16();
            if seen > units {
                return None;
            }
        }
        (seen == units).then_some(self.text.len())
    }
    pub(super) fn position(&self, offset: usize) -> (usize, usize) {
        let line = self
            .lines
            .partition_point(|(start, _)| *start <= offset)
            .saturating_sub(1);
        let checkpoint = self.checkpoints.partition_point(|(start, _)| *start <= offset).saturating_sub(1);
        let (start, units) = self.checkpoints[checkpoint];
        (
            units + self.text[start..offset].encode_utf16().count(),
            line + 1,
        )
    }
}

struct AnchorRecovery<'a> {
    source: SourceIndex<'a>,
    revision: &'a str,
    references: &'a BTreeMap<String, String>,
    indices: BTreeMap<&'a str, SourceIndex<'a>>,
    matches: BTreeMap<&'a str, Option<usize>>,
}
impl<'a> AnchorRecovery<'a> {
    fn new(references: &'a BTreeMap<String, String>, source: &'a str, revision: &'a str) -> Self {
        Self {
            source: SourceIndex::new(source),
            revision,
            references,
            indices: BTreeMap::new(),
            matches: BTreeMap::new(),
        }
    }
    fn recover(&mut self, comment: &Comment) -> Option<Comment> {
        let (key, previous) = self
            .references
            .get_key_value(comment.anchor_revision.as_ref()?)?;
        let index = self
            .indices
            .entry(key.as_str())
            .or_insert_with(|| SourceIndex::new(previous));
        let from = index.byte_offset(comment.from)?;
        let to = index.byte_offset(comment.to)?;
        if from > to {
            return None;
        }
        let mut recovered = comment.clone();
        if previous != self.source.text {
            let passage = &previous[from..to];
            if passage.trim().is_empty() || comment.position_reset {
                return None;
            }
            let found = *self
                .matches
                .entry(passage)
                .or_insert_with(|| passage_offset(self.source.text, passage, None).ok());
            let offset = found.or_else(|| {
                let context = paragraph_context_in(&index.paragraphs, from, to).ok()?;
                let text = &previous[context.clone()];
                let start = *self
                    .matches
                    .entry(text)
                    .or_insert_with(|| passage_offset(self.source.text, text, None).ok());
                Some(start? + from - context.start)
            })?;
            recovered.from = self.source.position(offset).0;
            recovered.to = self.source.position(offset + passage.len()).0;
            recovered.line = self
                .source
                .lines
                .partition_point(|(start, _)| *start < offset + passage.len());
            recovered.position_reset = false;
            recovered.removed_anchor = None;
        }
        recovered.anchor_revision = Some(self.revision.to_owned());
        Some(recovered)
    }
    // File identity is settled by the caller. Failed anchor recovery never
    // disconnects that file: retain the record at a safe Lost marker instead.
    fn recover_edit(&mut self, comment: &Comment, mappings: &mut BTreeMap<String, super::text_changes::TextChanges>, known_edit: bool) -> Comment {
        if let Some(mapped) = self.map_edit(comment, mappings, !known_edit) {
            return mapped;
        }
        if !known_edit {
            if let Some(recovered) = self.recover(comment) { return recovered; }
        }
        let mut lost = self.map_edit(comment, mappings, false).unwrap_or_else(|| comment.clone());
        let length = self.source.position(self.source.text.len()).0;
        lost.from = lost.from.min(length);
        // Invalid input can point into the middle of a UTF-16 surrogate pair.
        if self.source.byte_offset(lost.from).is_none() { lost.from = lost.from.saturating_sub(1); }
        lost.to = lost.from;
        lost.line = self.source.position(self.source.byte_offset(lost.from).unwrap_or(0)).1;
        lost.position_reset = true;
        lost.removed_anchor = None;
        lost.anchor_revision = Some(self.revision.to_owned());
        lost
    }
    fn map_edit(&mut self, comment: &Comment, mappings: &mut BTreeMap<String, super::text_changes::TextChanges>, contextual: bool) -> Option<Comment> {
        let (key, previous) = self.references.get_key_value(comment.anchor_revision.as_ref()?)?;
        let index = self.indices.entry(key.as_str()).or_insert_with(|| SourceIndex::new(previous));
        let from = index.byte_offset(comment.from)?;
        let to = index.byte_offset(comment.to)?;
        if from > to { return None; }
        // An existing but ambiguous quotation must not be assigned by diff order.
        if contextual && from < to && self.source.text.contains(&previous[from..to]) { return None; }
        let mapping = mappings.entry(key.clone()).or_insert_with(|| super::text_changes::TextChanges::new(previous, self.source.text));
        let mapped = mapping.map_anchor(comment)?;
        let range = self.source.byte_offset(mapped.from)?..self.source.byte_offset(mapped.to)?;
        if contextual && !mapping.matches_context(previous, self.source.text, from..to, range.clone()) {
            return None;
        }
        let mut recovered = comment.clone();
        recovered.from = mapped.from;
        recovered.to = mapped.to;
        recovered.line = self.source.position(if range.is_empty() { range.start } else { self.source.text[..range.end].char_indices().next_back()?.0 }).1;
        recovered.anchor_revision = Some(self.revision.to_owned());
        recovered.position_reset = mapped.position_reset;
        recovered.removed_anchor = mapped.removed_anchor.and_then(|value| serde_json::to_value(value).ok());
        Some(recovered)
    }

}

#[cfg(test)]
fn recover_anchor(
    comment: &Comment,
    sources: &BTreeMap<String, String>,
    source: &str,
) -> Option<Comment> {
    AnchorRecovery::new(sources, source, &revision(source).0).recover(comment)
}

// Detect case-only renames even on case-insensitive filesystems.
fn exact_spelling(root: &Path, path: &str) -> bool {
    let mut parent = root.to_path_buf();
    for component in Path::new(path).components() {
        let Ok(entries) = fs::read_dir(&parent) else {
            return false;
        };
        if !entries
            .filter_map(Result::ok)
            .any(|entry| entry.file_name() == component.as_os_str())
        {
            return false;
        }
        parent.push(component.as_os_str());
    }
    true
}
pub(super) fn remember(root: &Path, snapshot: &mut AuthorSnapshot, path: &str) {
    if snapshot.files.contains_key(path) {
        let source = project_source(root, path).ok().flatten();
        snapshot.revisions.insert(
            path.to_owned(),
            source.as_deref().map(revision).into_iter().collect(),
        );
        if let Some(source) = source {
            snapshot
                .sources
                .insert(snapshot.revisions[path][0].0.clone(), source);
        }
    } else {
        snapshot.revisions.remove(path);
    }
}

pub(super) fn cleanup_jobs(storage: &Path) -> Result<(), String> {
    for job in store::pending_cleanup(storage)? {
        if Path::new(&job).file_name().and_then(|name| name.to_str()) != Some(job.as_str()) {
            return Err("Invalid comment recovery job".into());
        }
        match fs::remove_file(super::recovery::directory(storage).join(&job)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        store::finish_cleanup(storage, &job)?;
    }
    Ok(())
}

fn commit(storage: &Path, sides: &[AuthorSnapshot; 2]) -> Result<(), String> {
    commit_recovery(storage, sides, Vec::new())
}
pub(super) fn commit_recovery(
    storage: &Path,
    sides: &[AuthorSnapshot; 2],
    jobs: Vec<String>,
) -> Result<(), String> {
    store::write(storage, &[(false, &sides[0]), (true, &sides[1])], &jobs)?;
    cleanup_jobs(storage)
}

pub(super) fn read_both(root: &Path, storage: &Path) -> Result<[AuthorSnapshot; 2], String> {
    cleanup_jobs(storage)?;
    let [human, agent] = store::transaction(storage, |db| store::read_both_on(db, None))?;
    Ok([
        validate_author_snapshot(root, storage, false, human)?,
        validate_author_snapshot(root, storage, true, agent)?,
    ])
}
fn supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "tex" | "md" | "markdown" | "txt" | "bib" | "sty" | "cls" | "ltx" | "rnw" | "rmd"
    )
}

// Only user-requested auto-relink scans the project. Size-filter before reading.
fn scan(
    root: &Path,
    dir: &Path,
    sizes: &[(u64, u64)],
    found: &mut BTreeMap<FileRevision, Vec<String>>,
    count: &mut usize,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
        if crate::project_files::ignored(relative) {
            continue;
        }
        *count += 1;
        if *count > 100_000 {
            return Err("Project scan limit reached; comments were preserved. Narrow the project folder before retrying.".into());
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            scan(root, &path, sizes, found, count)?;
        } else if kind.is_file() && supported(&path) {
            let length = entry.metadata().map_err(|e| e.to_string())?.len();
            let index = sizes.partition_point(|(start, _)| *start <= length);
            if index == 0 || length > sizes[index - 1].1 { continue; }
            let name = relative.to_string_lossy().replace('\\', "/");
            // The directory entry already supplies the exact spelling. Avoid
            // enumerating its parent again for every candidate in a large folder.
            let source = read_document(root, relative)?;
            found.entry(revision(&source)).or_default().push(name);
        }
    }
    Ok(())
}
pub(super) fn reconcile(root: &Path, storage: &Path) -> Result<Vec<CommentPathChange>, String> {
    Ok(read_reconciled(root, storage)?.1)
}
pub(super) fn read_reconciled(root: &Path, storage: &Path) -> Result<([AuthorSnapshot; 2], Vec<CommentPathChange>), String> {
    let mut sides = read_both(root, storage)?;
    let (changed, changes) = reconcile_snapshots(root, &mut sides)?;
    if changed {
        commit(storage, &sides)?;
    }
    Ok((sides, changes))
}

// Resolve queued IDs after replaying app renames, then inspect only those files.
// Return the loaded snapshots so the writer does not parse them again.
pub(super) fn load_for_write(
    root: &Path,
    storage: &Path,
    requested: impl IntoIterator<Item = (String, Option<String>)>,
) -> Result<[AuthorSnapshot; 2], String> {
    paths::recover_pending(root, storage)?;
    store::transaction(storage, |db| load_for_write_on(root, storage, db, requested))
}

pub(super) fn load_for_write_on(
    root: &Path, storage: &Path, db: &store::Connection,
    requested: impl IntoIterator<Item = (String, Option<String>)>,
) -> Result<[AuthorSnapshot; 2], String> {
    let requested: Vec<_> = requested.into_iter().collect();
    let scope = store::scope_for_connection(db, &requested)?;
    let [human, agent] = store::read_both_on(db, Some(&scope))?;
    let mut sides = [
        validate_author_snapshot(root, storage, false, human)?,
        validate_author_snapshot(root, storage, true, agent)?,
    ];
    let locations: BTreeMap<_, _> = sides
        .iter()
        .flat_map(|side| {
            side.files.iter().flat_map(|(path, comments)| {
                comments.iter().map(move |c| (c.id.as_str(), path.as_str()))
            })
        })
        .collect();
    let selected = requested
        .into_iter()
        .map(|(path, id)| {
            id.as_deref()
                .and_then(|id| locations.get(id))
                .map(|p| p.to_string())
                .unwrap_or(path)
        })
        .collect();
    let (changed, _) = reconcile_selected(root, &mut sides, selected, &BTreeSet::new())?;
    if changed {
        store::write_on(db, &[(false, &sides[0]), (true, &sides[1])], &[])?;
    }
    Ok(sides)
}

pub(super) fn prune_sources(side: &mut AuthorSnapshot) {
    side.revisions
        .retain(|path, _| side.files.contains_key(path));
    side.orphaned_revisions
        .retain(|path, _| side.orphaned.contains_key(path));
    let mut used: BTreeSet<_> = side
        .files
        .values()
        .chain(side.orphaned.values())
        .flatten()
        .filter_map(|c| c.anchor_revision.clone())
        .collect();
    used.extend(
        side.revisions
            .values()
            .chain(side.orphaned_revisions.values())
            .flatten()
            .map(|r| r.0.clone()),
    );
    side.sources.retain(|revision, _| used.contains(revision));
}

// Shared by live reconciliation and history's in-memory backup of readable sides.
pub(super) fn reconcile_snapshots(
    root: &Path,
    sides: &mut [AuthorSnapshot],
) -> Result<(bool, Vec<CommentPathChange>), String> {
    let known: BTreeSet<String> = sides.iter().flat_map(|s| s.files.keys().cloned()).collect();
    reconcile_selected(root, sides, known, &BTreeSet::new())
}

pub(super) fn reconcile_known_snapshots(root: &Path, sides: &mut [AuthorSnapshot], owned: &BTreeSet<String>) -> Result<(), String> {
    let known = sides.iter().flat_map(|s| s.files.keys().cloned()).collect();
    reconcile_selected(root, sides, known, owned)?;
    Ok(())
}

fn reconcile_selected(
    root: &Path,
    sides: &mut [AuthorSnapshot],
    known: BTreeSet<String>,
    owned: &BTreeSet<String>,
) -> Result<(bool, Vec<CommentPathChange>), String> {
    let mut occupied: BTreeSet<String> = sides
        .iter()
        .flat_map(|s| s.orphaned.keys().cloned())
        .collect();
    let mut changed = false;
    for path in known {
        if !sides.iter().any(|side| side.files.contains_key(&path)) {
            continue;
        }
        let source = project_source(root, &path)?;
        let current = source.as_deref().map(revision);
        let mut key = path.clone();
        let mut number = 2;
        while occupied.contains(&key) {
            key = format!("{path} [disconnected {number}]");
            number += 1;
        }
        let mut archived = false;
        let mut mappings = BTreeMap::new();
        for side in sides.iter_mut() {
            let Some(comments) = side.files.remove(&path) else {
                continue;
            };
            let trusted = source.is_some()
                && side
                    .revisions
                    .get(&path)
                    .is_none_or(|known| current.as_ref().is_some_and(|r| known.contains(r)));
            let mut connected = Vec::new();
            let mut disconnected = Vec::new();
            let mut recovery = source
                .as_deref()
                .zip(current.as_ref())
                .filter(|_| !trusted || owned.contains(&path))
                .map(|(s, rev)| AnchorRecovery::new(&side.sources, s, &rev.0));
            for comment in comments {
                if trusted && !owned.contains(&path) {
                    connected.push(comment);
                } else if let Some(recovery) = recovery.as_mut() {
                    let recovered = recovery.recover_edit(&comment, &mut mappings, owned.contains(&path));
                    changed |= recovered != comment;
                    connected.push(recovered);
                } else {
                    disconnected.push(comment);
                }
            }
            if !disconnected.is_empty() {
                if let Some(revisions) = side.revisions.get(&path) {
                    side.orphaned_revisions
                        .insert(key.clone(), revisions.clone());
                }
                side.orphaned.insert(key.clone(), disconnected);
                archived = true;
                changed = true;
            }
            if !connected.is_empty() {
                side.files.insert(path.clone(), connected);
                let revisions: Vec<_> = current.clone().into_iter().collect();
                changed |= side.revisions.get(&path) != Some(&revisions);
                side.revisions.insert(path.clone(), revisions);
                if let Some(source) = &source {
                    let rev = current.as_ref().unwrap().0.clone();
                    // The last disk version is also the fingerprint used to
                    // find this file after an external rename. Anchor versions
                    // can lag it while an editor save is still in flight.
                    side.sources.insert(rev, source.clone());
                }
            } else {
                side.revisions.remove(&path);
            }
        }
        if archived {
            occupied.insert(key);
        }
    }
    if changed {
        for side in sides {
            prune_sources(side);
        }
    }
    Ok((changed, Vec::new()))
}

// Called before the app publishes its replacement. Both old and prepared-new
// content revisions are valid until reconciliation, so interruption is safe.
pub(crate) fn prepare_save_revisions(
    root: &Path,
    storage: &Path,
    path: &str,
    temporary: &Path,
) -> Result<(), String> {
    let mut sides = load_for_write(root, storage, [(path.into(), None)])?;
    if !sides.iter().any(|side| side.files.contains_key(path)) {
        return Ok(());
    }
    let prepared = fs::read_to_string(temporary).ok().map(|source| {
        let source = catalex_document_core::normalize_document_text(&source);
        let rev = revision(&source);
        (source, rev)
    });
    let mut changed = false;
    for side in &mut sides {
        if side.files.contains_key(path) {
            remember(root, side, path);
            if let Some((source, rev)) = &prepared {
                side.revisions
                    .entry(path.into())
                    .or_default()
                    .push(rev.clone());
                side.sources.insert(rev.0.clone(), source.clone());
            }
            prune_sources(side);
            changed = true;
        }
    }
    if changed {
        commit(storage, &sides)?;
    }
    Ok(())
}

// App-owned history/agent operations have explicit provenance; external Git
// operations do not. Refresh only the paths actually written by the app.
pub(crate) fn refresh_revisions(
    root: &Path,
    storage: &Path,
    paths: &[String],
) -> Result<(), String> {
    let mut sides = read_both(root, storage)?;
    reconcile_known_snapshots(root, &mut sides, &paths.iter().cloned().collect())?;
    for side in &mut sides {
        for path in paths {
            remember(root, side, path);
        }
        prune_sources(side);
    }
    commit(storage, &sides)
}

// An app-initiated Git operation owns continuity at the same paths. Hold the
// comment gate across the command and refresh even after a conflict/partial error.
pub(crate) struct KnownEdit {
    root: PathBuf,
    storage: PathBuf,
    before: BTreeMap<String, Option<FileRevision>>,
}
pub(crate) fn begin_known_edit(
    service: &crate::host::ServiceContext,
    project_root: &str,
) -> Result<KnownEdit, String> {
    let root = fs::canonicalize(project_root).map_err(|e| e.to_string())?;
    let storage = comment_directory(service, project_root)?;
    paths::reconcile(&root, &storage)?;
    let sides = read_both(&root, &storage)?;
    let before = sides.iter().flat_map(|s| s.revisions.iter().map(|(path, revisions)| (path.clone(), revisions.first().cloned()))).collect();
    Ok(KnownEdit {
        root,
        storage,
        before,
    })
}
pub(crate) fn finish_known_edit(edit: KnownEdit) -> Result<(), String> {
    let changed: Vec<_> = edit.before.into_iter().filter_map(|(path, before)|
        (file_revision(&edit.root.join(&path)) != before).then_some(path)).collect();
    if changed.is_empty() { return Ok(()); }
    refresh_revisions(&edit.root, &edit.storage, &changed)
}

#[derive(Clone, Deserialize)]
pub struct FileCommentSelection {
    path: String,
    disconnected: bool,
    ids: Vec<String>,
}

/// Preview and execution share all guards. Execution rereads under the comment gate.
pub async fn manage_comment_files(
    window: &WindowContext,
    project_root: String,
    selection: Vec<FileCommentSelection>,
    author: String,
    action: String,
    target: String,
    preview: bool,
) -> Result<Value, String> {
    let _guard = window.service.comments.lock_project(&project_root).await?;
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let storage = comment_directory(&window.service, &project_root)?;
    paths::reconcile(&root, &storage)?;
    let work_root = root.clone();
    let work_storage = storage.clone();
    let work_action = action.clone();
    let (sides, result) = tokio::task::spawn_blocking(move || {
        prepare_file_groups(
            &work_root,
            &work_storage,
            &selection,
            &work_action,
            &target,
            &author,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    if !preview {
        checkpoint_comments(
            &window.service,
            &project_root,
            format!(
                "[comments] Before {} comments",
                if action != "clear" {
                    "reconnecting"
                } else {
                    "clearing"
                }
            ),
        )?;
        // Check target versions again after the history checkpoint. External
        // writers do not hold our service gate.
        for link in result["links"].as_array().into_iter().flatten() {
            let target = link["newPath"].as_str().ok_or("Invalid relink target")?;
            let current = project_source(&root, target)?.as_deref().map(revision);
            if sides
                .iter()
                .filter_map(|s| s.revisions.get(target))
                .any(|r| current.as_ref().is_none_or(|c| !r.contains(c)))
            {
                return Err("Target changed during relinking. Try again.".into());
            }
        }
        commit(&storage, &sides)?;
        let _ = window.service.emit(
            "catalex-comments-reconnected",
            json!({"projectRoot": project_root}),
        );
    }
    Ok(result)
}

fn relink_target(root: &Path, target: &str) -> Result<(String, String), String> {
    let candidate = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        root.join(relative_path(target)?)
    };
    if fs::symlink_metadata(&candidate)
        .map_err(|_| "The selected file no longer exists.")?
        .file_type()
        .is_symlink()
    {
        return Err("Choose a regular file, not a symbolic link.".into());
    }
    let canonical =
        fs::canonicalize(&candidate).map_err(|_| "The selected file no longer exists.")?;
    let relative = canonical
        .strip_prefix(root)
        .map_err(|_| "Choose a file inside this project.")?;
    if !canonical.is_file() || !supported(&canonical) {
        return Err("Choose a supported text document.".into());
    }
    let path = relative.to_string_lossy().replace('\\', "/");
    let source =
        project_source(root, &path)?.ok_or("Choose a regular file inside this project.")?;
    Ok((path, source))
}

fn can_relink(sides: &[AuthorSnapshot; 2], group: &FileCommentSelection, target: &str) -> bool {
    let occupied = sides
        .iter()
        .any(|s| s.files.get(target).is_some_and(|c| !c.is_empty()));
    let sibling = group.disconnected
        && (group.path == target || group.path.starts_with(&format!("{target} [disconnected ")));
    if occupied && !sibling {
        return false;
    }
    // Never duplicate a record, even across authors or malformed file groups.
    !sides
        .iter()
        .flat_map(|s| &s.files)
        .filter(|(p, _)| group.disconnected || *p != &group.path)
        .flat_map(|(_, c)| c)
        .any(|c| group.ids.contains(&c.id))
}

// Once manual selection or an unambiguous fingerprint identifies a file,
// reconnect every selected record through the same per-anchor recovery path.
fn relink_group(
    sides: &mut [AuthorSnapshot; 2],
    group: &FileCommentSelection,
    target: &str,
    source: &str,
) -> (Vec<String>, usize) {
    let mut ids = Vec::new();
    let mut unplaced = 0;
    let rev = revision(source);
    for side in sides {
        let comments = if group.disconnected {
            side.orphaned.remove(&group.path)
        } else {
            side.files.remove(&group.path)
        };
        let Some(comments) = comments else {
            continue;
        };
        let mut recovery = AnchorRecovery::new(&side.sources, source, &rev.0);
        let mut mappings = BTreeMap::new();
        for comment in comments {
            let recovered = recovery.recover_edit(&comment, &mut mappings, false);
            if recovered.position_reset {
                unplaced += 1;
            }
            ids.push(recovered.id.clone());
            side.files.entry(target.into()).or_default().push(recovered);
        }
        if !group.disconnected {
            side.revisions.remove(&group.path);
        }
        if side.files.contains_key(target) {
            side.revisions.insert(target.into(), vec![rev.clone()]);
            side.sources.insert(rev.0.clone(), source.into());
        }
    }
    (ids, unplaced)
}

fn prepare_file_groups(
    root: &Path,
    storage: &Path,
    selection: &[FileCommentSelection],
    action: &str,
    target: &str,
    author: &str,
) -> Result<([AuthorSnapshot; 2], Value), String> {
    if selection.is_empty() {
        return Err("Select at least one file.".into());
    }
    if !matches!(action, "clear" | "relink" | "auto-relink") {
        return Err("Unknown comment action.".into());
    }
    if action == "relink" && selection.len() != 1 {
        return Err("Select exactly one file to relink.".into());
    }
    if action == "auto-relink" && selection.iter().any(|g| !g.disconnected) {
        return Err("Select disconnected comments to auto-relink.".into());
    }
    if !matches!(author, "all" | "human" | "agent") {
        return Err("Unknown comment author filter.".into());
    }
    let mut seen = BTreeSet::new();
    let mut sides = read_both(root, storage)?;
    for group in selection {
        if !seen.insert((group.disconnected, group.path.clone())) {
            return Err("Duplicate file selection.".into());
        }
        let ids: BTreeSet<_> = sides
            .iter()
            .filter_map(|s| {
                if group.disconnected {
                    s.orphaned.get(&group.path)
                } else {
                    s.files.get(&group.path)
                }
            })
            .flatten()
            .map(|c| c.id.clone())
            .collect();
        if ids.is_empty() || ids != group.ids.iter().cloned().collect() {
            return Err("Comments changed. Refresh your selection and try again.".into());
        }
    }
    let mut cleared = 0;
    let mut unplaced = 0;
    let mut links = Vec::new();
    let mut new_path = String::new();
    if action == "clear" {
        for (index, side) in sides.iter_mut().enumerate() {
            if (author == "human" && index == 1) || (author == "agent" && index == 0) {
                continue;
            }
            for group in selection {
                let removed = if group.disconnected {
                    side.orphaned.remove(&group.path)
                } else {
                    side.files.remove(&group.path)
                };
                cleared += removed.map_or(0, |c| c.len());
                if !group.disconnected {
                    side.revisions.remove(&group.path);
                }
            }
        }
    } else if action == "relink" {
        let group = &selection[0];
        let (target, source) = relink_target(root, target)?;
        if !group.disconnected && group.path == target {
            return Err("Choose a different file.".into());
        }
        if !can_relink(&sides, group, &target) {
            return Err("This file already has comments. Choose a file without comments.".into());
        }
        let (ids, count) = relink_group(&mut sides, group, &target, &source);
        new_path = target.clone();
        unplaced = count;
        links.push(json!({"oldPath":group.path,"newPath":target,"ids":ids}));
    } else {
        let mut sizes = BTreeMap::new();
        let mut remember_size = |revision: &str, source: &str| {
            sizes.entry(revision.to_owned()).or_insert_with(|| {
                let length = source.len() as u64;
                // Snapshots use LF; raw files may use CRLF or mixed endings.
                (length, length + source.bytes().filter(|b| *b == b'\n').count() as u64)
            });
        };
        let mut wanted = Vec::new();
        let mut reference_hashes = BTreeMap::new();
        for group in selection {
            let mut revisions = BTreeSet::new();
            for side in &sides {
                for r in side
                    .orphaned_revisions
                    .get(&group.path)
                    .into_iter()
                    .flatten()
                {
                    if let Some(source) = side.sources.get(&r.0) {
                        remember_size(&r.0, source);
                        revisions.insert(r.clone());
                    }
                }
                for c in side.orphaned.get(&group.path).into_iter().flatten() {
                    if let Some(source) =
                        c.anchor_revision.as_ref().and_then(|r| side.sources.get(r))
                    {
                        remember_size(c.anchor_revision.as_ref().unwrap(), source);
                        revisions.insert(
                            reference_hashes
                                .entry(c.anchor_revision.as_ref().unwrap())
                                .or_insert_with(|| revision(source))
                                .clone(),
                        );
                    }
                }
            }
            wanted.push(revisions);
        }
        let mut found = BTreeMap::new();
        if !sizes.is_empty() {
            // Merge size intervals once; each directory entry needs one lookup.
            let mut sizes: Vec<_> = sizes.into_values().collect();
            sizes.sort_unstable();
            let mut merged: Vec<(u64, u64)> = Vec::new();
            for (start, end) in sizes {
                if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
                    last.1 = last.1.max(end);
                } else { merged.push((start, end)); }
            }
            scan(root, root, &merged, &mut found, &mut 0)?;
        }
        let targets: Vec<_> = wanted
            .iter()
            .map(|revisions| {
                let matches: BTreeSet<_> = revisions
                    .iter()
                    .filter_map(|r| found.get(r))
                    .flatten()
                    .cloned()
                    .collect();
                if matches.len() == 1 {
                    matches.into_iter().next()
                } else {
                    None
                }
            })
            .collect();
        for (group, target) in selection.iter().zip(&targets) {
            let Some(target) = target else {
                continue;
            };
            // Conflicting selected groups remain untouched rather than depending
            // on selection order. Partial siblings can still reconnect later.
            if targets
                .iter()
                .filter(|t| t.as_ref() == Some(target))
                .count()
                != 1
                || !can_relink(&sides, group, target)
            {
                continue;
            }
            let (_, source) = relink_target(root, target)?;
            // Verify bytes, not only the hash, and reread after the scan.
            if !sides.iter().any(|s| {
                s.orphaned.get(&group.path).into_iter().flatten().any(|c| {
                    c.anchor_revision.as_ref().and_then(|r| s.sources.get(r)) == Some(&source)
                }) || s
                    .orphaned_revisions
                    .get(&group.path)
                    .into_iter()
                    .flatten()
                    .any(|r| s.sources.get(&r.0) == Some(&source))
            }) {
                continue;
            }
            let (ids, count) = relink_group(&mut sides, group, target, &source);
            unplaced += count;
            if !ids.is_empty() {
                links.push(json!({"oldPath":group.path,"newPath":target,"ids":ids}));
            }
        }
    }
    for side in &mut sides {
        prune_sources(side);
    }
    let linked: usize = links
        .iter()
        .filter_map(|v| v["ids"].as_array())
        .map(Vec::len)
        .sum();
    let remaining: usize = if action == "auto-relink" {
        selection.iter().map(|g| g.ids.len()).sum::<usize>() - linked
    } else {
        0
    };
    Ok((
        sides,
        json!({"newPath":new_path,"unplaced":unplaced,"cleared":cleared,"links":links,"linked":linked,"remaining":remaining}),
    ))
}

#[cfg(test)]
fn prepare_file_action(
    root: &Path,
    storage: &Path,
    disconnected: bool,
    selection: &BTreeMap<String, Vec<String>>,
    action: &str,
    target: &str,
) -> Result<([AuthorSnapshot; 2], Value), String> {
    let groups: Vec<_> = selection
        .iter()
        .map(|(path, ids)| FileCommentSelection {
            path: path.clone(),
            disconnected,
            ids: ids.clone(),
        })
        .collect();
    prepare_file_groups(root, storage, &groups, action, target, "all")
}

#[cfg(test)]
mod tests {
    use super::*;
fn reconnect(
    root: &Path,
    storage: &Path,
    old: &str,
    new: &str,
    expected_ids: &[String],
) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let groups = [FileCommentSelection {
        path: old.into(),
        disconnected: true,
        ids: expected_ids.to_vec(),
    }];
    let (sides, _) = prepare_file_groups(&root, storage, &groups, "relink", new, "all")?;
    commit(storage, &sides)
}

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        fs::write(root.path().join("old.tex"), "hello world").unwrap();
        for agent in [false, true] {
            let c = json!({"id": if agent {"A-1"} else {"H-1"}, "number":1,"from":0,"to":5,"line":1,"text":"feedback","anchorRevision":revision("hello world").0,"origin":if agent {json!({"provider":"codex","sessionId":"test"})} else {Value::Null}});
            crate::comments::test_write(
                storage
                    .path()
                    .join(if agent { "agent.json" } else { "human.json" }),
                serde_json::to_vec(
                    &json!({"version":1,"counter":1,"files":{"old.tex":[c]},"sources":{revision("hello world").0:"hello world"}}),
                )
                .unwrap(),
            )
            .unwrap();
        }
        reconcile(root.path(), storage.path()).unwrap();
        assert!(
            file_revision(&root.path().join("old.tex")).is_some(),
            "test file must expose a content revision"
        );
        (root, storage)
    }
    #[test]
    fn recovery_index_preserves_utf16_boundaries_and_lines() {
        let text = "a😀\r\n中文\n𝄞z\n";
        let index = SourceIndex::new(text);
        let mut units = 0;
        for (byte, ch) in text.char_indices() {
            assert_eq!(index.byte_offset(units), Some(byte));
            assert_eq!(
                index.position(byte),
                (
                    units,
                    text[..byte].bytes().filter(|b| *b == b'\n').count() + 1
                )
            );
            if ch.len_utf16() == 2 {
                assert_eq!(index.byte_offset(units + 1), None);
            }
            units += ch.len_utf16();
        }
        assert_eq!(index.byte_offset(units), Some(text.len()));
        assert_eq!(index.byte_offset(units + 1), None);
    }

    #[test]
    fn mixed_file_groups_clear_only_requested_author_and_preserve_same_path_groups() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        let mut sides = read_both(&root, storage.path()).unwrap();
        for (index, side) in sides.iter_mut().enumerate() {
            let mut comment = side.files["old.tex"][0].clone();
            comment.id = if index == 0 {
                "H-2".into()
            } else {
                "A-2".into()
            };
            comment.number = Some(2);
            side.counter = 2;
            side.orphaned.insert("old.tex".into(), vec![comment]);
        }
        commit(storage.path(), &sides).unwrap();
        let selection = vec![
            FileCommentSelection {
                path: "old.tex".into(),
                disconnected: false,
                ids: vec!["H-1".into(), "A-1".into()],
            },
            FileCommentSelection {
                path: "old.tex".into(),
                disconnected: true,
                ids: vec!["H-2".into(), "A-2".into()],
            },
        ];
        let (planned, result) =
            prepare_file_groups(&root, storage.path(), &selection, "clear", "", "human").unwrap();
        assert_eq!(result["cleared"], 2);
        assert!(planned[0].files.is_empty() && planned[0].orphaned.is_empty());
        assert_eq!(planned[1].files["old.tex"][0].id, "A-1");
        assert_eq!(planned[1].orphaned["old.tex"][0].id, "A-2");
        assert!(planned[1].revisions.contains_key("old.tex"));
        // Planning did not change either author on disk.
        assert_eq!(
            read_both(&root, storage.path()).unwrap()[0].files["old.tex"].len(),
            1
        );
        let (agent_only, result) =
            prepare_file_groups(&root, storage.path(), &selection, "clear", "", "agent").unwrap();
        assert_eq!(result["cleared"], 2);
        assert_eq!(agent_only[0].files["old.tex"][0].id, "H-1");
        assert!(agent_only[1].files.is_empty() && agent_only[1].orphaned.is_empty());
        assert!(prepare_file_groups(
            &root,
            storage.path(),
            &selection,
            "relink",
            "next.md",
            "all"
        )
        .is_err());
        let (all, _) =
            prepare_file_groups(&root, storage.path(), &selection, "clear", "", "all").unwrap();
        commit(storage.path(), &all).unwrap();
        assert!(read_both(&root, storage.path())
            .unwrap()
            .iter()
            .all(|s| s.files.is_empty() && s.orphaned.is_empty()));
    }
    #[test]
    fn file_action_preview_is_read_only_and_rechecks_conflicts() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        fs::write(root.join("target.md"), "new text").unwrap();
        let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
        let (planned, result) = prepare_file_action(
            &root,
            storage.path(),
            false,
            &selection,
            "relink",
            "target.md",
        )
        .unwrap();
        assert_eq!(result["unplaced"], 2);
        assert!(read_both(&root, storage.path()).unwrap()[0]
            .files
            .contains_key("old.tex"));
        assert!(!planned[0].files.contains_key("old.tex"));
        assert!(prepare_file_action(
            &root,
            storage.path(),
            false,
            &selection,
            "relink",
            "old.tex"
        )
        .is_err());
        fs::write(root.join("unsupported.pdf"), "text").unwrap();
        assert!(prepare_file_action(
            &root,
            storage.path(),
            false,
            &selection,
            "relink",
            "unsupported.pdf"
        )
        .is_err());
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(prepare_file_action(
            &root,
            storage.path(),
            false,
            &selection,
            "relink",
            outside.path().to_str().unwrap()
        )
        .is_err());
        let mut occupied = read_both(&root, storage.path()).unwrap();
        let mut extra = occupied[0].files["old.tex"][0].clone();
        extra.id = "H-2".into();
        extra.number = Some(2);
        occupied[0].counter = 2;
        occupied[0].files.insert("target.md".into(), vec![extra]);
        commit(storage.path(), &occupied).unwrap();
        assert!(prepare_file_action(
            &root,
            storage.path(),
            false,
            &selection,
            "relink",
            "target.md"
        )
        .err()
        .unwrap()
        .contains("already has comments"));
        // No source group was removed when the target became occupied after preview.
        assert!(read_both(&root, storage.path()).unwrap()[0]
            .files
            .contains_key("old.tex"));
    }
    #[test]
    fn file_actions_handle_disconnected_relink_and_atomic_multi_clear() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        fs::remove_file(root.join("old.tex")).unwrap();
        reconcile(&root, storage.path()).unwrap();
        fs::write(root.join("new.md"), "text").unwrap();
        let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
        let (planned, _) =
            prepare_file_action(&root, storage.path(), true, &selection, "relink", "new.md")
                .unwrap();
        commit(storage.path(), &planned).unwrap();
        assert!(planned
            .iter()
            .all(|s| s.orphaned.is_empty() && s.files["new.md"].len() == 1));
        let mut selection = BTreeMap::from([("new.md".into(), vec!["H-1".into(), "A-1".into()])]);
        selection.insert("missing.md".into(), vec!["missing".into()]);
        assert!(
            prepare_file_action(&root, storage.path(), false, &selection, "clear", "").is_err()
        );
        assert!(read_both(&root, storage.path()).unwrap()[0]
            .files
            .contains_key("new.md"));
        selection.remove("missing.md");
        let (cleared, _) =
            prepare_file_action(&root, storage.path(), false, &selection, "clear", "").unwrap();
        assert!(cleared
            .iter()
            .all(|s| s.files.is_empty() && s.revisions.is_empty()));
    }
    #[test]
    fn external_rename_waits_for_requested_relink_and_same_path_copy_is_continuity() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        fs::rename(root.join("old.tex"), root.join("new.tex")).unwrap();
        assert!(reconcile(&root, storage.path()).unwrap().is_empty());
        let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
        let (sides, result) =
            prepare_file_action(&root, storage.path(), true, &selection, "auto-relink", "")
                .unwrap();
        assert_eq!(result["linked"], 2);
        assert_eq!(result["remaining"], 0);
        // Preview is read-only; explicit publication reconnects both authors.
        assert!(read_both(&root, storage.path()).unwrap()[0]
            .files
            .is_empty());
        commit(storage.path(), &sides).unwrap();
        crate::project_files::replace_file(&root.join("new.tex"), b"hello world").unwrap();
        reconcile(&root, storage.path()).unwrap();
        for side in read_both(&root, storage.path()).unwrap() {
            assert_eq!(side.files["new.tex"].len(), 1);
            assert!(side.orphaned.is_empty());
        }
    }

    #[test]
    fn external_replacement_recovers_matching_text_and_keeps_failed_anchors_lost() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        let mut sides = read_both(&root, storage.path()).unwrap();
        let mut second = sides[0].files["old.tex"][0].clone();
        second.id = "H-2".into();
        second.number = Some(2);
        second.from = 6;
        second.to = 11;
        sides[0].counter = 2;
        sides[0].files.get_mut("old.tex").unwrap().push(second);
        commit(storage.path(), &sides).unwrap();
        crate::project_files::replace_file(&root.join("old.tex"), "😀 hello universe".as_bytes())
            .unwrap();
        reconcile(&root, storage.path()).unwrap();
        let sides = read_both(&root, storage.path()).unwrap();
        for side in &sides {
            let c = &side.files["old.tex"][0];
            assert_eq!((c.from, c.to), (3, 8));
            assert_eq!(
                side.sources[c.anchor_revision.as_ref().unwrap()],
                "😀 hello universe"
            );
        }
        let edited = &sides[0].files["old.tex"][1];
        assert_eq!(edited.id, "H-2");
        assert_eq!((edited.from, edited.to), (9,17));
        assert!(sides[0].orphaned.is_empty());
        fs::write(root.join("old.tex"), "completely unrelated manuscript").unwrap();
        reconcile(&root, storage.path()).unwrap();
        let sides = read_both(&root, storage.path()).unwrap();
        assert!(sides.iter().all(|side| side.orphaned.is_empty()));
        assert_eq!(sides[0].files["old.tex"].len(), 2);
        let failed = &sides[0].files["old.tex"][1];
        assert!(failed.position_reset);
        assert_eq!(failed.from, failed.to);
        assert_eq!(failed.text, "feedback");
        assert_eq!(sides[0].sources[failed.anchor_revision.as_ref().unwrap()], "completely unrelated manuscript");
    }

    #[test]
    fn recovery_requires_unique_text_or_unique_context_and_handles_unicode() {
        let (root, storage) = fixture();
        fs::write(
            root.path().join("old.tex"),
            "hello world\n\nhello elsewhere",
        )
        .unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        assert!(read_both(root.path(), storage.path()).unwrap()[0]
            .orphaned
            .is_empty());
        fs::write(root.path().join("old.tex"), "hello world\n\nhello world").unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        let sides = read_both(root.path(), storage.path()).unwrap();
        assert!(sides[0].orphaned.is_empty());
        assert!(sides[0].files["old.tex"][0].position_reset);
        let source = "😀 hello";
        let mut c = sides[0].files["old.tex"][0].clone();
        c.position_reset = false;
        c.from = 0;
        c.to = 2;
        c.anchor_revision = Some(revision(source).0.clone());
        let refs = BTreeMap::from([(revision(source).0, source.into())]);
        let found = recover_anchor(&c, &refs, "prefix 😀 hello").unwrap();
        assert_eq!((found.from, found.to), (7, 9));
        c.to = 1;
        assert!(recover_anchor(&c, &refs, source).is_none());
    }

    #[test]
    fn app_owned_revision_refresh_prunes_unused_disk_versions() {
        let (root, storage) = fixture();
        for i in 0..5 {
            fs::write(root.path().join("old.tex"), format!("hello world {i}")).unwrap();
            refresh_revisions(root.path(), storage.path(), &["old.tex".into()]).unwrap();
        }
        for side in read_both(root.path(), storage.path()).unwrap() {
            assert_eq!(side.sources.len(), 1); // Anchors and disk now share the latest source.
        }
    }

    #[test]
    fn known_file_keeps_mixed_and_resolved_comments_linked_even_when_every_anchor_is_lost() {
        let (root, storage) = fixture();
        let mut sides = read_both(root.path(), storage.path()).unwrap();
        let mut second = sides[0].files["old.tex"][0].clone();
        second.id = "H-2".into();
        second.number = Some(2);
        second.from = 6;
        second.to = 11;
        sides[0].counter = 2;
        sides[0].files.get_mut("old.tex").unwrap().push(second);
        sides[1].files.get_mut("old.tex").unwrap()[0].resolved = true;
        commit(storage.path(), &sides).unwrap();
        fs::write(root.path().join("old.tex"), "hello utterly unrelated replacement").unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        let mixed = read_both(root.path(), storage.path()).unwrap();
        assert!(!mixed[0].files["old.tex"][0].position_reset);
        assert!(mixed[0].files["old.tex"][1].position_reset);
        assert!(mixed[1].files["old.tex"][0].resolved);
        assert!(mixed.iter().all(|side| side.orphaned.is_empty()));
        fs::write(root.path().join("old.tex"), "").unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        let empty = read_both(root.path(), storage.path()).unwrap();
        for side in &empty {
            assert!(side.orphaned.is_empty());
            for c in &side.files["old.tex"] {
                assert!(c.position_reset);
                assert_eq!((c.from, c.to, c.line), (0, 0, 1));
                assert_eq!(c.text, "feedback");
            }
        }
        assert!(empty[1].files["old.tex"][0].resolved);
        reconcile(root.path(), storage.path()).unwrap();
        assert_eq!(read_both(root.path(), storage.path()).unwrap()[0].files, empty[0].files);
        fs::remove_file(root.path().join("old.tex")).unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        let missing = read_both(root.path(), storage.path()).unwrap();
        assert_eq!(missing[0].orphaned["old.tex"].len(), 2);
        assert_eq!(missing[1].orphaned["old.tex"].len(), 1);
    }

    #[test]
    fn manual_and_auto_relink_share_recovery_and_reconnect_lost_anchors_too() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        let mut sides = read_both(&root, storage.path()).unwrap();
        let older = "missing words";
        let old_revision = revision(older).0;
        sides[0].files.get_mut("old.tex").unwrap()[0].anchor_revision = Some(old_revision.clone());
        sides[0].sources.insert(old_revision, older.into());
        commit(storage.path(), &sides).unwrap();
        fs::rename(root.join("old.tex"), root.join("moved.tex")).unwrap();
        reconcile(&root, storage.path()).unwrap();
        let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
        let (automatic, result) = prepare_file_action(&root, storage.path(), true, &selection, "auto-relink", "").unwrap();
        let (manual, _) = prepare_file_action(&root, storage.path(), true, &selection, "relink", "moved.tex").unwrap();
        assert_eq!(result["linked"], 2);
        assert_eq!(result["remaining"], 0);
        assert_eq!(result["unplaced"], 1);
        for i in 0..2 {
            assert_eq!(automatic[i].files, manual[i].files);
            assert!(automatic[i].orphaned.is_empty());
            assert_eq!(automatic[i].files["moved.tex"][0].position_reset, i == 0);
        }
        commit(storage.path(), &automatic).unwrap();
        reconcile(&root, storage.path()).unwrap();
        let reopened = read_both(&root, storage.path()).unwrap();
        assert!(reopened[0].files["moved.tex"][0].position_reset);
        assert!(reopened[1].orphaned.is_empty());
    }

    #[test]
    fn auto_relink_matches_lf_crlf_and_mixed_raw_sizes() {
        for source in ["hello world\nfooter\n", "hello world\r\nfooter\r\n", "hello world\r\nfooter\n"] {
            let (root, storage) = fixture();
            let root = fs::canonicalize(root.path()).unwrap();
            fs::write(root.join("old.tex"), source).unwrap();
            refresh_revisions(&root, storage.path(), &["old.tex".into()]).unwrap();
            fs::rename(root.join("old.tex"), root.join("moved.tex")).unwrap();
            reconcile(&root, storage.path()).unwrap();
            let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
            let (sides, result) = prepare_file_action(&root, storage.path(), true, &selection, "auto-relink", "").unwrap();
            assert_eq!(result["linked"], 2, "source {source:?}");
            assert_eq!(result["remaining"], 0);
            assert!(sides.iter().all(|side| !side.files["moved.tex"][0].position_reset));
        }
    }

    #[test]
    fn recovery_uses_shared_mapping_and_keeps_invalid_utf16_anchors_safe() {
        let old = "Before selected After";
        for new in ["Prefix Before selected After", "Before updated After", "Before  After", ""] {
            let c: Comment = serde_json::from_value(json!({"id":"H-1", "from":7,"to":15,"line":1,"text":"feedback", "resolved":true, "anchorRevision":revision(old).0})).unwrap();
            let refs = BTreeMap::from([(revision(old).0, old.into())]);
            let rev = revision(new);
            let mut recovery = AnchorRecovery::new(&refs, new, &rev.0);
            let mapped = recovery.recover_edit(&c, &mut BTreeMap::new(), false);
            let shared = super::super::text_changes::TextChanges::new(old, new).map_anchor(&c).unwrap();
            assert_eq!((mapped.from, mapped.to, mapped.position_reset), (shared.from, shared.to, shared.position_reset), "source {new:?}");
            assert!(mapped.resolved);
        }
        let mut c: Comment = serde_json::from_value(json!({"id":"H-1", "from":1,"to":999,"line":1,"text":"feedback"})).unwrap();
        let refs = BTreeMap::new();
        let rev = revision("😀z");
        let mut recovery = AnchorRecovery::new(&refs, "😀z", &rev.0);
        let lost = recovery.recover_edit(&c, &mut BTreeMap::new(), false);
        assert!(lost.position_reset);
        assert_eq!((lost.from, lost.to), (0, 0));
        c.from = usize::MAX;
        let lost = recovery.recover_edit(&c, &mut BTreeMap::new(), true);
        assert_eq!((lost.from, lost.to), (3, 3));
    }

    #[test]
    fn auto_relink_uses_last_saved_file_even_when_anchor_version_lags() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        let temp = root.join("save.tmp");
        fs::write(&temp, "hello world appended").unwrap();
        prepare_save_revisions(&root, storage.path(), "old.tex", &temp).unwrap();
        fs::rename(temp, root.join("old.tex")).unwrap();
        reconcile(&root, storage.path()).unwrap();
        fs::rename(root.join("old.tex"), root.join("moved.tex")).unwrap();
        reconcile(&root, storage.path()).unwrap();
        // A different comment edit must not prune the disconnected fingerprint.
        let mut sides = read_both(&root, storage.path()).unwrap();
        for side in &mut sides {
            prune_sources(side);
        }
        commit(storage.path(), &sides).unwrap();
        let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
        let (sides, result) =
            prepare_file_action(&root, storage.path(), true, &selection, "auto-relink", "")
                .unwrap();
        assert_eq!(result["linked"], 2);
        assert_eq!(sides[0].files["moved.tex"][0].to, 5);
        assert!(sides.iter().all(|s| s.orphaned_revisions.is_empty()));
    }

    #[test]
    fn auto_relink_leaves_duplicate_or_edited_candidates_disconnected() {
        let (root, storage) = fixture();
        let root = fs::canonicalize(root.path()).unwrap();
        fs::rename(root.join("old.tex"), root.join("a.tex")).unwrap();
        fs::copy(root.join("a.tex"), root.join("b.tex")).unwrap();
        reconcile(&root, storage.path()).unwrap();
        let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
        let (_, result) =
            prepare_file_action(&root, storage.path(), true, &selection, "auto-relink", "")
                .unwrap();
        assert_eq!(result["linked"], 0);
        assert_eq!(result["remaining"], 2);
        fs::remove_file(root.join("b.tex")).unwrap();
        fs::write(root.join("a.tex"), "hello world edited").unwrap();
        let (_, result) =
            prepare_file_action(&root, storage.path(), true, &selection, "auto-relink", "")
                .unwrap();
        assert_eq!(result["linked"], 0);
        // Explicit manual relinking can still recover the unchanged passage.
        let (sides, result) =
            prepare_file_action(&root, storage.path(), true, &selection, "relink", "a.tex")
                .unwrap();
        assert_eq!(result["unplaced"], 0);
        assert_eq!(sides[0].files["a.tex"][0].to, 5);
    }

    #[test]
    fn prepared_save_survives_crash_before_or_after_publication() {
        for publish in [false, true] {
            let (root, storage) = fixture();
            let temporary = root.path().join("save.tmp");
            fs::write(&temporary, "updated").unwrap();
            prepare_save_revisions(root.path(), storage.path(), "old.tex", &temporary).unwrap();
            if publish {
                fs::rename(temporary, root.path().join("old.tex")).unwrap();
            }
            reconcile(root.path(), storage.path()).unwrap();
            for side in read_both(root.path(), storage.path()).unwrap() {
                assert_eq!(side.files["old.tex"].len(), 1);
                assert_eq!(side.revisions["old.tex"].len(), 1);
            }
        }
    }
    #[test]
    fn move_outside_project_stays_disconnected_and_manual_reconnection_is_guarded() {
        let (root, storage) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::rename(root.path().join("old.tex"), outside.path().join("old.tex")).unwrap();
        reconcile(root.path(), storage.path()).unwrap();
        fs::write(root.path().join("selected.tex"), "different document").unwrap();
        let ids = vec!["H-1".into(), "A-1".into()];
        assert!(reconnect(
            root.path(),
            storage.path(),
            "old.tex",
            "../outside.tex",
            &ids
        )
        .is_err());
        assert!(reconnect(
            root.path(),
            storage.path(),
            "old.tex",
            "selected.tex",
            &["H-1".into()]
        )
        .is_err());
        reconnect(root.path(), storage.path(), "old.tex", "selected.tex", &ids).unwrap();
        for side in read_both(root.path(), storage.path()).unwrap() {
            assert!(side.orphaned.is_empty());
            let c = &side.files["selected.tex"][0];
            assert!(c.position_reset);
            assert_eq!((c.from, c.to), (0, 0));
        }
    }
    #[test]
    fn manual_reconnection_rejects_occupied_target_and_commit_preserves_both_authors() {
        let (root, storage) = fixture();
        let mut sides = read_both(root.path(), storage.path()).unwrap();
        for side in &mut sides {
            let mut copy = side.files["old.tex"].clone();
            for c in &mut copy { c.id.push_str("-missing"); }
            side.orphaned.insert("missing.tex".into(), copy);
        }
        commit(storage.path(), &sides).unwrap();
        assert!(reconnect(
            root.path(),
            storage.path(),
            "missing.tex",
            "old.tex",
            &["H-1-missing".into(), "A-1-missing".into()]
        )
        .unwrap_err()
        .contains("already has comments"));
        for side in &mut sides {
            side.files.clear();
        }
        commit(storage.path(), &sides).unwrap();
        let recovered = read_both(root.path(), storage.path()).unwrap();
        assert!(recovered
            .iter()
            .all(|s| s.files.is_empty() && !s.orphaned.is_empty()));
    }
    #[cfg(unix)]
    #[test]
    fn hardlink_ambiguity_and_symlink_escape_are_not_followed() {
        let (root, storage) = fixture();
        fs::hard_link(root.path().join("old.tex"), root.path().join("a.tex")).unwrap();
        fs::hard_link(root.path().join("old.tex"), root.path().join("b.tex")).unwrap();
        fs::remove_file(root.path().join("old.tex")).unwrap();
        assert!(reconcile(root.path(), storage.path()).unwrap().is_empty());
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("target.tex"), "hello world").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("target.tex"),
            root.path().join("link.tex"),
        )
        .unwrap();
        assert!(reconnect(
            root.path(),
            storage.path(),
            "old.tex",
            "link.tex",
            &["H-1".into(), "A-1".into()]
        )
        .is_err());
    }
    #[test]
    fn case_only_rename_requires_relink_to_current_directory_spelling() {
        let (root, storage) = fixture();
        fs::rename(root.path().join("old.tex"), root.path().join("OLD.tex")).unwrap();
        assert!(reconcile(root.path(), storage.path()).unwrap().is_empty());
        assert!(read_both(root.path(), storage.path()).unwrap()[0]
            .orphaned
            .contains_key("old.tex"));
        let root = fs::canonicalize(root.path()).unwrap();
        let selection = BTreeMap::from([("old.tex".into(), vec!["H-1".into(), "A-1".into()])]);
        let (_, result) =
            prepare_file_action(&root, storage.path(), true, &selection, "auto-relink", "")
                .unwrap();
        assert_eq!(result["links"][0]["newPath"], "OLD.tex");
    }
}
