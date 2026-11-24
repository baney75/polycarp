# Agent workspace API

Polycarp keeps one workspace for agent apps, the agent workspace (`polycarp-spaces agent on [N]`). This API has two
operations on it and nothing else:

- `windows`: list the windows on the agent workspace.
- `move`: move one window to the agent workspace.

Polycarp does not read, click or type into apps. A computer-use client starts its apps and then uses this API to keep their windows on the agent workspace.

## Transport

A Unix socket at `~/Library/Application Support/Polycarp/polycarp.sock`. Any process running as the same user can
connect; other users can't. Send one JSON line, read one JSON line back, and the app closes the connection.

The request is a `Wire.Request` with `op` set to `agent`, `text` set to the operation and `args` holding its
arguments. `caller` is optional and names you in Polycarp's trace log.

```json
{"op":"agent","text":"windows"}
{"op":"agent","text":"move","args":["4127"],"caller":"agent"}
```

The reply is a `Wire.Reply`: `ok`, an `error` string when `ok` is false, and `info`, a map of strings.

Callers on another machine (`polycarp-spaces remote on`) get neither operation. They can read `agent status` only.

## windows

No arguments. On success `info` holds:

| Key | Value |
| --- | --- |
| `version` | `2` |
| `workspace` | the agent workspace's number, `1` to `9` |
| `windows` | a JSON array, as a string, sorted by `id` |

Each window in the array is `{"id": <window number>, "pid": <process id>, "app": "<app name>", "title": "<title>"}`.
`id` is the macOS window number, the same one `move` takes. A window whose process has quit is left out. An empty
agent workspace answers `ok: true` with `"windows": "[]"`.

## move

One argument: the window number, in decimal. It must be a live window Polycarp places: one it shows on some workspace,
whose process still runs. A window already on the agent workspace may always move (a reframe). A window on another
workspace moves only when its process started in the last 60 seconds, so a caller can bring over an app it has just
started but never one of Donovan's apps that has been running. The start time is the app's launch date, or the
kernel's start time for a process launchd started. On success `info` holds `version`, `workspace` and `window`.

The move is the same one Polycarp makes when you send a window with its keys: the window is parked out of sight if
you aren't looking at the agent workspace.

## Errors

A refusal is `ok: false` with `error` for people and `info.code` for programs:

| `code` | When |
| --- | --- |
| `agent_workspace_off` | no agent workspace is set; `polycarp-spaces agent on [N]` sets one |
| `no_such_window` | `move` named a window Polycarp doesn't place (closed, its process gone, never seen, or on no workspace) |
| `refused` | `move` named a window on another workspace whose process has run for over 60 seconds |
| `bad_request` | `move` got no window number, more than one, or something that isn't one; or an unknown operation |

`ok: false` with no `code` means the app can't answer yet: it is still starting or waits for Accessibility. No reply
at all means Polycarp isn't running.

## Example

```sh
$ printf '%s\n' '{"op":"agent","text":"windows"}' | nc -U ~/Library/Application\ Support/Polycarp/polycarp.sock
{"ok":true,"info":{"version":"2","workspace":"9","windows":"[{\"app\":\"TextEdit\",\"id\":4127,\"pid\":8812,\"title\":\"notes.txt\"}]"}}

$ printf '%s\n' '{"op":"agent","text":"move","args":["4130"]}' | nc -U ~/Library/Application\ Support/Polycarp/polycarp.sock
{"ok":true,"info":{"version":"2","window":"4130","workspace":"9"}}
```

The command line does the same: `polycarp-spaces agent windows [--json]` and `polycarp-spaces agent move <window>`.

The code is `Sources/BaneySpacesCore/AgentAPI.swift` (the replies) and `SessionController.agent` (the routing); the
tests are `Tests/BaneySpacesCoreTests/AgentWorkspaceAPITests.swift`.
