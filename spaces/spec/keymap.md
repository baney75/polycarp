# Keymap: one file for every key (Windows today)

`config.md` holds the `[keys]` contract for all three platforms. This page says what the Windows daemon does with it
now, and what it doesn't do yet. The default chords are the Windows column of `keys.json`.

## The file

`%APPDATA%\BaneySpaces\config.toml` (or `config.toml` in `BANEYSPACES_CONFIG_DIR` when that is set). No file means the
defaults. `baneyspaces state` names the file it reads under `keys.config`.

```toml
[keys]
mod = "win"                        # win (the default), ctrl or alt

[keys.bindings]
"mod+1" = "switch 3"               # rebind a default
"mod+alt+j" = "switch 2"           # add a chord: any CLI command line
"mod+alt+left" = "none"            # unbind a default
"mod+ctrl+alt+l" = "window resize 100 0"
```

Bindings go over the defaults: a chord the file names replaces the default on that chord, `none` removes it, and
every other default stays.

## Chords

Modifiers, then one key, joined with `+`. Modifiers: `mod`, `win`, `ctrl`, `alt`, `shift`. A chord needs at least one of
`win`, `ctrl` or `alt` (after `mod` is read), so a bare letter or Shift+letter can never be taken from your typing.
Keys: `0` to `9`, `a` to `z`, `f1` to `f24`, `left`, `right`, `up`, `down`, `grave`, `escape`, `return`, `space`,
`tab`, `backspace`, `insert`, `delete`, `home`, `end`, `pageup`, `pagedown`, `minus`, `equal`, `comma`, `period`,
`slash`, `semicolon`, `quote`, `bracketleft`, `bracketright`, `backslash`.

`win+shift+escape` is the recovery chord and can't be bound. On Windows it is only reserved: holding it to reset the
keys and theme is not built yet.

## Actions

An action is a `baneyspaces` command line, checked when the file is read. The defaults (with `mod` = `win`):

| Chord | Action |
| --- | --- |
| Win+1 to Win+9 | `switch n` |
| Win+Shift+1 to Win+Shift+9 | `move n` |
| Win+` | `agent-workspace toggle` |
| Win+Alt+arrow | `window focus <dir>`: the nearest window you can see that way comes to the front |
| Win+Alt+Shift+arrow | `window swap <dir>`: the front window trades frames with the nearest one that way |
| Win+Ctrl+Alt+arrow | `window resize`: 40 px narrower (left), wider (right), shorter (up) or taller (down), top-left kept, never under 100 x 100 |
| Win+Alt+. | `window display next`: the front window goes to the next display, same place and size there, and joins the workspace that display shows |

"Nearest" is measured between the windows' middles: distance along the arrow plus twice the distance across it, so a
window straight across wins over a closer one far off to the side. Only windows on the workspace you see count.

Not on Windows yet: `exec` and `mode` (a file using either is refused with that path), and `[keys.modes]` (read, logged
as ignored, not refused).

## Reload

The daemon watches the folder. A saved file is in force within 1 s (CI measures it, `tests/ci/keymap.ps1`), and the
log says `keys: N bindings from config.toml, X ms after the change`. Saving the same text again does nothing.

A file that does not parse or validate changes nothing: the keys in force stay, the log says
`keys: <file> not applied, the keys in force stay: <reason>`, and `state` shows the reason under `keys.error` until a
good file replaces it. The reason starts with the exact path, for example
`keys.bindings."mod+alt+j": "warp 9": unknown command "warp"`, `keys.mod: "super" is not win, ctrl or alt`, or
`keys.bindings: no key is left to switch workspaces`. A file that is already bad when the daemon starts gives the
defaults.

## Elevated windows

Windows keeps a program that is not elevated from seeing keys typed into one that is (UIPI). While an elevated
window is in front (Task Manager, an administrator terminal, an installer), **no BaneySpaces chord works**: the keys go
to that window as if BaneySpaces were not running. The daemon doesn't ask for UI access and doesn't run elevated.

So the failure is never silent, the daemon checks each window that comes to the front. When it is elevated, the log
says `keys: <program> runs as administrator and is in front; ... your BaneySpaces keys do nothing until another window
is in front`, and `state` shows the program under `keys.blocked_by`; both clear when another window comes to the front.
An on-screen notice comes with the window bar (part 2). Untested live on Windows: the CI runner's own session is
elevated, so it has no window above the daemon.
