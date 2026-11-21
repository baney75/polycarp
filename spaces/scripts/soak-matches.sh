#!/bin/bash
# soak-matches.sh <receipt> <release dir> <commit>: exits 0 only when the receipt's last soak ran the exact build in
# <release dir>/Polycarp.zip, at <commit>: same binary sha256 and same build stamp. release.sh --soak runs it, so a
# draft whose files were replaced after the soak (a rerun at the same commit) never goes out on an old receipt.
set -euo pipefail
RECEIPT=$1 DIR=$2 COMMIT=$3
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
ditto -x -k "$DIR/Polycarp.zip" "$W"
APP="$W/Polycarp.app"
SHA=$(shasum -a 256 "$APP/Contents/MacOS/Polycarp" | awk '{print $1}')
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")
LAST=$(grep '^candidate ' "$RECEIPT" | tail -1 || true)
printf '%s\n' "$LAST" | awk -v c="commit=$COMMIT" -v s="sha256=$SHA" -v b="build=$BUILD" \
  'NF == 5 && $3 == c && $4 == s && $5 == b { ok = 1 } END { exit !ok }' && exit 0
echo "soak-matches.sh: the receipt's last soak ran another build than this one (commit $COMMIT, sha256 $SHA, build $BUILD)." >&2
exit 1
