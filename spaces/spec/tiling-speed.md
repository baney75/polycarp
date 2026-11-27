# Tiling speed

Tiling on the Mac must feel instant, like Hyprland: a window snaps into its tile as it opens, a tiling key moves the
windows before the finger is up, a closed window's space is filled at once, and a switch to a tiling workspace is as
fast as any other switch. Donovan, 2026-11-26: "TILING IS WAY TOO SLOW", for all four.

This file holds the rules, the timing line that measures them, and the cases the tests take. The tiling layout itself
is in `docs/tiling.md`; the switch's own rules are in `workspaces.md`.

## Terms

- **Cause**: the event a look answers. `key` (a tiling key went down), `new` (an app said a window was created),
  `close` (an app said a window was destroyed), `switch` (a workspace switch was asked for).
- **Cause time**: when the cause happened, on the system uptime clock: the key event's own time (Carbon
  `GetEventTime`), the moment the Accessibility notification reached Polycarp, the moment the switch was asked for.
- **Look**: `Tiling.look`, which reads the windows, plans with `TilingEngine` and writes frames.
- **Asked**: the last frame of a look's write was asked of its app (the write on `Spaces.axQueue` returned), or, for a
  key that only moves the focus, the focus was asked for.
- **Landed**: the settle after a write saw every window it wrote on its target, or held still.
- **In flight**: a frame asked for whose settle hasn't reported yet.

## Rules

### R-TS1 Every action writes its time
A look that asks for a frame or a focus because of a cause writes one line to timing.log:

    <epoch s> tile=<cause> looked=<ms> asked=<ms> landed=<ms> moves=<n>

Every ms is from the cause time. `looked` is when the look began to plan, so `looked` minus 0 is everything Polycarp
waited on first (a scan, an app's answer, a write before it). `asked` is the number the budgets judge. `landed` is
`-` when a newer look took the windows before this one's settle reported. `moves` is the frames asked for (0 for a
focus). Nothing else is written: no window id, title or app name.

### R-TS2 Which look answers which cause
- `key`: the looks `Tiling.run` makes for that key press; the line is written once that run asked (or found nothing
  to do, which writes no line).
- `new`: the first look that writes a frame for a window the engine never had before, when its app sent
  `kAXWindowCreated` in the 3 s before. The window server alone (no notification) writes no `new` line.
- `close`: the first look after an app sent `kAXUIElementDestroyed` for a window, in the 3 s before, that writes a
  frame on the workspace the window left.
- `switch`: the first look after a switch ended, within 1 s of it being asked for, that writes a frame on the workspace
  it went to. A newer switch replaces a pending one. A look with that workspace in sight that writes nothing on it drops
  the switch with no line, so a later write (a close, the next switch) never answers it.
- A cause no look answered within 3 s is dropped with no line. When one look answers several causes, each gets its line.

### R-TS3 Budgets
`spec/speed.json` `spacesTiming.kinds` has `tile-key`, `tile-new`, `tile-close` and `tile-switch`, judged on `asked`
by `scripts/speed-report.sh`. Targets, p90 over at least 20 real tries on the owner's Mac with Ghostty, Helium or
Safari, Finder and TextEdit: key 50 ms, new 150 ms, close 100 ms. A switch's own `parked` mark (the `ws=` line) has
the target 80 ms with tiling on. A target an app's own Accessibility answer time keeps out of reach is set to what the
app allows, with the numbers in the PR that sets it.

### R-TS4 A look never waits on a settle
Tiling is busy only while it asks apps (`question`) or writes frames (`write`). A look asked for while it is busy runs
as soon as that ask or write returns, not after the settle. The settle only reports where windows landed. A settle
reports a window only while its own write is that window's latest; a window a newer write took is the newer settle's.

### R-TS5 A frame in flight is not asked for again
While a frame is in flight to a target, a plan that wants the same target for that window asks nothing and uses up
none of its tries. A plan that wants another target asks at once. The settle ends the flight however it ends (landed,
held still, given up after 10 looks, or cut off by a switch or a press), and so does a window being touched.

