# CLI

One command family on every platform. Every command prints one envelope ([envelope.md](envelope.md));
`--text` prints a short human line instead where one exists. Targets are a ref (`@s8f3k2p9:e8`), a
window id, or a pid.

| Command | macOS | Linux | Windows |
| --- | --- | --- | --- |
| `switch <n>` | yes | yes | yes |
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
| `purpose list\|set <n> <text>\|clear <n>`, `one <text>\|--clear`, `day` (`--json` on each; local callers only) | yes | retired | not supported yet |
| `agent open <app> [file...]` | removed: computer use is Tychicus | yes: an allowlisted app by name, files from the handoff folder only | yes |
| `agent run [--dir D] -- CMD` | removed: computer use is Tychicus | yes | yes |
| `agent move <window>`, `agent bring <window>` | `agent move <window>` only ([agent-workspace-api.md](../docs/agent-workspace-api.md)) | yes | yes |
| `agent workspaces` | removed: computer use is Tychicus | yes (`special:agent` row, `number: null`) | not supported yet |
| `agent open ... [--new_window=false] [--wait S]` | removed: computer use is Tychicus | yes | not supported yet |
| `agent arrange full\|halves\|thirds\|grid [window...]`, `frames ID=x,y,w,h ...` | removed: computer use is Tychicus | yes | not supported yet |
| `agent move --window W [--frame x,y,w,h]` (the agent's verb; without `--window` it is yours) | removed: computer use is Tychicus | yes; a window that needs a lend or Full Access is `not_supported` | not supported yet |
| `query windows\|workspaces\|displays\|focused\|layout\|theme\|state [--json]`, `agent query <name>` ([agent-api.md](agent-api.md)) | removed: computer use is Tychicus | not supported yet | not supported yet |
| `subscribe [--events a,b]`: NDJSON events, `hello` first with the whole state ([agent-api.md](agent-api.md), "Events") | removed: computer use is Tychicus | not supported yet | not supported yet |
| `agent switch N [--display D]`, `agent focus --window W`, `agent frame x,y,w,h --window W`, `agent move --window W --workspace N\|--display D` (view control) | removed: computer use is Tychicus | not supported yet | not supported yet |
| `agent close --window W` (only windows this session's `open` made) | removed: computer use is Tychicus | yes | not supported yet |
| `agent snapshot|find|get|click|set-value|type|toggle|select|scroll|shot` | removed: computer use is Tychicus | yes (AT-SPI) | yes (UI Automation) |
| `agent get <ref> --copy`, `agent type <ref> --paste` (the agent clipboard: text held per session in Polycarp's memory, gone when the session ends or after an hour unused; a call with no session of its own, or the shared `default`, gets none. The session id is trusted as given: a CLI caller that sets `BANEYSPACES_SESSION` to another agent's id, or its tty name, reads what that agent copied, so the clipboard keeps apart MCP connections, not agents of one user that choose ids. cmd+c, cmd+x and cmd+v in `press`, by key code and by the key's character in the Mac's layouts, and a `click` or `select` of a Cut, Copy or Paste item answer `not_supported`: an item by its AppKit action in any language, or by English title when it has none; a click by the snapshot's own record of the ref, however many reads came after; a `select` also by the item the engine finds once the popup is open, before it is pressed) | removed: computer use is Tychicus | not listed (`invalid_args`) | not listed |
| `agent snapshot` rows: `--format rows\|json`, `--query`, `--since latest`, `--max_elements N`; a bare row number as a ref (the MCP `snapshot` tool answers rows by default) | removed: computer use is Tychicus | `not_supported` (JSON tree only) | `not_supported` (JSON tree only) |
| `agent menu --window W "Format > Font > Bold"` (AXPress on the menu-bar item; only a copy this session's `open` started, with W its one window and focused; waits while that copy is in front; refused by bar position, key equivalent and identifier, before anything is pressed or listed: the Apple, Window and Help menus, the app menu but About and Settings, full screen and the tab overview, Open and Open Recent, cut, copy and paste, and items that reach past the app (Emoji & Symbols, Dictation, Speech, AutoFill, Writing Tools, Print, Page Setup, Share, Import from iPhone); an item whose attributes can't be read is refused; for 1 s after the press, a file panel it raises is cancelled and a new window outside the agent workspace fails the call, closed only when tied to the press (the app's, its child process's, or a system helper's with no input from Donovan) and tracked by Polycarp, else reported as still open or left alone; the call fails with `not_supported` or `outside_agent_workspace`) | removed: computer use is Tychicus | not listed; `invalid_args` (unknown agent command) | not listed |
| `agent run-steps --steps '[{"tool":"click","args":{"ref":"5"}}]'` (at most 32 of click, type, set-value, press, click-at, drag, scroll, select, toggle and menu; every step checked and its row numbers bound before any runs; each window's consecutive steps in one transaction; stops at the first step that fails, is not verified or raises a dialog or sheet, and starts none after 40 s; ends with one `since: latest` read, or the dialog's rows) | removed: computer use is Tychicus | not listed; `invalid_args` (unknown agent command) | not listed |
| `agent press|key|pointer` | removed: computer use is Tychicus | `not_supported` (part 1) | phase 3-4 |
| `agent click-at --window W --x X --y Y [--count 1\|2\|3] [--button left\|right] [--item TITLE]` (window-local points; `count` outside 1 to 3 is `bad_arguments`; `--button right` posts only on an agent workspace window (not lent or Full Access) while the agent workspace is on screen under it (else `outside_agent_workspace`, nothing posted) and Escape can be sent to it (else `not_supported`); Look Up, Translate and the like are refused by English title only, answers `context_menu` with the menu's `items`, and presses `--item` or cancels the menu) | removed: computer use is Tychicus | `not_supported` | `not_supported` |
| `agent click <ref> --button right [--item TITLE]` (the element's context menu through the engine's AXShowMenu, never a posted click; refused before anything is sent unless it is an agent workspace window (not lent or Full Access) with the agent workspace on screen under it (`outside_agent_workspace`) and Escape can be sent to it (`not_supported`); then the same proof, `items`, `--item` press or cancel as `click-at --button right`; an element with no menu action is `not_supported`) | removed: computer use is Tychicus | `not_supported` | `not_supported` |
| `agent select` or `agent click` on a pop-up (the engine's `combobox`, which includes pop-up buttons, or `menubutton`; a select on a ref whose role can't be read counts as one) runs only while the agent workspace is on screen under the window: its menu would otherwise open on a display Donovan sees. Else `outside_agent_workspace`, retry never, nothing sent. `set-value` on a combobox opens no menu | removed: computer use is Tychicus | no menu gate (Linux part 1) | no menu gate (Windows part 1) |
| `agent log [--since SECS]` | removed: computer use is Tychicus | yes | yes |
| `agent lend|return` | removed: computer use is Tychicus | `not_supported` (later) | the user only |
| `keys [--platform P]` | yes | yes | yes |
| `daemon` | the app | yes | the app |
| `stop` | quit the app | yes (the uninstall script uses it) | quit the app |
| `mcp` | removed: computer use is Tychicus | yes | yes |
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
`agent log` prints the records: agent id, verb, pid, window id, ref, route, result, refusal. It never
holds snapshot text, values, typed text or captures. Records older than 30 days are dropped. macOS has no action log: Polycarp no longer acts on apps.

## MCP

`baneyspaces mcp` serves [mcp-tools.json](mcp-tools.json) over stdio: the Rust core's catalog, as Linux serves it. macOS
has no `mcp` any more: its `computer_*` tools moved to Tychicus. The agent API's queries and commands ([agent-api.md](agent-api.md)) are tools too. The ones that
switch, focus, or move or size a window on your workspaces need view control, which is off until you turn it on.

## Global flags

`--text` and `--agent-id ID` (or `--agent-id=ID`) are read only **before** the command. After the
command every argument belongs to it (`agent find --text needle` filters by text).

## Without the daemon

On Linux `switch` and `move` (including `--stay`) fall back to Hyprland's own dispatch when the
daemon is down, so the bound keys keep working; the reply says `fallback: hyprland`. Everything else
returns `daemon_down`.
