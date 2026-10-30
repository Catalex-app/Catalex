use crate::host::ServiceContext;
use crate::project_storage;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "agent_workspace_git.rs"]
mod git_storage;

const WORKSPACE_SCHEMA_VERSION: u32 = 2;
const MANIFEST_FILE_NAME: &str = "session.json";
#[cfg(test)]
const SOURCE_SNAPSHOT_DIR_NAME: &str = "source-snapshot";
#[cfg(test)]
const BASELINE_DIR_NAME: &str = "baseline";
const CANDIDATE_DIR_NAME: &str = "candidate";
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyBuffer {
    relative_path: String,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceSession {
    version: u32,
    session_id: String,
    project_root: String,
    tab_id: String,
    #[serde(default)]
    shared_session_id: Option<String>,
    mode: String,
    status: String,
    created_at: u64,
    updated_at: u64,
    #[serde(default)]
    source_commit: String,
    #[serde(default)]
    baseline_commit: String,
    candidate_root: String,
    warnings: Vec<String>,
    #[serde(default)]
    dirty_buffers: Vec<DirtyBuffer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceChange {
    id: String,
    proposal_revision: String,
    kind: String,
    file_path: String,
    old_file_path: Option<String>,
    new_file_path: Option<String>,
    source_absolute_path: String,
    candidate_absolute_path: Option<String>,
    old_content: Option<String>,
    new_content: Option<String>,
    binary: bool,
    source_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceReconciliation {
    session: AgentWorkspaceSession,
    changes: Vec<AgentWorkspaceChange>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceDecision {
    change_id: String,
    accept: bool,
    content: Option<String>,
    #[serde(default)]
    resolved_conflict: bool,
    #[serde(default)]
    delete_file: bool,
    #[serde(default)]
    proposal_revision: Option<String>,
    /// Commit resolved inline portions while retaining the candidate's remaining proposal.
    #[serde(default)]
    partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceConflict {
    change_id: String,
    file_path: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceApplyResult {
    #[serde(skip)]
    comment_patches: Vec<crate::comments::CommentPatch>,
    applied: bool,
    changed_paths: Vec<String>,
    path_changes: Vec<crate::comments::CommentPathChange>,
    comment_warning: Option<String>,
    conflicts: Vec<AgentWorkspaceConflict>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remaining_preview: Option<AgentWorkspacePreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspacePreview {
    session: AgentWorkspaceSession,
    changes: Vec<AgentWorkspaceChange>,
    conflicts: Vec<AgentWorkspaceConflict>,
    source_revision: String,
    project_revision: String,
    merged_contents: BTreeMap<String, Option<String>>,
    current_contents: BTreeMap<String, Option<String>>,
    conflict_contents: BTreeMap<String, Vec<ConflictSegment>>,
}

use crate::text_merge::ConflictSegment;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProjectState {
    revision: String,
    git_pending: bool,
}

/// Review is bound to the whole source project, not just proposed file paths.
/// Git index entries omit stat-cache data so a read-only status refresh is harmless.
pub fn review_project_state(project_root: String) -> Result<ReviewProjectState, String> {
    let root = Path::new(&project_root);
    if !root.is_dir() { return Err("The source project is unavailable".into()); }
    let mut hash = Sha1::new();
    let mut files = BTreeMap::new();
    visit_inventory(root, root, &mut |path, file| {
        files.insert(path, (file.digest, file.mode));
        Ok(())
    })?;
    for (path, (digest, mode)) in files {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(digest.as_bytes());
        hash.update(mode.to_le_bytes());
    }
    let mut git_pending = false;
    match git2::Repository::discover(root) {
        Ok(repo) => {
            hash.update(format!("{:?}", repo.state()).as_bytes());
            if let Ok(head) = repo.head() {
                hash.update(head.name_bytes());
                if let Some(target) = head.target() { hash.update(target.as_bytes()); }
            }
            let index = repo.index().map_err(|error| error.to_string())?;
            for entry in index.iter() {
                hash.update((entry.path.len() as u64).to_le_bytes());
                hash.update(&entry.path);
                hash.update(entry.id.as_bytes());
                hash.update(entry.mode.to_le_bytes());
                hash.update([(entry.flags >> 12 & 3) as u8]);
            }
            git_pending = repo.state() != git2::RepositoryState::Clean
                || index.has_conflicts() || repo.path().join("index.lock").exists();
        }
        Err(error) if error.code() == git2::ErrorCode::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(ReviewProjectState { revision: format!("{:x}", hash.finalize()), git_pending })
}

fn check_review_project(project_root: &str, expected: &str) -> Result<(), String> {
    let current = review_project_state(project_root.to_string())
        .map_err(|error| format!("project_changed: {error}"))?;
    if current.git_pending || current.revision != expected {
        return Err("project_changed: The project changed outside this review".into());
    }
    Ok(())
}

pub(crate) fn project_apply_lock(project_root: &str) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let root = fs::canonicalize(project_root).map_err(|error| error.to_string())?;
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Project lock unavailable")?;
    Ok(locks
        .entry(root)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn source_revision(source_root: &Path, records: &[ChangeRecord]) -> Result<String, String> {
    let paths: BTreeSet<_> = records
        .iter()
        .flat_map(|record| record.old_path.iter().chain(record.new_path.iter()))
        .collect();
    let mut hash = Sha1::new();
    for path in paths {
        ensure_no_symlink_components(source_root, path)?;
        hash.update(path.as_bytes());
        hash.update([0]);
        match file_bytes(&source_root.join(safe_relative_path(path)?))? {
            Some(bytes) => {
                hash.update([1]);
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
            }
            None => hash.update([0]),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn preview_agent_workspace(
    app: ServiceContext,
    project_root: String,
    session_id: String,
    decisions: Option<Vec<AgentWorkspaceDecision>>,
) -> Result<AgentWorkspacePreview, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let lock = project_apply_lock(&project_root)?;
    let _guard = lock.lock().map_err(|_| "Project lock unavailable")?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let session_dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    let session = load_project_session(&session_dir, &project_root, &storage)?;
    preview_workspace(&session_dir, session, &decisions.unwrap_or_default())
}

fn preview_workspace(
    session_dir: &Path,
    session: AgentWorkspaceSession,
    decisions: &[AgentWorkspaceDecision],
) -> Result<AgentWorkspacePreview, String> {
    let project_revision = review_project_state(session.project_root.clone())?.revision;
    let records = reconcile_records(session_dir)?;
    let source_root = Path::new(&session.project_root);
    let source_snapshot = git_storage::snapshot_records(session_dir, &session.source_commit, &records)?;
    let revision = source_revision(source_root, &records)?;
    let mut changes = Vec::new();
    let mut conflicts = Vec::new();
    let mut merged_contents = BTreeMap::new();
    let mut current_contents = BTreeMap::new();
    let mut conflict_contents = BTreeMap::new();
    for record in &records {
        let mut change =
            serialize_change_with_snapshot(session_dir, &session, record, &source_snapshot)?;
        let override_content = decisions
            .iter()
            .find(|decision| decision.change_id == record.id)
            .filter(|_| record.kind != ChangeKind::Deleted && !change.binary)
            .and_then(|decision| decision.content.clone());
        if override_content.is_some() {
            change.new_content = override_content.clone();
        }
        changes.push(change);
        let path = record
            .old_path
            .as_ref()
            .or(record.new_path.as_ref())
            .ok_or("Change has no path")?;
        current_contents.insert(
            record.id.clone(),
            file_bytes(&source_root.join(safe_relative_path(path)?))?
                .as_deref()
                .and_then(text_content),
        );
        let decision = AgentWorkspaceDecision {
            change_id: record.id.clone(),
            accept: true,
            content: override_content,
            ..Default::default()
        };
        match plan_change(
            record,
            &decision,
            source_root,
            &source_snapshot,
            session_dir,
        ) {
            Ok(operation) => {
                merged_contents.insert(
                    record.id.clone(),
                    operation.write_bytes.as_deref().and_then(text_content),
                );
            }
            Err(reason) => {
                let base = source_snapshot
                    .get(path)
                    .map(|f| f.bytes.as_slice())
                    .unwrap_or_default();
                let current =
                    file_bytes(&source_root.join(safe_relative_path(path)?))?.unwrap_or_default();
                let proposed = decision
                    .content
                    .as_ref()
                    .map(|s| s.as_bytes())
                    .or(record.candidate.as_ref().map(|f| f.bytes.as_slice()))
                    .unwrap_or_default();
                let occupied_rename_target = record.kind == ChangeKind::Renamed
                    && record
                        .new_path
                        .as_ref()
                        .is_some_and(|p| source_root.join(p).exists());
                if !occupied_rename_target
                    && [base, current.as_slice(), proposed]
                        .iter()
                        .all(|b| text_content(b).is_some())
                {
                    let (_, mut segments) =
                        git_storage::merge(session_dir, base, &current, proposed)?;
                    if segments.is_empty() {
                        segments.push(ConflictSegment::Conflict {
                            ancestor: text_content(base).unwrap_or_default(),
                            current: text_content(&current).unwrap_or_default(),
                            agent: text_content(proposed).unwrap_or_default(),
                        });
                    }
                    conflict_contents.insert(record.id.clone(), segments);
                }
                conflicts.push(AgentWorkspaceConflict {
                    change_id: record.id.clone(),
                    file_path: display_path(record),
                    reason,
                });
            }
        }
    }
    if source_revision(source_root, &records)? != revision {
        return Err("Source changed during draft preview; refresh the review".to_string());
    }
    Ok(AgentWorkspacePreview {
        session,
        changes,
        conflicts,
        source_revision: revision,
        project_revision,
        merged_contents,
        current_contents,
        conflict_contents,
    })
}

#[derive(Debug, Clone)]
struct FileEntry {
    mode: u32,
    bytes: Vec<u8>,
    digest: String,
}

#[derive(Debug, Clone)]
struct ChangeRecord {
    id: String,
    kind: ChangeKind,
    old_path: Option<String>,
    new_path: Option<String>,
    baseline: Option<FileEntry>,
    candidate: Option<FileEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl ChangeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
        }
    }
}

#[derive(Debug)]
struct PlannedOperation {
    remove_paths: Vec<String>,
    write_path: Option<String>,
    write_bytes: Option<Vec<u8>>,
}

pub fn prepare_agent_workspace(
    app: ServiceContext,
    project_root: String,
    tab_id: String,
    shared_session_id: Option<String>,
    mode: String,
    dirty_buffers: Vec<DirtyBuffer>,
) -> Result<AgentWorkspaceSession, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let lock = project_apply_lock(&project_root)?;
    let _guard = lock.lock().map_err(|_| "Project lock unavailable")?;
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    crate::history::history_init_at(&project_root, &storage)?;
    let _history = crate::history::lock_history_operations();
    crate::history::history_snapshot_unlocked_at(
        &project_root,
        &storage,
        "[agent] Before agent work".into(),
    )?;
    prepare_workspace_in_root(
        &storage.agent_workspaces_dir,
        &project_root,
        &tab_id,
        shared_session_id,
        &mode,
        dirty_buffers,
    )
}

/// Resume a reviewed draft without replacing its candidate or source snapshot.
pub fn resume_agent_workspace(
    app: ServiceContext,
    project_root: String,
    session_id: String,
    tab_id: String,
    shared_session_id: Option<String>,
) -> Result<AgentWorkspaceSession, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let lock = project_apply_lock(&project_root)?;
    let _guard = lock.lock().map_err(|_| "Project lock unavailable")?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    load_project_session(&dir, &project_root, &storage)?;
    resume_workspace(&dir, &project_root, &tab_id, shared_session_id.as_deref())
}

fn resume_workspace(
    dir: &Path,
    project_root: &str,
    tab_id: &str,
    shared_session_id: Option<&str>,
) -> Result<AgentWorkspaceSession, String> {
    let mut session = load_session(dir)?;
    ensure_session_project(&session, project_root)?;
    if tab_id.trim().is_empty() {
        return Err("A chat tab is required to refine this draft".into());
    }
    if session.tab_id != tab_id
        && !shared_session_id
            .is_some_and(|id| !id.is_empty() && session.shared_session_id.as_deref() == Some(id))
    {
        return Err("This draft belongs to another chat tab".into());
    }
    if !matches!(session.status.as_str(), "review" | "failed" | "cancelled") {
        return Err("This draft cannot be refined in its current state".into());
    }
    session.tab_id = tab_id.to_string();
    git_storage::checkpoint(dir)?;
    session.status = "active".into();
    session.updated_at = now_millis();
    save_session(dir, &session)?;
    Ok(session)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedWorkspaceInspection {
    changed: bool,
    revision: String,
    changes: Vec<AgentWorkspaceChange>,
}

pub fn set_agent_workspace_backup(
    app: ServiceContext,
    project_root: String,
    session_id: String,
    backup: bool,
) -> Result<(), String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let lock = project_apply_lock(&project_root)?;
    let _guard = lock.lock().map_err(|_| "Project lock unavailable")?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    let mut session = load_project_session(&dir, &project_root, &storage)?;
    if !matches!(session.status.as_str(), "active" | "resume-backup") {
        return Err("This draft is no longer paused".into());
    }
    session.status = if backup { "resume-backup" } else { "active" }.into();
    save_session(&dir, &session)
}

pub fn inspect_paused_workspace(
    app: ServiceContext,
    project_root: String,
    session_id: String,
    dirty_buffers: Vec<DirtyBuffer>,
) -> Result<PausedWorkspaceInspection, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let lock = project_apply_lock(&project_root)?;
    let _guard = lock.lock().map_err(|_| "Project lock unavailable")?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    let session = load_project_session(&dir, &project_root, &storage)?;
    // The baseline includes editor buffers supplied when this run started.
    let before = git_storage::snapshot(&dir, &session.baseline_commit)?;
    let mut current = inventory(Path::new(&project_root))?;
    for buffer in dirty_buffers {
        let path = safe_relative_path(&buffer.relative_path)?;
        let bytes = buffer.content.into_bytes();
        current.insert(
            path.to_string_lossy().replace('\\', "/"),
            FileEntry {
                mode: 0o100644,
                digest: format!("{:x}", Sha1::digest(&bytes)),
                bytes,
            },
        );
    }
    let changed = before.len() != current.len()
        || before.iter().any(|(path, file)| {
            current
                .get(path)
                .is_none_or(|other| other.digest != file.digest)
        });
    let mut hash = Sha1::new();
    for (path, file) in &current {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(file.digest.as_bytes());
    }
    for (path, file) in inventory(&dir.join(CANDIDATE_DIR_NAME))? {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(file.digest.as_bytes());
    }
    let source_snapshot = git_storage::snapshot(&dir, &session.source_commit)?;
    let changes = reconcile_records(&dir)?
        .iter()
        .map(|record| serialize_change_with_snapshot(&dir, &session, record, &source_snapshot))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PausedWorkspaceInspection {
        changed,
        revision: format!("{:x}", hash.finalize()),
        changes,
    })
}

pub fn agent_workspace_source_changed(
    app: ServiceContext,
    project_root: String,
    session_id: String,
) -> Result<bool, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    let session = load_project_session(&dir, &project_root, &storage)?;
    let before = git_storage::snapshot(&dir, &session.source_commit)?;
    let current = inventory(Path::new(&project_root))?;
    Ok(before.len() != current.len()
        || before.iter().any(|(path, file)| {
            current
                .get(path)
                .is_none_or(|other| other.digest != file.digest)
        }))
}

pub fn reconcile_agent_workspace(
    app: ServiceContext,
    project_root: String,
    session_id: String,
    outcome: String,
) -> Result<AgentWorkspaceReconciliation, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let session_dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    let mut session = load_project_session(&session_dir, &project_root, &storage)?;
    git_storage::checkpoint(&session_dir)?;
    session.status = normalize_outcome(&outcome)?.to_string();
    session.updated_at = now_millis();
    save_session(&session_dir, &session)?;
    let records = reconcile_records(&session_dir)?;
    let source_snapshot = git_storage::snapshot_records(&session_dir, &session.source_commit, &records)?;
    let changes = records
        .iter()
        .map(|record| {
            serialize_change_with_snapshot(&session_dir, &session, record, &source_snapshot)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(AgentWorkspaceReconciliation { session, changes })
}

pub fn apply_agent_workspace(
    app: ServiceContext,
    project_root: String,
    session_id: String,
    decisions: Vec<AgentWorkspaceDecision>,
    expected_source_revision: Option<String>,
    expected_project_revision: Option<String>,
) -> Result<AgentWorkspaceApplyResult, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let lock = project_apply_lock(&project_root)?;
    let _guard = lock.lock().map_err(|_| "Project lock unavailable")?;
    let _history = crate::history::lock_history_operations();
    if let Some(expected) = &expected_project_revision {
        check_review_project(&project_root, expected)?;
    }
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let session_dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    let comment_storage = storage.data_dir.join("comments");
    // Finish an interrupted settlement before checking its history marker.
    let previous = load_session(&session_dir)?;
    ensure_session_project(&previous, &project_root)?;
    // Do not overwrite an earlier acceptance's pending marker.
    if session_dir.join("history-pending").exists() {
        record_applied_history(&project_root, &storage, &session_dir, true)?;
    }
    let before_warning = if decisions.iter().any(|decision| decision.accept) {
        crate::history::history_snapshot_unlocked_at(
            &project_root, &storage, "[agent] Before applying reviewed changes".into(),
        ).err().map(|error| format!("Before-review checkpoint could not be saved: {error}"))
    } else { None };
    let mut result = apply_workspace_with_comments(
        Some(&comment_storage),
        &session_dir,
        &project_root,
        decisions,
        expected_source_revision,
    )?;
    if !result.comment_patches.is_empty() {
        // Receipts precede the source handoff and use the ordinary notification
        // path. Background refresh latency cannot leave old ranges on new text.
        let patches = std::mem::take(&mut result.comment_patches);
        let _ = app.emit("catalex-comments-changed", serde_json::json!({"projectRoot": project_root, "patches": patches}));
    }
    if let Some(warning) = before_warning {
        result.comment_warning = Some(match result.comment_warning {
            Some(existing) => format!("{existing}\n{warning}"),
            None => warning,
        });
    }
    if result.applied && session_dir.join("history-pending").exists() {
        match record_applied_history(&project_root, &storage, &session_dir, false) {
            Ok(()) => {}
            Err(error) => {
                result.comment_warning = Some(format!(
                    "{}History checkpoint pending: {error}",
                    result
                        .comment_warning
                        .map(|warning| format!("{warning}\n"))
                        .unwrap_or_default()
                ))
            }
        }
    }
    Ok(result)
}

// Public callers hold the comments and history gates before journal recovery.
fn load_project_session(
    session_dir: &Path,
    project_root: &str,
    storage: &project_storage::ProjectStoragePaths,
) -> Result<AgentWorkspaceSession, String> {
    let mut session = load_session(session_dir)?;
    ensure_session_project(&session, project_root)?;
    if session_dir.join("history-pending").exists() {
        if let Err(error) = record_applied_history(project_root, storage, session_dir, true) {
            session.warnings.push(format!("History checkpoint pending: {error}"));
        }
    }
    Ok(session)
}

fn record_applied_history(
    project_root: &str,
    storage: &project_storage::ProjectStoragePaths,
    session_dir: &Path,
    recovered: bool,
) -> Result<(), String> {
    // Retry captures today's complete state, not a reconstruction of the
    // acceptance moment. Make that distinction explicit in Rewind.
    crate::history::history_snapshot_unlocked_at(
        project_root,
        storage,
        if recovered { "[agent] Recovered checkpoint" } else { "[agent] Applied reviewed changes" }.into(),
    )?;
    if session_dir.join("history-pending").exists() {
        fs::remove_file(session_dir.join("history-pending")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
fn apply_workspace(
    session_dir: &Path,
    project_root: &str,
    decisions: Vec<AgentWorkspaceDecision>,
    expected_source_revision: Option<String>,
) -> Result<AgentWorkspaceApplyResult, String> {
    apply_workspace_with_comments(
        None,
        session_dir,
        project_root,
        decisions,
        expected_source_revision,
    )
}

fn apply_workspace_with_comments(
    comment_storage: Option<&Path>,
    session_dir: &Path,
    project_root: &str,
    decisions: Vec<AgentWorkspaceDecision>,
    expected_source_revision: Option<String>,
) -> Result<AgentWorkspaceApplyResult, String> {
    let mut session = load_session(&session_dir)?;
    ensure_session_project(&session, &project_root)?;
    let records = reconcile_records(&session_dir)?;
    let decisions_by_id: HashMap<_, _> = decisions
        .into_iter()
        .map(|decision| (decision.change_id.clone(), decision))
        .collect();

    let source_root = PathBuf::from(&session.project_root);
    let source_snapshot = git_storage::snapshot_records(session_dir, &session.source_commit, &records)?;
    let revision = source_revision(&source_root, &records)?;
    if expected_source_revision
        .as_ref()
        .is_some_and(|expected| expected != &revision)
    {
        return Ok(AgentWorkspaceApplyResult {
            comment_patches: Vec::new(),
            remaining_preview: None,
            applied: false,
            changed_paths: Vec::new(),
            path_changes: Vec::new(),
            comment_warning: None,
            conflicts: records
                .iter()
                .filter(|record| {
                    decisions_by_id
                        .get(&record.id)
                        .is_some_and(|decision| decision.accept)
                })
                .map(|record| AgentWorkspaceConflict {
                    change_id: record.id.clone(),
                    file_path: display_path(record),
                    reason: "Source changed since review; review the latest changes again"
                        .to_string(),
                })
                .collect(),
        });
    }
    let mut operations = Vec::new();
    let mut conflicts = Vec::new();

    for record in &records {
        let Some(decision) = decisions_by_id.get(&record.id) else {
            continue;
        };
        if decision.partial
            && (!decision.accept
                || !decision.resolved_conflict
                || decision.delete_file
                || decision.content.is_none()
                || !record.candidate.as_ref().is_some_and(|file| text_content(&file.bytes).is_some()))
        {
            return Err("Partial review requires an explicit reviewed text result".into());
        }
        if decision
            .proposal_revision
            .as_ref()
            .is_some_and(|v| v != &proposal_revision(record))
        {
            return Err("Agent proposal changed since review; refresh it before applying".into());
        }
        if !decision.accept {
            continue;
        }
        if decision.resolved_conflict {
            if record.kind == ChangeKind::Renamed
                && record
                    .new_path
                    .as_ref()
                    .is_some_and(|p| source_root.join(p).exists())
            {
                return Err("The rename destination is occupied; revise the draft without overwriting that file".into());
            }
            if expected_source_revision.is_none()
                || decision.proposal_revision.as_deref() != Some(proposal_revision(record).as_str())
            {
                return Err("Conflict resolution requires the exact reviewed project and proposal revisions".into());
            }
            // Inline text approval does not approve a pending filename change.
            let path = if decision.partial && record.kind == ChangeKind::Renamed {
                record.old_path.clone().ok_or("A rename needs its original path")?
            } else {
                display_path(record)
            };
            ensure_no_symlink_components(&source_root, &path)?;
            if decision.delete_file {
                operations.push(PlannedOperation {
                    remove_paths: record
                        .old_path
                        .iter()
                        .chain(record.new_path.iter())
                        .cloned()
                        .collect(),
                    write_path: None,
                    write_bytes: None,
                });
                continue;
            }
            let content = decision
                .content
                .as_ref()
                .ok_or("A conflict needs an explicit resolved result")?;
            if record
                .candidate
                .as_ref()
                .is_some_and(|f| text_content(&f.bytes).is_none())
            {
                return Err("Binary conflict requires whole-file resolution".into());
            }
            operations.push(PlannedOperation {
                remove_paths: if record.kind == ChangeKind::Renamed && !decision.partial {
                    record.old_path.iter().cloned().collect()
                } else {
                    Vec::new()
                },
                write_path: Some(path),
                write_bytes: Some(encode_review_content(record, content)),
            });
            continue;
        }
        // A revision-bound review edits the merged result, not the original
        // proposal. First validate the original proposal against current source;
        // only then substitute the reviewed text under the revision guard.
        let original_decision = AgentWorkspaceDecision {
            change_id: decision.change_id.clone(),
            accept: decision.accept,
            content: None,
            ..Default::default()
        };
        let planning_decision = if expected_source_revision.is_some() {
            &original_decision
        } else {
            decision
        };
        match plan_change(
            record,
            planning_decision,
            &source_root,
            &source_snapshot,
            session_dir,
        ) {
            Ok(mut operation) => {
                if expected_source_revision.is_some() && operation.write_path.is_some() {
                    if let Some(content) = &decision.content {
                        operation.write_bytes = Some(encode_review_content(record, content));
                    }
                }
                operations.push(operation);
            }
            Err(reason) => conflicts.push(AgentWorkspaceConflict {
                change_id: record.id.clone(),
                file_path: display_path(record),
                reason,
            }),
        }
    }

    if !conflicts.is_empty() {
        session.status = "conflict".to_string();
        session.updated_at = now_millis();
        save_session(&session_dir, &session)?;
        return Ok(AgentWorkspaceApplyResult {
            comment_patches: Vec::new(),
            remaining_preview: None,
            applied: false,
            changed_paths: Vec::new(),
            path_changes: Vec::new(),
            comment_warning: None,
            conflicts,
        });
    }

    if source_revision(&source_root, &records)? != revision {
        return Err(
            "Source changed while preparing application; review the latest changes again"
                .to_string(),
        );
    }
    let path_changes: Vec<_> = records
        .iter()
        .filter(|record| {
            matches!(record.kind, ChangeKind::Renamed)
                && decisions_by_id
                    .get(&record.id)
                    .is_some_and(|decision| decision.accept && !decision.partial)
        })
        .filter_map(|record| {
            Some(crate::comments::CommentPathChange {
                old_path: record.old_path.clone()?,
                new_path: record.new_path.clone()?,
                folder: false,
            })
        })
        .collect();
    let comment_paths: BTreeSet<_> = operations.iter().flat_map(|operation| operation.remove_paths.iter().chain(operation.write_path.iter()).cloned()).collect();
    let before_comments = comment_storage.filter(|_| !comment_paths.is_empty()).and_then(|storage| crate::comments::stored_document_comments(storage, &comment_paths).ok());
    git_storage::prepare_settlement(
        session_dir,
        &session,
        &records,
        &decisions_by_id,
        &operations,
        comment_storage,
    )?;
    let changed_paths = git_storage::apply_settlement_files(&session_dir)?;
    let comment_warning = git_storage::recover_settlement(session_dir, &mut session)?;
    let comment_patches = before_comments.zip(comment_storage).and_then(|(before, storage)| {
        crate::comments::stored_document_comments(storage, &comment_paths).ok().map(|after| crate::comments::document_comment_notifications(before, after))
    }).unwrap_or_default();
    let remaining_preview = if session.status == "settled" {
        None
    } else {
        Some(preview_workspace(session_dir, session.clone(), &[])?)
    };
    Ok(AgentWorkspaceApplyResult {
        comment_patches,
        remaining_preview,
        applied: true,
        changed_paths,
        path_changes,
        comment_warning,
        conflicts: Vec::new(),
    })
}

pub fn discard_agent_workspace(
    app: ServiceContext,
    project_root: String,
    session_id: String,
) -> Result<(), String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    let session_dir = session_dir(&storage.agent_workspaces_dir, &session_id)?;
    if !session_dir.exists() {
        project_storage::cleanup_missing_draft_storage(&app, &storage);
        return Ok(());
    }
    let session = load_session(&session_dir)?;
    ensure_session_project(&session, &project_root)?;
    if session_dir.join("history-pending").exists() {
        record_applied_history(&project_root, &storage, &session_dir, true)?;
    }
    git_storage::discard(&session_dir)?;
    fs::remove_dir_all(&session_dir).map_err(|error| {
        format!(
            "Failed to discard agent workspace {}: {error}",
            session_dir.display()
        )
    })?;
    project_storage::cleanup_missing_draft_storage(&app, &storage);
    Ok(())
}

pub(crate) fn validate_comment_scope(
    app: &ServiceContext,
    project_root: &str,
    draft_root: &str,
    tab_id: &str,
) -> Result<(), String> {
    let storage = project_storage::resolve_project_storage(app, project_root)?;
    validate_comment_scope_in_root(
        &storage.agent_workspaces_dir,
        project_root,
        draft_root,
        tab_id,
    )
}

fn validate_comment_scope_in_root(
    workspaces_root: &Path,
    project_root: &str,
    draft_root: &str,
    tab_id: &str,
) -> Result<(), String> {
    let draft =
        fs::canonicalize(draft_root).map_err(|_| "stale_session: draft was removed".to_string())?;
    let parent = draft
        .parent()
        .ok_or("invalid_project: draft has no session")?;
    let workspaces = fs::canonicalize(workspaces_root).map_err(|e| e.to_string())?;
    if parent.parent() != Some(workspaces.as_path())
        || draft.file_name().and_then(|s| s.to_str()) != Some(CANDIDATE_DIR_NAME)
    {
        return Err("invalid_project: draft does not belong to this source project".into());
    }
    let session = read_session_manifest(parent)?;
    ensure_session_project(&session, project_root)?;
    if session.tab_id != tab_id || session.status != "active" {
        return Err("stale_session: draft is not active in this chat".into());
    }
    Ok(())
}

fn retire_legacy_workspace(dir: &Path, session: &AgentWorkspaceSession) -> Result<(), String> {
    if session.version != 1 {
        return Err("Only known version-1 drafts may be retired".into());
    }
    let root = dir.parent().ok_or("Missing draft root")?;
    if session_dir(root, &session.session_id)? != dir {
        return Err("Invalid retired draft path".into());
    }
    if dir.join(MANIFEST_FILE_NAME).exists() && read_session_manifest(dir)?.version != 1 {
        return Err("Retirement marker does not own a version-1 draft; storage preserved".into());
    }
    let marker = root.join(format!(".{}.retired.json", session.session_id));
    // Keep the intent outside the directory being removed. Retry after a
    // partial deletion even if its original manifest no longer exists.
    atomic_write(
        &marker,
        &serde_json::to_vec(session).map_err(|e| e.to_string())?,
    )?;
    git_storage::discard_legacy(dir)?;
    fs::remove_file(marker).map_err(|e| e.to_string())
}

pub fn list_agent_workspaces(
    app: ServiceContext,
    project_root: String,
) -> Result<Vec<AgentWorkspaceSession>, String> {
    let _comments = app.comments.lock_project_blocking(&project_root)?;
    let _history = crate::history::lock_history_operations();
    let storage = project_storage::resolve_project_storage(&app, &project_root)?;
    if !storage.agent_workspaces_dir.exists() {
        project_storage::cleanup_missing_draft_storage(&app, &storage);
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(&storage.agent_workspaces_dir).map_err(|error| {
        format!(
            "Failed to inspect agent workspaces {}: {error}",
            storage.agent_workspaces_dir.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("Failed to read agent workspace: {error}"))?;
        if !entry.path().try_exists().map_err(|e| e.to_string())? {
            continue;
        }
        if entry
            .file_name()
            .to_string_lossy()
            .ends_with(".retired.json")
            && entry.file_type().map_err(|e| e.to_string())?.is_file()
        {
            let mut session: AgentWorkspaceSession =
                serde_json::from_slice(&fs::read(entry.path()).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if session.version != 1 {
                continue;
            }
            ensure_session_project(&session, &project_root)?;
            let dir = session_dir(&storage.agent_workspaces_dir, &session.session_id)?;
            if let Err(error) = retire_legacy_workspace(&dir, &session) {
                session
                    .warnings
                    .push(format!("Old draft cleanup pending: {error}"));
            }
            session.status = "cancelled".into();
            sessions.push(session);
            continue;
        }
        if !entry
            .file_type()
            .map_err(|error| format!("Failed to inspect agent workspace: {error}"))?
            .is_dir()
        {
            continue;
        }
        if !entry.path().join(MANIFEST_FILE_NAME).exists() {
            continue;
        }
        let mut known = read_session_manifest(&entry.path())?;
        ensure_session_project(&known, &project_root)?;
        if known.version == 1 {
            if entry.path().join("history-pending").exists() {
                if let Err(error) = record_applied_history(&project_root, &storage, &entry.path(), true) {
                    known
                        .warnings
                        .push(format!("Old draft checkpoint pending: {error}"));
                    known.status = "cancelled".into();
                    sessions.push(known);
                    continue;
                }
            }
            if let Err(error) = retire_legacy_workspace(&entry.path(), &known) {
                known
                    .warnings
                    .push(format!("Old draft cleanup pending: {error}"));
            }
            known.status = "cancelled".into();
            sessions.push(known);
            continue;
        }
        let mut session = load_session(&entry.path()).map_err(|error| {
            format!(
                "Cannot recover agent draft {}: {error}",
                entry.path().display()
            )
        })?;
        ensure_session_project(&session, &project_root)?;
        if entry.path().join("history-pending").exists() {
            if let Err(error) = record_applied_history(&project_root, &storage, &entry.path(), true) {
                session.warnings.push(format!("History checkpoint pending: {error}"));
                // Preserve the recovery marker and Git refs, but do not make
                // a completed review active again or block other chats loading.
                sessions.push(session);
                continue;
            }
        }
        if session.status == "settled" {
            git_storage::discard(&entry.path())?;
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        } else if session.status != "resume-backup" {
            sessions.push(session);
        }
    }

    project_storage::cleanup_missing_draft_storage(&app, &storage);
    sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    sessions.dedup_by(|a, b| a.session_id == b.session_id);
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
}

fn prepare_workspace_in_root(
    workspaces_root: &Path,
    project_root: &str,
    tab_id: &str,
    shared_session_id: Option<String>,
    mode: &str,
    dirty_buffers: Vec<DirtyBuffer>,
) -> Result<AgentWorkspaceSession, String> {
    let mode = normalize_mode(mode)?;
    let canonical_project = fs::canonicalize(project_root)
        .map_err(|error| format!("Failed to resolve project path {project_root}: {error}"))?;
    if !canonical_project.is_dir() {
        return Err(format!("Project path is not a directory: {project_root}"));
    }
    fs::create_dir_all(workspaces_root).map_err(|error| {
        format!(
            "Failed to create agent workspace directory {}: {error}",
            workspaces_root.display()
        )
    })?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let session_dir = workspaces_root.join(&session_id);
    let candidate_root = session_dir.join(CANDIDATE_DIR_NAME);
    fs::create_dir(&session_dir).map_err(|error| {
        format!(
            "Failed to create agent workspace {}: {error}",
            session_dir.display()
        )
    })?;

    let preparation = (|| {
        let mut warnings = Vec::new();
        let source = inventory(&canonical_project)?;
        let mut baseline = source.clone();
        for dirty in &dirty_buffers {
            let relative = safe_relative_path(&dirty.relative_path)?;
            let disk = source.get(&relative.to_string_lossy().replace('\\', "/")).and_then(|entry| std::str::from_utf8(&entry.bytes).ok()).unwrap_or("");
            let bytes = catalex_document_core::encode_document_text(&dirty.content, disk).into_bytes();
            baseline.insert(
                relative.to_string_lossy().replace('\\', "/"),
                FileEntry {
                    mode: 0o100644,
                    digest: hex_digest(&bytes),
                    bytes,
                },
            );
        }
        let (source_commit, baseline_commit) =
            git_storage::create(&session_dir, &source, &baseline, &mut warnings)?;

        let now = now_millis();
        let session = AgentWorkspaceSession {
            version: WORKSPACE_SCHEMA_VERSION,
            session_id,
            // Keep the path spelling used by the open document so frontend
            // project/tab identity checks remain stable. Command entrypoints
            // canonicalize both sides before trusting this association.
            project_root: if Path::new(project_root).is_absolute() {
                project_root.to_string()
            } else {
                canonical_project.to_string_lossy().to_string()
            },
            tab_id: tab_id.to_string(),
            shared_session_id,
            mode: mode.to_string(),
            status: "active".to_string(),
            created_at: now,
            updated_at: now,
            source_commit,
            baseline_commit,
            candidate_root: candidate_root.to_string_lossy().to_string(),
            warnings,
            dirty_buffers,
        };
        save_session(&session_dir, &session)?;
        Ok(session)
    })();

    if preparation.is_err() {
        let _ = git_storage::discard(&session_dir);
        let _ = fs::remove_dir_all(&session_dir);
    }
    preparation
}

fn normalize_mode(mode: &str) -> Result<&'static str, String> {
    match mode {
        "ask" | "default" => Ok("ask"),
        "edit" => Ok("edit"),
        _ => Err(format!("Unsupported agent workspace mode: {mode}")),
    }
}

fn normalize_outcome(outcome: &str) -> Result<&'static str, String> {
    match outcome {
        "success" => Ok("review"),
        "failed" => Ok("failed"),
        "cancelled" => Ok("cancelled"),
        _ => Err(format!("Unsupported agent workspace outcome: {outcome}")),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn session_dir(workspaces_root: &Path, session_id: &str) -> Result<PathBuf, String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid agent workspace session id".to_string());
    }
    Ok(workspaces_root.join(session_id))
}

fn safe_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let normalized = relative_path.replace('\\', "/");
    let path = Path::new(&normalized);
    if normalized.is_empty() || path.is_absolute() || crate::comments::is_sidecar(&normalized) {
        return Err(format!("Invalid workspace-relative path: {relative_path}"));
    }
    let components = path.components().collect::<Vec<_>>();
    let mut safe = PathBuf::new();
    for component in &components {
        match component {
            Component::Normal(part) => {
                if excluded_directory(&part.to_string_lossy()) {
                    return Err(format!(
                        "Workspace path enters an excluded directory: {relative_path}"
                    ));
                }
                safe.push(part);
            }
            _ => return Err(format!("Unsafe workspace-relative path: {relative_path}")),
        }
    }
    Ok(safe)
}

fn excluded_directory(name: &str) -> bool {
    crate::private_files::internal(Path::new(name))
}

fn read_session_manifest(session_dir: &Path) -> Result<AgentWorkspaceSession, String> {
    let manifest_path = session_dir.join(MANIFEST_FILE_NAME);
    let raw = fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "Failed to read agent workspace manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let session: AgentWorkspaceSession = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Failed to parse agent workspace manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    if session.session_id
        != session_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
    {
        return Err("Agent session identity does not match its storage directory".into());
    }
    Ok(session)
}

fn load_session(session_dir: &Path) -> Result<AgentWorkspaceSession, String> {
    let mut session = read_session_manifest(session_dir)?;
    if session.version == 1 {
        return Err("retired_agent_workspace: old copied-folder draft was cancelled; start a new request".into());
    }
    if session.version != WORKSPACE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported agent workspace version: {}",
            session.version
        ));
    }
    git_storage::recover_settlement(session_dir, &mut session)?;
    Ok(session)
}

fn save_session(session_dir: &Path, session: &AgentWorkspaceSession) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(session)
        .map_err(|error| format!("Failed to serialize agent workspace: {error}"))?;
    atomic_write(&session_dir.join(MANIFEST_FILE_NAME), &serialized)
}

fn ensure_session_project(
    session: &AgentWorkspaceSession,
    project_root: &str,
) -> Result<(), String> {
    let requested = fs::canonicalize(project_root)
        .map_err(|error| format!("Failed to resolve project path {project_root}: {error}"))?;
    let stored = fs::canonicalize(&session.project_root).map_err(|error| {
        format!(
            "Failed to resolve stored project path {}: {error}",
            session.project_root
        )
    })?;
    if requested != stored {
        return Err("Agent workspace belongs to a different project".to_string());
    }
    Ok(())
}

fn file_mode(path: &Path) -> Result<u32, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = fs::metadata(path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o111
            != 0;
        Ok(if executable { 0o100755 } else { 0o100644 })
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(0o100644)
    }
}

fn inventory(root: &Path) -> Result<BTreeMap<String, FileEntry>, String> {
    let mut entries = BTreeMap::new();
    visit_inventory(root, root, &mut |path, file| {
        entries.insert(path, file);
        Ok(())
    })?;
    Ok(entries)
}

fn visit_inventory(
    root: &Path,
    current: &Path,
    visit: &mut impl FnMut(String, FileEntry) -> Result<(), String>,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current)
        .map_err(|error| format!("Failed to read {}: {error}", current.display()))?
    {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        if crate::private_files::excluded(
            root,
            entry.path().strip_prefix(root).map_err(|e| e.to_string())?,
        ) || (current == root
            && crate::comments::is_sidecar(&entry.file_name().to_string_lossy()))
        {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if excluded_directory(&entry.file_name().to_string_lossy()) {
                continue;
            }
            visit_inventory(root, &entry.path(), visit)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| format!("Failed to make workspace path relative: {error}"))?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = fs::read(entry.path())
            .map_err(|error| format!("Failed to read {}: {error}", entry.path().display()))?;
        let digest = hex_digest(&bytes);
        visit(
            relative,
            FileEntry {
                mode: file_mode(&entry.path())?,
                bytes,
                digest,
            },
        )?;
    }
    Ok(())
}

