# Skill security

A skill is text an agent follows with the user's sign-in. A bad skill is a prompt
injection that never expires: it runs in every session that loads it. This document is
the threat model for skills and the gates every skill passes.

## What a lint can and can't do

No text filter makes prompt injection impossible. Language models follow instructions
wherever they appear, and an attacker can always phrase an instruction a pattern has
never seen. Tabkyra makes injection hard to land and cheap to catch by layering
these defenses:

1. **Skills ship only through review.** Bundled skills live in `skills/`, are compiled
   into the CLI, and change only through a pull request. CODEOWNERS requires a
   maintainer's review for `skills/`, the lint and CI.
2. **Every skill passes `tabkyra skill lint`,** in CI, in `tabkyra skill apply` (the only
   way `rsi` changes a skill), at install time for local edits, and on demand. The lint has no allowlist and no per-file exceptions.
3. **Red-team tests prove the lint still catches each attack** (`cli/test/skill-lint.test.mjs`).
   Weakening a rule turns CI red.
4. **A skill is one Markdown file.** Folders hold `SKILL.md` and a license only; scripts,
   binaries, extra files and symlinks are refused, so nothing outside the reviewed text
   reaches the model.
5. **Agents never see secrets.** The `proton-pass` skill routes credentials through the
   password manager's own injection (`pass-cli run`, `op run`, `bws run`). A model that
   holds only `pass://` references has nothing to leak.
6. **Page text is data.** The MCP server's instructions and every skill say so, and the
   `rsi` loop refuses lessons copied from page text, so an attack on one page can't
   become a skill edit.
7. **Actions under the user's sign-in need the user's yes,** and site access is
   allowlisted per host (README, Safety model).

## The lint rules

| Rule | Catches |
| --- | --- |
| `hidden-text` | Invisible format characters, bidi overrides, Unicode tag characters, filler characters, carriage returns, lookalike letters (mixed scripts, fullwidth, mathematical, stacked accents), HTML comments and any HTML tag, in code fences too (inline code spans excepted) |
| `override-instructions` | "Ignore/disregard ... previous/system instructions" |
| `role-hijack` | Fake `system:`, `developer:` or `user:` turns, role tags, "you are now", "developer mode" |
| `conceal-from-user` | "Without telling the user", "without asking", "don't tell the user", "secretly", "quietly", "silently" |
| `remote-code` | Downloads or decoded data piped, substituted (`$(curl ...)`, `<(curl ...)`) or `eval`ed into a shell or interpreter; a download saved as a script or executable; `iex (irm ...)`; `npx ...@latest` |
| `remote-instructions` | Following instructions fetched from a URL at run time, in either word order |
| `secret-exfiltration` | Printing, posting, saving or returning passwords, keys, tokens, cookies, card numbers; secret environment variables by name (`$OPENAI_API_KEY`); dumping the environment (`printenv`) |
| `credential-files` | Reading `~/.ssh`, `~/.aws`, `.env`, browser cookie and login stores, keychain dumps |
| `config-tamper` | Agent settings, hooks, MCP config, shell startup files, cron, launch agents; writing `rsi.json`, `skills-local`, `skill-history`, a harness's skills folder, `AGENTS.md` or `CLAUDE.md` |
| `safety-bypass` | `--dangerously-*`, `--no-verify`, `tabkyra allow-all`, disabling prompts or sandboxes |
| `encoded-blob` | Base64 or similar strings of 100+ characters |
| `remote-image` | Any image that isn't a relative path inside the skill, including reference-style images |
| `suspicious-link` | Plain http, raw IPs, link shorteners, punycode, protocol-relative `//host`, `data:`/`javascript:`/`file:` URLs, credentials in URLs |
| `structure` | Missing `## When to use`, numbered `## Steps`, `## Done when`; an unclosed fence; text on a fence line |
| `frontmatter` | Any line that isn't `key: value` for `name`, `description` or `license`; quoted values; duplicates; a name not matching its folder; a missing "Use when" |
| `file-type` | Anything in a skill folder besides `SKILL.md` and a license (which is linted too); loose files beside skill folders; any symbolic link |

Rules that name a dangerous act (`secret-exfiltration`, `remote-code`, `credential-files`,
`config-tamper`, `safety-bypass`, `remote-instructions`) allow a clause that opens by
forbidding it: "Never print the password", "Don't read ~/.ssh". Only "never", "don't",
"do not", "must not" and "mustn't" count, and at most three words may sit between them and
the act, all from a short list of plain verbs and determiners. Anything else ("refuse to",
"be afraid to", "hesitate to", "not") can turn the prohibition around, so it doesn't count.
Every match is checked on its own. Clauses end at punctuation, slashes, dashes and at
"and", "or", "but", "then", "if", "when", "so", "unless", "otherwise" and "instead".

