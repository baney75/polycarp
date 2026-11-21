# DC-2 and DC-9 records

## 2026-10-25: scoped tokens and loopback HTTP (narrow checks, not the DC Checks)

Command: `cd cli && npm run build && node --test test/remote.test.mjs`
Result on the #16 final head: 15 pass, 0 fail.

What each test could fail on:

- Token creation with no scope, "*", "all", "browser.*" or an unknown scope must exit 2,
  and tokens.json must not contain the secret.
- A request with no token, a fake token, or a raw POST gets 401.
- A `library.read` token's session lists exactly library_cite and library_search; a call to
  `click` errors; `library_search` succeeds.
- Another token on an existing session id gets 403. After `token revoke`, the old session
  is refused, and `token list` shows it revoked.
- `tunnel tailscale` calls `tailscale serve --bg --yes --https=443 --set-path=/tabkyra
  http://127.0.0.1:8787`; `--public` calls `funnel`; `--off` turns it off (stub binary
  records the arguments).
- `tunnel cloudflare` without cloudflared exits 1 and starts nothing (PATH holds only node).
- Token names that duplicate an active token or look like an id, and scopes named like
  Object.prototype members, exit 2.
- A non-initialize POST gets 400, an unknown session 404, bad JSON 400, and serving never
  rewrites tokens.json.
- A library.read session's instructions mention only its tools; a browser.read+act
  session keeps the password and ask-first rules and gets the sign-in fallback.
- A ninth session on one token gets 429; a malformed token record doesn't break auth.
- `--port 87x7` exits 2; Funnel is refused when :443 serves /grafana; a tailnet-only serve is
  refused while Funnel is on for :443; nothing changes when serve status can't be read.
- A cloudflared that only prints an API error is stopped after the timeout, its pid file
  removed, and its API URL never reported as the tunnel.

## Not yet run

- DC-2 Check: CLI and MCP parity on every command.
- DC-9 Check: a cloud agent reaching MCP through a real Tailscale and a real Cloudflare
  tunnel with a token, and being refused without one. This changes the owner's tailnet
  serve config and needs `cloudflared`, so it waits for a run he starts.
