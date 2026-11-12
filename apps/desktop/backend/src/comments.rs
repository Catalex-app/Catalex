//! One PoloDB store for both comment authors. UI edits are per-comment compare-and-set
//! patches, so an old editor snapshot cannot erase a concurrent agent addition.
mod paths;
mod store;
mod text_changes;
#[cfg(test)]
pub(crate) use store::{test_read, test_write};
mod identity;
pub mod pdf;
pub(crate) mod recovery;
use crate::host::WindowContext;
pub use identity::manage_comment_files;
#[cfg(test)]
pub(crate) use identity::refresh_revisions;
pub(crate) use identity::{begin_known_edit, finish_known_edit, prepare_save_revisions};
#[cfg(test)]
pub(crate) use paths::prepare as prepare_path_changes;
#[cfg(test)]
pub(crate) use paths::reconcile as reconcile_paths;
pub(crate) use paths::recover as recover_path_changes;
pub use paths::{rename_project_path, CommentPathChange};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
pub type Comments = BTreeMap<String, Vec<Comment>>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentOrigin {
    pub provider: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentProposal {
    pub id: String,
    pub batch_id: String,
    pub kind: String,
    pub text: Option<String>,
    pub revision: String,
    pub origin: AgentOrigin,
}

fn invalid_offset() -> usize {
    usize::MAX
}
fn read_offset<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(usize::MAX))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfCommentRegion {
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfCommentAnchor {
    pub fingerprint: String,
    pub text: String,
    pub regions: Vec<PdfCommentRegion>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Comment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<PdfCommentAnchor>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_revision: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub position_reset: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_anchor: Option<Value>,
    #[serde(default = "invalid_offset", deserialize_with = "read_offset")]
    pub from: usize,
    #[serde(default = "invalid_offset", deserialize_with = "read_offset")]
    pub to: usize,
    pub line: usize,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<CommentProposal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<AgentOrigin>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentPatch {
    pub file_path: String,
    pub id: String,
    pub before: Option<Comment>,
    pub after: Option<Comment>,
}

#[derive(Serialize, Deserialize)]
struct AuthorSnapshot {
    version: u8,
    #[serde(default)]
    counter: u64,
    files: Comments,
    #[serde(default)]
    orphaned: Comments,
    #[serde(default)]
    revisions: BTreeMap<String, Vec<identity::FileRevision>>,
    #[serde(default)]
    orphaned_revisions: BTreeMap<String, Vec<identity::FileRevision>>,
    // Each anchor refers to a source snapshot in the same PoloDB transaction.
    // Source and metadata may reach disk in either order; reopen can map between
    // the saved version and the document without a separate recovery journal.
    #[serde(default)]
    sources: BTreeMap<String, String>,
    // Loaded document scope; absent for full project operations/history.
    #[serde(skip)]
    scope: Option<std::collections::BTreeSet<String>>,
}

#[derive(Default)]
pub struct CommentService {
    pdf_requests: pdf::PdfRequests,
    gates: std::sync::Mutex<BTreeMap<PathBuf, std::sync::Weak<Mutex<()>>>>,
    clear_versions: std::sync::Mutex<BTreeMap<String, u64>>,
    confirmations: Arc<Mutex<BTreeMap<String, (String, oneshot::Sender<bool>)>>>,
}

impl CommentService {
    // Canonical paths share a gate, including symlink aliases. Keep only weak
    // entries so closed projects do not retain locks or database resources.
    fn project_gate(&self, root: impl AsRef<Path>) -> Result<Arc<Mutex<()>>, String> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let mut gates = self.gates.lock().map_err(|_| "Comment lock unavailable")?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(&root).and_then(std::sync::Weak::upgrade) { return Ok(gate); }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(root, Arc::downgrade(&gate));
        Ok(gate)
    }
    pub(crate) async fn lock_project(&self, root: impl AsRef<Path>) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        Ok(self.project_gate(root)?.lock_owned().await)
    }
    pub(crate) fn lock_project_blocking(&self, root: impl AsRef<Path>) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        Ok(self.project_gate(root)?.blocking_lock_owned())
    }

    pub(crate) fn invalidate_agent_creations(&self, project_root: &str) -> Result<(), String> {
        let root = fs::canonicalize(project_root).map_err(|error| error.to_string())?.to_string_lossy().into_owned();
        let mut versions = self.clear_versions.lock().map_err(|_| "Comment reset lock unavailable")?;
        *versions.entry(root).or_default() += 1;
        Ok(())
    }
}

struct ConfirmationGuard {
    pending: Arc<Mutex<BTreeMap<String, (String, oneshot::Sender<bool>)>>>,
    request_id: String,
}

impl Drop for ConfirmationGuard {
    fn drop(&mut self) {
        let pending = self.pending.clone();
        let id = self.request_id.clone();
        tokio::spawn(async move {
            pending.lock().await.remove(&id);
        });
    }
}

pub fn relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.contains('\\')
        || value.contains(':')
        || Path::new(value).is_absolute()
        || value
            .split('/')
            .any(|part| matches!(part, "" | "." | ".." | ".git" | ".catalex"))
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("invalid_path: use a project-relative document path without traversal".into());
    }
    Ok(PathBuf::from(value))
}

pub(crate) fn is_sidecar(name: &str) -> bool {
    matches!(name, "comments.json" | "comments-agents.json")
        || name.starts_with(".catalex-comments-")
}

fn validate(comment: &Comment) -> Result<(), String> {
    if comment.id.is_empty()
        || comment.text.trim().is_empty()
        || comment.text.len() > 20_000
        || comment.from > comment.to
        || comment.line == 0
    {
        return Err("invalid_comment: comment text, range, or id is invalid".into());
    }
    if let Some(pdf) = &comment.pdf {
        if pdf.fingerprint.len() != 40 || !pdf.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
            || pdf.text.trim().is_empty() || pdf.text.len() > 80_000
            || pdf.regions.is_empty() || pdf.regions.len() > 2000
            || pdf.regions.iter().any(|r| r.page == 0 || r.page > 100_000
                || [r.x, r.y, r.width, r.height].iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 1_000_000.0)
                || r.width <= 0.0 || r.height <= 0.0)
        { return Err("invalid_comment: invalid PDF anchor".into()); }
    }
    if let Some(origin) = &comment.origin {
        if !matches!(origin.provider.as_str(), "claude" | "codex" | "pi")
            || origin.session_id.is_empty()
        {
            return Err("invalid_comment: invalid agent provenance".into());
        }
    }
    Ok(())
}

fn comment_directory(
    service: &crate::host::ServiceContext,
    project_root: &str,
) -> Result<PathBuf, String> {
    let directory = crate::project_storage::resolve_project_storage(service, project_root)?
        .data_dir
        .join("comments");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

// Private history records logical author snapshots, including counters and source
// references. Missing authors are explicit so rewinding can restore an empty group.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct HistoryComments {
    version: u8,
    human: Option<String>,
    agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path_changes: Option<String>,
}

