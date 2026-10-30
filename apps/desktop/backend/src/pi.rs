//! Installed Pi RPC adapter. Each turn owns its process, MCP credential and cwd;
//! the native session file preserves conversation state across turns and restarts.
use crate::{host::WindowContext, verification::VerificationContext, workspace_mcp::WorkspaceMcp};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct PiProcessState {
    turns: Arc<Mutex<HashMap<String, Arc<PiTurn>>>>,
}
struct PiTurn {
    cancel: CancellationToken,
    done: CancellationToken,
    mcp: Arc<WorkspaceMcp>,
    session_file: String,
}

pub enum PiOperation {
    Prompt(String),
    Compact,
}

#[derive(serde::Serialize)]
pub struct PiStatus {
    installed: bool,
    binary_path: Option<String>,
    config_directory: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PiConfig {
    binary_path: String,
    config_directory: String,
}

fn expand_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    let path = if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        dirs::home_dir()
            .ok_or("Could not find your home folder")?
            .join(value.get(2..).unwrap_or(""))
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() {
        return Err("Choose an absolute path or a path starting with ~/".into());
    }
    Ok(path)
}

impl PiConfig {
    fn binary(&self) -> Result<PathBuf, String> {
        if self.binary_path.trim().is_empty() {
            return find_binary();
        }
        let path = expand_path(&self.binary_path)?;
        if path.is_dir() {
            // Folder pickers accept either the launcher folder or an install
            // prefix. Keep the search bounded and never evaluate a shell command.
            #[cfg(target_os = "windows")]
            let names = ["pi.exe", "pi.cmd", "bin/pi.exe", "bin/pi.cmd"];
            #[cfg(not(target_os = "windows"))]
            let names = ["pi", "bin/pi"];
            return names
                .into_iter()
                .map(|name| path.join(name))
                .find(|path| path.is_file())
                .ok_or_else(|| "Pi executable not found in this folder or its bin folder.".into());
        }
        if !path.is_file() {
            return Err("Pi executable not found. Choose the Pi executable file.".into());
        }
        Ok(path)
    }

    fn directory(&self) -> Result<PathBuf, String> {
        let custom = !self.config_directory.trim().is_empty();
        let path = if custom {
            expand_path(&self.config_directory)?
        } else {
            detected_agent_dir()?
        };
        // Pi may create its normal folder on first launch, including after it
        // becomes a saved dropdown choice. Other selected folders must exist.
        let normal_folder = detected_agent_dir().is_ok_and(|normal| normal == path);
        if (path.exists() || !normal_folder) && !path.is_dir() {
            return Err("Pi config folder not found. Choose an existing folder.".into());
        }
        Ok(path)
    }

    fn command(&self) -> Result<Command, String> {
        let mut cmd = command(&self.binary()?);
        cmd.env("PI_CODING_AGENT_DIR", self.directory()?);
        Ok(cmd)
    }
}

fn default_agent_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("Could not find your home folder")?
        .join(".pi/agent"))
}

fn detected_agent_dir() -> Result<PathBuf, String> {
    match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(value) if !value.trim().is_empty() => expand_path(&value),
        _ => default_agent_dir(),
    }
}

fn find_binary() -> Result<PathBuf, String> {
    if let Ok(path) = which::which("pi") {
        return Ok(path);
    }
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/pi"),
        PathBuf::from("/usr/local/bin/pi"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.extend([
            home.join(".local/bin/pi"),
            home.join(".bun/bin/pi"),
            home.join("Library/pnpm/pi"),
            home.join("AppData/Roaming/npm/pi.cmd"),
        ]);
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut nvm: Vec<_> = entries
                .flatten()
                .map(|entry| entry.path().join("bin/pi"))
                .collect();
            nvm.sort();
            nvm.reverse();
            candidates.extend(nvm);
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Pi is not installed. Install and configure Pi in your terminal first.".into()
        })
}

// Preserve the selected launcher, but also expose Node beside symlink targets.
// npm's final target is inside <prefix>/lib/node_modules, while Node is in
// <prefix>/bin. Inspect paths only; never invoke a shell or change the selection.
fn launcher_paths(binary: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut target = binary.to_path_buf();
    for _ in 0..40 {
        let parent = target.parent().unwrap_or(Path::new("."));
        let parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        if !paths.contains(&parent) {
            paths.push(parent.clone());
        }
        match std::fs::read_link(&target) {
            Ok(link) => {
                target = if link.is_absolute() {
                    link
                } else {
                    parent.join(link)
                }
            }
            Err(_) => break,
        }
    }
    if let Ok(resolved) = std::fs::canonicalize(binary) {
        #[cfg(target_os = "windows")]
        let node = "node.exe";
        #[cfg(not(target_os = "windows"))]
        let node = "node";
        if let Some(bin) = resolved
            .ancestors()
            .skip(1)
            .map(|ancestor| ancestor.join("bin"))
            .find(|bin| bin.join(node).is_file())
        {
            if !paths.contains(&bin) {
                paths.push(bin);
            }
        }
    }
    paths
}

fn command(binary: &Path) -> Command {
    #[cfg(target_os = "windows")]
    let mut command = if binary
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        // npm's .cmd shim cannot be launched directly by CreateProcess. Invoke
        // its package entry with Node, without introducing cmd.exe quoting.
        let root = binary.parent().unwrap_or(Path::new("."));
        let node = root.join("node.exe");
        let mut command = Command::new(if node.is_file() {
            node
        } else {
            PathBuf::from("node.exe")
        });
        command.arg(root.join("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"));
        command
    } else {
        Command::new(binary)
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(binary);
    // npm launchers use /usr/bin/env node, even when Electron has a minimal PATH.
    let mut paths = launcher_paths(binary);
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    // Tokio's output() inherits stdin. Pi's startup can change its flags, which
    // would corrupt the service's shared RPC input. Rpc::spawn supplies its own pipe.
    command.stdin(Stdio::null());
    command.kill_on_drop(true);
    command
}

