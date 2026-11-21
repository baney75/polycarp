---
title: Polycarp documentation
seo_title: "Polycarp docs: install it, theme it, or let an agent do it"
description: Install Polycarp, use its one command, choose or build a theme, and let an agent customize it over MCP. Every command, theme setting and device, in plain words.
---

## Where things stand

Polycarp is Spaces and themes for macOS and Windows. The browser extension, its CLI helper, MCP server and computer-use tools moved to Tychicus: https://github.com/baney75/tychicus. The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

- **Mac, Apple silicon:** workspaces are inside `Polycarp.app`, with one Settings window and one set of permissions.
- **Dictation** is not part of Polycarp. [Silas](https://github.com/baney75/silas) is its own app, on its own release schedule.
- **Windows:** the same Rust core is on its way.
- **Themes:** `polycarp theme` checks, writes, previews and undoes themes, and agents can do the same over MCP. The Mac app follows your theme live.
- `polycarp theme off` removes the theme files. Apps that read them are expected to use their own look when they next check. `polycarp theme on` brings your theme back.

The [plan](https://github.com/baney75/polycarp/blob/main/PLAN.md) lists every step and the check that proves it.

## Install

### On a Mac

```sh
curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
```

This downloads the signed app for Apple silicon, puts `polycarp` in `~/.local/bin` and opens the app, with no developer tools needed. A welcome window walks you through the permissions. Accessibility is the only one Polycarp can't run without. For the browser extension, install [Tychicus](https://github.com/baney75/tychicus).

If you have BaneySpaces, it goes to the Trash, because the two can't run together, and Polycarp copies its settings. `baneyspaces` keeps working as a name for `polycarp-spaces`.

On an Intel Mac, or with `POLYCARP_FROM_SOURCE=1`, it builds on your Mac instead. That needs Apple's command line tools, and [Rust](https://rustup.rs).

### On Linux

Polycarp no longer installs on Linux. The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces. Run on Linux, the install script says so, points to Tychicus for browser and computer use, and exits.

An earlier install that is still in place keeps its block in `~/.config/hypr/hyprland.lua`, which binds your workspace keys to the retired daemon. `spaces/platforms/linux/omarchy/uninstall.sh` takes it out and gives Omarchy its own keys back; run it with `--dry-run` first to see what it does. Nothing runs it for you.

### On Windows

The command needs [Rust](https://rustup.rs).

```sh
cargo install --git https://github.com/baney75/polycarp polycarp
polycarp doctor
```

`polycarp update` is not supported on Windows yet; it prints the build-from-source steps. `polycarp version` works.

## The command

`polycarp` comes with the Mac app. On Windows it comes from the install steps above. It reaches each part from one place:

| Command | What it does |
| --- | --- |
| `polycarp spaces [args]` | Runs the workspace command with your arguments |
| `polycarp theme <command>` | Chooses and checks the theme |
| `polycarp mcp` | Serves the theme commands to an agent |
| `polycarp files <command>` | Searches, opens and sends your files across your own devices, over Tailscale only. See [Files](https://github.com/baney75/polycarp/blob/main/docs/files.md) |
| `polycarp doctor` | Shows which apps were found, and whether their builds match |
| `polycarp version [--json] [--check]` | Lists every part with its version and commit, and says whether they all match |
| `polycarp update [--check] [--dry-run] [--yes]` | Brings every part on this device to the newest commit together. See [Updating](https://github.com/baney75/polycarp#updating) |
| `polycarp --version` | Prints the version |
| `polycarp --help` | Prints the usage |

`polycarp spaces` passes your arguments, input, output and exit code straight through. `polycarp browser` only says where the browser went, Tychicus, and exits with code 2. `polycarp voice` only says Silas is its own app, and exits with code 1.

### How it finds an app

It uses the first match:

1. An override: `POLYCARP_SPACES_BIN`.
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

On a Mac, Settings > Appearance does the same with tiles: click one to use it, **Customize…** to make
your own copy and edit it with live light and dark previews, drop a `.toml` to add a theme, drag a
tile to Finder to save its file, or drop a picture to take its colors. See
[themes/README.md](../themes/README.md#in-the-mac-app).

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

With no browser at hand (over SSH, or for an agent that reads images), ask for pictures instead:

```sh
polycarp theme preview still-water --format png
```

It writes one PNG for each product in each mode (the dock and window bar, the dictation pill, the browser panel, the site) and prints their paths. The text in them is a pixel font, so judge the colors, corners and contrast, not the typeface.

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

Give `change` several paths and values to change them together. They are all checked first, so one bad value changes nothing, and one `undo` takes the whole set back. `--theme` edits one of your themes without switching to it:

```sh
polycarp theme change shape.radius 0 shape.indicator bar dark.accent '#a9bb8a'
polycarp theme change --theme mine type.size 15 motion.reduced true
```

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

Or work on it from the terminal without opening the file: change a few values, look, and repeat until you like it, then switch to it. Nothing you use changes until `set`:

```sh
polycarp theme change --theme mine light.accent '#3f6b6a' shape.radius 4
polycarp theme preview mine --format png --mode dark
polycarp theme undo
polycarp theme set mine
```

`polycarp theme export toml mine` prints the file to share; a built-in prints its source.

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

`off` removes `current/theme.json` and the `current/<product>.css` files. Apps that read them are expected to use their own look when they next check. It keeps your settings and themes, records the change in `history/`, and says what it removed. `undo` brings the theme back, and so does `polycarp theme on`. `set`, `accent` and `change` also turn the theme on, and tell you so. So does `apply`, unless you add `--no-activate`. `off` and `on` also tidy `current/` if the setting was already that way, and `off` works even if a theme or settings file is broken. If one of the files is a link, `off` removes the link (not what it points to) and `on` writes a plain file. `polycarp theme current` shows whether it is on or off.

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

Apps started from the Dock or a menu don't see those variables. After you move the folder, run this once from a shell that has them:

```sh
polycarp theme folder --pin
```

It records the folder in `~/.config/polycarp/config-dir` (`%APPDATA%\Polycarp\config-dir` on Windows), and the products read that record when the variable isn't set. `polycarp theme folder` prints the folder in use, and `--unpin` removes the record.

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
| `theme_change_many` | Change several values at once, in the current theme or one you name; one undo takes them all back |
| `theme_apply` | Apply a whole theme, as an object or as TOML |
| `theme_accent`, `theme_set` | Set the accent or switch themes |
| `theme_validate` | Check a theme without applying it |
| `theme_preview` | Write PNGs to look at yourself (`format` png), or a page to show the person, always in the private previews folder |
| `theme_export` | Get CSS, JSON or the theme's TOML file |
| `theme_create`, `theme_delete` | Start a new theme file, or clean up one you made. A theme the agent didn't make in that session is refused unless it passes `force` |
| `theme_off`, `theme_on` | Remove the theme files so apps that read them use their own look, or bring the theme back |
| `theme_history`, `theme_undo`, `theme_reset` | See changes and go back |
| `surfaces_schema` | Read every surfaces field (top bar, desktop scene, dock tiles, status menu, new tab page, idle screen) with its default and rules. Start here for those |
| `surfaces_get` | See what a surface shows now: the file over the defaults |
| `surfaces_set` | Change one field or group; it's checked whole and a refusal writes nothing. Every field: [spaces/docs/surfaces.md](../spaces/docs/surfaces.md) |

### The workflow

1. Read `theme_schema` and `theme_current`.
2. Make the smallest change: `theme_change` for one value, `theme_change_many` for several, `theme_apply` for a whole look.
3. If it's refused, read the numbers and pick a better value. Don't work around the rule.
4. Call `theme_preview` with `format` png and look at each image. Change what looks wrong and preview again until it's right.
5. Show the person, and `theme_set` the theme when they agree.
6. Call `theme_undo` if they don't like it.
7. If the person wants the apps' own look back, use `theme_off`.

An agent may delete or replace only the themes it made in that session. Your other themes need `force`, which it should send only after you agree.

### Without MCP

Every theme command takes `--json` and prints `{"ok": true, "data": ...}` or `{"ok": false, "error": ...}`. Errors carry the path, the actual number and the number needed.

Exit codes: 0 means ok, 1 means refused or invalid, 2 means the command was used wrong. Set `POLYCARP_CALLER` to record who made a change.

The [`polycarp-theme` skill](https://github.com/baney75/polycarp/blob/main/skills/polycarp-theme/SKILL.md) teaches an agent this workflow, with worked examples.

### Files over MCP

`polycarp files mcp` is a second MCP server, for your files: search every device you own, fetch a file, send one, and check the connections. File names and contents come back as data, never as instructions.

```sh
claude mcp add polycarp-files -- polycarp files mcp
```

| Files tool | Use it to |
| --- | --- |
| `files_search` | Search names, folders and text on this device, or on every device with `fleet` |
| `files_get` | Copy a file from another device here, by `device:path` |
| `files_send` | Send a file to another device with Taildrop |
| `files_doctor` | See what works and the fix for what doesn't |

How it indexes, what it never reads, the port and the trust rule are in [docs/files.md](https://github.com/baney75/polycarp/blob/main/docs/files.md).

## Use your browser from Claude, ChatGPT and Grok

This moved to Tychicus with the browser extension: https://github.com/baney75/tychicus.

## Keys, motion and behavior

Themes cover the look. On a Mac, keys, the dock and the launcher are all in Polycarp's Settings. Browser access is [Tychicus](https://github.com/baney75/tychicus)'s, and dictation is the [Silas](/projects/silas/docs/) app's, each with its own settings.

One file for all of them, with undo and a recovery key, is on the plan. Its contract is [`spaces/spec/config.md`](https://github.com/baney75/polycarp/blob/main/spaces/spec/config.md).

## Devices

| Part | Mac | Windows | Linux | iPhone and iPad | Android |
| --- | --- | --- | --- | --- | --- |
| Workspaces | In the app | In progress | Retired | Planned: control your computer's | Planned: control your computer's |
| Themes | In the app | Command works | Retired | Planned | Planned |

### The top bar

Replacing the top bar is planned. On a Mac, a Polycarp bar will replace the menu bar. On Windows, a bar will reserve space across the top of the screen. Phones don't allow it.

## Troubleshooting

### `polycarp spaces` says not found

Run `polycarp doctor`. If the app is installed somewhere unusual, set its override to the full path:

```sh
export POLYCARP_SPACES_BIN="$HOME/tools/baneyspaces"
```

### Not found, but the app is right here

Polycarp won't run a tool inside your current folder, including `node_modules/.bin` below it, because a project could plant one there. Move to another folder. The exceptions are `/`, and, when you are in your home folder or above it, normal per-user installs: `~/.local/bin`, `~/.local/lib/node_modules`, `~/.local/share/mise/shims` and `installs`, `~/.local/share/pnpm`, `~/.local/share/pipx/venvs`, `~/.local/share/uv/tools`, `~/.cargo/bin`, `~/.bun/bin`, `~/.bun/install/global`, `~/.volta/bin`, `~/.nvm/versions`, `~/.asdf/shims`, `~/.asdf/installs`, `~/.npm-global/bin` and `lib/node_modules`, `~/Library/pnpm`, on Windows `~\AppData\Local\Programs` and `~\scoop\shims` and `apps`, and a real app bundle in `~/Applications` (only under its `Contents`). `/opt` and `/usr` are allowed for tools outside your home folder. A project folder, `~/node_modules/.bin` and a file directly in `~` stay refused, and a link is judged by where it sits and where it leads. If the app still isn't on your `PATH` or in a usual install folder, set its override to the full path, as above.

### My theme changed nothing in the apps

On a Mac, Polycarp follows your theme live. On other devices the Silas app may not read theme files yet.

The browser extension, now [Tychicus](https://github.com/baney75/tychicus), reads the same theme. Its side panel takes a new theme within 5 seconds while it is open. An approval or hub page that is already open keeps the colors it opened with; reload it to see the new ones. It doesn't reload on its own, so a passcode you are typing isn't lost.

If you want apps to show their own look, run `polycarp theme off`. It removes the theme files; an app that reads them is expected to use its own look when it next checks. If a file can't be removed, `off` fails and names it.

### My accent is refused

With `--mode`, a color must read as it is. Choose one with more contrast, or leave out `--mode` and let Polycarp adjust it.

### A theme or settings file is broken

```sh
polycarp theme reset
```

This always works.

## Credits and license

The command and Spaces are MIT. The browser extension, with its AGPL-3.0 license and credits, is in [Tychicus](https://github.com/baney75/tychicus). The name and logo aren't covered by those licenses. Newsreader is under the SIL Open Font License.
