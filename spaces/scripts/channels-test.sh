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
[ $status = 0 ] && echo "channels-test: pass"
exit $status
