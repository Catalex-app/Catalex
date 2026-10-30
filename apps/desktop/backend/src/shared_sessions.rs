use std::collections::HashMap;
use std::path::PathBuf;

use crate::project_storage::resolve_project_storage;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SharedSessionFile {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub archived: bool,
    pub last_provider: String,
    pub last_claude_model: Option<String>,
    pub last_codex_model: Option<String>,
    pub last_pi_model: Option<String>,
    pub provider_session_ids: HashMap<String, String>,
    #[serde(default)]
    pub provider_sync_cursors: Option<HashMap<String, usize>>,
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub pending_question: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SharedSessionInfo {
    #[serde(default)]
    pub created_at: i64,
    #[serde(alias = "id")]
    pub shared_session_id: String,
    pub title: String,
    #[serde(alias = "updated_at")]
    pub last_modified: i64,
    #[serde(default)]
    pub archived: bool,
    pub last_provider: String,
    pub last_claude_model: Option<String>,
    pub last_codex_model: Option<String>,
    pub last_pi_model: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SharedSessionData {
    pub shared_session_id: String,
    pub title: String,
    pub last_modified: i64,
    pub archived: bool,
    pub last_provider: String,
    pub last_claude_model: Option<String>,
    pub last_codex_model: Option<String>,
    pub last_pi_model: Option<String>,
    pub provider_session_ids: HashMap<String, String>,
    pub provider_sync_cursors: Option<HashMap<String, usize>>,
    pub messages: Vec<serde_json::Value>,
    pub pending_question: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SaveSharedSessionResult {
    pub shared_session_id: String,
    pub last_modified: i64,
}

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn shared_sessions_dir(app: &crate::host::ServiceContext, project_path: &str) -> Result<PathBuf, String> {
    resolve_project_storage(app, project_path).map(|paths| paths.sessions_dir)
}

fn session_file_path(
    app: &crate::host::ServiceContext,
    project_path: &str,
    shared_session_id: &str,
) -> Result<PathBuf, String> {
    shared_sessions_dir(app, project_path)
        .map(|directory| directory.join(format!("{shared_session_id}.json")))
}

fn load_shared_session_file(path: &PathBuf) -> Result<SharedSessionFile, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        format!(
            "Failed to read shared session file {}: {}",
            path.display(),
            e
        )
    })?;
    serde_json::from_str::<SharedSessionFile>(&raw).map_err(|e| {
        format!(
            "Failed to parse shared session file {}: {}",
            path.display(),
            e
        )
    })
}

fn save_shared_session_file(path: &PathBuf, file: &SharedSessionFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create shared sessions directory: {}", e))?;
    }

    let serialized = serde_json::to_string_pretty(file)
        .map_err(|e| format!("Failed to serialize shared session: {}", e))?;
    crate::project_files::replace_file(path, serialized.as_bytes()).map_err(|e| {
        format!(
            "Failed to write shared session file {}: {}",
            path.display(),
            e
        )
    })?;
    Ok(())
}

pub async fn list_shared_sessions(
    app: crate::host::ServiceContext,
    project_path: String,
) -> Result<Vec<SharedSessionInfo>, String> {
    let dir = shared_sessions_dir(&app, &project_path)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("Failed to read sessions directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Ignore transcript fields while streaming metadata. Listing sessions must
        // not allocate every message of a large conversation.
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        if let Ok(summary) = serde_json::from_reader::<_, SharedSessionInfo>(
            std::io::BufReader::new(file),
        ) {
            sessions.push(summary);
        }
    }

    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(sessions)
}

