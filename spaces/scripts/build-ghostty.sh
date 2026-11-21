#!/bin/bash
# Builds the terminal engine: libghostty, the library Ghostty's own macOS app links (GhosttyKit), from the commit
# pinned in ghostty/PIN, into ghostty/lib (Apple silicon only). Ghostty's sources are used as they are: nothing is
# patched, so moving the pin to a newer upstream tag is the whole update.
#
#   scripts/build-ghostty.sh          build if ghostty/lib is missing or older than the pin
#   scripts/build-ghostty.sh --force  build again
#
# Steps: fetch the tarball (cached in ghostty/.cache), check its sha256 and the commit id stored in it, unpack into
# ghostty/.src, check the license and the header in Sources/CGhostty against upstream's, check zig and the Metal
# Toolchain, run Ghostty's `zig build` for the native xcframework, then copy the static library and the resources
# (themes, shell integration, terminfo) into ghostty/lib.
#
# Exit 1: something is wrong (a checksum, a header, the build). Exit 3: this Mac can't build it (no zig at the pinned
# version, or no Metal Toolchain); the app then builds without the terminal and says so.
#
# GHOSTTY_PIN and GHOSTTY_DIR point it at another pin file and work folder (the tests use them).
set -euo pipefail
cd "$(dirname "$0")/.."
PIN=${GHOSTTY_PIN:-ghostty/PIN}
DIR=${GHOSTTY_DIR:-ghostty}
# shellcheck source=../ghostty/PIN
. "$PIN"
OUT=$DIR/lib
NOT_BUILT="terminal not built: needs the Metal Toolchain (xcodebuild -downloadComponent MetalToolchain)"
STAMP="$GHOSTTY_COMMIT $GHOSTTY_SHA256 $(shasum -a 256 scripts/build-ghostty.sh | cut -c1-16)"

if [ "${1:-}" != "--force" ] && [ -f "$OUT/libghostty.a" ] && [ "$(cat "$OUT/STAMP" 2>/dev/null)" = "$STAMP" ]; then
  echo "ghostty: up to date ($GHOSTTY_TAG, ${GHOSTTY_COMMIT:0:9})"
  exit 0
fi

mkdir -p "$DIR/.cache"
TAR="$DIR/.cache/ghostty-$GHOSTTY_COMMIT.tar.gz"
if [ ! -f "$TAR" ]; then
  echo "ghostty: fetching $GHOSTTY_REPO $GHOSTTY_TAG ($GHOSTTY_COMMIT)"
  curl -fsSL -o "$TAR.part" "https://codeload.github.com/$GHOSTTY_REPO/tar.gz/$GHOSTTY_COMMIT"
  mv "$TAR.part" "$TAR"
fi
GOT=$(shasum -a 256 "$TAR" | cut -d' ' -f1)
if [ "$GOT" != "$GHOSTTY_SHA256" ]; then
  rm -f "$TAR"
  echo "ghostty: the tarball's sha256 is $GOT, but $PIN says $GHOSTTY_SHA256. Refusing to build it." >&2
  exit 1
fi
# head closes the pipe early, which makes gzip fail under pipefail: only git's answer counts.
COMMIT_IN_TAR=$(gzip -dc "$TAR" 2>/dev/null | head -c 4096 | git get-tar-commit-id || true)
[ "$COMMIT_IN_TAR" = "$GHOSTTY_COMMIT" ] || { echo "ghostty: the tarball is commit $COMMIT_IN_TAR, not $GHOSTTY_COMMIT" >&2; exit 1; }

rm -rf "$DIR/.src" && mkdir -p "$DIR/.src"
tar xzf "$TAR" -C "$DIR/.src" --strip-components=1
SRC=$DIR/.src
[ "$(shasum -a 256 "$SRC/LICENSE" | cut -d' ' -f1)" = "$GHOSTTY_LICENSE_SHA256" ] || { echo "ghostty: upstream LICENSE changed; update LICENSES/ and $PIN" >&2; exit 1; }
cmp -s "$SRC/LICENSE" LICENSES/ghostty-MIT.txt || { echo "ghostty: LICENSES/ghostty-MIT.txt differs from upstream's LICENSE" >&2; exit 1; }
cmp -s "$SRC/include/ghostty.h" Sources/CGhostty/include/ghostty.h \
  || { echo "ghostty: Sources/CGhostty/include/ghostty.h differs from $GHOSTTY_TAG's include/ghostty.h; copy it over and check the Terminal code against the new API" >&2; exit 1; }

# The tools, checked before the long build so a Mac without them stops here with one clear line.
ZIG_HAVE=$(zig version 2>/dev/null || true)
if [ "$ZIG_HAVE" != "$GHOSTTY_ZIG" ]; then
  echo "terminal not built: $GHOSTTY_TAG builds with zig $GHOSTTY_ZIG, and this Mac has ${ZIG_HAVE:-no zig}" >&2
  exit 3
fi
if ! xcrun -sdk macosx metal --version >/dev/null 2>&1; then
  echo "$NOT_BUILT" >&2
  exit 3
fi

echo "ghostty: building GhosttyKit $GHOSTTY_TAG (Apple silicon)"
(cd "$SRC" && zig build -Doptimize=ReleaseFast -Demit-xcframework=true -Dxcframework-target=native -Demit-macos-app=false)

# The native xcframework holds one macOS slice with one static library; its file name is Ghostty's business.
LIBS=("$SRC"/macos/GhosttyKit.xcframework/macos-*/*.a)
[ "${#LIBS[@]}" = 1 ] && [ -f "${LIBS[0]}" ] || { echo "ghostty: expected one static library in GhosttyKit.xcframework, found: ${LIBS[*]}" >&2; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT/share"
cp "${LIBS[0]}" "$OUT/libghostty.a"
[ "$(lipo -archs "$OUT/libghostty.a")" = arm64 ] || { echo "ghostty: libghostty.a is $(lipo -archs "$OUT/libghostty.a"), not arm64" >&2; exit 1; }
# Themes and shell integration (share/ghostty) and Ghostty's terminfo (share/terminfo): the app bundle carries both in
# Contents/Resources, where libghostty looks for them.
cp -R "$SRC/zig-out/share/ghostty" "$OUT/share/ghostty"
cp -R "$SRC/zig-out/share/terminfo" "$OUT/share/terminfo"
[ -f "$OUT/share/terminfo/78/xterm-ghostty" ] || { echo "ghostty: the build made no terminfo/78/xterm-ghostty" >&2; exit 1; }
# A symbol Polycarp calls but the library lacks would fail at link, far from here. nm's output goes into a variable
# first: piped straight to grep -q, nm dies of SIGPIPE when grep stops early, and pipefail calls that a miss.
SYMS=$(nm -gU "$OUT/libghostty.a" 2>/dev/null || true)
for sym in ghostty_init ghostty_app_new ghostty_surface_new ghostty_config_load_file ghostty_surface_key; do
  grep -q " _$sym\$" <<<"$SYMS" || { echo "ghostty: the library has no $sym" >&2; exit 1; }
done
echo "$STAMP" > "$OUT/STAMP"
echo "ghostty: built $OUT/libghostty.a ($GHOSTTY_TAG, ${GHOSTTY_COMMIT:0:9}, $(du -h "$OUT/libghostty.a" | cut -f1))"
