#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copies spaces/extension into DEST as Polycarp Browser builds it in: scripts/stage-extension.sh DEST
# Shared by build-parts-windows.sh and build-parts-linux.sh.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/stage-extension.sh DEST" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST=$1
EXT=$HERE/../spaces/extension
if command -v rsync >/dev/null && command -v python3 >/dev/null; then
  "$EXT/scripts/stage.sh" "$DEST" >/dev/null
else
  # Windows runners have no rsync, which stage.sh needs, so Python copies the tree leaving out what stage.sh's rsync does:
  # /tests, /scripts, /docs and /*.md at the top, and dev-*, dot files and *.map anywhere.
  PY=$(command -v python3 || command -v python)
  "$PY" -I - "$EXT" "$DEST" <<'PY'
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
