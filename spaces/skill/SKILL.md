---
name: baneyspaces
description: See and drive what's open on Donovan's Mac through BaneySpaces - the session engine (every terminal split, browser tab and agent app in one list, with the workspace each is on) and the agent workspace (list its windows, move a window there). Use to find which terminal or tab holds something, open a URL, type into another Ghostty terminal, flag a terminal as needing him, or keep an agent's windows off his workspaces. Faster and safer than screenshots. It does not click or type into apps: computer use is Tychicus.
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
