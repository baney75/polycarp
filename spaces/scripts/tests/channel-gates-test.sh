#!/bin/bash
# The release gate in release.yml, run as written against a stand-in gh. Runs anywhere with
# bash and python3 (CI: channels.yml). Exit 0 only when every check passed.
set -uo pipefail
cd "$(dirname "$0")/../.."
status=0
bad() { echo "channel-gates-test: $*"; status=1; }
expect() { [ "$2" = "$3" ] || bad "$1: got \"$2\", want \"$3\""; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# The gate runs the real Decide script from release.yml against a stand-in gh. The release only moves to a commit that
# passed its own CI and is ahead of the one it offers (CI runs can finish out of order or be re-run).
decide() { # <workflow> [step name prefix] -> that step's script (the Decide step by default)
  python3 -I - "../.github/workflows/$1.yml" "${2:-Decide}" <<'PY'
import sys
lines = open(sys.argv[1]).read().split("\n")
i = next(n for n, l in enumerate(lines) if l.strip().startswith("- name: " + sys.argv[2]))
i = next(n for n in range(i, len(lines)) if lines[n].strip() == "run: |") + 1
ind = len(lines[i]) - len(lines[i].lstrip())
out = []
while i < len(lines) and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) >= ind):
    out.append(lines[i][ind:]); i += 1
print("\n".join(out))
PY
}
g="$tmp/gate"; mkdir -p "$g/bin"
cat > "$g/bin/gh" <<'GH'
#!/bin/bash
# STUB_LAST: the nightly tag's commit, STUB_DEV the dev tag's (empty: 404). STUB_REL_<base>_<head>: compare status. STUB_GREEN: newest green
# CI run's commit. STUB_MAIN: main's head. STUB_OLD: a commit with no publish.sh. STUB_OPEN: open blocking issues.
case "$*" in
  "api repos/r/contents/spaces/scripts/publish.sh?ref="*)
    [ "${2##*ref=}" != "${STUB_OLD:-}" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    [ "${2##*ref=}" != "${STUB_NETERR:-}" ] || { echo "gh: connection reset" >&2; exit 1; } ;;
  "api repos/r/git/ref/tags/nightly "*) [ -n "$STUB_LAST" ] && echo "$STUB_LAST" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  "api repos/r/git/ref/tags/dev "*) [ -n "${STUB_DEV:-}" ] && echo "$STUB_DEV" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  "api repos/r/compare/"*) p=${2#repos/r/compare/}; v="STUB_REL_${p%%...*}_${p##*...}"; echo "${!v:?no stub for $p}" ;;
  "api repos/r/commits/main"*) echo "$STUB_MAIN" ;;
  "run list"*) echo "${STUB_GREEN:-}" ;;
  "issue list"*) echo "${STUB_OPEN:-}" ;;
  *) echo "gh stand-in: $*" >&2; exit 1 ;;
