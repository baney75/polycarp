#!/bin/bash
# Installs Polycarp on a Mac:
#   curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
# Builds the workspace app and the `polycarp` command from source, on this Mac, then opens the app.
# It asks macOS for nothing itself: Polycarp's welcome window walks you through each permission.
# Run it again any time to update. POLYCARP_REF picks a branch or tag.
# POLYCARP_SOURCE=/path/to/checkout builds that checkout instead of downloading.
# Everything is inside main(), called on the last line: run through a pipe (curl | bash), a download that
# stops halfway runs nothing, and no step can read the script's own text from stdin.
set -euo pipefail

main() {
  local REPO="https://github.com/baney75/polycarp.git"
  local REF="${POLYCARP_REF:-main}"
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

  [ "$(uname -s)" = Darwin ] || fail "This installer is for a Mac. The polycarp command runs elsewhere: cargo install --git $REPO polycarp"
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || fail "Polycarp needs macOS 13 Ventura or later."
  if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swift >/dev/null 2>&1; then
    xcode-select --install >/dev/null 2>&1 </dev/null || true
    fail "It needs Apple's free command line tools first. A macOS window just opened: click Install, then run this again."
  fi
  # rustup's default spot, for a shell that hasn't picked it up yet.
  [ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"
  command -v cargo >/dev/null || fail "It needs Rust to build. Install it from https://rustup.rs, then run this again."

  local SRC
  if [ -n "${POLYCARP_SOURCE:-}" ]; then
    SRC=$(cd "$POLYCARP_SOURCE" && pwd)
  else
    step "Downloading" git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$REF" "$REPO" "$WORK/polycarp"
    SRC="$WORK/polycarp"
  fi

  local BIN="$HOME/.local/bin"
  # 1. Build everything first. Nothing on this Mac changes until all of it has built.
  step "Building the polycarp command" cargo build --quiet --release --locked --manifest-path "$SRC/cli/Cargo.toml" --target-dir "$WORK/cli-target"
  # Apple silicon builds for itself, which is much quicker than a universal app.
  if [ "$(uname -m)" = arm64 ]; then export BANEYSPACES_ARM64_ONLY=1; fi
  cd "$SRC/spaces"
  step "Building the hands engine" scripts/build-engine.sh
  step "Building Polycarp (a few minutes the first time)" scripts/bundle.sh

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
  STEP_FAIL="$install_failed" step "Installing Polycarp" scripts/install-app.sh "build/Polycarp.app"
  HEADING="Polycarp is installed, but one step didn't finish."
  # The command goes in only now, so a failed build leaves the one you had.
  mkdir -p "$BIN"
  step "Installing the polycarp command" install -m 755 "$WORK/cli-target/release/polycarp" "$BIN/polycarp"

  # 4. Only now retire the old app: stop its watchdog and move it to the Trash, where you can put it back.
  # Its settings stay, since Polycarp copies them on first launch.
  if [ ${#OLD_APPS[@]} -gt 0 ]; then
    if [ -z "$test_mode" ]; then
      step "Stopping BaneySpaces' watchdog" retire_watchdog
    fi
    STEP_FAIL="Polycarp is installed, but BaneySpaces could not be moved to the Trash. Drag these to the Trash yourself, then open Polycarp: ${OLD_APPS[*]}" \
      RETIRE_TEST_MODE="$test_mode" step "Moving BaneySpaces to the Trash (its settings stay)" retire_apps
  fi

  # Only when asked (POLYCARP_TAKE_OVER_TABKYRA=1): point an npm-linked or Homebrew tabkyra at the helper in the app.
  # Without it, a working tabkyra that is already there is left as it is (install-app.sh).
  if [ "${POLYCARP_TAKE_OVER_TABKYRA:-}" = 1 ]; then
    local helper="" d
    for d in "$HOME/Applications" "/Applications"; do [ -x "$d/Polycarp.app/Contents/Resources/browser/polycarp-browser" ] && { helper="$d/Polycarp.app/Contents/Resources/browser/polycarp-browser"; break; }; done
    [ -z "$helper" ] || step "Pointing tabkyra at the browser helper in Polycarp" retire_tabkyra "$helper" "$test_mode"
  fi

  # The Polycarp theme, unless you've already chosen something.
  local CFG="${POLYCARP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/polycarp}"
  if [ ! -e "$CFG/config.toml" ] && ! "$BIN/polycarp" theme set polycarp </dev/null >>"$LOG" 2>&1; then
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

# Repoints the tabkyra commands that are provably Tabkyra's at the helper inside Polycarp.app, so one program answers to the
# name. A command counts only when it is a symlink whose real file is Tabkyra's: it names the native host (ai.tabkyra.bridge)
# or lives in a tabkyra Homebrew keg or npm package. Nothing is moved or deleted: a link is replaced by a link, the old target
# is written down in the Polycarp support folder (uninstall.sh puts it back), and the keg or package itself is untouched.
# A plain file, a link to anything else, or a name that isn't there is left alone. Test mode ($2 not empty) looks only in
# $HOME/.local/bin, so a temporary home can never reach /opt/homebrew or /usr/local.
retire_tabkyra() {
  local helper="$1" test_mode="${2:-}" dir link real note ok=0
  [ -x "$helper" ] || { echo "no helper at $helper" >&2; return 1; }
  note="$HOME/Library/Application Support/Polycarp/tabkyra-retired-links"
  local dirs=("$HOME/.local/bin")
  [ -n "$test_mode" ] || dirs+=(/opt/homebrew/bin /usr/local/bin)
  for dir in "${dirs[@]}"; do
    link="$dir/tabkyra"
    [ -L "$link" ] || continue
    real=$(cd "$(dirname "$link")" && cd "$(dirname "$(readlink "$link")")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$(readlink "$link")")") || continue
    [ -f "$real" ] || continue
    case "$real" in
      *Polycarp.app/Contents/Resources/browser/polycarp-browser) continue ;;   # already ours
    esac
    if ! { case "$real" in */Cellar/tabkyra/*|*/lib/node_modules/tabkyra/*) true ;; *) false ;; esac || grep -q 'ai\.tabkyra\.bridge' "$real" 2>/dev/null; }; then
      continue
    fi
    mkdir -p "$(dirname "$note")"
    printf '%s\t%s\n' "$link" "$(readlink "$link")" >> "$note"
    if ln -sf "$helper" "$link"; then echo "tabkyra at $link now runs $helper"; else echo "could not repoint $link" >&2; ok=1; fi
  done
  return $ok
}

[ -n "${POLYCARP_INSTALL_FUNCTIONS_ONLY:-}" ] || main "$@"
