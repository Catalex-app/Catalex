# Desktop setup and storage

[Back to the README](../README.md) · [Contributing](../CONTRIBUTING.md)

Catalex uses React, Electron, and a headless Rust service for compilation, project data, Git, and agent workflows. The main branch uses Electron.

## Project folders

When no previous project folder is known, Catalex creates new projects under `~/Documents/Catalex`.

Catalex keeps rebuildable and private app-managed state outside the project:

- The OS app-cache directory stores per-project LaTeX build and intermediate output.
- The OS application-support directory stores per-project comments, automatic history, chat sessions, and agent drafts.
- A generated project UUID in Catalex's app-data registry keeps these locations separate between projects.

Projects may contain these Catalex-managed files alongside LaTeX sources:

- `attachments/` stores imported references, pasted files, and PDF captures when you use those features.
- `figures/` is a recommended folder for user or agent-generated figures, plots, and images. The app does not automatically create it in the current code.

Comments live in the app-managed PoloDB database, outside the source folder; comment snapshots are included in automatic project history. Legacy project-local `comments.json` files are not live comment storage.

Claude integrations may also create or use optional project-local `.claude/skills/` and `.claude/commands/` folders for scientific-skill and slash-command workflows. These are integration folders, unlike Catalex's OS-managed app state or legacy `.prism/`.

## Desktop development and builds

Install Node.js for development, the pnpm version declared in `package.json`, a Rust toolchain with the `wasm32-unknown-unknown` target, and the native Tectonic dependencies below. End users do not need to install Node.js to run the packaged Claude bridge: it uses Electron's bundled Node runtime. The Claude Code executable and sign-in remain separate.

```sh
rustup target add wasm32-unknown-unknown
pnpm install --frozen-lockfile
pnpm dev:desktop
```

`dev:desktop` prepares the native Rust service and JavaScript Claude bridge, then starts Vite and Electron together. Running only the frontend Vite server is useful for browser harnesses but does not start the desktop service.

Shell shortcuts are `./dev.sh` (or `--watch`) for development, `./dev.sh --once` (also `--bundle`) to build and launch the unpacked production app, and `./build.sh` to create the platform distributable. Development reloads renderer changes through Vite; restart it after changing Electron or Rust code. These scripts use the pinned pnpm version through Corepack when available.

| Command | Result |
| --- | --- |
| `pnpm dev:desktop` | Prepared native service and bridge, then Electron with the Vite development server |
| `pnpm build:desktop` | Production frontend, Electron main/preload, native service, bridge, and application directory |
| `pnpm package:desktop` | Production build plus the current platform's distributable |
| `pnpm -C apps/desktop build` | Frontend TypeScript check and Vite bundle only |
| `pnpm -C apps/desktop electron:typecheck` | Electron main/preload TypeScript check |
| `pnpm build:native --test` | Full native tests and release helper build using the same dependency environment |
| `pnpm -C apps/desktop test:electron` | Electron filesystem and subprocess tests |
| `pnpm -C apps/desktop test:electron-smoke` | Real Electron smoke with a temporary profile/project; requires a built frontend and helpers |

Electron build output is under `apps/desktop/release/`. Distributable targets are macOS DMG, Windows NSIS installer, and Linux AppImage. Build on the target OS; the Rust service, its native libraries, and Electron must match the target architecture. `apps/desktop/backend/` contains the Rust service and bundled resources. Electron main, preload, and React renderer code live under `apps/desktop/src/`; packaging icons live in `apps/desktop/build/icons/`. Generated main, preload, renderer, and native files are grouped under `apps/desktop/dist/`.

Local desktop builds disable automatic macOS signing-certificate discovery. To opt in, run `CSC_IDENTITY_AUTO_DISCOVERY=true pnpm build:desktop` (or `package:desktop`). The native helper retains its lightweight ad-hoc signing for local execution on Apple Silicon.

Native development dependencies:

- macOS: `brew install pkg-config icu4c harfbuzz graphite2 freetype fontconfig`.
- Linux: install a C/C++ toolchain, `pkg-config`, and the development packages for ICU, Graphite2, HarfBuzz, FreeType, and Fontconfig. The [contribution guide](../CONTRIBUTING.md#prerequisites) records the Ubuntu package names.
- Windows: install the MSVC build tools and vcpkg, then install `harfbuzz[graphite2]`, `freetype`, `icu`, and `fontconfig` for `x64-windows-static-md`. Set `TECTONIC_DEP_BACKEND=vcpkg`, `VCPKG_ROOT`, and `VCPKGRS_TRIPLET=x64-windows-static-md` for the build.

The macOS native build copies non-system dylibs into the application's native resources and rewrites their references. Linux currently uses system native libraries: an AppImage artifact alone does not prove those dependencies are portable across distributions. The current CI workflow builds only macOS ARM64. Windows and Linux still require build, runtime, and installer validation on those systems.

## Saved state and releases

Project source files stay in the folders you open. Settings and private project data use the app-managed locations below.

| Storage | macOS | Windows | Linux (default) |
| --- | --- | --- | --- |
| Settings, recent projects, workspace state, PDF snapshots | `~/Library/Application Support/Catalex-Electron` | `%APPDATA%/Catalex-Electron` | `~/.config/Catalex-Electron` |
| Registry, comments, history, sessions, agent drafts | `~/Library/Application Support/com.catalex.desktop` | `%APPDATA%/com.catalex.desktop` | `~/.local/share/com.catalex.desktop` |
| LaTeX build cache | `~/Library/Caches/com.catalex.desktop` | `%LOCALAPPDATA%/com.catalex.desktop` | `~/.cache/com.catalex.desktop` |

Linux respects the configured XDG directories. Automated checks use `CATALEX_USER_DATA_DIR` to isolate both browser and native state. Do not run two app instances against the same writable project data.

Branding is defined in root `branding.json`: `productName` controls displayed names, `namespace` identifies internal protocols/tools/resources, `appId` identifies the installation and private data directories, and `profileDirectory` selects the Electron settings folder. Keep the three technical identifiers stable for a cosmetic rebrand; changing `productName` must not move existing state.

All active app identifiers now use Catalex, including IPC, environment variables, MCP tools/skills, storage keys, and private Git metadata. Package/crate names and code symbols are static technical identifiers; changing the namespace still requires coordinated source/resource changes and integration checks. Skill prose, documentation, and historical release notes are ordinary text, not runtime settings.

Automatic updates are disabled. Signing, notarization, and update delivery require separate release configuration and verification.

Pushing a new version tag builds the macOS ARM64 installer and prepares a draft GitHub release after all checks pass. A maintainer reviews the installer and notes, then publishes the draft manually. Release notes come from the matching entry in [CHANGELOG.md](../CHANGELOG.md). Normal branch pushes do not publish releases. See [the release steps](../CONTRIBUTING.md#releasing-a-version). Installers currently lack publisher signing/notarization and may trigger OS security prompts; the workflow does not consume signing secrets.

See [the repository map](architecture.md) for module boundaries and checks.
