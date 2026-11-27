# The top bar

Polycarp's top bar: a thin strip across the top of each display that shows the workspaces and the time. macOS draws
it from `surfaces.json` (`docs/surfaces.md`, with modules you can move); Windows draws a fixed first set of them. The
shared rules are `crates/baneyspaces-core/src/bar.rs`, and macOS has the same ones in `BarLayout` and `BarText`.

## The switch

| Key | Values | Default |
| --- | --- | --- |
| `bar.enabled` | `true`, `false` | `false` on every platform: the bar is off until you turn it on |

macOS: `polycarp-spaces surfaces set bar.enabled true`. Windows: `baneyspaces set bar.enabled true`, stored in
`settings.json` with the other shared settings. Either way it applies at once, with no restart. An agent may set it, as
it may the appearance settings, and the `set` is logged with who asked.

## What it shows

- **Workspaces** (left): every workspace with at least one of your windows, and the one this display shows, in number
  order (`bar::workspaces`, macOS `BarLayout.dots`). A display showing none of the nine adds nothing. An agent's
  windows never count. Click one to go there: the click runs the same switch the workspace key runs, asked from this
  display (`switch n --monitor <this display>`, R-S7 in [workspaces.md](workspaces.md)), so the workspace comes to
  this display or you go to the display that shows it, whichever display you were on before the click.
