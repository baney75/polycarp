#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Makes what `polycarp browser install --dry-run` reads on Windows: scripts/build-parts-windows.sh DEST
# DEST gets make-browser/launcher.exe, make-browser/changes.toml, make-browser/LICENSE and extension/. Point
# POLYCARP_BROWSER_RESOURCES at DEST. It runs in Git Bash on Windows, and on a Mac or Linux for its own check, where the
# launcher it copies is that system's program under the Windows name.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/build-parts-windows.sh DEST" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST=$1
BUILD=${POLYCARP_PARTS_BUILD:-$HERE/launcher/target}
# DEST is deleted first, so it must be new, empty, or parts this script made before; never a folder of anything else.
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST")" ]; then
  extra=$(ls -A "$DEST" | grep -vx -e make-browser -e extension || true)
  [ -z "$extra" ] || { echo "build-parts-windows.sh: $DEST holds more than parts; give a new folder" >&2; exit 2; }
fi
rm -rf "$DEST"; mkdir -p "$DEST/make-browser" "$BUILD"
cargo build --quiet --release --locked --manifest-path "$HERE/launcher/Cargo.toml" --target-dir "$BUILD"
MADE=$BUILD/release/polycarp-browser-launcher
[ -f "$MADE.exe" ] && MADE=$MADE.exe
cp "$MADE" "$DEST/make-browser/launcher.exe"
cp "$HERE/changes.toml" "$HERE/LICENSE" "$DEST/make-browser/"

"$HERE/scripts/stage-extension.sh" "$DEST/extension"
echo "parts in $DEST"
