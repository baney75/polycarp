# Polycarp themes

One theme file drives every Polycarp product and the website. This folder holds the built-in themes.
Each one is a TOML file named after its theme. They are built into the `polycarp` command, so they
work with no files on disk.

Built-in themes: `polycarp` (the default), `still-water`, `evening`, `parchment`, `blocks`, `calm`.

Every theme in this folder must validate. Run `polycarp theme validate themes/<name>.toml` after any edit.

## Your own themes

Put a file at `themes/<name>.toml` inside your config folder:

- Anywhere: `$POLYCARP_CONFIG_DIR/`, if you set it. It must be an absolute path, or the command refuses it.
  Use it to try things in a temporary folder.
- macOS and Linux: `$XDG_CONFIG_HOME/polycarp/` (default `~/.config/polycarp/`)
- Windows: `%APPDATA%\Polycarp\`

The quickest start is `polycarp theme create mine --extends evening`. It writes the file with a comment
for each section. Then:

```sh
polycarp theme edit-path mine        # where the file is
polycarp theme validate <that file>  # check it
polycarp theme set mine              # use it
polycarp theme undo                  # go back
```

A user theme cannot use the name of a built-in theme.

### In the Mac app

Settings > Appearance shows every theme as a tile. Click one to use it. **Customize…** makes your own
copy of a built-in (what `polycarp theme create <name> --extends <base>` does) and opens the editor;
**Edit…** opens one of yours.

- The editor lists every field `polycarp theme schema` names, with a control for its type: a color
  well and hex field for colors, a slider for numbers, a menu for choices, a switch for on or off, and
  a text box for fonts and easing. A field the CLI adds later shows up with no app update.
- The light and dark previews beside it redraw as you drag: the dock, a panel, buttons, a settings row,
  status colors and the agent cursor (whose colors are its own, so you see how it reads on the theme).
- Any pair below WCAG AA (4.5:1 for text, 3:1 for marks) is listed, and marked beside both colors.
- Undo and Redo work inside the editor. Revert goes back to the last save. **Save** runs
  `polycarp theme change ... --theme <name>` with every edit at once, so the CLI checks it, shows why
  it refuses, and one `polycarp theme undo` takes the save back.
- Drop a `.toml` on the tab to add it. The CLI checks it first and its words are shown as they are.
  A built-in is never replaced, and one of yours only after you say so.
- Drag a tile to Finder to save its theme file.
- Drop a picture on the tab or the editor to take its colors: an accent, the text on it, a selection
  and a border, fitted so every pair still reads. Nothing changes until you use them.

## The format

```toml
name = "mine"            # required. Lowercase letters, digits and hyphens, up to 48, not starting with a hyphen. Must match the file name. The Windows reserved names (con, prn, aux, nul, com1 to com9, lpt1 to lpt9) are refused on every system.
title = "Mine"           # required, unless a theme it extends has one. No control characters, same for description
description = "..."      # optional
extends = "evening"      # optional. One theme. Up to 8 deep. No loops.
```

A theme is complete when, after `extends`, it has every field below. A field in your file replaces the
same field in the theme you extend. Everything else carries over. An unknown key is refused, and the
message names its exact path, so a typo shows up at once.

### Colors: `[light]` and `[dark]`

Each color is `"#rrggbb"`.

| Key | Use |
| --- | --- |
| `background` | The page |
| `surface` | Cards and panels |
| `sunken` | Wells and inputs |
| `foreground` | Normal text |
| `strong` | Headings and emphasis |
| `muted` | Quiet text |
| `border` | Lines |
| `accent` | The brand color |
| `on_accent` | Text on the accent |
| `selection` | Selected rows |
| `urgent`, `working`, `done` | Status colors |

### Shape: `[shape]`

| Key | Values |
| --- | --- |
| `radius_small`, `radius`, `radius_large` | px, 0 to 64 |
| `border_width` | px, 0 to 8 |
| `blur` | px, 0 to 80 |
| `shadow` | opacity, 0.0 to 1.0 |
| `density` | `"compact"`, `"regular"` or `"spacious"` |
| `indicator` | `"dot"`, `"bar"` or `"number-block"` |

### Type: `[type]`

| Key | Values |
| --- | --- |
| `display`, `ui`, `mono` | Font family stacks, as strings: names separated by commas. A name is plain (letters, digits, spaces, hyphens, underscores) or in matching single or double quotes, with no quote, `\`, `<` or `/*` inside. Anything else, such as `url(...)`, parentheses, `;` or braces, is refused. The pattern in `theme schema` says the same (letters and digits are Unicode, so it needs a regex engine with `\p{L}`) |
| `size` | Base size in px, 10 to 24 |
| `weight` | 300 to 800 |
| `line_height` | 1.0 to 2.0 |

### Motion: `[motion]`

| Key | Values |
| --- | --- |
| `fast`, `normal`, `slow` | ms, 0 to 1000 |
| `easing` | `ease`, `ease-in`, `ease-out`, `ease-in-out`, `linear`, or `cubic-bezier(a, b, c, d)`. The first and third numbers must be between 0 and 1 |
| `scale_from` | 0.5 to 1.0. Use 1.0 for fades with no scaling |
| `reduced` | `true` makes every exported duration 0 |

### One product only: `[surface.<name>]`

The names are `spaces`, `voice`, `browser` and `site`. Each holds any of the sections above. They are
merged over the theme for that product only.

```toml
[surface.site.light]
accent = "#3f6b6a"
```

## Readable colors

A theme is refused if text is hard to read. The check uses the WCAG contrast formula. It runs for both
modes and for every product, after all merging.

- `foreground`, `strong` and `muted` on `background`, `surface` and `sunken`: at least 4.5
- `foreground` and `strong` on `selection`: at least 4.5
- `urgent`, `working`, `done` and `accent` on `background` and `surface`: at least 4.5, because the UI
  draws them as text
- `on_accent` on `accent`: at least 4.5
- `urgent`, `working`, `done` and `accent` on `sunken`: at least 3.0, because there they are indicators (dots, bars, edges), never text; the preview's code sample uses only `foreground`, `strong` and `muted` on `sunken`
- `border` is not checked

Contrast reads the same both ways round, so the danger button (`background` text on an `urgent` fill) is
covered by `urgent` on `background`.

A refusal looks like this:

```
dark.muted on dark.surface is 3.04, needs 4.5
```

Every problem is listed, not only the first.

## A full example

This file is `mine.toml`. It starts from `evening` and changes a few things.

```toml
# ~/.config/polycarp/themes/mine.toml
name = "mine"
title = "Mine"
description = "Evening with a green accent, rounder corners and slower motion."
extends = "evening"

[light]
accent = "#2f6b55"
on_accent = "#f8f9fb"
selection = "#d3e4dc"

[dark]
accent = "#8fcfb2"
on_accent = "#10201a"
selection = "#2f4a3f"

[shape]
radius_small = 8
radius = 14
radius_large = 22
shadow = 0.2

[type]
display = 'Georgia, "Times New Roman", serif'
size = 17
line_height = 1.6

[motion]
fast = 160
normal = 260
slow = 400
easing = "cubic-bezier(0.3, 0, 0.2, 1)"

# The website gets a different accent in light mode and no corners at all.
[surface.site.light]
accent = "#3f6b6a"

[surface.site.shape]
radius_small = 0
radius = 0
radius_large = 0

# Spaces is more compact.
[surface.spaces.shape]
density = "compact"
```

## Commands

| Command | What it does |
| --- | --- |
| `polycarp theme list [--json]` | Built-in and user themes. The current one is marked |
| `polycarp theme show [name] [--json]` | The full resolved theme. With no name, the current one with your accent |
| `polycarp theme current [--json]` | The theme, mode and accent in force, and any problem found |
| `polycarp theme schema` | The JSON Schema for a theme file, every field described |
| `polycarp theme get <path> [name]` | One resolved value, such as `dark.accent` or `surface.site.light.accent` |
| `polycarp theme change <path> <value> [<path> <value> ...] [--theme <name>]` | Change one value, or several at once (all checked first, one entry in history). On a built-in, makes `<name>-custom` first. `--theme` edits that user theme instead of the current one and does not switch to it |
| `polycarp theme apply <file\|-> [--name <n>] [--no-activate]` | Save a whole theme (TOML or JSON) and use it |
| `polycarp theme preview [name] [--mode light\|dark\|both] [--surface <s>] [--format html\|png] [--out <file\|folder>]` | Write an HTML page showing the theme on product UI, by default into `<config>/previews/` (private to you). `--format png` writes one image per product and mode instead, `<name>-<product>-<mode>.png`, with no browser needed; `--out` is then a folder that exists. `--out` will not replace a file that is not itself a preview |
| `polycarp theme set <name> [--mode auto\|light\|dark]` | Use a theme and write the files |
| `polycarp theme accent <#rrggbb> [--mode light\|dark]` | Override the accent. `--clear` removes it |
| `polycarp theme create <name> --extends <base> [--force]` | Write a new user theme. Not one that extends itself or loops. `undo` removes it or restores the old one; it refuses to remove one that another user theme extends, unless `--force` |
| `polycarp theme edit-path <name>` | Print the file's path |
| `polycarp theme delete <name> [--force]` | Delete a user theme. Not the current one, one it extends, or one that another user theme extends (it names them). An unreadable theme file also blocks it, since it might extend this one; `--force` goes on anyway and the copy in history lets `undo` bring it back. Deleting an unparsable theme is allowed when only other unreadable themes are in the way |
| `polycarp theme validate <file\|->` | Exit 0 if the file is valid, 1 if not. Prints every problem. A file's `name` must match its file name; with `-` the theme comes on standard input, that check is skipped and `--json` reports the name, so an app can ask before it imports a dropped file |
| `polycarp theme export <css\|json\|toml> [name] [--surface <name>]` | Print the resolved theme. With no name it is the current one in its forced mode, as in `current/`; JSON has `mode`. `toml` prints the theme's own file as written (a built-in's source), unresolved, to share or import |
| `polycarp theme undo [--force]` | Step back one change. Refuses if the theme file was edited after that change; `--force` saves the edited text in `history/` as a `.bak` copy, then undoes |
| `polycarp theme history [--json]` | Past changes, newest first |
| `polycarp theme off` | Turn the theme off: remove `current/theme.json` and `current/<surface>.css`; apps that read them use their own look when they next check. If a file can't be removed it exits 1 and names what remains. Records `enabled = false` in `[appearance]` and in history, so `undo` brings it back. Your themes stay |
| `polycarp theme on` | Turn the last theme back on and write `current/` again. `set`, `accent` and `change` also turn it on, and say so; `apply` does too, but only when it activates the theme (not with `--no-activate`). `off` works even when the settings or a theme file are broken, and both bring `current/` into line when the setting is already so |
| `polycarp theme follow [omarchy [--sync \| --if-fresh] \| reset \| off]` | On Omarchy, match its theme and follow it (see below). With no argument, report the state and the changes on top. `--sync` is what the hook runs |
| `polycarp theme reset` | Back to `polycarp`, mode `auto`, no accent. Also turns the theme on |

Every `theme` command takes `--json`.

`accent` sets the accent for both modes, or for one with `--mode`. It picks `on_accent` for you by the same
rule the check uses (at least 4.5 on the accent): the theme's own if it reads on the new accent, else black,
else white. With `--mode`, an accent that fails the contrast check is refused and nothing changes. The accent is
also drawn as text, so it needs 4.5 on `background` and `surface`, and one color almost never does that in
both light and dark. With no `--mode`, Polycarp keeps your color where it reads, moves it the smallest step
where it doesn't and tells you what it chose. With `--mode`, it takes the color exactly or refuses it. `set` keeps your accent if it still reads on the new theme. If not, it clears
it and says so.

An accent from `theme accent` applies to every product, with one exception: a value a theme sets itself
under `[surface.<product>.<mode>]` wins for that product and mode. That holds for its own `accent` and
for its own `on_accent`: setting either one keeps the product's accent pair as the theme wrote it. So `change surface.browser.light.accent
<color>` changes only the browser's light accent and leaves your global accent alone. A plain
`change light.accent` replaces the global override for that mode, and says so.

## What gets written

`set`, `accent`, `on`, `undo` and `reset` write these files in the config folder:

- `config.toml`: your choices. `[appearance]` holds `theme`, `mode`, `accent_light` and `accent_dark`, and `enabled = false` while the theme is off (the key is left out when it is on).
- `current/theme.json`: the resolved theme for every product. Whether motion is reduced is in `surfaces.<surface>.motion.reduced`; there is no top-level `reduced_motion`.
- `current/spaces.css`, `voice.css`, `browser.css`, `site.css`: the same, as CSS variables.

Voice and Browser can read these files; that support is merged but not released yet. Spaces' is coming. Until an app is updated, only the files change.

While the theme is off (`polycarp theme off`), `theme.json` and the four CSS files are removed and nothing is written there. Apps that read them use their own look when they next check; this command checks only that the files are gone. `theme current` shows `state: off` and `"enabled": false`. `off` removes a symbolic link at one of those paths (the file it points to is left alone), and `on` writes plain files, so a link is not remembered. `off` does not need a working theme: if `config.toml` is broken, it is kept in `history/` and replaced.

Files are written to a temporary name and then renamed, so a reader never sees half a file. If one of the
files is a symbolic link, the file it points to is written and the link stays. An existing file keeps its
mode; a new one is 0644.

Every command that changes something takes a lock first: an operating-system lock on a `.lock` file in
the config folder. The file is never removed, and the system frees the lock when the process ends, even
after a crash, so a live command's lock is never taken away. Another change waits up to 5 seconds, then
fails with the code `busy`, whose `retry` is `after`: nothing was written, try again later. `reset` still
works if it cannot get the lock; it warns and goes on. So several programs can change one theme at once and none of the changes is lost.

## CSS

Variables are named `--pc-<role>`, with underscores as hyphens: `--pc-on-accent`, `--pc-radius-large`,
`--pc-font-display`, `--pc-motion-normal`. Shape, type and motion go in `:root`, with the light colors as
the default. The two modes are `:root[data-theme-mode="light"]` and `:root[data-theme-mode="dark"]`. When
no mode is set on the page, `@media (prefers-color-scheme: dark)` picks dark.

When the mode is `light` or `dark` rather than `auto`, the files in `current/` are fixed to that mode.

With `reduced = true`, every duration is written as 0. `theme show` still prints the values you wrote.

## Working on a theme in a terminal

On Omarchy, any other Linux, or over SSH, the same loop works with no window and no browser. These
commands already make it interactive, so there is no separate editor:

```sh
polycarp theme create mine --extends omarchy-overrides   # or any theme: blocks, calm, ...
polycarp theme change --theme mine light.accent '#3f6b6a' shape.radius 4 shape.indicator bar
polycarp theme preview mine --format png --mode dark      # one PNG per product: look at them
polycarp theme change --theme mine dark.muted '#c9cbb9'   # adjust, preview again, repeat
polycarp theme undo                                       # step back one change
polycarp theme set mine                                   # use it when you like it
```

- `change` with several pairs is one step: one `undo` takes the whole set back, and one bad value changes nothing
  and names every bad path.
- `--theme mine` edits your theme while the current one stays in force, so you can try things without your
  desktop changing. Leave it out to edit the theme in force.
- The PNGs are 720 by 420 and draw the dock and window bar, the dictation pill, the browser side panel with a
  permission prompt, and the site, in the theme's colors, corners, borders, shadow, density and indicator. A
  terminal that shows images can show them in place (in kitty or Ghostty, `kitty +kitten icat <file>`); any
  image viewer works. The text is a pixel font, so judge colors and contrast, not the typeface.
- To edit by hand instead, open `$(polycarp theme edit-path mine)` in your editor and run `polycarp theme validate`
  on it after each save.
- `polycarp theme export toml mine` prints the file to share. `polycarp theme apply <file> --no-activate` takes it
  in on another machine.

## Undo, history and recovery

Before every change, the old `config.toml` is saved in `history/`. The last 50 are kept. Each is stamped
with the time and who made the change. Set `POLYCARP_CALLER` to name yourself. An agent should use
`agent:<name>`. The default is `user`.

`undo` puts back only the `[appearance]` table of the newest saved file, keeps any other table now in
`config.toml`, and removes that entry from history, so repeating `undo` goes back further. If the file did
not exist before, `[appearance]` is removed (and the file too, if nothing else is in it). It also puts back
a theme file that change edited, created or deleted, and says who made the change it undid. If a history
entry is damaged (a length that is not a number, a missing or contradictory field, a bad theme name) it
says so and changes nothing. Each entry records a hash of the theme text the change wrote. If the file no
longer matches, someone edited it since, and `undo` refuses with the code `changed_since` instead of
overwriting or deleting that work. `undo --force` first keeps the edited text in `history/` and then goes on. `create --force` and `delete` are recorded too, so `undo`
brings the old theme back.
A change that would leave the theme file and `config.toml` exactly as they are succeeds with a note and
`changed: false`; it is not recorded in history and `current/` is not rewritten.
If a theme file or `config.toml` cannot be written, the change is put back, its history entry is dropped
and the command fails. If only a file in `current/` cannot be written, the settings stay saved and the
command succeeds with a warning that names the files it could not write.
`reset` and `undo` work even if a user theme or `config.toml` is broken. Once `config.toml` is safe,
`reset` turns a history, lock or `current/` failure into a warning. It leaves `config.toml` readable and
writable by its owner whatever mode the old file had, and if a folder is in the file's place it moves the
folder to `config.toml.moved-<time>-<n>` and warns.
`accent` and `change` refuse while the settings in force are broken (the default theme is in use), and list
the problems, so they never quietly replace your settings. Fix the file, or run `reset`. `set` and `reset` work. If `config.toml` is invalid, the
products and `polycarp theme current` use the default theme and say what was wrong. Nothing crashes.

## On Omarchy

On Omarchy, Polycarp follows the system theme by default, and anything can be changed on top.

- `polycarp theme follow omarchy` writes two user themes. `omarchy` is generated: it extends `blocks` and fills the 13 colors for the mode Omarchy's theme has, and it is rewritten on every switch. `omarchy-overrides` extends `omarchy`, is the current theme while following, and is yours: `theme change`, `theme accent`, fonts, corners and `[surface.*]` edits go there like any user theme, so no switch touches them. They win over every later Omarchy theme.
- The mapping is the one in `spaces/scripts/gen-palettes.py`: `background`, `surface` (Omarchy's `lighter_background`), `sunken` (`dark_background`), `foreground`, `strong` (`bright_foreground`), `muted` (`dark_foreground`), `border`, `accent`, `selection`, `urgent` (`red`), `working` (`yellow`) and `done` (`green`). A key an older theme lacks falls back to the next one in a short list, then to the base theme's value (a missing `selection` is the background pulled 15% toward the text), and a note says which. `on_accent` is Omarchy's background if it reads on the accent, else black or white.
- The mode is Omarchy's `mode` (any case), or, if it is missing or unrecognized, light or dark by the background's luminance; it is not `auto`. A mode chosen with `set --mode` while following is kept as a change on top and wins over Omarchy's until `follow reset`. The other mode lists only an accent pair, with the accent moved as little as it needs to read on the base colors.
- Omarchy's colors are never refused. A color that fails the rules above is moved in lightness, by the smallest step that passes (steps of 0.2% lightness, the direction of the mode on a tie), and listed in `notes` and `data.nudges`. Text and status colors move when they must, and the accent when it fails. `background` never moves. In a palette where no text color can read on every surface at once (for example a mid-gray background with a light and a dark surface), `surface`, `sunken` and `selection` move toward the background as little as needed, and the notes say so.
- A change you make is checked when you make it, as everywhere. If a later Omarchy theme makes it unreadable, a switch keeps it, moves the failing color the smallest step (written into `omarchy-overrides.toml`, with your original recorded in `[omarchy.fits]` in `config.toml`; the file's comments are kept), and notes it. On the next switch the original is put back first, so it returns exactly when it reads again. If you edited the value yourself in between, your edit stands.
- `polycarp theme follow` shows the changes in force. `follow reset` rewrites `omarchy-overrides.toml` empty and clears the accent overrides; it is recorded, so `undo` brings them back.
- A switch writes the theme files only if something changed, adds nothing to `history/` and one line to `follow.log` in the config folder (the last 50 are kept). `follow omarchy` and `follow reset` are recorded, so `undo` goes back.
- `follow off` removes `~/.config/omarchy/hooks/theme-set.d/polycarp` if it carries Polycarp's mark on its second line, and goes back to the theme set before following, which is kept in `[omarchy]` in `config.toml`. `set` of another theme, `apply` of another theme and `reset` also remove the hook (even when `config.toml` is broken), and moved colors go back to your values first. `undo`, `on` and `reset` while following reinstall a missing hook and bring the colors up to date, so the hook exists exactly while Polycarp follows. The accents you had before following come back when it stops.
- With no `config.toml` and Omarchy present, the first `theme change`, `accent`, `on` or `reset` follows first (after checking its own arguments, so a refused request starts nothing) and says so in `notes`, with the follow's own notes and moves merged in. `set`, `apply` and `off` are choices and never follow, and an existing `config.toml` is never overridden. `follow omarchy --if-fresh`, for installers, does the same start and nothing else: it follows only when Omarchy is found and there is no `config.toml`, and otherwise exits 0 doing nothing.
- The hook's second line is `# polycarp-managed-hook: config=<config folder>`: a hook for another config folder is not ours to replace or remove. It runs the program with `timeout 5` where that exists, and writes `FAILED` lines to `follow.log` when the sync fails or the program is missing; `follow` and `doctor` report the last one.
- Error codes `no_omarchy` (no `~/.local/state/omarchy`) and `not_following` (`follow reset` while not following).

Verified: all 22 bundled Omarchy 4.0.4 themes produce a theme that passes the contrast rules (`cli/tests/omarchy.rs`, with their `colors.toml` in `cli/tests/fixtures/omarchy/`); an accent, a font, corners and a `[surface.*]` override survive switches between several of them; `follow reset`, `undo`, an override that stops reading on a later theme, and the default on first use are tested; the hook works when started as `omarchy-hook` starts it. Omarchy runs hooks with `bash <file> <theme name>`, so the file needs no executable bit. Not yet run on a live Omarchy machine.

## For agents

An agent can customize Polycarp for its user in a few calls, with no prior knowledge. Two ways in, with the
same behavior: the `polycarp theme` command with `--json`, or the `polycarp mcp` server (stdio, MCP
`2025-06-18`), whose tools call the same code. The `polycarp-theme` skill (`skills/polycarp-theme/`) walks through it.

### The workflow

1. **Read.** `theme schema` (tool `theme_schema`) is a JSON Schema, draft 2020-12. Every field has a plain
   description of what it colors or controls and where it shows, plus its range or choices and the contrast
   rules. `theme current` says what is in force. `theme get <path>` reads one value.
2. **Change the least you can.** `theme change <path> <value>` for one value, such as
   `polycarp theme change dark.accent '#8fb37a'` or `polycarp theme change shape.radius 0`. The value's type
   comes from the path. If the current theme is built in, the change goes into a new user theme
   `<name>-custom` that extends it (or `-custom-2` and so on if that name is taken), and the command says so.
   Otherwise it edits the current user theme in place and keeps its comments where it can. `theme apply <file|->`
   takes a whole theme as TOML or JSON, detected by content, from a file or standard input. Use `extends` and
   list only what changes. `--name` saves it under another name; `--no-activate` saves without using it.
   `theme accent` sets only the brand color. Use `surface.<product>.<section>.<key>` paths, or `[surface.*]`
   tables, when only one product should change.
3. **Read refusals.** Everything is checked first, and a refusal changes nothing. A built-in's name is
   refused for `apply`. Fix what the errors say; do not look for a way around the contrast rules.
4. **Preview.** `theme preview --format png` writes one image per product and mode and lists them in
   `data.images`; look at each one, change what is wrong (`theme change` takes several pairs at once), and
   preview again until it is right. `theme preview` with no format writes one self-contained HTML file with no external requests, and prints its
   path. It shows the theme on product-shaped UI: the workspace dock (nine tiles, with the theme's indicator
   style), the dictation overlay, a browser side panel with a chat turn and a permission prompt, a settings
   form, code, buttons, a delete confirmation and status text. Light and dark go side by side by default.
   Open it in a browser and take a screenshot to show the person.
5. **Undo.** `theme undo` steps back one change, including the theme file that change wrote. `theme reset`
   always works. Set `POLYCARP_CALLER=agent:<name>` on the command line so history shows who changed what.
   Over MCP the caller is recorded as `agent:<clientInfo.name>`.

### `--json`

Every `theme` command takes `--json` and prints one object on standard output, success or failure.
Exit codes: 0 ok, 1 refused or invalid, 2 usage.

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "contrast", "message": "...", "retry": "never", "suggestion": "...",
    "data": { "errors": [
      { "path": "dark.muted", "message": "dark.muted on dark.surface is 3.04, needs 4.5",
        "actual": 3.04, "needs": 4.5, "on": "dark.surface" } ] } } }
```

`error.data.errors` is always a list of `{path, message}`, with `actual` and `needs` when there are figures
(contrast ratios are numbers). For a bad value, `actual` is what was sent and `needs` says what is allowed.
Codes: `invalid_args` (exit 2), `invalid_theme`, `contrast`, `invalid_value`, `unknown_theme`, `unknown_path`,
`builtin_read_only`, `exists`, `current_theme`, `in_use`, `not_yours` (MCP only), `nothing_to_undo`, `changed_since`, `io_error`, `config_error`, `busy`, `no_omarchy`, `not_following`. Warnings and notes
(such as "a `-custom` theme was made") come in `data.warnings` and `data.notes`.

### `polycarp mcp`

JSON-RPC 2.0 over standard input and output, one message per line. It answers `initialize`,
`notifications/initialized`, `ping`, `tools/list` and `tools/call`. The server `instructions` and the tool
descriptions give the workflow above. Each tool returns the `--json` envelope as text content and as
`structuredContent`, with `isError` true on a refusal.

| Tool | Same as |
| --- | --- |
| `theme_schema`, `theme_list`, `theme_current`, `theme_show`, `theme_get` | `schema`, `list`, `current`, `show`, `get` |
| `theme_set`, `theme_accent`, `theme_change`, `theme_apply` | `set`, `accent`, `change`, `apply` (`theme` is a JSON object or a TOML string) |
| `theme_change_many` | `change` with several pairs: `changes` is a list of `{path, value}`, and `theme` names a user theme to edit instead of the current one |
| `theme_create`, `theme_delete` | `create`, `delete`, so an agent can clean up the themes it made |
| `theme_validate` | `validate`, for a draft theme passed in, without saving |
| `theme_preview`, `theme_export` | `preview`, `export` |
| `theme_follow` | `follow` (`target`: `omarchy`, `reset`, `off` or `status`). It changes the active theme, one theme file and Omarchy's hook folder, so its `destructiveHint` is true |
| `theme_off`, `theme_on` | `off`, `on`. `theme_off` removes files, so its `destructiveHint` is true; `theme_on` only writes them |
| `theme_undo`, `theme_history`, `theme_reset` | `undo`, `history`, `reset` |

An agent may delete or replace (with `theme_apply`) only a user theme it made in that connection: with
`theme_create`, a `theme_apply` that wrote a new file, or the `<name>-custom` copy a change makes of a built-in.
Any other user theme is the person's, and those two calls refuse it with the code `not_yours` unless the agent
passes `force` true, which it should do only after the person agrees. The server keeps that list in memory for
the connection only. Editing values with `theme_change` and `theme_change_many` is not guarded: it keeps the
file's comments and `theme_undo` reverses it.

`theme_preview` takes `format` (`html`, the default, or `png`). With `png` the result's `data.images` lists
`{surface, mode, path}` for each image, so an agent can look at each one and iterate before it shows the person.
`theme_preview` takes no `out`: over MCP it writes only into `<config>/previews/`. Its annotations say it
writes (`readOnlyHint` false), replaces nothing but its own pages (`destructiveHint` false) and repeats safely
(`idempotentHint` true).

Configure a client with the command `polycarp mcp` and no arguments.

