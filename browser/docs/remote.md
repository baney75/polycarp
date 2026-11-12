# Use Polycarp from claude.ai, ChatGPT and grok.com

Web assistants can drive your own signed-in browser through Polycarp and, if you tick it when you
approve one, apps on your Mac's agent workspace ([Computer use](#computer-use)). It runs on your computer and
through your own free account with Tailscale or Cloudflare: no account with us, no relay, no cost. The commands below
also run as `polycarp browser`, for example `polycarp browser remote setup`.

**In the Polycarp app, use Settings > Browser > "Use Polycarp from Claude, ChatGPT and Grok".** It
walks you through the same steps with buttons. The rest of this page is the terminal.

## Quick start

One command:

```bash
polycarp browser remote setup
```

What you will see, in order:

1. If both Tailscale and Cloudflare are ready, or neither is, it asks which one. Tailscale needs no domain, so pick it
   if you're unsure.
2. A line for each thing it waits on, if any: installing Tailscale (with the link), signing in, or allowing Funnel on
   Tailscale's page, which it opens for you. Do that step; setup carries on by itself. Ctrl-C stops it, and running it
   again continues from where it was.
3. `From the internet, as an assistant sees it:` and one line per check (public DNS, the certificate, the OAuth
   metadata, the sign-in challenge, a streaming probe). All ok means an assistant can connect now. A brand-new name
   can take a few minutes to reach public DNS; then run `polycarp browser remote test` again in a few minutes.
4. The connector URL, `https://<this-computer>.<your-tailnet>.ts.net:8443/mcp`.
5. A connect code (`TK-XXXX-XXXX`). It works once, for 10 minutes. `polycarp browser token approval-code` makes another.
6. The passcode, only in the run that made it. Keep it: it re-approves an assistant you already approved.

Then add the connector URL in each assistant you use:

- **claude.ai**: Settings > Connectors > Add custom connector. Paste the URL, then Add.
- **ChatGPT**: Settings > Apps & Connectors, turn on developer mode, then Create. Paste the URL and choose OAuth.
- **grok.com**: grok.com/connectors > New Connector > Custom. Paste the URL.

Each opens Polycarp's approval page. Check the name, tick the permissions, type the connect code and press Allow.

To prove it works from outside at any time, and to repair it:

```bash
polycarp browser remote test   # what an assistant sees: DNS, TLS, OAuth, sign-in, streaming
polycarp browser remote fix    # repairs what test or status found, asking before each step
```

## Mac, Linux and Windows

**Mac.** Install Tailscale from the App Store or tailscale.com and sign in; setup finds the app's own `tailscale` at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` when it isn't on PATH. Services run under launchd
(`~/Library/LaunchAgents/com.polycarp.serve.plist`), and the Mac must stay on and awake.

**Linux.** Two one-time steps that Polycarp prints and never runs for you, because both need root or a session change:

```bash
sudo tailscale set --operator=$USER   # lets your user open Funnel
loginctl enable-linger $USER          # keeps your user services running after you log out
```

Services run as systemd user units (`~/.config/systemd/user/polycarp-serve.service`). `remote status` and `remote fix`
warn when either step is missing.

