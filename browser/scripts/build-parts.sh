#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Makes what `polycarp browser install` reads: scripts/build-parts.sh DEST [--arm64-only]
# spaces/scripts/bundle.sh runs it into Polycarp.app/Contents/Resources/browser. The launcher is a program of its own.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: scripts/build-parts.sh DEST [--arm64-only]" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST=$1
TARGETS=(aarch64-apple-darwin)
[ "${2:-}" = --arm64-only ] || TARGETS+=(x86_64-apple-darwin)
BUILD=${POLYCARP_PARTS_BUILD:-$HERE/launcher/target}
rm -rf "$DEST"; mkdir -p "$DEST" "$BUILD"
cp "$HERE/changes.toml" "$HERE/LICENSE" "$DEST/"
cp "$HERE/../spaces/scripts/signing-identity.sh" "$DEST/"

MADE=()
for t in "${TARGETS[@]}"; do
  ! command -v rustup >/dev/null || rustup --quiet target add "$t"
  cargo build --quiet --release --locked --target "$t" --manifest-path "$HERE/launcher/Cargo.toml" --target-dir "$BUILD"
  MADE+=("$BUILD/$t/release/polycarp-browser-launcher")
done
lipo -create "${MADE[@]}" -output "$DEST/launcher"

ICONS=$HERE/../brand/export/macos
SET=$BUILD/icon.iconset
rm -rf "$SET"; mkdir -p "$SET"
for size in 16 32 128 256 512; do
  cp "$ICONS/icon-$size.png" "$SET/icon_${size}x${size}.png"
  cp "$ICONS/icon-$((size * 2)).png" "$SET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$SET" -o "$DEST/icon.icns"
cp "$ICONS/icon-32.png" "$DEST/icon-32.png"
