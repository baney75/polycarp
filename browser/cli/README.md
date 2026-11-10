# tabkyra (CLI)

Bridge between coding harnesses and the Tabkyra browser extension. Any MCP client
(Claude Code, Codex, OpenCode, Cursor, OMP) and pi can drive a Chromium browser through it. Each harness
gets its own tab group and works in the background while you keep using your tabs.

```
harness ── stdio MCP ── tabkyra mcp ── unix socket ── native host ── native messaging ── extension
```

Nothing listens on the network. The browser spawns the native host; the host owns a
socket in `/tmp/tabkyra-bridge-<user>/` (0700 directory, 0600 socket) that only your
user can reach. The client refuses sockets and directories it does not own.

## Install

```bash
npm link                      # from this directory; puts tabkyra (and the sitegeist alias) on PATH
tabkyra setup                 # build, register, load, connect and wire up your harnesses
```

`tabkyra setup` builds `dist-chrome` if it is missing, registers the native host for every
Chromium browser it finds, shows the one manual step (Load unpacked), waits until the
extension connects, and offers to add the MCP server to each harness it detects. It edits
a harness config only after a yes; `--yes` accepts every offer, `--no-wait` skips the
wait, `--timeout=<s>` bounds it. `tabkyra doctor` re-checks everything later and prints
one fix per problem (`--json` for scripts).

`tabkyra mcp` runs the installer itself on first use, so a harness configured to start
it needs no extra step. Reload the extension once after the first install.

## Commands

| Command | Purpose |
| --- | --- |
| `tabkyra setup [--yes] [--no-wait] [--timeout <s>]` | first-time setup, end to end |
| `tabkyra status [--json]` | is the extension connected, which sites are allowed, which browsers have the host |
| `tabkyra doctor [--json]` | check Node, the build, host manifests, the connection and harness configs; exits 1 on a failure |
| `tabkyra mcp [--session <name>]` | stdio MCP server exposing the browser tools; without `--session` (or `TABKYRA_SESSION`) the session is the project's (git root), so a restarted harness resumes its tabs |
| `tabkyra sessions [list\|show\|rename\|end\|release\|focus\|collapse\|expand] [--json]` | agent sessions and their tab groups (see the main README, "Sessions and tab groups") |
| `tabkyra tabs [session] [--json]` | every agent tab, by session |
| `tabkyra allow <host>` | let agents open a site without a prompt (subdomains included) |
| `tabkyra ask` | agents ask before opening a site not yet allowed (the default) |
| `tabkyra allow-all` | agents may open any site without asking (`yolo` still works) |
| `tabkyra install [--force]` | write the native host manifest (Helium, Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Opera; Linux and Windows too) and the launchers in `~/.config/tabkyra/` |
| `tabkyra reload` | reload the extension (after rebuilding `dist-chrome`) |
| `tabkyra debug` | bridge state, recent request timings, Chrome API benchmark |
| `tabkyra pi-extension` | write `~/.pi/agent/extensions/tabkyra.ts` for pi |
| `tabkyra skill install [name...] [--all] [--force]` | install the bundled skills into Claude Code, Codex and OpenCode; a same-name skill Tabkyra didn't write is left alone without `--force` |
| `tabkyra skill list` | the bundled skills and what each is for |
| `tabkyra skill print [name] [--raw]` | a skill as an AGENTS.md section (default `polycarp-browser`); `--raw` is the exact SKILL.md |
| `tabkyra skill lint [path...]` | check skills for hidden text, injection, remote code, secret handling and structure ([rules](../docs/skill-security.md)) |
| `tabkyra skill apply <folder> [--yes]` | lint and diff an edited skill; `--yes` backs up the current one and installs the edit |
| `tabkyra skill revert <name>` | drop your edit and go back to the bundled skill |
| `tabkyra library add <doi\|arxiv> [--quote] [--location] [--note] [--tag]` | save a source, verified against its registry, OpenAlex and Crossref retraction notices |
| `tabkyra library list\|search\|verify\|cite\|export\|obsidian\|remove` | find, re-check, cite (apa, mla, chicago, ieee, harvard, vancouver), export (bibtex, ris, csl) or write Obsidian notes |
| `tabkyra serve [--port 8787]` | MCP over Streamable HTTP at `/mcp`, loopback only; every request needs a token |
| `tabkyra token create <name> --scope a,b` | a scoped, revocable token, shown once (`token list`, `token revoke <id\|name>`, `token scopes`) |
| `tabkyra tunnel tailscale [--port N] [--public] [--off]` | reach `serve` over HTTPS through your tailnet (`--public` uses Funnel) |
| `tabkyra tunnel cloudflare [--port N] [--off]` | reach `serve` through a cloudflared quick tunnel |
| `tabkyra update [--check] [--rollback] [--channel stable\|nightly]` | install the latest signed release ([docs/updates.md](../docs/updates.md)) |
| `tabkyra completion zsh\|bash\|fish` | shell completions for commands, subcommands and flags |
| `tabkyra version [--json]` | the CLI's version, which is the extension's (`static/manifest.chrome.json`) |

