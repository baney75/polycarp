#!/bin/bash
# Times the dock opening in the built app and judges each run against spec/speed.json (spacesTiming).
#   scripts/panel-bench.sh build/Polycarp.app
# The app's `--bench-panels` one-shot (PanelBench.swift) opens the dock cold and warm, alone and beside
# hw.ncpu background spinners, and writes each run as its own timing.log; scripts/speed-report.sh judges
# each one. Exit 1 when any run misses its budget. CI only: it puts panels on screen, so it refuses to run
# where CI is not "true" and never opens a panel on someone's own session.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CI:-}" = true ] || { echo "panel-bench: runs only where CI=true; it puts panels on screen" >&2; exit 2; }
app="${1:?usage: scripts/panel-bench.sh <path to Polycarp.app>}"
source scripts/product.env
out="$(mktemp -d)"
"$app/Contents/MacOS/$EXECUTABLE" --bench-panels "$out"
status=0
for run in "$out"/*/; do
    echo
    echo "== $(basename "$run")"
    POLYCARP_SUPPORT_DIR="$run" scripts/speed-report.sh --all || status=1
done
exit $status
