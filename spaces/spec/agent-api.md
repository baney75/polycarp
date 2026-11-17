# The agent API

One contract for reading and driving the window manager from a program: queries, commands and events. The Mac app
and the Windows daemon both follow it; Linux follows it when its daemon catches up. The shapes are in
[agent-api.schema.json](agent-api.schema.json) (JSON Schema 2020-12, one `$defs` entry per result and event).

What it adds to yabai's `query` and AeroSpace's `list-*` and callbacks: every query and every event goes through the
same scope as the hands (`computer_*`), so an agent can watch and drive the whole desktop under Full Access and only its
own workspace otherwise, and no window or workspace Donovan can see changes unless he turned that on. `theme-set` is
the one stated exception: agents may change how the Mac looks.

**Who reaches what.** That promise covers the agent API and the URL scheme. Any program, and a web page after one
browser prompt, can open `polycarp://switch/N`, `move/N` or `restore`, so those URLs follow the view control rule
below. The control socket (`polycarp-spaces focus`, `send`, `switch`, `move`, `restore`) trusts every process running
as Donovan. It is a convenience channel, not an agent boundary: nothing a process of his holds tells his shell from an
agent in that shell, so the socket does not try. Polycarp's own scripts and probes use it.

## Rules every platform keeps

- **Version.** Every query result, command result and event carries `"version": 1`. A change that removes or renames a
  field, or changes what one means, is version 2. Adding a field is not a new version.
- **Clients ignore unknown fields** and unknown event types. Servers may add both at any time.
- **The envelope.** Queries and commands answer in the envelope of [envelope.md](envelope.md): `{ "ok": true, "data": {...} }`
  or `{ "ok": false, "error": {...} }`. `data` is the result the schema describes. Events are not wrapped.
- **Ids.** A window id is an integer that stays the same for the window's life (macOS: the window server number;
  Windows: the HWND). A display id is a string that stays the same across sleep and reconnects (macOS: the display UUID;
  Windows: the monitor's device path). Workspaces are numbers 1 to 9. A window id is never kept past the window's life:
  macOS reuses window server numbers after a restart and Windows reuses HWNDs, so anything saved names windows by
  identity instead.
- **Window identity.** A window that must be known again once its id is gone (a saved layout, an app relaunched, a
  restart) is known by `{ bundle, title, order }` (`$defs/window_identity`): its app's bundle id (Windows, and a macOS
  process with no bundle id: the full path of its executable; `bundle` is never empty), its title, and its creation order among its process's windows, oldest first. A saved window
  matches a live window of the same bundle by the same title, then by the same title under the title rules (lowercase;
  an unsaved-changes mark, an unread count in front and an "Edited" note left out). Creation order decides only when
  no saved window of that bundle matches a live one by title and the saved and live counts of that bundle agree; a
  window that only shares an order with a renamed one is missing, never moved. Each saved window matches at most one live window. One that matches none is skipped and never moved. Only ordinary
  windows are saved, never a dialog, sheet or panel. Polycarp's own restore after a restart keeps windows by the same
  identity and the same rules.
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

A window outside the caller's scope is left out of every list, every count and every event: no id, app or title, and
no list, count or event changes when it opens or closes. Window ids and pids are the platform's own numbers, which
rise as any window or process starts, so the gap between two of the caller's own ids can show that something else
opened in between; that side channel is known and not closed. Workspace numbers, which workspace each display shows, and the displays
themselves are not private and are always listed. The focused window outside scope is reported as `"window": null`, and
focus moving between two windows outside scope sends no event.

A command acts only on windows in the caller's scope, and reads, records and reports only those. A window outside it is
refused as every hands verb refuses it.

A connector may query and read events with the `events` tool. `subscribe` holds a socket on this machine and is refused
for another one; `--on HOST` carries neither yet. Every command below is refused for a caller from another machine with
`permission_denied`, `retry: never`, as `arrange` and `move` are today.

**Read Only refuses every command** (`switch`, `focus`, `move`, `frame`, `layout save`, `layout restore`, `theme-set`)
with `permission_denied`, `retry: never`. It keeps every query, `layout list`, `subscribe` and `events`.

## View control

