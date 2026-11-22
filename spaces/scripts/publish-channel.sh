#!/bin/bash
# Publishes build/Polycarp.zip, its .sha256, Polycarp.dmg and the channel's latest.json on nightly or dev
# (docs/releases.md). Run by `scripts/release.sh --channel <c>` on the Mac, or by nightly.yml and dev.yml,
# after the app was built, signed, packaged and verified; never by hand.
#   scripts/publish-channel.sh nightly|dev [--bridge]
# A channel never ships half a build: every file goes into a draft first, is downloaded back and checked, and
# only then the draft takes the channel's tag. Nightly also keeps an immutable prerelease `nightly-<time>`.
# It refuses a build whose version is not newer than the one the feed already offers.
# --bridge (nightly only, once): also puts this build on the old `preview` release, so a copy that still reads
# preview gets a build whose updater follows nightly. preview/latest.json is kept there from then on.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/product.env
fail() { echo "publish-channel.sh: $*" >&2; exit 1; }
step() { printf '==> %s\n' "$*"; }
CHANNEL=${1:-}; BRIDGE=0
case "$CHANNEL" in nightly|dev) ;; *) fail "usage: scripts/publish-channel.sh nightly|dev [--bridge]" ;; esac
[ "${2:-}" != --bridge ] || BRIDGE=1
[ "$BRIDGE" = 0 ] || [ "$CHANNEL" = nightly ] || fail "only nightly takes over from preview."
REPO="${POLYCARP_REPO:-baney75/polycarp}"
APP="build/$PRODUCT_NAME.app"
plist() { plutil -extract "$1" raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true; }
VERSION=$(plist PolycarpVersion); COMMIT=$(plist PolycarpCommit); DATE=$(plist PolycarpCommitDate)
[ "$(plist PolycarpChannel)" = "$CHANNEL" ] || fail "$APP was built for \"$(plist PolycarpChannel)\", not $CHANNEL."
[ "$(plist PolycarpCommitDirty)" = 0 ] || fail "$APP was built from a changed tree."
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "$APP has no commit."
for f in "$PRODUCT_NAME.zip" "$PRODUCT_NAME.zip.sha256" "$PRODUCT_NAME.dmg"; do [ -s "build/$f" ] || fail "build/$f is missing."; done

# SemVer 2.0 precedence: exit 0 when $1 sorts above $2.
newer() { python3 -I scripts/semver-newer.py "$1" "$2"; }
FEED="https://github.com/$REPO/releases/download/$CHANNEL/latest.json"
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
  newer "$VERSION" "$OLD" || fail "$CHANNEL already offers $OLD, which is not older than $VERSION. Nothing was published."
fi

NOTES="Polycarp $VERSION, built from $COMMIT. Not a stable release."
# The marker lets a build from before the channels (it reads GitHub's release list) see this one.
BODY="$NOTES
<!-- baneyspaces commit=$COMMIT date=$DATE -->"
scripts/write-feed.sh "$CHANNEL" "$VERSION" "$COMMIT" "build/$PRODUCT_NAME.zip" build/latest.json "$NOTES"
FILES=("$PRODUCT_NAME.zip" "$PRODUCT_NAME.zip.sha256" "$PRODUCT_NAME.dmg" latest.json)

# draft <tag>: a draft prerelease holding every file, checked as downloaded. Sets DRAFT_ID. It never runs inside
# $(...), where macOS bash 3.2 turns set -e off and a failed check would still publish.
draft() {
  local id f back
  DRAFT_ID=
  id=$(gh api "repos/$REPO/releases" -f tag_name="$1" -f target_commitish="$COMMIT" -f name="Polycarp $VERSION" \
    -f body="$BODY" -F draft=true -F prerelease=true -f make_latest=false --jq .id)
  for f in "${FILES[@]}"; do
    gh api --method POST -H "Content-Type: application/octet-stream" --input "build/$f" \
      "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$f" >/dev/null
  done
  back=$(mktemp -d)
  while IFS=$'\t' read -r aid name; do
    gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$aid" > "$back/$name"
  done < <(gh api "repos/$REPO/releases/$id/assets" --jq '.[] | [.id, .name] | @tsv')
  for f in "${FILES[@]}"; do cmp -s "build/$f" "$back/$f" || { rm -rf "$back"; fail "the uploaded $f differs from the one built; draft $id is left unpublished."; }; done
  scripts/verify-release.sh "$back" >&2 || { rm -rf "$back"; fail "draft $id failed verify-release.sh and is left unpublished."; }
  rm -rf "$back"
  DRAFT_ID=$id
}

