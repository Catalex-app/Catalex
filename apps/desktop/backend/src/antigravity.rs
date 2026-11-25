use crate::{
    agent_prompt::{system_prompt, Provider},
    agent_questions,
    host::WindowContext,
    verification::VerificationContext,
    workspace_mcp::WorkspaceMcp,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct AntigravityProcessState {
    turns: Mutex<HashMap<(String, String), Arc<Turn>>>,
}

struct Turn {
    session: std::sync::Mutex<Option<String>>,
    cancel: CancellationToken,
    done: CancellationToken,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    binary_path: String,
    project_path: String,
    source_project_path: String,
    runtime_session_key: String,
    session_id: Option<String>,
    tab_id: String,
    prompt: String,
    model: Option<String>,
    thinking_effort: Option<String>,
    compile_context: Option<VerificationContext>,
}

fn binary(custom_path: &str) -> Result<PathBuf, String> {
    if !custom_path.is_empty() {
        let path = PathBuf::from(custom_path);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err("Choose an existing Antigravity executable.".into());
    }
    let mut locations = Vec::new();
    if let Some(home) = dirs::home_dir() {
        locations.push(home.join(".local/bin/agy"));
    }
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        locations.push(PathBuf::from(local).join("agy/bin/agy.exe"));
    }
    which::which("agy")
        .ok()
        .or_else(|| locations.into_iter().find(|path| path.is_file()))
        .ok_or_else(|| "Install Antigravity CLI in your terminal, then check again.".into())
}

// Give agy a workspace root for Catalex's instructions and packaged skills.
// The generated resources stay outside the draft and live for this turn.
fn stage_customizations(window: &WindowContext) -> Result<tempfile::TempDir, String> {
    fn copy_directory(source: &Path, target: &Path) -> io::Result<()> {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let target = target.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                copy_directory(&entry.path(), &target)?;
            } else if kind.is_file() {
                fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }

    let source = crate::builtin_skills::resolve_root(window)?.join("skills");
    let root = tempfile::tempdir().map_err(|error| error.to_string())?;
    let agents = root.path().join(".agents");
    let rules = agents.join("rules");
    fs::create_dir_all(&rules)
        .and_then(|_| {
            fs::write(
                rules.join("catalex.md"),
                format!(
                    "---\ntrigger: always_on\n---\n{}\n",
                    system_prompt(Provider::Antigravity)
                ),
            )
        })
        .map_err(|_| "Could not prepare the Catalex workspace rules for Antigravity.")?;
    let target = agents.join("skills");
    for name in crate::builtin_skills::NAMES {
        copy_directory(&source.join(name), &target.join(name))
            .map_err(|_| format!("Could not prepare the built-in {name} skill for Antigravity."))?;
    }
    Ok(root)
}

struct Acp {
    child: Child,
    stdin: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    pending_permission: Option<Value>,
}

