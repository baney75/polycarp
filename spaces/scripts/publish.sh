#!/bin/bash
# Publishes build/Polycarp.zip, its .sha256, Polycarp.dmg and latest.json as Polycarp's one stream of updates
# (docs/releases.md). Run by `scripts/release.sh` on the Mac or by release.yml, after the app was built, signed,
# packaged and verified; never by hand.
#   scripts/publish.sh
# An update never ships half a build: every file goes into a draft first, is downloaded back and checked, and only
# then the draft takes its tag. Each build is published three times:
#   nightly-<time>  an immutable prerelease, kept 14 days, that the feed's url names
#   nightly         the rolling release: the download link on dbaney.com and the feed every copy reads
#   dev             the same files with a feed in the old dev format, for copies that still read the dev feed
#                   (docs/releases.md, "One stream"). It holds the full build, so a dev copy installs it from here
#                   whether it downloads the zip or builds the dev tag from source.
# It refuses a build whose version is not newer than the one the nightly feed already offers.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/product.env
fail() { echo "publish.sh: $*" >&2; exit 1; }
step() { printf '==> %s\n' "$*"; }
[ $# = 0 ] || fail "usage: scripts/publish.sh"
REPO="${POLYCARP_REPO:-baney75/polycarp}"
APP="build/$PRODUCT_NAME.app"
plist() { plutil -extract "$1" raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true; }
VERSION=$(plist PolycarpVersion); COMMIT=$(plist PolycarpCommit); DATE=$(plist PolycarpCommitDate)
[ "$(plist PolycarpChannel)" = nightly ] || fail "$APP was built as \"$(plist PolycarpChannel)\", not a release build."
[ "$(plist PolycarpCommitDirty)" = 0 ] || fail "$APP was built from a changed tree."
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "$APP has no commit."
for f in "$PRODUCT_NAME.zip" "$PRODUCT_NAME.zip.sha256" "$PRODUCT_NAME.dmg"; do [ -s "build/$f" ] || fail "build/$f is missing."; done
TIME=$(printf '%s' "$VERSION" | sed -n 's/.*-nightly\.\([0-9]\{14\}\)+.*/\1/p')
[ -n "$TIME" ] || fail "$VERSION carries no build time."

# SemVer 2.0 precedence: exit 0 when $1 sorts above $2.
newer() { python3 -I scripts/semver-newer.py "$1" "$2"; }
FEED="https://github.com/$REPO/releases/download/nightly/latest.json"
DEV_FEED="https://github.com/$REPO/releases/download/dev/latest.json"
# Only a feed that is confirmed missing (404) means a first publish. Any other answer, a network error or a feed
# that doesn't parse stops here, so a blip can never let an older build replace a newer one.
FEED_BODY=$(mktemp); trap 'rm -f "$FEED_BODY"' EXIT
CODE=$(curl -sSL -o "$FEED_BODY" -w '%{http_code}' "$FEED") || fail "couldn't fetch $FEED. Nothing was published."
case "$CODE" in
  404) OLD="" ;;
  200) OLD=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])).get("version"); assert isinstance(v,str) and v; print(v)' "$FEED_BODY") \
         || fail "$FEED doesn't name a version. Nothing was published." ;;
  *) fail "$FEED answered HTTP $CODE. Nothing was published." ;;
esac
if [ -n "$OLD" ]; then
  newer "$VERSION" "$OLD" || fail "the release already offers $OLD, which is not older than $VERSION. Nothing was published."
fi

NOTES="Polycarp $VERSION, built from $COMMIT."
# The marker lets a build from before the feeds (0.3.0 and older; it reads GitHub's release list) see this one.
BODY="$NOTES
<!-- baneyspaces commit=$COMMIT date=$DATE -->"
scripts/write-feed.sh nightly "$VERSION" "$COMMIT" "build/$PRODUCT_NAME.zip" build/latest.json "$NOTES"
# The dev feed: the same build, said the way a copy that reads the dev feed takes it. Such a copy wants channel
# "dev" and a version X.Y.Z-dev.<time>+<sha7> newer than its own, and installs from the dev release by its tag.
DEV_VERSION=${VERSION/-nightly./-dev.}
python3 -I - build/latest.json "$DEV_VERSION" "https://github.com/$REPO/releases/download/dev/$PRODUCT_NAME.zip" > build/dev-latest.json <<'PY'
import json, sys
feed = json.load(open(sys.argv[1]))
feed["channel"], feed["version"] = "dev", sys.argv[2]
for p in feed["platforms"].values():
    p["url"] = sys.argv[3]
