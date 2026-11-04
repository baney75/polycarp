# Done Criteria status

Labels: `none` (no code), `prepared` (code written, Check not run), `verified` (a Check that
could fail passed; the record is linked), `deployed`, `published`. An item is only
`verified` when its own DC Check ran. A narrower test that passed is noted under
Evidence, and the item stays `prepared`. Decisions are in [../decisions.md](../decisions.md) (D1 to D19).

Updated 2026-10-25. #13 (skills, lint, CI), #14 (library) and #15 (private mode, bug
reports) are merged to main (published). Merged code is still `prepared` against its DC
item until that item's own Check runs. Review records are in each PR's Review block.

| ID | Item | Label | Evidence or gap |
| --- | --- | --- | --- |
| DC-1 | Install message replaced by one copy button (onboarding + settings + README) | prepared | #13; rendered and clicked headless ([dc-1.md](dc-1.md)). Label reads "Copy setup prompt for your agent" |
| DC-1 | Harness-agnostic prompt: detects harness and skills folder, installs CLI, MCP, skills, runs doctor | prepared | Detects Claude Code, Codex, OpenCode; Pi via pi-extension. OMP, Cursor, Grok skills folders not detected yet |
| DC-1 | No secrets, no piped installer, pinned version and checksum | prepared | Pinned tag yes, lint-tested; checksum missing (no signed release published yet) |
| DC-1 | Check: 4+ clean containers, doctor exits 0 | none | Docker daemon returns 500 on this Mac; D7 sets the scripted variant |
| DC-2 | CLI: search, skill {list,add,create,improve,review,submit}, cite, vault, tunnel, doctor, private-mode, report | prepared (partial) | Have doctor, skill {list,install,print,lint,apply,revert}, library {add,search,cite,export,obsidian}. Missing the rest |
| DC-2 | MCP parity, least privilege, scoped revocable per-client tokens | prepared (partial) | `tabkyra serve` + `tabkyra token` (D9). Narrow tests pass ([dc-2-dc-9.md](dc-2-dc-9.md)); CLI/MCP parity contract tests not written |
| DC-3 | One schema (SKILL.md + skill.toml per D1, tools/, tests/) | none | Lint currently allows SKILL.md + license only |
| DC-3 | Router: top-1 >= 90%, false-invoke <= 5% on 200 tasks | none | |
| DC-3 | Agent skill creation into skills/local as prepared | prepared | `skill write` and MCP `skill_manage` (lint on every write, saved only with `--yes`/`apply:true`), `skill test`, `skill remove` (D27); `cli/test/community.test.mjs`, dry run in [community-skills.md](community-skills.md) |
| DC-3 | Friction journal, improver, apply only if tests and eval hold, rollback | prepared (partial) | `skill revert` exists (tested); no journal, eval gate |
| DC-3 | `skill add <path|git-url|db-id>` with scan + tests | none | |
| DC-3 | Sandboxed skill tools with declared permissions | none | |
| DC-3 | Small-model eval >= 80% of frontier | none | |
| DC-4 | `/rsi` loop on demand and on schedule, written report | prepared | skills/rsi; no schedule, no report file |
| DC-4 | Adversarial review toggle, equal-or-stronger reviewer, failure blocks | prepared | Prose in skills/rsi; not enforced in code |
| DC-4 | Policy, CI, permission manifests, review gate read-only to agents | prepared (partial) | `skill apply` refuses rsi and kyraskillmaker (tested); no policy-file guard |
| DC-5 | Submission queue with per-submission confirmation | prepared | `skill submit`: preview, then `--confirm <code>` per submission; refused without `gh` and with personal data (D27). Tests and a dry run with no push ([community-skills.md](community-skills.md)); no real community pull request opened yet |
| DC-5 | CI gates 1-5 | prepared (partial) | Gate 2 (static scan) in CI with 105 red-team tests; gates 1, 3, 4, 5 missing |
| DC-5 | Auto-update with signature check, pinning, revoke list | prepared | Community catalog signed with the release key in CI, serial pinning against replay, `community/revoked.json` (D27). Verify and reject tested with a throwaway key; the release-environment signing job has not run yet |
| DC-5 | Check: >= 50 malicious blocked 100%, <= 5% false positives on >= 50 benign | none | Current corpus is synthetic single-line cases |
| DC-6 | Untrusted tagging, quarantined planner | none | MCP instructions only |
| DC-6 | Outbound actions need policy check + user confirmation | none | Prose rule in MCP instructions |
| DC-6 | >= 300-case red-team suite in CI | none | |
| DC-7 | Broker with opaque handles; values never in context | none | proton-pass skill uses `pass-cli run` references (prepared) |
| DC-7 | Encrypted cards, per-transaction confirmation | none | |
| DC-7 | E2E cookie and session sync | none | |
| DC-8 | Allowlist routing, block not warn | prepared | #15; unit tests pass; Check (forced call blocked and logged) not run end to end |
| DC-8 | Persistent indicator | none | |
| DC-9 | Tailscale and Cloudflare tunnels, token + TLS, default off | prepared | `tabkyra tunnel tailscale|cloudflare` (D9); args tested with stub binaries. The DC Check (a cloud agent through each real tunnel) is not run |
| DC-10 | Pause, notify, user solves, resume | prepared (partial) | `tabs_show` handoff exists; no notification |
| DC-10 | Opt-in solver per D2; CI flags bundled solvers | none | |
| DC-11 | Capture with metadata, snapshot, excerpt | prepared (partial) | #14: metadata + excerpt; no PDF or snapshot |
| DC-11 | Verification: DOI resolves, metadata match, retraction, quote found in source | prepared (partial) | DOI, retraction done (live-checked); quote-in-source missing |
| DC-11 | Exports, Zotero sync, Obsidian, Word | prepared (partial) | BibTeX, RIS, CSL-JSON, Obsidian notes; no Zotero sync or Word path |
| DC-11 | Check: 30 sources 100% metadata, fabricated rejected, Obsidian round-trip | none | Fabricated DOI rejection tested on a stand-in, not the 30-source set |
| DC-12 | academic, osint, news, rsi, autoresearch, dorks, proton-pass, artifacts, kyraskillmaker | prepared | #13; lint clean; no evals |
| DC-12 | ghost, blackboard, canvas, google classroom, other classroom, outlook, proton, office, 3d modeling, 3d printing, design, data, scripts, shopping, login, dashboard | none | |
| DC-12 | Forked skills with THIRD_PARTY.md | prepared (partial) | `visual-explainer` adapted from nicobailon/visual-explainer (MIT): notice in `skills/visual-explainer/LICENSE`, D17; no THIRD_PARTY.md |
| DC-12 | visual-explainer, mechanism-design; artifacts improved | prepared | Lint clean; tuned router cases pass; held-out gates pass, with visual-explainer held-out at 2/4 (misses listed in docs/skill-platform.md); small-model runs in the PR |
| DC-13 | Unchecked first-run box | prepared | #15; rendered headless |
| DC-13 | Autonomous filing via gh (D5), dedupe, scrubber, payload view | prepared (partial) | Redaction and payload view exist; filing is manual |
| DC-14 | STRIDE threat model, SBOM, signed reproducible CLI build | prepared (partial) | Releases are minisign-signed (existing); no SBOM, threat model or reproducible build |
| DC-14 | Daybreak identified | resolved | Owner confirmed, D4 (a decision, not a Check) |
| Extra | Session management on device and across devices | none | |
| Extra | Improved update system | prepared | Update now, checkout mode, Settings > Updates, What's new, skill refresh, mismatch banner (D19). Unit tests and a headless live check pass ([updates.md](updates.md)); the in-place reload in Helium is untested live; no release is published |
| New | Skills: maps, map data, Google world data, mathematics, chemistry, biology, genetics | none | |
| New | Skills: notes and documents (Obsidian, Notion, Google Docs, Slides, Sheets), Proton and Proton Drive | none | |
| New | Skill and system for adversarial review | prepared | skills/adversarial-review (lint clean, no eval); `rsi` step 7; D4 |
| New | Automatic skill invocation, strong compaction, small-model context budget | none | D12 |
| New | Local model provider set (localhost and tailnet) | none | D13 |
| New | `/fix`: rewrite a skill for the model tier that failed, verify, record, submit or keep | prepared | skills/fix (lint clean, no eval); D14 |
| New | Harness access to the skill and improvement system | prepared (partial) | CLI `skill apply/revert`; MCP skill tools not built |
| New | Design library, templates, `/reference` (legal referencing), `/branding` | none | |
| New | Shared successes and failures (opt-in) | none | D11 |
| New | Report button that has the agent write the report via `/bug` | prepared (partial) | skills/bug; no button yet; issues enabled 2026-10-25 |
| New | Agent-customizable appearance; modified builds lose auto-acceptance | none | D10 |
| New | Skill: PCB design and research | none | |
| New | Skill: email organization and label creation | none | Label changes act under the user's sign-in: ask first (D15) |
| New | Skills: writing, and writing in the user's voice from their own mail and documents | none | D15 |
| New | Hooks and linting system for harnesses | none | |
| New | Autoresearch kanban (add and check tasks) with a traces view | none | Pairs with the DC-12 dashboard skill |
