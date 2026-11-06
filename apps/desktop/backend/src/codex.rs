use crate::branding::PRODUCT_NAME;
use crate::verification::VerificationContext;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::host::WindowContext;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot, Mutex};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Clone)]
pub struct CodexProcessState {
    app_servers: Arc<Mutex<HashMap<String, Arc<CodexAppServerHandle>>>>,
    admission: Arc<Mutex<()>>,
}

impl Default for CodexProcessState {
    fn default() -> Self {
        Self {
            app_servers: Arc::new(Mutex::new(HashMap::new())),
            admission: Arc::new(Mutex::new(())),
        }
    }
}

#[cfg(test)]
const CATALEX_VERIFY_SKILL_MARKER: &str = "$catalex-verify-latex";

static NEXT_OWNER_TOKEN: AtomicI64 = AtomicI64::new(1);

struct CodexAppServerHandle {
    owner_token: i64,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    next_request_id: AtomicI64,
    response_waiters: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    notifications: broadcast::Sender<Value>,
    thread_id: Mutex<Option<String>>,
    active_turn_id: Mutex<Option<String>>,
    mcp: Mutex<Option<Arc<crate::workspace_mcp::WorkspaceMcp>>>,
    runtime_scope: Mutex<Option<(String, String)>>,
    catalex_skills_root: PathBuf,
}

impl CodexAppServerHandle {
    fn new(stdin: ChildStdin, child: Child, catalex_skills_root: PathBuf) -> Self {
        let (notifications, _) = broadcast::channel(512);
        Self {
            owner_token: NEXT_OWNER_TOKEN.fetch_add(1, Ordering::Relaxed),
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            next_request_id: AtomicI64::new(1000),
            response_waiters: Mutex::new(HashMap::new()),
            notifications,
            thread_id: Mutex::new(None),
            active_turn_id: Mutex::new(None),
            mcp: Mutex::new(None),
            runtime_scope: Mutex::new(None),
            catalex_skills_root,
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct CodexOutputEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct CodexActivityEvent {
    tab_id: String,
    kind: String,
    item_id: String,
    text: Option<String>,
    name: Option<String>,
    input: Option<Value>,
    content: Option<Value>,
    is_error: Option<bool>,
}

#[derive(Clone, serde::Serialize)]
struct CodexCompleteEvent {
    tab_id: String,
    success: bool,
}

#[derive(Clone, serde::Serialize)]
struct CodexErrorEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct CodexFinalEvent {
    tab_id: String,
    data: String,
    item_id: Option<String>,
}

#[derive(serde::Serialize)]
pub struct CodexStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub account_label: Option<String>,
}

#[derive(serde::Serialize)]
pub struct CodexModelInfo {
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub supported_reasoning_efforts: Vec<CodexModelReasoningEffort>,
    pub default_reasoning_effort: String,
    pub is_default: bool,
}

#[derive(serde::Serialize)]
pub struct CodexModelReasoningEffort {
    pub value: String,
    pub description: String,
}

fn find_codex_binary() -> Result<String, String> {
    if let Ok(path) = which::which("codex") {
        return Ok(path.to_string_lossy().to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(path) = run_login_shell_command("command -v codex") {
            if PathBuf::from(&path).exists() {
                return Ok(path);
            }
        }

        if let Some(path) = find_codex_in_nvm() {
            return Ok(path);
        }

        for path in [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/usr/bin/codex",
            "/bin/codex",
        ] {
            if PathBuf::from(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(home) = dirs::home_dir() {
            for path in [
                home.join("AppData").join("Roaming").join("npm").join("codex.cmd"),
                home.join("AppData")
                    .join("Local")
                    .join("pnpm")
                    .join("codex.cmd"),
                PathBuf::from(r"C:\Program Files\nodejs\codex.cmd"),
            ] {
                if path.exists() {
                    return Ok(path.to_string_lossy().to_string());
                }
            }
        }
    }

    Err("Not found in any known location. Install Codex CLI first.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn find_codex_in_nvm() -> Option<String> {
    let home = dirs::home_dir()?;
    let nvm_versions_dir = home.join(".nvm").join("versions").join("node");
    let mut candidates = std::fs::read_dir(nvm_versions_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin").join("codex"))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();

    candidates.sort_by(|a, b| b.cmp(a));
    candidates
        .into_iter()
        .next()
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "windows"))]
fn run_login_shell_command(command: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    for candidate in [shell.as_str(), "/bin/zsh", "/bin/bash", "/bin/sh"] {
        if let Ok(output) = std::process::Command::new(candidate)
            .args(["-l", "-c", command])
            .output()
        {
            if output.status.success() {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn new_sync_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn new_sync_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.env("PATH", build_augmented_path(program));
    cmd
}

fn create_command(program: &str, args: &[String], cwd: Option<&str>) -> Command {
    create_command_with_stdin(program, args, cwd, std::process::Stdio::null())
}

fn create_command_with_piped_stdin(program: &str, args: &[String], cwd: Option<&str>) -> Command {
    create_command_with_stdin(program, args, cwd, std::process::Stdio::piped())
}

fn create_command_with_stdin(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    stdin: std::process::Stdio,
) -> Command {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new(program);

    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(stdin);

    cmd.env("PATH", build_augmented_path(program));
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_AGENT_SDK_VERSION");

    cmd
}

fn build_augmented_path(program: &str) -> String {
    let mut current_path = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";

    if let Some(program_dir) = PathBuf::from(program).parent() {
        let dir = program_dir.to_string_lossy().to_string();
        if !current_path.contains(&dir) {
            current_path = format!("{dir}{sep}{current_path}");
        }
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(home) = dirs::home_dir() {
        for dir in [
            home.join(".local").join("bin"),
            home.join(".cargo").join("bin"),
            home.join(".bun").join("bin"),
            home.join("Library").join("pnpm"),
            home.join("Library").join("pnpm").join("global").join("bin"),
            home.join(".nvm").join("versions").join("node").join("current").join("bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ] {
            let dir = dir.to_string_lossy().to_string();
            if PathBuf::from(&dir).exists() && !current_path.contains(&dir) {
                current_path = format!("{dir}{sep}{current_path}");
            }
        }
    }

    current_path
}

fn codex_system_prompt() -> &'static str {
    concat!(
        concat!("You are an AI assistant integrated into a LaTeX document editor (", env!("APP_BRAND_NAME"), "). "),
        "Follow these rules strictly:\n",
        "1. PLANNING FIRST: Before making changes, create a step-by-step plan. ",
        "Break large tasks into small, incremental steps (one section or one logical unit per step).\n",
        "2. INCREMENTAL EDITS: Make small, targeted changes — one step at a time. ",
        "NEVER write or rewrite an entire file at once. Always prefer editing existing content over replacing it wholesale.\n",
        "3. STEP BY STEP: After each edit, mark the todo item as completed, then proceed to the next step. ",
        "This lets the user review changes incrementally.\n",
        "4. PRESERVE EXISTING CONTENT: Always read the file first. Keep the existing preamble, packages, ",
        "and structure intact. Only add or modify what is needed for the current step.\n",
        "5. LaTeX BEST PRACTICES: Use proper sectioning (\\chapter, \\section, \\subsection), ",
        "citations (\\cite), cross-references (\\label, \\ref), and BibTeX for bibliographies.\n",
        "6. SKILLS: Use $catalex-verify-latex for tasks that change LaTeX document sources. ",
        concat!("It defines ", env!("APP_BRAND_NAME"), "'s bounded compile, repair, render, and inspection workflow. "),
        "If scientific skills are installed in .claude/skills/, also follow their domain-specific guidelines ",
        "and use skill-provided LaTeX packages (.sty) and code patterns.",
        "\n7. VERIFY LATEX: After changing LaTeX sources, call mcp__catalex__compile before finishing. ",
        "It compiles the editor's resolved root with the user's active compiler settings and returns diagnostics.\n",
        "8. INSPECT OUTPUT: When visual verification matters, call mcp__catalex__render_page after a successful compile. ",
        "Request only the one to three pages needed for inspection.\n",
        concat!("9. REVIEW COMMENTS: When asked to leave document comments, use the ", env!("APP_BRAND_NAME"), " MCP create_comment tool with a relative file path and an exact passage. For standalone PDFs, first use read_pdf and include its page and fingerprint in create_comment.pdf; never invent page coordinates. "),
        concat!("Use list_comments to read comments and their revisions. Comment changes apply directly; follow the per-turn comment guidance. Comments save immediately after source paragraph validation. Never edit comments.json or comments-agents.json directly. Use the ", env!("APP_BRAND_NAME"), " MCP ask_user tool for user choices instead of native request_user_input. "),
        "Use $review-document for document reviews and critiques; follow chat-only requests and do not rewrite sources during review-only work."
    )
}

fn is_image_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
            )
        })
        .unwrap_or(false)
}

fn file_url_for_path(path: &std::path::Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    format!("file://{}", path.replace(' ', "%20"))
}

fn collect_generated_images_since(started_at: SystemTime) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let root = home.join(".codex").join("generated_images");
    let Ok(run_dirs) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut images = Vec::new();
    for run_dir in run_dirs.filter_map(Result::ok) {
        let run_path = run_dir.path();
        if !run_path.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(run_path) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let image_path = entry.path();
            if !is_image_path(&image_path) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(modified_at) = metadata.modified() else {
                continue;
            };
            if modified_at >= started_at {
                images.push(image_path);
            }
        }
    }

    images.sort_by(|a, b| {
        let a_modified = a
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let b_modified = b
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        a_modified.cmp(&b_modified)
    });
    images
}

fn generated_images_message(paths: &[PathBuf]) -> Option<String> {
    if paths.is_empty() {
        return None;
    }
    let mut lines = vec!["Generated Image:".to_string(), "Saved to:".to_string()];
    lines.extend(paths.iter().map(|path| file_url_for_path(path)));
    Some(lines.join("\n"))
}

async fn write_app_server_message(stdin: &mut ChildStdin, message: Value) -> Result<(), String> {
    let line = serde_json::to_string(&message)
        .map_err(|e| format!("Failed to serialize Codex app-server message: {e}"))?;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write Codex app-server message: {e}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("Failed to write Codex app-server newline: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush Codex app-server stdin: {e}"))?;
    Ok(())
}

async fn send_app_server_error_response(
    handle: &CodexAppServerHandle,
    request_id: Value,
    message: String,
) -> Result<(), String> {
    let mut stdin = handle.stdin.lock().await;
    write_app_server_message(
        stdin.as_mut().ok_or("Codex app-server is closed")?,
        json!({
            "id": request_id,
            "error": { "message": message }
        }),
    )
    .await
}

async fn send_app_server_result_response(
    handle: &CodexAppServerHandle,
    request_id: Value,
    result: Value,
) -> Result<(), String> {
    let mut stdin = handle.stdin.lock().await;
    write_app_server_message(
        stdin.as_mut().ok_or("Codex app-server is closed")?,
        json!({
            "id": request_id,
            "result": result
        }),
    )
    .await
}

async fn app_server_request(
    handle: &CodexAppServerHandle,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let request_id = handle.next_request_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    {
        let mut waiters = handle.response_waiters.lock().await;
        waiters.insert(request_id, sender);
    }

    let write_result = {
        let mut stdin = handle.stdin.lock().await;
        match stdin.as_mut() {
            None => Err("Codex app-server is closed".to_string()),
            Some(stdin) => write_app_server_message(
                stdin,
                json!({
                    "id": request_id,
                    "method": method,
                    "params": params
                }),
            )
            .await,
        }
    };

    if let Err(error) = write_result {
        let mut waiters = handle.response_waiters.lock().await;
        waiters.remove(&request_id);
        return Err(error);
    }

    let message = match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(message)) => message,
        Ok(Err(_)) => return Err(format!("Codex app-server request `{method}` was cancelled.")),
        Err(_) => {
            let mut waiters = handle.response_waiters.lock().await;
            waiters.remove(&request_id);
            return Err(format!("Codex app-server request `{method}` timed out."));
        }
    };

