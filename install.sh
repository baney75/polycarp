#!/bin/bash
# Installs Polycarp on a Mac:
#   curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
# Mac: downloads the signed app, which holds workspaces and the `polycarp` command, and opens it. No developer
# tools needed. POLYCARP_FROM_SOURCE=1 builds it on this Mac instead.
# It asks macOS for nothing itself: Polycarp's welcome window walks you through each permission.
# Run it again any time to update. POLYCARP_REF picks a branch or tag.
# POLYCARP_SOURCE=/path/to/checkout builds that checkout instead of downloading.
# Linux: the Linux and Omarchy desktop is retired. Run there, this prints one line saying so and installs nothing.
# Polycarp has no parts to choose: workspaces always run. POLYCARP_FEATURES is read only for the parts that left. One that
# names browser prints where the helper went (BROWSER_MOVED below) and installs nothing; one that names voice prints where
# Silas is and carries on. Anything else in it is ignored, and so is an old features.toml.
# Everything is inside main(), called on the last line: run through a pipe (curl | bash), a download that
# stops halfway runs nothing, and no step can read the script's own text from stdin.
set -euo pipefail

main() {
  # Tests source this file for its functions and run nothing.
  [ -z "${POLYCARP_INSTALL_FUNCTIONS_ONLY:-}" ] || return 0
  # Before anything is written, even the log.
  if [ "$(uname -s)" = Linux ]; then
    printf '%s\n' "$LINUX_MOVED"
    return 0
  fi
  moved_notes "${POLYCARP_FEATURES:-}" || return 0
  local REPO="https://github.com/baney75/polycarp.git"
  local REF="${POLYCARP_REF:-main}"
  # Where the ready-made app comes from, and the signature every release has to carry.
  local RELEASES="${POLYCARP_RELEASES:-https://github.com/baney75/polycarp/releases/download}"
  local CHANNEL="${POLYCARP_CHANNEL:-preview}"
  local REQUIREMENT='identifier "com.baney.polycarp" and certificate leaf = H"d1cfbd7446f84f6c625b9db83c5bf96da33b157e"'
  local bold dim reset green
  if [ -t 1 ]; then
    bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
    green=$(tput setaf 2 2>/dev/null || true)
  else bold=""; dim=""; reset=""; green=""; fi
  LOG="$HOME/Library/Logs/polycarp-install.log"
  mkdir -p "$(dirname "$LOG")"; : > "$LOG"
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  # BANEYSPACES_DEST_DIR is test mode, as in install-app.sh: nothing outside it changes and nothing opens.
  local test_mode="${BANEYSPACES_DEST_DIR:-}"

  # What a failure says happened. It changes once Polycarp is in place.
  local HEADING="Polycarp was not installed."
  say()  { printf '%s\n' "$*"; }
  fail() { printf '\n%s%s%s %s\n' "$bold" "$HEADING" "$reset" "$1" >&2
           [ -s "$LOG" ] && printf '\nThe last lines of the log (%s):\n' "$LOG" >&2 && tail -15 "$LOG" >&2
           exit 1; }
  # step "What it's doing" command...: one calm line, and the output kept in the log. stdin is closed so
  # nothing a step runs can read the rest of this script.
  step() {
    local label=$1 start=$SECONDS; shift
    printf '  %s…' "$label"
    if "$@" </dev/null >>"$LOG" 2>&1; then printf '\r  %s✓%s %s %s(%ss)%s\033[K\n' "$green" "$reset" "$label" "$dim" "$((SECONDS - start))" "$reset"
    else printf '\r  ✗ %s\033[K\n' "$label"; fail "${STEP_FAIL:-That step did not finish.}"; fi
  }

  say ""; say "${bold}Polycarp${reset}  ${dim}Bear much fruit.${reset}"; say ""

  local CFG="${POLYCARP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/polycarp}"
  [ "$(uname -s)" = Darwin ] || fail "This installer is for a Mac. The polycarp command runs elsewhere: cargo install --git $REPO polycarp"
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || fail "Polycarp needs macOS 13 Ventura or later."
  local BIN="$HOME/.local/bin"
  # 1. Get the app. Nothing on this Mac changes until it is here and checked.
  local NEW_APP="" from_source="${POLYCARP_FROM_SOURCE:-}" ZIP="${POLYCARP_ZIP:-}"
  [ -z "${POLYCARP_SOURCE:-}" ] || from_source=1
  # A branch or tag asked for by name is built from source: the ready-made download is the preview channel, not that ref.
  [ -z "${POLYCARP_REF:-}" ] || from_source=1
  # The ready-made app is for Apple silicon for now.
  [ "$(uname -m)" = arm64 ] || from_source=1
  if [ "$from_source" != 1 ]; then
    if [ -z "$ZIP" ]; then
      ZIP="$WORK/Polycarp.zip"
      if ! curl -fsSL -o "$ZIP" "$RELEASES/$CHANNEL/Polycarp.zip" </dev/null 2>>"$LOG"; then
        say "  ${dim}No ready-made app to download right now, so this builds it here.${reset}"
        ZIP=""; from_source=1
      fi
    fi
  fi
  if [ "$from_source" != 1 ]; then
    if [ -z "${POLYCARP_ZIP:-}" ]; then
      local want
      want=$(curl -fsSL "$RELEASES/$CHANNEL/Polycarp.zip.sha256" </dev/null 2>>"$LOG" | awk '{print $1}') \
        || fail "Couldn't fetch the download's checksum. Nothing was changed; try again."
      [ "$want" = "$(shasum -a 256 "$ZIP" | awk '{print $1}')" ] \
        || fail "The download doesn't match its checksum. Nothing was changed; try again."
    fi
    step "Unpacking" ditto -x -k "$ZIP" "$WORK/app"
    NEW_APP="$WORK/app/Polycarp.app"
    [ -d "$NEW_APP" ] || fail "The download didn't contain Polycarp. Nothing was changed."
    # A release has to carry the release signature. Only a test's own local zip is exempt.
    if [ -z "$test_mode" ] || [ -z "${POLYCARP_ZIP:-}" ]; then
      codesign --verify --strict --deep "$NEW_APP" 2>>"$LOG" && codesign -v -R "=$REQUIREMENT" "$NEW_APP" 2>>"$LOG" \
        || fail "The download isn't signed with Polycarp's release key, so it was not installed."
    fi
    xattr -dr com.apple.quarantine "$NEW_APP" 2>/dev/null || true
  else
    if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swift >/dev/null 2>&1; then
      xcode-select --install >/dev/null 2>&1 </dev/null || true
      fail "Building it needs Apple's free command line tools. A macOS window just opened: click Install, then run this again."
    fi
    # rustup's default spot, for a shell that hasn't picked it up yet.
    [ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"
    command -v cargo >/dev/null || fail "Building it needs Rust. Install it from https://rustup.rs, then run this again."
    local SRC
    if [ -n "${POLYCARP_SOURCE:-}" ]; then
      SRC=$(cd "$POLYCARP_SOURCE" && pwd)
    else
      step "Downloading the source" git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$REF" "$REPO" "$WORK/polycarp"
      SRC="$WORK/polycarp"
    fi
    # Apple silicon builds for itself, which is much quicker than a universal app.
    if [ "$(uname -m)" = arm64 ]; then export BANEYSPACES_ARM64_ONLY=1; fi
    cd "$SRC/spaces"
    step "Building the hands engine" scripts/build-engine.sh
    step "Building Polycarp (a few minutes the first time)" scripts/bundle.sh
    NEW_APP="$PWD/build/Polycarp.app"
  fi

  # The old app, if it is installed. Only the copies at these two paths are ours to retire.
  # Test mode looks only under a temporary home, so it can never quit or move a real copy.
  local OLD_APPS=() a
  if [ -z "$test_mode" ] || [ "$HOME" != "$(eval echo "~$(id -un)")" ]; then
    while IFS= read -r a; do [ -d "$a" ] && OLD_APPS+=("$a"); done < <(old_app_paths "$test_mode")
  fi
  # 2. Quit it (it puts every window and the Dock back first). The two can't run together, so the install
  # step quits any running BaneySpaces too. Never in test mode.
  local running=""
  if [ -z "$test_mode" ]; then
    for a in ${OLD_APPS[@]+"${OLD_APPS[@]}"}; do pgrep -f "$a/Contents/MacOS/BaneySpaces" >/dev/null && running=1; done
  fi
  if [ -n "$running" ]; then
    step "Quitting BaneySpaces" osascript -e 'tell application id "com.baney.baneyspaces" to quit'
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      running=""
      for a in "${OLD_APPS[@]}"; do pgrep -f "$a/Contents/MacOS/BaneySpaces" >/dev/null && running=1; done
      [ -n "$running" ] || break
      sleep 1
    done
    [ -z "$running" ] || fail "BaneySpaces didn't quit, so nothing was changed. Quit it from its menu, then run this again."
  fi

  # 3. Install, without opening it. If this fails, BaneySpaces is still installed: you have an app to open.
  export BANEYSPACES_NO_LAUNCH=1
  local install_failed="If Polycarp is running, quit it from its menu, then run this again."
  [ ${#OLD_APPS[@]} -eq 0 ] || install_failed="BaneySpaces is still installed; open it again from Applications."
  STEP_FAIL="$install_failed" step "Installing Polycarp" "$NEW_APP/Contents/Resources/install-app.sh" "$NEW_APP"
  connector_notice "$LOG"
  HEADING="Polycarp is installed, but one step didn't finish."

  # 4. Only now retire the old app: stop its watchdog and move it to the Trash, where you can put it back.
  # Its settings stay, since Polycarp copies them on first launch.
  if [ ${#OLD_APPS[@]} -gt 0 ]; then
    if [ -z "$test_mode" ]; then
      step "Stopping BaneySpaces' watchdog" retire_watchdog
    fi
    STEP_FAIL="Polycarp is installed, but BaneySpaces could not be moved to the Trash. Drag these to the Trash yourself, then open Polycarp: ${OLD_APPS[*]}" \
      RETIRE_TEST_MODE="$test_mode" step "Moving BaneySpaces to the Trash (its settings stay)" retire_apps
  fi

  # The Polycarp theme, unless you've already chosen something.
  local installed="${test_mode:-$HOME/Applications}/Polycarp.app"
  [ -d "$installed" ] || installed="/Applications/Polycarp.app"
  if [ ! -e "$CFG/config.toml" ] && ! "$installed/Contents/Resources/bin/polycarp" theme set polycarp </dev/null >>"$LOG" 2>&1; then
    say "  ${dim}The theme wasn't set; Polycarp uses its own look. Try: polycarp theme set polycarp${reset}"
  fi

  # 5. Open it, last. (Test mode never opens anything.)
  if [ -z "$test_mode" ]; then
    local dest
    for dest in "$HOME/Applications/Polycarp.app" "/Applications/Polycarp.app"; do [ -d "$dest" ] && break; done
    step "Opening Polycarp" open "$dest"
  fi

  say ""
  # The welcome window asks for one switch on a first run, or when macOS has forgotten the permission.
  if [ -z "$test_mode" ] && [ "$(defaults read com.baney.polycarp welcomeFinished 2>/dev/null </dev/null || true)" = 1 ]; then
    say "  ${bold}Polycarp is updated.${reset}"
  else
    say "  ${bold}Almost there.${reset} The Polycarp window on your screen needs one switch from you."
  fi
  say ""
  case ":$PATH:" in *":$BIN:"*) ;; *) say "  ${dim}Add $BIN to your PATH to use the polycarp command.${reset}"; say "" ;; esac
  say "  ${dim}Change how it looks: polycarp theme list${reset}"
  say "  ${dim}See what's installed: polycarp doctor${reset}"
  say ""
}

# The one line a Linux run prints (LINUX_MOVED in cli/src/update.rs says the same).
LINUX_MOVED="Polycarp runs on macOS and Windows. The Linux desktop is retired. For browser and computer use on Linux, install Tychicus: https://github.com/baney75/tychicus"
# Where the browser helper is now, and the line it prints. The release asset names aren't final yet:
# change them here and nowhere else.
TYCHICUS_RELEASES="https://github.com/baney75/tychicus/releases/latest"
TYCHICUS_ASSET="tychicus-<version>-<platform>"
TYCHICUS_INSTALL='tar -xzf tychicus-*.tar.gz && ./tychicus-*/tychicus install --release .'
BROWSER_MOVED="The browser helper is now Tychicus: download $TYCHICUS_ASSET from $TYCHICUS_RELEASES, then \`$TYCHICUS_INSTALL\`"

# The parts POLYCARP_FEATURES ($1) names that left: one line each saying where they went. Returns 1 when the install must
# stop there (only the browser was asked for, and it is all Tychicus now), 0 to carry on. `workspaces,browser`, the old
# non-interactive answer, still installs.
moved_notes() {
  if names_part browser "$1"; then printf '%s\n' "$BROWSER_MOVED"; fi
  if names_part voice "$1"; then printf '  voice is Silas now, its own app: https://github.com/baney75/silas\n' >&2; fi
  ! { names_part browser "$1" && ! names_part workspaces "$1"; }
}

# The lines `polycarp update --retire-old-browser` writes about the remote connector (CONNECTOR_OFF and CONNECTOR_STAYS
# in cli/src/retire.rs), from the install log ($1) to the terminal: the step that ran it only shows a check mark.
connector_notice() {
  { grep -E '^Your remote connector ' "$1" 2>/dev/null || true; } | while IFS= read -r line; do printf '  %s\n' "$line"; done
  return 0
}

# True when a comma- or space-separated list of parts ($2) names the part $1.
names_part() {
  case ",${2//[[:space:]]/,}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# Where an old copy can be. Test mode leaves out /Applications, which a temporary home doesn't hide.
old_app_paths() {
  printf '%s\n' "$HOME/Applications/BaneySpaces.app"
  [ -n "$1" ] || printf '%s\n' "/Applications/BaneySpaces.app"
}

# Stops BaneySpaces' launch agent, which would otherwise start puts-things-back runs for an app that is gone.
retire_watchdog() {
  local label="com.baney.baneyspaces.mc-watchdog" plist="$HOME/Library/LaunchAgents/com.baney.baneyspaces.mc-watchdog.plist"
  if [ -f "$plist" ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
  fi
  return 0
}

# Moves each old copy to ~/.Trash under a name no other item has. Every move is checked: what could not be
# moved is named, so it can be removed by hand.
retire_apps() {
  local trash="$HOME/.Trash" app dest n failed=0 stamp
  mkdir -p "$trash" || { echo "could not create $trash" >&2; return 1; }
  stamp=$(date +%Y%m%d-%H%M%S)
  while IFS= read -r app; do
    [ -d "$app" ] || continue
    n=0; dest="$trash/BaneySpaces-$stamp.app"
    while [ -e "$dest" ]; do n=$((n + 1)); dest="$trash/BaneySpaces-$stamp-$n.app"; done
    if ! mv "$app" "$dest"; then echo "could not move $app to the Trash" >&2; failed=1; fi
  done < <(old_app_paths "$RETIRE_TEST_MODE")
  return $failed
}

main "$@"
