# Catalex Agent Notes

See [Contributing](CONTRIBUTING.md), [the repository map](docs/development/architecture.md), and [testing conventions](docs/testing/README.md) for setup, module boundaries, and checks.

## Implementation Guidelines

- Use English, and prefer simple wording, but don't omit necessary details.
- For the UI, try to avoid verbose explanatory text, be simple and compact, while not losing information
- Try to reuse the existing UI components and designs, unless the user explicitly ask for a new one. And when implementing new components, try to make the styling align with the existing UI. If you find it necessary to create new components, ask user for confirmation. This is mainly for the convenience of app maintainance, and give a coherent visual.
- For the backend, prefer simple and robust rules, and don't overengineer. However, do pay attention to the possible edge cases, to ensure robustness.

## Branding

- Root `branding.json` defines productName, namespace, appId, and profileDirectory. Change the display name independently of stable technical identifiers. Namespace changes require updating static package/crate names, resources, and integration checks. Preserve historical release notes and real repository/worktree names.

## Project

Catalex is a desktop app with related workspace packages, using pnpm workspaces, React, TypeScript, Vite, Electron, and a headless Rust service. The Claude Agent SDK bridge is bundled JavaScript running on Electron's Node runtime.

- `pnpm dev:desktop` prepares the native service and Claude bridge, then starts Electron with Vite.
- `pnpm build:desktop` builds the production application directory; `pnpm package:desktop` also creates a platform distributable.
- `apps/desktop/backend/` contains the headless Rust service and bundled resources. Electron main, preload, and renderer code live in their respective directories under `apps/desktop/src/`. Packaging icons live in `apps/desktop/build/icons/`.
- Development takes place on `main`; stay on the current branch unless instructed otherwise.

## Verification

Subissue completion commits require non-build checks only; defer production builds to parent completion. The build rules below apply to parent or standalone completion.

- Before closing a GitHub issue as completed or creating a completion commit, run `npx --yes corepack pnpm exec biome ci`.
- Verify frontend TypeScript and production Vite output with `npx --yes corepack pnpm -C apps/desktop build`.
- For native Rust, Electron main/preload, bundled resources, app metadata, or version changes, run `npx --yes corepack pnpm build:desktop` for final verification. For distributable or installer changes, also run `npx --yes corepack pnpm package:desktop`.
- Verify Electron main/preload types with `npx --yes corepack pnpm -C apps/desktop electron:typecheck`. Browser harnesses do not establish native IPC, subprocess, or packaged-resource behavior; check the actual Electron application for changes to those surfaces.
- For UI changes, inspect rendered behavior and visual fit yourself before asking the user to verify. Code checks and builds alone are insufficient. Prefer Playwright against Vite; use Computer Use only when explicitly requested.
- During visual iteration, skip repeated full production builds before user checks unless diagnosing compile, import, or runtime issues.
- If rendered checks are blocked, explain exactly why, report lighter checks run, and ask the user to verify manually.
- For new UI or animation behavior, also inspect a rendered harness and confirm it matches expectations; code assertions alone are insufficient.
- For duet↔vibe input-bar transfer changes, run `npx --yes corepack pnpm -C apps/desktop exec playwright test -c playwright.config.ts e2e/input-transfer-harness.spec.ts`.
- For sidebar section motion/overlap changes, run `npx --yes corepack pnpm -C apps/desktop exec playwright test -c playwright.config.ts e2e/sidebar-animation-harness.spec.ts`.

## Test organization

- Follow `docs/testing/README.md`: module tests beside source, renderer cross-module tests in `src/renderer/__tests__/`, and browser/Electron application tests in `e2e/`.
- Keep the existing Rust test layout and the sidecar MCP smoke entry point used by Rust integration tests.

## Branches and Delegation

- Stay on the current branch; create or switch branches only when explicitly requested.
- Use subagents only for independent, parallelizable work whose speed or quality gain justifies coordination and token costs. Handle small, tightly coupled, exploratory, and UI-polish tasks directly.
- When delegating, the primary agent owns task breakdown, review, integration, and final verification.

## Release Signing

- Electron automatic updates are disabled pending signing, notarization, installer-transition, and update-feed configuration. Do not claim update compatibility until it is implemented and verified.
- The desktop workflow prepares draft GitHub releases from pushed `v*` tags only after validation and the macOS ARM64 build/tests pass. Publishing and selecting Latest are manual steps after installer review. Branch runs and pull requests only build. It does not publish updater manifests or consume signing secrets.
- `.release-env.sh` remains local and gitignored. Keep private signing keys outside the repo. Never print, commit, or paste private keys, signing passwords, or tokens; No signing material belongs in source control.
- Report platform coverage precisely: Windows/Linux workflow targets are not proof of runtime or installer parity. Electron uses a separate browser profile; preserving Rust domain data does not migrate browser-stored settings or preferences.
- Preserve and verify app state across windows and full application restarts. Do not add profile migrations without an explicit task.

## Versions

- Use root `package.json` as the authoritative version. Apply an approved bump with `npx --yes corepack pnpm version:set <nextVersion>`, then run `npx --yes corepack pnpm version:check`.
- The script synchronizes the root, desktop, and Claude bridge package versions, `apps/desktop/backend/Cargo.toml`, and the root crate version in `Cargo.lock`; `version:check` verifies all five values.
- Before committing, run the required native build with the synchronized `apps/desktop/backend/Cargo.lock`; keep dependency versions and checksums unchanged for a version-only update.
- Pure version bumps need not change `pnpm-lock.yaml` unless dependencies or pnpm metadata also change.
- Maintain `CHANGELOG.md` for every version: add one nonempty `## [<version>]` entry with user-facing changes before the completion commit. The release workflow uses that entry verbatim. Keep unreleased notes under `## [Unreleased]` until a version is approved.
- Every bump requires `npx --yes corepack pnpm build:desktop` before committing or tagging. Create an annotated tag on the completion commit with `git tag -a v<version> -m "Catalex v<version>"`. Never use lightweight release tags: GitHub Desktop and Git's follow-tags behavior push annotated tags alongside their commits. Keep repository-local `push.followTags` enabled. Never rewrite an already-pushed tag.
- For `no bump`, keep versions unchanged and run checks for the changed surface. Never bump or tag subissues.
