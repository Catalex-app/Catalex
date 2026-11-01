# Changelog

## [Unreleased]

- Check GitHub Releases for updates from the welcome and project sidebars or Settings → About, with manual installation and remembered per-version skips.

## [0.1.0-beta]

- First beta preview for Apple Silicon Macs, with local LaTeX writing, PDF previews, agent drafts, comments, recovery, and Git sync.
- Adopt GNU AGPLv3-or-later for Catalex, preserving the Claude bridge's MIT license and upstream and third-party notices.
- Improve macOS beta packaging and include installation instructions.
- Updates are manual. This beta is not signed with an Apple Developer ID or notarized.

Copy `Catalex.app` to Applications. If you trust the download and accept the risk of bypassing its quarantine protection, run:

```sh
xattr -dr com.apple.quarantine /Applications/Catalex.app
```

This command removes Catalex's quarantine flag. Use this beta at your own risk.

## [0.1.0]

- Introduce Catalex, a focused, local-first LaTeX writing workspace for Apple Silicon Macs.
- Compile with local LaTeXmk and work with source files, PDF previews, and document comments in one workspace.
- Connect installed Claude Code, Codex, or Pi agents with existing subscriptions and skills.
- Review agent changes in private drafts, let agents create and resolve comments, and recover earlier edits through local history.
- Sync project files with Overleaf or GitHub through the in-app Git controls.
