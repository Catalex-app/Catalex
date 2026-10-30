//! App-owned MCP transport, bound to a window/chat runtime. Each turn supplies
//! an immutable draft snapshot; already-admitted calls never follow a new draft.
use crate::branding::PRODUCT_NAME;
use std::sync::{Arc, Mutex};
use std::{future::Future, pin::Pin};

use axum::{extract::State, http::StatusCode, middleware, response::IntoResponse, Router};
use rmcp::{
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, RoleServer, ServerHandler,
};
use serde_json::{json, Value};
use crate::host::WindowContext;
use tokio_util::sync::CancellationToken;

use crate::verification::{
    execute_tool, VerificationContext, VerificationToolResult, MAX_RENDER_PAGES,
};

pub(crate) fn comment_guidance() -> &'static str {
    "Comments apply directly in every approval mode. Use list_comments before editing, resolving, or deleting, and reread on revision conflicts. Before changing existing comments, briefly explain your intention; one notice can cover a related group and does not require a reply. Prefer resolving to deleting; delete only when explicitly requested. If comment changes depend on proposed text, wait for the text decision, then reread the resulting source and comments before continuing. Never assume proposed text was accepted. Do not edit comments.json or comments-agents.json directly."
}

type Executor = Arc<
    dyn Fn(
            Arc<TurnScope>,
            String,
            Value,
        ) -> Pin<Box<dyn Future<Output = VerificationToolResult> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone, serde::Serialize)]
pub struct ConnectionSettings {
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
}

pub struct WorkspaceMcp {
    pub settings: ConnectionSettings,
    active: Arc<Mutex<Option<Arc<TurnScope>>>>,
    shutdown: CancellationToken,
}

/// Revokes access even when starting a provider turn fails before its listener starts.
pub struct TurnAccess(CancellationToken);

struct TurnScope {
    model: Option<String>,
    thinking_effort: Option<String>,
    review_choice: tokio::sync::Mutex<Option<crate::comments::ReviewChoice>>,
    project_path: String,
    context: Option<VerificationContext>,
    cancelled: CancellationToken,
}

// Captured at HTTP admission, before the MCP SDK schedules the tool handler.
#[derive(Clone)]
struct AdmittedTurn(Option<Arc<TurnScope>>);

impl Drop for TurnAccess {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl Drop for WorkspaceMcp {
    fn drop(&mut self) {
        self.cancel_turn();
        self.shutdown.cancel();
    }
}

impl WorkspaceMcp {
    pub async fn start(
        window: WindowContext,
        tab_id: String,
        source_root: String,
        origin: crate::comments::AgentOrigin,
    ) -> Result<Arc<Self>, String> {
        let execute: Executor = Arc::new(move |scope, tool, arguments| {
            let window = window.clone();
            let tab_id = tab_id.clone();
            let source_root = source_root.clone();
            let mut origin = origin.clone();
            origin.model = scope.model.clone();
            origin.thinking_effort = scope.thinking_effort.clone();
            Box::pin(async move {
                if tool == "ask_user" {
                    let result = async {
                        crate::agent_workspace::validate_comment_scope(
                            &window.service,
                            &source_root,
                            &scope.project_path,
                            &tab_id,
                        )?;
                        let answer = crate::agent_questions::ask(
                            &window,
                            &tab_id,
                            &origin.session_id,
                            &source_root,
                            arguments,
                            &scope.cancelled,
                        )
                        .await?;
                        crate::agent_workspace::validate_comment_scope(
                            &window.service,
                            &source_root,
                            &scope.project_path,
                            &tab_id,
                        )?;
                        Ok::<_, String>(answer)
                    }
                    .await;
                    return match result {
                        Ok(payload) => VerificationToolResult {
                            success: true,
                            payload,
                            images: vec![],
                        },
                        Err(error) => VerificationToolResult {
                            success: false,
                            payload: json!({"status":"error","message":error}),
                            images: vec![],
                        },
                    };
                }
                if matches!(
                    tool.as_str(),
                    "list_comments" | "edit_comment" | "resolve_comment" | "delete_comment"
                ) {
                    return match crate::comments::manage_agent_comment(
                        &window,
                        &source_root,
                        &scope.project_path,
                        &tab_id,
                        &tool,
                        arguments,
                        &scope.cancelled,
                    )
                    .await
                    {
                        Ok(payload) => VerificationToolResult {
                            success: true,
                            payload,
                            images: vec![],
                        },
                        Err(error) => VerificationToolResult {
                            success: false,
                            payload: json!({"status":"error","message":error}),
                            images: vec![],
                        },
                    };
                }
                if tool == "create_comment" {
                    return match crate::comments::create_agent_comment(
                        &window,
                        &source_root,
                        &scope.project_path,
                        &tab_id,
                        &origin,
                        arguments,
                        &scope.cancelled,
                        &scope.review_choice,
                    )
                    .await
                    {
                        Ok(payload) => VerificationToolResult {
                            success: true,
                            payload,
                            images: vec![],
                        },
                        Err(error) => VerificationToolResult {
                            success: false,
                            payload: json!({"status":"error","message":error}),
                            images: vec![],
                        },
                    };
                }
                execute_tool(
                    &window,
                    &scope.project_path,
                    &tab_id,
                    scope.context.as_ref(),
                    &tool,
                    &arguments,
                    &scope.cancelled,
                )
                .await
            })
        });
        Self::serve(execute).await
    }

