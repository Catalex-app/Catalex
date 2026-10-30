#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point. The shared Electron build creates local artifacts;
# signing/update publication must be configured separately before a release.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/../build.sh" "$@"