fn supported_version(version: &str) -> bool {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 1)
}

pub async fn check_pi_status(config: PiConfig) -> Result<PiStatus, String> {
    let directory = config.directory();
    let binary = match config.binary() {
        Ok(binary) => binary,
        Err(error) => {
            return Ok(PiStatus {
                installed: false,
                binary_path: None,
                config_directory: directory
                    .as_ref()
                    .ok()
                    .map(|path| path.to_string_lossy().into()),
                version: None,
                error: Some(error),
            })
        }
    };
    let mut status = PiStatus {
        installed: true,
        binary_path: Some(binary.to_string_lossy().into()),
        config_directory: directory
            .as_ref()
            .ok()
            .map(|path| path.to_string_lossy().into()),
        version: None,
        error: None,
    };
    if let Err(error) = directory {
        status.error = Some(error);
        return Ok(status);
    }
    let version = tokio::time::timeout(
        Duration::from_secs(10),
        config.command()?.arg("--version").output(),
    )
    .await
    .map_err(|_| "Pi version check timed out".to_string())?
    .map_err(|error| format!("Could not start Pi: {error}"))?;
    let success = version.status.success();
    let version = String::from_utf8_lossy(&version.stdout).trim().to_string();
    status.error = if !success {
        Some("Pi version check failed. Check the selected executable.".into())
    } else if !supported_version(&version) {
        Some("Pi 1.0 or newer is required for the RPC and MCP integration.".into())
    } else {
        None
    };
    status.version = Some(version);
    Ok(status)
}

struct Rpc {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr: Arc<Mutex<String>>,
    stderr_task: tokio::task::JoinHandle<()>,
    next_id: usize,
    events: Option<(WindowContext, String)>,
}
impl Rpc {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start Pi: {error}"))?;
        let stdin = child.stdin.take().ok_or("Pi stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi stdout is unavailable")?;
        let mut stderr_pipe = child.stderr.take().ok_or("Pi stderr is unavailable")?;
        let stderr = Arc::new(Mutex::new(String::new()));
        let captured = stderr.clone();
        let stderr_task = tokio::spawn(async move {
            let mut buffer = [0; 4096];
            while let Ok(count) = stderr_pipe.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let mut captured = captured.lock().await;
                captured.push_str(&String::from_utf8_lossy(&buffer[..count]));
                if captured.len() > 8192 {
                    let mut start = captured.len() - 8192;
                    while !captured.is_char_boundary(start) {
                        start += 1;
                    }
                    captured.drain(..start);
                }
            }
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            stderr,
            stderr_task,
            next_id: 0,
            events: None,
        })
    }
    async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or("Pi connection is closed")?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("Could not write to Pi: {error}"))?;
        stdin.flush().await.map_err(|error| error.to_string())
    }
    async fn read(&mut self) -> Result<Value, String> {
        // Rust read_line splits only on LF; Unicode separators inside JSON survive.
        let mut line = String::new();
        if self
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|error| format!("Could not read Pi output: {error}"))?
            == 0
        {
            let diagnostics = self.stderr.lock().await.clone();
            return Err(format!(
                "Pi closed before completing the request. {}",
                diagnostics.trim()
            ));
        }
        let record = parse_record(&line)?;
        if let Some((window, tab)) = &self.events {
            if matches!(
                record["type"].as_str(),
                Some(
                    "extension_error"
                        | "compaction_start"
                        | "compaction_end"
                        | "auto_retry_start"
                        | "auto_retry_end"
                        | "summarization_retry_scheduled"
                        | "summarization_retry_attempt_start"
                        | "summarization_retry_finished"
                )
            ) {
                output(window, tab, record.clone());
            }
        }
        Ok(record)
    }
    async fn request(&mut self, value: Value) -> Result<Value, String> {
        tokio::time::timeout(Duration::from_secs(30), self.request_until_response(value))
            .await
            .map_err(|_| "Pi did not respond within 30 seconds".to_string())?
    }
    async fn request_until_response(&mut self, mut value: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = format!("catalex-{}", self.next_id);
        value["id"] = json!(id);
        self.send(value).await?;
        loop {
            let record = self.read().await?;
            if record["type"] == "response" && record["id"] == id {
                return response_data(record);
            }
            if self.events.is_none() && record["type"] == "extension_error" {
                return Err(format!(
                    "Pi extension error ({}): {}\n{}",
                    record["event"].as_str().unwrap_or("unknown hook"),
                    record["error"].as_str().unwrap_or("Unknown error"),
                    record["extensionPath"].as_str().unwrap_or("")
                ));
            }
            // Discovery/setup has no active prompt. Never silently dismiss a
            // protocol parse failure or an extension requesting interaction.
            if record["type"] == "response" && record["success"] == false {
                return response_data(record);
            }
            if record["type"] == "extension_ui_request" {
                self.decline_extension_ui(&record).await?;
            }
        }
    }
    async fn decline_extension_ui(&mut self, record: &Value) -> Result<(), String> {
        if matches!(
            record["method"].as_str(),
            Some("select" | "input" | "editor" | "confirm")
        ) {
            self.send(json!({"type":"extension_ui_response","id":record["id"],"cancelled":true}))
                .await?;
        }
        Ok(())
    }
    async fn shutdown(&mut self) -> Result<(), String> {
        // EOF asks Pi to clean up its tools and MCP connections before exiting.
        drop(self.stdin.take());
        let clean = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        self.stderr_task.abort();
        match clean {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(status)) => Err(format!("Pi exited with {status}")),
            _ => {
                // A hung extension/tool must not leave child commands running
                // against a draft after cancellation or window disposal.
                if let Some(pid) = self.child.id() {
                    #[cfg(unix)]
                    let _ = Command::new("/bin/kill")
                        .args(["-KILL", "--", &format!("-{pid}")])
                        .status()
                        .await;
                    #[cfg(target_os = "windows")]
                    let _ = Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .status()
                        .await;
                }
                let _ = self.child.kill().await;
                let _ = self.child.wait().await;
                Err("Pi did not shut down cleanly".into())
            }
        }
    }
}
impl Drop for Rpc {
    fn drop(&mut self) {
        self.stderr_task.abort();
    }
}

