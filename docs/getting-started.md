# Getting started

Catalex currently supports Apple Silicon Macs. Onboarding checks your tools when you first open the app; you can write without connecting an agent.

## Prepare LaTeX

For local compilation with LaTeXmk, install [MacTeX](https://www.tug.org/mactex/mactex-download.html), the macOS distribution of [TeX Live](https://www.tug.org/texlive/). If you already have a working installation, keep using it.

With [Homebrew](https://formulae.brew.sh/cask/mactex-no-gui):

```sh
brew install --cask mactex-no-gui
```

This installs the TeX tools without the extra GUI apps. The full distribution is several gigabytes, so allow time for the download and installation. Reopen Catalex afterward so setup can detect it.

## Open a project

Download the latest beta for Apple Silicon Macs from [GitHub Releases](https://github.com/Catalex-app/Catalex/releases). Open the DMG, drag **Catalex.app** to **Applications**, then launch Catalex and follow the onboarding checks.

The beta is not yet signed or notarized, so macOS may block the first launch. Follow the instructions on the release page if you trust the download. You can also [build Catalex from source](development/setup.md).

Choose **Open Folder** for an existing project, start a blank document, or choose a template. **Import from Overleaf** brings in a project through its [Git connection](sync-and-recovery.md#overleaf).

Your project remains a folder of ordinary files. Keep its source, bibliography, images, and included files together; you can continue using other editors with the same folder. New projects use `~/Documents/Catalex` when no earlier project location is available.

## Connect an agent

Install and sign in to Claude Code, Codex, or Pi locally, then check **Settings → Agent**. Catalex uses your existing agent account and configuration. See [Working with agents](agents.md#connect-an-agent) for provider setup.

Start with [Your workspace](workspace.md), or open a file and begin [writing](writing.md).

## Install updates

Catalex checks [GitHub Releases](https://github.com/Catalex-app/Catalex/releases) once at launch and every 24 hours while running. After sleep, it checks if due. Use the refresh icon in **Settings → About** to check immediately. The welcome and project sidebars share the same update state. When an update is available, an **Update** button appears between Settings and the appearance control. It opens **Settings → About**, where **Install update** opens the release page so you can download and install it manually. **Skip this version** hides that version’s sidebar prompt, including after a restart. Refresh keeps that version skipped; newer versions will still be shown. **View release** opens a skipped version’s release page without clearing the skip. Automatic installation and restart are currently disabled.

Beta builds check for newer beta and stable releases; stable builds check for stable releases only. Draft releases are ignored. Downloads currently support Apple Silicon Macs.
