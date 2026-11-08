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
tabkyra remote setup
```

It turns on Tailscale Funnel for this computer, sets an approval passcode (shown once), writes
`remote.json` and installs a user service that keeps `tabkyra serve` running. Then it prints the
connector URL, `https://<this-computer>.<your-tailnet>.ts.net:8443/mcp`.

Check it any time:

```bash
tabkyra remote status
```

Each line is ok, warn or fail: `remote.json`, the passcode, whether `serve` answers on this
computer, whether public DNS resolves the name to an address outside the tailnet, and whether
the public URL answers. The DNS line matters: from inside your own tailnet, a ts.net name works
even when Funnel isn't reaching the internet, so a passing public fetch alone can hide a broken
Funnel. The computer must stay on, awake and signed in to the browser with Tabkyra loaded.

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
`cloudflared` running as services. It never overwrites a DNS record: a name already in use is refused, in Cloudflare's own
words. A sign-in covers one domain, so a name on another domain is refused too, and it says how to sign in for that one.
`remote off` stops the tunnel and leaves the tunnel and its record on your account, so turning it on again reuses them;
`cloudflared tunnel delete polycarp-<this computer>` removes the tunnel for good.

Settings > Connect has a "Set up with Cloudflare" button that does the same: enter the address, sign in to Cloudflare in the
tab it opens, and it makes the tunnel and checks the public address. If no `cloudflared` is installed it downloads its own
(pinned release 2026.10.7, SHA-256 checked before anything is unpacked or run) to `~/.config/tabkyra/bin/cloudflared`; one on
your PATH or in Homebrew's folders is used first. When Funnel is on, the button turns it off first.

To try it without an account, `polycarp browser tunnel cloudflare` gives a temporary `*.trycloudflare.com` address that
changes each time it starts, so a connector added with it stops working at the next restart.

## Computer use