Output is colored only on a terminal; `NO_COLOR` turns it off. Read commands take `--json`
(`status`, `doctor`, `sessions`, `tabs`, `skill list`, `skill match`, `skill versions`, `library list`,
`library search`, `token list`, `token scopes`, `update --check`, `version`); `debug`
always prints JSON.

Exit codes, for every command: **0** success; **1** failed, not connected, or nothing found
(the message says the next step); **2** usage error (an unknown command, option or
argument). `update --check` exits 100 when an update exists; `library add` exits 3 for a
retracted source and 4 when the retraction check couldn't finish.

### Shell completions

```bash
echo 'eval "$(tabkyra completion zsh)"' >> ~/.zshrc     # zsh
echo 'eval "$(tabkyra completion bash)"' >> ~/.bashrc   # bash
tabkyra completion fish > ~/.config/fish/completions/tabkyra.fish
```

The launcher `tabkyra install` writes (`~/.config/tabkyra/tabkyra`, what harness configs run)
sets `NODE_COMPILE_CACHE` (Node 22.1+). The saving is small: on one Apple M-series machine
`tabkyra mcp` started in 108 ms with it and 119 ms without (medians of 15 interleaved starts
each, `cli/eval/bridge-metrics.mjs --only launcher`), while the same harness on main, where
both arms are identical, differed by 9 ms. Treat it as at most about 10%.

## Harness setup

`tabkyra setup` does this for you. By hand, point each harness at the launcher
`~/.config/tabkyra/tabkyra`, which `tabkyra install` writes. It runs this CLI with an
absolute Node path, so harnesses started from a GUI don't need `node` on their PATH:

```bash
claude mcp add --scope user tabkyra -- ~/.config/tabkyra/tabkyra mcp
codex mcp add tabkyra -- ~/.config/tabkyra/tabkyra mcp
tabkyra pi-extension
```

OpenCode (`~/.config/opencode/opencode.json`):

```json
{ "mcp": { "tabkyra": { "type": "local", "command": ["/Users/you/.config/tabkyra/tabkyra", "mcp"], "enabled": true } } }
```

Cursor (`~/.cursor/mcp.json`) and OMP (`~/.omp/agent/mcp.json`):

```json
{ "mcpServers": { "tabkyra": { "command": "/Users/you/.config/tabkyra/tabkyra", "args": ["mcp"] } } }
```

## Permissions

By default the extension asks before an agent opens a new site. MCP clients that support
elicitation (Claude Code, Codex) show the prompt inline; otherwise answer it in the
Tabkyra side panel under Settings > Agents, run `tabkyra allow <host>`, or switch the
mode to "allow any site" there. pi: set `TABKYRA_AUTO_ALLOW=1` to auto-approve.

`TABKYRA_SESSION=<name>` makes a harness re-adopt the same tab group across restarts.
`TABKYRA_SOCKET_DIR` moves the socket directory (the end-to-end test runs a private bridge this way).
`TABKYRA_CLIENT_NAME` overrides the tab group label.

## MCP tools

| Tool | Does |
| --- | --- |
| `status` | connection, permission mode, allowed sites, your tab group and its tabs; never fails |
| `tabs_context`, `tabs_create`, `tabs_close`, `tabs_select` | your own background tabs |
| `tabs_show` | bring a tab in front of the user (the only tool that changes what they see) |
| `navigate` | open a URL, or go back/forward |
| `read_page`, `find`, `get_page_text`, `get_page_html`, `screenshot` | read the page |
| `click`, `hover`, `type`, `press`, `fill`, `scroll`, `drag`, `actions` | act on it |
| `run_js`, `wait`, `read_console`, `read_network` | scripts, waits and debugging |
| `handle_dialog` | answer an alert, confirm or prompt box; while one is open, other calls fail at once with `dialog_open` |
| `capture` | evidence from the agent's own tab as files under `~/.config/tabkyra/captures`: a redacted HAR (`network_start`/`network_stop`), a WebM recording (`record_start`/`record_stop`), the last minute of video (`flight_start`/`flight_save`); `status`, `cancel` |
| `library_add`, `library_search`, `library_cite` | the source library (`tabkyra library`) |

Every tool documents its parameters and includes an example in its description. The server's instructions tell the
agent that page text is untrusted data and that it must ask before acting under the
user's sign-in. With no browser connected, every tool returns: "Tabkyra isn't connected.
Ask the user to open Helium/Chrome with the Tabkyra extension loaded, or run
`tabkyra doctor`."
