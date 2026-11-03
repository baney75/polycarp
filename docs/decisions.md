# Decisions

Conventional defaults chosen while implementing the Done Criteria (DC-1 to DC-14), and the
owner's answers to the questions that changed the outcome. Newest last. Each entry names
the criterion it serves.

## D1. Tabkyra skill metadata lives in `skill.toml`, not in SKILL.md frontmatter (DC-3)

DC-3 lists name, description, triggers, required tools, permissions, version and
provenance as frontmatter. Harnesses read SKILL.md frontmatter, and some act on keys they
recognize (Claude Code's `allowed-tools` pre-approves tools), so extra keys there are an
escalation route. SKILL.md keeps `name`, `description` and `license`, which every harness
reads the same way. The Tabkyra fields go in `skill.toml` in the same folder, which only
Tabkyra reads and the lint validates. The installer copies only SKILL.md into harness
folders. Same information, no new attack surface in the harness.

## D2. CAPTCHA handling (DC-10, DC-12)

Owner, 2026-10-25: allow solving for search, removing your own data from brokers (ghost),
and OSINT on companies and domains, "with the exception of exploitation like scalping".
Implementation default:

- Off by default. Turned on once at setup, behind a plain warning that solving breaks
  most sites' terms and can get an account or IP flagged. The setting then syncs to the
  user's other devices.
- Tabkyra ships no solver. When the setting is on, the agent may use a solver extension
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

Every skill has a category in `skill.toml`: `personal` or `shared`. `tabkyra` classifies
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
detection, skills folder, MCP config and `tabkyra doctor`. The model-in-the-loop
transcripts are recorded as blocked until the owner signs in a harness for the run.

## D8. Stacked pull requests

#13 (skills, lint, CI), #14 (library) and #15 (private mode, bug reports) are reviewed
and merged in order. Owner, 2026-10-25, answering whether to run a second review series
on #13 and then review and merge #14 and #15: "Yes, review and merge".

## D9. Remote MCP and tunnels (DC-2, DC-9)

`tabkyra serve` speaks MCP over Streamable HTTP and binds to loopback only; it refuses any
other address. Every request needs a bearer token from `tabkyra token create`. Tokens are
per client, stored as SHA-256 hashes, revocable at once, and limited to named scopes
(`browser.read`, `browser.navigate`, `browser.act`, `browser.script`, `library.read`,
`library.write`). There is no wildcard. A session sees only its scopes' tools, and another
token can't reuse it. The stdio server that a local harness runs keeps full access: it
runs as the user, so a token there would protect nothing. TLS comes from the tunnel:
`tabkyra tunnel tailscale` (tailnet only; `--public` uses Funnel and warns) or
`tabkyra tunnel cloudflare` (a quick tunnel under the user's own `cloudflared`).

## D10. Appearance customization and the contribution network (owner, 2026-10-25)

Users and their agents customize Tabkyra's look through a theme file: design tokens and
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
skills apply their edits with `tabkyra skill apply`, which runs the same lint, so an improvement can't bloat a skill past it (`fix` also aims for under 150 lines).

## D13. Local model providers (owner, 2026-10-25)

A "Local models" provider set in the side panel. It finds OpenAI-compatible servers
(Ollama :11434, LM Studio :1234, llama.cpp and vLLM :8080 and :8000) on this machine and on
the user's tailnet peers. The native host asks `tailscale status --json` for the peers and
probes each port with a short timeout. A model on a tailnet peer counts as local for
private mode only once the user lists it as their own (#15's rule in `src/privacy/private-mode.ts`: only loopback is trusted automatically).

## D14. Fix submissions and tier variants (owner, 2026-10-25)

`submit` in `~/.config/tabkyra/rsi.json` takes `"ask"` (default), `"auto"` or `"never"`.
The owner asked that users be able to submit fixes automatically, which overrides DC-5's
confirm-each-submission default for users who choose `"auto"`. Auto submission still only
opens a pull request: CI, adversarial review and a maintainer decide what enters the
library (D10). A skill classified personal (D6) is never submitted under any setting.
When a fix for a small model would weaken a skill that works for large ones, `/fix`
writes a `<name>-lite` skill instead of editing the original. The router (DC-3) picks the
variant by model tier.

## D15. Voice and mail skills (owner, 2026-10-25)

The writing-voice skill learns the user's style only from the user's own mail and
documents, read in place through their signed-in Tabkyra tabs or their Drive. It keeps
just a style profile (sentence length, word choice, openings, sign-offs, a few short
example lines), not the messages. The profile is a personal skill (D6): it stays on the
user's devices and is never submitted, synced to shared storage or put in a bug report.
Email organization reads freely, but creating labels, moving mail or changing filters acts
under the user's sign-in. It shows the plan and waits for the user's yes, per the safety
rules.

## D16. SDKs and vendor terms (owner, 2026-10-25: "we don't want to break ToS")

No user should risk a ban for using Tabkyra.

- **Harnesses the user runs** (Claude Code, Codex, pi, OMP, OpenCode, Cursor) connect to
  Tabkyra as an MCP server, a pi extension or skills. The user's own harness, signed in
  however its vendor allows, calls Tabkyra. Nothing is borrowed or impersonated, so this
  is the primary integration.
- **pi** (`@mariozechner/pi-ai`, `pi-agent-core`, `pi-web-ui`, MIT) already powers the side
  panel with API keys. OMP is integrated through MCP config.
- **Vendor agent SDKs** (Claude Agent SDK, Codex SDK) are used only with an API key the
  user supplies and pays for, never with a subscription sign-in inside Tabkyra. Products
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
  with Nico Bailon's copyright is at the end of that `SKILL.md`, because `tabkyra skill
  install` copies only `SKILL.md`, and also in `skills/visual-explainer/LICENSE`. The skill
  is MIT; the rest of Tabkyra stays AGPL-3.0.
- **Inline SVG, not Mermaid.** Upstream loads Mermaid, Chart.js and three.js from a CDN.
  The `artifacts` rules forbid outside scripts, and inlining Mermaid would add megabytes of
  layout code to every page for diagrams a model can draw by hand. Upstream itself makes
  hand-drawn SVG the default and Mermaid opt-in. A user's Mermaid source is redrawn as SVG
  and kept as text in the page.
- **Upstream's checks are replaced by Tabkyra's**: serve the page's own folder,
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
- **Viewers live in Tabkyra, not the pi-mono patch.** pi-web-ui gains one hook,
  `setArtifactViewerFactory` (through `patches/pi-mono.patch`), which the artifacts panel
  asks before its built-in viewers; `src/artifacts/viewers.ts` answers it. The fork patch
  stays small, and the viewers are ordinary Tabkyra source with Tabkyra's tests and review.
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

- **The mode comes from where the native host runs**: `~/.local/share/tabkyra/app` is a
  release, a Tabkyra git checkout is a checkout, anything else updates only from a terminal.
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
- **Skill refresh only rewrites what Tabkyra wrote.** A hash record of installed files decides;
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
  tool names are Tabkyra's MCP tools and the panel agent uses its own (navigate, repl).
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
- **Group titles** are `Tabkyra · <agent> · <project or session name>`, plus an optional label
  the agent sets (session_info), sanitized as plain text, at most 32 characters, never
  starting with "Tabkyra".
- **Gestures apply to agent sessions only.** Side panel chats keep their rules: their tabs are
  the user's already. A tab counts as moved out only once it was seen inside the group, so a
  tab still being grouped is never handed over by mistake. A closed window is not a gesture.
- **An agent never lands on a page it didn't choose**: when the user takes or closes its
  current tab, it has no current tab until it picks one or navigates.
- **15 tabs per session**, refused with `tab_limit` and what to do. Popups the foreground
  guard adopts are not refused (they come from the page, not the agent).
- **`tabkyra sessions` acts as the user**, like the side panel: any local process that can
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
  planted instruction, two-store price comparison) through Tabkyra's MCP tools in a headless
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
  agentic harnesses"). Tabkyra sends its own identity and never borrows another app's (D16);
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
contrinute to the larger tabkyra community, ex if an llm finds a better way to navigate a site
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
- **Submission is the user's.** `tabkyra skill submit` always shows a preview and exits 3; it
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
  is over a day old, and `tabkyra mcp` on start and every 6 hours on the same rule. A failed or
  refused fetch keeps the catalog in use and doesn't count as a check. `tabkyra skill sync`
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
  copies Tabkyra installed into harnesses are deleted, and a local copy based on it is turned
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
  Copilot SDK with Tabkyra's own OAuth App (`Ov23li1qDiu9lRXbvcFh`, device flow, no secret).
- **No sign-in for Anthropic or Google.** Their terms forbid it, including driving their CLIs.
  Settings shows how to run Claude Code or Gemini CLI with Tabkyra's MCP server instead.
- **No OpenAI interest form.** OpenAI's docs send open-source, locally hosted apps to the docs and
  paid or hosted apps to the form; Tabkyra is AGPL-3.0 and local. The form itself says "If you're
  an open source developer, explore our developer docs", and it asks for a commercial partner.
  If Tabkyra ever ships a paid or hosted build, that build needs the form first.
- **OAuth App, not a GitHub App.** GitHub's Copilot SDK setup page says both work and names the
  OAuth App in its steps; the owner approved an OAuth App. Expiring tokens are on, and the device
  flow refreshes them without a secret.
- **Tokens only in the native host**, in 0600 files, never in browser storage, as OpenAI's docs
  require. The side panel reaches the providers through the host's loopback proxy with a
  per-process secret.
- **The Copilot SDK is installed by the user** (`tabkyra copilot-sdk install`, pinned 1.0.28,
  about 160 MB), not bundled: most users don't need it.
- **The API-keys-only rule of AGENTS.md is replaced** by "API keys, plus sign-ins on a provider's
  documented third-party route with Tabkyra's own registration".

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
  static bearer header (ChatGPT supports only no auth or OAuth). So `tabkyra serve
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
  fill a global cap for up to 15 minutes; `tabkyra token passcode` clears every limit. The
  passcode carries about 100 bits, so the caps don't guard against guessing.
- The passcode field is a masked text field with `autocomplete="one-time-code"`, so a password
  manager in the browser Tabkyra drives won't fill it for an agent tab. Blocking agent tabs
  from the approval page in the extension is a follow-up.
- Tailscale Funnel can't be the public route on Donovan's tailnet: Tailnet Lock rejects Funnel
  ingress (field note `lab-a/tailscale-funnel-never-reachable-on-a-tailnet-lock-tailnet`).
  The free route is a Cloudflare named tunnel (every account includes 1,000 at no cost) on an
  always-on host, reaching the browser's computer over the tailnet. A quick tunnel won't do:
  its URL changes and it doesn't carry SSE.

## D31. Each install is its own single-owner server; no central relay (Claude, 2026-11-01)

Many users will connect claude.ai, ChatGPT and grok.com to their own Tabkyra. `tabkyra remote
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
- `remote.json` in the config dir (0600) holds the route; `tabkyra serve` reads it when
  `--public-url` is absent, and flags win. A user service (launchd or systemd, user level) keeps
  serve running.

## D32. Many devices behind one hub, still single-owner (Claude, 2026-11-02)

Owner, 2026-11-02: one public URL (for example `https://tabkyra.dbaney.com/mcp`) that claude.ai,
ChatGPT and grok.com add once, with any number of his own computers behind it.

- `tabkyra hub setup` turns an always-on box into the hub. It needs no browser. It serves the D30
  OAuth server and consent page (shared code, `oauth-http.ts`) and `/mcp`, and proxies each MCP
  session to one of the owner's devices. A device runs `tabkyra link`, which dials out to the hub
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
  id and runs nothing. The background worker (`src/connect/relay.ts`) only takes Tabkyra's own
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
  20 seconds, 30 for `joinHub`, with `no_reply` and "Update it: tabkyra update".
- The setup prompt for an agent runs `remote setup` and `hub setup` with `--no-passcode`, which
  mint and print no passcode, so no long-lived secret lands in an agent's output or transcript.
  The one-time connect code approves the connection (D32), and the owner can set a passcode later
  with `tabkyra token passcode` in their own terminal.
- `joinHub` runs the same enrollment as `tabkyra link <hub> --code`, including the service.
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
  so the three match. That changes the default look from mini-lit's neutral palette to the Tabkyra
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
  (`tabkyra token approval-code`), outside the browser an agent drives. The passcode is not even
  checked for such a client, so the refusal tells an attacker nothing about it. A wrong code counts
  toward the same lockout. Clients with a grant before this change count as approved, so existing
  connectors keep working. Rejected: a separate `tabkyra token clients approve <id>` pending flow;
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
  Confirm, "run tabkyra update". Nothing is sent until Confirm, and what was confirmed is what is
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
  tabkyra link status". A manager's `/link/code` refusal maps the same way (401 revoked, 403 not a
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
