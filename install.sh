#!/bin/bash
# Installs Polycarp on a Mac:
#   curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
# Mac: downloads the signed app, which holds workspaces and the `polycarp` command, and opens it. No developer
# tools needed. POLYCARP_FROM_SOURCE=1 builds it on this Mac instead.
# It asks macOS for nothing itself: Polycarp's welcome window walks you through each permission.
# Run it again any time to update. POLYCARP_REF picks a branch or tag. The download is the newest build of main, from
# the `nightly` release.
# POLYCARP_SOURCE=/path/to/checkout builds that checkout instead of downloading.
# Linux: the Linux and Omarchy desktop is retired. Run there, this prints one line saying so and installs nothing.
# Polycarp has no parts to choose: workspaces always run. POLYCARP_FEATURES is read only for the parts that left. One that
# names browser prints that the agent browser extension was removed (BROWSER_MOVED below) and installs nothing; one that names
# voice prints where Silas is and carries on. Anything else in it is ignored, and so is an old features.toml.
# Companion apps, each from its own official installer and only when asked: Silas (dictation) and Shotate (screenshots
# and recordings). `curl ... | bash -s -- --with silas,shotate` or POLYCARP_WITH=silas,shotate picks them; at a terminal with
# neither, the installer asks once and Return means none. A companion that fails is named; Polycarp stays installed.
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
  local WITH="${POLYCARP_WITH:-}" asked_with=""
  [ -n "${POLYCARP_WITH+x}" ] && asked_with=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --with) WITH="${2:-}"; asked_with=1; shift 2 || shift ;;
      --with=*) WITH="${1#--with=}"; asked_with=1; shift ;;
      *) shift ;;
    esac
  done
  local REPO="https://github.com/baney75/polycarp.git"
  local REF="${POLYCARP_REF:-main}"
  # Where the ready-made app comes from (fetch_app), and the signature every release has to carry.
  local RELEASES="${POLYCARP_RELEASES:-https://github.com/baney75/polycarp/releases/download}"
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

  # step_soft: as step, but a failure returns 1 instead of stopping the install (for companions).
  step_soft() {
    local label=$1 start=$SECONDS; shift
    printf '  %s…' "$label"
    if "$@" </dev/null >>"$LOG" 2>&1; then printf '\r  %s✓%s %s %s(%ss)%s\033[K\n' "$green" "$reset" "$label" "$dim" "$((SECONDS - start))" "$reset"
    else printf '\r  ✗ %s\033[K\n' "$label"; return 1; fi
  }

  say ""; say "${bold}Polycarp${reset}  ${dim}Bear much fruit.${reset}"; say ""

  local CFG="${POLYCARP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/polycarp}"
  [ "$(uname -s)" = Darwin ] || fail "This installer is for a Mac. The polycarp command runs elsewhere: cargo install --git $REPO polycarp"
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || fail "Polycarp needs macOS 13 Ventura or later."
  local BIN="$HOME/.local/bin"
  # 1. Get the app. Nothing on this Mac changes until it is here and checked.
  local NEW_APP="" from_source="${POLYCARP_FROM_SOURCE:-}" ZIP="${POLYCARP_ZIP:-}"
  [ -z "${POLYCARP_SOURCE:-}" ] || from_source=1
  # A branch or tag asked for by name is built from source: the ready-made download is a channel's build, not that ref.
  [ -z "${POLYCARP_REF:-}" ] || from_source=1
  # The ready-made app is for Apple silicon for now.
  [ "$(uname -m)" = arm64 ] || from_source=1
  local FROM="" got
  if [ "$from_source" != 1 ]; then
    if [ -z "$ZIP" ]; then
      ZIP="$WORK/Polycarp.zip"
      local fetched=0
      got=$(fetch_app "$ZIP") || fetched=$?
      case $fetched in
        0) FROM=$got ;;
        2) fail "Couldn't reach the Polycarp release (see $LOG). Nothing was changed; try again in a minute." ;;
        *)
          say "  ${dim}No ready-made app to download right now, so this builds it here.${reset}"
          ZIP=""; from_source=1 ;;
      esac
    fi
  fi
  if [ "$from_source" != 1 ]; then
    if [ -z "${POLYCARP_ZIP:-}" ]; then
      local want
      # The checksum comes from the release the zip came from.
      want=$(curl -fsSL "$FROM/Polycarp.zip.sha256" </dev/null 2>>"$LOG" | awk '{print $1}') \
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
    # A build here is a local build (bundle.sh), whatever the environment says. An older checkout reads POLYCARP_CHANNEL.
    step "Building Polycarp (a few minutes the first time)" env -u POLYCARP_RELEASE -u POLYCARP_CHANNEL scripts/bundle.sh
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

  # 5. Open it. (Test mode never opens anything.)
  if [ -z "$test_mode" ]; then
    local dest
    for dest in "$HOME/Applications/Polycarp.app" "/Applications/Polycarp.app"; do [ -d "$dest" ] && break; done
    step "Opening Polycarp" open "$dest"
  fi

  # Companions, after Polycarp is open: what --with or POLYCARP_WITH named, else one question at a terminal. Each
  # runs its own installer.
  local picked
  if [ -z "$asked_with" ] && [ -z "$test_mode" ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
    WITH=$(ask_companions </dev/tty)
  fi
  picked=$(companion_list "$WITH")
  if [ -n "$picked" ]; then
    local c
    for c in $picked; do
      if [ -n "$test_mode" ]; then say "  ${dim}Would install $(companion_name "$c"): $(companion_command "$c")${reset}"; continue; fi
      if ! (step_soft "Installing $(companion_name "$c")" companion_install "$c"); then
        say "  ${dim}$(companion_name "$c") didn't install; Polycarp is fine. Try it alone: $(companion_command "$c") (log: $LOG)${reset}"
      fi
    done
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
LINUX_MOVED="Polycarp runs on macOS and Windows. The Linux desktop is retired."
# The line a run that names the browser prints (BROWSER_MOVED in cli/src/main.rs says the same).
BROWSER_MOVED="The agent browser extension was removed from Polycarp."

# The parts POLYCARP_FEATURES ($1) names that left: one line each saying so. Returns 1 when the install must stop there
# (only the browser was asked for, and it was removed), 0 to carry on. `workspaces,browser`, the old
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

# fetch_app <zip>: downloads the ready-made app to <zip> from the `nightly` release and prints that release's
# folder, so the checksum comes from the same release (docs/releases.md). Returns 1 when it has no app (HTTP 404, or
# no file at a file:// stand-in), 2 when it couldn't be read (a network error, a 5xx), so a blip never turns into a
# source build.
fetch_app() {
  local zip=$1 url="$RELEASES/nightly" code rc=0
  code=$(curl -sSL -o "$zip" -w '%{http_code}' "$url/Polycarp.zip" </dev/null 2>>"$LOG") || rc=$?
  case "$rc:$code" in
    0:200|0:000) printf '%s\n' "$url"; return 0 ;;
    0:404|37:*) rm -f "$zip"; return 1 ;;
    *) rm -f "$zip"; printf 'fetch_app: %s answered %s (curl exit %s)\n' "$url" "$code" "$rc" >>"$LOG"; return 2 ;;
  esac
}