pub async fn load_shared_session(
    app: crate::host::ServiceContext,
    project_path: String,
    shared_session_id: String,
) -> Result<SharedSessionData, String> {
    let path = session_file_path(&app, &project_path, &shared_session_id)?;
    if !path.exists() {
        return Err(format!("Shared session not found: {}", shared_session_id));
    }
    let session = load_shared_session_file(&path)?;

    Ok(SharedSessionData {
        shared_session_id: session.id,
        title: session.title,
        last_modified: session.updated_at,
        archived: session.archived,
        last_provider: session.last_provider,
        last_claude_model: session.last_claude_model,
        last_codex_model: session.last_codex_model,
        last_pi_model: session.last_pi_model,
        provider_session_ids: session.provider_session_ids,
        provider_sync_cursors: session.provider_sync_cursors,
        messages: session.messages,
        pending_question: session.pending_question,
    })
}

pub async fn save_shared_session(
    app: crate::host::ServiceContext,
    project_path: String,
    shared_session_id: Option<String>,
    title: String,
    last_provider: String,
    last_claude_model: Option<String>,
    last_codex_model: Option<String>,
    last_pi_model: Option<String>,
    provider_session_ids: HashMap<String, String>,
    provider_sync_cursors: Option<HashMap<String, usize>>,
    messages: Vec<serde_json::Value>,
    pending_question: Option<serde_json::Value>,
    last_activity_at: Option<i64>,
) -> Result<SaveSharedSessionResult, String> {
    let effective_id = shared_session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let path = session_file_path(&app, &project_path, &effective_id)?;

    let existing = if path.exists() {
        load_shared_session_file(&path).ok()
    } else {
        None
    };
    let now = now_unix_seconds();
    // Activity is recorded when messages/questions arrive, not when their
    // restored representation is checkpointed. Older clients/cached tabs may
    // omit it; preserve the stored time rather than inventing new activity.
    let previous_activity = existing
        .as_ref()
        .map_or(now, |previous| previous.updated_at);
    let updated_at = last_activity_at.map_or(previous_activity, |activity| {
        previous_activity.max(activity)
    });

    let session_file = SharedSessionFile {
        id: effective_id.clone(),
        title: if title.trim().is_empty() {
            "New Chat".to_string()
        } else {
            title
        },
        created_at: existing.as_ref().map_or(now, |previous| previous.created_at),
        updated_at,
        archived: existing.as_ref().is_some_and(|previous| previous.archived),
        last_provider,
        last_claude_model,
        last_codex_model,
        last_pi_model,
        provider_session_ids,
        provider_sync_cursors: Some(provider_sync_cursors.unwrap_or_default()),
        messages,
        pending_question,
    };

    save_shared_session_file(&path, &session_file)?;

    Ok(SaveSharedSessionResult {
        shared_session_id: effective_id,
        last_modified: updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn checkpoints_preserve_activity_time_but_new_messages_advance_it() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let project = project.to_string_lossy().to_string();
        let app = std::sync::Arc::new(crate::host::ServiceState {
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
        });
        for provider in ["claude", "codex", "pi"] {
            let path = session_file_path(&app, &project, provider).unwrap();
            let messages = vec![serde_json::json!({"type":"user","message":{"content":"Earlier question"}})];
            let original: SharedSessionFile = serde_json::from_value(serde_json::json!({
                "id":provider, "title":"Earlier chat", "created_at":100, "updated_at":200,
                "last_provider":provider, "provider_session_ids":{}, "messages":messages,
            })).unwrap();
            save_shared_session_file(&path, &original).unwrap();
            // The close/reopen checkpoint may refresh models and sync cursors.
            let saved = save_shared_session(
                app.clone(),
                project.clone(),
                Some(provider.into()),
                "Earlier chat".into(),
                provider.into(),
                Some("sonnet".into()),
                Some("gpt-5.4".into()),
                Some("pi-test-model".into()),
                HashMap::new(),
                Some(HashMap::from([(provider.into(), 1)])),
                messages.clone(),
                None,
                None,
            )
            .await
            .unwrap();
            assert_eq!(saved.last_modified, 200);
            let restored = load_shared_session(app.clone(), project.clone(), provider.into()).await.unwrap();
            assert_eq!(restored.last_modified, 200);
            assert_eq!(restored.last_claude_model.as_deref(), Some("sonnet"));
            assert_eq!(restored.last_pi_model.as_deref(), Some("pi-test-model"));
            assert_eq!(load_shared_session_file(&path).unwrap().created_at, 100);
            let mut changed = messages;
            changed
                .push(serde_json::json!({"type":"assistant","message":{"content":"New answer"}}));
            let saved = save_shared_session(
                app.clone(),
                project.clone(),
                Some(provider.into()),
                "Earlier chat".into(),
                provider.into(),
                None,
                None,
                None,
                HashMap::new(),
                None,
                changed.clone(),
                None,
                Some(300),
            )
            .await
            .unwrap();
            assert_eq!(saved.last_modified, 300);
            // Restoring can rebuild images/remove runtime entries without activity.
            changed.push(serde_json::json!({"type":"system","subtype":"init"}));
            let checkpoint = save_shared_session(
                app.clone(),
                project.clone(),
                Some(provider.into()),
                "Earlier chat".into(),
                provider.into(),
                None,
                None,
                None,
                HashMap::new(),
                None,
                changed,
                None,
                Some(200),
            )
            .await
            .unwrap();
            assert_eq!(checkpoint.last_modified, 300);
            let listed = list_shared_sessions(app.clone(), project.clone()).await.unwrap();
            assert_eq!(listed.iter().find(|s| s.shared_session_id == provider).unwrap().last_modified, saved.last_modified);
        }
    }

    #[test]
    fn unanswered_question_survives_session_serialization() {
        let pending = serde_json::json!({
            "requestId": "q",
            "question": "What next?",
            "options": [{"label": "Update"}, {"label": "Discard"}],
        });
        let session: SharedSessionFile = serde_json::from_value(serde_json::json!({
            "id": "chat", "title": "Review", "created_at": 1, "updated_at": 2,
            "last_provider": "codex", "provider_session_ids": {}, "messages": [],
            "pending_question": pending,
        }))
        .unwrap();
        let saved = serde_json::to_value(session).unwrap();
        assert_eq!(saved["pending_question"], pending);
    }

    #[test]
    fn legacy_session_without_provider_cursors_remains_loadable() {
        let session: SharedSessionFile = serde_json::from_str(
            r#"{
                "id": "legacy",
                "title": "Legacy",
                "created_at": 1,
                "updated_at": 2,
                "last_provider": "claude",
                "last_claude_model": "opus",
                "last_codex_model": null,
                "provider_session_ids": {"claude": "session-1"},
                "messages": []
            }"#,
        )
        .expect("legacy shared session should deserialize");

        assert!(session.provider_sync_cursors.is_none());
    }
}

pub async fn set_shared_session_archived(
    app: crate::host::ServiceContext,
    project_path: String,
    shared_session_id: String,
    archived: bool,
) -> Result<SharedSessionInfo, String> {
    let path = session_file_path(&app, &project_path, &shared_session_id)?;
    if !path.exists() {
        return Err(format!("Shared session not found: {}", shared_session_id));
    }

    let mut session = load_shared_session_file(&path)?;
    session.archived = archived;
    save_shared_session_file(&path, &session)?;

    Ok(SharedSessionInfo {
        created_at: session.created_at,
        shared_session_id: session.id,
        title: session.title,
        last_modified: session.updated_at,
        archived: session.archived,
        last_provider: session.last_provider,
        last_claude_model: session.last_claude_model,
        last_codex_model: session.last_codex_model,
        last_pi_model: session.last_pi_model,
    })
}

pub async fn shared_session_metadata(
    app: crate::host::ServiceContext, project_path: String, shared_session_id: String,
) -> Result<Option<SharedSessionInfo>, String> {
    let path = session_file_path(&app, &project_path, &shared_session_id)?;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_reader(std::io::BufReader::new(file)).map(Some).map_err(|error| error.to_string())
}
