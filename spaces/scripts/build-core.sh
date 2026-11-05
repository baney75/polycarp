#!/bin/bash
# Builds the voice core: the polycarp-core crate (../core/ffi, over ../core/voice) as a static library,
# into core-lib/libpolycarp_core.a (universal unless BANEYSPACES_ARM64_ONLY=1). Polycarp links it into
# its own binary, so dictation runs in the same process as the app.
#
#   scripts/build-core.sh          build if core-lib is missing or older than the sources
#   scripts/build-core.sh --force  build again
#
# Steps: build each architecture with the crate's own Cargo.lock (--locked), join them with lipo, check
# that every function the header declares is in the library, and that Sources/CPolycarpCore's copy of the
# header is the crate's.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
CORE=$ROOT/../core
OUT=core-lib

TARGETS=(aarch64-apple-darwin)
[ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ] || TARGETS+=(x86_64-apple-darwin)

# Everything the library is made of: sources, manifests and locks of both crates, the fixtures and data the engine embeds, and this script.
SRC_HASH=$( (cd "$CORE" && find ffi/src ffi/include ffi/Cargo.toml ffi/Cargo.lock voice/src voice/bench voice/data voice/Cargo.toml -type f | LC_ALL=C sort | xargs shasum -a 256; shasum -a 256 "$ROOT/scripts/build-core.sh") | shasum -a 256 | cut -c1-64)
STAMP="$SRC_HASH ${TARGETS[*]}"

# The header the app compiles against must be the crate's, byte for byte.
cmp -s "$CORE/ffi/include/polycarp_core.h" Sources/CPolycarpCore/include/polycarp_core.h \
  || { echo "core: Sources/CPolycarpCore/include/polycarp_core.h differs from core/ffi/include/polycarp_core.h; copy the crate's over it" >&2; exit 1; }

if [ "${1:-}" != "--force" ] && [ -f "$OUT/libpolycarp_core.a" ] && [ "$(cat "$OUT/STAMP" 2>/dev/null)" = "$STAMP" ]; then
  echo "core: up to date"
  exit 0
fi

command -v cargo >/dev/null || { echo "core: cargo isn't installed (rustup.rs). Rust is needed once to build the voice core." >&2; exit 1; }
if command -v rustup >/dev/null; then
  for t in "${TARGETS[@]}"; do
    rustup target list --installed 2>/dev/null | grep -qx "$t" || rustup target add "$t"
  done
fi

LIBS=()
for t in "${TARGETS[@]}"; do
  # Its own target folder, so a CARGO_TARGET_DIR set for something else can't put the library elsewhere.
  CARGO_TARGET_DIR="$CORE/ffi/target" cargo build --locked --release --manifest-path "$CORE/ffi/Cargo.toml" --target "$t"
  LIBS+=("$CORE/ffi/target/$t/release/libpolycarp_core.a")
done

mkdir -p "$OUT"
lipo -create "${LIBS[@]}" -output "$OUT/libpolycarp_core.a"
# A function the app calls but the library lacks would fail at link time; one the header promises and the library lacks, never.
# (nm's output goes to a variable first: grep -q closing the pipe early would fail it under pipefail.)
SYMBOLS=$(nm -gU "$OUT/libpolycarp_core.a" 2>/dev/null)
for sym in $(sed -n 's/.*[ *]\(pc_[a-z_]*\)(.*/\1/p' "$CORE/ffi/include/polycarp_core.h" | sort -u); do
  grep -q " _$sym\$" <<<"$SYMBOLS" || { echo "core: the library has no $sym" >&2; exit 1; }
done
echo "$STAMP" > "$OUT/STAMP"
echo "core: built $OUT/libpolycarp_core.a ($(lipo -archs "$OUT/libpolycarp_core.a"))"
