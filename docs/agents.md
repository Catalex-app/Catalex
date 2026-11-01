# Working with agents

Catalex connects your local agent to the writing workspace: project context, compilation, previews, comments, and review. It uses your existing agent account, skills, and provider limits.

## Connect an agent

Install and sign in to **Claude Code**, **Codex**, or **Pi** on your Mac. In **Settings → Agent**, enable the providers you want, check their detected setup, and choose another executable or configuration path when needed. Pi's integration has been checked with Pi 1.2.0.

Choose a provider, model, and available thinking-effort setting in the composer. Defaults live in Agent settings; the model list comes from the selected provider. The composer shows context usage and, where supported, subscription allowance; use its refresh action to request updated usage. If setup fails, check the chosen path and try that agent in a terminal. Authentication, subscription, and model availability belong to that provider.

## Add context

Describe the task in chat, then attach the material that matters. For example: “Tighten this abstract while preserving the claims and citations.”

- Type **`@`** to find a project file. Use the arrow keys to choose it, then Enter or Tab to attach it.
- Select a passage in source or preview to attach that text. Selection context includes its file and location where available.
- Add files or images through attachments, drag and drop, or clipboard input. Compilation errors and comments can also be sent to chat from their own controls.

Context appears as badges above the input. Inspect or remove a badge before sending. Captured selections, comments, and draft passages describe the version you attached; they are not a promise that the text will remain unchanged while the agent works.

## Commands and skills

Type **`/` at the start of the input** to browse commands and skills for the selected provider. Search by name or description, choose a category, and use the preview to read what a skill does before selecting it. Arrow keys navigate, Enter or Tab selects, the right arrow opens an available preview, and Esc closes the picker.

The catalog brings together Catalex's writing skills and the skills discovered from your provider's project, user, and supported plugin locations. Claude and Codex use their respective `.claude/skills` and `.codex/skills` folders; Pi reports skills from its selected configuration. Providers expose different catalogs, so switching one can change the list.

Catalex includes skills for **reviewing documents with passage-specific comments** and **compiling, fixing, and inspecting LaTeX changes**. Their displayed command names follow the provider's syntax. Add your request after selecting a skill. **`/compact`** asks the current provider to condense a long conversation; it does not start a new project.

## Project instructions

Use **System Prompts** in the sidebar to open or create the project's instruction files: `CLAUDE.md` for Claude, and `AGENTS.md` for Codex or Pi. These are ordinary project files you can review and share through Git.

**Settings → Agent → Global Instructions** holds the app-wide instructions added to agent requests. Keep general writing preferences there and project-specific conventions in the project's instruction file. Provider configuration and skills continue to follow the selected agent's own rules.

## Conversations and provider switching

Use a new chat tab for a separate task. You can switch providers within one conversation; Catalex carries the visible history forward and tracks each provider's session separately. This lets you ask another agent to continue the discussion without pretending that different providers share the same internal memory or context limits.

Chats are saved locally with their provider session references and review decisions. Resume a saved chat from the conversation list, or use **Fork from this response** to explore another direction from an earlier answer. Archive a finished chat to clear the active tabs and restore it from the saved list when needed. Resolve pending work before archiving when the app asks.

Restarting Catalex restores saved conversation state, not a still-running agent process. If a previous run was interrupted or its provider session cannot resume, use the recovery choices shown in chat.

## Review and apply changes

Each agent task works in a separate Git worktree draft, so you can keep writing in the source project. The approval mode controls how the completed proposal is handled:

- **Manual:** inspect the changes, accept or reject individual edits, or use **Accept All** / **Reject All**.
- **Auto:** apply clean changes automatically and pause when conflicts or errors need attention.

Choose the mode in the composer, or press **Shift+Tab** while idle. Agent settings provide the default. This controls Catalex's draft review, separately from a provider's tool-permission questions.

If you and an agent edited the same passage, the review compares the versions and lets you resolve the overlap. Several chats can have proposals; Catalex queues review and application so each draft is checked against the current project. Accepting a draft does not commit or push your project's [Git remote](sync-and-recovery.md#git-remotes).

## Working, waiting, and stopping

Chat status distinguishes an agent that is working, waiting for an answer, ready for review, queued for review, or paused. A question appears in the conversation with choices or a text answer. Answer it there so the response returns to the waiting agent.

You can prepare follow-up messages while an agent works. Queued prompts can be edited, reordered, or removed before they run. A paused queue shows **Resume queue**; resolve the question, review, or error that needs attention first.

Use **Stop** to interrupt a run, then inspect its messages and any draft. Stopping does not undo changes already accepted or applied. The composer offers **Continue** when a paused task can be resumed. Provider errors stay visible with recovery actions rather than being treated as successful completion.

## Document tools

Catalex exposes a local **MCP** connection—the Model Context Protocol—to the agent running in the app. You do not need to configure another server for these built-in tools.

| Tools | What the agent can do |
| --- | --- |
| `compile`, `diagnostics` | Build the active draft with the document's compiler settings and inspect actual errors |
| `render_page` | Inspect rendered PDF pages after compilation |
| `workspace_state` | Read the active document root, compiler choice, and latest build status |
| Comment tools | Read, create, edit, resolve, or delete passage-specific comments |
| `ask_user` | Ask a question inside the conversation and wait for your answer |

The connection belongs to that chat and active turn. Compilation and page inspection use the draft rather than silently switching to another conversation's document. [Comment actions](comments.md#work-with-an-agent) update the shared comment store separately from text review.

Draft review is a writing workflow, not an OS security sandbox. Local agents and their extensions retain their own tool permissions, and requests to model services follow the provider's data-handling policies. Catalex's saved conversations and drafts remain local; see [backup and sync boundaries](sync-and-recovery.md#backups-and-local-data).
