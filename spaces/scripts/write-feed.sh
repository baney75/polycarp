#!/bin/bash
# Writes the channel's update feed, latest.json, for the zip a release carries (docs/releases.md):
#   scripts/write-feed.sh <channel> <version> <commit> <zip> <out> [notes]
# The format is Tauri v2's updater manifest plus product, channel, commit, protocol and sha256. Polycarp's Mac
# app does not use Tauri's minisign check: an update is trusted by its code signature (release-requirement.txt)
# and the zip's sha256, so `signature` is empty and `requirement` names what the installer checks.
# The darwin keys list the architectures the app inside the zip holds, read with lipo.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "write-feed.sh: $*" >&2; exit 1; }
[ $# -ge 5 ] || fail "usage: scripts/write-feed.sh <channel> <version> <commit> <zip> <out> [notes]"
CHANNEL=$1 VERSION=$2 COMMIT=$3 ZIP=$4 OUT=$5 NOTES=${6:-}
case "$CHANNEL" in stable|nightly|dev) ;; *) fail "the channel is stable, nightly or dev, not \"$CHANNEL\"." ;; esac
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "the commit must be a full 40-character sha."
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
[[ "$VERSION" =~ $SEMVER ]] || fail "\"$VERSION\" is not a SemVer version."
if [ "$CHANNEL" = stable ]; then [[ "$VERSION" != *-* ]] || fail "a stable version has no pre-release part."
else [[ "$VERSION" == *"-$CHANNEL."* ]] || fail "a $CHANNEL version reads X.Y.Z-$CHANNEL.<time>+<sha7>."; fi
[ -f "$ZIP" ] || fail "$ZIP doesn't exist."
# The url names a release whose files never change, so any copy of this feed (the nightly-<time> release, the
# bridge's preview/latest.json, a feed re-published to roll back) still matches its sha256 after the next build.
# Dev keeps only its rolling release, so a dev feed is good until the next dev build and can't be rolled back to.
case "$CHANNEL" in
  stable) DOWNLOAD="https://github.com/baney75/polycarp/releases/download/v$VERSION" ;;
  nightly)
    TIME=$(printf '%s' "$VERSION" | sed -n 's/.*-nightly\.\([0-9]\{14\}\)+.*/\1/p')
    [ -n "$TIME" ] || fail "a nightly version carries its build time: X.Y.Z-nightly.YYYYMMDDHHMMSS+<sha7>."
    DOWNLOAD="https://github.com/baney75/polycarp/releases/download/nightly-$TIME" ;;
  dev) DOWNLOAD="https://github.com/baney75/polycarp/releases/download/dev" ;;
esac
# POLYCARP_FEED_ARCHS stands in for lipo in tests (a fake zip has no app in it).
ARCHS="${POLYCARP_FEED_ARCHS:-}"
if [ -z "$ARCHS" ]; then
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  ditto -x -k "$ZIP" "$TMP" && ARCHS=$(lipo -archs "$TMP/Polycarp.app/Contents/MacOS/Polycarp") || fail "couldn't read the app's architectures from $ZIP."
fi
SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
python3 -I - "$CHANNEL" "$VERSION" "$COMMIT" "$SHA" "$DOWNLOAD/Polycarp.zip" "$(cat scripts/release-requirement.txt)" "$NOTES" "$ARCHS" > "$OUT" <<'PY'
import json, sys, datetime
channel, version, commit, sha, url, requirement, notes, archs = sys.argv[1:9]
keys = {"arm64": "darwin-aarch64", "x86_64": "darwin-x86_64"}
platforms = {keys[a]: {"url": url, "signature": "", "sha256": sha, "requirement": requirement} for a in archs.split() if a in keys}
if not platforms:
    sys.exit("write-feed.sh: the app holds no architecture a Mac runs")
print(json.dumps({
    "product": "polycarp", "channel": channel, "version": version, "commit": commit,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "notes": notes, "protocol": 1, "platforms": platforms,
}, indent=2))
PY
echo "wrote $OUT ($CHANNEL $VERSION)"
