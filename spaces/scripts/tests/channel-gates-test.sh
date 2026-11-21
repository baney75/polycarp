#!/bin/bash
# The release gates in dev.yml, nightly.yml and promote.yml, run as written against a stand-in gh. Runs anywhere with
# bash and python3 (CI: channels.yml). Exit 0 only when every check passed.
set -uo pipefail
cd "$(dirname "$0")/../.."
status=0
bad() { echo "channel-gates-test: $*"; status=1; }
expect() { [ "$2" = "$3" ] || bad "$1: got \"$2\", want \"$3\""; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# The gates run the real Decide scripts from dev.yml and nightly.yml against a stand-in gh. A channel only moves to a
# commit that passed its own CI and is ahead of the one it offers (CI runs can finish out of order or be re-run).
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
# CI run's commit. STUB_MAIN: main's head.
case "$*" in
  "api repos/r/git/ref/tags/"*) [ -n "$STUB_LAST" ] && echo "$STUB_LAST" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  "api repos/r/compare/"*) p=${2#repos/r/compare/}; v="STUB_REL_${p%%...*}_${p##*...}"; echo "${!v:?no stub for $p}" ;;
  "api repos/r/commits/main"*) echo "$STUB_MAIN" ;;
  "run list"*) echo "${STUB_GREEN:-}" ;;
  "issue list"*) echo "" ;;
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
# first-F1: B is on dev; A's CI finishes later (or is re-run). Dev must not move back to A.
expect "dev, an older commit's CI" "$(gate dev RUN_SHA=aaa STUB_LAST=bbb STUB_REL_bbb_aaa=behind)" "false "
expect "dev, a newer commit's CI" "$(gate dev RUN_SHA=ccc STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" "true ccc"
expect "dev, the first build" "$(gate dev RUN_SHA=ccc STUB_LAST=)" "true ccc"
expect "dev, the same commit again" "$(gate dev RUN_SHA=bbb STUB_LAST=bbb STUB_REL_bbb_bbb=identical)" "false "
# sol-F1: main moved to ddd, whose CI hasn't finished. The nightly builds ccc, the newest tested commit, never ddd.
expect "nightly, untested head" "$(gate nightly EVENT=schedule STUB_MAIN=ddd STUB_GREEN=ccc STUB_REL_ccc_main=ahead STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" "true ccc"
expect "nightly, nothing new tested" "$(gate nightly EVENT=schedule STUB_GREEN=bbb STUB_REL_bbb_main=ahead STUB_LAST=bbb STUB_REL_bbb_bbb=identical)" "false "
expect "nightly, no green run" "$(gate nightly EVENT=schedule STUB_GREEN= STUB_LAST=bbb)" "false "
expect "nightly, tested commit left main" "$(gate nightly EVENT=schedule STUB_GREEN=eee STUB_REL_eee_main=diverged STUB_LAST=bbb)" "false "
expect "nightly, first (bridge) run" "$(gate nightly EVENT=workflow_dispatch STUB_GREEN=ccc STUB_REL_ccc_main=identical STUB_LAST=)" "true ccc"
expect "dev, started by hand" "$(gate dev RUN_SHA= REF=refs/heads/main STUB_MAIN=ddd STUB_GREEN=ccc STUB_LAST=bbb STUB_REL_bbb_ccc=ahead)" "true ccc"
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
grep -q "if: needs.gate.outputs.go == 'true'" ../.github/workflows/dev.yml || bad "dev.yml builds without the gate's go"

[ $status = 0 ] && echo "channel-gates-test: pass"
exit $status
