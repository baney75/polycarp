# Sign-in policy

Tabkyra takes **API keys**, plus exactly two subscription sign-ins: **Sign in with ChatGPT**
(OpenAI's open-source route) and **GitHub Copilot through the Copilot SDK**. Each uses the route
the provider documents for third-party apps, with Tabkyra's own registration. There is no
subscription sign-in for Anthropic or Google, because their terms forbid one.

Every subscription sign-in this fork inherited from Sitegeist worked by posing as
another product: it sent Codex CLI's, VS Code Copilot Chat's or Gemini CLI's OAuth
client id, and copied their headers. A provider can't tell that traffic from abuse of
its own app, and its terms let it suspend the account. A browser extension
must not put its users' accounts at risk to save them an API key, so those flows are gone.

The rule for any sign-in: keep a flow only when the provider explicitly permits it for
third-party apps, through a client registered to Tabkyra. Never send another app's client id,
`originator`, user agent or headers, and never spawn a provider's CLI to borrow its sign-in.

Checked 2026-10-28 against the providers' own pages (first checked 2026-10-25).

| Provider | Flow | Allowed for Tabkyra? | Source | What Tabkyra does |
| --- | --- | --- | --- | --- |
| OpenAI | **Sign in with ChatGPT, ChatGPT plan usage for open-source and locally hosted apps**: dynamic registration (`dynamic_agent_client`, no client secret), a stable `ext_agent_host_id`, loopback callback on `127.0.0.1`, Responses API with `store: false` and streaming | **Yes.** "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." Tabkyra is AGPL-3.0 and runs on the user's machine, so no form or approval applies. OpenAI's interest form says: "If you're an open source developer, explore our developer docs." | [Overview](https://developers.openai.com/siwc/token-sharing-open-source), [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines), [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/) (all read 2026-10-28) | Offered: "Continue with ChatGPT" in Settings. Provider `chatgpt-plan`. |
| OpenAI | ChatGPT Plus/Pro sign-in with Codex CLI's OAuth client (`auth.openai.com/oauth/...`, `originator`, `codex_cli_simplified_flow`) against `chatgpt.com/backend-api/codex` | **No.** The Codex auth docs describe that sign-in for Codex itself. SIWC is the route for other apps, and its docs say not to point at ChatGPT's backend-api endpoints. | [Codex auth](https://developers.openai.com/codex/auth) (2026-10-25) | Removed. |
| OpenAI | API key (`api.openai.com`) | Yes | [API keys](https://platform.openai.com/docs/api-reference/authentication) | Kept. Billed by OpenAI. |
| GitHub | **Copilot SDK with Tabkyra's own OAuth App** (client id `Ov23li1qDiu9lRXbvcFh`, registered by baney75 on 2026-10-28, device flow, no client secret issued) | **Yes.** "Use an OAuth GitHub App to authenticate users through your application and pass their credentials to the SDK. This enables your application to make Copilot API requests on behalf of users who authorize your app." The setup page: "You create a GitHub OAuth App (or GitHub App) ... Copilot usage is billed to each user's subscription." | [Authenticate the Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk), [GitHub OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth), [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) (all read 2026-10-28) | Offered: "Sign in with GitHub Copilot" in Settings. Provider `copilot-plan`. Each user needs their own Copilot plan. |
| GitHub | Copilot device flow with VS Code Copilot Chat's client id, `Editor-Version: vscode/...`, `Copilot-Integration-Id: vscode-chat`, `User-Agent: GitHubCopilotChat/...`, and the undocumented `copilot_internal/v2/token` | **No.** GitHub documents no third-party use of that client or endpoint. | [Terms for Additional Products](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features) | Removed. GitHub Models (PAT) was retired on 2026-07-30 ([changelog](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/)). |
| Google | Gemini CLI's OAuth client id and secret against Code Assist (`cloudcode-pa.googleapis.com`), or spawning the user's Gemini CLI to use its sign-in | **No, explicitly.** "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination of your account." | [Gemini CLI terms and privacy](https://geminicli.com/docs/resources/tos-privacy/) (updated 2026-04-10, read 2026-10-28) | Removed, along with Antigravity. Settings tells the user to run their own Gemini CLI with Tabkyra's MCP server instead: `gemini mcp add --scope user tabkyra ~/.config/tabkyra/tabkyra mcp`. |
| Google | Gemini API key from Google AI Studio | Yes. The terms page lists it as a supported method. | [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key) | Kept. Free tier with limits, paid above it, billed by Google. |
| Anthropic | Claude Pro/Max sign-in (claude.ai OAuth, `sk-ant-oat` tokens), or spawning the user's `claude` to use its sign-in | **No, explicitly.** "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens." The same page allows "an end user ... signing in to the unmodified Claude Code binary with their own Claude subscription." | [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (read 2026-10-28) | Removed. An `sk-ant-oat` token pasted into the key field is refused. Settings tells the user to run their own Claude Code with Tabkyra's MCP server: `claude mcp add --scope user tabkyra -- ~/.config/tabkyra/tabkyra mcp`. |
| Anthropic | API key from the Claude Console | Yes | same page: "should use API key authentication through Claude Console" | Kept. Billed by Anthropic. |
| Others (OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face, z.ai, MiniMax, custom and local providers) | API key or none | Yes | each provider's API docs | Kept. Billed by the provider (local models aren't billed). |

## How the two subscription sign-ins work

Both run in the **native host** (`cli/src/subscriptions/`), the Node process the browser
starts for Tabkyra, never in the extension. Tokens live in owner-only files under
`~/.config/tabkyra/subscriptions/` (folder 0700, files 0600, written atomically), as OpenAI's
docs require ("Keep tokens out of browser storage"). The extension never sees a token: the host
runs a loopback proxy on `127.0.0.1` that adds the user's token to each model request. The side
panel reaches it with a random per-process secret it gets over native messaging and keeps in
memory. The proxy checks the secret and its own `Host` header, and forwards only these routes:
`GET /v1/models` and `POST /v1/responses` on `api.openai.com`, and a Copilot SDK turn.

**Sign in with ChatGPT** (`siwc.ts`):

- First sign-in: `client_id=dynamic_agent_client`, `agent_name_hint=Tabkyra`, and the host's
  `ext_agent_host_id` (`urn:uuid:...`, made once and kept). Later sign-ins reuse the issued
  `oaiapp_...` client id with `login_hint`. Tabkyra never sends the optional `id_token_hint`: the
  authorization URL passes through the extension and the browser's history, which must hold no
  token.
- The listener on `http://127.0.0.1:<port>/auth/callback` starts before the browser opens.
  Port 1455 first, any free port when it's taken; the path never changes. A fresh state, nonce
  and PKCE verifier (S256) per attempt. A callback with another state is answered and ignored.
- The code exchange goes to `auth.openai.com/api/accounts/oauth/token` with the issued client id,
  the verifier, the same redirect URI and `resource=https://api.openai.com/v1`. No secret.
- The ID token is checked against OpenAI's JWKS (from the OpenID configuration): signature,
  issuer, audience (the issued client id), expiry and nonce. A returning sign-in must be the
  same account. Plan usage needs `chatgpt.tokens.use.direct` in the granted scopes; without it
  the sign-in is kept and inference is refused with a clear choice (allow it, or use a key).
- Refresh: near expiry (5 minutes), one at a time per process and per credential file (a lock
  file holding an owner token, since two browsers mean two hosts; every request under it times
  out after 15 seconds). The rotating refresh token is replaced with the access token, and the
  plan scope is checked again on the refreshed grant. A dead refresh token clears the tokens and
  asks for a new sign-in.
- Sign-out: stop requests in flight, then, under the same lock and after any refresh or sign-in
  already running has settled (neither can write tokens back afterwards), revoke the refresh
  token at the `revocation_endpoint` (retried on network errors and 5xx) and delete the access,
  refresh and ID tokens. The registration and host id stay.
- Requests: `store: false`, `stream: true`, no unsupported fields, developer instead of system
  items, function tools in a `tabkyra` namespace. The side panel shapes the body and the host
  shapes it again before forwarding (`siwcRequestBody` in `src/subscriptions/constants.ts`).
- UI per OpenAI's guidelines: "Continue with ChatGPT", a one-time "You're using your ChatGPT
  plan" note with "Got it", model names marked "(ChatGPT plan)", "Manage usage" links to
  `chatgpt.com/settings/usage`, and a usage-limit error that points there.

**GitHub Copilot** (`copilot.ts`, `copilot-turns.ts`):

- Device flow with Tabkyra's own OAuth App: `github.com/login/device/code`, then polling
  `github.com/login/oauth/access_token`. The user enters the code at `github.com/login/device`.
  No scopes are requested.
- The app was registered with "Expire user access tokens" on, so GitHub issues 8-hour tokens with
  a refresh token. GitHub: `client_secret` is "Required unless the user access token was generated
  using the device flow", so the refresh sends none. No client secret was ever generated for the
  app. The refresh path is tested against a fake GitHub; a token that never expires simply never
  refreshes.
- Sign-out deletes the token file. Revoking the grant on GitHub's side needs the app's secret,
  so Settings points the user to `github.com/settings/applications`.
- Inference uses GitHub's Copilot SDK (`@github/copilot-sdk`, pinned to 1.0.28), installed by the
  user with `tabkyra copilot-sdk install` (about 160 MB, the SDK's runtime for the platform). The
  host creates `CopilotClient({ gitHubToken, useLoggedInUser: false, mode: "empty" })`, so it
  never falls back to another login, and one session per chat with only Tabkyra's browser tools
  (`availableTools`), `systemMessage` in append mode so GitHub's own guardrails stay, and every
  permission request denied. A tool call ends the side panel's turn; the tool's result resolves
  the SDK's waiting handler on the next turn.

## What the code does

- `src/auth/policy.ts` lists the removed providers and the subscription-only APIs
  (`openai-codex-responses`, `google-gemini-cli`). `resolveApiKey` refuses stored OAuth
  credentials and Claude subscription tokens. The stream function refuses any model on a
  removed provider or API, so a model saved before the update can't run.
- On startup, before any chat is restored, the side panel deletes tokens left by the
  removed sign-ins and says so once. A saved chat on a removed provider reopens on a
  working model.
- `scripts/build.mjs` strips pi-ai's Codex, Gemini CLI and Copilot provider code, their
  model entries, and the Claude Code identity (user agent, `x-app`, beta flag, system
  prompt) from the bundle. If upstream moves any of those files, the build fails.
- Subscription models are routed in the side panel's stream function after private mode has
  checked them: private mode refuses both, since the requests go to OpenAI or GitHub.
- The CLI's MCP server has no sign-in. It drives the browser and never calls a model.
- `test/auth-policy.test.mjs` (run by `./check.sh`) fails if any of the removed client
  ids (plain or base64), `originator`, `codex_cli_simplified_flow`, Codex's
  `auth.openai.com/oauth/` endpoints, the Copilot or Gemini CLI headers, `copilot_internal` or
  `cloudcode-pa` come back in `src/`, `static/`, `cli/src/` or `scripts/`, or in a fresh build of
  the extension. It also fails if any `auth.openai.com` or `github.com/login` URL is not one of
  the documented SIWC and device-flow endpoints, if a client secret is sent, if the subscription
  code starts a process, or if Settings offers a Claude or Google sign-in.
- `test/subscriptions-host.test.mjs` runs both sign-ins against fake OpenAI and GitHub
  endpoints: the documented parameters, PKCE, ID-token checks, 0600 files, refresh, sign-out
  (tokens deleted), and one request through each route carrying the user's token to the
  documented endpoint. `test/subscriptions-extension.test.mjs` checks that no token field or
  browser storage appears in the extension's source, the relay's guard, and request shaping.

The decision record is D28 in `docs/decisions.md`.
