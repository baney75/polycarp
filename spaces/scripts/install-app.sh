#!/bin/bash
# Installs a built Polycarp.app and starts it:
#   scripts/install-app.sh path/to/Polycarp.app
#   scripts/install-app.sh --in-place path/to/Polycarp.app
# bundle.sh --install runs this on what it just built, and install.sh runs the copy inside the
# downloaded app (Contents/Resources/install-app.sh) on the prebuilt release.
#
# Where it goes: BANEYSPACES_INSTALL_DIR if set (the updater sets it to the folder the running
# app is in), else the folder of the Polycarp.app already installed (~/Applications, then
# /Applications), else ~/Applications. One copy only.
#
# --in-place: the app is already where it should be (dragged there from the disk image). Nothing
# is quit, copied, registered or opened; this only does the rest: AeroSpace steps aside, the
# ~/.local/bin command links (polycarp-spaces, baneyspaces, ghostdeck) point at that app, Ghostdeck goes to the Trash. The app runs it
# once at launch when its command link is missing.
#
# BANEYSPACES_DEST_DIR: test mode. Install into this folder and change nothing else: the running
# copy, AeroSpace, Ghostdeck, Launch Services and ~/.local/bin are left alone and the app isn't
# opened. (With --in-place, test mode leaves AeroSpace and Ghostdeck alone but makes the links.)
# BANEYSPACES_NO_LAUNCH=1: install as usual but don't open the app.
# The app's name, identifier and command names come from product.env, which sits beside this script
# (scripts/ in the repo, Contents/Resources in the app).
source "$(dirname "${BASH_SOURCE[0]}")/product.env"
set -euo pipefail
IN_PLACE=0
if [ "${1:-}" = "--in-place" ]; then IN_PLACE=1; shift; fi
[ $# -eq 1 ] && [ -d "$1" ] || { echo "usage: install-app.sh [--in-place] path/to/$PRODUCT_NAME.app" >&2; exit 1; }
APP=$(cd "$1" && pwd)
TEST="${BANEYSPACES_DEST_DIR:-}"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ "$IN_PLACE" = 1 ]; then
  DEST="$APP"
else
  DEST_DIR="${BANEYSPACES_DEST_DIR:-${BANEYSPACES_INSTALL_DIR:-}}"
  if [ -z "$DEST_DIR" ]; then
    DEST_DIR="$HOME/Applications"
    for dir in "$HOME/Applications" /Applications; do
      if [ -d "$dir/$PRODUCT_NAME.app" ]; then DEST_DIR="$dir"; break; fi
    done
  fi
  DEST="$DEST_DIR/$PRODUCT_NAME.app"
fi

# macOS ties the Accessibility permission to the signature. An ad-hoc (or missing) signature is new
# on every build, so putting one over an installed copy is an update that makes macOS ask again.
# bundle.sh falls back to ad-hoc when the local signing identity fails, so refuse here, before
# anything is quit or replaced. A first install (no copy there yet) is allowed.
if [ "$IN_PLACE" = 0 ] && [ -d "$DEST" ]; then
  SIGNATURE=$(codesign -dvv "$APP" 2>&1 || true)
  if ! grep -q '^Authority=' <<<"$SIGNATURE"; then
    echo "error: this build is signed ad-hoc, so installing it over $DEST would make macOS ask for Accessibility again. Nothing was changed. Check scripts/signing-identity.sh and build again." >&2
    exit 1
  fi
fi

if [ "$IN_PLACE" = 0 ] && [ -z "$TEST" ]; then
  # Quit by bundle ID so the app brings every hidden window back before it exits.
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do pgrep -f "$DEST/Contents/MacOS/$EXECUTABLE" >/dev/null || break; sleep 0.2; done
  if pgrep -f "$DEST/Contents/MacOS/$EXECUTABLE" >/dev/null; then
    echo "$PRODUCT_NAME is still running; quit it from the menu bar and run this again." >&2
    exit 1
  fi
  # Only one copy runs, so a running $LEGACY_NAME would make the new app hand over to it and exit.
  # Quitting is the gentle way out (it puts every window and the Dock back first); nothing of it is
  # removed, and it stays installed until the person removes it.
  if pgrep -f "$LEGACY_NAME.app/Contents/MacOS/$LEGACY_NAME" >/dev/null; then
    osascript -e "tell application id \"$LEGACY_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 75); do pgrep -f "$LEGACY_NAME.app/Contents/MacOS/$LEGACY_NAME" >/dev/null || break; sleep 0.2; done
    if pgrep -f "$LEGACY_NAME.app/Contents/MacOS/$LEGACY_NAME" >/dev/null; then
      echo "$LEGACY_NAME is still running; quit it from the menu bar and run this again." >&2
      exit 1
    fi
  fi
  # Silas, the dictation app, has its voice inside $PRODUCT_NAME now, and two apps on one key fight. It quits the
  # same way; it goes to the Trash after the install below (its data folder stays).
  if pgrep -f "$SILAS_NAME.app/Contents/MacOS/" >/dev/null; then
    osascript -e "tell application id \"$SILAS_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 75); do pgrep -f "$SILAS_NAME.app/Contents/MacOS/" >/dev/null || break; sleep 0.2; done
    if pgrep -f "$SILAS_NAME.app/Contents/MacOS/" >/dev/null; then
      echo "$SILAS_NAME is still running; quit it from the menu bar and run this again." >&2
      exit 1
    fi
  fi