    async fn serve(execute: Executor) -> Result<Arc<Self>, String> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Could not start {PRODUCT_NAME} MCP: {error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let shutdown = CancellationToken::new();
        let active = Arc::new(Mutex::new(None));
        let bearer = format!("Bearer {}", uuid::Uuid::new_v4());
        let handler = WorkspaceHandler {
            execute,
            pending: Arc::new(tokio::sync::Semaphore::new(8)),
        };
        let config = StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_allowed_hosts([address.to_string()])
            .with_allowed_origins([format!("http://{address}")])
            .with_max_request_body_bytes(64 * 1024)
            .with_cancellation_token(shutdown.clone());
        let service = StreamableHttpService::new(
            move || Ok(handler.clone()),
            Arc::new(LocalSessionManager::default()),
            config,
        );
        let router =
            Router::new()
                .nest_service("/mcp", service)
                .layer(middleware::from_fn_with_state(
                    (bearer.clone(), active.clone()),
                    authenticate,
                ));
        let stopped = shutdown.clone();
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router)
                .with_graceful_shutdown(stopped.cancelled_owned())
                .await
            {
                eprintln!("[catalex-mcp] server stopped: {error}");
            }
        });
        Ok(Arc::new(Self {
            settings: ConnectionSettings {
                url: format!("http://{address}/mcp"),
                headers: std::collections::HashMap::from([("Authorization".into(), bearer)]),
            },
            active,
            shutdown,
        }))
    }

    pub fn matches(&self, project_path: &str, context: Option<&VerificationContext>) -> bool {
        self.active.lock().unwrap().as_ref().is_some_and(|scope| {
            scope.project_path == project_path
                && serde_json::to_value(context).ok() == serde_json::to_value(&scope.context).ok()
        })
    }

    #[cfg(test)]
    pub fn begin_turn(
        &self,
        project_path: String,
        context: Option<VerificationContext>,
    ) -> Result<TurnAccess, String> {
        self.begin_turn_with_model(project_path, context, None, None)
    }

    pub fn begin_turn_with_model(
        &self,
        project_path: String,
        context: Option<VerificationContext>,
        model: Option<String>,
        thinking_effort: Option<String>,
    ) -> Result<TurnAccess, String> {
        let mut active = self.active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|scope| !scope.cancelled.is_cancelled())
        {
            return Err(concat!("A ", env!("APP_BRAND_NAME"), " MCP turn is already active").into());
        }
        let token = CancellationToken::new();
        *active = Some(Arc::new(TurnScope {
            model,
            thinking_effort,
            review_choice: tokio::sync::Mutex::new(None),
            project_path,
            context,
            cancelled: token.clone(),
        }));
        Ok(TurnAccess(token))
    }

    pub fn cancel_turn(&self) {
        if let Some(scope) = self.active.lock().unwrap().as_ref() {
            scope.cancelled.cancel();
        }
    }
}

async fn authenticate(
    State((bearer, active)): State<(String, Arc<Mutex<Option<Arc<TurnScope>>>>)>,
    mut request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let mut authorization = request.headers().get_all("authorization").iter();
    if authorization.next().and_then(|value| value.to_str().ok()) != Some(&bearer)
        || authorization.next().is_some()
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    request
        .extensions_mut()
        .insert(AdmittedTurn(active.lock().unwrap().clone()));
    next.run(request).await
}

