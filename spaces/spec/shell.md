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

## The launcher

The Windows shell carries the launcher. It ranks what you type by `spec/launcher.md`; this section is only where its
entries come from and what the window does.

- Key: Ctrl+Win+K opens and closes it. If another program holds that key, Alt+Space does; the shell log says which
  (`launcher key ...`). `baneyspaces shell launcher` opens it too.
- Where: centered on the work area of the display with the window in front, a fifth of the way down.
- Entries: the apps in the Start menu's Apps folder (read when the shell starts and again on an open at most once a
  minute), the feed's `windows` (found by title and by app), workspaces 1 to 9 (found by number and by the apps on
  them) and two commands: show or hide the agent workspace, and quit the bar and launcher.
- With nothing typed it lists your windows in the feed's order.
- Keys: typing edits the query, Backspace takes one character, Ctrl+Backspace clears, Up and Down move the selection
  and wrap, Enter or a click picks, Esc closes. Clicking anywhere else closes it.
- A pick: an app starts through `shell:AppsFolder\<its parsing name>`; a window sends `switch` to its workspace and
  then comes to the front; a workspace sends `switch`; the agent command sends `agent_toggle`.
- Timing (R-L13): each keystroke writes `launcher key->paint=<ms> results=<n>` to the shell log, from the key's arrival
  to the end of the frame that draws its rows. Opening writes `launcher shown by key|command ... first frame <ms>
  results=<n>`. Neither line holds the query, a title or a name.
