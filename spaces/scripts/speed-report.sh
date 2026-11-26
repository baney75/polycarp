#!/bin/bash
# Checks a day of real use against the budgets in spec/speed.json (spacesTiming), read-only.
#   scripts/speed-report.sh              the last 24 hours
#   scripts/speed-report.sh --hours 72   a longer window
#   scripts/speed-report.sh --all        everything the logs still hold
# For every event kind in timing.log it prints n, p50, p90 and p99 against the budget, and marks
# a miss. A percentile is judged only with spacesTiming.minSamples lines or more (fewer prints
# "few"). A kind in the log with no budget is a miss too, except a retired one (RETIRED below), which
# an older build wrote and this one never does: its lines are skipped.
# It also counts, from trace.log and its two rotations, the lines that mean a glitch Donovan
# reported came back (gap G8): the ⌘Tab switcher coming up or landing wrong. It must be 0.
# Exit 0 when everything is in budget and the count is 0, 1 on any miss, 2 when there is no
# timing.log. POLYCARP_SUPPORT_DIR points it at another folder (the tests use a fixture).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${POLYCARP_SUPPORT_DIR:-$HOME/Library/Application Support/Polycarp}"
SPEC="${SPEED_SPEC:-$here/spec/speed.json}"
hours=24
case "${1:-}" in
    --hours) hours="${2:?--hours needs a number}" ;;
    --all) hours=0 ;;
    "") ;;
    *) echo "usage: scripts/speed-report.sh [--hours N | --all]" >&2; exit 2 ;;
esac
[ -f "$DIR/timing.log" ] || { echo "no timing.log in $DIR" >&2; exit 2; }
exec python3 -I - "$SPEC" "$DIR" "$hours" <<'PY'
import json, math, os, re, sys, time

spec_path, folder, hours = sys.argv[1], sys.argv[2], float(sys.argv[3])
spec = json.load(open(spec_path))["spacesTiming"]
budgets, least = spec["kinds"], spec["minSamples"]
since = time.time() - hours * 3600 if hours > 0 else 0
# Kinds an older build logged for a surface that is gone: `dock`, the Workspace Dock, removed 2026-11-23.
RETIRED = {"dock"}

def kind_of(name):
    """`open <name>=` lines: every Settings pane counts as one kind."""
    if name.startswith("settings-") and name != "settings-first":
        return "settings-pane"
    return name

samples = {}
unfilled = {}
for line in open(os.path.join(folder, "timing.log"), encoding="utf-8", errors="replace"):
    parts = line.split()
    if not parts or not parts[0].isdigit() or int(parts[0]) < since:
        continue
    if len(parts) >= 2 and parts[1] == "open":
        m = re.match(r"([\w-]+)=(\d+)$", parts[2] if len(parts) > 2 else "")
        if m and kind_of(m.group(1)) not in RETIRED:
            samples.setdefault(kind_of(m.group(1)), []).append(int(m.group(2)))
        continue
    # A tiling look (spec/tiling-speed.md R-TS1): judged on asked=, the last frame asked for, from its cause.
    if len(parts) >= 2 and parts[1].startswith("tile="):
        m = re.search(r" asked=(\d+)", line)
        if m:
            samples.setdefault("tile-" + parts[1][5:], []).append(int(m.group(1)))
        continue
    # A close or move (spec/tiling-speed.md R-TS10): judged on fill=; fill=- (nothing written in 3 s) is counted apart.
    if len(parts) >= 3 and parts[1] in ("close", "move") and parts[2].startswith("fill="):
        kind = parts[1] + "-fill"
        if parts[2][5:].isdigit():
            samples.setdefault(kind, []).append(int(parts[2][5:]))
        else:
            unfilled[kind] = unfilled.get(kind, 0) + 1
        continue
    kv = {}
    for k, v in re.findall(r"(\w+)=(\S+)", line):
        kv.setdefault(k, v)  # the first of each mark: a switch out of full screen marks twice
    # A switch to the workspace you're on moves nothing (bench.sh makes those); a line without
    # from= can't tell, so it doesn't count either.
    if "ws" not in kv or "from" not in kv or kv["from"] == kv["ws"]:
        continue
    if kv.get("done", "").isdigit():
        samples.setdefault("switch", []).append(int(kv["done"]))
    if kv.get("parked", "").isdigit():
        samples.setdefault("parked", []).append(int(kv["parked"]))

def pct(values, p):
    """Nearest rank: the smallest value with at least p of them at or below it."""
    v = sorted(values)
    return v[max(0, math.ceil(len(v) * p) - 1)]

window = f"last {hours:g} h" if hours > 0 else "all of timing.log"
print(f"Spaces speed, {window} (budgets: spec/speed.json spacesTiming; judged at n >= {least})")
print(f"{'kind':<16}{'n':>5}  {'p50':>11}  {'p90':>11}  {'p99':>11}  result")
missed = []
for kind in list(budgets) + sorted(set(samples) - set(budgets)):
    values = samples.get(kind, [])
    budget = budgets.get(kind)
    if budget is None:
        print(f"{kind:<16}{len(values):>5}  no budget in spec/speed.json                  MISS")
        missed.append(f"{kind}: no budget")
        continue
    cells, result = [], "ok"
    for p, key in ((0.5, "p50"), (0.9, "p90"), (0.99, "p99")):
        if len(values) < least:
            cells.append(f"{'-':>5}/{budget[key]:<5}")
            continue
        got = pct(values, p)
        over = got > budget[key]
        cells.append(f"{got:>5}/{budget[key]:<4}{'!' if over else ' '}")
        if over:
            missed.append(f"{kind} {key} {got} ms over {budget[key]} ms")
            result = "MISS"
    if not values:
        result = "none"
    elif len(values) < least:
        result = "few"
    print(f"{kind:<16}{len(values):>5}  {cells[0]}  {cells[1]}  {cells[2]}  {result}")

for kind in sorted(unfilled):
    print(f"{kind:<16}{unfilled[kind]:>5}  with nothing written in 3 s (fill=-), not in the percentiles")
    # A close nothing filled is the miss Donovan reported (spec/tiling-speed.md R-TS8): it fails the report.
    missed.append(f"{kind}: {unfilled[kind]} with nothing written")

# Gap G8: lines that mean a glitch Donovan reported came back.
glitches = {
    "switcher wrong": [r"^cmdTab panel not on screen", r"^cmdTab passed to macOS started=true viewerOpen=false", r"^cmdTab landed wrong:"],
}
counts = {name: 0 for name in glitches}
examples = {}
for name in ("trace.log.2", "trace.log.1", "trace.log"):
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        continue
    for line in open(path, encoding="utf-8", errors="replace"):
        stamp, _, text = line.rstrip("\n").partition(" ")
        try:
            if float(stamp) < since:
                continue
        except ValueError:
            continue
        for glitch, patterns in glitches.items():
            if any(re.match(p, text) for p in patterns):
                counts[glitch] += 1
                examples.setdefault(glitch, text[:120])
print()
for glitch, n in counts.items():
    print(f"{glitch:<16}{n:>5} lines in trace.log  {'ok' if n == 0 else 'MISS: ' + examples[glitch]}")
    if n:
        missed.append(f"{glitch}: {n} lines")

if missed:
    print("\nspeed-report: FAIL (" + "; ".join(missed) + ")")
    sys.exit(1)
print("\nspeed-report: pass")
PY
