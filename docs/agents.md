# Working with agents

Bring the local agent you already use. Catalex connects it to your project, selected text, compilation results, and document tools. Your existing provider account and its usage limits still apply.

## Connect an agent

Install and sign in to Claude Code, Codex, or Pi on your Mac first. In **Settings → Agent**, check the detected setup and choose the executable or configuration path if it was not found automatically.

Pi is optional: enable it in **Settings → Agent → Pi** and select its executable and config folder. The Pi integration has been checked with Pi 1.2.0.

If an agent cannot start, check the selected path and try the agent in a terminal. Authentication and subscription problems need to be resolved with that agent or provider.

## Give it a clear task

Choose an agent and model in the chat, then describe what you want to change. Select text or attach relevant context when the request concerns a particular passage, figure, or compilation error.

For example: “Tighten this abstract while keeping the claims and citations unchanged.” Your agent can inspect the project, edit files, compile the document, and use Catalex tools to inspect pages or work with comments.

You can switch agent providers in one conversation. Catalex carries the visible conversation forward; each provider still has its own capabilities and context limits. Available skills depend on your agent and its configuration.

## Review the changes

The agent prepares project edits in a separate draft. You can keep writing while it works. When changes are ready, open the review and accept or reject them. Use **Accept All** or **Reject All** when the whole proposal is clear.

Accepted edits are applied to your project. If your own edits overlap, resolve the review before continuing. A draft is not a Git push: [syncing with a remote](sync-and-recovery.md#git-remotes) is a separate action.

## Know the boundary

Drafts keep proposed project edits separate until review. They are not an operating-system security sandbox. An agent or its extensions may run tools with your user account's permissions and can access paths outside the draft.

Your local agent also connects to its configured model service. That service's data handling and billing apply to requests sent through it. See [Under the hood](under-the-hood.md) for storage and integration details.
