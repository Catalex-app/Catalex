//! Process-wide domain services and the small event boundary to Electron.
use serde::Serialize;
use serde_json::json;
use std::{io::Write, path::PathBuf, sync::Arc};

pub type ServiceContext = Arc<ServiceState>;

pub struct ServiceState {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub resource_dir: PathBuf,
    pub claude: crate::claude::ClaudeProcessState,
    pub codex: crate::codex::CodexProcessState,
    pub pi: crate::pi::PiProcessState,
    pub latex: crate::latex::LatexCompilerState,
    pub verification: crate::verification::VerificationServiceState,
    pub comments: crate::comments::CommentService,
    pub project_files: crate::project_files::ProjectFiles,
    pub questions: crate::agent_questions::AgentQuestions,
    pub zotero: crate::zotero::ZoteroOAuthState,
}

impl ServiceState {
    pub fn from_environment() -> Result<ServiceContext, String> {
        fn directory(name: &str) -> Result<PathBuf, String> {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| format!("Missing service environment variable {name}"))
        }
        Ok(Arc::new(Self {
            data_dir: directory("CATALEX_DATA_DIR")?,
            cache_dir: directory("CATALEX_CACHE_DIR")?,
            resource_dir: directory("CATALEX_RESOURCE_DIR")?,
            claude: Default::default(),
            codex: Default::default(),
            pi: Default::default(),
            latex: Default::default(),
            verification: Default::default(),
            comments: Default::default(),
            project_files: Default::default(),
            questions: Default::default(),
            zotero: Default::default(),
        }))
    }

    /// Events without a window ID are broadcast by Electron to all windows.
    pub fn emit(&self, event: &str, payload: impl Serialize) -> Result<(), String> {
        write_message(&json!({"event": event, "payload": payload}))
    }

    pub async fn close_window(&self, window_id: &str) {
        crate::git_credentials::close_window(window_id);
        self.project_files.close_window(window_id);
        self.questions.close_window(window_id);
        tokio::join!(
            crate::claude::kill_process_for_window(&self.claude, window_id),
            crate::codex::kill_process_for_window(&self.codex, window_id),
            crate::pi::kill_process_for_window(&self.pi, window_id),
        );
    }
}

#[derive(Clone)]
pub struct WindowContext {
    pub service: ServiceContext,
    pub id: String,
}

impl WindowContext {
    pub fn label(&self) -> &str {
        &self.id
    }

    pub fn emit(&self, event: &str, payload: impl Serialize) -> Result<(), String> {
        write_message(&json!({"windowId": self.id, "event": event, "payload": payload}))
    }
}

/// Stdout is reserved for this protocol. One lock covers a complete line so
/// concurrent responses and filesystem/agent events cannot interleave.
pub fn write_message(message: &impl Serialize) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

/// Hold the same stdout lock across the header and payload, so events cannot
/// split a binary PDF response. The PDF bytes themselves are never serialized.
pub fn write_binary_message(id: u64, bytes: &[u8]) -> Result<(), String> {
    let header = serde_json::to_vec(&json!({"id": id, "binaryLength": bytes.len()}))
        .map_err(|error| error.to_string())?;
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&header)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.write_all(bytes))
        .and_then(|_| stdout.flush())
        .map_err(|error| error.to_string())
}
