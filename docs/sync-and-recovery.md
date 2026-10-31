# Sync and recovery

Use **Rewind** to recover local work and **Git** to share project files. They serve different purposes and keep separate histories.

## Rewind

Catalex keeps local project history as you work. Open **Rewind** to browse earlier versions, compare changes, and restore the version you need. You can also save a local version and give it a label before a larger edit.

Rewind belongs to this Catalex installation. It does not create commits in your project's Git repository or sync through its remote. Keep a separate backup of work you cannot afford to lose.

## Git remotes

Open the workspace's Git controls to inspect changes, commit, pull, and push. An existing project keeps its own Git repository and remotes; you can configure a remote through the app's Git interface.

A typical cycle is to pull your collaborators' changes, make and review your edits, commit them, then push. Review the selected files before committing. If changes conflict, finish resolving the merge before continuing the sync.

Catalex uses your Git setup and the remote's authentication. If access fails, check the repository URL and credentials for that host.

## Overleaf

Choose **Import from Overleaf** and provide the Git clone command from your Overleaf project, along with its access token when requested. Catalex clones the project locally and connects it to the Overleaf Git remote.

After editing, commit and push to send your file changes back. Pull to receive edits made in Overleaf. Overleaf's [Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration) requires access to that feature on your account or project.

## Collaborating

Catalex does not provide live shared editing. Collaborators can exchange committed project files through GitHub, Overleaf, or another Git remote.

Catalex comments, chat sessions, Rewind history, and pending agent drafts stay local. Pushing the project does not send these to collaborators. See [Under the hood](under-the-hood.md#what-syncs).
