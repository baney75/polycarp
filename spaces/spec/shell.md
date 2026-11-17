# The shell's feed

A desktop shell (on Windows, `baneyspaces shell`: the bar and the launcher) draws what the daemon knows. It learns it
from one long-lived connection, not by polling.

## Subscribe

Send one request line on the control pipe:

```json
{"op":"subscribe"}
```

The daemon answers with an envelope line, `{"ok":true,"data":{"subscribed":true}}`, keeps the connection open, and
writes one line at once and one more each time something below changes:

```json
{"event":"state","state":{
  "monitors":[{"id":"\\\\.\\DISPLAY1","current":2}],
  "focused_monitor":"\\\\.\\DISPLAY1",
  "occupied":[1,2],
  "active":{"id":"w-1312","app":"notepad.exe","title":"notes.txt - Notepad","workspace":2},
  "windows":[{"id":"w-1312","app":"notepad.exe","title":"notes.txt - Notepad","workspace":2}],
  "agent_shown":false}}
```

- `monitors`: every display, ordered as the daemon numbers them. `id` is the device name (`MONITORINFOEX.szDevice`
  on Windows). `current` is the workspace it shows, 0 for none of the nine.
- `occupied`: workspaces holding at least one of your windows, ascending.
- `active`: the window in front, or `null` when it is not one of yours.
- `windows`: your windows, workspaces ascending, oldest first within each.
- `agent_shown`: the agent workspace is on screen.

Only your windows are listed. An agent's window, and anything on the agent workspace, never appears in the feed.

A line is written only when it differs from the last one, right after the change is applied (a workspace switch, a
window opening, closing, moving or coming to the front, a title the daemon re-read). A shell redraws on each line.
Lines with another `event` may be added later; a shell ignores events it does not know.

## Who may subscribe

The person using the computer: a request from an agent's process is refused with `not_in_scope`, like `switch`.
The pipe itself is the control pipe (`spec/cli.md`), open only to your account.

## Acting

The shell sends ordinary one-line requests on new connections (`switch`, `move`), the same ones the CLI sends. It never
changes the model any other way.
