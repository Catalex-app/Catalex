# Testing conventions

Keep module tests beside their source, renderer cross-module tests in `apps/desktop/src/renderer/__tests__/`, and browser/Electron application tests in `apps/desktop/e2e/`. Preserve the existing Rust inline/integration test layout and the sidecar MCP smoke entry point used by Rust tests.

Use the runner for the owning process. Browser mocks do not verify native IPC, subprocesses, packaged resources, or saved state across full application restarts. Prefer tests of externally observable behavior and keep fixtures beside the suite that owns them. Save generated screenshots, traces, and recordings under ignored `output/` directories.

## Source checks

From the repository root:

```sh
pnpm branding:check
pnpm version:check
pnpm exec biome ci
node --test scripts/*.test.mjs
pnpm -C apps/desktop electron:typecheck
```

## Unit and integration tests

```sh
# Renderer unit and cross-module tests
pnpm -C apps/desktop test

# Electron main/preload and host helpers
pnpm -C apps/desktop test:electron

# Claude bridge (requires Bun)
pnpm --filter @catalex/desktop-sidecar test

# Native Rust tests with the platform dependency environment
pnpm build:native --test
```

See [desktop setup](../development/setup.md) for native dependencies. Tests use temporary projects and profiles; never point a smoke test at personal app data or manuscripts.

## Browser harnesses

```sh
pnpm -C apps/desktop exec playwright test -c playwright.config.ts
```

The Playwright configuration starts Vite. See the [browser demo catalog](browser-demos.md) for starting URLs and the full list. Interactive harnesses use `/?debug=<name>`. Useful focused guides cover [agent stop/pause](agent-pause-harness.md) and [sidebar animation](sidebar-animation-harness.md).

For composer transfer or sidebar motion changes, run the owning regression suite:

```sh
pnpm -C apps/desktop exec playwright test -c playwright.config.ts e2e/input-transfer-harness.spec.ts
pnpm -C apps/desktop exec playwright test -c playwright.config.ts e2e/sidebar-animation-harness.spec.ts
```

Inspect rendered behavior and visual fit for UI changes; code checks alone are insufficient.

Formatting regressions are covered by `agent-file-review.spec.ts` (editable review,
applying, and recovery) and `text-editor-header.spec.ts` (background work, panel
focus, and compact toolbars). The review test pauses the mocked backend response
inside the test; the demo needs no special controls. `menu-views-smoke.mjs` checks
the toolbar and native menu together.

## Electron application checks

Build the actual desktop resources first:

```sh
pnpm build:desktop
pnpm -C apps/desktop test:electron-smoke
pnpm -C apps/desktop test:electron-persistence
pnpm -C apps/desktop test:electron-profile
pnpm -C apps/desktop test:electron-windows
node apps/desktop/e2e/electron/updater-smoke.mjs
node apps/desktop/e2e/electron/compile-cancellation-smoke.mjs
node apps/desktop/e2e/electron/panel-window-smoke.mjs
node apps/desktop/e2e/electron/panel-review-smoke.mjs
node apps/desktop/e2e/electron/prompt-library-smoke.mjs
node apps/desktop/e2e/electron/pdf-file-comments-smoke.mjs
node apps/desktop/e2e/electron/agent-pdf-comments-smoke.mjs
node apps/desktop/e2e/electron/application-menu-smoke.mjs
node apps/desktop/e2e/electron/menu-updates-smoke.mjs
node apps/desktop/e2e/electron/menu-comments-smoke.mjs
node apps/desktop/e2e/electron/menu-views-smoke.mjs
```

The compilation cancellation smoke uses an isolated profile, a controlled latexmk
process tree, and the actual Tectonic subprocess. It checks scoped cancellation,
lock reuse, and preservation of published PDF/SyncTeX output. It currently targets
macOS/Linux process groups; Windows cleanup requires separate runtime verification.
The compilation-controls browser suite covers the hover/focus Stop action,
Stopping state, pending recompiles, and resuming after a fresh edit.

