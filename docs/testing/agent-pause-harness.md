# Agent stop, pause, and continue

Open `/?debug=agent-pause` against Vite for Codex, or append `&provider=claude` for Claude. The harness mounts the real composer, chat store, and provider event hook; only native IPC and document IO are simulated. Toggle layout and theme to inspect the compact/expanded composer in light/dark mode.

1. Click Stop. The control becomes disabled with “Stopping…” until the simulated terminal event arrives. Confirm Send returns, Continue is absent, and the conversation remains available. Only one cancellation is logged.
2. Close and reopen the project after Stop. A new chat receives focus; the stopped conversation stays in history without a paused indicator. Proposed edits, if any, enter the normal review flow without being applied to source.
3. Reload the harness to start running work. Click Back to welcome while it is running, then Reopen project. The original conversation receives focus with Continue.
4. Click Continue. The log must show `resume_codex_code` or `resume_claude_code` with `native-session`, and the chat must contain one continuation message.
5. While paused, type a different instruction and confirm Send replaces Continue. Clear the input and Continue returns.

Manual Stop finishes the current turn and pauses queued prompts. It does not archive the conversation or accept proposed edits. Stop before native launch cancels preparation without launching a provider; any existing draft returns to review. Stop during native launch waits for startup acknowledgement before interrupting the original tab, even if the user switches chats. Failed cancellation leaves the running turn available for another Stop attempt.

Project closure and unexpected interruptions preserve a paused turn. Pause keeps the isolated draft active instead of reconciling, applying, or deleting it. A pause before native launch retains the original request and context; Continue retries it without duplicating the visible user message. Checkpoint recovery preserves this distinction, including a saved Stop whose provider completion had not arrived before exit. An unfinished stopped draft is recovered into review rather than resumed automatically.

Claude uses the SDK's persistent query interrupt, as does [Claudian's persistent execution strategy](https://github.com/YishenTu/claudian/blob/main/src/providers/claude/execution/ClaudeExecutionStrategies.ts). Catalex now waits for both the interrupt acknowledgement and terminal result before reusing that query. A failed or timed-out interruption closes it; the next prompt resumes the saved session.

Codex uses `turn/interrupt` and waits for `turn/completed`, following the [official app-server lifecycle](https://developers.openai.com/codex/app-server). If completion never arrives, Catalex closes the runtime after a bounded wait. A completion claim prevents the shutdown fallback and old listener from both completing the turn. Transport closure explicitly wakes pending listeners.

Regression coverage: `agent-stop-harness.spec.ts`, `project-chat-lifecycle.test.ts`, `agent-workspace.test.ts`, `multi-tab-merge.test.ts`, `use-agent-events.test.tsx`, sidecar `interrupt-turn.test.ts`, and the Codex completion/timeout tests in `codex.rs`.