- **Clock** (center on Windows): the day and the time, `Saturday 22:04`, or `Saturday 10:04` on a 12-hour clock, with
  no AM or PM (`bar::clock`; macOS's `clock` module has the same time). Windows follows its own time format: a pattern
  with an `H` is 24 hours (`bar::clock_is_24h`).
- **Mark** (right on Windows): Polycarp's mark. On Windows it opens nothing yet.

On Windows the current workspace's number is drawn in `foreground` with a 2 px `accent` line under it, the others in
`muted`, on one solid `background`.

## Size and place

- Height: 26 px at 100% (96 dpi), scaled to the display's own scale and rounded (`bar::height_px`): 33 at 125%, 39 at
  150%. macOS sets its own in points (`bar.height`, 28 by default).
- Windows: one AppBar (`SHAppBarMessage`) docked to the top of every display, so the work area starts below it and a
  maximized window stops at its bottom edge. It follows display changes, scale changes (per-monitor DPI v2), the
  taskbar or another AppBar moving (`ABN_POSCHANGED`) and explorer.exe restarting (`TaskbarCreated`). While a
  full-screen app is up on a display, that display's bar hides and its place stays kept. A display has one when the
  frontmost window that reaches onto it (visible, not minimized or cloaked, not a tool or click-through window, not a
  bar or the shell's desktop or taskbar) covers the display's whole rect (`bar::full_screen_on`). An always-on-top
  window (`WS_EX_TOPMOST`) that does not cover the display, such as a picture-in-picture video, a meeting's mini window
  or a pinned note, is passed over: it floats in front of a full-screen video without bringing the bar back. Any other
  window in front of it does. The shell's `ABN_FULLSCREENAPP` only says when to look: which bars it is sent to is not
  relied on, so on every one each bar is decided again from its own display's windows (`bar::full_screen_bars`). With
  a full-screen app on each display, quitting one leaves the other display's bar hidden. Turning it off, the daemon stopping, a panic and the session ending each take every bar off the shell's list, so the work
  area is whole again. A daemon killed outright (`taskkill /F`) runs no cleanup, and the shell drops the bar with its
  window: on the CI runner the work area was whole again within 3 s (the live suite logs it after each run).
- The bar never takes the front: a click on it leaves your window in front.
- macOS: every icon sits in one slot (27 pt), and what is under the pointer gets one face, in the theme's corners, with
  a small press on a click (none under Reduce Motion). The whole height of the bar takes the click. The middle's modules
  take the width they need up to 44% and the sides get the rest; on a screen with a notch they sit on the camera's right
  (`BarGeometry`, `BarSides`). Windows: not yet.
- macOS: the marker at the workspace you're on slides when you switch, and the wheel over the numbers goes to the
  one before or after that no other display shows, one a trackpad gesture or wheel click (clicks within 0.14 s count as
  one) and none while a trackpad glides (`BarScroll`). Windows: not yet.
- macOS: two or more apps' status items fold behind a chevron that opens under the pointer, and stays open on a click
  (`bar.tray`; `BarTray`). Windows has no tray yet.
- macOS: the clock and the date open a calendar under the bar: today, then one month in six weeks from the calendar's
  first day of the week (`MonthGrid`). It goes as the bell's list does (`BarPanel`). Windows has none yet.
- macOS: `agents` counts the coding agents that need you (`Attention`, what ⌘⇧U steps through) and the ones at work
  (`BarAgents`); with neither it isn't drawn. Its list goes to the one you choose. Windows has none yet.

## Colors and type

The bar takes four roles from the Polycarp theme in force (`themes.md`, "Polycarp themes"): `background`,
`foreground`, `muted` and `accent` from `surfaces.spaces`, in the theme's `mode` (`auto` follows the system's light or
dark app mode). Windows reads `<config>\current\theme.json` (`POLYCARP_CONFIG_DIR` when set and absolute, else
`%APPDATA%\Polycarp`): a regular file of at most 256 KB, `schema` 1, those four as `#rrggbb`, and `foreground` and
`muted` on `background` at 4.5:1 at least (`bar::theme_colors`). Anything else draws the built-in dark look (near-black
`#121212`, white, a gray `#9a9a9a` and the system accent) and logs one line in the daemon's log, `bar: polycarp theme:
ignored <file>: <why>`, once until the reason changes. A missing file logs nothing.

Windows looks again every second at the file's size and time, the app mode, the time format and the accent, and the
next frame shows a change. One look a second covers the registry and locale settings, which have no file to watch.

Type is monospace: Cascadia Mono, else Consolas, 13 px at 100%.

## The battery (macOS)

Measures and rules are `BatteryGlyphSpec` and `BarStatus.batteryLook`; `BatteryGlyphTests` holds the case table. Windows
has no battery yet.

- **R-BB1 Shape.** macOS's own menu bar battery: a 23 by 11 pt body with a 1 pt outline and continuous 3 pt corners, a
  1.5 by 4 pt nub centered on its right, and the fill inset 1.5 pt with corners that follow the outline. A charge above
  zero fills at least 1.5 pt.
- **R-BB2 Fill.** The bar's ink at full opacity. While charging it stays ink, Low Power Mode included. Otherwise Low
  Power Mode fills in the theme's `working`, and 10% or below on battery in `urgent`. No battery (a desktop Mac): it
  isn't drawn.
- **R-BB3 Badge.** A bolt while charging, a plug on power when not charging: SF Symbols at 7 pt centered on the body
  on whole pixels, cut out of the fill where they lie on it and in ink on the empty body, with no ring round them.
- **R-BB4 Contrast.** The outline's opacity of the ink is 38%, or the least above that which reaches 3:1 against the
  theme's `background` and `surface` in that mode. The badge and both fill tints reach 3:1 in every theme in `themes/`.
- **R-BB5 Percent.** `bar.batteryPercent` (off by default) puts the charge in digits before the glyph, in the bar's
  type with monospaced digits.

## Moving modules (macOS)

The person moves the bar's modules with the mouse; Windows draws a fixed set and has none of this yet. The rules are
`BarArrange` (`Sources/BaneySpacesCore/BarArrange.swift`), pinned by `BarArrangeTests`.

- **R-BA1 The gesture.** ⌘ held with a press on any module starts moving it at once, as in the macOS menu bar. Arrange
  mode (the bar's right-click menu, "Arrange Bar Items…") does the same with a plain drag; there a click runs no module,
  and Escape, Done, a click outside the bar or 60 seconds with no drag ends it.
- **R-BA2 Slots.** A module goes before or after any module in any of the three rows, or into an empty row. The island
  split `|` moves like any module. A slot is the gap counted in the row's list before the move (0 first, `count` the end);
  the gap just before or after the module is its own place, and so is any gap that looks the same (between the drawn
  modules either side of it, past ones that draw nothing).
- **R-BA3 The notch.** On a notched display the center row stays where it is drawn, and no slot under the notch is
  offered: a drop there changes nothing. Nor is a row style.css hides, or one where it hides the module being
  moved, since the module would draw nowhere. Between two islands a drop goes to the nearer one.
- **R-BA4 One write, nothing lost.** A drop writes `bar.modules` (all three lists) to surfaces.json in one write, and
  every bar on every display redraws from it. The three lists hold the same modules before and after; modules that draw
  nothing (custom ones, a battery on a desktop Mac) keep their place beside their neighbours.
- **R-BA5 No change.** A drop outside the bar, Escape mid-drag, or a drop on the module's own place writes nothing.
  "Undo Move" in the bar's right-click menu, or ⌘Z in arrange mode, puts back the lists from before the last move until
  the next move or a quit.
- **R-BA6 VoiceOver.** Each module has the actions Move Left, Move Right (past the next module that draws, into the next
  row at an edge), Move to Left Section, Move to Center and Move to Right Section (the end of that row nearest the
  module), each the same move as a drop: a row that takes no drop of the module takes no step either.

| Lists (left / center / right) | Move | Result |
| --- | --- | --- |
| mark,workspaces / clock / status,\|,notifications | clock to right, 0 | mark,workspaces / (empty) / clock,status,\|,notifications |
| same | workspaces to left, 0 | workspaces,mark / clock / status,\|,notifications |
| same | clock to center, 0 (own place) | unchanged, no write |
| same | `\|` to left, end | mark,workspaces,\| / clock / status,notifications |
| mark / (empty) / status | status to center, 0 | mark / status / (empty) |
| any | from a place out of range | unchanged |
| x past the last module of right | slot | right, end |
| x under the notch | slot | none |
| x in an empty center's placeholder | slot | center, 0 |

## Not yet

On Windows: the status icons (the tray), the dock and the launcher. Until the tray comes the right end holds only the
mark, and the mark opens no menu.

## Read back

`baneyspaces state` has `bar`: `enabled`, the `font` and `theme` drawn, the `clock` text, and each bar's `monitor`,
`rect` (screen pixels), `dpi`, `height`, `hidden` and number `cells` (`n`, and `x` and `w` from the bar's left). The
Windows live suite (`platforms/windows/tests/ci/live.ps1`, section 9) turns the bar on, checks each bar's rect and the
work area against it, maximizes a window and checks that it stops at the bar, clicks a number, turns the bar off and
checks the work area is whole again.
