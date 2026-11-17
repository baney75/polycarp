#!/usr/bin/env bash
# Reads the accessibility tree of every surface --render draws (dock, overview, switcher, launcher, Settings, the helpers)
# and fails on a control VoiceOver can't name (gap X4). Offscreen only: nothing is shown, no setting is saved.
# Usage: scripts/ax-audit.sh [binary] [folder]
#   binary  the app's executable (default .build/release/BaneySpaces, then .build/debug/BaneySpaces)
#   folder  where the shots and ax-audit.txt go (default a new temporary folder)
# Exit 0 PASS, 1 FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
bin="${1:-}"
if [[ -z "$bin" ]]; then
  for b in .build/release/BaneySpaces .build/debug/BaneySpaces; do [[ -x "$b" ]] && { bin="$b"; break; }; done
fi
[[ -n "$bin" && -x "$bin" ]] || { echo "ax-audit: build first (swift build), or pass the executable" >&2; exit 1; }
out="${2:-$(mktemp -d)}"
mkdir -p "$out"
set +e
BANEYSPACES_RENDER_AX_AUDIT=1 "$bin" --render "$out" 2>/dev/null | grep -E '^(ax audit|unnamed):'
set -e
[[ -f "$out/ax-audit.txt" ]] || { echo "ax-audit: FAIL, $bin wrote no ax-audit.txt (a build without the audit)"; exit 1; }
echo "ax-audit: report at $out/ax-audit.txt"
tail -1 "$out/ax-audit.txt" | grep -q 'PASS$'
