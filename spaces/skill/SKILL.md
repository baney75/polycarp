---
name: baneyspaces
description: See and drive what's open on Donovan's Mac through BaneySpaces - the session engine (every terminal split, browser tab and agent app in one list, with the workspace each is on), the agent workspace (list its windows, move a window there) and his Contacts (find a person, open a call, FaceTime, a Messages draft or an email to them). Use to find which terminal or tab holds something, open a URL, type into another Ghostty terminal, flag a terminal as needing him, keep an agent's windows off his workspaces, or set up a call or message he asked for. Faster and safer than screenshots. Also use it to change what Polycarp's surfaces show (top bar, desktop scene and verse, dock tiles, status menu, new tab page, idle screen) through `surfaces get|set|reset`. It does not click or type into apps: computer use is Tychicus.
---

# BaneySpaces

BaneySpaces is the workspace manager on Donovan's Mac. It wraps Donovan's terminals, browser and coding apps into one
list. `baneyspaces` is its command (`ghostdeck`, the old Ghostdeck app's name, still works as an alias). It answers in milliseconds and never moves the pointer or
takes focus unless the command is meant to (`focus`).

## Look before you act

```sh
baneyspaces ls            # one row per terminal split, browser tab and agent window
baneyspaces ls --json     # the same with window numbers, folders, ttys, agent state
```

Each row has an ID: `ghostty:<uuid>` (a Ghostty split), `tab:<bundle>:<window>:<tab>` (a browser
or Terminal tab), `win:<CGWindowID>` (any other window). `windowNumber` is the macOS window ID that
`baneyspaces agent windows` and `agent move` use.
`activity` is `working`, `waiting` or `shell`. `workspace` > 0 means the row is on another
BaneySpaces workspace.

## Act

| Want | Command |
| --- | --- |
| Bring something forward | `baneyspaces focus <id or words>` (fuzzy: `baneyspaces focus helium github`) |
| Open a page | `baneyspaces open https://…` (default browser, stays in the session engine) |
| Type into another Ghostty terminal | `baneyspaces send <id or words> "text"` (pasted, no Return unless you include a newline) |
| Tell Donovan this terminal needs him | `baneyspaces notify "Tests failed, need a decision"` |
| Report your own state (non-Claude agents) | `baneyspaces event --state working\|waiting\|idle\|end --agent <name>` (add `--started` with `working` when a prompt was just submitted in the window in front; `--at <unix seconds>` says when it happened, default now) |

## Rules

- `focus` changes what Donovan sees. Use it only when he asked to be taken somewhere, or when
  you're about to hand him that window. Never `focus` to drive an app.
- `send` types into a live terminal. Never send into a terminal running someone else's agent
  turn (`activity` is `working`) and never send commands that delete, push or spend.
- Read state with `ls`, not screenshots. If `baneyspaces` says BaneySpaces isn't running, say so; there is no
  fallback that raises windows or takes the pointer.
- Claude Code sessions report their own state through hooks (`baneyspaces hooks status`). Don't
  call `notify` for an ordinary end of turn; the hook already marks it.

## Surfaces: what the bar, desktop, dock, menu, new tab and idle screen show

One file, `~/Library/Application Support/Polycarp/surfaces.json`, says what every Polycarp surface shows. Change it
only when Donovan asks for a change to how a surface looks or behaves; a running Polycarp shows it within 150 ms.

```sh
baneyspaces surfaces schema                      # every field, its default and what it takes: read it first
baneyspaces surfaces get bar --json              # what is in force now (the file over the defaults)
baneyspaces surfaces set bar.style glass         # checked, then written whole; a refusal writes nothing
baneyspaces surfaces set bar.modules '{"left":["mark","workspaces"],"center":["hour"],"right":["clock"]}'
baneyspaces surfaces reset bar.style             # back to the default
baneyspaces surfaces validate ./draft.json       # every error with its JSON path
```

Paths are keys joined with dots (`desktop.verseRotation`). Values are JSON (`30`, `true`, `"fixed:John 3:16"`,
`["mark"]`). A refusal names each path and why (`--json`: `error.data.errors`). A bar module goes in one place across
left, center and right, defaults included, so set `bar.modules` whole to move one. `settings` and `quit` can't be
hidden from the menu. Note the old value with `get` before a `set`, so you can put it back. Over MCP, `polycarp mcp`
serves the same as `surfaces_schema`, `surfaces_get` and `surfaces_set`. Colors and fonts are the theme's
(`polycarp theme`), not this file's. Every field: spaces/docs/surfaces.md.

## What each workspace is for

```sh
baneyspaces purpose list --json   # each workspace's purpose, and today's one thing
baneyspaces day --json            # today's seconds on each workspace
```

Read these to know what Donovan is about today and where his attention goes. Setting them (`purpose set <n> <text>`,
`purpose clear <n>`, `one <text>`, `one --clear`) states what his workspaces and his day are for: do it only when he
asks. Purposes hold up to 60 characters, the one thing up to 80; it clears at 4 am.

## People in Contacts

```sh
baneyspaces contacts find anna                 # names and the kinds of handles: phone (mobile), email (work)
baneyspaces contacts find anna --json          # add --full for the numbers and addresses
baneyspaces contacts call "anna smith"         # also facetime and email
baneyspaces contacts message "anna smith" --text "running late"
```

Polycarp never sends a message: `message` opens Messages with the draft in the box and Donovan presses Send; `email`
opens Mail the same way. Each action opens an app on his screen, so use it only when he asked for that call or that
message. It acts on one person only: when two match as well it refuses and names them, so say more of the name. It
picks the number he used last, else a mobile, else the first. Without Contacts access it says so; a command never asks
macOS for it (docs/contacts.md).

## The agent workspace

```sh
baneyspaces agent status          # the agent workspace's number, or off
baneyspaces agent windows --json  # the windows on it: id, pid, app, title
baneyspaces agent move 4127       # send a window there (a window number from ls or windows)
```

`agent on [N]` and `agent off` are Donovan's switch; don't change it unless he asks. `move` takes only a window
Polycarp places; send one of his own windows only when he asked. Errors carry a code: `agent_workspace_off`,
`no_such_window`, `bad_request` (docs/agent-workspace-api.md).

BaneySpaces doesn't read, click or type into apps: use Tychicus for that. Don't drive an app through AppleScript, JXA or
Shortcuts (`osascript`, `shortcuts run`) instead: they pick an app by name, not by window, so they can reach Donovan's own
copy of it or start one on his workspace. Never run anything that takes focus or raises a window.
