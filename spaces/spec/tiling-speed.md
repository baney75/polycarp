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
none of its tries. A plan that wants another target asks at once. The settle ends the flight, and so does a window
being touched (a press, a drag) or 1 s passing.

### R-TS6 Windows reach tiling through the apps' own notifications
Spaces watches each app it scans for `kAXWindowCreated`, `kAXFocusedWindowChanged` and `kAXMainWindowChanged`, and
each of its windows for `kAXUIElementDestroyed`, `kAXWindowMiniaturized` and `kAXWindowDeminiaturized`. Each such note
starts a scan of that app at once (`refresh(asking: [pid])`), and its answer reaches tiling through `onChange` as
before. The window server's list and the retry timers stay as the backstop, not the path.

### R-TS7 Nothing regresses
`swift test` passes. `BANEYSPACES_RENDER_TILE_TIMING` exits 0: every helper window on its tile, nothing written at
rest. No window ends off its tile: the `TilingEngine`, `TilingRequest` and `Tiling*` tests pass unchanged unless a
rule here changes them.

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

Cases 21 and 22 have no safe pure test: they are a wiring test that reads `Spaces.swift`, plus the probe live.
