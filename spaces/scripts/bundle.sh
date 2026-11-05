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
cp skill/SKILL.md "$APP/Contents/Resources/skill/SKILL.md"
cp engine/lib/libagent_desktop_ffi.dylib "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib"
cp NOTICE "$APP/Contents/Resources/NOTICE"
cp LICENSES/* "$APP/Contents/Resources/licenses/"
# Settings' Uninstall runs the same script as the README.
cp uninstall.sh "$APP/Contents/Resources/uninstall.sh"
# install.sh runs this copy on the prebuilt release, so the installer that fetched the app and the
# steps that put it in place always come from the same signed bundle.
cp scripts/install-app.sh "$APP/Contents/Resources/install-app.sh"
cp scripts/product.env "$APP/Contents/Resources/product.env"

# The pointer probe's test app, inside the bundle so that it is sealed with it and signed with the same identity.
# Polycarp starts it for an agent only from here and only when its signature and code hash match (ProbeAppTrust).
PROBE="$APP/Contents/Resources/probe/CanvasProbe.app"
mkdir -p "$PROBE/Contents/MacOS"
PROBE_SLICES=()
for ARCH in $(for a in "${ARCHS[@]}"; do [ "$a" = "--arch" ] || echo "$a"; done); do
  swiftc -O -target "$ARCH-apple-macos13.0" -o "build/CanvasProbe-$ARCH" scripts/canvas-probe-app.swift
  PROBE_SLICES+=("build/CanvasProbe-$ARCH")
done
lipo -create "${PROBE_SLICES[@]}" -output "$PROBE/Contents/MacOS/CanvasProbe"
cat > "$PROBE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID.canvasprobe</string><key>CFBundleName</key><string>Canvas Probe</string>
<key>CFBundleExecutable</key><string>CanvasProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST

# The Polycarp olive branch (brand/mark.svg), drawn at build time on the cream background.
swift scripts/make-icon.swift build/$PRODUCT_NAME.iconset ../brand
iconutil -c icns build/$PRODUCT_NAME.iconset -o "$APP/Contents/Resources/$PRODUCT_NAME.icns"
# The menu bar's template image: the small mark, black on clear (macOS tints it).
swift scripts/make-icon.swift --menu-bar "$APP/Contents/Resources" ../brand

# The commit and its date tell the updater exactly which build this is.
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
COMMIT_DATE=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
sed -e "s/@VERSION@/$VERSION/g" -e "s/@COMMIT@/$COMMIT/g" -e "s/@COMMIT_DATE@/$COMMIT_DATE/g" Resources/Info.plist > "$APP/Contents/Info.plist"
# A stable local identity keeps the Accessibility permission across rebuilds; ad-hoc is the fallback.
# Ad-hoc is for local builds and CI checks only and never ships as an update: install-app.sh refuses
# it over an installed copy, and release.sh and install.sh require scripts/release-requirement.txt.
if [ "${BANEYSPACES_ADHOC:-}" != 1 ] && IDENT=$(scripts/signing-identity.sh 2>/dev/null); then
  # Inside out: the engine's library, then the command, then the app that holds both.
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.engine" "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID.cli" "$APP/Contents/Resources/bin/$CLI_NAME"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier $BUNDLE_ID.canvasprobe "$PROBE"
  codesign -dvvv "$PROBE" 2>&1 | sed -n 's/^CDHash=//p' > "$APP/Contents/Resources/probe/CanvasProbe.cdhash"
  codesign --force --sign "${IDENT%%$'\t'*}" --keychain "${IDENT#*$'\t'}" --identifier "$BUNDLE_ID" "$APP"
else
  ADHOC_NOTE="note: signed ad-hoc, so macOS will ask for Accessibility again after each update"
  echo "$ADHOC_NOTE" >&2
  codesign --force --sign - --identifier "$BUNDLE_ID.engine" "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib"
  codesign --force --sign - --identifier "$BUNDLE_ID.cli" "$APP/Contents/Resources/bin/$CLI_NAME"
  codesign --force --sign - --identifier $BUNDLE_ID.canvasprobe "$PROBE"
  codesign -dvvv "$PROBE" 2>&1 | sed -n 's/^CDHash=//p' > "$APP/Contents/Resources/probe/CanvasProbe.cdhash"
  codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"
fi
codesign --verify --deep --strict "$APP"
# The probe app's recorded hash must be the hash of the signed app inside the sealed bundle.
[ -s "$APP/Contents/Resources/probe/CanvasProbe.cdhash" ] && [ "$(cat "$APP/Contents/Resources/probe/CanvasProbe.cdhash")" = "$(codesign -dvvv "$PROBE" 2>&1 | sed -n 's/^CDHash=//p')" ] || { echo "bundle: the probe app's code hash is not recorded" >&2; exit 1; }
# The licence of ported code ships with the app.
[ -s "$APP/Contents/Resources/licenses/cua-driver-MIT.txt" ] || { echo "bundle: the cua-driver licence is missing from the bundle" >&2; exit 1; }
# The app must find its library next to itself, not where it was built.
otool -L "$APP/Contents/MacOS/$EXECUTABLE" | grep -q '@rpath/libagent_desktop_ffi.dylib' || { echo "bundle: Polycarp doesn't link the engine through @rpath" >&2; exit 1; }
otool -l "$APP/Contents/MacOS/$EXECUTABLE" | grep -A2 LC_RPATH | grep -q '@executable_path/../Frameworks' || { echo "bundle: no @executable_path/../Frameworks rpath" >&2; exit 1; }
! otool -l "$APP/Contents/MacOS/$EXECUTABLE" | grep -A2 LC_RPATH | grep -q '/engine/lib ' || { echo "bundle: the build folder's engine/lib rpath is still in the app" >&2; exit 1; }
[ "$(otool -D "$APP/Contents/Frameworks/libagent_desktop_ffi.dylib" | grep -c '^@rpath/libagent_desktop_ffi.dylib$')" -ge 1 ] || { echo "bundle: the engine's install name isn't @rpath" >&2; exit 1; }
if otool -l "$APP/Contents/MacOS/$EXECUTABLE" | grep -A2 LC_RPATH | grep -q "$PWD/engine/lib"; then echo "bundle: the app still points at the build folder" >&2; exit 1; fi
echo "built $APP ($VERSION, $(lipo -archs "$APP/Contents/MacOS/$EXECUTABLE"))"

if [ "${1:-}" = "--install" ]; then
  scripts/install-app.sh "$APP"
fi
[ -z "${ADHOC_NOTE:-}" ] || echo "$ADHOC_NOTE"
