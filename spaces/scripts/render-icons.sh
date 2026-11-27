#!/bin/bash
# Draws Polycarp's app icon in every theme in ../themes, light and dark, into a folder, with the contrast of each:
#   scripts/render-icons.sh <folder>
# Each theme is set with the polycarp command in a throwaway config folder, so the real theme is never touched.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/render-icons.sh <folder>" >&2; exit 2; }
cd "$(dirname "$0")/.."
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cargo build --quiet --manifest-path ../cli/Cargo.toml
POLYCARP=../cli/target/debug/polycarp
mkdir -p "$WORK/themes"
for file in ../themes/*.toml; do
  name=$(basename "$file" .toml)
  POLYCARP_CONFIG_DIR="$WORK/config" "$POLYCARP" theme set "$name" >/dev/null
  cp "$WORK/config/current/theme.json" "$WORK/themes/$name.json"
done
swift build --quiet --product BaneySpaces
BANEYSPACES_RENDER_ICONS="$WORK/themes" "$(swift build --show-bin-path)/BaneySpaces" --render "$OUT"