Two permissions on the approval page, both unticked until you tick them: `computer.read` (see the
agent workspace and apps you lend) and `computer.act` (see them too, click and type in them, and start
apps from Polycarp's short list). The assistant gets `computer_*` tools, which run through
`polycarp-spaces mcp --connector` on your Mac. They need the Polycarp app, so another machine doesn't
offer them.

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
keep it. `token passcode --json` makes a new one.

`code` says why when it matters. For `problem`: `launcher`, `hub`, `service`, `serve` (nothing answers
on the local port, so nothing was turned on), `funnel` (Tailscale's own words are in `message`) or
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

- Tabkyra installed and connected (`tabkyra setup`, then `tabkyra install` so the service has a
  launcher to start).
- Tailscale on this computer, signed in. Free plan is enough. If Funnel isn't allowed for your
  tailnet yet, `tabkyra remote setup` prints the Tailscale page that allows it and stops; allow it
  there, then run setup again.

Funnel runs on its own port (8443), so the OAuth paths sit at the root of the URL, and anything
you serve on 443 stays private.

## If Funnel won't work

`tabkyra remote setup` stops, without changing anything, when:

- Tailscale isn't installed.
- The tailnet has Tailnet Lock on. Funnel doesn't work on a Tailnet Lock tailnet.
- Port 8443 on this computer already serves something else, or forwards plain TCP.
- A `remote.json` or a service from an earlier setup is in the way (`tabkyra remote off` clears it).

The free way out is your own HTTPS front door. A Cloudflare named tunnel costs nothing (an
account includes 1,000) and needs a domain on Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create tabkyra
cloudflared tunnel route dns tabkyra tabkyra.<your domain>
```

Point the tunnel at Tabkyra in `~/.cloudflared/config.yml`:

```yaml
tunnel: tabkyra
credentials-file: /home/<you>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: tabkyra.<your domain>
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run it (`cloudflared tunnel run tabkyra`, or as a service with `cloudflared service install`),
then tell Tabkyra the address:

```bash
tabkyra remote setup --public-url https://tabkyra.<your domain>
```

`--public-url` takes an origin only (`https://host`, no path). Any HTTPS front door that forwards
to `127.0.0.1:8787` works the same way. `--port N` changes the port; `--no-service` skips the
service, and you start `tabkyra serve` yourself. Quick tunnels (`trycloudflare.com`) won't do:
the name changes on every start.

If you switch from Funnel to your own front door, run `tabkyra remote off` first so Funnel closes;
setup refuses to switch while Funnel from an earlier setup is on.

## Add the connector

Paste `<public URL>/mcp` in each:

- **claude.ai**: Settings > Connectors > Add custom connector.
- **ChatGPT**: Settings > Apps & Connectors (turn on developer mode) > Create. Choose OAuth.
- **grok.com**: grok.com/connectors > New Connector > Custom.

Each opens Tabkyra's approval page. Check the name and the site you return to, tick the
permissions, enter your Tabkyra passcode and press Allow. Only approve a connection you just
started. Lost the passcode? `tabkyra token passcode` makes a new one; approvals you already
gave keep working.

## Revoke

```bash
tabkyra token clients            # connectors and their grants
tabkyra token revoke tkc_...     # remove one client and every grant it holds
tabkyra remote off               # close Funnel, stop the service, delete remote.json
```

`remote off` leaves approvals in `oauth.json`. They can't be used while the URL is gone, but they
become usable again if you set up later with the same URL. `tabkyra token clients` lists them and
`tabkyra token revoke <client id>` ends them for good.

On a custom route (`--public-url`), `remote off` can't close your front door: your own tunnel
keeps forwarding to this computer. Stop it there, for example by stopping `cloudflared`.

## Security notes

- Anyone on the internet can reach the URL. Two things stand between them and your browser: the
  passcode on the approval page (five wrong tries per connection, then a 15-minute wait) and the
  per-permission consent. Keep the passcode in a password manager the browser Tabkyra drives can't fill, and don't reuse it.
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
computer that has a browser with Tabkyra dials in. It is still your own server, with no relay and
no cost (D32).

On the always-on box, with an HTTPS front door pointing at `127.0.0.1:8787` (a free Cloudflare
named tunnel works, as in "If Funnel won't work" above):

```bash
tabkyra hub setup --public-url https://tabkyra.<your domain>   # hub.json, a passcode (shown once), a service
tabkyra hub code                                               # a one-time code, valid 10 minutes
```

On each computer with a browser:

```bash
tabkyra link https://tabkyra.<your domain> --code TK-XXXX-XXXX [--name laptop] [--scope browser.read,browser.act]
```

`link` enrolls the computer and installs a user service (`com.tabkyra.link` or
`tabkyra-link.service`) that runs `tabkyra link run`. `--scope` is what this computer allows at
most; without it, the default grant (no `browser.script`, no `threads.read`). Then add
`https://tabkyra.<your domain>/mcp` once in each assistant, as above. Approve with your passcode,
or with a one-time code from `tabkyra token approval-code` (or `tabkyra link approval-code` on a
manager device): the field reads "Passcode or connect code". A connector you have not approved
before (a new client) needs the one-time code; the passcode alone is refused for it, so a link
someone else sends you cannot be approved by typing the passcode (D34). Once a client is approved,
later approvals for it take the passcode as before.

```bash
tabkyra hub devices                  # online, extension, sessions, busy, last seen
tabkyra hub prefer laptop,desktop    # who wins a tie
tabkyra link busy on                 # on a device: new sessions go elsewhere first
tabkyra hub status                   # hub.json, passcode, local answer, public DNS and fetch, devices
```

Settings > Connect in the side panel does the same from the browser: it shows the connector URL,
makes a one-time code for the approval page, lists the devices (on the hub's computer), makes a
connect code for another device, and joins a hub from a code. It asks Tabkyra's helper, so it needs
`tabkyra setup` first. See D33 in [decisions.md](decisions.md).

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

### Revoke

```bash
tabkyra hub remove laptop    # the credential stops working, the live link closes within a second
tabkyra link off             # on a device: stop the service, forget the hub, revoke its link token
tabkyra hub off              # stop the hub service and remove hub.json (devices stay enrolled)
```

`hub code --manage` makes the device a manager: it can run `tabkyra link code` and
`tabkyra link approval-code`, which ask the hub for codes over HTTPS with the device credential.
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
- Only one `tabkyra link run` can run on a device; a second refuses to start. When the link drops,
  the device closes the sessions it carried, and assistants simply start new ones.
- The hub listens on loopback and answers only its public host. A device removed with
  `tabkyra hub remove` loses its link within a second.
- Cost: free. Nothing here runs on anyone else's server.

See D30, D31 and D32 in [decisions.md](decisions.md) for why each install is its own server.
