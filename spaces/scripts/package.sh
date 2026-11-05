#!/bin/bash
# Packages build/Polycarp.app for a release:
#   build/Polycarp.zip         what install.sh and the updater download
#   build/Polycarp.zip.sha256  its checksum
#   build/Polycarp.dmg         the disk image for people who download in a browser
# It refuses any app that isn't signed with the release identity (scripts/release-requirement.txt),
# so an ad-hoc or wrong-key build can never be packaged.
# The disk image is made without Finder: dmgbuild (pip, in a venv under ~/Library/Caches) writes it.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/product.env
APP=build/$PRODUCT_NAME.app
# The one place the release identity is written; the app's identifier in it is BUNDLE_ID (a test keeps them equal).
REQ=$(cat scripts/release-requirement.txt)
fail() { echo "package.sh: $*" >&2; exit 1; }

[ -d "$APP" ] || fail "$APP doesn't exist. Run scripts/bundle.sh first."
codesign -v -R "=$REQ" "$APP" 2>/dev/null \
  || fail "$APP isn't signed with the $PRODUCT_NAME release identity (ad-hoc or another key), so it won't be packaged. Run scripts/bundle.sh on the owner's Mac with the stable identity."

rm -f "build/$PRODUCT_NAME.zip" "build/$PRODUCT_NAME.zip.sha256" "build/$PRODUCT_NAME.dmg"
ditto -c -k --keepParent "$APP" "build/$PRODUCT_NAME.zip"
(cd build && shasum -a 256 "$PRODUCT_NAME.zip" > "$PRODUCT_NAME.zip.sha256")

# Disk image: the app on the left, an Applications link on the right, over a drawn background.
# dmgbuild and what it needs are pinned by version and hash (scripts/dmg-requirements.txt) and live
# in a venv outside build/, which bundle.sh wipes. Nothing is installed system-wide.
VENV="${BANEYSPACES_RELEASE_VENV:-$HOME/Library/Caches/baneyspaces-release-venv}"
[ -x "$VENV/bin/pip" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --disable-pip-version-check --require-hashes -r scripts/dmg-requirements.txt
rm -rf build/dmg && mkdir -p build/dmg
swift scripts/make-dmg-background.swift build/dmg
tiffutil -cathidpicheck build/dmg/background.png build/dmg/background@2x.png -out build/dmg/background.tiff
"$VENV/bin/dmgbuild" -s scripts/dmg-settings.py \
  -D app="$APP" -D background=build/dmg/background.tiff \
  "$PRODUCT_NAME" "build/$PRODUCT_NAME.dmg" >/dev/null
rm -rf build/dmg
echo "packaged build/$PRODUCT_NAME.zip ($(du -h "build/$PRODUCT_NAME.zip" | cut -f1)) and build/$PRODUCT_NAME.dmg ($(du -h "build/$PRODUCT_NAME.dmg" | cut -f1))"
