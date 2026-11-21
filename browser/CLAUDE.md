# Tabkyra

@AGENTS.md

AGENTS.md (imported above) is the source of truth for this repository. If anything here
seems to disagree with it, AGENTS.md wins.

Never break these:

- Run the checks before you commit: `./check.sh`, plus `(cd cli && npx tsc --noEmit && npm test)`
  for CLI changes. Fix every error first.
- Stage files by explicit path. Never `git add -A` or `git add .`.
- Never `git commit --no-verify`.
- Every skill in `skills/` passes `node cli/dist/index.js skill lint skills`. Fix the skill,
  not the lint.
- Never weaken the skill lint, its red-team tests, CI or CODEOWNERS without the
  maintainer's review.
- Sign-in policy: API keys only. Never add a sign-in that borrows another app's identity
  (docs/auth-policy.md).
- Commit only when the user asks.
