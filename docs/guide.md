---
title: Polycarp documentation
seo_title: "Polycarp docs: install it, theme it, or let an agent do it"
description: Install Polycarp, use its one command, choose or build a theme, and let an agent customize it over MCP. Every command, theme setting and device, in plain words.
---

## Where things stand

Polycarp is one app for your workspaces, your voice and the browser your agents use. It's early, and it's arriving one device at a time.

- **Mac, Apple silicon:** workspaces, dictation and browser agents are all inside `Polycarp.app`, with one Settings window and one set of permissions.
- **Other devices:** the same Rust core is on its way to them. Until then, Silas offers nightly voice builds on Windows and Linux, and Tabkyra's installer for them is written but not yet tried live. Those repos stay up.
- **Themes:** `polycarp theme` checks, writes, previews and undoes themes, and agents can do the same over MCP. The Mac app follows your theme live. On Omarchy, Polycarp matches your system theme, and you can still change anything; that hasn't run on a real theme switch yet.
- `polycarp theme off` removes the theme files. Apps that read them use their own look when they next check. `polycarp theme on` brings your theme back.

The [plan](https://github.com/baney75/polycarp/blob/main/PLAN.md) lists every step and the check that proves it.

## Install

### On a Mac

```sh
curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
```

This downloads the signed app for Apple silicon, puts `polycarp` in `~/.local/bin` and opens the app, with no developer tools needed. A welcome window walks you through the permissions. Accessibility is the only one Polycarp can't run without. Browser agents take one more step: Settings > Browser walks you through loading the extension in Chromium.

If you have BaneySpaces, it goes to the Trash, because the two can't run together, and Polycarp copies its settings. Silas stays installed and Polycarp copies its dictionary and models. Once dictation works for you, **Move Silas to the Trash** in Settings > Voice finishes the job. With voice turned off, Silas keeps working as it always did. Your own `tabkyra` keeps working too, and `baneyspaces` keeps working as a name for `polycarp-spaces`.

On an Intel Mac, or with `POLYCARP_FROM_SOURCE=1`, it builds on your Mac instead. That needs Apple's command line tools, [Rust](https://rustup.rs), [Bun](https://bun.sh) and [Node](https://nodejs.org).

### On Linux

The same install script needs [Rust](https://rustup.rs) and installs the `polycarp` command and every theme. On Omarchy it also turns on matching your system theme. The app for Linux is on the way.

### On Windows

The command needs [Rust](https://rustup.rs).

```sh
cargo install --git https://github.com/baney75/polycarp polycarp
polycarp doctor
```

## The command

`polycarp` comes with the Mac app. On Linux and Windows it comes from the install steps above. It reaches each part from one place:

| Command | What it does |
| --- | --- |
| `polycarp spaces [args]` | Runs the workspace command with your arguments |
| `polycarp browser [args]` | Runs the browser helper with your arguments |
| `polycarp voice` | Opens the Voice settings in Polycarp, or Silas if Polycarp isn't installed |
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

To remove a theme later, switch away from it first, then run `polycarp theme delete mine`. `delete` refuses a theme that another of your themes extends, and names them. It also refuses while a theme file can't be read, since that file might extend it; `delete <name> --force` goes on anyway and keeps a copy in `history/`, and an unreadable theme can itself be deleted when only other unreadable themes are in the way. `create` won't replace an existing theme unless you add `--force`.

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

`off` removes `current/theme.json` and the `current/<product>.css` files. Apps that read them use their own look when they next check. It keeps your settings and themes, records the change in `history/`, and says what it removed. `undo` brings the theme back, and so does `polycarp theme on`. `set`, `accent` and `change` also turn the theme on, and tell you so. So does `apply`, unless you add `--no-activate`. `off` and `on` also tidy `current/` if the setting was already that way, and `off` works even if a theme or settings file is broken. If one of the files is a link, `off` removes the link (not what it points to) and `on` writes a plain file. `polycarp theme current` shows whether it is on or off.

### Use a theme elsewhere

```sh
polycarp theme export css still-water --surface site
polycarp theme export json
polycarp theme show still-water
```

CSS variables start with `--pc-`: colors and shape use the field name, such as `--pc-accent` and `--pc-radius-large`; fonts add `font-`, such as `--pc-font-display`; and motion adds `motion-`, such as `--pc-motion-fast`.

### On Omarchy

On Omarchy, Polycarp can match the system theme and change with it, and you can still change anything on top. The Polycarp installer turns this on for you by running `polycarp theme follow omarchy --if-fresh`, which follows only if Omarchy is found and Polycarp has no settings yet, and does nothing (exit 0) otherwise. Without the installer, the first of `theme change`, `theme accent`, `theme on` or `theme reset` on such a machine starts following by itself and says so in its notes. `theme set`, `theme apply` and `theme off` are choices and are respected, and an existing settings file is never overridden.

```sh
polycarp theme follow
polycarp theme follow omarchy
polycarp theme follow reset
polycarp theme follow off
```

**What following does.** `follow omarchy` reads the colors of the theme Omarchy is using, builds a theme named `omarchy` on top of `blocks` (square corners, a monospace face: Omarchy's own look), and makes `omarchy-overrides` current, in the mode Omarchy's theme has. It adds a small hook at `~/.config/omarchy/hooks/theme-set.d/polycarp`; Omarchy runs it after every theme switch and Polycarp updates the colors. The hook prints nothing, asks nothing, gives the sync 5 seconds where the `timeout` command exists, and always exits 0, so it cannot break or stall Omarchy's switch. If the sync fails, or the program the hook calls is gone, a line starting `FAILED` goes to `follow.log` in the config folder, and `follow` and `doctor` show the last one. The hook names its config folder: a hook for another folder, or any file that is not Polycarp's, is never replaced or removed; the command refuses and names it.

**Change anything on top.** While following, use the usual commands: `theme accent '#ffcc66'`, `theme accent`, a font, corners, a `surface.<product>` override, or `theme set omarchy-overrides --mode light`. They go into `omarchy-overrides.toml`, the accent settings and a mode choice. A switch of Omarchy's theme does not overwrite them: your change wins over every later Omarchy theme, and changing something never stops following. `polycarp theme follow` lists the changes in force. `polycarp theme follow reset` clears them, the mode choice too, and returns to Omarchy's own colors; `undo` reverses one change, or the reset. `theme set omarchy` while following means `omarchy-overrides`.

**Readable by rule.** Omarchy's colors are kept exactly wherever they already read well. If one would fail the contrast rules (a muted gray on a dark background, say), only that color moves, by the smallest change in lightness that passes, and the command lists each move in `notes`. A theme is never refused: in the rare palette where no text color reads on every one of its surfaces at once, a surface, sunken or selection color moves toward the background, and the background itself never moves. Your changes are checked when you make them. If a later Omarchy theme makes one unreadable, the switch still goes through: that color is moved the smallest step, written into `omarchy-overrides.toml` with your original remembered, and noted. When a theme where your color reads comes back, your exact color is back.

**Stopping.** `follow off` removes only Polycarp's own hook and goes back to the theme, mode and accents you had before. `theme set <other>` does the same and says so. Your changes stay in `omarchy-overrides.toml` (a mode choice is not kept); `follow omarchy` picks them up again. After `undo`, `reset` or `on`, Polycarp puts the hook and the colors in line with the settings, and `follow` and `doctor` say when they disagree. On a machine without Omarchy, `follow omarchy` exits with an error and changes nothing, and no command behaves differently.

What is verified: the mapping and the readability rule hold for all 22 themes that ship with Omarchy 4.0.4 (their `colors.toml` files are test data, checked against an independent copy of the mapping), changes survive switches between several of them, and the hook runs correctly when started the way Omarchy's `omarchy-hook` starts it (`bash <file> <theme name>`). Not yet run on a live Omarchy machine.

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
| `theme_off`, `theme_on` | Remove the theme files so apps that read them use their own look, or bring the theme back |
| `theme_follow` | On Omarchy, match the system theme and follow it, keeping your changes on top (`target` omarchy, reset, off, or leave out to see the state and the changes) |
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

Themes cover the look. On a Mac, keys, the dock, the launcher, dictation and browser access are all in Polycarp's Settings. On Windows and Linux, see the [Silas](/projects/silas/docs/) and [Tabkyra](/projects/tabkyra/docs/) docs.

One file for all of them, with undo and a recovery key, is on the plan. Its contract is [`spaces/spec/config.md`](https://github.com/baney75/polycarp/blob/main/spaces/spec/config.md).

## Devices

| Part | Mac | Windows | Linux | iPhone and iPad | Android |
| --- | --- | --- | --- | --- | --- |
| Voice | In the app | Nightly, as Silas | Nightly | In progress, iPad first | Planned |
| Workspaces | In the app | In progress | In progress | Planned: control your computer's | Planned: control your computer's |
| Browser agents | In the app | Not yet tried | Not yet tried | Planned: watch and steer your computer's | Planned: watch and steer your computer's |
| Themes | In the app | Command works | Command works; Omarchy matching not yet tried live | Planned | Planned |

### The top bar

Replacing the top bar is planned. On a Mac, a Polycarp bar will replace the menu bar. On Windows, a bar will reserve space across the top of the screen. On Omarchy, Polycarp will modify your existing Waybar. Phones don't allow it.

## Troubleshooting

### `polycarp spaces` says not found

Run `polycarp doctor`. If the app is installed somewhere unusual, set its override to the full path:

```sh
export POLYCARP_SPACES_BIN="$HOME/tools/baneyspaces"
```

### Not found, but the app is right here

Polycarp won't run a tool inside your current folder, including `node_modules/.bin` below it, because a project could plant one there. Move to another folder. The exceptions are `/`, and, when you are in your home folder or above it, normal per-user installs: `~/.local/bin`, `~/.local/lib/node_modules`, `~/.local/share/mise`, `~/.cargo/bin`, `~/.bun/bin`, `~/.bun/install/global`, `~/.volta/bin`, `~/.nvm/versions`, `~/.asdf/shims`, `~/.asdf/installs`, `~/.npm-global`, `~/Library/pnpm`, `~/.config/tabkyra`, on Windows `~\AppData\Local\Programs` and `~\scoop`, and a real app bundle in `~/Applications` (only under its `Contents`). `/opt` and `/usr` are allowed for tools outside your home folder. A project folder, `~/node_modules/.bin` and a file directly in `~` stay refused, and a link is judged by where it sits and where it leads. If the app still isn't on your `PATH` or in a usual install folder, set its override to the full path, as above.

### My theme changed nothing in the apps

On a Mac, Polycarp follows your theme live. On other devices the Silas and Tabkyra apps may not read theme files yet.

If you want apps to show their own look, run `polycarp theme off`. It removes the theme files; an app that reads them uses its own look when it next checks. If a file can't be removed, `off` fails and names it.

### My accent is refused

With `--mode`, a color must read as it is. Choose one with more contrast, or leave out `--mode` and let Polycarp adjust it.

### A theme or settings file is broken

```sh
polycarp theme reset
```

This always works.

## Credits and license

The command, Spaces and Voice are MIT. Browser is AGPL-3.0, and builds on [0xSero's sitegeist](https://github.com/0xSero/sitegeist) and [Mario Zechner's Sitegeist](https://github.com/badlogic/sitegeist). The name and logo aren't covered by those licenses. Newsreader is under the SIL Open Font License.