The `prompt-library` browser suite checks immediate sends without consuming the
composer draft, contextual suggestions, empty-chat cards, and settings editing
and synchronization. The prompt-library Electron smoke uses an isolated profile
and production assets to verify library text, ordering, and enabled state across
native windows and a full app restart; it does not launch an external agent.

The panel-window smoke starts an isolated Vite server and Electron profile. It checks native editor, Markdown, PDF, and chat windows, pinned files, bidirectional edits, comments, save-failure protection, duplicate focus (including shared LaTeX roots), project-close cleanup, and persistence after restart. It uses the installed LaTeXmk compiler for its PDF check.

The panel-review smoke uses a temporary Git project, isolated Electron profile, and the real backend to check editor pop-outs through draft/source transitions, decisions from different windows, accepted deletion, and resumed editing/saving. It creates a controlled proposal without launching an external agent. The `multi-window-context` browser suite covers live selection sharing, targeted
selection pinning from reference windows, comment-only main-window selection menus, chat-menu status and window
availability, keyboard dismissal, reference-window controls, shared-root preview windows, and rejected/failed
deletion. The panel-window smoke also checks selection transfer between native
windows and retention of the pinned excerpt after a full application restart.

Additional `e2e/electron/*-smoke.mjs` scripts exercise specific features, including comments, Git, agent drafts, native compilation, and restart recovery. Review each script's prerequisites before running it. Agent protocol fixtures use local scripted providers; real installed-agent tests must be explicitly selected and may depend on local credentials.

The PDF file comments smoke uses isolated Vite, Electron, and project directories to verify selection comments, sharing across native windows, same-name file isolation, persistence through restart, and safe disconnection after binary replacement. The `pdf-file-comments` browser suite covers editing, resolving, undo, and highlight rendering in standalone PDF views.

The agent PDF comments smoke holds an isolated Claude turn open against a local dummy model endpoint, then calls the actual authenticated MCP tools without model inference. It checks PDF reading and all comment operations, same-name isolation, passage/page/path errors, stale fingerprints, unchanged binary files, Markdown creation, and restart persistence. No personal project or external model endpoint is used.

See [agent harnesses](../development/agent-harnesses.md) for provider boundaries, [private draft snapshots](private-draft-snapshots.md) for draft behavior, and the [PDF](pdf-performance.md) and [long-project](long-paper-performance.md) runbooks for opt-in stress tests. Run performance measurements without competing builds or tests and distinguish browser, native, and packaged-app coverage.

Current runtime verification is on macOS. Windows/Linux packaging targets do not establish runtime or installer parity.

The application-menu smoke uses an isolated Electron profile and temporary project.
It invokes the real native menu items and checks Markdown/LaTeX formatting,
selection retention, disabling formatting after focus moves to search or the Markdown iframe, preview Find routing, Find and
Replace, the New File dialog, Markdown PDF export, recent projects, project
closing, PDF-local versus app zoom, shortcut recording in Settings, editor pop-out
cleanup, shortcut customization across windows, and a full application restart.
Dialog paths are controlled by the test; application actions use real IPC and
storage. Rendered screenshots are saved under
`output/playwright/electron/application-menu/`.
When the background runner cannot acquire macOS window focus, the smoke emits
Electron's window-focus event explicitly to check routing. This does not replace
an interactive check of switching windows through the macOS menu bar.

The menu-comments smoke checks native Add Comment routing between the editor and Markdown iframe, saved source anchors, standalone PDF comments, the existing project-manager dialog, and visibility checkboxes. Screenshots are saved under `output/playwright/electron/menu-comments/`.

The menu-views smoke also verifies that exporting a focused standalone PDF writes
the original bytes even when a hidden compiled preview is mounted.

The menu-views smoke checks the existing Markdown, LaTeX, and CSV switches through native menus, toolbar/menu selection synchronization, hidden switches for single-view files, expanded panels, and pop-outs, agent workspace behavior, and read-only content. It also double-clicks panel headers and checks formatting through both the native menu and existing toolbar inside the expanded editor, including pointer access and restoration. Screenshots are saved under `output/playwright/electron/menu-views/`.

The menu-updates smoke invokes Check for Updates through the native Catalex menu,
using controlled GitHub responses with the real update service and production UI.
It checks new and existing About windows, one shared request, the disabled busy
label across window changes, available/current/error results, and retry. Screenshots
are saved under `output/playwright/electron/menu-updates/`.

