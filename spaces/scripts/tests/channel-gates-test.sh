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
decide() { # <workflow> -> the Decide step's script
  python3 -I - "../.github/workflows/$1.yml" <<'PY'
import sys
lines = open(sys.argv[1]).read().split("\n")
i = next(n for n, l in enumerate(lines) if l.strip() == "- name: Decide")
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
# STUB_LAST: the channel tag's commit (empty: 404). STUB_REL_<base>_<head>: compare status. STUB_GREEN: newest green
# CI run's commit. STUB_MAIN: main's head. STUB_OLD: a commit with no publish.sh. STUB_OPEN: open blocking issues.
case "$*" in
  "api repos/r/contents/spaces/scripts/publish.sh?ref="*)
    [ "${2##*ref=}" != "${STUB_OLD:-}" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    [ "${2##*ref=}" != "${STUB_NETERR:-}" ] || { echo "gh: connection reset" >&2; exit 1; } ;;
  "api repos/r/git/ref/tags/"*) [ -n "$STUB_LAST" ] && echo "$STUB_LAST" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
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

[ $status = 0 ] && echo "channel-gates-test: pass"
exit $status
