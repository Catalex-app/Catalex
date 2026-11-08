# Repository map

Catalex has two application packages: `apps/desktop` for the React/Electron app
and its headless Rust service, and `apps/desktop-sidecar` for the Claude Agent SDK
bridge. Keep package-specific source, tests, and build helpers with the package
that owns them. Development takes place on `main`.

## Desktop process boundary

```text
React renderer → isolated preload → Electron main
                                      ↓ JSON lines
                              Rust domain service
                                      ↓ JSON lines
                         Claude bridge (Electron Node)
                                      ↓ Agent SDK
                              installed Claude CLI
```

Electron owns windows, native dialogs, menus, clipboard, filesystem adapters,
local asset delivery, external application launching, and Chromium PDF printing.
The renderer uses `src/renderer/lib/desktop/` APIs exposed through the preload rather than
importing native shell plugins. Browser harnesses implement the same boundary.

| Location, relative to `apps/desktop/` | Responsibility |
| --- | --- |
| `src/main/index.ts` | Application/window lifecycle, host commands, protocols, resource and profile paths |
| `src/preload/index.ts` | Context-isolated renderer API and event bridge |
| `src/main/service.ts` | Rust subprocess requests, responses, events, failure and shutdown |
| `src/main/file-access.ts` | Filesystem adapter and local asset path access |
| `src/main/editors.ts` | External editor discovery and launch |
| `scripts/build-electron.mjs`, `scripts/dev-electron.mjs` | Electron source bundling and development launch |
| `electron-builder.cjs` | Application files, native/bridge resources, platform artifact targets |

One Rust service runs per Electron application. Requests are
`{id, windowId, command, args}`; replies contain `{id, result}` or `{id, error}`.
Events contain `{windowId, event, payload}`, with no `windowId` for broadcasts.
Electron derives the window identity from the IPC sender. Rust writes protocol
messages to stdout and diagnostics to stderr. Service failure rejects pending
requests rather than replaying potentially mutating commands.

Node remains outside the renderer. The Claude bridge uses Electron's executable
in Node mode and clears `ELECTRON_RUN_AS_NODE` before starting native Claude or
its tools. It does not bundle another JavaScript runtime.

## Desktop frontend

| Location | Responsibility |
| --- | --- |
| `src/renderer/main.tsx` | Window bootstrap, startup errors, and visibility recovery |
| `src/renderer/App.tsx` | Main application composition |
| `src/renderer/components/workspace/` | Editor, preview, sidebar, and Git UI |
| `src/renderer/components/agent-chat/` | Agent conversation UI |
| `src/renderer/components/settings/` | Settings UI |
| `src/renderer/components/ui/` | Reusable presentation primitives |
| `src/renderer/components/debug/debug-page.tsx` | The app's diagnostic page |
| `src/renderer/stores/` | Shared application state and persistence |
| `src/renderer/hooks/` | React lifecycle integration |
| `src/renderer/lib/` | Domain helpers and external adapters; `lib/desktop/` is the host boundary and `lib/debug/` is runtime logging |
| `src/renderer/dev/render-debug-window.tsx` | Existing debug-query dispatch and harness rendering |
| `src/renderer/dev/harnesses/` | Deterministic browser screens used for development and Playwright |
| `src/renderer/dev/desktop-browser-mocks.ts` | Shared browser implementations of desktop calls |
| `src/renderer/__tests__/` | Existing cross-module tests, shared mocks, and test setup |
| `e2e/` | Playwright behavior tests |
| `public/` | Shipped static assets, including example documents |

Harnesses import product code and shared mocks. Product components should not
import harnesses. Shared harness support belongs in `src/renderer/dev/`, rather than
being exported by an unrelated harness. The diagnostic page and runtime logs
remain product code.

The `dev` directory describes ownership, not a build exclusion. Existing debug
URLs, lazy loading, Strict Mode choices, and availability in production are
preserved. Any future exclusion from release builds is a separate behavior change.

