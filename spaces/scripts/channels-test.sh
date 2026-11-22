#!/bin/bash
# Checks scripts/channel-version.sh and scripts/write-feed.sh against docs/releases.md. Runs anywhere with bash,
# python3 and npx (CI: channels.yml). Exit 0 only when every check passed.
set -uo pipefail
cd "$(dirname "$0")/.."
status=0
bad() { echo "channels-test: $*"; status=1; }
expect() { [ "$2" = "$3" ] || bad "$1: got \"$2\", want \"$3\""; }
export POLYCARP_BUILD_TIME=20261118070000 POLYCARP_COMMIT=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
base=$(cat VERSION)
expect stable "$(scripts/channel-version.sh stable)" "$base"
expect nightly "$(scripts/channel-version.sh nightly)" "$base-nightly.20261118070000+1a2b3c4"
expect dev "$(scripts/channel-version.sh dev)" "$base-dev.20261118070000+1a2b3c4"
expect local "$(scripts/channel-version.sh local)" "$base-dev.0+local.1a2b3c4"
expect bundle "$(scripts/channel-version.sh --bundle-version)" "20261118.070000"
POLYCARP_BUILD_TIME=2026111807 scripts/channel-version.sh nightly >/dev/null 2>&1 && bad "a short build time was taken"
scripts/channel-version.sh preview >/dev/null 2>&1 && bad "preview is not a channel any more"

# The rename: a preview build carries the plain base version (0.3.0), and the first nightly must sort above it,
# so main's base went up at the rename. A 0.3.0 nightly would sort below the 0.3.0 preview build.
order=(0.3.0-dev.20261117131042+9f8e7d6 0.3.0-nightly.20261117070000+1a2b3c4 0.3.0 \
  0.4.0-dev.0+local.9f8e7d6 0.4.0-dev.20261118090500+1111111 0.4.0-nightly.20261117070000+2222222 \
  0.4.0-nightly.20261118070000+3333333 0.4.0)
sorted=$(npx -y semver@7.6.3 "${order[@]}" 2>/dev/null)
# semver prints each version without its build metadata (+sha), which never counts for order.
expect "SemVer order" "$sorted" "$(printf '%s\n' "${order[@]%%+*}")"
# publish-channel.sh's own comparison agrees with the semver package on every neighbouring pair, both ways.
for ((i = 1; i < ${#order[@]}; i++)); do
  python3 -I scripts/semver-newer.py "${order[i]}" "${order[i-1]}" || bad "semver-newer.py: ${order[i]} is not above ${order[i-1]}"
  python3 -I scripts/semver-newer.py "${order[i-1]}" "${order[i]}" && bad "semver-newer.py: ${order[i-1]} is above ${order[i]}"
done
python3 -I scripts/semver-newer.py 0.4.0-nightly.20261118070000+aaaaaaa 0.4.0-nightly.20261118070000+bbbbbbb \
  && bad "semver-newer.py: two builds of one time differ only in build metadata, so neither is newer"
[ "$(printf '%s' "$base" | cut -d. -f1-2)" != 0.3 ] || bad "VERSION is still 0.3.x, so the first nightly would sort below the preview builds (0.3.0)"

# The app says which channel and version it is: every @TOKEN@ in the Info.plist template is one bundle.sh fills.
for key in PolycarpVersion PolycarpChannel; do grep -q "<key>$key</key>" Resources/Info.plist || bad "Info.plist has no $key"; done
grep -q '<key>CFBundleVersion</key><string>@BUILD_NUMBER@</string>' Resources/Info.plist || bad "CFBundleVersion is not the build time"
for token in $(grep -o '@[A-Z_]*@' Resources/Info.plist | sort -u); do
  grep -q "s/$token/" scripts/bundle.sh || bad "bundle.sh never fills $token"
done
plist=$(sed -e 's/@[A-Z_]*@/x/g' Resources/Info.plist | plutil -lint - 2>&1) || bad "Info.plist: $plist"

# The feed.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf 'zip' > "$tmp/Polycarp.zip"
sha=$(shasum -a 256 "$tmp/Polycarp.zip" | awk '{print $1}')
c=$POLYCARP_COMMIT
feed() { POLYCARP_FEED_ARCHS="$1" scripts/write-feed.sh "$2" "$3" "$c" "$tmp/Polycarp.zip" "$tmp/latest.json" "notes" >/dev/null 2>&1; }
field() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$tmp/latest.json" "$1"; }
for ch in stable nightly dev; do
  v=$(scripts/channel-version.sh "$ch")
  feed arm64 "$ch" "$v" || { bad "write-feed refused $ch $v"; continue; }
  case $ch in stable) url="https://github.com/baney75/polycarp/releases/download/v$v/Polycarp.zip" ;;
              nightly) url="https://github.com/baney75/polycarp/releases/download/nightly-20261118070000/Polycarp.zip" ;;
              *) url="https://github.com/baney75/polycarp/releases/download/$ch/Polycarp.zip" ;; esac
  expect "$ch feed" "$(field '[d["product"], d["channel"], d["version"], d["commit"], d["protocol"]]')" "['polycarp', '$ch', '$v', '$c', 1]"
  expect "$ch url" "$(field 'd["platforms"]["darwin-aarch64"]["url"]')" "$url"
  expect "$ch sha256" "$(field 'd["platforms"]["darwin-aarch64"]["sha256"]')" "$sha"
  expect "$ch requirement" "$(field 'd["platforms"]["darwin-aarch64"]["requirement"]')" "$(cat scripts/release-requirement.txt)"
