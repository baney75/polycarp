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
  full-screen app is up on a display, that display's bar hides and its place stays kept. The shell sends
  `ABN_FULLSCREENAPP` to each bar for its own display, so only the bar told hides or comes back: with a full-screen
  app on each display, quitting one leaves the other display's bar hidden. Turning
  it off, the daemon stopping, a panic and the session ending each take every bar off the shell's list, so the work
  area is whole again. A daemon killed outright (`taskkill /F`) runs no cleanup, and the shell drops the bar with its
  window: on the CI runner the work area was whole again within 3 s (the live suite logs it after each run).
- The bar never takes the front: a click on it leaves your window in front.

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

## Not yet

On Windows: the status icons (the tray), the dock and the launcher. Until the tray comes the right end holds only the
mark, and the mark opens no menu.

## Read back

`baneyspaces state` has `bar`: `enabled`, the `font` and `theme` drawn, the `clock` text, and each bar's `monitor`,
`rect` (screen pixels), `dpi`, `height`, `hidden` and number `cells` (`n`, and `x` and `w` from the bar's left). The
Windows live suite (`platforms/windows/tests/ci/live.ps1`, section 9) turns the bar on, checks each bar's rect and the
work area against it, maximizes a window and checks that it stops at the bar, clicks a number, turns the bar off and
checks the work area is whole again.