impl Acp {
    fn spawn(binary: &Path, cwd: &Path, customization_root: Option<&Path>) -> Result<Self, String> {
        let mut cmd = Command::new(binary);
        cmd.args(["acp", "--process-per-session", "--sandbox", "--log-file"])
            .arg(if cfg!(windows) { "NUL" } else { "/dev/null" })
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(customization_root) = customization_root {
            cmd.arg("--add-dir").arg(customization_root);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        let mut child = cmd
            .spawn()
            .map_err(|_| "Could not launch Antigravity CLI.")?;
        let stdin = child.stdin.take().ok_or("Antigravity has no input pipe.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Antigravity has no output pipe.")?;
        Ok(Self {
            child,
            stdin,
            output: BufReader::new(stdout).lines(),
            next_id: 0,
            pending_permission: None,
        })
    }

    async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&value).map_err(|_| "Invalid Antigravity request.")?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .await
            .map_err(|_| "Antigravity connection closed.".into())
    }

    async fn read(&mut self) -> Result<Value, String> {
        let line = self
            .output
            .next_line()
            .await
            .map_err(|_| "Could not read the Antigravity response.")?
            .ok_or("Antigravity connection closed.")?;
        serde_json::from_str(&line).map_err(|_| "Antigravity returned invalid ACP data.".into())
    }

    async fn start(&mut self, method: &str, params: Value) -> Result<u64, String> {
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0", "id":self.next_id, "method":method, "params":params}))
            .await?;
        Ok(self.next_id)
    }

    async fn reject_request(&mut self, row: &Value) -> Result<(), String> {
        self.send(json!({"jsonrpc":"2.0", "id":row["id"],
            "error":{"code":-32601, "message":"Unsupported Catalex ACP client method"}}))
            .await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        tokio::time::timeout(Duration::from_secs(30), async {
            let id = self.start(method, params).await?;
            loop {
                let row = self.read().await?;
                if row.get("method").is_some() && row.get("id").is_some() {
                    if row["method"] == "session/request_permission" {
                        self.send(reply(&row, None)).await?;
                    } else {
                        self.reject_request(&row).await?;
                    }
                } else if row["id"].as_u64() == Some(id) {
                    return response(&row, method);
                }
            }
        })
        .await
        .map_err(|_| format!("Antigravity timed out during {method}."))?
    }

    async fn initialize(&mut self) -> Result<Value, String> {
        let info = self.request("initialize", json!({
            "protocolVersion":1, "clientCapabilities":{},
            "clientInfo":{"name":concat!(env!("APP_BRAND_NAMESPACE"), "-editor"),"version":env!("CARGO_PKG_VERSION")}
        })).await?;
        let capabilities = &info["agentCapabilities"];
        if info["protocolVersion"] != 1
            || capabilities["mcpCapabilities"]["http"] != true
            || capabilities["sessionCapabilities"].get("resume").is_none()
        {
            return Err(
                "Update Antigravity CLI to a version with ACP session resume and HTTP MCP.".into(),
            );
        }
        Ok(info)
    }

    async fn shutdown(mut self) -> Result<(), String> {
        drop(self.stdin);
        if matches!(
            tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await,
            Ok(Ok(_))
        ) {
            return Ok(());
        }
        if let Some(pid) = self.child.id() {
            #[cfg(unix)]
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .status()
                .await;
            #[cfg(windows)]
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .status()
                .await;
        }
        self.child
            .kill()
            .await
            .map_err(|_| "Could not stop Antigravity.".into())
    }
}

fn response(row: &Value, method: &str) -> Result<Value, String> {
    if let Some(result) = row.get("result") {
        return Ok(result.clone());
    }
    // ACP errors can contain data from user settings or tools. Keep only the code.
    let code = row["error"]["code"].as_i64();
    let message = row["error"]["message"].as_str().unwrap_or_default();
    if code == Some(-32000) && message.to_ascii_lowercase().contains("authenticat") {
        return Err(
            "Sign in to Antigravity by running agy in your terminal, then try again.".into(),
        );
    }
    Err(format!(
        "Antigravity could not complete {method} (ACP error {}).",
        code.map_or_else(|| "unknown".into(), |code| code.to_string())
    ))
}

pub async fn check_status(binary_path: String) -> Result<Value, String> {
    let binary = binary(&binary_path)?;
    let directory = tempfile::tempdir().map_err(|_| "Could not prepare Antigravity setup.")?;
    let mut acp = Acp::spawn(&binary, directory.path(), None)?;
    let result = acp.initialize().await;
    acp.shutdown().await?;
    let info = result?;
    Ok(json!({"version":info["agentInfo"]["version"],"binaryPath":binary}))
}

fn output(window: &WindowContext, event: &str, tab: &str, fields: Value) {
    let mut payload = fields;
    payload["tab_id"] = json!(tab);
    let _ = window.emit(event, payload);
}

fn select_values(option: &Value) -> impl Iterator<Item = &Value> {
    option["options"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry["options"]
                .as_array()
                .map_or_else(|| std::slice::from_ref(entry), Vec::as_slice)
        })
}

