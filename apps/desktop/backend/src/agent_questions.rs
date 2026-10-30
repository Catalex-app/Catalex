//! Provider-neutral, turn-scoped questions. No process cancellation or new chat turn.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use crate::host::WindowContext;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    label: String,
    #[serde(default)]
    description: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    details: Option<String>,
    #[serde(default)]
    permission: bool,
    options: Vec<Choice>,
}

impl Question {
    fn validate(&self) -> Result<(), String> {
        if self.question.trim().is_empty()
            || self.question.len() > 2000
            || self.details.as_ref().is_some_and(|details| details.len() > 128_000)
            || !(2..=4).contains(&self.options.len())
            || self.options.iter().any(|o| {
                o.label.trim().is_empty() || o.label.len() > 120 || o.description.len() > 500
            })
            || self.options.iter().enumerate().any(|(i, o)| {
                self.options[..i]
                    .iter()
                    .any(|p| p.label.trim() == o.label.trim())
            })
        {
            return Err(
                "invalid_question: supply a question and 2–4 distinct concise choices".into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    request_id: String,
    tab_id: String,
    session_id: String,
    project_root: String,
    #[serde(flatten)]
    question: Question,
}

struct Entry {
    window: String,
    request: PendingQuestion,
    cancelled: CancellationToken,
    answer: oneshot::Sender<String>,
}

#[derive(Default)]
pub struct AgentQuestions {
    pending: Arc<Mutex<BTreeMap<String, Entry>>>,
}

impl AgentQuestions {
    pub fn close_window(&self, window_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, entry| {
                if entry.window == window_id {
                    entry.cancelled.cancel();
                    false
                } else {
                    true
                }
            });
        }
    }

    fn register(
        &self,
        window: String,
        request: PendingQuestion,
        cancelled: CancellationToken,
    ) -> Result<oneshot::Receiver<String>, String> {
        request.question.validate()?;
        if cancelled.is_cancelled() {
            return Err("stale_session: agent turn ended".into());
        }
        let mut pending = self.pending.lock().unwrap();
        if pending.values().any(|e| {
            e.window == window && e.request.tab_id == request.tab_id && !e.cancelled.is_cancelled()
        }) {
            return Err(
                "question_pending: wait for the current answer before asking another question"
                    .into(),
            );
        }
        let (answer, receiver) = oneshot::channel();
        pending.insert(
            request.request_id.clone(),
            Entry {
                window,
                request,
                cancelled,
                answer,
            },
        );
        Ok(receiver)
    }

    fn answer(
        &self,
        window: &str,
        request_id: &str,
        tab_id: &str,
        session_id: &str,
        answer: String,
    ) -> Result<(), String> {
        if answer.trim().is_empty() || answer.len() > 4000 {
            return Err("invalid_answer: enter a nonempty answer of at most 4000 bytes".into());
        }
        let mut pending = self.pending.lock().unwrap();
        if !pending.get(request_id).is_some_and(|entry| {
            entry.window == window
                && entry.request.tab_id == tab_id
                && entry.request.session_id == session_id
                && !entry.cancelled.is_cancelled()
        }) {
            return Err(
                "stale_question: this question expired or belongs to another conversation".into(),
            );
        }
        pending
            .remove(request_id)
            .unwrap()
            .answer
            .send(answer.trim().into())
            .map_err(|_| "stale_question: this question is no longer waiting for an answer".into())
    }
}

// Runs on success, timeout, turn cancellation, and dropped MCP requests alike.
struct PendingGuard {
    pending: Arc<Mutex<BTreeMap<String, Entry>>>,
    window: WindowContext,
    request_id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.request_id);
        let _ = self.window.emit(
            "catalex-question-closed",
            json!({"requestId":self.request_id}),
        );
    }
}

pub fn answer_agent_question(
    window: WindowContext,
    request_id: String,
    tab_id: String,
    session_id: String,
    answer: String,
) -> Result<(), String> {
    window.service.questions.answer(
        window.label(),
        &request_id,
        &tab_id,
        &session_id,
        answer,
    )
}

pub fn list_agent_questions(window: WindowContext) -> Vec<PendingQuestion> {
    window.service.questions
        .pending
        .lock()
        .unwrap()
        .values()
        .filter(|e| e.window == window.label() && !e.cancelled.is_cancelled())
        .map(|e| e.request.clone())
        .collect()
}

