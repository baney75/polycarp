#!/bin/bash
# Copies plugins/omarchy to the repo people install it from, as one commit on top of what is there. An Omarchy plugin has
# to be a repo with manifest.json at its root, and this is the only thing that writes to that one.
#   plugins/publish-omarchy.sh [--ref REF] [--to URL] [--dry-run]
# Run it again whenever main has moved: with nothing new it does nothing. It never forces a push, and it refuses to publish
# a source older than the one already there.
set -euo pipefail

ref= to=https://github.com/baney75/omarchy-polycarp.git dry=0
while (($#)); do
  case $1 in
  --ref) ref=${2:?--ref needs a commit}; shift 2 ;;
  --to) to=${2:?--to needs a repo}; shift 2 ;;
  --dry-run) dry=1; shift ;;
  *) sed -n '2,5p' "$0" >&2; exit 2 ;;
  esac
done
fail() { echo "publish-omarchy: $*" >&2; exit 1; }

cd "$(dirname "$0")/.."
if [[ -z $ref ]]; then
  git fetch --quiet origin main || fail "could not fetch origin main"
  ref=origin/main
fi
source=$(git rev-parse --verify --quiet "$ref^{commit}") || fail "no commit $ref here; fetch first"
tree=$(git rev-parse --verify --quiet "$source:plugins/omarchy") || fail "$ref has no plugins/omarchy"

# What Omarchy refuses, or a person should not be handed.
for f in manifest.json README.md LICENSE; do git cat-file -e "$tree:$f" 2>/dev/null || fail "$f is missing"; done
links=$(git ls-tree -r "$tree" | awk '$1 != "100644" && $1 != "100755"')
[[ -z $links ]] || fail "only plain files can be published: $links"
size=$(git ls-tree -r -l "$tree" | awk '{ n += $4 } END { print n + 0 }')
((size < 2 * 1024 * 1024)) || fail "$size bytes is over 2 MB"
command -v node >/dev/null || fail "needs node"
# The manifest's version; nothing when it has none that is text, and a failure when it is not JSON.
versionOf() {
  git cat-file blob "$1:manifest.json" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let m; try { m = JSON.parse(s) } catch { process.exit(3) }
      const v = m && m.version; if (typeof v === "string" && v.trim()) console.log(v)
    })'
}
# Whether version $1 is above $2, number by number: 1.10.0 is above 1.9.3.
above() {
  node -e '
    const [a, b] = process.argv.slice(1).map((v) => v.split(".").map((n) => parseInt(n, 10)))
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) process.exit(d > 0 ? 0 : 1) }
    process.exit(1)' "$1" "$2"
}
version=$(versionOf "$tree") || fail "manifest.json is not JSON"
[[ $version ]] || fail "manifest.json has no version"

heads=$(git ls-remote "$to") || fail "could not reach $to"
parent=
if awk '$2 == "refs/heads/main" { found = 1 } END { exit !found }' <<<"$heads"; then
  git fetch --quiet "$to" main || fail "could not fetch main from $to"
  parent=$(git rev-parse FETCH_HEAD)
  # Each publish names its source, so a run from an older checkout cannot quietly undo a newer one.
  last=$(git log -1 --format=%b "$parent" | sed -n 's/^From plugins\/omarchy in baney75\/polycarp at \([0-9a-f]*\)\.$/\1/p')
  [[ $last ]] || fail "main on $to was not made by this script; look at it first"
  git cat-file -e "$last^{commit}" 2>/dev/null || fail "$to was published from $last, which is not here; fetch first"
  git merge-base --is-ancestor "$last" "$source" || fail "$to was published from $last, which $ref does not contain"
elif [[ -n $heads ]]; then
  fail "$to has commits but no main"
fi
if [[ $parent ]] && [[ $(git rev-parse "$parent^{tree}") == "$tree" ]]; then
  echo "publish-omarchy: $to already has this ($version)"
  exit 0
fi
# Omarchy shows the version, so new content under the same one or a lower one would look like no update, or a step back.
if [[ $parent ]]; then
  old=$(versionOf "$parent" || true)
  [[ -z $old ]] || above "$version" "$old" || fail "manifest.json says $version, which is not above $old; raise it"
fi

message="Polycarp for Omarchy $version

From plugins/omarchy in baney75/polycarp at $source."
commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "$message")
git diff-tree --stat ${parent:-$(git hash-object -t tree /dev/null)} "$commit" | tail -n 20
if ((dry)); then echo "publish-omarchy: would push $commit ($size bytes)"; exit 0; fi
git push --quiet "$to" "$commit:refs/heads/main"
echo "publish-omarchy: $version is on $to as $commit ($size bytes)"