    if let Some(error) = message.get("error") {
        return Err(format!("Codex app-server `{method}` failed: {error}"));
    }

    message
        .get("result")
        .cloned()
        .ok_or_else(|| format!("Codex app-server `{method}` response did not include a result."))
}

async fn kill_app_server_handle(handle: Arc<CodexAppServerHandle>) -> Result<(), String> {
    if let Some(mcp) = handle.mcp.lock().await.take() {
        mcp.cancel_turn();
    }
    let mut child_slot = handle.child.lock().await;
    // Closing the pipe reaches both native installs and CLI launcher children.
    // SIGKILL alone only kills the launcher, leaving its child holding the thread writer.
    drop(handle.stdin.lock().await.take());
    handle.response_waiters.lock().await.clear();
    if let Some(mut child) = child_slot.take() {
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(_)) => {}
            result => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(format!("Codex app-server did not shut down cleanly; refusing to resume its thread: {result:?}"));
            }
        }
    }
    Ok(())
}

fn remove_app_server_handle_if_current<T>(
    app_servers: &mut HashMap<String, Arc<T>>,
    process_key: &str,
    handle: &Arc<T>,
) -> Option<Arc<T>> {
    if app_servers
        .get(process_key)
        .map(|current| Arc::ptr_eq(current, handle))
        .unwrap_or(false)
    {
        app_servers.remove(process_key)
    } else {
        None
    }
}

fn codex_skills_extra_roots_params(skills_root: &Path) -> Value {
    json!({ "extraRoots": [skills_root.to_string_lossy()] })
}

fn codex_skills_list_params(project_path: &str) -> Value {
    json!({
        "cwds": [project_path],
        "forceReload": true
    })
}

fn skills_list_contains_builtin_skill(result: &Value, name: &str, root: &Path) -> bool {
    result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("skills").and_then(Value::as_array))
        .flatten()
        .any(|skill| {
            skill.get("name").and_then(Value::as_str) == Some(name)
                && skill
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && skill
                    .get("path")
                    .and_then(Value::as_str)
                    .map(Path::new)
                    .map(|path| path == root.join(name).join("SKILL.md"))
                    .unwrap_or(false)
        })
}

async fn ensure_codex_app_server(
    window: &WindowContext,
    runtime_root: &str,
    tab_id: &str,
) -> Result<Arc<CodexAppServerHandle>, String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);
    let codex_state = &window.service.codex;

    if let Some(handle) = codex_state
        .app_servers
        .lock()
        .await
        .get(&process_key)
        .cloned()
    {
        return Ok(handle);
    }

    let catalex_skills_root = crate::builtin_skills::resolve_root(window)?.join("skills");
    let codex_path = find_codex_binary()?;
    let args = vec![
        "app-server".to_string(),
        "--listen".to_string(),
        "stdio://".to_string(),
    ];
    let mut cmd = create_command_with_piped_stdin(&codex_path, &args, Some(runtime_root));
    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn Codex app-server process: {e}. Is Codex CLI installed?")
    })?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;

    let handle = Arc::new(CodexAppServerHandle::new(
        stdin,
        child,
        catalex_skills_root.clone(),
    ));

    {
        let mut app_servers = codex_state.app_servers.lock().await;
        if let Some(existing) = app_servers.insert(process_key.clone(), handle.clone()) {
            tokio::spawn(kill_app_server_handle(existing));
        }
    }

    spawn_app_server_stdout_task(
        window.clone(),
        tab_id.to_string(),
        process_key.clone(),
        handle.clone(),
        codex_state.app_servers.clone(),
        stdout,
    );
    spawn_app_server_stderr_task(window.clone(), tab_id.to_string(), stderr);

    let setup_result = async {
        app_server_request(
            &handle,
            "initialize",
            json!({
                "clientInfo": {
                    "name": crate::branding::NAMESPACE,
                    "title": crate::branding::PRODUCT_NAME,
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }),
            Duration::from_secs(30),
        )
        .await?;
        app_server_request(
            &handle,
            "skills/extraRoots/set",
            codex_skills_extra_roots_params(&catalex_skills_root),
            Duration::from_secs(30),
        )
        .await?;
        let skills = app_server_request(
            &handle,
            "skills/list",
            codex_skills_list_params(runtime_root),
            Duration::from_secs(30),
        )
        .await?;
        for name in crate::builtin_skills::NAMES {
            if !skills_list_contains_builtin_skill(&skills, name, &catalex_skills_root) {
                return Err(format!(
                    "Codex did not discover {PRODUCT_NAME}'s built-in `{name}` skill."
                ));
            }
        }
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = setup_result {
        {
            let mut app_servers = codex_state.app_servers.lock().await;
            remove_app_server_handle_if_current(&mut app_servers, &process_key, &handle);
        }
        let _ = kill_app_server_handle(handle.clone()).await;
        return Err(error);
    }

    Ok(handle)
}

fn spawn_app_server_stdout_task(
    window: WindowContext,
    tab_id: String,
    process_key: String,
    handle: Arc<CodexAppServerHandle>,
    app_servers: Arc<Mutex<HashMap<String, Arc<CodexAppServerHandle>>>>,
    stdout: tokio::process::ChildStdout,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                let _ = window.emit(
                    "codex-output",
                    CodexOutputEvent {
                        tab_id: tab_id.clone(),
                        data: line,
                    },
                );
                continue;
            };

            if let Some(request_id) = message.get("id").and_then(Value::as_i64) {
                let sender = {
                    let mut waiters = handle.response_waiters.lock().await;
                    waiters.remove(&request_id)
                };
                if let Some(sender) = sender {
                    let _ = sender.send(message.clone());
                    continue;
                }
            }

            if message.get("method").is_some() {
                let _ = handle.notifications.send(message);
            }
        }

        {
            let mut app_servers = app_servers.lock().await;
            remove_app_server_handle_if_current(&mut app_servers, &process_key, &handle);
        }
        let _ = kill_app_server_handle(handle.clone()).await;
        // The listener owns a sender too, so dropping stdout alone never closes
        // its broadcast receiver. Explicitly terminate the pending turn.
        let _ = handle.notifications.send(json!({ "method": "catalex/transportClosed" }));
    });
}

fn spawn_app_server_stderr_task(
    window: WindowContext,
    tab_id: String,
    stderr: tokio::process::ChildStderr,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = window.emit(
                "codex-error",
                CodexErrorEvent {
                    tab_id: tab_id.clone(),
                    data: line,
                },
            );
        }
    });
}

fn codex_thread_id_from_result(result: &Value) -> Option<String> {
    result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn emit_codex_thread_started(window: &WindowContext, tab_id: &str, thread_id: &str) {
    let _ = window.emit(
        "codex-output",
        CodexOutputEvent {
            tab_id: tab_id.to_string(),
            data: json!({
                "type": "thread.started",
                "thread_id": thread_id,
                "session_id": thread_id
            })
            .to_string(),
        },
    );
}

fn emit_codex_activity(
    window: &WindowContext,
    tab_id: &str,
    kind: &str,
    item_id: &str,
    text: Option<String>,
    name: Option<String>,
    input: Option<Value>,
    content: Option<Value>,
    is_error: Option<bool>,
) {
    let _ = window.emit(
        "codex-activity",
        CodexActivityEvent {
            tab_id: tab_id.to_string(),
            kind: kind.to_string(),
            item_id: item_id.to_string(),
            text,
            name,
            input,
            content,
            is_error,
        },
    );
}

fn codex_tool_details(item: &Value) -> Option<(String, Value)> {
    let item_type = item.get("type")?.as_str()?;
    match item_type {
        "commandExecution" => {
            let command = item
                .get("commandActions")
                .and_then(Value::as_array)
                .and_then(|actions| actions.first())
                .and_then(|action| action.get("command"))
                .and_then(Value::as_str)
                .or_else(|| item.get("command").and_then(Value::as_str))
                .unwrap_or_default();
            Some(("Bash".to_string(), json!({ "command": command })))
        }
        "fileChange" => {
            let changes = item
                .get("changes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let file_path = changes
                .first()
                .and_then(|change| change.get("path"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some((
                "Edit".to_string(),
                json!({ "file_path": file_path, "changes": changes }),
            ))
        }
        "imageView" => Some((
            "Read".to_string(),
            json!({
                "file_path": item.get("path").and_then(Value::as_str).unwrap_or_default()
            }),
        )),
        "webSearch" => Some((
            "WebSearch".to_string(),
            json!({
                "query": item.get("query").cloned().unwrap_or(Value::Null),
                "queries": item.get("queries").cloned().unwrap_or(Value::Null),
                "url": item.get("url").cloned().unwrap_or(Value::Null),
                "pattern": item.get("pattern").cloned().unwrap_or(Value::Null),
                "action": item.get("action").cloned().unwrap_or(Value::Null)
            }),
        )),
        "collabAgentToolCall" => {
            let raw_name = item
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("agent_tool");
            let name = match raw_name {
                "spawnAgent" => "spawn_agent",
                "sendInput" => "send_input",
                "resumeAgent" => "resume_agent",
                "closeAgent" => "close_agent",
                other => other,
            };
            Some((
                name.to_string(),
                item.get("arguments").cloned().unwrap_or_else(|| json!({})),
            ))
        }
        "mcpToolCall" => {
            let server = item
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or("server");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            Some((
                format!("mcp__{server}__{tool}"),
                item.get("arguments").cloned().unwrap_or_else(|| json!({})),
            ))
        }
        "dynamicToolCall" => Some((
            item.get("tool")
                .and_then(Value::as_str)
                .unwrap_or("dynamic_tool")
                .to_string(),
            item.get("arguments").cloned().unwrap_or_else(|| json!({})),
        )),
        _ => None,
    }
}

fn codex_tool_result(item: &Value) -> (Value, bool) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut is_error = matches!(status, "failed" | "error" | "declined");
    let content = match item_type {
        "commandExecution" => {
            if let Some(exit_code) = item.get("exitCode").and_then(Value::as_i64) {
                is_error |= exit_code != 0;
            }
            Value::String(
                item.get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .unwrap_or("Command completed")
                    .to_string(),
            )
        }
        "fileChange" => {
            let paths = item
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|change| change.get("path").and_then(Value::as_str))
                .collect::<Vec<_>>();
            Value::String(if paths.is_empty() {
                "File change completed".to_string()
            } else {
                paths.join(", ")
            })
        }
        "imageView" => Value::String(
            item.get("path")
                .and_then(Value::as_str)
                .unwrap_or("Image viewed")
                .to_string(),
        ),
        "webSearch" => Value::String("Search complete".to_string()),
        "mcpToolCall" => {
            is_error |= item.pointer("/result/isError").and_then(Value::as_bool) == Some(true);
            if let Some(error) = item.pointer("/error/message").and_then(Value::as_str)
                .or_else(|| item.get("error").and_then(Value::as_str))
            {
                is_error = true;
                Value::String(error.to_string())
            } else {
                let text = item
                    .pointer("/result/content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                Value::String(if text.is_empty() {
                    "Completed".to_string()
                } else {
                    text
                })
            }
        }
        "dynamicToolCall" => {
            is_error |= item.get("success").and_then(Value::as_bool) == Some(false);
            let content_items = item
                .get("contentItems")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let text = content_items
                .iter()
                .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            Value::String(if text.is_empty() {
                let image_count = content_items
                    .iter()
                    .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("inputImage"))
                    .count();
                if image_count > 0 {
                    format!("Returned {image_count} image(s)")
                } else {
                    "Completed".to_string()
                }
            } else {
                text
            })
        }
        "collabAgentToolCall" => item
            .get("result")
            .cloned()
            .unwrap_or_else(|| Value::String("Completed".to_string())),
        _ => Value::String("Completed".to_string()),
    };
    (content, is_error)
}

