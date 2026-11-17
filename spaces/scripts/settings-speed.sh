#!/usr/bin/env bash
# Every Settings pane opens and switches inside one 60 Hz frame (16 ms) of main-thread time (gap X2, issue #350).
# Usage: scripts/settings-speed.sh [--write] [binary]
#   binary   the app's executable (default .build/release/BaneySpaces; time a release build, debug is several times slower)
#   --write  record the medians in scripts/settings-speed.json (SettingsSpeedTests holds the file to the budget)
# ROUNDS (default 7) sets how many times each pane is timed; medians are printed. Offscreen only: no window is shown.
# The budget is on the main thread's CPU time (`cpu`), which a busy Mac doesn't inflate; wall time is printed beside it.
# Exit 0 when every pane is in budget, 1 when one isn't.
set -euo pipefail
cd "$(dirname "$0")/.."
write=0
if [[ "${1:-}" == "--write" ]]; then write=1; shift; fi
bin="${1:-.build/release/BaneySpaces}"
[[ -x "$bin" ]] || { echo "settings-speed: build first (swift build -c release), or pass the executable" >&2; exit 1; }
budget=16
out=$(mktemp -d)
lines=$(BANEYSPACES_RENDER_SETTINGS_TIMING="${ROUNDS:-7}" "$bin" --render "$out" 2>/dev/null | grep '^settings ')
panes=$(grep -c ' cpu open ' <<<"$lines" || true)
[[ "$panes" -gt 0 ]] || { echo "settings-speed: FAIL, $bin printed no cpu column (a build before the budget)"; exit 1; }
echo "$lines"
# settings <pane> open <w> ms  switch <w> ms  idle <i> ms/s  cpu open <c> ms  cpu switch <c> ms
over=$(awk -v b="$budget" '/ cpu open / { if ($14 + 0 > b || $18 + 0 > b) printf "%s (cpu open %s ms, switch %s ms) ", $2, $14, $18 }' <<<"$lines")
if [[ "$write" == 1 ]]; then
  awk -v b="$budget" -v when="$(date +%Y-%m-%d)" -v commit="$(git rev-parse --short HEAD)" -v load="$(sysctl -n vm.loadavg | awk '{print $2}')" '
    BEGIN { printf "{\n  \"budgetMs\": %d,\n  \"measured\": \"%s\",\n  \"commit\": \"%s\",\n  \"loadAverage\": %s,\n  \"panes\": {\n", b, when, commit, load }
    / cpu open / { if (n++) printf ",\n"; printf "    \"%s\": { \"cpuOpenMs\": %s, \"cpuSwitchMs\": %s, \"wallOpenMs\": %s, \"wallSwitchMs\": %s }", $2, $14, $18, $4, $7 }
    END { printf "\n  }\n}\n" }' <<<"$lines" > scripts/settings-speed.json
  echo "settings-speed: wrote scripts/settings-speed.json"
fi
if [[ -n "$over" ]]; then echo "settings-speed: FAIL, over ${budget} ms: $over"; exit 1; fi
echo "settings-speed: PASS, $panes panes open and switch under ${budget} ms of main-thread time"
