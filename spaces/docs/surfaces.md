# Surfaces: one file for every Polycarp surface

`surfaces.json` says how each Polycarp surface looks and behaves: the top bar, the desktop scene and its verse, the
Workspace Dock's tiles, the status menu, the browser's new tab page, the idle screen, and the wake alarm and one-thing
timer. Agents and the owner edit it
with `polycarp-spaces surfaces`, or over MCP with `polycarp mcp`. A running Polycarp picks up a change within 150 ms;
nothing restarts.

Colors, fonts and the theme's wallpaper stay in the theme (`polycarp theme`, `themes/*.toml`). This file says what each
surface shows; the theme says what it looks like.

- File: `~/Library/Application Support/Polycarp/surfaces.json`
- Every field is optional. A missing field, or no file at all, takes the default below.
- A path is the keys joined with dots: `bar.height`, `bar.modules.left`, `desktop.scene`.
- `polycarp-spaces surfaces schema` prints the JSON Schema (draft 2020-12) with every field, its default and its rules.

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

## Every field

### `bar`: the top bar that stands in for the macOS menu bar

| Path | Default | Takes |
| --- | --- | --- |
| `bar.enabled` | `false` | `true` or `false`. Show Polycarp's top bar. Off until you turn it on. |
| `bar.height` | `28` | A whole number of points, 22 to 40. |
| `bar.style` | `"solid"` | `solid` (the theme's surface color), `glass` (blurred, see-through) or `hairline` (the desktop shows through, with a thin line under it). |
| `bar.modules.left` | `["mark","workspaces","app-menus","purpose"]` | Module ids, in order. |
| `bar.modules.center` | `["one-thing"]` | Module ids, in order. |
| `bar.modules.right` | `["status","hour","clock"]` | Module ids, in order. |
| `bar.clockFormat` | `"12h"` | `12h` (3:05) or `24h` (15:05). |
| `bar.hourNames` | `true` | The hour module names the hour of prayer (Vigils, Lauds, Terce, Sext, None, Vespers, Compline); off, the part of the day (morning). |
| `bar.hideSystemMenuBar` | `false` | Ask for the macOS menu bar to hide: Polycarp opens System Settings > Menu Bar for you to choose Always. It never changes the setting itself. |

Module ids: `mark`, `workspaces`, `purpose`, `one-thing`, `app-menus`, `status`, `hour`, `clock`, `date`, `verse`,
`battery`, `network`, and `custom:<name>` (lowercase letters, digits and hyphens, up to 32) for a module of your own.

What each one draws:

| Module | Shows |
| --- | --- |
| `mark` | Polycarp's vine mark. Click it for Polycarp's menu (Settings, Quit and the rest), which `status` leaves out. |
| `workspaces` | A dot for each workspace with windows, the one you're on drawn long; click one to go there. |
| `purpose` | What the workspace you're on is for (`polycarp-spaces purpose set`), in serif italic. Nothing when it has none. |
| `one-thing` | Today's one thing (`polycarp-spaces one`), in gold. Nothing when there is none. |
| `hour` | The day and the hour in words: "Saturday, Terce". Sunday is the Lord's Day. |
| `clock` | 3:05, or 15:05 with `clockFormat` 24h. |
| `date` | November 21. |
| `verse` | The desktop's verse for now, with its reference. |
| `battery` | The charge, only off power or while charging. Nothing on a desktop Mac. |
| `network` | "Offline" when there is no connection; nothing when there is. |
| `app-menus` | The front app's menus: the Apple logo, the app's name in bold, then File, Edit and the rest. Click one to open it, as from the macOS bar. Titles past the room are left out whole, from the end. |
| `status` | The status items of macOS and your apps, in the macOS bar's order: Wi-Fi, the battery, Control Center and the like as symbols, an app's own as its icon. Click one to open it. The macOS clock is left out beside `clock` or `date`, the battery beside `battery`; Polycarp's own is under the mark. |
| `custom:<name>` | Kept in the file, not drawn yet. |

`app-menus` and `status` read through the Accessibility permission Polycarp already has; no pixels are copied, so
they need no Screen Recording. A status item that macOS or its app doesn't show to Accessibility isn't drawn.

**The macOS menu bar.** No app can remove it, so Polycarp's bar shows only where the macOS bar is hidden: System
Settings > Menu Bar > "Automatically hide and show the menu bar" set to Always. Pointing at the top edge still brings the
macOS bar and the app's menus down. Where the macOS bar stays, Polycarp's bar steps aside, and on a full-screen app it
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

The desktop shows a scene while Settings › Appearance › "Theme sets the desktop picture" is on and a Polycarp theme is in
force; off, each display gets its own picture back. `field`, `olive`, `water` and `parchment` are drawn by Polycarp at each
display's size. With `followDaylight` on, the light is dawn, day, dusk or night by the clock: sunrise and sunset are
worked out for the time zone, so Polycarp never asks where you are. Off, the scene stays in day light, or night while macOS
is dark. The picture changes on its own at each edge of the light and when the verse turns (midnight, or each hour).

The verses are a set of 31 from the Berean Standard Bible (`Verses.desktop` in `DesktopScene.swift`), each the BSB's own
words. A `fixed:` reference outside that set turns daily instead, so the desktop never goes without one. The verse sits
low on the left, right or center, clear of the Dock; with the verse on the right the land is drawn mirrored, so the
lilies stand opposite it.

### `dock`: the Workspace Dock's tiles

| Path | Default | Takes |
| --- | --- | --- |
| `dock.tileLabel` | `"purpose"` | What each workspace tile says: `purpose` (the workspace's purpose in italic under the tile, with its number in the tile's corner; the number alone where it has no purpose), `number`, or `icons` (only its apps' icons). |
| `dock.restTile` | `true` | An "At rest" tile after the workspaces gathers apps running with no window. Off, they don't show on the dock. |

### `menu`: the status menu (Polycarp's menu bar icon)

| Path | Default | Takes |
| --- | --- | --- |
| `menu.order` | `["workspaces","show-all","find","agents","update","dock","settings","quit"]` | Row ids in order. Rows left out follow in their default order. |
| `menu.hidden` | `[]` | Row ids not shown. `settings` and `quit` can't be hidden. |

Row ids: `workspaces`, `show-all`, `find`, `agents` (agents that finished while you were away), `update`, `dock`
(the dock switch), `settings`, `quit`.

### `newtab`: the browser's new tab page

| Path | Default | Takes |
| --- | --- | --- |
| `newtab.question` | `"What is this hour for?"` | One line, not blank, up to 160 characters. |
| `newtab.chips` | `false` | Your workspaces by purpose under the field; a click switches to one. |
| `newtab.verse` | `true` | A verse on the page. |
| `newtab.searchURL` | `"https://duckduckgo.com/?q={query}"` | An `https://` URL with `{query}` once, where the search words go. |

### `idle`: the idle screen

| Path | Default | Takes |
| --- | --- | --- |
| `idle.enabled` | `false` | Show Polycarp's idle screen. Off until you turn it on. |
| `idle.style` | `"martyr-night"` | `martyr-night` (night sky and embers), `field` (the desktop scene, dimmed) or `verse` (one verse on black). |
| `idle.effects` | `true` | Motion on the idle screen. Reduce Motion turns it off regardless. |
| `idle.showMachineName` | `true` | The Mac's name. |
| `idle.showVerse` | `true` | A verse. |
| `idle.showKierkegaard` | `true` | A line from Kierkegaard. |
| `idle.startAfterMinutes` | `10` | Minutes without input before it comes up: 1 to 240. |

The idle screen covers every screen after `startAfterMinutes` without input: the Mac's name, the time, a verse (BSB,
a new one each hour) and a line of Kierkegaard (a new one each day). The words drift a few points a minute so nothing
sits on the same pixels all night. Any key, click or move takes it away, and the key that wakes it doesn't reach the
app under it. It doesn't come up while an app keeps the display awake (a video playing, a call), or once macOS's
screen saver, lock or display sleep has the screen; those still come in their time, over it. To see it soon: `polycarp-spaces surfaces set idle
'{"enabled":true,"startAfterMinutes":1}'`.

### `alarm`: the wake alarm and the one-thing timer

| Path | Default | Takes |
| --- | --- | --- |
| `alarm.wake` | `false` | Ring at `alarm.wakeAt` and open the morning question. Off until you turn it on. |
| `alarm.wakeAt` | `"06:30"` | When: `"HH:MM"` on the 24 hour clock, `00:00` to `23:59` (`"6:30"` is refused; write `"06:30"`). |
| `alarm.days` | `"every"` | Which days ring: `every` (all), `weekdays` (Monday to Friday) or `not-sunday` (all but Sunday). |
| `alarm.keepAwake` | `true` | On power, hold the Mac awake for the last hour before the alarm so it can ring. |
| `alarm.timerMinutes` | `25` | The one-thing timer's default length in minutes: 1 to 240. |

At `wakeAt`, on a day `days` allows, Polycarp lights the display, takes the idle screen down and plays Glass (a macOS
sound), then again each minute up to five rings in all; any key, click or move stops it. If the morning question hasn't
been given today, its card opens. On a DST day the alarm keeps the clock time and rings once. With `keepAwake` on and
the Mac on power, Polycarp holds off idle sleep ("Polycarp wake alarm" in `pmset -g assertions`) for the last hour so the
ring can come; on battery, or with the lid closed, the Mac sleeps as it would and the alarm can't ring. An alarm the Mac
slept through doesn't ring late. The one-thing timer is started from the status menu ("Start a timer (25 min)") or
`polycarp-spaces timer [minutes]`; its time left shows after the one thing in the bar, and Glass plays once at its end.
To try it: `polycarp-spaces surfaces set alarm '{"wake":true,"wakeAt":"07:00","days":"weekdays"}'`.

### `text`: where verses come from

| Path | Default | Takes |
| --- | --- | --- |
| `text.translation` | `"BSB"` | The Bible translation. Only `BSB` (the Berean Standard Bible, public domain) for now. |
| `text.verseSource` | `"built-in"` | `built-in`, or `file:<name>.json` for a list of references in the support folder's `verses/` folder. |

Not here yet: the morning question, the evening examen and Sunday rest. They belong to workspace purposes and the day
ledger, which are built separately; this file will mirror them once that work lands.

## Examples

```sh
# Turn the top bar on, glass, a little taller, with the hour of prayer in the middle.
polycarp-spaces surfaces set bar '{"enabled":true,"style":"glass","height":30}'
polycarp-spaces surfaces set bar.modules '{"left":["mark","workspaces"],"center":["hour"],"right":["verse","clock"]}'

# One verse on the desktop, always, at the top right.
polycarp-spaces surfaces set desktop.verseRotation '"fixed:Psalm 46:10"'
polycarp-spaces surfaces set desktop.versePosition top-right

# Dock tiles by purpose; rest after an hour.
polycarp-spaces surfaces set dock.tileLabel purpose
polycarp-spaces surfaces set dock.restTile false

# A quieter menu.
polycarp-spaces surfaces set menu.hidden '["find","agents"]'

# The new tab page's question and search engine.
polycarp-spaces surfaces set newtab.question '"Purity of heart is to will one thing."'
polycarp-spaces surfaces set newtab.searchURL '"https://search.brave.com/search?q={query}"'

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
`[BarModule]`, `clockFormat`, `hourNames`, `hideSystemMenuBar`), `desktop` (`scene`, `followDaylight`, `verse`,
`versePosition`, `verseRotation`), `dock` (`tileLabel`, `restTile`), `menu` (`order`, `hidden`, and
`rows`, the rows to show in order), `newtab` (`question`, `chips`, `verse`, `searchURL`, and `searchURL(for:)`), `idle`
(`enabled`, `style`, `effects`, `showMachineName`, `showVerse`, `showKierkegaard`, `startAfterMinutes`), `alarm` (`wake`,
`wakeAt`, `days`, `keepAwake`, `timerMinutes`, and `time`, the hour and minute) and `text` (`translation`, `verseSource`). `SurfaceField.all` is the one list of fields: validation, defaults, the model and the schema all read it.

Test hook: `POLYCARP_SURFACES_FILE` (an absolute path) points the command at another file. Never set in real use.