Place new feature UI with its owning component directory and focused tests next
to the module they exercise. Keep tests spanning stores or application boundaries
in `src/renderer/__tests__/`. See [testing conventions](../testing/README.md) for
placement, runner commands, and harness documentation.

## Workspace appearance

Workspace modes control layout and features. Their visual theme is independently
assigned in Settings → Appearance: `pure` (Artisan) defaults to Classic;
`sidecar` (Duet) and `handoff` (Vibe) default to Modern. `lib/ui-theme.ts`
defines the small built-in catalog and assignment defaults. The settings store
persists and normalizes the mapping, independently of light/dark/system appearance.

`useWorkspaceTheme` sets `html[data-ui-theme]` for the active workspace. Theme
CSS lives in `styles/ui-themes.css`; the root scope includes portals under body.
Shared Radix surfaces and custom `data-ui-surface="popover"` surfaces use the same
palette. The welcome screen and separate Settings window use Modern. Theme rules
may style control density (Classic uses compact toolbar controls), but must not
change workspace layout, available features, or mode transition behavior. Keep theme decisions out of individual feature components.

Workspace panels share a temporary expanded state in `workspace-layout.tsx`.
`workspace-panel.tsx` keeps the live content mounted and lifts the selected panel
above the app while making the surrounding workspace inactive. The split ratios
remain unchanged. Headers use the same expand/restore control; Escape restores
the panel after nested menus or search have handled the key. The editor and preview expand the same `WorkspacePanel` boundary, including its
header and content. File tabs stay outside that boundary; file-change notices
stay inside the editor panel. Markdown forwards Escape from its iframe.
Expansion and restoration share the split-layout timing. Live panel bounds and
PDF display scale update together before each paint; PDF raster rendering waits
until motion finishes. Workspace column transitions provide the same motion inputs
to compiled previews and standalone PDFs, using the preview and editor column
dimensions respectively. Background branches scale together around the viewport
center on that same timeline, bringing the toolbar behind the expanded panel
without scaling the native traffic lights or the focused content. Light mode
uses a white backdrop; dark mode retains its dim backdrop and outer shadow.
Reduced motion skips the transition. This state is local
to the workspace and resets when its project or mode changes.

## Native backend and sidecar

Rust lives under `backend/`, with its implementation unchanged by the folder reorganization. `src/main.rs` starts
the headless service or the isolated `--tectonic-compile` mode. `src/lib.rs`
exports domain modules, `src/service.rs` routes explicit commands, and
`src/host.rs` owns shared service state, window context, events, resource paths,
and cleanup. The native crate no longer depends on the Tauri window runtime.
Tectonic still compiles in a separate subprocess to isolate its global C state.

| Modules | Responsibility |
| --- | --- |
| `latex`, `compile_diagnostics`, `verification` | Compilation, source/PDF mapping, and agent verification |
| `project_storage`, `project_files`, `comments` | Project data, file watching, and persisted comments |
| `agent_workspace`, `shared_sessions`, `agent_questions` | Agent drafts, shared conversation state, and questions |
| `claude`, `codex`, `workspace_mcp` | Provider processes and the shared MCP service |
| `history`, `git_conflicts` | Automatic snapshots and user Git workflows |
| `builtin_skills`, `skills`, `slash_commands` | Agent skill resources and command discovery |
| `zotero` | Zotero authorization and integration |

The sidecar's `src/index.ts` owns the persistent Claude query and JSON-lines
protocol; `catalex-mcp.ts` and `catalex-skills.ts` configure the app-owned MCP
service and bundled skills. Its `scripts/build.mjs` uses esbuild to create
`dist/index.mjs`, a self-contained Node-compatible ES module. The installed
native Claude executable is supplied explicitly to the SDK. Claude installation
and authentication are separate from the app's JavaScript runtime.

