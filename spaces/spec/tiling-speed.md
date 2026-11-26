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
- `switch`: the first look after a switch ended, within 1 s of it being asked for, that writes a frame.
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
rest. No window ends off its tile: the `TilingEngine`, `TilingRequest` and `Tiling*` tests pass unchanged unless a
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

Two windows are the exception. A closed window whose app has another window on that workspace the window server
doesn't draw may be a native tab, whose hidden sibling takes its tile (`TilingEngine` swaps it in); filling first would
move the others twice, so the scan decides, as before. A minimized window stays in the model, out of the layout from
its note for 2 s while the animation still draws it, then by the scan's own reading; brought back, it is tiled again.

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

## Measuring

- In real use: the `tile=` lines in timing.log, read by `scripts/speed-report.sh`.
- End to end, outside Polycarp: `swift scripts/tile-probe.swift <empty tiling workspace>` opens and closes TextEdit
  and Finder windows and presses the tiling keys there, timing from its own Accessibility notifications and key events
  to the frames it reads back. It takes the keyboard, so it runs only after 10 minutes with no input, switches to the
  workspace given and back.

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
| 23 | R-TS7 | `BANEYSPACES_RENDER_TILE_TIMING=20 Polycarp --render <dir>` | exit 0 |
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
Cases 21, 22 and 24 to 30 have no safe pure test: they are wiring tests that read `Spaces.swift`, plus the probe live.
