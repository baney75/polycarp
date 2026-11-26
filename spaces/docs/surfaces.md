# Surfaces: one file for every Polycarp surface

`surfaces.json` says how each Polycarp surface looks and behaves: the top bar, the desktop scene and its verse, the
status menu, the browser's new tab page and the idle screen. Agents and the owner edit it with `polycarp-spaces surfaces`, or over MCP with `polycarp mcp`. A running Polycarp picks up a change within 150 ms;
nothing restarts.

Colors, fonts and the theme's wallpaper stay in the theme (`polycarp theme`, `themes/*.toml`). This file says what each
surface shows; the theme says what it looks like. To restyle the bar or a panel past the theme (a glass bar, a
square launcher), use the style sheet: [style.md](style.md). `polycarp look` saves, shares and applies these settings' looks with
the theme, the sheet and the paper: [looks.md](../../docs/looks.md) lists which fields.

The Workspace Dock was removed on 2026-11-23. Workspaces are on ⌘1 to ⌘9 and the top bar's numbers; the overview is on
the Mission Control key, the hot corner and the status menu; apps running with no window are in the launcher (⌃⌘K)
under "Running, no window". A file that still has a `dock` section, or `dock` in `menu.order` or `menu.hidden`, reads
with a warning and the rest applies; `surfaces set dock.*` is refused.

