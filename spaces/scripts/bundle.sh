#!/bin/bash
# Builds Polycarp.app (universal: Apple silicon and Intel) into ./build.
#   scripts/bundle.sh            release build
#   scripts/bundle.sh --install  also copy to ~/Applications and start it
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/product.env
VERSION=$(cat VERSION)
APP=build/$PRODUCT_NAME.app
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/skill" "$APP/Contents/Resources/licenses"

# The built-in terminal (libghostty, from scripts/build-ghostty.sh) links only into an Apple silicon build that has the
# library. Any other build compiles the terminal out and says so once. SwiftPM caches the manifest on its environment,
# not on files, so Package.swift is told outright (docs/terminal.md).
TERMINAL_NOT_BUILT="terminal not built: needs the Metal Toolchain (xcodebuild -downloadComponent MetalToolchain)"
if [ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ] && [ -f ghostty/lib/libghostty.a ]; then
  export POLYCARP_TERMINAL=1
elif [ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ]; then
  export POLYCARP_TERMINAL=0
  echo "$TERMINAL_NOT_BUILT" >&2
else
  export POLYCARP_TERMINAL=0
  echo "terminal not built: universal and Intel builds leave it out (libghostty is built for Apple silicon only)" >&2
fi

ARCHS=(--arch arm64)
if xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 && [ "${BANEYSPACES_ARM64_ONLY:-}" != 1 ]; then ARCHS+=(--arch x86_64); fi
swift build -c release "${ARCHS[@]}"
BIN=$(swift build -c release "${ARCHS[@]}" --show-bin-path)/BaneySpaces
cp "$BIN" "$APP/Contents/MacOS/$EXECUTABLE"
# The session engine's command, polycarp-spaces (baneyspaces and ghostdeck are links to it, made at install).
# It lives in Resources, not MacOS, so it is never mistaken for the app's own executable.
cp "$(dirname "$BIN")/baneyspaces-cli" "$APP/Contents/Resources/bin/$CLI_NAME"
# The `polycarp` command, in the app, so one install gives you everything.
if [ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ]; then
  cargo build --quiet --release --locked --manifest-path ../cli/Cargo.toml --target-dir build/cli-target
  cp build/cli-target/release/polycarp "$APP/Contents/Resources/bin/polycarp"
else
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    ! command -v rustup >/dev/null || rustup --quiet target add "$t"
    cargo build --quiet --release --locked --target "$t" --manifest-path ../cli/Cargo.toml --target-dir build/cli-target
  done
  lipo -create build/cli-target/aarch64-apple-darwin/release/polycarp build/cli-target/x86_64-apple-darwin/release/polycarp \
    -output "$APP/Contents/Resources/bin/polycarp"
