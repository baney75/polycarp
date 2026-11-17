#!/bin/bash
# Checks a day of real use against the budgets in spec/speed.json (spacesTiming), read-only.
#   scripts/speed-report.sh              the last 24 hours
#   scripts/speed-report.sh --hours 72   a longer window
#   scripts/speed-report.sh --all        everything the logs still hold
# For every event kind in timing.log it prints n, p50, p90 and p99 against the budget, and marks
# a miss. p50 and p90 are judged only with spacesTiming.minSamples lines or more (fewer prints
# "few"); p99 only with 100 or more, since below that nearest-rank p99 is the slowest one or two.
# A kind in the log with no budget is a miss too.
# It also counts, from trace.log and its two rotations, the lines that mean a glitch Donovan
# reported came back (gap G8): the dock stuck open, and the ⌘Tab switcher coming up or landing
# wrong. Each must be 0. The rotations hold about 600 KB, so it prints the span the trace lines
# cover; with no trace.log, or no line in the window, the counts are untested, not 0.
# It reads the installed build's logs, so it judges main as installed, not a branch.
# Exit 0 when everything is in budget and both counts are 0, 1 on any miss, 2 when there is no
# timing.log, 3 when nothing missed but the glitch counts are untested.
# POLYCARP_SUPPORT_DIR points it at another folder (the tests use a fixture).
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
P99_LEAST = 100  # below this, nearest-rank p99 is the max (n < 100) or next to it
since = time.time() - hours * 3600 if hours > 0 else 0

def kind_of(name):
    """`open <name>=` lines: every Settings pane counts as one kind."""
    if name.startswith("settings-") and name != "settings-first":
        return "settings-pane"
    return name

samples = {}
for line in open(os.path.join(folder, "timing.log"), encoding="utf-8", errors="replace"):
    parts = line.split()
    if not parts or not parts[0].isdigit() or int(parts[0]) < since:
        continue
    if len(parts) >= 2 and parts[1] == "open":
        m = re.match(r"([\w-]+)=(\d+)$", parts[2] if len(parts) > 2 else "")
        if m:
            samples.setdefault(kind_of(m.group(1)), []).append(int(m.group(2)))
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
print(f"Spaces speed, {window} (budgets: spec/speed.json spacesTiming; judged at n >= {least}, p99 at n >= {P99_LEAST})")
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
        if len(values) < (P99_LEAST if key == "p99" else least):
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
    elif len(values) < P99_LEAST:
        result += f" (p99 n<{P99_LEAST}, not judged)"
    print(f"{kind:<16}{len(values):>5}  {cells[0]}  {cells[1]}  {cells[2]}  {result}")

# Gap G8: lines that mean a glitch Donovan reported came back.
glitches = {
    "dock stuck open": [r"^dock stray:", r"^dock held 2s with the bar unmeasured", r"^dock menu marked open with none on screen"],
    "switcher wrong": [r"^cmdTab panel not on screen", r"^cmdTab passed to macOS started=true viewerOpen=false"],
}
# SpeedBudgetTests checks each pattern against the strings the app logs, so a reworded line can't
# leave its count at 0 for good. Add a pattern only once the line that writes it is in the app.
counts = {name: 0 for name in glitches}
examples = {}
found, oldest, first, last = [], None, None, None
for name in ("trace.log.2", "trace.log.1", "trace.log"):
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        continue
    found.append(name)
    for line in open(path, encoding="utf-8", errors="replace"):
        stamp, _, text = line.rstrip("\n").partition(" ")
        try:
            at = float(stamp)
        except ValueError:
            continue
        oldest = at if oldest is None else min(oldest, at)
        if at < since:
            continue
        first = at if first is None else min(first, at)
        last = at if last is None else max(last, at)
        for glitch, patterns in glitches.items():
            if any(re.match(p, text) for p in patterns):
                counts[glitch] += 1
                examples.setdefault(glitch, text[:120])
print()
untested = None
if not found:
    untested = f"no trace.log in {folder}"
elif first is None:
    untested = f"no trace.log line in the {window}"
else:
    clock = lambda t: time.strftime("%Y-%m-%d %H:%M", time.localtime(t))
    span = f"trace.log covers {clock(first)} to {clock(last)} ({(last - first) / 3600:.1f} h)"
    if hours > 0 and oldest > since:
        span += f", not all {hours:g} h: older lines rotated out"
    print(span)
for glitch, n in counts.items():
    if untested:
        print(f"{glitch:<16}  untested: {untested}")
    else:
        print(f"{glitch:<16}{n:>5} lines in trace.log  {'ok' if n == 0 else 'MISS: ' + examples[glitch]}")
    if n:
        missed.append(f"{glitch}: {n} lines")

if missed:
    print("\nspeed-report: FAIL (" + "; ".join(missed) + ")")
    sys.exit(1)
if untested:
    print(f"\nspeed-report: glitch counts untested ({untested}); speed in budget")
    sys.exit(3)
print("\nspeed-report: pass")
PY
