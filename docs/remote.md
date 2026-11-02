# Use Tabkyra from claude.ai, ChatGPT and grok.com

Web assistants can drive your own signed-in browser through Tabkyra. It runs on your
computer: no account with us, no relay, no cost. One command sets it up.

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

## What you need

- Tabkyra installed and connected (`tabkyra setup`, then `tabkyra install` so the service has a
  launcher to start).
- Tailscale on this computer, signed in, with Funnel allowed for your tailnet. Free plan is enough.

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
manager device): the field reads "Passcode or connect code".

```bash
tabkyra hub devices                  # online, extension, sessions, busy, last seen
tabkyra hub prefer laptop,desktop    # who wins a tie
tabkyra link busy on                 # on a device: new sessions go elsewhere first
tabkyra hub status                   # hub.json, passcode, local answer, public DNS and fetch, devices
```

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
