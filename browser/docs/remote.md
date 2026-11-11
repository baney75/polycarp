# Use Polycarp from claude.ai, ChatGPT and grok.com

Web assistants can drive your own signed-in browser through Polycarp and, if you tick it when you
approve one, apps on your Mac's agent workspace ([Computer use](#computer-use)). It runs on your computer and
through your own free account with Tailscale or Cloudflare: no account with us, no relay, no cost. The commands below
also run as `polycarp browser`, for example `polycarp browser remote setup`.

**In the Polycarp app, use Settings > Browser > "Use Polycarp from Claude, ChatGPT and Grok".** It
walks you through it one step at a time. First pick Tailscale or Cloudflare; each has a button to create
a free account if you don't have one. Then get the tool and sign in, then Turn on. If Tailscale needs
you to allow Funnel for your computer, Polycarp asks you to after you click Turn on, and you try again.
When it's on, the window shows the address and a passcode (once) and says how to add them in each
assistant. Behind the buttons it runs the commands below. The rest of this page is the same thing for
the terminal. One command sets it up.

```bash
polycarp browser remote setup
```

It turns on Tailscale Funnel for this computer, sets an approval passcode (shown once), writes
`remote.json` and installs a user service that keeps `polycarp browser serve` running. When it's done it prints:

- the connector URL, `https://<this-computer>.<your-tailnet>.ts.net:8443/mcp`;
- a one-time connect code (`TK-XXXX-XXXX`, good once for 10 minutes). Type it on the approval page when you add
  Polycarp to an assistant for the first time. `polycarp browser token approval-code` makes another;
- the passcode, only in the run that made it. It re-approves an assistant you already approved; it can't approve a new one;
- where to add the connector in claude.ai, ChatGPT and grok.com, and the status command.

In a terminal it waits instead of stopping. With no route flag it uses whichever of Tailscale and Cloudflare is ready,
and asks when both or neither is. If Tailscale isn't installed it prints the download link and waits; if it's signed
out it waits for the sign-in; if Funnel isn't allowed yet it opens Tailscale's page, says what to click and tries again
every 5 seconds for up to 10 minutes; if `polycarp browser install` hasn't run it runs it (it only writes the launcher
and the native host files, and skips what's current). Each wait prints one line naming what it waits for. Ctrl-C stops
it, and running setup again continues from where it was. `--no-wait` makes it stop and say what to do instead, and
`--no-input` never asks a question (it needs `--tailscale`, `--cloudflare <name>` or `--public-url`). `--json`, or a
run with no terminal, never waits or asks.

Check it any time:

```bash
polycarp browser remote status
```

Each line is ok, warn or fail: `remote.json`, the passcode, whether `serve` answers on this
computer, whether public DNS resolves the name to an address outside the tailnet, and whether
the public URL answers. The DNS line matters: from inside your own tailnet, a ts.net name works
even when Funnel isn't reaching the internet, so a passing public fetch alone can hide a broken
Funnel. The computer must stay on, awake and signed in to the browser with Polycarp loaded.

## Tailscale or Cloudflare

Both are free and run on your own account. Polycarp never makes an account and doesn't install either tool.

- **Tailscale** needs no domain, so it's the quickest. The address is `https://<computer>.<tailnet>.ts.net:8443`.
- **Cloudflare** puts the address on a domain you have on your Cloudflare account, because a Cloudflare tunnel with a
  fixed name needs one. No domain there means Tailscale, or a domain added in Cloudflare first.

From the terminal:

```bash
polycarp browser remote cloudflare login                        # your browser opens Cloudflare; pick the domain
polycarp browser remote setup --cloudflare polycarp.example.com
```

`setup` makes a tunnel named `polycarp-<this computer>`, or reuses it, adds the DNS record and keeps both `serve` and
`cloudflared` running as services. It never overwrites or deletes a DNS record: a name already in use is refused, in
Cloudflare's own words. A sign-in covers one domain, so a name on another domain is refused too, and it says how to sign
in for that one. Before it makes anything it asks public DNS which zone the name is in and refuses one that isn't on
Cloudflare, and it remembers the zone your sign-in turned out to cover, so a later name outside it is refused with
nothing made.