done
feed "x86_64 arm64" stable "$base" && expect "universal" "$(field 'sorted(d["platforms"])')" "['darwin-aarch64', 'darwin-x86_64']"
feed arm64 nightly "$base" && bad "a nightly feed took a stable version"
feed arm64 stable "$base-nightly.20261118070000+1a2b3c4" && bad "a stable feed took a nightly version"
feed arm64 dev "$base-nightly.20261118070000+1a2b3c4" && bad "a dev feed took a nightly version"
feed arm64 preview "$base" && bad "write-feed took the preview channel"
feed arm64 nightly "$base-nightly.2026111807+1a2b3c4" && bad "write-feed took a nightly version with no build time"
POLYCARP_FEED_ARCHS=ppc scripts/write-feed.sh nightly "$(scripts/channel-version.sh nightly)" "$c" "$tmp/Polycarp.zip" "$tmp/x.json" >/dev/null 2>&1 \
  && bad "a feed with no Mac architecture was written"
# The feed read-back after the move waits out GitHub's download cache instead of failing on its first 404.
grep -q 'for _ in $(seq 1 12); do' scripts/publish-channel.sh && grep -qF "two minutes after the publish" scripts/publish-channel.sh \
  || bad "publish-channel.sh reads the moved feed back once, so a cache 404 fails a good publish"
# The bridge marks preview as the old publisher did: its tag on the build's commit, the marker in its notes.
bridge=$(sed -n '/if \[ "$BRIDGE" = 1 \]; then/,/^fi/p' scripts/publish-channel.sh)
grep -qF 'git/refs/tags/preview" -f sha="$COMMIT"' <<<"$bridge" || bad "the bridge leaves the preview tag on the old commit"
grep -qF '<!-- baneyspaces commit=$COMMIT date=$DATE -->' <<<"$bridge" || bad "the bridge's preview notes have no commit marker"
# The rolling nightly must be found by a build from before the channels, such as a 0.3.0 copy built from main on
# the Nightly channel. That updater (Updates.swift before #456) reads GitHub's release list, takes the release
# tagged exactly `nightly` that isn't a draft, reads the commit and date from the `<!-- baneyspaces ... -->` line
# of its notes, offers it when that date is later than its own commit's, and then runs install.sh at that commit
# with BANEYSPACES_REF=nightly, which downloads releases/download/nightly/Polycarp.zip and its .sha256.
# This runs the real publish-channel.sh against a stand-in for gh and curl and checks the release it leaves.
pub="$tmp/pub"; mkdir -p "$pub/scripts" "$pub/bin" "$pub/state" "$pub/build/Polycarp.app/Contents"
cp scripts/publish-channel.sh scripts/semver-newer.py scripts/product.env scripts/write-feed.sh scripts/release-requirement.txt "$pub/scripts/"
printf '#!/bin/bash\n[ -z "${STUB_VERIFY_FAIL:-}" ]\n' > "$pub/scripts/verify-release.sh"
pv=$(scripts/channel-version.sh nightly); pdate=2026-11-21T12:00:00Z
python3 -I -c 'import plistlib,sys; plistlib.dump({"PolycarpVersion": sys.argv[2], "PolycarpChannel": "nightly", "PolycarpCommit": sys.argv[3], "PolycarpCommitDate": sys.argv[4], "PolycarpCommitDirty": "0"}, open(sys.argv[1], "wb"))' \
  "$pub/build/Polycarp.app/Contents/Info.plist" "$pv" "$c" "$pdate"
