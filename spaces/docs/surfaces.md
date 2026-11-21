# Surfaces: one file for every Polycarp surface

`surfaces.json` says how each Polycarp surface looks and behaves: the top bar, the desktop scene and its verse, the
Workspace Dock's tiles, the status menu, the browser's new tab page and the idle screen. Agents and the owner edit it
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
- **A bar module goes in one place.** Each id appears once in `left`, `center` and `right` together, defaults included:
  to move `clock` to the left, set `bar.modules` whole, or set `bar.modules.right` without it first.
- **`settings` and `quit` can't be hidden** from the status menu.
- `version` is the file's format. This build writes 1, and never lowers a higher one it finds.

## Every field

### `bar`: the top bar that stands in for the macOS menu bar

| Path | Default | Takes |
| --- | --- | --- |
| `bar.enabled` | `false` | `true` or `false`. Show Polycarp's top bar. Off until you turn it on. |
| `bar.height` | `28` | A whole number of points, 22 to 40. |
| `bar.style` | `"solid"` | `solid` (the theme's surface color), `glass` (blurred, see-through) or `hairline` (the desktop shows through, with a thin line under it). |
| `bar.modules.left` | `["mark","workspaces","app-menus"]` | Module ids, in order. |
| `bar.modules.center` | `["one-thing"]` | Module ids, in order. |
| `bar.modules.right` | `["status","network","battery","date","clock"]` | Module ids, in order. |
| `bar.clockFormat` | `"12h"` | `12h` (3:05) or `24h` (15:05). |
| `bar.hourNames` | `true` | The hour module names the hour of prayer (Lauds, Terce, Sext, None, Vespers, Compline). |
| `bar.hideSystemMenuBar` | `false` | Hide the macOS menu bar while Polycarp's bar is on. Off: the two share the top of the screen. |

Module ids: `mark`, `workspaces`, `purpose`, `one-thing`, `app-menus`, `status`, `hour`, `clock`, `date`, `verse`,
`battery`, `network`, and `custom:<name>` (lowercase letters, digits and hyphens, up to 32) for a module of your own.

### `desktop`: the scene behind every window, and its verse

| Path | Default | Takes |
| --- | --- | --- |
| `desktop.scene` | `"field"` | `field`, `olive`, `water`, `parchment`, `solid` (the theme's background), or `image:<file>` for a picture of your own: lowercase letters, digits and hyphens, then `.png`, `.jpg` or `.heic` (the names a theme's `image:` wallpaper takes). |
| `desktop.followDaylight` | `true` | The scene's light follows the day: dawn, noon, dusk and night. |
| `desktop.verse` | `true` | A small verse on the desktop. |
| `desktop.versePosition` | `"bottom-right"` | `bottom-left`, `bottom-center`, `bottom-right`, `top-left`, `top-center`, `top-right` or `center`. |
| `desktop.verseRotation` | `"daily"` | `daily`, `hourly`, or `fixed:<reference>` for one verse always, as `fixed:John 3:16` or `fixed:1 Corinthians 13:4-7`. |

### `dock`: the Workspace Dock's tiles

| Path | Default | Takes |
| --- | --- | --- |
| `dock.tileLabel` | `"number"` | What each workspace tile says: `purpose`, `number`, or `icons` (only its apps' icons). |
| `dock.restTile` | `true` | An "At rest" tile gathers apps that have sat idle in the background. |
| `dock.restAfterMinutes` | `30` | Minutes in the background, unused, before an app moves to the rest tile: 1 to 1440. |

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
| `newtab.question` | `"What is the one thing today?"` | One line, not blank, up to 160 characters. |
| `newtab.chips` | `true` | Shortcut chips under the question. |
| `newtab.verse` | `true` | A verse on the page. |
| `newtab.searchURL` | `"https://duckduckgo.com/?q={query}"` | An `https://` URL with `{query}` once, where the search words go. |

### `idle`: the idle screen

| Path | Default | Takes |
| --- | --- | --- |
| `idle.style` | `"martyr-night"` | `martyr-night` (night sky and embers), `field` (the desktop scene, dimmed) or `verse` (one verse on black). |
| `idle.effects` | `true` | Motion on the idle screen. Reduce Motion turns it off regardless. |
| `idle.showMachineName` | `true` | The Mac's name. |
| `idle.showVerse` | `true` | A verse. |
| `idle.showKierkegaard` | `true` | A line from Kierkegaard. |
| `idle.startAfterMinutes` | `10` | Minutes without input before it comes up: 1 to 240. |

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
polycarp-spaces surfaces set dock.restAfterMinutes 60

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
`versePosition`, `verseRotation`), `dock` (`tileLabel`, `restTile`, `restAfterMinutes`), `menu` (`order`, `hidden`, and
`rows`, the rows to show in order), `newtab` (`question`, `chips`, `verse`, `searchURL`, and `searchURL(for:)`), `idle`
(`style`, `effects`, `showMachineName`, `showVerse`, `showKierkegaard`, `startAfterMinutes`) and `text` (`translation`,
`verseSource`). `SurfaceField.all` is the one list of fields: validation, defaults, the model and the schema all read it.

Test hook: `POLYCARP_SURFACES_FILE` (an absolute path) points the command at another file. Never set in real use.