Rust starts the bridge with the host-provided `CATALEX_NODE_EXECUTABLE` and
`CATALEX_CLAUDE_BRIDGE` paths. It retains one persistent bridge per window/tab
session, reads stdout/stderr separately, and waits for output before reporting
process exit. Closing stdin lets the bridge close its SDK query; a bounded
shutdown fallback reaps an unresponsive bridge. Cancellation still uses the
existing JSON-lines control command. Bun is only a development test runner.

Claude model discovery uses the same sidecar in `--list-models` mode. Its
`src/model-discovery.ts` initializes the installed CLI and reads the SDK's
`supportedModels()` catalogue without submitting a prompt. Discovery disables
session persistence, hooks, tools, and MCP startup and closes the query afterward.
The native `list_claude_models` command bounds the process lifetime. The frontend
Claude setup store shares concurrent requests and exposes loading/error/retry
state to chat and settings. `src/renderer/lib/claude-models.ts` formats reported versions
and orders Default first, then Fable, Opus, Sonnet, Haiku, and other models.
Default displays its reported model in parentheses. Runtime IDs remain
separate from labels and are preserved in saved settings and conversations.
Older CLIs may report versions in descriptions rather than `resolvedModel`;
those descriptions are used for labels without synthesizing model IDs.

These module boundaries describe the current implementation. Splitting large
Rust or editor modules should be a focused change with behavior checks, rather
than part of a mass folder rename.

Keep each harness's execution, session lifecycle, skills, and options in its own
integration. Share code where Catalex owns the behavior, such as draft review,
verification, and the Ask/Edit policy (`AgentExecutionMode`). Chat code blocks
offer Copy and, for LaTeX, Insert; they do not execute commands. Agents execute
commands through their own harness tools. Similar-looking provider discovery
and process-launching code may have different platform requirements and should
not be merged solely to remove duplication.

The prompt library is a provider-independent list in the persisted settings
store (`catalex-settings`). `lib/prompt-library.ts` defines defaults and validates
saved entries; an empty list stays empty. Settings → Agent manages titles, text,
availability (Always, Has text selection, Has issues), optional icons, enabled
state, and ordering. The defaults are Improve writing, Fix issues, Review &
comment, and Tighten layout. A complete, untouched older set upgrades in place.
Customized libraries and intentionally deleted prompts are preserved.
The icon picker starts with 16 suggested Lucide icons. Search and the All icons tab
load the installed catalog on demand (`lib/prompt-icons.ts`). Default icon uses
the prompt's assigned icon or a bookmark for custom prompts. No icon is saved
as `null`.
Half/Full use a
card strip above the composer with a narrow right-side fold/menu column. Mini
uses a title strip beside the chat switcher, with its fold control at the left
and menu at the right. All three modes share `areLibraryPromptsExpanded`: new
chats start expanded and existing conversations start folded with one expand
button. In Half, the folded button floats above the composer with its bottom
aligned to the expanded shelf's bottom (8px above the input). The virtual list
reserves 36px of scrollable footer space while folded so the last message can
clear it. In Full, the folded button sits at the right of the mode-switch row,
independently of its centered switcher. Full shares the same 36px footer space
so the last message and its actions can scroll above the conversation fade.
The composer shelf stays mounted so width, height, and reserved space transition
over 200ms when opening or folding, with reduced motion respected. Full fades
the shelf out while revealing its separate mode-row button.
Typing and selection do not change visibility.
The tab's window-local `miniPromptsExpanded` choice resets on each chat visit:
empty chats expand and existing conversations fold. An accepted `sendPrompt`
submission (including queued submissions) folds the strip; rejections preserve
its visibility. The persisted app-wide `keepMiniPromptsOpen` setting overrides
these defaults in Mini, Half, and Full, including while sending. Its original
storage key is retained to preserve existing pins. Enable it through “Pin
prompt bar” in any prompt menu; the chevron becomes a pin that unpins globally
and folds the current chat's strip in one click. Existing Mini chats retain their
status icon beside expanded prompts, with status details on hover. Folding
prompts restores the status or latest-message preview and elapsed timer.
The strip's dots menu exposes the full library and pin preference; the input
toolbar keeps only its command and mention shortcuts.
Command completion replaces only the active `/query` at the caret, preserving
the surrounding draft and leaving a space for continued typing. Command and
mention popovers anchor 8px above the input surface, overlaying the prompt shelf
instead of moving upward when the shelf is expanded.
Selecting a prompt sends it through the current chat's normal `sendPrompt` path
with an explicit context snapshot, preserving history and the unsent composer
draft. Global instructions remain a separate new-chat setting.
Context is automatic: live selection, then pinned selection, then current text
file. Always can also send without a file. Has issues uses the editor's transient
`promptDiagnostics` snapshot, shared with chat popouts through the document view.
It requires matching project, file, draft session, and content. A selection scopes
issues to its lines (an end at column one excludes that ending line); a clean or
stale selection never borrows unrelated file issues. File context includes
unlocated compiler problems. Diagnostic messages, severity, and locations travel
with the source attachment and stay separate from the user's prompt text.
LaTeX preview pop-outs are keyed by project and resolved TeX root, using the
same `resolveTexRoot` mapping as the PDF cache. Opening a preview from another
included file focuses the existing window without resetting its page or zoom.
The preview's title, compilation target, and lifetime belong to the root;
deleting an included file does not close it. Editor and non-LaTeX preview
pop-outs remain pinned to individual files.