## macOS permission prompts

To retest first-use permissions, quit Catalex, install the build being tested, and reset only its macOS privacy permissions:

```sh
tccutil reset All com.catalex.desktop
```

This does not remove projects, chat history, settings, or agent accounts. Deleting the app or its data is not needed. macOS documents [app-scoped permission resets](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos).

Launch Catalex and open a small project in Downloads. Automatic Claude status/model checks should not request Apple Music, Photos, Desktop, or unrelated Documents access. A request for the protected location containing the selected project can be legitimate. Check model discovery with the existing account, then start a normal conversation to verify project instructions, skills, and tool permission handling still work. macOS may request permissions later if an actual tool operation accesses another protected resource.

A successful test without resetting permissions does not establish first-use prompt behavior: macOS remembers earlier grants and denials. Use macOS privacy-service logs to distinguish the responsible app from the subprocess making the access. Do not grant Full Disk Access to hide a prompt regression.

The `pdf-minimap` browser suite checks standalone and compiled PDF navigation,
dragging, zoom, author filters, page labels, comment activation and preview
pop-outs. Run it alongside `editor-minimap-harness`, `pdf-file-comments`, and
`standalone-pdf-layout` when changing the shared minimap or PDF viewport inset.

The Markdown preview/comment browser suites cover heading, HTML-anchor and line navigation, sanitized HTML formatting, sidebar file drops with undo, insertion-caret positioning across wrapped lines and scrolling, drag cancellation, preview synchronization, and comment mapping. `node apps/desktop/e2e/electron/markdown-links-smoke.mjs` uses a temporary project and isolated Electron profile to exercise native file paths through preload, the insertion caret, relative-link insertion, cross-file heading navigation, saving, and a full restart.

The Markdown highlighting checks cover common language aliases and LaTeX, literal HTML escaping, math, plain-text fallbacks, exact code whitespace, live edits, light/dark preview colors, and imported theme overrides. Screenshots are saved under `output/playwright/markdown-code-*.png`.

Math-engine checks cover KaTeX/MathJax switching, inline and aligned display equations, horizontal scrolling for wide displays, malformed-input recovery, document macros and recursion limits, independent theme selection, keyboard navigation between Typora menu levels, and preference rehydration. The production chunk check blocks external network requests. The native Markdown smoke exports a MathJax PDF, checks that prose around inline math stays on one line, and saves a rendered PDF screenshot for inspection. File-choice checks cover separate documents, identical file IDs in different projects, defaults, and rehydration. The native Markdown smoke verifies engine changes for the same file across a preview pop-out and the main window, global-default synchronization without replacing explicit file choices, a different file inheriting the default, and saved choices after a full Electron restart.

Typora menu checks use a long theme list to verify the five-item recent limit, duplicate promotion, missing-file filtering, the right-side check layout, selected-theme centering, top-of-list fallback, and back navigation. Native checks verify recent themes across windows and a full restart.

The `project-navigation` harness renders the real App with an in-memory project.
Its browser suite checks rightward opening, leftward return, and fading in both directions, independent
row movement and opacity, stationary loading feedback, duplicate-open protection,
light/dark appearance, a reversed screen transition with the closed project appearing and settling
before its neighbours without an outline, even in the
middle of the list, reduced motion, missing View Transition support, failed
loading and saving, recovery, and interrupted navigation. Mid-transition
screenshots are saved under `output/playwright/project-handoff-*.png`.

The `sidebar-status` browser suite checks the app-wide stacked/separate indicator
preference, mouse and keyboard toggling without file selection, non-interactive
single indicators, action-only indicator tooltips, sibling button semantics, cross-window sync,
and reload persistence. Bubble animation checks sample rendered entrance frames,
resolve comments, remove the final icon, exercise rapid reappearance, and cover
stacked/separate layouts and reduced motion. Frame samples also verify that
neighboring icons slide when a middle indicator is added or removed. Native verification uses isolated Electron profiles and
temporary projects to check synchronization and full application restarts.