fn parse_record(line: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(line.trim_end_matches(['\r', '\n']))
        .map_err(|error| format!("Invalid Pi RPC JSON: {error}"))?;
    if !value.is_object() || !value["type"].is_string() {
        return Err("Invalid Pi RPC record: missing type".into());
    }
    Ok(value)
}
fn response_data(record: Value) -> Result<Value, String> {
    if record["success"] == true {
        Ok(record["data"].clone())
    } else {
        Err(record["error"]
            .as_str()
            .unwrap_or("Pi rejected the command")
            .to_string())
    }
}

pub async fn list_pi_models(window: WindowContext, config: PiConfig) -> Result<Vec<Value>, String> {
    let mut cmd = config.command()?;
    std::fs::create_dir_all(&window.service.cache_dir).map_err(|error| error.to_string())?;
    let extension_dir = tempfile::Builder::new()
        .prefix("pi-models-")
        .tempdir_in(&window.service.cache_dir)
        .map_err(|error| error.to_string())?;
    let extension = extension_dir.path().join("catalex-models.mjs");
    let catalog = extension_dir.path().join("models.json");
    std::fs::write(&extension, include_str!("pi_models.mjs")).map_err(|error| error.to_string())?;
    cmd.args([
        "--mode",
        "rpc",
        "--no-session",
        "--no-mcp",
        "--no-skills",
        "--no-context-files",
        "--no-approve",
        "--offline",
    ])
    .arg("--extension")
    .arg(extension);
    cmd.current_dir(&window.service.cache_dir)
        .env("CATALEX_PI_MODELS", &catalog);
    let mut rpc = Rpc::spawn(cmd)?;
    // The RPC catalog ignores enabledModels. Read Pi's resolved scope from the
    // startup extension instead, without cycling models or changing settings.
    // get_state is handled after session_start; the extension has written its
    // result by then. Pi reserves stdout for its own RPC records.
    let response = rpc.request(json!({"type":"get_state"})).await;
    let _ = rpc.shutdown().await;
    response?;
    let record: Value = serde_json::from_slice(
        &std::fs::read(catalog)
            .map_err(|error| format!("Could not read Pi scoped models: {error}"))?,
    )
    .map_err(|error| format!("Invalid Pi scoped model list: {error}"))?;
    if let Some(error) = record["error"].as_str() {
        return Err(error.to_string());
    }
    record["models"]
        .as_array()
        .cloned()
        .ok_or_else(|| "Pi returned no scoped model list".to_string())
}

pub async fn list_pi_skills(window: WindowContext, config: PiConfig) -> Result<Vec<Value>, String> {
    let mut cmd = config.command()?;
    let builtins = crate::builtin_skills::resolve_root(&window)?.join("skills");
    std::fs::create_dir_all(&window.service.cache_dir).map_err(|error| error.to_string())?;
    cmd.args([
        "--mode",
        "rpc",
        "--no-approve",
        "--no-session",
        "--no-mcp",
        "--no-context-files",
        "--offline",
    ])
    .arg("--skill")
    .arg(&builtins)
    .current_dir(&window.service.cache_dir);
    let mut rpc = Rpc::spawn(cmd)?;
    let response = rpc.request(json!({"type":"get_commands"})).await;
    let _ = rpc.shutdown().await;
    skills_from_commands(response?, &builtins)
}

fn skills_from_commands(record: Value, builtins: &Path) -> Result<Vec<Value>, String> {
    let commands = record["commands"]
        .as_array()
        .ok_or("Pi returned no command list")?;
    Ok(commands
        .iter()
        .filter_map(|command| {
            if command["source"] != "skill" {
                return None;
            }
            let name = command["name"].as_str()?.strip_prefix("skill:")?;
            if name.is_empty() {
                return None;
            }
            let file = command["sourceInfo"]["path"].as_str().unwrap_or("");
            let path = Path::new(file);
            let file_path = if let Ok(relative) = path.strip_prefix(builtins) {
                format!(
                    "catalex://built-in-skills/{}",
                    relative.to_string_lossy().replace('\\', "/")
                )
            } else {
                file.to_string()
            };
            Some(json!({
                "id": format!("pi-skill:{name}"), "name": name,
                "full_command": format!("/{name}"), "scope": "skill", "namespace": null,
                "skill_scope": command["sourceInfo"]["scope"],
                "file_path": file_path,
                "content": std::fs::read_to_string(path).unwrap_or_default(),
                "description": command["description"], "allowed_tools": [],
                "has_bash_commands": false, "has_file_references": false, "accepts_arguments": true,
            }))
        })
        .collect())
}