fn reconcile_records(session_dir: &Path) -> Result<Vec<ChangeRecord>, String> {
    git_storage::changes(session_dir)
}

fn make_record(
    kind: ChangeKind,
    old_path: Option<String>,
    new_path: Option<String>,
    baseline: Option<FileEntry>,
    candidate: Option<FileEntry>,
) -> ChangeRecord {
    let identity = format!(
        "{}:{}:{}",
        kind.as_str(),
        old_path.as_deref().unwrap_or_default(),
        new_path.as_deref().unwrap_or_default()
    );
    ChangeRecord {
        id: format!("workspace-{}", hex_digest(identity.as_bytes())),
        kind,
        old_path,
        new_path,
        baseline,
        candidate,
    }
}

fn display_path(record: &ChangeRecord) -> String {
    record
        .new_path
        .as_ref()
        .or(record.old_path.as_ref())
        .cloned()
        .unwrap_or_default()
}

// IDs identify the change across rounds; revisions identify the exact reviewed bytes.
fn proposal_revision(record: &ChangeRecord) -> String {
    let mut hash = Sha1::new();
    for value in [
        Some(record.kind.as_str()),
        record.old_path.as_deref(),
        record.new_path.as_deref(),
    ] {
        match value {
            Some(value) => {
                hash.update([1]);
                hash.update((value.len() as u64).to_le_bytes());
                hash.update(value.as_bytes());
            }
            None => hash.update([0]),
        }
    }
    match &record.candidate {
        Some(candidate) => {
            hash.update([1]);
            hash.update((candidate.bytes.len() as u64).to_le_bytes());
            hash.update(&candidate.bytes);
        }
        None => hash.update([0]),
    }
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
fn serialize_change(
    session_dir: &Path,
    session: &AgentWorkspaceSession,
    record: &ChangeRecord,
) -> Result<AgentWorkspaceChange, String> {
    serialize_change_with_snapshot(
        session_dir,
        session,
        record,
        &git_storage::snapshot(session_dir, &session.source_commit)?,
    )
}

fn serialize_change_with_snapshot(
    session_dir: &Path,
    session: &AgentWorkspaceSession,
    record: &ChangeRecord,
    source_snapshot: &BTreeMap<String, FileEntry>,
) -> Result<AgentWorkspaceChange, String> {
    let source_root = Path::new(&session.project_root);
    let candidate_root = session_dir.join(CANDIDATE_DIR_NAME);
    let path = display_path(record);
    let source_path = record.old_path.clone().unwrap_or_else(|| path.clone());
    let source_changed = file_bytes(&source_root.join(safe_relative_path(&source_path)?))?
        != source_snapshot
            .get(&source_path)
            .map(|entry| entry.bytes.clone());
    let old_content = record
        .baseline
        .as_ref()
        .and_then(|entry| text_content(&entry.bytes));
    let new_content = record
        .candidate
        .as_ref()
        .and_then(|entry| text_content(&entry.bytes));
    let binary = record
        .baseline
        .as_ref()
        .is_some_and(|entry| text_content(&entry.bytes).is_none())
        || record
            .candidate
            .as_ref()
            .is_some_and(|entry| text_content(&entry.bytes).is_none());
    Ok(AgentWorkspaceChange {
        id: record.id.clone(),
        proposal_revision: proposal_revision(record),
        kind: record.kind.as_str().to_string(),
        file_path: path,
        old_file_path: record.old_path.clone(),
        new_file_path: record.new_path.clone(),
        source_absolute_path: source_root
            .join(safe_relative_path(&source_path)?)
            .to_string_lossy()
            .to_string(),
        candidate_absolute_path: record
            .new_path
            .as_ref()
            .map(|relative| candidate_root.join(relative).to_string_lossy().to_string()),
        old_content,
        new_content,
        binary,
        source_changed,
    })
}

// A reviewed result comes from LF editor text. Preserve the candidate's physical
// line endings while retaining byte-exact native revision/conflict checks.
fn encode_review_content(record: &ChangeRecord, content: &str) -> Vec<u8> {
    let disk = record.candidate.as_ref().or(record.baseline.as_ref()).and_then(|entry| std::str::from_utf8(&entry.bytes).ok()).unwrap_or("");
    catalex_document_core::encode_document_text(content, disk).into_bytes()
}

fn plan_change(
    record: &ChangeRecord,
    decision: &AgentWorkspaceDecision,
    source_root: &Path,
    source_snapshot: &BTreeMap<String, FileEntry>,
    session_dir: &Path,
) -> Result<PlannedOperation, String> {
    for relative in record.old_path.iter().chain(record.new_path.iter()) {
        ensure_no_symlink_components(source_root, relative)?;
    }
    let desired = decision
        .content
        .as_ref()
        .map(|content| encode_review_content(record, content))
        .or_else(|| record.candidate.as_ref().map(|entry| entry.bytes.clone()));
    match record.kind {
        ChangeKind::Added => {
            let path = record.new_path.as_ref().ok_or("Added change has no path")?;
            let desired = desired.ok_or("Added change has no candidate content")?;
            let current = file_bytes(&source_root.join(safe_relative_path(path)?))?;
            if current.as_ref().is_some_and(|bytes| bytes != &desired) {
                return Err("A different file now exists at this path".to_string());
            }
            Ok(PlannedOperation {
                remove_paths: Vec::new(),
                write_path: Some(path.clone()),
                write_bytes: Some(desired),
            })
        }
        ChangeKind::Modified => {
            let path = record
                .new_path
                .as_ref()
                .ok_or("Modified change has no path")?;
            let desired = desired.ok_or("Modified change has no candidate content")?;
            let base = source_snapshot.get(path).map(|entry| entry.bytes.clone());
            let current = file_bytes(&source_root.join(safe_relative_path(path)?))?;
            let settled = match (base, current) {
                (Some(base), Some(current)) => {
                    merge_if_needed(session_dir, &base, &current, &desired)?
                }
                (Some(_), None) => {
                    return Err(
                        "The source file was deleted while the agent was working".to_string()
                    )
                }
                (None, None) => desired,
                (None, Some(current)) if current == desired => desired,
                (None, Some(_)) => {
                    return Err("A different file now exists at this path".to_string())
                }
            };
            Ok(PlannedOperation {
                remove_paths: Vec::new(),
                write_path: Some(path.clone()),
                write_bytes: Some(settled),
            })
        }
        ChangeKind::Deleted => {
            let path = record
                .old_path
                .as_ref()
                .ok_or("Deleted change has no path")?;
            let base = source_snapshot.get(path).map(|entry| entry.bytes.clone());
            let current = file_bytes(&source_root.join(safe_relative_path(path)?))?;
            if current.is_some() && current != base {
                return Err("The source file changed while the agent was working".to_string());
            }
            Ok(PlannedOperation {
                remove_paths: vec![path.clone()],
                write_path: None,
                write_bytes: None,
            })
        }
        ChangeKind::Renamed => {
            let old_path = record.old_path.as_ref().ok_or("Rename has no old path")?;
            let new_path = record.new_path.as_ref().ok_or("Rename has no new path")?;
            let desired = desired.ok_or("Rename has no candidate content")?;
            let base = source_snapshot
                .get(old_path)
                .map(|entry| entry.bytes.clone());
            let current_old = file_bytes(&source_root.join(safe_relative_path(old_path)?))?;
            let current_new = file_bytes(&source_root.join(safe_relative_path(new_path)?))?;
            if current_old.is_none() && current_new.as_ref() == Some(&desired) {
                return Ok(PlannedOperation {
                    remove_paths: Vec::new(),
                    write_path: None,
                    write_bytes: None,
                });
            }
            if current_new.is_some() {
                return Err("The rename target now exists".to_string());
            }
            let settled = match (base, current_old) {
                (Some(base), Some(current)) => {
                    merge_if_needed(session_dir, &base, &current, &desired)?
                }
                (Some(_), None) => {
                    return Err(
                        "The file being renamed was removed while the agent was working"
                            .to_string(),
                    )
                }
                (None, None) => desired,
                (None, Some(_)) => {
                    return Err(
                        "A file appeared at the rename source while the agent was working"
                            .to_string(),
                    )
                }
            };
            Ok(PlannedOperation {
                remove_paths: vec![old_path.clone()],
                write_path: Some(new_path.clone()),
                write_bytes: Some(settled),
            })
        }
    }
}

fn merge_if_needed(
    session_dir: &Path,
    base: &[u8],
    current: &[u8],
    desired: &[u8],
) -> Result<Vec<u8>, String> {
    if current == base || current == desired {
        return Ok(desired.to_vec());
    }
    if desired == base {
        return Ok(current.to_vec());
    }
    if [base, current, desired]
        .iter()
        .any(|bytes| text_content(bytes).is_none())
    {
        return Err("Concurrent changes to a binary file cannot be merged automatically".into());
    }
    let (content, conflicts) = git_storage::merge(session_dir, base, current, desired)?;
    if conflicts.is_empty() {
        Ok(content)
    } else {
        Err("Concurrent edits overlap and need manual resolution".into())
    }
}

fn remove_empty_parent_dirs(path: &Path, source_root: &Path) {
    let mut parent = path.parent();
    while let Some(directory) = parent {
        if directory == source_root || !directory.starts_with(source_root) {
            break;
        }
        if fs::remove_dir(directory).is_err() {
            break;
        }
        parent = directory.parent();
    }
}

fn ensure_no_symlink_components(root: &Path, relative: &str) -> Result<(), String> {
    let safe = safe_relative_path(relative)?;
    let mut current = root.to_path_buf();
    for component in safe.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Refusing to apply through symbolic link {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!("Failed to inspect {}: {error}", current.display()));
            }
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    crate::project_files::replace_file(path, bytes)
}