**One rule:** a command needs view control when it lands a window on, or changes a window on, a workspace other than
the agent workspace. Exception: `move` onto the agent workspace needs no view control, and answers `in_use` while the
workspace it leaves or the agent workspace is shown. So `switch` and `focus` always need it, `move` needs it unless it
goes onto the agent workspace, and `frame` and `layout restore` need it unless their windows are on the agent
workspace. A command that needs view control runs only when all three hold:

1. The caller is on this machine (never a connector or `--on HOST`).
2. Access is Full Access.
3. Donovan turned on **Agents may change what you see** in the app's own Settings (macOS: Settings > Agents; off by
   default). The switch is never stored: it lives in the running app, is off at every launch, and turns on only when
   Donovan confirms it on Polycarp's own sheet with a real click or key, checked as a lend's is (a click posted by a
   program or an accessibility press is refused). So a `defaults write`, an edit of the settings file or a copied
   value leaves view control off: nothing on disk is read for it, and a value found under the old key is removed at
   launch. A Keychain item planted with a matching seal, which an earlier draft of this rule trusted, is never read
   either. Hands refuse Polycarp's own windows in every mode, so no agent clicks the switch either. On Windows,
   until the daemon has a confirmation that synthetic input can't answer, the switch stays off.

Otherwise the command fails with `permission_denied`, `retry: never`, before anything moves, and the suggestion says
which of the three is missing.

**Not while he looks:** a command that acts on the agent workspace never changes a workspace a display shows: not the
agent workspace while it is shown, and not the workspace a window leaves while that one is shown. With view control or
without, it answers `in_use`, `retry: safe`, and goes once no display shows them. A shown workspace is a passing
condition, so it is never `permission_denied`. This is about timing, not permission: with view control an agent may move
a window off his workspace to another one, and from there onto the agent workspace once that is out of sight.

## Queries

Read only, never wait on Donovan, never change anything. One name each, the same on the command line and over MCP:

| Query | `$defs` | What it holds |
| --- | --- | --- |
| `windows` | `windows_result` | Every window in scope: id, pid, app, bundle, title, workspace, display, frame, focused, agent, minimized |
| `workspaces` | `workspaces_result` | All nine: number, name, shown (and on which display), current, agent, the count and ids of the windows in scope |
| `displays` | `displays_result` | Every display: id, name, main, frame, visible frame (no menu bar or taskbar), scale, workspace shown, focused |
| `focused` | `focused_result` | The focused display, the workspace it shows, and the focused window (null outside scope) |
| `layout` | `layout_result` | For each workspace with windows in scope: each window's frame; plus each saved layout as `{ workspace, name }` |
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
| `move` | `window`; then `workspace` or `display` | `{ version, window, workspace, display, frame }` | unless it goes onto the agent workspace (then `in_use` while the workspace it leaves or the agent workspace is shown) |
| `frame` | `window`, `frame` (`x,y,width,height`, absolute, as `windows` reports it) | `{ version, window, frame }` | unless the window is on the agent workspace (then `in_use` while it is shown) |
| `layout` | `action` (`save`, `restore`, `list`), `name`, `workspace` (default: the agent workspace), `replace` | `layout_command_result` | `restore`, unless on the agent workspace (then `in_use` while it is shown) |
| `theme-set` | `theme`, `palette` (optional) | `{ version, theme, palette, drawn }` | never (agents may change how the Mac looks; Donovan, 2026-11-01) |

- `move` with `display` sends the window to the workspace that display shows.
- `move` without `workspace` or `display` keeps today's meaning: onto the agent workspace, where its `--frame`
  (`left|right|full` or a fraction of the agent area) still places it.
- `frame` sets one window's position and size in display coordinates; the result is the frame read back.
- `layout save` records the ordinary windows in scope on one workspace under `name` (letters, digits, `-` and `_`, at
  most 64), each by its identity and frame, with no window id. Under scope `agent` only the agent workspace can be saved
  or restored; any other answers `permission_denied`, `retry: never`. Saved layouts live in the platform's support
  folder, one folder per workspace, `layouts/<workspace>/<name>.json`, so a save on one workspace never replaces a
  layout of another. Names are compared without case (`Work` and `work` are one layout, stored lowercase). A save
  over a name already saved on that workspace answers `invalid_args`, `retry: never`, unless it passes `replace: true`.
  `layout list` and the `layout` query name only layouts of workspaces in the caller's scope, each as
  `{ workspace, name }` (`$defs/saved_layout`): a name alone is not unique, and a restore needs both.
