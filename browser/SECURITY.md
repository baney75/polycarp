# Security policy

Tabkyra drives a browser that is signed in as its user, so security reports matter here
more than most. Thank you for taking the time to send one.

## Report privately

Don't open a public issue, discussion or pull request for a vulnerability. Use either:

- **GitHub private vulnerability reporting:** the **Report a vulnerability** button on the
  repository's [Security tab](https://github.com/baney75/tabkyra/security), or
  [this form](https://github.com/baney75/tabkyra/security/advisories/new) directly.
- **Email:** [donovan@dbaney.com](mailto:donovan@dbaney.com), with "Tabkyra security" in
  the subject.

Include what you found, the version (extension version from the side panel's About screen,
`tabkyra --version`, and the commit if you built from source), the steps to reproduce,
and what an attacker gains. A proof of concept against a test page or a throwaway account
is the most useful thing you can send.

Tabkyra has one maintainer, Donovan Baney. Reports are read by him, and fixes are
coordinated with you before anything is published. If you'd like credit in the release
notes, say how you want to be named.

## Supported versions

No release has been published yet. Fixes land on the `main` branch, and the first signed
release will be built from it. Once releases exist, the latest release and `main` are
supported.

## Scope

In scope:

- The extension: the side panel, the bridge, site permissions, tab group isolation,
  private mode and bug-report redaction.
- The native host, the Unix-socket client and the MCP server (`tabkyra mcp`).
- Remote MCP: `tabkyra serve`, token scopes and revocation, and the tunnel commands.
- The skill lint and the bundled skills in `skills/`, including a skill text that gets an
  agent to act against its user and still passes the lint.
- `tabkyra update`: signature, checksum and unpacking checks.
- The setup prompt, `tabkyra setup`, `tabkyra install` and the launcher they write.
- The release and CI workflows in `.github/`.

Examples of what counts: an agent reaching tabs outside its own group, opening a site
that wasn't allowed while the mode is "ask", a token using a tool outside its scopes,
another local user reaching the bridge socket, a skill that hides instructions from the
lint, an update that installs unsigned code, or redaction that leaks an email or a key.

Out of scope, or known and documented:

- A model following instructions in page text on a site the user allowed. The README's
  safety model says this is guidance to the model, not enforcement. A way around a
  control (site permission, tab group, token scope) is in scope.
- Programs running as the same user reaching the bridge. They have the same trust as the
  user's shell.
- Lint gaps already listed under "Limits" in
  [docs/skill-security.md](docs/skill-security.md). A new way around them is in scope.
- `tabkyra allow-all` and `tabkyra tunnel tailscale --public` behaving as documented.
- Bugs in the sibling projects themselves. Report those upstream:
  [badlogic/pi-mono](https://github.com/badlogic/pi-mono),
  [badlogic/mini-lit](https://github.com/badlogic/mini-lit),
  [badlogic/sitegeist](https://github.com/badlogic/sitegeist) and
  [0xSero/sitegeist](https://github.com/0xSero/sitegeist). If one affects Tabkyra, a note
  here is welcome too.
- Model providers, harnesses (Claude Code, Codex and others), Tailscale and Cloudflare.

## What to expect

We aim to acknowledge a report within seven days and to agree on a disclosure date with
you once a fix is planned.

## Please don't

- Test against accounts, browsers or machines that aren't yours.
- Read, keep or share other people's data, even to prove a point.
- Run denial-of-service or high-volume tests against anyone's service.
- Use social engineering or phishing against the maintainer or users.
- Publish details before a fix is out and we've agreed on a date.

Good-faith research that follows these rules is welcome.

## Local secret scan

Husky's `.husky/pre-commit` runs `npm run check`, then `scripts/secret-scan.py` on
staged lines. The scan flags token prefixes, PEM headers, basic-auth URLs and a short
list of other shapes, and prints the file, line and pattern name (never the matched
value). `npm install` runs `prepare` → Husky, so you do not need a separate
`core.hooksPath`.

When a test needs a fake credential, assemble it at runtime (`"gh" + "p_" + "x" * 36`)
so this scan and GitGuardian never see a contiguous token. End a look-alike line with
`secret-scan: allow` if you must keep one.
