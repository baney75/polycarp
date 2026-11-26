# CLI

One command family on every platform. Every command prints one envelope ([envelope.md](envelope.md));
`--text` prints a short human line instead where one exists. Targets are a window id or a pid.

| Command | macOS | Linux | Windows |
| --- | --- | --- | --- |
| `switch <n>` | yes | yes | yes |
| `switch <n> --monitor <name>`: asked from that display, as a click on its top bar ([workspaces.md](workspaces.md) R-S7) | not supported yet | retired | yes |
| `move <n> [--stay]` | yes | yes | yes |
| `window focus\|swap <dir>`, `window resize <dx> <dy>`, `window display next\|prev` | not supported yet | not supported yet | yes (`keymap.md`) |
| `ls` | yes (session rows) | yes (windows by workspace) | yes |
| `state` | yes (`state.json`) | yes (`state.json`) | yes |
| `overview` | yes | records the request; the shell plugin shows it (part 2) | yes |
| `agent on|off` | yes | not needed (the agent workspace always exists) | not needed (the agent workspace always exists) |
| `agent-workspace show|hide|toggle` | the key | yes | yes |
| `agent status` | yes | yes | yes |
| `play <file>` ([player.md](player.md), R-P8) | yes | retired | not supported yet |
| `contacts find <query> [--json] [--full]`, `contacts call\|facetime\|message\|email <query> [--text T]` ([contacts.md](../../docs/contacts.md)): opens the app with a draft, never sends | yes | retired | not supported yet |
| `agent windows` | yes | yes | yes |
| `agent open <app> [file...]` | removed: no computer use | yes: an allowlisted app by name, files from the handoff folder only | yes |
| `agent run [--dir D] -- CMD` | removed: no computer use | yes | yes |
| `agent move <window>`, `agent bring <window>` | `agent move <window>` only ([agent-workspace-api.md](../docs/agent-workspace-api.md)) | yes | yes |
| `agent workspaces` | removed: no computer use | yes (`special:agent` row, `number: null`) | not supported yet |
| `agent open ... [--new_window=false] [--wait S]` | removed: no computer use | yes | not supported yet |
| `agent arrange full\|halves\|thirds\|grid [window...]`, `frames ID=x,y,w,h ...` | removed: no computer use | yes | not supported yet |
| `agent move --window W [--frame x,y,w,h]` (the agent's verb; without `--window` it is yours) | removed: no computer use | yes | not supported yet |
| `query windows\|workspaces\|displays\|focused\|layout\|theme\|state [--json]`, `agent query <name>` ([agent-api.md](agent-api.md)) | removed: no computer use | not supported yet | not supported yet |
| `subscribe [--events a,b]`: NDJSON events, `hello` first with the whole state ([agent-api.md](agent-api.md), "Events") | removed: no computer use | not supported yet | not supported yet |
| `agent switch N [--display D]`, `agent focus --window W`, `agent frame x,y,w,h --window W`, `agent move --window W --workspace N\|--display D` (view control) | removed: no computer use | not supported yet | not supported yet |
| `agent close --window W` (only windows this session's `open` made) | removed: no computer use | yes | not supported yet |
| `agent snapshot\|find\|get\|click\|set-value\|type\|toggle\|select\|scroll\|shot\|press\|key\|pointer\|click-at\|mouse\|lend\|return` | removed: no computer use | retired | removed: no computer use (`not_supported`) |
| `agent log [--since SECS]` | removed: no computer use | yes | yes |
| `keys [--platform P]` | yes | yes | yes |
| `defaults [get\|candidates\|set\|reset] [--json]` ([default-apps.md](default-apps.md)) | yes | not supported yet | not supported yet |
| `open <role> [--new] [--in DIR] [--prompt TEXT]` ([default-apps.md](default-apps.md) R-D11) | yes | not supported yet | not supported yet |
| `daemon` | the app | yes | the app |
| `stop` | quit the app | yes (the uninstall script uses it) | quit the app |
| `mcp` | removed: no computer use | yes | yes |
| `doctor` | yes | yes | yes |

## Doctor

`doctor` prints the app's status lines. On macOS one is `polycarp_theme`: `none (...)`, or
`in force: <title> (<name>, mode <m>)` when a Polycarp theme draws instead of `appearance.theme` and
`appearance.palette` ([themes.md](themes.md), "Polycarp themes"). It needs the app running and past launch.

## State file

`state.json` is the model's `view` plus `"version": 1`, `"platform"`, `"agent_workspace"`, and, on
Linux, a top-level `"scheme"` (a one-line description of the workspace mapping). macOS: `~/Library/Application Support/BaneySpaces/state.json`.
Linux: `$XDG_STATE_HOME/baneyspaces/state.json` (default `~/.local/state/baneyspaces/`).

## Agent identity

`--agent-id ID` or `BANEYSPACES_AGENT_ID` names the caller in the action log (default `agent`).
`agent log` prints the records: agent id, verb, pid, window id, route, result, refusal. It never
holds content. Records older than 30 days are dropped. macOS has no action log: Polycarp no longer acts on apps.

## MCP

`baneyspaces mcp` serves [mcp-tools.json](mcp-tools.json) over stdio: the Rust core's catalog, as Linux serves it. macOS
has no `mcp` any more: its `computer_*` tools were removed. The catalog is `agent_status`, `agent_windows` and
`agent_open`; any other name is an unknown tool.

## Agent skill

macOS only. The app bundle carries the agent skill at `Contents/Resources/skill/SKILL.md`, named `polycarp-spaces`.

- **R-K1** `skill install` writes it to `~/.claude/skills/polycarp-spaces/SKILL.md`, replacing any file there, and
  prints `installed <path>`.
- **R-K2** After that write succeeds, it removes `~/.claude/skills/baneyspaces/` only when that folder is a real
  directory holding only a `SKILL.md` that names itself `baneyspaces` (the copy installs before the rename wrote), and prints
  `removed <path>`. Any other folder there is someone else's and stays. A failed write removes nothing.
- **R-K3** Without the bundled copy it prints an error and changes nothing.
- **R-K4** `polycarp version` and `polycarp update` count the skill as installed when either folder holds a
  `SKILL.md`, the new name first, so an old install is still refreshed and the refresh moves it to the new name.
  Uninstall removes both folders.

## Global flags

`--text` and `--agent-id ID` (or `--agent-id=ID`) are read only **before** the command. After the
command every argument belongs to it (`agent run -- ls --text` passes `--text` to `ls`).

## Without the daemon

On Linux `switch` and `move` (including `--stay`) fall back to Hyprland's own dispatch when the
daemon is down, so the bound keys keep working; the reply says `fallback: hyprland`. Everything else
returns `daemon_down`.
