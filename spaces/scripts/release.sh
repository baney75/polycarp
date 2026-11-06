#!/bin/bash
# Soak gate: run scripts/soak-check.sh on rectory1 and keep the receipt before marking Latest/stable.
# Builds, signs and uploads the prebuilt app for a stable release. Run it on the owner's Mac
# (the signing key never leaves it) after pushing the tag:
#   git tag v0.2.2 && git push origin v0.2.2     # the Release workflow writes the notes
#   make release                                 # uploads Polycarp.zip, .sha256 and .dmg, then publishes
# The Release workflow creates the release as a draft. This uploads the files, checks them again as
# uploaded, and only then publishes it, so nobody is offered a release without its app.
# --dry-run does everything except the tag check, the upload and the publish, so it can run on a branch.
# --preview builds for Apple silicon only, signs with the real identity, and publishes a prerelease named `preview`
# with Polycarp.zip and its .sha256 (no disk image), replacing the assets of the last preview. It needs no version tag:
# the `preview` tag is moved to HEAD, which must already be pushed. install.sh downloads this release on Apple silicon.
#   scripts/release.sh --preview [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0
PREVIEW=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --preview) PREVIEW=1 ;;
    *) echo "usage: scripts/release.sh [--preview] [--dry-run]" >&2; exit 1 ;;
  esac
