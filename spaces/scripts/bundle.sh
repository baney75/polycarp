#!/bin/bash
# Builds Polycarp.app (universal: Apple silicon and Intel) into ./build.
#   scripts/bundle.sh            release build
#   scripts/bundle.sh --install  also copy to ~/Applications and start it
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/product.env
VERSION=$(cat VERSION)
APP=build/$PRODUCT_NAME.app
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/skill" "$APP/Contents/Resources/licenses"

# The hands engine (agent-desktop's library), built from the pinned commit; Polycarp links it.
scripts/build-engine.sh

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
# swift build points a dev binary at engine/lib; the bundle finds its library in Contents/Frameworks. The path is
# the package's real path, which isn't always $PWD: under mktemp (install.sh's updates) $PWD is /var/folders/… and
# the rpath /private/var/folders/…. So delete the engine/lib rpaths the binary has, as otool reads them.
for rp in $(otool -l "$APP/Contents/MacOS/$EXECUTABLE" | awk '/cmd LC_RPATH/ { r = 1 } r && $1 == "path" { print $2; r = 0 }' | grep '/engine/lib$' | sort -u); do
  install_name_tool -delete_rpath "$rp" "$APP/Contents/MacOS/$EXECUTABLE"
done
# The session engine's command, polycarp-spaces (baneyspaces and ghostdeck are links to it, made at install).
# It lives in Resources, not MacOS, so it is never mistaken for the app's own executable.
cp "$(dirname "$BIN")/baneyspaces-cli" "$APP/Contents/Resources/bin/$CLI_NAME"
# The `polycarp` command, in the app, so one install gives you everything.
if [ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ]; then
  cargo build --quiet --release --locked --manifest-path ../cli/Cargo.toml --target-dir build/cli-target
  cp build/cli-target/release/polycarp "$APP/Contents/Resources/bin/polycarp"
else
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    cargo build --quiet --release --locked --target "$t" --manifest-path ../cli/Cargo.toml --target-dir build/cli-target
  done
  lipo -create build/cli-target/aarch64-apple-darwin/release/polycarp build/cli-target/x86_64-apple-darwin/release/polycarp \
    -output "$APP/Contents/Resources/bin/polycarp"
fi
cp skill/SKILL.md "$APP/Contents/Resources/skill/SKILL.md"
# The new tab page (a small Chrome extension, docs/newtab.md); its host is the bundled command.
if [ -d extension/newtab ]; then
  cp -R extension/newtab "$APP/Contents/Resources/newtab-extension"