pub async fn ask(
    window: &WindowContext,
    tab_id: &str,
    session_id: &str,
    project_root: &str,
    args: Value,
    cancelled: &CancellationToken,
) -> Result<Value, String> {
    let question: Question =
        serde_json::from_value(args).map_err(|e| format!("invalid_question: {e}"))?;
    let request = PendingQuestion {
        request_id: uuid::Uuid::new_v4().to_string(),
        tab_id: tab_id.into(),
        session_id: session_id.into(),
        project_root: project_root.into(),
        question,
    };
    let state = &window.service.questions;
    let receiver = state.register(window.label().into(), request.clone(), cancelled.clone())?;
    let _guard = PendingGuard {
        pending: state.pending.clone(),
        window: window.clone(),
        request_id: request.request_id.clone(),
    };
    window
        .emit("catalex-question", &request)
        .map_err(|e| format!("question_unavailable: {e}"))?;
    let answer = tokio::select! {
        biased;
        _ = cancelled.cancelled() => return Err("stale_session: question cancelled with its agent turn".into()),
        result = tokio::time::timeout(Duration::from_secs(600), receiver) => match result {
            Ok(Ok(answer)) => answer,
            _ => return Err("question_expired: no answer received; do not assume a choice or repeat automatically".into()),
        },
    };
    if cancelled.is_cancelled() {
        return Err("stale_session: agent turn ended".into());
    }
    Ok(json!({"status":"answered", "question":request.question.question, "answer":answer}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(id: &str) -> PendingQuestion {
        PendingQuestion {
            request_id: id.into(),
            tab_id: "tab".into(),
            session_id: "session".into(),
            project_root: "/source".into(),
            question: Question {
                question: "What next?".into(),
                details: None,
                permission: false,
                options: vec![
                    Choice {
                        label: "Update".into(),
                        description: String::new(),
                    },
                    Choice {
                        label: "Discard unsaved".into(),
                        description: String::new(),
                    },
                ],
            },
        }
    }
    #[tokio::test]
    async fn answers_are_bound_to_window_tab_session_and_consumed_once() {
        let service = AgentQuestions::default();
        let receiver = service
            .register("main".into(), request("q"), CancellationToken::new())
            .unwrap();
        for (window, tab, session) in [
            ("other", "tab", "session"),
            ("main", "other", "session"),
            ("main", "tab", "old"),
        ] {
            assert!(service
                .answer(window, "q", tab, session, "Update".into())
                .is_err());
        }
        assert!(service
            .register("main".into(), request("q2"), CancellationToken::new())
            .is_err());
        service
            .answer("main", "q", "tab", "session", "My custom answer".into())
            .unwrap();
        assert_eq!(receiver.await.unwrap(), "My custom answer");
        assert!(service
            .answer("main", "q", "tab", "session", "Update".into())
            .is_err());
    }
    #[test]
    fn cancelled_questions_and_invalid_inputs_are_rejected() {
        let service = AgentQuestions::default();
        let token = CancellationToken::new();
        let _receiver = service
            .register("main".into(), request("q"), token.clone())
            .unwrap();
        token.cancel();
        assert!(service
            .answer("main", "q", "tab", "session", "Update".into())
            .is_err());
        assert!(service
            .register("main".into(), request("q2"), token)
            .is_err());
        let mut invalid = request("bad");
        invalid.question.options[1].label = "Update".into();
        assert!(service
            .register("main".into(), invalid, CancellationToken::new())
            .is_err());
    }

    #[test]
    fn closing_a_window_cancels_only_its_questions() {
        let service = AgentQuestions::default();
        let closed = CancellationToken::new();
        let open = CancellationToken::new();
        let _closed_receiver = service.register("closed".into(), request("q1"), closed.clone()).unwrap();
        let _open_receiver = service.register("open".into(), request("q2"), open.clone()).unwrap();
        service.close_window("closed");
        assert!(closed.is_cancelled());
        assert!(!open.is_cancelled());
        let pending = service.pending.lock().unwrap();
        assert!(!pending.contains_key("q1"));
        assert!(pending.contains_key("q2"));
    }

}
