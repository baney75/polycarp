# Development Rules

This file is the source of truth for coding agents in this repository. `CLAUDE.md` points
here. Human contributors: see `CONTRIBUTING.md`, which follows the same rules.

## First Message
If the user did not give you a concrete task, read README.md first.

## Commands
- After code changes: run `./check.sh`. Fix all errors and warnings before committing.
- The user runs `./dev.sh` in a separate tmux session. Don't start `npm run dev`. Run `npm run build` only for bridge work, as "Bridge development" below says, or as `TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=<dir> npm run build` to build elsewhere without bumping the version in the checkout.
- NEVER commit unless the user asks.

## Testing
CI runs exactly these on every pull request (`.github/workflows/ci.yml`). Run the ones
your change touches before you say it works:

```bash
npx biome check .                       # format and lint (./check.sh runs it with --write)
npx tsc --noEmit                        # extension types
node --import tsx --test test/*.test.mjs  # extension tests
(cd cli && npx tsc --noEmit && npm test)  # CLI build and tests (npm test rebuilds cli/dist first)
node cli/dist/index.js skill lint skills  # the skill gate
(cd cli && node --test test/skill-lint.test.mjs)  # red-team tests for the lint
```

`(cd cli && npm run test:e2e)` drives the extension, native host and MCP server in a
throwaway headless Chromium. It is not in CI; run it after bridge or MCP changes (first
time: `cd cli && npx playwright-core install chromium`).

A test that passed proves the logic, not what the user sees. Say which one you ran.

## Code Quality
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- NEVER use inline imports (no `await import(...)`, no `import("pkg").Type`)
- Always ask before removing functionality or code that appears intentional

## Dependencies
- `@mariozechner/mini-lit`, `@mariozechner/pi-ai`, `@mariozechner/pi-web-ui`, `@mariozechner/pi-agent-core` are linked via `file:` to sibling repos `../mini-lit` and `../pi-mono`
- Changes to those packages require rebuilding them (the dev watcher handles this)
- If you need to modify upstream code, edit it in `../pi-mono` or `../mini-lit` directly and rebuild
- Changes to pi-mono that Tabkyra depends on go in `patches/pi-mono.patch`, which `scripts/setup-siblings.sh` applies at the pinned commit

## Skills
Bundled skills in `skills/` run with the user's sign-in in every agent that loads them.
Treat a skill change like a security change.

- Write skills to the `kyraskillmaker` standard (`skills/kyraskillmaker/SKILL.md`):
  frontmatter with `name` (same as the folder), a one-line `description` that includes
  "Use when", then `## When to use`, numbered `## Steps` and `## Done when`.
- A skill folder holds `SKILL.md` and an optional license, nothing else. No scripts, no
  extra files, no symbolic links.
- Keep each skill to 150 lines and 8,000 characters (docs/decisions.md, D12; enforced by
  `tabkyra skill lint`). Split longer material into its own skill.
- Every skill must pass `node cli/dist/index.js skill lint skills`. Fix the skill, never
  the lint, to make it pass. The rules are in `docs/skill-security.md`.
- Register a new skill in `cli/src/skills-catalog.ts` (import and map entry). A test fails
  when a folder under `skills/` is missing there.
