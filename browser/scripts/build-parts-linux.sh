#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Makes what `polycarp browser install --dry-run` reads on Linux: scripts/build-parts-linux.sh DEST
# DEST gets make-browser/launcher (built for this computer), make-browser/changes.toml, make-browser/LICENSE and
# extension/. Point POLYCARP_BROWSER_RESOURCES at DEST.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/build-parts-linux.sh DEST" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST=$1
BUILD=${POLYCARP_PARTS_BUILD:-$HERE/launcher/target}
# DEST is deleted first, so it must be new, empty, or parts this script made before; never a folder of anything else.
refuse() { echo "build-parts-linux.sh: $DEST holds more than parts; give a new folder" >&2; exit 2; }
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  [ -d "$DEST" ] && [ ! -L "$DEST" ] || refuse
  for f in "$DEST"/* "$DEST"/.[!.]* "$DEST"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case ${f##*/} in make-browser | extension) ;; *) refuse ;; esac
  done
fi
rm -rf "$DEST"; mkdir -p "$DEST/make-browser" "$BUILD"
cargo build --quiet --release --locked -j 4 --manifest-path "$HERE/launcher/Cargo.toml" --target-dir "$BUILD"
cp "$BUILD/release/polycarp-browser-launcher" "$DEST/make-browser/launcher"
chmod 755 "$DEST/make-browser/launcher"
cp "$HERE/changes.toml" "$HERE/LICENSE" "$DEST/make-browser/"
"$HERE/scripts/stage-extension.sh" "$DEST/extension"
echo "parts in $DEST"
