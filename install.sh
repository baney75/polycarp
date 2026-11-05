#!/bin/bash
# Installs Polycarp on a Mac:
#   curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
# Builds the workspace app and the `polycarp` command from source, on this Mac, then opens the app.
# It asks macOS for nothing itself: Polycarp's welcome window walks you through each permission.
# Run it again any time to update. POLYCARP_REF picks a branch or tag.
# POLYCARP_SOURCE=/path/to/checkout builds that checkout instead of downloading.
set -euo pipefail

REPO="https://github.com/baney75/polycarp.git"
REF="${POLYCARP_REF:-main}"
if [ -t 1 ]; then
  bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
  green=$(tput setaf 2 2>/dev/null || true)
else bold=""; dim=""; reset=""; green=""; fi
LOG="$HOME/Library/Logs/polycarp-install.log"
mkdir -p "$(dirname "$LOG")"; : > "$LOG"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say()  { printf '%s\n' "$*"; }
fail() { printf '\n%sPolycarp was not installed.%s %s\n' "$bold" "$reset" "$1" >&2
         [ -s "$LOG" ] && printf '\nThe last lines of the log (%s):\n' "$LOG" >&2 && tail -15 "$LOG" >&2
         exit 1; }
# step "What it's doing" command...: one calm line, and the output kept in the log.
step() {
  local label=$1 start=$SECONDS; shift
  printf '  %s…' "$label"
  if "$@" >>"$LOG" 2>&1; then printf '\r  %s✓%s %s %s(%ss)%s\033[K\n' "$green" "$reset" "$label" "$dim" "$((SECONDS - start))" "$reset"
  else printf '\r  ✗ %s\033[K\n' "$label"; fail "That step didn't finish."; fi
}

say ""; say "${bold}Polycarp${reset}  ${dim}Bear much fruit.${reset}"; say ""

[ "$(uname -s)" = Darwin ] || fail "This installer is for a Mac. The polycarp command runs elsewhere: cargo install --git $REPO polycarp"
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || fail "Polycarp needs macOS 13 Ventura or later."
if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swift >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  fail "It needs Apple's free command line tools first. A macOS window just opened: click Install, then run this again."
fi
# rustup's default spot, for a shell that hasn't picked it up yet.
[ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || fail "It needs Rust to build. Install it from https://rustup.rs, then run this again."

if [ -n "${POLYCARP_SOURCE:-}" ]; then
  SRC=$(cd "$POLYCARP_SOURCE" && pwd)
else
  step "Downloading" git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$REF" "$REPO" "$WORK/polycarp"
  SRC="$WORK/polycarp"
fi

BIN="$HOME/.local/bin"
step "Building the polycarp command" cargo install --quiet --locked --force --path "$SRC/cli" --root "$HOME/.local"

# Apple silicon builds for itself, which is much quicker than a universal app.
if [ "$(uname -m)" = arm64 ]; then export BANEYSPACES_ARM64_ONLY=1; fi
cd "$SRC/spaces"
step "Building the hands engine" scripts/build-engine.sh
step "Building Polycarp (a few minutes the first time)" scripts/bundle.sh

# The old app can't run beside Polycarp, and its login item and watchdog would come back after a
# restart. It goes to the Trash, where you can put it back; its settings stay, since Polycarp
# imports them on first launch.
retire_baneyspaces() {
  local label="com.baney.baneyspaces.mc-watchdog" plist="$HOME/Library/LaunchAgents/com.baney.baneyspaces.mc-watchdog.plist"
  if [ -f "$plist" ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
  fi
  local app
  for app in "$HOME/Applications/BaneySpaces.app" "/Applications/BaneySpaces.app"; do
    [ -d "$app" ] && mv "$app" "$HOME/.Trash/BaneySpaces-$(date +%Y%m%d-%H%M%S).app"
  done
  return 0
}
OLD_APP=""
for a in "$HOME/Applications/BaneySpaces.app" "/Applications/BaneySpaces.app"; do [ -d "$a" ] && OLD_APP="$a"; done
if [ -n "$OLD_APP" ] && pgrep -x BaneySpaces >/dev/null; then
  step "Quitting BaneySpaces" osascript -e 'tell application id "com.baney.baneyspaces" to quit'
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x BaneySpaces >/dev/null || break; sleep 1; done
  pgrep -x BaneySpaces >/dev/null && fail "BaneySpaces didn't quit. Quit it from its menu, then run this again."
fi
[ -z "$OLD_APP" ] || step "Moving BaneySpaces to the Trash (its settings stay)" retire_baneyspaces

# The Polycarp theme, unless you've already chosen something.
CFG="${POLYCARP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/polycarp}"
[ -e "$CFG/config.toml" ] || step "Setting the Polycarp theme" "$BIN/polycarp" theme set polycarp

step "Opening Polycarp" scripts/install-app.sh "build/Polycarp.app"

say ""
say "  ${bold}Almost there.${reset} The Polycarp window on your screen needs one switch from you."
say ""
case ":$PATH:" in *":$BIN:"*) ;; *) say "  ${dim}Add $BIN to your PATH to use the polycarp command.${reset}"; say "" ;; esac
say "  ${dim}Change how it looks: polycarp theme list${reset}"
say "  ${dim}See what's installed: polycarp doctor${reset}"
say ""
