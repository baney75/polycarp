# The agent API

One contract for reading and driving the window manager from a program: queries, commands and events. The Mac app
and the Windows daemon both follow it; Linux follows it when its daemon catches up. The shapes are in
[agent-api.schema.json](agent-api.schema.json) (JSON Schema 2020-12, one `$defs` entry per result and event).

What it adds to yabai's `query` and AeroSpace's `list-*` and callbacks: every query and every event goes through the
same scope as the hands (`computer_*`), so an agent can watch and drive the whole desktop under Full Access and only its
own workspace otherwise, and Donovan's screen never changes unless he turned that on.

## Rules every platform keeps

- **Version.** Every query result, command result and event carries `"version": 1`. A change that removes or renames a
  field, or changes what one means, is version 2. Adding a field is not a new version.
- **Clients ignore unknown fields** and unknown event types. Servers may add both at any time.
- **The envelope.** Queries and commands answer in the envelope of [envelope.md](envelope.md): `{ "ok": true, "data": {...} }`
  or `{ "ok": false, "error": {...} }`. `data` is the result the schema describes. Events are not wrapped.
- **Ids.** A window id is an integer that stays the same for the window's life (macOS: the window server number;
  Windows: the HWND). A display id is a string that stays the same across sleep and reconnects (macOS: the display UUID;
  Windows: the monitor's device path). Workspaces are numbers 1 to 9.
- **Frames.** `{ "x", "y", "width", "height" }` in the units the platform places windows in (macOS points, Windows
  physical pixels), with the origin at the top left of the main display and y growing down. Displays carry `scale`.
  A window out of sight reports the frame it comes back to.
- **Where a window is.** Its `workspace` is where the window manager keeps it. Its `display` is the display showing that
  workspace, null while the workspace is out of sight. `minimized` is true only when the platform knows it: macOS knows
  it only on a workspace a display shows, and reports false elsewhere.

## Scope

Each result says what the caller could see: `"scope": "agent"` or `"scope": "all"`.

| Access (Settings > Agents) | `scope` | Windows listed, events sent |
| --- | --- | --- |
| Read Only, Default | `agent` | Windows on the agent workspace and windows of apps Donovan lent |
| Full Access | `all` | Every window the window manager places |
| A caller from another machine (connector, `--on HOST`) | `agent` | As Default, whatever the Mac's setting |

A window outside the caller's scope is left out of every list and every event: no id, app or title. Workspace numbers,
which workspace each display shows, and the displays themselves are not private and are always listed. The focused
window outside scope is reported as `"window": null`.

## View control

Commands that change what Donovan sees: `switch`, `focus`, and `move`, `frame` or `layout restore` on a window or
workspace other than the agent workspace (or onto a workspace a display is showing). They run only when all three hold:

1. The caller is on this machine (never a connector or `--on HOST`).
2. Access is Full Access.
3. Donovan turned on **Agents may change what you see** (macOS: Settings > Agents, stored as `agentViewControl` in the
   app's defaults, off by default; Windows: `agent_view_control = true` in its settings file). No command, tool or
   setting an agent can reach turns it on.

Otherwise the command fails with `permission_denied`, `retry: never`, before anything moves, and the suggestion says
which of the three is missing. Work on windows that stay on the agent workspace while it is out of sight needs none of
this and runs in Default, as `arrange` and `move` do today.

## Queries

Read only, never wait on Donovan, never change anything. One name each, the same on the command line and over MCP:

| Query | `$defs` | What it holds |
| --- | --- | --- |
| `windows` | `windows_result` | Every window in scope: id, pid, app, bundle, title, workspace, display, frame, focused, agent, minimized |
| `workspaces` | `workspaces_result` | All nine: number, name, shown (and on which display), current, agent, window count, window ids in scope |
| `displays` | `displays_result` | Every display: id, name, main, frame, visible frame (no menu bar or taskbar), scale, workspace shown, focused |
| `focused` | `focused_result` | The focused display, the workspace it shows, and the focused window (null outside scope) |
| `layout` | `layout_result` | For each workspace with windows in scope: each window's frame; plus the names of saved layouts |
| `theme` | `theme_result` | The appearance theme and palette in force, and the Polycarp theme when one draws instead |
| `state` | `state_result` | All six above in one answer, read at one moment |

Command line: `polycarp-spaces query <name> [--json]`. Without `--json` it prints a short table for a person; with it,
the envelope. `polycarp-spaces agent query <name>` always prints the envelope. MCP: the `query` tool with
`{"what": "<name>"}` (default `state`).

## Commands

Each answers with the state it read back after acting, never with what it asked for.

| Command | Arguments | Result `data` | Needs view control |
| --- | --- | --- | --- |
| `switch` | `workspace` (1 to 9), `display` (optional) | `{ version, workspace, display, shown: true }` | always |
| `focus` | `window` | `{ version, window, workspace, focused: true }` | always |
| `move` | `window`; then `workspace` or `display` | `{ version, window, workspace, display, frame }` | unless the target is the agent workspace while it is out of sight |
| `frame` | `window`, `frame` (`x,y,width,height`, absolute, as `windows` reports it) | `{ version, window, frame }` | unless the window is on the agent workspace |
| `layout` | `action` (`save`, `restore`, `list`), `name`, `workspace` (default: the agent workspace) | `layout_command_result` | `restore` on any workspace but the agent workspace |
| `theme-set` | `theme`, `palette` (optional) | `{ version, theme, palette, drawn }` | never (agents may change how the Mac looks; Donovan, 2026-11-01) |

- `move` with `display` sends the window to the workspace that display shows.
- `move` without `workspace` or `display` keeps today's meaning: onto the agent workspace, where its `--frame`
  (`left|right|full` or a fraction of the agent area) still places it.
- `frame` sets one window's position and size in display coordinates; the result is the frame read back.
- `layout save` records each window's id, app, title and frame on one workspace under `name` (letters, digits, `-` and
  `_`, at most 64). `restore` puts each window back by id, then by app and title for a window that was reopened, and
  lists the rest in `missing`. Saved layouts live in the platform's support folder, `layouts/<name>.json`.
- `drawn` is false when a Polycarp theme draws instead of the appearance theme: the value is saved and not shown.
- `focus` brings the window's app forward and switches to its workspace. It is the one command that takes keyboard
  focus, which is why it always needs view control.

Command line: `polycarp-spaces agent <command> --window 4211 --workspace 3`. MCP: one tool per command, named as in the
table with `-` spelled `_`.

## Events

`polycarp-spaces subscribe [--events workspace_switched,window_focused]` prints one JSON object per line until it is
stopped or the app quits. Over MCP, the `events` tool returns what happened after a `since` sequence number, waiting up
to `wait_ms` (at most 5000) for the first one.

Every event is `{ "version": 1, "seq": N, "at": <unix milliseconds>, "type": "...", "data": {...} }` (`$defs/event`).
`seq` rises by one per event sent to that subscriber; a gap never happens without a `lagged` event.

| Type | `data` |
| --- | --- |
| `hello` | First line, always: `scope`, `access`, the event types this server sends, and `state` (a `state_result`) |
| `workspace_switched` | `display`, `from`, `to` |
| `window_focused` | `window` (null outside scope), `workspace`, `display` |
| `window_created` | `window`: a window object as `windows` lists it |
| `window_closed` | `window` (id), `workspace` |
| `window_moved` | `window`, `from` and `to`, each `{ workspace, display, frame }`; a frame only when it is known |
| `theme_changed` | `theme`, `palette`, `polycarp_theme` |
| `lagged` | `missed`: the count of events dropped because the reader fell behind; query `state` again |

Events come from the same model the queries read: a change is reported once the window manager has applied it, never
when it was only asked for. A window that leaves the caller's scope (a lend ends) is reported as `window_closed`, and one
that enters it as `window_created`. Frame changes the window manager did not make (a person dragging a window) are
reported on its next scan, not at once.

## Timing

Measured by the contract test against the running app on an otherwise idle machine:

- Every query, and every command on a responsive app, answers in under 50 ms at the 95th percentile over 100 calls.
- Every state change a command makes is seen as an event within 100 ms of the command's answer.

## Checks

- `Tests/BaneySpacesCoreTests/AgentAPIContractTests.swift`: the schema, the examples, real query results and the event
  stream from the model, validated against the schema with no display.
- `scripts/agent-api-probe.swift`: the same against the running app, plus the timing above and an MCP client that
  calls `tools/list` and moves a test window on the agent workspace and reads it back. It acts on the agent workspace
  only and runs only when the Mac has been idle 10 minutes; otherwise it prints "untested live" and exits 3.

## Example

```json
{ "ok": true, "data": { "version": 1, "scope": "agent", "access": "default", "focused": { "display": "37D8832A-2D66-02CA-B9F7-8F30A301B230", "workspace": 1, "window": null } } }
```

```json
{ "version": 1, "seq": 7, "at": 1763400000123, "type": "workspace_switched", "data": { "display": "37D8832A-2D66-02CA-B9F7-8F30A301B230", "from": 1, "to": 3 } }
```
