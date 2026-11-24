#!/bin/bash
# Builds, signs, packages and checks the app, then publishes it with scripts/publish.sh (docs/releases.md). Run by
# release.yml, or on the owner's Mac (the signing key never leaves it) on a clean checkout of main:
#   scripts/release.sh [--dry-run]
# A release is built for Apple silicon with the one release signing identity, never ad-hoc, from a commit already on
# origin/main. --dry-run does everything except the main check and the publish, so it can run on a branch.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0
# `--channel nightly` is accepted and changes nothing. release.yml always passes it: GitHub runs main's release.yml
# against whichever green commit the gate picks, and a release.sh from before the one stream builds a stable
# release when it gets no channel.
usage() { echo "usage: scripts/release.sh [--channel nightly] [--dry-run]" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --channel) [ "${2:-}" = nightly ] || usage; shift ;;
    *) usage ;;
  esac
  shift
done
export POLYCARP_RELEASE=1 BANEYSPACES_ARM64_ONLY=1
export POLYCARP_BUILD_TIME="${POLYCARP_BUILD_TIME:-$(date -u +%Y%m%d%H%M%S)}"
unset BANEYSPACES_ADHOC
REQ=$(cat scripts/release-requirement.txt)
bold=$(tput bold 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
fail() { echo "release.sh: $*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || fail "the working tree isn't clean. Commit or stash first, so the app matches a commit."
if [ "$DRY" = 0 ]; then
  git fetch --quiet origin || fail "couldn't reach origin."
  git merge-base --is-ancestor HEAD origin/main || fail "HEAD isn't on origin/main. Releases are built from main only."
fi

step "Building"
scripts/bundle.sh
codesign -v -R "=$REQ" build/Polycarp.app 2>/dev/null \
  || fail "bundle.sh didn't sign with the release identity (it fell back to ad-hoc or used another key). Nothing was packaged."
step "Packaging"
scripts/package.sh
# The files are checked as a person would get them, before anything is uploaded.
step "Checking the zip, the disk image and the checksum"
scripts/verify-release.sh build

if [ "$DRY" = 1 ]; then
  echo "dry run: nothing published. The files are in build/."
  exit 0
fi
exec scripts/publish.sh
