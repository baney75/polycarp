---
title: Polycarp documentation
seo_title: "Polycarp docs: install it, theme it, or let an agent do it"
description: Install Polycarp, use its one command, choose or build a theme, and let an agent customize it over MCP. Every command, theme setting and device, in plain words.
---

## Where things stand

Polycarp is Spaces and themes for macOS and Windows, with its own browser extension for reading, a library and calmer feeds (`spaces/extension`). The browser-driving extension, its CLI helper, MCP server and computer-use tools are a separate project, Tychicus: https://github.com/baney75/tychicus. The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

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

This downloads the signed app for Apple silicon, puts `polycarp` in `~/.local/bin` and opens the app, with no developer tools needed. A welcome window walks you through the permissions. Accessibility is the only one Polycarp can't run without. Polycarp's browser extension comes inside the app: in `helium://extensions` (or `chrome://extensions`), turn on Developer mode, click **Load unpacked** and pick `~/Applications/Polycarp.app/Contents/Resources/extension`. After that it updates with the app ([spaces/extension/README.md](https://github.com/baney75/polycarp/blob/main/spaces/extension/README.md)). For an assistant that drives your browser, install [Tychicus](https://github.com/baney75/tychicus), a separate extension.

To add Polycarp's companions in the same run, name them: `curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash -s -- --with tychicus,silas,shotate,local-studio` (or `--with all`). Tychicus lets agents drive your browser and apps, Silas is dictation, Shotate takes screenshots and recordings, and Local Studio runs AI models on your Mac, with Polycarp's plugin added to it. Each installs from its own installer and stays its own app; Tychicus's browser extension is separate from Polycarp's. Run at a terminal without `--with`, the installer asks once, and Return means none.

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
| `polycarp agent <command>` | One MCP gateway for Grok Bot, Claude Code, Codex and web assistants, local, over your tailnet or through a tunnel. See [Agents](https://github.com/baney75/polycarp/blob/main/docs/agents.md) |
| `polycarp install --local-studio [--uninstall]` | Adds Polycarp's plugin to Local Studio and grants its tools, so a local model can drive Polycarp. See [Agents](https://github.com/baney75/polycarp/blob/main/docs/agents.md#local-studio) |
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
| `paper_set` | Change the wallpaper in one call: what lies behind the desktop, the new tab page and the idle screen. A picture path, an https URL to a picture, `#RRGGBB` or a scene; `on` limits it to some places |
| `paper_get`, `paper_reset` | See each place's paper, or take it off so the theme's wallpaper and each place's old look come back |
| `style_example` | Read every style sheet selector and property for the top bar and the dock, with what each takes. Start here to restyle one part past the theme |
| `style_get`, `style_check` | See the style sheet in use, or list its problems with line and column |
| `style_set`, `style_unset` | Change or remove one declaration in place, keeping comments; a change that would add an error writes nothing. The grammar: [spaces/docs/style.md](../spaces/docs/style.md) |
| `style_preset` | Replace the sheet with a whole look in one call (`omarchy`: a solid dark bar, monospace, numbered workspaces with an accent line); the old sheet is kept as the next backup (`style.css.bak`, `.bak.1` and on), never written over |
| `style_restore` | Undo a preset: put the newest backup back; the sheet in force becomes the next backup, so a second call undoes the first |
| `search` | Find what the person has open (tabs, windows, terminal splits) and the web, ranked as the launcher and the new tab page rank it, with the same bangs and `search.engine`. Changes nothing |
| `search_open` | Go to the top `search` result: bring the open tab or window forward, or open the page in the default browser. Only when the person asked to go there |
| `keys_list` | Read every Polycarp keyboard shortcut: its keys (`mod` is the person's modifier), what it does, its group, where it works and when. Read-only. The same list: [docs/keys.md](https://github.com/baney75/polycarp/blob/main/docs/keys.md) |
| `filters_list`, `filter_set`, `filter_remove` | See, add or replace (by `id`), and remove the feed filters and page edits Polycarp's browser extension applies. See [Filters](#filters) |

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

### One gateway for every assistant

`polycarp agent` puts the theme tools, the files tools and the running app (its items, settings, the agent workspace, the launcher) behind one MCP server, with scopes. Claude Code, Codex and Grok Bot on this Mac use it over stdio; Grok Bot on your other devices reaches it over your tailnet; claude.ai, ChatGPT and grok.com reach it through a tunnel and connect with OAuth, and you approve each one on this Mac.

```sh
polycarp agent connect claude-code    # or codex, grokbot, claude.ai, chatgpt, grok.com
polycarp agent clients                # what is connected, with last use
```

The routes, the scopes and the threat model are in [docs/agents.md](https://github.com/baney75/polycarp/blob/main/docs/agents.md).

## Filters

Polycarp's browser extension hides posts you don't want in your feeds on X, YouTube, Reddit, Hacker News, Bluesky, LinkedIn and Mastodon, each behind a one-click Show bar, and can hide parts of a site's pages. The rules live in `filters.json`, beside `bangs.json` in `~/Library/Application Support/Polycarp/`. Open pages pick a change up within 30 seconds, new pages at once. The app need not be running to change them.

An agent calls `filters_list`, then `filter_set` with one rule; `filter_remove` takes one away. From a terminal:

```sh
polycarp-spaces filters set '{"id":"no-shorts","sites":["youtube.com"],"kinds":["shorts"]}'
polycarp-spaces filters set '{"id":"x-sidebar","sites":["x.com"],"hide":["[data-testid=sidebarColumn]"]}'
polycarp-spaces filters ls
polycarp-spaces filters rm no-shorts
polycarp-spaces filters reset       # every rule gone
```

A rule has an `id` (1 to 64 of a-z, 0-9 and -; `set` with an id in use replaces that rule), `enabled` (true unless set false), `sites` (hosts such as `youtube.com`; none means every site), and at least one of `words`, `patterns` (JavaScript regular expressions), `accounts` (handles such as `@name`), `kinds` (`shorts`, `promoted`, `reposts`) and `hide` (CSS selectors of page parts, only with `sites`). A pattern must compile, and may not repeat a group that holds a quantifier (`(a+)+`), count past `{20}`, or use a backreference or lookbehind, since any of those can stall a page on a long post. A selector may not hold `{ } ; \ @ <`, `/*`, `*/` or a line break, or leave a quote, bracket or parenthesis open. Limits: 200 rules, 200 entries a list, 200 characters an entry, 256 KiB for the file. A rule past one, or with a bad field, is refused with the field named, and nothing is written. Every command takes `--json`.

## Use your browser from Claude, ChatGPT and Grok

This is Tychicus, a separate extension: https://github.com/baney75/tychicus. Polycarp's own extension doesn't let an assistant drive your browser.

## Keys, motion and behavior

Themes cover the look. On a Mac, keys, the dock and the launcher are all in Polycarp's Settings. Every shortcut, by group and with where it works, is in [docs/keys.md](https://github.com/baney75/polycarp/blob/main/docs/keys.md); `polycarp-spaces keys` prints the same list with your modifier. Browser access is [Tychicus](https://github.com/baney75/tychicus)'s, and dictation is the [Silas](/projects/silas/docs/) app's, each with its own settings.

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

[Tychicus](https://github.com/baney75/tychicus), the browser-driving extension, reads the same theme. Its side panel takes a new theme within 5 seconds while it is open. An approval or hub page that is already open keeps the colors it opened with; reload it to see the new ones. It doesn't reload on its own, so a passcode you are typing isn't lost.

If you want apps to show their own look, run `polycarp theme off`. It removes the theme files; an app that reads them is expected to use its own look when it next checks. If a file can't be removed, `off` fails and names it.

### My accent is refused

With `--mode`, a color must read as it is. Choose one with more contrast, or leave out `--mode` and let Polycarp adjust it.

### A theme or settings file is broken

```sh
polycarp theme reset
```

This always works.

## Credits and license

The command and Spaces are MIT. Polycarp's browser extension is GPL-3.0-or-later, because it bundles the eSpeak NG phonemizer; its libraries and fonts keep their own licenses, listed in `spaces/extension`. Tychicus, the browser-driving extension, carries its own AGPL-3.0 license in [its repo](https://github.com/baney75/tychicus). The name and logo aren't covered by those licenses. Newsreader is under the SIL Open Font License.
