#!/bin/bash
# For CI runners: fetches the zig that ghostty/PIN names (Apple silicon), checks its sha256 against the pin, unpacks
# it into ghostty/.zig and prints that folder, for PATH. It installs nothing system-wide. A Mac that builds the
# terminal itself brings its own zig at the pinned version (scripts/build-ghostty.sh checks it).
set -euo pipefail
cd "$(dirname "$0")/.."
PIN=${GHOSTTY_PIN:-ghostty/PIN}
# shellcheck source=../ghostty/PIN
. "$PIN"
[ "$(uname -m)" = arm64 ] || { echo "fetch-zig: libghostty builds on Apple silicon only" >&2; exit 1; }
NAME=zig-aarch64-macos-$GHOSTTY_ZIG
DEST=ghostty/.zig
TAR=$DEST/$NAME.tar.xz
mkdir -p "$DEST"
if [ ! -f "$TAR" ]; then
  curl -fsSL -o "$TAR.part" "https://ziglang.org/download/$GHOSTTY_ZIG/$NAME.tar.xz"
  mv "$TAR.part" "$TAR"
fi
GOT=$(shasum -a 256 "$TAR" | cut -d' ' -f1)
if [ "$GOT" != "$GHOSTTY_ZIG_SHA256" ]; then
  rm -f "$TAR"
  echo "fetch-zig: the zig tarball's sha256 is $GOT, but $PIN says $GHOSTTY_ZIG_SHA256. Refusing to use it." >&2
  exit 1
fi
rm -rf "${DEST:?}/$NAME" && tar -xJf "$TAR" -C "$DEST"
[ "$("$DEST/$NAME/zig" version)" = "$GHOSTTY_ZIG" ] || { echo "fetch-zig: $NAME/zig doesn't say it is $GHOSTTY_ZIG" >&2; exit 1; }
echo "$PWD/$DEST/$NAME"