Main-window editor and PDF selection popups offer Comment; their selections
continue to provide live context to chats, where users can pin them. Editor and
PDF pop-outs additionally offer Send to chat. This action
replaces the popup's actions with chat choices on click or keyboard activation, keeping
one popup surface. A back arrow, Escape, or Left Arrow restores the actions;
keyboard users can navigate the choices with arrow keys. It lists the main chat
and open chat pop-outs with status indicators
and Main, Pop-out, or Main & Pop-out badges. A chat open in both places still
appears once and receives the selection once. With just one target, Send to chat shows its badge and pins directly
when clicked, without a submenu.
PDF excerpts retain the project-relative compiled root (or directly opened PDF
path), page, and selection identity independently of optional source mapping.
The document path and page are included in the agent prompt even when mapping
fails. Duplicate checks use document identity and selection position/text, so
identical passages in different PDFs remain separate. Older excerpts without
PDF identity are kept rather than guessed to match new captures.

Directly opened PDF comments reuse the existing comment cards and project storage, with selected text, page rectangles in PDF coordinates, and a fingerprint of the exact immutable PDF snapshot. Native snapshot creation and comment storage hash bytes by streaming. Comments never modify the PDF binary. Replacement bytes disconnect old comments instead of mapping them through source-text offsets or placing highlights on a different document; historical and agent draft previews remain isolated. Compiled LaTeX comments retain their source-based mapping.

Agents use `read_pdf({filePath, pages})` to obtain selectable text, page count, and a binary fingerprint, then `create_comment({filePath, passage, text, pdf: {page, fingerprint}})`. The owning renderer opens a private MuPDF snapshot and derives glyph rectangles without changing the visible document. Matching is case-sensitive, normalizes whitespace and Unicode compatibility forms (including ligatures), and requires a unique passage on one page. The backend validates project/session scope and matching source/draft fingerprints before reading and saving; replies are bound to their requesting window and pending requests expire or cancel. There is no OCR, fuzzy matching, or agent-supplied geometry. Existing revision-checked comment tools manage both PDF and source comments.
The Files context menu uses the same chat targets, location badges and click-to-open inline chooser. A single target sends directly; the full back row, Escape and Left Arrow return to file actions. Whole-file sends update one pinned reference per path in the chosen draft, including files without text content, without changing the active chat or opening its drawer. Selection sends still require nonempty selected text.