for f in Polycarp.zip Polycarp.zip.sha256 Polycarp.dmg; do printf '%s' "$f" > "$pub/build/$f"; done
cat > "$pub/bin/gh" <<'GH'
#!/bin/bash
# Keeps each release as state/<id>/{tag,draft,body,assets/}. Only the calls publish-channel.sh makes.
S="$STUB_STATE"
if [ "$1" = release ] && [ "$2" = delete ]; then
  for d in "$S"/r*; do [ -f "$d/tag" ] && [ "$(cat "$d/tag")" = "$3" ] && rm -rf "$d"; done; exit 0
fi
[ "$1" = api ] || { echo "gh stand-in: $*" >&2; exit 1; }
shift
method=GET; input=""; accept=""; url=""; fields=()
while [ $# -gt 0 ]; do
  case "$1" in
    -X|--method) method=$2; shift ;;
    --input) input=$2; shift ;;
    -H) accept=$2; shift ;;
    -f|-F) fields+=("$2"); shift ;;
    --jq) shift ;;
    *) url=$1 ;;
  esac
  shift
done
val() { local f; for f in "${fields[@]}"; do [ "${f%%=*}" = "$1" ] && { printf '%s' "${f#*=}"; return 0; }; done; return 1; }
case "$url" in
  repos/*/releases)
    n=$(( $(ls -d "$S"/r* 2>/dev/null | wc -l) + 1 )); d="$S/r$n"; mkdir -p "$d/assets"
    val tag_name > "$d/tag"; val draft > "$d/draft"; val body > "$d/body"; echo "r$n" ;;
  https://uploads.github.com/*) id=${url#*/releases/}; id=${id%%/*}; cp "$input" "$S/$id/assets/${url##*name=}" ;;
  repos/*/releases/*/assets) id=${url#*/releases/}; id=${id%/assets}; for a in "$S/$id"/assets/*; do printf '%s\t%s\n' "$id/assets/${a##*/}" "${a##*/}"; done ;;
  repos/*/releases/assets/*) cat "$S/${url#*/releases/assets/}" ;;
  repos/*/releases/*)
    d="$S/${url##*/}"; t=$(val tag_name) && echo "$t" > "$d/tag"; v=$(val draft) && echo "$v" > "$d/draft"
    [ "$(cat "$d/tag")" != nightly ] || [ "$(cat "$d/draft")" != false ] || cp "$d/assets/latest.json" "$S/nightly.json" ;;
  *) echo "gh stand-in: $url" >&2; exit 1 ;;
esac
GH
cat > "$pub/bin/curl" <<'CURL'
#!/bin/bash
# Honors -o and -w '%{http_code}' like curl -sSL. STUB_CURL: neterr (no answer), 500, badjson; otherwise the feed
# when one was published, else 404.
out=/dev/stdout
while [ $# -gt 0 ]; do [ "$1" = -o ] && { out=$2; shift; }; shift; done
case "${STUB_CURL:-}" in
  neterr) exit 6 ;;
  500) printf 'oops' > "$out"; printf 500 ;;
  badjson) printf '{"channel": "nightly"}' > "$out"; printf 200 ;;
  *) if [ -f "$STUB_STATE/nightly.json" ]; then cat "$STUB_STATE/nightly.json" > "$out"; [ "$out" = /dev/stdout ] || printf 200; else printf 404; fi ;;
esac
CURL
chmod +x "$pub/bin/gh" "$pub/bin/curl" "$pub/scripts/"*.sh
out=$(STUB_STATE="$pub/state" POLYCARP_FEED_ARCHS=arm64 PATH="$pub/bin:$PATH" bash "$pub/scripts/publish-channel.sh" nightly 2>&1) \
  || bad "publish-channel.sh nightly failed against the stand-in: $out"
rolling=$(for d in "$pub"/state/r*; do [ "$(cat "$d/tag" 2>/dev/null)" = nightly ] && echo "$d"; done)
if [ -z "$rolling" ]; then bad "publish-channel.sh left no release tagged nightly"
else
  expect "the rolling nightly is published" "$(cat "$rolling/draft")" false
  for f in Polycarp.zip Polycarp.zip.sha256 latest.json; do [ -f "$rolling/assets/$f" ] || bad "the rolling nightly has no $f"; done
  # Release.marker, Updates.isNewer and Updates.candidates from main before #456, for a nightly-channel copy
  # built from an older commit.
  python3 -I - "$rolling/body" "$c" "$pdate" <<'PY' || bad "a build from before the channels would not take the rolling nightly"
