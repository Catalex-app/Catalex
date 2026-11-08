# Changelog

## [Unreleased]

- Choose KaTeX or MathJax from the Markdown preview menu, with independent theme choices, up to five recent Typora themes, and a second-level full theme list that opens at the current selection. The math-engine preference is saved per project/file and stays consistent across windows and restarts. Files without an explicit choice follow the configurable default in Rendering settings, initially KaTeX. Wide MathJax displays scroll horizontally, and inline math stays inline in PDF exports.

- Highlight Markdown fenced code blocks by language, including LaTeX, with light and dark preview colors and custom-theme overrides.

- Follow Markdown links to headings, HTML anchors, and source lines, with a Jump back popup to restore the previous preview position. Insert relative links by dropping files into the Markdown editor, with a caret showing the insertion point, and render HTML snippets with text formatting and colors.

## [0.2.0]

### TL;DR

- Expand workspace panels with a double-click on the header, or open them in a pop-out window with Option + double-click.
- Add comments and navigate with the minimap in PDF files.
- Access built-in prompts from the new prompt bar.

### Full Changelog

- Open editor, preview, and chat panels in synchronized native pop-out windows. Keep file windows pinned to their documents and reuse existing windows, including one LaTeX preview per root document.
- Expand panels across the workspace, with shared controls, discoverable header gestures, and smooth restore transitions.
- Send selected text, PDF passages, or whole files to the main chat or an open chat pop-out without submitting a prompt or replacing its draft. Identify PDF selections by document and page, including PDFs with the same name.
- Open files and saved chat sessions in pop-outs directly from sidebar context menus, preserving the main selection.
- Keep editor pop-outs synchronized through agent review, edits, decisions, project changes, and application restarts.
- Add comments to standalone PDF selections, with highlights, editing, resolution, pop-out synchronization, and restart persistence. Store comments separately without modifying PDF files, and disconnect them when the PDF bytes change.
- Let agents read standalone PDF pages and create, edit, resolve, reopen, or delete anchored comments using verified text and document fingerprints.
- Add floating document minimaps to standalone PDFs and LaTeX previews, with page navigation, draggable viewports, and comment markers. Share styling and the existing editor minimap setting.
- Give standalone PDFs the same panel-resize scaling as LaTeX previews, preserving reading position and manual zoom. Share PDF-style fit and percentage zoom controls with images, and remove image cropping.
- Add four built-in prompt suggestions: Improve writing, Fix issues, Review & comment, and Tighten layout. Support enable/disable controls and ordering in settings while retaining existing custom prompt data for future customization support.
- Collapse prompt suggestions automatically for standalone PDFs, images, and binary files. Pinning keeps them open; manual expansion choices last until the active file or chat changes.
- Keep PDF comment creation in the floating selection toolbar and remove its duplicate right-click action. Align shared navigation controls and panel header buttons.
- Find installed Homebrew ICU libraries reliably when building the macOS native helper.

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
