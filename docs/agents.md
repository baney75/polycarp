# Agents: one MCP gateway

`polycarp agent` is one MCP server for every assistant you use: Grok Bot, Claude Code and Codex on this Mac, Grok Bot on your other devices, and the web assistants (claude.ai, ChatGPT, grok.com). Each one gets the scopes you choose and nothing more.

Behind it are the same tools Polycarp already has:

| Tools | Scope | What they do |
| --- | --- | --- |
| `theme_*` | read to look, act to change | Everything `polycarp mcp` does |
| `files_*` | files | Everything `polycarp files mcp` does |
| `app_status`, `app_items`, `app_settings`, `workspace_agent_status` | read | Ask the running app what it tracks and how it is set |
| `app_setting_set`, `app_focus`, `workspace_agent_set`, `workspace_agent_move`, `workspace_switch`, `launcher_open` | act | Change a setting, bring a window forward, run the agent workspace, switch workspaces, open the launcher |

An assistant sees only the tools its scopes allow. App tools talk to the running app over the same socket `polycarp-spaces` uses, and every change they make is logged in the app with the client's name and id. No tool opens a terminal, types into one, or changes how the app updates.

## Routes

| Route | How to reach it | Who uses it |
| --- | --- | --- |
| Local stdio | `polycarp agent serve --stdio` | Claude Code, Codex, Grok Bot on this Mac |
| Local HTTP | `http://127.0.0.1:41772/mcp` | Any client on this Mac that speaks Streamable HTTP |
| Tailnet | `http://<this-mac>.<tailnet>.ts.net:41772/mcp`, with `serve --tailnet` | Grok Bot and other clients on your own devices |
| Your Cloudflare tunnel | `https://<your host>/mcp` | Web assistants (dev and nightly) |
| Tailscale Serve | `https://<this-mac>.<tailnet>.ts.net:8443/mcp` | Your own devices over HTTPS (dev and nightly) |
| Tailscale Funnel | the same address, public | Web assistants (dev and nightly) |
| Hosted tunnel | not open yet | Web assistants on stable, by invite |

The HTTP server listens on loopback only. `--bind` takes 127.0.0.1 or ::1 and refuses anything else, including 0.0.0.0, a LAN address and a Tailscale address. The tailnet listener is separate: it binds this device's Tailscale addresses only and asks Tailscale who each caller is before it reads a byte.

## Release channels

| Channel | Local and tailnet | Your own tunnel (Cloudflare, Tailscale) | Hosted tunnel |
| --- | --- | --- | --- |
| dev | yes | yes | no |
| nightly | yes | yes | no |
| stable | yes | no | waitlisted |

On stable, `polycarp agent tunnel cloudflare` and `tunnel tailscale` refuse and say why: the hosted tunnel may cost money to run, so it opens by invite. `polycarp agent tunnel join` opens the waitlist at https://dbaney.com/polycarp/waitlist, and `polycarp agent tunnel redeem <invite>` stores an invite you get. Until then, local and tailnet work on stable as on any channel.

The gate is checked every time, not only at setup. A tunnel set up on nightly stops working if the install moves to stable: requests through it get the waitlist message, and `tunnel run` won't start cloudflared.

The channel is the app's own (its Info.plist), or for a source install the one `polycarp update --channel` recorded, or dev.

## Connecting each assistant

`polycarp agent connect <client>` prints the exact steps. It never prints a token.

- **Claude Code**: `claude mcp add --scope user polycarp -- <polycarp> agent serve --stdio`. `connect claude-code --run` runs it for you.
- **Codex**: a `[mcp_servers.polycarp]` entry in `~/.codex/config.toml` (or `$CODEX_HOME`). `connect codex --write` adds it and keeps the rest of the file; it refuses a file that isn't valid TOML, and an existing `polycarp` entry that says something else.
- **Grok Bot on this Mac**: the same stdio entry in `~/.grok/config.toml`. Check it with `grok mcp doctor polycarp`.
- **Grok Bot on another device**: `connect grokbot --tailnet` gives a `url` and `headers` entry for its `~/.grok/config.toml`, and the `token create` command for the token it needs.
- **claude.ai**: Settings > Connectors > Add custom connector, with the tunnel's `/mcp` address. Leave the OAuth client fields empty.
- **ChatGPT**: turn on Developer mode under Settings > Apps & Connectors > Advanced settings, then Create a connector with the address and OAuth.
- **grok.com**: Connectors > New Connector > Custom, with the address and OAuth.

