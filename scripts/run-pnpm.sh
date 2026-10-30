#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Prefer Corepack so packageManager selects this repository's pnpm version.
if command -v corepack >/dev/null 2>&1; then
  runner=("$(command -v corepack)" pnpm)
elif command -v npx >/dev/null 2>&1; then
  runner=("$(command -v npx)" --yes corepack pnpm)
elif command -v pnpm >/dev/null 2>&1; then
  runner=("$(command -v pnpm)")
else
  echo "Install Node.js and Corepack or pnpm before running Catalex scripts." >&2
  exit 1
fi

# electron-builder also invokes pnpm by name. Give it the same runner instead
# of allowing another global pnpm installation to take over nested commands.
shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/catalex-pnpm.XXXXXX")"
trap 'rm -rf "$shim_dir"' EXIT
{
  printf '#!/usr/bin/env bash\nexec '
  printf '%q ' "${runner[@]}"
  printf '"$@"\n'
} > "$shim_dir/pnpm"
chmod +x "$shim_dir/pnpm"
export PATH="$shim_dir:$PATH"
"$shim_dir/pnpm" "$@"
