//! Explicit RPC routing: argument names match the public desktop API.
use crate::{
    host::{write_binary_message, write_message, ServiceContext, ServiceState, WindowContext},
    *,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    window_id: String,
    command: String,
    #[serde(default)]
    binary_response: bool,
    #[serde(default)]
    args: Value,
}

fn argument<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, Value> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|error| json!(format!("Invalid argument {name}: {error}")))
}

fn value<T: Serialize>(result: T) -> Result<Value, Value> {
    serde_json::to_value(result).map_err(|error| json!(error.to_string()))
}

fn result<T: Serialize, E: Serialize>(result: Result<T, E>) -> Result<Value, Value> {
    match result {
        Ok(output) => value(output),
        Err(error) => {
            Err(serde_json::to_value(error).unwrap_or_else(|error| json!(error.to_string())))
        }
    }
}

fn git_task<T>(window: &WindowContext, action: impl FnOnce() -> T) -> T {
    tokio::task::block_in_place(|| git_credentials::with_window(window.clone(), action))
}

async fn compile_pdf(window: WindowContext, args: &Value, snapshot: bool) -> Result<Vec<u8>, Value> {
    let state = window.service.latex.clone();
    latex::compile_latex(
        window,
        &state,
        argument(args, "projectDir")?,
        argument(args, "mainFile")?,
        argument(args, "backend")?,
        argument(args, "engine")?,
        argument::<ChannelId>(args, "diagnostics")?.__channel,
        argument(args, "installation")?,
        if snapshot { Some(argument(args, "snapshotPath")?) } else { None },
        argument(args, "compilationId")?,
    )
    .await
    .map_err(|error| serde_json::to_value(error).unwrap_or_else(|error| json!(error.to_string())))
}

