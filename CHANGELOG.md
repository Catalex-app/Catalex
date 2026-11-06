# Changelog

## [Unreleased]

- Share PDF-style fit and percentage zoom controls with image previews, and remove image cropping.

- Collapse prompt suggestions by default for standalone PDFs, images, and binary files. New chats expand them again on editable files, while pinning keeps them open and manual choices last until the file or chat changes.

- Keep PDF comment creation in the floating selection toolbar and remove its duplicate right-click menu action.

- Open files and saved chat sessions in pop-outs from their sidebar context menus, preserving the main selection and reusing existing windows.

- Let the Files menu send a file directly to the main chat or an open chat pop-out, with shared status badges and an inline chat chooser. Preserve existing drafts and whole-file references.

- Extend the document minimap to standalone PDFs and LaTeX previews, with page navigation, a draggable viewport, and human/agent comment markers using the existing styling and settings.

- Let agents read standalone PDF pages and create anchored review comments, using verified text and document fingerprints. Existing comment tools can edit, resolve, reopen, and delete PDF comments.

- Add comments to directly opened PDF selections, with page highlights, existing comment actions, pop-out synchronization, and restart persistence. Keep comments disconnected when the PDF bytes change, without modifying the PDF file.

- Reveal expanded-panel icons and labels together without clipping the Pop out and Restore text during their entrance.

- Make directly opened PDFs follow workspace panel resizing with the same scaling and final sharp render as LaTeX previews, preserving reading position and manual zoom.

- Make panel header gestures discoverable with a hand cursor and tooltip, and label the expanded view's Pop out and Restore buttons.

- Identify PDF selections by their document and page even when source mapping is unavailable, and keep matching passages from different PDFs as separate chat attachments.

- Reuse one LaTeX preview pop-out per root document, including when opened from different chapter files. Keep its page and zoom, and keep it open when an included file is deleted.

- Send selections from editor and PDF pop-outs to the main chat or an open chat pop-out. The selection is pinned in the chosen chat without submitting a prompt or replacing its draft. Main-window selections continue to supply live context automatically.

- Add a customizable prompt library with optional icons and a searchable icon picker in Agent settings, with cards in empty chats and compact suggestions beside the mini-mode chat switcher. Prompt clicks send in the current conversation while preserving the typed draft.
- Simplify prompt availability to Always, Has text selection, or Has issues, with automatic text context. The four defaults are Improve writing (including proofreading), Fix issues, Review & comment, and Tighten layout.

- Keep editor pop-outs open through agent review, with synchronized edits and decisions. Main-workspace selections supply live context to open chats; editor and PDF pop-outs retain reference and review actions without sending new agent requests. Fade the chat drawer smoothly when focusing and restoring a panel.

- Open editor, preview, and chat panels in synchronized native windows; editor and preview windows stay pinned to their files, and each chat can have its own pinned window. Reopening a panel focuses its existing window.

- Temporarily expand editor, preview, and chat panels across the app, with a shared header control and Escape to restore the workspace.

## [0.1.1]

- Prioritize exact conference matches in the deadline picker, with highlighted search text and separate exact and fuzzy result sections.
- Stop a running compilation from the compile button or compilation menu while preserving the last published PDF and source mapping.
- Automatically update the Homebrew tap after publishing a stable macOS release.

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
