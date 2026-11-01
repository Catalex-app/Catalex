# Changelog

## [Unreleased]

## [0.1.0-beta]

The first public beta of Catalex, a free, local-first LaTeX writing workspace for Apple Silicon Macs, released under AGPL-3.0-or-later.

### In this beta

- A focused writing workspace with integrated agent conversations and PDF previews.
- Local LaTeXmk compilation with your existing TeX installation.
- Claude Code, Codex, and Pi support using your installed agents, subscriptions, and skills.
- Agent changes prepared in isolated worktrees for your review before they are applied, with agent comment creation and resolution.
- Local edit recovery and an in-app Git GUI for syncing project files with Overleaf or GitHub.
- Update notifications for newer beta and stable releases, with manual installation and remembered per-version skips.

### Install

Requires macOS 13 or later on Apple Silicon. Install LaTeXmk through MacTeX or another TeX distribution for local compilation. Agent connections are optional; onboarding checks your tools when you first open Catalex.

Download the DMG below, open it, and copy `Catalex.app` to Applications.

**This beta is for testing and is not signed with an Apple Developer ID or notarized.** macOS may block it. If you trust this download and accept the risk, run:

```sh
xattr -dr com.apple.quarantine /Applications/Catalex.app
```

This removes the quarantine flag from Catalex only. Use this beta at your own risk.

### Current limitations

- Apple Silicon Macs only.
- Local-first, without live multi-user collaboration. Use Git to share project changes.
- Comments stay in Catalex and do not sync to Overleaf or GitHub.
- Updates require a manual download and installation; automatic installation and restart are not enabled.