#[derive(Clone)]
struct WorkspaceHandler {
    execute: Executor,
    pending: Arc<tokio::sync::Semaphore>,
}

fn tool_catalog() -> Vec<Tool> {
    let empty = json!({"type":"object","properties":{},"additionalProperties":false});
    [
        ("compile", concat!("Compile this draft's resolved LaTeX root using ", env!("APP_BRAND_NAME"), "'s preview compiler and engine. Returns authoritative compile status, diagnostics, configured engine, and actualEngine (the last engine invoked, or null if no compiler ran)."), empty.clone()),
        ("diagnostics", concat!("Read diagnostics and actualEngine from this draft's latest ", env!("APP_BRAND_NAME"), " compile."), empty.clone()),
        ("workspace_state", "Read this draft's resolved LaTeX root, compiler settings, and verification capabilities.", empty),
        ("render_page", "Render one to three pages of this draft's latest compiled PDF as PNG images. Compile first if the document changed.", json!({
            "type":"object", "properties":{"pages":{"type":"array","items":{"type":"integer","minimum":1},"minItems":1,"maxItems":MAX_RENDER_PAGES,"uniqueItems":true}},
            "required":["pages"],"additionalProperties":false
        })),
        ("ask_user", concat!("Ask the user one question with 2–4 choices in ", env!("APP_BRAND_NAME"), "'s UI; custom answers are also allowed. Use when clarification or a decision is needed. Keep questions and choices simple, precise, and compact. Waits for an answer in this turn (up to 10 minutes); cancellation/expiry is not approval. The answer does not bypass any tool validation. For changed review text, offer updating feedback, saving only safely anchored comments, or discarding only unsaved comments."), json!({
            "type":"object","properties":{
                "permission":{"type":"boolean","description":"Whether this is a tool approval request with explicit choices only."},
                "details":{"type":"string","description":"Optional full action details shown with the question.","maxLength":128000},
                "question":{"type":"string","description":"One short, clear sentence asking for the user's decision.","minLength":1,"maxLength":2000},
                "options":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"object","properties":{
                    "label":{"type":"string","description":"A few words identifying the choice. Put any necessary explanation in description.","minLength":1,"maxLength":120},
                    "description":{"type":"string","description":"Optional explanation shown when hovering over the question mark. Usually one brief sentence; do not repeat the label or add unnecessary detail.","maxLength":500}
                },"required":["label"],"additionalProperties":false}}
            },"required":["question","options"],"additionalProperties":false
        })),
        ("list_comments", "List all human and agent comments, including resolved comments, on a source document. Returns IDs and revisions for safe mutations.", json!({"type": "object", "properties": {"filePath": {"type": "string", "description": "Project-relative source document path"}}, "required": ["filePath"], "additionalProperties": false})),
        ("edit_comment", "Edit only the text of an existing human or agent comment. Applies directly in every approval mode. Preserves its anchor and original author. Use the revision from list_comments; on conflict, reread and reconsider.", json!({"type": "object", "properties": {"filePath": {"type": "string", "description": "Project-relative source document path"}, "id": {"type": "string", "minLength": 1}, "revision": {"type": "string", "minLength": 1}, "text": {"type": "string", "minLength": 1, "maxLength": 20000}}, "required": ["filePath", "id", "revision", "text"], "additionalProperties": false})),
        ("resolve_comment", "Change comment status directly in every approval mode. Set resolved to true to resolve, or false to reopen and show it again. Omitted resolved defaults to true. Briefly inform the user before changing existing comments. Use its current revision from list_comments; on conflict, reread and reconsider.", json!({"type": "object", "properties": {"filePath": {"type": "string", "description": "Project-relative source document path"}, "id": {"type": "string", "minLength": 1}, "revision": {"type": "string", "minLength": 1}, "resolved": {"type": "boolean", "default": true, "description": "true resolves the comment; false reopens it"}}, "required": ["filePath", "id", "revision"], "additionalProperties": false})),
        ("delete_comment", "Delete a comment directly. Prefer resolving; delete only when explicitly requested. Use its current revision from list_comments; on conflict, reread and reconsider.", json!({"type": "object", "properties": {"filePath": {"type": "string", "description": "Project-relative source document path"}, "id": {"type": "string", "minLength": 1}, "revision": {"type": "string", "minLength": 1}}, "required": ["filePath", "id", "revision"], "additionalProperties": false})),
        ("create_comment", concat!("Add an Agent review comment immediately to the source, independently of accepting draft edits. Supply an exact passage and optionally its 1-based start line in the draft. If the file differs, the complete blank-line-delimited paragraph(s) must remain exact and unique in source; shifted/moved blocks are allowed. A missing or conflicting anchor opens ", env!("APP_BRAND_NAME"), "'s existing choice UI and waits for the user. Do not launch another question. A review_decision response saved nothing: follow the recorded answer. Only Update comments permits a fresh reviewedParagraph; reread the returned source path and reconsider feedback first. Safe-only and discard decisions cannot be bypassed with fresh context. Never edit source to force a match; unsaved source buffers and stale sessions still reject."), json!({
            "type":"object","properties":{
                "filePath":{"type":"string","description":"Project-relative document path"},
                "passage":{"type":"string","minLength":1,"maxLength":20000},
                "lineHint":{"type":"integer","minimum":1},
                "text":{"type":"string","minLength":1,"maxLength":20000},
                "reviewedParagraph":{"type":"string","minLength":1,"maxLength":20000,"description":"Only after rereviewing changed source: exact complete blank-line-delimited source block(s), including adjoining section/command lines when no blank line separates them. Omit outer blank lines and the trailing newline. Must be unique; passage must occur once inside it. An incomplete_paragraph error supplies the full context to review before a corrected attempt. lineHint is not used in this mode."}
            },"required":["filePath","passage","text"],"additionalProperties":false
        })),
    ].into_iter().map(|(name, description, schema)| {
        Tool::new(name, description, schema.as_object().unwrap().clone())
    }).collect()
}

