#!/bin/bash
# Builds, signs and uploads the prebuilt app on the owner's Mac (the signing key never leaves it), for one channel
# (docs/releases.md). No workflow starts on a pushed tag.
# Stable: promote.yml tags vX.Y.Z on the stable branch and makes the release as a draft with its notes. On the
# stable checkout at that tag:
#   scripts/release.sh                         uploads Polycarp.zip, .sha256, .dmg and latest.json, checks them as
#                                              uploaded and leaves the draft for the soak
#   scripts/release.sh --soak <receipt>        publishes the draft as Latest, only with a scripts/soak-check.sh
#                                              receipt that says SOAK PASSED for this commit (spaces/AGENTS.md)
# Nightly and dev: built from main for Apple silicon with the same signing identity, and published by
# scripts/publish-channel.sh. HEAD must already be on origin. --bridge (nightly) also replaces the old preview
# release's files, once, so copies that read preview move to nightly.
#   scripts/release.sh --channel nightly|dev [--bridge] [--dry-run]
# --dry-run does everything except the tag check, the upload and the publish, so it can run on a branch.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0
CHANNEL=stable
BRIDGE=""
SOAK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --channel) CHANNEL=${2:-}; shift ;;
    --bridge) BRIDGE=--bridge ;;
    --soak) SOAK=${2:-}; shift ;;
    *) echo "usage: scripts/release.sh [--channel nightly|dev [--bridge]] [--soak <receipt>] [--dry-run]" >&2; exit 1 ;;
  esac
  shift
