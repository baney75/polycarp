# Contributing a skill

Found a better way to get around a site? Turn it into a community skill. Every Tabkyra user
gets it once a maintainer merges it. This page is for you and for your agent. The design is
decision D27 in [docs/decisions.md](docs/decisions.md).

## What a community skill is

A `SKILL.md` for one or a few sites, written to the `kyraskillmaker` standard
(`tabkyra skill print kyraskillmaker`), in `community/skills/<name>/`. Its router cases go in
`community/cases/<name>.jsonl`. It differs from a built-in skill in four ways:

- **Scoped.** A `## Sites` section lists its sites, one hostname per bullet (`- notion.so`).
  Every link in it must point at one of them. Agents are told to use it only there.
- **Reads and navigates only.** No `run_js`, no page scripts, no step that asks for a password,
  code, key or cookie, and no step that sends page content anywhere.
- **No personal data.** No names, emails, phone numbers, home paths, account or page links
  from your sessions, cookies, or text copied from a page. Write what you learned in your own
  words.
- **Second in line.** A community skill is picked when no built-in or local skill fits, or
  when the task names one of its sites and it outranks the built-in. Nothing else about
  routing changes.

## The flow

Your agent does steps 1 to 4. Step 5 needs your yes.

1. **Write it.** `tabkyra skill write <name> --file SKILL.md` lints it and shows the diff;
   `--yes` saves it as a local skill. (MCP: `skill_manage` with action `write`, then `apply:true` after you approve.)
2. **Write the cases.** At least 8 tasks in your words that should pick it, plus near misses
   that should pick none, one JSON object per line:
   `{"task": "open my Weekly Sync page in Notion", "skill": "notion-navigation"}`.
3. **Test it.** `tabkyra skill test <name> --cases cases.jsonl` runs the lint, the community
   rules and the router. In a Tabkyra checkout it runs the full regression CI runs. Then use
   the skill on the real site and fix what goes wrong.
4. **Preview the submission.** `tabkyra skill submit <name> --cases cases.jsonl`. It clones the
   repository, runs the checks CI runs with your skill added, and prints the exact files and
   the pull request it would open. Nothing is sent. (MCP: `skill_manage` with action `prepare_submit`.)
5. **Submit.** If you approve the preview, run the command it prints, with its
   `--confirm <code>`. The code covers that exact skill and those cases; any change needs a new
   preview. Tabkyra forks `baney75/tabkyra` to your GitHub account with `gh`, pushes a branch
   and opens the pull request. `--dry-run` does everything except the push.

Submission needs `gh` signed in (`gh auth login`). It refuses personal data outright and
never edits your skill to remove it. An agent may draft and preview; only your yes submits.

## Review

CI runs on every community pull request:

- the skill lint (hidden text, prompt injection, remote code, secret handling, structure);
- the community rules (scope, page scripts, credential requests, exfiltration, personal data);
- the regression eval with your skill routed as on a client: every built-in skill must still
  route its cases at its baseline, no `none` case may pick your skill, and your skill must
  route 75% or more of its own cases;
- the judge: the base branch's eval, run on your files as data;
- a check that the pull request changes nothing outside `community/`.

A maintainer reads the skill and merges it by hand. Nothing merges on its own.

## Updates, local edits and removal

- Merged skills reach users in a signed catalog, checked about once a day. It is signed with
  the release key in CI; clients refuse an unsigned, tampered or older catalog.
- Settings > Skills in the side panel, or `tabkyra skill sync --off`, turns community skills off.
- If you edit a community skill, your copy is kept and used while that community skill is in
  use. A newer community version never overwrites it; `tabkyra skill list` says so, and
  `tabkyra skill revert <name>` goes back. If the skill is pulled or you turn community skills
  off, your copy is turned off too; the file stays.
- `tabkyra skill remove <name>` turns a community skill off on your device;
  `tabkyra skill enable <name>` turns it back on.
- To pull a merged skill, a maintainer deletes its folder and adds it with a reason to
  `community/revoked.json`. Clients drop it at the next sync, delete the copies Tabkyra
  installed, and turn off local copies of it.