esac
GH
chmod +x "$g/bin/gh"
gate() { # <workflow> <env...>: prints go and commit
  local wf=$1; shift; : > "$g/out"
  env "$@" REPO=r GITHUB_OUTPUT="$g/out" RUNNER_TEMP="$g" PATH="$g/bin:$PATH" bash -c "$(decide "$wf")" >/dev/null 2>&1 \
    || { echo "error"; return; }
  printf '%s %s\n' "$(sed -n 's/^go=//p' "$g/out")" "$(sed -n 's/^commit=//p' "$g/out")"
}
# first-F1: B is offered; A's CI finishes later (or is re-run). The release must not move back to A.
expect "an older commit's CI" "$(gate release RUN_SHA=aaa STUB_LAST=bbb STUB_REL_bbb_aaa=behind)" "false "
expect "a newer commit's CI" "$(gate release RUN_SHA=ccc STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" "true ccc"
expect "the first build" "$(gate release RUN_SHA=ccc STUB_LAST=)" "true ccc"
expect "the same commit again" "$(gate release RUN_SHA=bbb STUB_LAST=bbb STUB_REL_bbb_bbb=identical)" "false "
# Started by hand: the newest commit with a green CI run, never main's untested head (ddd).
expect "started by hand" "$(gate release RUN_SHA= REF=refs/heads/main STUB_MAIN=ddd STUB_GREEN=ccc STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" "true ccc"
expect "by hand, no green run" "$(gate release RUN_SHA= REF=refs/heads/main STUB_GREEN= STUB_LAST=bbb)" "false "
# sol-sol-F4: dev never moves back. A run that stopped after moving dev leaves it on the commit, which runs again.
expect "a commit behind dev" "$(gate release RUN_SHA=vvv STUB_LAST=www STUB_REL_www_vvv=ahead STUB_DEV=xxx STUB_REL_xxx_vvv=behind)" "false "
expect "the commit dev already holds" "$(gate release RUN_SHA=xxx STUB_LAST=www STUB_REL_www_xxx=ahead STUB_DEV=xxx STUB_REL_xxx_xxx=identical)" "true xxx"
expect "a commit ahead of both" "$(gate release RUN_SHA=yyy STUB_LAST=www STUB_REL_www_yyy=ahead STUB_DEV=xxx STUB_REL_xxx_yyy=ahead)" "true yyy"
# sol-F3: a commit from before the one stream would move nightly alone, so it isn't built; a lookup that fails is an error.
expect "a commit from before publish.sh" "$(gate release RUN_SHA=ccc STUB_OLD=ccc STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" "false "
[ "$(gate release RUN_SHA=ccc STUB_NETERR=ccc STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" = error ] || bad "a failed publish.sh lookup was taken as an old commit"
# first-F2: an open regression labeled blocks-nightly holds every release.
expect "an open blocking regression" "$(gate release RUN_SHA=ccc STUB_OPEN='#7' STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" "false "
[ "$(gate release RUN_SHA= REF=refs/heads/feature STUB_GREEN=ccc)" = error ] || bad "a release was started from a branch other than main"
# A job's own permissions replace the workflow's, so each job that lists issues or runs must grant reading them.
python3 -I - ../.github/workflows/*.yml <<'PY' || bad "a workflow job calls gh issue list or gh run list without the permission to read them"
import re, sys
bad = False
for path in sys.argv[1:]:
    top, jobs, cur, section, inperm = {}, {}, None, None, False
    for l in open(path).read().split("\n"):
        if l.startswith("jobs:"): section = "jobs"; continue
        if l.startswith("permissions:"): section = "top"; continue
        if re.match(r"^\S", l): section = None; continue
        if section == "top":
            m = re.match(r"^  ([\w-]+): (\w+)", l)
            if m: top[m.group(1)] = m.group(2)
        if section != "jobs": continue
        m = re.match(r"^  ([\w-]+):\s*$", l)
        if m: cur = jobs.setdefault(m.group(1), {"perm": None, "text": ""}); inperm = False; continue
        if cur is None: continue
        if re.match(r"^    permissions:\s*$", l): cur["perm"] = {}; inperm = True; continue
        if re.match(r"^    \S", l): inperm = False
        if inperm:
            m = re.match(r"^      ([\w-]+): (\w+)", l)
            if m: cur["perm"][m.group(1)] = m.group(2)
        cur["text"] += l + "\n"
    for name, j in jobs.items():
        perm = j["perm"] if j["perm"] is not None else top
        for call, scope in (("gh issue list", "issues"), ("gh run list", "actions")):
            if call in j["text"] and perm.get(scope) not in ("read", "write"):
                print(f"{path}: job {name} runs {call} without {scope}: read"); bad = True
sys.exit(1 if bad else 0)
PY
grep -q "if: needs.gate.outputs.go == 'true'" ../.github/workflows/release.yml || bad "release.yml builds without the gate's go"
# sol-sol-F1: only the build waits its turn. A run-wide queue would let a run the gate stops (a failed CI run) take the
# place of a waiting green build, and cancelling a build mid-publish would leave the releases half moved.
python3 -I - ../.github/workflows/release.yml <<'PY' || bad "release.yml's queue isn't the build job's alone, never cancelling"
import re, sys
text = open(sys.argv[1]).read()
build = re.search(r"^  build:\n((?:    .*\n|\n)*)", text, re.M)
ok = text.count("concurrency:") == 1 and build is not None \
    and "    concurrency:\n      group: release\n      cancel-in-progress: false\n" in build.group(1)
sys.exit(0 if ok else 1)
PY

# sol-sol-F6: prune keeps the nightly-<time> the rolling feed names, even when a newer one was left by a run that
# stopped partway, and deletes nothing when it can't read the feed.
p="$tmp/prune"; mkdir -p "$p/bin"
cat > "$p/bin/gh" <<'GH'
#!/bin/bash
case "$*" in
  "release download nightly -R r -p latest.json -O -") [ -n "$STUB_FEED" ] && echo "$STUB_FEED" || exit 1 ;;
  "api --paginate repos/r/releases?per_page=100 --jq "*) printf '%s\n' $STUB_TAGS ;;
  "release delete "*) echo "$3" >> "$STUB_DELETED" ;;
  *) echo "gh stand-in: $*" >&2; exit 1 ;;
esac
GH
printf '#!/bin/sh\necho 20261110000000\n' > "$p/bin/date"
chmod +x "$p/bin/gh" "$p/bin/date"
prune() { # <feed json> -> the tags deleted, oldest first
  : > "$p/deleted"
  env STUB_FEED="$1" STUB_DELETED="$p/deleted" REPO=r PATH="$p/bin:$PATH" \
    STUB_TAGS="nightly-20261001000000 nightly-20261101000000 nightly-20261120000000 nightly preview" \
    bash -c "$(decide release 'Delete nightly-<time>')" >/dev/null 2>&1 || echo "error"
  sort "$p/deleted" | tr '\n' ' '
}
named='{"platforms": {"darwin-aarch64": {"url": "https://github.com/r/releases/download/nightly-20261101000000/Polycarp.zip"}}}'
expect "prune keeps the feed's release" "$(prune "$named")" "nightly-20261001000000 "
expect "prune with no feed" "$(prune "")" ""

[ $status = 0 ] && echo "channel-gates-test: pass"
exit $status
