//! Private draft storage. Only the candidate is materialized; immutable states
//! share the project's history object database. Callers serialize mutations with
//! the history gate so retention cannot collect objects during a transaction.
use super::*;
use git2::{
    DiffFindOptions, Index, IndexEntry, IndexTime, Oid, Repository, Signature, WorktreeAddOptions,
};

fn repository_path(dir: &Path) -> Result<PathBuf, String> {
    let workspaces = dir.parent().ok_or("Workspace has no parent")?;
    // Production storage is a sibling of history.git; standalone test stores
    // deliberately own their own repository as well.
    Ok(
        if workspaces
            .file_name()
            .is_some_and(|name| name == "agent-workspaces")
        {
            workspaces
                .parent()
                .ok_or("Workspace has no project storage")?
                .join("history.git")
        } else {
            workspaces.join("history.git")
        },
    )
}
pub(super) fn repository(dir: &Path) -> Result<Repository, String> {
    Repository::open(repository_path(dir)?)
        .map_err(|e| format!("Private draft repository unavailable: {e}"))
}
fn entry(path: &str, oid: Oid, size: usize) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        file_size: size.min(u32::MAX as usize) as u32,
        id: oid,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}
fn tree(repo: &Repository, files: &BTreeMap<String, FileEntry>) -> Result<Oid, String> {
    let mut index = Index::new().map_err(|e| e.to_string())?;
    for (path, file) in files {
        safe_relative_path(path)?;
        let oid = repo.blob(&file.bytes).map_err(|e| e.to_string())?;
        let mut item = entry(path, oid, file.bytes.len());
        item.mode = file.mode;
        index.add(&item).map_err(|e| e.to_string())?;
    }
    index.write_tree_to(repo).map_err(|e| e.to_string())
}
fn commit(repo: &Repository, tree: Oid, parent: Option<Oid>, message: &str) -> Result<Oid, String> {
    let tree = repo.find_tree(tree).map_err(|e| e.to_string())?;
    let parent = parent
        .map(|oid| repo.find_commit(oid))
        .transpose()
        .map_err(|e| e.to_string())?;
    let sig = Signature::now(env!("APP_BRAND_NAME"), "catalex@local").map_err(|e| e.to_string())?;
    repo.commit(
        None,
        &sig,
        &sig,
        message,
        &tree,
        &parent.iter().collect::<Vec<_>>(),
    )
    .map_err(|e| e.to_string())
}
fn session_id(dir: &Path) -> Result<&str, String> {
    dir.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid session directory".into())
}
fn pin(repo: &Repository, id: &str, kind: &str, oid: Oid) -> Result<(), String> {
    // OID-named refs keep previous revision snapshots across baseline changes.
    repo.reference(
        &format!("refs/catalex/agents/{id}/{kind}/{oid}"),
        oid,
        true,
        "Private draft checkpoint",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn attach(repo: &Repository, dir: &Path, baseline: Oid) -> Result<(), String> {
    let id = session_id(dir)?;
    let name = format!("catalex-agent-{id}");
    let branch = repo
        .reference(
            &format!("refs/heads/{name}"),
            baseline,
            true,
            "Private agent draft",
        )
        .map_err(|e| e.to_string())?;
    let mut opts = WorktreeAddOptions::new();
    opts.reference(Some(&branch));
    let candidate = dir.join(CANDIDATE_DIR_NAME);
    if repo.find_worktree(&name).is_err() {
        repo.worktree(&name, &candidate, Some(&opts))
            .map_err(|e| format!("Cannot create private worktree: {e}"))?;
    }
    Ok(())
}
pub(super) fn create(
    dir: &Path,
    source: &BTreeMap<String, FileEntry>,
    baseline: &BTreeMap<String, FileEntry>,
    _warnings: &mut Vec<String>,
) -> Result<(String, String), String> {
    let path = repository_path(dir)?;
    let repo = if path.exists() {
        repository(dir)?
    } else {
        Repository::init(&path).map_err(|e| e.to_string())?
    };
    let source_tree = tree(&repo, source)?;
    let source_oid = commit(&repo, source_tree, None, "Agent starting project snapshot")?;
    let baseline_tree = tree(&repo, baseline)?;
    let baseline_oid = if source_tree == baseline_tree {
        source_oid
    } else {
        commit(
            &repo,
            baseline_tree,
            Some(source_oid),
            "Agent editor baseline",
        )?
    };
    let id = session_id(dir)?;
    pin(&repo, id, "source", source_oid)?;
    pin(&repo, id, "baseline", baseline_oid)?;
    attach(&repo, dir, baseline_oid)?;
    Ok((source_oid.to_string(), baseline_oid.to_string()))
}
pub(super) fn snapshot(dir: &Path, oid: &str) -> Result<BTreeMap<String, FileEntry>, String> {
    let repo = repository(dir)?;
    let tree = repo
        .find_commit(Oid::from_str(oid).map_err(|e| e.to_string())?)
        .and_then(|commit| commit.tree())
        .map_err(|e| e.to_string())?;
    let mut files = BTreeMap::new();
    fn visit(
        repo: &Repository,
        tree: &git2::Tree<'_>,
        prefix: &str,
        files: &mut BTreeMap<String, FileEntry>,
    ) -> Result<(), String> {
        for item in tree {
            let name = item.name().ok_or("Draft contains a non-UTF8 filename")?;
            let path = format!("{prefix}{name}");
            match item.kind() {
                Some(git2::ObjectType::Tree) => visit(
                    repo,
                    &repo.find_tree(item.id()).map_err(|e| e.to_string())?,
                    &format!("{path}/"),
                    files,
                )?,
                Some(git2::ObjectType::Blob) => {
                    let bytes = repo
                        .find_blob(item.id())
                        .map_err(|e| e.to_string())?
                        .content()
                        .to_vec();
                    files.insert(
                        path,
                        FileEntry {
                            mode: item.filemode() as u32,
                            digest: hex_digest(&bytes),
                            bytes,
                        },
                    );
                }
                _ => return Err("Unsupported object in private draft".into()),
            }
        }
        Ok(())
    }
    visit(&repo, &tree, "", &mut files)?;
    Ok(files)
}
fn inventory_tree(repo: &Repository, root: &Path) -> Result<Oid, String> {
    let mut index = Index::new().map_err(|e| e.to_string())?;
    visit_inventory(root, root, &mut |path, file| {
        let oid = repo.blob(&file.bytes).map_err(|e| e.to_string())?;
        let mut item = entry(&path, oid, file.bytes.len());
        item.mode = file.mode;
        index.add(&item).map_err(|e| e.to_string())
    })?;
    // Explicit editor buffers remain part of the draft even when their suffix
    // normally denotes generated output. Internal paths are still rejected.
    let session = read_session_manifest(root.parent().ok_or("Missing draft directory")?)?;
    for buffer in &session.dirty_buffers {
        let path = safe_relative_path(&buffer.relative_path)?;
        if !crate::private_files::excluded(root, &path) {
            continue;
        }
        let full = root.join(&path);
        if !full.try_exists().map_err(|e| e.to_string())? {
            continue;
        }
        ensure_no_symlink_components(root, &buffer.relative_path)?;
        let bytes = fs::read(&full).map_err(|e| e.to_string())?;
        let oid = repo.blob(&bytes).map_err(|e| e.to_string())?;
        let mut item = entry(&buffer.relative_path, oid, bytes.len());
        item.mode = file_mode(&full)?;
        index.add(&item).map_err(|e| e.to_string())?;
    }
    index.write_tree_to(repo).map_err(|e| e.to_string())
}

fn tree_file(repo: &Repository, oid: Oid, mode: u32) -> Result<FileEntry, String> {
    let bytes = repo
        .find_blob(oid)
        .map_err(|e| e.to_string())?
        .content()
        .to_vec();
    Ok(FileEntry {
        digest: hex_digest(&bytes),
        bytes,
        mode,
    })
}

pub(super) fn snapshot_records(
    dir: &Path,
    oid: &str,
    records: &[ChangeRecord],
) -> Result<BTreeMap<String, FileEntry>, String> {
    let repo = repository(dir)?;
    let tree = repo
        .find_commit(Oid::from_str(oid).map_err(|e| e.to_string())?)
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    let mut files = BTreeMap::new();
    for path in records
        .iter()
        .flat_map(|r| r.old_path.iter().chain(r.new_path.iter()))
        .collect::<BTreeSet<_>>()
    {
        match tree.get_path(Path::new(path)) {
            Ok(item) => {
                files.insert(
                    path.clone(),
                    tree_file(&repo, item.id(), item.filemode() as u32)?,
                );
            }
            Err(e) if e.code() == git2::ErrorCode::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(files)
}

pub(super) fn checkpoint(dir: &Path) -> Result<(), String> {
    checkpoint_with_parent(dir, None)
}

fn checkpoint_with_parent(dir: &Path, baseline: Option<Oid>) -> Result<(), String> {
    let repo = repository(dir)?;
    let oid = inventory_tree(&repo, &dir.join(CANDIDATE_DIR_NAME))?;
    let reference_name = format!("refs/heads/catalex-agent-{}", session_id(dir)?);
    let parent = repo
        .find_reference(&reference_name)
        .and_then(|r| r.peel_to_commit())
        .map_err(|e| e.to_string())?;
    if parent.tree_id() == oid
        && baseline.is_none_or(|base| parent.id() == base || parent.parent_id(0).ok() == Some(base))
    {
        return Ok(());
    }
    let next = commit(
        &repo,
        oid,
        Some(baseline.unwrap_or(parent.id())),
        "Agent proposal revision",
    )?;
    pin(&repo, session_id(dir)?, "revision", next)?;
    repo.reference(&reference_name, next, true, "Private draft revision")
        .map_err(|e| e.to_string())?;
    // The worktree index follows its saved revision; no checkout touches files.
    let wt = Repository::open(dir.join(CANDIDATE_DIR_NAME)).map_err(|e| e.to_string())?;
    let expected = repo
        .path()
        .join("worktrees")
        .join(format!("catalex-agent-{}", session_id(dir)?));
    if fs::canonicalize(wt.path()).map_err(|e| e.to_string())?
        != fs::canonicalize(expected).map_err(|e| e.to_string())?
    {
        return Err("Agent worktree Git metadata was changed; private draft retained".into());
    }
    let mut index = wt.index().map_err(|e| e.to_string())?;
    index
        .read_tree(&repo.find_tree(oid).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())
}
// Existing v2 snapshots may contain outputs captured before the shared policy.
// Filter their tree entries too, so an exclusion never becomes a deletion proposal.
fn review_baseline_tree(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    session: &AgentWorkspaceSession,
) -> Result<Oid, String> {
    fn visit(
        repo: &Repository,
        tree: &git2::Tree<'_>,
        prefix: &str,
        session: &AgentWorkspaceSession,
        index: &mut Index,
    ) -> Result<(), String> {
        for item in tree {
            let path = format!("{prefix}{}", item.name().ok_or("Non-UTF8 draft path")?);
            if item.kind() == Some(git2::ObjectType::Tree) {
                if !crate::private_files::internal(Path::new(&path)) {
                    visit(
                        repo,
                        &repo.find_tree(item.id()).map_err(|e| e.to_string())?,
                        &format!("{path}/"),
                        session,
                        index,
                    )?;
                }
            } else {
                let relative = Path::new(&path);
                let explicit = session
                    .dirty_buffers
                    .iter()
                    .any(|buffer| buffer.relative_path == path);
                if (!explicit
                    && crate::private_files::excluded(Path::new(&session.project_root), relative))
                    || (relative.components().count() == 1 && crate::comments::is_sidecar(&path))
                {
                    continue;
                }
                let mut value = entry(&path, item.id(), 0);
                value.mode = item.filemode() as u32;
                index.add(&value).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    let mut index = Index::new().map_err(|e| e.to_string())?;
    visit(repo, tree, "", session, &mut index)?;
    index.write_tree_to(repo).map_err(|e| e.to_string())
}

pub(super) fn changes(dir: &Path) -> Result<Vec<ChangeRecord>, String> {
    let session = load_session(dir)?;
    let repo = repository(dir)?;

    let before = repo
        .find_commit(Oid::from_str(&session.baseline_commit).map_err(|e| e.to_string())?)
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    let before = repo
        .find_tree(review_baseline_tree(&repo, &before, &session)?)
        .map_err(|e| e.to_string())?;
    let after = repo
        .find_tree(inventory_tree(&repo, &dir.join(CANDIDATE_DIR_NAME))?)
        .map_err(|e| e.to_string())?;
    let mut diff = repo
        .diff_tree_to_tree(Some(&before), Some(&after), None)
        .map_err(|e| e.to_string())?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))
        .map_err(|e| e.to_string())?;
    let mut records = Vec::new();
    for delta in diff.deltas() {
        let (kind, old, new) = match delta.status() {
            git2::Delta::Added => (ChangeKind::Added, None, delta.new_file().path()),
            git2::Delta::Deleted => (ChangeKind::Deleted, delta.old_file().path(), None),
            git2::Delta::Renamed => (
                ChangeKind::Renamed,
                delta.old_file().path(),
                delta.new_file().path(),
            ),
            git2::Delta::Modified | git2::Delta::Typechange => (
                ChangeKind::Modified,
                delta.old_file().path(),
                delta.new_file().path(),
            ),
            _ => continue,
        };
        let old = old.map(|p| p.to_string_lossy().into_owned());
        let new = new.map(|p| p.to_string_lossy().into_owned());
        if matches!(kind, ChangeKind::Modified) && delta.old_file().id() == delta.new_file().id() {
            continue;
        }
        let baseline = if old.is_some() {
            Some(tree_file(
                &repo,
                delta.old_file().id(),
                delta.old_file().mode().into(),
            )?)
        } else {
            None
        };
        let candidate = if new.is_some() {
            Some(tree_file(
                &repo,
                delta.new_file().id(),
                delta.new_file().mode().into(),
            )?)
        } else {
            None
        };
        records.push(make_record(kind, old, new, baseline, candidate));
    }
    records.sort_by_key(display_path);
    Ok(records)
}

pub(super) fn merge(
    dir: &Path,
    base: &[u8],
    current: &[u8],
    proposed: &[u8],
) -> Result<(Vec<u8>, Vec<ConflictSegment>), String> {
    crate::text_merge::merge(&repository(dir)?, base, current, proposed)
}

pub(super) fn discard_legacy(dir: &Path) -> Result<(), String> {
    // A failed old migration may have left a worktree and private refs.
    if repository_path(dir)?.exists() {
        discard(dir)?;
    }
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(super) fn remove_worktree(dir: &Path) -> Result<(), String> {
    let repo = repository(dir)?;
    let name = format!("catalex-agent-{}", session_id(dir)?);
    if let Ok(wt) = repo.find_worktree(&name) {
        let mut options = git2::WorktreePruneOptions::new();
        options.valid(true).locked(true).working_tree(true);
        wt.prune(Some(&mut options))
            .map_err(|e| format!("Cannot remove private worktree: {e}"))?;
    } else if dir.join(CANDIDATE_DIR_NAME).exists() {
        fs::remove_dir_all(dir.join(CANDIDATE_DIR_NAME)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(super) fn discard(dir: &Path) -> Result<(), String> {
    remove_worktree(dir)?;
    let repo = repository(dir)?;
    let id = session_id(dir)?;
    if let Ok(mut reference) = repo.find_reference(&format!("refs/heads/catalex-agent-{id}")) {
        reference.delete().map_err(|e| e.to_string())?;
    }
    for reference in repo
        .references_glob(&format!("refs/catalex/agents/{id}/*"))
        .map_err(|e| e.to_string())?
    {
        reference
            .map_err(|e| e.to_string())?
            .delete()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StoredFile {
    blob: String,
    // Old byte-only journals did not record permissions. Do not infer them
    // from files that may already have been partially replaced.
    mode: Option<u32>,
}
type StoredFiles = BTreeMap<String, Option<StoredFile>>;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SettlementDirection {
    Apply,
    Rollback,
}

#[derive(Serialize, Deserialize)]
struct Settlement {
    version: u32,
    #[serde(default)]
    comment_recovery_id: String,
    #[serde(default)]
    comment_before: crate::comments::recovery::FileRevisions,
    direction: SettlementDirection,
    session: AgentWorkspaceSession,
    before: StoredFiles,
    candidate_before: StoredFiles,
    #[serde(default)]
    partial_paths: BTreeSet<String>,
    after: StoredFiles,
    changed_paths: Vec<String>,
    comment_storage: Option<PathBuf>,
    #[serde(default)]
    comment_path_changes: Vec<crate::comments::CommentPathChange>,
}

#[derive(Serialize, Deserialize)]
struct LegacySettlement {
    session: AgentWorkspaceSession,
    before: BTreeMap<String, Option<Vec<u8>>>,
    candidate_before: BTreeMap<String, Option<Vec<u8>>>,
    after: BTreeMap<String, Option<Vec<u8>>>,
}
const SETTLEMENT: &str = "settlement.json";

fn store_file(repo: &Repository, bytes: &[u8], mode: Option<u32>) -> Result<StoredFile, String> {
    Ok(StoredFile {
        blob: repo.blob(bytes).map_err(|e| e.to_string())?.to_string(),
        mode,
    })
}
fn capture_file(
    repo: &Repository,
    root: &Path,
    relative: &str,
) -> Result<Option<StoredFile>, String> {
    ensure_no_symlink_components(root, relative)?;
    let path = root.join(safe_relative_path(relative)?);
    file_bytes(&path)?
        .map(|bytes| store_file(repo, &bytes, Some(file_mode(&path)?)))
        .transpose()
}
fn blob<'a>(repo: &'a Repository, file: &StoredFile) -> Result<git2::Blob<'a>, String> {
    repo.find_blob(Oid::from_str(&file.blob).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn matches_file(
    root: &Path,
    relative: &str,
    expected: &Option<StoredFile>,
) -> Result<bool, String> {
    ensure_no_symlink_components(root, relative)?;
    let path = root.join(safe_relative_path(relative)?);
    Ok(match (file_bytes(&path)?, expected) {
        (None, None) => true,
        (Some(bytes), Some(file)) => {
            let oid =
                Oid::hash_object(git2::ObjectType::Blob, &bytes).map_err(|e| e.to_string())?;
            oid.to_string() == file.blob
                && (file.mode.is_none() || file.mode == Some(file_mode(&path)?))
        }
        _ => false,
    })
}
fn save_settlement(dir: &Path, pending: &Settlement) -> Result<(), String> {
    atomic_write(
        &dir.join(SETTLEMENT),
        &serde_json::to_vec(pending).map_err(|e| e.to_string())?,
    )
}

// Pin all recovery blobs before publishing the journal. Git maintenance then
// retains them just like other active-draft snapshots, without duplicate bytes.
fn pin_settlement(repo: &Repository, pending: &Settlement) -> Result<(), String> {
    let mut index = Index::new().map_err(|e| e.to_string())?;
    for (prefix, files) in [
        ("before", &pending.before),
        ("candidate", &pending.candidate_before),
        ("after", &pending.after),
    ] {
        for (path, file) in files {
            safe_relative_path(path)?;
            if let Some(file) = file {
                let object = blob(repo, file)?;
                let mut item = entry(&format!("{prefix}/{path}"), object.id(), object.size());
                item.mode = file.mode.unwrap_or(0o100644);
                index.add(&item).map_err(|e| e.to_string())?;
            }
        }
    }
    let tree = index.write_tree_to(repo).map_err(|e| e.to_string())?;
    let oid = commit(repo, tree, None, "Pending draft acceptance recovery")?;
    pin(repo, &pending.session.session_id, "settlement", oid)
}

fn load_settlement(dir: &Path, repo: &Repository) -> Result<Settlement, String> {
    let raw = fs::read(dir.join(SETTLEMENT)).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let mut pending = if let Some(version) = value.get("version") {
        if version.as_u64() != Some(2) {
            return Err("Unsupported pending acceptance version; recovery data preserved".into());
        }
        serde_json::from_value::<Settlement>(value).map_err(|e| e.to_string())?
    } else {
        let old: LegacySettlement = serde_json::from_value(value).map_err(|e| e.to_string())?;
        let convert = |files: BTreeMap<String, Option<Vec<u8>>>| -> Result<StoredFiles, String> {
            files
                .into_iter()
                .map(|(path, bytes)| {
                    safe_relative_path(&path)?;
                    Ok((
                        path,
                        bytes
                            .map(|bytes| store_file(repo, &bytes, None))
                            .transpose()?,
                    ))
                })
                .collect()
        };
        let changed_paths = old
            .after
            .iter()
            .filter(|(path, bytes)| old.before.get(*path) != Some(*bytes))
            .map(|(path, _)| path.clone())
            .collect();
        let pending = Settlement {
            version: 2,
            comment_recovery_id: uuid::Uuid::new_v4().to_string(),
            comment_before: Default::default(),
            direction: SettlementDirection::Apply,
            session: old.session,
            before: convert(old.before)?,
            candidate_before: convert(old.candidate_before)?,
            partial_paths: BTreeSet::new(),
            after: convert(old.after)?,
            changed_paths,
            comment_path_changes: Vec::new(),
            comment_storage: dir
                .parent()
                .filter(|parent| {
                    parent
                        .file_name()
                        .is_some_and(|name| name == "agent-workspaces")
                })
                .and_then(Path::parent)
                .map(|data| data.join("comments")),
        };
        if pending.session.session_id != session_id(dir)? {
            return Err("Invalid pending draft transaction".into());
        }
        pin_settlement(repo, &pending)?;
        save_settlement(dir, &pending)?;
        pending
    };
    if pending.session.session_id != session_id(dir)? {
        return Err("Invalid pending draft transaction".into());
    }
    // Validate every reference before modifying any file. Missing/corrupt objects
    // must leave both the journal and project intact.
    if pending.before.keys().ne(pending.after.keys())
        || pending.candidate_before.keys().ne(pending.after.keys())
        || pending.partial_paths.iter().any(|path| !pending.after.contains_key(path))
    {
        return Err("Incomplete pending draft transaction".into());
    }
    for files in [&pending.before, &pending.candidate_before, &pending.after] {
        for (path, file) in files {
            safe_relative_path(path)?;
            if let Some(file) = file {
                if file
                    .mode
                    .is_some_and(|mode| !matches!(mode, 0o100644 | 0o100755))
                {
                    return Err("Unsupported recovery file mode".into());
                }
                blob(repo, file)?;
            }
        }
    }
    if pending.comment_recovery_id.is_empty() {
        pending.comment_recovery_id = uuid::Uuid::new_v4().to_string();
        save_settlement(dir, &pending)?;
    }
    uuid::Uuid::parse_str(&pending.comment_recovery_id).map_err(|e| e.to_string())?;
    Ok(pending)
}

/// Persist the approved transition before touching project files.
pub(super) fn prepare_settlement(
    dir: &Path,
    session: &AgentWorkspaceSession,
    records: &[ChangeRecord],
    decisions: &HashMap<String, AgentWorkspaceDecision>,
    operations: &[PlannedOperation],
    comment_storage: Option<&Path>,
) -> Result<(), String> {
    checkpoint(dir)?;
    let repo = repository(dir)?;
    let mut source = snapshot(dir, &session.source_commit)?;
    let mut baseline = snapshot(dir, &session.baseline_commit)?;
    let mut before = StoredFiles::new();
    for record in records.iter().filter(|r| decisions.contains_key(&r.id)) {
        for path in record.old_path.iter().chain(record.new_path.iter()) {
            before.insert(
                path.clone(),
                capture_file(&repo, Path::new(&session.project_root), path)?,
            );
        }
    }
    let candidate_before = before
        .keys()
        .map(|path| {
            Ok((
                path.clone(),
                capture_file(&repo, &dir.join(CANDIDATE_DIR_NAME), path)?,
            ))
        })
        .collect::<Result<StoredFiles, String>>()?;
    let mut after = before.clone();
    let mut changed_paths = BTreeSet::new();
    for operation in operations {
        for path in &operation.remove_paths {
            after.insert(path.clone(), None);
            changed_paths.insert(path.clone());
        }
        if let (Some(path), Some(bytes)) = (&operation.write_path, &operation.write_bytes) {
            // Preserve the current publication policy: existing destination
            // permissions remain; this change does not introduce chmod proposals.
            let mode = before
                .get(path)
                .and_then(|f| f.as_ref())
                .and_then(|f| f.mode)
                .unwrap_or(0o100644);
            after.insert(path.clone(), Some(store_file(&repo, bytes, Some(mode))?));
            changed_paths.insert(path.clone());
        }
    }
    for (path, file) in &after {
        for files in [&mut source, &mut baseline] {
            if let Some(file) = file {
                let bytes = blob(&repo, file)?.content().to_vec();
                files.insert(
                    path.clone(),
                    FileEntry {
                        mode: file.mode.unwrap_or(0o100644),
                        digest: hex_digest(&bytes),
                        bytes,
                    },
                );
            } else {
                files.remove(path);
            }
        }
    }
    let mut next = session.clone();
    let new_source = commit(
        &repo,
        tree(&repo, &source)?,
        Some(Oid::from_str(&session.source_commit).map_err(|e| e.to_string())?),
        "Project after partial review",
    )?;
    let new_baseline = commit(
        &repo,
        tree(&repo, &baseline)?,
        Some(Oid::from_str(&session.baseline_commit).map_err(|e| e.to_string())?),
        "Remaining proposal baseline",
    )?;
    pin(&repo, &session.session_id, "source", new_source)?;
    pin(&repo, &session.session_id, "baseline", new_baseline)?;
    next.source_commit = new_source.to_string();
    next.baseline_commit = new_baseline.to_string();
    let partial_paths: BTreeSet<_> = records.iter()
        .filter(|record| decisions.get(&record.id).is_some_and(|decision| decision.partial))
        .flat_map(|record| record.old_path.iter().chain(record.new_path.iter()).cloned())
        .collect();
    next.status = if partial_paths.is_empty() && records.iter().all(|r| decisions.contains_key(&r.id)) {
        "settled"
    } else {
        "review"
    }
    .into();
    next.updated_at = now_millis();
    let pending = Settlement {
        version: 2,
        comment_recovery_id: uuid::Uuid::new_v4().to_string(),
        comment_before: crate::comments::recovery::capture(Path::new(&session.project_root), &changed_paths.iter().cloned().collect::<Vec<_>>())?,
        direction: SettlementDirection::Apply,
        session: next,
        before,
        candidate_before,
        partial_paths,
        after,
        changed_paths: changed_paths.into_iter().collect(),
        comment_storage: comment_storage.map(Path::to_path_buf),
        comment_path_changes: records.iter().filter(|record| {
            matches!(record.kind, ChangeKind::Renamed)
                && decisions.get(&record.id).is_some_and(|decision| decision.accept && !decision.partial)
        }).filter_map(|record| Some(crate::comments::CommentPathChange {
            old_path: record.old_path.clone()?, new_path: record.new_path.clone()?, folder: false,
        })).collect(),
    };
    pin_settlement(&repo, &pending)?;
    save_settlement(dir, &pending)
}

/// A partial decision advances source/baseline but keeps the already-flushed draft.
fn candidate_after(pending: &Settlement) -> StoredFiles {
    pending.after.iter().map(|(path, file)| {
        (path.clone(), if pending.partial_paths.contains(path) {
            pending.candidate_before[path].clone()
        } else {
            file.clone()
        })
    }).collect()
}

fn validate_files(
    root: &Path,
    before: &StoredFiles,
    after: &StoredFiles,
    label: &str,
) -> Result<(), String> {
    for (path, approved) in after {
        if !matches_file(root, path, approved)?
            && !matches_file(root, path, before.get(path).ok_or("Missing recovery path")?)?
        {
            return Err(format!("{label} changed during interrupted acceptance of {path}; newer edits and recovery checkpoint preserved"));
        }
    }
    Ok(())
}
fn publish_files(repo: &Repository, root: &Path, files: &StoredFiles) -> Result<(), String> {
    publish_files_prepared(repo, root, files, |_, _| Ok(()))
}
fn publish_source(repo: &Repository, root: &Path, files: &StoredFiles, pending: &Settlement) -> Result<(), String> {
    publish_files_prepared(repo, root, files, |relative, prepared| {
        if let Some(storage) = &pending.comment_storage {
            if !pending.changed_paths.is_empty() {
                crate::comments::recovery::record_file(storage, &pending.comment_recovery_id, relative, prepared)?;
            }
        }
        Ok(())
    })
}
fn publish_files_prepared(repo: &Repository, root: &Path, files: &StoredFiles,
    mut prepared: impl FnMut(&str, Option<&Path>) -> Result<(), String>,
) -> Result<(), String> {
    // Publish destinations before removing sources, including during rollback.
    for (relative, file) in files
        .iter()
        .filter(|(_, file)| file.is_some())
        .chain(files.iter().filter(|(_, file)| file.is_none()))
    {
        if matches_file(root, relative, file)? {
            continue;
        }
        let path = root.join(safe_relative_path(relative)?);
        if let Some(file) = file {
            let object = blob(repo, file)?;
            let parent = path.parent().ok_or("Path has no parent")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            crate::project_files::replace_file_prepared(&path, object.content(), file.mode, |temporary| prepared(relative, Some(temporary)))?;
        } else if path.exists() {
            prepared(relative, None)?;
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            remove_empty_parent_dirs(&path, root);
        }
    }
    Ok(())
}
fn prepare_comments(dir: &Path, pending: &Settlement) -> Result<(), String> {
    if let Some(storage) = &pending.comment_storage {
        if pending.changed_paths.is_empty() { return Ok(()); }
        crate::comments::recovery::defer(
            Path::new(&pending.session.project_root), storage, &dir.join(SETTLEMENT),
            &pending.comment_recovery_id, &pending.changed_paths,
            if pending.direction == SettlementDirection::Apply { &pending.comment_path_changes } else { &[] },
            &pending.comment_before,
        )?;
    }
    Ok(())
}
fn finish_comments(pending: &Settlement) -> Option<String> {
    let storage = pending.comment_storage.as_ref()?;
    let root = Path::new(&pending.session.project_root);
    crate::comments::recovery::recover(root, storage)
        .and_then(|_| crate::comments::recover_path_changes(root, storage))
        .err()
}
fn clear_settlement(dir: &Path) -> Result<(), String> {
    // Only an old-format transaction may have left this copy. It is no longer
    // needed once the journal's chosen outcome has been fully published.
    let old_rollback = dir.join("rollback");
    if old_rollback.exists() {
        fs::remove_dir_all(old_rollback).map_err(|e| e.to_string())?;
    }
    fs::remove_file(dir.join(SETTLEMENT)).map_err(|e| e.to_string())
}
fn finish_rollback(dir: &Path, repo: &Repository, pending: &Settlement) -> Result<(), String> {
    let root = Path::new(&pending.session.project_root);
    validate_files(root, &pending.before, &pending.after, "Project")?;
    prepare_comments(dir, pending)?;
    if let Some(storage) = &pending.comment_storage {
        if !pending.changed_paths.is_empty() {
            crate::comments::recovery::prepare_rollback(root, storage, &pending.comment_recovery_id, &pending.changed_paths)?;
        }
    }
    publish_source(repo, root, &pending.before, pending)?;
    clear_settlement(dir)?;
    // Comment I/O cannot turn a completed file rollback into a failed rollback.
    let _ = finish_comments(pending);
    Ok(())
}
pub(super) fn rollback_settlement(dir: &Path) -> Result<(), String> {
    let repo = repository(dir)?;
    let mut pending = load_settlement(dir, &repo)?;
    pending.direction = SettlementDirection::Rollback;
    save_settlement(dir, &pending)?;
    finish_rollback(dir, &repo, &pending)
}

pub(super) fn apply_settlement_files(dir: &Path) -> Result<Vec<String>, String> {
    let repo = repository(dir)?;
    let pending = load_settlement(dir, &repo)?;
    let root = Path::new(&pending.session.project_root);
    let validation = (|| {
        validate_files(root, &pending.before, &pending.after, "Project")?;
        validate_files(
            &dir.join(CANDIDATE_DIR_NAME),
            &pending.candidate_before,
            &candidate_after(&pending),
            "Draft",
        )?;
        Ok::<(), String>(())
    })();
    if let Err(error) = validation {
        // Record cancellation even if newer external content prevents cleanup.
        let _ = rollback_settlement(dir);
        return Err(error);
    }
    if let Err(error) = prepare_comments(dir, &pending)
        .and_then(|_| publish_source(&repo, root, &pending.after, &pending)) {
        return Err(match rollback_settlement(dir) {
            Ok(()) => format!("{error}; all partial changes were rolled back"),
            Err(rollback) => format!("{error}; rollback is pending: {rollback}"),
        });
    }
    Ok(pending.changed_paths)
}

pub(super) fn recover_settlement(
    dir: &Path,
    session: &mut AgentWorkspaceSession,
) -> Result<Option<String>, String> {
    if !dir.join(SETTLEMENT).exists() {
        return Ok(None);
    }
    let repo = repository(dir)?;
    let pending = load_settlement(dir, &repo)?;
    ensure_session_project(&pending.session, &session.project_root)?;
    if pending.direction == SettlementDirection::Rollback {
        return finish_rollback(dir, &repo, &pending).map(|_| None);
    }
    let root = Path::new(&session.project_root);
    validate_files(root, &pending.before, &pending.after, "Project")?;
    validate_files(
        &dir.join(CANDIDATE_DIR_NAME),
        &pending.candidate_before,
        &candidate_after(&pending),
        "Draft",
    )?;
    prepare_comments(dir, &pending)?;
    publish_source(&repo, root, &pending.after, &pending)?;
    publish_files(&repo, &dir.join(CANDIDATE_DIR_NAME), &candidate_after(&pending))?;
    if pending.before != pending.after {
        atomic_write(&dir.join("history-pending"), b"Applied agent changes")?;
    }
    save_session(dir, &pending.session)?;
    *session = pending.session.clone();
    checkpoint_with_parent(
        dir,
        Some(Oid::from_str(&session.baseline_commit).map_err(|e| e.to_string())?),
    )?;
    // Comment continuity was persisted before source publication. There is no
    // second storage handoff here which could fail after acceptance completed.
    clear_settlement(dir)?;
    Ok(finish_comments(&pending))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn fixture() -> (TempDir, TempDir, AgentWorkspaceSession, PathBuf) {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("a.tex"), "a original\n").unwrap();
        fs::write(project.path().join("b.tex"), "b original\n").unwrap();
        let session = prepare_workspace_in_root(
            workspaces.path(),
            project.path().to_str().unwrap(),
            "tab",
            None,
            "ask",
            vec![],
        )
        .unwrap();
        let dir = workspaces.path().join(&session.session_id);
        (project, workspaces, session, dir)
    }
    #[test]
    #[ignore = "representative preview timing and storage measurement"]
    fn measure_large_project_preview() {
        fn disk_size(path: &Path) -> u64 {
            fs::read_dir(path).unwrap().map(|e| {
                let e = e.unwrap(); let m = e.metadata().unwrap();
                if m.is_dir() { disk_size(&e.path()) } else { m.len() }
            }).sum()
        }
        let (project, workspaces, _session, dir) = fixture();
        let mut seed = 12345_u64;
        for i in 0..128 {
            let bytes: Vec<u8> = (0..512*1024).map(|_| {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed as u8
            }).collect();
            fs::write(project.path().join(format!("asset-{i}.bin")), bytes).unwrap();
        }
        fs::write(project.path().join("generated.aux"), vec![b'x'; 8*1024*1024]).unwrap();
        discard(&dir).unwrap(); fs::remove_dir_all(&dir).unwrap();
        let session = prepare_workspace_in_root(workspaces.path(), project.path().to_str().unwrap(), "measure", None, "ask", vec![]).unwrap();
        let dir = workspaces.path().join(&session.session_id);
        fs::write(dir.join("candidate/a.tex"), "changed\n").unwrap();
        let mut times = Vec::new();
        for _ in 0..5 {
            let start = std::time::Instant::now();
            let preview = preview_workspace(&dir, session.clone(), &[]).unwrap();
            assert_eq!(preview.changes.len(), 1);
            times.push(start.elapsed().as_millis());
        }
        times.sort();
        println!("preview median_ms={} private_bytes={}", times[2], disk_size(workspaces.path()));
    }

    #[test]
    fn draft_exclusions_preserve_assets_gitignored_sources_and_explicit_buffers() {
        let project = TempDir::new().unwrap(); let store = TempDir::new().unwrap();
        for (name, bytes) in [("main.tex", "source"), ("reference.pdf", "asset"), ("data.gz", "archive"), ("main.aux", "generated"), ("main.pdf", "output"), ("main.fls", "OUTPUT main.pdf"), (".gitignore", "ignored.tex"), ("ignored.tex", "keep")] {
            fs::write(project.path().join(name), bytes).unwrap();
        }
        fs::create_dir_all(project.path().join(".cache")).unwrap();
        fs::write(project.path().join(".cache/cache"), "generated").unwrap();
        let session = prepare_workspace_in_root(store.path(), project.path().to_str().unwrap(), "tab", None, "ask", vec![DirtyBuffer { relative_path: "new.log".into(), content: "explicit buffer".into() }]).unwrap();
        let dir = store.path().join(&session.session_id);
        for path in ["main.tex", "reference.pdf", "data.gz", "ignored.tex", "new.log"] { assert!(dir.join("candidate").join(path).exists(), "{path}"); }
        for path in ["main.aux", "main.pdf", "main.fls", ".cache"] { assert!(!dir.join("candidate").join(path).exists(), "{path}"); }
        assert!(changes(&dir).unwrap().is_empty());
        fs::write(dir.join("candidate/new.log"), "buffer edit").unwrap();
        let records = changes(&dir).unwrap(); assert_eq!(records.len(), 1); assert_eq!(display_path(&records[0]), "new.log");
    }

    #[test]
    fn existing_v2_outputs_do_not_become_deletion_proposals() {
        let (_project, _store, mut session, dir) = fixture();
        let repo = repository(&dir).unwrap();
        let mut baseline = snapshot(&dir, &session.baseline_commit).unwrap();
        baseline.insert("main.aux".into(), FileEntry { mode: 0o100644, bytes: b"old output".to_vec(), digest: hex_digest(b"old output") });
        session.baseline_commit = commit(&repo, tree(&repo, &baseline).unwrap(), None, "Previous v2 baseline").unwrap().to_string();
        save_session(&dir, &session).unwrap();
        fs::write(dir.join("candidate/main.aux"), "new output").unwrap();
        assert!(changes(&dir).unwrap().is_empty());
        assert_eq!(fs::read_to_string(dir.join("candidate/main.aux")).unwrap(), "new output");
    }

    #[test]
    fn legacy_retirement_retries_partial_cleanup_and_never_deletes_unknown_versions() {
        let (project, _current_store, mut old, _current_dir) = fixture();
        let store = TempDir::new().unwrap(); let dir = store.path().join("old");
        fs::create_dir_all(&dir).unwrap(); old.version = 1; old.session_id = "old".into();
        save_session(&dir, &old).unwrap();
        fs::write(store.path().join("history.git"), "unavailable repository").unwrap();
        assert!(retire_legacy_workspace(&dir, &old).is_err());
        assert!(store.path().join(".old.retired.json").exists());
        fs::remove_file(dir.join(MANIFEST_FILE_NAME)).unwrap(); // interrupted folder removal
        fs::remove_file(store.path().join("history.git")).unwrap();
        retire_legacy_workspace(&dir, &old).unwrap();
        assert!(!dir.exists()); assert!(!store.path().join(".old.retired.json").exists());
        fs::create_dir_all(&dir).unwrap(); old.version = 3; save_session(&dir, &old).unwrap();
        assert!(retire_legacy_workspace(&dir, &old).is_err());
        assert!(dir.join(MANIFEST_FILE_NAME).exists());
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), "a original\n");
    }

    #[test]
    fn one_real_worktree_without_snapshot_directories() {
        let (_p, _w, session, dir) = fixture();
        assert!(Repository::open(&session.candidate_root)
            .unwrap()
            .is_worktree());
        assert!(!dir.join(SOURCE_SNAPSHOT_DIR_NAME).exists());
        assert!(!dir.join(BASELINE_DIR_NAME).exists());
        assert!(!inventory(Path::new(&session.candidate_root))
            .unwrap()
            .contains_key(".git"));
    }
    #[test]
    fn partial_application_and_rejection_keep_remaining_work_across_reload() {
        let (p, _w, session, dir) = fixture();
        fs::write(
            Path::new(&session.candidate_root).join("a.tex"),
            "a proposed\n",
        )
        .unwrap();
        fs::write(
            Path::new(&session.candidate_root).join("b.tex"),
            "b proposed\n",
        )
        .unwrap();
        let preview = preview_workspace(&dir, session, &[]).unwrap();
        let selected = preview
            .changes
            .iter()
            .find(|c| c.file_path == "a.tex")
            .unwrap();
        let result = apply_workspace(
            &dir,
            p.path().to_str().unwrap(),
            vec![AgentWorkspaceDecision {
                change_id: selected.id.clone(),
                accept: true,
                proposal_revision: Some(selected.proposal_revision.clone()),
                ..Default::default()
            }],
            Some(preview.source_revision),
        )
        .unwrap();
        assert!(result.applied);
        let remaining = result.remaining_preview.unwrap();
        assert_eq!(remaining.changes.len(), 1);
        assert_eq!(remaining.changes[0].file_path, "b.tex");
        assert_eq!(
            fs::read_to_string(p.path().join("a.tex")).unwrap(),
            "a proposed\n"
        );
        let reloaded = load_session(&dir).unwrap();
        assert_eq!(reloaded.status, "review");
        let repo = repository(&dir).unwrap();
        let head = repo
            .find_reference(&format!(
                "refs/heads/catalex-agent-{}",
                reloaded.session_id
            ))
            .unwrap()
            .peel_to_commit()
            .unwrap();
        assert_eq!(
            head.parent_id(0).unwrap().to_string(),
            reloaded.baseline_commit
        );
        let result = apply_workspace(
            &dir,
            p.path().to_str().unwrap(),
            vec![AgentWorkspaceDecision {
                change_id: remaining.changes[0].id.clone(),
                accept: false,
                ..Default::default()
            }],
            Some(remaining.source_revision),
        )
        .unwrap();
        assert!(result.applied);
        assert!(result.remaining_preview.is_none());
        assert_eq!(
            fs::read_to_string(p.path().join("b.tex")).unwrap(),
            "b original\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("candidate/b.tex")).unwrap(),
            "b original\n"
        );
    }

    #[test]
    fn inline_review_checkpoint_keeps_pending_candidate_across_refinement() {
        let (project, _workspaces, session, dir) = fixture();
        let candidate = dir.join("candidate/a.tex");
        let proposed = "accepted first\n\nstill proposed\n";
        let reviewed = "accepted first\n\nstill original\n";
        fs::write(&candidate, proposed).unwrap();
        let preview = preview_workspace(&dir, session, &[]).unwrap();
        let change = &preview.changes[0];
        let result = apply_workspace(&dir, project.path().to_str().unwrap(), vec![AgentWorkspaceDecision {
            change_id: change.id.clone(), accept: true, partial: true, resolved_conflict: true,
            content: Some(reviewed.into()), proposal_revision: Some(change.proposal_revision.clone()),
            ..Default::default()
        }], Some(preview.source_revision)).unwrap();
        assert!(result.applied);
        let remaining = result.remaining_preview.unwrap();
        assert_eq!(remaining.changes.len(), 1);
        assert_eq!(remaining.current_contents[&remaining.changes[0].id].as_deref(), Some(reviewed));
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), reviewed);
        assert_eq!(fs::read_to_string(&candidate).unwrap(), proposed);
        assert_eq!(load_session(&dir).unwrap().status, "review");
        let resumed = resume_workspace(&dir, &remaining.session.project_root, "tab", None).unwrap();
        assert_eq!(resumed.status, "active");
        fs::write(&candidate, "accepted first\n\nrefined second\n").unwrap();
        let next = preview_workspace(&dir, resumed, &[]).unwrap();
        assert_eq!(next.current_contents[&next.changes[0].id].as_deref(), Some(reviewed));
        let result = apply_workspace(&dir, project.path().to_str().unwrap(), vec![AgentWorkspaceDecision {
            change_id: next.changes[0].id.clone(), accept: false, ..Default::default()
        }], Some(next.source_revision)).unwrap();
        assert!(result.applied);
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), reviewed);
        assert_eq!(load_session(&dir).unwrap().status, "settled");
    }

    #[test]
    fn inline_checkpoint_keeps_rename_pending_and_comments_on_original_path() {
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        let original = format!("First: original\n{}Last: original\n", "Unchanged context\n".repeat(30));
        let proposed = original.replace("original", "proposed");
        let reviewed = original.replacen("original", "proposed", 1);
        fs::write(project.path().join("a.tex"), &original).unwrap();
        let session = prepare_workspace_in_root(workspaces.path(), project.path().to_str().unwrap(), "tab", None, "ask", vec![]).unwrap();
        let dir = workspaces.path().join(&session.session_id);
        fs::rename(dir.join("candidate/a.tex"), dir.join("candidate/renamed.tex")).unwrap();
        fs::write(dir.join("candidate/renamed.tex"), &proposed).unwrap();
        let preview = preview_workspace(&dir, session, &[]).unwrap();
        let change = &preview.changes[0];
        assert_eq!(change.kind, "renamed");
        let result = apply_workspace(&dir, project.path().to_str().unwrap(), vec![AgentWorkspaceDecision {
            change_id: change.id.clone(), accept: true, partial: true, resolved_conflict: true,
            content: Some(reviewed.clone()), proposal_revision: Some(change.proposal_revision.clone()),
            ..Default::default()
        }], Some(preview.source_revision)).unwrap();
        assert!(result.applied);
        assert!(result.path_changes.is_empty());
        assert_eq!(result.changed_paths, vec!["a.tex"]);
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), reviewed);
        assert!(!project.path().join("renamed.tex").exists());
        assert!(!dir.join("candidate/a.tex").exists());
        assert_eq!(fs::read_to_string(dir.join("candidate/renamed.tex")).unwrap(), proposed);
        let remaining = result.remaining_preview.unwrap();
        assert_eq!(remaining.changes.len(), 1);
        assert_eq!(remaining.changes[0].kind, "renamed");
        let result = apply_workspace(&dir, project.path().to_str().unwrap(), vec![AgentWorkspaceDecision {
            change_id: remaining.changes[0].id.clone(), accept: false, ..Default::default()
        }], Some(remaining.source_revision)).unwrap();
        assert!(result.applied);
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), reviewed);
        assert!(!project.path().join("renamed.tex").exists());
        assert_eq!(load_session(&dir).unwrap().status, "settled");
    }

    #[test]
    fn interrupted_inline_checkpoint_recovers_without_overwriting_pending_proposal() {
        for published in [false, true] {
            let (project, _workspaces, session, dir) = fixture();
            fs::write(dir.join("candidate/a.tex"), "approved\nremaining proposal\n").unwrap();
            let records = changes(&dir).unwrap();
            let change = &records[0];
            let decision = AgentWorkspaceDecision {
                change_id: change.id.clone(), accept: true, partial: true, resolved_conflict: true,
                content: Some("approved\nremaining original\n".into()),
                proposal_revision: Some(proposal_revision(change)), ..Default::default()
            };
            let operations = vec![PlannedOperation { remove_paths: vec![], write_path: Some("a.tex".into()), write_bytes: Some(b"approved\nremaining original\n".to_vec()) }];
            prepare_settlement(&dir, &session, &records, &HashMap::from([(change.id.clone(), decision)]), &operations, None).unwrap();
            if published { apply_settlement_files(&dir).unwrap(); }
            let mut reloaded = load_session(&dir).unwrap();
            recover_settlement(&dir, &mut reloaded).unwrap();
            recover_settlement(&dir, &mut reloaded).unwrap();
            assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), "approved\nremaining original\n");
            assert_eq!(fs::read_to_string(dir.join("candidate/a.tex")).unwrap(), "approved\nremaining proposal\n");
            assert_eq!(reloaded.status, "review");
            assert_eq!(preview_workspace(&dir, reloaded, &[]).unwrap().changes.len(), 1);
        }
    }
    #[test]
    fn git_conflict_segments_preserve_independent_edits_and_require_revision() {
        let (p, _w, session, dir) = fixture();
        let source = "Original title\n\nContext\n\nSamples: 10\n\nOther context\n\nOriginal end\n";
        // Fresh fixture with all three divergent versions captured correctly.
        fs::write(p.path().join("a.tex"), source).unwrap();
        let mut s = load_session(&dir).unwrap();
        let files = inventory(p.path()).unwrap();
        let repo = repository(&dir).unwrap();
        let oid = commit(&repo, tree(&repo, &files).unwrap(), None, "test base").unwrap();
        pin(&repo, &s.session_id, "source", oid).unwrap();
        s.source_commit = oid.to_string();
        s.baseline_commit = oid.to_string();
        save_session(&dir, &s).unwrap();
        fs::write(
            p.path().join("a.tex"),
            source
                .replace("Original title", "User title")
                .replace("10", "20"),
        )
        .unwrap();
        fs::write(
            Path::new(&session.candidate_root).join("a.tex"),
            source
                .replace("10", "15")
                .replace("Original end", "Agent end"),
        )
        .unwrap();
        let preview = preview_workspace(&dir, s, &[]).unwrap();
        let change = &preview.changes[0];
        let segments = &preview.conflict_contents[&change.id];
        let result = segments
            .iter()
            .map(|s| match s {
                ConflictSegment::Resolved { content } => content.as_str(),
                ConflictSegment::Conflict { ancestor, .. } => ancestor.as_str(),
            })
            .collect::<String>();
        assert!(result.contains("User title"));
        assert!(result.contains("Samples: 10"));
        assert!(result.contains("Agent end"));
        let mut decision = AgentWorkspaceDecision {
            change_id: change.id.clone(),
            accept: true,
            content: Some(result.clone()),
            resolved_conflict: true,
            ..Default::default()
        };
        assert!(apply_workspace(
            &dir,
            p.path().to_str().unwrap(),
            vec![decision.clone()],
            Some(preview.source_revision.clone())
        )
        .is_err());
        decision.proposal_revision = Some(change.proposal_revision.clone());
        assert!(
            apply_workspace(
                &dir,
                p.path().to_str().unwrap(),
                vec![decision],
                Some(preview.source_revision)
            )
            .unwrap()
            .applied
        );
        assert_eq!(fs::read_to_string(p.path().join("a.tex")).unwrap(), result);
    }
    #[test]
    fn interrupted_settlement_recovers_without_dropping_pending_work() {
        let (p, _w, session, dir) = fixture();
        fs::write(dir.join("candidate/a.tex"), "approved\n").unwrap();
        fs::write(dir.join("candidate/b.tex"), "pending\n").unwrap();
        let records = changes(&dir).unwrap();
        let chosen = records.iter().find(|r| display_path(r) == "a.tex").unwrap();
        let decision = AgentWorkspaceDecision {
            change_id: chosen.id.clone(),
            accept: true,
            ..Default::default()
        };
        let operation = plan_change(
            chosen,
            &decision,
            p.path(),
            &snapshot(&dir, &session.source_commit).unwrap(),
            &dir,
        )
        .unwrap();
        prepare_settlement(
            &dir,
            &session,
            &records,
            &HashMap::from([(chosen.id.clone(), decision)]),
            &[operation],
            None,
        )
        .unwrap();
        validate_comment_scope_in_root(
            dir.parent().unwrap(),
            &session.project_root,
            &session.candidate_root,
            &session.tab_id,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(p.path().join("a.tex")).unwrap(),
            "a original\n"
        );
        let recovered = load_session(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(p.path().join("a.tex")).unwrap(),
            "approved\n"
        );
        assert_eq!(changes(&dir).unwrap().len(), 1);
        assert_eq!(recovered.status, "review");
        assert!(!dir.join(SETTLEMENT).exists());
    }
    #[test]
    fn interrupted_settlement_refuses_new_external_content() {
        let (p, _w, session, dir) = fixture();
        fs::write(dir.join("candidate/a.tex"), "approved\n").unwrap();
        let records = changes(&dir).unwrap();
        let selected = &records[0];
        let decision = AgentWorkspaceDecision {
            change_id: selected.id.clone(),
            accept: true,
            ..Default::default()
        };
        let operation = plan_change(
            selected,
            &decision,
            p.path(),
            &snapshot(&dir, &session.source_commit).unwrap(),
            &dir,
        )
        .unwrap();
        prepare_settlement(
            &dir,
            &session,
            &records,
            &HashMap::from([(selected.id.clone(), decision)]),
            &[operation],
            None,
        )
        .unwrap();
        fs::write(p.path().join("a.tex"), "new external work").unwrap();
        assert!(load_session(&dir)
            .unwrap_err()
            .contains("interrupted acceptance"));
        assert_eq!(
            fs::read_to_string(p.path().join("a.tex")).unwrap(),
            "new external work"
        );
        assert!(rollback_settlement(&dir).is_err());
        assert!(dir.join(SETTLEMENT).exists());
        fs::write(p.path().join("a.tex"), "a original\n").unwrap();
        rollback_settlement(&dir).unwrap();
        assert!(!dir.join(SETTLEMENT).exists());
    }
    #[test]
    fn resolving_an_absent_version_deletes_instead_of_creating_an_empty_file() {
        let (project, _workspaces, session, dir) = fixture();
        fs::remove_file(project.path().join("a.tex")).unwrap();
        fs::write(
            dir.join("candidate/a.tex"),
            "Agent edited this deleted file\n",
        )
        .unwrap();
        let preview = preview_workspace(&dir, session, &[]).unwrap();
        let change = &preview.changes[0];
        assert_eq!(preview.conflicts.len(), 1);
        let result = apply_workspace(
            &dir,
            project.path().to_str().unwrap(),
            vec![AgentWorkspaceDecision {
                change_id: change.id.clone(),
                accept: true,
                resolved_conflict: true,
                delete_file: true,
                proposal_revision: Some(change.proposal_revision.clone()),
                ..Default::default()
            }],
            Some(preview.source_revision),
        )
        .unwrap();
        assert!(result.applied);
        assert!(!project.path().join("a.tex").exists());
        assert!(!dir.join("candidate/a.tex").exists());
    }

    #[test]
    fn stale_rejection_does_not_discard_a_newer_proposal() {
        let (project, _workspaces, session, dir) = fixture();
        fs::write(dir.join("candidate/a.tex"), "first proposal").unwrap();
        let preview = preview_workspace(&dir, session, &[]).unwrap();
        let change = &preview.changes[0];
        fs::write(dir.join("candidate/a.tex"), "newer proposal").unwrap();
        assert!(apply_workspace(
            &dir,
            project.path().to_str().unwrap(),
            vec![AgentWorkspaceDecision {
                change_id: change.id.clone(),
                accept: false,
                proposal_revision: Some(change.proposal_revision.clone()),
                ..Default::default()
            }],
            Some(preview.source_revision)
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(dir.join("candidate/a.tex")).unwrap(),
            "newer proposal"
        );
    }

    #[test]
    fn rename_collision_cannot_overwrite_an_unseen_destination() {
        let (p, _w, session, dir) = fixture();
        fs::rename(
            dir.join("candidate/a.tex"),
            dir.join("candidate/renamed.tex"),
        )
        .unwrap();
        fs::write(p.path().join("renamed.tex"), "Independent destination").unwrap();
        let preview = preview_workspace(&dir, session, &[]).unwrap();
        let change = preview
            .changes
            .iter()
            .find(|c| c.kind == "renamed")
            .unwrap();
        assert!(!preview.conflict_contents.contains_key(&change.id));
        assert!(apply_workspace(
            &dir,
            p.path().to_str().unwrap(),
            vec![AgentWorkspaceDecision {
                change_id: change.id.clone(),
                accept: true,
                content: Some("replacement".into()),
                resolved_conflict: true,
                proposal_revision: Some(change.proposal_revision.clone()),
                ..Default::default()
            }],
            Some(preview.source_revision)
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(p.path().join("renamed.tex")).unwrap(),
            "Independent destination"
        );
        assert!(p.path().join("a.tex").exists());
    }

    #[cfg(unix)]
    #[test]
    fn worktree_preserves_executable_source_scripts() {
        use std::os::unix::fs::PermissionsExt;
        let project = TempDir::new().unwrap();
        let workspaces = TempDir::new().unwrap();
        fs::write(project.path().join("build.sh"), "#!/bin/sh\necho hello\n").unwrap();
        fs::set_permissions(
            project.path().join("build.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let session = prepare_workspace_in_root(
            workspaces.path(),
            project.path().to_str().unwrap(),
            "tab",
            None,
            "ask",
            vec![],
        )
        .unwrap();
        assert_ne!(
            fs::metadata(Path::new(&session.candidate_root).join("build.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }

    #[test]
    fn overlapping_crlf_edits_keep_line_endings_in_all_three_versions() {
        let (_project, _workspaces, _session, dir) = fixture();
        let (_, segments) = merge(
            &dir,
            b"Samples: 10\r\n",
            b"Samples: 20\r\n",
            b"Samples: 15\r\n",
        )
        .unwrap();
        assert!(
            matches!(&segments[0],ConflictSegment::Conflict{ancestor,current,agent}
            if ancestor=="Samples: 10\r\n" && current=="Samples: 20\r\n" && agent=="Samples: 15\r\n")
        );
    }

    #[test]
    fn interrupted_settlement_preserves_newer_candidate_edits() {
        let (p, _w, session, dir) = fixture();
        fs::write(dir.join("candidate/a.tex"), "approved").unwrap();
        let records = changes(&dir).unwrap();
        let selected = &records[0];
        let decision = AgentWorkspaceDecision {
            change_id: selected.id.clone(),
            accept: true,
            ..Default::default()
        };
        let operation = plan_change(
            selected,
            &decision,
            p.path(),
            &snapshot(&dir, &session.source_commit).unwrap(),
            &dir,
        )
        .unwrap();
        prepare_settlement(
            &dir,
            &session,
            &records,
            &HashMap::from([(selected.id.clone(), decision)]),
            &[operation],
            None,
        )
        .unwrap();
        fs::write(dir.join("candidate/a.tex"), "newer draft edit").unwrap();
        assert!(load_session(&dir).unwrap_err().contains("Draft changed"));
        assert_eq!(
            fs::read_to_string(dir.join("candidate/a.tex")).unwrap(),
            "newer draft edit"
        );
        assert_eq!(
            fs::read_to_string(p.path().join("a.tex")).unwrap(),
            "a original\n"
        );
    }

    #[test]
    fn old_draft_retirement_is_idempotent_and_preserves_project_and_current_draft() {
        let (project, workspaces, current, current_dir) = fixture();
        let dir = workspaces.path().join("old-session");
        fs::create_dir_all(dir.join("candidate-migration")).unwrap();
        fs::write(dir.join("candidate-migration/unaccepted.tex"), "discard").unwrap();
        let mut old = current.clone(); old.version = 1; old.session_id = "old-session".into();
        old.candidate_root = dir.join("candidate").to_string_lossy().into_owned();
        save_session(&dir, &old).unwrap();
        assert!(load_session(&dir).unwrap_err().contains("retired"));
        retire_legacy_workspace(&dir, &old).unwrap();
        retire_legacy_workspace(&dir, &old).unwrap();
        assert!(!dir.exists());
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), "a original\n");
        assert_eq!(load_session(&current_dir).unwrap().version, 2);
    }

    fn prepare_review(
        dir: &Path,
        session: &AgentWorkspaceSession,
        paths: &[(&str, bool)],
        comments: Option<&Path>,
    ) {
        let records = changes(dir).unwrap();
        let source = snapshot(dir, &session.source_commit).unwrap();
        let mut decisions = HashMap::new();
        let mut operations = Vec::new();
        for (path, accept) in paths {
            let record = records.iter().find(|r| display_path(r) == *path).unwrap();
            let decision = AgentWorkspaceDecision {
                change_id: record.id.clone(),
                accept: *accept,
                ..Default::default()
            };
            if *accept {
                operations.push(
                    plan_change(
                        record,
                        &decision,
                        Path::new(&session.project_root),
                        &source,
                        dir,
                    )
                    .unwrap(),
                );
            }
            decisions.insert(record.id.clone(), decision);
        }
        prepare_settlement(dir, session, &records, &decisions, &operations, comments).unwrap();
    }

    #[test]
    fn recovery_is_idempotent_at_each_publication_boundary() {
        for boundary in 0..7 {
            let (project, _workspaces, session, dir) = fixture();
            fs::write(dir.join("candidate/a.tex"), "approved\n").unwrap();
            fs::write(dir.join("candidate/b.tex"), "rejected\n").unwrap();
            fs::write(dir.join("candidate/c.tex"), "still pending\n").unwrap();
            prepare_review(&dir, &session, &[("a.tex", true), ("b.tex", false)], None);
            let repo = repository(&dir).unwrap();
            let pending = load_settlement(&dir, &repo).unwrap();
            if boundary >= 1 {
                publish_files(
                    &repo,
                    project.path(),
                    &BTreeMap::from([("a.tex".into(), pending.after["a.tex"].clone())]),
                )
                .unwrap();
            }
            if boundary >= 2 {
                publish_files(&repo, project.path(), &pending.after).unwrap();
            }
            if boundary >= 3 {
                publish_files(
                    &repo,
                    &dir.join("candidate"),
                    &BTreeMap::from([("b.tex".into(), pending.after["b.tex"].clone())]),
                )
                .unwrap();
            }
            if boundary >= 4 {
                publish_files(&repo, &dir.join("candidate"), &pending.after).unwrap();
            }
            if boundary >= 5 {
                save_session(&dir, &pending.session).unwrap();
            }
            if boundary >= 6 {
                checkpoint_with_parent(
                    &dir,
                    Some(Oid::from_str(&pending.session.baseline_commit).unwrap()),
                )
                .unwrap();
            }
            drop(repo);
            for _ in 0..2 {
                let recovered = load_session(&dir).unwrap();
                assert_eq!(recovered.status, "review", "boundary {boundary}");
                assert_eq!(
                    fs::read_to_string(project.path().join("a.tex")).unwrap(),
                    "approved\n"
                );
                assert_eq!(
                    fs::read_to_string(dir.join("candidate/b.tex")).unwrap(),
                    "b original\n"
                );
                let remaining = changes(&dir).unwrap();
                assert_eq!(remaining.len(), 1);
                assert_eq!(display_path(&remaining[0]), "c.tex");
                assert!(dir.join("history-pending").exists());
                assert!(!dir.join(SETTLEMENT).exists());
                assert!(!dir.join("rollback").exists());
            }
        }
    }

    #[test]
    fn interrupted_rollback_never_reapplies_cancelled_changes() {
        let (project, _workspaces, session, dir) = fixture();
        for name in ["a.tex", "b.tex"] {
            fs::write(dir.join("candidate").join(name), "proposal\n").unwrap();
        }
        prepare_review(&dir, &session, &[("a.tex", true), ("b.tex", true)], None);
        let repo = repository(&dir).unwrap();
        let mut pending = load_settlement(&dir, &repo).unwrap();
        publish_files(&repo, project.path(), &pending.after).unwrap();
        pending.direction = SettlementDirection::Rollback;
        save_settlement(&dir, &pending).unwrap();
        publish_files(
            &repo,
            project.path(),
            &BTreeMap::from([("a.tex".into(), pending.before["a.tex"].clone())]),
        )
        .unwrap();
        drop(repo);
        for _ in 0..2 {
            assert_eq!(
                load_session(&dir).unwrap().baseline_commit,
                session.baseline_commit
            );
            for name in ["a", "b"] {
                assert_eq!(
                    fs::read_to_string(project.path().join(format!("{name}.tex"))).unwrap(),
                    format!("{name} original\n")
                );
                assert_eq!(
                    fs::read_to_string(dir.join(format!("candidate/{name}.tex"))).unwrap(),
                    "proposal\n"
                );
            }
            assert!(!dir.join(SETTLEMENT).exists());
            assert!(!dir.join("history-pending").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_publication_restores_earlier_writes_without_backup_copies() {
        use std::os::unix::fs::PermissionsExt;
        let (project, _workspaces, session, dir) = fixture();
        fs::write(dir.join("candidate/a.tex"), "proposal\n").unwrap();
        fs::create_dir(dir.join("candidate/blocked")).unwrap();
        fs::write(dir.join("candidate/blocked/new.tex"), "new file\n").unwrap();
        fs::create_dir(project.path().join("blocked")).unwrap();
        prepare_review(
            &dir,
            &session,
            &[("a.tex", true), ("blocked/new.tex", true)],
            None,
        );
        fs::set_permissions(
            project.path().join("blocked"),
            fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        let outcome = apply_settlement_files(&dir);
        fs::set_permissions(
            project.path().join("blocked"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        assert!(outcome
            .unwrap_err()
            .contains("all partial changes were rolled back"));
        assert_eq!(
            fs::read_to_string(project.path().join("a.tex")).unwrap(),
            "a original\n"
        );
        assert!(!project.path().join("blocked/new.tex").exists());
        assert!(!dir.join(SETTLEMENT).exists());
        assert!(!dir.join("rollback").exists());
        assert_eq!(changes(&dir).unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn recovery_preserves_recorded_modes_and_refuses_newer_mode_edits() {
        use std::os::unix::fs::PermissionsExt;
        let (project, _workspaces, session, dir) = fixture();
        fs::set_permissions(
            project.path().join("a.tex"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(dir.join("candidate/a.tex"), "proposal\n").unwrap();
        prepare_review(&dir, &session, &[("a.tex", true)], None);
        fs::set_permissions(
            project.path().join("a.tex"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(load_session(&dir).unwrap_err().contains("Project changed"));
        assert!(dir.join(SETTLEMENT).exists());
        fs::set_permissions(
            project.path().join("a.tex"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        load_session(&dir).unwrap();
        assert_eq!(file_mode(&project.path().join("a.tex")).unwrap(), 0o100755);
        assert_eq!(file_mode(&dir.join("candidate/a.tex")).unwrap(), 0o100755);
    }

    #[test]
    fn legacy_byte_journal_recovers_and_removes_old_backup_only_after_success() {
        let (project, _workspaces, session, dir) = fixture();
        fs::write(dir.join("candidate/a.tex"), "approved\n").unwrap();
        prepare_review(&dir, &session, &[("a.tex", true)], None);
        let repo = repository(&dir).unwrap();
        let pending = load_settlement(&dir, &repo).unwrap();
        let bytes = |files: &StoredFiles| {
            files
                .iter()
                .map(|(path, file)| {
                    (
                        path.clone(),
                        file.as_ref()
                            .map(|f| blob(&repo, f).unwrap().content().to_vec()),
                    )
                })
                .collect()
        };
        let old = LegacySettlement {
            session: pending.session,
            before: bytes(&pending.before),
            candidate_before: bytes(&pending.candidate_before),
            after: bytes(&pending.after),
        };
        fs::write(dir.join(SETTLEMENT), serde_json::to_vec(&old).unwrap()).unwrap();
        fs::create_dir(dir.join("rollback")).unwrap();
        fs::write(dir.join("rollback/a.tex"), "a original\n").unwrap();
        fs::write(project.path().join("a.tex"), "new external edit").unwrap();
        assert!(load_session(&dir).is_err());
        assert!(dir.join("rollback/a.tex").exists());
        assert_eq!(load_settlement(&dir, &repo).unwrap().version, 2);
        fs::write(project.path().join("a.tex"), "a original\n").unwrap();
        load_session(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join("a.tex")).unwrap(),
            "approved\n"
        );
        assert!(!dir.join("rollback").exists());
        assert!(!dir.join(SETTLEMENT).exists());
    }

    #[test]
    fn invalid_recovery_data_is_preserved_without_publishing() {
        for corrupt_blob in [false, true] {
            let (project, _workspaces, session, dir) = fixture();
            fs::write(dir.join("candidate/a.tex"), "approved\n").unwrap();
            prepare_review(&dir, &session, &[("a.tex", true)], None);
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(dir.join(SETTLEMENT)).unwrap()).unwrap();
            if corrupt_blob {
                value["after"]["a.tex"]["blob"] = "1234567890123456789012345678901234567890".into();
            } else {
                value["version"] = 999.into();
            }
            let bytes = serde_json::to_vec(&value).unwrap();
            fs::write(dir.join(SETTLEMENT), &bytes).unwrap();
            assert!(load_session(&dir).is_err());
            assert_eq!(fs::read(dir.join(SETTLEMENT)).unwrap(), bytes);
            assert_eq!(
                fs::read_to_string(project.path().join("a.tex")).unwrap(),
                "a original\n"
            );
        }
    }

    #[test]
    fn recovery_journal_reuses_git_blobs_and_survives_garbage_collection() {
        let (project, _workspaces, session, dir) = fixture();
        let before = "user text\n".repeat(100_000);
        fs::write(project.path().join("a.tex"), &before).unwrap();
        fs::write(dir.join("candidate/a.tex"), "proposal\n").unwrap();
        // Reject preserves current user bytes, which are absent from the initial snapshots.
        prepare_review(&dir, &session, &[("a.tex", false)], None);
        let repo = repository(&dir).unwrap();
        let pending = load_settlement(&dir, &repo).unwrap();
        assert_eq!(pending.before["a.tex"], pending.after["a.tex"]);
        let journal_bytes = fs::metadata(dir.join(SETTLEMENT)).unwrap().len();
        let old = LegacySettlement {
            session: pending.session.clone(),
            before: BTreeMap::from([("a.tex".into(), Some(before.as_bytes().to_vec()))]),
            candidate_before: BTreeMap::from([("a.tex".into(), Some(b"proposal\n".to_vec()))]),
            after: BTreeMap::from([("a.tex".into(), Some(before.as_bytes().to_vec()))]),
        };
        let legacy_journal_bytes = serde_json::to_vec(&old).unwrap().len();
        println!("Recovery storage: journal {journal_bytes} bytes versus legacy journal {legacy_journal_bytes} bytes for {} bytes of user content (excluding Git objects shared by both).", before.len());
        assert!(journal_bytes < 4096);
        assert!(legacy_journal_bytes > before.len() * 2);
        let git_dir = repo.path().to_path_buf();
        drop(repo);
        assert!(std::process::Command::new("git")
            .arg("--git-dir")
            .arg(git_dir)
            .args(["gc", "--prune=now"])
            .output()
            .unwrap()
            .status
            .success());
        load_session(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("candidate/a.tex")).unwrap(),
            before
        );
    }

    #[test]
    fn unavailable_comment_handoff_stops_before_publishing_and_cancels_on_restart() {
        let (project, workspaces, session, dir) = fixture();
        let storage = workspaces.path().join("comments");
        fs::create_dir_all(&storage).unwrap();
        fs::write(dir.join("candidate/a.tex"), "approved\n").unwrap();
        prepare_review(&dir, &session, &[("a.tex", true)], Some(&storage));
        let blocked = storage.with_extension("recovery");
        fs::write(&blocked, "unavailable directory").unwrap();
        assert!(apply_settlement_files(&dir).is_err());
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), "a original\n");
        assert_eq!(fs::read_to_string(dir.join("candidate/a.tex")).unwrap(), "approved\n");
        fs::remove_file(blocked).unwrap();
        load_session(&dir).unwrap();
        assert!(!dir.join(SETTLEMENT).exists());
        assert_eq!(fs::read_to_string(project.path().join("a.tex")).unwrap(), "a original\n");
    }

    #[test]
    fn interrupted_prepared_file_recovers_comment_identity_before_publication() {
        let (project, workspaces, session, dir) = fixture();
        let storage = workspaces.path().join("comments");
        fs::create_dir_all(&storage).unwrap();
        crate::comments::test_write(storage.join("human.json"), r#"{"version":1,"counter":1,"files":{"a.tex":[{"id":"H-1","from":0,"to":1,"line":1,"text":"Keep","resolved":false}]}}"#).unwrap();
        crate::comments::refresh_revisions(project.path(), &storage, &["a.tex".into()]).unwrap();
        fs::write(dir.join("candidate/a.tex"), "approved\n").unwrap();
        prepare_review(&dir, &session, &[("a.tex", true)], Some(&storage));
        let repo = repository(&dir).unwrap();
        let pending = load_settlement(&dir, &repo).unwrap();
        prepare_comments(&dir, &pending).unwrap();
        let target = project.path().join("a.tex");
        let interrupted = crate::project_files::replace_file_prepared(&target, b"approved\n", None, |temporary| {
            crate::comments::recovery::record_file(&storage, &pending.comment_recovery_id, "a.tex", Some(temporary))?;
            Err("simulated interruption before publication".into())
        });
        assert!(interrupted.is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "a original\n");
        assert_eq!(load_session(&dir).unwrap().status, "settled");
        crate::comments::reconcile_paths(project.path(), &storage).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&crate::comments::test_read(storage.join("human.json")).unwrap()).unwrap();
        assert_eq!(saved["files"]["a.tex"][0]["text"], "Keep");
        assert_eq!(fs::read_to_string(target).unwrap(), "approved\n");
    }

    #[test]
    fn interrupted_rename_recovers_both_comment_groups_and_revisions() {
        let (project, _workspaces, session, dir) = fixture();
        let comments = TempDir::new().unwrap();
        for group in ["human", "agent"] {
            crate::comments::test_write(comments.path().join(format!("{group}.json")), serde_json::json!({"version":1,"counter":1,"files":{"a.tex":[{"id":"comment-1","number":1,"from":0,"to":1,"line":1,"text":"Keep feedback","resolved":true,"origin":if group == "agent" { serde_json::json!({"provider":"codex","sessionId":"test"}) } else { serde_json::Value::Null }}]}}).to_string()).unwrap();
        }
        crate::comments::refresh_revisions(project.path(), comments.path(), &["a.tex".into()])
            .unwrap();
        fs::rename(
            dir.join("candidate/a.tex"),
            dir.join("candidate/renamed.tex"),
        )
        .unwrap();
        crate::comments::prepare_path_changes(
            project.path(),
            comments.path(),
            &[crate::comments::CommentPathChange {
                old_path: "a.tex".into(),
                new_path: "renamed.tex".into(),
                folder: false,
            }],
        )
        .unwrap();
        prepare_review(
            &dir,
            &session,
            &[("renamed.tex", true)],
            Some(comments.path()),
        );
        apply_settlement_files(&dir).unwrap();
        // Metadata failure retains only the independent comment job.
        let human = crate::comments::test_read(comments.path().join("human.json")).unwrap();
        crate::comments::test_write(comments.path().join("human.json"), "invalid JSON").unwrap();
        let settled = load_session(&dir).unwrap();
        assert_eq!(settled.status, "settled");
        assert!(!dir.join(SETTLEMENT).exists());
        crate::comments::test_write(comments.path().join("human.json"), human).unwrap();
        crate::comments::recovery::recover(project.path(), comments.path()).unwrap();
        crate::comments::recover_path_changes(project.path(), comments.path()).unwrap();
        load_session(&dir).unwrap();
        for group in ["human", "agent"] {
            let saved: serde_json::Value = serde_json::from_slice(
                &crate::comments::test_read(comments.path().join(format!("{group}.json"))).unwrap(),
            )
            .unwrap();
            assert!(saved["files"]["a.tex"].is_null());
            assert_eq!(saved["files"]["renamed.tex"][0]["text"], "Keep feedback");
            assert_eq!(
                saved["revisions"]["renamed.tex"].as_array().unwrap().len(),
                1
            );
        }
        assert!(!dir.join(SETTLEMENT).exists());
    }

    #[test]
    fn rollback_objects_survive_gc_even_when_absent_from_all_draft_snapshots() {
        let (project, _workspaces, session, dir) = fixture();
        fs::write(project.path().join("a.tex"), "external before acceptance\n").unwrap();
        fs::write(dir.join("candidate/a.tex"), "approved resolution\n").unwrap();
        let records = changes(&dir).unwrap();
        let chosen = records.iter().find(|r| display_path(r) == "a.tex").unwrap();
        let decision = AgentWorkspaceDecision {
            change_id: chosen.id.clone(),
            accept: true,
            ..Default::default()
        };
        // An explicitly reviewed resolution can replace both divergent texts.
        prepare_settlement(
            &dir,
            &session,
            &records,
            &HashMap::from([(chosen.id.clone(), decision)]),
            &[PlannedOperation {
                remove_paths: vec![],
                write_path: Some("a.tex".into()),
                write_bytes: Some(b"approved resolution\n".to_vec()),
            }],
            None,
        )
        .unwrap();
        apply_settlement_files(&dir).unwrap();
        let repo = repository(&dir).unwrap();
        let git_dir = repo.path().to_path_buf();
        drop(repo);
        assert!(std::process::Command::new("git")
            .arg("--git-dir")
            .arg(git_dir)
            .args(["gc", "--prune=now"])
            .output()
            .unwrap()
            .status
            .success());
        rollback_settlement(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join("a.tex")).unwrap(),
            "external before acceptance\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("candidate/a.tex")).unwrap(),
            "approved resolution\n"
        );
        assert_eq!(
            load_session(&dir).unwrap().source_commit,
            session.source_commit
        );
    }

    #[test]
    fn validation_failure_persists_cancellation_until_newer_edits_are_resolved() {
        let (project, _workspaces, session, dir) = fixture();
        fs::write(dir.join("candidate/a.tex"), "proposal\n").unwrap();
        prepare_review(&dir, &session, &[("a.tex", true)], None);
        fs::write(project.path().join("a.tex"), "newer user edit\n").unwrap();
        assert!(apply_settlement_files(&dir)
            .unwrap_err()
            .contains("Project changed"));
        let repo = repository(&dir).unwrap();
        assert!(matches!(
            load_settlement(&dir, &repo).unwrap().direction,
            SettlementDirection::Rollback
        ));
        assert!(load_session(&dir).is_err());
        assert_eq!(
            fs::read_to_string(project.path().join("a.tex")).unwrap(),
            "newer user edit\n"
        );
        fs::write(project.path().join("a.tex"), "a original\n").unwrap();
        load_session(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join("a.tex")).unwrap(),
            "a original\n"
        );
        assert!(!dir.join(SETTLEMENT).exists());
        assert_eq!(changes(&dir).unwrap().len(), 1);
    }

}
