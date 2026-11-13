# Decisions

Conventional defaults chosen while implementing the Done Criteria (DC-1 to DC-14), and the
owner's answers to the questions that changed the outcome. Newest last. Each entry names
the criterion it serves.

## D1. Polycarp skill metadata lives in `skill.toml`, not in SKILL.md frontmatter (DC-3)

DC-3 lists name, description, triggers, required tools, permissions, version and
provenance as frontmatter. Harnesses read SKILL.md frontmatter, and some act on keys they
recognize (Claude Code's `allowed-tools` pre-approves tools), so extra keys there are an
escalation route. SKILL.md keeps `name`, `description` and `license`, which every harness
reads the same way. The Polycarp fields go in `skill.toml` in the same folder, which only
Polycarp reads and the lint validates. The installer copies only SKILL.md into harness
folders. Same information, no new attack surface in the harness.

## D2. CAPTCHA handling (DC-10, DC-12)

Owner, 2026-10-25: allow solving for search, removing your own data from brokers (ghost),
and OSINT on companies and domains, "with the exception of exploitation like scalping".
Implementation default:

- Off by default. Turned on once at setup, behind a plain warning that solving breaks
  most sites' terms and can get an account or IP flagged. The setting then syncs to the
  user's other devices.
- Polycarp ships no solver. When the setting is on, the agent may use a solver extension
  the user installed themselves (Buster), one challenge at a time at human pace.
- Allowed for search engines, the `ghost` skill and the `osint` skill's company and domain
  research. Never for buying, ticketing, account creation, posting, or any site the user
  hasn't allowed. People research hands the challenge to the user, as the owner's chosen
  option said.
- Everything else gets the DC-10 handoff: pause, notify, user solves, resume.
- CI fails any first-party skill that bundles a solver or calls a solving service.

## D3. People research scope (DC-12 osint)

The osint skill covers companies, domains, public figures, a person's professional
footprint, and genealogy of the user's own family or of people who consented. It does
not unmask anonymous accounts or people, and it doesn't compile a private person's home
address, phone, relatives or routine for someone else. These are the stalking and doxxing
uses the safety rules exist to stop, so the skill refuses them instead of gating them.

## D4. "ChatGPT Daybreak" (DC-14)

Owner, 2026-10-25: it is the Codex `daybreak` flag. It runs as an optional
second-opinion security reviewer through `codex exec` on the user's own sign-in, with
no API billing. Until Daybreak supports the review model, calls pass `-c daybreak=false`
for gpt-6.1-sol, as the existing field note documents.

## D5. Bug report transport (DC-13)

Owner, 2026-10-25: GitHub issues filed through the user's own `gh` sign-in on
baney75/tabkyra. Reports are de-duplicated by a fingerprint of the scrubbed error (an
open issue with the same fingerprint gets a comment instead of a new issue). Off by
default. Without `gh` signed in, the report falls back to the prefilled issue link the
user submits.

## D6. Personal and shared skills (owner note, DC-5)

Every skill has a category in `skill.toml`: `personal` or `shared`. `polycarp-browser` classifies
it automatically and the stricter answer wins. Anything matching personal data (emails,
phone numbers, street addresses, account or student IDs, home paths, names the user marks
as private, signed-in site data) makes it `personal`. Personal skills are never submitted,
pushed, uploaded to GitHub or put in the skill DB, in any form. They sync only to the
user's own devices, end-to-end encrypted. Submission refuses a personal skill outright;
it doesn't ask.

## D7. Clean-container check for the install prompt (DC-1)

Pasting the prompt into each harness needs that harness signed in and calling a model.
That uses the owner's sign-ins and, for some harnesses, metered API use, which is not
allowed without the owner. The default check runs the prompt's commands, unchanged, in a
fresh container per harness with that harness's binary installed. It checks harness
detection, skills folder, MCP config and `polycarp browser doctor`. The model-in-the-loop
transcripts are recorded as blocked until the owner signs in a harness for the run.

## D8. Stacked pull requests

#13 (skills, lint, CI), #14 (library) and #15 (private mode, bug reports) are reviewed
and merged in order. Owner, 2026-10-25, answering whether to run a second review series
on #13 and then review and merge #14 and #15: "Yes, review and merge".

## D9. Remote MCP and tunnels (DC-2, DC-9)

`polycarp browser serve` speaks MCP over Streamable HTTP and binds to loopback only; it refuses any
other address. Every request needs a bearer token from `polycarp browser token create`. Tokens are
per client, stored as SHA-256 hashes, revocable at once, and limited to named scopes
(`browser.read`, `browser.navigate`, `browser.act`, `browser.script`, `library.read`,
`library.write`). There is no wildcard. A session sees only its scopes' tools, and another
token can't reuse it. The stdio server that a local harness runs keeps full access: it
runs as the user, so a token there would protect nothing. TLS comes from the tunnel:
`polycarp browser tunnel tailscale` (tailnet only; `--public` uses Funnel and warns) or
`polycarp browser tunnel cloudflare` (a quick tunnel under the user's own `cloudflared`).

## D10. Appearance customization and the contribution network (owner, 2026-10-25)

Users and their agents customize Polycarp's look through a theme file: design tokens and
CSS custom properties as data, checked by a linter. A theme can't contain code, URLs or
selectors that hide controls. A modified build is still allowed (AGPL-3.0).

"Lose access to the contribution network if they tamper with the code" is enforced where
it can actually hold. The client can't prove it is unmodified: it is open source, so any
check inside it can be patched out or faked. So the network never trusts the client.

- Every contribution (skill fix, success or failure report, bug report) is signed with a
  per-install key and carries the build's hash. Builds whose hash isn't in the signed
  release manifest are labeled `unofficial build`. Their contributions go to a separate
  queue that is never auto-accepted.
- Every contribution, from any build, passes the same server-side gates: CI lint, the
  red-team suite, adversarial review, and a maintainer for sensitive scopes. Security
  rests on these gates, not on trusting the client.
- Abuse (repeated rejected or malicious submissions) revokes that install key.

## D11. Worldwide successes and failures (owner, 2026-10-25)

Off by default and opt-in at first run, next to bug reports. When on, a skill run's
outcome is scrubbed by the DC-7 scrubber and contributed. It includes the skill name and
version, the model class, pass or fail, the step that failed, and the fix if `/fix`
produced one. Personal skills (D6) and page content are never included. Outcomes reach
the shared library only through D10's gates, as proposed fixes. Raw data never edits a
skill directly.

## D12. Small-model context budget (owner direction; numbers set by Claude, 2026-10-25)

The owner asked that skills not bloat context, "especially for the super small models"
(2026-10-25). He set no number; the figures below are Claude's. Harnesses see only each skill's name and its one-line description. The full SKILL.md
loads when the skill is invoked. Each first-party skill stays under 150 lines and
8,000 characters (about 2,000 tokens; `BUDGET_LINES` and `BUDGET_CHARS` in
`cli/src/skill-lint.ts`). Claude first set 1,500 tokens and raised it the same
day, because every well-specified skill exceeded it; the owner hasn't ruled on the number. Enforced by the lint's `budget` rule, and longer material is
split into separate skills, not appendices. The
router (DC-3) picks at most one skill per task for small models. The `rsi` and `fix`
skills apply their edits with `polycarp browser skill apply`, which runs the same lint, so an improvement can't bloat a skill past it (`fix` also aims for under 150 lines).

## D13. Local model providers (owner, 2026-10-25)

A "Local models" provider set in the side panel. It finds OpenAI-compatible servers
(Ollama :11434, LM Studio :1234, llama.cpp and vLLM :8080 and :8000) on this machine and on
the user's tailnet peers. The native host asks `tailscale status --json` for the peers and
probes each port with a short timeout. A model on a tailnet peer counts as local for
private mode only once the user lists it as their own (#15's rule in `src/privacy/private-mode.ts`: only loopback is trusted automatically).

## D14. Fix submissions and tier variants (owner, 2026-10-25)

`submit` in `~/.config/polycarp/browser/rsi.json` takes `"ask"` (default), `"auto"` or `"never"`.
The owner asked that users be able to submit fixes automatically, which overrides DC-5's
confirm-each-submission default for users who choose `"auto"`. Auto submission still only
opens a pull request: CI, adversarial review and a maintainer decide what enters the
library (D10). A skill classified personal (D6) is never submitted under any setting.
When a fix for a small model would weaken a skill that works for large ones, `/fix`
writes a `<name>-lite` skill instead of editing the original. The router (DC-3) picks the
variant by model tier.

## D15. Voice and mail skills (owner, 2026-10-25)

The writing-voice skill learns the user's style only from the user's own mail and
documents, read in place through their signed-in Polycarp tabs or their Drive. It keeps
just a style profile (sentence length, word choice, openings, sign-offs, a few short
example lines), not the messages. The profile is a personal skill (D6): it stays on the
user's devices and is never submitted, synced to shared storage or put in a bug report.
Email organization reads freely, but creating labels, moving mail or changing filters acts
under the user's sign-in. It shows the plan and waits for the user's yes, per the safety
rules.

## D16. SDKs and vendor terms (owner, 2026-10-25: "we don't want to break ToS")

No user should risk a ban for using Polycarp.

- **Harnesses the user runs** (Claude Code, Codex, pi, OMP, OpenCode, Cursor) connect to
  Polycarp as an MCP server, a pi extension or skills. The user's own harness, signed in
  however its vendor allows, calls Polycarp. Nothing is borrowed or impersonated, so this
  is the primary integration.
- **pi** (`@mariozechner/pi-ai`, `pi-agent-core`, `pi-web-ui`, MIT) already powers the side
  panel with API keys. OMP is integrated through MCP config.
- **Vendor agent SDKs** (Claude Agent SDK, Codex SDK) are used only with an API key the
  user supplies and pays for, never with a subscription sign-in inside Polycarp. Products
  built on these SDKs are expected to use API keys, and reusing a consumer sign-in in
  another app is what got the old Sitegeist sign-ins removed (docs/auth-policy.md).
- `/fix` and `adversarial-review` run a stronger model by calling the user's own CLI
  (`claude -p`, `codex exec`) on their machine, the same way the user would.

## D17. Adapted third-party skills and the mechanism dataset (Claude, 2026-10-26)

The owner asked for a `visual-explainer` skill adapted from nicobailon/visual-explainer
(MIT) and a `mechanism-design` skill informed by arXiv 2409.03763. Defaults chosen:

- **Adapt, don't vendor.** A skill folder holds `SKILL.md` and a license only, under the
  D12 budget, so upstream's `references/` files, its CSS/JS kit, its renderer and its
  slide and video tooling are not copied. Their rules (figure choice, grid layout, shape
  meanings, captions, motion restraint) are rewritten into one `SKILL.md`. The MIT notice
  with Nico Bailon's copyright is at the end of that `SKILL.md`, because `polycarp browser skill
  install` copies only `SKILL.md`, and also in `skills/visual-explainer/LICENSE`. The skill
  is MIT; the rest of Polycarp stays AGPL-3.0.
- **Inline SVG, not Mermaid.** Upstream loads Mermaid, Chart.js and three.js from a CDN.
  The `artifacts` rules forbid outside scripts, and inlining Mermaid would add megabytes of
  layout code to every page for diagrams a model can draw by hand. Upstream itself makes
  hand-drawn SVG the default and Mermaid opt-in. A user's Mermaid source is redrawn as SVG
  and kept as text in the page.
- **Upstream's checks are replaced by Polycarp's**: serve the page's own folder,
  `navigate`, start `read_console` and `read_network` and reload, `screenshot`, and
  `run_js` checks for captions, SVG labels, the script count and 375px overflow. The page's
  Content-Security-Policy (first in head: `default-src 'none'`, `script-src 'none'` or the
  SHA-256 of its one script, `form-action 'none'`, `base-uri 'none'`) is the control that
  blocks injected script and form posts; a check confirms it word for word.
- **Link the mechanism dataset, never bundle it.** Its images were scraped from a YouTube
  channel, DMG-lib and Artobolevsky's book, partly under copyright, and its code repository
  states no license. `mechanism-design` cites the paper and points to the repository as a
  catalogue of mechanism names only.

## D18. Artifact previews for more file types (Claude, 2026-10-27)

The owner asked for previews of more document types in the side panel's artifact viewer
("add preview for more docs too please", 2026-10-26, after a `.pptx` showed "Preview not
available"). Defaults chosen:

- **Own readers, no new libraries.** pptx, odt, odp, RTF and notebooks are read by small
  readers in `src/artifacts/preview/` over the JSZip already in the bundle. `pptx-preview`
  (ISC) was the only maintained pptx renderer found; it ships minified code and pulls in
  ECharts, lodash and uuid, about a megabyte. `rtf.js` (MIT) was last released in 2022.
  `marked`, already bundled for mini-lit's markdown, becomes a direct dependency for the
  notebook preview; the build aliases it, SheetJS, JSZip and highlight.js to one copy each.
  The previews add about 58 KB unminified (18 KB gzipped) to `sidepanel.js`. The build has
  no code splitting and AGENTS.md forbids dynamic imports, so nothing is lazy-loaded.
- **Viewers live in Polycarp, not the pi-mono patch.** pi-web-ui gains one hook,
  `setArtifactViewerFactory` (through `patches/pi-mono.patch`), which the artifacts panel
  asks before its built-in viewers; `src/artifacts/viewers.ts` answers it. The fork patch
  stays small, and the viewers are ordinary Polycarp source with Polycarp's tests and review.
- **Spreadsheets** (`xlsm`, `xlsb`, `ods`, `numbers` and templates) go through the SheetJS
  build already bundled. CSV and TSV get a table with a toggle to the raw text.
- **Untrusted input.** Nothing in a file runs or reaches the network: text is set as text,
  external images and links to files outside the package are dropped, notebook HTML outputs
  go through an allow-list sanitizer with only inline `data:` images, notebook markdown
  turns remote images into links, and SVG outputs show as `<img>`. The XML reader never
  expands DTD entities. Size limits (`PREVIEW_LIMITS` in `preview/content.ts`) bound each
  whole file, not each part: the file, every inflated zip entry (read through a stream that
  stops at the cap), the archive, the entries it lists, Apple Numbers' Snappy streams
  (checked before SheetJS inflates them), and what a deck, document, table or notebook draws.
- **No preview for legacy binaries** (`doc`, `ppt`, `key`, `pages` and a few others): the
  message names the format and says what to save it as.
- **Slides show as a scrolling column** scaled to the panel width, which suits a narrow
  side panel better than one slide with a thumbnail strip.

## D19. Updates from the side panel (Claude, 2026-10-27)

The owner asked for "a great update system" (2026-10-26) with Update now, checkout mode,
Settings > Updates and an automatic choice defaulting to "Tell me". Defaults chosen:

- **The mode comes from where the native host runs**: `~/.local/share/polycarp/browser/app` is a
  release, a Polycarp git checkout is a checkout, anything else updates only from a terminal.
  The browser's extension folder is confirmed by its `build-info.json` (build ids are new for
  every build); if it differs from the host's folder, Update now refuses, because updating
  the host's folder would not change what the browser runs.
- **A checkout rollback restores the builds, not git.** It swaps `dist-chrome` and
  `cli/dist` with the kept ones and leaves HEAD alone; Update now rebuilds HEAD. Resetting a
  branch the user may have work on is not the updater's call.
- **Untracked files don't block a checkout update**; tracked changes, another branch and a
  diverged main do. `git pull --ff-only` itself refuses an untracked file it would overwrite.
- **Build first, swap when idle.** Downloading, verifying, pulling and building run while
  agents work; the swap of live files (activation, rollback) and the reload wait for idle and
  follow each other at once, so the browser doesn't run old and new files side by side.
- **"Idle"** means no side panel run (counted while its heartbeat is under 3 minutes old) and
  no bridge request in flight; a harness also counts as running for 30 seconds after a
  browser call. Automatic updates wait for 3 quiet minutes.
- **A checkout trusts its origin** as a manual `git pull` and build would; there is no
  signature to check. Automatic updates are still offered in a checkout; docs/updates.md says
  what that means.
- **Automatic updates never undo a rollback**: not the release rolled back from, and in a
  checkout only new commits. A failed automatic attempt isn't retried for the same version.
- **Skill refresh only rewrites what Polycarp wrote.** A hash record of installed files decides;
  a copy without a record is refreshed only if it matched the old CLI's text right before the
  swap. Anything else is reported, never overwritten.
- **What's new is plain text.** Release notes come from GitHub and are rendered as text, never
  HTML; links must be https.

## D20. ask_user: agents ask the user questions (Claude, 2026-10-27)

The owner asked, after watching Claude Code's AskUserQuestion tool, to "make it so it can ask
questions too" (2026-10-27). Defaults chosen:

- **One shape everywhere.** The side panel tool and the MCP tool take the same arguments
  (1 to 4 questions; header, question, 2 to 4 options with label and description,
  multiSelect), checked by one function (`src/ask/core.ts`). "Other" free text is always
  offered, so an option can't be named Other.
- **No answer is an answer.** Skip, Stop, a closed or reloaded panel, the timeout and a
  disconnected agent all return a result that says there was no answer and tells the model
  not to assume one. A question cut off by a panel reload gets that result on the next turn
  (`src/messages/message-transformer.ts`).
- **External agents' questions go to the panel, not the harness.** They wait in
  `chrome.storage.session` like site-permission prompts, show above the chat in every open
  panel with the agent's name, badge the toolbar icon, and give up after 5 minutes. The panel
  answers by request id; the request id carries the client id and a random UUID, and only the
  waiting request with that id takes it, so an answer goes back only to the agent that asked.
  No bridge method answers a question, so a harness can't answer its own or another's.
  `chrome.storage.session` is closed to content scripts, so a page can't either.
- **Remote sessions need their own scope**, `user.ask`, never implied by the others: a remote
  agent that can ask questions can put text in front of the user.
- **Two open questions per agent at most.** One call already carries up to four, and a cap keeps
  one agent from filling the panel. An agent that gives up on its call (its tool timeout, or the
  user stopping it) withdraws the question with `ask_user.cancel`, which names that call and
  only ever reaches the calling agent's own questions.

## D21. Side panel transcript and composer menus (Claude, 2026-10-27)

The owner asked to clean up the side panel chat, remove the in-chat Artifacts pill, and add a
`/` menu that runs skills and an `@` menu that references tabs (2026-10-27). Defaults chosen:

- **Reasoning under 40 characters gets no row.** It is still shown inside the step it led to.
- **A step list longer than 8 rows shows its last 5** behind an "N earlier steps" row.
- **Per-step usage is a tooltip and part of the expanded row**, not a line under each step;
  the run total below the composer is unchanged.
- **Artifact tool calls stay full cards**: the card is how the user opens what was made.
- **The `/` menu order** is site skills matching the current page, then the library, then site
  skills for other sites. A name shows once, in its first section.
- **A library skill runs by loading its SKILL.md into the user message**, with a note that its
  tool names are Polycarp's MCP tools and the panel agent uses its own (navigate, repl).
- **References resolve when the message first goes to the model** (prompt, queue and Send now
  all pass through `convertToLlm`), once per message, and are frozen on it. Messages loaded
  with a saved chat are never resolved again.
- **A referenced tab owned by any other session stays with it**, not only a bridge agent's:
  the reference is consent for this chat, not permission to take another agent's tab.
- **A referenced tab never becomes current.** The model is told to switch to it with navigate
  `switchToTab`; a reference queued mid-run must not move the agent's next action to another page.
- **Browser pages, private tabs, tabs without a readable URL and tabs in another window are
  not referenceable.** The menu lists only the panel's window; a typed id elsewhere is refused.
- **References that fail to resolve are frozen as unusable**, with a toast, so a chip never
  looks shared when nothing was.

## D22. A dropped bridge: reads are resent, input is never replayed (Claude, 2026-10-27)

Owner, 2026-10-27: a tool call during an extension reload or native host restart "retries
safely or fails with a clear retryable error, never a hang". Defaults chosen:

- **What counts as a read** is a fixed list in `src/bridge/protocol.ts` (`isIdempotent`):
  status, tab listing and selection, snapshot, text, HTML, find, screenshot, wait, console
  and network reads, and `navigate` to a URL (loading the same URL again repeats a GET).
  Everything else, including `navigate` back or forward, `tabs.create` and `actions`, is
  input and is sent at most once.
- **The host answers for the extension.** When the extension goes away with requests out
  (reload, update, worker restart, a bad frame), the native host answers each one with
  `interrupted` before it exits, so no client waits on a reply that can't come. A stopping
  host keeps each client's socket open until that client has been quiet for 250 ms (2 s at
  most), and a request that arrives then gets `not_sent`. A request the extension refuses
  during an update install gets `not_sent` too: it never ran.
- **The client resends** a read cut off in flight and anything that never left (no socket, or
  `not_sent`), after the bridge is back, up to three sends in all. A cut-off input request
  fails with `interrupted` at once, without waiting for the bridge, telling the agent it may
  have run and to check the page before repeating it; the next call reconnects. This replaces
  the one blind retry, which ran a click twice when a reload cut off its reply.
- **A refusal is waited out, not counted as a drop.** A live host's `not_sent` (an update
  installing, a host stopping) is resent after 250 ms, 500 ms, 1 s, 2 s... within the budget.
  A half-closed socket takes no request; one an answer showed is retiring is no longer used
  but not cut under the requests still waiting on it.
- **Same browser, for a resend.** Each profile keeps a random id (`tabkyra.browserId`) that
  the host passes on. A call's resends go only to the browser it started in, never to another
  browser or to a host that hasn't said which it is; when that browser doesn't come back within
  the budget the call fails, and the next call takes whatever browser is up. A reconnect on a
  host whose extension never answers keeps looking, without redialing its own host; nothing is
  written to a host whose extension isn't there.
- **No new waits.** From its first drop, one call waits at most 40 s in all for the bridge,
  however many times it drops (time the request itself ran isn't charged); concurrent calls
  share one reconnect and one connect, a socket is used only once it is welcomed and chosen,
  and a client never holds more than one.
- **Cut off means stopped.** When the native host goes away while the extension lives (a host
  crash or restart), the extension stops the running request from sending more input, a
  request still in its preamble (update gate, session open) never reaches its handler, and
  nothing queued for that client starts, so the agent's "check the page, then repeat" can't
  race a handler still running.
## D23. Sessions follow the project; the user's gestures on a group are commands (Claude, 2026-10-27)

Owner, 2026-10-27: sessions "resumable across restarts of the harness", "a clear rule for the
default name (cwd or project plus harness)", and "improve group management too". Defaults
chosen:

- **The default session is the project**, not the harness conversation: the git root of the
  MCP server's working directory (or the directory), named `<folder>-<4 hex of its path>`.
  `--session` and `TABKYRA_SESSION` override it. Harness conversation ids
  (`CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`) no longer pick it: each new conversation made a new
  group and lost the old one's tabs. Outside a project (the disk root or the home folder, even a
  home that is a git repository, where GUI harnesses often start servers) each process gets its
  own session, so unrelated agents never resume each other's tabs.
- **A default is never shared by two live clients.** The second gets `<name>-2` and is told
  (`session_assigned`) so a reload can't swap it onto the first one's tabs. A restarted harness
  that connected before its old process hung up gets the base session back if it hasn't
  opened its `-2` yet. A name the user chose is shared on purpose.
- **Group titles** are `Polycarp · <agent> · <project or session name>`, plus an optional label
  the agent sets (session_info), sanitized as plain text, at most 32 characters, never
  starting with "Polycarp".
- **Gestures apply to agent sessions only.** Side panel chats keep their rules: their tabs are
  the user's already. A tab counts as moved out only once it was seen inside the group, so a
  tab still being grouped is never handed over by mistake. A closed window is not a gesture.
- **An agent never lands on a page it didn't choose**: when the user takes or closes its
  current tab, it has no current tab until it picks one or navigates.
- **15 tabs per session**, refused with `tab_limit` and what to do. Popups the foreground
  guard adopts are not refused (they come from the page, not the agent).
- **`polycarp browser sessions` acts as the user**, like the side panel: any local process that can
  reach the bridge socket can list, rename, end, focus or collapse agent sessions.

## D24. Past chats are readable by local agents, by default (Claude, 2026-10-27)

Owner, 2026-10-27: "Make it so tabkyra threads are accessible locally too for the agents using
the mcp, and cli, and such." Defaults chosen:

- **On by default**, with a Settings > Privacy switch that turns it off: no agent reads a past
  chat, live or from files, and the files are deleted.
- **Only chats from this version on**, unless the user ticks "Also chats from before <date>".
  Older versions saved private-mode chats without a mark, so nothing created before this build
  first ran (`threads.sharedSince`) is shown or mirrored by default.
  The files sit in the user's own data folder, readable only by the user, the same reach a local
  agent already has over the user's other files.
- **Never private-mode chats.** A chat saved while private mode is on is marked private for
  good; turning private mode off later doesn't expose it.
- **Redacted and trimmed, in every form** (text, Markdown and JSON). Keys and tokens are removed,
  including keys written only in hex (32 or 64 digits; a 40-digit commit id stays); reasoning is
  left out; tool results are cut to 300 characters; images and attachment contents appear by
  name only.
- **One folder per browser profile** (`threads/<browserId>/`), so two browsers never delete or
  overwrite each other's copy; the CLI and MCP read all of them.
- **Local stdio MCP may read threads; remote sessions need `threads.read`**, a scope no other
  scope implies.
- **Data, not instructions**: the tool descriptions, the MCP instructions and every rendered
  thread say so, since a past chat can hold page text an attacker wrote.

## D25. Side panel polish: fewer header buttons, Share only when it acts, six settings tabs (Claude, 2026-10-28)

Owner, 2026-10-28: "also work on the UI a bit", then "fix this button, and improve speed
provider, session, and setting management and UI making it less cluttered and easy to use".
Defaults chosen:

- **Header**: chat title, then Past chats, New chat, More, Settings. Copy chat, Record a skill
  and the theme moved under More. Every icon has a name that shows as a tooltip on hover and on
  keyboard focus. Recording shows a red "Recording" pill that stops it.
- **No share button: the tab in front goes with the message.** Owner, 2026-10-28: "No we
  shouldn't need to press share this tab it should all be available". Sending a message gives
  the agent the tab the user is looking at and makes it the agent's page; "Send now" mid-run adds
  it without swapping the run's page. A tab another agent is driving stays with that agent, and
  browser pages (settings, the extension's own pages, the web store) never go to the agent; a
  blank new tab does. Other tabs are referenced with `@`.
- **Hover is neutral, brass means on.** The theme's accent text (blue in light, yellow in dark)
  made a hovered icon look switched on.
- **Settings has six tabs** that all show at the panel's width: Providers (API keys, then custom
  providers), Skills, Bridge, Privacy (with the CORS proxy), Costs, About (with updates). The
  provider list has a search box, lists providers with a key first, saves on Enter and offers
  "Choose a model" after a save.
- **Past chats**: the search box has focus when the list opens and Enter opens the top match;
  each row renames in place and deletes with Undo instead of a confirm box. Bulk import, export
  and delete are under the list's More menu (bulk delete still asks).
- **Starter chips**: Summarize this page (runs), Research with sources, Fill a form and Compare
  tabs (each fills the chat input for the user to finish; Compare tabs opens the `@` tab menu).

## D26. Free mode: the best free OpenRouter model, measured (Claude, 2026-10-28)

Owner, 2026-10-28: "Add a free mode so through openrouter it provides the best free model for
usage in tabkyra." Defaults chosen:

- **One step to turn on.** "Free (best available)" is the first entry in the model selector,
  and Settings > Providers has a Free mode switch. Free mode is a model choice
  (`openrouter/tabkyra-free`), so it persists like any other model. OpenRouter has no model by
  that id, so a request that somehow skipped the gate fails instead of reaching a paid model.
- **Best is measured, not guessed.** `cli/eval/free-models.mjs` runs every free, tool-capable
  model on four fixture tasks (shop, contact form with a confirm dialog, a forum thread with a
  planted instruction, two-store price comparison) through Polycarp's MCP tools in a headless
  Chromium, scored by the fixture site's own state. `cli/eval/free-ranking.mjs` writes the
  result to `src/models/free-ranking.json` with its date and method; `test/free-mode.test.mjs`
  fails if the shipped order doesn't match the recorded scores. The eval drives the MCP tools,
  not the side panel's own tool set; the two are close in kind (navigate, read, click, fill),
  and one real side panel turn (`cli/eval/free-mode-turn.mjs`) checks the panel end to end.
- **Live list, refreshed daily.** The panel reads OpenRouter's `/models` and `/endpoints/zdr`
  (no key needed) at most once a day and keeps only `:free` ids (or `openrouter/free`) whose
  every price is zero and that list `tools`. A zero-priced model without the `:free` suffix
  is not trusted, since its price can change under the same id. Measured models keep their
  measured order; a measured model that passed nothing is left out; a model rate-limited on
  every run was never measured and ranks with the unmeasured ones; unmeasured new free
  models follow, longest context first, then newest; `openrouter/free` is always last.
- **Fallbacks, free only.** Each request sends OpenRouter's `models` list: the two best models
  and `openrouter/free` (OpenRouter takes at most three, checked live). Every id is checked
  free against the live list before sending, and the request carries `provider.max_price` of
  zero as a second guard. If the whole list is rate-limited, overloaded, pulled or gated, the
  panel tries the next two models once more; then the turn ends with the free daily limit
  (50 requests a day, 1,000 after buying 10 credits, 20 a minute) and what to do.
- **Gated free models are not worked around.** Some free models answer only for apps on
  OpenRouter's app list (`thinkingmachines/inkling:free` and `inkling-small:free` returned 403 "only available on
  agentic harnesses"). Polycarp sends its own identity and never borrows another app's (D16);
  such a model scores 0 and is skipped.
- **Private mode still wins.** In private mode Free mode uses only free models with a free
  zero-data-retention endpoint, never `openrouter/free` (it picks its model on OpenRouter's
  side), and each request carries private mode's ZDR routing. With none available it refuses
  and sends nothing. The selector entry and the switch say free providers may log prompts.
- **No key.** Picking Free mode without an OpenRouter key opens the key prompt with one line on
  getting a free key; Free mode stays off unless a key is added.
- **Which model answered.** pi-ai records the model a router reports (`responseModel`, through
  `patches/pi-mono.patch`), and the composer's model button reads "Free · <model>".

## D27. Community skills: manage, contribute, review, sync (Claude, 2026-10-28)

Owner, 2026-10-28: "make it so the skill system is easier for peoples llms to manage, and
contrinute to the larger polycarp browser community, ex if an llm finds a better way to navigate a site
like notion, it should make said skill, review it, and submit it for review to be merged, and
then synced amongst those who use tabkyra." Defaults chosen:

- **Where they live.** `community/skills/<name>/SKILL.md` and `community/cases/<name>.jsonl` in
  baney75/tabkyra, beside but apart from the built-in `skills/`. They are not compiled into the
  CLI or the extension; they reach users only through the signed catalog. A community skill
  can't take a built-in skill's name.
- **Scope instead of new frontmatter.** A required `## Sites` section names the sites (D1 keeps
  the frontmatter to name, description and license). Every link must point at one of them,
  and agents read a one-line header that names them. Community skills may not use `run_js` or
  page scripts, ask for credentials, or send page content anywhere: a navigation skill needs
  none of these, and each is how a skill under the user's sign-in would do harm. The rules are
  in `cli/src/skill-community.ts` and run in `skill lint --community`, `skill test`,
  `skill submit`, CI, the catalog build and on every client before a synced skill is used.
- **Second in line for routing.** Adding any skill changes every word's weight in the router,
  so a strict "no built-in skill may drop" gate would refuse almost every new skill, and a
  catalog that grew each day would move the built-in skills on every client. So the router
  keeps its index of built-in and local skills exactly as CI measured it, and consults a second
  index with the community skills added only when the first finds nothing, or when the task
  names one of the community skill's sites and the community skill leads the second index.
  The eval routes the same way (`twoStageRanker` in `cli/src/skill.ts`), and the baseline gate
  (built-in skills and `none`) catches a community skill that takes their cases. Each community
  skill needs 8 or more cases and must route 75% of them to itself (`COMMUNITY_TOP1_MIN`).
  The 75% is Claude's number; the measured example (notion-navigation) routes 9 of 10, losing
  one to the built-in `notes` skill, which also covers Notion.
- **Submission is the user's.** `polycarp browser skill submit` always shows a preview and exits 3; it
  sends only with `--confirm <code>`, a hash of the target, the skill, its cases and the note,
  so a yes covers exactly what the user saw. D14's `"auto"` setting for `/fix` doesn't apply
  here: every community submission needs the user's yes. The MCP tool only prepares
  (`skill_manage` action `prepare_submit`). It needs `gh` signed in and opens a fork pull request from the
  user's account. Personal data refuses the submission (D6); the skill is never rewritten to
  remove it. Lint and eval output in the pull request body is scrubbed of home paths, tokens,
  emails and the user's names.
- **Merging stays human.** CODEOWNERS covers `community/`, CI has no auto-merge, and a pull
  request that changes `community/` changes nothing else.
- **Signed catalog, release key, in CI.** `.github/workflows/community-catalog.yml` builds the
  catalog on main (on a merge that changes `community/`, the lint or community rules, or the release key, and by hand; no scheduled publish, owner 2026-10-28; a daily check with no signing key rebuilds the catalog, verifies the published file and signature, and opens an issue when they differ or the check can't run; a publish refuses a catalog whose source predates a change to its inputs or whose serial isn't newer; a takedown still waits for a person to approve its publish) in a job with no secrets,
  then signs it with minisign in the `release` environment in a job that runs no repo code,
  verifies it against `keys/tabkyra-release.pub`, and uploads it to the `community-catalog`
  release. No key is on a contributor's or user's machine. The signed trusted comment names
  the catalog's serial (its build time); a client refuses a catalog whose comment and file
  disagree, and any serial lower than the one it holds, so an old catalog can't be replayed to
  bring back a pulled skill. The kept file is verified again whenever it changes on disk.
- **Sync about daily.** The native host syncs on each hello and hourly when the last good check
  is over a day old, and `polycarp browser mcp` on start and every 6 hours on the same rule. A failed or
  refused fetch keeps the catalog in use and doesn't count as a check. `polycarp browser skill sync`
  checks now; `--off` (or the switch in Settings > Skills) turns community skills off and stops
  checking. The side panel gets the skills from the native host, never from the network.
- **Local edits win, while their base is in use.** Editing a community skill keeps a local copy
  (`skills-local`, base `community`). A sync never touches it; `skill list` says it overrides the
  community version and when that version changed. `skill revert` goes back. Such a copy is used
  only while the community skill it was made from is: in the verified catalog, community skills
  on, not removed by the user. So a pulled skill can't come back through a local copy, and
  opting out turns these copies off too. The file is always kept. (Review of #56, sol-F3.)
- **Cleanup is idempotent.** Every sync, from any process, deletes the installed copies (ours,
  with the marker) of community skills not in use, so a cleanup another process skipped happens
  on the next pass. A catalog can't pull a built-in skill: the build refuses it and clients never
  delete a built-in skill's copies. Catalog commits take a lock and recheck the serial under it,
  so a slow sync can't roll back a newer catalog. (Review of #56, first-F1, sol-F1, sol-F2, sol-F4.)
- **Pulling a skill.** Delete its folder and list it in `community/revoked.json` with a reason.
  At the next sync the skill is no longer matched or read (`skill_read` gives the reason), the
  copies Polycarp installed into harnesses are deleted, and a local copy based on it is turned
  off but left on disk.
- **Built-in skills keep their path.** `skill submit` refuses a built-in skill's name; changes to
  those still go through a pull request to `skills/` (the `fix` skill).

## D28. Subscription sign-ins: Sign in with ChatGPT and the Copilot SDK only (Claude, 2026-10-28)

Owner, 2026-10-28: "Make it so people can LEGALLY connect to their coding subs like codex claude
code ect ... follow the TOS exactly do none get banned." He approved registering a Tabkyra GitHub
OAuth App under baney75 ("Yes, register it"), chose "Build it" for ChatGPT, and asked to "review
and merge the codex login and copilot login thing". Sources and details: `docs/auth-policy.md`.

- **Two sign-ins, each on the provider's documented third-party route.** OpenAI: Sign in with
  ChatGPT for open-source and locally hosted apps (dynamic registration, no secret). GitHub: the
  Copilot SDK with Polycarp's own OAuth App (`Ov23li1qDiu9lRXbvcFh`, device flow, no secret).
- **No sign-in for Anthropic or Google.** Their terms forbid it, including driving their CLIs.
  Settings shows how to run Claude Code or Gemini CLI with Polycarp's MCP server instead.
- **No OpenAI interest form.** OpenAI's docs send open-source, locally hosted apps to the docs and
  paid or hosted apps to the form; Polycarp is AGPL-3.0 and local. The form itself says "If you're
  an open source developer, explore our developer docs", and it asks for a commercial partner.
  If Polycarp ever ships a paid or hosted build, that build needs the form first.
- **OAuth App, not a GitHub App.** GitHub's Copilot SDK setup page says both work and names the
  OAuth App in its steps; the owner approved an OAuth App. Expiring tokens are on, and the device
  flow refreshes them without a secret.
- **Tokens only in the native host**, in 0600 files, never in browser storage, as OpenAI's docs
  require. The side panel reaches the providers through the host's loopback proxy with a
  per-process secret.
- **The Copilot SDK is installed by the user** (`polycarp browser copilot-sdk install`, pinned 1.0.28,
  about 160 MB), not bundled: most users don't need it.
- **The API-keys-only rule of AGENTS.md is replaced** by "API keys, plus sign-ins on a provider's
  documented third-party route with Polycarp's own registration".

## D29. Dictation: speech to text on the device, the model chosen by the device (Claude, 2026-10-29)

Owner, 2026-10-29: "add a stt using a strong model that runs on device based on the device".

- **On the device, in the browser.** transformers.js 4.3.2 (pinned exactly) runs the model in a
  dedicated module worker (`src/dictation/worker.ts`); the audio never leaves the browser. The
  onnxruntime-web runtime (wasm and its loader, about 27 MB) ships in the extension under `ort/`,
  copied from the onnxruntime-web transformers.js resolves; the build rewrites transformers.js's
  jsDelivr default to it, fails if that default moves or isn't bundled, and fails if the built
  worker still names jsDelivr. That runtime is the onnxruntime-web dev build transformers.js 4.3.2
  depends on (1.31.0-dev.20260914), not a release; overriding it would run untested pairs. The
  package also installs onnxruntime-node and sharp for developers and CI; neither is bundled. MV3 allows no
  remote code, so nothing executable is fetched. The CSP gains `'wasm-unsafe-eval'`, which wasm
  needs and which allows no JavaScript eval.
- **Model files come from Hugging Face**, pinned to a commit per model, downloaded on first use
  and kept in Cache Storage. Settings > Privacy > Dictation shows the size and removes them. A
  first download of 200 MB or more is asked for (OK downloads it; Cancel, or Esc, only stops this
  dictation, since a native dialog can't tell the two apart; a smaller model is chosen in
  Settings); a smaller download is announced.
- **The device picks the model** (`chooseModel`, `src/dictation/tiers.ts`): WebGPU with
  shader-f16, 8 GB or more and 1 GiB buffers get Whisper large-v3 turbo (fp16 encoder, q4f16
  decoder, about 1.5 GB); another GPU gets Whisper small (about 590 MB); a processor gets
  Moonshine base for English or Whisper base otherwise (63 and 77 MB); under 4 GB gets the tiny
  ones. 4-bit encoders are left out: they are reported to drop speech. Settings can pick any
  model and a language; a language other than English never gets an English-only model.
- **Measured, not assumed.** `cli/eval/dictation.mjs` loads each model in the built extension's
  worker and transcribes reference clips, then presses the composer's microphone with Chromium's
  fake microphone and reads the composer. Results in `docs/benchmarks.md`.
- **Not Chrome's on-device Web Speech.** `processLocally` (Chrome 139+) is unconfirmed in
  extension pages and absent in Helium; it may replace the download where it exists, later.
- **The microphone permission** is asked for in an extension tab (`mic-permission.html`): a side
  panel can't show the prompt. The grant then covers the panel.
- **Silence is trimmed before transcription**, and a recording with less than a quarter second of
  sound above the noise floor (silence, a click, a cough) sends nothing: Whisper writes words into
  silence. Recording stops at 5 minutes and transcribes what was said.
- **pi-web-ui gains `composerActions`** (`AgentInterface` to `MessageEditor` `actions`), a slot
  for buttons beside the attachment button, through `patches/pi-mono.patch`.

## D30. OAuth for web connectors (Claude, 2026-11-01)

Owner, 2026-11-01: get the MCP working for claude.ai, grok.com, Grok Bot and ChatGPT online,
"maybe tailscale tunnels", and without paying for a tunnel.

- claude.ai, ChatGPT and grok.com call a connector from their own servers and can't send a
  static bearer header (ChatGPT supports only no auth or OAuth). So `polycarp browser serve
  --public-url` adds an OAuth 2.1 authorization server, ported from Waypost's (`src/oauth.ts`
  in baney75/waypost), which already works with claude.ai. Static `tkr_` tokens stay for header
  clients such as Grok Bot (`~/.grok/config.toml`, `url` plus a bearer header).
- One owner, so approval is a passcode on the consent page, not an account. The owner picks the
  grant's scopes there from the same SCOPES (D9); still no wildcard. Default ticks cover
  reading, opening pages, clicking and typing, the library, skills and `ask_user`;
  `browser.script` and `threads.read` must be ticked by hand.
- Codes go back only to the documented callbacks (claude.ai's and claude.com's
  `/api/mcp/auth_callback`, ChatGPT's `/connector_platform_oauth_redirect` and its
  per-connector `/connector/oauth/<id>`), to any path on grok.com and x.ai, whose callback path
  isn't documented, or to loopback. The consent page shows the full callback and how long ago
  the client registered, and warns against approving a link someone sent.
- The grant (a family of rotating tokens) is the session's owner, not the access token, so an
  hourly refresh doesn't end the session or its tab group.
- Rate limits count per client and per source, with high global caps that only bound scrypt
  work (run off the event loop, four at a time). A flood with forged source headers can still
  fill a global cap for up to 15 minutes; `polycarp browser token passcode` clears every limit. The
  passcode carries about 100 bits, so the caps don't guard against guessing.
- The passcode field is a masked text field with `autocomplete="one-time-code"`, so a password
  manager in the browser Polycarp drives won't fill it for an agent tab. Blocking agent tabs
  from the approval page in the extension is a follow-up.
- Tailscale Funnel can't be the public route on Donovan's tailnet: Tailnet Lock rejects Funnel
  ingress (field note `lab-a/tailscale-funnel-never-reachable-on-a-tailnet-lock-tailnet`).
  The free route is a Cloudflare named tunnel (every account includes 1,000 at no cost) on an
  always-on host, reaching the browser's computer over the tailnet. A quick tunnel won't do:
  its URL changes and it doesn't carry SSE.

## D31. Each install is its own single-owner server; no central relay (Claude, 2026-11-01)

Many users will connect claude.ai, ChatGPT and grok.com to their own Polycarp. `polycarp browser remote
setup` (docs/remote.md) is the one command for it.

- Each install is single-owner: its own OAuth server (D30), its own passcode, its own public
  address. There is no relay run by the maintainer.
- A relay would cost the maintainer money as users grow, and it would put one server in front of
  every user's signed-in browser: a single breach, subpoena or bug would reach all of them.
  Per-install servers keep the blast radius to one user and the cost at zero.
- Default route: Tailscale Funnel on port 8443. It is free, needs no domain and keeps the OAuth
  paths at the root of the URL; 443 stays private. Setup refuses without changing anything when
  Tailscale is missing, the tailnet has Tailnet Lock on (Funnel doesn't work there), or 8443
  already serves something else.
- Otherwise: a Cloudflare named tunnel (free) or any HTTPS front door the user runs to
  `127.0.0.1:<port>`, given as `--public-url`.
- `remote.json` in the config dir (0600) holds the route; `polycarp browser serve` reads it when
  `--public-url` is absent, and flags win. A user service (launchd or systemd, user level) keeps
  serve running.

## D32. Many devices behind one hub, still single-owner (Claude, 2026-11-02)

Owner, 2026-11-02: one public URL (for example `https://tabkyra.dbaney.com/mcp`) that claude.ai,
ChatGPT and grok.com add once, with any number of his own computers behind it.

- `polycarp browser hub setup` turns an always-on box into the hub. It needs no browser. It serves the D30
  OAuth server and consent page (shared code, `oauth-http.ts`) and `/mcp`, and proxies each MCP
  session to one of the owner's devices. A device runs `polycarp browser link`, which dials out to the hub
  over a WebSocket, so devices need no inbound port or tunnel of their own.
- Still D31: one owner, no relay run by the maintainer, no cost. The hub is the owner's own
  server; the maintainer runs nothing. An install has one public route, so `hub setup` refuses
  next to `remote.json` and `remote setup` refuses next to `hub.json`.
- Routing: a new session goes to an online device with the extension connected; not busy first,
  then fewest sessions, then the `prefer` order, then most recently seen. With no extension
  anywhere, any online device (tools such as `skill_match` still work). A session stays on its
  device and caller. If that device's link is gone, the hub answers 404 "Unknown or expired
  session", and the client's re-initialize lands elsewhere.
- Scopes never widen across the hop. The hub sets `x-tabkyra-hub-scopes` and
  `x-tabkyra-hub-caller` itself from the caller it authenticated, and drops any
  `x-tabkyra-hub-*` header a public client sends (the forwarded headers come from a short
  list). A device's `serve` honors those headers only for a `link`-kind token, only on the
  loopback serve `link run` starts (never one with a public URL, which refuses to start with
  that option), and uses the intersection of the token's scopes (the device's cap, default
  `DEFAULT_GRANT`, never `browser.script` or `threads.read` unless named) and the header's. Every
  other token ignores the headers. `link run` mints its link token at start and holds it in
  memory only; it is revoked when `link run` stops.
- Secrets: a device credential is 32 random bytes, kept on the hub as SHA-256 and compared with
  `timingSafeEqual`. Connect codes (`TK-XXXX-XXXX`, Crockford base32, 40 bits, 10 minutes,
  single use) and approval codes are kept as SHA-256. A code has 40 bits, far less than the
  passcode's 100, so the limits matter. Five wrong connect codes per source and 20 in all in 15
  minutes lock `/link/enroll` (429); the global cap holds even against forged source headers, and
  the cost is accepted: anyone can lock enrollment (only enrollment) for 15 minutes. Approval
  codes share the passcode's counter (five per client, 20 per source, 1,000 in all) and lockout.
  A device credential has 256 bits, so `/link` and `/link/code` check it first and never refuse a
  valid one; only failures are throttled, per source (30 in 15 minutes), with no global cap, so
  forged sources can't lock devices out.
- Capacity: a device handles 32 POST and DELETE requests at once and 24 sessions (its link
  token's cap). Each session has at most one GET event stream, counted apart from requests (up to
  24 per device), so open streams never starve tool calls. The hub reserves a request slot before
  it reads the body. A device reports its session cap and its scope cap in its status frame; the
  hub routes only to devices that have reported, allow at least one of the caller's scopes and
  have room, and prefers full scope coverage before busy and load. When no device grants any of a
  caller's scopes the answer is 403, not a forward that fails. The head timeout (120 s) waits for
  a response head only; a stream may run as long as it likes. Whenever the hub abandons a request
  it sends `cancel`. A request whose frame would exceed 16 MB after JSON escaping gets 413 without
  touching the link.
- Hostile and slow peers: the upgrade handler attaches its own error listener and answers a
  malformed request with 400, and `hub serve` survives a connection error that escapes (any other
  uncaught error is logged with its stack and ends the process, so the service restarts clean).
  An initialize reserves a per-caller and hub-wide (64) slot before its body is read. A client
  that stops reading pauses the device's link for at most 30 seconds, then the request is
  cancelled; a request past 16 MB of unread output is cancelled at once. An initialize the hub
  abandons leaves no session behind: the device lets it finish and closes what it made, and the
  hub deletes the session of a head that arrives late. Chunks never split a surrogate pair. An
  unreadable `hub-devices.json` is never overwritten, never revokes a live link, and authorizes
  nobody. Request handlers wait at most 200 ms for a lock file (503 after); a wrong code is
  rejected from a read-only look, before any lock.
- Reconnect: when a link ends, the device closes every MCP session that connection carried (the
  hub has already forgotten them), and `link run` holds an exclusive pid file so a second run
  refuses instead of revoking the first one's token. The link token is named `link:run`, a name
  ordinary tokens can't have.
- `hub remove` deletes the credential; the running hub notices within a second and closes the
  link. A manager device (`hub code --manage`) may mint connect and approval codes through
  `/link/code`; a stolen manager credential is therefore as strong as the passcode, and
  `hub remove` is the answer.
- Considered and not done: a hub that also drives its own browser (run `link` on the hub box
  instead), and a maintainer-run hub (D31).


## D33. Connect in the side panel: what the host answers and what the panel shows (Claude, 2026-11-02)

- The panel reaches the helper through a `connect` native-messaging frame, parsed strictly in
  `cli/src/connect-host.ts`: exactly `{type, id, method, params?}`, a known method, and that
  method's own params. A frame that isn't exactly that is answered `bad_params` when it has an
  id and runs nothing. The background worker (`src/connect/relay.ts`) only takes Polycarp's own
  pages and known method names; the host is the authority.
- `status` reads local files only (hub.json, remote.json, link.json, the live snapshots, the
  theme), never the network, so the panel can ask every 10 seconds. It reports `route` as hub,
  then remote, then link, then none. A config file that is present but unreadable shows as
  `problem` and the route reads none. An unreadable `hub-devices.json` also shows as `problem`,
  with the route still hub and no device list. `joinHub` and the panel's join form refuse while
  `problem` is set and whenever `hub.json` or `remote.json` exists, readable or not.
- Never in an answer: the passcode, a device secret or credential, a token hash, a device id.
  Codes are returned once to the panel that asked and are stored only as hashes (D32).
- `approvalCode` and `deviceCode` share one limit in the host: 10 in 10 minutes of either kind,
  counted when asked: a call that passes the route checks takes a slot, even if the hub then
  fails it; a call refused before that (no route, not a manager, a remote route) takes none. The window is a 0600 file of
  timestamps (`connect-mints.json` in the config dir), so a new host process or a second browser
  profile on the same config shares it; the hub's own caps (20 live codes) still hold.
- A code the hub returns to a linked manager device is checked before anything shows it: the
  code must be exactly `TK-XXXX-XXXX` and a connector URL an https origin plus `/mcp`, else the
  host answers "The hub answered with a malformed code." The panel checks again before drawing a
  code or the command that carries it.
- A request the helper never answers (a helper older than the panel drops the frame) fails after
  20 seconds, 30 for `joinHub`, with `no_reply` and "Update it: polycarp browser update".
- The setup prompt for an agent runs `remote setup` and `hub setup` with `--no-passcode`, which
  mint and print no passcode, so no long-lived secret lands in an agent's output or transcript.
  The one-time connect code approves the connection (D32), and the owner can set a passcode later
  with `polycarp browser token passcode` in their own terminal.
- `joinHub` runs the same enrollment as `polycarp browser link <hub> --code`, including the service.
  The address (https origin, or http on loopback; a pasted `/mcp` is dropped) and the code
  (`TK-XXXX-XXXX`, case and look-alike letters folded) are checked in the parser, before any
  file is read or any network call. It runs only when the route is none, one at a time.
  The lock on `link.json` covers only the check and the write, never the hub call or the service
  manager: a second join that starts meanwhile enrolls too, but finds the first one's link at its
  own write and is refused. The service install runs without blocking the host's event loop, and
  the host repeats its progress frame every 10 seconds so the panel's 30-second wait stays armed.
  A panel that still hears nothing after the service step began says the device may be linked.
- The device list shows on a hub's computer. A device linked as a manager can make codes but
  sees no list: the hub has no endpoint that lists devices for a device credential, and adding
  one widens what a stolen manager credential reads. Not done; the list stays on the hub.
- The side panel's colors are the approval and hub pages' presets (`src/appearance/palettes.ts`),
  so the three match. That changes the default look from mini-lit's neutral palette to the Polycarp
  one for everyone on update; the choice is saved in `chrome.storage.local`. Text pairs reach
  4.5:1 and the focus ring 3:1 in both modes (`test/appearance.test.mjs`). Control edges (`--input`,
  also the off switch's track) are derived from the text color to reach 3:1 against the page and
  the card; `--border` stays the soft divider. Light, Dark or Match system is sent to the helper
  with the preset and accent, kept in `theme.json` as `mode` (absent for Match system), and fixes
  the pages' `color-scheme`.

## D34. OAuth consent: agents never open the approval page; a new client needs a connect code (Claude, 2026-11-02)

Issues #94 and #97, follow-ups from #93.

- The native host reads `remote.json`, `hub.json` and `link.json` and sends the hostnames of their
  public URLs with each bridge request (`guardedHosts`, `cli/src/guarded-hosts.ts`). The extension
  refuses `navigate` and `tabs_create` to those hosts in every permission mode, `allow_all`
  included, and resets a tab that a redirect or history step lands on one (`isGuardedUrl`,
  `src/bridge/permissions.ts`). Only agent calls are checked, so a person opening the page in their
  own tab is not stopped. The match is the exact hostname (any port, any path), not subdomains: a
  public URL host is one name, and a wider match would block unrelated sites on a shared domain.
  Not covered: a link an agent clicks in a page already open, which the extension does not see as
  a bridge navigation.
- Consent phishing: anyone can register a client against the public URL and send the owner its
  approval link. A client with no earlier grant (`approved_at` unset, no `last_used`, no token)
  is approved only by a live one-time connect code, which the owner mints on their computer
  (`polycarp browser token approval-code`), outside the browser an agent drives. The passcode is not even
  checked for such a client, so the refusal tells an attacker nothing about it. A wrong code counts
  toward the same lockout. Clients with a grant before this change count as approved, so existing
  connectors keep working. Rejected: a separate `polycarp browser token clients approve <id>` pending flow;
  it adds a second state and a second command for the same out-of-browser step the connect code
  already is.

## D35. Connect hardening after review: who may ask, one join at a time, what the panel says (Claude, 2026-11-02)

- The Connect relay serves only the side panel document: a port whose sender has a tab, or whose
  URL is not `sidepanel.html` of this extension, is closed. A browser-driving client can open
  `sidepanel.html` as a tab, so that page must never reach code minting. `approvalCode`,
  `deviceCode` and `joinHub` also carry a gesture token. The security boundary is
  `isSidePanelPort` (the side panel document, no tab sender); code in that document is the
  extension's own, and MV3's CSP keeps page script out of it. The token is not proof of a click to
  the worker, which cannot observe one: the panel mints it only while
  `navigator.userActivation.isActive`, and the relay accepts it for 5 seconds, once
  (`src/connect/gate.ts`). It is a same-document guard against accidental or scripted calls from
  the panel's own code paths; code already in the panel can fabricate one. The relay has no test allowance; the panel e2e replaces
  `chrome.runtime.connect` with a stand-in, and a second e2e test drives the real relay from a tab
  and expects it to close the port. The bridge refuses to open `chrome-extension://<own id>/`
  in every permission mode, without asking the user.
- Joining shows a confirm step first: the hub's host, "The hub's owner will be able to open sites,
  read pages, and click and type in this browser as you", and each scope the link would allow with
  its description (`status.joinScopes`, `{id, what}` pairs from the host's `SCOPES`, the
  device's default grant, not the hub's choice). A helper that sends no list is out of date: no
  Confirm, "run polycarp browser update". Nothing is sent until Confirm, and what was confirmed is what is
  sent; a route change, a problem, or an edit to the address, code or name clears the confirm.
  Success lists the scopes.
- A join, from the panel or the CLI, takes `link.json.joining` (O_EXCL, under the short
  `link.json` lock; pid, nonce, time) before it contacts the hub and drops it when link.json is
  written or the join fails. A competing join is refused before it redeems its code. A reservation
  is stale after 5 minutes or when its pid is gone. This replaces D33's "a second join enrolls
  too, but is refused at its write". The commit re-checks under the lock: the panel the whole route
  (hub.json, remote.json, link.json), the CLI that no link.json appeared. A route created in the
  gap can still leave an unused device record on the hub; the join then writes nothing.
- `link off` and the Busy toggle take the `link.json` lock, so a toggle in flight cannot bring a
  removed link.json back.
- The hub's words do not reach the panel. Enroll failures map by status to fixed sentences (wrong
  or expired code, rate limited, unreachable, refused); the hub-chosen device name must pass
  `validDeviceName` before anything is written; service-manager output is replaced by "run
  polycarp browser link status". A manager's `/link/code` refusal maps the same way (401 revoked, 403 not a
  manager, 429 rate limited, otherwise "refused"; the CLI still prints the hub's words). The
  device-code origin the hub returns is normalized before use, and the hub normalizes it before
  sending. Whatever else passes through from the library is our own sentence, cut at 200 characters.
- `link off` stops the service and revokes the token outside the `link.json` lock (a service manager
  can be slow), then takes the lock only to remove `link.json` and the live file; when the lock is
  held it keeps `link.json`, says the service is stopped, and exits 1. Every lock file carries an
  owner token, so a holder whose lock was taken as stale never deletes the next holder's.
- `/link/code` for a device code returns the hub's public origin; the manager checks it (an
  origin only, canonical) and uses it in the command and the prompt. On the link route the panel
  shows the connector URL the hub returned with the approval code, and "Get a code to see the
  connector URL" before that, instead of deriving it from the link address.

## D36. Evidence captures: one `capture` tool, and recording through the screencast, not tabCapture (Claude, 2026-11-08)

- **One tool.** `capture` takes an `action` (`network_start`, `network_stop`, `record_start`, `record_stop`,
  `flight_start`, `flight_save`, `status`, `cancel`), not eight tools: every agent pays for the tools/list on
  every turn (budget 31,100 bytes, `cli/test/mcp.test.mjs`). The tool costs about 940 bytes. The list had 29
  bytes to spare, so the SDK's default `"execution":{"taskSupport":"forbidden"}` is no longer sent on each tool
  (about 1.9 KB; an absent field means the same). No description was shortened and the budget did not move.
- **Why not `chrome.tabCapture`.** `getMediaStreamId` for an agent's tab fails with "Extension has not been
  invoked for the current page (see activeTab permission)", with the host permissions Polycarp has and also after
  `tabs_show`: it needs the user to have invoked the extension on that tab, which no agent session has. Measured
  in Chrome 156 (the e2e Chromium). The debugger's screencast already renders a tab nobody is looking at, so the
  frames come from it (`startScreencast`), and the hidden page encodes them with MediaRecorder. No permission is
  added; the `offscreen` row in `store/permissions.md` says what the page now does. A tab that already streams to a
  live view is refused rather than taken over, and one tab has at most one video (record or flight) and one
  network capture.
- **One hidden page.** Chrome allows one offscreen document, so `static/offscreen.html` (was `pdf-text.html`) loads
  `pdf-text.js` and `recorder.js`, and `src/offscreen/document.ts` creates it with both reasons for whichever
  caller comes first.
- **Where the bytes go.** The extension redacts and encodes; the helper only writes. The extension answers a stop or
  save with the file (a HAR object, or base64 video, under the 60 MiB frame limit: HAR 50 MB, video 32 MB), the MCP
  server writes it to `configDir()/captures` (0700, files 0600, exclusive create, a link in the way refused) and
  the agent is told the path, size and what the file leaves out. A "WebM" with no EBML header is refused.
- **What a HAR never holds.** Credential headers and query parameters by name (Authorization, Cookie, Set-Cookie,
  Proxy-Authorization, and any name with token, key, secret or auth), by shape (`mask-body.ts`), in Location and
  Referer; no request body at all, because a password can sit under any field name and a page can remove its form
  before a check could look; a response body only for same-origin JSON (the rule `read_network` uses), masked. A cross-site frame's requests and other tabs' are not in it.
- **Flight recorder.** A MediaRecorder stream can't be cut anywhere: only its first bytes describe it and a cluster
  plays only from a key frame. `WebmRing` reads the stream's elements, keeps the header, and drops clusters older than 60
  seconds only where the next starts at a key frame, so the saved file starts at 0 and plays. Chrome writes every
  frame as a BlockGroup and a key frame is one with no ReferenceBlock; the ring reads both forms. Its window is a
  floor: key frames come about every 10 seconds, so a save covers 60 to about 70 seconds. A flight recorder runs up
  to 30 minutes, a network capture or recording 10; an ended capture is kept 30 minutes for its owner to save.
- **Scope.** A capture belongs to the session that started it (`CaptureManager`): its tab must be one of the session's
  at the start and while it runs (checked every 2 seconds against the session's record, and at once on close or
  release), and an id from another session answers as if it never existed. Remote tokens need `browser.capture`.

## D37. The in-use veil: drawn in the page, invisible to the agent, idle after 15 seconds (Claude, 2026-11-10)

The owner asked that a tab or window an agent uses be blocked out "with a cool thing to show its being used".

- **Where it is drawn.** Inside the page, because an extension can't draw over browser UI: one element appended to
  `<html>` (after `<body>`, so no body text or walk reaches it) with a closed shadow root, injected with
  `chrome.scripting` into the extension's isolated world (`src/browser/veil-page.ts`). Its styles are `:host` rules
  marked important, which beat any important rule the page writes for it; it is fixed, covers the viewport, and has
  `pointer-events: none`, so it moves nothing and every click goes through. Only the pill's "Take over" button takes
  pointer events. Not a top-layer popover: a popover's attribute and open state are visible to the page, and a page's
  own dialog still opens above it.
- **What a page can still detect.** That an element with a random custom-element name (new per document) and no
  attributes is the last child of `<html>`; its computed style (fixed, highest z-index, no pointer events); that
  `elementFromPoint` over the button returns that element between agent calls; and that it comes back (at most five
  times) when removed. It cannot read the agent or project name, the colors, or the text: they live in the closed
  shadow root and the isolated world, never in an attribute or a page global. A fixed tag name was rejected because it
  would let any page tell Polycarp is driving it with one query; a random name per document leaves it guessing from
  structure.
- **What the agent can't see.** `get_page_html` cuts the element out and `inspect_page` doesn't count it (both read
  the tab's tag from session storage, `veil-shared.ts`). `read_page`, `find` and `get_page_text` never reach it: they
  read `<body>`, open shadow roots and interactive selectors. A screenshot conceals it for the capture (`setCaptureCover`
  in `cdp.ts`, awaited before `Page.captureScreenshot`); a screencast or recording conceals it while it runs. While a
  call that hit-tests or sends pointer input runs (click, hover, drag, type, scroll, fill, actions), the button takes no
  pointer events, so neither the agent's `elementFromPoint` checks nor its CDP clicks can land on it. `run_js` code
  that walks `document.documentElement` can still find the element; that is the agent's own code.
- **Idle time: 15 seconds.** Between two tool calls the model thinks, typically a few seconds and sometimes over ten
  (not measured here; a reasoned default). Fifteen should keep it steady through a task and gone soon after one stops.
  `VEIL_IDLE_MS` in `veil-state.ts` is the one place to change it. Ending,
  releasing, taking over, a client leaving and closing the tab remove it at once, with no fade.
- **Take over** calls `userTook` and ungroups the tab, the path a drag out of the group takes, so the agent hears the
  same notice. The button answers only a trusted click on a veil the worker drew, in a top frame.
- **Theme.** The worker builds the panel's own tokens (`appearanceVariables`) for light and dark from the saved choice
  and the cached Polycarp theme. The panel now mirrors its Light / Dark / System switch to `tabkyra.mode` in
  extension storage so the veil follows it; before the panel opens once after this change, "System" is assumed.
  The group colors are Chrome's tab group colors, as custom properties.

## D38. Files in and out of a page: content through the helper, never a path to the browser (Claude, 2026-11-10)

Agents could not attach a file to a form or keep a file a page offers. One tool, `files`, does both.

- **One tool.** `files` takes an `action` (`upload`, `download`, `save_pdf`, `list`, `read`, `remove`), for the reason
  `capture` does (D36). It costs 1,319 bytes of tools/list (30,434 to 31,753), most of it the nine arguments. The
  list had 666 bytes to spare, so the budget in `cli/test/mcp.test.mjs` went from 31,100 to 31,800.
- **The browser never gets a host path.** `DOM.setFileInputFiles` would have the browser open a path the helper
  names: the path rules would then be enforced by nobody the user can see, and a remote helper could name any file
  the browser's user can read. Instead the helper reads the file and sends its content. The extension builds `File`
  objects in the page, sets `input.files` through a `DataTransfer` and fires `input` and `change`, or, when the
  element is not a file input, fires `dragenter`, `dragover` and `drop` with that `DataTransfer`. A label stands for
  its input. `multiple` and `accept` are honored: a second file for a single input, or a type it does not accept, is
  an error and nothing is set.
- **Pieces.** A frame to the extension is capped near 900 KiB, so an upload is `files.upload.begin` (each file's name,
  size, type and SHA-256, and whether it needs the person's yes), `files.upload.chunk` (480 KiB each, in order) and
  `files.upload.commit`. Everything is decided at begin, before content moves: the tab is the caller's, its site is
  allowed, the element takes these files, the person said yes. Commit checks the total and each file's hash, and that
  the tab is still on the host it was on at begin. A download runs the other way in 3 MiB pieces
  (`files.download.begin`, `.chunk`, `.end`), and the helper checks each piece's size and the total. A transfer
  belongs to the client and session that began it; it is dropped on any error, when either goes, and after five
  idle minutes. None of the writing methods is idempotent, so a dropped connection is never replayed.
- **Which paths (`cli/src/file-rules.ts`, pure, table-tested for Linux, macOS and Windows).** A remote caller (hub,
  tunnel, or any scoped session) may not name a path at all, only ids of files its own session saved. A local path
  is resolved with realpath and opened once without following a link; the rules judge that open file and the same
  handle is read, so what was checked is what is sent. Refused whatever folder they are in, by any part of the given
  or the resolved path: `.env`, `.env.*`, `*.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `*.ppk`, `id_rsa*`,
  `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `*.keychain*`, `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.pgpass`,
  `.git-credentials`, `known_hosts`, `authorized_keys`, `credentials`, `tokens.json`, `oauth*.json`, a browser's
  cookie and login stores by name, and anything under `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube` or `.docker`.
  Refused by place: the Polycarp and tabkyra config folders except `files/`, browser profile folders, and the
  system key stores (on Windows the same under `%USERPROFILE%`, `%APPDATA%` and `%LOCALAPPDATA%`). Names are
  compared without case on every platform, and folders without case on Windows and macOS. Also refused: anything
  that is not a regular file, a file with more than one hard link, an unreadable one, and on Windows a device path
  or an alternate data stream. At most 10 files and 10 MB per call.
- **When the person is asked.** Not at all for a file inside the session's saved-files folder or inside one of the
  MCP client's roots (`roots/list`; when the client has no roots, the helper's working directory). A root that is the
  home folder, above it, or a drive root counts as no root. Any other path needs a yes for that exact upload. The
  question goes the way a site question does (elicitation in the agent's client, and "Waiting for your answer" in
  Settings > Agents) and names the agent, the files, their sizes and the destination host. It differs from a site
  question in three ways: it is asked in every permission mode, `TABKYRA_AUTO_ALLOW` does not answer it, and there
  is no "from now on": only a yes to this one upload, never remembered. A no, no answer in two minutes, and a
  client that cannot show questions with nobody at the side panel are all refusals.
- **Where files may go.** Only into a page on a site the person has allowed for agents (the allowed list, or the
  "always allow" mode). A site the agent was let onto once is not enough, and a guarded host is refused as always.
- **Downloads.** `download` fetches in the tab's own page, so the page's origin, cookies and CORS rules apply and the
  extension's wider reach is not used. The URL goes through `checkUrl` like a navigation; a `blob:` URL must be the
  page's own; `data:` is decoded in the worker; a redirect that ends on a guarded address is dropped, and one that
  ends on another site gets the same `checkUrl`. The source URL kept with a file has credential-named query
  parameters masked (`maskUrl`). `ref` resolves
  to the element's `href`, `currentSrc` or `src`. The fetch runs in a user-script world of its own, because the
  snapshot world's policy allows no network. `save_pdf` is `Page.printToPDF`. One file is at most 50 MB and the
  error states the size; a session keeps at most 200 files and 500 MB.
- **Where they are kept.** `configDir()/files/<session>/`, under the rules captures follow: folders 0700, files 0600,
  created exclusively, a taken name gets a number. A name from a server keeps only its last part and loses leading
  dots, control and direction-override characters and what Windows refuses. Each file has an id; `upload` takes
  `ids`. A local caller is also told the path; a remote caller never is. `read` returns text as text (200 KB, and
  says when it cut), an image as an image only when its bytes are one, anything else as a resource blob, at most
  8 MB; over that it is an error with the size.
- **Scope.** `browser.files` holds the tool and is not in the default grant: the owner ticks it. Without it a remote
  session does not list the tool. A download is fetched in the page with the user's sign-in on that site and `read`
  returns it whole, so the scope alone must not reach what the session's other scopes could not (review round 1).
  Two rules in `ARGUMENT_RULES` (`cli/src/mcp.ts`), checked on every call and by the link cap, fail closed:
  `download` with `url` needs `browser.script`, because an address the agent names, fetched with cookies, is what
  `run_js` does with `fetch`; any `download` needs `browser.navigate`, because a link's file is what opening the link
  would fetch. What is left to `browser.files` with read and navigate is the file behind an element the page itself
  shows. Requests to another origin never carry credentials (`credentials: "same-origin"`), for any caller. The
  scope's description on the consent page says all of this.
- **Bound to the document.** The site check, the element check and the person's yes are for one document. `begin`
  leaves a random mark in that document and records its origin; the scripts that stash a piece and that set the
  files check the origin and the mark as they run, before they touch content, and refuse in any other document
  (`Bound` in `src/browser/files-page.ts`). A check made in the worker before the script runs cannot do this: the
  tab can navigate in between. A reload between `begin` and `commit` is refused for the same reason. A download's
  fetch checks the page's origin the same way, and `save_pdf` is refused when the tab changed origin while printing.
- **Bound to the caller.** A commit under way stays its client's to cancel. When the client disconnects, its session
  ends or the bridge connection drops, the upload is cancelled: no further piece goes to the page, the files are not
  set, and the pieces already in the page are cleared.
- **Cleaned up.** A session's folder is removed when the session ends: `session_end`, and for a remote session also
  when it expires or its connection closes (its id is never used again). All sessions together keep at most 2 GB,
  and a file being written counts against the caps from its first byte. A default project session's folder is keyed
  on the name the extension gave the client ("<name>-2" for a second agent in one project), which the helper learns
  before it touches a folder, so two agents in one project do not share saved files.
- **No new permission.** The manifest is unchanged, so `store/permissions.md` is too.
- **Not built: downloads a click starts.** A file the browser itself downloads (a click on a link with
  `Content-Disposition: attachment`, a form that answers with a file) never reaches the page's script, so this tool
  cannot see it. Catching it needs the `downloads` permission. That should be an optional permission the person
  grants from a click in the side panel, with the download then moved into the same session folder; it is a
  follow-up, not part of this change.
- **Next: the Spaces handoff folder.** The folder Spaces uses to hand files between the person and an agent should
  accept files from `files/<session>/` next, on Mac and Linux, so a file an agent saved in the browser can be passed
  to a native app without the agent naming a path. Not built here; no Swift or Rust code changed.

## D39. One remote flow on every surface, driven by the helper's JSON; no passcode from the panel (Claude, 2026-11-11)

- **One table of words.** Every state, `problem` code and `next.kind` the helper sends maps to one title, one sentence and
  one action in `src/connect/remote-copy.ts`. Only a state the table doesn't know shows the helper's own `message`. The
  Mac app holds the same strings, and a test holds the panel's assistant steps equal to what `remote setup` prints.
- **No passcode from the side panel.** D33 keeps the passcode out of every answer the panel gets, and a live connect code
  already approves an assistant again, so setups started in the panel pass `passcode: false`. A passcode is made only
  where it can be shown outside the browser (the terminal and the Mac app).
- **Funnel approval advances by retrying Funnel.** Status can't see Funnel being allowed (it stays `funnel_closed` until
  `tailscale funnel` runs again), so the panel calls `remoteFunnel` every 5 seconds for up to 10 minutes. It reopens only
  the Funnel `remote.json` already names; it needs no click because it changes nothing the person didn't set up. For the
  same reason it never mints a connect code (review round 1, second-N2): a code is made only by a method that needs a
  gesture (Turn on, Cloudflare's Turn on, New code). After the retry turns Funnel on, the result says to press New code.
  The gesture token lasts 5 seconds, so a retry minutes later can't carry one; one press is the cost.
- **A pending check is waiting, not failed.** A failure `remote test` marks `pending` (a new name not in public DNS yet,
  a tunnel still connecting, a resolver that can't be reached) means the route is on: the panel shows the result with
  the address, a code when the person pressed Turn on, and "the address is still being published", and runs the outside
  checks again every 30 seconds until they pass. Only a failure that isn't pending is "failed" and can offer Repair. A
  Cloudflare setup whose last check times out after the tunnel was made is the same case, not a failed setup.
- **Repair is feature-detected.** The host runs `remote fix --json --dry-run`; exit 2 or no `actions` array means this
  helper has none, and the button stays hidden. Repair also stays hidden when the plan's `actions` is empty.
- **The Mac app retries Funnel by running setup again, every 15 seconds.** It has no `remoteFunnel` call, and setup run a
  second time makes no new passcode (one exists) and reopens only what `remote.json` names. 15 seconds, not 5, because a
  setup run costs more than opening Funnel. The same 10-minute limit, then one Check again button. The retry runs setup
  without `--connect-code`, so, as in the panel, only a press (Turn on, Check again, New code) makes a code.
- **Leaving Settings > Browser pauses the Funnel retry; coming back resumes it with a fresh 10 minutes.** Coming back
  tries at once, because Funnel was most likely allowed while the window was away, and never reopens Tailscale's page.
  A fresh limit, not what was left of the old one, so a person who allowed Funnel slowly isn't sent to the gave-up step
  the moment they return. The passcode and connect code stay through a tab switch and go when the window closes.
- **`launcher` has a Mac entry of its own (`launcher_app`).** The terminal's remedy is `polycarp install`; the app's is
  Connect in the Browsers section, which installs the launcher. The entry lives in the shared table, so the words still
  come from one place.
- **Replaced claim.** "claude.ai often can't reach Tailscale Funnel addresses" had no source and is gone. The true reason
  Funnel fails on some networks is Tailnet Lock (D30), which the Tailnet Lock step now says.
- **`remote fix` ends the wait (review round 2, second-N2).** An answer whose `next` is `run_command ... remote fix` is
  setup saying the wait is over, so it is a failed check with Repair, not "still being published", and the host makes no
  code for it. Any result still waiting after 15 minutes (`WAITING_FOR_MS`) draws its pending check as failed and offers
  Repair. 15 minutes: setup already waited 5, and a new public name or tunnel answers well inside that.
- **Nothing claims to wait unless something polls (first-F2).** The operator refusal waits only while the Funnel retry
  runs on a saved route; once it stopped, or before anything is saved, the step is `tailscale_operator_check`: the command
  and "Check again" (Funnel again on a saved route, Turn on otherwise). A stopped Repair never says it waits (PR 136
  review round 1, second-S2 and first-F2): every step that would wait drops its "this page checks" sentence, ends "Then
  press Repair again.", and draws one Repair button in place of the checklist's.
- **Probes never block the host (first-F3).** `remoteState` and the Funnel retry read Tailscale through async commands
  with a 15-second limit (`PROBE_TIMEOUT_MS`). The choose screen asks every 3 seconds until it has read the routes, then
  every 15 (`CHOOSE_POLL_MS`): an install or sign-in in another window still shows up, at a fifth of the cost.
- **Setup's refusals are steps (first-F1).** The Cloudflare tunnel step returns setup's report when it isn't ok, and the
  panel draws its state, so every `cloudflare_*` entry is reachable. Only a setup with no report at all is an error.
- **Mac-only result strings stay in the one table (first-F4).** `passcodeLabel`, `passcodeNote` and `turnOff` are for the
  Mac app (it shows a passcode once and has Turn off); `MAC_ONLY_RESULT` names them, and a test fails on any other result
  string the panel doesn't draw.
- **Only a refusal is a refusal (PR 136 review round 1, first-F1).** Setup's report counts as a refusal only when it isn't
  on (`answerOn` false). A new Cloudflare tunnel that answers 502 or 530 in its first minute is on and pending: the panel
  keeps the result, its code and the 30-second check. A late `remoteFunnel` answer after "Use Cloudflare instead" is
  dropped, and the Cloudflare form is skipped only for a refusal that came from that form (second-S1). Retrying after a
  refusal uses the saved hostname only when the saved route is Cloudflare, else the name the refused run was for (second-S3).
- **One Tailscale read per poll (first-F3).** `remoteState` reads lock status, status and serve status once and derives
  the routes, the plan and the Funnel check from that one result.
- **The 15-minute wait counts visible time (second-S4).** Each tick adds at most 2 seconds (`WAIT_TICK_GAP_MS`), so a
  hidden or asleep panel doesn't jump straight to failed when it wakes.
- **A Tailscale that doesn't answer is unreadable, not signed out (second-S5).** A probe that hits its 15-second limit
  reports "Tailscale didn't answer within 15 seconds", with nothing changed, never the sign-in step and never "on".
  The answer carries `code` `tailscale_silent` (PR 136 review round 2, first-F1 and second-S1): its own step, "Tailscale
  didn't answer, checking again", which polls `remoteState` and has Check again, not Try again. On a saved route it comes
  ahead of the result and of an older run, like the states in BLOCKING. `remote status --json` reads Tailscale through the
  same 15-second probes, so the Mac app gets the step inside its 30-second wait and polls every 4 seconds while it shows.
- **A failed check always keeps a way forward (PR 136 review round 2, first-F2).** When Repair has nothing behind it (no
  `remote fix`, or a plan with no actions), the check_failed step's button is Check again, which runs `remoteTest` (the
  Mac: `remote test`); a test that says the route is on ends the step.


## D40. The side panel's model uses the bridge's ref tools, grouped as one `act` tool (Claude, 2026-11-11)

- **One implementation.** The panel's calls run the bridge's own handlers (`src/bridge/tools.ts`) on its own browser
  session: the stale-ref refusal, hit-tested clicks, shadow roots, frames and dialog handling are the ones MCP clients get.
  The specs, routes and result text live once in `src/bridge/page-tools.ts`; the panel adapter (`src/tools/page-tools.ts`)
  and the CLI's `mcp --profile panel` both use them. Read formatting (`src/bridge/format.ts`) is shared with `cli/src/mcp.ts`.
- **In the service worker.** The panel sends each routed call as a message and the worker runs it
  (`src/bridge/panel-calls.ts`). Loading the handlers in the panel pulled their capture, PDF and site-edit code (the public
  suffix list alone is 150 KB) into what the panel parses to open, 2,061,447 bytes against the 1,900,000 budget even as a
  lazy import, because the bundler shares those modules with the panel's own. In the worker the panel stays at main's size.
  The worker answers only `sidepanel.html` of this extension.
- **One source of truth for the tabs.** The panel and the worker each hold a BrowserSession object for the panel's
  session; the stored session table is the truth for both. The worker reads it under the table lock for every call
  (`BrowserSession.existing`), its handlers write it the same way, and the panel reads it back as each call returns, so a
  navigate {switchToTab} or {newTab} is what the next read_page sees, and a tab the worker made current is the panel's at
  once (storage.onChanged alone arrives a task later). Tests: a tab switch then a read across two contexts, and in the
  panel e2e.
- **Worker restarts.** With no native host connected nothing keeps the worker running, and Chrome stops it after about 30
  idle seconds. The panel pings it every 20 seconds until five minutes pass with no page tool call, which covers a
  model's thinking between calls. What act x/y needs is kept anyway: the worker mirrors the screenshot scales and open
  dialogs into storage.session (`persistCdpMemory` in cdp.ts, the worker only, so the panel's own extract_image scales
  can't replace them) and reads them back when it starts. act x/y with no screenshot of the tab is refused with
  `bad_params`, never mapped by a guessed scale. The panel e2e stops the worker over DevTools between act screenshot and
  act click x/y.
- **Stop ends the call.** The panel stops waiting the moment the user presses stop (`interrupted`), the worker answers
  the call at once and stops the handler between steps, and a handler that never settles is cut off by the bridge's
  `withTimeout(HANDLER_TIMEOUT_MS)`, now shared from `src/bridge/errors.ts`.
- **Five tools, not fifteen.** read_page, find, get_page_text and handle_dialog stay separate; the ten input tools (click,
  type, fill, press, hover, scroll, drag, wait, screenshot, actions) are one `act` tool with an `action` field. Fifteen
  separate tools cost the panel 1,938 tokens a turn over main (+21%); the grouped five cost 1,187 (+13%), measured with
  `cli/eval/panel-prompt-size.mjs` (docs/benchmarks.md). Small models run the panel in 16k to 32k windows, and reading
  comes first in the loop, so the reads keep their own names. `actions` is `act` `steps`, and scroll's `to` is `edge`, so
  `to` means only drag's end point.
- **Left out.** tabs_* (navigate lists, opens, switches, shows and closes the panel's tabs), run_js and get_page_html (the
  REPL), files (its approval flow is the bridge's question to the user), read_console, read_network, inspect_page and
  capture (debugging and evidence for outside agents), site_edit and site_script (Settings > Sites), and search, crawl,
  skills, library and threads (the helper's or the panel's own tools).
- **Same reach as before, nothing looser.** The tools act only on tabs in the panel's session (the handlers refuse others),
  never on a Polycarp page (`isOwnExtensionUrl`), open no site (their `checkUrl` refuses; navigate stays the panel's own
  tool) and send no file (`askUpload` is false). The bridge's per-host allow list governs outside agents and is not
  applied: the panel's model could already act on these pages through the REPL, and asking before acting under the user's
  sign-in stays a system prompt rule, as it was. Guarded hosts are the native host's to name per bridge request, so the
  panel has none. Page text from read_page, find and get_page_text is listed as untrusted data in the prompt.
- **Dialogs.** A non-dialog-safe call fails with `dialog_open` while any session tab has a box open, and a click that
  opened one is the click's success, through the same `raceDialogs` bridge requests use (`isDialogSafe` moved to
  `src/bridge/dialogs.ts` so both share it). The bridge's messages name MCP tools; the panel rewrites the two that name
  tabs_context and tabs_select into navigate's words.
- **One rule for the REPL and the page tools.** The REPL runs code: data work, files, bulk extraction, a skill's
  functions, a recorded workflow's replay() and skill code under test. The model's own clicks and keys go through act.
  The tool list, the Working on Pages paragraph, browserjs(), Website automation and the skill tool's Creating Skills
  steps all say this; a capability is found with read_page and act, then written as skill code and tested in the REPL.
  nativeClick and friends remain for skills.
- **act steps reports everything.** Beyond the count and note, every field the batch returns (`notRun`, the dialog it
  opened, what each step did) reaches the model.
- **Enums are `{type: "string", enum}`**, not a union of literals: Google's API rejects the anyOf a union makes, as the
  skill tool already notes.

## D41. Input tools wait for the page to settle, capped at 2.5 seconds (Claude, 2026-11-11)

Gap analysis item 4. `navigate`, `click`, `type`, `press`, `fill`, `scroll` and the end of `actions` wait, after their action, until the
page has been quiet for 300 ms or 2.5 s have passed; `wait {until:"settled"}` waits for 500 ms of quiet, up to `timeoutMs`
(default 10 s). `drag` waits for 200 ms of quiet, up to 0.6 s, with Network left as it is. Quiet means all three
(`src/browser/settle.ts`):
- **No request the page waits on.** Documents, scripts, stylesheets, fetch and XHR from the tab's debugger Network events;
  images, media, fonts, pings, EventSource and websockets don't count. Only requests started after the action began count,
  and only while they are younger than 2 s (5 s for `wait`): a long poll or a stream would otherwise hold every call to its cap.
- **No DOM change.** A MutationObserver the first wait leaves in the document, in Polycarp's isolated world; the veil's own
  element is left out.
- **No loading marker on screen.** `aria-busy="true"`, or a class token `skeleton`, `shimmer`, `spinner` or `loading`
  on a visible element in the window, and a document still parsing.

Why these numbers: 300 ms covers a 250 ms search debounce, which is common, while keeping a click on a quiet page under half
a second. The cap bounds a page that never goes quiet (a ticking counter, analytics pings, a feed). A result that hit the cap
says `settled: false` and what it was waiting on; one that settled says nothing more. The wait stops at once when a dialog
opens, and the dialog stays the action's effect (it is reported as before, not as `dialog_open`). Steps inside `actions` keep
their `settleMs` pause, so canvas batches are not slowed. Not counted: requests and mutations inside cross-origin frames.

Network bookkeeping: Network is turned on just before every action (a batch's first step included), not once per tab,
because a debugging session can end with no event (a worker restart, a silent detach) and take the domain with it; the e2e
run caught that. Each action sends it once (a whole `actions` batch too, in the tab it names), and waits at most 0.5 s for it. A frame's current document is the one
`Page.frameNavigated` last committed; what an older document of that frame had in flight is dropped. A request for a document
never moves that mark: a download or a 204 asks for one that never commits, and the old page keeps its own requests.

What it can never do: hold an action longer than the cap plus that 0.5 s (a timer ends the wait at the cap whatever the page
or the debugger does, and one DOM probe gets at most 0.4 s), or fail an action that already ran. A box the page opens while
it settles is the action's result, with the dialog note, for every tool that settles. A page Polycarp may not script (the
Chrome Web Store, the PDF viewer) is judged by its requests alone after two refused probes, counted per document (the main frame's loaderId, so a reload starts over and a hash change does not), so a page reached from there is probed again; a probe that times out means the
page's main thread is busy (`waitingOn: "loading"`). A loader counts only when a person could see it: an ancestor's opacity or
visibility hides it, and so does being outside the window on any side. A landing on the approval page (#94) is blanked
before anything runs in it, so the wait never starts there. A redirect can still commit there after the wait last read
the tab, so the probe checks the approval hosts itself and touches nothing on that page; `wait` with `until: "settled"`
then refuses the landing as `navigate` does, and a wait cut short otherwise says it stopped, not that the page kept
changing. A cap that lands mid-pass reports the reason the last full pass found, and no probe goes out after it.

The side panel's `act` runs the same handlers (D40), so its input settles the same way (`test/panel-settle.test.mjs`).

## D42. Every panel request fits the model's window, by one rule the tests check over a grid (Claude, 2026-11-12)

A 400-page PDF handed whole to a small-window model got `400 status code (no body)` and left the chat dead. The guard
(`src/models/context-guard.ts`, `src/models/context-budget.ts`) sits outermost on the panel's stream function, so every
route a request takes is fitted. Two rounds of review found four ways the first version still sent a request that could not
fit, or locked a model out. They were one bug: the guard was a list of cases. Now it is one rule.

**The budget.** The window, less the reply's room, less the fixed part (system prompt and tools) as measured. The reply
gets a quarter of the window, at most what was asked; when the conversation would have less than 512 tokens, the reply
shrinks to 1,024 first. Below that floor nothing is sent and the person reads the window that would work.

**What gives way.** Everything in the history, in this order, until the estimate is under the budget: tool results and
attached documents (each to one budget however many parts it has, older ones to a stub, then all halved, largest first),
images, earlier replies (thinking, large tool call arguments, text), the person's earlier messages, whole earlier turns
(oldest first, with a note), then the latest message and the turn in progress, ending with the newest call's own thinking.
Every halving ends at the floor itself. Each tool call keeps its result, the person's latest message is always sent, and
the stored chat keeps everything. A request still over the budget is not sent.

**Whose words they are.** The guard fits the messages as sent: after the panel's transformer, which turns each navigation
into a user-role note and moves it after the tool results, mid-turn. A note opens with `CONTEXT_NOTE_MARK`
(`<browser-context>`), read once before any cut, since a cut can leave no room for it; it is cut like a tool result and travels with the call it follows. Only the person's messages start
a turn or count as the latest message, so a navigation can never push the person's question out as an "earlier turn".

**When the provider disagrees.** One retry, with the conversation halved and the fixed part whole. A smaller window is
learned only on proof (the provider's words name size, or refusals on two turns in a row; a first-try success resets the
count), never below what the fixed part needs, and forgotten when a probe after 10 good turns works at a larger size.
Proof means the provider's words name the context, the prompt or tokens ("image too large" does not), and a request worked
only when its reply ran to `done`: a stream can start and then fail, so the outcome is read past `start`. A refused probe
falls back to the learned window, the size known to work, and nothing a refusal teaches rises above what was learned. A
learned window is evidence about a past request, not a law: when the instructions or tools grow past what it can hold, it
is dropped and the model's own window is tried. The reply the guard reserves is sent to every provider, custom ones too.

**Measuring the fixed part.** Text keeps the conservative estimate (3 characters a token, punctuation 2, CJK more), since
undercounting sends what won't fit. Tool schemas don't: the panel's 13 tools are 8,979 tokens in o200k, and the general
rule counted 12,536, which left a 16k model no room. Schema ASCII counts at 3.5 characters a token (about 10% over).

**Each limit in its own unit.** A cap is checked on what crosses it, in the unit it is in. The guard's limit is tokens, so
`extract_document` and the panel's page tools measure their answer with `estimateTextTokens` and read again smaller when
it is over. The MCP cap is characters of JSON, so the bridge's reads, `page_markdown` and `crawl` measure their text as
JSON writes it (`encodedHead`), and the net keeps a value valid JSON by cutting its longest fields. A file read counts bytes
that aren't UTF-8 as the decoder does, so its offset is exact.

**Tools size their own answers to the same budget.** `extract_document`, and since D40 the panel's `get_page_text` and
`read_page` (`fitPageCall` in `src/bridge/page-tools.ts`), ask for what one result may hold and say how to read on, so the
guard never cuts their notes away. Screenshots count 1,600 tokens and give way like other images, with a line saying so.

Rejected: sending and letting the provider's refusal decide (a bare 400 says nothing, and the chat is dead in the
meantime); a real tokenizer in the panel (one per model family, megabytes each, and still an estimate of the chat template).
Proof: `test/context-guard-property.test.mjs` runs the guard over windows from 8k to 200k, fixed parts from 2,000 to 20,000
tokens, providers that take less than they claim, and random histories, and asserts every send fits, keeps its pairs and the
latest message, and that a refusal naming size heals. Each finding has a named test, and each fix was broken on purpose to
see its test fail.

## D43. Input tools report what they changed (Claude, 2026-11-12)

Gap analysis item 3. `navigate`, `click`, `type`, `press`, `fill`, `scroll`, `drag` and `actions` (one report per batch)
return `changes`: what the action did to the page, so an agent acts on the result instead of reading the page again to find
out (`src/browser/changes.ts`). The tool looks at the page just before the action and again after it settles (D41), and
reports the difference:
- `url` and `title` when they changed; `tabsOpened` (id and URL) and `tabsClosed`; `focus` when it moved somewhere other
  than the control the action went to.
- `appeared`, `changed` and `gone`: controls with their ref, role and name, as `read_page` lists them. The same element keeps
  its ref, so a listed ref works at once. An element that now shows something else (a reused row, a live counter) gets a new
  ref; when the look finds the same element under it, that is one changed line naming the old ref right after the new one
  (`e9 (was e5) ...`), since that ref fails now. An identical node put in a control's place (a form re-render) is a new
  element, so it is listed as appeared and the old ref as gone, never paired by role and place. A scroll pairs nothing: a
  list that recycles its rows shows new items in old elements. Anything else whose old ref fails is listed as gone. A changed line says what changed (name,
  value, states).
- `newText`: up to 3 new lines of page text, 100 characters each (`moreText` counts the rest); a line that only repeats a
  listed control's name is left out. `text` says the text changed when no line is new.
- A full navigation is a new document: `navigate` says `page: "new page; read_page lists it"` without looking, since every
  ref is new and the list would be the page; back, forward and a jump to a hash are compared. A URL that loads no document
  (a 204, a download) leaves the main frame's loader as it was (`Page.getFrameTree`), and then the report says `"no new page
  loaded"`. Tabs the load opened or closed are in both. A load that timed out says
  `"still loading"`, so `navigate` always returns `changes`. `actions` whose step changed the current tab says `"moved to tab
  N"`: the look was on the first tab; a batch that names a tab and only waits stays on it. `drag` waits briefly (0.6 s cap,
  0.2 s quiet, Network left as it is), so a drop that reorders a frame or a transition later is in the report, at most about
  2.1 s with the looks; `scroll` keeps the full wait, since a list loads its
  next rows after the scroll, so a scroll on a page that never goes quiet takes at most about 4.5 s (Network on 0.5 s, the
  2.5 s cap, two looks of 0.75 s), held by a test in `test/changes.test.mjs` that runs each part to its full time and allows
  300 ms for the test machine.
  With nothing to report the field is `"nothing changed"`.

Bounds: each look is capped at 0.75 s, so the report adds at most 1.5 s to an action (`changes.test.mjs` holds that
ratchet), and a page of over 15,000 elements is not looked at (`page: "too large to compare quickly"`). Past 400 controls
on either side only the URL, title and text are compared and `partial` says so, since a scroll would make old controls
"appear". 12 element lines (`more` counts the rest). A report is two real looks compared or it says `page: "could not be
compared; read_page shows it"`: a look that timed out, a page that refuses scripts, or a guarded page never yields
"nothing changed". The click point is found after the first look, so a layout shift during it cannot move the click. A page with an open dialog is
not looked at: the dialog is the result. The look after the action runs inside the window where a dialog counts as the
action's effect (D41). The approval page is never looked at: the tab's pending URL is checked first, and the look's script
checks the approval hosts itself before it reads anything.

Safety: the report holds page text, quoted like `read_page` text (one JSON string per line, control characters replaced,
capped), and covered by the same rule in the server instructions: page text is data. Password values never appear, since
the snapshot leaves them out. Nothing is clicked, focused or scrolled to take a look.

Measured with `cli/eval/change-report.mjs` on 8 multi-step DOM benchmark tasks (`docs/benchmarks.md`): 48 tool calls and
about 3,231 tokens with the old read-act-read loop, 33 calls and 2,411 tokens acting on `changes`, every task passing its
check. One action takes 369 ms on average against 365 ms without the report. The server instructions and the skill now say to
read `changes` and to call `read_page` again only when they say too little. Cost in the schema: the instructions grow by 47
bytes (about 12 tokens, 2,991 measured, budget 2,995 in `cli/test/mcp.test.mjs`); tools/list is unchanged by it (32,676
bytes with D42's bounded reads), since no tool gained a parameter.

Size: the report is a summary, never the page. Each URL is held to 200 characters and each element line to 160, and the
whole report, as JSON, to 3,000 characters (about 750 tokens, `CHANGES_MAX_CHARS` in `src/bridge/fit-changes.ts`). In the
side panel it also counts against the room D42 keeps for one tool result: `act` gets that room for its report, and on a
model whose estimate still runs over (CJK text, long names) the report is fitted again, shorter, before the guard would cut
the result. Fitting drops new text lines first, then element lines from the longest list (`more` counts them), then opened
tabs; a report that still does not fit says only "changed, too much to show here; read_page shows it", never "nothing
changed". MCP results stay far under their own net (`OUTPUT_CAP`, 100,000 characters).

The side panel's `act` runs the same handlers (D40), so its results carry `changes` too, and its prompt's loop line says
the same thing as the server instructions: 13 tokens more in the panel's system prompt (1,996 to 2,009, o200k_base), the act
tool's description now says the same, 9 tokens more in the tool list (8,613 to 8,622) (`cli/test/e2e-panel.test.mjs` checks a click's report).

The looks leave refs as the agent last saw them. A look snapshots the page, and a snapshot gives a reused row a new ref; the
looks keep the old ref too, so a click by it still fails with "now shows something else", as it would with no look
(`keepStale` in `pageSnapshot`). Only `read_page` and `find` retire a ref. A control whose name keeps changing (a live
counter) gets a new ref each look, so at most 200 such kept refs stay between reads.

Platforms: all of it runs in the extension's service worker and the page, with no code per operating system, so Chrome,
Helium and the other Chromium browsers on the Mac, Linux and Windows behave the same. Run on the Mac (the e2e and panel
suites) and on Linux (CI); not run on Windows.

## D44. Search a document instead of reading it, with the tools agents already have (Claude, 2026-11-12)

**Problem.** A 400-page PDF is about 560,000 characters. Read whole, it killed the chat (D42 now cuts it to fit, but
a cut book still can't answer "what does Aristotle say about friendship in Book VIII"). Paging through it 50,000
characters at a time takes a dozen calls and fills the context with pages nobody asked about.

**Decision.** Search first, then read the pages that matched. `get_page_text` takes `query`: on a PDF tab the answer is
the matching pages, best first, with numbers and snippets (the same ranking as the panel's `extract_document`,
`src/tools/document-reader.ts`), and `pages` then reads them; on a long page it is the matching parts of about 3,000
characters, each with the `offset` that reads it. The parsed PDF is kept by URL (six at a time) while the extension
runs. Over MCP the tool already existed, so `query` costs 143 bytes of tools/list, not a new tool's 600 or more. The
side panel keeps `extract_document` for URLs and attachments (and now long web pages), and gets the same `query` on
its own `get_page_text`. Nothing is platform-specific: pdf.js runs in the extension's offscreen document on every
Chromium browser, Mac, Linux and Windows alike.

**Not done.** A document store that outlives the extension (IndexedDB, a Documents tab): a URL is fetched again after
a restart, and an attachment is kept in the chat itself. It can come when a measured case needs it.

**Proof.** `test/document-search.test.mjs` (the bridge's real handler on a PDF tab and a long page; one parse for two
searches; offsets that read the part that matched), and the 32k panel e2e above.

## D45. Long chats are summarized when the guard would drop turns, and the notes are kept in the chat (Claude, 2026-11-12)

Problem: on a small window the guard (D42) keeps a long chat going by cutting it, and past a point by dropping its
earliest turns whole, so the person's first instructions and what was found go with them.

Decision:

- **When.** The agent's `transformContext` hook (`src/models/compactor.ts`) runs the guard's own `fitContext` on what it
  would send, with the guard's budget (the learned window included). Only when that would drop earlier messages
  (`Fitted.dropped`) does it summarize; otherwise the request is the same array, byte for byte. One rule, so the two
  never disagree on what fits. The guard still runs after it, as the last line.
- **What.** The chat's own model, through the panel's guarded stream function and with no tools, writes notes in six
  fixed sections. Older tool results reach it reduced to what they proved (URL, title, the lines later answers used),
  inside `<untrusted>` blocks; goals and instructions come only from the person's messages. A later round rewrites the
  notes with the next part of the chat; a section left out keeps its earlier points.
- **Budgets** come from the guard's room (its input budget less the system prompt and tools): notes up to a quarter of
  it, the person's earlier words a tenth, the recent turns kept verbatim two fifths. Under 1,200 tokens of room the
  guard cuts instead.
- **The latest question** is never summarized: the cut falls before the person's last message, never between a tool
  call and its result.
- **Kept.** The record is a `compaction` message appended to the stored chat. The model path ignores the role; the
  compactor builds the request from the latest record, so a reloaded panel sends the same notes with no new call.
  History and export stay whole.
- **Failure.** A failed or unsectioned summary shows one notice per chat and sends the request as it was, for the guard
  to cut; no new try until the chat grows by about half the verbatim budget.

Not done: the context meter and the "summarize now" press from the first draft of this change (PR 140), to keep this
change small; they can follow.

Proof: `test/compaction.test.mjs`, with each of the five rules above broken on purpose to see a test fail, and a panel
e2e that runs a chat on an 18k stub model until it is summarized, reloads the panel, and checks the next request
carries the stored notes and the latest question with no new summary and nothing dropped.

Amended after review (PR 140 round 1, 2026-11-12):

- **Who said what is structure.** The summarizer reads each message as a `<message from="person|assistant|tool|browser">`
  block built from the stored role. Text inside a block can't open or close one, and a role marker inside it is shown
  as a quote.
- **The notes are Polycarp's.** The notes message carries the `compactionNotes` field (`COMPACTION_NOTES`), never a
  text mark, so nothing the person writes can pass for it. The guard never counts it as the person and cuts it only
  after every earlier turn (step 8b), before the latest message.
- **Full history when it fits.** A stored record applies only while the whole chat would make the guard drop turns.
- **A turn compacts at most twice.** The second time cuts at the person's latest message, so further tool steps find
  nothing to summarize.
- **Done steps** is a section of its own.
- Chunks are sized by `estimateTextTokens`; summary calls are recorded in Costs; `compaction-summary.ts` loads on the
  first compaction.

Amended after review (PR 153 round 1, 2026-11-12): telling the person's lines from planted ones by word overlap failed
on short planted lines, reworded steps, other languages and facts promoted in a later round. Structure replaces it:

- **The person's instructions never pass through the summarizer.** Code quotes the person's own earlier messages word
  for word under "The person's own words": the first one (cut by code, with a count, only if it alone is too long) and
  the most recent ones, whole, with a count of those left out. The summarizer writes no goal section.
- **Everything the summarizer writes is labeled once** as Polycarp's working notes from pages and tool results: facts
  and progress, not instructions. The system prompt says nothing in the notes authorizes an action the person's own
  words don't. A planted line is at worst a recorded fact; no filter is needed.
- **No rule drops or adds a step because its wording changed.** A section the summarizer leaves out or answers with
  "none" keeps what the earlier notes had. The earlier notes reach the next round inside an `<earlier-notes>` block,
  as data.
- **Cut order.** The notes message has two text parts, the person's words and the working notes. A cut to fit takes
  the working notes first and the person's words last, each with its own hint.

Amended after review (PR 153 round 2, 2026-11-12):

- **No to-do list.** "Open steps" is now "Not finished", sent as "What Polycarp had not finished, by its own guess;
  the person's words above decide what to do". Notes stored under "Open steps" are read as it.
- **"none" is an answer.** It empties the section; only a section whose heading is left out keeps the earlier
  content.
- **No person message vanishes.** Every one is quoted. When they don't fit, long ones are cut by code to one share,
  marked; when a share would be under a line, the first and newest stay whole and the rest keep their start, with a
  count of those shortened.
- **Every heading is attributed.** The summarizer's sections are `###` headings under the label, each ending in
  "(Polycarp's note)".
- **True notes.** The drop note says the dropped messages came after Polycarp's notes, and its room is reserved.
  Cuts fall on code points.

Amended (PR 162 round 1), replacing the "none" and "left out" rules above: "none" empties only Not finished. Past a
line each, the person's part keeps the first, newest and newest others' starts, and a gap line names the rest. The drop
note's room comes from the notes, never the latest message. Old goal sections are not sent.

## D47. The agent's pointer: Mote (Claude, 2026-11-12)

Problem: the veil (D37) says a tab is in use but not what the agent is doing in it. The owner asked for "a cool mouse guy
thing" that shows it.

Decision:

- **What**: Mote, a drop in the session's group color with its tip up and to the left (the brand's pointer direction) and
  two eyes that look along the tip. The tip is the exact point the agent's input lands on. Inline SVG (`MOTE` in
  `src/browser/veil-page.ts`), an ink outline and a white halo, so it reads on light and dark pages at 1x. Picked from four
  directions on a contact sheet (Mote, Kite, Helmsman, Gull): the others had an unclear tip, did not read as a pointer,
  or were too busy at 28 px.
- **Where**: inside the veil's closed shadow root, so it exists only on a tab in use (D37) and goes with the veil. It takes
  no pointer events, the capture cover hides it with the veil, and the readers already skip the veil's element, so
  read_page, find, get_page_html and screenshots never see it.
- **How it moves**: cdp.ts reports each pointer action (`cuePointer`: click, hover, drag, scroll, type, press; tools.ts
  adds fill and a scroll to a ref). veil.ts sends a `point` command in its own order per tab, after the veil changes
  already queued, without waiting for it, so input never waits on it. Nothing waits on a point: the capture cover and
  the next call's veilBegin do not queue behind one a busy page leaves unanswered, and of the cues that pile up behind
  it only the newest is sent. A press cues after its key is up, where focus moved to. It glides to the point (210 ms), then reacts: a squash and ring on click, a perk on hover, a
  tug and a slow follow on drag, a tap and caret on typing, a nudge on scroll; then idles with a slow sway and a blink.
  Typing has no point: the page finds the focused field through open shadow roots and same-origin frames; in a
  cross-origin frame it points at the frame's box, and with nothing focused it stays put.
- **Coordinates**: the points are main-frame CSS pixels, the same ones page.ts reads from `getBoundingClientRect` (frame
  offsets added) and the overlay is drawn in, so scroll and page zoom need no conversion.
- **Settings > Agents**: "Show the agent's pointer" (`veil_pointer`, on by default) sits under the veil's own switch. Off
  hides the character on open veils at once and keeps the veil. A veil drawn before a restarted worker has read the
  setting waits for that read, so it never shows the character the person turned off.
- **Motion**: off under prefers-reduced-motion or a Polycarp theme with motion off (it jumps and holds still); Highlight
  colors under forced colors.

Not done: a pointer for the side panel's own calls (its session has no veil), and for `actions` steps beyond the input
calls they make through cdp.ts.

Proof: `test/veil.test.mjs` (when it moves, the SVG and its CSS), and the e2e "the pointer character" in
`cli/test/e2e-bridge.test.mjs`: at the clicked element on a scrolled page and at 150% zoom, at the field the agent typed
into and at one inside a same-origin frame, absent on a same-site tab the user has, absent from the agent's screenshot
while a direct capture shows it, gone when the setting is off while the veil stays, and gone with the veil.