### R-TS6 Windows reach tiling through the apps' own notifications
Spaces watches each app it scans for `kAXWindowCreated`, `kAXFocusedWindowChanged` and `kAXMainWindowChanged`, and
each of its windows for `kAXUIElementDestroyed`, `kAXWindowMiniaturized` and `kAXWindowDeminiaturized`. Each such note
starts a scan of that app at once (`refresh(asking: [pid])`), and its answer reaches tiling through `onChange` as
before. The window server's list and the retry timers stay as the backstop, not the path.

### R-TS7 Nothing regresses
`swift test` passes. `BANEYSPACES_RENDER_TILE_TIMING` exits 0: every helper window on its tile, nothing written at
rest. Each round it also times a move key on the new window, that window let go over another window's tile (a drag into a
tile), and a close of another window on real windows (a window sent to another workspace leaves its tile the same way): each plans
at most one frame per window, every window ends on its tile, and a move key that moves nothing either way, or a drop that moves nothing, fails. No window ends off its tile: the `TilingEngine`, `TilingRequest` and `Tiling*` tests pass unchanged unless a
rule here changes them.

### R-TS8 A window that leaves fills its space at once
Donovan, 2026-11-26, the second report: "when a window's closed tiling doesn't auto fill like it should, is still
often slow and janky as well." A window leaves its workspace's layout the moment Polycarp hears it went:

- its app says `kAXUIElementDestroyed` for it: the close button, ⌘W, a tab merged into another window;
- its app says `kAXWindowMiniaturized` for it: minimize;
- its app quits (`NSWorkspace.didTerminateApplicationNotification`): every window of that app;
- Polycarp moves it to another workspace.

Spaces takes it out of the model then, without waiting for the window server to drop it or for a scan. It is kept as
dormant, so a window whose app still lists it at the next scan goes back to its workspace and is tiled again. Tiling
looks at once: no `lookSoon` delay, no scan and no settle first. The note still starts a scan of the app (R-TS6),
which only confirms. A sheet or panel closing is not a window leaving: nothing is written.

