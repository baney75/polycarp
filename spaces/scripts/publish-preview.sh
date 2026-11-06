#!/bin/bash
# Publishes build/Polycarp.zip, build/Polycarp.zip.sha256 and build/Polycarp.dmg as the prerelease named `preview`, replacing the last preview's
# assets. Run by `scripts/release.sh --preview` after it has built, signed, packaged and verified the zip; never by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "publish-preview.sh: $*" >&2; exit 1; }
step() { printf '==> %s\n' "$*"; }
step "Publishing the preview prerelease"
# The tag moves to this commit; the release is a prerelease, never Latest, so the stable updater ignores it.
git tag -f preview HEAD
git push --force origin refs/tags/preview
if gh release view preview >/dev/null 2>&1; then
  gh release edit preview --prerelease --latest=false --title "Preview" --notes "Apple silicon build of $(git rev-parse --short HEAD). Not a stable release."
else
  gh release create preview --prerelease --title "Preview" --notes "Apple silicon build of $(git rev-parse --short HEAD). Not a stable release." --verify-tag
fi
# Replace the earlier preview's assets: upload over the same names, and remove any other asset.
gh release upload preview build/Polycarp.zip build/Polycarp.zip.sha256 build/Polycarp.dmg --clobber
for old in $(gh release view preview --json assets --jq '.assets[].name'); do
  case "$old" in Polycarp.zip|Polycarp.zip.sha256|Polycarp.dmg) ;; *) gh release delete-asset preview "$old" --yes ;; esac
done
BACK=$(mktemp -d); trap 'rm -rf "$BACK"' EXIT
gh release download preview --dir "$BACK" --pattern 'Polycarp.zip' --pattern 'Polycarp.zip.sha256' --pattern 'Polycarp.dmg'
for f in Polycarp.zip Polycarp.zip.sha256 Polycarp.dmg; do cmp -s "build/$f" "$BACK/$f" || fail "the uploaded $f differs from the one built."; done
scripts/verify-release.sh "$BACK"
echo "published the preview prerelease with Polycarp.zip, Polycarp.zip.sha256 and Polycarp.dmg"
