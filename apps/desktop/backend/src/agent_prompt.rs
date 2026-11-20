//! What every agent is told at the start of a session. All providers get the
//! same text; only the names that differ between them are filled in. How the
//! app works in detail belongs in the guide skill, not here.
use crate::branding::PRODUCT_NAME;
use std::sync::OnceLock;

#[derive(Clone, Copy)]
pub(crate) enum Provider {
    Claude,
    Codex,
    Pi,
}

impl Provider {
    /// How this provider's model refers to one of the built-in skills.
    fn skill(self, name: &str) -> String {
        match self {
            Self::Claude => format!("the {}:{name} skill", crate::branding::NAMESPACE),
            Self::Codex => format!("${name}"),
            Self::Pi => format!("the {name} skill"),
        }
    }
    /// The provider's own question tool, which the app's UI cannot show.
    fn own_question_tool(self) -> &'static str {
        match self {
            Self::Claude => " instead of AskUserQuestion",
            Self::Codex => " instead of request_user_input",
            Self::Pi => "",
        }
    }
    fn plan(self) -> &'static str {
        match self {
            Self::Claude => "plan first with TodoWrite and mark each step done as you go",
            Self::Codex | Self::Pi => "plan first and work through the plan one step at a time",
        }
    }
}

/// Rules for the comment tools. They apply in every turn, so they live in the
/// session text and are not repeated in each tool description.
fn comment_rules() -> &'static str {
    "To leave a comment, use create_comment with a project-relative path and an exact passage; for a standalone PDF, call read_pdf first and pass its page and fingerprint. Comment changes apply directly in every approval mode. Use list_comments before editing, resolving, or deleting, and reread on a revision conflict. Before changing existing comments, briefly say what you intend; one notice can cover a related group and needs no reply. Prefer resolving to deleting; delete only when asked. When a comment should be resolved because of text you propose in this draft, call resolve_comment with when \"accepted\": the app resolves it once the user accepts every proposed edit in that file, and keeps it open otherwise. Do not wait for the text decision and do not resolve such a comment now. Never edit the comment storage files comments.json or comments-agents.json."
}

pub(crate) fn system_prompt(provider: Provider) -> &'static str {
    static TEXTS: [OnceLock<String>; 3] = [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    TEXTS[provider as usize].get_or_init(|| {
        [
            format!("You are working inside {PRODUCT_NAME}, a desktop app for writing LaTeX and Markdown documents."),
            "Drafts: your edits go to a draft of the project in the current working directory. The user reviews the draft in the app and accepts or rejects each change. Do not write to the original project, and never assume a change was accepted. A later turn may get a new draft folder: paths to earlier drafts in this conversation are out of date, so always work in the current working directory.".into(),
            format!("Editing: for a task with several steps, {}. Read a file before changing it. Make small, targeted edits and never rewrite a whole file. Keep the existing preamble, packages, and structure unless the task needs them changed. Use proper sectioning, citations, cross-references, and BibTeX.", provider.plan()),
            format!("Tools: {PRODUCT_NAME}'s MCP tools compile the draft, render pages, read standalone PDFs, manage comments, and ask the user a question. Ask through ask_user{}.", provider.own_question_tool()),
            format!("LaTeX: after changing LaTeX sources, follow {}: compile before finishing, and render pages when the layout matters.", provider.skill("catalex-verify-latex")),
            format!("Reviews: for a document review or critique, follow {}. Do not rewrite sources during review-only work.", provider.skill("review-document")),
            format!("Comments: {}", comment_rules()),
            format!("The app: for how {PRODUCT_NAME} works, where a setting is, or a problem that may come from an app setting, read {}. The user's app settings are not yours to change: say which setting it is and where the user changes it.", provider.skill("catalex-guide")),
            "Other skills: if the project has skills installed, follow them for domain tasks.".into(),
        ]
        .join("\n")
    })
}

/// The session text for a provider named by the renderer, shown read-only in
/// Settings so the user sees what every chat already gets.
pub(crate) fn app_instructions(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude" => Ok(system_prompt(Provider::Claude)),
        "codex" => Ok(system_prompt(Provider::Codex)),
        "pi" => Ok(system_prompt(Provider::Pi)),
        other => Err(format!("Unknown agent provider: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_gets_the_same_rules_in_its_own_terms() {
        let texts = [Provider::Claude, Provider::Codex, Provider::Pi].map(system_prompt);
        for text in texts {
            for needed in [PRODUCT_NAME, "draft", "earlier drafts", "ask_user", "list_comments", "when \"accepted\"", "catalex-guide", "catalex-verify-latex", "review-document"] {
                assert!(text.contains(needed), "{needed}");
            }
            // A session start is paid for by every conversation.
            assert!(text.len() < 2800, "{}", text.len());
            assert_eq!(text.lines().count(), texts[0].lines().count());
        }
        assert!(texts[0].contains("the catalex:catalex-guide skill") && texts[0].contains("TodoWrite"));
        assert!(texts[1].contains("$catalex-guide") && texts[1].contains("request_user_input"));
        assert!(texts[2].contains("the catalex-guide skill") && !texts[2].contains("instead of"));
    }

    #[test]
    fn settings_show_the_text_each_provider_gets() {
        assert_eq!(app_instructions("claude").unwrap(), system_prompt(Provider::Claude));
        assert_eq!(app_instructions("codex").unwrap(), system_prompt(Provider::Codex));
        assert_eq!(app_instructions("pi").unwrap(), system_prompt(Provider::Pi));
        assert!(app_instructions("other").is_err());
    }
}