done
VERSION=$(cat VERSION)
TAG="v$VERSION"
[ "$PREVIEW" = 0 ] || TAG=preview
REQ=$(cat scripts/release-requirement.txt)
bold=$(tput bold 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
fail() { echo "release.sh: $*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || fail "the working tree isn't clean. Commit or stash first, so the app matches a commit."
# The app holds the browser helper, built with Bun from the pinned sibling repos: a release is built with everything.
command -v bun >/dev/null || fail "Bun isn't installed (https://bun.sh); the browser helper can't be built without it."
if [ ! -d ../mini-lit ] || [ ! -d ../pi-mono ] || [ ! -d ../browser/node_modules ]; then
  step "Checking out the browser's sibling repos"
  ../browser/scripts/setup-siblings.sh
fi
if [ "$PREVIEW" = 1 ]; then
  # Apple silicon only, and still the stable signing identity (never ad-hoc).
  export BANEYSPACES_ARM64_ONLY=1
  unset BANEYSPACES_ADHOC
  if [ "$DRY" = 0 ]; then
    git fetch --quiet origin || fail "couldn't reach origin."
    [ -n "$(git branch -r --contains HEAD 2>/dev/null)" ] || fail "HEAD isn't on origin. Push the branch first, so the preview matches a commit anyone can see."
    # A real release may not be moving a published stable tag.
    [ "$(git ls-remote origin refs/tags/preview | wc -l)" -le 1 ] || fail "origin has more than one preview ref."
  fi
elif [ "$DRY" = 0 ]; then
  TAG_COMMIT=$(git rev-parse --verify --quiet "refs/tags/$TAG^{commit}") || fail "tag $TAG doesn't exist. Tag the release commit first."
  [ "$TAG_COMMIT" = "$(git rev-parse HEAD)" ] || fail "HEAD isn't the commit of $TAG. Check out the tag, or move VERSION to match."
  # The remote must have the same tag on the same commit (an annotated tag shows its commit on the ^{} line).
  # ls-remote lists the tag itself before its peeled ^{} line, so take the ^{} line when there is one
  # (v0.3.0, 2026-10-30: taking the first line compared a tag object with the commit).
  LS=$(git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}") || fail "couldn't reach origin to check $TAG."
  REMOTE=$(printf '%s\n' "$LS" | awk '$2 ~ /\^\{\}$/ { peeled = $1 } { first = first ? first : $1 } END { print peeled ? peeled : first }')
  [ "$REMOTE" = "$TAG_COMMIT" ] || fail "origin doesn't have $TAG on this commit. Push the tag first (git push origin $TAG)."
  # Only the draft the Release workflow made: a published release is already being offered, so its
  # files must never change under people. Fix forward with a new patch version.
  # (Listed through the API: a draft has no public page, and `gh release view` may not find it by tag.)
  [ "$(gh api "repos/{owner}/{repo}/releases?per_page=100" --jq "[.[] | select(.tag_name == \"$TAG\") | .draft] | first" 2>/dev/null)" = true ] \
    || fail "$TAG is already published (or has no draft release yet). Release a new patch version, or let the Release workflow finish first."
  # A real release is universal and uses the stable identity, whatever this shell has set.
  unset BANEYSPACES_ARM64_ONLY BANEYSPACES_ADHOC
fi

step "Building $TAG"
scripts/bundle.sh
codesign -v -R "=$REQ" build/Polycarp.app 2>/dev/null \
  || fail "bundle.sh didn't sign with the release identity (it fell back to ad-hoc or used another key). Nothing was packaged."
if [ "$DRY" = 0 ] && [ "$PREVIEW" = 0 ]; then
  ARCHS=$(lipo -archs build/Polycarp.app/Contents/MacOS/Polycarp)
  [ "$ARCHS" = "x86_64 arm64" ] || [ "$ARCHS" = "arm64 x86_64" ] || fail "the app isn't universal ($ARCHS)."
fi

step "Packaging"
if [ "$PREVIEW" = 1 ]; then NODMG=--no-dmg; else NODMG=; fi
scripts/package.sh $NODMG
# The files are checked as a person would get them, before anything is uploaded.
step "Checking the zip$([ "$PREVIEW" = 1 ] || echo ", the disk image") and the checksum"
if [ "$PREVIEW" = 1 ]; then scripts/verify-release.sh --no-dmg build; else
scripts/verify-release.sh build
fi

if [ "$DRY" = 1 ]; then
  echo "dry run: $TAG not uploaded. The files are in build/."
  exit 0
fi
if [ "$PREVIEW" = 1 ]; then
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
  gh release upload preview build/Polycarp.zip build/Polycarp.zip.sha256 --clobber
  for old in $(gh release view preview --json assets --jq '.assets[].name'); do
    case "$old" in Polycarp.zip|Polycarp.zip.sha256) ;; *) gh release delete-asset preview "$old" --yes ;; esac
  done
  BACK=$(mktemp -d); trap 'rm -rf "$BACK"' EXIT
  gh release download preview --dir "$BACK" --pattern 'Polycarp.zip' --pattern 'Polycarp.zip.sha256'
  for f in Polycarp.zip Polycarp.zip.sha256; do cmp -s "build/$f" "$BACK/$f" || fail "the uploaded $f differs from the one built."; done
  scripts/verify-release.sh --no-dmg "$BACK"
  echo "published the preview prerelease with Polycarp.zip and Polycarp.zip.sha256"
  exit 0
fi
# The release is a draft until the files are up and checked again; the updater never offers a draft.
step "Uploading to $TAG"
gh release upload "$TAG" build/Polycarp.zip build/Polycarp.zip.sha256 build/Polycarp.dmg --clobber
step "Checking what was uploaded"
BACK=$(mktemp -d)
trap 'rm -rf "$BACK"' EXIT
gh release download "$TAG" --dir "$BACK" --pattern 'Polycarp.zip' --pattern 'Polycarp.zip.sha256' --pattern 'Polycarp.dmg'
for f in Polycarp.zip Polycarp.zip.sha256 Polycarp.dmg; do
  cmp -s "build/$f" "$BACK/$f" || fail "the uploaded $f differs from the one built. $TAG stays unpublished."
done
scripts/verify-release.sh "$BACK"
step "Publishing $TAG"
gh release edit "$TAG" --draft=false --latest
echo "published $TAG with Polycarp.zip, Polycarp.zip.sha256 and Polycarp.dmg"