**Windows.** Both routes work without administrator rights. Each service is a Task Scheduler task for your account,
and its log is a file in the config folder ([Windows](#windows)). Task Scheduler words a task's status in the system's
language, so `remote status` and `remote fix` treat an installed tunnel task as running; `remote test` says whether it answers.

## Troubleshooting

Run `polycarp browser remote fix` first: it repairs what it can, one step at a time, and names the rest. `remote test`
and `remote status --json` give the `state` or check name in the first column.

| State or check | What it means | Do this |
| --- | --- | --- |
| `not_set_up` | Nothing is set up on this computer. | `remote setup` |
| `tailscale_missing` | Tailscale isn't installed. | Install it from tailscale.com, then `remote setup`. |
| `tailscale_signed_out` | Tailscale isn't connected. | Open Tailscale and sign in (`tailscale up` on Linux). |
| `tailnet_lock` | Funnel doesn't work with Tailnet Lock on. | Use Cloudflare: `remote setup --cloudflare <name>`. |
| `funnel_not_allowed` | Your tailnet hasn't allowed Funnel for this computer. | Open the `adminUrl` page and allow it; setup waits. |
| `funnel_closed` | Funnel was turned off for this address. | `remote fix` opens it again. |
| `cloudflared_missing` | cloudflared is gone. | `remote fix` offers the pinned download. |
| `port_busy` | Another program uses the local port or 8443. | Stop it, or `remote setup --port N`. |
| `dns` | Public DNS has no public address (A or AAAA) for the name, or the lookup failed (SERVFAIL). | No address yet: wait a few minutes for a new name; else `remote fix`. A failed lookup: fix the name's DNS records or DNSSEC with your DNS provider. |
| `tls` | The certificate isn't valid for the name, the port speaks plain HTTP, or nothing answers. | `remote fix`; on your own front door, a certificate for the name. |
| `resource_metadata` | The public name reaches something that isn't this connector, or (`pending`) its tunnel or gateway answers 502, 503, 504, 521, 522, 523 or 530 or nothing: it hasn't connected yet. | A pending one: wait a minute, then `remote test`. Otherwise, or if it stays: `remote fix` (restarts `serve` and the tunnel; a renamed computer gets its new URL). |
| `auth_metadata` | The OAuth server metadata names another address, or no authorization or token endpoint on this one. | `remote fix`. |
| `auth_challenge` | `/mcp` doesn't answer a sign-in challenge. | `remote fix`. |
| `streaming` | The stream's first bytes take over 5 seconds, so assistants time out. | Use Tailscale Funnel or a Cloudflare named tunnel, not a quick tunnel or a buffering proxy. |
| `probe_cleanup` | `remote test` couldn't delete its probe token. It stops working by itself two minutes after it was made. | The `token revoke <id>` command in `next`. |
| `passcode` | No passcode is set. | `polycarp browser token passcode` (shown once). |
| `linger`, `tailscale user` | Linux one-time steps. | The command in [Mac, Linux and Windows](#mac-linux-and-windows). |

`remote fix` restarts the `serve` and `cloudflared` services, opens Funnel, downloads cloudflared after you say yes, and
rewrites `remote.json` when the computer was renamed. When the name changed it prints the old URL and the new one: add
the new URL in each assistant; the old one no longer works. It never deletes or overwrites a DNS record, runs sudo,
touches Tailnet Lock, turns a route off, revokes a token or connector, or makes a passcode. In a terminal it asks
before each step; `--yes` skips the questions, `--dry-run` lists the steps and changes nothing, and with no terminal and
no `--yes` it changes nothing and exits 3 with the list.

## Check it

```bash
polycarp browser remote status   # fast checks from this computer
polycarp browser remote test     # the proof, from outside
```

`remote status` checks `remote.json`, the passcode, whether `serve` answers on this computer, public DNS and a public
fetch. From inside your own tailnet a ts.net name answers even when Funnel isn't reaching the internet, so status adds a
`public test` line pointing to `remote test` when its fetch could have stayed inside the tailnet.

`remote test` asks public DNS (DNS over HTTPS) for the name and connects to that public address with the name as TLS SNI
and Host, as an assistant does. It checks the certificate, `/.well-known/oauth-protected-resource/mcp`, the
authorization server metadata (its issuer, and an authorization and token endpoint, plus any registration endpoint, on
the connector's own address), that `POST /mcp` without a token answers 401 with a `WWW-Authenticate` naming the
metadata, and a streaming probe: an authenticated request whose event stream must start within 5 seconds. The probe
uses a token made for it alone, with the narrowest scope (`skills.read`, no browser access) and a two-minute expiry that
every token check enforces, and deleted when the probe ends, also on Ctrl-C. If the delete fails, the run fails with a
`probe_cleanup` check naming the token's id; the token still stops working at its expiry. Its secret is never printed,
logged or in `--json`. Every request has an absolute deadline, so a proxy that trickles bytes can't stretch it. `remote setup` runs the same checks at its end. The
computer must stay on, awake and signed in to the browser with Polycarp loaded.

## Setup in detail

`remote setup` turns on Tailscale Funnel for this computer, sets an approval passcode (shown once), writes
`remote.json` and installs a user service that keeps `polycarp browser serve` running.

In a terminal it waits instead of stopping. With no route flag it uses whichever of Tailscale and Cloudflare is ready,
and asks when both or neither is. If Tailscale isn't installed it prints the download link and waits; if it's signed
out it waits for the sign-in; if Funnel isn't allowed yet it opens Tailscale's page, says what to click and tries again
every 5 seconds for up to 10 minutes; if the service has no launcher yet it writes one (only the launcher; run
`polycarp browser install` yourself to register browsers). `--no-wait` makes it stop and say what to do instead, and
`--no-input` never asks a question (it needs `--tailscale`, `--cloudflare <name>` or `--public-url`). `--json`, or a
run with no terminal, never waits or asks. A connect code is made for a person at a terminal, or with `--connect-code`.

## Tailscale or Cloudflare

Both are free and run on your own account. Polycarp never makes an account. It installs neither tool, and downloads cloudflared only when you say yes.

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
Cloudflare's own words. Before it makes anything it asks public DNS which zone the name is in, and refuses a zone public
DNS shows is served somewhere other than Cloudflare, or a name outside the zone an earlier sign-in proved. Polycarp never
reads cloudflared's sign-in file, so with several zones on your account and no earlier setup it can't tell which one the
sign-in covers. If Cloudflare then puts the record in another zone, setup stops, names the record it made, and says you
can delete it in the Cloudflare dashboard (DNS, Records); Polycarp never deletes DNS records. It remembers the zone, so
the next name outside it is refused with nothing made.

In a terminal, `remote setup --cloudflare` does the rest inline: with no `cloudflared` it offers the download below
(y/N; `--yes` accepts, and it never downloads without one of those), signs you in to Cloudflare and waits, asks for the
name if you gave none, and after the tunnel starts checks the public address for up to 5 minutes, with a line while it waits.
`remote off` stops the tunnel and leaves the tunnel and its record on your account, so turning it on again reuses them;
`cloudflared tunnel delete polycarp-<this computer>` removes the tunnel for good.

Settings > Agents does the same with buttons; see "From the side panel" below. If no `cloudflared` is installed it
downloads its own (pinned release 2026.10.7, SHA-256 checked before anything is unpacked or run) to
`~/.config/polycarp/browser/bin/cloudflared`; one on your PATH or in Homebrew's folders is used first. When Funnel is on,
choosing Cloudflare turns Funnel off only after the tunnel is ready; in a terminal that is
`remote setup --cloudflare <name> --replace-funnel`.

## From the side panel

Settings > Agents > "Use Polycarp from Claude, ChatGPT and Grok" turns it on without a terminal, on Mac, Linux and
Windows. It asks Polycarp's helper through the native host, so the helper must be installed; nothing the page holds
reaches a command line (the remote methods take no parameters, and the Cloudflare address is checked before use).

1. **Choose a way.** Tailscale (no domain; recommended when it is installed) or Cloudflare (a domain on your account).
2. **Get it and sign in.** The page names what is missing, with one button: Tailscale's download page, the command to
   sign in, or "Turn on" for Cloudflare, which downloads cloudflared and opens Cloudflare's sign-in. It checks every
   3 seconds and moves on by itself.
3. **Turn on.** If Tailscale hasn't allowed Funnel yet, the page opens Tailscale's page once and tries Funnel again every
   5 seconds for up to 10 minutes; no "try again" press is needed. After 10 minutes it stops and shows "Check again".

The result shows the connector URL, a one-time connect code with a 10-minute countdown and "New code", the steps for
claude.ai, ChatGPT and grok.com (the same lines `remote setup` prints), and the checks from the internet
(`remote test`). A code comes only from a press: Turn on makes one, and when the Funnel retry turned the route on by
itself the result asks you to press New code. A brand-new name that public DNS doesn't have yet, or a tunnel still
connecting, is a `pending` check: the result says the address is still being published and checks again every 30
seconds until it passes. When a check fails for real and the helper's `remote fix` has something to do, a Repair button
runs it; an older helper shows no button. The side panel never makes or shows a passcode: a new connect code approves an assistant again. The code lives
only in the page's memory and is gone when Settings closes.

The Mac app's Settings > Browser has the same three steps in the same words (they come from one table, held equal by
`test/remote-copy.test.mjs`). Its differences: "Get it for me" asks for the Cloudflare address first and runs
`remote setup --cloudflare <name> --yes`, Funnel is tried again every 15 seconds by running setup again, and a run that
makes the passcode shows it once, labeled for re-approving. The passcode and the connect code are forgotten when
Settings closes, not on a tab switch. Leaving the section pauses the Funnel retry and coming back resumes it, without
opening Tailscale's page again. A setup answer whose `next` is `remote fix` is a failed check with Repair, not a name still
being published, and brings no connect code.

The Linux desktop app has no remote screen; on Linux, use the side panel or the terminal. On Windows the helper finds
`tailscale.exe` and `cloudflared.exe` in their installers' folders as well as on PATH ("Windows" below).

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
download `url`), `sign_in` (with the `command`), `open_page` (`url`), `run_command` (`command`; a `<name>` in it is yours to fill in, as in `install --browser <name>`), `choose_name` (pick
another Cloudflare name) or, on `on`, `add_connector` (`url`, the connector URL). The exit code is 0 for `on`, 1 for a
failure, 2 for a usage error and 3 when a person has to do something, which `next` names.
`remote off --json` prints `{ok, message, notes}` with the same 0 or 1.

`setup --json` ends with `checks`, the same list `remote test --json` gives (below). Only a failure marked `pending`
(no public address yet, or nothing answering yet) is what a new name looks like for a few minutes; setup is then `on` and
says to run `remote test` later. One pending failure is reported as a `problem`: the name resolves and has a certificate,
but the tunnel in front of `serve` answers 502, 503, 504, 521, 522, 523 or 530, or nothing, as a Cloudflare tunnel does
for a minute after its service starts. `--json` never waits, so it reports this at once with `next` `run_command`
`remote test` (exit 3); only a person at a terminal on Tailscale or Cloudflare waits, asking every 5 seconds for up to 5
minutes, and then gets `next` `remote fix`. On your own front door (`--public-url`) the same answer is a fault (exit 1):
point it at `127.0.0.1:<port>`. Any other failed check (a refused certificate, a 421, another connector's metadata, a
held stream, no sign-in challenge) makes setup a `problem` whose `code` is that check's name, exit 1, with the saved
`connectorUrl`, and `remote.json` is kept. Every failure after `remote.json` is saved carries `connectorUrl`. With `--connect-code`, a code that can't be made is a `problem` with `code`
`connect_code`, the reason in `connectCodeProblem`, the `connectorUrl` and, when this run made it, the `passcode`; it exits
1 and the route stays set up.

`remote test --json` prints `{ok, state, code?, message, publicUrl, connectorUrl, checks}`. `state` is `on` when every
check passes, else `problem` with `code` naming the first failed check. Each of `checks` is `{name, status, detail,
next?, pending?}`: `status` is `ok`, `warn` or `fail`, `next` is the one thing to do after a failure, `pending` is true on
a failure that waiting fixes (no public address yet, a refused connection, no route from this computer, a resolver's
HTTP error, or a gateway status or no answer past TLS), and `name` is, in order, `dns`, `tls`, `resource_metadata`, `auth_metadata`,
`auth_challenge`, `streaming` or `probe_cleanup` (only when the probe's token couldn't be deleted). Checks after a failed `dns` or
`tls` don't run, and `streaming` runs only when `resource_metadata` passed. `remote fix --dry-run` always exits 0, even when
a step only you can take blocks the rest; the JSON still names it. Nothing set up is `code` `not_set_up` with
`next` `run_command`. Exit codes: 0 every check passed, 1 a check failed, 2 usage, 3 nothing is set up. No token is
ever in it.

`remote fix --json` prints `{ok, state, code?, message, next?, publicUrl, oldUrl?, newUrl?, actions, advice, checks?}`.
Each of `actions` is `{kind, what, status, detail?}`; `kind` is one of `download_cloudflared`, `rename`,
`restart_serve`, `restart_cloudflared` and `open_funnel` (they run in that order), and `status` is `planned`, `done`,
`failed` or `declined`. `advice` lists steps only you can take, `{name, detail, command?}` (`passcode`, `linger`,
`tailscale user`). `oldUrl` and `newUrl` are there after a `rename`: the connector moved, so the old URL no longer works.
`checks` is the outside proof, run once nothing is left to repair. `code` `fix_pending` means repairs are listed and
nothing was changed (`--dry-run`, which exits 0, or no terminal and no `--yes`, which exits 3). A step only you can take
uses the same `state` values as status (`tailscale_signed_out`, `funnel_not_allowed` with `next` `open_page`, and so on)
and exits 3. Exit codes: 0 ok, 1 a repair or a check failed, 2 usage, 3 a person has to act or nothing is set up.

`code` says why when it matters. For `problem`: `launcher`, `hub`, `service`, `serve` (nothing answers
on the local port, so nothing was turned on), `funnel` (Tailscale's own words are in `message`),
`tailscale_operator` (Tailscale refused because your user isn't its operator; `next` has the command),
`cloudflare_login`, `cloudflare_name` (no name was given), `cloudflare_zone` (public DNS shows the name's zone served
elsewhere, or it is outside the zone an earlier sign-in proved, both checked before any record is made; or Cloudflare
put the record in another zone, which `message` names so you can delete it), `cloudflare_dns` (`next` `choose_name` only
when the name is taken; any other cloudflared error has no `next`), `cloudflare_tunnel` or
`config`. A failure after the passcode was made, such as a file that can't be written, is a `problem` with
`code` `config`, `service` or `funnel`, and still carries the `passcode`. For `port_busy`: `tailscale_port` (a saved Tailscale setting already uses 8443) or
`local_port` (a program on this computer uses the local port). A status read on the Funnel route
names `tailscale_missing`, `tailscale_signed_out` or `tailnet_lock` ahead of `problem`, and
`funnel_closed` when Tailscale's Funnel isn't open for the saved address (status only; `remote setup`
opens it again). `problem` with `code` `dns` means the only failures are public DNS and the public
fetch, which lag a new address by minutes: waiting fixes it. `code` `dns_lookup` means public DNS answered that the
lookup failed (SERVFAIL or REFUSED, often broken DNSSEC): waiting doesn't fix it; fix the name's records with your DNS
provider.

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
