# Polycarp Connect

A small Cloudflare Worker that hands out Cloudflare named tunnels, so a person can connect claude.ai,
ChatGPT or grok.com to Polycarp's browser on their own computer with one click. It is free for the person
and stays inside the 1,000 tunnels a Cloudflare account includes. Past the limit it says it is at capacity.

## What it can and can't see

**Traffic never passes through this Worker.** It only provisions: it asks Cloudflare for one tunnel and one
DNS name, and gives the person's computer the tunnel token. After that the person's computer talks to
Cloudflare directly, and Cloudflare forwards requests for `pc-….<host>` to `127.0.0.1` on that computer.

**What protects a person's browser, and what doesn't.** Using someone's browser takes their approval passcode and the sign-in it issues. Those are made on their computer and stay there (`remote setup --public-url`); this service never receives them, so it can't use a browser with what it holds.

This is a real dependency, stated plainly. The connection runs on a Cloudflare account Donovan controls, and Cloudflare carries the traffic, so it passes through Cloudflare unencrypted at that point. Whoever controls that account could see metadata, could turn on logging, or could repoint or remove a person's address. A person who doesn't want that shouldn't turn this on: it's off by default, and `remote setup` with their own Tailscale or Cloudflare account avoids it.

- The approval passcode, the OAuth consent page and every access token live on the person's computer
  (`remote setup --public-url`). This service never receives them.
- A web agent still has to be approved with the person's passcode before it can do anything.
- The service stores only: tunnel id, hostname, a SHA-256 of the device public key, created and last-seen
  times. It does not store the tunnel token, the public key, IP addresses, or the passcode. Rate limits use a
  keyed hash of the IP that expires in two days.
- Anyone with the tunnel
  token could run a connector for that hostname, so the token is handed to the device that claimed it and
  nowhere else, and it is never logged.
- Email is stored only if a person types it into the waitlist, and they can delete it (below).

## Secrets, variables and token permissions

Secrets (set with `wrangler secret put`, never in a file in this repo):

| Secret | What it is |
| --- | --- |
| `CF_API_TOKEN` | A Cloudflare API token with exactly two permissions (below). |
| `ADMIN_SECRET` | 32+ random characters (`openssl rand -base64 32`). The `X-Admin-Secret` header for admin calls. |
| `IP_SALT` | 32+ random characters. Keys the IP hash for rate limits and the waitlist delete token. |

The API token needs only:

- **Account › Cloudflare Tunnel › Edit**, scoped to the one account.
- **Zone › DNS › Edit**, scoped to the one zone that holds the tunnel hostnames (dbaney.com).

Nothing else: not Workers, not Account Settings, not other zones. Create it at
`dash.cloudflare.com/profile/api-tokens` as a custom token.

