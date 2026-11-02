# Changelog

## [Unreleased]

## [0.1.0]

The first stable release of Catalex, a free, local-first LaTeX writing workspace for Apple Silicon Macs.

### Changes

- Developer ID signed for the macOS app. No quarantine flags anymore.
- Includes the writing workspace, Claude Code, Codex and Pi integrations, isolated agent drafts, PDF preview, local compilation, Git sync, and edit recovery introduced in the public beta.

### Install

Requires macOS 13 or later on Apple Silicon. Download `Catalex-0.1.0-arm64.dmg`, open it, and drag **Catalex.app** into **Applications**.

Install LaTeXmk through [MacTeX](https://tug.org/mactex/mactex-download.html) or another TeX distribution for local compilation. The onboarding wizard checks compiler and agent availability.

## [0.1.0-beta]

The first public beta of Catalex, a free, local-first LaTeX writing workspace for Apple Silicon Macs.

### In this beta

- A focused writing workspace with integrated agent conversations and PDF previews.
- Local LaTeXmk compilation with your existing TeX installation.
- Claude Code, Codex, and Pi support using your installed agents, subscriptions, and skills.
- Agent changes prepared in isolated worktrees for your review before they are applied, with agent comment creation and resolution.
- Local edit recovery and an in-app Git GUI for syncing project files with Overleaf or GitHub.
- Update notifications for newer beta and stable releases, with manual installation and remembered per-version skips.

### Install

Requires macOS 13 or later on Apple Silicon. Install LaTeXmk through [MacTeX](https://tug.org/mactex/mactex-download.html) or another TeX distribution for local compilation. An onboarding wizard will check your latex compiler and agent availability when you first open Catalex.

Download the "Catalex-0.1.0-beta-arm64.dmg" below, open it, and copy `Catalex.app` to Applications.

**This is not yet signed so macOS may block it on first launch. You can remove its quarantine flag with terminal command:**

```sh
xattr -dr com.apple.quarantine /Applications/Catalex.app
```

This applies only to Catalex and does not disable Gatekeeper system-wide.

You can also [build Catalex from source](https://github.com/Catalex-app/Catalex/blob/main/docs/development/setup.md). Bug reports and feedback are welcome as we refine the beta.

### Current limitations

- Apple Silicon Macs only.
- Local-first, without live multi-user collaboration. Use Git to share project changes.
- Comments stay in Catalex and do not sync to Overleaf or GitHub.
- Updates require a manual download and installation; automatic installation and restart are not enabled.
