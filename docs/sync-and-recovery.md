# Sync and recovery

Use **Rewind** to recover local work and **Git** to exchange project files. Catalex keeps those histories separate so a local recovery point does not create an unwanted commit in your shared repository.

## Rewind

Open **Rewind** to browse saved project versions, compare changes, and restore earlier work. Catalex records local history as you work; you can also save a version deliberately and give it a label before a larger edit.

Rewind uses a private local Git history, separate from the project's own `.git` repository. Restoring files does not rewrite the remote repository's history. Review the result before committing or pushing it.

Rewind's management controls let you set a history storage limit and clear history. Reducing the limit can prune older versions; labels help identify versions you care about, but Rewind is not a replacement for an independent backup.

## Git remotes

Use Catalex's built-in Git controls to inspect changed files and diffs, select what to commit, manage branches, and pull or push. The app works with your project's own repository and configured remotes, including GitHub; it does not require a separate Git GUI.

A typical cycle is to pull collaborators' changes, edit and review your work, commit selected files, then push. The interface also handles merge conflicts and repository operations such as stash and rebase. Complete or abort an unfinished operation before starting another incompatible action.

Catalex uses your Git authentication setup. If an HTTPS operation fails authentication, its credential dialog identifies the host and operation and lets you retry with the appropriate username and token. Verified credentials are saved through your configured Git credential helper.

## Overleaf

Choose **Import from Overleaf** and provide the project's Git clone command and access token when requested. Catalex clones the files locally and connects the project to the Overleaf Git remote.

Commit and push to send file changes back; pull to receive changes made in Overleaf. This depends on having access to Overleaf's [Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration). Comments in Catalex remain local and do not become Overleaf comments.

## Collaborating

Catalex does not currently provide live shared editing. Collaborators can exchange committed files through GitHub, Overleaf, or another Git remote. Pull before a session, keep commits focused, and resolve overlapping edits when syncing.

| Goes through your project Git repository | Stays in this Catalex installation |
| --- | --- |
| Files you commit: source, images, `.bib` files, project instructions | Comments, saved chats, pending drafts, Rewind history, app settings, and account connections |

## Backups and local data

Your project folder holds the ordinary files. Catalex keeps review state and local working data separately, so they do not clutter your manuscript or get pushed accidentally.

On macOS:

| Location | Contents |
| --- | --- |
| `~/Library/Application Support/Catalex-Electron` | Settings, workspace recovery state, and PDF snapshots |
| `~/Library/Application Support/com.catalex.desktop` | Project registry, comment database, saved conversations, private history, and agent drafts |
| `~/Library/Caches/com.catalex.desktop` | LaTeX build output and intermediate files |

Back up the project folder and both application-support locations to preserve the files and their local context. Quit Catalex before making a manual copy of app-managed data, and use the app's controls rather than editing its database or draft folders by hand.

**Settings → Storage** shows project data and cache usage, with controls to clear categories or reveal their folders. Clearing comments, chat data, drafts, or history is different from removing rebuildable output; read the selected action before confirming it. Active projects and shared agent/history storage have checks to prevent incompatible cleanup. Unused build caches can be cleaned automatically without deleting source projects.