fi
cp engine/lib/libagent_desktop_ffi.dylib "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib"
cp NOTICE "$APP/Contents/Resources/NOTICE"
cp LICENSES/* "$APP/Contents/Resources/licenses/"
# libghostty finds its themes, shell integration and terminfo in Contents/Resources.
if [ "$POLYCARP_TERMINAL" = 1 ]; then
  cp -R ghostty/lib/share/ghostty "$APP/Contents/Resources/ghostty"
  cp -R ghostty/lib/share/terminfo "$APP/Contents/Resources/terminfo"
fi
# The Rust crates the polycarp command and the engine link, from cargo's own record of them.
RUST_TARGETS=(--target aarch64-apple-darwin); [ "${BANEYSPACES_ARM64_ONLY:-}" = 1 ] || RUST_TARGETS+=(--target x86_64-apple-darwin)
python3 scripts/rust-licenses.py --out "$APP/Contents/Resources/licenses/polycarp-rust-crates.txt" --own "$PWD/.." "${RUST_TARGETS[@]}" \
  ../cli/Cargo.toml:polycarp engine/.src/Cargo.toml:agent-desktop-ffi
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
# The channel and its version string (docs/releases.md): POLYCARP_CHANNEL is stable, nightly or dev for a release
# and unset for a build made here, which is "local". CFBundleShortVersionString stays X.Y.Z, as macOS wants.
CHANNEL="${POLYCARP_CHANNEL:-local}"
export POLYCARP_BUILD_TIME="${POLYCARP_BUILD_TIME:-$(date -u +%Y%m%d%H%M%S)}"
if [ "$COMMIT" = unknown ]; then FULL_VERSION="$VERSION-dev.0+local.unknown"; else FULL_VERSION=$(POLYCARP_COMMIT=$COMMIT scripts/channel-version.sh "$CHANNEL"); fi
BUILD_NUMBER=$(scripts/channel-version.sh --bundle-version)
COMMIT_DATE=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
# 1 when tracked files had changes, so the commit does not say everything (`polycarp version` shows it).
DIRTY=0
[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || DIRTY=1
sed -e "s/@VERSION@/$VERSION/g" -e "s/@FULL_VERSION@/$FULL_VERSION/g" -e "s/@CHANNEL@/$CHANNEL/g" -e "s/@BUILD_NUMBER@/$BUILD_NUMBER/g" -e "s/@COMMIT@/$COMMIT/g" -e "s/@COMMIT_DATE@/$COMMIT_DATE/g" -e "s/@DIRTY@/$DIRTY/g" Resources/Info.plist > "$APP/Contents/Info.plist"
# A stable local identity keeps the Accessibility permission across rebuilds; ad-hoc is the fallback.
# Ad-hoc is for local builds and CI checks only and never ships as an update: install-app.sh refuses
# it over an installed copy, and release.sh and install.sh require scripts/release-requirement.txt.
if [ "${BANEYSPACES_ADHOC:-}" != 1 ] && IDENT=$(scripts/signing-identity.sh 2>/dev/null); then
  # Inside out: the engine's library, then the command, then the app that holds both.
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.engine" "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.cli" "$APP/Contents/Resources/bin/$CLI_NAME"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.command" "$APP/Contents/Resources/bin/polycarp"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID" --entitlements Resources/Polycarp.entitlements "$APP"
else
  # A channel build in CI never falls back to ad-hoc: its identity was named, so failing to use it is the error.
  [ -z "${POLYCARP_SIGNING_IDENTITY:-}" ] || { echo "bundle: the signing identity \"$POLYCARP_SIGNING_IDENTITY\" can't be used" >&2; exit 1; }
  ADHOC_NOTE="note: signed ad-hoc, so macOS will ask for Accessibility again after each update"
  echo "$ADHOC_NOTE" >&2
  codesign --force --sign - --identifier "$BUNDLE_ID.engine" "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib"
  codesign --force --sign - --identifier "$BUNDLE_ID.cli" "$APP/Contents/Resources/bin/$CLI_NAME"
  codesign --force --sign - --identifier "$BUNDLE_ID.command" "$APP/Contents/Resources/bin/polycarp"
  codesign --force --sign - --identifier "$BUNDLE_ID" --entitlements Resources/Polycarp.entitlements "$APP"
fi
codesign --verify --deep --strict "$APP"
# The licence of ported code ships with the app.
[ -s "$APP/Contents/Resources/licenses/cua-driver-MIT.txt" ] || { echo "bundle: the cua-driver licence is missing from the bundle" >&2; exit 1; }
[ -s "$APP/Contents/Resources/licenses/polycarp-rust-crates.txt" ] || { echo "bundle: the Rust crates' licences are missing from the bundle" >&2; exit 1; }
# The app must find its library next to itself, not where it was built.
otool -L "$APP/Contents/MacOS/$EXECUTABLE" | grep -q '@rpath/libagent_desktop_ffi.dylib' || { echo "bundle: Polycarp doesn't link the engine through @rpath" >&2; exit 1; }
otool -l "$APP/Contents/MacOS/$EXECUTABLE" | grep -A2 LC_RPATH | grep -q '@executable_path/../Frameworks' || { echo "bundle: no @executable_path/../Frameworks rpath" >&2; exit 1; }
! otool -l "$APP/Contents/MacOS/$EXECUTABLE" | grep -A2 LC_RPATH | grep -q '/engine/lib ' || { echo "bundle: the build folder's engine/lib rpath is still in the app" >&2; exit 1; }
[ "$(otool -D "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib" | grep -c '^@rpath/libagent_desktop_ffi.dylib$')" -ge 1 ] || { echo "bundle: the engine's install name isn't @rpath" >&2; exit 1; }
if otool -l "$APP/Contents/MacOS/$EXECUTABLE" | grep -A2 LC_RPATH | grep -q "$PWD/engine/lib"; then echo "bundle: the app still points at the build folder" >&2; exit 1; fi
if [ "$POLYCARP_TERMINAL" = 1 ]; then
  [ -s "$APP/Contents/Resources/licenses/ghostty-MIT.txt" ] || { echo "bundle: Ghostty's licence is missing from the bundle" >&2; exit 1; }
  [ -f "$APP/Contents/Resources/terminfo/78/xterm-ghostty" ] || { echo "bundle: the terminal's terminfo is missing from the bundle" >&2; exit 1; }
fi
echo "built $APP ($FULL_VERSION, $(lipo -archs "$APP/Contents/MacOS/$EXECUTABLE"), terminal $([ "$POLYCARP_TERMINAL" = 1 ] && echo built || echo "not built"))"

if [ "${1:-}" = "--install" ]; then
  scripts/install-app.sh "$APP"
fi
[ -z "${ADHOC_NOTE:-}" ] || echo "$ADHOC_NOTE"
