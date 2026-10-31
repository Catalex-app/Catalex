# Contributing to Catalex

Contributions are welcome! This guide covers the development environment, workflow, and testing.

## Development Environment

### Prerequisites

- [Node.js](https://nodejs.org/) 24+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://rustup.rs/) (stable)
- Platform-specific native dependencies (required by [Tectonic](https://tectonic-typesetting.github.io/)):
  - **macOS:** `brew install pkg-config icu4c harfbuzz graphite2 freetype fontconfig`
  - **Ubuntu:** `apt install build-essential pkg-config libicu-dev libgraphite2-dev libharfbuzz-dev libfreetype6-dev libfontconfig1-dev`
  - **Windows:** Visual Studio Build Tools (C++ workload) + vcpkg — see detailed steps below

#### Windows Setup (PowerShell)

```powershell
# 1. Install Visual Studio Build Tools (if not already installed)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2. Install vcpkg
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat

# 3. Set environment variables (persistent)
[Environment]::SetEnvironmentVariable("VCPKG_ROOT", "C:\vcpkg", "User")
$path = [Environment]::GetEnvironmentVariable("PATH", "User")
[Environment]::SetEnvironmentVariable("PATH", "$path;C:\vcpkg", "User")
[Environment]::SetEnvironmentVariable("TECTONIC_DEP_BACKEND", "vcpkg", "User")
[Environment]::SetEnvironmentVariable("VCPKGRS_TRIPLET", "x64-windows-static-md", "User")

# 4. Restart PowerShell, then install native libraries (~10-20 min)
vcpkg install "harfbuzz[graphite2]:x64-windows-static-md" freetype:x64-windows-static-md icu:x64-windows-static-md fontconfig:x64-windows-static-md
```

### Setup

```bash
git clone https://github.com/RicercarG/Catalex.git Catalex
cd Catalex
pnpm install --frozen-lockfile
```

### Run

```bash
pnpm dev:desktop
```

### Build

```bash
pnpm build:desktop
```

This creates the production application directory. Use `pnpm package:desktop`
to also generate a DMG, NSIS installer, or AppImage on the target operating
system. Build output is in `apps/desktop/release/`. See the
[README](README.md#desktop-development-and-builds) for current platform and
release limitations.

### Updating App Icons

The icon converter accepts square PNG or SVG files. Apple Icon Composer
`.icon` projects need to be exported first.

1. Export a square PNG from Icon Composer (recommended `1024x1024` with transparency).
2. Regenerate the desktop bundle icon set:

```bash
pnpm icons:update -- /absolute/path/to/icon.png
```

This command updates `apps/desktop/build/icons` (`icon.icns`, `icon.ico`,
PNG sizes) and the browser favicon. The Tauri CLI remains a development-only
icon converter; Electron does not use it to build or run the app.

## Project Structure

```
Catalex/
├── apps/
│   ├── desktop/              # Electron desktop app
│   │   ├── src/
│   │   │   ├── main/        # Electron lifecycle and host services
│   │   │   ├── preload/     # Secure renderer bridge
│   │   │   └── renderer/    # React UI, stores, adapters, and frontend tests
│   │   ├── backend/         # Headless Rust service and bundled skills
│   │   ├── build/icons/     # Checked-in packaging icons
│   │   ├── scripts/         # Electron build and development launchers
│   │   ├── e2e/             # Browser harnesses and Electron smoke tests
│   │   ├── public/          # Assets copied into the renderer build
│   │   ├── dist/            # Generated main, preload, renderer, and native files
│   │   └── release/         # Generated applications and installers
│   └── desktop-sidecar/      # Claude Agent SDK bridge bundled for Electron's Node
├── docs/                     # Repository architecture and implementation reviews
├── scripts/                  # Workspace versioning, builds, and icon tooling
├── .github/workflows/        # Lint, tests, builds, and releases
├── biome.json                # Linter config
└── turbo.json                # Turborepo config
```

See [the repository map](docs/architecture.md) for module responsibilities and
where to put new files. Generated browser output belongs in `output/playwright/`;
local browser sessions and package caches are ignored by Git.

The Rust service remains a separate backend. Packaging assets live in `build/`;
generated files live in `dist/` and `release/`.

## Testing

Follow the [test placement and runner conventions](docs/testing/README.md).

### Frontend (Vitest)

```bash
pnpm -C apps/desktop test

# Watch mode
pnpm -C apps/desktop test:watch
```

### Rust

```bash
pnpm build:native --test
```

This runs Cargo tests with the same native dependency environment as packaging,
then builds the release helper.

### Electron host

```bash
pnpm -C apps/desktop electron:typecheck
pnpm -C apps/desktop test:electron
# Requires a built frontend and native helper
pnpm -C apps/desktop test:electron-smoke
```

### Browser harnesses (Playwright)

```bash
pnpm -C apps/desktop exec playwright test -c playwright.config.ts
```

The configuration starts Vite automatically. Harness URLs use the existing
`?debug=<name>` query parameter, for example `?debug=editor-comments`.

### What to test

- **Unit tests:** Pure functions, parsers, data transformations
- **Integration tests:** Filesystem/git operations using `tempfile` crate for isolation
- Rust unit tests live in `#[cfg(test)] mod tests` blocks within each source file; Rust integration tests live in `backend/tests/`.

### Adding Rust integration tests

Use `tempfile::TempDir` for tests that touch the filesystem or git:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_example() {
        let dir = TempDir::new().unwrap();
        // ... test with dir.path() ...
    }

    #[tokio::test]
    async fn test_async_example() {
        // Exercise async service functions using isolated test data.
    }
}
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for TypeScript/React linting and formatting.

```bash
pnpm lint          # check
pnpm lint:fix      # auto-fix
```

Rust code follows standard `rustfmt` conventions.

### Pre-commit Hook

A [Husky](https://typicode.github.io/husky/) pre-commit hook runs automatically on every commit. It checks and auto-fixes staged files via `biome check --staged --write`, so lint issues are caught before they reach the repository.

The hook is set up automatically when you run `pnpm install`.

### CI

The lint workflow checks pushes and pull requests to `main`. The desktop
workflow checks pull requests, supports manual builds, and prepares draft releases
when a `v*` version tag is pushed. The current macOS ARM64 build and its checks
must pass before an installer is attached to a draft.

### Releasing a version

1. Run `pnpm version:set <version>` with the approved version.
2. Add `## [<version>]` at the top of `CHANGELOG.md` and write the user-facing
   changes underneath it. Use `## [Unreleased]` for notes not assigned a version
   yet; move those notes into the version entry before releasing.
3. Run the required checks and `pnpm package:desktop`. The version command synchronizes
   the native crate version in Cargo.lock so locked builds can verify it. Commit the version files,
   changelog, and changes together on `main`.
4. Create an annotated tag on that commit:

   ```bash
   git tag -a v<version> -m "Catalex v<version>"
   ```

5. Click **Push origin** in GitHub Desktop; it includes annotated tags with
   their commits. For ordinary command-line pushes, enable this once per clone:

   ```bash
   git config --local push.followTags true
   ```

   Then `git push origin main` includes the annotated version tag. To push only
   the intended branch and release tag explicitly, use
   `git push --atomic origin main v<version>`.

Use annotated release tags, not lightweight tags. Never recreate a tag that has
already reached GitHub just to change its type.

The current GitHub workflow builds a macOS ARM64 DMG. Windows and Linux
are not included in its build matrix.
It copies only that version's `CHANGELOG.md` entry into the release notes.
A mismatched tag/version, missing notes, or failing build prevents draft preparation.
Tags containing a prerelease suffix, such as `v0.1.0-beta.1`, prepare drafts
marked as prereleases. A version bump without a pushed tag does not prepare a release.

The release job leaves the installer and changelog in a **draft release**. It
never publishes a release or changes which published version is Latest. Once the
workflow finishes, download the draft's DMG with maintainer access, test it, and
review the release notes. In GitHub Releases, edit the draft, choose its prerelease
and Latest status, then click **Publish release** when ready.

Rerun a failed workflow from GitHub Actions to retry. A rerun resumes incomplete
drafts and leaves completed drafts or published releases unchanged. Temporary
Actions installers expire after one day and are deleted sooner once their release
asset upload is verified, including while the release is still a draft. This does
not delete the release's installer. Keep Actions artifact usage within the account
allowance; starting a new private repository does not reset that allowance.

Manual runs against a branch only build; runs against a version tag can prepare
a draft. Release tags must point to a commit containing the release workflow.
Never move an existing release tag.

GitHub supplies the release token automatically; no personal token is required.
Repository Actions policies must allow the release job's `contents: write`
permission. Installers currently lack publisher signing/notarization, so operating
systems may show security prompts or block opening them. In-app automatic updates
remain disabled. Publishing downloads does not enable automatic updates.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run the frontend, Electron, and Rust checks above for the changed surface
5. Commit — the pre-commit hook will auto-fix lint issues on staged files
6. Push to your fork and open a PR
7. CI will verify lint and tests pass

### Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Usage |
|--------|-------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation |
| `test:` | Adding or updating tests |
| `refactor:` | Code refactoring |
| `ci:` | CI/CD changes |
| `chore:` | Maintenance tasks |
