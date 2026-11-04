# Skill platform

How an agent finds the right skill, how CI keeps that working, and how a user edits,
versions and rolls back a skill. Security rules for skill text are in
[skill-security.md](skill-security.md); the context budget is decision D12 in
[decisions.md](decisions.md).

## Router

`cli/src/skill-router.ts` picks the skill for a task. It is offline, has no dependencies and
needs no model, so it runs in the MCP server on every call and in CI.

Each skill is indexed from three parts of its SKILL.md:

| Field | Source | Weight |
| --- | --- | --- |
| name | the folder name, split on `-`; a run-together name like `kyraskillmaker` also counts the words of its own description it contains | 1.5 |
| what | the description up to "Use when" | 1 |
| when | the description from "Use when", plus the bullets under `## When to use` | 1.5 |

Matching is BM25F over lowercased, lightly stemmed words with stopwords removed, plus
three order signals:

- a slash command that names a skill: +6. It counts only as the task's first token, and not
  when followed by `/` or `.`, so paths like `ls /fix` or `cat /bug/report.txt` don't. Other
  path-like words (starting with `/`, `./`, `../` or `~/`) are dropped as data;
- a skill the task asks for by name ("use the osint skill on this landlord", "run the
  dorks skill"): +6, the same as its command;
- a quoted trigger phrase of two or more words from the description ("learn from this"):
  +2.5. It counts as evidence only if it holds a word specific enough to be evidence by
  itself, so a phrase of common words ("what's going on with") can rank a skill but can't
  make a match alone ("What's going on with my Docker build?" is none). A one-word quote is
  just a word, scored as one;
- a pair of neighbouring words shared with the skill ("literature review",
  "search operators"): +2 each. In a list such as "write, draft or port a skill", each item
  pairs with the list's last word.

Sentences that send the reader elsewhere ("Not for ...", "For news, use `news-research`")
are left out, quoted phrases in them included, and backticked mentions of other skills are
dropped, so they don't pull in the tasks they exclude. "Use `x` ..." counts as a redirect
only when `x` is a skill; "Use `pass-cli run` when ..." is a trigger and stays.

How a task names a skill ("<name> skill") decides what the name does:

- **Changed:** an edit verb (fix, repair, edit, update, rewrite, improve, review, change,
  correct, port...) governs the mention, as in "fix the osint skill", "rewrite my old dorks
  skill", "edit to the osint skill" or "the osint skill failed, repair it", or a slash
  command is the first token (`/fix news-research`). The name doesn't score for itself, and
  the task counts as evidence for the skills whose job is skills. An edit-like word elsewhere
  ("the latest updates", "review what you find") doesn't count.
- **Ruled out:** a negation governs it, within a few words before it: "don't/do not/never
  use (or run, apply, follow) the osint skill", "without", "instead of", "rather than",
  "skip", "avoid", or "not the osint skill". That skill is never returned for the task. A
  "no" or "not" elsewhere ("no rush, use the osint skill", "why not use the osint skill",
  "I have no idea who runs this, so use the osint skill") rules nothing out.
- **The CLI:** `tabkyra skill install` (or another subcommand) is the Tabkyra CLI, read as
  "tabkyra cli", not a request for the tabkyra skill.
- **A subject, not a skill:** nothing points the mention at a skill: no "the", "this" or
  "that" before a singular mention, no use, edit or negation verb, no slash command and no
  backticks. "My biology skill", "what chemistry skills do employers want" and "improve my
  writing skill" (improve or refine with no determiner is about a person) score for no skill.
  "A Tabkyra skill" (a kind of skill to make) keeps its words but asks for no skill. A plural
  with one name ("the chemistry skills employers want") is a subject too.
- **Lists:** several names before one "skills" ("use the osint and dorks skills", "the maps,
  osint or dorks skills", spaced or hyphenated) are read together, and the verb before the
  list applies to every name: "don't use the osint and dorks skills" rules out both.
- **Requested:** otherwise ("use the osint skill on this landlord"), +6 for that skill.

The name `none` is reserved for "no skill fits": lint, `skill apply`, `skill edit` and the
catalog script refuse a skill by that name, so a real match can't look like no match.

A skill matches when it scores at least 2.5 and has two pieces of evidence (specific words,
word pairs, a phrase or a command), or one piece and a score of 4.5 (4.8 past 13 skills, rising past 32 skills as below).
Otherwise the answer is `none`: a small model does better with no skill than with the wrong
one. A word or word pair counts as evidence when its IDF, computed as if the catalog had
min(catalog size, 13) skills, is at least 1.5: so it is evidence when held by at most two
skills in a catalog of 11 or more, by only one in a catalog of 6 to 10, and by none in a
catalog of 5 or fewer. (Past 13 skills the IDF used for scoring is scaled and can be higher;
it doesn't decide evidence.) So common words alone never make a match, however high they add up.

Plain IDF rises as skills are added: in a larger catalog a word unique to one skill weighs
more, and a word in three skills would turn into evidence. Past 13 skills, the catalog the
thresholds were calibrated on, IDF is scaled so a word unique to one skill weighs what it
did at 13, a word or word pair is evidence only if at most two skills hold it, and one piece
of evidence needs a score of 4.8, because mid-frequency words still score a little higher than
they did at 13. Past 32 skills (the catalog 4.8 was measured on) a word held by two skills,
which is still evidence, keeps gaining weight, so the bar grows in proportion: one such word
clears it no more easily at 52 skills than at 32. Without that, adding 19 skills made one ordinary word in an old skill enough
for a match ("a good name for a puppy" went to `fix`, "a bug in my login handler" to `bug`).
A catalog of 13 skills or fewer scores as before; on `main`'s 13 skills the only change across
the 608 case texts is that "a Tabkyra skill" no longer asks for the tabkyra skill.

The router indexes the skills in use: the bundled skills and the user's applied local
copies (`tabkyra skill apply`). The index is built once per process and rebuilt only when
`~/.config/tabkyra/skills-local` changes: each file's inode, change time, modification time
and size, plus a hash of `index.json`, so two same-size edits within one timestamp tick
still rebuild it.

### Using it

- `tabkyra skill match "<task>" [--json] [--top N]` prints the best skills with their scores
  and one-line descriptions, or `none`.
- MCP `skill_match {"task": "..."}` returns the same in a few lines, ending with the
  `skill_read` call to make. `skill_read {"name": "..."}` returns one SKILL.md: the user's
  applied edit if there is one, otherwise the bundled text. The server instructions give one
  order: first `skill_match` with the user's task (it needs no browser), then `skill_read`
  only for the chosen skill, so only one skill enters the context; `status` comes before any
  browser tool, and a missing browser stops browser work only.
- Remote sessions (`tabkyra serve`) see both tools only with the `skills.read` token scope.
  They match and read the bundled skills only, never the user's local skills or edits: a
  remote session can be a cloud agent off the user's devices, and personal skills stay on
  them (D6). Any session created with a tool scope (`allowedTools`) gets the same, whether
  or not it is marked remote.

## Eval and the regression cases

`skills-eval/router-cases.jsonl` holds one case per line:

```json
{"task": "Find peer-reviewed studies on sleep and memory", "skill": "academic-research"}
{"task": "Convert this JSON to YAML", "skill": "none"}
```

Write cases the way users phrase tasks, not by copying the description. A new skill needs at
least 8 cases, and near misses belong in `none`. Cases are append-only: CI fails a pull
request that removes or relabels one (see CI gates).

`skills-eval/router-heldout.jsonl` has the same format. Its cases were written before the
scorer was run on them, and the scorer's constants are never tuned on it. Add held-out cases
without looking at how they score, and don't change the scorer because of them.

**What the numbers mean.** The scorer's constants and the descriptions' "Use when" phrases
were tuned against `router-cases.jsonl`. Its gates measure regression on a tuned set, not
true accuracy on new phrasings. The held-out figures are the closer estimate of that, and
they have lower floors.

`tabkyra skill eval [--json] [--cases <file>]` runs every case against the bundled skills and
checks seven gates. It exits 1 when any fails.

| Gate | Requirement |
| --- | --- |
| top-1 accuracy | 90% or more of positive cases route to the right skill |
| false invokes | 5% or fewer of `none` cases route to any skill |
| cases per skill | every bundled skill has 8 or more cases |
| p95 latency | under 10 ms per match (the index build time is reported too) |
| baseline | every bundled skill and `none` has a value from 0 to 1 in `skills-eval/baseline.json`, and none claims more than the router measures (no tolerance), so every later comparison is like with like |
| held-out top-1 | 80% or more of held-out positive cases |
| held-out none | 10% or fewer of held-out `none` cases route to a skill |

Cases that name a skill the catalog doesn't have are skipped and listed, so cases can land
before or after their skill. `tabkyra skill eval --update-baseline` rewrites `baseline.json`
from the current results. Commit it in the same pull request as the change that moved the
numbers.

The baseline only ratchets up. A pull request may raise any value. A value lower than the
base branch's fails CI unless the pull request adds an entry for that skill and its new value
to `skills-eval/accepted-drops.json`, which a maintainer reviews (CODEOWNERS):

```json
{"drops": [{"skill": "news-research", "value": 0.7059, "reason": "the new skills share its words"}]}
```

An entry the base branch already had doesn't count again, so every drop is accepted once,
by name, with a reason. An added entry must name a skill that exists, carry exactly that
skill's new value in `baseline.json`, and sit below the base branch's value. The accepted value
then becomes the skill's floor with no tolerance, in `skill eval` and in the base-code eval:
it means "at least this", not "anything".

Measured on 2026-10-25 (13 skills): on the tuned set of 280 cases, top-1 91.7% (209 of 228)
and false invokes 0% (0 of 52); on the 49 held-out cases, top-1 94.9% (37 of 39) and false
invokes 10% (1 of 10). The top-1 gate needs 206 of 228, so the margin is three cases.
Matching takes about 0.2 ms at p95 and the index build about 20 ms on the CI runner (about
0.1 ms and under 10 ms on an Apple-silicon Mac).

Measured on 2026-10-26 (15 skills, after `visual-explainer` and `mechanism-design`): tuned
set of 326 cases, top-1 93.2% (246 of 264) and false invokes 0% (0 of 62); 62 held-out
cases, top-1 91.8% (45 of 49) and false invokes 7.7% (1 of 13). Adding skills raises every
word's IDF, so a word held by three skills becomes evidence and a word held by one scores
higher: the new skills' descriptions were worded so the existing none cases stay none. On the
held-out cases written after tuning, `visual-explainer` routes 2 of 4 and `mechanism-design`
4 of 4. The two `visual-explainer` misses: "Draw me a picture of how our
microservices call each other, as an HTML page" goes to `artifacts` (a wrong skill, a known
gap), and "Diagram the database schema and the foreign keys between tables" goes to none. Two measured near-misses are not in the case files: "Sketch my kitchen floor plan as
a diagram" and "Explain photosynthesis as a diagram" both go to `visual-explainer` (the words
diagram and plan or explain). Adding the first as a held-out none case would put held-out
false invokes at 2 of 14, over the 10% floor.

With #19 and #26 merged (34 skills, measured 2026-10-26): tuned set of 545 cases, top-1 92.9% (421 of 453) and false invokes 0% (0 of 92); held-out top-1 87.7% over 106 cases and false invokes 5.9% (1 of 17). The merged catalog moved three skills below main's baseline, recorded in `accepted-drops.json`: kyraskillmaker 77.8% to 72.2%, mechanism-design 100% to 93.3%, visual-explainer 100% to 94.1%.

With the 19 skills from pull request #19 (32 skills, measured 2026-10-26): on the tuned set of
499 cases, top-1 93.3% (389 of 417) and false invokes 0% (0 of 82); on the 110 held-out cases,
top-1 88.5% (85 of 96) and false invokes 0% (0 of 14). The top-1 gate needs 376 of 417.

## CI gates

The `skill-regression` job in `.github/workflows/ci.yml` builds the CLI without install
scripts and runs:

1. `tabkyra skill lint skills`, which includes the `budget` rule: every SKILL.md is 150
   lines and 8,000 characters or fewer. `tabkyra skill apply` runs the same lint, so a local
   edit can't grow a skill past the budget either. A local edit applied before the budget
   existed is still used when it's over; `tabkyra skill list` and `install` warn, naming the
   file and the rule, until it is trimmed and applied again.
2. `tabkyra skill eval`, the seven gates above. `--router <script>` runs a router built
   from `cli/src/router-worker.ts` (`dist/router-worker.js`) in a child process instead of
   this one.
3. `cli/test/skill-router.test.mjs`, `cli/test/skill-platform.test.mjs` and
   `cli/test/judge-label.test.mjs`.

Those three run in `skill-regression`, which builds and runs the pull request's own code.
The judge runs in a separate job, `skill-judge`, that runs no pull request code before the
judge is built: it checks out the base branch and reads the pull request's `skills/`,
`skills-eval/` files, `skill-eval.ts` (for the threshold check) and `skill-router.ts` as
data, with `git show` and `git archive` (its skills must be plain files, not links). So a
pull request's build script or tests can't tamper with the judge, and the pull request's
router runs only inside the judge's sandboxed child process.

4. On a pull request that changes `cli/src/skill-eval.ts` or `cli/src/skill-router.ts`, the
   judge job fails unless a maintainer adds the `skill-judge-change` label (only
   maintainers can add labels). Those files are the judge and what it measures most. CI
   can't judge a change to its own judge: a weakened gate would pass in its own pull request
   and then judge every later one, so a person reviews it. The label approves one version of
   the judge: a later push that changes either file voids it. The judge job fails on that
   push even with the label, and `.github/workflows/skill-judge-label.yml`
   (`pull_request_target`, through the GitHub API only, never checking out or running pull
   request code) removes the label, so a maintainer must review the new judge and add it
   again. Both decide with `.github/scripts/judge-label.mjs`, which fails closed when a push
   can't be compared.
5. On every pull request, the judge job runs
   `tabkyra skill eval --base <base files> --router <script>`.

   | From the pull request (what is judged) | From the base branch (the judge) |
   | --- | --- |
   | `skills/`, with the catalog regenerated from it by `cli/scripts/skills-catalog.mjs` | `cli/src/skill-eval.ts`: every gate's logic and threshold |
   | `skills-eval/`: case files, `baseline.json`, `accepted-drops.json` | the rest of the CLI (`skill.ts`, `index.ts`), built with the base router |
   | `cli/src/skill-router.ts`, built alone into the base's `cli/src/router-worker.ts` | the base branch's own `skills-eval/` files, for the comparisons |

   The pull request's router runs in a child process of its own. The judge sends it skill
   texts and tasks as JSON over stdin and gets back one ranking per task; no judge code runs
   in the router's process, so a router can't patch the judge (say, its `Array.prototype`).
   A small fixed loader from the judge reads the router bundle and the request from stdin
   and imports the bundle from memory, under Node's permission model, so the router can't
   read or write files or start processes, and its size isn't limited by the command line.
   Before it starts, CI moves both case files out of every checkout to a folder only the
   judge reads. Every answer is checked: one ranking per task, each a real skill or `none`,
   and one timing per match. The judge also times the whole process, and the p95 gate uses
   the larger of the router's p95 and the wall-clock time per match, so a router can't
   report itself fast.

   That limits what a router can do, not what it is. A router written to game its eval can
   still do it without reading anything, for example by carrying the public case texts in its
   own source. The real control is review: the `skill-judge-change` label above, and
   `.github/CODEOWNERS` on these files.

   If the pull request's `skill-router.ts` doesn't type-check against the base's
   `skill-eval.ts`, `router-worker.ts` and CLI, the router and the eval API changed
   together; CI fails with that message, with no fallback. The regenerated catalog means new
   skills are indexed and removed ones don't break the build, and CI checks the judge
   indexed as many skills as `skills/` holds. It fails when the pull request:
   - removed or relabeled a case from either case file;
   - lowered a skill's value in `baseline.json` below the base branch's, or dropped it,
     without an accepted drop;
   - loosened a threshold in `cli/src/skill-eval.ts` (each may only move the strict way);
   - has an accepted-drops entry that isn't valid (see above);
   - has skills that, under the base code, route the base cases worse than the base
     baseline (no tolerance; an accepted drop's value is the floor instead) or fail the base
     gates;
   - deletes a skill the base measures without listing it under `removed` in
     `accepted-drops.json`, with a reason: `{"removed": [{"skill": "old-skill", "reason":
     "merged into osint"}]}`;
   - fails the base gates and thresholds (top-1, false invokes, cases per skill, latency,
     held-out floors, and the baseline for every skill and `none`, accepted floors
     included) over all of its own case files and its own baseline, judged with its own
     router. Skills it adds need no base cases, but they are held to these gates.

   The router may improve in a pull request (with the label), and the base gates measure the
   result. The threshold check compares the constants' declarations, so a stricter threshold
   can merge; a change to gate logic takes effect only after it merges, which is why it needs
   the label and why `.github/CODEOWNERS` requires a maintainer for `skills-eval/`
   (`accepted-drops.json` included), `skill-eval.ts`, `skill-router.ts`,
   `router-worker.ts`, `cli/scripts/`, `cli/test/` and `.github/`.

## Versions

A skill's version is the first 12 hex digits of the SHA-256 of its SKILL.md, so the same
text has the same version wherever it is stored.

- `tabkyra skill list --json` gives each skill's name, description, version and source
  (`bundled` or `local`).
- `tabkyra skill versions <name> [--json]` lists the bundled version, the applied local
  version and every version in `~/.config/tabkyra/skill-history/<name>/` with the time it
  was kept and why (`backup` before an apply, `reverted`, or `<harness>-replaced`).

## Rollback

`tabkyra skill rollback <name> --to <version|time> [--yes]` restores a version from
skill-history. `--to` takes 6 to 12 hex digits of a version or the time `versions` prints.
The text goes through the same checks as `tabkyra skill apply`: lint, the protected skills
(`rsi`, `kyraskillmaker`) and the protected sections. Without `--yes` it prints the diff,
changes nothing and exits 3. An unknown or ambiguous version is refused. A target that is
the bundled text removes the local edit, as `tabkyra skill revert <name>` does, instead of
pinning a local copy that would stop bundled updates.

## Editor

`tabkyra skill edit <name> [--yes]` copies the exact source in use (`print --raw`) to
`~/.config/tabkyra/skill-drafts/<name>/SKILL.md` and records the version it was taken from
in `skill-drafts/.bases/<name>`. An unfinished draft taken from the current version is
resumed. A draft taken from an older version (an apply or rollback happened since) would
undo those changes, so it is moved to `skill-drafts/.backups/<name>/`, with a warning, and a
fresh draft is started. A draft that differs from the version it was taken from is always
moved there before a fresh one replaces it, even when its text matches the current source;
only an untouched draft is refreshed in place.

- In a terminal with `$VISUAL` or `$EDITOR` set, it opens the draft, then shows the diff
  through the same checks as `skill apply`, asks `Apply? [y/N]`, and applies with a backup
  only on yes, or straight away with `--yes`.
- If the skill changes while the editor is open, or before the yes (another apply, revert or
  rollback), it refuses to apply, keeps the draft, and says to start again from the new
  version, so the other change isn't undone.
- Outside a terminal, or with `--draft-only`, it prints the draft path and the `skill apply`
  command, and exits 0 without opening an editor, asking or applying. Agents use
  `--draft-only`: their shell can be a terminal with the user's `$EDITOR` set.
- `--draft-only` never touches a draft with unapplied changes (one that differs from the
  version it was taken from), current or stale: it leaves
  the file as it is, says so and exits 1, and the agent stops and asks the user (the rsi
  skill says to). An agent never overwrites, moves or discards the user's draft.

The protected skills can't be edited this way; they change only through a reviewed pull
request.

## Managing skills from an agent

Agents manage skills without editing files, through the CLI or one MCP tool. Every write runs
the lint first (`planApply`), and nothing is saved without `--yes` or `apply:true`.

| Job | CLI | MCP `skill_manage` action |
| --- | --- | --- |
| List with provenance (built-in, community with its catalog, local) | `skill list [--json]` | `list` |
| Read one | `skill print <name> --raw` | `skill_read` |
| Create or edit | `skill write <name> --file SKILL.md [--yes]` | `write` (`apply:true` after the user approves the diff) |
| Test: lint, community rules, router cases | `skill test <name\|folder> --cases <file>` | `test` |
| Remove a local skill, or turn off a community one | `skill remove <name>`, `skill enable <name>` | `remove` |
| Propose to the community | `skill submit <name> --cases <file>` (preview), then `--confirm <code>` | `prepare_submit` (preview only) |

`skill_manage` exists only on the local stdio server; remote and scoped sessions never get it.
A skill the user wrote themselves (no built-in or community base) can be rewritten freely; the
rules on sections apply to edits of built-in and community skills.

## Community skills

Community skills are in `community/skills/` and reach clients in a signed catalog
(D27, [CONTRIBUTING-skills.md](../CONTRIBUTING-skills.md)). The router keeps its index of
built-in and local skills as measured above and adds a second index with the community skills.
A community skill is the answer only when it leads that second index and either the first finds
nothing or the task names one of the skill's sites (its word, like "notion" for notion.so, or its
host). `skill eval` routes the same way when a checkout has `community/`, adds the cases from
`community/cases/`, and prints a second set of gates prefixed `community:`: every gate above,
built-in skills and `none` at their baselines, and each community skill routing 75% or more of
its own 8 or more cases. The judge reads the pull request's `community/` as data and runs the
same gates with the base code.