Web assistants run in their makers' clouds, so they need a public address: your Cloudflare tunnel or Tailscale Funnel. Tailscale Serve reaches only your own devices.

## Scopes

| Scope | Lets a client |
| --- | --- |
| read | List tools, read themes, ask the app what it tracks and how it is set |
| files | Search, fetch and send your files across your devices |
| act | Change themes and settings, move windows to the agent workspace, switch workspaces, open the launcher |
| contacts | Reserved for the contacts feature; no tool uses it yet |

There is no wildcard. stdio has every scope, because it is your own process.

## Approving a web assistant

1. The assistant registers itself (dynamic client registration) and opens Polycarp's sign-in page in your browser.
2. The page shows a code like `ABCD-EFGH`, the assistant's name and the scopes it asks for (read when it asks for none). It never asks you to click Allow: a web page can't approve anything.
3. On this Mac, run `polycarp agent approve ABCD-EFGH`. Add `--scopes read,files,act` to grant more or less than it asked for. `polycarp agent deny ABCD-EFGH` says no. `polycarp agent approve` with no code lists what is waiting.
4. The page goes on by itself and returns the assistant to its own site with a one-time code.

The waiting connections are also written to `agent/approvals.json` (codes, names and scopes; no secrets) for the app to show. The request expires in ten minutes. Every authorization needs your approval, including a returning assistant whose refresh token ran out.

The OAuth server takes PKCE S256 only, an exact match of a registered redirect address, and a `state` it sends back unchanged; a `nonce` comes back in the token response. Redirect addresses must be one of claude.ai's, claude.com's, ChatGPT's or grok.com's callbacks, a loopback address, or one you add to `extra_redirects` in `agent/agent.toml`. Codes last five minutes and work once. Access tokens last an hour. Refresh tokens last 30 days and rotate on every use.

## Local tokens, clients and revocation

```sh
polycarp agent token create --name grokbot --scopes read,act
polycarp agent clients
polycarp agent revoke <id>
```

`token create` prints the token once; only its SHA-256 is kept. A local token works on loopback and the tailnet. Add `--remote` to let it through a tunnel too.

`clients` lists every connector and token with its scopes and last use. `revoke` takes effect on the next request: a revoked connector loses every grant, code and waiting request, and must register again.

## Tunnels

```sh
polycarp agent tunnel cloudflare --hostname agent.example.com   # dev, nightly
polycarp agent tunnel tailscale [--public]                      # dev, nightly
polycarp agent tunnel status
polycarp agent tunnel off
polycarp agent service install [--tunnel] [--tailnet]
```

`tunnel cloudflare` uses your own `cloudflared` and your own Cloudflare account. Sign in first with `cloudflared tunnel login`; Polycarp checks only that the sign-in happened and never asks for or stores an API key. It makes (or reuses) a named tunnel, routes the host name to it, and writes the tunnel's config to `agent/cloudflared.yml`. It won't overwrite a DNS record that already exists. `tunnel off` removes the config and prints the `cloudflared tunnel delete` command; deleting the tunnel from your account is your call.

`tunnel tailscale` runs Tailscale Serve on port 8443 to the gateway. `--public` uses Funnel instead and prints a warning: the sign-in pages become public, though only a connector you approved, or a `--remote` token, can call a tool. Tailnet Lock refuses Funnel; the command says so. It won't replace something else already served on port 8443.

Each tunnel command takes `--dry-run` to print what it would run. `POLYCARP_CLOUDFLARED` sets the `cloudflared` command, and `POLYCARP_TAILSCALE` the `tailscale` one; each passes the same check as every tool Polycarp runs.

`service install` writes a user-level unit (a launchd agent, a systemd user unit or a Scheduled Task) and prints the command that starts it. With `--tunnel` it runs `polycarp agent tunnel run`, which starts cloudflared. Tailscale needs no unit; it keeps Serve and Funnel itself.

## Doctor and fix

