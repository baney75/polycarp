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
| `display`, `ui`, `mono` | Font family stacks, as strings: names separated by commas. A name is plain (letters, digits, spaces, hyphens, underscores) or in matching single or double quotes, with no quote, `\`, `<` or `/*` inside. Anything else, such as `url(...)`, parentheses, `;` or braces, is refused |
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
| `polycarp theme change <path> <value>` | Change one value. On a built-in, makes `<name>-custom` first |
| `polycarp theme apply <file\|-> [--name <n>] [--no-activate]` | Save a whole theme (TOML or JSON) and use it |
| `polycarp theme preview [name] [--mode light\|dark\|both] [--surface <s>] [--out <file>]` | Write an HTML page showing the theme on product UI, by default into `<config>/previews/` (private to you). `--out` will not replace a file that is not itself a preview |
| `polycarp theme set <name> [--mode auto\|light\|dark]` | Use a theme and write the files |
| `polycarp theme accent <#rrggbb> [--mode light\|dark]` | Override the accent. `--clear` removes it |
| `polycarp theme create <name> --extends <base> [--force]` | Write a new user theme. Not one that extends itself or loops. `undo` removes it or restores the old one |
| `polycarp theme edit-path <name>` | Print the file's path |
| `polycarp theme delete <name>` | Delete a user theme. Not the current one or one it extends. `undo` brings it back |
| `polycarp theme validate <file>` | Exit 0 if the file is valid, 1 if not. Prints every problem |
| `polycarp theme export <css\|json> [name] [--surface <name>]` | Print the resolved theme. With no name it is the current one in its forced mode, as in `current/`; JSON has `mode` |
| `polycarp theme undo [--force]` | Step back one change. Refuses if the theme file was edited after that change; `--force` saves the edited text in `history/` as a `.bak` copy, then undoes |
| `polycarp theme history [--json]` | Past changes, newest first |
| `polycarp theme reset` | Back to `polycarp`, mode `auto`, no accent |

Every `theme` command takes `--json`.

`accent` sets the accent for both modes, or for one with `--mode`. It picks `on_accent` for you by the same
rule the check uses (at least 4.5 on the accent): the theme's own if it reads on the new accent, else black,
else white. With `--mode`, an accent that fails the contrast check is refused and nothing changes. The accent is
also drawn as text, so it needs 4.5 on `background` and `surface`, and one color almost never does that in
both light and dark. With no `--mode`, Polycarp keeps your color where it reads, moves it the smallest step
where it doesn't and tells you what it chose. With `--mode`, it takes the color exactly or refuses it. `set` keeps your accent if it still reads on the new theme. If not, it clears
it and says so.

An accent from `theme accent` applies to every product, with one exception: a value a theme sets itself
under `[surface.<product>.<mode>]` wins for that product and mode. So `change surface.browser.light.accent
<color>` changes only the browser's light accent and leaves your global accent alone. A plain
`change light.accent` replaces the global override for that mode, and says so.

## What gets written

`set`, `accent`, `undo` and `reset` write these files in the config folder:

- `config.toml`: your choices. `[appearance]` holds `theme`, `mode`, `accent_light` and `accent_dark`.
- `current/theme.json`: the resolved theme for every product.
- `current/spaces.css`, `voice.css`, `browser.css`, `site.css`: the same, as CSS variables.

Products read these files once their adapters land. Until then only the files change.

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
`reset` turns a history, lock or `current/` failure into a warning.
`accent` and `change` refuse while the settings in force are broken (the default theme is in use), and list
the problems, so they never quietly replace your settings. Fix the file, or run `reset`. `set` and `reset` work. If `config.toml` is invalid, the
products and `polycarp theme current` use the default theme and say what was wrong. Nothing crashes.

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
4. **Preview.** `theme preview` writes one self-contained HTML file with no external requests, and prints its
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
`builtin_read_only`, `exists`, `current_theme`, `nothing_to_undo`, `changed_since`, `io_error`, `config_error`, `busy`. Warnings and notes
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
| `theme_validate` | `validate`, for a draft theme passed in, without saving |
| `theme_preview`, `theme_export` | `preview`, `export` |
| `theme_undo`, `theme_history`, `theme_reset` | `undo`, `history`, `reset` |

`theme_preview` takes no `out`: over MCP it writes only into `<config>/previews/`. Its annotations say it
writes (`readOnlyHint` false), replaces nothing but its own pages (`destructiveHint` false) and repeats safely
(`idempotentHint` true).

Configure a client with the command `polycarp mcp` and no arguments.