TIME=$(printf '%s' "$VERSION" | sed -n "s/.*-$CHANNEL\.\([0-9]\{14\}\)+.*/\1/p")
[ -n "$TIME" ] || fail "$VERSION carries no build time."
if [ "$CHANNEL" = nightly ]; then
  step "Publishing the immutable prerelease nightly-$TIME"
  draft "nightly-$TIME"
  gh api -X PATCH "repos/$REPO/releases/$DRAFT_ID" -F draft=false -f make_latest=false >/dev/null
fi
step "Moving $CHANNEL to $VERSION"
draft "$CHANNEL-next-$TIME"; id=$DRAFT_ID
# The rolling release is replaced, never edited in place, so its files always belong to one build. Every
# nightly it held is still kept as nightly-<time>.
gh release delete "$CHANNEL" -R "$REPO" --cleanup-tag --yes 2>/dev/null || true
gh api -X PATCH "repos/$REPO/releases/$id" -f tag_name="$CHANNEL" -f target_commitish="$COMMIT" \
  -F draft=false -F prerelease=true -f make_latest=false >/dev/null
# GitHub's download links can serve a 404 or the old file for a while after the tag moves (the first nightly, 11-22:
# a 404 seconds after the move, the right file a minute later), so the read-back tries 12 times, 10 s apart.
offered=0; seen=""
for try in $(seq 1 12); do
  [ "$try" = 1 ] || sleep "${POLYCARP_FEED_RETRY_SECS:-10}"
  code=$(curl -sSL --max-time 15 -o "$FEED_BODY" -w '%{http_code}' "$FEED" 2>/dev/null) || code="no answer"
  if [ "$code" = 200 ] && grep -qF "\"version\": \"$VERSION\"" "$FEED_BODY"; then offered=1; break; fi
  seen="HTTP $code"
  [ "$code" != 200 ] || seen="$seen, version $(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$FEED_BODY" | head -1)"
done
[ "$offered" = 1 ] || fail "$FEED doesn't offer $VERSION two minutes after the publish (last answer: $seen)."

if [ "$BRIDGE" = 1 ]; then
  step "Putting the bridge build on preview"
  gh release upload preview -R "$REPO" "${FILES[@]/#/build/}" --clobber
  # As the old publisher did: the preview tag names the commit of the files it holds, and the notes carry the marker.
  gh api -X PATCH "repos/$REPO/git/refs/tags/preview" -f sha="$COMMIT" -F force=true >/dev/null
  gh release edit preview -R "$REPO" --prerelease --latest=false --title "Preview (moved to Nightly)" \
    --notes "Preview is now Nightly: https://github.com/$REPO/releases/tag/nightly. This last preview build is Polycarp $VERSION, built from $COMMIT, and follows the Nightly channel by itself.
<!-- baneyspaces commit=$COMMIT date=$DATE -->"
  [ "$(gh api "repos/$REPO/git/ref/tags/preview" --jq .object.sha)" = "$COMMIT" ] || fail "the preview tag isn't on $COMMIT."
  back=$(mktemp -d); trap 'rm -rf "$back" "$FEED_BODY"' EXIT
  gh release download preview -R "$REPO" --dir "$back" --pattern '*'
  for f in "${FILES[@]}"; do cmp -s "build/$f" "$back/$f" || fail "the uploaded preview $f differs from the one built."; done
  scripts/verify-release.sh "$back"
fi
echo "published Polycarp $VERSION on $CHANNEL"