In a terminal, `remote setup --cloudflare` does the rest inline: with no `cloudflared` it offers the download below
(y/N; `--yes` accepts, and it never downloads without one of those), signs you in to Cloudflare and waits, asks for the
name if you gave none, and after the tunnel starts checks the public address for up to 5 minutes, with a line while it waits.
`remote off` stops the tunnel and leaves the tunnel and its record on your account, so turning it on again reuses them;
`cloudflared tunnel delete polycarp-<this computer>` removes the tunnel for good.

Settings > Agents has a "Set up with Cloudflare" button that does the same: enter the address, sign in to Cloudflare in the
tab it opens, and it makes the tunnel and checks the public address. If no `cloudflared` is installed it downloads its own
(pinned release 2026.10.7, SHA-256 checked before anything is unpacked or run) to `~/.config/polycarp/browser/bin/cloudflared`; one on
your PATH or in Homebrew's folders is used first. When Funnel is on, the button moves to Cloudflare and turns Funnel off only after the tunnel is ready; in a terminal that is `remote setup --cloudflare <name> --replace-funnel`.

`polycarp browser tunnel cloudflare` is a quick tunnel for local testing with a token, with no account: a temporary
`*.trycloudflare.com` address that changes each time it starts. claude.ai, ChatGPT and grok.com can't use it, because a
quick tunnel doesn't carry their event stream. For them, use `polycarp browser remote setup`. It finds `cloudflared` the
same way setup does, including the copy setup downloaded.

## Computer use