fn emit_codex_tool_activity(window: &WindowContext, tab_id: &str, item: &Value, completed: bool) {
    let Some(item_id) = item.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some((name, input)) = codex_tool_details(item) else {
        return;
    };
    emit_codex_activity(
        window,
        tab_id,
        "tool_started",
        item_id,
        None,
        Some(name),
        Some(input),
        None,
        None,
    );
    if completed {
        let (content, is_error) = codex_tool_result(item);
        emit_codex_activity(
            window,
            tab_id,
            "tool_completed",
            item_id,
            None,
            None,
            None,
            Some(content),
            Some(is_error),
        );
    }
}

fn codex_workspace_write_sandbox_policy(project_path: &str) -> Value {
    json!({
        "type": "workspaceWrite",
        "writableRoots": [project_path],
        "readOnlyAccess": { "type": "fullAccess" },
        "networkAccess": true,
        "excludeTmpdirEnvVar": false,
        "excludeSlashTmp": false
    })
}

fn retired_dynamic_tool_response() -> Value {
    json!({
        "success": false,
        "contentItems": [{
            "type": "inputText",
            "text": concat!("This tool is no longer available. Use the ", env!("APP_BRAND_NAME"), " MCP tools.")
        }]
    })
}

pub(crate) fn codex_mcp_config(settings: &crate::workspace_mcp::ConnectionSettings) -> Value {
    json!({
        "catalex": {
            "url": settings.url,
            "http_headers": settings.headers,
            "tool_timeout_sec": 660,
            "required": true,
            // Only the app's existing draft-scoped operations are pre-authorized.
            // Do not change the global approval policy or trust future tools implicitly.
            "tools": {
                "compile": { "approval_mode": "approve" },
                "diagnostics": { "approval_mode": "approve" },
                "render_page": { "approval_mode": "approve" },
                "read_pdf": { "approval_mode": "approve" },
                "workspace_state": { "approval_mode": "approve" },
                "create_comment": { "approval_mode": "approve" },
                "list_comments": { "approval_mode": "approve" },
                "edit_comment": { "approval_mode": "approve" },
                "resolve_comment": { "approval_mode": "approve" },
                "delete_comment": { "approval_mode": "approve" },
                "ask_user": { "approval_mode": "approve" }
            }
        }
    })
}

fn codex_thread_start_params(
    project_path: &str,
    model: &str,
    reasoning_effort: &str,
    sandbox: &str,
) -> Value {
    json!({
        "model": model,
        "modelProvider": null,
        "serviceTier": null,
        "cwd": project_path,
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "sandbox": sandbox,
        "config": { "model_reasoning_effort": reasoning_effort },
        "serviceName": null,
        "baseInstructions": null,
        "developerInstructions": codex_system_prompt(),
        "personality": null,
        "ephemeral": false,
        "sessionStartSource": null,
        "experimentalRawEvents": false,
        "persistExtendedHistory": false
    })
}

fn codex_thread_resume_params(
    thread_id: &str,
    project_path: &str,
    model: &str,
    reasoning_effort: &str,
    sandbox: &str,
) -> Value {
    json!({
        "threadId": thread_id,
        "history": null,
        "path": null,
        "model": model,
        "modelProvider": null,
        "serviceTier": null,
        "cwd": project_path,
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "sandbox": sandbox,
        "config": { "model_reasoning_effort": reasoning_effort },
        "baseInstructions": null,
        "developerInstructions": codex_system_prompt(),
        "personality": null,
        "excludeTurns": true,
        "persistExtendedHistory": false
    })
}

