# Changelog

## [Unreleased]

## [0.3.0]

### TL;DR

- Use native menus for file, editing, comment, and workspace actions.
- Work more comfortably in narrow windows, with steadier chat sizing and consistent Find controls.
- Resize PDF comment highlights and manage your personal spelling dictionary.

### Full Changelog

- Native menus: Access New File, recent projects, Save, PDF export, Find and Replace, formatting, comments, workspace views, panel expansion, pop-outs, and interface zoom. Menu state follows the focused panel, document type, and customized shortcuts across windows and restarts.
- About and updates: Show the app name and version in the native About dialog. Check for Updates opens Settings → About and shares the existing update check, including its busy state.
- Workspace sizing: Preserve usable pane widths and each project's preferred sidebar width as the window shrinks. Keep resize handles clear of source/preview navigation controls and fit header actions, comments, and minimaps into narrow panes.
- Chat sizing: Adapt composer controls to the available width while keeping typed slash commands and mentions available. Stabilize draft and question heights, scrolling, focus, and Mini/Half/Full transitions. Restore missing Half-mode chat history and preserve the preferred drawer height after temporary viewport limits.
- Chat actions and context: Open saved chats in pop-outs from shared context menus, and confirm before archiving. Attach selected document context to custom answers while an agent question is pending.
- Find: Use consistent info bars to search text and comments in the editor, Markdown, and PDFs, and search saved chat history. Preserve queries and options, route Find to the active pane, and keep PDF search through recompilation. Close search explicitly with its close control.
- Context menus: Keep keyboard and mouse input with the open menu, consume outside clicks when dismissing, and restore normal input afterward. Preserve the source row's highlight while its menu is open.
- Comments: Fit comment cards and navigation controls into narrow panes. Support Command+Enter for a new line and copy comment content. Keep Markdown comment creation in selection controls and the native Edit menu.
- PDF comments: Drag either endpoint to resize a standalone PDF highlight, with text snapping, live preview, undo/redo, and persistence across pop-outs and restarts. Include overlapping comments when sending selected PDF text to chat.
- Spell Check settings: Group spell-check controls in a dedicated tab. View and remove personal dictionary words, with changes synchronized across windows and saved after restart.
- Appearance: Apply Light, Dark, and System preferences to Electron's native interface. Match window backgrounds to the app theme during resizing and across windows.
- Navigation: Briefly highlight the destination after locating an editor or preview position. Restore pointer access to expanded panels during project transitions.
- Sidebar: Show unresolved human and agent comments alongside warnings and errors. Switch multiple indicators between stacked and separate layouts, with a saved app-wide preference and reduced-motion support.
- Project transitions: Animate opening and closing projects with staggered horizontal movement, revealing the returning project's row first. Respect reduced motion and recover from interrupted or failed navigation.

## [0.2.1]

### TL;DR

Better markdown preview support, for MathJax, richer HTML, and easier navigation.

### Full Changelog

- Markdown navigation: Follow links to headings, HTML anchors, and source lines. Use Jump back to return, dismiss it manually, or clear it by scrolling past the return position.
- File drag and drop: Insert relative file links into Markdown, with a caret showing where they will land. Renamed the sidebar action to “New File.”
- Richer rendering: Support sanitized HTML formatting and colors, plus language-aware code highlighting, including LaTeX. Fixed checklist markers in GitHub Light.
- Math engines: Choose KaTeX or MathJax per file and configure the default in Rendering settings. Preferences persist across windows and restarts. Wide MathJax equations scroll horizontally, and inline equations remain inline in PDF exports.
- Preview settings: Keep the menu open while making selections, with content-sized layouts and animated transitions. Show up to five recent Typora themes without reordering existing rows, and open the full theme list at the current selection.
- Theme previews: Show three outlined color squares for GitHub and Typora themes in both preview and settings menus, with neutral fallback colors.

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