Choosing a chat pins the excerpt in that chat's draft without submitting a
prompt, switching chats, or replacing typed text. File pop-outs can explicitly
send their local selections through this menu while their automatic selection
context remains local. Closed and archived chats are excluded, and the target
and project are checked again when attaching. AI quick actions live in the
prompt bar. A surface with no available actions renders no selection popup.

## Repository support and generated files

- `scripts/`: workspace version synchronization and platform build helpers.
  `pnpm dev:desktop` prepares the Rust service and bridge before starting Electron
  and Vite. `pnpm build:desktop` creates a production application directory;
  `pnpm package:desktop` also builds a distributable.
- `docs/`: architecture, contributor guides, and `testing/` harness instructions.
- `output/playwright/`: generated screenshots and browser verification output.
- `.playwright-cli/`, `.pnpm-store/`, `node_modules/`, `dist/`, `apps/desktop/release/`, and Rust `target/`: local
  sessions, caches, dependencies, and build products, excluded from Git.

Do not move `public/`, native resources, or package/build entry points without
updating their configured paths. Do not store durable documentation in a cache
or generated-output directory.


## Saved state and release boundary

Electron stores browser state under its `Catalex-Electron` user-data profile,
using the stable `catalex://app` production origin. Settings, recent projects,
chat snapshots, and pending reviews retain their existing storage schemas.
The Rust service receives `com.catalex.desktop` data/cache roots for
Electron-created project registries, history, sessions, and isolated drafts.
Project source files stay in their original folders. Comments live in the
app-managed PoloDB database, with snapshots in private project history.
Development uses its fixed loopback origin and has separate browser state.

Set `CATALEX_USER_DATA_DIR` for automated checks; Electron then keeps its
browser profile and the service's `data/` and `project-cache/` under that isolated root.
Provider-native authentication/configuration remains governed by the provider
and is not automatically isolated by this app-profile setting.

The desktop workflow currently builds only macOS ARM64 DMG artifacts on pull
requests, manual dispatch, and version-tag pushes. Windows/Linux builds and
release artifacts are paused; their runtime and installer parity remain unverified.
Validated `v*` tags prepare a draft GitHub release with the macOS DMG and changelog
after the build and tests pass. Publication and Latest selection are manual after
installer review. Pull requests and non-tag manual runs only build.

Automatic updating is explicitly unavailable. The workflow does not consume
signing secrets or create version tags. Signing/notarization, update delivery,
and any future profile migration require separate release checks.

### PDF minimap

Text editors and PDF viewers share the `DocumentMinimap` presentation: layers,
clustered comment hover cards, keyboard focus, and pixel-based scroll dragging.
The existing Show minimap preference covers both. PDF views expose only human
and agent comment layers, and retain their horizontal scrollbar. Their adapter
measures rendered page bounds, so zoom, mixed page sizes, and panel motion use
the actual viewport. Both minimaps share the same inset, rounded, shadow-free surface styling;
only their background differs. The editor leaves a gutter for it, while the
PDF minimap overlays the page with an opaque surface matching the panel. A right content gutter keeps fitted pages
clear of it, while zoomed pages can extend underneath. Fit-width motion includes
that gutter; the scroll viewport itself spans the whole panel.

Standalone markers reuse fingerprint-validated PDF anchors; compiled markers
use the current SyncTeX source map and full project-relative source paths. No
extra page rasterization or whole-document text extraction is required. A
changed comment context or compilation discards pending marker results; hidden,
historical, draft, or stale previews retain navigation without live comment
markers. Marker activation uses the existing PDF comment interaction, including
source synchronization when the editor is visible.

Sidebar file and session context menus use explicit targets with `openPanelWindow`; they do not change the main file or chat selection. Small text files load on demand, and saved sessions restore through `loadChatInBackground` with project and duplicate checks before opening a window. Archived sessions must be restored first.

