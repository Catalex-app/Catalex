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
until motion finishes. Background branches scale together around the viewport
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