fn options(window: &WindowContext, tab: &str, value: &Value) {
    if let Some(options) = value.get("configOptions").and_then(Value::as_array) {
        let list: Vec<_> = options.iter()
            .filter(|option| matches!(option["category"].as_str(), Some("model" | "thought_level")))
            .map(|option| {
                let options: Vec<_> = select_values(option)
                    .filter(|item| item["value"].is_string() && item["name"].is_string())
                    .map(|item| json!({"value":item["value"],"name":item["name"],"description":item["description"]}))
                    .collect();
                json!({"category":option["category"],"currentValue":option["currentValue"],"options":options})
            }).collect();
        output(window, "antigravity-options", tab, json!({"options":list}));
    }
}

async fn configure(
    acp: &mut Acp,
    session: &str,
    key: &str,
    value: Option<&str>,
    config: &mut Value,
) -> Result<(), String> {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        if let Some(option) = config["configOptions"]
            .as_array()
            .and_then(|options| options.iter().find(|option| option["category"] == key))
        {
            if option["currentValue"] != value
                && select_values(option).any(|item| item["value"] == value)
            {
                *config = acp
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId":session, "configId":option["id"], "value":value
                        }),
                    )
                    .await?;
            }
        }
    }
    Ok(())
}

fn reply(row: &Value, selection: Option<&Value>) -> Value {
    let outcome = selection.map_or_else(
        || json!({"outcome":"cancelled"}),
        |id| json!({"outcome":"selected","optionId":id}),
    );
    json!({"jsonrpc":"2.0","id":row["id"],"result":{"outcome":outcome}})
}

async fn permission(window: &WindowContext, turn: &Turn, args: &TurnRequest, row: &Value) -> Value {
    let params = &row["params"];
    let tool = &params["toolCall"];
    let mut choices = Vec::new();
    for (kind, label) in [
        ("reject_once", "Deny"),
        ("allow_once", "Approve once"),
        ("reject_always", "Always deny"),
        ("allow_always", "Always approve"),
    ] {
        if let Some(option) = params["options"]
            .as_array()
            .and_then(|options| options.iter().find(|option| option["kind"] == kind))
            .filter(|option| option["optionId"].is_string())
        {
            choices.push((label, option["optionId"].clone()));
        }
    }
    // Older agents may omit a reject option. The cancelled result denies the action.
    if choices.len() == 1 {
        choices.insert(0, ("Cancel", Value::Null));
    }
    let title = tool["title"].as_str().unwrap_or("use this tool");
    let details = tool
        .get("rawInput")
        .or_else(|| tool.get("locations"))
        .and_then(|value| serde_json::to_string_pretty(value).ok());
    let question = json!({
        "permission":true,
        "question":format!("Allow Antigravity to {}?", title.chars().take(400).collect::<String>()),
        "details":details.map(|text| text.chars().take(32_000).collect::<String>()),
        "options":choices.iter().map(|(label, _)| json!({"label":label})).collect::<Vec<_>>(),
    });
    let answer = agent_questions::ask(
        window,
        &args.tab_id,
        &args.runtime_session_key,
        &args.source_project_path,
        question,
        &turn.cancel,
    )
    .await
    .ok();
    let selection = answer
        .as_ref()
        .and_then(|answer| choices.iter().find(|(label, _)| answer["answer"] == *label))
        .map(|(_, id)| id)
        .filter(|id| id.is_string());
    reply(row, selection)
}

fn activity(
    window: &WindowContext,
    tab: &str,
    chunk_id: &mut String,
    tools: &mut HashSet<String>,
    update: &Value,
) {
    let payload = match update["sessionUpdate"].as_str() {
        Some("agent_message_chunk" | "agent_thought_chunk") => {
            let kind = if update["sessionUpdate"] == "agent_message_chunk" {
                "text_delta"
            } else {
                "thinking_delta"
            };
            json!({"kind":kind, "item_id":chunk_id, "text":update["content"]["text"]})
        }
        Some("tool_call" | "tool_call_update") => {
            let Some(tool_id) = update["toolCallId"].as_str() else {
                return;
            };
            let kind = match update["status"].as_str() {
                Some("completed" | "failed") => "tool_completed",
                _ if tools.insert(tool_id.into()) => "tool_started",
                _ => return,
            };
            if kind == "tool_completed" {
                *chunk_id = uuid::Uuid::new_v4().to_string();
            }
            json!({"kind":kind, "item_id":tool_id, "name":update["title"], "input":update["rawInput"],
                "content":update["rawOutput"], "is_error":update["status"] == "failed"})
        }
        Some("config_option_update") => {
            options(window, tab, update);
            return;
        }
        _ => return,
    };
    output(window, "antigravity-activity", tab, payload);
}