fn prompt_invokes_skill(prompt: &str, name: &str) -> bool {
    prompt
        .match_indices(&format!("${name}"))
        .any(|(start, marker)| {
            let before_is_boundary = prompt[..start]
                .chars()
                .next_back()
                .map(|ch| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-')
                .unwrap_or(true);
            let after_index = start + marker.len();
            let after_is_boundary = prompt[after_index..]
                .chars()
                .next()
                .map(|ch| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-')
                .unwrap_or(true);
            before_is_boundary && after_is_boundary
        })
}

fn codex_turn_input(prompt: &str, skills_root: Option<&Path>) -> Vec<Value> {
    let text = if let Some(root) = skills_root {
        let paths = crate::builtin_skills::NAMES
            .iter()
            .map(|name| format!("- {name}: {}", root.join(name).join("SKILL.md").display()))
            .collect::<Vec<_>>()
            .join("\n");
        format!("[{PRODUCT_NAME} built-in skill locations]\nUse these exact absolute paths when reading these skills. Skill-root aliases such as r8 are lookup keys, not directories under ~/.codex/skills.\n{paths}\n\n{prompt}")
    } else {
        prompt.to_string()
    };
    let mut input = vec![json!({
        "type": "text",
        "text": text,
        "text_elements": []
    })];
    if let Some(root) = skills_root {
        for name in crate::builtin_skills::NAMES {
            if prompt_invokes_skill(prompt, name) {
                input.push(json!({
                    "type": "skill",
                    "name": name,
                    "path": root.join(name).join("SKILL.md").to_string_lossy()
                }));
            }
        }
    }
    input
}

fn codex_turn_start_params(
    thread_id: &str,
    project_path: &str,
    prompt: &str,
    model: &str,
    reasoning_effort: &str,
    fast_mode: bool,
    skills_root: Option<&Path>,
) -> Value {
    json!({
        "threadId": thread_id,
        "input": codex_turn_input(prompt, skills_root),
        "serviceTierForTurn": if fast_mode { "fast" } else { "default" },
        "cwd": project_path,
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "sandboxPolicy": codex_workspace_write_sandbox_policy(project_path),
        "model": model,
        "serviceTier": null,
        "effort": reasoning_effort,
        "summary": "none",
        "personality": null,
        "outputSchema": null,
        "collaborationMode": null
    })
}

fn turn_id_from_result(result: &Value) -> Option<String> {
    result
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn ensure_codex_thread(
    handle: &CodexAppServerHandle,
    project_path: &str,
    session_id: Option<String>,
    model: &str,
    reasoning_effort: &str,
) -> Result<String, String> {
    let requested_thread_id = session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let current_thread_id = handle.thread_id.lock().await.clone();

    if let Some(current_thread_id) = current_thread_id {
        if requested_thread_id
            .as_deref()
            .map(|requested| requested == current_thread_id)
            .unwrap_or(true)
        {
            return Ok(current_thread_id);
        }
        return Err("A different Codex conversation is already loaded; start a new runtime".into());
    }

    let settings = handle.mcp.lock().await.as_ref()
        .ok_or(concat!(env!("APP_BRAND_NAME"), " MCP connection is unavailable"))?
        .settings.clone();
    let configure = |mut params: Value| {
        params["config"]["mcp_servers"] = codex_mcp_config(&settings);
        params
    };
    let result = if let Some(thread_id) = requested_thread_id {
        app_server_request(
            handle,
            "thread/resume",
            configure(codex_thread_resume_params(
                &thread_id,
                project_path,
                model,
                reasoning_effort,
                "workspace-write",
            )),
            Duration::from_secs(30),
        )
        .await?
    } else {
        app_server_request(
            handle,
            "thread/start",
            configure(codex_thread_start_params(
                project_path, model, reasoning_effort, "workspace-write",
            )),
            Duration::from_secs(30),
        )
        .await?
    };

    let thread_id = codex_thread_id_from_result(&result)
        .ok_or_else(|| "Codex app-server did not return a thread id.".to_string())?;
    {
        let mut current_thread_id = handle.thread_id.lock().await;
        *current_thread_id = Some(thread_id.clone());
    }
    Ok(thread_id)
}

async fn prepare_codex_turn(
    handle: &CodexAppServerHandle,
    project_path: &str,
    session_id: Option<String>,
    model: &str,
    reasoning_effort: &str,
    compile_context: Option<VerificationContext>,
) -> Result<(String, crate::workspace_mcp::TurnAccess), String> {
    if handle.active_turn_id.lock().await.is_some() {
        return Err("A Codex turn is already running".into());
    }
    // Reserve admission before RPC awaits; failure drops the guard and revokes it.
    let access = handle.mcp.lock().await.as_ref()
        .ok_or(concat!(env!("APP_BRAND_NAME"), " MCP connection is unavailable"))?
        .begin_turn_with_model(project_path.to_string(), compile_context, Some(model.to_string()), Some(reasoning_effort.to_string()))?;
    let id = ensure_codex_thread(handle, project_path, session_id, model, reasoning_effort).await?;
    Ok((id, access))
}

async fn start_loaded_codex_turn(
    handle: &CodexAppServerHandle,
    thread_id: &str,
    project_path: &str,
    prompt: &str,
    model: &str,
    reasoning_effort: &str,
    fast_mode: bool,
) -> Result<String, String> {
    let result = app_server_request(
        handle, "turn/start",
        codex_turn_start_params(
            thread_id, project_path, prompt, model, reasoning_effort,
            fast_mode,
            Some(handle.catalex_skills_root.as_path()),
        ),
        Duration::from_secs(30),
    ).await?;
    let id = turn_id_from_result(&result).ok_or("Codex app-server did not return a turn id.")?;
    *handle.active_turn_id.lock().await = Some(id.clone());
    Ok(id)
}

async fn finish_codex_turn(
    handle: &CodexAppServerHandle,
    turn_id: &str,
    access: crate::workspace_mcp::TurnAccess,
) -> bool {
    drop(access);
    let mut active = handle.active_turn_id.lock().await;
    claim_turn_completion(&mut active, turn_id)
}

fn claim_turn_completion(active: &mut Option<String>, turn_id: &str) -> bool {
    if active.as_deref() != Some(turn_id) { return false; }
    *active = None;
    true
}

async fn wait_for_turn_end(active: &Mutex<Option<String>>, turn_id: &str, timeout: Duration) -> bool {
    tokio::time::timeout(timeout, async {
        while active.lock().await.as_deref() == Some(turn_id) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.is_ok()
}

async fn start_codex_app_server_turn(
    window: WindowContext,
    project_path: String,
    source_project_path: String,
    runtime_session_key: String,
    session_id: Option<String>,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    compile_context: Option<VerificationContext>,
    compact: bool,
) -> Result<(), String> {
    let admission = window.service.codex.admission.clone();
    let _admission = admission.lock().await;
    // The OS working directory must outlive settled-draft cleanup. Codex can
    // consult getcwd even when turn/start supplies a different absolute cwd.
    let mut handle = ensure_codex_app_server(&window, &source_project_path, &tab_id).await?;
    if handle.active_turn_id.lock().await.is_some() {
        return Err("A Codex turn is already running".into());
    }
    let runtime_scope = (source_project_path.clone(), runtime_session_key.clone());
    let new_runtime = handle.runtime_scope.lock().await.as_ref()
        .is_some_and(|current| current != &runtime_scope);
    if new_runtime {
        // A different source project/chat gets a fresh credential and process;
        // ordinary draft changes are supplied to the existing MCP on each turn.
        let key = format!("{}:{}", window.label(), tab_id);
        remove_app_server_handle_if_current(
            &mut *window.service.codex.app_servers.lock().await,
            &key,
            &handle,
        );
        kill_app_server_handle(handle).await?;
        handle = ensure_codex_app_server(&window, &source_project_path, &tab_id).await?;
    }
    *handle.runtime_scope.lock().await = Some(runtime_scope);
    {
        let mut slot = handle.mcp.lock().await;
        if slot.is_none() {
            *slot = Some(crate::workspace_mcp::WorkspaceMcp::start(
                window.clone(), tab_id.clone(),
                source_project_path.clone(),
                crate::comments::AgentOrigin { provider: "codex".into(), session_id: runtime_session_key.clone(), model: None, thinking_effort: None },
            ).await?);
        }
    }
    let model = model.unwrap_or_else(|| "gpt-5.4".to_string());
    let reasoning_effort = reasoning_effort.unwrap_or_else(|| "medium".to_string());
    let notifications = handle.notifications.subscribe();
    let is_resume = session_id.is_some();
    let (thread_id, mcp_turn) = prepare_codex_turn(
        &handle,
        &project_path,
        session_id,
        &model,
        &reasoning_effort,
        compile_context,
    )
    .await.map_err(|error| if is_resume { format!("Could not resume Codex session: {error}") } else { error })?;
    emit_codex_thread_started(&window, &tab_id, &thread_id);

    let started_at = SystemTime::now()
        .checked_sub(Duration::from_secs(2))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let prompt = format!("{}\n\n{}", crate::workspace_mcp::comment_guidance(), prompt);
    let started = if compact {
        start_codex_compaction(&handle, &thread_id).await
    } else { start_loaded_codex_turn(
        &handle,
        &thread_id, &project_path, &prompt, &model, &reasoning_effort,
        fast_mode.unwrap_or(false),
    ).await };
    let turn_id = match started {
        Ok(id) => id,
        Err(error) => {
            drop(mcp_turn);
            // A timeout may have started a native turn. Do not reuse an uncertain runtime.
            let key = format!("{}:{}", window.label(), tab_id);
            remove_app_server_handle_if_current(
                &mut *window.service.codex.app_servers.lock().await,
                &key, &handle,
            );
            let _ = kill_app_server_handle(handle).await;
            return Err(error);
        }
    };

    spawn_codex_turn_listener(
        window,
        handle,
        notifications,
        started_at,
        tab_id,
        thread_id,
        turn_id,
        mcp_turn,
    );

    Ok(())
}

fn codex_error_message(value: &Value) -> Option<String> {
    let error = value.get("error").filter(|error| !error.is_null()).unwrap_or(value);
    let message = error.get("message").and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())?;
    Some(match error.get("additionalDetails").and_then(Value::as_str)
        .filter(|detail| !detail.trim().is_empty()) {
        Some(detail) => format!("{message}\n{detail}"),
        None => message.to_string(),
    })
}

fn codex_provider_status(current: Option<&'static str>, method: &str, params: &Value) -> Option<&'static str> {
    let item = params.get("item").unwrap_or(&Value::Null);
    let item_type = item.get("type").and_then(Value::as_str);
    let response_started = matches!(item_type, Some("agentMessage" | "reasoning" | "fileChange" | "mcpToolCall" | "webSearch"))
        || (item_type == Some("commandExecution")
            && item.get("source").and_then(Value::as_str).unwrap_or("agent") == "agent");
    match method {
        "error" if params.get("willRetry").and_then(Value::as_bool) == Some(true) => Some("retrying"),
        "item/started" if item_type == Some("contextCompaction") => Some("compacting"),
        "item/completed" if item_type == Some("contextCompaction") && current == Some("compacting") => None,
        "thread/compacted" if current == Some("compacting") => None,
        "item/started" if response_started && current == Some("retrying") => None,
        "item/completed" if item_type == Some("agentMessage") && current == Some("retrying")
            && item.get("text").and_then(Value::as_str).is_some_and(|text| !text.is_empty()) => None,
        "item/agentMessage/delta" | "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta"
            if current == Some("retrying")
                && params.get("delta").and_then(Value::as_str).is_some_and(|delta| !delta.is_empty()) => None,
        "error" if current == Some("retrying")
            && params.get("willRetry").and_then(Value::as_bool) == Some(false) => None,
        "turn/completed" => None,
        _ => current,
    }
}

fn emit_codex_provider_status(window: &WindowContext, tab_id: &str, status: Option<&str>) {
    let _ = window.emit("codex-output", CodexOutputEvent {
        tab_id: tab_id.to_string(),
        data: json!({ "type": "provider_status", "status": status }).to_string(),
    });
}

fn spawn_codex_turn_listener(
    window: WindowContext,
    handle: Arc<CodexAppServerHandle>,
    mut notifications: broadcast::Receiver<Value>,
    started_at: SystemTime,
    tab_id: String,
    thread_id: String,
    turn_id: String,
    mcp_turn: crate::workspace_mcp::TurnAccess,
) {
    tokio::spawn(async move {
        let mut success = false;
        let mut emitted_final_text = String::new();
        let mut failure = None;
        let mut provider_status = None;

        loop {
            let message = match notifications.recv().await {
                Ok(message) => message,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => {
                    failure = Some("Codex connection closed before the turn finished.".to_string());
                    break;
                }
            };

            let Some(method) = message.get("method").and_then(Value::as_str) else {
                continue;
            };
            if method == "catalex/transportClosed" {
                failure = Some("Codex connection closed before the turn finished.".to_string());
                break;
            }
            let params = message.get("params").unwrap_or(&Value::Null);
            let message_thread_id = params.get("threadId").and_then(Value::as_str);
            if message_thread_id.is_some() && message_thread_id != Some(thread_id.as_str()) {
                continue;
            }
            let message_turn_id = params
                .get("turnId")
                .and_then(Value::as_str)
                .or_else(|| {
                    params
                        .get("turn")
                        .and_then(|turn| turn.get("id"))
                        .and_then(Value::as_str)
                });
            if message_turn_id.is_some() && message_turn_id != Some(turn_id.as_str()) {
                continue;
            }

            if let Some(request_id) = message.get("id").cloned() {
                if method == "item/tool/call" {
                    if let Err(error) = send_app_server_result_response(
                        &handle,
                        request_id.clone(),
                        retired_dynamic_tool_response(),
                    )
                    .await
                    {
                        let _ = window.emit(
                            "codex-error",
                            CodexErrorEvent {
                                tab_id: tab_id.clone(),
                                data: format!("Failed to handle Codex dynamic tool call: {error}"),
                            },
                        );
                        let _ = send_app_server_error_response(
                            &handle,
                            request_id,
                            error,
                        )
                        .await;
                    }
                    continue;
                }
                match method {
                    "item/tool/requestUserInput"
                    | "item/commandExecution/requestApproval"
                    | "item/fileChange/requestApproval"
                    | "item/permissions/requestApproval"
                    | "mcpServer/elicitation/request"
                    | "account/chatgptAuthTokens/refresh"
                    | "applyPatchApproval"
                    | "execCommandApproval" => {
                        let _ = window.emit(
                            "codex-final",
                            CodexFinalEvent {
                                tab_id: tab_id.clone(),
                                data: format!(
                                    "Codex requested an unsupported interactive action: `{method}`.\n\n\
                                     {PRODUCT_NAME} stopped this turn instead of waiting indefinitely."
                                ),
                                item_id: None,
                            },
                        );
                        let _ = send_app_server_error_response(
                            &handle,
                            request_id,
                            format!("{PRODUCT_NAME} does not support Codex app-server request {method}"),
                        )
                        .await;
                        break;
                    }
                    _ => {}
                }
            }

            let next_status = codex_provider_status(provider_status, method, params);
            if method != "turn/completed" && next_status != provider_status {
                provider_status = next_status;
                emit_codex_provider_status(&window, &tab_id, provider_status);
            }

            match method {
                "thread/tokenUsage/updated" => {
                    let _ = window.emit("codex-output", CodexOutputEvent {
                        tab_id: tab_id.clone(),
                        data: message.to_string(),
                    });
                }
                "turn/started" => {
                    if let Some(started_turn_id) = message_turn_id {
                        let mut active_turn_id = handle.active_turn_id.lock().await;
                        *active_turn_id = Some(started_turn_id.to_string());
                    }
                }
                "item/agentMessage/delta" => {
                    let item_id = params
                        .get("itemId")
                        .and_then(Value::as_str)
                        .unwrap_or("codex-text");
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        emit_codex_activity(
                            &window,
                            &tab_id,
                            "text_delta",
                            item_id,
                            Some(delta.to_string()),
                            None,
                            None,
                            None,
                            None,
                        );
                    }
                }
                "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                    let item_id = params
                        .get("itemId")
                        .and_then(Value::as_str)
                        .unwrap_or("codex-reasoning");
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        emit_codex_activity(
                            &window,
                            &tab_id,
                            "thinking_delta",
                            item_id,
                            Some(delta.to_string()),
                            None,
                            None,
                            None,
                            None,
                        );
                    }
                }
                "item/started" => {
                    if let Some(item) = params.get("item") {
                        emit_codex_tool_activity(&window, &tab_id, item, false);
                    }
                }
                "item/fileChange/patchUpdated" => {
                    if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
                        emit_codex_tool_activity(
                            &window,
                            &tab_id,
                            &json!({
                                "type": "fileChange",
                                "id": item_id,
                                "changes": params.get("changes").cloned().unwrap_or_else(|| json!([]))
                            }),
                            false,
                        );
                    }
                }
                "item/completed" => {
                    let Some(item) = params.get("item") else {
                        continue;
                    };
                    emit_codex_tool_activity(&window, &tab_id, item, true);
                    let text = match item.get("type").and_then(Value::as_str) {
                        Some("agentMessage") => item.get("text").and_then(Value::as_str),
                        _ => None,
                    };
                    let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) else {
                        continue;
                    };
                    emitted_final_text.push_str(text);
                    emitted_final_text.push('\n');
                    let _ = window.emit(
                        "codex-final",
                        CodexFinalEvent {
                            tab_id: tab_id.clone(),
                            data: text.to_string(),
                            item_id: item.get("id").and_then(Value::as_str).map(str::to_string),
                        },
                    );
                }
                "turn/completed" => {
                    let turn = params.get("turn").unwrap_or(&Value::Null);
                    success = turn.get("status").and_then(Value::as_str) == Some("completed");
                    if turn.get("status").and_then(Value::as_str) == Some("failed") {
                        failure = codex_error_message(turn).or(failure)
                            .or_else(|| Some("Codex turn failed.".to_string()));
                    } else {
                        failure = None;
                    }
                    break;
                }
                "error" => {
                    let data = codex_error_message(params).unwrap_or_else(|| params.to_string());
                    if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                        eprintln!("[codex-agent] [{tab_id}] Retrying provider request: {data}");
                        continue;
                    }
                    if params.get("willRetry").and_then(Value::as_bool) == Some(false) {
                        failure = Some(data.clone());
                    }
                    let _ = window.emit(
                        "codex-error",
                        CodexErrorEvent {
                            tab_id: tab_id.clone(),
                            data,
                        },
                    );
                }
                _ => {}
            }
        }

        // Cancellation fallback may already own completion for this turn.
        if !finish_codex_turn(&handle, &turn_id, mcp_turn).await { return; }
        if provider_status.is_some() {
            emit_codex_provider_status(&window, &tab_id, None);
        }
        if let Some(message) = failure {
            eprintln!("[codex-agent] [{tab_id}] {message}");
            let _ = window.emit("codex-output", CodexOutputEvent {
                tab_id: tab_id.clone(),
                data: json!({ "type": "error", "message": message }).to_string(),
            });
        }
        let generated_images = collect_generated_images_since(started_at);
        if !generated_images.is_empty() {
            let has_generated_image_path = generated_images.iter().any(|path| {
                emitted_final_text.contains(&path.to_string_lossy().to_string())
                    || emitted_final_text.contains(&file_url_for_path(path))
            });
            if !has_generated_image_path {
                if let Some(message) = generated_images_message(&generated_images) {
                    let _ = window.emit(
                        "codex-final",
                        CodexFinalEvent {
                            tab_id: tab_id.clone(),
                            data: message,
                            item_id: None,
                        },
                    );
                }
            }
        }

        let _ = window.emit(
            "codex-complete",
            CodexCompleteEvent { tab_id, success },
        );
    });
}

