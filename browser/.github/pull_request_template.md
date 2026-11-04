## What changed

<!-- One or two sentences. Link the issue: "closes #123". -->

## How I checked it

<!-- The commands you ran and what they printed. For anything a user sees (side panel, setup output, --help), say how you checked it by hand, or say you didn't. -->

- [ ] `npx biome check .`
- [ ] `npx tsc --noEmit`
- [ ] `node --import tsx --test test/*.test.mjs`
- [ ] `(cd cli && npx tsc --noEmit && npm test)`
- [ ] `node cli/dist/index.js skill lint skills`
- [ ] `(cd cli && node --test test/skill-lint.test.mjs)`
- [ ] `(cd cli && npm run test:e2e)` (bridge, host or MCP changes)

## Checklist

- [ ] A line under `## [Unreleased]` in CHANGELOG.md
- [ ] Files staged by explicit path; no `--no-verify`
- [ ] No personal data, secrets or signed-in page text anywhere in the diff

## Protected paths

<!-- CODEOWNERS asks for the maintainer's review on these. Tick any this touches and say why. -->

- [ ] `skills/` (new or changed skill: registered in `cli/src/skills-catalog.ts`, tested on a small model, not a personal skill)
- [ ] The skill lint, its red-team tests or the skills catalog
- [ ] `.github/` (CI, release workflow, CODEOWNERS, templates)
- [ ] The setup prompt, the CLI's build or package files, or `docs/skill-security.md`
- [ ] Sign-in or provider code (API keys only: docs/auth-policy.md)