The instruction rules read logical lines: a sentence wrapped across lines is checked as
one sentence (a line that opens with a role such as `system:` always starts its own), after folding fullwidth and mathematical letters to plain ones and dropping
stacked accents.

Every line is checked, including fence lines and code blocks. A model reads the raw file,
so a fence doesn't change what it will follow. Fences are tracked the way CommonMark reads
them (at most three spaces of indent, closed by the same character), so an indented
look-alike fence can't hide HTML from the markup check, and escaped backticks don't open a
code span. Skills describe attacks; they never quote
them. Frontmatter is parsed strictly: one `key: value` per line, allowed keys only, no
quotes, no YAML syntax, no duplicates, and no `: `, ` #`, trailing `:` or tab inside a
value, which YAML would read as a mapping or a comment.

## Local edits

`tabkyra skill apply <folder>` is the only way the `rsi` loop changes a skill. Without
`--yes` it changes nothing: it lints the draft, refuses edits to `rsi` and
`kyraskillmaker`, refuses an edit that drops a section, and prints the diff. With `--yes`
it backs up the current version to `~/.config/tabkyra/skill-history/`, keeps the edit in
`~/.config/tabkyra/skills-local/` and installs it, leaving alone any same-name skill
Tabkyra didn't write. A local copy is used only while `index.json` records it, it passes
lint, it isn't a protected skill, it keeps every section of the bundled text, and its
protected sections (safety, rules, ethics, purpose check, limits, done when) are exactly
the bundled ones. Those sections are read-only to `skill apply`, because an added line
can cancel a rule as surely as a removed one; they change only through a reviewed pull
request. Headings inside code fences don't count. Tabkyra never writes through a symbolic
link, in skills-local or in a harness's skills folder.
Skill names are checked before they reach a path. `tabkyra skill install` keeps using
the edit while it passes lint, and warns when the bundled skill has changed since the edit
was based on it. `tabkyra skill revert <name>` returns to the bundled text. By default the
`rsi` loop shows the user each diff first. It applies a change on its own only when the
user has turned on both adversarial review and auto-apply, and the reviewer approved.

## Limits

- Known gaps, tracked as issues: `config-tamper` doesn't yet catch a shell redirect or
  `install`/`ln`/`rsync` into an installed skill folder; `remote-code` doesn't yet catch an
  extensionless download that a later line runs; and package runners (`npx`, `uvx`,
  `pipx run`) without a pinned version aren't flagged. The negation check also accepts
  "never ... except <secret>" and "never hide <secret>" phrasings, and a secret
  environment variable passed to a network tool without a listed verb isn't flagged.
  Review must catch these by hand until the rules land.
- `skill apply` refuses edits that add a new section to an existing skill, since a new
  section could override a protected one.

- CODEOWNERS asks for a maintainer's review on the paths that control skills. It blocks a
  merge only if branch protection requires code-owner review.
- The skills CI job also lints with the base branch's lint whenever the base has one, so a
  pull request that weakens the lint must still pass the old lint. That step lives in the
  pull request's own copy of `ci.yml`, so it is only as strong as the CODEOWNERS review of
  `.github/`. A ruleset with a required workflow the pull request can't edit would close
  that gap.
- An agent with a shell runs as the user and can write any file the user can, skills
  included. `tabkyra skill apply` and the lint stop a skill's text from telling an agent
  to do that; the harness's own permission prompts are what stop a hijacked agent.

## Sources studied

The bundled skills were written for Tabkyra, not forked. One is adapted:
`visual-explainer` rewrites the rules of nicobailon/visual-explainer (MIT) into one
`SKILL.md`, with the MIT notice in its folder. Its kit scripts, renderer, CDN libraries,
reader-reply loop and the reference that fetched older recipes from GitHub at run time
were left out (D17). These were read for coverage and rejected as fork bases for the
reasons given:

| Source | Why it wasn't forked |
| --- | --- |
| smixs/osint-skill (MIT) | Uses paid scrapers to get around captchas and login walls; profiles private people |
| Imbad0202/academic-research-skills | CC BY-NC 4.0, not compatible with AGPL-3.0 |
| bitwarden/agent-access examples | Returns the password to the agent; install fetches the skill at run time |
| NousResearch hermes-agent 1password skill | Stores a service token in a dotfile; examples print secrets |
| uditgoenka/autoresearch (MIT) | Sends optional outbound webhooks; ML-specific loop |
| snyk/agent-scan (Apache-2.0) | Sends skill content to a remote API; Tabkyra's gate runs offline |

Note for anyone adding a Bitwarden route: `@bitwarden/cli` 2026.4.0 on npm carried a
credential stealer (StepSecurity, 2026-04-23). Pin a known-good version.
