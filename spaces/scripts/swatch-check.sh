#!/usr/bin/env bash
# Draws Settings > Appearance in dark mode offscreen and fails when the workspace colors sit on near-white (gap X1).
# Usage: scripts/swatch-check.sh [binary] [folder]
#   binary  the app's executable (default .build/release/BaneySpaces, then .build/debug/BaneySpaces)
#   folder  where swatches-dark.png goes (default a new temporary folder)
# Offscreen only: nothing is put on screen and no setting is saved. Exit 0 PASS, 1 FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
bin="${1:-}"
if [[ -z "$bin" ]]; then
  for b in .build/release/BaneySpaces .build/debug/BaneySpaces; do [[ -x "$b" ]] && { bin="$b"; break; }; done
fi
[[ -n "$bin" && -x "$bin" ]] || { echo "swatch-check: build first (swift build), or pass the executable" >&2; exit 1; }
out="${2:-$(mktemp -d)}"
mkdir -p "$out"
set +e
line=$(BANEYSPACES_RENDER_SWATCHES=1 "$bin" --render "$out" 2>/dev/null | grep '^swatch check:')
set -e
if [[ -z "$line" ]]; then
  echo "swatch-check: FAIL, $bin printed no swatch check (a build without the check draws every shot instead)"
  exit 1
fi
echo "$line"
echo "swatch-check: shot at $out/swatches-dark.png"
[[ "$line" == *PASS ]]
