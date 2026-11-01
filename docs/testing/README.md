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

The Playwright configuration starts Vite. Interactive harnesses use `/?debug=<name>`. Useful focused guides cover [agent stop/pause](agent-pause-harness.md) and [sidebar animation](sidebar-animation-harness.md).

For composer transfer or sidebar motion changes, run the owning regression suite:

```sh
pnpm -C apps/desktop exec playwright test -c playwright.config.ts e2e/input-transfer-harness.spec.ts
pnpm -C apps/desktop exec playwright test -c playwright.config.ts e2e/sidebar-animation-harness.spec.ts
```

Inspect rendered behavior and visual fit for UI changes; code checks alone are insufficient.

## Electron application checks

Build the actual desktop resources first:

```sh
pnpm build:desktop
pnpm -C apps/desktop test:electron-smoke
pnpm -C apps/desktop test:electron-persistence
pnpm -C apps/desktop test:electron-profile
pnpm -C apps/desktop test:electron-windows
node apps/desktop/e2e/electron/updater-smoke.mjs
```

Additional `e2e/electron/*-smoke.mjs` scripts exercise specific features, including comments, Git, agent drafts, native compilation, and restart recovery. Review each script's prerequisites before running it. Agent protocol fixtures use local scripted providers; real installed-agent tests must be explicitly selected and may depend on local credentials.

See [agent harnesses](../development/agent-harnesses.md) for provider boundaries, [private draft snapshots](private-draft-snapshots.md) for draft behavior, and the [PDF](pdf-performance.md) and [long-project](long-paper-performance.md) runbooks for opt-in stress tests. Run performance measurements without competing builds or tests and distinguish browser, native, and packaged-app coverage.

Current runtime verification is on macOS. Windows/Linux packaging targets do not establish runtime or installer parity.