pub async fn check_codex_status() -> Result<CodexStatus, String> {
    let binary_path = match find_codex_binary() {
        Ok(path) => path,
        Err(_) => {
            return Ok(CodexStatus {
                installed: false,
                authenticated: false,
                binary_path: None,
                version: None,
                account_label: None,
            })
        }
    };

    let version_output = new_sync_command(&binary_path).arg("--version").output();
    let version = match version_output {
        Ok(output) if output.status.success() => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            combined
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        }
        _ => None,
    };

    if version.is_none() {
        return Ok(CodexStatus {
            installed: false,
            authenticated: false,
            binary_path: None,
            version: None,
            account_label: None,
        });
    }

    let auth_output = new_sync_command(&binary_path)
        .args(["login", "status"])
        .output();

    let (authenticated, account_label) = match auth_output {
        Ok(output) if output.status.success() => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let logged_in = combined.to_ascii_lowercase().contains("logged in");
            let label = combined
                .lines()
                .find(|line| !line.trim().is_empty() && !line.contains("WARNING:"))
                .map(|line| line.trim().to_string());
            (logged_in, label)
        }
        _ => (false, None),
    };

    Ok(CodexStatus {
        installed: true,
        authenticated,
        binary_path: Some(binary_path),
        version,
        account_label,
    })
}

fn normalize_codex_model_info(value: &Value) -> Option<CodexModelInfo> {
    if value.get("hidden").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let model = value
        .get("model")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)?
        .trim();
    if model.is_empty() {
        return None;
    }

    let supported_reasoning_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|effort| {
            let value = effort
                .get("reasoningEffort")
                .or_else(|| effort.get("value"))
                .and_then(Value::as_str)?
                .trim();
            if value.is_empty() {
                return None;
            }
            Some(CodexModelReasoningEffort {
                value: value.to_string(),
                description: effort
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect::<Vec<_>>();
    let default_reasoning_effort = value
        .get("defaultReasoningEffort")
        .and_then(Value::as_str)
        .filter(|effort| !effort.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            supported_reasoning_efforts
                .first()
                .map(|effort| effort.value.clone())
        })?;

    Some(CodexModelInfo {
        model: model.to_string(),
        display_name: value
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(model)
            .to_string(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        supported_reasoning_efforts,
        default_reasoning_effort,
        is_default: value
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub async fn read_codex_subscription_usage(window: WindowContext) -> Result<Value, String> {
    let project_path = std::env::current_dir()
        .map_err(|error| format!("Could not resolve the current directory: {error}"))?;
    let project_path = project_path.to_string_lossy().to_string();
    let handle = ensure_codex_app_server(&window, &project_path, "__model-discovery").await?;
    app_server_request(&handle, "account/rateLimits/read", json!({}), Duration::from_secs(30)).await
}

pub async fn list_codex_models(window: WindowContext) -> Result<Vec<CodexModelInfo>, String> {
    let project_path = std::env::current_dir()
        .map_err(|error| format!("Could not resolve the current directory: {error}"))?;
    let project_path = project_path.to_string_lossy().to_string();
    let handle = ensure_codex_app_server(&window, &project_path, "__model-discovery").await?;

    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    loop {
        let mut params = json!({
            "includeHidden": false,
            "limit": 100
        });
        if let Some(cursor) = cursor.as_deref() {
            params["cursor"] = json!(cursor);
        }
        let result =
            app_server_request(&handle, "model/list", params, Duration::from_secs(30)).await?;
        if let Some(data) = result.get("data").and_then(Value::as_array) {
            models.extend(data.iter().filter_map(normalize_codex_model_info));
        }

        let next_cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|next| !next.trim().is_empty())
            .map(str::to_string);
        let Some(next_cursor) = next_cursor else {
            break;
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("Codex model/list returned a repeated cursor.".to_string());
        }
        cursor = Some(next_cursor);
    }

    Ok(models)
}

pub async fn verify_codex_model(model_id: String) -> Result<Value, String> {
    crate::model_verification::validate_model_id(&model_id)?;
    let binary = find_codex_binary()?;
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    // Use account authentication but no project instructions, hooks, MCP servers,
    // or user-configured execution permissions for this isolated availability probe.
    let args = vec![
        "exec", "--model", &model_id, "--json", "--ephemeral",
        "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "--sandbox", "read-only", "-c", "features.shell_tool=false",
        "-c", "web_search=\"disabled\"",
        "-c", "project_doc_max_bytes=0",
        "Reply with OK only. Do not use tools.",
    ].into_iter().map(str::to_string).collect::<Vec<_>>();
    let mut command = create_command(&binary, &args, Some(&directory.path().to_string_lossy()));
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(50), command.output()).await
        .map_err(|_| "Model verification timed out. Please retry.".to_string())?
        .map_err(|error| format!("Could not start Codex verification: {error}"))?;
    crate::model_verification::check_codex_probe(&output.stdout)?;
    if !output.status.success() {
        return Err("Codex could not verify this model. Check your sign-in and model ID.".to_string());
    }
    Ok(json!({ "id": model_id }))
}

pub async fn login_codex(window: WindowContext) -> Result<(), String> {
    let binary_path = find_codex_binary().map_err(|e| format!("Codex CLI not found: {e}"))?;
    let mut cmd = create_command(&binary_path, &["login".to_string()], None);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run codex login: {e}"))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit("codex-login-output", line);
        }
    });

    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit("codex-login-error", line);
        }
    });

    let win_complete = window;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let success = child.wait().await.map(|status| status.success()).unwrap_or(false);
        let _ = win_complete.emit("codex-login-complete", success);
    });

    Ok(())
}

pub async fn execute_codex_code(
    window: WindowContext,
    project_path: String,
    source_project_path: String,
    runtime_session_key: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    compile_context: Option<VerificationContext>,
) -> Result<(), String> {
    start_codex_app_server_turn(
        window,
        project_path,
        source_project_path,
        runtime_session_key,
        None,
        prompt,
        tab_id,
        model,
        reasoning_effort,
        fast_mode,
        compile_context,
        false,
    )
    .await
}

pub async fn resume_codex_code(
    window: WindowContext,
    project_path: String,
    source_project_path: String,
    runtime_session_key: String,
    session_id: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    compile_context: Option<VerificationContext>,
) -> Result<(), String> {
    start_codex_app_server_turn(
        window,
        project_path,
        source_project_path,
        runtime_session_key,
        Some(session_id),
        prompt,
        tab_id,
        model,
        reasoning_effort,
        fast_mode,
        compile_context,
        false,
    )
    .await
}

pub async fn compact_codex_session(
    window: WindowContext,
    project_path: String,
    source_project_path: String,
    runtime_session_key: String,
    session_id: String,
    tab_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    start_codex_app_server_turn(window, project_path, source_project_path,
        runtime_session_key, Some(session_id), String::new(), tab_id,
        model, reasoning_effort, None, None, true).await
}

async fn start_codex_compaction(handle: &CodexAppServerHandle, thread_id: &str) -> Result<String, String> {
    let mut notifications = handle.notifications.subscribe();
    app_server_request(handle, "thread/compact/start", json!({"threadId": thread_id}), Duration::from_secs(30)).await?;
    let turn_id = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let message = notifications.recv().await.map_err(|error| error.to_string())?;
            if message["method"] == "catalex/transportClosed" {
                return Err("Codex connection closed before compaction started.".to_string());
            }
            if message["method"] == "turn/started" && message["params"]["threadId"] == thread_id {
                return message["params"]["turn"]["id"].as_str().map(str::to_string)
                    .ok_or_else(|| "Codex compaction did not return a turn id.".to_string());
            }
        }
    }).await.map_err(|_| "Codex compaction did not start in time.".to_string())??;
    *handle.active_turn_id.lock().await = Some(turn_id.clone());
    Ok(turn_id)
}

// A capability is tied to an exact managed process, never inferred from an error or PID.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionOwner {
    owner_token: String,
}

async fn managed_session_owner(
    window: &WindowContext, tab_id: &str, session_id: &str,
) -> Result<Option<Arc<CodexAppServerHandle>>, String> {
    let state = &window.service.codex;
    let requester_key = format!("{}:{}", window.label(), tab_id);
    let handles = state.app_servers.lock().await.clone();
    let requester = handles.get(&requester_key).ok_or("The failed Codex runtime is no longer available. Send your message again.")?;
    let scope = requester.runtime_scope.lock().await.clone().ok_or("Codex runtime scope is unavailable")?;
    let mut owner = None;
    for (key, handle) in handles {
        if key == requester_key { continue; }
        if handle.thread_id.lock().await.as_deref() != Some(session_id) { continue; }
        if handle.runtime_scope.lock().await.as_ref().map(|s| &s.0) != Some(&scope.0) {
            return Err("The session belongs to a different project; takeover is unavailable.".into());
        }
        let mut child = handle.child.lock().await;
        if let Some(child) = child.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                if owner.is_some() { return Err("Multiple session owners found; takeover is unavailable.".into()); }
                owner = Some(handle.clone());
            }
        }
    }
    Ok(owner)
}

pub async fn check_codex_session_owner(window: WindowContext, tab_id: String, session_id: String) -> Result<Option<CodexSessionOwner>, String> {
    let admission = window.service.codex.admission.clone();
    let _admission = admission.lock().await;
    Ok(managed_session_owner(&window, &tab_id, &session_id).await?.map(|handle| CodexSessionOwner { owner_token: handle.owner_token.to_string() }))
}

pub async fn reconnect_codex_session(
    window: WindowContext, tab_id: String, session_id: String,
    owner_token: Option<String>, model: String, reasoning_effort: String,
) -> Result<(), String> {
    let admission = window.service.codex.admission.clone();
    let _admission = admission.lock().await;
    let owner = managed_session_owner(&window, &tab_id, &session_id).await?;
    match (owner, owner_token) {
        (Some(owner), Some(token)) if owner.owner_token.to_string() == token => {
            // EOF closes launcher and native writer; failure deliberately prevents reconnect.
            kill_app_server_handle(owner.clone()).await?;
            let _ = owner.notifications.send(json!({ "method": "catalex/transportClosed" }));
            window.service.codex.app_servers.lock().await.retain(|_, handle| !Arc::ptr_eq(handle, &owner));
        }
        (Some(_), _) => return Err("Session ownership changed or takeover was not confirmed. Refresh and try again.".into()),
        (None, Some(_)) => return Err("The confirmed session owner is no longer present. Refresh to reconnect.".into()),
        (None, None) => {}
    }
    let key = format!("{}:{}", window.label(), tab_id);
    let handle = window.service.codex.app_servers.lock().await.get(&key).cloned().ok_or("Codex runtime is no longer available")?;
    if handle.active_turn_id.lock().await.is_some() { return Err("This agent is already working".into()); }
    let scope = handle.runtime_scope.lock().await.clone().ok_or("Codex runtime scope is unavailable")?;
    ensure_codex_thread(&handle, &scope.0, Some(session_id), &model, &reasoning_effort).await?;
    Ok(())
}