`polycarp agent doctor` says whether the gateway answers, whether its files are private, which tunnel is set up and whether this channel allows it, which units are written and loaded, what is waiting for approval, and whether the app is running, with the step that fixes each problem. `--json` gives the same as data. `polycarp agent fix` does only the safe steps: make the folder and its files private again, and restart a loaded unit that stopped answering.

## Where the state lives

Everything is under `agent/` in Polycarp's config folder. The folder is 0700 and every file is 0600, written whole and renamed into place:

| File | Holds |
| --- | --- |
| `auth.json` | Clients, hashed tokens, codes and waiting requests. Every secret is a SHA-256 hash |
| `agent.toml` | Your settings: `port`, `tailnet`, `allow_devices`, `extra_redirects` |
| `tunnel.json` | The tunnel a tunnel command set up |
| `cloudflared.yml` | The Cloudflare tunnel's config (cloudflared's credentials stay in `~/.cloudflared`) |
| `invite.json` | A hosted tunnel invite (stable) |
| `approvals.json` | What is waiting for approval, for the app to show |

## Extension points

Purposes, surfaces and contacts add their tools by implementing `Provider` in `cli/src/agent/gateway.rs` and listing it in `extensions()`. The gateway sets the rules: a purposes or surfaces tool needs read or act, every contacts tool needs contacts, and no extension can replace a built-in tool.

## Threat model

### What a stolen token can do

- **An access token** (from a web connector) can call the tools its scopes allow, through any route, for at most an hour. It can't mint new tokens. With read only, it can read themes, app settings, and the titles of your windows and terminals. With files, it can search your files on every device and fetch or send one. With act, it can change settings and themes and move windows to the agent workspace.
- **A refresh token** can get new access tokens with the same or fewer scopes for up to 30 days. The first time it is used, the old one is spent. If the thief and the real client both use it, the second use ends the whole grant for both, and the client must be approved again.
- **A local token** can do what its scopes allow, until you revoke it. Unless it was made with `--remote`, it works only on loopback and the tailnet, so a copy that leaks off your devices is useless through a tunnel.
- **An authorization code** is useless without the PKCE verifier, which never leaves the client. One wrong verifier burns the code, and a code used twice ends the grant it made.
- None of them can approve a client, widen their own scopes, open a terminal, type into a window, read `auth.json`, or change how Polycarp updates.

`polycarp agent revoke <id>` ends any of them on the next request.

### What a malicious web page can't do

- **Call a tool.** A request from a web page (it carries `Origin`, or `Sec-Fetch-Site` other than `none`) can reach only the public metadata and the approval page. `/mcp`, `/token`, `/register` and `/revoke` refuse it, and no response carries CORS headers, so the page can't read an answer either.
- **Rebind DNS.** Every request must name this server in its Host header: a loopback name, the host of a tunnel this channel allows, or (on the tailnet) this device's own name or address. A page on `evil.example` that rebinds its name to 127.0.0.1 still sends `Host: evil.example` and is refused.
- **Forge a request.** Browsers mark a cross-site post with `Origin`, so a form a page submits to `/token` or `/mcp` is refused before it is read. `/mcp` also takes only `application/json` and a bearer header, which a page can't send cross-site without a CORS preflight, and none is ever answered. No cookie is ever set, so there is nothing for a page to ride on.
- **Approve itself.** Approval happens only on this Mac, at the command line. The approval page has no buttons, no forms and no scripts (`Content-Security-Policy: default-src 'none'`), and it can't be framed.
- **Steal a code by redirect.** A code goes only to a redirect address the client registered, matched exactly, and registration accepts only the known assistants' callbacks, loopback, or ones you added.

### Other users and devices

- Another user on this Mac can't read the state: the folder is 0700. A process running as you can; that is outside what Polycarp can defend.
- Another person's device on your tailnet, a tagged device, or one outside `allow_devices` is refused by whois before the request is read. Your own device still needs a token.
- Through a public tunnel, anyone can reach the sign-in pages and register a client. Registration is rate-limited and capped, and a registered client gets nothing until you approve it here.

### Not built yet

- The hosted tunnel and its relay. Stable only joins the waitlist and stores an invite.
- An approval prompt in the app itself. Until then the app can read `agent/approvals.json`, and `serve` logs each waiting connection with its approve command.