- File: `~/Library/Application Support/Polycarp/surfaces.json`
- Every field is optional. A missing field, or no file at all, takes the default below.
- A path is the keys joined with dots: `bar.height`, `bar.modules.left`, `desktop.scene`.
- `polycarp-spaces surfaces schema` prints the JSON Schema (draft 2020-12) with every field, its default and its rules.
- To change the wallpaper, use `polycarp-spaces paper` ([Paper](#paper-the-desktop-the-new-tab-and-the-idle-screen-in-one-command)): it takes a picture, a URL, a color or a scene and writes the `paper` fields for you.

## Commands

```sh
polycarp-spaces surfaces get [path] [--json]              # the value in force: the file over the defaults
polycarp-spaces surfaces set <path> <json-value> [--json] # checked, then written whole
polycarp-spaces surfaces reset [path] [--json]            # one path back to its default, or the whole file
polycarp-spaces surfaces schema [--json]                  # the JSON Schema
polycarp-spaces surfaces validate [file] [--json]         # every error with its path (default: the file in use)
```

`polycarp spaces surfaces ...` runs the same command. `baneyspaces` is an older name for `polycarp-spaces`.

`set` takes a JSON value: `30`, `true`, `"glass"`, `["mark","clock"]`, `{"height":30}`. A value that isn't JSON is
taken as a string, so `set bar.style glass` works too. `set` checks the whole file with the change in it and writes
nothing when it fails; otherwise it writes a temp file beside the target and renames it in, so the app never reads half
a file. Setting a group (`bar`, `bar.modules`) replaces that group with the object you give.

Exit codes: 0 done, 1 refused (an invalid value, an unknown path, a file that can't be read), 2 the command was used
wrong.

### `--json`

Every subcommand with `--json` prints one envelope, the same shape `polycarp theme --json` uses:

```json
{"ok": true, "data": {"path": "bar.height", "value": 30, "file": "~/Library/Application Support/Polycarp/surfaces.json"}}
```

```json
{"ok": false, "error": {"code": "invalid_value", "message": "bar.height: must be from 22 to 40, not 99",
  "suggestion": "run `surfaces schema` for what bar.height takes",
  "data": {"errors": [{"path": "bar.height", "message": "must be from 22 to 40, not 99"}]}}}
```

- `get`: `data` is `{path, value, set, file}`. `set` is true when the file itself holds the path.
- `set`: `{path, value, file}`, plus `warnings` when the file holds keys this build doesn't know.
- `reset`: `{path, value, file}`; `value` is the default now in force.
- `schema`: `data` is the schema.
- `validate`: `{file, valid: true, warnings}`, or an error with code `invalid_surfaces` and every error in
  `error.data.errors`.

Error codes: `invalid_value` (the value fails its check), `unknown_path` (no such field; `suggestion` names the nearest),
`invalid_file` (the file isn't JSON, or still has errors), `invalid_surfaces` (from `validate`), `io_error`,
`invalid_args`.

## Rules an agent should know

- **Errors carry the JSON path.** A list item has its index: `bar.modules.left[2]`. The whole file is `$`.
- **An invalid file never takes effect.** The app keeps its last good config (the defaults, at launch) and writes one
  line to `trace.log`: `surfaces: ignored ~/.../surfaces.json: <path>: <why>; keeping the last good config`. A file that
  isn't JSON can't be edited by `set` or a one-path `reset`; `surfaces reset` with no path starts it over.
- **Unknown keys are kept.** A key this build doesn't know (a newer Polycarp wrote it) is read past, kept through every
  `set` and `reset`, and listed as a warning. `set` refuses an unknown path, so a typo can't land; `get` and `reset`
  reach a key the file holds even when this build doesn't know it.
- **Unknown values are errors.** A choice not in the list, a number out of range or an id this build doesn't know.
- **A bar module goes in one place.** Each id appears once in the places the file sets. A place the file sets takes
  its modules from the places left at their default: `{"bar":{"modules":{"left":["mark","clock"]}}}` moves `clock`
  out of the default right.
- **`settings` and `quit` can't be hidden** from the status menu.
- `version` is the file's format. This build writes 1, and never lowers a higher one it finds.

## Paper: the desktop, the new tab and the idle screen in one command

The paper is what lies behind a place: the desktop picture, the browser's new tab page and the idle screen. One
command sets it for all three, or for the places you name:

```sh
polycarp-spaces paper set ~/Pictures/sunset.jpg                 # every place
polycarp-spaces paper set https://example.com/sunset.jpg --on desktop
polycarp-spaces paper set "#2B2E26" --on newtab,idle
polycarp-spaces paper set olive                                 # a scene, drawn in the hour's light
polycarp-spaces paper get [--json]                              # each place's paper and where it comes from
polycarp-spaces paper reset [--on desktop,newtab,idle|all]      # back to what each place showed before
```

`<what>` is one of:

- a picture on this Mac: `.png`, `.jpg`, `.heic` or `.webp`, at most 25 MB and at most 16384 pixels on a side and
  100 megapixels (`too_large`, read from its header before any decode). `~/` is your home folder; a relative path
  starts where you run the command.
- an `https://` URL to a picture. It is fetched once, at most 25 MB, and refused unless it decodes as a PNG, JPEG,
  HEIC or WebP picture. Plain `http://` is refused, and so is a host on this Mac or the local network (`localhost`,
  `.local`, loopback, private, link-local and shared addresses, by name or by what it resolves to), before the
  request and on every redirect.
- a color, `#RRGGBB`.
- a scene: `field`, `olive`, `water`, `parchment` (drawn at each display's size, in the hour's light, with the
  desktop's verse), or `solid` (the theme's own picture).

A picture is copied into `Papers/` beside surfaces.json (`~/Library/Application Support/Polycarp/Papers/`) as
`paper-<16 hex digits>.<ext>`, named for its content, so you never follow a naming rule by hand and the same picture
twice is one file. After each `set` and `reset`, pictures no paper names are pruned, keeping the newest 10.

`--on` takes `desktop`, `newtab`, `idle` or `all`, joined with commas; the default is `all`. All three places write
`paper` and clear each place's own. Fewer write only those places' own (`desktop.paper` and the rest). `reset --on
desktop` takes the desktop's paper off and leaves the others showing what they showed.

- **Desktop.** The running app sets it within the same 150 ms pickup as any surfaces change, on every display and
  Space, the way the theme's wallpaper is set: before Polycarp first covers a display's picture it records it and keeps
  a copy, and reset puts it back. A paper wins over the theme's wallpaper and `desktop.scene`, whatever the Settings
  switch "Theme sets the desktop picture" says; reset brings the theme's back while that switch is on. A picture fills
  the screen, cropping what overhangs.
- **New tab.** The page paints it behind the field and the verse, with a soft scrim from the theme's background so
  both stay readable on any picture ([newtab.md](newtab.md#paper)).
- **Idle screen.** It is the background in any style, dimmed like the `field` style.

An unset paper changes nothing: each place looks as it did before paper. A picture that is gone from `Papers/` counts
as unset for that place. `paper set` and `paper reset` print each place's paper as `paper get` does; with `--json` the
envelope's `data` is `{paper, desktop, newtab, idle, file}`, each place `{value, kind, picture, from}` (`value` null
for none, `from` `paper` or the place's own path). Error codes, beyond the surfaces ones: `invalid_paper`,
`not_found`, `not_a_picture`, `too_large`, `fetch_failed`. A file with errors of its own refuses the paper with
`invalid_file` before a picture is fetched or copied in, and a write that fails takes a newly copied picture back out.

## Every field

| Path | Default | Takes |
| --- | --- | --- |
| `paper` | `""` | What lies behind the desktop, the new tab page and the idle screen: `#RRGGBB`, a scene (`field`, `olive`, `water`, `parchment`, `solid`), or `picture:<name>` for a picture in `Papers/` that `polycarp-spaces paper set` made. Empty: every place as before paper. Each place's own `paper` overrides it. |

### `bar`: the top bar that stands in for the macOS menu bar

| Path | Default | Takes |
| --- | --- | --- |
| `bar.enabled` | `false` | `true` or `false`. Show Polycarp's top bar. Off until you turn it on. |
| `bar.height` | `26` | A whole number of points, 22 to 40. |
| `bar.style` | `"islands"` | `islands` (each group of modules floats in its own rounded island over the desktop; `"\|"` in a module list starts a new island; style them with `bar .island` in style.css), `solid` (the theme's background color), `glass` (blurred, see-through) or `hairline` (the desktop shows through, with a thin line under it). |
| `bar.modules.left` | `["mark","workspaces","\|","app-menus"]` | Module ids, in order. `"\|"` starts a new island, as often as you like. |
| `bar.modules.center` | `["clock"]` | Module ids, in order. |
| `bar.modules.right` | `["agents","status","\|","notifications"]` | Module ids, in order. |
| `bar.clockFormat` | `"day-12h"` | `day-12h` (Saturday 10:04 PM), `day-24h` (Saturday 22:04), `12h` (3:05) or `24h` (15:05). |
| `bar.hourNames` | `true` | The hour module names the hour of prayer (Vigils, Lauds, Terce, Sext, None, Vespers, Compline); off, the part of the day (morning). |
| `bar.tray` | `"drawer"` | `drawer` (your apps' status items fold behind a chevron) or `row` (they stay in the row with macOS's). |

Module ids: `mark`, `workspaces`, `app-menus`, `status`, `hour`, `clock`, `date`, `verse`,
`battery`, `network`, `agents`, `page`, `notifications`, and `custom:<name>` (lowercase letters, digits and hyphens, up to 32) for a module of your own.

What each one draws:

| Module | Shows |
| --- | --- |
| `mark` | Polycarp's olive branch mark. Click it for Polycarp's menu (Settings, Quit and the rest), which `status` leaves out. |
| `workspaces` | A number for each workspace with windows and the one you're on, in order: `1 2 4`. The one you're on is bright on a soft accent pill (a `dot` theme), over a short accent line (`bar`) or on an accent block (`number-block`, such as Omarchy), which slides when you switch; the others are muted. Click one to go there, or turn the wheel over them for the one before or after. |
| `hour` | The day and the hour in words: "Saturday, Terce". Sunday is the Lord's Day. |
| `clock` | Saturday 10:04 PM by default, the time in full and the rest a step quieter; Saturday 22:04 with `clockFormat` day-24h, 3:05 with 12h, 15:05 with 24h. Click it for a calendar: the arrow keys or the wheel go a month or a year, T comes back to today. |
| `date` | November 21. Click it for the same calendar. |
| `verse` | The desktop's verse for now, with its reference. |
| `battery` | The charge, only off power or while charging. Nothing on a desktop Mac. |
| `network` | "Offline" when there is no connection; nothing when there is. |
| `agents` | How many coding agents need you, beside an accent mark, and how many are working, a step quieter; nothing when there are none. Click it for the list, the ones that need you first, and choose one to go to it. |
| `app-menus` | The front app's menus: the Apple logo, the app's name in bold, then File, Edit and the rest. Click one to open it, as from the macOS bar. Titles past the room are left out whole, from the end. |
| `status` | The status items of macOS and your apps, in the macOS bar's order: Wi-Fi, the battery, Control Center and the like as symbols in the bar's text color, an app's own as its icon in its own colors. Two or more of your apps' fold into a drawer behind a chevron: point at it and they slide out, click it and they stay out. With `bar.tray` row they are all in one row. Click one to open it. The macOS clock is left out beside `clock` or `date`, the battery beside `battery`; Polycarp's own is under the mark, and what macOS hid behind its "Show Hidden Menu Bar Items" button stays hidden. |
| `page` | What the browsers running the Polycarp extension have on this workspace: the front page's site icon and title (click to go to it), a speaker while a tab plays sound (click to go to that tab), and how far the downloads on their way are (click to show one in Finder). Not in the bar unless you list it; nothing when there is nothing to show; a kind switched off in Settings › Launcher is left out. |
| `notifications` | A bell, with how many notifications are new. Click it for the list, by app: open one, dismiss it, clear an app or all of them, keep an app quiet, or open Notification Center. With the Polycarp extension, a browser's finished downloads are listed too, and a web notification has its site's icon and goes to that site's tab. |
| `custom:<name>` | Kept in the file, not drawn yet. |

**The look.** By default (`bar.style` islands) each group of modules floats in its own rounded island over the
desktop, as many Omarchy and Waybar setups draw theirs: the theme's surface color, a hairline edge, a small shadow,
6 points between islands. `"|"` in a module list starts a new island; `bar .island` in style.css restyles them; an
island whose modules draw nothing (the battery on a desktop Mac, the network while online) isn't drawn. `solid` is
Omarchy's own look: one strip in the theme's background color. Either way the bar has one monospace face for all
of it (the Polycarp theme's `type.mono` stack when one is in force, else SF Mono) at 12 points, the app's name in
semibold and its menus regular, and no color but the accent at the workspace you're on. Every icon has one slot,
27 points, whatever its own shape, and everything you can click lights a soft face under the pointer and presses in; the
whole height of the bar takes the click, so the pointer can rest on the screen's edge. Groups between `"|"` are a little
apart and there are no lines between them. On a screen with a notch the middle's modules sit beside the camera, on its
right, and the right's at the screen's edge. By default the bar shows the mark, the numbers, the app's menus, the clock, the agents while there are any, the status row and the bell,
nothing else.

**Moving modules.** Hold ⌘ and drag any module along the bar, as in the macOS menu bar: it lifts under the pointer,
the others part where it will land, and a thin accent line marks the place. It can go before or after any module in
any of the three places, or into an empty place (a dashed outline shows while you drag). Let go to keep it there:
the three lists are written to `bar.modules` in one write, and every bar on every display follows. Letting go off the
bar, pressing Escape, or letting go where it started changes nothing. Right-click the bar's empty space for Undo Move,
which puts back the lists from before your last move until the next move or a quit. On a screen with a notch nothing
can be dropped under the camera, and the middle's modules stay beside it; nor in a place style.css hides, or one
that hides the module you hold. Escape is kept from the app in front while you drag. The first move writes all three places, so
a place you never set stops following Polycarp's defaults; `polycarp-spaces surfaces reset bar.modules` gives them
back. Without ⌘: right-click the bar's empty space or the mark and choose Arrange Bar Items…. Every module gets a faint
outline, the island splits show as small grips you can move too, a plain drag moves a module, clicks open nothing,
and Done sits after the middle's modules. Done, Escape, a click outside the bar, or a minute with no drag ends it;
⌘Z undoes the last move while it is on. VoiceOver: each module has the actions Move Left, Move Right, Move to Left
Section, Move to Center and Move to Right Section, each the same move as a drop. The rules and their cases are in
spec/bar.md, "Moving modules (macOS)".

**Saved module lists are not changed.** The defaults above (the clock in the middle, the status row at the right, no
`hour`) are for a file that sets no `bar.modules` place. A file that already lists its modules keeps them as they are;
to take the new layout, `polycarp-spaces surfaces reset bar.modules`.

**Retired values still read.** Workspace purposes, the day's focus and the menu bar ask were removed on 2026-11-22. A
file written before then still reads, with a warning for each retired value: `purpose` and `one-thing` are left out
of a module list, and `bar.hideSystemMenuBar`, `newtab.chips`
and an `alarm` section are ignored as unknown keys. `surfaces set` refuses them.

`app-menus` and `status` read through the Accessibility permission Polycarp already has; no pixels are copied, so
they need no Screen Recording. A status item that macOS or its app doesn't show to Accessibility isn't drawn.

**Notifications.** The list holds the banners macOS drew since the bar came up, at most 200, in memory only: nothing is
written, logged or sent, and it is empty again when Polycarp quits. Opening one while its banner is up does what a
click on the banner does; after that it brings its app forward. An app kept quiet has its banners closed as they come and filed
without being counted (where macOS is in English, since its Close action is found by name). macOS draws no banner
during a Focus, or for an app set to none, so those reach only Notification Center, which the list opens.

**The macOS menu bar.** No app can remove it, so Polycarp's bar shows only where the macOS bar is hidden: System
Settings > Menu Bar > "Automatically hide and show the menu bar" set to Always. While Polycarp's bar is up, Polycarp has the
window server draw the macOS bar fully transparent, and then it takes no clicks either, so pointing at the top edge
never brings it in, full screen included (Donovan, 2026-11-23: "block the bar from coming in any form"); the app's
menus open from the bar's `app-menus`. Holding the pointer off the edge was tried first and failed: macOS reveals its
bar from the raw pointer events. Polycarp sets it again on every Space and workspace change. The setting ends when Polycarp quits or crashes, so the
macOS bar comes back then.
Where a window fills the top of the screen or an app is in full screen, Polycarp's bar is covered and the pointer can't
reach any menus there: use the keyboard (⌃F2 opens the menus, ⌃⌘F leaves full screen).
The trace says `macOS menu bar: hidden under Polycarp's bar` or `shown`. Where the macOS bar stays, Polycarp's bar steps aside, and on a full-screen app it
stays away. The bar sits just under your windows, so a window that reaches the top of the screen covers it rather than
losing its buttons under it.

### `desktop`: the scene behind every window, and its verse

| Path | Default | Takes |
| --- | --- | --- |
| `desktop.scene` | `"field"` | `field`, `olive`, `water`, `parchment`, `solid` (the theme's background), or `image:<file>` for a picture of your own: lowercase letters, digits and hyphens, then `.png`, `.jpg` or `.heic` (the names a theme's `image:` wallpaper takes). |
| `desktop.followDaylight` | `true` | The scene's light follows the day: dawn, noon, dusk and night. |
| `desktop.verse` | `true` | A small verse on the desktop. |
| `desktop.versePosition` | `"bottom-right"` | `bottom-left`, `bottom-center`, `bottom-right`, `top-left`, `top-center`, `top-right` or `center`. |
| `desktop.verseRotation` | `"daily"` | `daily`, `hourly`, or `fixed:<reference>` for one verse always, as `fixed:Psalm 46:10` or `fixed:Lamentations 3:22-23`. |
| `desktop.paper` | `""` | The desktop's own paper, over `paper`: `#RRGGBB`, a scene or `picture:<name>`. It wins over the theme's wallpaper and `desktop.scene`. Empty follows `paper`. |

The desktop shows a scene while Settings › Appearance › "Theme sets the desktop picture" is on and a Polycarp theme is in
force; off, each display gets its own picture back. `field`, `olive`, `water` and `parchment` are drawn by Polycarp at each
display's size. With `followDaylight` on, the light is dawn, day, dusk or night by the clock: sunrise and sunset are
worked out for the time zone, so Polycarp never asks where you are. Off, the scene stays in day light, or night while macOS
is dark. The picture changes on its own at each edge of the light and when the verse turns (midnight, or each hour).

The verses are a set of 31 from the Berean Standard Bible (`Verses.desktop` in `DesktopScene.swift`), each the BSB's own
words. A `fixed:` reference outside that set turns daily instead, so the desktop never goes without one. The verse sits
low on the left, right or center, clear of the Dock; with the verse on the right the land is drawn mirrored, so the
lilies stand opposite it.

### `menu`: the status menu (Polycarp's menu bar icon)

| Path | Default | Takes |
| --- | --- | --- |
| `menu.order` | `["workspaces","show-all","find","agents","update","settings","quit"]` | Row ids in order. Rows left out follow in their default order. |
| `menu.hidden` | `[]` | Row ids not shown. `settings` and `quit` can't be hidden. |

Row ids: `workspaces`, `show-all`, `find`, `agents` (agents that finished while you were away), `update`, `settings`,
`quit`.

### `search`: one web search for the launcher, the new tab page and `polycarp-spaces search`

| Path | Default | Takes |
| --- | --- | --- |
| `search.engine` | `"g"` | Where plain words go: a bang trigger (`g` Google, `ddg` DuckDuckGo, `brave` Brave Search, `kagi` Kagi, `b` Bing, `pplx` Perplexity, or one of yours from `bangs.json`), or an `https://` URL with `{query}` once. A trigger Polycarp doesn't list searches DuckDuckGo with that bang. |

The launcher (its Search the Web menu and the web rows under every search), the browser's new tab page and
`polycarp-spaces search` all read this one setting, and all three use the same bang table: the built-in bangs plus yours
from `bangs.json` in the support folder, so `!yt cats` or `!claude a question` does the same thing in each. Settings >
Launcher's "Search the web with" picker writes it.

Which engine wins: `search.engine` when the file sets it; else `newtab.searchURL` when the file sets that (a file from
before `search.engine` keeps searching where it did); else Google. `surfaces get search.engine` prints `"g"` for a
file that sets only `newtab.searchURL`, but searches go where `newtab.searchURL` says until `search.engine` is set. An
engine chosen in the launcher before this setting existed moves into the file once, the first time Polycarp starts,
unless the file already chose one: `search.engine`, or a `newtab.searchURL` other than its default (a full file from
`surfaces get` carries the default, which nobody chose). Settings > Launcher shows the engine in force and follows the
file; a pick the file refuses goes back, with the reason under the picker.

### `newtab`: the browser's new tab page

| Path | Default | Takes |
| --- | --- | --- |
| `newtab.question` | `"Search or type an address"` | The placeholder in the new tab's one field: one line, not blank, up to 160 characters. |
| `newtab.verse` | `true` | A verse on the page. |
| `newtab.searchURL` | `"https://duckduckgo.com/?q={query}"` | The older name for the engine: an `https://` URL with `{query}` once. Used only when the file doesn't set `search.engine`. With no Polycarp host at all, the page searches DuckDuckGo. |
| `newtab.paper` | `""` | The page's own paper, over `paper`: `#RRGGBB`, a scene or `picture:<name>`. Empty follows `paper`. |

The page's finder, its keys and the host's `find` reply: [newtab.md](newtab.md).

### `idle`: the idle screen

| Path | Default | Takes |
| --- | --- | --- |
| `idle.enabled` | `false` | Show Polycarp's idle screen. Off until you turn it on. |
| `idle.style` | `"martyr-night"` | `martyr-night` (night sky and embers), `theme` (the same sky in your theme's colors, its words in the theme's display font; with a paper in force, the night's colors), `field` (the desktop scene, dimmed) or `verse` (one verse on black). |
| `idle.effects` | `true` | Motion on the idle screen. Reduce Motion turns it off regardless. |
| `idle.showMachineName` | `true` | The Mac's name. |
| `idle.showVerse` | `true` | A verse. |
| `idle.showKierkegaard` | `true` | A line from Kierkegaard. |
| `idle.startAfterMinutes` | `10` | Minutes without input before it comes up: 1 to 240. |
| `idle.paper` | `""` | The idle screen's own paper, over `paper`, dimmed behind the words in any style: `#RRGGBB`, a scene or `picture:<name>`. Empty follows `paper`. |

The idle screen covers every screen after `startAfterMinutes` without input: the Mac's name, the time, a verse (BSB,
a new one each hour) and a line of Kierkegaard (a new one each day). The words drift a few points a minute so nothing
sits on the same pixels all night. Any key, click or move takes it away, and the key that wakes it doesn't reach the
app under it. It doesn't come up while an app keeps the display awake (a video playing, a call), or once macOS's
screen saver, lock or display sleep has the screen; those still come in their time, over it. To see it soon: `polycarp-spaces surfaces set idle
'{"enabled":true,"startAfterMinutes":1}'`.

### `text`: where verses come from

| Path | Default | Takes |
| --- | --- | --- |
| `text.translation` | `"BSB"` | The Bible translation. Only `BSB` (the Berean Standard Bible, public domain) for now. |
| `text.verseSource` | `"built-in"` | `built-in`, or `file:<name>.json` for a list of references in the support folder's `verses/` folder. |

### `rooms`: the Baney Extended System's rooms

| Path | Default | Takes |
| --- | --- | --- |
| `rooms.root` | `"~/BES"` | The folder that holds `0 Inbox`, `1 Do`, `2 Keep`, `3 Know` and `4 Let Go` (`bes init` makes them). `~/` starts at your home folder; a drive works too (`/Volumes/Drive/BES`). Polycarp shows the rooms only once this folder has `.bes/` or `0 Inbox/` in it, and never makes them. |
| `rooms.menu` | `true` | A Rooms section in the status menu: the five rooms, and what waits in the Inbox. |

What the rooms do in the launcher and the menu: [rooms.md](rooms.md).

### `tiling`: windows side by side

Off until you turn it on: [docs/tiling.md](../../docs/tiling.md).

| Path | Default | Takes |
| --- | --- | --- |
| `tiling.enabled` | `false` | Tile every workspace that isn't in `tiling.off`. A workspace in `tiling.on` tiles either way. |
| `tiling.on` | `[]` | Workspaces, `"1"` to `"9"`, that tile while `tiling.enabled` is off. |
| `tiling.off` | `[]` | Workspaces that don't tile while `tiling.enabled` is on. |
| `tiling.style` | `"dwindle"` | `dwindle` splits the window you are in, `columns` puts windows side by side, `main` keeps one large window beside a stack, `scrolling` has columns in a strip wider than the screen, `floating` leaves windows where you put them. |
| `tiling.gaps.inner` | `8` | Points between tiled windows, 0 to 64. |
| `tiling.gaps.outer` | `8` | Points around them, 0 to 64. |
| `tiling.gaps.top` | `0` | Points more at the top edge, 0 to 400, for something that stays there. |
| `tiling.gaps.bottom` | `0` | Points more at the bottom edge, 0 to 400, for something that stays there. |
| `tiling.gaps.left` | `0` | Points more at the left edge, 0 to 400, for something that stays there. |
| `tiling.gaps.right` | `0` | Points more at the right edge, 0 to 400, for something that stays there. |
| `tiling.loneWidth` | `"smart"` | How wide a workspace's only window gets: `smart` (a 16:10 shape on a wide display, all of any other), `fill`, or `points:<width>`. |
| `tiling.newWindow` | `"after"` | Which side of the window you are in a new one goes on: `after` (right or below) or `before`. |
| `tiling.float` | `[]` | Apps whose windows are never tiled, by bundle id, besides the small utilities that float unless a rule tiles them. |
| `tiling.rules` | `[]` | Window rules, one a line: an app's bundle id, then `float`, `tile`, `pin` or a workspace 1-9, then words of the title if only some windows. The first float or tile rule that matches wins, and the first pin or workspace rule says where a new window goes. |
| `tiling.floatModifier` | `"shift"` | The key held while a tiled window is let go that leaves it floating: `shift`, `control`, `option`, `command` or `none`. |
| `tiling.keys.toggle` | `"ctrl+opt+T"` | Tile this workspace, or stop. |
| `tiling.keys.focus-left` | `"ctrl+opt+Left"` | Focus the window to the left. |
| `tiling.keys.focus-right` | `"ctrl+opt+Right"` | Focus the window to the right. |
| `tiling.keys.focus-up` | `"ctrl+opt+Up"` | Focus the window above. |
| `tiling.keys.focus-down` | `"ctrl+opt+Down"` | Focus the window below. |
| `tiling.keys.focus-next` | `"ctrl+opt+]"` | Focus the next tiled window. |
| `tiling.keys.focus-previous` | `"ctrl+opt+["` | Focus the previous tiled window. |
| `tiling.keys.move-left` | `"ctrl+opt+shift+Left"` | Move the tiled window left. |
| `tiling.keys.move-right` | `"ctrl+opt+shift+Right"` | Move the tiled window right. |
| `tiling.keys.move-up` | `"ctrl+opt+shift+Up"` | Move the tiled window up. |
| `tiling.keys.move-down` | `"ctrl+opt+shift+Down"` | Move the tiled window down. |
| `tiling.keys.grow-left` | `"ctrl+opt+cmd+Left"` | Move the tiled window's edge left. |
| `tiling.keys.grow-right` | `"ctrl+opt+cmd+Right"` | Move the tiled window's edge right. |
| `tiling.keys.grow-up` | `"ctrl+opt+cmd+Up"` | Move the tiled window's edge up. |
| `tiling.keys.grow-down` | `"ctrl+opt+cmd+Down"` | Move the tiled window's edge down. |
| `tiling.keys.balance` | `"ctrl+opt+B"` | Even out every split. |
| `tiling.keys.flip` | `"ctrl+opt+R"` | Turn the window's split. |
| `tiling.keys.style` | `"ctrl+opt+S"` | Next layout: dwindle, columns, main, scrolling, floating. |
| `tiling.keys.promote` | `"ctrl+opt+Return"` | Make the window the main one. |
| `tiling.keys.float` | `"ctrl+opt+F"` | Float the window, or tile it again. |
| `tiling.keys.full` | `"ctrl+opt+M"` | Give the window the whole area, or put it back. |
| `tiling.keys.fullscreen` | `"ctrl+opt+shift+M"` | Fill the display with the tile, or put it back. |
| `tiling.keys.full-width` | `"ctrl+opt+W"` | Give the tile the whole width, or put it back. |
| `tiling.keys.width-keep` | `"ctrl+opt+shift+\\"` | Keep the window's width for its app. |
| `tiling.keys.width-restore` | `"ctrl+opt+\\"` | Give the window the width kept for its app. |
| `tiling.keys.group` | `"ctrl+opt+G"` | Make the tile a group of tabs, or take it apart. |
| `tiling.keys.group-left` | `"ctrl+opt+shift+cmd+Left"` | Move the window into the tile to the left, or out of its group. |
| `tiling.keys.group-right` | `"ctrl+opt+shift+cmd+Right"` | Move the window into the tile to the right, or out of its group. |
| `tiling.keys.group-up` | `"ctrl+opt+shift+cmd+Up"` | Move the window into the tile above, or out of its group. |
| `tiling.keys.group-down` | `"ctrl+opt+shift+cmd+Down"` | Move the window into the tile below, or out of its group. |
| `tiling.keys.group-next` | `"ctrl+opt+Tab"` | Focus the next window of the group. |
| `tiling.keys.group-previous` | `"ctrl+opt+shift+Tab"` | Focus the previous window of the group. |
| `tiling.keys.next-display` | `"ctrl+opt+N"` | Send the window to the next display. |
| `tiling.keys.scratchpad` | `"ctrl+opt+-"` | Show the scratchpad, or put it away. |
| `tiling.keys.scratchpad-send` | `"ctrl+opt+shift+-"` | Send the window to the scratchpad, or take it out. |
| `tiling.keys.pop` | `"ctrl+opt+O"` | Pop the window out over every workspace, or put it back. |
| `tiling.keys.pin` | `"ctrl+opt+P"` | Pin the window over every workspace where it is, or put it back. |
| `tiling.keys.style-dwindle` | `""` | Tile in the dwindle style. |
| `tiling.keys.style-columns` | `""` | Tile in the columns style. |
| `tiling.keys.style-main` | `""` | Tile in the main style. |
| `tiling.keys.style-scrolling` | `""` | Tile in the scrolling style. |
| `tiling.keys.style-floating` | `""` | Tile in the floating style. |

A key is modifiers and one key joined with `+`: `ctrl`, `opt`, `shift`, `cmd`, then a letter, an arrow, `F1` to `F20`, `Return`, `Space`, `Tab`, `Delete`, `Home`, `End`, `PageUp`, `PageDown` or one of `0 - = [ ] ; ' , . / \` and the backtick. A key takes `ctrl` and another modifier, or `cmd` and `opt`, so none is taken from the app in front; 1 to 9 are the workspaces'. Empty is no key. A key you give one command leaves the command that has it by default without one; two commands in the file can't share a key.

## Examples

```sh
# Turn the top bar on, glass, a little taller, with the hour of prayer in the middle.
polycarp-spaces surfaces set bar '{"enabled":true,"style":"glass","height":30}'
polycarp-spaces surfaces set bar.modules '{"left":["mark","workspaces"],"center":["hour"],"right":["verse","clock"]}'

# One verse on the desktop, always, at the top right.
polycarp-spaces surfaces set desktop.verseRotation '"fixed:Psalm 46:10"'
polycarp-spaces surfaces set desktop.versePosition top-right

# A quieter menu.
polycarp-spaces surfaces set menu.hidden '["find","agents"]'

# The new tab page's placeholder; one search engine for the launcher, the new tab and polycarp-spaces search.
polycarp-spaces surfaces set newtab.question '"Search the web"'
polycarp-spaces surfaces set search.engine kagi
polycarp-spaces surfaces set search.engine '"https://search.brave.com/search?q={query}"'

# Check a draft before putting it in place; undo one change; start over.
polycarp-spaces surfaces validate ./draft.json
polycarp-spaces surfaces reset desktop.versePosition
polycarp-spaces surfaces reset
```

A complete file (every field at its default) is what `polycarp-spaces surfaces get` prints. A file only needs what
differs:

```json
{
  "version": 1,
  "bar": {"enabled": true, "style": "hairline"},
  "desktop": {"scene": "olive", "verseRotation": "hourly"},
  "idle": {"startAfterMinutes": 15}
}
```

## MCP

`polycarp mcp` (the theme server) also serves three surfaces tools. Each runs `polycarp-spaces surfaces ... --json` and
returns its envelope as is, so the command and the tools can't disagree:

| Tool | Arguments | Does |
| --- | --- | --- |
| `surfaces_schema` | none | The JSON Schema. Read it first. |
| `surfaces_get` | `path` (optional) | The value in force at `path`, or everything. |
| `surfaces_set` | `path`, `value` (any JSON) | Checks, then writes. A refusal is a tool error with `error.data.errors`. |

To undo, `surfaces_set` the old value (from `surfaces_get` before the change), or run `polycarp-spaces surfaces reset <path>`.

Two search tools read `search.engine` and the bangs the same way: `search` (`query`; read-only) runs
`polycarp-spaces search <query> --json` and returns the ranked results, and `search_open` (`query`) runs it with
`--open` to go to the top one.

Three paper tools run `polycarp-spaces paper ... --json` the same way, so "make my wallpaper this sunset picture" is one
call:

| Tool | Arguments | Does |
| --- | --- | --- |
| `paper_set` | `what`, `on` (optional) | A picture path, an https URL, `#RRGGBB` or a scene, for every place or those in `on`. |
| `paper_get` | none | Each place's paper and where it comes from. |
| `paper_reset` | `on` (optional) | Takes the paper off those places. |

## For views (Swift)

Views read `SurfacesStore.shared.current` (a `Surfaces`, safe from any thread) and listen for
`SurfacesStore.didChange`, posted on the main queue after `current` holds the new config, with it in
`userInfo[SurfacesStore.key]`. The app starts the store at launch (`AppDelegate`), beside the theme watcher.

```swift
let s = SurfacesStore.shared.current
bar.isHidden = !s.bar.enabled
NotificationCenter.default.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { note in
    guard let s = note.userInfo?[SurfacesStore.key] as? Surfaces else { return }
    apply(s)
}
```

The model is `Surfaces` in BaneySpacesCore: `bar` (`Bar`: `enabled`, `height`, `style`, `left`, `center`, `right` as
`[BarModule]`, `clockFormat`, `hourNames`), `desktop` (`scene`, `followDaylight`, `verse`,
`versePosition`, `verseRotation`, `paper`), `menu` (`order`, `hidden`, and
`rows`, the rows to show in order), `search` (`engine`; `OneSearch.engine` resolves it against the bangs), `newtab`
(`question`, `verse`, `searchURL`, `paper`, and `searchURL(for:)`), `idle`
(`enabled`, `style`, `effects`, `showMachineName`, `showVerse`, `showKierkegaard`, `startAfterMinutes`, `paper`), `paper`
and `paper(on:)` (the paper in force for a place, Paper.swift) and `text` (`translation`, `verseSource`). `SurfaceField.all` is the one list of fields: validation, defaults, the model and the schema all read it.

Test hook: `POLYCARP_SURFACES_FILE` (an absolute path) points the command at another file. Never set in real use.