print(json.dumps(feed, indent=2))
PY
FILES=("$PRODUCT_NAME.zip" "$PRODUCT_NAME.zip.sha256" "$PRODUCT_NAME.dmg")

# draft <tag> <feed>: a draft prerelease holding every file and <feed> as latest.json, checked as downloaded. Sets
# DRAFT_ID. It never runs inside $(...), where macOS bash 3.2 turns set -e off and a failed check would still publish.
draft() {
  local id f back
  DRAFT_ID=
  id=$(gh api "repos/$REPO/releases" -f tag_name="$1" -f target_commitish="$COMMIT" -f name="Polycarp $VERSION" \
    -f body="$BODY" -F draft=true -F prerelease=true -f make_latest=false --jq .id)
  for f in "${FILES[@]}"; do
    gh api --method POST -H "Content-Type: application/octet-stream" --input "build/$f" \
      "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$f" >/dev/null
  done
  gh api --method POST -H "Content-Type: application/octet-stream" --input "$2" \
    "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=latest.json" >/dev/null
  back=$(mktemp -d)
  while IFS=$'\t' read -r aid name; do
    gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$aid" > "$back/$name"
  done < <(gh api "repos/$REPO/releases/$id/assets" --jq '.[] | [.id, .name] | @tsv')
  for f in "${FILES[@]}"; do cmp -s "build/$f" "$back/$f" || { rm -rf "$back"; fail "the uploaded $f differs from the one built; draft $id is left unpublished."; }; done
  cmp -s "$2" "$back/latest.json" || { rm -rf "$back"; fail "the uploaded latest.json differs from $2; draft $id is left unpublished."; }
  scripts/verify-release.sh "$back" >&2 || { rm -rf "$back"; fail "draft $id failed verify-release.sh and is left unpublished."; }
  rm -rf "$back"
  DRAFT_ID=$id
}

# flip <tag> <draft id> <feed url> <version>: the rolling release <tag> becomes the checked draft, and its feed is
# read back. The release is replaced, never edited in place, so its files always belong to one build.
flip() {
  local tag=$1 id=$2 url=$3 want=$4 offered=0 seen="" code try
  step "Moving $tag to $want"
  gh release delete "$tag" -R "$REPO" --cleanup-tag --yes 2>/dev/null || true
  gh api -X PATCH "repos/$REPO/releases/$id" -f tag_name="$tag" -f target_commitish="$COMMIT" \
    -F draft=false -F prerelease=true -f make_latest=false >/dev/null
  # GitHub's download links can serve a 404 or the old file for a while after the tag moves (the first nightly,
  # 11-22: a 404 seconds after the move, the right file a minute later), so the read-back tries 12 times, 10 s apart.
  for try in $(seq 1 12); do
    [ "$try" = 1 ] || sleep "${POLYCARP_FEED_RETRY_SECS:-10}"
    code=$(curl -sSL --max-time 15 -o "$FEED_BODY" -w '%{http_code}' "$url" 2>/dev/null) || code="no answer"
    if [ "$code" = 200 ] && grep -qF "\"version\": \"$want\"" "$FEED_BODY"; then offered=1; break; fi
    seen="HTTP $code"
    [ "$code" != 200 ] || seen="$seen, version $(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$FEED_BODY" | head -1)"
  done
  [ "$offered" = 1 ] || fail "$url doesn't offer $want two minutes after the publish (last answer: $seen)."
}

# Every release is a checked draft before any of them is published, so a failed upload or check moves nothing.
step "Uploading and checking nightly-$TIME, nightly and dev"
draft "nightly-$TIME" build/latest.json; ARCHIVE_ID=$DRAFT_ID
draft "dev-next-$TIME" build/dev-latest.json; DEV_ID=$DRAFT_ID
draft "nightly-next-$TIME" build/latest.json; NIGHTLY_ID=$DRAFT_ID
step "Publishing the immutable prerelease nightly-$TIME"
gh api -X PATCH "repos/$REPO/releases/$ARCHIVE_ID" -F draft=false -f make_latest=false >/dev/null
# Dev moves first. release.yml builds a commit only while it is ahead of the nightly tag, so a run that stops after
# dev moved (or before) leaves nightly behind, and starting the workflow again finishes both.
flip dev "$DEV_ID" "$DEV_FEED" "$DEV_VERSION"
flip nightly "$NIGHTLY_ID" "$FEED" "$VERSION"
echo "published Polycarp $VERSION"
