#!/bin/bash
# Builds the zip for the Chrome Web Store: scripts/build-store.sh <out dir>
# The normal build, minus the debug page, the source maps and the dev `key` (Google assigns the store
# id). scripts/store-package.mjs checks the result and fails the build if any of it came back.
set -euo pipefail
out="${1:?usage: build-store.sh <out dir>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$here"
TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR="$work/ext" npm run --silent build
node scripts/store-package.mjs prepare "$work/ext" "$here"
node scripts/store-package.mjs check "$work/ext"
version="$(node -p "require('$work/ext/manifest.json').version")"
zip_path="$out/polycarp-$version.zip"
rm -f "$zip_path"
(cd "$work/ext" && zip -qr -X "$zip_path" .)
echo "$zip_path ($(du -h "$zip_path" | cut -f1), $(find "$work/ext" -type f | wc -l | tr -d ' ') files)"