async fn run_turn(
    acp: &mut Acp,
    window: &WindowContext,
    turn: &Turn,
    args: &TurnRequest,
    connection: &WorkspaceMcp,
    session: &mut Option<String>,
) -> Result<bool, String> {
    acp.initialize().await?;
    let mut params = json!({
        "cwd":args.project_path,
        "mcpServers":[{
            "type":"http", "name":crate::branding::NAMESPACE, "url":connection.settings.url,
            "headers":connection.settings.headers.iter().map(|(name, value)| json!({"name":name, "value":value})).collect::<Vec<_>>()
        }]
    });
    let mut config = if let Some(id) = &args.session_id {
        params["sessionId"] = json!(id);
        let config = acp.request("session/resume", params).await?;
        *session = Some(id.clone());
        config
    } else {
        let config = acp.request("session/new", params).await?;
        *session = Some(
            config["sessionId"]
                .as_str()
                .ok_or("Antigravity did not return a session ID.")?
                .into(),
        );
        config
    };
    let session = session
        .as_deref()
        .ok_or("Antigravity did not open a session.")?;
    *turn.session.lock().unwrap() = Some(session.into());
    options(window, &args.tab_id, &config);
    configure(acp, session, "model", args.model.as_deref(), &mut config).await?;
    configure(
        acp,
        session,
        "thought_level",
        args.thinking_effort.as_deref(),
        &mut config,
    )
    .await?;
    options(window, &args.tab_id, &config);
    let id = acp
        .start(
            "session/prompt",
            json!({
                "sessionId":session,"prompt":[{"type":"text","text":args.prompt}]
            }),
        )
        .await?;
    output(
        window,
        "antigravity-session",
        &args.tab_id,
        json!({"sessionId":session}),
    );
    let mut chunk_id = uuid::Uuid::new_v4().to_string();
    let mut tools = HashSet::new();
    loop {
        let row = acp.read().await?;
        match row["method"].as_str() {
            Some("session/update") if row["params"]["sessionId"] == session => {
                activity(
                    window,
                    &args.tab_id,
                    &mut chunk_id,
                    &mut tools,
                    &row["params"]["update"],
                );
            }
            Some("session/request_permission") if row["params"]["sessionId"] == session => {
                acp.pending_permission = Some(row["id"].clone());
                acp.send(permission(window, turn, args, &row).await).await?;
                acp.pending_permission = None;
            }
            Some(_) if row.get("id").is_some() => acp.reject_request(&row).await?,
            None if row["id"].as_u64() == Some(id) => {
                return Ok(response(&row, "session/prompt")?["stopReason"] != "cancelled");
            }
            _ => {}
        }
    }
}