fi
cp skill/SKILL.md "$APP/Contents/Resources/skill/SKILL.md"
cp NOTICE "$APP/Contents/Resources/NOTICE"
cp LICENSES/* "$APP/Contents/Resources/licenses/"
# libghostty finds its themes, shell integration and terminfo in Contents/Resources.
if [ "$POLYCARP_TERMINAL" = 1 ]; then
  cp -R ghostty/lib/share/ghostty "$APP/Contents/Resources/ghostty"
  cp -R ghostty/lib/share/terminfo "$APP/Contents/Resources/terminfo"
fi
# The Rust crates the polycarp command links, from cargo's own record of them.
RUST_TARGETS=(--target aarch64-apple-darwin); [ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ] || RUST_TARGETS+=(--target x86_64-apple-darwin)
python3 scripts/rust-licenses.py --out "$APP/Contents/Resources/licenses/polycarp-rust-crates.txt" --own "$PWD/.." "${RUST_TARGETS[@]}" ../cli/Cargo.toml:polycarp
# Settings' Uninstall runs the same script as the README.
cp uninstall.sh "$APP/Contents/Resources/uninstall.sh"
# install.sh runs this copy on the prebuilt release, so the installer that fetched the app and the
# steps that put it in place always come from the same signed bundle.
cp scripts/install-app.sh "$APP/Contents/Resources/install-app.sh"
cp scripts/product.env "$APP/Contents/Resources/product.env"

# The brand's own macOS icon (brand/export/macos), at every size an .icns needs.
ICONSET="build/$PRODUCT_NAME.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  cp "../brand/export/macos/icon-$size.png" "$ICONSET/icon_${size}x${size}.png"
  cp "../brand/export/macos/icon-$((size * 2)).png" "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns build/$PRODUCT_NAME.iconset -o "$APP/Contents/Resources/$PRODUCT_NAME.icns"
# The menu bar's template image: the small mark, black on clear (macOS tints it).
swift scripts/make-icon.swift --menu-bar "$APP/Contents/Resources" ../brand

# The commit and its date tell the updater exactly which build this is.
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
# The version string (docs/releases.md): POLYCARP_RELEASE=1 (release.sh) is a release build, anything else a build
# made here. PolycarpChannel tells the updater which: "nightly" for a release, "local" for a build made here.
# CFBundleShortVersionString stays X.Y.Z, as macOS wants.
if [ "${POLYCARP_RELEASE:-}" = 1 ]; then KIND=release CHANNEL=nightly; else KIND=local CHANNEL=local; fi
export POLYCARP_BUILD_TIME="${POLYCARP_BUILD_TIME:-$(date -u +%Y%m%d%H%M%S)}"
if [ "$COMMIT" = unknown ]; then FULL_VERSION="$VERSION-dev.0+local.unknown"; else FULL_VERSION=$(POLYCARP_COMMIT=$COMMIT scripts/build-version.sh "$KIND"); fi
BUILD_NUMBER=$(scripts/build-version.sh --bundle-version)
COMMIT_DATE=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
# 1 when tracked files had changes, so the commit does not say everything (`polycarp version` shows it).
DIRTY=0
[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || DIRTY=1
# The Polycarp browser extension (extension/README.md): reading, the Reader, the Library and the new tab, whose host is
# the bundled command. Its version_name is this build's full version; the extension reloads itself when the copy here
# differs from the one the browser runs, so an app update updates it too.
sh extension/scripts/stage.sh "$APP/Contents/Resources/extension" "$FULL_VERSION"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@FULL_VERSION@/$FULL_VERSION/g" -e "s/@CHANNEL@/$CHANNEL/g" -e "s/@BUILD_NUMBER@/$BUILD_NUMBER/g" -e "s/@COMMIT@/$COMMIT/g" -e "s/@COMMIT_DATE@/$COMMIT_DATE/g" -e "s/@DIRTY@/$DIRTY/g" Resources/Info.plist > "$APP/Contents/Info.plist"
# What `polycarp browser` builds Polycarp Browser from on the person's own Mac (browser/AGENTS.md). It holds no Helium code.
PARTS=(); [ "${BANEYSPACES_ARM64_ONLY:-}" != 1 ] || PARTS=(--arm64-only)
POLYCARP_PARTS_BUILD="$PWD/build/browser-parts" ../browser/scripts/build-parts.sh "$APP/Contents/Resources/browser" ${PARTS[@]+"${PARTS[@]}"}
# A stable local identity keeps the Accessibility permission across rebuilds; ad-hoc is the fallback.
# Ad-hoc is for local builds and CI checks only and never ships as an update: install-app.sh refuses
# it over an installed copy, and release.sh and install.sh require scripts/release-requirement.txt.
if [ "${BANEYSPACES_ADHOC:-}" != 1 ] && IDENT=$(scripts/signing-identity.sh 2>/dev/null); then
  # Inside out: the commands, then the app that holds them.
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.cli" "$APP/Contents/Resources/bin/$CLI_NAME"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.command" "$APP/Contents/Resources/bin/polycarp"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.browser-launcher" "$APP/Contents/Resources/browser/launcher"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID" --entitlements Resources/Polycarp.entitlements "$APP"
else
  # A channel build in CI never falls back to ad-hoc: its identity was named, so failing to use it is the error.
  [ -z "${POLYCARP_SIGNING_IDENTITY:-}" ] || { echo "bundle: the signing identity \"$POLYCARP_SIGNING_IDENTITY\" can't be used" >&2; exit 1; }
  ADHOC_NOTE="note: signed ad-hoc, so macOS will ask for Accessibility again after each update"
  echo "$ADHOC_NOTE" >&2
  codesign --force --sign - --identifier "$BUNDLE_ID.cli" "$APP/Contents/Resources/bin/$CLI_NAME"
  codesign --force --sign - --identifier "$BUNDLE_ID.command" "$APP/Contents/Resources/bin/polycarp"
  codesign --force --sign - --identifier "$BUNDLE_ID.browser-launcher" "$APP/Contents/Resources/browser/launcher"
  codesign --force --sign - --identifier "$BUNDLE_ID" --entitlements Resources/Polycarp.entitlements "$APP"
fi
codesign --verify --deep --strict "$APP"
[ -s "$APP/Contents/Resources/licenses/polycarp-rust-crates.txt" ] || { echo "bundle: the Rust crates' licences are missing from the bundle" >&2; exit 1; }
# A library the bundle doesn't carry, or a path on the machine that built it, is an app that won't start elsewhere.
if otool -arch all -L "$APP/Contents/MacOS/$EXECUTABLE" | grep '^	' | grep -Ev '^	(/usr/lib/|/System/Library/)'; then echo "bundle: Polycarp links the library above, which the bundle doesn't carry" >&2; exit 1; fi
if [ "$POLYCARP_TERMINAL" = 1 ]; then
  [ -s "$APP/Contents/Resources/licenses/ghostty-MIT.txt" ] || { echo "bundle: Ghostty's licence is missing from the bundle" >&2; exit 1; }
  [ -f "$APP/Contents/Resources/terminfo/78/xterm-ghostty" ] || { echo "bundle: the terminal's terminfo is missing from the bundle" >&2; exit 1; }
fi
echo "built $APP ($FULL_VERSION, $(lipo -archs "$APP/Contents/MacOS/$EXECUTABLE"), terminal $([ "$POLYCARP_TERMINAL" = 1 ] && echo built || echo "not built"))"

if [ "${1:-}" = "--install" ]; then
  scripts/install-app.sh "$APP"
fi
[ -z "${ADHOC_NOTE:-}" ] || echo "$ADHOC_NOTE"