async fn dispatch(
    service: ServiceContext,
    window_id: String,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    let window = WindowContext {
        service: service.clone(),
        id: window_id,
    };
    let tracking_service = service.clone();
    let tracks_git_files = matches!(command,
        "git_panel_checkout_branch" | "git_panel_rebase_onto" | "git_panel_continue_rebase" |
        "git_panel_pull" | "git_panel_pull_flow" | "git_panel_stash" | "git_panel_stash_apply" |
        "git_panel_stash_pop" | "git_panel_abort_operation" | "git_panel_reset_selected" |
        "git_panel_reset_all" | "git_panel_resolve_conflict" | "git_panel_reopen_conflict" |
        "git_panel_resolve_conflict_side");
    let _tracking_guard = if tracks_git_files { Some(tracking_service.comments.lock_project(argument::<String>(&args, "projectRoot")?).await.map_err(|e| json!(e))?) } else { None };
    let tracking = if tracks_git_files {
        let root: String = argument(&args, "projectRoot")?;
        Some(comments::begin_known_edit(&tracking_service, &root).map_err(|e| json!(e))?)
    } else { None };
    let mut outcome = match command {
        "__ping" => Ok(json!({"version": env!("CARGO_PKG_VERSION")})),
        "__close_window" => {
            service.close_window(window.label()).await;
            Ok(Value::Null)
        }
        "slash_commands_list"
            if argument::<Option<String>>(&args, "provider")?.as_deref() == Some("pi") =>
        {
            result(
                pi::list_pi_skills(
                    window,
                    argument::<Option<pi::PiConfig>>(&args, "piConfig")?.unwrap_or_default(),
                )
                .await,
            )
        }
        "slash_commands_list" => result(
            slash_commands::slash_commands_list(
                argument(&args, "projectPath")?,
                argument(&args, "provider")?,
            )
            .await,
        ),
        "slash_command_get" => {
            result(slash_commands::slash_command_get(argument(&args, "commandId")?).await)
        }
        "list_claude_models" => result(claude::list_claude_models(window).await),
        "read_claude_subscription_usage" => {
            result(claude::read_claude_subscription_usage(window).await)
        }
        "verify_claude_model" => {
            result(claude::verify_claude_model(window, argument(&args, "modelId")?).await)
        }
        "check_claude_status" => result(claude::check_claude_status().await),
        "install_claude_cli" => result(claude::install_claude_cli(window).await),
        "login_claude" => result(claude::login_claude(window).await),
        "compact_claude_session" => result(claude::compact_claude_session(
            window, argument(&args, "projectPath")?, argument(&args, "sourceProjectPath")?,
            argument(&args, "sessionId")?, argument(&args, "tabId")?,
            argument(&args, "runtimeSessionKey")?, argument(&args, "model")?,
            argument(&args, "effortLevel")?,
        ).await),
        "compact_codex_session" => result(codex::compact_codex_session(
            window, argument(&args, "projectPath")?, argument(&args, "sourceProjectPath")?,
            argument(&args, "runtimeSessionKey")?, argument(&args, "sessionId")?,
            argument(&args, "tabId")?, argument(&args, "model")?,
            argument(&args, "reasoningEffort")?,
        ).await),
        "execute_claude_code" => result(
            claude::execute_claude_code(
                window,
                argument(&args, "projectPath")?,
                argument(&args, "sourceProjectPath")?,
                argument(&args, "prompt")?,
                argument(&args, "tabId")?,
                argument(&args, "runtimeSessionKey")?,
                argument(&args, "model")?,
                argument(&args, "effortLevel")?,
                argument(&args, "compileContext")?,
            )
            .await,
        ),
        "continue_claude_code" => result(
            claude::continue_claude_code(
                window,
                argument(&args, "projectPath")?,
                argument(&args, "sourceProjectPath")?,
                argument(&args, "prompt")?,
                argument(&args, "tabId")?,
                argument(&args, "runtimeSessionKey")?,
                argument(&args, "model")?,
                argument(&args, "effortLevel")?,
                argument(&args, "compileContext")?,
            )
            .await,
        ),
        "resume_claude_code" => result(
            claude::resume_claude_code(
                window,
                argument(&args, "projectPath")?,
                argument(&args, "sourceProjectPath")?,
                argument(&args, "sessionId")?,
                argument(&args, "prompt")?,
                argument(&args, "tabId")?,
                argument(&args, "runtimeSessionKey")?,
                argument(&args, "model")?,
                argument(&args, "effortLevel")?,
                argument(&args, "compileContext")?,
            )
            .await,
        ),
        "cancel_claude_execution" => {
            result(claude::cancel_claude_execution(window, argument(&args, "tabId")?).await)
        }
        "dispose_claude_session" => {
            result(claude::dispose_claude_session(window, argument(&args, "tabId")?).await)
        }
        "list_claude_sessions" => {
            result(claude::list_claude_sessions(argument(&args, "projectPath")?).await)
        }
        "load_session_history" => result(
            claude::load_session_history(
                argument(&args, "projectPath")?,
                argument(&args, "sessionId")?,
            )
            .await,
        ),
        "get_claude_fast_mode" => result(claude::get_claude_fast_mode().await),
        "set_claude_fast_mode" => {
            result(claude::set_claude_fast_mode(argument(&args, "enabled")?).await)
        }
        "resolve_verification_render_request" => result(
            verification::resolve_verification_render_request(
                &service.verification,
                argument(&args, "requestId")?,
                argument(&args, "result")?,
            )
            .await,
        ),
        "check_pi_status" => result(
            pi::check_pi_status(
                argument::<Option<pi::PiConfig>>(&args, "piConfig")?.unwrap_or_default(),
            )
            .await,
        ),
        "list_pi_models" => result(
            pi::list_pi_models(
                window,
                argument::<Option<pi::PiConfig>>(&args, "piConfig")?.unwrap_or_default(),
            )
            .await,
        ),
        "execute_pi_code" | "resume_pi_code" | "compact_pi_session" => result(
            pi::start_pi_turn(
                window,
                argument::<Option<pi::PiConfig>>(&args, "piConfig")?.unwrap_or_default(),
                argument(&args, "projectPath")?,
                argument(&args, "sourceProjectPath")?,
                argument(&args, "runtimeSessionKey")?,
                if command != "execute_pi_code" {
                    Some(argument(&args, "sessionId")?)
                } else {
                    None
                },
                if command == "compact_pi_session" {
                    pi::PiOperation::Compact
                } else {
                    pi::PiOperation::Prompt(argument(&args, "prompt")?)
                },
                argument(&args, "tabId")?,
                argument(&args, "model")?,
                argument(&args, "reasoningEffort")?,
                argument(&args, "compileContext")?,
            )
            .await,
        ),
        "cancel_pi_execution" | "dispose_pi_session" => {
            result(pi::cancel_pi_execution(window, argument(&args, "tabId")?).await)
        }
        "check_codex_status" => result(codex::check_codex_status().await),
        "list_codex_models" => result(codex::list_codex_models(window).await),
        "read_codex_subscription_usage" => {
            result(codex::read_codex_subscription_usage(window).await)
        }
        "verify_codex_model" => {
            result(codex::verify_codex_model(argument(&args, "modelId")?).await)
        }
        "login_codex" => result(codex::login_codex(window).await),
        "execute_codex_code" => result(
            codex::execute_codex_code(
                window,
                argument(&args, "projectPath")?,
                argument(&args, "sourceProjectPath")?,
                argument(&args, "runtimeSessionKey")?,
                argument(&args, "prompt")?,
                argument(&args, "tabId")?,
                argument(&args, "model")?,
                argument(&args, "reasoningEffort")?,
                argument(&args, "fastMode")?,
                argument(&args, "compileContext")?,
            )
            .await,
        ),
        "resume_codex_code" => result(
            codex::resume_codex_code(
                window,
                argument(&args, "projectPath")?,
                argument(&args, "sourceProjectPath")?,
                argument(&args, "runtimeSessionKey")?,
                argument(&args, "sessionId")?,
                argument(&args, "prompt")?,
                argument(&args, "tabId")?,
                argument(&args, "model")?,
                argument(&args, "reasoningEffort")?,
                argument(&args, "fastMode")?,
                argument(&args, "compileContext")?,
            )
            .await,
        ),
        "check_codex_session_owner" => result(codex::check_codex_session_owner(window, argument(&args, "tabId")?, argument(&args, "sessionId")?).await),
        "reconnect_codex_session" => result(codex::reconnect_codex_session(window, argument(&args, "tabId")?, argument(&args, "sessionId")?, argument(&args, "ownerToken")?, argument(&args, "model")?, argument(&args, "reasoningEffort")?).await),
        "dispose_codex_session" => {
            result(codex::dispose_codex_session(window, argument(&args, "tabId")?).await)
        }
        "cancel_codex_execution" => {
            result(codex::cancel_codex_execution(window, argument(&args, "tabId")?).await)
        }
        "review_project_state" => tokio::task::block_in_place(|| {
            result(agent_workspace::review_project_state(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "preview_agent_workspace" => tokio::task::block_in_place(|| {
            result(agent_workspace::preview_agent_workspace(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
                argument(&args, "decisions")?,
            ))
        }),
        "prepare_agent_workspace" => tokio::task::block_in_place(|| {
            result(agent_workspace::prepare_agent_workspace(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "tabId")?,
                argument(&args, "sharedSessionId")?,
                argument(&args, "mode")?,
                argument(&args, "dirtyBuffers")?,
            ))
        }),
        "resume_agent_workspace" => tokio::task::block_in_place(|| {
            result(agent_workspace::resume_agent_workspace(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
                argument(&args, "tabId")?,
                argument(&args, "sharedSessionId")?,
            ))
        }),
        "set_agent_workspace_backup" => tokio::task::block_in_place(|| {
            result(agent_workspace::set_agent_workspace_backup(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
                argument(&args, "backup")?,
            ))
        }),
        "inspect_paused_workspace" => tokio::task::block_in_place(|| {
            result(agent_workspace::inspect_paused_workspace(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
                argument(&args, "dirtyBuffers")?,
            ))
        }),
        "agent_workspace_source_changed" => tokio::task::block_in_place(|| {
            result(agent_workspace::agent_workspace_source_changed(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
            ))
        }),
        "reconcile_agent_workspace" => tokio::task::block_in_place(|| {
            result(agent_workspace::reconcile_agent_workspace(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
                argument(&args, "outcome")?,
            ))
        }),
        "apply_agent_workspace" => tokio::task::block_in_place(|| {
            result(agent_workspace::apply_agent_workspace(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
                argument(&args, "decisions")?,
                argument(&args, "expectedSourceRevision")?,
                argument(&args, "expectedProjectRevision")?,
            ))
        }),
        "discard_agent_workspace" => tokio::task::block_in_place(|| {
            result(agent_workspace::discard_agent_workspace(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "sessionId")?,
            ))
        }),
        "list_agent_workspaces" => tokio::task::block_in_place(|| {
            result(agent_workspace::list_agent_workspaces(
                service.clone(),
                argument(&args, "projectRoot")?,
            ))
        }),
        "zotero_start_oauth" => result(zotero::zotero_start_oauth(&service.zotero).await),
        "zotero_complete_oauth" => result(zotero::zotero_complete_oauth(&service.zotero).await),
        "zotero_cancel_oauth" => result(zotero::zotero_cancel_oauth(&service.zotero).await),
        "list_shared_sessions" => result(
            shared_sessions::list_shared_sessions(service.clone(), argument(&args, "projectPath")?)
                .await,
        ),
        "shared_session_metadata" => result(shared_sessions::shared_session_metadata(
            service.clone(), argument(&args,"projectPath")?, argument(&args,"sharedSessionId")?,
        ).await),
        "load_shared_session" => result(
            shared_sessions::load_shared_session(
                service.clone(),
                argument(&args, "projectPath")?,
                argument(&args, "sharedSessionId")?,
            )
            .await,
        ),
        "save_shared_session" => result(
            shared_sessions::save_shared_session(
                service.clone(),
                argument(&args, "projectPath")?,
                argument(&args, "sharedSessionId")?,
                argument(&args, "title")?,
                argument(&args, "lastProvider")?,
                argument(&args, "lastClaudeModel")?,
                argument(&args, "lastCodexModel")?,
                argument(&args, "lastPiModel")?,
                argument(&args, "providerSessionIds")?,
                argument(&args, "providerSyncCursors")?,
                argument(&args, "messages")?,
                argument(&args, "pendingQuestion")?,
                argument(&args, "lastActivityAt")?,
            )
            .await,
        ),
        "set_shared_session_archived" => result(
            shared_sessions::set_shared_session_archived(
                service.clone(),
                argument(&args, "projectPath")?,
                argument(&args, "sharedSessionId")?,
                argument(&args, "archived")?,
            )
            .await,
        ),
        "history_storage_info" => tokio::task::block_in_place(|| {
            result(history::history_storage_info(
                service.clone(),
                argument(&args, "projectRoot")?,
            ))
        }),
        "history_set_storage_limit" => tokio::task::block_in_place(|| {
            result(history::history_set_storage_limit(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "limitBytes")?,
            ))
        }),
        "history_clear" => tokio::task::block_in_place(|| {
            result(history::history_clear(
                service.clone(),
                argument(&args, "projectRoot")?,
            ))
        }),
        "git_project_init" => tokio::task::block_in_place(|| {
            result(history::git_project_init(argument(&args, "projectRoot")?))
        }),
        "git_project_complete_setup" => tokio::task::block_in_place(|| {
            result(history::git_project_complete_setup(
                argument(&args, "projectRoot")?,
                argument(&args, "gitignoreContent")?,
            ))
        }),
        "git_project_connect_remote" => git_task(&window, || {
            result(history::git_project_connect_remote(
                argument(&args, "projectRoot")?,
                argument(&args, "remoteUrl")?,
                argument(&args, "remoteName")?,
                argument(&args, "upstreamBranch")?,
            ))
        }),
        "git_project_upstream_status" => tokio::task::block_in_place(|| {
            result(history::git_project_upstream_status(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_project_remote_configuration" => tokio::task::block_in_place(|| {
            result(history::git_project_remote_configuration(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_project_save_remote" => git_task(&window, || {
            result(history::git_project_save_remote(
                argument(&args, "projectRoot")?,
                argument(&args, "originalRemoteName")?,
                argument(&args, "remoteName")?,
                argument(&args, "remoteUrl")?,
                argument(&args, "localBranch")?,
                argument(&args, "upstreamBranch")?,
            ))
        }),
        "git_project_delete_remote" => tokio::task::block_in_place(|| {
            result(history::git_project_delete_remote(
                argument(&args, "projectRoot")?,
                argument(&args, "remoteName")?,
            ))
        }),
        "git_remote_inspect" => git_task(&window, || {
            result(history::git_remote_inspect_impl(&argument::<String>(
                &args,
                "remoteUrl",
            )?))
        }),
        "git_credential_respond" => tokio::task::block_in_place(|| {
            result(git_credentials::respond(
                window.label(),
                argument(&args, "id")?,
                argument(&args, "username")?,
                argument(&args, "token")?,
            ))
        }),
        "git_overleaf_token_detect" => {
            tokio::task::block_in_place(|| result(history::git_overleaf_token_detect()))
        }
        "git_overleaf_clone" => tokio::task::block_in_place(|| {
            result(history::git_overleaf_clone(
                argument(&args, "cloneCommand")?,
                argument(&args, "accessToken")?,
                argument(&args, "localName")?,
                argument(&args, "localPath")?,
            ))
        }),
        "history_init" => tokio::task::block_in_place(|| {
            result(history::history_init(
                service.clone(),
                argument(&args, "projectRoot")?,
            ))
        }),
        "history_snapshot" => tokio::task::block_in_place(|| {
            result(history::history_snapshot(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "message")?,
            ))
        }),
        "history_list" => tokio::task::block_in_place(|| {
            result(history::history_list(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "limit")?,
                argument(&args, "offset")?,
            ))
        }),
        "history_diff" => tokio::task::block_in_place(|| {
            result(history::history_diff(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "fromId")?,
                argument(&args, "toId")?,
            ))
        }),
        "git_head_file_content" => tokio::task::block_in_place(|| {
            result(history::git_head_file_content(
                argument(&args, "projectRoot")?,
                argument(&args, "filePath")?,
            ))
        }),
        "git_conflict_file_content" => tokio::task::block_in_place(|| {
            result(history::git_conflict_file_content(
                argument(&args, "projectRoot")?,
                argument(&args, "filePath")?,
            ))
        }),
        "git_panel_resolve_conflict" => tokio::task::block_in_place(|| {
            result(history::git_panel_resolve_conflict_review(
                argument(&args, "projectRoot")?,
                argument(&args, "filePath")?,
                argument(&args, "expectedVersion")?,
                argument(&args, "content")?,
            ))
        }),
        "git_panel_reopen_conflict" => tokio::task::block_in_place(|| {
            result(history::git_panel_reopen_conflict(
                argument(&args, "projectRoot")?,
                argument(&args, "filePath")?,
            ))
        }),
        "git_panel_status" => tokio::task::block_in_place(|| {
            result(history::git_panel_status(argument(&args, "projectRoot")?))
        }),
        "git_panel_branches" => tokio::task::block_in_place(|| {
            result(history::git_panel_branches(argument(&args, "projectRoot")?))
        }),
        "git_panel_checkout_branch" => tokio::task::block_in_place(|| {
            result(history::git_panel_checkout_branch(
                argument(&args, "projectRoot")?,
                argument(&args, "branch")?,
            ))
        }),
        "git_panel_changed_files" => tokio::task::block_in_place(|| {
            result(history::git_panel_changed_files(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_graph" => tokio::task::block_in_place(|| {
            result(history::git_panel_graph(
                argument(&args, "projectRoot")?,
                argument(&args, "limit")?,
            ))
        }),
        "git_panel_rebase_onto" => tokio::task::block_in_place(|| {
            result(history::git_panel_rebase_onto(
                argument(&args, "projectRoot")?,
                argument(&args, "targetCommit")?,
            ))
        }),
        "git_panel_continue_rebase" => tokio::task::block_in_place(|| {
            result(history::git_panel_continue_rebase(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_history" => tokio::task::block_in_place(|| {
            result(history::git_panel_history(
                argument(&args, "projectRoot")?,
                argument(&args, "limit")?,
            ))
        }),
        "git_panel_commit" => tokio::task::block_in_place(|| {
            result(history::git_panel_commit(
                argument(&args, "projectRoot")?,
                argument(&args, "message")?,
                argument(&args, "includeUnstaged")?,
            ))
        }),
        "git_panel_commit_all" => tokio::task::block_in_place(|| {
            result(history::git_panel_commit_all(
                argument(&args, "projectRoot")?,
                argument(&args, "message")?,
            ))
        }),
        "git_panel_commit_selected" => tokio::task::block_in_place(|| {
            result(history::git_panel_commit_selected(
                argument(&args, "projectRoot")?,
                argument(&args, "message")?,
                argument(&args, "selectedFiles")?,
            ))
        }),
        "git_panel_add_all" => tokio::task::block_in_place(|| {
            result(history::git_panel_add_all(argument(&args, "projectRoot")?))
        }),
        "git_panel_pull" => git_task(&window, || {
            result(history::git_panel_pull(argument(&args, "projectRoot")?))
        }),
        "git_panel_stash" => tokio::task::block_in_place(|| {
            result(history::git_panel_stash(
                argument(&args, "projectRoot")?,
                argument(&args, "message")?,
            ))
        }),
        "git_panel_pull_flow" => git_task(&window, || {
            result(history::git_panel_pull_flow(
                argument(&args, "projectRoot")?,
                argument(&args, "message")?,
                argument(&args, "stashSelectedFiles")?,
                argument(&args, "reapplyMode")?,
            ))
        }),
        "git_panel_stash_list" => tokio::task::block_in_place(|| {
            result(history::git_panel_stash_list(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_stash_files" => tokio::task::block_in_place(|| {
            result(history::git_panel_stash_files(
                argument(&args, "projectRoot")?,
                argument(&args, "stashRef")?,
            ))
        }),
        "git_panel_stash_apply" => tokio::task::block_in_place(|| {
            result(history::git_panel_stash_apply(
                argument(&args, "projectRoot")?,
                argument(&args, "stashRef")?,
            ))
        }),
        "git_panel_stash_pop" => tokio::task::block_in_place(|| {
            result(history::git_panel_stash_pop(
                argument(&args, "projectRoot")?,
                argument(&args, "stashRef")?,
            ))
        }),
        "git_panel_stash_drop" => tokio::task::block_in_place(|| {
            result(history::git_panel_stash_drop(
                argument(&args, "projectRoot")?,
                argument(&args, "stashRef")?,
            ))
        }),
        "git_panel_abort_operation" => tokio::task::block_in_place(|| {
            result(history::git_panel_abort_operation(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_reset_selected" => tokio::task::block_in_place(|| {
            result(history::git_panel_reset_selected(
                argument(&args, "projectRoot")?,
                argument(&args, "selectedFiles")?,
                argument(&args, "untrackedFiles")?,
            ))
        }),
        "git_panel_reset_all" => tokio::task::block_in_place(|| {
            result(history::git_panel_reset_all(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_pull_status" => git_task(&window, || {
            result(history::git_panel_pull_status_impl(&argument::<String>(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_push_recovery_preview" => git_task(&window, || {
            result(history::git_panel_push_recovery_preview(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_push" => git_task(&window, || {
            result(history::git_panel_push(argument(&args, "projectRoot")?))
        }),
        "git_panel_force_push" => git_task(&window, || {
            result(history::git_panel_force_push(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_worktree_file_line_stats" => tokio::task::block_in_place(|| {
            result(history::git_worktree_file_line_stats(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_ignored_paths" => tokio::task::block_in_place(|| {
            result(history::git_ignored_paths(argument(&args, "projectRoot")?))
        }),
        "history_snapshot_files" => tokio::task::block_in_place(|| {
            result(history::history_snapshot_files(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "snapshotId")?,
            ))
        }),
        "history_file_bytes" => tokio::task::block_in_place(|| {
            result(history::history_file_bytes(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "snapshotId")?,
                argument(&args, "filePath")?,
            ))
        }),
        "history_file_at" => tokio::task::block_in_place(|| {
            result(history::history_file_at(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "snapshotId")?,
                argument(&args, "filePath")?,
            ))
        }),
        "history_restore" => tokio::task::block_in_place(|| {
            result(history::history_restore(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "snapshotId")?,
            ))
        }),
        "history_add_label" => tokio::task::block_in_place(|| {
            result(history::history_add_label(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "snapshotId")?,
                argument(&args, "label")?,
            ))
        }),
        "history_remove_label" => tokio::task::block_in_place(|| {
            result(history::history_remove_label(
                service.clone(),
                argument(&args, "projectRoot")?,
                argument(&args, "snapshotId")?,
                argument(&args, "label")?,
            ))
        }),
        "history_label_counts" => tokio::task::block_in_place(|| {
            result(history::history_label_counts(
                service.clone(),
                argument(&args, "projectRoot")?,
            ))
        }),
        "rename_project_path" => tokio::task::block_in_place(|| {
            result(comments::rename_project_path(
                &service,
                argument(&args, "projectRoot")?,
                argument(&args, "change")?,
            ))
        }),
        "manage_comment_files" => result(
            comments::manage_comment_files(
                &window,
                argument(&args, "projectRoot")?,
                argument(&args, "selection")?,
                argument(&args, "author")?,
                argument(&args, "action")?,
                argument(&args, "target")?,
                argument(&args, "preview")?,
            )
            .await,
        ),
        "read_project_comments_anchored" => result(
            comments::read_project_comments_anchored(
                &service,
                argument(&args, "projectRoot")?,
                argument::<Option<bool>>(&args, "includeDisconnected")?.unwrap_or(false),
            )
            .await,
        ),
        "update_project_comment_anchors" => result(comments::update_project_comment_anchors(window, argument(&args, "projectRoot")?, argument(&args, "patches")?, argument(&args, "source")?).await),
        "update_project_comment_anchored" => result(
            comments::update_project_comment_anchored(
                window,
                argument(&args, "projectRoot")?,
                argument(&args, "patch")?,
                argument(&args, "source")?,
            )
            .await,
        ),
        "clear_project_comments" => result(
            comments::clear_project_comments(
                window,
                argument(&args, "projectRoot")?,
                argument(&args, "agent")?,
            )
            .await,
        ),
        "read_project_comments" => {
            result(comments::read_project_comments(&service, argument(&args, "projectRoot")?).await)
        }
        "replay_project_comment" => result(
            comments::replay_project_comment(
                window,
                argument(&args, "projectRoot")?,
                argument(&args, "patch")?,
            )
            .await,
        ),
        "update_project_comment" => result(
            comments::update_project_comment(
                window,
                argument(&args, "projectRoot")?,
                argument(&args, "patch")?,
            )
            .await,
        ),
        "confirm_comment_source" => result(
            comments::confirm_comment_source(
                window,
                argument(&args, "requestId")?,
                argument(&args, "matches")?,
            )
            .await,
        ),
        "git_panel_conflicts" => tokio::task::block_in_place(|| {
            result(git_conflicts::git_panel_conflicts(argument(
                &args,
                "projectRoot",
            )?))
        }),
        "git_panel_resolve_conflict_side" => tokio::task::block_in_place(|| {
            result(git_conflicts::git_panel_resolve_conflict_side(
                argument(&args, "projectRoot")?,
                argument(&args, "filePath")?,
                argument(&args, "choice")?,
                argument(&args, "expectedVersion")?,
            ))
        }),
        "detect_texlive" => tokio::task::block_in_place(|| value(latex::detect_texlive())),
        "cancel_compilation" => result(window.service.latex.operations.cancel(
            window.label(), &argument::<String>(&args, "projectDir")?,
            &argument::<Vec<String>>(&args, "compilationIds")?,
        ).await),
        "compile_latex" => result(compile_pdf(window, &args, false).await),
        "compile_latex_snapshot" => result(compile_pdf(window, &args, true).await),
        "get_compiled_pdf" => {
            let project_dir: String = argument(&args, "projectDir")?;
            if let Some(request_id) = argument::<Option<String>>(&args, "requestId")? {
                value(service.verification.take_pdf(&window.id, &project_dir, &request_id).await)
            } else {
                result(latex::get_compiled_pdf(&service.latex, project_dir).await)
            }
        }
        "get_synctex_source_map" => result(
            latex::get_synctex_source_map(&service.latex, argument(&args, "projectDir")?, window.label(), argument(&args, "compilationId")?).await,
        ),
        "synctex_edit" => result(
            latex::synctex_edit(
                &service.latex,
                argument(&args, "projectDir")?,
                argument(&args, "page")?,
                argument(&args, "x")?,
                argument(&args, "y")?,
                window.label(),
                argument(&args, "compilationId")?,
            )
            .await,
        ),
        "synctex_view" => result(
            latex::synctex_view(
                &service.latex,
                argument(&args, "projectDir")?,
                argument(&args, "file")?,
                argument(&args, "line")?,
                argument(&args, "column")?,
                window.label(),
                argument(&args, "compilationId")?,
            )
            .await,
        ),
        "watch_project_files" => tokio::task::block_in_place(|| {
            result(project_files::watch_project_files(
                window,
                argument(&args, "projectRoot")?,
                argument(&args, "watchId")?,
            ))
        }),
        "unwatch_project_files" => tokio::task::block_in_place(|| {
            result(project_files::unwatch_project_files(
                window,
                argument(&args, "watchId")?,
            ))
        }),
        "save_file_if_unchanged" => tokio::task::block_in_place(|| {
            result(project_files::save_file_if_unchanged(
                &service,
                argument(&args, "projectRoot")?,
                argument(&args, "filePath")?,
                argument(&args, "expected")?,
                argument(&args, "content")?,
            ))
        }),
        "answer_agent_question" => tokio::task::block_in_place(|| {
            result(agent_questions::answer_agent_question(
                window,
                argument(&args, "requestId")?,
                argument(&args, "tabId")?,
                argument(&args, "sessionId")?,
                argument(&args, "answer")?,
            ))
        }),
        "list_agent_questions" => {
            tokio::task::block_in_place(|| value(agent_questions::list_agent_questions(window)))
        }
        "prepare_project_storage" => tokio::task::block_in_place(|| {
            result(project_storage::prepare_project_storage(
                service.clone(),
                argument(&args, "projectRoot")?,
            ))
        }),
        _ => Err(json!(format!("Unknown service command: {command}"))),
    };
    if let Some(tracking) = tracking {
        if let Err(error) = comments::finish_known_edit(tracking) {
            // Git already ran. Preserve its result and report metadata recovery separately.
            if let Ok(Value::Object(output)) = &mut outcome { output.insert("commentWarning".into(), json!(error)); }
            eprintln!("[comments] Git completed; tracking needs recovery: {error}");
        }
    }
    outcome
}

#[derive(Deserialize)]
struct ChannelId {
    __channel: u64,
}

pub async fn run() -> Result<(), String> {
    let _ = dotenvy::dotenv();
    let service = ServiceState::from_environment()?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut windows: HashMap<String, tokio::task::JoinSet<()>> = HashMap::new();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("Invalid service request: {error}");
                continue;
            }
        };
        if request.command == "__close_window" {
            // Abort asynchronous work first so it cannot start another agent
            // after this window's processes have been cleaned up.
            if let Some(mut requests) = windows.remove(&request.window_id) {
                requests.shutdown().await;
            }
            service.close_window(&request.window_id).await;
            write_message(&json!({"id": request.id, "result": null}))?;
            continue;
        }
        let requests = windows.entry(request.window_id.clone()).or_default();
        while let Some(completed) = requests.try_join_next() {
            if let Err(error) = completed {
                eprintln!("Service task failed: {error}");
            }
        }
        let service = service.clone();
        requests.spawn(async move {
            if request.binary_response && request.command == "compile_latex" {
                let response = compile_pdf(
                    WindowContext {
                        service,
                        id: request.window_id,
                    },
                    &request.args,
                    false,
                )
                .await;
                let sent = match response {
                    Ok(bytes) => write_binary_message(request.id, &bytes),
                    Err(error) => write_message(&json!({"id": request.id, "error": error})),
                };
                if let Err(error) = sent {
                    eprintln!("Service response failed: {error}");
                }
                return;
            }
            let response =
                dispatch(service, request.window_id, &request.command, request.args).await;
            let message = match response {
                Ok(output) => json!({"id": request.id, "result": output}),
                Err(error) => json!({"id": request.id, "error": error}),
            };
            if let Err(error) = write_message(&message) {
                eprintln!("Service response failed: {error}");
            }
        });
    }
    // Electron closed the pipe. Dropping a task cancels its MCP turn and pending
    // renderer callbacks; then stop child processes and clear in-memory build state.
    for requests in windows.values_mut() {
        requests.abort_all();
    }
    let mut cleanup = tokio::task::JoinSet::new();
    for (window, mut requests) in windows {
        requests.shutdown().await;
        let service = service.clone();
        cleanup.spawn(async move {
            service.close_window(&window).await;
        });
    }
    while cleanup.join_next().await.is_some() {}
    crate::claude::kill_all_processes(&service.claude).await;
    crate::latex::cleanup_all_builds(&service.latex).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_arguments_preserve_optional_fields_and_channel_ids() {
        let request: Request = serde_json::from_value(json!({
            "id": 9,
            "windowId": "main",
            "command": "compile_latex",
            "args": {"projectDir": "/tmp/project", "diagnostics": {"__channel": 12}}
        }))
        .unwrap();
        assert_eq!(request.window_id, "main");
        assert_eq!(
            argument::<String>(&request.args, "projectDir").unwrap(),
            "/tmp/project"
        );
        assert_eq!(
            argument::<Option<String>>(&request.args, "engine").unwrap(),
            None
        );
        assert_eq!(
            argument::<ChannelId>(&request.args, "diagnostics")
                .unwrap()
                .__channel,
            12
        );
        assert!(argument::<String>(&request.args, "mainFile")
            .unwrap_err()
            .as_str()
            .unwrap()
            .contains("mainFile"));
    }

    #[test]
    fn compile_failure_keeps_structured_diagnostics() {
        let failure = crate::latex::CompileFailure {
            code: "compile_failed",
            actual_engine: None,
            message: "Compilation failed".into(),
            diagnostics: vec![crate::latex::CompileDiagnostic {
                severity: "error",
                message: "Undefined control sequence".into(),
                file: Some("main.tex".into()),
                line: Some(7),
                end_line: Some(7),
            }],
        };
        let error = result::<(), _>(Err(failure)).unwrap_err();
        assert_eq!(error["message"], "Compilation failed");
        assert_eq!(error["diagnostics"][0]["file"], "main.tex");
        assert_eq!(error["diagnostics"][0]["line"], 7);
    }

    #[test]
    fn pdf_response_keeps_all_byte_values() {
        assert_eq!(
            result::<_, String>(Ok(vec![0_u8, 37, 128, 255])).unwrap(),
            json!([0, 37, 128, 255])
        );
    }
}
