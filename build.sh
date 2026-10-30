#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ $# -gt 0 ]]; then
  echo "Usage: ./build.sh"
  echo "Builds the Electron app and the current platform's installer."
  [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]] && exit 0
  exit 1
fi

# Optional local Electron signing/notarization credentials; never committed.
if [[ -f .release-env.sh ]]; then
  set -a
  source .release-env.sh
  set +a
fi
exec ./scripts/run-pnpm.sh package:desktop
