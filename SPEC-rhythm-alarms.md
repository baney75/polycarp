# Spec: alarms in the rhythm (wake alarm and the one-thing timer)

Worktree: ~/Projects/_work/polycarp-alarms (branch feat/rhythm-alarms), work in `spaces/`. Don't commit this file.
Read the repo's AGENTS.md / CLAUDE.md first. No em or en dashes anywhere (code comments, docs, strings).

Donovan picked "Alarms into the rhythm": the wake alarm opens the morning question, and timers belong to the one
thing. (Reminders per workspace come later, with the Reminders permission; not in this change.)

## 1. surfaces.json: a new `alarm` section

Add to `Surfaces` (Sources/BaneySpacesCore/Surfaces.swift) the way `idle` is done: a struct, a section line in the
sections list ("The wake alarm and the one-thing timer."), `SurfaceField`s, parse, defaults, schema (it comes from
`SurfaceField.all`), and `docs/surfaces.md` (a `### alarm` table plus one paragraph, like `idle`).

| Path | Type | Default | Meaning |
| --- | --- | --- | --- |
| `alarm.wake` | `.bool` | `false` | Ring at `alarm.wakeAt`. Off until you turn it on. |
| `alarm.wakeAt` | time `"HH:MM"` 24 hour | `"06:30"` | When. Add a `.time` field kind if none exists (validate 00:00 to 23:59). |
| `alarm.days` | choice `every`, `weekdays`, `not-sunday` | `"every"` | Which days ring: all, Monday to Friday, or all but Sunday. |
| `alarm.keepAwake` | `.bool` | `true` | On power, hold the Mac awake for the last hour before the alarm so it can ring. |
| `alarm.timerMinutes` | int 1 to 240 | `25` | The one-thing timer's default length. |

Use whatever field kinds exist (look at how `startAfterMinutes` is an int range). SurfacesTests: defaults, a full
set of values round trips, bad values refused (`"25:00"`, `"6:3"`, `0`, `241`).

## 2. The pure rules (BaneySpacesCore, new `Purpose/Alarm.swift`, `enum Alarm`)

- `nextRing(after: Date, settings: Surfaces.Alarm, clock: DayClock/Calendar, timeZone) -> Date?`: the next wake time
  strictly after the date that the `days` rule allows; nil when `wake` is off.
- `shouldHoldAwake(now:, next:, onPower:, settings:) -> Bool`: `keepAwake && onPower && next - now in (0, 3600]`.
- Ringing: when the ring time comes the app rings, then rings again each minute up to 5 rings in all, and stops at
  the first input. Model it as `Alarm.Ringing` (started at, rings so far) with
  `step(now:, inputSince: Bool) -> (ring: Bool, done: Bool)` so tests pin the 5-ring cap and the stop on input.
- The timer: `OneThingTimer` (Codable, `startedAt`, `minutes`, `oneThing: String?`), `remaining(now:) -> TimeInterval`
  (never below 0), `done(now:)`, and `BarText.timer(remaining:) -> String` ("24 min", "1 min", then "0:42" under a
  minute; no dashes).

## 3. The app

- **Wake alarm** (new `Sources/BaneySpaces/WakeAlarm.swift`, started in AppDelegate near `IdleCover.shared.start()`):
  a timer that re-arms from `Alarm.nextRing` on start, on `SurfacesStore.didChange`, on wake from sleep and on
  `NSSystemTimeZoneDidChange`. When it fires:
  1. `IOPMAssertionDeclareUserActivity` to light the display.
  2. If `IdleCover` is up, hide it.
  3. Play the ring: `NSSound(named: "Glass")` (a system sound, nothing bundled), repeated per `Alarm.Ringing`;
     input (`PurposeKeeper.idleSeconds()` going down, like `IdleScreen.inputSince`) stops it.
  4. Show the morning card: `RhythmSheet.shared.show(.morningQuestion)` if the morning question hasn't been given
     today (`PurposeKeeper.shared.rhythm` / `Rhythm`); otherwise nothing more.
  - Keep-awake: while `Alarm.shouldHoldAwake` is true, hold `kIOPMAssertPreventUserIdleSystemSleep` (named
    "Polycarp wake alarm") and release it after the ring or when false. Read on-power with
    `IOPSGetProvidingPowerSourceType` (or whatever BarText's battery code already uses).
  - Trace one line per arm and per ring. Never write the macOS menu bar setting or any system setting.
- **One-thing timer**:
  - `PurposeKeeper` holds `timer: OneThingTimer?`, saved in UserDefaults ("oneThingTimer") so a relaunch keeps it,
    posts a notification when it starts, stops or ends.
  - At the end: `NSSound(named: "Glass")` once and a user notification if the app already posts notifications
    elsewhere (search; if not, skip the notification, don't add the permission).
  - The menu (Now-first menu, `MenuLayout`/`MenuEntry` in AppDelegate): under "Set the one thing…", a row
    "Start a timer (25 min)" using `alarm.timerMinutes`, which becomes "Stop the timer (12 min left)" while running.
    Keep `MenuLayout` pure and tested like the existing entries.
  - The bar's `.oneThing` module (TopBar.swift ~line 284): when a timer runs, show the remaining time after the one
    thing in the same font, muted (`Chrome.wash(0.85)`), monospaced digits, refreshed with the bar's clock.
  - CLI: `polycarp-spaces timer [minutes] | timer stop | timer status [--json]` over the socket, following how
    `purpose`/`one` go through `PurposeAPI` (add the ops to that API and its tests rather than a new Wire op if it fits).
  - The timer runs whether or not a one thing is set; it records the one thing's text at start.

## Tests

New `AlarmTests.swift`: nextRing across midnight, weekdays (Fri evening to Mon), Sunday skip, DST spring-forward
day in America/Chicago (06:30 still rings once), off returns nil; shouldHoldAwake edges (3600 s yes, 3601 no, on
battery no); Ringing caps at 5 and stops on input; timer remaining and done; BarText.timer strings. Menu entries
for the timer row. PurposeAPI timer ops. Also add the new SurfaceFields to whatever conformance or schema tests list
fields.

## Docs and CHANGELOG

`docs/surfaces.md` (alarm section), `docs/rhythm.md` or wherever the rhythm is documented (search), the CLI usage
text. A CHANGELOG entry at the top of `## Unreleased` in the existing style, ending "Untested live. Windows and
Linux: not yet."

## Done check

```
cd ~/Projects/_work/polycarp-alarms/spaces && POLYCARP_TERMINAL=0 swift build --build-tests && swift test --skip-build
```

Everything passes except possibly the known timing tests (PhotoDecodeSpeedTests, DockOpenSpeedTests) under load;
rerun those alone and report both. Commit on feat/rhythm-alarms with a plain message ending in
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; don't push. Report the files changed, the test counts,
and every place you departed from this spec and why.
