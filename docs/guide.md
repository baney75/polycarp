---
title: Polycarp documentation
seo_title: "Polycarp docs: install it, theme it, or let an agent do it"
description: Install Polycarp, use its one command, choose or build a theme, and let an agent customize it over MCP. Every command, theme setting and device, in plain words.
---

## Where things stand

Polycarp is being assembled from three apps: BaneySpaces, Silas and Tabkyra. Here is what works today.

- The `polycarp` command reaches all three apps.
- `polycarp theme` checks, writes, previews and undoes theme files, and agents can do the same over MCP.
- This website is built from the same six themes, and you can try them here. It doesn't read your own files.
- Voice and Browser can read your theme files. That support is merged but not released yet. Spaces' is coming. Until an app is updated, it keeps its own look and settings.
- `polycarp theme off` returns every app to its own look, and `polycarp theme on` brings your theme back.
- The apps install separately for now. The old app names still appear on your computer.

The [plan](https://github.com/baney75/polycarp/blob/main/PLAN.md) lists every step and the check that proves it.

## Install

### The command

The command needs [Rust](https://rustup.rs).

```sh
cargo install --git https://github.com/baney75/polycarp polycarp
polycarp doctor
```

`polycarp doctor` lists the apps it can reach. Exit code 0 means Spaces and Browser were both found.

### The apps

Each app has its own install guide. Add them in any order.

| Part | App | Devices today | Guide |
| --- | --- | --- | --- |
| Voice | Silas | Mac (stable), Windows and Linux (nightly) | [Silas docs](/projects/silas/docs/) |
| Workspaces | BaneySpaces | Mac | [BaneySpaces docs](/projects/baneyspaces/docs/) |
| Browser agents | Tabkyra | Chromium on a Mac. Linux and Windows are not yet tried live | [Tabkyra docs](/projects/tabkyra/docs/) |

## The command

| Command | What it does |
| --- | --- |
| `polycarp spaces [args]` | Runs the BaneySpaces command with your arguments |
| `polycarp browser [args]` | Runs the Tabkyra command with your arguments |
| `polycarp voice` | Opens Silas. Voice commands arrive later |
| `polycarp theme <command>` | Chooses and checks the theme |
| `polycarp mcp` | Serves the theme commands to an agent |
| `polycarp doctor` | Shows which apps were found |
| `polycarp --version` | Prints the version |
| `polycarp --help` | Prints the usage |

`polycarp spaces` and `polycarp browser` pass your arguments, input, output and exit code straight through.

### How it finds an app

It uses the first match:

1. An override: `POLYCARP_SPACES_BIN`, `POLYCARP_BROWSER_BIN` or `POLYCARP_VOICE_BIN`.
2. Your `PATH`.
3. The usual install folders.

It only runs absolute paths, and never a file inside your current folder or below it. If an app isn't found, it exits with code 127 and tells you where to get it.

## Themes

One theme file sets colors, corners, fonts, spacing and motion.

### Choose a theme

```sh
polycarp theme list
polycarp theme set still-water
polycarp theme set still-water --mode dark
polycarp theme current
```

`--mode` takes `auto`, `light` or `dark`. `auto` follows your system.

| Theme | What it's like |
| --- | --- |
| `polycarp` | Warm paper and moss green. The default |
| `still-water` | Quiet. Cool greys with a deep teal accent |
| `evening` | Muted slate and dusk blues |
| `parchment` | Warm paper with small corners and serif text everywhere |
| `blocks` | Square and flat, with monospace interface text. Workspaces show as numbered blocks |
| `calm` | Nothing moves. Extra room and no shadows |

Look at any of them on realistic screens before you choose:

```sh
polycarp theme preview still-water --mode both
```

It prints the path of a page you can open in any browser. Previews go in `previews/` in your settings folder unless you choose a file with `--out`. `--surface` previews one product's overrides.

### Change one thing

```sh
polycarp theme accent '#3f6b6a'
polycarp theme accent --clear
polycarp theme change shape.radius 0
polycarp theme change dark.muted '#c9cbb9'
polycarp theme get dark.accent
```

`accent` keeps your color where it reads, moves it the smallest step where it doesn't and tells you what it chose. It also picks a readable text color to go on it. With `--mode light` or `--mode dark`, it takes the color exactly for that mode or refuses it.

`change` never edits a built-in theme. The first time, it makes `<name>-custom`, which extends the built-in, and switches to it.

### Write your own

```sh
polycarp theme create mine --extends polycarp
polycarp theme edit-path mine
```

`edit-path` prints where the file is. Edit it, then check it and switch to it:

```sh
polycarp theme validate "$(polycarp theme edit-path mine)"
polycarp theme set mine
```

To remove a theme later, switch away from it first, then run `polycarp theme delete mine`. `delete` refuses a theme that another of your themes extends, and names them. `create` won't replace an existing theme unless you add `--force`.

List only what differs from the theme you extend:

```toml
name = "mine"
title = "Mine"
extends = "polycarp"

[light]
accent = "#3f6b6a"
on_accent = "#ffffff"

[shape]
radius = 4

[surface.browser.light]
accent = "#2f5d3a"
```

Or apply a whole theme in one step, from a file or from input:

```sh
polycarp theme apply mine.toml
polycarp theme apply - < mine.toml
```

`--name` saves it under another name, and `--no-activate` saves it without switching to it.

An explicit `[surface.*]` value beats a global `theme accent` for that product and mode.

### What's in a theme

| Section | Fields |
| --- | --- |
| `[light]`, `[dark]` | `background`, `surface`, `sunken`, `foreground`, `strong`, `muted`, `border`, `accent`, `on_accent`, `selection`, `urgent`, `working`, `done` |
| `[shape]` | `radius_small`, `radius`, `radius_large`, `border_width`, `blur`, `shadow`, `density`, `indicator` |
| `[type]` | `display`, `ui`, `mono`, `size`, `weight`, `line_height` |
| `[motion]` | `fast`, `normal`, `slow`, `easing`, `scale_from`, `reduced` |
| `[surface.spaces]`, `[surface.voice]`, `[surface.browser]`, `[surface.site]` | Any of the above, for that product only |

`polycarp theme schema` prints every field with its meaning and range.

### Readable by rule

A theme that would be hard to read is refused, with the exact field and number. Nothing changes.

```
dark.muted on dark.surface is 3.04, needs 4.5
```

| Pair | Needs |
| --- | --- |
| `foreground`, `strong` and `muted` on `background`, `surface` and `sunken` | 4.5 |
| `foreground` and `strong` on `selection` | 4.5 |
| `accent`, `urgent`, `working` and `done` on `background` and `surface` | 4.5 |
| `on_accent` on `accent` | 4.5 |
| `accent`, `urgent`, `working` and `done` on `sunken` | 3.0 |

These checks run on both modes and every product override.

### Get back

```sh
polycarp theme history
polycarp theme undo
polycarp theme reset
```

`undo` steps back through the last 50 changes and says who made each one. If you edited a theme file by hand after a change, `undo` won't overwrite it unless you add `--force`, which saves your text to `history/` first. `reset` returns to `polycarp`, auto mode and no accent, turns the theme on, and always works, even if a theme or settings file is broken. A broken settings file never stops anything: Polycarp warns you and uses the default. Until you fix it or reset, commands that would overwrite your broken theme refuse and tell you why.

### Turn the theme off

```sh
polycarp theme off
polycarp theme on
```

`off` removes `current/theme.json` and the `current/<product>.css` files, so each app goes back to its own look. It keeps your settings and themes, records the change in `history/`, and says what it removed. `undo` brings the theme back, and so does `polycarp theme on`. `set`, `accent` and `change` also turn the theme on, and tell you so. `polycarp theme current` shows whether it is on or off.

### Use a theme elsewhere

```sh
polycarp theme export css still-water --surface site
polycarp theme export json
polycarp theme show still-water
```

CSS variables start with `--pc-`: colors and shape use the field name, such as `--pc-accent` and `--pc-radius-large`; fonts add `font-`, such as `--pc-font-display`; and motion adds `motion-`, such as `--pc-motion-fast`.

### Where files live

| What | Where |
| --- | --- |
| Settings | `~/.config/polycarp/config.toml`, or `%APPDATA%\Polycarp\config.toml` on Windows |
| Your themes | `themes/<name>.toml` in that folder |
| Past versions | `history/` in that folder |
| What the apps read | `current/theme.json` and `current/<product>.css` in that folder. They are gone while the theme is off |

`POLYCARP_CONFIG_DIR` moves the folder on any system, and must be an absolute path. `XDG_CONFIG_HOME` also moves it on Mac and Linux.

## For agents

Over `polycarp mcp`, agents can change any part of a theme a person can. History records the agent's name. Keys and behavior stay in each app for now.

### Connect over MCP

`polycarp mcp` runs an MCP server over standard input and output.

```sh
claude mcp add polycarp -- polycarp mcp
codex mcp add polycarp -- polycarp mcp
```

Any other MCP client can start the same command.

| Tool | Use it to |
| --- | --- |
| `theme_schema` | Read every field, range and rule. Start here |
| `theme_current`, `theme_list`, `theme_show`, `theme_get` | See what exists and what's in force |
| `theme_change` | Change one value |
| `theme_apply` | Apply a whole theme, as an object or as TOML |
| `theme_accent`, `theme_set` | Set the accent or switch themes |
| `theme_validate` | Check a theme without applying it |
| `theme_preview` | Write a page to show the person, always in the private previews folder |
| `theme_export` | Get CSS or JSON |
| `theme_create`, `theme_delete` | Start a new theme file, or clean one up |
| `theme_off`, `theme_on` | Return the apps to their own look, or bring the theme back |
| `theme_history`, `theme_undo`, `theme_reset` | See changes and go back |

### The workflow

1. Read `theme_schema` and `theme_current`.
2. Make the smallest change: `theme_change` for one value, `theme_apply` for a whole look.
3. If it's refused, read the numbers and pick a better value. Don't work around the rule.
4. Call `theme_preview` and show the person.
5. Call `theme_undo` if they don't like it.
6. If the person wants the apps' own look back, use `theme_off`.

### Without MCP

Every theme command takes `--json` and prints `{"ok": true, "data": ...}` or `{"ok": false, "error": ...}`. Errors carry the path, the actual number and the number needed.

Exit codes: 0 means ok, 1 means refused or invalid, 2 means the command was used wrong. Set `POLYCARP_CALLER` to record who made a change.

The [`polycarp-theme` skill](https://github.com/baney75/polycarp/blob/main/skills/polycarp-theme/SKILL.md) teaches an agent this workflow, with worked examples.

## Keys, motion and behavior

Themes cover the look. Today, each app keeps its own keys and behavior settings:

- [BaneySpaces](/projects/baneyspaces/docs/): keys, the dock, the launcher and more, in its Settings.
- [Silas](/projects/silas/docs/): the hold-to-talk key and dictionary, in its window.
- [Tabkyra](/projects/tabkyra/docs/): site access and agents, in its side panel.

One file for all of them, with undo and a recovery key, is on the plan. Its contract is [`spaces/spec/config.md`](https://github.com/baney75/polycarp/blob/main/spaces/spec/config.md).

## Devices

| Part | Mac | Windows | Linux | iPhone and iPad | Android |
| --- | --- | --- | --- | --- | --- |
| Voice | Ships | Nightly | Nightly | In progress, iPad first | Planned |
| Workspaces | Ships | In progress | In progress | Planned: control your computer's | Planned: control your computer's |
| Browser agents | Ships | Not yet tried | Not yet tried | Planned: watch and steer your computer's | Planned: watch and steer your computer's |
| Themes | Command works | Command works | Command works | Planned | Planned |

### The top bar

Replacing the top bar is planned. On a Mac, a Polycarp bar will replace the menu bar. On Windows, a bar will reserve space across the top of the screen. On Omarchy, Polycarp will modify your existing Waybar. Phones don't allow it.

## Troubleshooting

### `polycarp spaces` says not found

Run `polycarp doctor`. If the app is installed somewhere unusual, set its override to the full path:

```sh
export POLYCARP_SPACES_BIN="$HOME/tools/baneyspaces"
```

### Not found, but the app is right here

Polycarp won't run a tool inside your current folder, including `node_modules/.bin` below it, because a project could plant one there. Move to another folder. The exceptions are `/`, and, when you are in your home folder or above it, tools under `~/.local/bin`. If the app still isn't on your `PATH` or in a usual install folder, set its override to the full path, as above.

### My theme changed nothing in the apps

Voice and Browser support for theme files is merged but not released, so the versions you can install today may not read them yet. Spaces' support is coming. This website doesn't read your files either: it has its own theme picker.

If you want an app to show its own look, run `polycarp theme off`.

### My accent is refused

With `--mode`, a color must read as it is. Choose one with more contrast, or leave out `--mode` and let Polycarp adjust it.

### A theme or settings file is broken

```sh
polycarp theme reset
```

This always works.

## Credits and license

The command, Spaces and Voice are MIT. Browser is AGPL-3.0, and builds on [0xSero's sitegeist](https://github.com/0xSero/sitegeist) and [Mario Zechner's Sitegeist](https://github.com/badlogic/sitegeist). The name and logo aren't covered by those licenses. Newsreader is under the SIL Open Font License.