pub async fn start_turn(window: WindowContext, args: TurnRequest) -> Result<(), String> {
    let executable = binary(&args.binary_path)?;
    let key = (window.label().to_owned(), args.tab_id.clone());
    let mut turns = window.service.antigravity.turns.lock().await;
    if turns.contains_key(&key)
        || args.session_id.as_ref().is_some_and(|id| {
            turns
                .values()
                .any(|turn| turn.session.lock().unwrap().as_ref() == Some(id))
        })
    {
        return Err("This Antigravity conversation already has an active turn.".into());
    }
    let customizations = stage_customizations(&window)?;
    let mut acp = Acp::spawn(
        &executable,
        Path::new(&args.project_path),
        Some(customizations.path()),
    )?;
    let connection = WorkspaceMcp::start(
        window.clone(),
        args.tab_id.clone(),
        args.source_project_path.clone(),
        crate::comments::AgentOrigin {
            provider: "antigravity".into(),
            session_id: args.runtime_session_key.clone(),
            model: None,
            thinking_effort: None,
        },
    )
    .await?;
    let access = connection.begin_turn_with_model(
        args.project_path.clone(),
        args.compile_context.clone(),
        args.model.clone(),
        args.thinking_effort.clone(),
    )?;
    let turn = Arc::new(Turn {
        session: std::sync::Mutex::new(args.session_id.clone()),
        cancel: CancellationToken::new(),
        done: CancellationToken::new(),
    });
    turns.insert(key.clone(), turn.clone());
    drop(turns);
    tokio::spawn(async move {
        let mut session = None;
        let result = tokio::select! {
            biased;
            _ = turn.cancel.cancelled() => Ok(false),
            result = run_turn(&mut acp, &window, &turn, &args, &connection, &mut session) => result,
        };
        drop(access);
        if turn.cancel.is_cancelled() {
            if let Some(session) = session {
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    acp.send(json!({
                        "jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}
                    }))
                    .await?;
                    if let Some(id) = acp.pending_permission.take() {
                        acp.send(reply(&json!({"id":id}), None)).await?;
                    }
                    Ok::<_, String>(())
                })
                .await;
            }
        }
        let shutdown = acp.shutdown().await;
        drop(customizations);
        let result = result.and_then(|success| shutdown.map(|_| success));
        let mut turns = window.service.antigravity.turns.lock().await;
        if let Err(error) = &result {
            output(
                &window,
                "antigravity-error",
                &args.tab_id,
                json!({"data":error}),
            );
        }
        output(
            &window,
            "antigravity-complete",
            &args.tab_id,
            json!({"success":result.unwrap_or(false)}),
        );
        turns.remove(&key);
        turn.done.cancel();
    });
    Ok(())
}

pub async fn cancel(window: WindowContext, tab: String) -> Result<(), String> {
    let turn = window
        .service
        .antigravity
        .turns
        .lock()
        .await
        .get(&(window.label().into(), tab))
        .cloned();
    if let Some(turn) = turn {
        turn.cancel.cancel();
        tokio::time::timeout(Duration::from_secs(8), turn.done.cancelled())
            .await
            .map_err(|_| "Antigravity cancellation timed out.")?;
    }
    Ok(())
}