### R-TS9 One frame per window, sent so it never shows a frame in between
- A close or a move asks each window for at most one frame. A window is asked again only when it didn't land
  (R-TS5's tries), and that write counts.
- A frame goes to its app in the fewest Accessibility messages that never show the window clamped by the display's
  edge. Same size: the position alone. Same position: the size alone.
  Otherwise the position first when the window at its new position and old size stays inside the display, else the
  size first when it does at its old position and new size, else size, position and size again (the old way). When
  both fit, the order whose frame in between lies inside the new frame, else inside the old one. Animation stays off
  while it is sent.

### R-TS10 Every close and move writes its time and its writes
    <epoch s> close fill=<ms> writes=<n> windows=<k> how=<destroyed|minimized|quit|workspace>
    <epoch s> move fill=<ms> writes=<n> windows=<k> how=<key|drag>

`fill` is from the cause (the note's arrival, the key's event time, the drop, the move) to the last frame write that
returned for it, `-` when nothing was written in 3 s. `writes` is the most frames asked of any one window for it and
`windows` how many windows got one. The line is written once 0.5 s pass with no write for it, or 3 s after the cause.
A close counts only when the window was tiled and another tiled window stays on its workspace; a move key only when
it moved a window. Nothing else is written.

### R-TS11 Budgets
`spec/speed.json` `close-fill` and `move-fill`, judged on `fill` by `scripts/speed-report.sh`: p90 50 ms each, over at
least 20 real tries. `writes` is 1 on every line but one whose window didn't land.

### R-TS12 The probe tiles the agent workspace, off screen, only while it runs
Donovan wants live tiling numbers from the real app with nothing on his screen. The agent workspace is never shown,
so the probe tiles there, off every display, with windows of its own.

1. `polycarp-spaces agent probe [--rounds N] [--seconds S] [--json]` runs the probe in the running app and prints its
   numbers. N is 1 to 10, 3 when left out. S is 1 to 300, 180 when left out. A caller on another machine is refused,
   as for every agent operation but `status` (`Remote.allows`).
2. On the wire: op `agent`, text `probe`. Args `["start", "<caller pid>", "<rounds>", "<seconds>"]` answers at once
   with `ok` and `info.state` `running`; an empty number takes its default. Args `["status"]` answers `info.state`
   `running`, `done` (with `info.result`, the JSON of rule 12) or `ended` (with `info.why`). With no probe since the app
   started, `status` is `ended` with why `error`. The command starts it, asks `status` every 0.5 s until it is not
   running, then prints. Refusals are `AgentAPI.refusal`: `bad_request` for N or S out of range or a pid that isn't a
   running process, `agent_workspace_off` with no agent workspace, `probe_busy` while one runs, `probe_off` while
   Polycarp isn't placing windows.
3. While a probe runs, and only then, `tiles(agent workspace)` is true (`TilingOptions.probing`). No settings key sets
   it: `TilingOptions(_:agentWorkspace:)` never does, and a settings reload during a probe keeps it
   (`TilingOptions.reloaded`) while the agent workspace stays the same number, and drops it if that number changed. The Settings row for the agent workspace stays disabled, and `tile on` and
   `tile toggle` of it still answer "the agent workspace never tiles" (`refusesTurning`).
4. The probe's area is `TilingProbe.area(screens:usable:)`: the size of the main display's tiling area as TilingView
   takes it, its right edge 2000 pt left of the leftmost display, its top at that area's top. In the window server's
   coordinates, as every TilingView area is. `Geometry.isStranded` is true for it.
5. During a probe TilingView shows the agent workspace on the display key `probe` with that area. Only the helper's
   windows there count as in sight; every other window of the agent workspace stays parked. Nothing changes for the
   other workspaces.
6. Probe windows come from one helper: a new instance of the app, started by LaunchServices
   (`NSWorkspace.openApplication`, a new instance, not activated) with `--render`, `BANEYSPACES_RENDER_MOVE_FREE=1`
   and `BANEYSPACES_PROBE_AREA="x y w h"`. Not as the app's own child: macOS answers the app's Accessibility asks of
   a process it started itself with "API disabled" (`-25211`, measured 2026-11-26), so a child's windows never reach
   tiling. Its windows are titled, closable and resizable, at level 0, alpha 0.01, with no shadow, taking no click,
   in an accessory app that never activates (`orderFrontRegardless`, never `makeKey`). Each frame is inside the probe
   area from the window's creation. It talks a line at a time over two named pipes, `BANEYSPACES_PROBE_IN` and
   `BANEYSPACES_PROBE_OUT`, that the app opens before starting it: `ready` first, then `open` opens a window and
   answers `open <window number>`, `close <i>` closes the i-th opened, `quit` quits. It quits too when the process
   in `BANEYSPACES_PROBE_OWNER` exits. The first step waits until the helper said `ready` and LaunchServices gave its
   pid. Without `BANEYSPACES_PROBE_AREA` the helper is the render harness's as before, on its standard input and output.
7. A new window of a helper's pid joins the agent workspace in the scan that finds it, before any look
   (`TilingProbe.homes`): never the current workspace, never another, and no claim, rule or parked-app adoption
   moves it, and a switch neither hides the helper nor parks its windows (`TilingProbe.switchOwners`): they stay in
   the probe area. The helper is scanned while the probe runs,
   though it is not a regular app.
8. The probe drives tiling through the same engine and look a key uses (`Tiling.runProbe`), on the agent workspace,
   with a probe window as the one in front and `pressed` the uptime the probe asked. A focus moves the engine's
   focus alone: never `spaces.focus`, never an app activation. Only focus, move and resize in four directions run;
   any other command, and an outcome that would cross a display or turn tiling on or off, does nothing.
9. A probe ends when it is done; at its deadline (a timer in the app, at most 300 s); when the caller's process exits
   (a pid already gone at the start is `bad_request`); when Polycarp stops placing windows; when the agent workspace
   changes, turns off or comes into sight on a display (a start while it is in sight is `probe_off`).
   Every end sends the helper `quit`, closes the pipes, stops a helper still running 1 s later, turns the
   probe flag off, drops the agent workspace's layout from the engine and writes one trace line
   `probe end why=<done|deadline|caller|inactive|workspace|error>`. Its state is in memory only. On its first window a probe also writes
   `probe ax pid=<helper> trusted=<bool> main=<error/windows> background=<error/windows>`: how the helper answers
   Polycarp's Accessibility ask on the main thread and on a background queue.
10. The probe never touches the current workspace, the focus, a display or any app but its helper, so it needs no
    idle wait.
11. Each round opens 3 windows one at a time (3 `new` samples, each waiting for its window to land), presses 4 move,
    4 focus and 4 resize keys, closes 2 windows one at a time (2 `close` samples, each must fill) and closes the last
    (no sample). A sample is the result the action would write to timing.log (R-TS1 `tile=`, R-TS10 `close`),
    heard in the app (`Tiling.probeHook`): `asked` of a `tile=` line, `fill` of a `close` line. The probe's own
    results stay out of timing.log, so `scripts/speed-report.sh` judges real use alone. One with no landing in 2 s
    is a miss. A key with nothing to do (at an edge) writes no line and is no sample.
12. The result has, for each of `key focus`, `key move`, `key resize`, `new` and `close`: n, p50, p90 and max in ms
    over the samples that landed, the misses, and the most frames any one window got. Percentiles are nearest rank,
    as `scripts/speed-report.sh` takes them. Exit 0 when every sample landed, 1 on a miss or an early end, 2 on a
    refusal. `--json` prints the result's JSON.
13. The agent workspace never tiles outside a probe.

### R-TS13 A new window not drawn yet is waited for while its note is pending
Donovan's timing.log, 2026-11-26: four `tile=new` lines from 725 to 2865 ms, three of them answered by the look of a
close or a switch that came later. The window was in the model; the looks after its scan wrote nothing for it, and
`waitForLate` stopped looking after 4 looks, about 0.3 s. When the app drew the window later, nothing looked again.

1. A window that is not drawn yet on a workspace in sight is looked at again 0.1 s later (`lookSoon`), for 4 looks
   (`TileCauses.lateLooks`). While a `new` cause of its app is pending (R-TS2, younger than `TileCauses.keep`), the
   count does not end the wait (`TileCauses.keepsWaiting`). The wait ends when the window is drawn and tiled, or the
   cause is answered or expires. No look waits sooner than `lookSoon` paces it.
2. Each look that writes no frame for a window of an app whose `new` cause is pending, and that the app didn't have
   when the cause came, writes one trace.log line when the reason changes:

       tile new skip id=<id> pid=<pid> why=<not-in-model|not-on-screen|wait-ended|silent|out-of-sight|not-planned>

   `not-in-model` is an app with no such window in the model yet, with `id=-`. `out-of-sight`: its workspace isn't
   shown, or it is parked or minimized. `silent`: its app didn't answer and is asked later. `not-on-screen`: not drawn,
   still waited for. `wait-ended`: not drawn, no longer waited for. `not-planned`: the plan asked nothing of it
   (`TilingRead.skipped`). Nothing else is written.
3. Waiting writes no frame: R-TS9 holds.

## Measuring

- In real use: the `tile=` lines in timing.log, read by `scripts/speed-report.sh`.
- In the running app, with nothing on screen: `polycarp-spaces agent probe [--rounds N] [--json]` (R-TS12) tiles the
  agent workspace off screen with windows of its own and prints each kind's n, p50, p90, max, misses and writes. It
  needs an agent workspace and no idle wait.

## Cases

Each row is a test; the test names it.

| # | Rule | Input | Expected |
| --- | --- | --- | --- |
| 1 | R-TS1 | a key cause at uptime 10.000; plan at 10.004, asked at 10.021, landed at 10.140, 3 moves; epoch 1795726000 | `1795726000 tile=key looked=4 asked=21 landed=140 moves=3` |
| 2 | R-TS1 | the same, superseded before its settle | `... landed=- moves=3` |
| 3 | R-TS1 | a key that only focuses, asked at 10.006 | `... asked=6 landed=- moves=0` |
| 4 | R-TS2 | a `new` cause for pid 7 at 10.0; a look at 12.9 writes a window of pid 7 the engine never had | the look answers it |
| 5 | R-TS2 | the same look at 13.1 | dropped, no line |
| 6 | R-TS2 | a `new` cause for pid 7; a look writes only windows of pid 8 the engine had | not answered; still pending |
| 7 | R-TS2 | a `close` cause on workspace 2; a look writes on workspace 2 | answered |
| 8 | R-TS2 | a `close` cause on workspace 2; a look writes only on workspace 3 | still pending |
| 9 | R-TS2 | a `switch` cause; a look 1.2 s later writes | dropped, no line |
| 10 | R-TS2 | a `new` and a `close` cause both answered by one look | two lines |
| 11 | R-TS3 | a timing.log with 3 `tile=key ... asked=N` lines | speed-report counts them under `tile-key` |
| 12 | R-TS3 | the app's code | every `tile=` cause has a budget (`SpeedBudgetTests`) |
| 13 | R-TS4 | write started, a look asked, write returned | the look runs at the write's return |
| 14 | R-TS4 | write returned, settle running, a look asked | the look runs now |
| 15 | R-TS4 | question running, a look asked | the look runs at the question's return |
| 16 | R-TS4 | settle A wrote window 1; settle B later wrote window 1 too; A reports | A reports no frame for window 1 |
| 17 | R-TS5 | window 1 asked for target T, in flight; a plan wants T | no move, tries unchanged |
| 18 | R-TS5 | window 1 in flight to T; a plan wants U | a move to U |
| 19 | R-TS5 | window 1 in flight to T; it lands | a plan that wants T with the window elsewhere asks again |
| 20 | R-TS5 | window 1 in flight to T, touched | a plan that wants T asks again |
| 21 | R-TS6 | `kAXWindowCreated` from pid 7 | a scan asking pid 7 starts at once |
| 22 | R-TS6 | `kAXUIElementDestroyed` from a window of pid 7 | a scan asking pid 7 starts at once |
| 23 | R-TS7 | `BANEYSPACES_RENDER_TILE_TIMING=20 Polycarp --render <dir>` | exit 0; prints `a move key`, `a drag` and `a close` lines |
| 24 | R-TS8 | `kAXUIElementDestroyed` for a tiled window the window server still lists | the window leaves the model and the layout at once; the look that follows plans its neighbours |
| 25 | R-TS8 | the same from ⌘W or a tab merge (the same note) | the same as 24 |
| 26 | R-TS8 | an app that isn't in front quits | its windows leave at once; the neighbours fill |
| 27 | R-TS8 | `kAXWindowMiniaturized` for a tiled window | it leaves the layout at once |
| 28 | R-TS8 | a window moved to another workspace | its old workspace looks at once, not in 20 ms |
| 29 | R-TS8 | a sheet or panel closes | no window leaves, nothing is written |
| 30 | R-TS8 | a destroyed window its app lists again at the next scan | back on its workspace, tiled again |
| 31 | R-TS9 | (92,40 744x934) to (8,40 1496x934) on a display 1512 wide | position, then size; between, (8,40 744x934) |
| 32 | R-TS9 | (8,40 744x934) to (760,40 744x934) | the position alone |
| 33 | R-TS9 | (8,40 744x934) to (8,40 1496x934) | the size alone |
| 34 | R-TS9 | (8,40 1496x934) to (760,40 744x934) | size, then position; between, (8,40 744x934) |
| 35 | R-TS9 | (700,600 800x300) to (750,40 760x985), display (0,40 1512x985): moved first runs off the right, sized first runs off the bottom | size, position, size |
| 36 | R-TS9 | three tiled windows, the middle one leaves | one move for each of the two left; none in the next plan while they fly or once they landed |
| 37 | R-TS10 | a close at 10.000; writes of windows 1 and 2 return at 10.010, window 1 again at 10.030; 0.5 s quiet | `close fill=30 writes=2 windows=2 how=destroyed` |
| 38 | R-TS10 | a close with no write in 3 s | `close fill=- writes=0 windows=0 how=destroyed` |
| 39 | R-TS10 | a move key at 10.000, two windows written once, back at 10.012 | `move fill=12 writes=1 windows=2 how=key` |
| 40 | R-TS10 | a close of the last tiled window on its workspace | no line |
| 41 | R-TS11 | the app's code | `close-fill` and `move-fill` have budgets (`SpeedBudgetTests`) |
| 42 | R-TS12.13 | options with agentWorkspace 9, no probe | `tiles(9)` false |
| 43 | R-TS12.3 | same, probe on | `tiles(9)` true; `tiles(3)` unchanged from settings |
| 44 | R-TS12.3 | probe on, then the options rebuilt as readSettings does | probe still on after the reload; options built fresh have it off |
| 45 | R-TS12.3 | `tile on 9` or toggle 9 during a probe | refused "the agent workspace never tiles"; the options unchanged, so surfaces.json is untouched |
| 46 | R-TS12.4 | screens [(0,0,1512,982)], usable (0,40,1512,934) | area (-3512, 40, 1512, 934); isStranded true |
| 47 | R-TS12.4 | screens [(-1920,0,1920,1080),(0,0,1512,982)], usable (0,40,1512,934) | area maxX = -3920; isStranded true |
| 48 | R-TS12.2 | start with seconds 900 / 0 / missing | bad_request / bad_request / 180 |
| 49 | R-TS12.2 | start with rounds 0 / 11 / missing | bad_request / bad_request / 3 |
| 50 | R-TS12.2 | start with no agent workspace | `agent_workspace_off` |
| 51 | R-TS12.2 | start while one runs | `probe_busy` |
| 52 | R-TS12.9 | session: start; caller exits | ended, why `caller` |
| 53 | R-TS12.9 | session: start; deadline passes | ended, why `deadline` |
| 54 | R-TS12.9 | session: start; agent workspace set to another number | ended, why `workspace` |
| 55 | R-TS12.9 | any end | probe flag off; `tiles(agent)` false |
| 56 | R-TS12.7 | a new window of a probe pid while current is 2 and agent is 9 | assigned to 9 |
| 57 | R-TS12.7 | a new window of another pid | the usual path (not 9) |
| 58 | R-TS12.8 | probe `focus right` on 3 probe windows | the engine's focus moves; the step has no app focus in it |
| 59 | R-TS12.8 | probe asks `toggle` or `scratchpad` | refused |
| 60 | R-TS12.12 | samples [10, 20, 30, 40, 1000] | p50 30, p90 1000, max 1000 |
| 61 | R-TS12.12 | one miss among 5 | misses 1, exit code 1 |
| 62 | R-TS12.7 | a switch hides window 1 (app 40) and windows 5, 6 of probe helper 77 | helper 77 not hidden, 5 and 6 not parked; app 40 hidden |
| 63 | R-TS12.9 | start while a display shows agent workspace 9; a running probe when it comes into sight | `probe_off`; ended, why `workspace` |
| 64 | R-TS2 | a `switch` to 3 at 10.0; a look writes on 2, then one on 3 | the first answers nothing; the second answers it |
| 65 | R-TS2 | a `switch` to 2 at 10.0, then one to 3 at 10.4; a look writes on 3 | only the switch to 3 answered; none pending |
| 66 | R-TS2 | a `switch` to 3 and a `close` on 3; a look with 3 in sight writes nothing; a later look writes on 3 | the switch leaves with no line; the later look answers the close alone |
| 67 | R-TS2 | a `switch` to 3; a look with only 1 in sight writes nothing | the switch stays; the next look writing on 3 answers it |
| 68 | R-TS13.1 | a window not drawn at look 5; its app's `new` cause 1 s old | still waited for |
| 69 | R-TS13.1 | the same at 3.1 s | the wait ends |
| 70 | R-TS13.1 | no pending `new` cause of its app (none, another app's, a close) | waited for at look 3, not at look 4 |
| 71 | R-TS13.1 | its app's `new` cause answered | the wait ends at look 5 |
| 72 | R-TS13.2 | a skipped new window: on workspace 2, parked, silent, unanswered, undrawn and waited for, undrawn and not, drawn | `out-of-sight`, `out-of-sight`, `silent`, `silent`, `not-on-screen`, `wait-ended`, `not-planned` |
Cases 21, 22 and 24 to 30 have no safe pure test: they are wiring tests that read `Spaces.swift`, plus the probe live.
