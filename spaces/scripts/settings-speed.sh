#!/usr/bin/env bash
# Times every Settings pane's open and switch in main-thread CPU time and holds each to its recorded number (gap X2, #350).
# Usage: scripts/settings-speed.sh [--write] [binary]
#   binary   the app's executable (default .build/release/BaneySpaces; time a release build, debug is several times slower)
#   --write  record the medians in scripts/settings-speed.json, after a change meant to move them
# ROUNDS (default 7) sets how many times each pane is timed; medians are printed. Offscreen only: no window is shown.
# It runs the app at background priority (taskpolicy -b), so every run measures on the same efficiency cores and leaves
# the Mac's own work alone; CPU time there is about twice a performance core's. Wall time is printed beside it.
# A pane fails when its open or switch takes more than 30% over its recorded time. The goal is one 60 Hz frame (16 ms):
# a switch to a pane Settings already holds (`cpu built`) must meet it, and opens and first switches still over it are
# listed without failing. The window must take its first click within the first-open budget (`settings-first` p50 in
# spec/speed.json) with the deck filling, and holding every pane may grow the app by at most 30 MB.
# Exit 0 when every check passes, 1 when one fails or the timing didn't run.
set -euo pipefail
cd "$(dirname "$0")/.."
write=0
if [[ "${1:-}" == "--write" ]]; then write=1; shift; fi
bin="${1:-.build/release/BaneySpaces}"
record=scripts/settings-speed.json
[[ -x "$bin" ]] || { echo "settings-speed: build first (swift build -c release), or pass the executable" >&2; exit 1; }
goal=16 headroom=1.3 memory_limit=30
# The first-open budget from spec/speed.json (#470); 150 ms, its value, on a branch from before it.
first_budget=$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["spacesTiming"]["kinds"]["settings-first"]["p50"])' spec/speed.json 2>/dev/null || echo 150)
out=$(mktemp -d)
status=0
BANEYSPACES_RENDER_SETTINGS_TIMING="${ROUNDS:-7}" taskpolicy -b nice -n 15 "$bin" --render "$out" >"$out/log" 2>&1 || status=$?
lines=$(grep '^settings ' "$out/log" || true)
panes=$(grep -c ' cpu open ' <<<"$lines" || true)
if [[ "$status" != 0 || "$panes" -eq 0 ]]; then
  echo "settings-speed: FAIL, the timing didn't run (exit $status):"; tail -5 "$out/log"; exit 1
fi
echo "$lines"
# settings <pane> open <w> ms  switch <w> ms  idle <i> ms/s  cpu open <c> ms  cpu switch <c> ms  cpu built <c> ms  step <c> ms
# settings memory <m> MB  first input <f> ms  (...)
summary=$(grep '^settings memory ' "$out/log" || true)
memory=$(awk '{print $3}' <<<"$summary") first=$(awk '{print $7}' <<<"$summary")
if [[ -z "$summary" ]] || ! grep -q ' cpu built ' <<<"$lines"; then
  echo "settings-speed: FAIL, this build doesn't time switches to built panes (no deck)"; exit 1
fi
if [[ "$write" == 1 ]]; then
  # Keeps the record's "before" block (the times this work started from) and replaces the rest.
  /usr/bin/python3 -I - "$record" "$goal" "$(git rev-parse --short HEAD)" "$(sysctl -n vm.loadavg | awk '{print $2}')" "${ROUNDS:-7}" "$out/log" <<'PY'
import json, os, sys, time
path, goal, commit, load, rounds, log = sys.argv[1:]
old = json.load(open(path)) if os.path.exists(path) else {}
doc = {"goalMs": int(goal), "measured": time.strftime("%Y-%m-%d"), "commit": commit, "loadAverage": float(load),
       "cores": "efficiency (taskpolicy -b)", "rounds": f"one run of {rounds}, medians", "panes": {}}
for line in open(log):
    f = line.split()   # settings <pane> open <w> ms  switch <w> ms  idle <i> ms/s  cpu open <c> ms  cpu switch <c> ms
    if line.startswith("settings ") and " cpu open " in line:
        doc["panes"][f[1]] = {"cpuOpenMs": float(f[13]), "cpuSwitchMs": float(f[17]), "cpuBuiltMs": float(f[21]), "cpuStepMs": float(f[24]),
                              "wallOpenMs": float(f[3]), "wallSwitchMs": float(f[6]), "idleMsPerS": float(f[9])}
    if line.startswith("settings memory "):
        doc["memoryMB"] = float(f[2]); doc["firstInputMs"] = float(f[6])
if "before" in old: doc["before"] = old["before"]
json.dump(doc, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
  echo "settings-speed: wrote $record"
fi
[[ -f "$record" ]] || { echo "settings-speed: FAIL, no $record; run with --write"; exit 1; }
# One "pane open switch" line per recorded pane.
recorded=$(/usr/bin/python3 -I -c 'import json,sys; [print(k, v["cpuOpenMs"], v["cpuSwitchMs"]) for k, v in json.load(open(sys.argv[1]))["panes"].items()]' "$record")
slower=$(awk -v h="$headroom" 'NR == FNR { o[$1] = $2; s[$1] = $3; next }
  / cpu open / { if (!($2 in o)) { printf "%s (not recorded) ", $2; next }
                 if ($14 > o[$2] * h || $18 > s[$2] * h) printf "%s (cpu open %s ms, recorded %s; switch %s ms, recorded %s) ", $2, $14, o[$2], $18, s[$2] }' \
  <(echo "$recorded") - <<<"$lines")
over=$(awk -v g="$goal" '/ cpu open / { if ($14 + 0 > g || $18 + 0 > g) printf "%s ", $2 }' <<<"$lines")
[[ -z "$over" ]] || echo "settings-speed: opens or first switches over the ${goal} ms goal: $over"
echo "settings-speed: memory with every pane built +$memory MB (limit $memory_limit), first input $first ms (budget $first_budget)"
built=$(awk -v g="$goal" '/ cpu built / { if ($22 + 0 > g) printf "%s (%s ms) ", $2, $22 }' <<<"$lines")
fail=0
if [[ -n "$slower" ]]; then echo "settings-speed: FAIL, slower than recorded by over 30%: $slower"; fail=1; fi
if [[ -n "$built" ]]; then echo "settings-speed: FAIL, a switch to a built pane over ${goal} ms: $built"; fail=1; fi
if awk -v m="$memory" -v l="$memory_limit" 'BEGIN { exit !(m > l) }'; then echo "settings-speed: FAIL, every pane built grew the app $memory MB, over $memory_limit"; fail=1; fi
if awk -v f="$first" -v b="$first_budget" 'BEGIN { exit !(f > b) }'; then echo "settings-speed: FAIL, first input $first ms, over the $first_budget ms budget"; fail=1; fi
[[ "$fail" == 0 ]] || exit 1
echo "settings-speed: PASS, $panes panes no slower than recorded, every built pane switches within ${goal} ms"
