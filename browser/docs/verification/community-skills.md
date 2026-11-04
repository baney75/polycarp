# Community skills: the loop, end to end (D27)

Run 2026-10-28 by Claude on a Mac (Apple silicon), from branch `community-skills`, with
`node cli/eval/community-loop.mjs`. Everything ran in a throwaway Playwright Chromium with its
own HOME, profile and socket folder; no installed browser, no real Tabkyra config and no gh
sign-in were used. The submission checks ran on a read-only clone of baney75/tabkyra main.
Nothing was pushed and no pull request was opened.

| # | Step | Result |
| --- | --- | --- |
| 1 | `skill_manage` write without apply: lint, diff, nothing saved | PASS |
| 2 | write with `apply:true` (scripted stand-in for the user's yes) | PASS |
| 3 | `skill_manage` test: lint, community rules, 12 router cases | PASS: 9 of 10 route to the skill, 0 of 2 none cases route to a skill |
| 4 | On a local Notion-style page through the real MCP tools: Quick Find lists both "Weekly Sync" pages with paths | PASS: picked the one under Team Meetings |
| 5 | Breadcrumb ends with the page asked for | PASS |
| 6 | Page text read | PASS: three action items |
| 7 | Sidebar fallback: `find` the parent's arrow, unfold, open the child | PASS |
| 8 | `prepare_submit` in a profile without a signed-in gh | PASS: refused, "Fix: run gh auth login, then submit again." |
| 9 | `skill submit --dry-run`: preview, exit 3, nothing sent | PASS |
| 10 | `--dry-run --confirm <code>`: scratch commit of `community/skills/notion-navigation/SKILL.md` and `community/cases/notion-navigation.jsonl` | PASS: no push, no PR |
| 11 | A test catalog with the skill, signed with a throwaway key the profile trusts (`TABKYRA_UPDATE_PUBKEY`), synced through the extension's Settings action and the native host | PASS: catalog 100, `community, catalog 100; notion.so, notion.site` |
| 12 | `skill_match` picks it; `skill_read` starts with its provenance and scope | PASS |
| 13 | The same catalog, tampered after signing | PASS: refused ("Signature: does not match the file"); catalog 100 stays in use |
| 14 | Catalog 102 pulls the skill (`community/revoked.json`) | PASS: removed, with the reason; no longer matched |
| 15 | Settings opt-out | PASS: off, no community skills |

What writing the skill showed. The first draft passed the lint but failed the regression: its
description used "navigate", "open" and "page", so it took `tabkyra` and `notes` cases (GitHub
notifications, Amazon orders, capturing into Notion). The first two-index rule (community
skills only when nothing else fits) then routed 3 of 10 of its own cases, because the built-in
`notes` skill also covers Notion. The final rule and a Notion-specific description route 9 of
10 with every built-in skill at its baseline. Testing on the page also caught a wrong
parameter in the draft (`find` takes `query`, not `text`).

Not covered here: the release-environment signing job (`.github/workflows/community-catalog.yml`)
has not run, and a real community pull request has not been opened. The Settings > Skills
section was driven through its message, not clicked; how it looks is untested live.
