#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/update-icons.sh <source-icon.(png|svg)>

Regenerates desktop icons in apps/desktop/build/icons.
Export Apple Icon Composer .icon files as PNG before running this tool.
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

SOURCE_ICON="$1"

if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Error: source icon not found: $SOURCE_ICON" >&2
  exit 1
fi

EXTENSION="${SOURCE_ICON##*.}"
EXTENSION_LOWER="$(echo "$EXTENSION" | tr '[:upper:]' '[:lower:]')"

if [[ "$EXTENSION_LOWER" == "icon" ]]; then
  cat >&2 <<'EOF'
Error: .icon files from Apple's Icon Composer must be exported first.

Export your icon from Icon Composer as a square PNG (recommended 1024x1024 with transparency),
then run this script again with that PNG file.
EOF
  exit 1
fi

if [[ "$EXTENSION_LOWER" != "png" && "$EXTENSION_LOWER" != "svg" ]]; then
  echo "Error: unsupported source format .$EXTENSION_LOWER (expected .png or .svg)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/apps/desktop/build/icons"
WEB_ICON="$REPO_ROOT/apps/desktop/public/favicon.png"
LOCAL_TAURI_CLI="$REPO_ROOT/node_modules/.bin/tauri"
TMP_OUTPUT_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_OUTPUT_DIR"
}
trap cleanup EXIT

# The Tauri CLI is used only as an icon converter, not to build or run the app.
echo "Generating desktop icons from $SOURCE_ICON"
if [[ -x "$LOCAL_TAURI_CLI" ]]; then
  (
    cd "$REPO_ROOT/apps/desktop"
    "$LOCAL_TAURI_CLI" icon "$SOURCE_ICON" --output "$TMP_OUTPUT_DIR"
  )
else
  PNPM_CMD=()
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_CMD=(pnpm)
  elif command -v corepack >/dev/null 2>&1; then
    PNPM_CMD=(corepack pnpm)
  elif command -v npx >/dev/null 2>&1; then
    PNPM_CMD=(npx --yes corepack pnpm)
  else
    echo "Error: could not find local tauri CLI, pnpm, corepack, or npx in PATH." >&2
    exit 1
  fi

  if ! "${PNPM_CMD[@]}" -C "$REPO_ROOT/apps/desktop" exec tauri icon "$SOURCE_ICON" --output "$TMP_OUTPUT_DIR"; then
    cat >&2 <<'EOF'
Error: icon generation failed.
If this environment is network-restricted, install pnpm locally (or enable network for corepack) and rerun.
EOF
    exit 1
  fi
fi

# Copy only desktop formats; discard the converter's mobile and Store assets.
for icon_file in 32x32.png 128x128.png 128x128@2x.png icon.icns icon.ico icon.png; do
  if [[ ! -f "$TMP_OUTPUT_DIR/$icon_file" ]]; then
    echo "Error: expected generated icon missing: $icon_file" >&2
    exit 1
  fi
  cp "$TMP_OUTPUT_DIR/$icon_file" "$OUTPUT_DIR/$icon_file"
done

cp "$TMP_OUTPUT_DIR/icon.png" "$WEB_ICON"

echo "Updated icons in: $OUTPUT_DIR"
echo "Updated browser icon: $WEB_ICON"