- Skills describe attacks; they never quote them, not even in a code fence.
- Personal skills (anything with the user's own data) are never committed, pushed or
  submitted (D6).
- Community skills live in `community/skills/` with cases in `community/cases/`; they follow
  `CONTRIBUTING-skills.md` and pass `node cli/dist/index.js skill lint --community community/skills`.
  A community pull request changes nothing outside `community/`. Agents prepare a submission
  (`tabkyra skill submit` without `--confirm`) and never send one without the user's yes (D27).

## Changelog
Location: `CHANGELOG.md`

### Format
Use these sections under `## [Unreleased]`:
- `### Breaking Changes`
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

### Rules
- New entries ALWAYS go under `## [Unreleased]`
- Add to the existing subsection, never a duplicate one. Put the entry users most need to see
  first: the "What's new" card shows the first two entries of each section.
- NEVER modify already-released version sections
- Start each entry with one short sentence (under 110 characters) that says what changed for the
  person using Tabkyra, in their words: "Settings tabs no longer leave one tab alone on a line."
  Details, file names, decisions (D12) and tests come after it. The side panel's "What's new" card
  shows only that first sentence (`digestReleaseNotes` in `src/update/logic.ts`), and a longer one is
  cut at its first colon, semicolon or parenthesis.

## Decisions and verification
- `docs/decisions.md` records design defaults and the owner's answers (D1, D2, ...). Add
  an entry when you choose a default that changes the outcome; never rewrite an old one.
- `docs/verification/STATUS.md` tracks each Done Criteria item as `none`, `prepared`,
  `verified`, `deployed` or `published`. An item is `verified` only when its own Check ran
  and could have failed; record the run in `docs/verification/`. A narrower test that
  passed is evidence, and the item stays `prepared`.

## Releasing
When the user asks to do a release:
1. Ask: major, minor, or patch?
2. Ensure `CHANGELOG.md` has entries under `## [Unreleased]`
3. Run `./release.sh <major|minor|patch>`

The script bumps the version in `static/manifest.chrome.json`, finalizes the changelog, commits, tags, and pushes. GitHub Actions builds and publishes the release. Releases are signed with minisign; the one-time key setup is in `docs/updates.md`.

## Updating the Website
When the user asks to update the website, build it with `cd site && ./run.sh build`. No
deploy target is configured; `./run.sh deploy` refuses until one is chosen.

The site is static HTML (no backend). Source is in `site/src/frontend/`.

## Brand
Brand assets are generated by `media/brand/build.mjs` (rules in `media/brand/BRAND.md`).
Edit the script, run `node media/brand/build.mjs`, and look at the PNGs it writes. Never
edit the outputs by hand.

## Style
- No emojis in commits, code, or comments
- No fluff or cheerful filler text
- Technical prose only, direct and concise

## Git Rules
- NEVER use `git add -A` or `git add .`
- ALWAYS use `git add <specific-file-paths>`
- NEVER use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`
- NEVER use `git commit --no-verify`
- Include `fixes #<number>` or `closes #<number>` in commit messages when applicable

## Review and merge
- Every change goes through a pull request against `main`. CI must pass both jobs
  (`skills` and `check`).
- `.github/CODEOWNERS` requires the maintainer's review for `skills/`, the skill lint and
  its tests, the skills catalog, `.github/` (CI and CODEOWNERS), the CLI's build and
  package files, the setup prompt and `docs/skill-security.md`.
- Never weaken the lint, its red-team tests, CI or CODEOWNERS in a change that also does
  something else, and never without the maintainer's review. CI also lints with the base
  branch's lint, so a weakened lint fails anyway.
- Stacked pull requests merge in order (D8).
- Agents don't merge unless the maintainer asked for it in the task.

## Sign-in policy
API keys, plus subscription sign-ins only on a route the provider documents for third-party
apps, with Tabkyra's own registration: Sign in with ChatGPT (open-source path) and GitHub
Copilot through the Copilot SDK (D28). Tokens stay in the native host, never in browser
storage. Never add a sign-in that sends another app's OAuth client id, originator, user agent
or headers, never spawn a provider's CLI to borrow its sign-in, and never add a Claude or
Google subscription sign-in (their terms forbid it). `test/auth-policy.test.mjs` fails if the
removed flows come back. Rules and sources: `docs/auth-policy.md`.

## Project Structure
```
src/
  sidepanel.ts          # Main entry point, agent setup, settings, rendering
  background.ts         # Service worker (sidepanel toggle, session locks, bridge, foreground guard)
  agent-setup-prompt.ts # The "Copy setup prompt for your agent" text
  browser/              # Tab sessions (tab group per agent), CDP screenshots/input, page primitives
  bridge/               # Native-messaging bridge for external harnesses, site permissions
  models/               # Runtime model discovery per provider
  auth/                 # Sign-in policy (docs/auth-policy.md)
  subscriptions/        # Sign in with ChatGPT and Copilot: settings, relay, streaming (tokens stay in cli/src/subscriptions)
  privacy/              # Private mode and opt-in, scrubbed bug reports
  dialogs/              # Settings tabs, API key dialogs, welcome setup
  tools/                # Agent tools (navigate, REPL, extract-image, skills, debugger)
  messages/             # Custom message types (navigation, welcome)
  storage/              # IndexedDB storage (sessions, skills, costs)
  prompts/              # System prompt and token counting
  components/           # UI components (Toast, TabPill, HelmMark, helm-svg, AgentSetupPrompt)
  composer/             # The chat input's "/" skill menu and "@" tab menu, and how references reach the model
  transcript/           # The transcript as a log: grouping (group.ts) and drawing (render.ts) through pi-web-ui's hook
  artifacts/            # Artifact previews (pptx, spreadsheets, CSV, media, notebooks, ODF, RTF); viewers.ts plugs them into pi-web-ui
test/                   # Extension tests (node --test): auth policy, privacy, setup prompt, custom elements
skills/                 # Bundled agent skills, one SKILL.md per folder, compiled into the CLI
cli/
  src/
    index.ts            # `tabkyra` command dispatch and --help
    mcp.ts              # MCP server: browser and library tools, safety instructions
    host.ts, client.ts  # Native host and the Unix-socket client
    setup.ts, doctor.ts, install.ts, harness.ts  # Setup, checks, host registration, harness configs
    skill.ts            # skill install, list, print, apply, revert
    skill-lint.ts       # The skill lint (docs/skill-security.md)
    skills-catalog.ts   # Every bundled skill, imported at build time
    library.ts          # Source library: DOI and arXiv, retraction checks, cite, export
    remote.ts           # `tabkyra serve` (MCP over HTTP, loopback) and scoped tokens
    tunnel.ts           # Tailscale and Cloudflare tunnels for serve
    update.ts, minisign.ts  # Signed release updates
  test/                 # CLI tests, including the lint red team and the e2e bridge test
docs/
  decisions.md          # Design decisions and the owner's answers
  verification/         # Done Criteria status and check records
media/brand/            # Mark, palette and build.mjs, which generates every brand asset
site/
  src/frontend/         # Static landing page and install instructions
static/
  manifest.chrome.json  # Extension manifest (version lives here)
.github/                # CI, release workflow, CODEOWNERS, issue and PR templates
```

## Bridge development
- After changing `src/`, rebuild and reload with `npm run build && tabkyra reload` (always `&&`: a reload after a failed build unloads the extension until it is reloaded from the extensions page).
- `tabkyra debug` prints the extension's bridge state, request timings, and a Chrome API benchmark.
- The CLI is a separate package: `cd cli && npm run check`.
