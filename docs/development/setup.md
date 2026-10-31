# Development setup

Build Catalex from source with the steps below. To use the packaged app, see [Getting started](../getting-started.md).

## Platform status

| Platform | Current status |
| --- | --- |
| macOS, Apple Silicon | Build and packaging verified locally and in CI; packaged-app behavior checked locally. Current releases target this platform. |
| Windows | Experimental source-build and NSIS packaging paths exist; builds, installers, and app behavior are not verified. |
| Linux | Experimental source-build and AppImage packaging paths exist; builds, installers, and app behavior are not verified. |

Intel Mac builds are also unverified. Build on the operating system and architecture you intend to run; the native Rust helper is compiled for the build machine. The current GitHub Actions matrix builds macOS ARM64 only.

## Tools

Install [Git](https://git-scm.com/downloads), [Node.js](https://nodejs.org/en/download) 24 to match CI, and a stable [Rust toolchain](https://rustup.rs/). Rust must be available in your terminal.

Enable [Corepack](https://github.com/nodejs/corepack#how-to-install) so `pnpm` uses the version pinned in `package.json`:

```sh
corepack enable
rustup target add wasm32-unknown-unknown
```

If Corepack is missing, install it with `npm install --global corepack` first. The WebAssembly target is needed to build Catalex's document core.

## macOS dependencies

Install Xcode Command Line Tools if you do not already have Xcode or its command-line tools:

```sh
xcode-select --install
```

Wait for installation to finish. Then install the native libraries with [Homebrew](https://brew.sh/):

```sh
brew install pkg-config icu4c harfbuzz graphite2 freetype fontconfig
```

The build script discovers the Homebrew library paths and bundles the required non-system libraries with the app.

## Run and build

After installing the dependencies for your platform:

```sh
git clone https://github.com/RicercarG/Catalex.git
cd Catalex
pnpm install --frozen-lockfile
pnpm dev:desktop
```

The first build downloads dependencies and compiles the Rust service, so it can take a while. `dev:desktop` prepares the native service and Claude bridge, then starts Electron with Vite. Renderer edits reload automatically; restart after changing Electron or Rust code. Running Vite alone does not start the desktop app.

| Command | Result |
| --- | --- |
| `pnpm build:desktop` | Production application directory |
| `pnpm package:desktop` | Production app and the build platform's installer in `apps/desktop/release/` |
| `pnpm -C apps/desktop build` | Frontend TypeScript check and Vite bundle only |
| `pnpm -C apps/desktop electron:typecheck` | Electron main/preload type check |

On Apple Silicon, the production app is `apps/desktop/release/mac-arm64/Catalex.app`. Local builds do not require publisher signing credentials. Building an installer does not establish support on an unverified platform.

The bridge runs on Electron's bundled Node runtime. A local agent CLI is only needed to use that agent; LaTeXmk and a TeX distribution are only needed for the LaTeXmk compilation backend. See [Getting started](../getting-started.md) for these runtime tools.

On macOS or Linux, `./dev.sh` starts development, `./dev.sh --once` builds and launches the production app, and `./build.sh` packages an installer. On Windows, use the `pnpm` commands above.

See [Testing](../testing/README.md), [Architecture](architecture.md), and [Releases](releases.md) for checks and release preparation.

## Experimental platform setup

Use these dependencies as a starting point for Windows and Linux development. Both platforms still need build, launch, persistence, and installer verification.

### Linux

On Ubuntu or Debian, install a C/C++ toolchain and the [Tectonic native dependencies](https://tectonic-typesetting.github.io/book/latest/howto/build-tectonic/external-dep-install.html):

```sh
sudo apt install build-essential pkg-config libicu-dev libgraphite2-dev libharfbuzz-dev libfreetype6-dev libfontconfig1-dev libssl-dev zlib1g-dev libpng-dev
```

Then use the shared run/build commands above. Electron also needs your distribution's desktop runtime libraries and a graphical session. Linux packaging currently relies on system native libraries; an AppImage is not yet a verified portable installer.

### Windows

Install Visual Studio Build Tools with the C++ workload and a Windows SDK. Use an x64 Developer PowerShell with the MSVC tools available, and the stable Rust MSVC toolchain.

Set up [vcpkg](https://github.com/microsoft/vcpkg) and the native libraries:

```powershell
git clone https://github.com/microsoft/vcpkg.git "$env:USERPROFILE\vcpkg"
& "$env:USERPROFILE\vcpkg\bootstrap-vcpkg.bat"
$env:VCPKG_ROOT = "$env:USERPROFILE\vcpkg"
$env:TECTONIC_DEP_BACKEND = "vcpkg"
$env:VCPKGRS_TRIPLET = "x64-windows-static-md"
& "$env:VCPKG_ROOT\vcpkg.exe" install "harfbuzz[graphite2]:x64-windows-static-md" freetype:x64-windows-static-md icu:x64-windows-static-md fontconfig:x64-windows-static-md
```

Use the shared run/build commands in that same terminal. Reapply the three environment variables in a new terminal. These commands target Windows x64; Windows ARM64 is not verified.

## App icons

Export a square PNG or SVG, then regenerate the packaging icons and browser favicon:

```sh
pnpm icons:update -- /absolute/path/to/icon.png
```

The icon script uses Bash and the Tauri CLI as an icon converter; it is separate from the Electron app build.
