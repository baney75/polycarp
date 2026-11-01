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
- Port 8443 on this computer already serves something else.

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
tabkyra remote off               # stop the service, close Funnel, delete remote.json
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

See D30 and D31 in [decisions.md](decisions.md) for why each install is its own server.
