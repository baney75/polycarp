#!/bin/bash
# Builds the browser piece of Polycarp into build/browser: the helper (polycarp-browser, one executable, no Node needed
# on the Mac), the extension folder, and the licences of what is compiled in. bundle.sh places the result in
# Polycarp.app/Contents/Resources/browser.
#   scripts/build-browser.sh                       universal helper (Apple silicon and Intel)
#   BANEYSPACES_ARM64_ONLY=1 scripts/build-browser.sh   arm64 only, the fast path for local work and CI
# Needs Node, Bun and the sibling repos browser/scripts/setup-siblings.sh checks out; none of them end up on the user's Mac.
set -euo pipefail
cd "$(dirname "$0")/.."
SPACES=$PWD
BROWSER=$SPACES/../browser
OUT=$SPACES/build/browser
rm -rf "$OUT" && mkdir -p "$OUT/extension" "$OUT/licenses"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

command -v bun >/dev/null || { echo "build-browser: bun is needed to compile the helper (https://bun.sh)" >&2; exit 1; }
command -v node >/dev/null || { echo "build-browser: node is needed to build the helper and the extension" >&2; exit 1; }
[ -d "$BROWSER/node_modules" ] && [ -d "$BROWSER/../mini-lit" ] && [ -d "$BROWSER/../pi-mono" ] || { echo "build-browser: run browser/scripts/setup-siblings.sh first (it checks out and builds the extension's siblings)" >&2; exit 1; }
[ -d "$BROWSER/cli/node_modules" ] || (cd "$BROWSER/cli" && npm ci --no-audit --no-fund)

# The helper. Both slices are compiled from one bundle, then joined; a universal file needs unsigned slices.
cd "$BROWSER/cli"
node scripts/compile.mjs --arch arm64 --out "$WORK/arm64"
if [ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ]; then
  cp "$WORK/arm64" "$OUT/polycarp-browser"
else
  node scripts/compile.mjs --arch x64 --out "$WORK/x64"
  codesign --remove-signature "$WORK/arm64" "$WORK/x64"
  lipo -create "$WORK/arm64" "$WORK/x64" -output "$OUT/polycarp-browser"
fi
chmod 755 "$OUT/polycarp-browser"

# The extension, the same build `npm run build` makes, without source maps and the test page. The version is not bumped.
(cd "$BROWSER" && TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR="$WORK/extension" node scripts/build.mjs >/dev/null)
rsync -a --exclude '*.map' --exclude 'test.html' "$WORK/extension/" "$OUT/extension/"
for f in manifest.json background.js sidepanel.js sidepanel.html app.css; do
  [ -s "$OUT/extension/$f" ] || { echo "build-browser: the extension build has no $f" >&2; exit 1; }
done

# Licences: the packages in the bundle, Bun, and Tabkyra's own.
cd "$BROWSER/cli"
node scripts/licenses.mjs --out "$OUT/licenses/polycarp-browser-packages.txt" --bun "$SPACES/LICENSES/bun-runtime.md"
cp "$BROWSER/LICENSE" "$OUT/licenses/tabkyra-AGPL-3.0.txt"
echo "built $OUT ($(lipo -archs "$OUT/polycarp-browser"), extension $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$OUT/extension/manifest.json" | head -1))"