# The companions, in the order the question lists them.
COMPANIONS="silas shotate"
companion_name() {
  case "$1" in silas) echo Silas ;; shotate) echo Shotate ;; esac
}
companion_blurb() {
  case "$1" in
    silas) echo "dictation anywhere" ;;
    shotate) echo "screenshots and screen recordings" ;;
  esac
}
# Each companion's own official installer, exactly as its README gives it.
companion_command() {
  case "$1" in
    silas) echo 'curl -fsSL https://raw.githubusercontent.com/baney75/silas/main/install.sh | sh' ;;
    shotate) echo 'curl -fsSL https://raw.githubusercontent.com/baney75/shotate/main/install.sh | bash' ;;
  esac
}
# companion_install <companion>: download its installer and run it. pipefail, so a download that fails (a 404, no
# network) fails here instead of feeding an empty script to a shell that then reports success.
companion_install() {
  bash -o pipefail -c "$(companion_command "$1")" </dev/null
}
# companion_list "<list>": the companions a comma- or space-separated list names, each once, in COMPANIONS order.
# Accepts names (any case), the question's numbers 1 and 2, and "all". Prints
# one line naming anything it doesn't know, on stderr.
companion_list() {
  local raw w c out="" n
  raw=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  local -a words=()
  read -r -a words <<<"$(printf '%s' "$raw" | tr ',' ' ')" || true # read splits without expanding * or ?
  for w in ${words[@]+"${words[@]}"}; do
    case "$w" in all) out="$COMPANIONS"; continue ;; esac
    if [[ "$w" =~ ^[1-2]$ ]]; then n=0; for c in $COMPANIONS; do n=$((n + 1)); if [ "$n" = "$w" ]; then w=$c; fi; done; fi
    if names_part "$w" "${COMPANIONS// /,}"; then out="$out $w"
    else printf '  Not a companion: %s (choose from %s)\n' "$w" "${COMPANIONS// /, }" >&2; fi
  done
  local picked=""
  for c in $COMPANIONS; do if names_part "$c" "${out// /,}"; then picked="$picked $c"; fi; done
  printf '%s' "${picked# }"
}
# One question at a terminal; prints the answer for companion_list. Return alone means none.
ask_companions() {
  local c n=0 answer=""
  {
    printf '\n  Also install (optional, each is its own app):\n'
    for c in $COMPANIONS; do n=$((n + 1)); printf '    %s  %-13s %s\n' "$n" "$(companion_name "$c")" "$(companion_blurb "$c")"; done
    printf '  Numbers to add, like 1 2 (Return for none): '
  } >&2
  read -r -t 120 answer || answer="" # no answer in two minutes means none
  printf '%s' "$answer"
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