fn file_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

fn text_content(bytes: &[u8]) -> Option<String> {
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES || bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok()
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha1::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn review_project_state_tracks_all_sources_but_ignores_generated_outputs() {
        let project = TempDir::new().unwrap();
        let root = project.path().to_str().unwrap();
        fs::write(project.path().join("accepted.tex"), "accepted text\n").unwrap();
        fs::write(project.path().join("pending.tex"), "pending text\n").unwrap();
        let before = review_project_state(root.into()).unwrap();
        fs::write(project.path().join("pending.aux"), "compiler output").unwrap();
        assert_eq!(before.revision, review_project_state(root.into()).unwrap().revision);
        fs::write(project.path().join("accepted.tex"), "external text\n").unwrap();
        assert!(check_review_project(root, &before.revision).unwrap_err().starts_with("project_changed:"));
        let edited = review_project_state(root.into()).unwrap();
        fs::remove_file(project.path().join("accepted.tex")).unwrap();
        assert_ne!(edited.revision, review_project_state(root.into()).unwrap().revision);
        assert_eq!(fs::read_to_string(project.path().join("pending.tex")).unwrap(), "pending text\n");
    }

    #[test]
    fn review_project_state_detects_git_only_changes_and_unfinished_merge() {
        let project = TempDir::new().unwrap();
        let root = project.path().to_str().unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git").current_dir(project.path())
                .args(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"])
                .args(args).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        };
        git(&["init", "--initial-branch=main"]);
        fs::write(project.path().join("main.tex"), "source\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "Initial"]);
        let before = review_project_state(root.into()).unwrap();
        git(&["status", "--porcelain"]);
        assert_eq!(before.revision, review_project_state(root.into()).unwrap().revision);
        git(&["checkout", "-b", "other"]);
        let switched = review_project_state(root.into()).unwrap();
        assert_ne!(before.revision, switched.revision);
        git(&["commit", "--allow-empty", "-m", "Metadata only"]);
        let committed = review_project_state(root.into()).unwrap();
        assert_ne!(switched.revision, committed.revision);
        git(&["update-index", "--chmod=+x", "main.tex"]);
        assert_ne!(committed.revision, review_project_state(root.into()).unwrap().revision);
        let repo = git2::Repository::open(project.path()).unwrap();
        fs::write(repo.path().join("MERGE_HEAD"), repo.head().unwrap().target().unwrap().to_string()).unwrap();
        let merging = review_project_state(root.into()).unwrap();
        assert!(merging.git_pending);
        // Even without unresolved index entries, an unfinished merge blocks acceptance.
        assert!(!repo.index().unwrap().has_conflicts());
        assert!(check_review_project(root, &merging.revision).is_err());
        fs::remove_file(repo.path().join("MERGE_HEAD")).unwrap();
        assert!(!review_project_state(root.into()).unwrap().git_pending);
    }

    #[test]
    fn comments_stay_on_source_and_cannot_enter_review() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::create_dir(project.path().join("sub")).unwrap();
        for name in ["comments.json", "comments-agents.json"] {
            fs::write(project.path().join(name), "source metadata").unwrap();
            fs::write(
                project.path().join("sub").join(name),
                "ordinary nested file",
            )
            .unwrap();
        }
        fs::write(project.path().join("main.tex"), "source").unwrap();
        let session = prepare(&project, &workspaces, vec![]);
        let candidate = Path::new(&session.candidate_root);
        for name in ["comments.json", "comments-agents.json"] {
            assert!(!candidate.join(name).exists());
            assert!(candidate.join("sub").join(name).exists());
            fs::write(
                candidate.join(name),
                "agent must not replace source metadata",
            )
            .unwrap();
            assert!(safe_relative_path(name).is_err());
        }
        assert!(reconcile_records(candidate.parent().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn comment_scope_rejects_wrong_project_tab_finished_and_removed_drafts() {
        let project = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let mut session = prepare(&project, &workspaces, vec![]);
        let root = project.path().to_str().unwrap();
        let check = |project: &str, tab: &str| {
            validate_comment_scope_in_root(workspaces.path(), project, &session.candidate_root, tab)
        };
        assert!(check(root, "tab-1").is_ok());
        assert!(check(root, "wrong-tab").is_err());
        assert!(check(other.path().to_str().unwrap(), "tab-1").is_err());
        session.status = "completed".into();
        save_session(
            Path::new(&session.candidate_root).parent().unwrap(),
            &session,
        )
        .unwrap();
        assert!(validate_comment_scope_in_root(
            workspaces.path(),
            root,
            &session.candidate_root,
            "tab-1"
        )
        .is_err());
        fs::remove_dir_all(&session.candidate_root).unwrap();
        assert!(validate_comment_scope_in_root(
            workspaces.path(),
            root,
            &session.candidate_root,
            "tab-1"
        )
        .is_err());
    }

    fn apply_test_operations(
        root: &Path,
        dir: &Path,
        operations: &[PlannedOperation],
    ) -> Result<Vec<String>, String> {
        let mut session = load_session(dir)?;
        ensure_session_project(&session, root.to_str().unwrap())?;
        let records = reconcile_records(dir)?;
        let decisions = records
            .iter()
            .map(|record| {
                (
                    record.id.clone(),
                    AgentWorkspaceDecision {
                        change_id: record.id.clone(),
                        accept: true,
                        ..Default::default()
                    },
                )
            })
            .collect();
        git_storage::prepare_settlement(dir, &session, &records, &decisions, operations, None)?;
        let changed = git_storage::apply_settlement_files(dir)?;
        git_storage::recover_settlement(dir, &mut session)?;
        Ok(changed)
    }

    fn prepare(
        project: &TempDir,
        workspaces: &TempDir,
        dirty: Vec<DirtyBuffer>,
    ) -> AgentWorkspaceSession {
        prepare_workspace_in_root(
            workspaces.path(),
            &project.path().to_string_lossy(),
            "tab-1",
            Some("shared-session-1".to_string()),
            "ask",
            dirty,
        )
        .unwrap()
    }

    #[test]
    fn refinement_resumes_same_candidate_across_multiple_rounds() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "source").unwrap();
        let mut session = prepare(&project, &workspaces, vec![]);
        let dir = session_dir(workspaces.path(), &session.session_id).unwrap();
        for (round, outcome) in ["review", "failed", "cancelled", "review"]
            .iter()
            .enumerate()
        {
            let content = format!("draft {round}");
            fs::write(
                Path::new(&session.candidate_root).join("main.tex"),
                &content,
            )
            .unwrap();
            session.status = outcome.to_string();
            save_session(&dir, &session).unwrap();
            let resumed = resume_workspace(&dir, &session.project_root, "tab-1", None).unwrap();
            assert_eq!(resumed.status, "active");
            assert_eq!(resumed.session_id, session.session_id);
            assert_eq!(resumed.candidate_root, session.candidate_root);
            assert_eq!(
                fs::read_to_string(Path::new(&resumed.candidate_root).join("main.tex")).unwrap(),
                content
            );
            assert_eq!(
                fs::read_to_string(project.path().join("main.tex")).unwrap(),
                "source"
            );
            assert_eq!(load_session(&dir).unwrap().status, "active");
        }
    }

    #[test]
    fn refinement_checks_owner_project_and_unsettled_status() {
        let project = TempDir::new().unwrap();
        let other_project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let mut session = prepare(&project, &workspaces, vec![]);
        let dir = session_dir(workspaces.path(), &session.session_id).unwrap();
        session.status = "review".into();
        save_session(&dir, &session).unwrap();
        assert!(resume_workspace(&dir, &session.project_root, "other-tab", None).is_err());
        assert!(resume_workspace(
            &dir,
            &session.project_root,
            "other-tab",
            Some("wrong-conversation")
        )
        .is_err());
        assert!(
            resume_workspace(&dir, &other_project.path().to_string_lossy(), "tab-1", None).is_err()
        );
        for status in ["settled", "conflict", "active", "resume-backup"] {
            session.status = status.into();
            save_session(&dir, &session).unwrap();
            assert!(resume_workspace(&dir, &session.project_root, "tab-1", None).is_err());
            assert_eq!(load_session(&dir).unwrap().status, status);
        }
        session.status = "review".into();
        save_session(&dir, &session).unwrap();
        let restored = resume_workspace(
            &dir,
            &session.project_root,
            "recovered-tab",
            Some("shared-session-1"),
        )
        .unwrap();
        assert_eq!(restored.tab_id, "recovered-tab");
        assert_eq!(load_session(&dir).unwrap().tab_id, "recovered-tab");
    }

    #[test]
    fn proposal_revision_tracks_binary_bytes_without_changing_identity() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("figure.png"), [0, 1, 2]).unwrap();
        let session = prepare(&project, &workspaces, vec![]);
        let dir = session_dir(workspaces.path(), &session.session_id).unwrap();
        let candidate = Path::new(&session.candidate_root).join("figure.png");
        fs::write(&candidate, [0, 3, 4]).unwrap();
        let first = serialize_change(&dir, &session, &reconcile_records(&dir).unwrap()[0]).unwrap();
        let identical =
            serialize_change(&dir, &session, &reconcile_records(&dir).unwrap()[0]).unwrap();
        assert!(first.binary);
        assert_eq!(first.proposal_revision, identical.proposal_revision);
        fs::write(&candidate, [0, 3, 5]).unwrap();
        let second =
            serialize_change(&dir, &session, &reconcile_records(&dir).unwrap()[0]).unwrap();
        assert_eq!(first.id, second.id);
        assert_ne!(first.proposal_revision, second.proposal_revision);
        fs::remove_file(candidate).unwrap();
        let deletion =
            serialize_change(&dir, &session, &reconcile_records(&dir).unwrap()[0]).unwrap();
        assert_ne!(second.proposal_revision, deletion.proposal_revision);
    }

    #[test]
    fn creates_isolated_candidate_with_dirty_buffers() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "source").unwrap();

        let session = prepare(
            &project,
            &workspaces,
            vec![DirtyBuffer {
                relative_path: "main.tex".to_string(),
                content: "dirty".to_string(),
            }],
        );

        assert_eq!(
            session.shared_session_id.as_deref(),
            Some("shared-session-1")
        );

        assert_eq!(
            fs::read_to_string(project.path().join("main.tex")).unwrap(),
            "source"
        );
        assert_eq!(
            String::from_utf8(
                git_storage::snapshot(
                    &workspaces.path().join(&session.session_id),
                    &session.source_commit
                )
                .unwrap()["main.tex"]
                    .bytes
                    .clone()
            )
            .unwrap(),
            "source"
        );
        assert_eq!(
            String::from_utf8(
                git_storage::snapshot(
                    &workspaces.path().join(&session.session_id),
                    &session.baseline_commit
                )
                .unwrap()["main.tex"]
                    .bytes
                    .clone()
            )
            .unwrap(),
            "dirty"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&session.candidate_root).join("main.tex")).unwrap(),
            "dirty"
        );
        assert_eq!(session.dirty_buffers.len(), 1);
    }

    #[test]
    fn makes_read_only_source_files_writable_only_in_workspace() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let source = project.path().join("main.tex");
        fs::write(&source, "source").unwrap();
        let mut permissions = fs::metadata(&source).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&source, permissions).unwrap();

        let session = prepare(&project, &workspaces, Vec::new());
        let candidate = Path::new(&session.candidate_root).join("main.tex");
        assert!(fs::metadata(&source).unwrap().permissions().readonly());
        assert!(!fs::metadata(candidate).unwrap().permissions().readonly());
    }

    #[test]
    fn reconciles_add_modify_delete_and_rename() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("modify.tex"), "before").unwrap();
        fs::write(project.path().join("delete.tex"), "delete").unwrap();
        fs::write(project.path().join("old.tex"), "rename").unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        let candidate = Path::new(&session.candidate_root);
        fs::write(candidate.join("modify.tex"), "after").unwrap();
        fs::remove_file(candidate.join("delete.tex")).unwrap();
        fs::rename(candidate.join("old.tex"), candidate.join("new.tex")).unwrap();
        fs::write(candidate.join("added.tex"), "added").unwrap();

        let records =
            reconcile_records(workspaces.path().join(&session.session_id).as_path()).unwrap();
        assert_eq!(records.len(), 4);
        assert!(records
            .iter()
            .any(|record| record.kind == ChangeKind::Modified));
        assert!(records
            .iter()
            .any(|record| record.kind == ChangeKind::Deleted));
        assert!(records
            .iter()
            .any(|record| record.kind == ChangeKind::Renamed));
        assert!(records
            .iter()
            .any(|record| record.kind == ChangeKind::Added));
    }

    #[test]
    fn accepted_agent_merge_preserves_both_comment_groups_and_identity() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let comments = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "one\ntwo\nthree\n").unwrap();
        for agent in [false, true] {
            let origin = if agent {
                serde_json::json!({"provider":"codex","sessionId":"test"})
            } else {
                serde_json::Value::Null
            };
            crate::comments::test_write(comments.path().join(if agent {"agent.json"} else {"human.json"}), serde_json::json!({"version":1,"counter":1,"files":{"main.tex":[{"id":if agent {"A-1"} else {"H-1"},"number":1,"from":4,"to":7,"line":2,"text":"Keep feedback","resolved":true,"origin":origin,"anchorRevision":"a"}]},"sources":{"a":"one\ntwo\nthree\n"}}).to_string()).unwrap();
        }
        crate::comments::refresh_revisions(project.path(), comments.path(), &["main.tex".into()])
            .unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        fs::write(
            Path::new(&session.candidate_root).join("main.tex"),
            "one\ntwo\nTHREE\n",
        )
        .unwrap();
        fs::write(project.path().join("main.tex"), "ONE\ntwo\nthree\n").unwrap();
        let dir = workspaces.path().join(&session.session_id);
        let records = reconcile_records(&dir).unwrap();
        let decisions = records
            .iter()
            .map(|r| AgentWorkspaceDecision {
                change_id: r.id.clone(),
                accept: true,
                content: None,
                ..Default::default()
            })
            .collect();
        let result = apply_workspace_with_comments(
            Some(comments.path()),
            &dir,
            &session.project_root,
            decisions,
            None,
        )
        .unwrap();
        assert!(result.applied);
        assert_eq!(result.comment_patches.len(), 2);
        assert!(result.comment_patches.iter().all(|patch| patch.file_path == "main.tex" && patch.before.is_some() && patch.after.is_some()));
        assert!(result.comment_warning.is_none());
        assert_eq!(
            fs::read_to_string(project.path().join("main.tex")).unwrap(),
            "ONE\ntwo\nTHREE\n"
        );
        for agent in [false, true] {
            let path = comments
                .path()
                .join(if agent { "agent.json" } else { "human.json" });
            let saved: serde_json::Value =
                serde_json::from_slice(&crate::comments::test_read(path).unwrap()).unwrap();
            assert_eq!(saved["files"]["main.tex"][0]["text"], "Keep feedback");
            assert_eq!(saved["files"]["main.tex"][0]["resolved"], true);
            assert_eq!(saved["revisions"]["main.tex"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn accepted_agent_rename_moves_comment_paths() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let comments = TempDir::new().unwrap();
        fs::write(project.path().join("old.md"), "source").unwrap();
        crate::comments::test_write(comments.path().join("human.json"), serde_json::json!({"version": 1, "counter": 1,
            "files": {"old.md": [{"id": "H-1", "number": 1, "from": 0, "to": 6, "line": 1, "text": "Keep", "resolved": true}]},
            "sources": {}}).to_string()).unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        let candidate = Path::new(&session.candidate_root);
        fs::rename(candidate.join("old.md"), candidate.join("new.md")).unwrap();
        let dir = workspaces.path().join(&session.session_id);
        let records = reconcile_records(&dir).unwrap();
        let decisions = records
            .iter()
            .map(|record| AgentWorkspaceDecision {
                change_id: record.id.clone(),
                accept: true,
                content: None,
                ..Default::default()
            })
            .collect();
        let result = apply_workspace_with_comments(
            Some(comments.path()),
            &dir,
            &session.project_root,
            decisions,
            None,
        )
        .unwrap();
        assert!(result.applied);
        assert_eq!(result.path_changes.len(), 1);
        assert!(result.comment_warning.is_none());
        let saved: serde_json::Value =
            serde_json::from_slice(&crate::comments::test_read(comments.path().join("human.json")).unwrap()).unwrap();
        assert!(saved["files"]["old.md"].is_null());
        assert_eq!(saved["files"]["new.md"][0]["id"], "H-1");
        assert_eq!(saved["files"]["new.md"][0]["resolved"], true);
    }

    #[test]
    fn applies_add_modify_delete_and_rename_together() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("modify.tex"), "before").unwrap();
        fs::write(project.path().join("delete.tex"), "delete").unwrap();
        fs::write(project.path().join("old.tex"), "rename").unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        let candidate = Path::new(&session.candidate_root);
        fs::write(candidate.join("modify.tex"), "after").unwrap();
        fs::remove_file(candidate.join("delete.tex")).unwrap();
        fs::rename(candidate.join("old.tex"), candidate.join("new.tex")).unwrap();
        fs::write(candidate.join("added.tex"), "added").unwrap();

        let session_dir = workspaces.path().join(&session.session_id);
        let records = reconcile_records(&session_dir).unwrap();
        let operations = records
            .iter()
            .map(|record| {
                plan_change(
                    record,
                    &AgentWorkspaceDecision {
                        change_id: record.id.clone(),
                        accept: true,
                        content: None,
                        ..Default::default()
                    },
                    project.path(),
                    &git_storage::snapshot(
                        &workspaces.path().join(&session.session_id),
                        &session.source_commit,
                    )
                    .unwrap(),
                    &workspaces.path().join(&session.session_id),
                )
                .unwrap()
            })
            .collect::<Vec<_>>();

        let changed = apply_test_operations(project.path(), &session_dir, &operations).unwrap();
        assert_eq!(
            changed,
            vec![
                "added.tex",
                "delete.tex",
                "modify.tex",
                "new.tex",
                "old.tex"
            ]
        );
        assert_eq!(
            fs::read_to_string(project.path().join("modify.tex")).unwrap(),
            "after"
        );
        assert_eq!(
            fs::read_to_string(project.path().join("added.tex")).unwrap(),
            "added"
        );
        assert_eq!(
            fs::read_to_string(project.path().join("new.tex")).unwrap(),
            "rename"
        );
        assert!(!project.path().join("delete.tex").exists());
        assert!(!project.path().join("old.tex").exists());
    }

    #[test]
    fn merges_non_overlapping_concurrent_text_edits() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        let dir = workspaces.path().join(session.session_id);
        assert_eq!(
            merge_if_needed(
                &dir,
                b"one\nkeep\nlast\n",
                b"ONE\nkeep\nlast\n",
                b"one\nkeep\nLAST\n"
            )
            .unwrap(),
            b"ONE\nkeep\nLAST\n"
        );
        assert!(merge_if_needed(&dir, b"one\n", b"current\n", b"desired\n").is_err());
    }

    #[test]
    fn previews_second_agent_against_first_accepted_draft() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "one\ntwo\nthree\n").unwrap();
        let first = prepare(&project, &workspaces, Vec::new());
        let second = prepare(&project, &workspaces, Vec::new());
        fs::write(
            Path::new(&first.candidate_root).join("main.tex"),
            "ONE\ntwo\nthree\n",
        )
        .unwrap();
        fs::write(
            Path::new(&second.candidate_root).join("main.tex"),
            "one\ntwo\nTHREE\n",
        )
        .unwrap();
        let second_dir = workspaces.path().join(&second.session_id);
        let before = preview_workspace(&second_dir, second.clone(), &[]).unwrap();
        let first_dir = workspaces.path().join(&first.session_id);
        let record = reconcile_records(&first_dir).unwrap().remove(0);
        let operation = plan_change(
            &record,
            &AgentWorkspaceDecision {
                change_id: record.id.clone(),
                accept: true,
                content: None,
                ..Default::default()
            },
            project.path(),
            &git_storage::snapshot(
                &workspaces.path().join(&first.session_id),
                &first.source_commit,
            )
            .unwrap(),
            &workspaces.path().join(&first.session_id),
        )
        .unwrap();
        apply_test_operations(project.path(), &first_dir, &[operation]).unwrap();
        let after = preview_workspace(&second_dir, second.clone(), &[]).unwrap();
        assert!(after.conflicts.is_empty());
        assert_ne!(before.source_revision, after.source_revision);
        let id = &after.changes[0].id;
        assert_eq!(
            after.merged_contents[id].as_deref(),
            Some("ONE\ntwo\nTHREE\n")
        );
        assert_eq!(
            after.current_contents[id].as_deref(),
            Some("ONE\ntwo\nthree\n")
        );
        assert_eq!(
            after.changes[0].new_content.as_deref(),
            Some("one\ntwo\nTHREE\n")
        );
        // A conflicting second draft is reported without modifying either copy.
        fs::write(
            Path::new(&second.candidate_root).join("main.tex"),
            "other\ntwo\nthree\n",
        )
        .unwrap();
        let conflict = preview_workspace(&second_dir, second, &[]).unwrap();
        assert_eq!(conflict.conflicts.len(), 1);
        assert!(conflict.merged_contents.is_empty());
        assert_eq!(
            fs::read_to_string(project.path().join("main.tex")).unwrap(),
            "ONE\ntwo\nthree\n"
        );
    }

    #[test]
    fn rechecks_review_edits_without_changing_the_sandbox() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let path = project.path().join("main.tex");
        fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        let candidate = Path::new(&session.candidate_root).join("main.tex");
        fs::write(&candidate, "one\ntwo\nagent\n").unwrap();
        let session_dir = workspaces.path().join(&session.session_id);
        let preview = preview_workspace(&session_dir, session.clone(), &[]).unwrap();
        let decision = AgentWorkspaceDecision {
            change_id: preview.changes[0].id.clone(),
            accept: true,
            content: Some("one\ntwo\nreviewer\n".to_string()),
            ..Default::default()
        };
        fs::write(&path, "OTHER AGENT\ntwo\nthree\n").unwrap();
        let refreshed =
            preview_workspace(&session_dir, session.clone(), &[decision.clone()]).unwrap();
        assert!(refreshed.conflicts.is_empty());
        assert_eq!(refreshed.changes[0].new_content, decision.content);
        assert_eq!(
            refreshed.merged_contents[&decision.change_id].as_deref(),
            Some("OTHER AGENT\ntwo\nreviewer\n")
        );
        assert_eq!(fs::read_to_string(&candidate).unwrap(), "one\ntwo\nagent\n");
        fs::write(&path, "one\ntwo\nconflicting edit\n").unwrap();
        let conflict = preview_workspace(&session_dir, session, &[decision.clone()]).unwrap();
        assert_eq!(conflict.conflicts.len(), 1);
        assert_eq!(conflict.changes[0].new_content, decision.content);
    }

    #[test]
    fn revision_bound_apply_checks_source_and_preserves_reviewed_text() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let path = project.path().join("main.tex");
        fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        fs::write(
            Path::new(&session.candidate_root).join("main.tex"),
            "one\ntwo\nTHREE\n",
        )
        .unwrap();
        let session_dir = workspaces.path().join(&session.session_id);
        let preview = preview_workspace(&session_dir, session.clone(), &[]).unwrap();
        fs::write(&path, "ONE\ntwo\nthree\n").unwrap();
        let decision = AgentWorkspaceDecision {
            change_id: preview.changes[0].id.clone(),
            accept: true,
            content: Some("ONE\nreviewed\nTHREE\n".to_string()),
            ..Default::default()
        };
        let result = apply_workspace(
            &session_dir,
            &session.project_root,
            vec![decision.clone()],
            Some(preview.source_revision),
        )
        .unwrap();
        assert!(!result.applied);
        assert!(!result.conflicts.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "ONE\ntwo\nthree\n");
        let refreshed = preview_workspace(&session_dir, session.clone(), &[]).unwrap();
        let result = apply_workspace(
            &session_dir,
            &session.project_root,
            vec![decision],
            Some(refreshed.source_revision),
        )
        .unwrap();
        assert!(result.applied);
        assert_eq!(fs::read_to_string(&path).unwrap(), "ONE\nreviewed\nTHREE\n");
    }

    #[test]
    fn applies_non_overlapping_source_and_agent_edits() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "one\ntwo\nthree\n").unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        fs::write(
            Path::new(&session.candidate_root).join("main.tex"),
            "one\ntwo\nTHREE\n",
        )
        .unwrap();
        fs::write(project.path().join("main.tex"), "ONE\ntwo\nthree\n").unwrap();

        let session_dir = workspaces.path().join(&session.session_id);
        let record = reconcile_records(&session_dir).unwrap().remove(0);
        let decision = AgentWorkspaceDecision {
            change_id: record.id.clone(),
            accept: true,
            content: None,
            ..Default::default()
        };
        let operation = plan_change(
            &record,
            &decision,
            project.path(),
            &git_storage::snapshot(
                &workspaces.path().join(&session.session_id),
                &session.source_commit,
            )
            .unwrap(),
            &workspaces.path().join(&session.session_id),
        )
        .unwrap();
        apply_test_operations(project.path(), &session_dir, &[operation]).unwrap();

        assert_eq!(
            fs::read_to_string(project.path().join("main.tex")).unwrap(),
            "ONE\ntwo\nTHREE\n"
        );
    }

    #[test]
    fn applies_agent_edits_to_an_unsaved_new_buffer() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let session = prepare(
            &project,
            &workspaces,
            vec![DirtyBuffer {
                relative_path: "draft.tex".to_string(),
                content: "user draft\n".to_string(),
            }],
        );
        fs::write(
            Path::new(&session.candidate_root).join("draft.tex"),
            "polished draft\n",
        )
        .unwrap();

        let session_dir = workspaces.path().join(&session.session_id);
        let record = reconcile_records(&session_dir).unwrap().remove(0);
        let operation = plan_change(
            &record,
            &AgentWorkspaceDecision {
                change_id: record.id.clone(),
                accept: true,
                content: None,
                ..Default::default()
            },
            project.path(),
            &git_storage::snapshot(
                &workspaces.path().join(&session.session_id),
                &session.source_commit,
            )
            .unwrap(),
            &workspaces.path().join(&session.session_id),
        )
        .unwrap();
        apply_test_operations(project.path(), &session_dir, &[operation]).unwrap();

        assert_eq!(
            fs::read_to_string(project.path().join("draft.tex")).unwrap(),
            "polished draft\n"
        );
    }

    #[test]
    fn applies_agent_rename_of_an_unsaved_new_buffer() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let session = prepare(
            &project,
            &workspaces,
            vec![DirtyBuffer {
                relative_path: "draft.tex".to_string(),
                content: "user draft\n".to_string(),
            }],
        );
        fs::rename(
            Path::new(&session.candidate_root).join("draft.tex"),
            Path::new(&session.candidate_root).join("renamed.tex"),
        )
        .unwrap();

        let session_dir = workspaces.path().join(&session.session_id);
        let record = reconcile_records(&session_dir).unwrap().remove(0);
        assert_eq!(record.kind, ChangeKind::Renamed);
        let operation = plan_change(
            &record,
            &AgentWorkspaceDecision {
                change_id: record.id.clone(),
                accept: true,
                content: None,
                ..Default::default()
            },
            project.path(),
            &git_storage::snapshot(
                &workspaces.path().join(&session.session_id),
                &session.source_commit,
            )
            .unwrap(),
            &workspaces.path().join(&session.session_id),
        )
        .unwrap();
        apply_test_operations(project.path(), &session_dir, &[operation]).unwrap();

        assert!(!project.path().join("draft.tex").exists());
        assert_eq!(
            fs::read_to_string(project.path().join("renamed.tex")).unwrap(),
            "user draft\n"
        );
    }

    #[test]
    fn refuses_overlapping_source_and_agent_edits() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "before\n").unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        fs::write(
            Path::new(&session.candidate_root).join("main.tex"),
            "agent\n",
        )
        .unwrap();
        fs::write(project.path().join("main.tex"), "external\n").unwrap();

        let record = reconcile_records(&workspaces.path().join(&session.session_id))
            .unwrap()
            .remove(0);
        let result = plan_change(
            &record,
            &AgentWorkspaceDecision {
                change_id: record.id.clone(),
                accept: true,
                content: None,
                ..Default::default()
            },
            project.path(),
            &git_storage::snapshot(
                &workspaces.path().join(&session.session_id),
                &session.source_commit,
            )
            .unwrap(),
            &workspaces.path().join(&session.session_id),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(project.path().join("main.tex")).unwrap(),
            "external\n"
        );
    }

    #[test]
    fn refuses_concurrent_binary_edits() {
        assert!(merge_if_needed(Path::new("unused"), &[0, 1], &[0, 2], &[0, 3]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_apply_through_a_source_symlink() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("main.tex"), "outside").unwrap();
        symlink(outside.path(), project.path().join("linked")).unwrap();

        let result = ensure_no_symlink_components(project.path(), "linked/main.tex");
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("main.tex")).unwrap(),
            "outside"
        );
    }

    #[test]
    fn rejects_parent_traversal_in_dirty_buffer() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let result = prepare_workspace_in_root(
            workspaces.path(),
            &project.path().to_string_lossy(),
            "tab-1",
            None,
            "ask",
            vec![DirtyBuffer {
                relative_path: "../outside".to_string(),
                content: "bad".to_string(),
            }],
        );
        assert!(result.is_err());
    }

    #[test]
    fn ignores_agent_output_in_excluded_directories() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "source").unwrap();
        let session = prepare(&project, &workspaces, Vec::new());
        let generated = Path::new(&session.candidate_root).join("target");
        fs::create_dir(&generated).unwrap();
        fs::write(generated.join("artifact.txt"), "generated").unwrap();

        let records = reconcile_records(&workspaces.path().join(&session.session_id)).unwrap();
        assert!(records.is_empty());
        assert!(safe_relative_path(".git/config").is_err());
    }
}
