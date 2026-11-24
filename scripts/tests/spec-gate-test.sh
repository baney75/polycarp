#!/usr/bin/env bash
# The ten cases in the spec gate's test table (S-G1 to S-G6). Each builds a throwaway git repo.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
gate=$here/../spec-gate.py
status=0
tmp=$(mktemp -d "${TMPDIR:-/tmp}/spec-gate-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# Keep the user's git config, hooks and signing out of the throwaway repos.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
unset GITHUB_EVENT_PATH

top=spaces/Sources/BaneySpaces/TopBar.swift
n=0

# A repo whose base commit has a spec with R-S1 only, TopBar.swift and crates/core/src/lib.rs.
new_repo() {
  n=$((n + 1))
  repo=$tmp/case$n
  mkdir -p "$repo"
  cd "$repo" || exit 2
  git init -q
  mkdir -p spaces/spec spaces/Sources/BaneySpaces spaces/crates/core/src
  printf 'R-S1 A switch shows the target Space.\n' > spaces/spec/workspaces.md
  printf '# Bar\n' > spaces/spec/bar.md
  printf 'base\n' > "$top"
  printf 'base\n' > spaces/crates/core/src/lib.rs
  git add -A && git commit -qm base
  base=$(git rev-parse HEAD)
}

# Commit the case's changes and run the gate with the given body.
run_gate() {
  git add -A && git commit -qm head
  head=$(git rev-parse HEAD)
  printf '%s' "$1" > "$tmp/body$n"
  out=$(python3 "$gate" --base "$base" --head "$head" --body-file "$tmp/body$n" 2>&1)
  code=$?
}

# expect <case> <exit code> [text the output must contain]...
expect() {
  local name=$1 want=$2
  shift 2
  if [ "$code" != "$want" ]; then
    echo "case $name: exit $code, want $want. Output:"
    echo "$out"
    status=1
  fi
  for text in "$@"; do
    grep -qF -- "$text" <<<"$out" || { echo "case $name: output lacks \"$text\". Output:"; echo "$out"; status=1; }
  done
}

# 1: a behavior file, empty body: fail and list it.
new_repo; printf 'change\n' >> "$top"; run_gate ""
expect 1 1 "$top" "S-G2" "S-G3" "S-G4"

# 2: a behavior file and a spec edit: pass by S-G2.
new_repo; printf 'change\n' >> "$top"; printf 'battery\n' >> spaces/spec/bar.md; run_gate ""
expect 2 0 "S-G2"

# 3: an existing rule id: pass by S-G3.
new_repo; printf 'change\n' >> "$top"; run_gate "Fix the switch.

Spec: R-S1"
expect 3 0 "S-G3"

# 4: one id missing from the spec: fail, naming it.
new_repo; printf 'change\n' >> "$top"; run_gate "Spec: R-S1, R-Z9"
expect 4 1 "R-Z9"

# 5: a stated non-change with a long enough reason: pass by S-G4.
new_repo; printf 'change\n' >> "$top"; run_gate "Spec: none (speed only, no visible change)"
expect 5 0 "S-G4"

# 6: a stated non-change with a short reason: fail.
new_repo; printf 'change\n' >> "$top"; run_gate "Spec: none (n/a)"
expect 6 1 "too short"

# 7: only a test file and a doc: pass by S-G5.
new_repo; mkdir -p spaces/Tests/BaneySpacesTests
printf 'test\n' > spaces/Tests/BaneySpacesTests/FooTests.swift; printf 'readme\n' > README.md; run_gate ""
expect 7 0 "no behavior files"

# 8: a deleted behavior file counts.
new_repo; git rm -q spaces/crates/core/src/lib.rs; run_gate ""
expect 8 1 "spaces/crates/core/src/lib.rs"

# 9: R-S10 does not match R-S1 (whole word).
new_repo; printf 'change\n' >> "$top"; run_gate "Spec: R-S10"
expect 9 1 "R-S10"

# 10: 25 behavior files: list 20, then "and 5 more".
new_repo
for i in $(seq -w 1 25); do printf 'x\n' > "spaces/Sources/BaneySpaces/File$i.swift"; done
run_gate ""
expect 10 1 "and 5 more"
listed=$(grep -cE '^  spaces/Sources/BaneySpaces/File[0-9]+\.swift$' <<<"$out")
[ "$listed" = 20 ] || { echo "case 10: listed $listed files, want 20"; status=1; }

[ "$status" = 0 ] && echo "spec gate tests: all 10 cases pass"
exit $status
