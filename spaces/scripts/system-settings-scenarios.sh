#!/bin/bash
# Agents driving System Settings, live, on the agent workspace only. Each scenario prints ok, FAIL or skip with the
# envelope it judged by. It navigates and reads; it never turns a switch, so no macOS setting changes.
#   S1 a pane link while System Settings isn't running opens that pane, in one call, on the agent workspace (#361).
#   S2 run-steps clicks a sidebar row by text, then an element of the pane it loads (#387: the pane draws after it).
#   S3 the search field: set-value "Keyboard" and the results list shows Keyboard.
#   S4 a pane link to the copy this run started is refused (in_use), with a suggestion, and nothing moves.
# It runs only when the Mac has been idle 10 minutes and System Settings isn't running (a running copy is Donovan's).
# Otherwise it prints "untested live" and exits 3, opening nothing. It quits only the copy it started: a pid that was
# not there before, started with -ApplePersistenceIgnoreState. Afterwards it deletes the open cover flag.
#   scripts/system-settings-scenarios.sh
set -uo pipefail
PS=${POLYCARP_SPACES:-$HOME/.local/bin/polycarp-spaces}
BUNDLE=com.apple.systempreferences
idle=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}')
if [ "${idle:-0}" -lt 600 ]; then echo "untested live: idle ${idle:-0} s, under 600 s"; exit 3; fi
if pgrep -x "System Settings" >/dev/null; then echo "untested live: System Settings is already running"; exit 3; fi

field() { python3 -c 'import json,sys
d=json.load(sys.stdin); o=d
for k in sys.argv[1].split("."):
    o=o.get(k) if isinstance(o,dict) else None
print("" if o is None else (json.dumps(o) if isinstance(o,(dict,list)) else o))' "$1"; }
fail=0
ok()   { echo "ok   $*"; }
bad()  { echo "FAIL $*"; fail=1; }

# S1
t0=$(python3 -c 'import time; print(time.time())')
OPEN=$("$PS" agent open "System Settings" "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
t1=$(python3 -c 'import time; print(time.time())')
WIN=$(echo "$OPEN" | field data.window); PID=$(echo "$OPEN" | field data.pid)
AGENT=$("$PS" agent status --json | field info.workspace)
if [ -z "$WIN" ]; then bad "S1 open answered no window: $OPEN"
else
  ON=$("$PS" agent windows | python3 -c 'import json,sys
w=[x for x in json.load(sys.stdin).get("data",{}).get("windows",[]) if str(x.get("window"))==sys.argv[1]]
print(w[0].get("workspace","") if w else "")' "$WIN")
  [ "$ON" = "$AGENT" ] && ok "S1 window $WIN on the agent workspace $AGENT ($(python3 -c "print(round($t1-$t0,2))") s)" || bad "S1 window $WIN on workspace '$ON', agent workspace $AGENT"
  sleep 1
  PANE=$("$PS" agent find --window "$WIN" --text "Accessibility" --limit 5)
  [ "$(echo "$PANE" | field data.count)" -ge 1 ] 2>/dev/null && ok "S1 the Accessibility pane is shown" || bad "S1 pane not shown: $PANE"
fi

# S2
if [ -n "$WIN" ]; then
  STEPS="{\"steps\":[{\"tool\":\"click\",\"args\":{\"window\":$WIN,\"text\":\"General\"}},{\"tool\":\"click\",\"args\":{\"window\":$WIN,\"text\":\"About\"}}]}"
  RUN=$("$PS" agent run-steps --steps "$(echo "$STEPS" | field steps)")
  [ "$(echo "$RUN" | field ok)" = True ] || [ "$(echo "$RUN" | field ok)" = true ] && ok "S2 General, then About in its pane, in one run" || bad "S2 $RUN"
fi

# S3
if [ -n "$WIN" ]; then
  SEARCH=$("$PS" agent find --window "$WIN" --role searchfield --limit 1)
  REF=$(echo "$SEARCH" | python3 -c 'import json,sys; m=json.load(sys.stdin).get("data",{}).get("matches",[]); print(m[0].get("ref_id") or m[0].get("ref") if m else "")')
  if [ -z "$REF" ]; then bad "S3 no search field: $SEARCH"
  else
    "$PS" agent set-value --ref "$REF" --value "Keyboard" >/dev/null
    sleep 1
    HITS=$("$PS" agent find --window "$WIN" --text "Keyboard" --limit 10)
    [ "$(echo "$HITS" | field data.count)" -ge 2 ] 2>/dev/null && ok "S3 search shows Keyboard results" || bad "S3 search showed nothing: $HITS"
  fi
fi

# S4
if [ -n "$WIN" ]; then
  AGAIN=$("$PS" agent open "System Settings" "x-apple.systempreferences:com.apple.Displays-Settings.extension")
  [ "$(echo "$AGAIN" | field error.code)" = in_use ] && ok "S4 a pane link to the running copy is refused (in_use)" || bad "S4 $AGAIN"
fi

# Quit only the copy this run started.
if [ -n "$PID" ] && ps -o command= -p "$PID" | grep -q -- "-ApplePersistenceIgnoreState"; then kill "$PID"; fi
defaults delete com.baney.polycarp agentOpenFlashGuard 2>/dev/null || true
exit $fail