import sys, datetime
body, commit, date = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3]
line = next((l for l in body.split("\n") if "<!-- baneyspaces " in l), None)
assert line, "no marker line"
got = {}
for field in line.split(" "):
    k, eq, v = field.partition("=")
    if not eq: continue
    if k == "commit" and len(v) >= 7 and all(ch in "0123456789abcdefABCDEF" for ch in v): got["commit"] = v
    if k == "date": got["date"] = datetime.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ")
assert got.get("commit") == commit, f"marker commit {got.get('commit')}"
assert got.get("date") == datetime.datetime.strptime(date, "%Y-%m-%dT%H:%M:%SZ"), "marker date"
assert got["date"] > datetime.datetime(2026, 11, 21, 4, 17, 31), "not newer than a 0.3.0 build from fdc42684"
PY
fi

# A publish that can't confirm its checks publishes nothing. Each run starts from an empty stand-in.
# sol-F1/first-F1: verify-release.sh failing on the downloaded draft. sol-F2: a feed that can't be read, so the
# version guard can't run. Each must exit non-zero and leave no published release.
refuses() { # <what> <env...>
  local what=$1 st="$tmp/refuse-$RANDOM" o; shift; mkdir -p "$st"
  if o=$(env "$@" STUB_STATE="$st" POLYCARP_FEED_ARCHS=arm64 PATH="$pub/bin:$PATH" bash "$pub/scripts/publish-channel.sh" nightly 2>&1); then
    bad "publish-channel.sh went ahead when $what: $o"
  fi
  for d in "$st"/r*; do [ "$(cat "$d/draft" 2>/dev/null)" != false ] || bad "$what, yet $(cat "$d/tag") was published"; done
}
refuses "verify-release.sh failed" STUB_VERIFY_FAIL=1
refuses "the feed didn't answer" STUB_CURL=neterr
refuses "the feed answered HTTP 500" STUB_CURL=500
refuses "the feed named no version" STUB_CURL=badjson

# sol-F3: release.sh --soak publishes only the build the receipt soaked, by binary sha256 and build stamp.
sk="$tmp/soak"; mkdir -p "$sk/app/Polycarp.app/Contents/MacOS" "$sk/rel"
printf 'build A' > "$sk/app/Polycarp.app/Contents/MacOS/Polycarp"
python3 -I -c 'import plistlib,sys; plistlib.dump({"CFBundleVersion": "412"}, open(sys.argv[1], "wb"))' "$sk/app/Polycarp.app/Contents/Info.plist"
ditto -c -k --keepParent "$sk/app/Polycarp.app" "$sk/rel/Polycarp.zip"
shaA=$(shasum -a 256 "$sk/app/Polycarp.app/Contents/MacOS/Polycarp" | awk '{print $1}')
printf 'candidate version=0.4.0 commit=%s sha256=%s build=412\nSOAK PASSED\n' "$c" "$shaA" > "$sk/a.receipt"
scripts/soak-matches.sh "$sk/a.receipt" "$sk/rel" "$c" 2>/dev/null || bad "soak-matches.sh refused the build its receipt soaked"
scripts/soak-matches.sh "$sk/a.receipt" "$sk/rel" 0000000 2>/dev/null && bad "soak-matches.sh took a receipt for another commit"
printf 'candidate version=0.4.0 commit=%s sha256=%s build=411\nSOAK FAILED\n%s' "$c" "$shaA" "$(cat "$sk/a.receipt")" > "$sk/b.receipt"
scripts/soak-matches.sh "$sk/b.receipt" "$sk/rel" "$c" 2>/dev/null || bad "soak-matches.sh should read the receipt's last soak"
printf 'build B' > "$sk/app/Polycarp.app/Contents/MacOS/Polycarp"; rm "$sk/rel/Polycarp.zip"
ditto -c -k --keepParent "$sk/app/Polycarp.app" "$sk/rel/Polycarp.zip"
scripts/soak-matches.sh "$sk/a.receipt" "$sk/rel" "$c" 2>/dev/null && bad "soak-matches.sh took build A's receipt for build B (sol-F3)"
grep -q 'scripts/soak-matches.sh "$SOAK" "$BACK" "$TAG_COMMIT"' scripts/release.sh || bad "release.sh --soak must run soak-matches.sh on the downloaded draft"

