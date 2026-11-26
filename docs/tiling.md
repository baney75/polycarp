# Tiling: windows side by side

Polycarp on a Mac can lay a workspace's windows side by side, so that none covers another. It is off until you turn it
on, for every workspace or one at a time. While it is off, nothing is read, watched or moved for it.

Linux and Windows have no tiling yet.

## Turn it on

- **⌃⌥T** tiles the workspace you are on, or stops and puts its windows back where they were.
- **Settings > Windows** has the same for every workspace, with the style, the gaps and the apps that are never tiled.
- `polycarp-spaces tile on` and `tile off`.

## Styles

| Style | What it does |
| --- | --- |
| `dwindle` | A new window splits the one you are in, along its long side |
| `columns` | Windows stand side by side |
| `main` | One large window, the rest in a stack beside it |
| `scrolling` | Columns in a strip that can be wider than the screen; going to a window scrolls it in |
| `floating` | Windows stay where you put them; the focus keys still go from one to the next |

In `scrolling` a window that isn't in view waits in the corner, where Polycarp parks windows of other workspaces. One
that hangs over the end of the strip by less than half stays in sight, unless it would show on the next display.

Each workspace has its own, on each display. ⌃⌥S goes to the next. A workspace's only window takes a 16:10 shape on a
wide display and all of any other (`tiling.loneWidth`).

## Keys

Every key can be changed, or taken away, in Settings > Keys or with `polycarp-spaces surfaces set tiling.keys.<name>`.
The same list with your changes: `polycarp-spaces keys`.

| Keys | What it does |
| --- | --- |
| ⌃⌥T | Tile this workspace, or stop |
| ⌃⌥ arrows | Focus the window that way, also on the next display |
| ⌃⌥] and ⌃⌥[ | Focus the next or previous tiled window |
| ⌃⌥⇧ arrows | Move the window that way, also to the next display |
| ⌃⌥⌘ arrows | Move the window's edge that way |
| ⌃⌥B | Even out every split |
| ⌃⌥R | Turn the window's split |
| ⌃⌥S | Next style |
| ⌃⌥Return | Make the window the main one |
| ⌃⌥F | Float the window, or tile it again |
| ⌃⌥M | Give the window the whole area, or put it back |
| ⌃⌥G | Make the tile a group of tabs, or take it apart |
| ⌃⌥⇧⌘ arrows | Move the window into the tile that way, or out of its group |
| ⌃⌥Tab and ⌃⌥⇧Tab | Focus the next or previous window of the group |
| ⌃⌥N | Send the window to the next display |

While VoiceOver is on it keeps the keys it uses (⌃⌥ with the arrows and more); Settings > Keys marks them.

## Groups

A group is several windows in one tile, with a strip of tabs above it. ⌃⌥G makes the tile you are in a group; a window
opened in it joins it. ⌃⌥⇧⌘ with an arrow moves the window into the tile that way, or out of its group on that side.
Click a tab to go to its window, or drop a dragged window on the strip to join. ⌃⌥G again takes the group apart.

The layout treats a group as one window. A tile under 120 points high has no strip. Groups are kept across restarts.

## The pointer

Drag a tiled window by its title bar: an outline shows where it would go. Let go over another window's edge to split it,
over its middle to trade places, or over another display. Escape, or letting go over its own place, puts it back. Hold ⇧
while letting go to float it (`tiling.floatModifier`). Pull a tiled window's edge and its neighbors follow when you let go.

The outline takes the theme's border color; `tiling { … }` in [style.css](../spaces/docs/style.md) changes it.

## What is never tiled

Windows that can't be resized, dialogs, sheets, panels and popovers, full-screen windows, Polycarp's own windows and
every window on the agent workspace. So are the windows of an app in `tiling.float` (Calculator and Stickies, until you
change it in Settings > Windows) and any window you floated. Minimized and hidden windows leave the layout and come back to
their place. The native tabs of one window take one tile.

An app may refuse a size. Polycarp learns the smallest it takes, solves the layout again and leaves it there: it tries a
size at most three times.

Layouts are kept across restarts of Polycarp and of its apps, for each workspace and display, for two weeks.

## The command

`polycarp-spaces tile <command> [--json]` asks the running app. `tile help` lists every command.

```sh
polycarp-spaces tile status            # what tiles, and the windows of the workspace in use
polycarp-spaces tile on 3              # tile workspace 3
polycarp-spaces tile focus left
polycarp-spaces tile style columns
polycarp-spaces tile off               # stop here, and put the windows back
```

`--json` prints `{"ok": true, "data": …}` with `workspace`, `tiles`, `style`, `full`, `windows` (numbers, in the layout's
order), `focused` and `tiling` (every workspace that tiles), or `{"ok": false, "error": …}`. A command with nothing to do
is refused with the reason and changes nothing. Exit 1 is a refusal, 2 a command used wrong.

The gaps, the keys and the rest of the settings are one group of surfaces.json: `polycarp-spaces surfaces get tiling`.

## MCP

| Tool | Runs |
| --- | --- |
| `tiling_status` | `polycarp-spaces tile status --json` |
| `tiling_run` | `polycarp-spaces tile <command> --json`, with `workspace` for `on` and `off` |

`tiling_run` moves the person's windows, so an agent calls it only when they asked. Through the
[gateway](agents.md) `tiling_status` needs the read scope and `tiling_run` the act scope, so a web assistant or another device given act may arrange this Mac's windows. The remote socket never takes a tile request.
