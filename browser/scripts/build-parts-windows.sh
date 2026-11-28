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
rm -rf "$DEST"; mkdir -p "$DEST/make-browser" "$BUILD"
cargo build --quiet --release --locked --manifest-path "$HERE/launcher/Cargo.toml" --target-dir "$BUILD"
MADE=$BUILD/release/polycarp-browser-launcher
[ -f "$MADE.exe" ] && MADE=$MADE.exe
cp "$MADE" "$DEST/make-browser/launcher.exe"
cp "$HERE/changes.toml" "$HERE/LICENSE" "$DEST/make-browser/"

EXT=$HERE/../spaces/extension
if command -v rsync >/dev/null && command -v python3 >/dev/null; then
  "$EXT/scripts/stage.sh" "$DEST/extension" >/dev/null
else
  # Windows runners have no rsync, which stage.sh needs, so the same tree is copied without what it leaves out.
  cp -R "$EXT" "$DEST/extension"
  rm -rf "$DEST/extension/tests" "$DEST/extension/scripts" "$DEST/extension/docs"
fi
echo "parts in $DEST"
