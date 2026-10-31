# Under the hood

Catalex is a local-first desktop app. Your document remains a folder of ordinary files; the app keeps its own working state separately.

## Your files and app data

Source files, images, bibliographies, and other project assets stay in the folder you open. New projects use `~/Documents/Catalex` when no earlier project location is available. Imports and captures may add files under `attachments/`.

On macOS, Catalex uses these locations:

| Location | Contents |
| --- | --- |
| `~/Library/Application Support/Catalex-Electron` | Settings, recent projects, workspace state, and PDF snapshots |
| `~/Library/Application Support/com.catalex.desktop` | Project registry, comments, Rewind history, conversations, and agent drafts |
| `~/Library/Caches/com.catalex.desktop` | LaTeX build output and intermediate files |

A copy of the project folder preserves its source files. To preserve Catalex's local comments and history as well, include its application-support data in your Mac backup. Avoid editing app-managed data while Catalex is running.

## Agent drafts

Catalex prepares a separate working draft for an agent. The agent can make a batch of edits there, and you review the proposed changes before they are applied to the project.

This review boundary is separate from the agent's tool permissions. Agents run locally and may connect to external model services or access other files using your account's permissions. See [Working with agents](agents.md#know-the-boundary).

## What syncs

Git pushes the project files you commit. Catalex's comments, chat sessions, private drafts, and Rewind history live outside that repository and stay on this Mac. Comments do not sync into Overleaf or GitHub.

Rewind uses a private local history. Your project's Git history belongs to the repository and its remotes. Neither replaces a backup of your project and local app data.

## Updates

Automatic updates are currently disabled. Install a newer release from the [download page](https://ricercarg.github.io/catalex.github.io/download/) when one is available. Current releases are for Apple Silicon Macs.

For the implementation, see the [developer architecture guide](development/architecture.md).
