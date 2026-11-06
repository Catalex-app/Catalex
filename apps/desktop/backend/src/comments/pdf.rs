//! Agent PDF reads and anchors use the app's MuPDF worker, never agent coordinates.
use super::*;
type Waiters = Arc<std::sync::Mutex<BTreeMap<String, (String, oneshot::Sender<PdfReply>)>>>;

#[derive(Default)]
pub(super) struct PdfRequests {
    pending: Waiters,
}
struct Pending {
    pending: Waiters,
    id: String,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfReply {
    fingerprint: Option<String>,
    page_count: Option<usize>,
    #[serde(default)]
    pages: Vec<PdfPage>,
    anchor: Option<PdfCommentAnchor>,
    error: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PdfPage {
    page: usize,
    text: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PdfLocation {
    pub page: usize,
    pub fingerprint: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadPdf {
    file_path: String,
    pages: Vec<usize>,
}

fn fingerprint(root: &Path, file: &str) -> Result<String, String> {
    let relative = relative_path(file)?;
    if !relative
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("invalid_document: read_pdf requires a standalone .pdf file".into());
    }
    identity::project_source(root, file)?
        .and_then(|source| source.strip_prefix("pdf:").map(str::to_owned))
        .ok_or_else(|| "missing_document: PDF must be a regular project file".into())
}
fn check_pages(pages: &[usize]) -> Result<(), String> {
    if pages.is_empty()
        || pages.len() > 3
        || pages.iter().any(|p| *p == 0 || *p > 100_000)
        || pages
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != pages.len()
    {
        return Err("invalid_pages: request one to three unique positive page numbers".into());
    }
    Ok(())
}

pub async fn resolve(
    window: WindowContext,
    request_id: String,
    reply: PdfReply,
) -> Result<(), String> {
    let mut pending = window
        .service
        .comments
        .pdf_requests
        .pending
        .lock()
        .map_err(|_| "PDF requests unavailable")?;
    if !pending
        .get(&request_id)
        .is_some_and(|(owner, _)| owner == window.label())
    {
        return Err("stale_session: PDF request expired or belongs to another window".into());
    }
    if let Some((_, sender)) = pending.remove(&request_id) {
        let _ = sender.send(reply);
    }
    Ok(())
}

async fn inspect(
    window: &WindowContext,
    source_root: &str,
    draft_root: &str,
    tab_id: &str,
    file: &str,
    pages: &[usize],
    passage: Option<&str>,
    expected: Option<&str>,
    cancelled: &CancellationToken,
) -> Result<PdfReply, String> {
    check_pages(pages)?;
    crate::agent_workspace::validate_comment_scope(
        &window.service,
        source_root,
        draft_root,
        tab_id,
    )?;
    if cancelled.is_cancelled() {
        return Err("stale_session: agent turn ended".into());
    }
    let source = fs::canonicalize(source_root).map_err(|e| e.to_string())?;
    let current = fingerprint(&source, file)?;
    if expected.is_some_and(|expected| expected != current)
        || fingerprint(Path::new(draft_root), file)? != current
    {
        return Err(
            "changed_pdf: source and reviewed PDF must match; read the current PDF again".into(),
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    let pending = window.service.comments.pdf_requests.pending.clone();
    {
        let mut waiters = pending.lock().map_err(|_| "PDF requests unavailable")?;
        if waiters.len() >= 8 {
            return Err("busy: too many PDF requests".into());
        }
        waiters.insert(id.clone(), (window.label().into(), sender));
    }
    let _guard = Pending {
        pending,
        id: id.clone(),
    };
    let mut request = json!({"requestId":id,"projectRoot":source_root,"path":source.join(relative_path(file)?),"fingerprint":current,"pages":pages});
    if let Some(passage) = passage {
        request["passage"] = json!(passage);
    }
    window.emit("catalex-agent-pdf-request", request)?;
    let reply = tokio::select! {
        biased;
        _ = cancelled.cancelled() => return Err("stale_session: agent turn ended".into()),
        result = tokio::time::timeout(std::time::Duration::from_secs(45), receiver) =>
            result.map_err(|_| "pdf_unavailable: PDF reader timed out")?.map_err(|_| "pdf_unavailable: PDF reader closed")?,
    };
    if let Some(error) = &reply.error {
        return Err(error.chars().take(2000).collect());
    }
    crate::agent_workspace::validate_comment_scope(
        &window.service,
        source_root,
        draft_root,
        tab_id,
    )?;
    if fingerprint(&source, file)? != current
        || fingerprint(Path::new(draft_root), file)? != current
    {
        return Err("changed_pdf: PDF changed while it was being read".into());
    }
    if reply.fingerprint.as_deref() != Some(&current)
        || reply
            .page_count
            .is_none_or(|count| count == 0 || count > 100_000)
        || reply.pages.len() != pages.len()
        || reply.pages.iter().zip(pages).any(|(p, requested)| {
            p.page != *requested || p.page > reply.page_count.unwrap_or(0) || p.text.len() > 80_000
        })
    {
        return Err("invalid_pdf_reply: document or page identity mismatch".into());
    }
    Ok(reply)
}

pub async fn read(
    window: &WindowContext,
    source_root: &str,
    draft_root: &str,
    tab_id: &str,
    args: Value,
    cancelled: &CancellationToken,
) -> Result<Value, String> {
    let input: ReadPdf =
        serde_json::from_value(args).map_err(|e| format!("invalid_arguments: {e}"))?;
    let reply = inspect(
        window,
        source_root,
        draft_root,
        tab_id,
        &input.file_path,
        &input.pages,
        None,
        None,
        cancelled,
    )
    .await?;
    Ok(
        json!({"filePath":input.file_path,"fingerprint":reply.fingerprint,"pageCount":reply.page_count,"pages":reply.pages}),
    )
}

pub(super) async fn create(
    window: &WindowContext,
    source_root: &str,
    draft_root: &str,
    tab_id: &str,
    origin: &AgentOrigin,
    input: &CreateComment,
    cancelled: &CancellationToken,
) -> Result<Value, String> {
    let location = input
        .pdf
        .as_ref()
        .ok_or("invalid_arguments: PDF page and fingerprint are required")?;
    if input.line_hint.is_some()
        || input.reviewed_paragraph.is_some()
        || input.passage.trim().is_empty()
        || input.passage.len() > 20_000
    {
        return Err("invalid_arguments: PDF comments require an exact passage, without source line or paragraph hints".into());
    }
    let root = fs::canonicalize(source_root).map_err(|e| e.to_string())?;
    let version = *window
        .service
        .comments
        .clear_versions
        .lock()
        .map_err(|_| "Comment reset lock unavailable")?
        .get(root.to_string_lossy().as_ref())
        .unwrap_or(&0);
    let reply = inspect(
        window,
        source_root,
        draft_root,
        tab_id,
        &input.file_path,
        &[location.page],
        Some(&input.passage),
        Some(&location.fingerprint),
        cancelled,
    )
    .await?;
    let anchor = reply
        .anchor
        .ok_or("missing_passage: PDF reader did not locate the passage")?;
    if anchor.fingerprint != location.fingerprint
        || anchor.text != input.passage
        || anchor
            .regions
            .iter()
            .any(|region| region.page != location.page)
    {
        return Err("invalid_pdf_reply: anchor does not match the requested passage".into());
    }
    let comment = Comment {
        id: uuid::Uuid::new_v4().to_string(),
        pdf: Some(anchor),
        number: None,
        anchor_revision: None,
        position_reset: false,
        removed_anchor: None,
        from: 0,
        to: 0,
        line: location.page,
        text: input.text.trim().into(),
        created_at: Some(chrono::Utc::now().to_rfc3339()),
        resolved: false,
        proposal: None,
        origin: Some(origin.clone()),
    };
    validate(&comment)?;
    let _lock = window.service.comments.lock_project(source_root).await?;
    crate::agent_workspace::validate_comment_scope(
        &window.service,
        source_root,
        draft_root,
        tab_id,
    )?;
    if cancelled.is_cancelled() {
        return Err("stale_session: agent turn ended".into());
    }
    if version
        != *window
            .service
            .comments
            .clear_versions
            .lock()
            .map_err(|_| "Comment reset lock unavailable")?
            .get(root.to_string_lossy().as_ref())
            .unwrap_or(&0)
    {
        return Err("comments_cleared: comments were deleted while preparing this comment".into());
    }
    if fingerprint(&root, &input.file_path)? != location.fingerprint
        || fingerprint(Path::new(draft_root), &input.file_path)? != location.fingerprint
    {
        return Err("changed_pdf: PDF changed before saving the comment".into());
    }
    let storage = comment_directory(&window.service, source_root)?;
    let sides = identity::load_for_write(&root, &storage, [(input.file_path.clone(), None)])?;
    let first = sides
        .iter()
        .all(|side| side.files.get(&input.file_path).is_none_or(Vec::is_empty));
    let change = apply_patch_with_source(
        &root,
        &storage,
        &CommentPatch {
            file_path: input.file_path.clone(),
            id: comment.id.clone(),
            before: None,
            after: Some(comment),
        },
        true,
        None,
    )?;
    if let Err(error) = window.service.emit(
        "catalex-comments-changed",
        json!({"projectRoot":source_root,"tabId":tab_id,"patch":change}),
    ) {
        eprintln!("[comments] saved, but could not notify editors: {error}");
    }
    checkpoint_first_comment(window, source_root, &input.file_path, first, true);
    Ok(json!({"status":"created","filePath":input.file_path,"comment":change.after}))
}