done
case "$CHANNEL" in stable|nightly|dev) ;; *) echo "release.sh: the channel is nightly or dev (stable is the default)" >&2; exit 1 ;; esac
[ -z "$BRIDGE" ] || [ "$CHANNEL" = nightly ] || { echo "release.sh: --bridge goes with --channel nightly" >&2; exit 1; }
PREVIEW=0
[ "$CHANNEL" = stable ] || PREVIEW=1
export POLYCARP_CHANNEL=$CHANNEL
export POLYCARP_BUILD_TIME="${POLYCARP_BUILD_TIME:-$(date -u +%Y%m%d%H%M%S)}"
VERSION=$(cat VERSION)
TAG="v$VERSION"
[ "$PREVIEW" = 0 ] || TAG=$CHANNEL
REQ=$(cat scripts/release-requirement.txt)
bold=$(tput bold 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
fail() { echo "release.sh: $*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || fail "the working tree isn't clean. Commit or stash first, so the app matches a commit."
if [ "$PREVIEW" = 1 ]; then
  # Apple silicon only, and still the one signing identity every channel shares (never ad-hoc), so moving
  # between channels never asks for a permission again.
  export BANEYSPACES_ARM64_ONLY=1
  unset BANEYSPACES_ADHOC
  if [ "$DRY" = 0 ]; then
    git fetch --quiet origin || fail "couldn't reach origin."
    # Nightly and dev are built from main only.
    git merge-base --is-ancestor HEAD origin/main || fail "HEAD isn't on origin/main. $CHANNEL is built from main only."
  fi
elif [ "$DRY" = 0 ]; then
  TAG_COMMIT=$(git rev-parse --verify --quiet "refs/tags/$TAG^{commit}") || fail "tag $TAG doesn't exist. promote.yml makes it (docs/releases.md)."
  [ "$TAG_COMMIT" = "$(git rev-parse HEAD)" ] || fail "HEAD isn't the commit of $TAG. Check out the tag, or move VERSION to match."
  # The remote must have the same tag on the same commit (an annotated tag shows its commit on the ^{} line).
  # ls-remote lists the tag itself before its peeled ^{} line, so take the ^{} line when there is one
  # (v0.3.0, 2026-10-30: taking the first line compared a tag object with the commit).
  LS=$(git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}") || fail "couldn't reach origin to check $TAG."
  REMOTE=$(printf '%s\n' "$LS" | awk '$2 ~ /\^\{\}$/ { peeled = $1 } { first = first ? first : $1 } END { print peeled ? peeled : first }')
  [ "$REMOTE" = "$TAG_COMMIT" ] || fail "origin doesn't have $TAG on this commit. Only promote.yml makes a v tag (docs/releases.md)."
  # Only the draft promote.yml made: a published release is already being offered, so its
  # files must never change under people. Fix forward with a new patch version.
  # (Listed through the API: a draft has no public page, and `gh release view` may not find it by tag.)
  [ "$(gh api "repos/{owner}/{repo}/releases?per_page=100" --jq "[.[] | select(.tag_name == \"$TAG\") | .draft] | first" 2>/dev/null)" = true ] \
    || fail "$TAG is already published (or has no draft release yet). Release a hotfix, or let promote.yml finish first."
  # A real release is universal and uses the stable identity, whatever this shell has set.
  unset BANEYSPACES_ARM64_ONLY BANEYSPACES_ADHOC
fi

# Latest is the stable feed (releases/latest/download/latest.json), so it waits for the soak on a Mac running the
# uploaded build. --soak builds nothing: it checks the draft's files again and publishes exactly what was soaked.
# A --ci receipt is the script's self-check, never a soak.
if [ -n "$SOAK" ]; then
  [ "$PREVIEW" = 0 ] && [ "$DRY" = 0 ] || fail "--soak publishes a stable draft; it takes no --channel or --dry-run."
  [ -f "$SOAK" ] || fail "$SOAK doesn't exist."
  [ "$(grep '^SOAK ' "$SOAK" | tail -1)" = "SOAK PASSED" ] || fail "$SOAK doesn't end in SOAK PASSED (a --ci receipt never counts). $TAG stays a draft."
  grep -q "^candidate .*commit=$TAG_COMMIT" "$SOAK" || fail "$SOAK soaked another commit, not $TAG_COMMIT. $TAG stays a draft."
  BACK=$(mktemp -d)
  trap 'rm -rf "$BACK"' EXIT
  gh release download "$TAG" --dir "$BACK" --pattern 'Polycarp.zip' --pattern 'Polycarp.zip.sha256' --pattern 'Polycarp.dmg' --pattern latest.json
  scripts/verify-release.sh "$BACK"
  scripts/soak-matches.sh "$SOAK" "$BACK" "$TAG_COMMIT" || fail "soak this draft's build. $TAG stays a draft."
  step "Publishing $TAG"
  gh release edit "$TAG" --draft=false --latest
  echo "published $TAG with Polycarp.zip, Polycarp.zip.sha256, Polycarp.dmg and latest.json"
  exit 0
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
scripts/package.sh
# The files are checked as a person would get them, before anything is uploaded. Every channel ships the same files.
step "Checking the zip, the disk image and the checksum"
scripts/verify-release.sh build

if [ "$DRY" = 1 ]; then
  echo "dry run: $TAG not uploaded. The files are in build/."
  exit 0
fi
# Nightly and dev have their own publish: the files are verified above, scripts/publish-channel.sh uploads them.
[ "$PREVIEW" = 0 ] || exec scripts/publish-channel.sh "$CHANNEL" $BRIDGE
scripts/write-feed.sh stable "$VERSION" "$TAG_COMMIT" build/Polycarp.zip build/latest.json "Polycarp $VERSION"
scripts/verify-release.sh build
# The release is a draft until the files are up and checked again; the updater never offers a draft.
step "Uploading to $TAG"
gh release upload "$TAG" build/Polycarp.zip build/Polycarp.zip.sha256 build/Polycarp.dmg build/latest.json --clobber
step "Checking what was uploaded"
BACK=$(mktemp -d)
trap 'rm -rf "$BACK"' EXIT
gh release download "$TAG" --dir "$BACK" --pattern 'Polycarp.zip' --pattern 'Polycarp.zip.sha256' --pattern 'Polycarp.dmg' --pattern latest.json
for f in Polycarp.zip Polycarp.zip.sha256 Polycarp.dmg latest.json; do
  cmp -s "build/$f" "$BACK/$f" || fail "the uploaded $f differs from the one built. $TAG stays unpublished."
done
scripts/verify-release.sh "$BACK"
echo "uploaded $TAG and left it a draft. Install it on rectory1, run scripts/soak-check.sh there, then:"
echo "  scripts/release.sh --soak <receipt>"
