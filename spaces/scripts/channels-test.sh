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
printf '#!/bin/bash\nexit 0\n' > "$pub/scripts/verify-release.sh"
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
printf '#!/bin/bash\n[ -f "$STUB_STATE/nightly.json" ] && cat "$STUB_STATE/nightly.json" || exit 22\n' > "$pub/bin/curl"
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
[ $status = 0 ] && echo "channels-test: pass"
exit $status
