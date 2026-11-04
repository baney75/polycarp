# Contributing to Tabkyra

Thanks for helping. Bug reports, fixes, docs and skills are all welcome. This page covers
setup, the checks a pull request must pass, and how skill contributions are reviewed.
Coding agents follow the same rules, written for them in [AGENTS.md](AGENTS.md).

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Set up

You need Node 20+, git and a Chromium 141+ browser. Clone into a folder of its own,
because the build puts two sibling repositories beside the clone:

```bash
mkdir tabkyra-src && cd tabkyra-src
git clone https://github.com/baney75/tabkyra && cd tabkyra
./scripts/setup-siblings.sh               # clones pi-mono and mini-lit, pins and patches them, installs
(cd cli && npm install && npm run build && npm link)
tabkyra setup                             # builds the extension, registers the host, connects
```

`./dev.sh` starts the watchers. After a change in `src/`, rebuild and reload with
`npm run build && tabkyra reload`. Set `TABKYRA_NO_BUMP=1` to stop a build from bumping
the version in `static/manifest.chrome.json`.

Upstream code lives in the siblings. A change to pi-mono that Tabkyra needs goes in
`patches/pi-mono.patch`.

## Checks

CI runs these on every pull request. Run them before you push:

```bash
npx biome check .
npx tsc --noEmit
node --import tsx --test test/*.test.mjs
(cd cli && npx tsc --noEmit && npm test)
node cli/dist/index.js skill lint skills
(cd cli && node --test test/skill-lint.test.mjs)
```

`./check.sh` runs the first three (formatting with `--write`) plus the site check, and the
pre-commit hook runs it for you. Don't skip the hook with `--no-verify`.

For changes to the bridge, the native host or the MCP server, also run the end-to-end
test, which isn't in CI:

```bash
cd cli && npx playwright-core install chromium   # first time only
npm run test:e2e
```

If your change affects what someone sees (the side panel, setup output, `--help`), say in
the pull request how you checked it by hand, or that you didn't.

## Pull requests

- Branch from `main` and open the pull request against `main`. The template asks for what
  changed, how you checked it, and whether a protected path is touched.
- Keep one change per pull request. A refactor and a feature are two pull requests.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Stage files by explicit path (`git add path/to/file`), never `git add -A` or `git add .`.
- Plain, direct English in code, comments and docs. No emojis. The voice is in
  [media/brand/BRAND.md](media/brand/BRAND.md).
- Side panel sign-in is API keys only. A pull request that adds a subscription sign-in or
  borrows another app's identity won't be merged ([docs/auth-policy.md](docs/auth-policy.md)).

## Contributing a skill

A skill is text an agent follows with the user's sign-in, in every session that loads it.
A bad one is a prompt injection that never expires, so skills get the strictest review in
this repository.

1. **Write it to the standard.** Follow `skills/kyraskillmaker/SKILL.md`: frontmatter with
   `name` (the folder name), a one-line `description` with "Use when", then
   `## When to use`, numbered `## Steps` and `## Done when`. Keep it under 150 lines and
   1,500 tokens ([D12](docs/decisions.md)); split longer material into its own skill.
2. **One file.** The folder `skills/<name>/` holds `SKILL.md` and an optional license.
   Scripts, extra files and symbolic links are refused.
3. **Pass the lint.** `node cli/dist/index.js skill lint skills/<name>`. Fix the skill,
   never the lint. Every rule and its reason is in
   [docs/skill-security.md](docs/skill-security.md).
4. **Register it.** Add an import and a map entry in `cli/src/skills-catalog.ts`. A test
   fails when a folder under `skills/` isn't listed.
5. **Try it on a small model.** Give the skill and two realistic tasks to the cheapest model
   you have, and fix every place it went wrong. Say in the pull request which model you used.
6. **Write original text.** Don't paste another project's skill. A source under a license
   that isn't compatible with AGPL-3.0 can't be used at all.

### How CI and CODEOWNERS gate it

- The `skills` CI job lints every skill and runs the lint's red-team tests, without running
  any install scripts. On a pull request it also lints with the base branch's lint, so a
  pull request that weakens the lint still has to pass the old one.
- [.github/CODEOWNERS](.github/CODEOWNERS) asks for the maintainer's review on `skills/`,
  the lint and its tests, the skills catalog, `.github/`, the CLI's build and package files,
  the setup prompt and `docs/skill-security.md`.
- A pull request that changes the lint, its tests, CI or CODEOWNERS must say why in its
  description, and shouldn't do anything else.

### Personal skills are never submitted

A skill that contains your own data (emails, phone numbers, addresses, account or student
IDs, home paths, names you mark as private, or anything from your signed-in sites) is
personal ([D6](docs/decisions.md)). Keep it on your machine with `tabkyra skill apply`.
Don't open a pull request with it, in any form. If you're not sure, it's personal.

## Reporting bugs

Use the bug report form. The fastest way to fill it: turn on bug reports in the side
panel (Settings > Privacy) and use **Review report**, or ask your agent for `/bug`. Both
scrub personal data first. Check the text yourself before you submit it.

## License

By contributing, you agree that your contribution is licensed under
[AGPL-3.0](LICENSE), the license of this project.