Two permissions on the approval page, both unticked until you tick them: `computer.read` (see the
agent workspace and apps you lend) and `computer.act` (see them too, click and type in them, and start
apps from Polycarp's short list). The assistant gets `computer_*` tools, which run through
`polycarp-spaces mcp --connector` on your Mac. They need the Polycarp app, so another machine doesn't
offer them. An agent on the Mac itself gets them from the local stdio server without a connector or a
token (README, "Computer use on this Mac"), with the access mode set in Settings > Agents; everything
below is about remote callers only.

A connector is held to Default whatever else is on. Full Access in Settings is for agents on your Mac:
with it on, a connector still sees only the agent workspace and apps you lend, and starts only apps on
the short list. It can't lend itself anything and can't drive an Open or Save panel in any window. An
app Polycarp starts for it can't show a document from outside the handoff folder. Read Only stops it
acting too. An app you lend is lent with what it shows, to every agent and connector with these
permissions, until you take it back or the time runs out. If the Polycarp app or `polycarp-spaces` on
this Mac is too old to enforce all this, the connector gets no computer tools.

The agent's apps run as you. Those window rules keep it out of your other windows, but an app can reach
what you can, so tick this only for an assistant you'd let sit at your keyboard. Revoke a connector with
`polycarp browser token revoke` and everything it was granted ends.

## For an app

`remote status --json` and `remote setup --json` print one JSON object, so an app never reads
sentences. `state` is one of `tailscale_missing`, `tailscale_signed_out`, `funnel_not_allowed` (with
`adminUrl`, the page Tailscale printed), `funnel_closed` (status only), `cloudflared_missing`, `tailnet_lock`, `port_busy`, `ready`, `on` (with
`connectorUrl`), `no_browser_connected` or `problem` (with `message`, and sometimes `code`).
`status --json` also has `routes`: `tailscale` and `cloudflare`, each with `installed` and `signedIn`, read without changing anything.
`setup --json` includes `passcode` only in the run that made it, even when that run then fails, so
keep it. `token passcode --json` makes a new one. It mints no connect code unless you pass `--connect-code`; then it adds
`connectCode` (`TK-XXXX-XXXX`) and `connectCodeExpiresAt` (milliseconds since 1970, 10 minutes on). Neither is logged.

`setup --json` also says what comes next in `next`: `{kind, url?, command?}`, where `kind` is `install` (with the
download `url`), `sign_in` (with the `command`), `open_page` (`url`), `run_command` (`command`), `choose_name` (pick
another Cloudflare name) or, on `on`, `add_connector` (`url`, the connector URL). The exit code is 0 for `on`, 1 for a
failure, 2 for a usage error and 3 when a person has to do something, which `next` names.
`remote off --json` prints `{ok, message, notes}` with the same 0 or 1.

`code` says why when it matters. For `problem`: `launcher`, `hub`, `service`, `serve` (nothing answers
on the local port, so nothing was turned on), `funnel` (Tailscale's own words are in `message`),
`tailscale_operator` (Tailscale refused because your user isn't its operator; `next` has the command),
`cloudflare_login`, `cloudflare_name` (no name was given), `cloudflare_zone` (the name's zone isn't on Cloudflare or
isn't the one you signed in for; checked before any record is made), `cloudflare_dns`, `cloudflare_tunnel` or
`config`. A failure after the passcode was made, such as a file that can't be written, is a `problem` with
`code` `config`, `service` or `funnel`, and still carries the `passcode`. For `port_busy`: `tailscale_port` (a saved Tailscale setting already uses 8443) or
`local_port` (a program on this computer uses the local port). A status read on the Funnel route
names `tailscale_missing`, `tailscale_signed_out` or `tailnet_lock` ahead of `problem`, and
`funnel_closed` when Tailscale's Funnel isn't open for the saved address (status only; `remote setup`
opens it again). `problem` with `code` `dns` means the only failures are public DNS and the public
fetch, which lag a new address by minutes.

`funnel_not_allowed` means Tailscale printed its login.tailscale.com page for enabling Funnel. The
helper returns it as soon as the page appears and stops that `tailscale funnel` call, which would
otherwise wait; every `tailscale funnel` call is bounded at 30 seconds. On the Funnel route, `on` is reported only after
`tailscale serve status` shows Funnel on for the machine. The Mac app's own `tailscale` is found at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` when it isn't on PATH, so the terminal and the
app behave the same.

## What you need

- Polycarp installed and connected (`polycarp browser setup`, then `polycarp browser install` so the service has a
  launcher to start).
- Tailscale on this computer, signed in. Free plan is enough. If Funnel isn't allowed for your
  tailnet yet, `polycarp browser remote setup` opens the Tailscale page that allows it and waits while you
  allow it (with `--no-wait`, `--json` or no terminal it prints the page and stops; run setup again after).

On Linux, two more things:

- Tailscale refuses changes from a user who isn't its operator, with "Access denied" and its own advice. Setup
  prints the fix and waits for you to run it once; Polycarp never runs sudo:

  ```bash
  sudo tailscale set --operator=$USER
  ```

- A systemd user service stops when you log out unless lingering is on. Setup and `remote status` warn when it
  isn't, with the fix: `loginctl enable-linger $USER`. `remote status` also warns when Tailscale has no operator.

Funnel runs on its own port (8443), so the OAuth paths sit at the root of the URL, and anything
you serve on 443 stays private.

## If Funnel won't work

`polycarp browser remote setup` stops, without changing anything, when:

- Tailscale isn't installed (in a terminal it waits for you to install it instead).
- The tailnet has Tailnet Lock on. Funnel doesn't work on a Tailnet Lock tailnet.
- Port 8443 on this computer already serves something else, or forwards plain TCP.
- A `remote.json` or a service from an earlier setup is in the way (`polycarp browser remote off` clears it).

The free way out is your own HTTPS front door. A Cloudflare named tunnel costs nothing (an
account includes 1,000) and needs a domain on Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create polycarp
cloudflared tunnel route dns polycarp polycarp.<your domain>
```

Point the tunnel at Polycarp in `~/.cloudflared/config.yml`:

```yaml
tunnel: polycarp
credentials-file: /home/<you>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: polycarp.<your domain>
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run it (`cloudflared tunnel run polycarp`, or as a service with `cloudflared service install`),
then tell Polycarp the address:

```bash
polycarp browser remote setup --public-url https://polycarp.<your domain>
```

`--public-url` takes an origin only (`https://host`, no path). Any HTTPS front door that forwards
to `127.0.0.1:8787` works the same way. `--port N` changes the port; `--no-service` skips the
service, and you start `polycarp browser serve` yourself. Quick tunnels (`trycloudflare.com`) won't do:
the name changes on every start.

If you switch from Funnel to your own front door, run `polycarp browser remote off` first so Funnel closes;
setup refuses to switch while Funnel from an earlier setup is on.

## Add the connector

Paste `<public URL>/mcp` in each:

- **claude.ai**: Settings > Connectors > Add custom connector.
- **ChatGPT**: Settings > Apps & Connectors (turn on developer mode) > Create. Choose OAuth.
- **grok.com**: grok.com/connectors > New Connector > Custom.

Each opens Polycarp's approval page. Check the name and the site you return to, tick the
permissions, enter the connect code setup printed and press Allow. A new assistant needs a connect
code; the passcode alone is refused for one (D34). Code used or expired? `polycarp browser token approval-code`
makes another. Later approvals of an assistant you already approved take the passcode. Only approve a connection
you just started. Lost the passcode? `polycarp browser token passcode` makes a new one; approvals you already
gave keep working.

## Windows

Both routes work on Windows without administrator rights, and Polycarp runs no installer. Install Tailscale or
cloudflared yourself as usual, or let the Cloudflare route offer Polycarp's own copy of cloudflared (Windows on x64 only;
it asks first, as on the Mac, and checks the download's SHA-256 before using it). Polycarp finds `tailscale.exe` and
`cloudflared.exe` on PATH, then in the installers' folders (`C:\Program Files\Tailscale`, `C:\Program Files\cloudflared`,
`C:\Program Files (x86)\cloudflared`), then its own copy, `bin\cloudflared.exe` in the helper's config folder.

Windows has no user service like launchd or systemd, so each service is a Task Scheduler task for your account alone:
`com.polycarp.serve`, plus `com.polycarp.cloudflared` on the Cloudflare route (`com.polycarp.hub` and `com.polycarp.link`
for a hub and a device). Each starts when you log on, runs with your own limited rights, stores no password, and runs a
small script that starts the program again 10 seconds after it stops. They live in the helper's config folder, the same one
it uses everywhere else: `%USERPROFILE%\.config\polycarp\browser`, or `POLYCARP_BROWSER_CONFIG_DIR` when you set it.

- The scripts the tasks run: `services\com.polycarp.serve.cmd` and the others beside it.
- The logs: `logs\polycarp-serve.log`, `logs\polycarp-cloudflared.log` and so on (Windows has no journal). When the
  program starts again, a log past 10 MB becomes `<name>.log.1`, replacing the one before; a program that runs for weeks
  keeps writing to the same log until then.

The scripts name no folder: each finds the config folder from its own place, so a profile folder with letters outside
ASCII works.

Each task shows a command window while it runs, titled with its name. Closing that window stops the service until you
log on again or run setup again. `schtasks /Query /TN com.polycarp.serve /V /FO LIST` shows a task.

`polycarp browser remote off` removes it: it ends the tasks, ends the programs they started with `taskkill /T` and checks
they are gone, then deletes the tasks and their scripts, and keeps the logs. Each program records its pid and start time
when it starts and marks the record `exited` when it exits; a pid is ended only while Windows (`Get-Process`) reports the same
start time, so a pid Windows has since given to another program is never touched. A program that won't stop, one whose
start time can't be read, or a running task with no record leaves its task in place and says what to end in Task Manager.
If Windows refuses to make a task, in any language, setup says your organization may block scheduled tasks and how to run
`polycarp browser serve` yourself instead.

When setup asks you to allow Funnel, it opens the page in your default browser (on Windows through `rundll32.exe
url.dll,FileProtocolHandler`, so no command line parses the address) and prints the address either way.

## Revoke

```bash
polycarp browser token clients   # connectors and their grants
polycarp browser token revoke tkc_...  # remove one client and every grant it holds
polycarp browser remote off      # close Funnel, stop the service, delete remote.json
```

`remote off` leaves approvals in `oauth.json`. They can't be used while the URL is gone, but they
become usable again if you set up later with the same URL. `polycarp browser token clients` lists them and
`polycarp browser token revoke <client id>` ends them for good.

On a custom route (`--public-url`), `remote off` can't close your front door: your own tunnel
keeps forwarding to this computer. Stop it there, for example by stopping `cloudflared`.

## Security notes

- Anyone on the internet can reach the URL. Two things stand between them and your browser: the
  connect code or passcode on the approval page (a new assistant needs the one-time code; five wrong tries per
  connection, then a 15-minute wait) and the per-permission consent. Keep the passcode in a password manager the browser Polycarp drives can't fill, and don't reuse it.
- An approval carries only the permissions you ticked; there is no wildcard. `browser.script`
  (run code in a page as you) and `threads.read` (your past chats) start unticked. Leave them off
  unless you need them.
- Access tokens last an hour, refresh tokens rotate, and an old refresh token coming back ends
  the grant. Only hashes are stored, in `oauth.json` (0600), next to `remote.json` (0600).
- Agents work in their own tab group, in your signed-in browser. Sites you haven't allowed still
  ask first. Revoke a connector you stop using.
- `serve` listens on loopback only and answers only the public host and loopback names.

## Many devices, one connector

One connector URL for claude.ai, ChatGPT and grok.com, and any number of your own computers behind
it. The hub runs on an always-on box (a small server, a Raspberry Pi) and needs no browser. Each
computer that has a browser with Polycarp dials in. It is still your own server, with no relay and
no cost (D32).

On the always-on box, with an HTTPS front door pointing at `127.0.0.1:8787` (a free Cloudflare
named tunnel works, as in "If Funnel won't work" above):

```bash
polycarp browser hub setup --public-url https://polycarp.<your domain>  # hub.json, a passcode (shown once), a service
polycarp browser hub code                                      # a one-time code, valid 10 minutes
```

On each computer with a browser:

```bash
polycarp browser link https://polycarp.<your domain> --code TK-XXXX-XXXX [--name laptop] [--scope browser.read,browser.act]
```

`link` enrolls the computer and installs a user service (`com.polycarp.link` or
`polycarp-link.service`) that runs `polycarp browser link run`. `--scope` is what this computer allows at
most; without it, the default grant (no `browser.script`, no `threads.read`). Then add
`https://polycarp.<your domain>/mcp` once in each assistant, as above. Approve with your passcode,
or with a one-time code from `polycarp browser token approval-code` (or `polycarp browser link approval-code` on a
manager device): the field reads "Passcode or connect code". A connector you have not approved
before (a new client) needs the one-time code; the passcode alone is refused for it, so a link
someone else sends you cannot be approved by typing the passcode (D34). Once a client is approved,
later approvals for it take the passcode as before.

```bash
polycarp browser hub devices         # online, extension, sessions, busy, last seen
polycarp browser hub prefer laptop,desktop  # who wins a tie
polycarp browser link busy on        # on a device: new sessions go elsewhere first
polycarp browser hub status          # hub.json, passcode, local answer, public DNS and fetch, devices
```

Settings > Agents in the side panel does the same from the browser: it shows the connector URL,
makes a one-time code for the approval page, lists the devices (on the hub's computer), makes a
connect code for another device, and joins a hub from a code. It asks Polycarp's helper, so it needs
`polycarp browser setup` first. See D33 in [decisions.md](decisions.md).

### What a device allows

A device's cap lives in its own `link.json`, and only that computer changes it. Nothing the hub
sends can write it.

```bash
tabkyra link scopes                          # what this device allows
tabkyra link scopes --remove browser.script  # narrower: the next call that needs it is refused
tabkyra link scopes --add browser.script     # wider: applies once link run starts again
```

A narrower cap applies to the very next call, also on sessions already open: that call gets
"laptop doesn't allow browser.script (allows: ...). Only its owner can add it, on laptop." `link run`
reads `link.json` at every tool call, inside its local server, after the call's arguments are parsed,
so the check judges the call that runs. It counts arguments too: `read_network` with `requestId`
needs `browser.script`, and `session_info` with `label` needs `browser.navigate`. In front of the
local server, a body on an open session that doesn't parse as UTF-8 JSON is refused, and the
content-type the server sees is always `application/json`. The last scope can't be removed;
`tabkyra link off` stops serving. A wider cap needs a new link token, so `link scopes --add`
restarts the link service when there is one, and open sessions start over.

Computer use (`computer.read`, `computer.act`) is not available over a link yet. Granting it needs
the owner's approval in the Polycarp app, which isn't built yet, and nothing else can stand in for it:
a yes typed at a terminal can come from an agent running the command in a pseudo-terminal, and an
agent with a shell can edit `link.json` by hand. So:

- `link --scope computer.act` and `link scopes --add computer.act` (or `computer.read`) are refused
  and change nothing: "computer.act can't be turned on from the command line: granting computer use
  over a link needs the owner's approval in the Polycarp app, and that approval isn't built yet."
- `link run` never serves a computer scope, whatever `link.json` says. That includes a cap an
  earlier preview build wrote: it loses its computer scopes. `link run` logs one line naming them,
  and `link status` (and `link status --json`, as `notServed`) says which ones and why. It also drops
  any scope this computer can't serve.
- The next `link scopes` change writes the cap without them.
- Joining a hub from the side panel never grants computer use, and the panel doesn't offer it.

A computer without Polycarp's Mac app (`polycarp-spaces`) is told "This computer can't serve
computer.read: computer use needs Polycarp's Mac app, and it isn't on this computer."

A cap written as an empty list allows nothing; only a `link.json` with no `scopes` gets the default
grant. Removals are checked under `link.json`'s lock, so two at once can't empty the cap.

### How a session is routed

A new session goes to an online device that has reported in, grants at least one of the caller's
scopes, and has room (fewer than 32 requests in flight, and fewer sessions than its own cap of 24).
Of those, devices whose extension is connected come first. Then, in order: full coverage of the
caller's scopes, not busy, the fewest sessions, your `prefer` order, the one seen most recently. If no
device has its extension connected, any of them takes it (tools such as `skill_match` still work).
If none is online, the assistant gets a 503 that names each device and when it was last seen; if
none grants any of the caller's scopes, a 403 that names what each allows; if all are full, a 429.
Requests carry up to 4 MB of body in frames of up to 16 MB, and a request that would not fit a
frame after escaping gets a 413 without disturbing the link. A response is streamed with backpressure:
a client that stops reading is cancelled after 30 seconds. A session
stays on its device and only for the caller that opened it. When that device goes away, the next
request on its session gets 404, the assistant starts a new session, and another device takes it.

### Pick a device for one call

The hub sends every device a list of all of them (the roster), and a session behind a hub has a
`devices` tool: each device's name, id, platform, online or when last seen, what it allows, and
whether it has the browser extension and computer use. Every other tool takes an optional `device`
(a name or id from `devices`). Without it, a call runs on the session's own device, exactly as
before. With another device's name, the hub sends that one call there, in a second session it opens
on that device for this session (once, then reused, and closed when this session ends), and removes
`device` from the call first.

- The second session gets the caller's own scopes, narrowed by that device's own cap on the device,
  as any new session is. What the session's first device allows never carries over.
- The hub checks the target's cap before it sends anything, and refuses a tool outside it:
  `Parish1 doesn't allow computer.act (allows: browser.read, ...). Only its owner can add it, on Parish1.`
- An offline device: `Chapel1 is offline (last seen 2026-11-10 14:02). Nothing was sent. Online now: Mac, Parish1.`
  A name the hub doesn't know: `No device called "X". Devices: Mac, Parish1, Chapel1.`
- A device that drops while the call runs: `Parish1 went offline while this call ran. The action may
  have landed: read it back before you repeat it.`
- Each of these is a tool result marked as an error, never an HTTP failure, so the session stays.
- A call that still names another device when it reaches one (an older hub, or a JSON-RPC batch, which
  the hub doesn't route) is refused there and nothing runs.
- Site approvals: no session through a hub asks the assistant to approve a site, on its first device
  or another. A new site waits for you in that device's side panel (Settings > Agents), and the
  assistant is told to ask you to allow it there.

### Revoke

```bash
polycarp browser hub remove laptop  # the credential stops working, the live link closes within a second
polycarp browser link off    # on a device: stop the service, forget the hub, revoke its link token
polycarp browser hub off     # stop the hub service and remove hub.json (devices stay enrolled)
```

`hub code --manage` makes the device a manager: it can run `polycarp browser link code` and
`polycarp browser link approval-code`, which ask the hub for codes over HTTPS with the device credential.
Use it only for a computer you would trust with the passcode.

### Security notes

- Callers reach a device only through the hub. The hub sets the caller's scopes itself and drops
  any `x-tabkyra-hub-*` header a public client sends. A device narrows them by its own cap; it never
  widens. A device's link token works only on the loopback server `link run` starts.
- A device credential is 32 random bytes, stored on the hub only as a SHA-256 hash; connect codes
  and approval codes are single-use, last 10 minutes and are stored only as hashes. Wrong connect
  codes are limited (five per source, 20 in all, per 15 minutes, so anyone can pause enrollment, and
  only enrollment, for 15 minutes); wrong approval codes count toward the passcode's limit and
  15-minute lockout. A valid device credential is never refused because of other people's failures.
- Only one `polycarp browser link run` can run on a device; a second refuses to start. When the link drops,
  the device closes the sessions it carried, and assistants simply start new ones.
- The hub listens on loopback and answers only its public host. A device removed with
  `polycarp browser hub remove` loses its link within a second.
- Cost: free. Nothing here runs on anyone else's server.

See D30, D31 and D32 in [decisions.md](decisions.md) for why each install is its own server.