pub async fn dispose_codex_session(window: WindowContext, tab_id: String) -> Result<(), String> {
    let key = format!("{}:{}", window.label(), tab_id);
    let handle = window.service.codex.app_servers.lock().await.remove(&key);
    if let Some(handle) = handle {
        kill_app_server_handle(handle).await?;
    }
    Ok(())
}

pub async fn cancel_codex_execution(window: WindowContext, tab_id: String) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);
    let codex_state = &window.service.codex;

    let handle = codex_state.app_servers.lock().await.get(&process_key).cloned();
    let Some(handle) = handle else {
        return Ok(());
    };

    let thread_id = handle.thread_id.lock().await.clone();
    let turn_id = handle.active_turn_id.lock().await.clone();
    if let Some(mcp) = handle.mcp.lock().await.as_ref() {
        mcp.cancel_turn();
    }
    if let (Some(thread_id), Some(turn_id)) = (thread_id.as_ref(), turn_id.as_ref()) {
        let interrupt_result = app_server_request(
            &handle,
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id
            }),
            Duration::from_secs(5),
        )
        .await;
        if interrupt_result.is_ok()
            && wait_for_turn_end(&handle.active_turn_id, turn_id, Duration::from_secs(10)).await {
            return Ok(());
        }
    }

    // Claim the old turn before shutting down, so its listener cannot emit a
    // second completion after the user has already resumed.
    if let Some(turn_id) = turn_id.as_deref() {
        if !claim_turn_completion(&mut *handle.active_turn_id.lock().await, turn_id) {
            return Ok(());
        }
    }
    {
        let mut app_servers = codex_state.app_servers.lock().await;
        remove_app_server_handle_if_current(&mut app_servers, &process_key, &handle);
    }
    let shutdown_result = kill_app_server_handle(handle.clone()).await;
    let _ = handle.notifications.send(json!({ "method": "catalex/transportClosed" }));
    let _ = window.emit(
        "codex-complete",
        CodexCompleteEvent {
            tab_id,
            success: false,
        },
    );
    shutdown_result
}