pub async fn close_window(state: &AntigravityProcessState, window: &str) {
    let turns: Vec<_> = state
        .turns
        .lock()
        .await
        .iter()
        .filter(|((owner, _), _)| owner == window)
        .map(|(_, turn)| turn.clone())
        .collect();
    for turn in &turns {
        turn.cancel.cancel();
    }
    for turn in turns {
        let _ = tokio::time::timeout(Duration::from_secs(8), turn.done.cancelled()).await;
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn fake_acp_reuses_the_session_in_a_new_draft_and_answers_permissions() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let fake = root.join("test agy");
        std::fs::write(
            &fake,
            r#"#!/bin/sh
case " $* " in *' --dangerously-skip-permissions '*) exit 13;; esac
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"version":"test"},"agentCapabilities":{"mcpCapabilities":{"http":true},"sessionCapabilities":{"resume":{}}}}}' ;;
    *'"method":"session/new"'*)
      case "$PWD" in */first) ;; *) exit 14;; esac
      case "$line" in *'"type":"http"'*'"Authorization"'*|*'"Authorization"'*'"type":"http"'*) ;; *) exit 15;; esac
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"same-session","configOptions":[]}}' ;;
    *'"method":"session/resume"'*)
      case "$PWD" in */second) ;; *) exit 16;; esac
      case "$line" in *'"sessionId":"same-session"'*) ;; *) exit 17;; esac
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"configOptions":[]}}' ;;
    *'"method":"session/prompt"'*)
      case "$line" in *'"text":"Fixture prompt"'*) ;; *) exit 19 ;; esac
      printf '%s\n' '{"jsonrpc":"2.0","id":"tool-1","method":"session/request_permission","params":{"sessionId":"same-session","toolCall":{"title":"read fixture"},"options":[{"kind":"allow_once","optionId":"allow"},{"kind":"reject_once","optionId":"deny"}]}}' ;;
    *'"id":"tool-1"'*'"optionId":"allow"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"same-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Fixture reply"}}}}' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}' ;;
    *'"method":"session/cancel"'*) exit 0 ;;
    *) exit 18 ;;
  esac
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        let service = Arc::new(crate::host::ServiceState {
            data_dir: root.clone(),
            cache_dir: root.clone(),
            resource_dir: Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
            claude: Default::default(),
            codex: Default::default(),
            pi: Default::default(),
            antigravity: Default::default(),
            latex: Default::default(),
            verification: Default::default(),
            comments: Default::default(),
            project_files: Default::default(),
            questions: Default::default(),
            zotero: Default::default(),
        });
        let window = WindowContext {
            service,
            id: "test".into(),
        };
        let status = check_status(fake.to_string_lossy().into()).await.unwrap();
        assert_eq!(status["version"], "test");

        let customizations = stage_customizations(&window).unwrap();
        let staged = customizations.path().to_path_buf();
        assert_eq!(
            fs::read_to_string(staged.join(".agents/rules/catalex.md")).unwrap(),
            format!(
                "---\ntrigger: always_on\n---\n{}\n",
                system_prompt(Provider::Antigravity)
            )
        );
        assert!(staged
            .join(".agents/skills/catalex-guide/docs/agents.md")
            .is_file());
        for name in crate::builtin_skills::NAMES {
            assert!(staged
                .join(".agents/skills")
                .join(name)
                .join("SKILL.md")
                .is_file());
        }

        for (draft, previous) in [("first", None), ("second", Some("same-session"))] {
            let path = root.join(draft);
            std::fs::create_dir(&path).unwrap();
            let args = TurnRequest {
                binary_path: fake.to_string_lossy().into(),
                project_path: path.to_string_lossy().into(),
                source_project_path: root.to_string_lossy().into(),
                runtime_session_key: "runtime".into(),
                session_id: previous.map(str::to_string),
                tab_id: "tab".into(),
                prompt: "Fixture prompt".into(),
                model: None,
                thinking_effort: None,
                compile_context: None,
            };
            let turn = Turn {
                session: std::sync::Mutex::new(args.session_id.clone()),
                cancel: CancellationToken::new(),
                done: CancellationToken::new(),
            };
            let connection = crate::workspace_mcp::tests::fixture().await;
            let _access = connection
                .begin_turn(args.project_path.clone(), None)
                .unwrap();
            let mut acp = Acp::spawn(&fake, &path, Some(customizations.path())).unwrap();
            let mut session = None;
            let answer = async {
                loop {
                    let questions = agent_questions::list_agent_questions(window.clone());
                    if let Some(question) = questions.into_iter().next() {
                        let question = serde_json::to_value(question).unwrap();
                        assert_eq!(question["permission"], true);
                        agent_questions::answer_agent_question(
                            window.clone(),
                            question["requestId"].as_str().unwrap().into(),
                            "tab".into(),
                            "runtime".into(),
                            "Approve once".into(),
                        )
                        .unwrap();
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
                tokio::join!(
                    run_turn(&mut acp, &window, &turn, &args, &connection, &mut session),
                    answer
                )
            })
            .await
            .expect("fake ACP answered the turn");
            assert!(result.unwrap());
            assert_eq!(session.as_deref(), Some("same-session"));
            acp.shutdown().await.unwrap();
        }
        drop(customizations);
        assert!(!staged.exists());
    }

    #[test]
    fn errors_exclude_wire_details_and_permission_cancellation_denies() {
        let error = response(&json!({"error":{"code":-32000,"message":"Authentication required","data":{"opaque":"private"}}}), "session/new").unwrap_err();
        assert!(error.contains("Sign in"));
        assert!(!error.contains("private"));
        assert_eq!(
            reply(&json!({"id":7}), None)["result"]["outcome"]["outcome"],
            "cancelled"
        );
    }
}