- `layout restore` gives each window that matches a saved one by identity, and is in scope on that workspace now, its
  saved frame, and lists it in `moved`. It never moves a window to another workspace and never touches a window outside
  scope or on another workspace. Saved windows that matched nothing are listed in `missing` by identity.
- `drawn` is false when a Polycarp theme draws instead of the appearance theme: the value is saved and not shown.
- `focus` brings the window's app forward and switches to its workspace. It is the one command that takes keyboard
  focus, which is why it always needs view control.

Every command also takes `wait`, as every hands action does: how long to wait while Donovan is using the app.

Command line: `polycarp-spaces agent <command> --window 4211 --workspace 3`. MCP: one tool per command, named as in the
table with `-` spelled `_`.

## Events

`polycarp-spaces subscribe [--events workspace_switched,window_focused]` prints one JSON object per line until it is
stopped or the app quits. Over MCP, the `events` tool returns what happened after `since`, waiting up to `wait_ms` (at
most 5000) for the first event: `{ version, events, next }` (`$defs/events_result`).

Every event is `{ "version": 1, "seq": N, "at": <unix milliseconds>, "type": "...", "data": {...} }` (`$defs/event`).

**`seq` is per subscriber.** A subscriber is one `subscribe` connection, or one MCP session's events. Its `seq` starts at
1 with `hello` and rises by one per event sent to it. Events its filter or its scope leaves out are never numbered, so
`seq` has no gaps; when events are dropped because the reader fell behind, the next event is `lagged` with their count.
Over MCP, a call without `since` starts the session's events again and answers `hello` with `next: 1`. After that,
`since` is the `next` of the last call: the answer holds the events after it. An event stays until a later `since`
passes it, so a retried call gets the same answer. A `since` past the last event fails `invalid_args`.

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
when it was only asked for. Every event is filtered by the scope in force when it is sent. A window that leaves the
caller's scope while it listens (a lend ends) is reported as `window_closed`, and one that enters it as
`window_created`. When Donovan changes Access, the server ends every subscriber: `subscribe` closes, and the next
`events` call with `since` fails `invalid_args` and says to start again. The client starts again and gets a `hello`
with the new scope and state. Frame changes the window manager did not make (a person dragging a window) are
reported on its next scan, not at once.

## Timing

Measured by `scripts/agent-api-probe.swift` against the running app on an otherwise idle machine:

- Every query, and every `move` and `frame` of a window on the agent workspace while it is out of sight, answers in
  under 50 ms at the 95th percentile over 100 calls, with the app the window belongs to responsive.
- Every state change a command makes is seen as an event within 100 ms of the command's answer.
- `switch` and `focus` move every window on a display; their time is the switch time `scripts/bench.sh` holds.
- A command that doesn't see its change in the model within 1 s answers `unverified`, `retry: after_snapshot`.

## Checks

- `Tests/BaneySpacesCoreTests/AgentAPIContractTests.swift`: the schema is well formed, every `$ref` resolves, every
  query, command and event in this document has its `$defs` entry and its table row, the rules above are stated, and
  the examples validate, with no display.
- Later in the same stack, without a display: query results built from the model (`AgentAPIQueryTests`), commands
  (`AgentCommandsTests`), the event diff and stream (`AgentEventsTests`) and an MCP client (`AgentAPIMCPTests`), each
  validated against the schema.
- `scripts/agent-api-probe.swift` (not written yet): the same against the running app, plus the timing above and an MCP
  client that calls `tools/list`, moves a test window on the agent workspace and reads it back. It acts on the agent
  workspace only and runs only when the Mac has been idle 10 minutes; otherwise it prints "untested live" and exits 3.
- View control, by hand on macOS: `defaults write com.baney.polycarp agentViewControl -bool true` and a planted
  Keychain item with its seal both leave the switch off after a relaunch, and `switch` still answers
  `permission_denied`; only a click on Turn On in Polycarp's sheet turns it on, until Polycarp quits.

## Example

```json
{ "ok": true, "data": { "version": 1, "scope": "agent", "access": "default", "focused": { "display": "37D8832A-2D66-02CA-B9F7-8F30A301B230", "workspace": 1, "window": null } } }
```

```json
{ "version": 1, "seq": 7, "at": 1763400000123, "type": "workspace_switched", "data": { "display": "37D8832A-2D66-02CA-B9F7-8F30A301B230", "from": 1, "to": 3 } }
```