fn mcp_result(result: VerificationToolResult) -> CallToolResult {
    let mut content = vec![ContentBlock::text(result.payload.to_string())];
    for image in result.images {
        let Some(data) = image.strip_prefix("data:image/png;base64,") else {
            return CallToolResult::error(vec![ContentBlock::text(
                concat!(env!("APP_BRAND_NAME"), " returned an invalid PNG image"),
            )]);
        };
        content.push(ContentBlock::image(data, "image/png"));
    }
    if result.success {
        CallToolResult::success(content)
    } else {
        CallToolResult::error(content)
    }
}

impl ServerHandler for WorkspaceHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new(concat!(env!("APP_BRAND_NAME"), " Workspace"), env!("CARGO_PKG_VERSION")),
        )
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut result = ListToolsResult::default();
        result.tools = tool_catalog();
        // New-protocol clients validate these required cache fields. Leave the
        // legacy response unchanged, including for Codex's 2025-06-18 client.
        if context
            .protocol_version()
            .is_some_and(|version| version >= ProtocolVersion::V_2026_07_28)
        {
            result.ttl_ms = Some(0);
            result.cache_scope = Some(CacheScope::Private);
        }
        Ok(result)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let admitted = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<AdmittedTurn>())
            .and_then(|admitted| admitted.0.clone());
        let Some(scope) = admitted.filter(|scope| !scope.cancelled.is_cancelled()) else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                concat!("This ", env!("APP_BRAND_NAME"), " agent turn is no longer active"),
            )])
            .into());
        };
        let Ok(permit) = self.pending.clone().try_acquire_owned() else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                concat!(env!("APP_BRAND_NAME"), " MCP is busy; try again after pending calls finish"),
            )])
            .into());
        };
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        let execute = self.execute.clone();
        let token = scope.cancelled.clone();
        if matches!(request.name.as_ref(), "ask_user" | "create_comment") {
            // Both can wait for a question; drop that wait on client cancellation.
            let result = tokio::select! {
                biased;
                _ = token.cancelled() => CallToolResult::error(vec![ContentBlock::text("Question cancelled with its agent turn")]),
                _ = context.ct.cancelled() => CallToolResult::error(vec![ContentBlock::text("Question cancelled by client")]),
                result = execute(scope, request.name.into_owned(), arguments) => mcp_result(result),
            };
            drop(permit);
            return Ok(result.into());
        }
        // Keep the backend future alive after client cancellation: its compile
        // lock must remain held until the blocking compiler actually finishes.
        let operation = tokio::spawn(async move {
            let _permit = permit;
            execute(scope, request.name.into_owned(), arguments).await
        });
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => CallToolResult::error(vec![ContentBlock::text(concat!(env!("APP_BRAND_NAME"), " agent turn cancelled"))]),
            result = operation => match result {
                Ok(result) => mcp_result(result),
                Err(_) => CallToolResult::error(vec![ContentBlock::text(concat!(env!("APP_BRAND_NAME"), " verification failed unexpectedly"))]),
            },
        };
        Ok(result.into())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[tokio::test]
    async fn model_metadata_is_snapshotted_per_turn() {
        let connection = fixture().await;
        let first = connection
            .begin_turn_with_model(
                "/draft".into(),
                None,
                Some("first".into()),
                Some("low".into()),
            )
            .unwrap();
        let admitted = connection.active.lock().unwrap().clone().unwrap();
        drop(first);
        let _second = connection
            .begin_turn_with_model(
                "/draft".into(),
                None,
                Some("second".into()),
                Some("high".into()),
            )
            .unwrap();
        assert_eq!(admitted.model.as_deref(), Some("first"));
        assert_eq!(admitted.thinking_effort.as_deref(), Some("low"));
        let active = connection.active.lock().unwrap().clone().unwrap();
        assert_eq!(active.model.as_deref(), Some("second"));
        assert_eq!(active.thinking_effort.as_deref(), Some("high"));
    }

    pub(crate) async fn fixture() -> Arc<WorkspaceMcp> {
        WorkspaceMcp::serve(
            Arc::new(move |scope, tool, arguments| {
                Box::pin(async move {
                    VerificationToolResult {
                        success: tool != "unknown",
                        payload: json!({"scope":scope.project_path, "context":scope.context, "tool":tool, "arguments":arguments}),
                        images: if tool == "render_page" {
                            vec!["data:image/png;base64,iVBORw0KGgo=".into()]
                        } else {
                            vec![]
                        },
                    }
                })
            }),
        )
        .await
        .unwrap()
    }

    fn request(connection: &WorkspaceMcp, method: &str, params: Value) -> reqwest::RequestBuilder {
        reqwest::Client::new()
            .post(&connection.settings.url)
            .header(
                "Authorization",
                &connection.settings.headers["Authorization"],
            )
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-03-26")
            .header("Content-Type", "application/json")
            .body(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string())
    }

    async fn rpc(connection: &WorkspaceMcp, method: &str, params: Value) -> Value {
        let text = request(connection, method, params)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test]
    async fn tool_catalog_cache_metadata_is_versioned_without_changing_tools() {
        let connection = fixture().await;
        let _turn = connection.begin_turn("/draft-protocol".into(), None).unwrap();
        for version in ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] {
            let modern = version == "2026-07-28";
            let meta = json!({
                "io.modelcontextprotocol/protocolVersion": version,
                "io.modelcontextprotocol/clientInfo": {"name":"protocol-test","version":"1"},
                "io.modelcontextprotocol/clientCapabilities": {}
            });
            for (method, mut params) in [
                ("tools/list", json!({})),
                ("tools/call", json!({"name":"list_comments","arguments":{"filePath":"main.tex"}})),
            ] {
                if modern {
                    params["_meta"] = meta.clone();
                }
                let response = reqwest::Client::new()
                    .post(&connection.settings.url)
                    .header("Authorization", &connection.settings.headers["Authorization"])
                    .header("Accept", "application/json, text/event-stream")
                    .header("MCP-Protocol-Version", version)
                    .header("Mcp-Method", method)
                    .header("Mcp-Name", "list_comments")
                    .header("Content-Type", "application/json")
                    .body(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string())
                    .send().await.unwrap();
                let status = response.status();
                let text = response.text().await.unwrap();
                assert!(status.is_success(), "{version} {method}: {status} {text}");
                let reply: Value = serde_json::from_str(&text).unwrap();
                let mut result = reply["result"].clone();
                if modern {
                    assert_eq!(result.as_object_mut().unwrap().remove("resultType"), Some(json!("complete")));
                }
                if method == "tools/list" {
                    if modern {
                        assert_eq!(result.as_object_mut().unwrap().remove("ttlMs"), Some(json!(0)));
                        assert_eq!(result.as_object_mut().unwrap().remove("cacheScope"), Some(json!("private")));
                    }
                    // Full schemas/descriptions and the legacy envelope stay identical.
                    assert_eq!(result, json!({"tools":tool_catalog()}), "{version}");
                } else {
                    assert_eq!(result["isError"], false, "{version}: {reply}");
                    let payload: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
                    assert_eq!(payload, json!({"scope":"/draft-protocol","context":null,"tool":"list_comments","arguments":{"filePath":"main.tex"}}));
                }
            }
        }
    }

    #[tokio::test]
    async fn http_protocol_discovers_one_catalog_and_returns_images() {
        let connection = fixture().await;
        let _turn = connection.begin_turn("/draft-a".into(), None).unwrap();
        let initialized = rpc(
            &connection,
            "initialize",
            json!({
                "protocolVersion":"2025-03-26","capabilities":{},
                "clientInfo":{"name":"catalex-test","version":"1"}
            }),
        )
        .await;
        assert_eq!(
            initialized["result"]["serverInfo"]["name"],
            concat!(env!("APP_BRAND_NAME"), " Workspace")
        );
        let listed = rpc(&connection, "tools/list", json!({})).await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 10);
        let status_tool = tools.iter().find(|tool| tool["name"] == "resolve_comment").unwrap();
        assert_eq!(status_tool["inputSchema"]["properties"]["resolved"]["type"], "boolean");
        assert_eq!(status_tool["inputSchema"]["properties"]["resolved"]["default"], true);
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "compile",
                "diagnostics",
                "workspace_state",
                "render_page",
                "ask_user",
                "list_comments",
                "edit_comment",
                "resolve_comment",
                "delete_comment",
                "create_comment"
            ]
        );
        assert_eq!(
            tools[3]["inputSchema"]["properties"]["pages"]["maxItems"],
            MAX_RENDER_PAGES
        );
        let ask_user = tools
            .iter()
            .find(|tool| tool["name"] == "ask_user")
            .unwrap();
        let properties = &ask_user["inputSchema"]["properties"];
        let choice = &properties["options"]["items"]["properties"];
        for (description, guidance) in [
            (&ask_user["description"], "simple, precise, and compact"),
            (&properties["question"]["description"], "One short"),
            (&choice["label"]["description"], "A few words"),
            (
                &choice["description"]["description"],
                "hovering over the question mark",
            ),
        ] {
            assert!(description.as_str().unwrap().contains(guidance));
        }
        let rendered = rpc(
            &connection,
            "tools/call",
            json!({"name":"render_page","arguments":{"pages":[1]}}),
        )
        .await;
        assert_eq!(rendered["result"]["isError"], false);
        assert_eq!(rendered["result"]["content"][1]["type"], "image");
        assert_eq!(rendered["result"]["content"][1]["mimeType"], "image/png");
        assert_eq!(rendered["result"]["content"][1]["data"], "iVBORw0KGgo=");
    }

    #[tokio::test]
    async fn http_auth_origin_and_scope_are_enforced() {
        let a = fixture().await;
        let b = fixture().await;
        let _turn_a = a.begin_turn("/draft-a".into(), None).unwrap();
        let _turn_b = b.begin_turn("/draft-b".into(), None).unwrap();
        let response = reqwest::Client::new()
            .post(&a.settings.url)
            .header("Authorization", &b.settings.headers["Authorization"])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = request(&a, "tools/list", json!({}))
            .header("Origin", "https://untrusted.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = request(&a, "tools/list", json!({}))
            .header("Host", "untrusted.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        for (connection, expected) in [(&a, "/draft-a"), (&b, "/draft-b")] {
            let result = rpc(connection, "tools/call", json!({"name":"workspace_state"})).await;
            let payload: Value =
                serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(payload["scope"], expected);
        }
        assert!(a.matches("/draft-a", None));
        assert!(!a.matches("/draft-b", None));
    }

    #[tokio::test]
    async fn turn_completion_cancellation_and_continuation_control_access() {
        let connection = fixture().await;
        let call = json!({"name":"workspace_state"});
        assert_eq!(
            rpc(&connection, "tools/call", call.clone()).await["result"]["isError"],
            true
        );
        let first = connection.begin_turn("/draft-a".into(), None).unwrap();
        assert_eq!(
            rpc(&connection, "tools/call", call.clone()).await["result"]["isError"],
            false
        );
        connection.cancel_turn();
        assert_eq!(
            rpc(&connection, "tools/call", call.clone()).await["result"]["isError"],
            true
        );
        let second = connection.begin_turn("/draft-b".into(), None).unwrap();
        drop(first); // Late cleanup must not revoke the next turn.
        assert_eq!(
            rpc(&connection, "tools/call", call.clone()).await["result"]["isError"],
            false
        );
        drop(second);
        assert_eq!(
            rpc(&connection, "tools/call", call).await["result"]["isError"],
            true
        );
    }

    #[test]
    fn failed_results_remain_errors_and_invalid_images_are_rejected() {
        let result = mcp_result(VerificationToolResult {
            success: false,
            payload: json!({"code":"compile_failed"}),
            images: vec![],
        });
        assert_eq!(result.is_error, Some(true));
        let result = mcp_result(VerificationToolResult {
            success: true,
            payload: json!({}),
            images: vec!["https://example.com/image.png".into()],
        });
        assert_eq!(result.is_error, Some(true));
    }

    #[tokio::test]
    async fn persistent_connection_refreshes_draft_and_settings_only_between_turns() {
        let connection = fixture().await;
        let settings = serde_json::to_value(&connection.settings).unwrap();
        let first = connection.begin_turn("/draft-a".into(), None).unwrap();
        assert!(connection.begin_turn("/draft-b".into(), None).is_err());
        assert!(connection.matches("/draft-a", None));
        drop(first);
        let context = VerificationContext {
            root_id: "appendix.tex".into(),
            target_path: "appendix.tex".into(),
            backend: crate::latex::CompilerBackend::Latexmk,
            engine: crate::latex::TexEngine::XeLaTeX,
            auto_engine: false,
        };
        let second = connection
            .begin_turn("/draft-b".into(), Some(context.clone()))
            .unwrap();
        for tool in ["workspace_state", "diagnostics", "compile", "render_page"] {
            let arguments = if tool == "render_page" {
                json!({"pages":[1]})
            } else {
                json!({})
            };
            let result = rpc(
                &connection,
                "tools/call",
                json!({"name":tool,"arguments":arguments}),
            )
            .await;
            let payload: Value =
                serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(payload["scope"], "/draft-b");
            assert_eq!(payload["context"], serde_json::to_value(&context).unwrap());
        }
        assert_eq!(
            settings,
            serde_json::to_value(&connection.settings).unwrap()
        );
        drop(second);
        assert_eq!(
            rpc(&connection, "tools/call", json!({"name":"workspace_state"})).await["result"]
                ["isError"],
            true
        );
    }

    #[tokio::test]
    async fn cancelled_inflight_call_retains_its_snapshot_after_a_new_turn_starts() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let (finished, mut finishes) = tokio::sync::mpsc::unbounded_channel();
        let release_operation = release.clone();
        let connection = WorkspaceMcp::serve(Arc::new(move |scope, tool, _| {
            let release = release_operation.clone();
            let started = started.clone();
            let finished = finished.clone();
            Box::pin(async move {
                if tool == "compile" {
                    started.send(()).unwrap();
                    release.notified().await;
                    finished.send(scope.project_path.clone()).unwrap();
                }
                VerificationToolResult {
                    success: true,
                    payload: json!({"scope":scope.project_path}),
                    images: vec![],
                }
            })
        }))
        .await
        .unwrap();
        let first = connection.begin_turn("/draft-a".into(), None).unwrap();
        let old_connection = connection.clone();
        let old_call = tokio::spawn(async move {
            rpc(&old_connection, "tools/call", json!({"name":"compile"})).await
        });
        starts.recv().await.unwrap();
        connection.cancel_turn();
        let _second = connection.begin_turn("/draft-b".into(), None).unwrap();
        drop(first);
        assert_eq!(old_call.await.unwrap()["result"]["isError"], true);
        assert!(finishes.try_recv().is_err());
        let current = rpc(&connection, "tools/call", json!({"name":"workspace_state"})).await;
        assert!(current["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("/draft-b"));
        release.notify_waiters();
        assert_eq!(finishes.recv().await.unwrap(), "/draft-a");
        assert!(connection.matches("/draft-b", None));
    }

    #[tokio::test]
    async fn cancelled_calls_keep_backend_locks_and_pending_calls_are_bounded() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let (finished, mut finishes) = tokio::sync::mpsc::unbounded_channel();
        let release_operation = release.clone();
        let connection = WorkspaceMcp::serve(Arc::new(move |_scope, tool, _| {
            let release = release_operation.clone();
            let started = started.clone();
            let finished = finished.clone();
            Box::pin(async move {
                if tool == "compile" {
                    started.send(()).unwrap();
                    release.notified().await;
                    finished.send(()).unwrap();
                }
                VerificationToolResult {
                    success: true,
                    payload: json!({}),
                    images: vec![],
                }
            })
        }))
        .await
        .unwrap();
        let _turn = connection.begin_turn("/draft".into(), None).unwrap();
        let mut calls = Vec::new();
        for _ in 0..8 {
            let connection = connection.clone();
            calls.push(tokio::spawn(async move {
                rpc(&connection, "tools/call", json!({"name":"compile"})).await
            }));
        }
        for _ in 0..8 {
            starts.recv().await.unwrap();
        }
        let overflow = rpc(&connection, "tools/call", json!({"name":"workspace_state"})).await;
        assert_eq!(overflow["result"]["isError"], true);
        connection.cancel_turn();
        for call in calls {
            assert_eq!(call.await.unwrap()["result"]["isError"], true);
        }
        assert!(
            finishes.try_recv().is_err(),
            "Cancellation must not drop the backend future"
        );
        release.notify_waiters();
        for _ in 0..8 {
            finishes.recv().await.unwrap();
        }
        let _next_turn = connection.begin_turn("/draft-next".into(), None).unwrap();
        let result = rpc(&connection, "tools/call", json!({"name":"workspace_state"})).await;
        assert_eq!(result["result"]["isError"], false);
    }

    #[tokio::test]
    async fn cancelling_a_question_drops_the_waiter_instead_of_detaching_it() {
        assert_question_cancellation("ask_user").await;
        assert_question_cancellation("create_comment").await;
    }

    async fn assert_question_cancellation(question_tool: &'static str) {
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let (dropped, mut drops) = tokio::sync::mpsc::unbounded_channel();
        struct Guard(tokio::sync::mpsc::UnboundedSender<()>);
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let connection = WorkspaceMcp::serve(Arc::new(move |_, tool, _| {
            let started = started.clone();
            let dropped = dropped.clone();
            Box::pin(async move {
                if tool == question_tool {
                    let _guard = Guard(dropped);
                    started.send(()).unwrap();
                    std::future::pending::<()>().await;
                }
                VerificationToolResult {
                    success: true,
                    payload: json!({}),
                    images: vec![],
                }
            })
        }))
        .await
        .unwrap();
        let turn = connection.begin_turn("/draft".into(), None).unwrap();
        let question_connection = connection.clone();
        let question = tokio::spawn(async move {
            rpc(
                &question_connection,
                "tools/call",
                json!({"name":question_tool}),
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), starts.recv())
            .await
            .unwrap()
            .unwrap();
        drop(turn);
        assert_eq!(question.await.unwrap()["result"]["isError"], true);
        tokio::time::timeout(std::time::Duration::from_secs(2), drops.recv())
            .await
            .unwrap()
            .unwrap();
        let _next = connection.begin_turn("/next".into(), None).unwrap();
        assert_eq!(
            rpc(&connection, "tools/call", json!({"name":"workspace_state"})).await["result"]
                ["isError"],
            false
        );
    }

    #[tokio::test]
    #[ignore = "Requires installed Codex, Claude and sidecar Bun; sends no model prompts"]
    async fn installed_clients() {
        run_client_smoke(false).await;
    }

    #[tokio::test]
    #[ignore = "Sends a short Codex model turn to test MCP tool approval on a fixture"]
    async fn installed_agent_tool_approval() {
        run_client_smoke(true).await;
    }

    async fn run_client_smoke(agent_probe: bool) {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;
        let connection = fixture().await;
        let _turn = connection.begin_turn("/draft-smoke".into(), None).unwrap();
        let sidecar =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop-sidecar");
        let mut child = tokio::process::Command::new(sidecar.join("node_modules/.bin/bun"))
            .arg("run")
            .arg("scripts/mcp-client-smoke.ts")
            .current_dir(&sidecar)
            .env(
                "CATALEX_MCP_AGENT_PROBE",
                if agent_probe { "1" } else { "0" },
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(
                &serde_json::to_vec(&json!({
                    "connection": connection.settings,
                    "codexConfig": crate::codex::codex_mcp_config(&connection.settings),
                    "pluginRoot": crate::builtin_skills::resolve_root_from_resource_dir(
                        std::env::current_exe().unwrap().parent().unwrap()
                    ).unwrap()
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        drop(stdin);
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(90), child.wait_with_output())
                .await
                .expect("MCP client smoke timed out")
                .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
    }
}
