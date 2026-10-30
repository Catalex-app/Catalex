#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point for the shared Electron packaging command.
# This does not create releases or publish an updater manifest.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/../build.sh" "$@"
