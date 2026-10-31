# Getting started

Catalex currently supports Apple Silicon Macs. The app guides you through setup when you first open it.

## Install LaTeX

For local compilation with LaTeXmk, install [MacTeX](https://www.tug.org/mactex/mactex-download.html), the macOS distribution of [TeX Live](https://www.tug.org/texlive/). If it is already installed, you can keep using it.

With [Homebrew](https://formulae.brew.sh/cask/mactex-no-gui), you can install it without the extra GUI apps:

```sh
brew install --cask mactex-no-gui
```

The full distribution is several gigabytes, so allow time for the download and installation. Reopen Catalex afterward so setup can detect the tools.

## Open a project

[Download Catalex](https://ricercarg.github.io/catalex.github.io/download/), open the DMG, and drag the app to Applications. Launch it and follow the setup checks.

Choose **Open Folder** to use an existing project, or create a blank document or a project from a template. To bring in an Overleaf project, choose **Import from Overleaf**. See [Sync and recovery](sync-and-recovery.md#overleaf) for the connection details.

Keep the whole project folder together, including its bibliography, images, and included files. You can continue opening these ordinary files in other editors.

## Add an agent when you need one

Catalex works with local Claude Code, Codex, and Pi. Install and sign in to your chosen agent, then select it in Catalex. You can also write and compile without an agent.

See [Working with agents](agents.md) for setup and review, or go straight to [Writing](writing.md).