Variables (in `wrangler.jsonc`, not secret):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CF_ACCOUNT_ID`, `CF_ZONE_ID` | placeholders | The account and zone ids. The Worker refuses to run until both are set. |
| `TUNNEL_HOST_SUFFIX` | `dbaney.com` | Hostnames are `pc-<20 random base32 chars>.<this>`. One label only, because Universal SSL covers one. Change it to move to a Polycarp domain later. |
| `HARD_LIMIT` | `1000` | Cloudflare's included tunnels per account. |
| `RESERVE` | `10` | Kept back from everyone. Only a `reserve` invite can use it. |
| `INVITE_ONLY_ABOVE` | `900` | From here, a claim needs an invite code. |
| `PAUSED` | `0` | `1` makes new claims answer `paused`. People who are already connected keep working, get their connection back after a restart, and can still turn off. Edit it in the dashboard (Workers › polycarp-connect › Settings › Variables) for an instant switch. |
| `CLAIMS_PER_IP_PER_DAY` | `10` | The abuse brake: a claim needs only a device key, and keys are free. |
| `STALE_DAYS` | `60` | The daily pass frees tunnels unseen this long. |
| `CRON_BATCH` | `12` | Most tunnels the daily pass deletes per run (a Worker has a limit on outgoing calls). The rest wait for the next run. |

## Deploy steps (not run yet)

```bash
cd connect && npm ci
npx wrangler d1 create polycarp-connect          # copy the database_id into wrangler.jsonc
# edit wrangler.jsonc: CF_ACCOUNT_ID, CF_ZONE_ID
npx wrangler d1 migrations apply polycarp-connect --remote
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put IP_SALT
npx wrangler deploy
curl https://<worker host>/v1/capacity            # {"status":"open","remaining":"plenty","paused":false}
```

Then give the Worker a stable address (a custom domain such as `connect.dbaney.com`, or the `workers.dev` address)
and make it the helper's default: `DEFAULT_CONNECT_URL` in `browser/cli/src/connect.ts` (the app runs the helper, so
it needs nothing else; `POLYCARP_CONNECT_URL` overrides it for testing).

Check before the first real claim: no existing Worker route or DNS record on the zone matches `pc-*.dbaney.com`
(a `*.dbaney.com/*` route would catch tunnel traffic).

## API

Requests from a device are signed with its Ed25519 key. Headers: `X-Polycarp-Key` (base64url, 32-byte public
key), `X-Polycarp-Time` (unix seconds, within 5 minutes), `X-Polycarp-Nonce` (16 to 64 of `A-Za-z0-9_-`, used
once), `X-Polycarp-Sig` (base64url signature of `polycarp-connect/v1\nMETHOD\n/path\ntime\nnonce\nsha256hex(body)`).

| Call | What |
| --- | --- |
| `GET /v1/capacity` | `{status: open｜invite_only｜at_capacity, remaining: plenty｜some｜few｜none, paused}`. A band, never the exact count (the account holds other tunnels). `503 unavailable` if Cloudflare can't be read. |
| `POST /v1/claim` | Signed. Body `{port?, invite?}`. Makes the tunnel, its ingress to `http://127.0.0.1:<port>` and DNS. Returns `{status: "ok", hostname, tunnelToken}`. Idempotent: one active tunnel per device. Other statuses: `paused`, `at_capacity` (503, with `waitlist`), `invite_required`, `invite_invalid` (403), `rate_limited` (429), `in_progress` (409), `unavailable` (503). |
| `POST /v1/seen` | Signed heartbeat. 404 `not_found` means turn it on again. |
| `DELETE /v1/claim` | Signed. Deletes the tunnel and DNS record and frees the slot. |
| `POST /v1/waitlist` | `{email}`. Returns a `deleteToken`. |
| `DELETE /v1/waitlist` | `{email, token}` removes the email. |
| `/v1/admin/...` | `X-Admin-Secret`. `POST/GET /v1/admin/invites`, `DELETE /v1/admin/invites/:id`, `GET /v1/admin/waitlist`, `DELETE /v1/admin/waitlist/:id`, `GET /v1/admin/stats`. |

### Capacity

The live tunnel count is read from the Cloudflare API and cached in D1 for 60 seconds. D1 alone is never
trusted: the account has other tunnels. Reservations made after the last read are added on top.

- Below `INVITE_ONLY_ABOVE` (900): open to anyone.
- 900 up to `HARD_LIMIT - RESERVE` (990): only with a valid, unused invite code.
- At or past 990: `at_capacity`, with an offer to join the waitlist. A `reserve` invite can still use slots up
  to `HARD_LIMIT` (1000), which is how Donovan gives a free slot to a selected person after the public door shuts.
- A claim takes a slot in D1 with one atomic statement before it calls Cloudflare, so two claims can't both
  take the last slot. If Cloudflare returns a limit error, the claim is undone, the answer is `at_capacity`, and
  the door stays shut for a minute.

### Admin

```bash
export POLYCARP_CONNECT_URL=https://<worker host>
# supply POLYCARP_CONNECT_ADMIN_SECRET from your password manager (for example `pass-cli run -- node scripts/admin.mjs ...`)
node scripts/admin.mjs invite create --count 3 --note "church friends"
node scripts/admin.mjs invite create --reserve --note "Pastor"
node scripts/admin.mjs invite list
node scripts/admin.mjs invite revoke 4
node scripts/admin.mjs waitlist list
node scripts/admin.mjs stats
```

### Daily pass

A cron at 04:17 UTC deletes tunnels unseen for 60 days (the helper sends a heartbeat while connected), cleans
setups that stalled halfway, and prunes nonces and rate counters.

## Develop

```bash
npm ci
npm test            # vitest in the real Workers runtime (workerd), with a fake Cloudflare client
npm run typecheck
```

Tests never reach Cloudflare. They use an in-memory fake of the API client, and the real client is tested
against a stub `fetch`.