fi

if [ -z "$TEST" ]; then
  # Two workspace managers on the same keys fight, so AeroSpace steps aside: it quits, it stops
  # opening at login, and its config stops re-adding it. The app itself stays installed.
  # Each change is written down first, so uninstall.sh can put it back.
  STATE="$HOME/Library/Application Support/$SUPPORT_FOLDER"
  mkdir -p "$STATE"
  if [ -f "$HOME/.aerospace.toml" ] && grep -q '^start-at-login *= *true' "$HOME/.aerospace.toml"; then
    touch "$STATE/aerospace-start-at-login"
    sed -i '' 's/^start-at-login *= *true/start-at-login = false/' "$HOME/.aerospace.toml"
  fi
  if pgrep -xq AeroSpace; then
    osascript -e 'tell application id "bobko.aerospace" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do pgrep -xq AeroSpace || break; sleep 0.2; done
    if pgrep -xq AeroSpace; then
      echo "AeroSpace is still running; quit it from its menu bar icon and run this again." >&2
      exit 1
    fi
  fi
  aero=$(osascript -e 'tell application "System Events" to get the path of login item "AeroSpace"' 2>/dev/null || true)
  [ -n "$aero" ] && printf '%s' "$aero" > "$STATE/aerospace-login-item"
  osascript -e 'tell application "System Events" to delete login item "AeroSpace"' >/dev/null 2>&1 || true
  if osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -q AeroSpace; then
    echo "warning: AeroSpace is still a login item; remove it in System Settings › General › Login Items." >&2
  fi
fi

if [ "$IN_PLACE" = 0 ]; then
  rm -rf "$DEST"
  mkdir -p "$DEST_DIR"
  cp -R "$APP" "$DEST"
  if [ -n "$TEST" ]; then
    echo "installed $DEST (test mode: nothing else changed)"
    exit 0
  fi
  "$LSREGISTER" -f "$DEST"
  "$LSREGISTER" -u "$APP" 2>/dev/null || true
fi

if [ -z "$TEST" ]; then
  # The session engine replaces Ghostdeck, its standalone predecessor: two sidebars on the same windows would
  # fight. Ghostdeck quits and goes to the Trash (recoverable), and its command name now runs ours.
  osascript -e 'tell application id "com.baney.ghostdeck" to quit' >/dev/null 2>&1 || true
  if [ -d "$HOME/Applications/Ghostdeck.app" ]; then
    for _ in $(seq 1 25); do pgrep -f "Ghostdeck.app/Contents/MacOS/Ghostdeck" >/dev/null || break; sleep 0.2; done
    mv "$HOME/Applications/Ghostdeck.app" "$HOME/.Trash/Ghostdeck-$(date +%Y%m%d-%H%M%S).app"
    echo "moved Ghostdeck.app to the Trash; the session engine in $PRODUCT_NAME replaces it"
  fi
fi
if [ -z "$TEST" ]; then
  # This build includes voice, so Silas has nothing left to do. Recoverable: the Trash, never rm. Its data
  # (~/Library/Application Support/Silas) is not touched; Polycarp copied what it needs.
  for dir in /Applications "$HOME/Applications"; do
    if [ -d "$dir/$SILAS_NAME.app" ]; then
      mv "$dir/$SILAS_NAME.app" "$HOME/.Trash/$SILAS_NAME-$(date +%Y%m%d-%H%M%S).app"
      echo "moved $dir/$SILAS_NAME.app to the Trash; voice is inside $PRODUCT_NAME now (its data stays)"
    fi
  done
fi
mkdir -p "$HOME/.local/bin"
# polycarp-spaces is the command; baneyspaces and ghostdeck stay as names for it, because agents and
# hooks on other machines call them.
for name in $CLI_NAME $CLI_ALIASES; do
  ln -sf "$DEST/Contents/Resources/bin/$CLI_NAME" "$HOME/.local/bin/$name"
done
if [ "$IN_PLACE" = 0 ] && [ "${BANEYSPACES_NO_LAUNCH:-}" != 1 ]; then open "$DEST"; fi
echo "installed $DEST and ~/.local/bin/$CLI_NAME"