/// History preserves malformed snapshot data without trusting them as anchors.
/// Unfinished recovery and real storage failures must still propagate.
pub(crate) fn capture_reconciled_history(root: &Path, storage: &Path) -> Result<HistoryComments, String> {
    recovery::recover(root, storage)?;
    paths::recover(root, storage)?;
    match identity::reconcile(root, storage) {
        Ok(_) => capture_history(storage),
        Err(error) if error.starts_with("invalid_comments_file:") => {
            // This also enforces regular-file, size, UTF-8 and I/O checks.
            let mut snapshot = capture_history(storage)?;
            let mut valid = Vec::new();
            let mut authors = Vec::new();
            for agent in [false, true] {
                match read_author_snapshot(root, storage, agent) {
                    Ok(side) => { valid.push(side); authors.push(agent); }
                    Err(error) if error.starts_with("invalid_comments_file:") => {}
                    Err(error) => return Err(error),
                }
            }
            // One malformed author must not let the other author's stale
            // anchors enter history. Reuse the same identity rules in memory.
            identity::reconcile_snapshots(root, &mut valid)?;
            for (agent, side) in authors.into_iter().zip(valid) {
                let value = if agent { &mut snapshot.agent } else { &mut snapshot.human };
                if value.is_some() {
                    *value = Some(serde_json::to_string(&side).map_err(|e| e.to_string())?);
                }
            }
            Ok(snapshot)
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn capture_history(storage: &Path) -> Result<HistoryComments, String> {
    identity::cleanup_jobs(storage)?;
    let path_changes = match fs::read_to_string(storage.join("path-change.json")) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    Ok(HistoryComments { version: 1, human: store::export(storage, false)?, agent: store::export(storage, true)?, path_changes })
}

pub(crate) fn validate_history(storage: &Path, snapshot: &HistoryComments) -> Result<(), String> {
    store::validate(storage)?;
    if snapshot.version != 1 { return Err("Unsupported comment history version".into()); }
    if let Some(value) = &snapshot.path_changes {
        if value.len() as u64 > MAX_BYTES { return Err("Comment path history exceeds storage limit".into()); }
        let changes: Vec<CommentPathChange> = serde_json::from_str(value).map_err(|error| error.to_string())?;
        for change in changes { relative_path(&change.old_path)?; relative_path(&change.new_path)?; }
    }
    Ok(())
}

pub(crate) fn restore_history(storage: &Path, snapshot: &HistoryComments) -> Result<(), String> {
    identity::cleanup_jobs(storage)?;
    validate_history(storage, snapshot)?;
    fs::create_dir_all(storage).map_err(|error| error.to_string())?;
    store::restore(storage, [(false, snapshot.human.as_deref()), (true, snapshot.agent.as_deref())])?;
    let journal = storage.join("path-change.json");
    if let Some(value) = &snapshot.path_changes {
        crate::project_files::replace_file(&journal, value.as_bytes())?;
    } else if journal.exists() {
        fs::remove_file(journal).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
fn read_author_comments(root: &Path, storage: &Path, agent: bool) -> Result<Comments, String> {
    Ok(read_author_snapshot(root, storage, agent)?.files)
}

fn read_author_snapshot(root: &Path, storage: &Path, agent: bool) -> Result<AuthorSnapshot, String> {
    identity::cleanup_jobs(storage)?;
    let parsed = store::read(storage, agent, None)?;
    validate_author_snapshot(root, storage, agent, parsed)
}

fn validate_author_snapshot(root: &Path, _storage: &Path, agent: bool, mut parsed: AuthorSnapshot) -> Result<AuthorSnapshot, String> {
    if parsed.version != 1 {
        return Err("invalid_comments_file: unsupported version".into());
    }
    for (file, comments) in &mut parsed.files {
        relative_path(file)?;
        let mut ids = std::collections::BTreeSet::new();
        for comment in comments {
            if comment.from > comment.to
                || comment.from == usize::MAX
                || comment.to == usize::MAX
                || comment.line == 0
            {
                let text = read_document(root, &relative_path(file)?).unwrap_or_default();
                let length = text.encode_utf16().count();
                let position = if comment.from == usize::MAX {
                    0
                } else {
                    comment.from.min(length)
                };
                comment.from = position;
                comment.to = position;
                let mut offset = 0;
                let mut line = 1;
                for ch in text.chars() {
                    if offset + ch.len_utf16() > position {
                        break;
                    }
                    offset += ch.len_utf16();
                    if ch == '\n' {
                        line += 1;
                    }
                }
                comment.from = offset;
                comment.to = offset;
                comment.line = line;
                comment.anchor_revision = None;
                comment.removed_anchor = None;
                comment.position_reset = true;
            }
            validate(comment)?;
            if comment.origin.is_some() != agent || !ids.insert(&comment.id) {
                return Err("invalid_comments_file: wrong origin or duplicate comment id".into());
            }
        }
    }
    validate_numbers(&parsed)?;
    Ok(parsed)
}

fn validate_numbers(parsed: &AuthorSnapshot) -> Result<(), String> {
    let mut numbers = std::collections::BTreeSet::new();
    for comment in parsed.files.values().flatten() {
        let number = comment.number.ok_or("invalid_comments_file: missing comment number")?;
        if number == 0 || number > parsed.counter || number > 9_007_199_254_740_991 || !numbers.insert(number) {
            return Err("invalid_comments_file: invalid or duplicate comment number".into());
        }
    }
    Ok(())
}

fn next_number(counter: u64) -> Result<u64, String> {
    counter
        .checked_add(1)
        .filter(|number| *number <= 9_007_199_254_740_991)
        .ok_or_else(|| "comments_full: comment counter exhausted".into())
}

#[cfg(test)]
fn write_author_snapshot(storage: &Path, agent: bool, snapshot: &AuthorSnapshot) -> Result<(), String> {
    store::write(storage, &[(agent, snapshot)], &[])
}

fn merge_comment(
    current: Option<&Comment>,
    patch: &CommentPatch,
    agent_create: bool,
) -> Result<Option<Comment>, String> {
    if let Some(after) = &patch.after {
        validate(after)?;
        if after.id != patch.id {
            return Err("invalid_comment: id mismatch".into());
        }
    }
    if patch
        .before
        .as_ref()
        .is_some_and(|before| before.id != patch.id)
    {
        return Err("invalid_comment: id mismatch".into());
    }
    if patch.before.is_none()
        && patch.after.as_ref().is_some_and(|c| c.origin.is_some())
        && !agent_create
    {
        return Err("invalid_origin: only the app can create agent provenance".into());
    }
    if current == patch.after.as_ref() {
        return Ok(current.cloned());
    }
    match (current, &patch.before, &patch.after) {
        (None, None, after) => Ok(after.clone()),
        (Some(current), Some(before), None) if current == before => Ok(None),
        (Some(current), Some(before), Some(after)) => {
            if before.origin != after.origin
                || current.origin != before.origin
                || before.created_at != after.created_at
            {
                return Err("invalid_origin: provenance and creation time are immutable".into());
            }
            let mut merged = current.clone();
            // A range is one value: never combine boundaries from competing moves.
            let range = |comment: &Comment| (comment.from, comment.to, comment.line);
            if range(before) != range(after) {
                if range(current) != range(before) && range(current) != range(after) {
                    return Err("comment_conflict: the comment anchor changed elsewhere".into());
                }
                (merged.from, merged.to, merged.line) = range(after);
            }
            macro_rules! field { ($name:ident) => {
                if before.$name != after.$name {
                    if current.$name != before.$name && current.$name != after.$name {
                        return Err("comment_conflict: this comment changed elsewhere; reload before retrying".into());
                    }
                    merged.$name = after.$name.clone();
                }
            }; }
            field!(pdf);
            field!(text);
            field!(resolved);
            field!(position_reset);
            field!(removed_anchor);

            validate(&merged)?;
            Ok(Some(merged))
        }
        _ => Err("comment_conflict: this comment changed or was removed elsewhere".into()),
    }
}

// Caller holds the service gate; only the affected author scope is persisted.
#[cfg(test)]
fn apply_patch(
    root: &Path,
    storage: &Path,
    patch: &CommentPatch,
    agent_create: bool,
) -> Result<CommentPatch, String> {
    apply_patch_with_source(root, storage, patch, agent_create, None)
}

fn apply_patch_with_source(
    root: &Path,
    storage: &Path,
    patch: &CommentPatch,
    agent_create: bool,
    source: Option<&str>,
) -> Result<CommentPatch, String> {
    paths::recover_pending(root, storage)?;
    store::transaction(storage, |db| {
        let sides = identity::load_for_write_on(root, storage, db, [(patch.file_path.clone(), Some(patch.id.clone()))])?;
        apply_patch_on(root, db, patch, agent_create, source, sides)
    })
}

fn apply_patch_on(
    root: &Path, db: &store::Connection, patch: &CommentPatch, agent_create: bool,
    source: Option<&str>, sides: [AuthorSnapshot; 2],
) -> Result<CommentPatch, String> {
    let mut patch = patch.clone();
    // Resolve queued writes by comment ID after a filesystem rename.
    for snapshot in [&sides[usize::from(patch.before.as_ref().or(patch.after.as_ref()).is_some_and(|c| c.origin.is_some()))]] {
        if let Some((path, _)) = snapshot
            .files
            .iter()
            .find(|(_, comments)| comments.iter().any(|c| c.id == patch.id))
        {
            patch.file_path = path.clone();
            break;
        }
    }
    let patch = &patch;
    relative_path(&patch.file_path)?;
    let agent = patch
        .before
        .as_ref()
        .or(patch.after.as_ref())
        .is_some_and(|c| c.origin.is_some());
    let mut snapshot = sides.into_iter().nth(usize::from(agent)).unwrap();
    if snapshot
        .orphaned
        .values()
        .flatten()
        .any(|comment| comment.id == patch.id)
    {
        return Err("comment_orphaned: this comment belongs to a removed file; its original metadata is preserved".into());
    }
    let hash = source.map(|text| format!("{:x}", Sha1::digest(text.as_bytes())));
    let change = apply_patch_to_snapshot(
        root,
        &mut snapshot,
        patch,
        agent_create,
        source.zip(hash.as_deref()),
        None,
    )?;
    if change.before != change.after {
        identity::remember(root, &mut snapshot, &change.file_path);
        identity::prune_sources(&mut snapshot);
        store::write_change(db, agent, &snapshot, &change)?;
    }
    Ok(change)
}

// Shared CAS/number/anchor validation for individual edits and grouped typing updates.
fn apply_patch_to_snapshot(
    root: &Path,
    snapshot: &mut AuthorSnapshot,
    patch: &CommentPatch,
    agent_create: bool,
    source: Option<(&str, &str)>,
    known_index: Option<usize>,
) -> Result<CommentPatch, String> {
    if source.is_some_and(|(text, _)| text.len() as u64 > MAX_BYTES) { return Err("Comment source exceeds storage limit".into()); }
    if let Some(pdf) = patch.after.as_ref().and_then(|comment| comment.pdf.as_ref()) {
        if source.is_some() || identity::project_source(root, &patch.file_path)?.as_deref() != Some(&format!("pdf:{}", pdf.fingerprint)) {
            return Err("comment_conflict: PDF changed; reopen it before commenting".into());
        }
    }
    let files = &mut snapshot.files;
    let comments = files.entry(patch.file_path.clone()).or_default();
    let index = known_index.filter(|index| comments.get(*index).is_some_and(|c| c.id == patch.id)).or_else(|| comments.iter().position(|comment| comment.id == patch.id));
    let before = index.map(|index| comments[index].clone());
    // Number allocation is backend-owned. Older queued UI patches may not yet
    // include the number returned by the first save.
    let mut normalized = patch.clone();
    if let Some(current) = &before {
        for value in [&mut normalized.before, &mut normalized.after]
            .into_iter()
            .flatten()
        {
            if value.number.is_some() && value.number != current.number {
                return Err("invalid_comment: comment number is immutable".into());
            }
            value.number = current.number;
        }
    }
    let superseded_anchor = anchor_only(&normalized) && before.as_ref().is_some_and(|current| {
        source.is_some_and(|(_, revision)| current.anchor_revision.as_deref() == Some(revision))
            && normalized.before.as_ref().is_some_and(|expected| expected.anchor_revision != current.anchor_revision)
    });
    let preserves_recovered_anchor = before.as_ref().is_some_and(|current| {
        source.is_some_and(|(_, revision)| current.anchor_revision.as_deref() == Some(revision))
            && normalized.before.as_ref().zip(normalized.after.as_ref()).is_some_and(|(old, new)| {
                (old.from, old.to, old.line, old.position_reset) == (new.from, new.to, new.line, new.position_reset)
                    && old.removed_anchor == new.removed_anchor
            })
    });
    let mut after = match merge_comment(before.as_ref(), &normalized, agent_create) {
        Err(error) if superseded_anchor && error.starts_with("comment_conflict:") => {
            return Err("comment_anchor_superseded: reload the anchor already recovered for this source revision".into());
        }
        result => result?,
    };
    if before.is_none() {
        if let Some(comment) = &mut after {
            snapshot.counter = next_number(snapshot.counter)?;
            comment.number = Some(snapshot.counter);
        }
    }
    let disk_source = if before.is_none() && source.is_none() {
        read_document(root, &relative_path(&patch.file_path)?).ok()
    } else {
        None
    };
    if let (Some(comment), Some(text)) = (
        &mut after,
        source.map(|(text, _)| text).or(disk_source.as_deref()),
    ) {
        if !preserves_recovered_anchor && patch.after.as_ref().is_some_and(|requested| {
            (requested.from, requested.to, requested.line)
                != (comment.from, comment.to, comment.line)
        }) {
            if superseded_anchor {
                return Err("comment_anchor_superseded: reload the anchor already recovered for this source revision".into());
            }
            return Err("comment_conflict: anchor changed while saving its source".into());
        }
        let revision = source
            .map(|(_, hash)| hash.to_owned())
            .unwrap_or_else(|| format!("{:x}", Sha1::digest(text.as_bytes())));
        snapshot
            .sources
            .entry(revision.clone())
            .or_insert_with(|| text.to_owned());
        comment.anchor_revision = Some(revision);
    }
    if before != after {
        match (index, &after) {
            (Some(index), Some(comment)) => comments[index] = comment.clone(),
            (Some(index), None) => { comments.remove(index); }
            (None, Some(comment)) => comments.push(comment.clone()),
            (None, None) => {}
        }
        if comments.is_empty() {
            files.remove(&patch.file_path);
        }
    }
    Ok(CommentPatch {
        file_path: patch.file_path.clone(),
        id: patch.id.clone(),
        before,
        after,
    })
}

pub async fn read_project_comments(
    service: &crate::host::ServiceContext,
    project_root: String,
) -> Result<Comments, String> {
    let _guard = service.comments.lock_project(&project_root).await?;
    let storage = comment_directory(service, &project_root)?;
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let ([human, agent], _) = paths::read_reconciled(&root, &storage)?;
    let mut human = human.files;
    for (file, comments) in agent.files {
        human.entry(file).or_default().extend(comments);
    }
    Ok(human)
}

// Call while holding the comment gate; use the same lock order as agent acceptance.
fn checkpoint_comments(service: &crate::host::ServiceContext, project: &str, message: String) -> Result<(), String> {
    let lock = crate::agent_workspace::project_apply_lock(project)?;
    let _project = lock.lock().map_err(|_| "Project lock unavailable")?;
    let paths = crate::project_storage::resolve_project_storage(service, project)?;
    crate::history::history_init_at(project, &paths)?;
    let _history = crate::history::lock_history_operations();
    crate::history::history_snapshot_unlocked_at(project, &paths, message)?;
    Ok(())
}

fn first_comment(root: &Path, storage: &Path, patch: &CommentPatch) -> Result<bool, String> {
    if patch.before.is_some() || patch.after.is_none() {
        return Ok(false);
    }
    for side in identity::load_for_write(
        root,
        storage,
        [(patch.file_path.clone(), Some(patch.id.clone()))],
    )? {
        if side
            .files
            .get(&patch.file_path)
            .is_some_and(|items| !items.is_empty())
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn checkpoint_first_comment(window: &WindowContext, project: &str, path: &str, first: bool, agent: bool) {
    if !first { return; }
    // The comment is already saved: never report a save failure or replay the write.
    let category = if agent { "agent-comments" } else { "comments" };
    if let Err(error) = checkpoint_comments(&window.service, project, format!("[{category}] First comment on {path}")) {
        eprintln!("[comments] First-comment checkpoint failed: {error}");
        let _ = window.service.emit("catalex-comment-checkpoint-failed", json!({"projectRoot":project}));
    }
}

pub async fn update_project_comment(
    window: WindowContext,
    project_root: String,
    patch: CommentPatch,
) -> Result<CommentPatch, String> {
    save_project_comment(window, project_root, patch, None).await
}

async fn save_project_comment(window: WindowContext, project_root: String, patch: CommentPatch, source: Option<String>) -> Result<CommentPatch, String> {
    let guard = window.service.comments.lock_project(&project_root).await?;
    tokio::task::spawn_blocking(move || {
        // Own the guard in the worker: cancelling its caller cannot release the
        // project while a durable write is still running.
        let _guard = guard;
        let storage = comment_directory(&window.service, &project_root)?;
        let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
        let first = first_comment(&root, &storage, &patch)?;
        let change = apply_patch_with_source(&root, &storage, &patch, false, source.as_deref())?;
        checkpoint_first_comment(&window, &project_root, &change.file_path, first, false);
        let _ = window.service.emit("catalex-comments-changed", json!({"projectRoot":project_root,"patch":change}));
        Ok(change)
    }).await.map_err(|e| e.to_string())?
}

// Called while the caller owns the project comment gate. Scope the receipt to
// affected documents so acceptance does not read unrelated project comments.
pub(crate) fn stored_document_comments(storage: &Path, paths: &std::collections::BTreeSet<String>) -> Result<Comments, String> {
    store::transaction(storage, |db| {
        let [human, agent] = store::read_both_on(db, Some(paths))?;
        let mut files = human.files;
        for (path, comments) in agent.files {
            files.entry(path).or_default().extend(comments);
        }
        Ok(files)
    })
}

pub(crate) fn document_comment_notifications(before: Comments, after: Comments) -> Vec<CommentPatch> {
    let prior: BTreeMap<_, _> = before.into_iter().flat_map(|(path, comments)| comments.into_iter().map(move |comment| (comment.id.clone(), (path.clone(), comment)))).collect();
    after.into_values().flatten().filter_map(|comment| {
        let (path, old) = prior.get(&comment.id)?;
        (old != &comment).then(|| CommentPatch { file_path: path.clone(), id: comment.id.clone(), before: Some(old.clone()), after: Some(comment) })
    }).collect()
}

pub async fn read_project_comments_anchored(
    service: &crate::host::ServiceContext,
    project_root: String,
    include_disconnected: bool,
) -> Result<Value, String> {
    let _guard = service.comments.lock_project(&project_root).await?;
    let storage = comment_directory(service, &project_root)?;
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let ([human, agent], path_changes) = paths::read_reconciled(&root, &storage)?;
    let counters = [human.counter, agent.counter];
    // Reconciliation captured these disk revisions and their source text under
    // the comment gate. Return that same basis: a second renderer filesystem
    // read could observe an unrelated external replacement and trust it as an edit.
    let documents: BTreeMap<_, _> = human.revisions.iter().chain(&agent.revisions)
        .filter_map(|(path, revisions)| match revisions.as_slice() {
            [revision] => Some((path.clone(), revision.clone())),
            _ => None,
        }).collect();
    let orphaned_paths: std::collections::BTreeSet<_> = human.orphaned.keys().chain(agent.orphaned.keys()).cloned().collect();
    let orphaned_ids: Vec<_> = human.orphaned.values().chain(agent.orphaned.values()).flatten().map(|comment| comment.id.clone()).collect();
    let mut files = human.files;
    for (path, comments) in agent.files {
        files.entry(path).or_default().extend(comments);
    }
    let mut sources = human.sources;
    sources.extend(agent.sources);
    let mut snapshot = json!({"files": files, "sources": sources, "documents": documents, "counters": counters, "orphanedPaths": orphaned_paths, "orphanedIds": orphaned_ids, "pathChanges": path_changes});
    // The manager needs both views of this same reconciled snapshot. Reuse the
    // records already read above instead of reconciling and opening storage again.
    if include_disconnected {
        let mut disconnected = human.orphaned;
        for (path, comments) in agent.orphaned {
            disconnected.entry(path).or_default().extend(comments);
        }
        snapshot["disconnected"] = json!(disconnected);
    }
    Ok(snapshot)
}

pub async fn update_project_comment_anchored(
    window: WindowContext,
    project_root: String,
    patch: CommentPatch,
    source: String,
) -> Result<CommentPatch, String> {
    save_project_comment(window, project_root, patch, Some(source)).await
}

fn anchor_only(patch: &CommentPatch) -> bool {
    let (Some(before), Some(after)) = (&patch.before, &patch.after) else {
        return false;
    };
    let mut anchor = before.clone();
    anchor.from = after.from;
    anchor.to = after.to;
    anchor.line = after.line;
    anchor.anchor_revision = after.anchor_revision.clone();
    anchor.position_reset = after.position_reset;
    anchor.removed_anchor = after.removed_anchor.clone();
    anchor == *after
}

// A typing transaction sends one source snapshot, reconciles once and publishes
// both author groups atomically through the existing recovery journal.
fn apply_anchor_batch(
    root: &Path,
    storage: &Path,
    patches: &[CommentPatch],
    source: &str,
) -> Result<Value, String> {
    if patches.is_empty()
        || patches
            .iter()
            .any(|patch| !anchor_only(patch) || patch.file_path != patches[0].file_path)
    {
        return Err("invalid_comment: expected anchor updates for one file".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    if patches.iter().any(|patch| !ids.insert(&patch.id)) {
        return Err("invalid_comment: duplicate anchor update".into());
    }
    paths::recover_pending(root, storage)?;
    store::transaction(storage, |db| apply_anchor_batch_on(root, storage, db, patches, source))
}
fn apply_anchor_batch_on(root: &Path, storage: &Path, db: &store::Connection, patches: &[CommentPatch], source: &str) -> Result<Value, String> {
    let mut sides = identity::load_for_write_on(
        root,
        storage,
        db,
        patches
            .iter()
            .map(|patch| (patch.file_path.clone(), Some(patch.id.clone()))),
    )?;
    let locations: BTreeMap<_, _> = sides
        .iter()
        .flat_map(|side| {
            side.files.iter().flat_map(|(path, comments)| {
                comments
                    .iter()
                    .enumerate()
                    .map(move |(index, comment)| ((comment.origin.is_some(), comment.id.clone()), (path.clone(), index)))
            })
        })
        .collect();
    let orphaned: std::collections::BTreeSet<_> = sides
        .iter()
        .flat_map(|side| {
            side.orphaned
                .values()
                .flatten()
                .map(|comment| comment.id.clone())
        })
        .collect();
    let hash = format!("{:x}", Sha1::digest(source.as_bytes()));
    let mut changes = Vec::new();
    let mut disconnected = Vec::new();
    let mut changed_paths = std::collections::BTreeSet::new();
    for patch in patches {
        if orphaned.contains(&patch.id) {
            disconnected.push(patch.id.clone());
            continue;
        }
        let mut patch = patch.clone();
        let agent = patch.before.as_ref().unwrap().origin.is_some();
        let location = locations.get(&(agent, patch.id.clone()));
        if let Some((path, _)) = location { patch.file_path = path.clone(); }
        relative_path(&patch.file_path)?;
        let change = apply_patch_to_snapshot(
            root,
            &mut sides[usize::from(agent)],
            &patch,
            false,
            Some((source, &hash)),
            location.map(|(_, index)| *index),
        )?;
        if change.before != change.after {
            changed_paths.insert((agent, change.file_path.clone()));
        }
        changes.push(change);
    }
    if !changed_paths.is_empty() {
        for (agent, path) in changed_paths {
            identity::remember(root, &mut sides[usize::from(agent)], &path);
        }
        for side in &mut sides {
            identity::prune_sources(side);
        }
        store::write_anchors_on(db, &[(false, &sides[0]), (true, &sides[1])])?;
    }
    Ok(json!({"patches":changes,"orphanedIds":disconnected}))
}

pub async fn update_project_comment_anchors(
    window: WindowContext,
    project_root: String,
    patches: Vec<CommentPatch>,
    source: String,
) -> Result<Value, String> {
    let _guard = window.service.comments.lock_project(&project_root).await?;
    let storage = comment_directory(&window.service, &project_root)?;
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let result =
        tokio::task::spawn_blocking(move || { let _guard = _guard; apply_anchor_batch(&root, &storage, &patches, &source) })
            .await
            .map_err(|error| error.to_string())??;
    if let Some(first) = result["patches"].as_array().and_then(|items| items.first()) {
        let _ = window.service.emit(
            "catalex-comments-changed",
            json!({"projectRoot":project_root,"patch":first,"patches":result["patches"]}),
        );
    }
    Ok(json!({"orphanedIds":result["orphanedIds"]}))
}

/// Reset one author group without parsing damaged metadata or touching source files.
pub async fn clear_project_comments(
    window: WindowContext,
    project_root: String,
    agent: bool,
) -> Result<(), String> {
    let _guard = window.service.comments.lock_project(&project_root).await?;
    let storage = comment_directory(&window.service, &project_root)?;
    checkpoint_comments(&window.service, &project_root, "[comments] Before clearing comments".into())?;
    clear_author(&storage, agent)?;
    if agent {
        let root = fs::canonicalize(&project_root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        let mut versions = window
            .service
            .comments
            .clear_versions
            .lock()
            .map_err(|_| "Comment reset lock unavailable")?;
        *versions.entry(root).or_default() += 1;
    }
    window.service.emit(
        "catalex-comments-cleared",
        json!({"projectRoot":project_root,"agent":agent}),
    )?;
    Ok(())
}

fn clear_author(storage: &Path, agent: bool) -> Result<(), String> {
    identity::cleanup_jobs(storage)?;
    store::clear(storage, agent)
}

// Undo/redo is an app action, not an agent tool. Require unchanged content and
// attribution, while preserving anchors that ordinary text edits have moved.
pub async fn replay_project_comment(
    window: WindowContext,
    project_root: String,
    patch: CommentPatch,
) -> Result<CommentPatch, String> {
    let _guard = window.service.comments.lock_project(&project_root).await?;
    let storage = comment_directory(&window.service, &project_root)?;
    let root = fs::canonicalize(&project_root).map_err(|e| e.to_string())?;
    let change = replay_patch(&root, &storage, patch)?;
    if let Err(error) = window.service.emit(
        "catalex-comments-changed",
        json!({"projectRoot":project_root,"patch":change,"historyReplay":true}),
    ) {
        eprintln!("[comments] saved undo/redo, but could not notify editors: {error}");
    }
    Ok(change)
}

fn replay_patch(
    root: &Path,
    storage: &Path,
    patch: CommentPatch,
) -> Result<CommentPatch, String> {
    paths::recover_pending(root, storage)?;
    store::transaction(storage, |db| replay_patch_on(root, storage, db, patch))
}
fn replay_patch_on(root: &Path, storage: &Path, db: &store::Connection, patch: CommentPatch) -> Result<CommentPatch, String> {
    let sides = identity::load_for_write_on(root, storage, db, [(patch.file_path.clone(), Some(patch.id.clone()))])?;
    let mut patch = patch.clone();
    for snapshot in [&sides[usize::from(patch.before.as_ref().or(patch.after.as_ref()).is_some_and(|c| c.origin.is_some()))]] {
        if let Some((path, _)) = snapshot.files.iter().find(|(_, comments)| comments.iter().any(|c| c.id == patch.id)) { patch.file_path = path.clone(); break; }
    }
    relative_path(&patch.file_path)?;
    let value = patch
        .before
        .as_ref()
        .or(patch.after.as_ref())
        .ok_or("Empty comment history entry")?;
    let agent = value.origin.is_some();
    let mut snapshot = sides.into_iter().nth(usize::from(agent)).unwrap();
    if snapshot.orphaned.values().flatten().any(|comment| comment.id == patch.id) {
        return Err("comment_orphaned: original metadata is preserved; this path no longer identifies that file".into());
    }
    let current = snapshot
        .files
        .get(&patch.file_path)
        .and_then(|items| items.iter().find(|c| c.id == patch.id))
        .cloned();
    // Deliberate range changes must replay their saved endpoints. Text/comment
    // edits still preserve anchors moved by subsequent source edits.
    let range_change = match (&patch.before, &patch.after) {
        (Some(before), Some(after)) => {
            before.from != after.from || before.to != after.to || before.pdf != after.pdf
        }
        _ => false,
    };
    // First-save acknowledgements may arrive after the undo entry was recorded.
    if let Some(current) = &current {
        for value in [&mut patch.before, &mut patch.after].into_iter().flatten() {
            if value.number.is_none() {
                value.number = current.number;
            }
            value.anchor_revision = current.anchor_revision.clone();
            if !range_change {
                value.from = current.from;
                value.to = current.to;
                value.line = current.line;
            }
        }
    }
    if current != patch.before {
        return Err(
            "comment_conflict: this comment changed since that action; undo was not applied".into(),
        );
    }
    if let Some(after) = &patch.after {
        validate(after)?;
        if let Some(pdf) = &after.pdf {
            if identity::project_source(root, &patch.file_path)?.as_deref() != Some(&format!("pdf:{}", pdf.fingerprint)) {
                return Err("comment_conflict: PDF changed; the original comment was preserved".into());
            }
        }
        if after.id != patch.id || after.origin.is_some() != agent {
            return Err("Invalid comment history entry".into());
        }
        if let Some(before) = &patch.before {
            if before.origin != after.origin
                || before.created_at != after.created_at
                || before.number != after.number
            {
                return Err("Comment history cannot change attribution or number".into());
            }
        }
        if current.is_none()
            && snapshot
                .files
                .values()
                .flatten()
                .any(|c| c.id == after.id || (after.number.is_some() && c.number == after.number))
        {
            return Err("comment_conflict: restored comment identity is already in use".into());
        }
    }
    if let Some(after) = &mut patch.after {
        if after.number.is_none() {
            snapshot.counter = next_number(snapshot.counter)?;
            after.number = Some(snapshot.counter);
        }
        snapshot.counter = snapshot.counter.max(after.number.unwrap());
    }
    let items = snapshot.files.entry(patch.file_path.clone()).or_default();
    items.retain(|c| c.id != patch.id);
    if let Some(after) = &patch.after {
        items.push(after.clone());
    }
    if items.is_empty() {
        snapshot.files.remove(&patch.file_path);
    }
    identity::remember(root, &mut snapshot, &patch.file_path);
    store::write_on(db, &[(agent, &snapshot)], &[])?;
    Ok(patch)
}

// Revisions cover the entire comment, including anchors and provenance.
fn comment_revision(comment: &Comment) -> String {
    {
        let mut accepted = comment.clone();
        accepted.proposal = None;
        format!("{:x}", Sha1::digest(serde_json::to_vec(&accepted).unwrap()))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManageComment {
    file_path: String,
    id: Option<String>,
    revision: Option<String>,
    text: Option<String>,
    resolved: Option<bool>,
}

fn manage_comment(
    root: &Path,
    storage: &Path,
    tool: &str,
    args: Value,
) -> Result<(Value, Option<CommentPatch>), String> {
    let input: ManageComment =
        serde_json::from_value(args).map_err(|e| format!("invalid_arguments: {e}"))?;
    relative_path(&input.file_path)?;
    if is_sidecar(&input.file_path) {
        return Err("invalid_path: comment snapshots are app-managed metadata".into());
    }
    paths::recover_pending(root, storage)?;
    store::transaction(storage, |db| manage_comment_on(root, storage, db, tool, input))
}
fn manage_comment_on(root: &Path, storage: &Path, db: &store::Connection, tool: &str, input: ManageComment) -> Result<(Value, Option<CommentPatch>), String> {
    let sides = identity::load_for_write_on(root, storage, db, [(input.file_path.clone(), None)])?;
    let comments: Vec<_> = sides
        .iter()
        .flat_map(|side| {
            side.files
                .get(&input.file_path)
                .into_iter()
                .flatten()
                .cloned()
        })
        .collect();
    if tool == "list_comments" {
        if input.id.is_some()
            || input.revision.is_some()
            || input.text.is_some()
            || input.resolved.is_some()
        {
            return Err("invalid_arguments: listing accepts only filePath".into());
        }
        return Ok((
            json!({"filePath":input.file_path,"comments":comments.iter().map(|comment|
            json!({"comment":comment,"revision":comment_revision(comment)})
        ).collect::<Vec<_>>()}),
            None,
        ));
    }
    if !matches!(tool, "edit_comment" | "resolve_comment" | "delete_comment") {
        return Err("invalid_arguments: unknown comment operation".into());
    }
    if (tool == "edit_comment") != input.text.is_some() {
        return Err("invalid_arguments: text is required only for edit_comment".into());
    }
    if tool != "resolve_comment" && input.resolved.is_some() {
        return Err("invalid_arguments: resolved is only accepted by resolve_comment".into());
    }
    let id = input.id.ok_or("invalid_arguments: id is required")?;
    let revision = input
        .revision
        .ok_or("invalid_arguments: revision is required; list comments first")?;
    let matches: Vec<_> = comments
        .into_iter()
        .filter(|comment| comment.id == id)
        .collect();
    if matches.len() != 1 {
        return Err("comment_not_found: expected one comment with this id in this file".into());
    }
    let before = matches.into_iter().next().unwrap();
    if comment_revision(&before) != revision {
        return Err(
            "comment_conflict: comment changed; list comments and reconsider before retrying"
                .into(),
        );
    }
    let mut after = before.clone();
    if let Some(text) = input.text {
        after.text = text;
    }
    if tool == "resolve_comment" {
        after.resolved = input.resolved.unwrap_or(true);
    }
    let change = apply_patch_on(
        root,
        db,
        &CommentPatch {
            file_path: input.file_path.clone(),
            id,
            before: Some(before),
            after: (tool != "delete_comment").then_some(after),
        },
        false,
        None,
        sides,
    )?;
    Ok((
        json!({"status":match tool {"edit_comment" => "edited", "resolve_comment" if input.resolved == Some(false) => "reopened", "resolve_comment" => "resolved", _ => "deleted"},
        "filePath":input.file_path,"id":change.id,"comment":change.after,
        "revision":change.after.as_ref().map(comment_revision)}),
        Some(change),
    ))
}

pub async fn manage_agent_comment(
    window: &WindowContext,
    source_root: &str,
    draft_root: &str,
    tab_id: &str,
    tool: &str,
    args: Value,
    cancelled: &CancellationToken,
) -> Result<Value, String> {
    let _guard = window.service.comments.lock_project(source_root).await?;
    if cancelled.is_cancelled() {
        return Err("stale_session: agent turn ended".into());
    }
    crate::agent_workspace::validate_comment_scope(
        &window.service,
        source_root,
        draft_root,
        tab_id,
    )?;
    let lock = crate::agent_workspace::project_apply_lock(source_root)?;
    let _project_guard = lock.lock().map_err(|_| "Project lock unavailable")?;
    let source = fs::canonicalize(source_root).map_err(|e| e.to_string())?;
    let storage = comment_directory(&window.service, source_root)?;
    let (payload, change) = manage_comment(&source, &storage, tool, args)?;
    if let Some(change) = change {
        if let Err(error) = window.service.emit(
            "catalex-comments-changed",
            json!({"projectRoot":source_root,"tabId":tab_id,"patch":change}),
        ) {
            eprintln!("[comments] saved, but could not notify editors: {error}");
        }
    }
    Ok(payload)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateComment {
    pdf: Option<pdf::PdfLocation>,
    file_path: String,
    passage: String,
    line_hint: Option<usize>,
    text: String,
    // Explicit context reread from current source, never an unchecked offset.
    reviewed_paragraph: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
pub enum ReviewChoice {
    Update,
    SafeOnly,
    Stop,
}

fn authorized_comment(
    source: &str,
    draft: &str,
    input: &CreateComment,
    origin: AgentOrigin,
    choice: Option<ReviewChoice>,
) -> Result<Comment, String> {
    if choice == Some(ReviewChoice::Stop) {
        return Err(
            "review_stopped: leave all remaining comments unsaved; existing comments are untouched"
                .into(),
        );
    }
    // Agents read raw filesystem text; comment coordinates use editor LF text.
    let normalized = CreateComment {
        passage: catalex_document_core::normalize_document_text(&input.passage),
        reviewed_paragraph: input.reviewed_paragraph.as_deref().map(catalex_document_core::normalize_document_text),
        ..input.clone()
    };
    let input = &normalized;
    // Always try the original paragraph rule first. Fresh context is not consent.
    let mut original = input.clone();
    original.reviewed_paragraph = None;
    let normal = anchored_comment(source, draft, &original, origin.clone());
    if normal.is_ok() {
        return normal;
    }
    let error = normal.unwrap_err();
    if error.starts_with("invalid_")
        || (source == draft
            && (error.starts_with("ambiguous_passage:")
                || passage_offset(draft, &input.passage, None).is_ok()))
    {
        return Err(error);
    }
    match choice {
        None => Err(format!("review_choice_required: {error}")),
        Some(ReviewChoice::Update) if input.reviewed_paragraph.is_some() =>
            anchored_comment(source, draft, input, origin),
        Some(ReviewChoice::Update) => Err("rereview_required: read the current source, reconsider the feedback, and provide its exact complete reviewedParagraph".into()),
        _ => Err("unsafe_comment: user chose safe comments only; leave this affected comment unsaved".into()),
    }
}

fn read_document(root: &Path, relative: &Path) -> Result<String, String> {
    let path = fs::canonicalize(root.join(relative))
        .map_err(|_| "missing_document: document does not exist".to_string())?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("invalid_path: document leaves the project or exceeds 8 MiB".into());
    }
    fs::read_to_string(path)
        .map(|text| catalex_document_core::normalize_document_text(&text))
        .map_err(|_| "invalid_document: expected a UTF-8 document".into())
}

fn passage_offset(source: &str, passage: &str, line_hint: Option<usize>) -> Result<usize, String> {
    if line_hint.is_none() && !passage.is_empty() {
        let first = source
            .find(passage)
            .ok_or("missing_passage: the exact passage was not found at the requested location")?;
        let next = first + source[first..].chars().next().unwrap().len_utf8();
        if source[next..].contains(passage) {
            return Err("ambiguous_passage: include more text or a start-line hint".into());
        }
        return Ok(first);
    }
    let mut line = 1;
    let offsets: Vec<_> = source
        .char_indices()
        .filter_map(|(offset, character)| {
            let matches =
                line_hint.is_none_or(|hint| hint == line) && source[offset..].starts_with(passage);
            if character == '\n' {
                line += 1;
            }
            matches.then_some(offset)
        })
        .take(2)
        .collect();
    match offsets.as_slice() {
        [offset] => Ok(*offset),
        [] => {
            return Err(
                "missing_passage: the exact passage was not found at the requested location".into(),
            )
        }
        _ => Err("ambiguous_passage: include more text or a start-line hint".into()),
    }
}

// Paragraphs are source blocks separated by blank (possibly whitespace-only) lines.
fn paragraphs(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut result = Vec::new();
    let mut start = None;
    let mut end = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.trim().is_empty() {
            if let Some(start) = start.take() {
                result.push(start..end);
            }
        } else {
            start.get_or_insert(offset);
            end = offset + line.trim_end_matches(['\r', '\n']).len();
        }
        offset += line.len();
    }
    if let Some(start) = start {
        result.push(start..end);
    }
    result
}

fn paragraph_context(text: &str, from: usize, to: usize) -> Result<std::ops::Range<usize>, String> {
    paragraph_context_in(&paragraphs(text), from, to)
}

fn paragraph_context_in(
    blocks: &[std::ops::Range<usize>],
    from: usize,
    to: usize,
) -> Result<std::ops::Range<usize>, String> {
    let first = blocks
        .iter()
        .find(|block| block.start <= from && from < block.end);
    let last = blocks
        .iter()
        .rev()
        .find(|block| block.start < to && block.end > from);
    match (first, last) {
        (Some(first), Some(last)) => Ok(first.start..last.end),
        _ => Err("invalid_passage: quote text inside a paragraph".into()),
    }
}

fn unique_paragraph_offset(source: &str, context: &str) -> Result<usize, String> {
    let blocks = paragraphs(source);
    let matches: Vec<_> = blocks
        .iter()
        .filter(|block| {
            source[block.start..].starts_with(context)
                && blocks
                    .iter()
                    .any(|end| end.end == block.start + context.len())
        })
        .take(2)
        .collect();
    match matches.as_slice() {
        [block] => Ok(block.start),
        [] => Err("changed_text: the reviewed paragraph changed or was removed; reconsider the feedback against the current source".into()),
        _ => Err("ambiguous_paragraph: the reviewed paragraph appears more than once; no comment was saved".into()),
    }
}

fn anchored_comment(
    source: &str,
    draft: &str,
    input: &CreateComment,
    origin: AgentOrigin,
) -> Result<Comment, String> {
    if input.passage.is_empty() || input.passage.len() > 20_000 || input.line_hint == Some(0) {
        return Err(
            "invalid_passage: supply an exact passage and an optional positive start-line hint"
                .into(),
        );
    }
    let offset = if let Some(context) = &input.reviewed_paragraph {
        if context.is_empty() || context.len() > 20_000 {
            return Err("invalid_passage: reviewedParagraph must contain at most 20000 bytes of exact source context".into());
        }
        let start = unique_paragraph_offset(source, context).map_err(|error| {
            // A reread may omit an adjoining section/command line. That is an
            // incomplete argument, not evidence that the source changed again.
            let mut matches = source.match_indices(context);
            if let Some((offset, _)) = matches.next() {
                if matches.next().is_none() {
                    if let Ok(block) = paragraph_context(source, offset, offset + context.len()) {
                        let complete = &source[block];
                        if complete != context && complete.len() <= 20_000 {
                            return format!(
                                "incomplete_paragraph: reviewedParagraph matches current source but omits part of its blank-line-delimited block (including adjoining commands). No comment was saved. Review the complete context and retry with it; required reviewedParagraph: {}",
                                json!(complete)
                            );
                        }
                    }
                }
            }
            error
        })?;
        // A line hint cannot make duplicated fresh context safe.
        start + passage_offset(context, &input.passage, None)?
    } else {
        let reviewed_offset = passage_offset(draft, &input.passage, input.line_hint)?;
        if source == draft {
            reviewed_offset
        } else {
            let context = paragraph_context(
                draft,
                reviewed_offset,
                reviewed_offset + input.passage.len(),
            )?;
            unique_paragraph_offset(source, &draft[context.clone()])? + reviewed_offset
                - context.start
        }
    };
    if !source
        .get(offset..)
        .is_some_and(|text| text.starts_with(&input.passage))
    {
        return Err("changed_text: the exact passage changed; no comment was saved".into());
    }
    let end = offset + input.passage.len();
    let comment = Comment {
        pdf: None,
        id: uuid::Uuid::new_v4().to_string(),
        number: None,
        anchor_revision: None,
        position_reset: false,
        removed_anchor: None,
        from: source[..offset].encode_utf16().count(),
        to: source[..end].encode_utf16().count(),
        line: source[..end].bytes().filter(|b| *b == b'\n').count()
            + usize::from(!input.passage.ends_with('\n')),
        text: input.text.trim().into(),
        created_at: Some(chrono::Utc::now().to_rfc3339()),
        resolved: false,
        proposal: None,
        origin: Some(origin),
    };
    validate(&comment)?;
    Ok(comment)
}

pub async fn confirm_comment_source(
    window: WindowContext,
    request_id: String,
    matches: bool,
) -> Result<(), String> {
    let state = &window.service.comments;
    let mut confirmations = state.confirmations.lock().await;
    if confirmations
        .get(&request_id)
        .is_some_and(|(label, _)| label == window.label())
    {
        if let Some((_, sender)) = confirmations.remove(&request_id) {
            let _ = sender.send(matches);
        }
        return Ok(());
    }
    Err("stale_session: source confirmation expired or belongs to another window".into())
}

pub async fn create_agent_comment(
    window: &WindowContext,
    source_root: &str,
    draft_root: &str,
    tab_id: &str,
    origin: &AgentOrigin,
    args: Value,
    cancelled: &CancellationToken,
    review_choice: &Mutex<Option<ReviewChoice>>,
) -> Result<Value, String> {
    // Serialize saves and decisions within this turn, not across conversations.
    let mut choice = review_choice.lock().await;
    let input: CreateComment =
        serde_json::from_value(args).map_err(|e| format!("invalid_arguments: {e}"))?;
    if input.pdf.is_some() {
        if *choice == Some(ReviewChoice::Stop) { return Err("review_stopped: no further comment saves are authorized this turn".into()); }
        return pdf::create(window, source_root, draft_root, tab_id, origin, &input, cancelled).await;
    }
    if Path::new(&input.file_path).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")) {
        return Err("invalid_arguments: call read_pdf first, then provide pdf.page and pdf.fingerprint".into());
    }
    let relative = relative_path(&input.file_path)?;
    if is_sidecar(&input.file_path) {
        return Err("invalid_path: comment snapshots are app-managed metadata".into());
    }
    let source = fs::canonicalize(source_root).map_err(|e| e.to_string())?;
    let draft = fs::canonicalize(draft_root).map_err(|e| e.to_string())?;
    crate::agent_workspace::validate_comment_scope(
        &window.service,
        source_root,
        draft_root,
        tab_id,
    )?;
    let clear_version = *window
        .service
        .comments
        .clear_versions
        .lock()
        .map_err(|_| "Comment reset lock unavailable")?
        .get(source.to_string_lossy().as_ref())
        .unwrap_or(&0);
    let reviewed = read_document(&draft, &relative)?;
    let original = read_document(&source, &relative)?;
    let result = authorized_comment(&original, &reviewed, &input, origin.clone(), *choice);
    if result
        .as_ref()
        .err()
        .is_some_and(|e| e.starts_with("review_choice_required:"))
    {
        // An unanswered, cancelled, skipped, or custom response grants no write permission.
        *choice = Some(ReviewChoice::Stop);
        let response = crate::agent_questions::ask(window, tab_id, &origin.session_id, source_root,
            json!({"question":"The reviewed text no longer matches. What should I do?","options":[
                {"label":"Update comments","description":"Reread the current text and revise unsaved feedback."},
                {"label":"Apply safe comments only","description":"Save only comments on unchanged, uniquely matching paragraphs."},
                {"label":"Discard unsaved comments","description":"Stop commenting. Already-saved comments stay."}
            ]}), cancelled).await?;
        let answer = response["answer"].as_str().unwrap_or("");
        *choice = Some(match answer {
            "Update comments" => ReviewChoice::Update,
            "Apply safe comments only" => ReviewChoice::SafeOnly,
            _ => ReviewChoice::Stop,
        });
        return Err(format!("review_decision: User answered {}. No comment was saved. {} Current source (read only): {}",
            json!(answer), match *choice {
                Some(ReviewChoice::Update) => "Read the current source now, reconsider the feedback, then retry with its exact complete reviewedParagraph. Do not ask the same question again.",
                Some(ReviewChoice::SafeOnly) => "Skip this affected finding; only submit remaining safely anchored comments.",
                _ => "Leave remaining comments unsaved. Follow any custom instruction in chat; no further comment saves are authorized this turn."
            }, source.join(&relative).display()));
    }
    let comment = result.map_err(|error| {
        format!(
            "{error}. Current source (read only): {}. Never edit source to force a match.",
            source.join(&relative).display()
        )
    })?;
    let state = &window.service.comments;
    let request_id = uuid::Uuid::new_v4().to_string();
    let _confirmation = ConfirmationGuard {
        pending: state.confirmations.clone(),
        request_id: request_id.clone(),
    };
    let (sender, receiver) = oneshot::channel();
    state
        .confirmations
        .lock()
        .await
        .insert(request_id.clone(), (window.label().into(), sender));
    let sent = window.emit("catalex-comment-check-source", json!({
        "requestId":request_id,"projectRoot":source_root,"filePath":input.file_path,
        "tabId":tab_id,"sessionId":origin.session_id,"sha1":format!("{:x}", Sha1::digest(original.as_bytes()))
    }));
    let confirmed = if sent.is_ok() {
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => false,
            result = tokio::time::timeout(std::time::Duration::from_secs(5), receiver) => matches!(result, Ok(Ok(true))),
        }
    } else {
        false
    };
    state.confirmations.lock().await.remove(&request_id);
    if !confirmed {
        return Err(
            "changed_text: source editor changed, session ended, or confirmation unavailable"
                .into(),
        );
    }
    let _guard = state.lock_project(source_root).await?;
    if cancelled.is_cancelled() {
        return Err("stale_session: agent turn ended".into());
    }
    crate::agent_workspace::validate_comment_scope(
        &window.service,
        source_root,
        draft_root,
        tab_id,
    )?;
    if read_document(&source, &relative)? != original
        || read_document(&draft, &relative)? != reviewed
    {
        return Err("changed_text: document changed while preparing the comment".into());
    }
    let current_clear = *state
        .clear_versions
        .lock()
        .map_err(|_| "Comment reset lock unavailable")?
        .get(source.to_string_lossy().as_ref())
        .unwrap_or(&0);
    if current_clear != clear_version {
        return Err(
            "comments_cleared: comments were deleted while this comment was being prepared".into(),
        );
    }
    let storage = comment_directory(&window.service, source_root)?;
    let sides = identity::load_for_write(&source, &storage, [(input.file_path.clone(), Some(comment.id.clone()))])?;
    let first = sides.iter().all(|side| side.files.get(&input.file_path).is_none_or(Vec::is_empty));
    let change = apply_patch_with_source(
        &source,
        &storage,
        &CommentPatch {
            file_path: input.file_path.clone(),
            id: comment.id.clone(),
            before: None,
            after: Some(comment.clone()),
        },
        true,
        None,
    )?;
    if let Err(error) = &window.service.emit(
        "catalex-comments-changed",
        json!({"projectRoot":source_root,"tabId":tab_id,"patch":change}),
    ) {
        eprintln!("[comments] saved, but could not notify editors: {error}");
    }
    checkpoint_first_comment(window, source_root, &input.file_path, first, true);
    Ok(json!({"status":"created","filePath":input.file_path,"comment":change.after}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn concurrent_comment_edits_compare_and_write_in_one_transaction() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.tex"), "Some passage here").unwrap();
        let storage = tempfile::tempdir().unwrap();
        let original = apply_patch(root.path(), storage.path(), &patch(None, Some(comment("same", false))), false).unwrap().after.unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let results = std::thread::scope(|threads| {
            let jobs: Vec<_> = ["First edit", "Second edit"].into_iter().map(|text| {
                let barrier = barrier.clone();
                let original = original.clone();
                let root = root.path(); let storage = storage.path();
                threads.spawn(move || {
                    let mut after = original.clone(); after.text = text.into();
                    barrier.wait();
                    apply_patch(root, storage, &patch(Some(original), Some(after)), false)
                })
            }).collect();
            jobs.into_iter().map(|job| job.join().unwrap()).collect::<Vec<_>>()
        });
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(results.iter().find_map(|r| r.as_ref().err()).unwrap().contains("comment_conflict:"));
    }

    #[tokio::test]
    async fn project_gates_serialize_aliases_without_blocking_other_projects() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let service = super::CommentService::default();
        let guard = service.lock_project(first.path()).await.unwrap();
        assert!(service.project_gate(first.path().join(".")).unwrap().try_lock_owned().is_err());
        assert!(service.project_gate(second.path()).unwrap().try_lock_owned().is_ok());
        #[cfg(unix)] {
            let aliases = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(first.path(), aliases.path().join("alias")).unwrap();
            assert!(service.project_gate(aliases.path().join("alias")).unwrap().try_lock_owned().is_err());
        }
        drop(guard);
        assert!(service.project_gate(first.path()).unwrap().try_lock_owned().is_ok());
    }

    use super::*;
    use tempfile::TempDir;

    #[test]
    fn first_comment_counts_both_authors_and_ignores_edits_and_deletes() {
        let root = TempDir::new().unwrap();
        let storage = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let new = patch(None, Some(comment("first", true)));
        assert!(first_comment(root.path(), storage.path(), &new).unwrap());
        let saved = apply_patch(root.path(), storage.path(), &new, true).unwrap();
        assert!(!first_comment(root.path(), storage.path(), &patch(None, Some(comment("second", false)))).unwrap());
        assert!(!first_comment(root.path(), storage.path(), &patch(saved.after.clone(), saved.after.clone())).unwrap());
        assert!(!first_comment(root.path(), storage.path(), &patch(saved.after.clone(), None)).unwrap());
        apply_patch(root.path(), storage.path(), &patch(saved.after, None), false).unwrap();
        assert!(first_comment(root.path(), storage.path(), &new).unwrap());
    }

    #[test]
    fn management_edits_follow_explicit_rename_and_merge_independent_changes() {
        let project = TempDir::new().unwrap();
        let root = fs::canonicalize(project.path()).unwrap();
        let storage = TempDir::new().unwrap();
        fs::write(root.join("main.tex"), "text").unwrap();
        let original = apply_patch(&root, storage.path(), &patch(None, Some(comment("one", true))), true).unwrap().after.unwrap();
        let changes = [CommentPathChange { old_path: "main.tex".into(), new_path: "renamed.tex".into(), folder: false }];
        paths::prepare(&root, storage.path(), &changes).unwrap();
        fs::rename(root.join("main.tex"), root.join("renamed.tex")).unwrap();
        let (listed, _) = manage_comment(&root, storage.path(), "list_comments", json!({"filePath":"renamed.tex"})).unwrap();
        assert_eq!(listed["comments"][0]["comment"]["id"], "one");
        let (_, edit) = manage_comment(&root, storage.path(), "edit_comment", json!({"filePath":"renamed.tex","id":"one","revision":comment_revision(&original),"text":"Edited after rename"})).unwrap();
        assert_eq!(edit.unwrap().file_path, "renamed.tex");
        // A stale old-path resolution changes only its field, preserving the edit.
        let mut resolved = original.clone(); resolved.resolved = true;
        let merged = apply_patch(&root, storage.path(), &patch(Some(original), Some(resolved)), false).unwrap();
        let after = merged.after.unwrap();
        assert_eq!(merged.file_path, "renamed.tex");
        assert_eq!(after.text, "Edited after rename"); assert!(after.resolved);
        assert_eq!(after.origin.unwrap().provider, "codex");
    }

    #[test]
    fn history_restores_deleted_comments_and_replays_resolve_without_losing_identity() {
        for agent in [false, true] {
            let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
            let original = apply_patch(
                root.path(),
                root.path(),
                &patch(None, Some(comment("one", agent))),
                true,
            )
            .unwrap()
            .after
            .unwrap();
            let (_, deleted) = manage_comment(
                root.path(),
                root.path(),
                "delete_comment",
                json!({
                    "filePath":"main.tex", "id":"one", "revision":comment_revision(&original)
                }),
            )
            .unwrap();
            let deleted = deleted.unwrap();
            let restored = replay_patch(root.path(), root.path(), patch(None, deleted.before))
                .unwrap()
                .after
                .unwrap();
            assert_eq!(restored, original);
            let mut resolved = original.clone();
            resolved.resolved = true;
            replay_patch(
                root.path(),
                root.path(),
                patch(Some(original.clone()), Some(resolved.clone())),
            )
            .unwrap();
            replay_patch(
                root.path(),
                root.path(),
                patch(Some(resolved), Some(original.clone())),
            )
            .unwrap();
            assert_eq!(
                read_author_comments(root.path(), root.path(), agent).unwrap()["main.tex"],
                vec![original]
            );
            assert_eq!(
                read_author_snapshot(root.path(), root.path(), agent)
                    .unwrap()
                    .counter,
                1
            );
        }
    }

    #[test]
    fn history_rejects_stale_content_and_attribution_changes() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let original = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("one", true))),
            true,
        )
        .unwrap()
        .after
        .unwrap();
        let mut edited = original.clone();
        edited.text = "Newer feedback".into();
        replay_patch(
            root.path(),
            root.path(),
            patch(Some(original.clone()), Some(edited.clone())),
        )
        .unwrap();
        assert!(replay_patch(
            root.path(),
            root.path(),
            patch(Some(original.clone()), None)
        )
        .unwrap_err()
        .contains("comment_conflict"));
        let mut forged = edited.clone();
        forged.origin.as_mut().unwrap().session_id = "someone-else".into();
        assert!(replay_patch(
            root.path(),
            root.path(),
            patch(Some(edited.clone()), Some(forged))
        )
        .is_err());
        assert_eq!(
            read_author_comments(root.path(), root.path(), true).unwrap()["main.tex"],
            vec![edited]
        );
    }

    #[test]
    fn history_replays_deliberate_range_changes() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let original = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("one", true))),
            true,
        )
        .unwrap()
        .after
        .unwrap();
        let mut resized = original.clone();
        resized.to += 8;
        apply_patch(
            root.path(),
            root.path(),
            &patch(Some(original.clone()), Some(resized.clone())),
            false,
        )
        .unwrap();
        let undone = replay_patch(
            root.path(),
            root.path(),
            patch(Some(resized.clone()), Some(original.clone())),
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!(undone, original);
        let redone = replay_patch(
            root.path(),
            root.path(),
            patch(Some(original), Some(resized.clone())),
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!(redone, resized);
    }

    #[test]
    fn history_preserves_anchors_moved_by_text_edits() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let original = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("one", true))),
            true,
        )
        .unwrap()
        .after
        .unwrap();
        let mut edited = original.clone();
        edited.text = "Revised".into();
        replay_patch(
            root.path(),
            root.path(),
            patch(Some(original.clone()), Some(edited.clone())),
        )
        .unwrap();
        let mut moved = edited.clone();
        moved.from = 10;
        moved.to = 14;
        moved.line = 2;
        apply_patch(
            root.path(),
            root.path(),
            &patch(Some(edited.clone()), Some(moved.clone())),
            false,
        )
        .unwrap();
        let undone = replay_patch(
            root.path(),
            root.path(),
            patch(Some(edited), Some(original.clone())),
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!((undone.from, undone.to, undone.line), (10, 14, 2));
        assert_eq!(undone.text, original.text);
        assert_eq!(undone.origin, moved.origin);
    }

    fn origin() -> AgentOrigin {
        AgentOrigin {
            provider: "codex".into(),
            session_id: "session-1".into(),
            model: Some("gpt-5.4".into()),
            thinking_effort: Some("high".into()),
        }
    }

    #[test]
    fn agent_management_preserves_metadata_and_rejects_stale_changes() {
        for agent in [false, true] {
            let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
            let original = apply_patch(
                root.path(),
                root.path(),
                &patch(None, Some(comment("one", agent))),
                true,
            )
            .unwrap()
            .after
            .unwrap();
            let (listed, _) = manage_comment(
                root.path(),
                root.path(),
                "list_comments",
                json!({"filePath":"main.tex"}),
            )
            .unwrap();
            let revision = listed["comments"][0]["revision"].as_str().unwrap();
            let args = json!({"filePath":"main.tex","id":"one","revision":revision,"text":"Revised feedback"});
            let (_, change) =
                manage_comment(root.path(), root.path(), "edit_comment", args.clone()).unwrap();
            let edited = change.unwrap().after.unwrap();
            let mut expected = original.clone();
            expected.text = "Revised feedback".into();
            assert_eq!(edited, expected);
            assert!(
                manage_comment(root.path(), root.path(), "edit_comment", args)
                    .unwrap_err()
                    .contains("comment_conflict")
            );
            let (_, change) = manage_comment(
                root.path(),
                root.path(),
                "resolve_comment",
                json!({"filePath":"main.tex","id":"one","revision":comment_revision(&edited)}),
            )
            .unwrap();
            let resolved = change.unwrap().after.unwrap();
            assert!(resolved.resolved);
            assert!(manage_comment(
                root.path(),
                root.path(),
                "delete_comment",
                json!({"filePath":"main.tex","id":"one","revision":comment_revision(&edited)})
            )
            .is_err());
            manage_comment(
                root.path(),
                root.path(),
                "delete_comment",
                json!({"filePath":"main.tex","id":"one","revision":comment_revision(&resolved)}),
            )
            .unwrap();
            assert!(read_author_comments(root.path(), root.path(), agent)
                .unwrap()
                .is_empty());
            assert_eq!(
                read_author_snapshot(root.path(), root.path(), agent)
                    .unwrap()
                    .counter,
                1
            );
        }
    }

    #[test]
    fn agents_can_reopen_resolved_comments_with_revision_checks() {
        for agent in [false, true] {
            let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
            let original = apply_patch(
                root.path(),
                root.path(),
                &patch(None, Some(comment("one", agent))),
                true,
            )
            .unwrap()
            .after
            .unwrap();
            let (_, change) = manage_comment(root.path(), root.path(), "resolve_comment", json!({
                "filePath":"main.tex", "id":"one", "revision":comment_revision(&original), "resolved":true
            })).unwrap();
            let resolved = change.unwrap().after.unwrap();
            let (listed, _) = manage_comment(
                root.path(),
                root.path(),
                "list_comments",
                json!({"filePath":"main.tex"}),
            )
            .unwrap();
            assert_eq!(listed["comments"][0]["comment"]["resolved"], true);
            assert!(manage_comment(root.path(), root.path(), "resolve_comment", json!({
                "filePath":"main.tex", "id":"one", "revision":comment_revision(&original), "resolved":false
            })).unwrap_err().contains("comment_conflict"));
            let (result, change) = manage_comment(root.path(), root.path(), "resolve_comment", json!({
                "filePath":"main.tex", "id":"one", "revision":listed["comments"][0]["revision"], "resolved":false
            })).unwrap();
            assert_eq!(result["status"], "reopened");
            let change = change.unwrap();
            assert_eq!(change.before, Some(resolved.clone()));
            assert_eq!(change.after, Some(original.clone()));
            assert_eq!(
                read_author_comments(root.path(), root.path(), agent).unwrap()["main.tex"],
                vec![original.clone()]
            );
            // Reopening joins the same reversible status-change timeline.
            replay_patch(
                root.path(),
                root.path(),
                patch(Some(original.clone()), Some(resolved.clone())),
            )
            .unwrap();
            replay_patch(
                root.path(),
                root.path(),
                patch(Some(resolved), Some(original.clone())),
            )
            .unwrap();
            assert_eq!(
                read_author_comments(root.path(), root.path(), agent).unwrap()["main.tex"],
                vec![original]
            );
        }
    }

    #[test]
    fn agent_management_rejects_bad_paths_missing_ids_and_invalid_edits() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let original = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("one", true))),
            true,
        )
        .unwrap()
        .after
        .unwrap();
        for args in [
            json!({"filePath":"../main.tex"}),
            json!({"filePath":"human.json"}),
            json!({"filePath":"main.tex","id":"missing","revision":"x","text":"new"}),
            json!({"filePath":"main.tex","id":"one","text":"new"}),
            json!({"filePath":"main.tex","id":"one","revision":comment_revision(&original),"text":"  "}),
            json!({"filePath":"main.tex","id":"one","revision":comment_revision(&original),"text":"new","from":42}),
            json!({"filePath":"main.tex","id":"one","revision":comment_revision(&original),"text":"new","resolved":false}),
        ] {
            assert!(manage_comment(root.path(), root.path(), "edit_comment", args).is_err());
        }
        assert_eq!(
            read_author_comments(root.path(), root.path(), true).unwrap()["main.tex"],
            vec![original]
        );
    }

    #[test]
    fn origin_metadata_allows_unspecified_model() {
        let value = serde_json::to_value(origin()).unwrap();
        assert_eq!(value["model"], "gpt-5.4");
        assert_eq!(value["thinkingEffort"], "high");
        assert_eq!(
            serde_json::from_value::<AgentOrigin>(value).unwrap(),
            origin()
        );
        let unspecified: AgentOrigin =
            serde_json::from_value(json!({"provider":"codex","sessionId":"old"})).unwrap();
        assert_eq!(unspecified.model, None);
        assert_eq!(unspecified.thinking_effort, None);
    }
    #[test]
    fn obsolete_reply_fields_are_not_a_supported_comment_format() {
        let mut value = serde_json::to_value(comment("current", false)).unwrap();
        value["replies"] = json!([]);
        assert!(serde_json::from_value::<Comment>(value).is_err());
    }

    fn comment(id: &str, agent: bool) -> Comment {
        Comment {
            pdf: None,
            id: id.into(),
            number: None,
            anchor_revision: None,
            position_reset: false,
            removed_anchor: None,
            from: 0,
            to: 4,
            line: 1,
            text: "Clarify this".into(),
            created_at: Some("2026-09-09T00:00:00Z".into()),
            resolved: false,
            proposal: None,
            origin: agent.then(origin),
        }
    }
    fn patch(before: Option<Comment>, after: Option<Comment>) -> CommentPatch {
        CommentPatch {
            file_path: "main.tex".into(),
            id: before.as_ref().or(after.as_ref()).unwrap().id.clone(),
            before,
            after,
        }
    }
    fn input(passage: &str, line_hint: Option<usize>) -> CreateComment {
        CreateComment {
            pdf: None,
            file_path: "main.tex".into(),
            passage: passage.into(),
            line_hint,
            text: "Clarify this".into(),
            reviewed_paragraph: None,
        }
    }

    #[test]
    fn pdf_comments_persist_geometry_and_disconnect_on_binary_replacement() {
        let root = TempDir::new().unwrap();
        let storage = TempDir::new().unwrap();
        let bytes = b"%PDF-1.7\noriginal binary \xff\x00";
        fs::write(root.path().join("paper.pdf"), bytes).unwrap();
        let mut annotation = comment("pdf-one", false);
        annotation.from = 0;
        annotation.to = 0;
        annotation.line = 2;
        annotation.pdf = Some(PdfCommentAnchor {
            fingerprint: format!("{:x}", Sha1::digest(bytes)), text: "Selected passage".into(),
            regions: vec![PdfCommentRegion { page: 2, x: 40.0, y: 80.0, width: 90.0, height: 12.0 }],
        });
        let creation = CommentPatch { file_path: "paper.pdf".into(), id: annotation.id.clone(), before: None, after: Some(annotation.clone()) };
        let saved = apply_patch(root.path(), storage.path(), &creation, false).unwrap().after.unwrap();
        let loaded = read_author_snapshot(root.path(), storage.path(), false).unwrap();
        assert_eq!(loaded.files["paper.pdf"][0].pdf, annotation.pdf);
        let mut changed = saved.clone(); changed.text = "Updated comment".into();
        let edit = CommentPatch { before: Some(saved), after: Some(changed.clone()), ..creation.clone() };
        apply_patch(root.path(), storage.path(), &edit, false).unwrap();
        assert_eq!(read_author_comments(root.path(), storage.path(), false).unwrap()["paper.pdf"][0].text, "Updated comment");
        let mut resized = changed.clone();
        resized.line = 1;
        let anchor = resized.pdf.as_mut().unwrap();
        anchor.text = "Resized passage".into();
        anchor.regions[0].page = 1;
        let resize = CommentPatch {
            before: Some(changed.clone()),
            after: Some(resized.clone()),
            ..creation.clone()
        };
        apply_patch(root.path(), storage.path(), &resize, false).unwrap();
        let undo_resize = CommentPatch {
            before: Some(resized.clone()),
            after: Some(changed.clone()),
            ..creation.clone()
        };
        assert_eq!(
            replay_patch(root.path(), storage.path(), undo_resize.clone()).unwrap().after,
            Some(changed)
        );
        assert_eq!(
            replay_patch(root.path(), storage.path(), resize).unwrap().after,
            Some(resized)
        );
        replay_patch(root.path(), storage.path(), undo_resize).unwrap();
        fs::write(root.path().join("paper.pdf"), b"%PDF-1.7\nreplacement").unwrap();
        let snapshot = identity::load_for_write(root.path(), storage.path(), [("paper.pdf".into(), None)]).unwrap();
        assert!(!snapshot[0].files.contains_key("paper.pdf"));
        assert_eq!(snapshot[0].orphaned["paper.pdf"][0].pdf, annotation.pdf);
        assert!(apply_patch(root.path(), storage.path(), &creation, false).is_err());
        // A new comment made against the stale viewer must not bind to new bytes.
        let stale = CommentPatch { id: "stale".into(), after: Some(Comment { id: "stale".into(), ..annotation }), ..creation };
        assert!(apply_patch(root.path(), storage.path(), &stale, false).unwrap_err().contains("PDF changed"));
    }

    #[test]
    fn local_storage_ignores_project_json_and_resets_each_author_independently() {
        let project = TempDir::new().unwrap();
        let local = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "text").unwrap();
        fs::write(project.path().join("comments.json"), "invalid old JSON").unwrap();
        fs::write(
            project.path().join("comments-agents.json"),
            "ignored old agent comments",
        )
        .unwrap();
        assert!(read_author_comments(project.path(), local.path(), false)
            .unwrap()
            .is_empty());
        assert!(read_author_comments(project.path(), local.path(), true)
            .unwrap()
            .is_empty());
        apply_patch(
            project.path(),
            local.path(),
            &patch(None, Some(comment("human", false))),
            false,
        )
        .unwrap();
        apply_patch(
            project.path(),
            local.path(),
            &patch(None, Some(comment("agent", true))),
            true,
        )
        .unwrap();
        let agent_bytes = test_read(local.path().join("agent.json")).unwrap();
        clear_author(local.path(), false).unwrap();
        clear_author(local.path(), false).unwrap();
        assert!(!local.path().join("human.json").exists());
        assert_eq!(
            read_author_snapshot(project.path(), local.path(), false)
                .unwrap()
                .counter,
            0
        );
        assert_eq!(
            test_read(local.path().join("agent.json")).unwrap(),
            agent_bytes
        );
        test_write(local.path().join("agent.json"), "damaged JSON").unwrap();
        clear_author(local.path(), true).unwrap();
        assert!(!local.path().join("agent.json").exists());
        assert_eq!(
            fs::read_to_string(project.path().join("comments.json")).unwrap(),
            "invalid old JSON"
        );
        assert_eq!(
            fs::read_to_string(project.path().join("comments-agents.json")).unwrap(),
            "ignored old agent comments"
        );
    }

    #[test]
    fn anchor_sources_are_atomic_pruned_and_preserved_on_failed_save() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let first = apply_patch_with_source(
            root.path(),
            root.path(),
            &patch(None, Some(comment("one", false))),
            false,
            Some("text"),
        )
        .unwrap()
        .after
        .unwrap();
        let snapshot = read_author_snapshot(root.path(), root.path(), false).unwrap();
        assert_eq!(
            snapshot.sources[first.anchor_revision.as_ref().unwrap()],
            "text"
        );
        let mut next = first.clone();
        next.from = 1;
        next.to = 5;
        let saved = apply_patch_with_source(
            root.path(),
            root.path(),
            &patch(Some(first), Some(next)),
            false,
            Some(" text"),
        )
        .unwrap()
        .after
        .unwrap();
        let snapshot = read_author_snapshot(root.path(), root.path(), false).unwrap();
        // Keep the last disk version as well as the unsaved anchor version.
        assert_eq!(snapshot.sources.len(), 2);
        assert_eq!(
            snapshot.sources[saved.anchor_revision.as_ref().unwrap()],
            " text"
        );
        let bytes = test_read(root.path().join("human.json")).unwrap();
        let huge = "x".repeat(MAX_BYTES as usize + 1);
        assert!(apply_patch_with_source(
            root.path(),
            root.path(),
            &patch(Some(saved.clone()), Some(saved)),
            false,
            Some(&huge)
        )
        .is_err());
        assert_eq!(test_read(root.path().join("human.json")).unwrap(), bytes);
    }

    #[test]
    fn routine_writes_reconcile_only_the_affected_file() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        fs::write(root.path().join("other.tex"), "text").unwrap();
        fs::write(root.path().join("without-comments.tex"), [0xff]).unwrap();
        assert!(identity::load_for_write(
            root.path(),
            root.path(),
            [("without-comments.tex".into(), None)]
        )
        .is_ok());

        let main = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("main", false))),
            false,
        )
        .unwrap()
        .after
        .unwrap();
        let mut other = patch(None, Some(comment("other", false)));
        other.file_path = "other.tex".into();
        apply_patch(root.path(), root.path(), &other, false).unwrap();
        fs::remove_file(root.path().join("other.tex")).unwrap();
        let mut after = main.clone();
        after.from += 1;
        after.to += 1;
        apply_anchor_batch(
            root.path(),
            root.path(),
            &[patch(Some(main), Some(after))],
            " text",
        )
        .unwrap();
        // A routine main.tex save must not even reconcile another missing file.
        let saved = read_author_snapshot(root.path(), root.path(), false).unwrap();
        assert!(saved.files.contains_key("other.tex"));
        assert!(saved.orphaned.is_empty());
        paths::reconcile(root.path(), root.path()).unwrap();
        let saved = read_author_snapshot(root.path(), root.path(), false).unwrap();
        assert!(saved.orphaned.contains_key("other.tex"));
        // The affected file is still checked: queued content edits preserve a
        // successful external anchor recovery rather than restoring stale offsets.
        fs::write(root.path().join("main.tex"), " text").unwrap();
        let before = saved.files["main.tex"][0].clone();
        fs::write(root.path().join("main.tex"), "prefix text").unwrap();
        let mut after = before.clone();
        after.text = "Updated feedback".into();
        let saved = apply_patch(
            root.path(),
            root.path(),
            &patch(Some(before), Some(after)),
            false,
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!(saved.from, 7);
        assert_eq!(saved.to, 11);
        assert_eq!(saved.text, "Updated feedback");
    }

    #[test]
    fn recovered_source_supersedes_old_anchor_saves_but_preserves_feedback_edits() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let original = apply_patch_with_source(root.path(), root.path(), &patch(None, Some(comment("H-1", false))), false, Some("text")).unwrap().after.unwrap();
        let source = "completely unrelated manuscript";
        fs::write(root.path().join("main.tex"), source).unwrap();
        paths::reconcile(root.path(), root.path()).unwrap();
        let current = read_author_snapshot(root.path(), root.path(), false).unwrap().files["main.tex"][0].clone();
        assert!(current.position_reset);
        let mut obsolete = original.clone();
        obsolete.from = 1;
        obsolete.to = 5;
        assert!(apply_patch_with_source(root.path(), root.path(), &patch(Some(original.clone()), Some(obsolete.clone())), false, Some(source)).unwrap_err().starts_with("comment_anchor_superseded:"));
        let mut newer = current.clone();
        newer.from = 2;
        newer.to = 4;
        newer.position_reset = false;
        apply_patch_with_source(root.path(), root.path(), &patch(Some(current.clone()), Some(newer)), false, Some(source)).unwrap();
        let mut competing = current.clone();
        competing.from = 3;
        competing.to = 6;
        assert!(apply_patch_with_source(root.path(), root.path(), &patch(Some(current), Some(competing)), false, Some(source)).unwrap_err().starts_with("comment_conflict:"));
        let mut feedback = original.clone();
        feedback.text = "Retain my feedback draft".into();
        let saved = apply_patch_with_source(root.path(), root.path(), &patch(Some(original), Some(feedback)), false, Some(source)).unwrap().after.unwrap();
        assert_eq!(saved.text, "Retain my feedback draft");
        assert_eq!((saved.from, saved.to), (2, 4));
        assert!(!saved.position_reset);
    }

    #[test]
    fn fast_passage_search_preserves_overlapping_and_unicode_matches() {
        assert!(passage_offset("aaa", "aa", None)
            .unwrap_err()
            .starts_with("ambiguous_passage:"));
        assert!(passage_offset("😀😀😀", "😀😀", None)
            .unwrap_err()
            .starts_with("ambiguous_passage:"));
        assert_eq!(passage_offset("x😀y", "😀", None).unwrap(), 1);
        assert_eq!(passage_offset("same\nsame", "same", Some(2)).unwrap(), 5);
    }

    #[test]
    fn grouped_anchors_preserve_both_authors_and_roll_back_conflicts() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let mut originals = Vec::new();
        for (id, agent) in [("one", false), ("two", true)] {
            originals.push(
                apply_patch_with_source(
                    root.path(),
                    root.path(),
                    &patch(None, Some(comment(id, agent))),
                    agent,
                    Some("text"),
                )
                .unwrap()
                .after
                .unwrap(),
            );
        }
        let updates: Vec<_> = originals
            .iter()
            .map(|before| {
                let mut after = before.clone();
                after.from += 1;
                after.to += 1;
                patch(Some(before.clone()), Some(after))
            })
            .collect();
        // A later conflict must not persist an earlier comment's shifted anchor.
        let mut conflict = updates.clone();
        conflict[1].before.as_mut().unwrap().from = 2;
        assert!(apply_anchor_batch(root.path(), root.path(), &conflict, " text").is_err());
        for (index, agent) in [false, true].into_iter().enumerate() {
            assert_eq!(
                read_author_snapshot(root.path(), root.path(), agent)
                    .unwrap()
                    .files["main.tex"],
                vec![originals[index].clone()]
            );
        }
        let saved = apply_anchor_batch(root.path(), root.path(), &updates, " text").unwrap();
        assert_eq!(saved["patches"].as_array().unwrap().len(), 2);
        // A lost acknowledgement can replay the whole batch safely.
        apply_anchor_batch(root.path(), root.path(), &updates, " text").unwrap();
        for (index, agent) in [false, true].into_iter().enumerate() {
            let side = read_author_snapshot(root.path(), root.path(), agent).unwrap();
            let current = &side.files["main.tex"][0];
            assert_eq!(current.from, 1);
            assert_eq!(current.to, 5);
            assert_eq!(current.number, originals[index].number);
            assert_eq!(current.origin, originals[index].origin);
            assert_eq!(
                side.sources[current.anchor_revision.as_ref().unwrap()],
                " text"
            );
            assert_eq!(side.sources.len(), 2);
        }
        // A concurrent content edit is independent of anchor-only updates.
        let mut side = read_author_snapshot(root.path(), root.path(), false).unwrap();
        side.files.get_mut("main.tex").unwrap()[0].text = "Newer feedback".into();
        write_author_snapshot(root.path(), false, &side).unwrap();
        let merged = apply_anchor_batch(root.path(), root.path(), &updates, " text").unwrap();
        assert_eq!(merged["patches"][0]["after"]["text"], "Newer feedback");
        let mut text_edit = updates.clone();
        text_edit[0].after.as_mut().unwrap().text = "Changed feedback".into();
        assert!(apply_anchor_batch(root.path(), root.path(), &text_edit, " text").is_err());
        fs::rename(root.path().join("main.tex"), root.path().join("moved.tex")).unwrap();
        let detached = apply_anchor_batch(root.path(), root.path(), &updates, " text").unwrap();
        assert_eq!(detached["orphanedIds"].as_array().unwrap().len(), 2);
        assert!(detached["patches"].as_array().unwrap().is_empty());
        assert_eq!(
            identity::read_both(root.path(), root.path())
                .unwrap()
                .iter()
                .map(|side| side.orphaned.values().map(Vec::len).sum::<usize>())
                .sum::<usize>(),
            2
        );
    }

    #[test]
    fn invalid_offsets_recover_without_breaking_other_comments() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "a\n😀z").unwrap();
        let mut bad = serde_json::to_value(comment("bad", false)).unwrap();
        bad["from"] = json!(3);
        bad["to"] = json!(-1);
        test_write(
            root.path().join("human.json"),
            serde_json::to_vec(
                &json!({"version":1,"files":{"main.tex":[bad, comment("good",false)]}}),
            )
            .unwrap(),
        )
        .unwrap();
        let snapshot = read_author_snapshot(
            &fs::canonicalize(root.path()).unwrap(),
            &fs::canonicalize(root.path()).unwrap(),
            false,
        )
        .unwrap();
        let bad = &snapshot.files["main.tex"][0];
        assert_eq!((bad.from, bad.to, bad.line), (2, 2, 2));
        assert!(bad.position_reset);
        assert_eq!(snapshot.files["main.tex"][1].to, 4);
    }

    #[tokio::test]
    async fn cancelled_confirmation_drops_its_pending_sender() {
        let pending = Arc::new(Mutex::new(BTreeMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending
            .lock()
            .await
            .insert("request".into(), ("window".into(), sender));
        drop(ConfirmationGuard {
            pending: pending.clone(),
            request_id: "request".into(),
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), receiver)
                .await
                .unwrap()
                .is_err()
        );
        assert!(pending.lock().await.is_empty());
    }

    #[test]
    fn exact_passages_use_utf16_ranges_and_end_lines() {
        let source = "😀 Intro\nA proof\nLast";
        let result = anchored_comment(source, source, &input("A proof\n", None), origin()).unwrap();
        assert_eq!((result.from, result.to, result.line), (9, 17, 2));
        assert_eq!(result.origin, Some(origin()));
        assert!(result.created_at.is_some());
    }

    #[test]
    fn missing_ambiguous_overlapping_and_changed_passages_reject() {
        for (source, passage, hint, expected) in [
            ("one", "absent", None, "missing_passage"),
            ("same\nsame", "same", None, "ambiguous_passage"),
            ("aaa", "aa", None, "ambiguous_passage"),
            ("same same", "same", Some(1), "ambiguous_passage"),
            ("same", "same", Some(2), "missing_passage"),
            ("same", "", None, "invalid_passage"),
        ] {
            assert!(
                anchored_comment(source, source, &input(passage, hint), origin())
                    .unwrap_err()
                    .starts_with(expected)
            );
        }
        let matched = anchored_comment(
            "same\nsame",
            "same\nsame",
            &input("same", Some(2)),
            origin(),
        )
        .unwrap();
        assert_eq!((matched.from, matched.line), (5, 2));
        assert!(anchored_comment(
            "edited elsewhere\nsame",
            "original\nsame",
            &input("same", None),
            origin()
        )
        .unwrap_err()
        .starts_with("changed_text"));
    }

    #[test]
    fn unrelated_edits_and_moved_paragraphs_reanchor_with_utf16_offsets() {
        let draft = "Intro\n\n😀 A proof\nSecond line\n\nEnd";
        for source in [
            "Longer intro\n\n😀 A proof\nSecond line\n\nEnd",
            "End\n\n😀 A proof\nSecond line",
        ] {
            let c = anchored_comment(source, draft, &input("A proof", Some(3)), origin()).unwrap();
            let offset = source.find("A proof").unwrap();
            assert_eq!(c.from, source[..offset].encode_utf16().count());
            assert_eq!(c.to - c.from, 7);
            assert_eq!(c.line, 3);
        }
    }

    #[test]
    fn changed_or_duplicated_paragraphs_do_not_save_even_with_a_hint() {
        let draft = "Intro\n\nA proof\nDetails\n\nEnd";
        for source in [
            "Intro\n\nA proof\nEdited details\n\nEnd",
            "Intro\n\nA proof\nDetails\n\nA proof\nDetails",
            "Intro\n\nPrefix A proof\nDetails\n\nEnd",
            "Intro\n\nA proof\nDetails extended\n\nEnd",
        ] {
            assert!(anchored_comment(source, draft, &input("A proof", Some(3)), origin()).is_err());
        }
    }


    #[test]
    fn agent_raw_crlf_passages_use_editor_coordinates() {
        let source = "😀 Intro\n\nOne\n\nTwo\n\nEnd";
        let comment = authorized_comment(source, source, &input("One\r\n\r\nTwo", None), origin(), None).unwrap();
        assert_eq!(comment.from, 10);
        assert_eq!(comment.to, 18);
    }
    #[test]
    fn whitespace_boundaries_and_multi_paragraph_passages_are_exact() {
        let draft = "Intro\r\n \t\r\nOne\r\n\r\nTwo\r\n\r\nEnd";
        let source = draft.replace("Intro", "Edited intro 😀");
        let c = anchored_comment(&source, draft, &input("One\r\n\r\nTwo", None), origin()).unwrap();
        assert_eq!(
            c.from,
            source[..source.find("One").unwrap()].encode_utf16().count()
        );
        assert!(anchored_comment(
            &source.replace("Two", "Changed"),
            draft,
            &input("One\r\n\r\nTwo", None),
            origin()
        )
        .is_err());
    }

    #[test]
    fn explicit_rereview_requires_a_complete_unique_current_paragraph() {
        let source = "Intro\n\nA new proof\nCurrent details\n\nEnd";
        let mut args = input("new proof", None);
        args.reviewed_paragraph = Some("A new proof\nCurrent details".into());
        assert!(anchored_comment(source, "old draft", &args, origin()).is_ok());
        args.reviewed_paragraph = Some("new proof".into());
        assert!(anchored_comment(source, "old draft", &args, origin()).is_err());
        args.reviewed_paragraph = Some("A new proof\nCurrent details".into());
        assert!(anchored_comment(
            &format!("{source}\n\nA new proof\nCurrent details"),
            "old draft",
            &args,
            origin()
        )
        .is_err());
        assert!(anchored_comment(
            &source.replace("Current", "Edited"),
            "old draft",
            &args,
            origin()
        )
        .is_err());
    }

    #[test]
    fn changed_review_retry_cannot_skip_the_user_choice() {
        let draft = "Original claim.";
        let source = "Original claim. typing typing.";
        let mut args = input(draft, None);
        assert!(authorized_comment(source, draft, &args, origin(), None)
            .unwrap_err()
            .starts_with("review_choice_required:"));
        args.passage = source.into();
        args.reviewed_paragraph = Some(source.into());
        assert!(authorized_comment(source, draft, &args, origin(), None)
            .unwrap_err()
            .starts_with("review_choice_required:"));
        assert!(
            authorized_comment(source, draft, &args, origin(), Some(ReviewChoice::Update)).is_ok()
        );
        assert!(
            authorized_comment(source, draft, &args, origin(), Some(ReviewChoice::SafeOnly))
                .is_err()
        );
        assert!(authorized_comment(
            draft,
            draft,
            &input(draft, None),
            origin(),
            Some(ReviewChoice::Stop)
        )
        .is_err());
    }

    #[test]
    fn unrelated_changes_do_not_require_a_choice() {
        let draft = "Intro\n\nUnchanged claim.";
        let source = "Updated intro\n\nUnchanged claim.";
        for choice in [None, Some(ReviewChoice::SafeOnly)] {
            assert!(authorized_comment(
                source,
                draft,
                &input("Unchanged claim.", None),
                origin(),
                choice
            )
            .is_ok());
        }
    }

    #[test]
    fn incorrect_line_hint_is_not_a_changed_text_decision() {
        let source = "Intro\n\nA claim.";
        let error = authorized_comment(source, source, &input("A claim.", Some(1)), origin(), None)
            .unwrap_err();
        assert!(error.starts_with("missing_passage:"));
        assert!(
            authorized_comment(source, source, &input("A claim.", Some(3)), origin(), None).is_ok()
        );
    }

    #[test]
    fn rereview_with_omitted_section_line_reports_incomplete_context_and_can_recover() {
        let source = "Earlier 😀\n\n\\section{Introduction}\nA duplicated claim. typing typing.\n\nNext paragraph";
        let mut args = input("typing typing.", Some(4));
        args.reviewed_paragraph = Some("A duplicated claim. typing typing.".into());
        let error = anchored_comment(source, "old draft", &args, origin()).unwrap_err();
        assert!(error.starts_with("incomplete_paragraph:"), "{error}");
        let context: String =
            serde_json::from_str(error.split("required reviewedParagraph: ").nth(1).unwrap())
                .unwrap();
        assert_eq!(
            context,
            "\\section{Introduction}\nA duplicated claim. typing typing."
        );
        args.reviewed_paragraph = Some(context);
        let comment = anchored_comment(source, "old draft", &args, origin()).unwrap();
        assert_eq!(
            comment.from,
            source[..source.find("typing typing.").unwrap()]
                .encode_utf16()
                .count()
        );
    }

    #[test]
    fn rejects_unsafe_paths_and_escaped_documents() {
        for path in [
            "",
            "/main.tex",
            "../main.tex",
            "a/../b",
            "a/./b",
            "a//b",
            "C:\\main.tex",
            ".git/config",
        ] {
            assert!(relative_path(path).is_err(), "{path}");
        }
        assert!(relative_path("chapters/intro.tex").is_ok());
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("main.tex"), "outside").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("main.tex"),
                root.path().join("main.tex"),
            )
            .unwrap();
            assert!(
                read_document(&root.path().canonicalize().unwrap(), Path::new("main.tex")).is_err()
            );
        }
    }

    #[test]
    fn human_and_agent_files_are_separate_and_provenance_survives_edits() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let human = comment("human", false);
        let agent = comment("agent", true);
        let human = apply_patch(root.path(), root.path(), &patch(None, Some(human)), false)
            .unwrap()
            .after
            .unwrap();
        let human_bytes = test_read(root.path().join("human.json")).unwrap();
        let agent = apply_patch(root.path(), root.path(), &patch(None, Some(agent)), true)
            .unwrap()
            .after
            .unwrap();
        let mut edited = agent.clone();
        edited.text = "Human edit of agent comment".into();
        apply_patch(
            root.path(),
            root.path(),
            &patch(Some(agent), Some(edited.clone())),
            false,
        )
        .unwrap();
        assert_eq!(
            read_author_comments(root.path(), root.path(), true).unwrap()["main.tex"],
            vec![edited.clone()]
        );
        assert_eq!(
            test_read(root.path().join("human.json")).unwrap(),
            human_bytes
        );
        apply_patch(root.path(), root.path(), &patch(Some(edited), None), false).unwrap();
        assert!(read_author_comments(root.path(), root.path(), true)
            .unwrap()
            .is_empty());
        assert_eq!(
            read_author_comments(root.path(), root.path(), false).unwrap()["main.tex"],
            vec![human]
        );
    }

    #[test]
    fn counters_are_global_per_author_monotonic_and_reset_with_clear() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("main.tex"), "text").unwrap();
        fs::write(root.path().join("chapter.tex"), "text").unwrap();
        assert_eq!(
            read_author_snapshot(root.path(), root.path(), false)
                .unwrap()
                .counter,
            0
        );
        let first = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("one", false))),
            false,
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!(first.number, Some(1));
        // Retrying an older creation does not consume another number.
        apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("one", false))),
            false,
        )
        .unwrap();
        let mut second_patch = patch(None, Some(comment("two", false)));
        second_patch.file_path = "chapter.tex".into();
        let second = apply_patch(root.path(), root.path(), &second_patch, false)
            .unwrap()
            .after
            .unwrap();
        assert_eq!(second.number, Some(2));
        let agent = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("agent", true))),
            true,
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!(agent.number, Some(1));
        let mut resolved = first.clone();
        resolved.resolved = true;
        apply_patch(
            root.path(),
            root.path(),
            &patch(Some(first), Some(resolved.clone())),
            false,
        )
        .unwrap();
        apply_patch(
            root.path(),
            root.path(),
            &patch(Some(resolved), None),
            false,
        )
        .unwrap();
        assert_eq!(
            read_author_snapshot(root.path(), root.path(), false)
                .unwrap()
                .counter,
            2
        );
        let third = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("three", false))),
            false,
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!(third.number, Some(3));
        clear_author(root.path(), false).unwrap();
        let reset = apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(comment("reset", false))),
            false,
        )
        .unwrap()
        .after
        .unwrap();
        assert_eq!(reset.number, Some(1));
        assert_eq!(
            read_author_snapshot(root.path(), root.path(), true)
                .unwrap()
                .counter,
            1
        );
    }

    #[test]
    fn persisted_comments_require_explicit_numbers() {
        let mut side = AuthorSnapshot { version: 1, counter: 12, files: BTreeMap::from([("main.tex".into(), vec![comment("H-12", false)])]), orphaned: BTreeMap::new(), revisions: BTreeMap::new(), orphaned_revisions: BTreeMap::new(), sources: BTreeMap::new(), scope: None };
        assert!(validate_numbers(&side).is_err());
        side.files.get_mut("main.tex").unwrap()[0].number = Some(12);
        assert!(validate_numbers(&side).is_ok());
    }

    #[test]
    fn resolution_retains_the_record_while_deletion_removes_it() {
        for agent in [false, true] {
            let original = comment("comment", agent);
            let mut resolved = original.clone();
            resolved.resolved = true;
            let merged = merge_comment(
                Some(&original),
                &patch(Some(original.clone()), Some(resolved.clone())),
                false,
            )
            .unwrap()
            .unwrap();
            assert!(merged.resolved);
            assert_eq!(merged.origin, original.origin);
            let json = serde_json::to_value(&merged).unwrap();
            assert_eq!(json["resolved"], true);
            assert_eq!(serde_json::from_value::<Comment>(json).unwrap(), resolved);
            assert!(
                merge_comment(Some(&resolved), &patch(Some(resolved.clone()), None), false,)
                    .unwrap()
                    .is_none()
            );
            let mut defaults = serde_json::to_value(original).unwrap();
            defaults.as_object_mut().unwrap().remove("resolved");
            assert!(!serde_json::from_value::<Comment>(defaults).unwrap().resolved);
        }
    }

    #[test]
    fn merges_independent_edits_but_rejects_conflicting_edits_deletes_and_origin_changes() {
        let original = comment("agent", true);
        let mut moved_start = original.clone();
        moved_start.from = 1;
        let mut moved_end = original.clone();
        moved_end.to = 3;
        assert!(merge_comment(
            Some(&moved_start),
            &patch(Some(original.clone()), Some(moved_end)),
            false
        )
        .is_err());
        let mut moved = original.clone();
        moved.from = 10;
        moved.to = 14;
        moved.line = 2;
        let mut edited = original.clone();
        edited.text = "Edited".into();
        let merged = merge_comment(
            Some(&moved),
            &patch(Some(original.clone()), Some(edited.clone())),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!((merged.from, merged.to, merged.line), (10, 14, 2));
        assert_eq!(merged.text, "Edited");
        assert_eq!(merged.origin, original.origin);
        let mut conflict = edited.clone();
        conflict.text = "Other edit".into();
        assert!(merge_comment(
            Some(&conflict),
            &patch(Some(original.clone()), Some(edited)),
            false
        )
        .is_err());
        assert!(merge_comment(Some(&moved), &patch(Some(original.clone()), None), false).is_err());
        let mut spoof = original.clone();
        spoof.origin = None;
        assert!(merge_comment(
            Some(&original),
            &patch(Some(original.clone()), Some(spoof)),
            false
        )
        .is_err());
        assert!(merge_comment(None, &patch(None, Some(original.clone())), false).is_err());
        assert!(
            merge_comment(None, &patch(Some(original.clone()), Some(original)), false).is_err()
        );
    }

    #[tokio::test]
    async fn serialized_writes_preserve_concurrent_additions_and_stale_editor_edits() {
        let root = std::sync::Arc::new(TempDir::new().unwrap());
        fs::write(root.path().join("main.tex"), "text").unwrap();
        let service = std::sync::Arc::new(CommentService::default());
        let original = comment("existing", true);
        apply_patch(
            root.path(),
            root.path(),
            &patch(None, Some(original.clone())),
            true,
        )
        .unwrap();
        let mut jobs = vec![];
        for i in 0..30 {
            let (root, service) = (root.clone(), service.clone());
            jobs.push(tokio::spawn(async move {
                let _guard = service.lock_project(root.path()).await.unwrap();
                apply_patch(
                    root.path(),
                    root.path(),
                    &patch(None, Some(comment(&format!("agent-{i}"), true))),
                    true,
                )
                .unwrap();
            }));
        }
        for job in jobs {
            job.await.unwrap();
        }
        let mut edited = original.clone();
        edited.text = "Edited from old snapshot".into();
        let _guard = service.lock_project(root.path()).await.unwrap();
        apply_patch(
            root.path(),
            root.path(),
            &patch(Some(original), Some(edited.clone())),
            false,
        )
        .unwrap();
        let files = read_author_comments(root.path(), root.path(), true).unwrap();
        assert_eq!(files["main.tex"].len(), 31);
        edited.number = Some(1);
        assert!(files["main.tex"].contains(&edited));
        let numbers: std::collections::BTreeSet<_> = files["main.tex"]
            .iter()
            .map(|comment| comment.number)
            .collect();
        assert_eq!(numbers.len(), 31);
        assert_eq!(
            read_author_snapshot(root.path(), root.path(), true)
                .unwrap()
                .counter,
            31
        );
    }

    #[test]
    fn invalid_or_symlink_databases_are_not_overwritten() {
        let root = TempDir::new().unwrap();
        let db = root.path().join("comments.polodb");
        fs::write(&db, "unrelated data").unwrap();
        assert!(apply_patch(root.path(), root.path(), &patch(None, Some(comment("human", false))), false).is_err());
        assert_eq!(fs::read_to_string(&db).unwrap(), "unrelated data");
        #[cfg(unix)] {
            let other = TempDir::new().unwrap();
            std::os::unix::fs::symlink(&db, other.path().join("comments.polodb")).unwrap();
            assert!(apply_patch(root.path(), other.path(), &patch(None, Some(comment("agent", true))), true).is_err());
            assert_eq!(fs::read_to_string(&db).unwrap(), "unrelated data");
        }
    }

}


pub(crate) fn prepare_project_save(service: &crate::host::ServiceContext, project_root: &str, root: &Path, path: &str, temporary: &Path) -> Result<(), String> {
    let storage = comment_directory(service, project_root)?;
    prepare_save_revisions(root, &storage, path, temporary)
}
