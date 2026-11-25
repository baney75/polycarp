#!/bin/bash
# plugins/publish-omarchy.sh against throwaway repos: first publish, nothing new, a change, and what it refuses.
# Each step is its own line, so set -e stops on the first one that fails.
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/publish-omarchy.sh
tmp=$(mktemp -d)
trap 'rm -rf -- "${tmp:?}"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
git init -q --bare -b main "$tmp/to.git"
git init -q -b main "$tmp/src"
cd "$tmp/src"
mkdir -p plugins/omarchy/ui
cp "$script" plugins/
printf '{\n  "id": "x.y",\n  "version": "1.2.3"\n}\n' >plugins/omarchy/manifest.json
for f in README.md LICENSE ui/A.qml; do echo "$f" >"plugins/omarchy/$f"; done
commit() { git add -A && git commit -qm "$1"; }
run() { bash plugins/publish-omarchy.sh --ref HEAD --to "$tmp/to.git" "$@"; }
there() { git --git-dir="$tmp/to.git" "$@"; }
ok=0
is() { [[ $2 == "$3" ]] || { echo "FAIL $1: \"$2\" is not \"$3\"" >&2; exit 1; }; ok=$((ok + 1)); }
refuses() { local why=$1; shift; if out=$(run "$@" 2>&1); then echo "FAIL: published in spite of: $why" >&2; exit 1; fi; [[ $out == *"$why"* ]] || { echo "FAIL: said \"$out\", not \"$why\"" >&2; exit 1; }; ok=$((ok + 1)); }

commit first
run --dry-run >/dev/null
is "a dry run pushes nothing" "$(there for-each-ref)" ""
run >/dev/null
is "manifest.json is at the root" "$(there show main:manifest.json | sed -n 's/.*"version": "\(.*\)"/\1/p')" 1.2.3
is "only the plugin is there" "$(there ls-tree -r --name-only main | tr '\n' ' ')" "LICENSE README.md manifest.json ui/A.qml "
first=$(there rev-parse main)
run >/dev/null
is "nothing new, nothing pushed" "$(there rev-parse main)" "$first"
echo else >other
commit elsewhere
run >/dev/null
is "a change outside the plugin is not a release" "$(there rev-parse main)" "$first"
echo more >>plugins/omarchy/ui/A.qml
commit more
run >/dev/null
is "the next one is on top of the last" "$(there rev-parse main^)" "$first"
is "it says where it came from" "$(there log -1 --format=%b main)" "From plugins/omarchy in baney75/polycarp at $(git rev-parse HEAD)."
last=$(there rev-parse main)
refuses "which HEAD~2 does not contain" --ref HEAD~2
ln -s README.md plugins/omarchy/link
commit link
refuses "only plain files"
git rm -q plugins/omarchy/link plugins/omarchy/LICENSE
commit nolicense
refuses "LICENSE is missing"
git checkout -q HEAD~1 -- plugins/omarchy/LICENSE
git rm -q plugins/omarchy/README.md
commit noreadme
refuses "README.md is missing"
git checkout -q HEAD~1 -- plugins/omarchy/README.md
echo '{ "version": ' >plugins/omarchy/manifest.json
commit broken
refuses "not JSON"
printf '{\n  "id": "x.y",\n  "version": "1.2.4"\n}\n' >plugins/omarchy/manifest.json
head -c 2200000 /dev/zero >plugins/omarchy/big
commit big
refuses "over 2 MB"
is "nothing refused was pushed" "$(there rev-parse main)" "$last"
git rm -q plugins/omarchy/big
commit small

# A main someone else made, and a repo with commits but no main.
git clone -q --bare "$tmp/to.git" "$tmp/hand.git"
git --git-dir="$tmp/hand.git" update-ref refs/heads/main "$(git --git-dir="$tmp/hand.git" commit-tree "main^{tree}" -p main -m "by hand")"
refuses "not made by this script" --to "$tmp/hand.git"
git --git-dir="$tmp/hand.git" branch -q -m main other
refuses "commits but no main" --to "$tmp/hand.git"
run >/dev/null
is "a newer source goes on top" "$(there rev-parse main^)" "$last"
echo "publish-omarchy: $ok checks passed"
