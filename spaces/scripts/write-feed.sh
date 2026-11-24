#!/bin/bash
# Writes the update feed, latest.json, for the zip a release carries (docs/releases.md):
#   scripts/write-feed.sh <version> <commit> <zip> <out> [notes]
# The format is Tauri v2's updater manifest plus product, channel, commit, protocol and sha256. Polycarp's Mac
# app does not use Tauri's minisign check: an update is trusted by its code signature (release-requirement.txt)
# and the zip's sha256, so `signature` is empty and `requirement` names what the installer checks.
# `channel` stays "nightly", the name every installed copy reads it by. The darwin keys list the architectures the
# app inside the zip holds, read with lipo.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "write-feed.sh: $*" >&2; exit 1; }
[ $# -ge 4 ] || fail "usage: scripts/write-feed.sh <version> <commit> <zip> <out> [notes]"
CHANNEL=nightly VERSION=$1 COMMIT=$2 ZIP=$3 OUT=$4 NOTES=${5:-}
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "the commit must be a full 40-character sha."
TIME=$(printf '%s' "$VERSION" | sed -nE 's/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-nightly\.([0-9]{14})\+[0-9a-f]{7}$/\4/p')
[ -n "$TIME" ] || fail "\"$VERSION\" isn't a release version: X.Y.Z-nightly.YYYYMMDDHHMMSS+<sha7>."
[ -f "$ZIP" ] || fail "$ZIP doesn't exist."
# The url names the immutable nightly-<time> release, so any copy of this feed (one re-published to roll back)
# still matches its sha256 after the next build.
DOWNLOAD="https://github.com/baney75/polycarp/releases/download/nightly-$TIME"
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
