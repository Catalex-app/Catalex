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

Packaged downloads are coming soon on [GitHub Releases](https://github.com/Catalex-app/Catalex/releases). For now, [build Catalex from source](development/setup.md), then follow the onboarding checks.

Choose **Open Folder** for an existing project, start a blank document, or choose a template. **Import from Overleaf** brings in a project through its [Git connection](sync-and-recovery.md#overleaf).

Your project remains a folder of ordinary files. Keep its source, bibliography, images, and included files together; you can continue using other editors with the same folder. New projects use `~/Documents/Catalex` when no earlier project location is available.

## Connect an agent

Install and sign in to Claude Code, Codex, or Pi locally, then check **Settings → Agent**. Catalex uses your existing agent account and configuration. See [Working with agents](agents.md#connect-an-agent) for provider setup.

Start with [Your workspace](workspace.md), or open a file and begin [writing](writing.md).

## Install updates

Automatic updates are currently disabled. When packaged releases become available, download new versions from [GitHub Releases](https://github.com/Catalex-app/Catalex/releases) and install them manually.
