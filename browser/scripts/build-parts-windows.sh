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

EXT=$HERE/../spaces/extension
if command -v rsync >/dev/null && command -v python3 >/dev/null; then
  "$EXT/scripts/stage.sh" "$DEST/extension" >/dev/null
else
  # Windows runners have no rsync, which stage.sh needs, so Python copies the tree leaving out what stage.sh's rsync does:
  # /tests, /scripts, /docs and /*.md at the top, and dev-*, dot files and *.map anywhere.
  PY=$(command -v python3 || command -v python)
  "$PY" -I - "$EXT" "$DEST/extension" <<'PY'
import fnmatch, shutil, sys
src, dest = sys.argv[1], sys.argv[2]
def skip(folder, names):
    top = folder == src
    out = set()
    for n in names:
        if top and (n in ("tests", "scripts", "docs") or n.endswith(".md")):
            out.add(n)
        elif fnmatch.fnmatch(n, "dev-*") or n.startswith(".") or n.endswith(".map"):
            out.add(n)
    return out
shutil.copytree(src, dest, ignore=skip)
PY
fi
echo "parts in $DEST"
