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
POLYCARP_FEED_ARCHS=ppc scripts/write-feed.sh nightly "$(scripts/channel-version.sh nightly)" "$c" "$tmp/Polycarp.zip" "$tmp/x.json" >/dev/null 2>&1 \
  && bad "a feed with no Mac architecture was written"
# CI signing fails closed: no secrets is "publish nothing" (exit 3), a bad secret or a named identity that isn't
# there stops the build, and neither falls back to ad-hoc or makes a key.
env -u POLYCARP_SIGNING_P12 -u POLYCARP_SIGNING_P12_PASSWORD scripts/ci-signing.sh >/dev/null 2>&1; code=$?
expect "ci-signing without secrets" "$code" 3
POLYCARP_SIGNING_P12=eA== POLYCARP_SIGNING_P12_PASSWORD='a b' RUNNER_TEMP="$tmp" GITHUB_ENV="$tmp/env" scripts/ci-signing.sh >/dev/null 2>&1 \
  && bad "ci-signing took a password security -i would split"
[ ! -e "$tmp/env" ] && [ -z "$(ls -d "$tmp"/signing.* 2>/dev/null)" ] || bad "ci-signing changed something before refusing"
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
# Comments and echoed advice may name the Mac's publish step; a command may not.
if grep -nE -- '--soak|draft=false|--draft=false|make_latest=true|--latest( |$)' ../.github/workflows/*.yml \
  | grep -vE '^[^:]+:[0-9]+: *(#|echo )'; then bad "a workflow publishes a release by itself"; fi

[ $status = 0 ] && echo "channels-test: pass"
exit $status