fn selected_model(model: Option<&str>) -> Result<Option<(String, String)>, String> {
    model
        .filter(|model| *model != "default")
        .map(|model| {
            let [provider, id]: [String; 2] = serde_json::from_str(model)
                .map_err(|_| "Invalid Pi model selection".to_string())?;
            if provider.trim().is_empty() || id.trim().is_empty() {
                return Err("Invalid Pi model selection".into());
            }
            Ok((provider, id))
        })
        .transpose()
}

fn session_path(directory: &Path, session_id: Option<&str>) -> Result<PathBuf, String> {
    // Use one identity for new and resumed files, including aliased data roots.
    let root = std::fs::canonicalize(directory).map_err(|error| error.to_string())?;
    if let Some(session_id) = session_id {
        let path = PathBuf::from(session_id);
        // The renderer only restores files created by this adapter, never UUID
        // prefixes that Pi might resolve to another project's conversation.
        let canonical = std::fs::canonicalize(&path).map_err(|_| {
            "Could not resume Pi session: saved session file is missing".to_string()
        })?;
        if !canonical.starts_with(root)
            || canonical.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
        {
            return Err(
                "Could not resume Pi session: file is outside Catalex session storage".into(),
            );
        }
        Ok(canonical)
    } else {
        Ok(root.join(format!("{}.jsonl", uuid::Uuid::new_v4())))
    }
}

fn update_session_cwd(path: &Path, cwd: &str) -> Result<(), String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("Could not read Pi session: {error}"))?;
    let end = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(bytes.len());
    let mut header: Value = serde_json::from_slice(&bytes[..end])
        .map_err(|_| "Could not resume Pi session: invalid header".to_string())?;
    if header["type"] != "session" || !header["id"].is_string() {
        return Err("Could not resume Pi session: invalid header".into());
    }
    if header["cwd"] == cwd {
        return Ok(());
    }
    // Pi's CLI restores cwd from the session header, overriding the launch cwd.
    // Only our own session files are admitted; preserve all transcript bytes.
    header["cwd"] = json!(cwd);
    let mut updated = serde_json::to_vec(&header).map_err(|error| error.to_string())?;
    updated.extend_from_slice(&bytes[end..]);
    crate::project_files::replace_file(path, &updated)
        .map_err(|error| format!("Could not update Pi session cwd: {error}"))
}

pub async fn start_pi_turn(
    window: WindowContext,
    config: PiConfig,
    project_path: String,
    source_project_path: String,
    runtime_session_key: String,
    session_id: Option<String>,
    operation: PiOperation,
    tab_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    compile_context: Option<VerificationContext>,
) -> Result<(), String> {
    if matches!(operation, PiOperation::Compact) && session_id.is_none() {
        return Err("Start or resume a Pi conversation before compacting".into());
    }
    let selected = selected_model(model.as_deref())?;
    if reasoning_effort.as_deref().is_some_and(|level| {
        !matches!(
            level,
            "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        )
    }) {
        return Err("Invalid Pi thinking level".into());
    }
    let mut cmd = config.command()?;
    let sessions = window.service.data_dir.join("pi-sessions");
    std::fs::create_dir_all(&sessions).map_err(|error| error.to_string())?;
    let session_file = session_path(&sessions, session_id.as_deref())?;
    let key = format!("{}:{}", window.label(), tab_id);
    let mut turns = window.service.pi.turns.lock().await;
    if turns.contains_key(&key) {
        return Err("A Pi turn is already running in this chat".into());
    }
    if turns
        .values()
        .any(|turn| turn.session_file == session_file.to_string_lossy())
    {
        return Err("This Pi session is already running in another chat".into());
    }
    let mcp = WorkspaceMcp::start(
        window.clone(),
        tab_id.clone(),
        source_project_path.clone(),
        crate::comments::AgentOrigin {
            provider: "pi".into(),
            session_id: runtime_session_key,
            model: None,
            thinking_effort: None,
        },
    )
    .await?;
    let access = mcp.begin_turn_with_model(
        project_path.clone(),
        compile_context,
        model.clone(),
        reasoning_effort.clone(),
    )?;
    std::fs::create_dir_all(&window.service.cache_dir).map_err(|error| error.to_string())?;
    let extension_dir = tempfile::Builder::new()
        .prefix("pi-mcp-")
        .tempdir_in(&window.service.cache_dir)
        .map_err(|error| error.to_string())?;
    let extension = extension_dir.path().join("catalex-mcp.mjs");
    std::fs::write(&extension, include_str!("pi_mcp.mjs")).map_err(|error| error.to_string())?;
    // Compaction does not need an editing draft and may run after acceptance.
    // Give Pi an existing cwd without creating a review workspace.
    let working_directory = if matches!(operation, PiOperation::Compact) {
        let scratch = extension_dir.path().join("compaction");
        std::fs::create_dir(&scratch).map_err(|error| error.to_string())?;
        scratch
    } else {
        PathBuf::from(&project_path)
    };
    if session_id.is_some() {
        update_session_cwd(&session_file, &working_directory.to_string_lossy())?;
    }
    // The selected agent directory supplies Pi configuration. Native context
    // discovery still reads AGENTS.md from the draft and its ancestors.
    cmd.args(["--mode", "rpc", "--no-approve", "--offline", "--session"])
        .arg(&session_file)
        .arg("--extension")
        .arg(extension)
        .current_dir(&working_directory)
        .env(
            "CATALEX_PI_MCP",
            serde_json::to_string(&mcp.settings).map_err(|error| error.to_string())?,
        );
    if let Some((provider, id)) = selected {
        cmd.arg("--provider").arg(provider).arg("--model").arg(id);
    }
    if let Some(level) = reasoning_effort {
        cmd.arg("--thinking").arg(level);
    }
    cmd.arg("--skill")
        .arg(crate::builtin_skills::resolve_root(&window)?.join("skills"));
    cmd.arg("--append-system-prompt").arg(format!(
        "{}\n\nUse the Catalex MCP tools for document compilation, preview inspection, comments, and questions. Use ask_user when you need the user's input.\n\nYour current working directory is {}. Make project edits in this draft for the user to review; do not modify the original project at {} directly. Previous draft paths in the conversation are historical; use the current working directory.",
        crate::workspace_mcp::comment_guidance(),
        working_directory.display(),
        source_project_path,
    ));
    let mut rpc = Rpc::spawn(cmd)?;
    rpc.events = Some((window.clone(), tab_id.clone()));
    let turn = Arc::new(PiTurn {
        cancel: CancellationToken::new(),
        done: CancellationToken::new(),
        mcp,
        session_file: session_file.to_string_lossy().into(),
    });
    turns.insert(key.clone(), turn.clone());
    drop(turns);
    tokio::spawn(async move {
        let result = tokio::select! {
            biased;
            _ = turn.cancel.cancelled() => Ok(false),
            result = async {
                let state = rpc.request(json!({"type":"get_state"})).await?;
                match operation {
                    PiOperation::Prompt(prompt) => run_turn(&mut rpc, &window, &tab_id, &turn.session_file, &prompt, &state).await,
                    PiOperation::Compact => run_compaction(&mut rpc, &window, &tab_id, &state).await,
                }
            } => result,
        };
        // Turn access is revoked before waiting for a provider to stop.
        drop(access);
        turn.mcp.cancel_turn();
        if turn.cancel.is_cancelled() {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                rpc.send(json!({"type":"abort","id":"catalex-abort"})),
            )
            .await;
        }
        let shutdown = rpc.shutdown().await;
        drop(extension_dir);
        let result = if turn.cancel.is_cancelled() {
            Ok(false)
        } else {
            result.and_then(|success| shutdown.map(|_| success))
        };
        // Completion is emitted before admission is released, so a stale event
        // cannot finish a newly admitted turn on the same tab.
        let mut turns = window.service.pi.turns.lock().await;
        turns.remove(&key);
        if let Err(error) = &result {
            let _ = window.emit("pi-error", json!({"tab_id":tab_id,"data":error}));
        }
        let _ = window.emit(
            "pi-complete",
            json!({"tab_id":tab_id,"success":result.unwrap_or(false)}),
        );
        turn.done.cancel();
    });
    Ok(())
}

