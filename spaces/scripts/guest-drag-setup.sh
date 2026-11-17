#!/bin/bash
# Runs inside the throwaway Tart guest, from scripts/guest-drag.sh (never on a real Mac: it writes the system TCC
# database). Installs the browser and the Polycarp build from the read-only shares, grants them and the drag driver
# Accessibility, sets the window tiling settings Donovan's Mac has, and starts Polycarp and the browser.
#   setup.sh <no-polycarp 0|1>
set -euo pipefail
NO_POLYCARP=${1:-0}
SHARE="/Volumes/My Shared Files"
GUSER=admin
GUID=$(id -u "$GUSER")
GHOME=$(dscl . -read "/Users/$GUSER" NFSHomeDirectory | awk '{print $2}')
# GUI work runs in the guest user's login session, whoever tart exec runs us as.
as_user() { if [ "$(id -u)" = "$GUID" ]; then "$@"; else sudo -n launchctl asuser "$GUID" sudo -n -u "$GUSER" "$@"; fi; }

# A real Mac would refuse this; the guest must be the pinned image with SIP off.
if ! csrutil status | grep -q disabled; then
  echo "setup: SIP is on in this guest, so its TCC database can't be written: $(csrutil status)" >&2
  exit 5
fi

sudo -n rm -rf /Applications/Browser.app /Applications/Polycarp.app
sudo -n ditto "$SHARE/browser" /Applications/Browser.app
[ "$NO_POLYCARP" = 1 ] || sudo -n ditto "$SHARE/stage/Polycarp.app" /Applications/Polycarp.app
sudo -n install -m 755 -o "$GUSER" "$SHARE/stage/real-drag" "$GHOME/real-drag"
sudo -n xattr -dr com.apple.quarantine /Applications/Browser.app /Applications/Polycarp.app "$GHOME/real-drag" 2>/dev/null || true

# TCC: Accessibility, Post Event and Listen Event for Polycarp (by bundle id), the driver (by path) and the guest agent
# that starts it (macOS asks about the responsible process).
AGENT=$(ps -axo comm= | grep -m1 -i 'tart-guest-agent' || true)
DB="/Library/Application Support/com.apple.TCC/TCC.db"
now=$(date +%s)
grant() { # service client client_type
  sudo -n sqlite3 "$DB" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, flags, last_modified, boot_uuid, last_reminded) VALUES ('$1', '$2', $3, 2, 4, 1, 'UNUSED', 0, $now, 'UNUSED', 0);"
}
for svc in kTCCServiceAccessibility kTCCServicePostEvent kTCCServiceListenEvent; do
  [ "$NO_POLYCARP" = 1 ] || grant "$svc" com.baney.polycarp 0
  grant "$svc" "$GHOME/real-drag" 1
  [ -z "$AGENT" ] || grant "$svc" "$AGENT" 1
done
grant kTCCServiceScreenCapture com.baney.polycarp 0
sudo -n killall -9 tccd 2>/dev/null || true

# Donovan's window tiling: fill by a drag to the top on, tile margins off.
as_user defaults write com.apple.WindowManager EnableTopTilingByEdgeDrag -bool true
as_user defaults write com.apple.WindowManager EnableTiledWindowMargins -bool false
# Polycarp starts with every part on, as on his Mac (no welcome), and parks Helium the way he has it.
as_user defaults write com.baney.polycarp welcomeFinished -bool true
as_user defaults write com.baney.polycarp setupShown -bool true
as_user defaults write com.baney.polycarp loginItemChosen -bool true
as_user defaults write com.baney.polycarp workspaceDock -bool true
as_user defaults write com.baney.polycarp viewerReplacesMissionControl -bool false
as_user defaults write com.baney.polycarp parkInsteadOfHide -array net.imput.helium org.chromium.Chromium com.google.chrome.for.testing
sleep 2

if [ "$NO_POLYCARP" = 0 ]; then
  as_user open -g /Applications/Polycarp.app
  for _ in $(seq 1 30); do
    grep -q "launch:" "$GHOME/Library/Application Support/Polycarp/trace.log" 2>/dev/null && break
    sleep 1
  done
  grep -q "launch:" "$GHOME/Library/Application Support/Polycarp/trace.log" 2>/dev/null || { echo "setup: Polycarp wrote no launch line" >&2; exit 6; }
fi
PROFILE=$(as_user mktemp -d /tmp/drag-profile.XXXXXX)
as_user open -n /Applications/Browser.app --args "--user-data-dir=$PROFILE" --no-first-run --no-default-browser-check \
  --disable-sync --disable-features=Translate about:blank
for _ in $(seq 1 30); do
  as_user osascript -e 'tell application "System Events" to count windows of (first process whose bundle identifier is not "")' >/dev/null 2>&1 && break
  sleep 1
done
sleep 4
echo "setup: ready ($(sw_vers -productVersion), Polycarp $([ "$NO_POLYCARP" = 1 ] && echo off || echo on))"