pub async fn kill_process_for_window(state: &CodexProcessState, window_label: &str) {
    let prefix = format!("{}:", window_label);
    let handles = {
        let mut app_servers = state.app_servers.lock().await;
        let keys_to_remove: Vec<String> = app_servers
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        keys_to_remove
            .into_iter()
            .filter_map(|key| app_servers.remove(&key))
            .collect::<Vec<_>>()
    };
    let mut cleanup = tokio::task::JoinSet::new();
    for handle in handles {
        cleanup.spawn(kill_app_server_handle(handle));
    }
    while cleanup.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_status_follows_explicit_compaction_and_retry_events() {
        let compact = json!({"item":{"type":"contextCompaction","id":"compact"}});
        assert_eq!(codex_provider_status(None, "item/started", &compact), Some("compacting"));
        assert_eq!(codex_provider_status(Some("compacting"), "item/completed", &compact), None);
        assert_eq!(codex_provider_status(Some("compacting"), "thread/compacted", &Value::Null), None);
        assert_eq!(codex_provider_status(Some("compacting"), "error", &json!({"willRetry":true})), Some("retrying"));
        assert_eq!(codex_provider_status(Some("retrying"), "item/completed", &compact), Some("retrying"));
        assert_eq!(codex_provider_status(Some("retrying"), "thread/tokenUsage/updated", &Value::Null), Some("retrying"));
        assert_eq!(codex_provider_status(Some("retrying"), "item/completed", &json!({"item":{"type":"commandExecution"}})), Some("retrying"));
        assert_eq!(codex_provider_status(Some("retrying"), "item/reasoning/textDelta", &json!({"delta":""})), Some("retrying"));
        assert_eq!(codex_provider_status(Some("retrying"), "item/reasoning/textDelta", &json!({"delta":"Recovered"})), None);
        assert_eq!(codex_provider_status(Some("retrying"), "error", &json!({"willRetry":false})), None);
        assert_eq!(codex_provider_status(Some("compacting"), "turn/completed", &Value::Null), None);
    }

    #[test]
    fn provider_status_recovers_on_model_origin_item_starts() {
        for item_type in ["agentMessage", "reasoning", "commandExecution", "fileChange", "mcpToolCall", "webSearch"] {
            assert_eq!(codex_provider_status(Some("retrying"), "item/started", &json!({"item":{"type":item_type}})), None);
        }
        for item in [
            json!({"type":"userMessage"}),
            json!({"type":"functionCallOutput"}),
            json!({"type":"subAgentActivity"}),
            json!({"type":"commandExecution","source":"userShell"}),
            json!({"type":"commandExecution","source":"unifiedExecInteraction"}),
            json!({"type":"futureItem"}),
        ] {
            assert_eq!(codex_provider_status(Some("retrying"), "item/started", &json!({"item":item})), Some("retrying"));
        }
    }

    #[test]
    fn provider_errors_preserve_nested_messages_and_details() {
        assert_eq!(
            codex_error_message(&json!({"error": {
                "message": "Connection failed", "additionalDetails": "Retry limit reached"
            }})),
            Some("Connection failed\nRetry limit reached".into()),
        );
        assert_eq!(codex_error_message(&json!({"message":"Legacy error"})), Some("Legacy error".into()));
        assert_eq!(codex_error_message(&json!({"error":null,"status":"completed"})), None);
    }

    #[tokio::test]
    #[ignore = "requires installed Codex; creates and archives a temporary thread without inference"]
    async fn installed_codex_takeover_reconnects_exact_managed_owner() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_str().unwrap().to_string();
        let service = Arc::new(crate::host::ServiceState {
            data_dir: directory.path().into(),
            cache_dir: directory.path().into(),
            resource_dir: directory.path().into(),
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
        let owner = installed_codex_server_in(&root).await;
        let requester = installed_codex_server_in(&root).await;
        let started = app_server_request(&owner, "thread/start", json!({"cwd":root,"approvalPolicy":"never","sandbox":"read-only"}), Duration::from_secs(30)).await.unwrap();
        let thread = started["thread"]["id"].as_str().unwrap().to_string();
        app_server_request(&owner, "thread/inject_items", json!({"threadId":thread,"items":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Takeover regression fixture, no inference."}]}]}), Duration::from_secs(30)).await.unwrap();
        *owner.thread_id.lock().await = Some(thread.clone());
        *owner.runtime_scope.lock().await = Some((root.clone(), "owner".into()));
        *requester.runtime_scope.lock().await = Some((root, "requester".into()));
        *requester.mcp.lock().await = Some(crate::workspace_mcp::tests::fixture().await);
        service.codex.app_servers.lock().await.extend([("requester:tab".into(),requester.clone()),("owner:tab".into(),owner.clone())]);
        let window = WindowContext {service, id:"requester".into()};
        let token = check_codex_session_owner(window.clone(), "tab".into(), thread.clone()).await.unwrap().unwrap().owner_token;
        let result = reconnect_codex_session(window, "tab".into(), thread.clone(), Some(token), "gpt-5.4".into(), "medium".into()).await;
        let loaded = requester.thread_id.lock().await.clone();
        let _ = app_server_request(&requester,"thread/archive",json!({"threadId":thread}),Duration::from_secs(30)).await;
        let _ = kill_app_server_handle(owner).await;
        let _ = kill_app_server_handle(requester).await;
        assert!(result.is_ok(), "takeover failed: {result:?}");
        assert_eq!(loaded, Some(thread));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn takeover_requires_exact_owner_and_preserves_unrelated_processes() {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(crate::host::ServiceState {
            data_dir: directory.path().into(),
            cache_dir: directory.path().into(),
            resource_dir: directory.path().into(),
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
        let window = WindowContext { service: service.clone(), id: "requester".into() };
        async fn process(thread: &str) -> Arc<CodexAppServerHandle> {
            let mut child = create_command_with_piped_stdin("/bin/cat", &[], None).spawn().unwrap();
            let handle = Arc::new(CodexAppServerHandle::new(child.stdin.take().unwrap(), child, PathBuf::new()));
            *handle.thread_id.lock().await = Some(thread.into());
            *handle.runtime_scope.lock().await = Some(("/project".into(), "chat".into()));
            handle
        }
        let requester = process("session").await;
        let owner = process("session").await;
        let unrelated = process("other-session").await;
        service.codex.app_servers.lock().await.extend([
            ("requester:tab".into(), requester.clone()), ("other:tab".into(), owner.clone()), ("unrelated:tab".into(), unrelated.clone()),
        ]);
        let token = check_codex_session_owner(window.clone(), "tab".into(), "session".into()).await.unwrap().unwrap().owner_token;
        for confirmation in [None, Some("stale-token".into())] {
            assert!(reconnect_codex_session(window.clone(), "tab".into(), "session".into(), confirmation, "model".into(), "medium".into()).await.is_err());
            assert!(owner.child.lock().await.as_mut().unwrap().try_wait().unwrap().is_none());
        }
        reconnect_codex_session(window.clone(), "tab".into(), "session".into(), Some(token), "model".into(), "medium".into()).await.unwrap();
        assert!(owner.child.lock().await.is_none());
        assert!(unrelated.child.lock().await.as_mut().unwrap().try_wait().unwrap().is_none());
        assert!(check_codex_session_owner(window.clone(), "tab".into(), "session".into()).await.unwrap().is_none());
        kill_app_server_handle(requester).await.unwrap();
        kill_app_server_handle(unrelated).await.unwrap();
    }



    #[test]
    fn completion_is_claimed_once_and_never_clears_a_newer_turn() {
        let mut active = Some("old".to_string());
        assert!(claim_turn_completion(&mut active, "old"));
        assert!(!claim_turn_completion(&mut active, "old"));
        active = Some("new".to_string());
        assert!(!claim_turn_completion(&mut active, "old"));
        assert_eq!(active.as_deref(), Some("new"));
    }

    #[tokio::test]
    async fn interrupted_turn_waits_for_terminal_state_and_has_a_deadline() {
        let active = Mutex::new(Some("old".to_string()));
        assert!(!wait_for_turn_end(&active, "old", Duration::from_millis(5)).await);
        claim_turn_completion(&mut *active.lock().await, "old");
        assert!(wait_for_turn_end(&active, "old", Duration::from_millis(5)).await);
        *active.lock().await = Some("new".to_string());
        assert!(wait_for_turn_end(&active, "old", Duration::from_millis(5)).await);
        assert_eq!(active.lock().await.as_deref(), Some("new"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn subscription_usage_reads_account_without_starting_a_turn() {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(crate::host::ServiceState {
            data_dir: directory.path().into(),
            cache_dir: directory.path().into(),
            resource_dir: directory.path().into(),
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
        let window = WindowContext { service: service.clone(), id: "usage-test".into() };
        let mut child = create_command_with_piped_stdin("/bin/cat", &[], None).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let handle = Arc::new(CodexAppServerHandle::new(child.stdin.take().unwrap(), child, PathBuf::new()));
        service.codex.app_servers.lock().await.insert("usage-test:__model-discovery".into(), handle.clone());
        let mut lines = BufReader::new(stdout).lines();
        let payload = json!({"rateLimits": null, "rateLimitsByLimitId": {"codex": {"planType": "pro", "primary": {"usedPercent": 25, "windowDurationMins": 300, "resetsAt": 123456}}}});
        for response in [json!({"result": payload}), json!({"error": {"code": -32000, "message": "Unavailable"}})] {
            let request = tokio::spawn(read_codex_subscription_usage(window.clone()));
            let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await.unwrap().unwrap().unwrap();
            let message: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(message["method"], "account/rateLimits/read");
            assert_eq!(message["params"], json!({}));
            let request_id = message["id"].as_i64().unwrap();
            handle.response_waiters.lock().await.remove(&request_id).unwrap().send(response.clone()).unwrap();
            let result = request.await.unwrap();
            if response.get("error").is_some() {
                assert!(result.unwrap_err().contains("Unavailable"));
            } else {
                assert_eq!(result.unwrap(), payload);
            }
            assert!(handle.thread_id.lock().await.is_none());
            assert!(handle.active_turn_id.lock().await.is_none());
        }
        kill_app_server_handle(handle).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_closes_launcher_child_input_even_with_live_handle() {
        use tokio::io::AsyncReadExt;

        // A launcher waiting for a child that inherits its pipes, like the npm CLI.
        let mut child = create_command_with_piped_stdin(
            "/bin/sh", &["-c".into(), "cat & printf ready; wait".into()], None,
        ).spawn().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let handle = Arc::new(CodexAppServerHandle::new(
            child.stdin.take().unwrap(), child, PathBuf::new(),
        ));
        let mut ready = [0; 5];
        tokio::time::timeout(Duration::from_secs(5), stdout.read_exact(&mut ready))
            .await.unwrap().unwrap();
        assert_eq!(&ready, b"ready");
        let (sender, receiver) = oneshot::channel();
        handle.response_waiters.lock().await.insert(1, sender);
        kill_app_server_handle(handle.clone()).await.unwrap();
        let mut output = Vec::new();
        let eof = tokio::time::timeout(Duration::from_secs(1), stdout.read_to_end(&mut output)).await;
        assert!(eof.is_ok(), "launcher child still holds stdout after shutdown");
        assert!(receiver.await.is_err());
        let closed = app_server_request(&handle, "thread/resume", json!({}), Duration::from_secs(1)).await;
        assert_eq!(closed.unwrap_err(), "Codex app-server is closed");
        assert!(handle.response_waiters.lock().await.is_empty());
        kill_app_server_handle(handle).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn window_shutdown_closes_all_tab_inputs_before_waiting() {
        let directory = tempfile::tempdir().unwrap();
        let state = CodexProcessState::default();
        let markers = [directory.path().join("first"), directory.path().join("second")];
        for index in 0..2 {
            // Each child can exit only after its peer also receives EOF. Serial
            // shutdown would spend the five-second grace on the first child.
            let mut command = create_command_with_piped_stdin(
                "/bin/sh",
                &["-c".into(), "cat >/dev/null; touch \"$MARKER\"; while [ ! -e \"$PEER\" ]; do sleep 0.01; done".into()],
                None,
            );
            command.env("MARKER", &markers[index]).env("PEER", &markers[1 - index]);
            let mut child = command.spawn().unwrap();
            let handle = Arc::new(CodexAppServerHandle::new(
                child.stdin.take().unwrap(), child, PathBuf::new(),
            ));
            state.app_servers.lock().await.insert(format!("window:{index}"), handle);
        }
        let result = tokio::time::timeout(Duration::from_secs(2), kill_process_for_window(&state, "window")).await;
        // Release fixture children even if the regression assertion will fail.
        for marker in &markers { std::fs::write(marker, "").unwrap(); }
        assert!(result.is_ok(), "Tab processes were shut down serially");
        assert!(state.app_servers.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn loaded_thread_preparation_reuses_runtime_and_revokes_failed_admission() {
        let mut child = create_command_with_piped_stdin("/bin/cat", &[], None).spawn().unwrap();
        let handle = Arc::new(CodexAppServerHandle::new(
            child.stdin.take().unwrap(), child, PathBuf::new(),
        ));
        let connection = crate::workspace_mcp::tests::fixture().await;
        *handle.mcp.lock().await = Some(connection.clone());
        *handle.thread_id.lock().await = Some("loaded-thread".into());
        let requests_before = handle.next_request_id.load(Ordering::SeqCst);
        for draft in ["/draft-a", "/draft-b"] {
            let (id, access) = prepare_codex_turn(
                &handle, draft, Some("loaded-thread".into()), "model", "low", None,
            ).await.unwrap();
            assert_eq!(id, "loaded-thread");
            assert!(connection.matches(draft, None));
            assert!(prepare_codex_turn(&handle, "/overlap", None, "model", "low", None).await.is_err());
            *handle.active_turn_id.lock().await = Some(draft.into());
            finish_codex_turn(&handle, draft, access).await;
            assert!(handle.active_turn_id.lock().await.is_none());
        }
        assert!(prepare_codex_turn(&handle, "/wrong", Some("other-thread".into()), "model", "low", None).await.is_err());
        let (_, access) = prepare_codex_turn(&handle, "/valid", None, "model", "low", None).await.unwrap();
        drop(access);
        assert_eq!(handle.next_request_id.load(Ordering::SeqCst), requests_before);
        kill_app_server_handle(handle).await.unwrap();
    }

    async fn installed_codex_server() -> Arc<CodexAppServerHandle> {
        installed_codex_server_in(env!("CARGO_MANIFEST_DIR")).await
    }

    async fn installed_codex_server_in(launch_cwd: &str) -> Arc<CodexAppServerHandle> {
            let mut child = create_command_with_piped_stdin(
                &find_codex_binary().unwrap(),
                &["app-server".into(), "--listen".into(), "stdio://".into()],
                Some(launch_cwd),
            ).spawn().unwrap();
            let stdout = child.stdout.take().unwrap();
            let handle = Arc::new(CodexAppServerHandle::new(
                child.stdin.take().unwrap(), child, PathBuf::new(),
            ));
            let weak = Arc::downgrade(&handle);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let message: Value = serde_json::from_str(&line).unwrap();
                    let Some(handle) = weak.upgrade() else { break };
                    if let Some(id) = message.get("id").and_then(Value::as_i64) {
                        if let Some(waiter) = handle.response_waiters.lock().await.remove(&id) {
                            let _ = waiter.send(message);
                            continue;
                        }
                    }
                    if message.get("method").is_some() {
                        let _ = handle.notifications.send(message);
                    }
                }
            });
            app_server_request(&handle, "initialize", json!({
                "clientInfo": {"name":"catalex-resume-test", "version":"1"},
                "capabilities": {"experimentalApi":true}
            }), Duration::from_secs(30)).await.unwrap();
            handle
    }

    // Exercise the installed CLI launcher as well as the native app-server. No inference.
    #[tokio::test]
    #[ignore = "requires installed Codex CLI"]
    async fn installed_codex_releases_writer_before_resume() {
        let first = installed_codex_server().await;
        let started = app_server_request(&first, "thread/start", json!({
            "cwd":env!("CARGO_MANIFEST_DIR"), "approvalPolicy":"never", "sandbox":"read-only"
        }), Duration::from_secs(30)).await.unwrap();
        let thread_id = started["thread"]["id"].as_str().unwrap();
        app_server_request(&first, "thread/inject_items", json!({
            "threadId":thread_id,
            "items":[{"type":"message", "role":"user", "content":[{"type":"input_text", "text":"Catalex resume regression fixture; no inference."}]}]
        }), Duration::from_secs(30)).await.unwrap();
        kill_app_server_handle(first.clone()).await.unwrap();
        // Keep the old handle alive, just as the production stdout task does.
        let second = installed_codex_server().await;
        let resumed = app_server_request(&second, "thread/resume", json!({
            "threadId":thread_id, "excludeTurns":true,
            "cwd":env!("CARGO_MANIFEST_DIR"), "approvalPolicy":"never", "sandbox":"read-only"
        }), Duration::from_secs(30)).await;
        drop(first);
        let _ = app_server_request(&second, "thread/archive", json!({"threadId":thread_id}), Duration::from_secs(30)).await;
        kill_app_server_handle(second).await.unwrap();
        assert!(resumed.is_ok(), "second conversation round failed: {resumed:?}");
    }

    #[tokio::test]
    #[ignore = "requires installed Codex; sends two short model turns on temporary drafts"]
    async fn installed_codex_keeps_loaded_conversation_across_drafts() {
        let drafts = tempfile::tempdir().unwrap();
        let first_draft = drafts.path().join("draft-a");
        std::fs::create_dir(&first_draft).unwrap();
        // The runtime lives in the source project, not a disposable candidate.
        let handle = installed_codex_server_in(drafts.path().to_str().unwrap()).await;
        let connection = crate::workspace_mcp::tests::fixture().await;
        *handle.mcp.lock().await = Some(connection.clone());
        let checked_handle = handle.clone();
        // Keep the source directory alive through thread archival and shutdown.
        let draft_root = drafts.path().to_path_buf();
        // Keep cleanup outside the assertion task so failures still release the writer.
        let checked = tokio::spawn(async move {
            let handle = checked_handle;
            let pid = handle.child.lock().await.as_ref().unwrap().id();
            let settings = serde_json::to_value(&connection.settings).unwrap();
            let mut session = None;
            for draft in ["draft-a", "draft-b"] {
                let directory = draft_root.join(draft);
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(directory.join("marker.txt"), draft).unwrap();
                let path = directory.to_str().unwrap();
                let context = VerificationContext {
                    root_id: draft.into(), target_path: "main.tex".into(),
                    backend: crate::latex::CompilerBackend::Latexmk,
                    engine: crate::latex::TexEngine::LuaLaTeX,
                    auto_engine: false,
                };
                let mut events = handle.notifications.subscribe();
                let requests_before = handle.next_request_id.load(Ordering::SeqCst);
                let (thread_id, access) = prepare_codex_turn(
                    &handle, path, session.clone(), "gpt-5.6-luna", "low", Some(context),
                ).await.unwrap();
                if let Some(previous) = &session {
                    assert_eq!(&thread_id, previous);
                    assert_eq!(handle.next_request_id.load(Ordering::SeqCst), requests_before,
                        "Follow-up must not resume or reconfigure the loaded thread");
                }
                session = Some(thread_id.clone());
                assert!(directory.is_dir(), "The new turn cwd exists before turn/start");
                let turn_id = start_loaded_codex_turn(
                    &handle, &thread_id, path,
                    "Call the Catalex MCP workspace_state tool exactly once with {}. Also run `cat marker.txt` once using the shell tool in the CURRENT working directory (no explicit cwd override). Do not read other files, edit anything, or invoke skills. Briefly report the two results.",
                    "gpt-5.6-luna", "low", false,
                ).await.unwrap();
                assert!(prepare_codex_turn(&handle, "/other", session.clone(), "gpt-5.6-luna", "low", None).await.is_err());
                let mut items = Vec::new();
                let completed = tokio::time::timeout(Duration::from_secs(90), async {
                    loop {
                        let event = events.recv().await.unwrap();
                        if event["method"] == "item/completed" {
                            items.push(event["params"]["item"].clone());
                        }
                        if event["method"] == "turn/completed" && event["params"]["turn"]["id"] == turn_id {
                            break event["params"]["turn"].clone();
                        }
                    }
                }).await.unwrap();
                finish_codex_turn(&handle, &turn_id, access).await;
                assert_eq!(completed["status"], "completed", "{completed}");
                let tools: Vec<_> = items.iter().filter(|item| item["type"] == "mcpToolCall" && item["server"] == "catalex").collect();
                assert_eq!(tools.len(), 1, "{items:?}");
                assert_eq!(tools[0]["status"], "completed", "{:?}", tools[0]);
                let payload: Value = serde_json::from_str(tools[0]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
                assert_eq!(payload["scope"], path);
                assert_eq!(payload["context"]["rootId"], draft);
                let commands: Vec<_> = items.iter().filter(|item| item["type"] == "commandExecution").collect();
                assert_eq!(commands.len(), 1, "{items:?}");
                assert_eq!(commands[0]["exitCode"], 0);
                assert!(commands[0]["aggregatedOutput"].as_str().unwrap().contains(draft));
                assert_eq!(handle.child.lock().await.as_ref().unwrap().id(), pid);
                assert!(Arc::ptr_eq(handle.mcp.lock().await.as_ref().unwrap(), &connection));
                assert_eq!(serde_json::to_value(&connection.settings).unwrap(), settings);
                println!("{draft}: same process, thread and MCP endpoint; shell and MCP use current draft");
                // Match Catalex's settled-draft cleanup, not just a path switch.
                std::fs::remove_file(directory.join("marker.txt")).unwrap();
                std::fs::remove_dir(&directory).unwrap();
                assert!(!directory.exists());
            }
        }).await;
        let thread_id = handle.thread_id.lock().await.clone();
        let archived = if let Some(thread_id) = thread_id {
            app_server_request(&handle, "thread/archive", json!({"threadId":thread_id}), Duration::from_secs(10)).await.map(|_| ())
        } else { Ok(()) };
        kill_app_server_handle(handle).await.unwrap();
        checked.unwrap();
        archived.unwrap();
    }

    #[test]
    fn normal_turn_start_params_use_writable_sandbox_and_top_level_model() {
        let params = codex_turn_start_params(
            "thread-1",
            "/tmp/project",
            "hello",
            "gpt-5.5",
            "xhigh",
            false,
            None,
        );

        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(params["cwd"], json!("/tmp/project"));
        assert_eq!(params["input"][0]["text"], json!("hello"));
        assert_eq!(params["approvalPolicy"], json!("never"));
        assert_eq!(
            params["sandboxPolicy"],
            codex_workspace_write_sandbox_policy("/tmp/project")
        );
        assert_eq!(params["model"], json!("gpt-5.5"));
        assert_eq!(params["effort"], json!("xhigh"));
        assert_eq!(params["serviceTierForTurn"], json!("default"));
        assert_eq!(params["collaborationMode"], Value::Null);
    }

    #[test]
    fn fast_mode_overrides_only_the_new_turn() {
        let params = codex_turn_start_params("thread-1", "/tmp/project", "hello", "gpt-test", "medium", true, None);
        assert_eq!(params["serviceTierForTurn"], json!("fast"));
        assert_eq!(params["effort"], json!("medium"));
    }

    #[test]
    fn explicit_catalex_skill_invocation_adds_typed_turn_input() {
        let root = Path::new("/Applications/Catalex.app/Contents/Resources/catalex/skills");
        for name in crate::builtin_skills::NAMES {
            let params = codex_turn_start_params(
                "thread-1",
                "/tmp/project",
                &format!("${name} Review the document."),
                "gpt-5.5",
                "medium",
                false,
                Some(root),
            );
            assert_eq!(params["input"].as_array().unwrap().len(), 2);
            assert_eq!(params["input"][1]["type"], json!("skill"));
            assert_eq!(params["input"][1]["name"], json!(name));
            assert_eq!(
                params["input"][1]["path"],
                json!(root.join(name).join("SKILL.md"))
            );
            for prompt in [format!("${name}-extra"), format!("prefix${name}")] {
                assert!(!prompt_invokes_skill(&prompt, name));
            }
        }
        assert_eq!(codex_turn_input("Review this", Some(root)).len(), 1);
        let ordinary = codex_turn_input("Comment this", Some(root));
        let text = ordinary[0]["text"].as_str().unwrap();
        assert!(text.contains(
            &root
                .join("review-document/SKILL.md")
                .to_string_lossy()
                .to_string()
        ));
        assert!(text.contains("lookup keys, not directories"));
        assert!(text.ends_with("Comment this"));
        assert_eq!(codex_turn_input("$review-document", None).len(), 1);
        let both = codex_turn_input(
            "$review-document $catalex-verify-latex $review-document",
            Some(root),
        );
        assert_eq!(both.len(), 3);
        assert!(codex_system_prompt().contains("$review-document"));
    }

    #[test]
    fn configures_and_recognizes_the_bundled_skill_root() {
        let root = Path::new("/Applications/Catalex.app/Contents/Resources/catalex/skills");
        assert_eq!(
            codex_skills_extra_roots_params(root),
            json!({ "extraRoots": [root.to_string_lossy()] })
        );
        assert_eq!(
            codex_skills_list_params("/tmp/project"),
            json!({ "cwds": ["/tmp/project"], "forceReload": true })
        );

        for name in crate::builtin_skills::NAMES {
            let discovered = json!({
                "data": [{
                    "cwd": "/tmp/project",
                    "skills": [{
                        "name": name,
                        "description": "Bundled workflow",
                        "enabled": true,
                        "path": root.join(name).join("SKILL.md"),
                        "scope": "user"
                    }],
                    "errors": []
                }]
            });
            assert!(skills_list_contains_builtin_skill(&discovered, name, root));
            assert!(!skills_list_contains_builtin_skill(
                &discovered, name, Path::new("/other/skills"),
            ));

            let disabled = json!({
                "data": [{
                    "skills": [{
                        "name": name,
                        "enabled": false,
                        "path": root.join(name).join("SKILL.md")
                    }]
                }]
            });
            assert!(!skills_list_contains_builtin_skill(&disabled, name, root));
        }
    }

    #[test]
    fn bundled_skill_documents_every_bounded_verification_path() {
        let skill = include_str!(
            "../resources/catalex/skills/catalex-verify-latex/SKILL.md"
        );

        for required in [
            "at most three compile attempts total",
            "Successful first compile",
            "Actionable compile failure",
            "Retry exhausted",
            "Visual problem",
            "mcp__catalex__compile",
            "mcp__catalex__render_page",
            "Never manipulate CodeMirror",
            "Never claim a successful compile",
        ] {
            assert!(skill.contains(required), "missing skill rule: {required}");
        }
        assert!(codex_system_prompt().contains(CATALEX_VERIFY_SKILL_MARKER));
    }

    #[test]
    fn universal_mcp_config_uses_authenticated_http_without_dynamic_tools() {
        let settings = crate::workspace_mcp::ConnectionSettings {
            url: "http://127.0.0.1:1234/mcp".into(),
            headers: std::collections::HashMap::from([("Authorization".into(), "Bearer scope".into())]),
        };
        let config = codex_mcp_config(&settings);
        assert_eq!(config["catalex"]["url"], settings.url);
        assert_eq!(config["catalex"]["http_headers"]["Authorization"], "Bearer scope");
        assert_eq!(config["catalex"]["required"], true);
        assert_eq!(config["catalex"]["tools"].as_object().unwrap().len(), 11);
        for tool in ["compile", "diagnostics", "render_page", "read_pdf", "workspace_state", "create_comment", "list_comments", "edit_comment", "resolve_comment", "delete_comment", "ask_user"] {
            assert_eq!(config["catalex"]["tools"][tool]["approval_mode"], "approve");
        }
        assert!(config["catalex"].get("default_tools_approval_mode").is_none());
        let start = codex_thread_start_params("/draft", "gpt-5.5", "medium", "workspace-write");
        assert!(start.get("dynamicTools").is_none());
        assert_eq!(start["approvalPolicy"], "never");
    }

    #[test]
    fn retired_tool_calls_get_an_explicit_failed_response() {
        let response = retired_dynamic_tool_response();
        assert_eq!(response["success"], false);
        assert_eq!(response["contentItems"][0]["type"], "inputText");
        assert!(response["contentItems"][0]["text"].as_str().unwrap().contains("Catalex MCP"));
    }

    #[test]
    fn stale_app_server_handle_cleanup_does_not_remove_newer_handle() {
        let process_key = "window:tab".to_string();
        let old_handle = Arc::new(1);
        let new_handle = Arc::new(2);
        let mut app_servers = HashMap::from([(process_key.clone(), new_handle.clone())]);

        let removed =
            remove_app_server_handle_if_current(&mut app_servers, &process_key, &old_handle);

        assert!(removed.is_none());
        assert!(Arc::ptr_eq(app_servers.get(&process_key).unwrap(), &new_handle));

        let removed =
            remove_app_server_handle_if_current(&mut app_servers, &process_key, &new_handle);

        assert!(removed.is_some());
        assert!(!app_servers.contains_key(&process_key));
    }

    #[test]
    fn mcp_activity_preserves_errors_and_omits_image_data() {
        let (content, is_error) = codex_tool_result(&json!({
            "type":"mcpToolCall", "status":"failed", "error":{"message":"compile failed"}
        }));
        assert!(is_error);
        assert_eq!(content, "compile failed");
        let (content, is_error) = codex_tool_result(&json!({
            "type":"mcpToolCall", "status":"completed", "result":{"content":[
                {"type":"text","text":"Rendered page 1"},
                {"type":"image","mimeType":"image/png","data":"base64-image"}
            ]}
        }));
        assert!(!is_error);
        assert_eq!(content, "Rendered page 1");
    }

    #[test]
    fn extracts_thread_id_from_app_server_thread_result() {
        assert_eq!(
            codex_thread_id_from_result(&json!({
                "thread": { "id": "thread-123" }
            })),
            Some("thread-123".to_string())
        );
        assert_eq!(codex_thread_id_from_result(&json!({ "thread": {} })), None);
    }

    #[test]
    fn normalizes_discovered_models_and_reasoning_efforts() {
        let model = normalize_codex_model_info(&json!({
            "id": "gpt-5.6",
            "model": "gpt-5.6",
            "displayName": "GPT-5.6",
            "description": "Frontier model",
            "hidden": false,
            "supportedReasoningEfforts": [
                { "reasoningEffort": "medium", "description": "Balanced" },
                { "reasoningEffort": "ultra", "description": "Deepest" }
            ],
            "defaultReasoningEffort": "medium",
            "isDefault": true
        }))
        .unwrap();

        assert_eq!(model.model, "gpt-5.6");
        assert_eq!(model.display_name, "GPT-5.6");
        assert_eq!(model.supported_reasoning_efforts.len(), 2);
        assert_eq!(model.supported_reasoning_efforts[1].value, "ultra");
        assert_eq!(model.default_reasoning_effort, "medium");
        assert!(model.is_default);
    }

    #[test]
    fn maps_command_and_file_change_items_to_existing_tool_widgets() {
        let (name, input) = codex_tool_details(&json!({
            "type": "commandExecution",
            "id": "command-1",
            "command": "rg --files"
        }))
        .unwrap();
        assert_eq!(name, "Bash");
        assert_eq!(input["command"], json!("rg --files"));

        let (name, input) = codex_tool_details(&json!({
            "type": "fileChange",
            "id": "change-1",
            "changes": [{ "path": "main.tex", "kind": "update" }]
        }))
        .unwrap();
        assert_eq!(name, "Edit");
        assert_eq!(input["file_path"], json!("main.tex"));

        let (name, input) = codex_tool_details(&json!({
            "type": "dynamicToolCall",
            "id": "compile-1",
            "tool": "catalex_compile",
            "arguments": {}
        }))
        .unwrap();
        assert_eq!(name, "catalex_compile");
        assert_eq!(input, json!({}));
    }
}