fn output(window: &WindowContext, tab: &str, data: Value) {
    let _ = window.emit("pi-output", json!({"tab_id":tab,"data":data.to_string()}));
}
fn activity(window: &WindowContext, tab: &str, kind: &str, item: &str, fields: Value) {
    let mut payload = json!({"tab_id":tab,"kind":kind,"item_id":item});
    if let Some(fields) = fields.as_object() {
        for (key, value) in fields {
            payload[key] = value.clone();
        }
    }
    let _ = window.emit("pi-activity", payload);
}

async fn run_compaction(
    rpc: &mut Rpc,
    window: &WindowContext,
    tab: &str,
    state: &Value,
) -> Result<bool, String> {
    // Unlike setup requests, compact responds only after the model has finished.
    // The owning turn remains cancellable throughout summary generation.
    let result = rpc
        .request_until_response(json!({"type":"compact"}))
        .await?;
    if let Some(tokens) = result["estimatedTokensAfter"].as_u64() {
        output(
            window,
            tab,
            json!({"type":"usage","tokens":tokens,"capacity":state["model"]["contextWindow"]}),
        );
    }
    Ok(true)
}

async fn run_turn(
    rpc: &mut Rpc,
    window: &WindowContext,
    tab: &str,
    session_file: &str,
    prompt: &str,
    state: &Value,
) -> Result<bool, String> {
    let capacity = state["model"]["contextWindow"].as_u64();
    let mut session_emitted = false;
    emit_saved_session(window, tab, session_file, &mut session_emitted);
    // Do not await the prompt response separately: fast models can send all
    // events before it, and acceptance is not turn completion.
    rpc.send(json!({"id":"catalex-prompt","type":"prompt","message":prompt}))
        .await?;
    let mut message_number = 0;
    let turn_id = uuid::Uuid::new_v4().to_string();
    let mut failure = None;
    let mut accepted = false;
    let acceptance_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let record = if accepted {
            rpc.read().await?
        } else {
            tokio::time::timeout_at(acceptance_deadline, rpc.read())
                .await
                .map_err(|_| "Pi did not accept the prompt within 30 seconds".to_string())??
        };
        emit_saved_session(window, tab, session_file, &mut session_emitted);
        let item = format!("{turn_id}-{message_number}");
        match record["type"].as_str().unwrap_or_default() {
            "response" if record["id"] == "catalex-prompt" => {
                let data = response_data(record)?;
                if data["disposition"] == "handled" {
                    return Ok(true);
                }
                accepted = true;
            }
            "response" if record["success"] == false => {
                return response_data(record).map(|_| false);
            }
            "message_start" if record["message"]["role"] == "assistant" => {
                message_number += 1;
            }
            "message_update" => {
                let event = &record["assistantMessageEvent"];
                let kind = match event["type"].as_str() {
                    Some("text_delta") => Some("text_delta"),
                    Some("thinking_delta") => Some("thinking_delta"),
                    _ => None,
                };
                if let Some(kind) = kind {
                    activity(window, tab, kind, &item, json!({"text":event["delta"]}));
                }
                emit_usage(window, tab, &record["usage"], capacity);
            }
            "message_end" if record["message"]["role"] == "assistant" => {
                let message = &record["message"];
                for (kind, text) in final_content(message) {
                    activity(window, tab, kind, &item, json!({"text":text}));
                }
                failure = message_failure(message);
                emit_usage(window, tab, &message["usage"], capacity);
            }
            "tool_execution_start" => activity(
                window,
                tab,
                "tool_started",
                record["toolCallId"].as_str().unwrap_or(&item),
                json!({"name":record["toolName"],"input":record["args"]}),
            ),
            "tool_execution_end" => activity(
                window,
                tab,
                "tool_completed",
                record["toolCallId"].as_str().unwrap_or(&item),
                json!({"name":record["toolName"],"content":record["result"]["content"],"is_error":record["isError"]}),
            ),
            "agent_settled" => {
                return if record["aborted"] == true {
                    Ok(false)
                } else if let Some(error) = failure {
                    Err(error)
                } else {
                    Ok(true)
                }
            }
            "extension_ui_request" => {
                if matches!(
                    record["method"].as_str(),
                    Some("select" | "input" | "editor" | "confirm")
                ) {
                    rpc.decline_extension_ui(&record).await?;
                    return Err("A Pi extension requested an unsupported terminal dialog. Use Catalex's ask_user tool or configure the extension in Pi.".into());
                }
            }
            _ => {}
        }
    }
}
fn emit_saved_session(window: &WindowContext, tab: &str, session_file: &str, emitted: &mut bool) {
    if !*emitted && Path::new(session_file).is_file() {
        output(
            window,
            tab,
            json!({"type":"session","session_id":session_file}),
        );
        *emitted = true;
    }
}
fn final_content(message: &Value) -> Vec<(&'static str, String)> {
    let Some(content) = message["content"].as_array() else {
        return vec![];
    };
    [("text", "text_replace"), ("thinking", "thinking_replace")]
        .into_iter()
        .filter_map(|(field, kind)| {
            let text = content
                .iter()
                .filter(|part| part["type"] == field)
                .filter_map(|part| part[field].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some((kind, text))
        })
        .collect()
}

fn message_failure(message: &Value) -> Option<String> {
    match message["stopReason"].as_str() {
        Some("error" | "aborted") => Some(
            message["errorMessage"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .unwrap_or("Pi could not complete the response")
                .into(),
        ),
        _ => None,
    }
}
fn emit_usage(window: &WindowContext, tab: &str, usage: &Value, capacity: Option<u64>) {
    if !usage.is_object() {
        return;
    }
    let tokens: u64 = ["input", "output", "cacheRead", "cacheWrite"]
        .iter()
        .map(|key| usage[*key].as_u64().unwrap_or(0))
        .sum();
    output(
        window,
        tab,
        json!({"type":"usage","tokens":tokens,"capacity":capacity}),
    );
}

pub async fn cancel_pi_execution(window: WindowContext, tab_id: String) -> Result<(), String> {
    let key = format!("{}:{tab_id}", window.label());
    let turn = window.service.pi.turns.lock().await.get(&key).cloned();
    if let Some(turn) = turn {
        turn.mcp.cancel_turn();
        turn.cancel.cancel();
        tokio::time::timeout(Duration::from_secs(10), turn.done.cancelled())
            .await
            .map_err(|_| "Pi cancellation timed out".to_string())?;
    }
    Ok(())
}
pub async fn kill_process_for_window(state: &PiProcessState, window: &str) {
    let prefix = format!("{window}:");
    let turns: Vec<_> = state
        .turns
        .lock()
        .await
        .iter()
        .filter(|(key, _)| key.starts_with(&prefix))
        .map(|(_, turn)| turn.clone())
        .collect();
    for turn in &turns {
        turn.mcp.cancel_turn();
        turn.cancel.cancel();
    }
    for turn in turns {
        let _ = tokio::time::timeout(Duration::from_secs(10), turn.done.cancelled()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_launcher_finds_its_node_without_changing_selected_path() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("node installation/bin");
        let package = root.path().join("node installation/lib/node_modules/pi");
        let aliases = root.path().join("aliases");
        for folder in [&bin, &package, &aliases] {
            std::fs::create_dir_all(folder).unwrap();
        }
        let cli = package.join("cli.js");
        let node = bin.join("node");
        std::fs::write(&cli, "#!/usr/bin/env node\n").unwrap();
        std::fs::write(&node, "#!/bin/sh\nprintf 'fixture-node\\n'\n").unwrap();
        for file in [&cli, &node] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        symlink("../lib/node_modules/pi/cli.js", bin.join("pi")).unwrap();
        let alias = aliases.join("pi");
        symlink(bin.join("pi"), &alias).unwrap();
        let direct = aliases.join("direct-pi");
        symlink(&cli, &direct).unwrap();
        for selected in [&alias, &direct] {
            let mut cmd = command(selected);
            assert_eq!(cmd.as_std().get_program(), selected.as_os_str());
            // Exclude the test runner's PATH, so a globally installed Node
            // cannot mask a failure to find this installation's runtime.
            cmd.env(
                "PATH",
                std::env::join_paths(launcher_paths(selected)).unwrap(),
            );
            let output = cmd.output().await.unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim(),
                "fixture-node"
            );
        }
        let loop_link = aliases.join("loop");
        symlink("loop", &loop_link).unwrap();
        assert_eq!(launcher_paths(&loop_link).len(), 1);
    }

    #[test]
    fn installation_picker_accepts_launcher_folders_and_prefixes() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        #[cfg(target_os = "windows")]
        let executable = bin.join("pi.cmd");
        #[cfg(not(target_os = "windows"))]
        let executable = bin.join("pi");
        std::fs::write(&executable, "fixture").unwrap();
        for folder in [root.path(), bin.as_path()] {
            let config = PiConfig {
                binary_path: folder.to_string_lossy().into(),
                ..Default::default()
            };
            assert_eq!(config.binary().unwrap(), executable);
        }
        std::fs::remove_file(executable).unwrap();
        let config = PiConfig {
            binary_path: root.path().to_string_lossy().into(),
            ..Default::default()
        };
        assert!(config
            .binary()
            .unwrap_err()
            .contains("this folder or its bin folder"));
    }

    #[test]
    fn selected_paths_are_literal_and_invalid_overrides_never_fall_back() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("pi executable; literal");
        let directory = temp.path().join("custom config");
        std::fs::write(&binary, "fixture").unwrap();
        std::fs::create_dir(&directory).unwrap();
        let mut config = PiConfig {
            binary_path: binary.to_string_lossy().into(),
            config_directory: directory.to_string_lossy().into(),
        };
        let command = config.command().unwrap();
        assert_eq!(command.as_std().get_program(), binary.as_os_str());
        assert!(command
            .as_std()
            .get_envs()
            .any(|(name, value)| name == "PI_CODING_AGENT_DIR"
                && value == Some(directory.as_os_str())));
        config.config_directory = binary.to_string_lossy().into();
        assert!(config.directory().unwrap_err().contains("config folder"));
        config.config_directory = temp.path().join("missing").to_string_lossy().into();
        assert!(config.directory().is_err());
        config.binary_path = temp.path().join("missing").to_string_lossy().into();
        assert!(config
            .binary()
            .unwrap_err()
            .contains("executable not found"));
        config.binary_path = "relative/pi".into();
        assert!(config.binary().unwrap_err().contains("absolute path"));
        assert_eq!(
            expand_path("~/.pi/agent").unwrap(),
            default_agent_dir().unwrap()
        );
    }

    #[test]
    fn pi_skill_catalog_preserves_names_scopes_and_package_paths() {
        let temp = tempfile::tempdir().unwrap();
        let skill = temp.path().join("package/nested/SKILL.md");
        let builtins = temp.path().join("builtins");
        std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
        std::fs::write(&skill, "# Skill preview").unwrap();
        let commands = skills_from_commands(json!({"commands": [
            {"source":"skill", "name":"skill:actual-name", "description":"Package skill",
             "sourceInfo":{"path":skill, "scope":"user"}},
            {"source":"skill", "name":"skill:local", "sourceInfo":{"path":"/project/.agents/skills/local/SKILL.md", "scope":"project"}},
            {"source":"skill", "name":"skill:review-document", "sourceInfo":{"path":builtins.join("review-document/SKILL.md"), "scope":"temporary"}},
            {"source":"prompt", "name":"prompt"}, {"source":"extension", "name":"extension"}
        ]}), &builtins).unwrap();
        assert_eq!(commands.len(), 3);
        assert_eq!(commands[0]["full_command"], "/actual-name");
        assert_eq!(commands[0]["content"], "# Skill preview");
        assert_eq!(commands[0]["skill_scope"], "user");
        assert_eq!(commands[1]["skill_scope"], "project");
        assert_eq!(
            commands[2]["file_path"],
            "catalex://built-in-skills/review-document/SKILL.md"
        );
        assert!(skills_from_commands(json!({}), &builtins).is_err());
    }

    #[test]
    fn records_preserve_unicode_separators_and_reject_garbage() {
        let text = "a\u{2028}b\u{2029}c";
        let line = format!("{}\r\n", json!({"type":"message_update","delta":text}));
        assert_eq!(parse_record(&line).unwrap()["delta"], text);
        for invalid in ["banner\n", "{}\n", "[]\n", "{\"type\":42}\n"] {
            assert!(parse_record(invalid).is_err());
        }
        assert_eq!(
            response_data(json!({"type":"response","success":false,"error":"No API key"}))
                .unwrap_err(),
            "No API key"
        );
    }

    #[test]
    #[cfg(unix)]
    fn new_and_resumed_sessions_share_identity_through_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        let alias = temp.path().join("alias");
        std::fs::create_dir(&sessions).unwrap();
        std::os::unix::fs::symlink(&sessions, &alias).unwrap();
        let new = session_path(&alias, None).unwrap();
        std::fs::write(&new, "fixture").unwrap();
        let aliased_file = alias.join(new.file_name().unwrap());
        assert_eq!(
            new,
            session_path(&sessions, Some(aliased_file.to_str().unwrap())).unwrap()
        );
    }

    #[test]
    fn restores_only_owned_sessions_and_updates_cwd_without_touching_transcript() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = session_path(&sessions, None).unwrap();
        let body = b"\n{\"type\":\"message\",\"id\":\"unchanged\",\"odd spacing\" : true}\n";
        let mut contents = serde_json::to_vec(
            &json!({"type":"session","id":"same-id","cwd":"/removed-draft","version":3}),
        )
        .unwrap();
        contents.extend_from_slice(body);
        std::fs::write(&path, contents).unwrap();
        let canonical = session_path(&sessions, Some(path.to_str().unwrap())).unwrap();
        update_session_cwd(&canonical, "/new-draft").unwrap();
        let after = std::fs::read(&path).unwrap();
        let split = after.iter().position(|b| *b == b'\n').unwrap();
        let header: Value = serde_json::from_slice(&after[..split]).unwrap();
        assert_eq!(header["cwd"], "/new-draft");
        assert_eq!(header["id"], "same-id");
        assert_eq!(&after[split..], body);
        let outside = temp.path().join("user-session.jsonl");
        std::fs::write(&outside, "user content").unwrap();
        assert!(session_path(&sessions, Some(outside.to_str().unwrap())).is_err());
        assert!(session_path(&sessions, Some("missing.jsonl"))
            .unwrap_err()
            .contains("missing"));
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "user content");
    }

    #[test]
    fn final_content_covers_responses_without_deltas() {
        assert_eq!(
            final_content(
                &json!({"content":[{"type":"text","text":"Final answer"},{"type":"thinking","thinking":"Reason"},{"type":"toolCall","name":"read"}]})
            ),
            vec![
                ("text_replace", "Final answer".into()),
                ("thinking_replace", "Reason".into())
            ]
        );
        assert!(final_content(&json!({"content":[]})).is_empty());
    }

    #[test]
    fn model_identity_and_failures_are_explicit() {
        assert_eq!(
            selected_model(Some("[\"custom-provider\",\"model/with/slashes\"]")).unwrap(),
            Some(("custom-provider".into(), "model/with/slashes".into()))
        );
        assert_eq!(selected_model(Some("default")).unwrap(), None);
        for invalid in ["unqualified-model", "[\"\",\"id\"]", "[\"provider\"]"] {
            assert!(selected_model(Some(invalid)).is_err());
        }
        assert!(supported_version("1.2.0"));
        assert!(!supported_version("0.61.0"));
        assert_eq!(
            message_failure(&json!({"stopReason":"error","errorMessage":"Quota exceeded"})),
            Some("Quota exceeded".into())
        );
        assert!(message_failure(&json!({"stopReason":"stop"})).is_none());
    }

    #[cfg(unix)]
    fn fixture(script: &str) -> Rpc {
        let mut cmd = command(Path::new("/bin/sh"));
        cmd.args(["-c", script]);
        Rpc::spawn(cmd).unwrap()
    }

    #[cfg(unix)]
    fn window(temp: &tempfile::TempDir) -> WindowContext {
        WindowContext {
            id: "pi-test".into(),
            service: Arc::new(crate::host::ServiceState {
                data_dir: temp.path().join("data"),
                cache_dir: temp.path().join("cache"),
                resource_dir: temp.path().join("resources"),
                claude: Default::default(),
                codex: Default::default(),
                pi: Default::default(),
                latex: Default::default(),
                verification: Default::default(),
                comments: Default::default(),
                project_files: Default::default(),
                questions: Default::default(),
                zotero: Default::default(),
            }),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_split_records_and_cleanly_closes_rpc_process() {
        let mut rpc = fixture("printf '%s' '{\"type\":\"response\",'; printf '%s\r\n' '\"id\":\"catalex-1\",\"success\":true,\"data\":{\"ok\":true}}'; cat >/dev/null");
        assert_eq!(
            rpc.request(json!({"type":"get_state"})).await.unwrap()["ok"],
            true
        );
        rpc.shutdown().await.unwrap();
        assert!(rpc.child.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_reports_hook_errors_but_chat_keeps_native_nonfatal_behavior() {
        let script = r#"read request
printf '%s\n' '{"type":"extension_error","event":"session_start","extensionPath":"/config/test.ts","error":"Hook failed"}' '{"type":"response","id":"catalex-1","success":true,"data":{"ok":true}}'
cat >/dev/null"#;
        let mut discovery = fixture(script);
        let error = discovery
            .request(json!({"type":"get_state"}))
            .await
            .unwrap_err();
        assert!(error.contains("Hook failed"));
        assert!(error.contains("/config/test.ts"));
        discovery.shutdown().await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mut chat = fixture(script);
        chat.events = Some((window(&temp), "tab".into()));
        assert_eq!(
            chat.request(json!({"type":"get_state"})).await.unwrap()["ok"],
            true
        );
        chat.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prompt_ack_and_agent_end_do_not_hide_later_provider_failure() {
        let temp = tempfile::tempdir().unwrap();
        let mut rpc = fixture(
            r#"
read state
printf '%s\n' '{"type":"response","id":"catalex-1","success":true,"data":{"model":{"contextWindow":200000}}}'
read prompt
printf '%s\n' '{"type":"response","id":"catalex-prompt","success":true,"data":{"disposition":"started"}}' '{"type":"agent_end"}' '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"No credentials"}}' '{"type":"agent_settled","aborted":false}'
cat >/dev/null
"#,
        );
        let state = rpc.request(json!({"type":"get_state"})).await.unwrap();
        let result = run_turn(&mut rpc, &window(&temp), "tab", "/session", "hello", &state).await;
        assert_eq!(result.unwrap_err(), "No credentials");
        rpc.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_interrupts_pending_read_and_reaps_process() {
        let mut rpc = fixture("cat >/dev/null");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let cancelled = tokio::select! {
            biased;
            _ = cancel.cancelled() => true,
            _ = rpc.read() => false,
        };
        assert!(cancelled);
        rpc.send(json!({"type":"abort"})).await.unwrap();
        rpc.shutdown().await.unwrap();
        assert!(rpc.child.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unexpected_exit_and_rejected_command_are_errors() {
        let mut rpc = fixture("printf '%s\n' 'fatal startup error' >&2; exit 1");
        assert!(rpc.read().await.unwrap_err().contains("closed"));
        assert!(rpc.shutdown().await.is_err());
        let mut rpc = fixture("read request; printf '%s\n' '{\"type\":\"response\",\"id\":\"catalex-1\",\"success\":false,\"error\":\"bad model\"}'; cat >/dev/null");
        assert_eq!(
            rpc.request(json!({"type":"set_model"})).await.unwrap_err(),
            "bad model"
        );
        rpc.shutdown().await.unwrap();
    }
}
