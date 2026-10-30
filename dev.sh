#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

usage() {
  cat <<'EOF'
Usage: ./dev.sh [--watch | --bundle | --once]

  --watch          Start Electron with Vite renderer reload (default).
  --bundle, --once  Build and launch the unpacked production app.

Restart development after changing Electron or Rust code.
EOF
}

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 1
fi

case "${1:---watch}" in
  -h|--help) usage; exit 0 ;;
  --watch) exec ./scripts/run-pnpm.sh dev:desktop ;;
  --bundle|--once) ;;
  *) usage >&2; exit 1 ;;
esac

# Local previews do not need publisher signing credentials.
CSC_IDENTITY_AUTO_DISCOVERY=false ./scripts/run-pnpm.sh build:desktop

arch="$(node -p 'process.arch')"
arch_suffix="-$arch"
[[ "$arch" != "x64" ]] || arch_suffix=""
case "$(node -p 'process.platform')" in
  darwin) executable="apps/desktop/release/mac$arch_suffix/Catalex.app/Contents/MacOS/Catalex" ;;
  linux) executable="apps/desktop/release/linux$arch_suffix-unpacked/catalex" ;;
  win32) executable="apps/desktop/release/win$arch_suffix-unpacked/Catalex.exe" ;;
  *) echo "Unsupported desktop platform" >&2; exit 1 ;;
esac

unset ELECTRON_RUN_AS_NODE CATALEX_DEV_URL
exec "$executable"