Prompt expansion uses one shared file-aware rule across Mini, Half, Full, and chat pop-outs. Standalone PDF, image, and binary files suppress only the new-chat automatic expansion; editable source files (including LaTeX with a PDF preview) keep that default. Manual expansion or collapse overrides the default for the current file visit; changing the active file or project clears it in the owner window, and chat entry also resets it. Pinning remains persistent across file and chat changes. Prompt availability and library settings are unchanged.

Prompt customization is temporarily gated by `PROMPT_CUSTOMIZATION_ENABLED`. Settings and chat use `visiblePromptLibrary` to show the four stock prompts with saved ordering and enabled flags. Add/edit/delete and icon-picker implementations remain in place behind the gate; stored custom entries and edits are retained without a migration. Visible reordering skips hidden entries, and toggles preserve saved custom content.

Markdown previews parse HTML snippets before sanitizing them and rendering math. Inline text formatting and colors, details, tables, and explicit anchors are supported; scripts, event handlers, embedded frames, and document-wide CSS are removed. Generated heading anchors use GitHub-style slugs, including duplicate suffixes. Local links with heading/HTML fragments or `#L<number>` (optionally `C<column>`) open the target file and navigate the source and preview. Source lookup shares the rendering pipeline. Successful fragment jumps show the same compact return popup as PDF navigation. Jump back restores the original file and exact preview scroll position; its small dismiss button clears the return point without navigating, and scrolling back to or past the saved position in the same file also clears it; each jump replaces the return point, and unrelated file/project changes or source edits clear it. File drops from the sidebar or native filesystem insert escaped paths relative to the Markdown document at the drop position as one undoable edit. An editor caret previews that exact position without moving the real selection; sidebar drags hide the filename badge over the editor so the caret remains visible. It follows scrolling and clears on leaving, dropping, or canceling.

Markdown fenced code uses `rehype-highlight` with the common language grammars plus LaTeX, after sanitization and KaTeX. Only explicit, supported language labels are highlighted; unknown languages, unlabeled blocks, and inline code remain plain. Raw HTML code markup retains its existing source annotations. Token styles follow the built-in light/dark preview palettes; imported themes receive a text-color-based fallback and can override the low-specificity `.hljs-*` rules. Code text, whitespace, and block source positions remain unchanged.

The Markdown preview menu separates the math engine from the visual theme. KaTeX remains the default; MathJax is loaded on demand and renders bundled SVG without remote fonts or iframe scripts. Its TeX package list covers notation while excluding HTML/link injection and dynamic package loading. `markdownMathEnginesByFile` uses the existing settings persistence and window synchronization, keyed by the project root and file ID like LaTeX compiler choices. Files without a saved choice follow `defaultMarkdownMathEngine`, configured in Settings → Rendering → Markdown and initially KaTeX. Changing the default preserves explicit per-file choices; selecting an engine in the preview affects only that file. Both engines share Markdown parsing, sanitization, and theme selection; this is not an OpenReview compatibility mode. Installed Typora and project CSS choices share a two-level menu using the existing dropdown components. The first level shows up to five available recent themes, identified by absolute path. Persisted recency determines membership while a separate persisted display order keeps retained rows in place. Selecting an existing theme only updates recency and the checkmark; a new theme evicts the least recently used entry and is appended at the bottom immediately. All Typora themes opens the second level in the same menu, with a back row and a separately scrolling list. It centers the selected custom theme on entry, or starts at the top for a built-in theme. Missing theme files are omitted from recents. Theme rows show background/text/accent colors as three squares in the existing 16px icon slot. GitHub themes use their built-in colors; custom themes use approximate palettes with neutral colors for unrecognized values. Each square has a thin dark outline in light menus and a light outline in dark menus so matching colors remain visible. Visible installed-theme rows read and cache local palettes without rendering theme CSS or loading its imports; project CSS edits update swatches directly.