# CI signing fails closed: no secrets is "publish nothing" (exit 3), a bad secret or a named identity that isn't
# there stops the build, and neither falls back to ad-hoc or makes a key.
env -u POLYCARP_SIGNING_P12 -u POLYCARP_SIGNING_P12_PASSWORD scripts/ci-signing.sh >/dev/null 2>&1; code=$?
expect "ci-signing without secrets" "$code" 3
POLYCARP_SIGNING_P12=eA== POLYCARP_SIGNING_P12_PASSWORD='a b' RUNNER_TEMP="$tmp" GITHUB_ENV="$tmp/env" scripts/ci-signing.sh >/dev/null 2>&1 \
  && bad "ci-signing took a password security -i would split"
[ ! -e "$tmp/env" ] && [ -z "$(ls -d "$tmp"/signing.* 2>/dev/null)" ] || bad "ci-signing changed something before refusing"
# A keychain secret (what set-ci-signing.sh sends) is unlocked in place with its own password, not imported as a .p12:
# an empty one becomes the runner's keychain, still opened by the secret's password (a .p12 import makes a new one
# with a random password), then stops for want of a key.
ek="$tmp/empty.keychain-db"; printf '%s\n' "create-keychain -p emptypass \"$ek\"" | security -i >/dev/null
out=$(POLYCARP_SIGNING_P12=$(base64 < "$ek" | tr -d '\n') POLYCARP_SIGNING_P12_PASSWORD=emptypass RUNNER_TEMP="$tmp/ek" GITHUB_ENV="$tmp/ek/env" \
  bash -c 'mkdir -p "$RUNNER_TEMP"; scripts/ci-signing.sh' 2>&1); code=$?
placed=$(ls "$tmp"/ek/signing.*/polycarp-ci.keychain-db 2>/dev/null | head -1)
[ "$code" != 0 ] && [ -n "$placed" ] && printf '%s\n' "unlock-keychain -p emptypass \"$placed\"" | security -i 2>&1 | { ! grep -q .; } || bad "ci-signing didn't place a keychain secret as it is: exit $code: $out"
security delete-keychain "$ek" 2>/dev/null; [ -n "$placed" ] && security delete-keychain "$placed" 2>/dev/null
[ ! -e "$tmp/ek/env" ] || bad "ci-signing wrote GITHUB_ENV from an empty keychain"
POLYCARP_SIGNING_IDENTITY=nobody POLYCARP_SIGNING_KEYCHAIN="$tmp/none.keychain-db" scripts/signing-identity.sh >/dev/null 2>&1 \
  && bad "signing-identity.sh accepted a CI identity that isn't in its keychain"
grep -q 'POLYCARP_SIGNING_IDENTITY:-}" ] || { echo "bundle: the signing identity' scripts/bundle.sh || bad "bundle.sh can fall back to ad-hoc with a CI identity named"
# Workflows: a build step runs only once signed, and no workflow ever publishes a stable release (the Mac does,
# after the soak).
for wf in channel-build stable-build; do
  f=../.github/workflows/$wf.yml
  # Each step (a "      - " line and what follows it) that runs release.sh carries the signed condition.
  awk -v want="        if: steps.sign.outputs.signed == 'true'" '
    function step() { if (on && s ~ /release\.sh/ && s !~ /ci-signing\.sh/) { n++; if (index(s, "\n" want "\n") == 0) miss = 1 } s = "" }
    /^      - / { step(); on = 1 }
    { s = s "\n" $0 }
    END { s = s "\n"; step(); exit !(n && !miss) }
  ' "$f" || bad "$wf.yml runs release.sh without the signing identity"
done
# This repository is public: no job runs on a self-hosted runner, and the builds run on GitHub's hosted macOS.
if grep -nE 'runs-on:.*self-hosted|^ *- *self-hosted' ../.github/workflows/*.yml; then bad "a workflow uses a self-hosted runner"; fi
for wf in channel-build stable-build; do
  [ "$(grep -E '^ +runs-on:' "../.github/workflows/$wf.yml" | sed 's/^ *runs-on: *//' | sort -u)" = macos-15 ] || bad "$wf.yml doesn't build on macos-15"
done
# Comments and echoed advice may name the Mac's publish step; a command may not.
if grep -nE -- '--soak|draft=false|--draft=false|make_latest=true|--latest( |$)' ../.github/workflows/*.yml \
  | grep -vE '^[^:]+:[0-9]+: *(#|echo )'; then bad "a workflow publishes a release by itself"; fi


[ $status = 0 ] && echo "channels-test: pass"
exit $status
