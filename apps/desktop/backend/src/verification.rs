use crate::branding::PRODUCT_NAME;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::host::WindowContext;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

pub const MAX_RENDER_PAGES: usize = 3;
const RENDER_TARGET_WIDTH: u32 = 900;
const MAX_RENDER_IMAGE_DATA_URL_BYTES: usize = 8 * 1024 * 1024;
const MAX_RENDER_TOTAL_DATA_URL_BYTES: usize = 20 * 1024 * 1024;
const MAX_TOOL_TEXT_CHARS: usize = 12_000;
const MAX_PENDING_RENDER_REQUESTS: usize = 8;
const MAX_PENDING_COMPILE_PDFS: usize = 8;
const RENDER_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationContext {
    pub root_id: String,
    pub target_path: String,
    pub backend: crate::latex::CompilerBackend,
    pub engine: crate::latex::TexEngine,
    #[serde(default)]
    pub auto_engine: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationToolResult {
    pub success: bool,
    pub payload: Value,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

#[derive(Clone)]
pub struct VerificationServiceState {
    render_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<VerificationRenderReply>>>>,
    next_request_id: Arc<AtomicI64>,
    last_compile_results: Arc<Mutex<HashMap<String, Value>>>,
    compile_pdfs: Arc<Mutex<VecDeque<VerificationPdf>>>,
}

impl Default for VerificationServiceState {
    fn default() -> Self {
        Self {
            render_waiters: Arc::new(Mutex::new(HashMap::new())),
            next_request_id: Arc::new(AtomicI64::new(1)),
            last_compile_results: Arc::new(Mutex::new(HashMap::new())),
            compile_pdfs: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

struct VerificationPdf {
    window_id: String,
    project_path: String,
    request_id: String,
    bytes: Vec<u8>,
}

impl VerificationServiceState {
    async fn save_pdf(&self, pdf: VerificationPdf) {
        let mut pdfs = self.compile_pdfs.lock().await;
        while pdfs.len() >= MAX_PENDING_COMPILE_PDFS {
            pdfs.pop_front();
        }
        pdfs.push_back(pdf);
    }

    // Consume the exact result once. Never fall back to another build's PDF.
    pub async fn take_pdf(&self, window_id: &str, project_path: &str, request_id: &str) -> Option<Vec<u8>> {
        let mut pdfs = self.compile_pdfs.lock().await;
        let index = pdfs.iter().position(|pdf| pdf.window_id == window_id && pdf.project_path == project_path && pdf.request_id == request_id)?;
        pdfs.remove(index).map(|pdf| pdf.bytes)
    }
}

#[derive(Clone, serde::Serialize)]
struct VerificationCompileEvent {
    request_id: String,
    tab_id: String,
    project_path: String,
    root_id: String,
    main_file: String,
    backend: String,
    engine: String,
    status: String,
    duration_ms: Option<u64>,
    error: Option<String>,
    diagnostics: Vec<crate::latex::CompileDiagnostic>,
}

#[derive(Clone, serde::Serialize)]
struct VerificationRenderRequestEvent {
    request_id: String,
    tab_id: String,
    project_path: String,
    root_id: String,
    pages: Vec<u32>,
    target_width: u32,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRenderedPage {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub image_data_url: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRenderReply {
    pub status: String,
    pub code: Option<String>,
    pub message: Option<String>,
    pub page_count: Option<u32>,
    pub pages: Option<Vec<VerificationRenderedPage>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct VerificationError {
    pub code: &'static str,
    pub message: String,
}

fn bounded_text(message: &str) -> String {
    message.chars().take(MAX_TOOL_TEXT_CHARS).collect()
}

fn compiler_backend_name(backend: crate::latex::CompilerBackend) -> &'static str {
    match backend {
        crate::latex::CompilerBackend::Latexmk => "latexmk",
        crate::latex::CompilerBackend::Tectonic => "tectonic",
    }
}

fn tex_engine_name(engine: crate::latex::TexEngine) -> &'static str {
    match engine {
        crate::latex::TexEngine::Latex => "pdflatex",
        crate::latex::TexEngine::XeLaTeX => "xelatex",
        crate::latex::TexEngine::LuaLaTeX => "lualatex",
    }
}

fn success(payload: Value) -> VerificationToolResult {
    VerificationToolResult {
        success: true,
        payload,
        images: Vec::new(),
    }
}

fn failure(code: &str, message: impl AsRef<str>) -> VerificationToolResult {
    let message = bounded_text(message.as_ref());
    VerificationToolResult {
        success: false,
        payload: json!({
            "status": "error",
            "code": code,
            "diagnostics": [{
                "severity": "error",
                "message": message
            }]
        }),
        images: Vec::new(),
    }
}

fn require_empty_arguments(arguments: &Value, tool: &str) -> Result<(), VerificationError> {
    let Some(object) = arguments.as_object() else {
        return Err(VerificationError {
            code: "invalid_arguments",
            message: format!("{tool} expects an empty object as its arguments"),
        });
    };
    if !object.is_empty() {
        return Err(VerificationError {
            code: "invalid_arguments",
            message: format!("{tool} does not accept any arguments"),
        });
    }
    Ok(())
}

pub(crate) fn parse_render_page_arguments(
    arguments: &Value,
) -> Result<Vec<u32>, VerificationError> {
    let Some(object) = arguments.as_object() else {
        return Err(VerificationError {
            code: "invalid_arguments",
            message: "render_page expects an object with a pages array".to_string(),
        });
    };
    if object.keys().any(|key| key != "pages") {
        return Err(VerificationError {
            code: "invalid_arguments",
            message: "render_page only accepts the pages field".to_string(),
        });
    }
    let Some(raw_pages) = object.get("pages").and_then(Value::as_array) else {
        return Err(VerificationError {
            code: "invalid_arguments",
            message: "render_page requires a pages array".to_string(),
        });
    };
    if raw_pages.is_empty() {
        return Err(VerificationError {
            code: "invalid_arguments",
            message: "Request at least one PDF page".to_string(),
        });
    }
    if raw_pages.len() > MAX_RENDER_PAGES {
        return Err(VerificationError {
            code: "too_many_pages",
            message: format!("A single render request is limited to {MAX_RENDER_PAGES} pages"),
        });
    }

    let mut pages = Vec::with_capacity(raw_pages.len());
    let mut unique_pages = HashSet::new();
    for raw_page in raw_pages {
        let Some(page) = raw_page.as_u64().filter(|page| *page > 0) else {
            return Err(VerificationError {
                code: "invalid_page",
                message: "Page numbers must be positive one-based integers".to_string(),
            });
        };
        let Ok(page) = u32::try_from(page) else {
            return Err(VerificationError {
                code: "invalid_page",
                message: "A requested page number is too large".to_string(),
            });
        };
        if !unique_pages.insert(page) {
            return Err(VerificationError {
                code: "duplicate_page",
                message: format!("Page {page} was requested more than once"),
            });
        }
        pages.push(page);
    }
    Ok(pages)
}

fn validate_project_scope(
    project_path: &str,
    context: Option<&VerificationContext>,
) -> Result<String, VerificationError> {
    let canonical_project =
        std::fs::canonicalize(project_path).map_err(|error| VerificationError {
            code: "invalid_project",
            message: format!("{PRODUCT_NAME} could not resolve the active project: {error}"),
        })?;
    if !canonical_project.is_dir() {
        return Err(VerificationError {
            code: "invalid_project",
            message: concat!("The active ", env!("APP_BRAND_NAME"), " project is not a directory").to_string(),
        });
    }

    let Some(context) = context else {
        return Ok(canonical_project.to_string_lossy().to_string());
    };
    if context.root_id.is_empty() || context.root_id.len() > 4_096 {
        return Err(VerificationError {
            code: "invalid_root",
            message: "The active LaTeX root identifier is invalid".to_string(),
        });
    }

    let target = Path::new(&context.target_path);
    let is_safe_relative_target = !context.target_path.is_empty()
        && target.extension().and_then(|extension| extension.to_str()) == Some("tex")
        && target
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
    if !is_safe_relative_target {
        return Err(VerificationError {
            code: "invalid_root",
            message: "The active LaTeX root must be a project-relative .tex file".to_string(),
        });
    }

    let canonical_target =
        std::fs::canonicalize(canonical_project.join(target)).map_err(|error| {
            VerificationError {
                code: "invalid_root",
                message: format!("{PRODUCT_NAME} could not resolve the active LaTeX root: {error}"),
            }
        })?;
    if !canonical_target.starts_with(&canonical_project) {
        return Err(VerificationError {
            code: "invalid_root",
            message: "The active LaTeX root resolves outside the opened project".to_string(),
        });
    }

    Ok(canonical_project.to_string_lossy().to_string())
}

fn render_error_payload(
    code: impl Into<String>,
    message: impl AsRef<str>,
    page_count: Option<u32>,
) -> Value {
    json!({
        "status": "error",
        "code": code.into(),
        "message": bounded_text(message.as_ref()),
        "pageCount": page_count
    })
}

fn normalized_render_error_code(code: Option<&str>) -> &'static str {
    match code {
        Some("missing_pdf") => "missing_pdf",
        Some("invalid_page") => "invalid_page",
        Some("render_failed") => "render_failed",
        Some("image_too_large") => "image_too_large",
        _ => "render_failed",
    }
}

pub(crate) fn render_reply_to_result(
    requested_pages: &[u32],
    reply: VerificationRenderReply,
) -> Result<VerificationToolResult, VerificationError> {
    if reply.status != "success" {
        return Err(VerificationError {
            code: "render_failed",
            message: bounded_text(
                reply
                    .message
                    .as_deref()
                    .unwrap_or(concat!(env!("APP_BRAND_NAME"), " could not render the requested PDF pages")),
            ),
        });
    }

    let rendered_pages = reply.pages.ok_or_else(|| VerificationError {
        code: "invalid_render_response",
        message: "The PDF renderer returned no page images".to_string(),
    })?;
    if rendered_pages.len() != requested_pages.len() {
        return Err(VerificationError {
            code: "invalid_render_response",
            message: "The PDF renderer returned an unexpected number of page images".to_string(),
        });
    }

    let mut total_data_url_bytes = 0usize;
    let mut images = Vec::with_capacity(rendered_pages.len());
    let mut metadata = Vec::with_capacity(rendered_pages.len());
    for (expected_page, rendered_page) in requested_pages.iter().zip(rendered_pages) {
        if rendered_page.page != *expected_page {
            return Err(VerificationError {
                code: "invalid_render_response",
                message: format!(
                    "The PDF renderer returned page {} while page {} was requested",
                    rendered_page.page, expected_page
                ),
            });
        }
        if rendered_page.width == 0
            || rendered_page.height == 0
            || rendered_page.width > 8_192
            || rendered_page.height > 8_192
        {
            return Err(VerificationError {
                code: "invalid_render_response",
                message: format!("Page {expected_page} has invalid image dimensions"),
            });
        }
        if !rendered_page
            .image_data_url
            .starts_with("data:image/png;base64,")
        {
            return Err(VerificationError {
                code: "invalid_render_response",
                message: format!("Page {expected_page} was not returned as a PNG image"),
            });
        }
        if rendered_page.image_data_url.len() > MAX_RENDER_IMAGE_DATA_URL_BYTES {
            return Err(VerificationError {
                code: "image_too_large",
                message: format!("The rendered image for page {expected_page} is too large"),
            });
        }
        total_data_url_bytes =
            total_data_url_bytes.saturating_add(rendered_page.image_data_url.len());
        if total_data_url_bytes > MAX_RENDER_TOTAL_DATA_URL_BYTES {
            return Err(VerificationError {
                code: "images_too_large",
                message: "The combined rendered page images are too large".to_string(),
            });
        }

        metadata.push(json!({
            "page": rendered_page.page,
            "width": rendered_page.width,
            "height": rendered_page.height,
            "mimeType": "image/png"
        }));
        images.push(rendered_page.image_data_url);
    }

    Ok(VerificationToolResult {
        success: true,
        payload: json!({
            "status": "success",
            "pageCount": reply.page_count,
            "pages": metadata
        }),
        images,
    })
}

async fn compile(
    window: &WindowContext,
    project_path: &str,
    tab_id: &str,
    context: &VerificationContext,
    canonical_project: &str,
    cancelled: &CancellationToken,
) -> VerificationToolResult {
    let request_id = format!(
        "verification-compile-{}",
        window.service.verification.next_request_id.fetch_add(1, Ordering::Relaxed)
    );
    let operation = match window.service.latex.operations.register_verification(
        &window.id, project_path, &request_id, cancelled.child_token(),
    ) {
        Ok(operation) => operation,
        Err(error) => return failure("compile_failed", &error),
    };
    let backend = compiler_backend_name(context.backend);
    let engine = if context.auto_engine { "auto" } else { tex_engine_name(context.engine) };
    let _ = window.emit(
        "catalex-verification-compile",
        VerificationCompileEvent {
            request_id: request_id.clone(),
            tab_id: tab_id.to_string(),
            project_path: project_path.to_string(),
            root_id: context.root_id.clone(),
            main_file: context.target_path.clone(),
            backend: backend.to_string(),
            engine: engine.to_string(),
            status: "started".to_string(),
            duration_ms: None,
            error: None,
            diagnostics: Vec::new(),
        },
    );

    let started_at = Instant::now();
    let app = window.service.clone();
    let compiler_state = window.service.latex
        .clone();
    let compile_result = crate::latex::compile_latex_bytes(
        &app,
        &compiler_state,
        project_path.to_string(),
        context.target_path.clone(),
        Some(context.backend),
        if context.auto_engine { None } else { Some(context.engine) },
        operation.clone(),
    ).await;
    let stopped = compiler_state.operations.finish(&window.id, project_path, &request_id, &operation,
        compile_result.as_ref().err().map(|e| e.message.as_str()));
    let cleanup_failed = compile_result.as_ref().err().is_some_and(|error| error.message.starts_with(crate::compile_process::CLEANUP_FAILED));
    let compilation_cancelled = !cleanup_failed && (stopped || compile_result.as_ref().err().is_some_and(|error| error.code == "cancelled"));
    // Always send a terminal event after the compiler releases its lock. A
    // cancelled turn releases the renderer queue without publishing its result.
    let duration_ms = started_at.elapsed().as_millis() as u64;

    let diagnostics = compile_result
        .as_ref()
        .map(|result| result.diagnostics.clone())
        .unwrap_or_else(|error| error.diagnostics.clone());
    let (success_value, payload, event_error, pdf_bytes) = match compile_result {
        Ok(result) => {
            let payload = json!({
                "status": "success",
                "rootFile": context.target_path,
                "backend": backend,
                "engine": engine,
                "actualEngine": result.actual_engine,
                "durationMs": duration_ms,
                "pdfBytes": result.pdf_bytes.len(),
                "diagnostics": result.diagnostics
            });
            (true, payload, None, Some(result.pdf_bytes))
        },
        Err(error) => {
            let actual_engine = error.actual_engine;
            let error = bounded_text(&error.message);
            (
                false,
                json!({
                    "status": "error",
                    "rootFile": context.target_path,
                    "backend": backend,
                    "engine": engine,
                    "actualEngine": actual_engine,
                    "durationMs": duration_ms,
                    "diagnostics": if diagnostics.is_empty() {
                        json!([{ "severity": "error", "message": error }])
                    } else { json!(diagnostics) }
                }),
                Some(error),
                None,
            )
        }
    };

    let state = window.service.verification
        .clone();
    {
        let mut results = state.last_compile_results.lock().await;
        if !cancelled.is_cancelled() && !compilation_cancelled {
            results.insert(canonical_project.to_string(), payload.clone());
        }
    }

    if !cancelled.is_cancelled() && !compilation_cancelled {
        if let Some(bytes) = pdf_bytes {
            state.save_pdf(VerificationPdf {
                window_id: window.id.clone(),
                project_path: project_path.to_string(),
                request_id: request_id.clone(),
                bytes,
            }).await;
        }
    }
    let was_cancelled = cancelled.is_cancelled() || compilation_cancelled;
    let _ = window.emit(
        "catalex-verification-compile",
        VerificationCompileEvent {
            request_id: request_id.clone(),
            tab_id: tab_id.to_string(),
            project_path: project_path.to_string(),
            root_id: context.root_id.clone(),
            main_file: context.target_path.clone(),
            backend: backend.to_string(),
            engine: engine.to_string(),
            status: if was_cancelled { "cancelled" } else if success_value { "succeeded" } else { "failed" }.to_string(),
            duration_ms: Some(duration_ms),
            error: if was_cancelled { None } else { event_error },
            diagnostics: if was_cancelled { Vec::new() } else { diagnostics },
        },
    );

    if compilation_cancelled && !cancelled.is_cancelled() {
        return failure("compile_cancelled", "Compilation cancelled by user");
    }
    if was_cancelled {
        return failure("turn_cancelled", concat!(env!("APP_BRAND_NAME"), " agent turn cancelled"));
    }

    VerificationToolResult {
        success: success_value,
        payload,
        images: Vec::new(),
    }
}

async fn diagnostics(window: &WindowContext, canonical_project: &str) -> VerificationToolResult {
    let last_compile = window.service.verification
        .last_compile_results
        .lock()
        .await
        .get(canonical_project)
        .cloned();
    let Some(last_compile) = last_compile else {
        return success(json!({
            "status": "not_compiled",
            "diagnostics": [],
            "message": concat!("No ", env!("APP_BRAND_NAME"), " verification compile has run for this project yet")
        }));
    };

    success(json!({
        "status": "success",
        "compileStatus": last_compile.get("status").cloned().unwrap_or(Value::Null),
        "rootFile": last_compile.get("rootFile").cloned().unwrap_or(Value::Null),
        "backend": last_compile.get("backend").cloned().unwrap_or(Value::Null),
        "engine": last_compile.get("engine").cloned().unwrap_or(Value::Null),
        "actualEngine": last_compile.get("actualEngine").cloned().unwrap_or(Value::Null),
        "durationMs": last_compile.get("durationMs").cloned().unwrap_or(Value::Null),
        "diagnostics": last_compile.get("diagnostics").cloned().unwrap_or_else(|| json!([]))
    }))
}

async fn workspace_state(
    window: &WindowContext,
    project_path: &str,
    canonical_project: &str,
    context: Option<&VerificationContext>,
) -> VerificationToolResult {
    let last_compile = window.service.verification
        .last_compile_results
        .lock()
        .await
        .get(canonical_project)
        .cloned();
    let last_compile_summary = last_compile.as_ref().map(|compile| {
        json!({
            "status": compile.get("status").cloned().unwrap_or(Value::Null),
            "rootFile": compile.get("rootFile").cloned().unwrap_or(Value::Null),
            "durationMs": compile.get("durationMs").cloned().unwrap_or(Value::Null),
            "pdfBytes": compile.get("pdfBytes").cloned().unwrap_or(Value::Null),
            "diagnosticCount": compile
                .get("diagnostics")
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
        })
    });
    let root = context.map(|context| {
        json!({
            "id": context.root_id,
            "file": context.target_path,
            "backend": compiler_backend_name(context.backend),
            "engine": if context.auto_engine { "auto" } else { tex_engine_name(context.engine) }
        })
    });

    success(json!({
        "status": "success",
        "server": { "id": "catalex", "name": concat!(env!("APP_BRAND_NAME"), " Workspace") },
        "projectPath": project_path,
        "root": root,
        "lastCompile": last_compile_summary,
        "capabilities": ["compile", "diagnostics", "render_page", "workspace_state"],
        "limits": {
            "maxRenderPages": MAX_RENDER_PAGES,
            "maxConcurrentCompilations": crate::latex::MAX_CONCURRENT_COMPILATIONS,
            "maxPendingRenderRequests": MAX_PENDING_RENDER_REQUESTS,
            "renderTargetWidth": RENDER_TARGET_WIDTH,
            "maxTextCharacters": MAX_TOOL_TEXT_CHARS
        }
    }))
}

async fn render_pages(
    window: &WindowContext,
    project_path: &str,
    tab_id: &str,
    context: &VerificationContext,
    pages: Vec<u32>,
    cancelled: &CancellationToken,
) -> VerificationToolResult {
    let state = &window.service.verification;
    let render_request_id = format!(
        "verification-render-{}",
        state.next_request_id.fetch_add(1, Ordering::Relaxed)
    );
    let (reply_sender, reply_receiver) = oneshot::channel();
    {
        let mut waiters = state.render_waiters.lock().await;
        if waiters.len() >= MAX_PENDING_RENDER_REQUESTS {
            return VerificationToolResult {
                success: false,
                payload: render_error_payload(
                    "server_busy",
                    concat!(env!("APP_BRAND_NAME"), " Workspace has too many pending render requests"),
                    None,
                ),
                images: Vec::new(),
            };
        }
        waiters.insert(render_request_id.clone(), reply_sender);
    }

    if let Err(error) = window.emit(
        "catalex-verification-render-page",
        VerificationRenderRequestEvent {
            request_id: render_request_id.clone(),
            tab_id: tab_id.to_string(),
            project_path: project_path.to_string(),
            root_id: context.root_id.clone(),
            pages: pages.clone(),
            target_width: RENDER_TARGET_WIDTH,
        },
    ) {
        state.render_waiters.lock().await.remove(&render_request_id);
        return VerificationToolResult {
            success: false,
            payload: render_error_payload(
                "render_failed",
                format!("Failed to start {PRODUCT_NAME}'s PDF renderer: {error}"),
                None,
            ),
            images: Vec::new(),
        };
    }

    let reply_result = tokio::select! {
        biased;
        _ = cancelled.cancelled() => {
            state.render_waiters.lock().await.remove(&render_request_id);
            return failure("turn_cancelled", concat!(env!("APP_BRAND_NAME"), " agent turn cancelled"));
        }
        result = tokio::time::timeout(RENDER_TIMEOUT, reply_receiver) => result,
    };
    let reply = match reply_result {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => {
            state.render_waiters.lock().await.remove(&render_request_id);
            return VerificationToolResult {
                success: false,
                payload: render_error_payload(
                    "render_failed",
                    concat!(env!("APP_BRAND_NAME"), "'s PDF renderer stopped before returning the requested pages"),
                    None,
                ),
                images: Vec::new(),
            };
        }
        Err(_) => {
            state.render_waiters.lock().await.remove(&render_request_id);
            return VerificationToolResult {
                success: false,
                payload: render_error_payload(
                    "render_timeout",
                    concat!(env!("APP_BRAND_NAME"), "'s PDF renderer timed out after 45 seconds"),
                    None,
                ),
                images: Vec::new(),
            };
        }
    };

    if reply.status != "success" {
        return VerificationToolResult {
            success: false,
            payload: render_error_payload(
                normalized_render_error_code(reply.code.as_deref()),
                reply
                    .message
                    .as_deref()
                    .unwrap_or(concat!(env!("APP_BRAND_NAME"), " could not render the requested PDF pages")),
                reply.page_count,
            ),
            images: Vec::new(),
        };
    }

    match render_reply_to_result(&pages, reply) {
        Ok(result) => result,
        Err(error) => VerificationToolResult {
            success: false,
            payload: render_error_payload(error.code, error.message, None),
            images: Vec::new(),
        },
    }
}

/// Execute a semantic Catalex verification operation. This service is shared by
/// the MCP transport and never accepts arbitrary filesystem or UI actions.
pub async fn execute_tool(
    window: &WindowContext,
    project_path: &str,
    tab_id: &str,
    context: Option<&VerificationContext>,
    tool: &str,
    arguments: &Value,
    cancelled: &CancellationToken,
) -> VerificationToolResult {
    if cancelled.is_cancelled() {
        return failure("turn_cancelled", concat!(env!("APP_BRAND_NAME"), " agent turn cancelled"));
    }
    let canonical_project = match validate_project_scope(project_path, context) {
        Ok(project) => project,
        Err(error) => return failure(error.code, error.message),
    };

    match tool {
        "compile" => {
            if let Err(error) = require_empty_arguments(arguments, tool) {
                return failure(error.code, error.message);
            }
            let Some(context) = context else {
                return failure(
                    "missing_root",
                    concat!("The active ", env!("APP_BRAND_NAME"), " project does not contain a compilable LaTeX root"),
                );
            };
            compile(window, project_path, tab_id, context, &canonical_project, cancelled).await
        }
        "diagnostics" => {
            if let Err(error) = require_empty_arguments(arguments, tool) {
                return failure(error.code, error.message);
            }
            diagnostics(window, &canonical_project).await
        }
        "workspace_state" => {
            if let Err(error) = require_empty_arguments(arguments, tool) {
                return failure(error.code, error.message);
            }
            workspace_state(window, project_path, &canonical_project, context).await
        }
        "render_page" => {
            let pages = match parse_render_page_arguments(arguments) {
                Ok(pages) => pages,
                Err(error) => return failure(error.code, error.message),
            };
            let Some(context) = context else {
                return VerificationToolResult {
                    success: false,
                    payload: render_error_payload(
                        "missing_pdf",
                        concat!("The active ", env!("APP_BRAND_NAME"), " project does not contain a compiled LaTeX document"),
                        None,
                    ),
                    images: Vec::new(),
                };
            };
            render_pages(window, project_path, tab_id, context, pages, cancelled).await
        }
        _ => failure(
            "unknown_tool",
            format!("{PRODUCT_NAME} Workspace does not provide the semantic operation `{tool}`"),
        ),
    }
}

pub async fn resolve_verification_render_request(
    state: &VerificationServiceState,
    request_id: String,
    result: VerificationRenderReply,
) -> Result<(), String> {
    let sender = state
        .render_waiters
        .lock()
        .await
        .remove(&request_id)
        .ok_or_else(|| format!("No active {PRODUCT_NAME} render request matches `{request_id}`"))?;
    sender
        .send(result)
        .map_err(|_| concat!("The ", env!("APP_BRAND_NAME"), " render request is no longer active").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    #[ignore = "requires installed latexmk, pdfLaTeX, XeLaTeX and LuaLaTeX"]
    async fn compile_reports_actual_engine_and_preserves_it_in_diagnostics() {
        let dir = TempDir::new().unwrap();
        let service = std::sync::Arc::new(crate::host::ServiceState {
            data_dir: dir.path().join("data"),
            cache_dir: dir.path().join("cache"),
            resource_dir: dir.path().join("resources"),
            claude: Default::default(),
            codex: Default::default(),
            pi: Default::default(),
            latex: Default::default(),
            verification: Default::default(),
            comments: Default::default(),
            project_files: Default::default(),
            questions: Default::default(),
            zotero: Default::default(),
        });
        let window = WindowContext { service, id: "engine-test".into() };
        let project = dir.path().join("project");
        fs::create_dir(&project).unwrap();
        let project = project.to_str().unwrap();
        let cancelled = CancellationToken::new();
        for (name, source, engine, auto, expected, succeeds) in [
            ("auto", r"\documentclass{article}\begin{document}Hello\end{document}", crate::latex::TexEngine::Latex, true, Some("pdflatex"), true),
            ("fallback", r"\documentclass{article}\usepackage{fontspec}\begin{document}Hello\end{document}", crate::latex::TexEngine::Latex, true, Some("xelatex"), true),
            ("lua", r"\documentclass{article}\begin{document}Hello\end{document}", crate::latex::TexEngine::LuaLaTeX, false, Some("lualatex"), true),
            ("broken", r"\documentclass{article}\begin{document}\input{missing}\end{document}", crate::latex::TexEngine::XeLaTeX, false, Some("xelatex"), false),
            ("missing", "", crate::latex::TexEngine::Latex, true, None, false),
        ] {
            let file = format!("{name}.tex");
            if !source.is_empty() { fs::write(Path::new(project).join(&file), source).unwrap(); }
            let context = VerificationContext { root_id: file.clone(), target_path: file.clone(),
                backend: crate::latex::CompilerBackend::Latexmk, engine, auto_engine: auto };
            let result = compile(&window, project, "tab", &context, project, &cancelled).await;
            assert_eq!(result.success, succeeds, "{name}: {:?}", result.payload);
            assert_eq!(result.payload["actualEngine"], json!(expected), "{name}");
            assert_eq!(result.payload["engine"], if auto { "auto" } else { tex_engine_name(engine) });
            let saved = diagnostics(&window, project).await.payload;
            assert_eq!(saved["actualEngine"], json!(expected), "{name}");
            assert_eq!(saved["rootFile"], file);
            assert_eq!(workspace_state(&window, project, project, Some(&context)).await.payload["root"]["engine"], result.payload["engine"]);
        }
    }

    #[tokio::test]
    async fn pdf_results_are_request_scoped_consumable_and_bounded() {
        let state = VerificationServiceState::default();
        for index in 0..=MAX_PENDING_COMPILE_PDFS {
            state.save_pdf(VerificationPdf {
                window_id: "window".into(), project_path: "/project".into(),
                request_id: index.to_string(), bytes: vec![index as u8],
            }).await;
        }
        assert_eq!(state.take_pdf("window", "/project", "0").await, None);
        assert_eq!(state.take_pdf("other", "/project", "1").await, None);
        assert_eq!(state.take_pdf("window", "/other", "1").await, None);
        assert_eq!(state.take_pdf("window", "/project", "1").await, Some(vec![1]));
        assert_eq!(state.take_pdf("window", "/project", "1").await, None);
        assert_eq!(state.take_pdf("window", "/project", "2").await, Some(vec![2]));
    }

    #[test]
    fn validates_bounded_one_based_render_page_requests() {
        assert_eq!(
            parse_render_page_arguments(&json!({ "pages": [1, 3] })).unwrap(),
            vec![1, 3]
        );
        assert_eq!(
            parse_render_page_arguments(&json!({ "pages": [] }))
                .unwrap_err()
                .code,
            "invalid_arguments"
        );
        assert_eq!(
            parse_render_page_arguments(&json!({ "pages": [1, 2, 3, 4] }))
                .unwrap_err()
                .code,
            "too_many_pages"
        );
        assert_eq!(
            parse_render_page_arguments(&json!({ "pages": [1, 1] }))
                .unwrap_err()
                .code,
            "duplicate_page"
        );
        assert_eq!(
            parse_render_page_arguments(&json!({ "pages": [0] }))
                .unwrap_err()
                .code,
            "invalid_page"
        );
    }

    #[test]
    fn rejects_roots_outside_the_project_scope() {
        let project = TempDir::new().unwrap();
        fs::write(project.path().join("main.tex"), "content").unwrap();
        let valid = VerificationContext {
            root_id: "main.tex".to_string(),
            target_path: "main.tex".to_string(),
            backend: crate::latex::CompilerBackend::Latexmk,
            engine: crate::latex::TexEngine::XeLaTeX,
            auto_engine: false,
        };
        assert!(validate_project_scope(project.path().to_str().unwrap(), Some(&valid)).is_ok());

        let invalid = VerificationContext {
            target_path: "../main.tex".to_string(),
            ..valid
        };
        assert_eq!(
            validate_project_scope(project.path().to_str().unwrap(), Some(&invalid))
                .unwrap_err()
                .code,
            "invalid_root"
        );
    }

    #[test]
    fn render_result_keeps_images_separate_from_bounded_metadata() {
        let image_data_url = "data:image/png;base64,iVBORw0KGgo=".to_string();
        let result = render_reply_to_result(
            &[2],
            VerificationRenderReply {
                status: "success".to_string(),
                code: None,
                message: None,
                page_count: Some(5),
                pages: Some(vec![VerificationRenderedPage {
                    page: 2,
                    width: 1_800,
                    height: 2_546,
                    image_data_url: image_data_url.clone(),
                }]),
            },
        )
        .unwrap();

        assert!(result.success);
        assert_eq!(result.payload["pageCount"], json!(5));
        assert_eq!(result.payload["pages"][0]["page"], json!(2));
        assert_eq!(result.images, vec![image_data_url]);
        assert!(!result.payload.to_string().contains("data:image/png"));
    }
}
