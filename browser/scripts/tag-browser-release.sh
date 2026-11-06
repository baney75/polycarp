#!/bin/bash
# Tags the commit a store upload came from as browser-v<version>, which the setup prompt builds the helper from.
# Refuses until cli/src/install.ts has the id Google assigned: a helper built from a tag without it could never talk to
# the store extension, and a tag doesn't move later. --check only says whether it would refuse.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
if ! grep -Eq 'STORE_EXTENSION_ID: string = "[a-p]{32}"' "$here/cli/src/install.ts"; then
  echo "STORE_EXTENSION_ID in cli/src/install.ts is empty. Upload the draft, set the id Google assigns, then tag." >&2
  exit 1
fi
[ "${1:-}" = "--check" ] && exit 0
version="$(node -p "require('$here/static/manifest.chrome.json').version")"
git -C "$here" tag -a "browser-v$version" -m "Polycarp browser $version"
git -C "$here" push origin "browser-v$version"
echo "Tagged browser-v$version"
