# Development setup

This guide is for building Catalex from source. To use the packaged app, see [Getting started](../getting-started.md).

## Prerequisites

Install Node.js 24+, the pnpm version declared in `package.json`, and a stable Rust toolchain. Add the WebAssembly target used by the document core:

```sh
rustup target add wasm32-unknown-unknown
```

Install the native Tectonic dependencies for your platform.

On macOS:

```sh
brew install pkg-config icu4c harfbuzz graphite2 freetype fontconfig
```

On Ubuntu:

```sh
sudo apt install build-essential pkg-config libicu-dev libgraphite2-dev libharfbuzz-dev libfreetype6-dev libfontconfig1-dev
```

On Windows, install Visual Studio Build Tools with the C++ workload, then configure vcpkg in PowerShell:

```powershell
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
[Environment]::SetEnvironmentVariable("VCPKG_ROOT", "C:\vcpkg", "User")
$path = [Environment]::GetEnvironmentVariable("PATH", "User")
[Environment]::SetEnvironmentVariable("PATH", "$path;C:\vcpkg", "User")
[Environment]::SetEnvironmentVariable("TECTONIC_DEP_BACKEND", "vcpkg", "User")
[Environment]::SetEnvironmentVariable("VCPKGRS_TRIPLET", "x64-windows-static-md", "User")
```

Restart PowerShell, then install the libraries:

```powershell
vcpkg install "harfbuzz[graphite2]:x64-windows-static-md" freetype:x64-windows-static-md icu:x64-windows-static-md fontconfig:x64-windows-static-md
```

## Run and build

```sh
git clone https://github.com/RicercarG/Catalex.git
cd Catalex
pnpm install --frozen-lockfile
pnpm dev:desktop
```

`dev:desktop` prepares the Rust service and Claude bridge, then starts Electron with Vite. The packaged bridge uses Electron's Node runtime; installing and signing in to the Claude Code CLI is separate.

| Command | Result |
| --- | --- |
| `pnpm build:desktop` | Production application directory |
| `pnpm package:desktop` | Production build and platform installer in `apps/desktop/release/` |
| `pnpm -C apps/desktop build` | Frontend TypeScript check and Vite bundle |
| `pnpm -C apps/desktop electron:typecheck` | Electron main/preload type check |

The shell shortcuts are `./dev.sh` for development, `./dev.sh --once` to build and launch the production app, and `./build.sh` to package an installer. Renderer edits reload through Vite; restart after changing Electron or Rust code.

Current release and runtime validation covers macOS ARM64. Windows and Linux targets still require platform build, runtime, and installer verification. The macOS build bundles non-system native libraries; Linux currently relies on system libraries.

See [Testing](../testing/README.md), [Architecture](architecture.md), and [Releases](releases.md) for the remaining development workflow.

## App icons

Export a square PNG or SVG, then run:

```sh
pnpm icons:update -- /absolute/path/to/icon.png
```

This updates the checked-in packaging icons and browser favicon. The Tauri CLI is only used as an icon converter.
