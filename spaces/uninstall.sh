#!/bin/bash
# Removes Polycarp from this Mac and puts back everything it changed:
#   curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/spaces/uninstall.sh | bash
# Settings > General > Uninstall Polycarp runs this same script.
# A BaneySpaces app that is still installed is never touched (Polycarp copied its settings, it never moved them).
# Quitting first brings every hidden window and app back on screen.
#
# Exits 0 when everything is removed and put back, 2 when everything is removed but something
# couldn't be put back (it says what, and keeps what's needed to finish by hand), 1 when it
# stopped before removing anything.
#
# BANEYSPACES_APP: the app to remove (default ~/Applications/Polycarp.app).
# BANEYSPACES_UNINSTALL_TEST=1: for the test only. Commands that touch the real Mac's
# settings, permissions or processes are printed instead of run; files under $HOME still go.
set -euo pipefail
bold=$(tput bold 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
APP="${BANEYSPACES_APP:-$HOME/Applications/Polycarp.app}"
APP="${APP%/}"
DATA="$HOME/Library/Application Support/Polycarp"
ID=com.baney.polycarp
# The app this one replaces. If it is still installed its hooks, skill and command links stay.
LEGACY_APP=""
for dir in "$HOME/Applications" /Applications; do
  [ "$dir" = "/Applications" ] && [ -n "${BANEYSPACES_UNINSTALL_TEST:-}" ] && continue
  if [ -x "$dir/BaneySpaces.app/Contents/MacOS/BaneySpaces" ]; then LEGACY_APP="$dir/BaneySpaces.app"; break; fi
done
TEST="${BANEYSPACES_UNINSTALL_TEST:-}"
# The real Mac's settings, permissions and processes: printed instead of run in the test.
# (To the script's own output, past any redirect on the command.)
exec 3>&1
sys() { if [ -n "$TEST" ]; then echo "would run: $*" >&3; else "$@"; fi; }
# What couldn't be put back, for the end.
problems=()
problem() { problems+=("$*"); }
running() {
  [ -z "$TEST" ] || return 1
  pgrep -f "Polycarp.app/Contents/MacOS/Polycarp" >/dev/null || pgrep -f "$APP/Contents/MacOS/" >/dev/null
}
# Its own settings. The test reads them from a plist file instead (BANEYSPACES_UNINSTALL_PREFS).
pref() {
  if [ -n "$TEST" ]; then [ -n "${BANEYSPACES_UNINSTALL_PREFS:-}" ] && defaults read "$BANEYSPACES_UNINSTALL_PREFS" "$1" 2>/dev/null || true
  else defaults read "$ID" "$1" 2>/dev/null || true; fi
}

# The test reads this Mac's settings as BANEYSPACES_UNINSTALL_MACOS says, not for real.
# BANEYSPACES_UNINSTALL_MACOS_<key> sets one setting (a - in the key is a _); BANEYSPACES_UNINSTALL_MACOS, every other.
macos_pref() {
  if [ -n "$TEST" ]; then v="BANEYSPACES_UNINSTALL_MACOS_${2//-/_}"; echo "${!v-${BANEYSPACES_UNINSTALL_MACOS:-}}"
  else defaults read "$1" "$2" 2>/dev/null || true; fi
}

# Puts macOS's Mission Control back from BaneySpaces' record of what was there. The Dock's switch
# (mcx-expose-disabled) and each hot corner BaneySpaces remapped from Mission Control go back to
# what the record says, but only while still as BaneySpaces left them (the switch on, the corner
# at 1): a setting changed since is the person's. A setting the record doesn't have wasn't there
# before, and is removed. A switch that was already on before BaneySpaces stays on, untouched.
restore_mission_control() {
  local mc_saved mc_changed corner was
  mc_saved=$(pref systemMissionControlSaved)
  # The app also keeps the record in a file of its own, which survives a crash that its settings don't.
  [ -n "$mc_saved" ] || mc_saved=$(defaults read "$DATA/mc-record" 2>/dev/null || true)
  [ -n "$mc_saved" ] || return 0
  mc_changed=""
  if [ "$(macos_pref com.apple.dock mcx-expose-disabled)" = "1" ]; then
    was=$(printf '%s\n' "$mc_saved" | sed -n 's|.*"com.apple.dock/mcx-expose-disabled" = \([01]\);.*|\1|p')
    if [ "$was" != 1 ]; then
      step "Putting back Mission Control"
      if [ -n "$was" ]; then sys defaults write com.apple.dock mcx-expose-disabled -bool false
      else sys defaults delete com.apple.dock mcx-expose-disabled 2>/dev/null || true; fi
      mc_changed=1
    fi
  fi
  for corner in tl tr bl br; do
    was=$(printf '%s\n' "$mc_saved" | sed -n "s|.*\"com.apple.dock/wvous-$corner-corner\" = \([0-9]*\);.*|\1|p")
    if [ -n "$was" ] && [ "$(macos_pref com.apple.dock "wvous-$corner-corner")" = "1" ]; then
      step "Putting back the $corner hot corner"
      sys defaults write com.apple.dock "wvous-$corner-corner" -int "$was"
      mc_changed=1
    fi
  done
  [ -z "$mc_changed" ] || sys killall Dock 2>/dev/null || true
  return 0
}

# The launch agent that did this when BaneySpaces had stopped running, and its files.
WATCHDOG=com.baney.polycarp.mc-watchdog
remove_watchdog() {
  # The plist first: when the agent is what runs this, unloading it ends this very process.
  rm -f "$HOME/Library/LaunchAgents/$WATCHDOG.plist"
  sys launchctl bootout "gui/$(id -u)/$WATCHDOG" >/dev/null 2>&1 || true
  return 0
}

# `uninstall.sh --restore-mission-control`: only that. The launch agent runs it (from a copy in
# BaneySpaces' folder) when BaneySpaces hasn't run for a minute, and it ends by forgetting the
# record, so the next launch saves what is there then.
if [ "${1:-}" = "--restore-mission-control" ]; then
  restore_mission_control
  sys defaults delete "$ID" systemMissionControlSaved >/dev/null 2>&1 || true
  rm -f "$DATA/mc-heartbeat" "$DATA/mc-updating" "$DATA/mc-record.plist"
  remove_watchdog
  exit 0
fi

step "Quitting Polycarp (it puts every window back first)"
sys osascript -e "tell application id \"$ID\" to quit" >/dev/null 2>&1 || true
for _ in $(seq 1 75); do running || break; sleep 0.2; done
# Its saved window positions are deleted below, so it must be gone first or a hidden window
# could lose its place.
if running; then
  echo "Polycarp is still running. Quit it from its menu bar icon, then run this again." >&2
  exit 1
fi
# From here on a failed step doesn't stop the rest: it's listed at the end, and the exit is 2.
set +e
trap 'problem "A step failed (line $LINENO of the uninstaller); the output above says which."' ERR
# Its record of shortcuts it turned off: a list with an id in it, or Spotlight's flag.
shortcuts_off() { pref freedShortcuts | grep -q '[0-9]' || [ "$(pref freedSpotlight)" = 1 ]; }

# The app knows how to undo its own changes to macOS. Already in the Trash still counts.
BIN=""
# The places it's installed; the test stays inside its made-up home.
# Each once: by default $APP is the first of these.
INSTALLED=("$APP")
for app in "$HOME/Applications/Polycarp.app" "/Applications/Polycarp.app"; do
  [ "$app" = "$APP" ] && continue
  [ "$app" = "/Applications/Polycarp.app" ] && [ -n "$TEST" ] && continue
  INSTALLED+=("$app")
done
for app in "${INSTALLED[@]}" "$HOME/.Trash/Polycarp"*.app; do
  if [ -x "$app/Contents/MacOS/Polycarp" ]; then BIN="$app/Contents/MacOS/Polycarp"; break; fi
done

if [ -n "$BIN" ]; then
  # Screenshot and Spotlight shortcuts that setup's Free Them or the launcher switched off go back on.
  step "Turning macOS's screenshot and Spotlight shortcuts back on (if Polycarp turned them off)"
  sys "$BIN" --restore-shortcuts >/dev/null 2>&1 || problem "macOS's screenshot or Spotlight shortcuts may still be off: turn them on in System Settings › Keyboard › Keyboard Shortcuts."
  # Quitting already brings the macOS Dock back; this covers a crash that didn't.
  sys "$BIN" --restore-dock >/dev/null 2>&1 || true
  step "Removing it from Login Items"
  sys "$BIN" --unregister-login >/dev/null 2>&1 \
    || problem "Polycarp may still be in Login Items: remove it in System Settings › General › Login Items."
elif shortcuts_off; then
  # Without the app the shortcuts can't be written back the way it turned them off, so its
  # record of them stays for the next install to finish the job.
  problem "macOS's screenshot or Spotlight shortcuts are still off (the app was already gone): turn them on in System Settings › Keyboard › Keyboard Shortcuts."
fi

# The Workspace Dock's own Dock settings, if the app wasn't there to put them back. Each goes
# back only if it's still at BaneySpaces' value; a setting changed since is the person's.
if [ -z "$TEST" ] && [ "$(defaults read com.apple.dock autohide-delay 2>/dev/null)" = "1000" ]; then
  step "Bringing the macOS Dock back"
  saved=$(pref systemDockSaved)
  delay=$(printf '%s\n' "$saved" | sed -n 's/.*"autohide-delay" = "\{0,1\}\([0-9.]*\)"\{0,1\};.*/\1/p')
  if [ -n "$delay" ]; then defaults write com.apple.dock autohide-delay -float "$delay"; else defaults delete com.apple.dock autohide-delay; fi
  if [ "$(defaults read com.apple.dock autohide 2>/dev/null)" = "1" ]; then
    hide=$(printf '%s\n' "$saved" | sed -n 's/.*[^-]autohide = "\{0,1\}\([01]\)"\{0,1\};.*/\1/p')
    if [ -n "$hide" ]; then defaults write com.apple.dock autohide -bool "$([ "$hide" = 1 ] && echo true || echo false)"
    else defaults delete com.apple.dock autohide 2>/dev/null || true; fi
  fi
  killall Dock 2>/dev/null || true
fi

# Mission Control for a window dragged to the top, if the app wasn't there to put it back. Only
# a setting still off as BaneySpaces left it goes back to its saved value. Fill-the-screen, which
# builds before 2026-10-28 turned off too, comes back on as the app does it, unless the app
# already gave it back or it was off before BaneySpaces.
# (macos_pref, above, reads this Mac's settings.)
top_drag_back() {  # domain key process what
  [ "$(macos_pref "$1" "$2")" = "0" ] || return 0
  step "Putting back $4 for a window dragged to the top"
  was=$(printf '%s\n' "$saved" | sed -n "s|.*\"$1/$2\" = \([01]\);.*|\1|p")
  if [ -n "$was" ]; then sys defaults write "$1" "$2" -bool "$([ "$was" = 1 ] && echo true || echo false)"
  else sys defaults delete "$1" "$2" 2>/dev/null || true; fi
  sys killall "$3" 2>/dev/null || true
}
saved=$(pref systemTopDragSaved)
if [ -n "$saved" ]; then
  top_drag_back com.apple.dock enterMissionControlByTopWindowDrag Dock "Mission Control"
fi
# Still owed when the record is there, when the app's last try didn't read back, or when it
# gave up (that's one last write here, not a reason to skip it).
fill_was=$(printf '%s\n' "$saved" | sed -n 's|.*"com.apple.WindowManager/EnableTopTilingByEdgeDrag" = \([01]\);.*|\1|p')
if { [ -n "$saved" ] || [ "$(pref systemTopDragFillPending)" = 1 ] || [ "$(pref systemTopDragFillGaveUp)" = 1 ]; } && [ "$(pref systemTopDragFillGivenBack)" != 1 ] \
  && [ "$fill_was" != 0 ] && [ "$(macos_pref com.apple.WindowManager EnableTopTilingByEdgeDrag)" = "0" ]; then
  step "Turning fill-the-screen back on for a window dragged to the top"
  sys defaults write com.apple.WindowManager EnableTopTilingByEdgeDrag -bool true
  sys killall WindowManager 2>/dev/null || true
fi

# Mission Control, if the app wasn't there to put it back (it does on its own when it is).
restore_mission_control
remove_watchdog

# AeroSpace: the installer stopped it opening at login so the two don't fight over the same keys.
if [ -f "$DATA/aerospace-start-at-login" ] && [ -f "$HOME/.aerospace.toml" ]; then
  step "Letting AeroSpace open at login again, as it did before"
  sed -i '' 's/^start-at-login *= *false/start-at-login = true/' "$HOME/.aerospace.toml" 2>/dev/null \
    || problem "AeroSpace still won't open at login: set start-at-login = true in ~/.aerospace.toml."
fi
if [ -s "$DATA/aerospace-login-item" ]; then
  item=$(cat "$DATA/aerospace-login-item")
  # Only where it was. Moved or deleted since, it can't be put back, so the person is told.
  if [ -e "$item" ]; then
    sys osascript -e 'on run argv' -e 'tell application "System Events" to make login item at end with properties {path:(item 1 of argv), hidden:false}' -e 'end run' "$item" >/dev/null 2>&1 \
      || problem "AeroSpace isn't back in Login Items: add $item in System Settings › General › Login Items."
  else
    problem "AeroSpace was at $item and isn't any more, so it isn't back in Login Items: add it there yourself if you still use it."
  fi
fi

# The agent hooks the session engine added. Only BaneySpaces' own entries go; every other hook and
# setting stays as it is. With the app gone, the same rule runs here in JavaScript.
CLAUDE="$HOME/.claude/settings.json"
# As the file has it: a double quote around the path is written \" in JSON.
ours="(ghostdeck|baneyspaces|polycarp-spaces)(\\\\?['\"])? +hook +(claude|grok)"
# The hooks, the agent skill and the command links are shared with a BaneySpaces that is still
# installed, which keeps working on them; they go only when it is not there.
# Hooks Polycarp wrote name its command, polycarp-spaces, which is going. For BaneySpaces to keep reporting they must
# name its command, the baneyspaces link, instead. Written in place (cat into the file), so a symlinked settings file
# and its permissions stay.
rewrite_hooks() {  # file
  [ -f "$1" ] || return 0
  local q="'" tmp
  grep -Eq "polycarp-spaces([${q}\"\\\\]*) +hook" "$1" || return 0
  tmp=$(mktemp) || return 1
  sed -E "s#polycarp-spaces([${q}\"\\\\]*) +hook#baneyspaces\\1 hook#g" "$1" > "$tmp" && cat "$tmp" > "$1" || problem "Couldn't point the hooks in $1 at BaneySpaces' command: change 'polycarp-spaces hook' to 'baneyspaces hook' there."
  rm -f "$tmp"
}
if [ -n "$LEGACY_APP" ]; then
  step "Leaving the agent hooks and skill for BaneySpaces, which is still installed (its command name goes into them)"
  rewrite_hooks "$CLAUDE"
  rewrite_hooks "$HOME/.grok/hooks/baneyspaces.json"
elif [ -f "$CLAUDE" ] && grep -Eq "$ours" "$CLAUDE"; then
  step "Removing its hooks from Claude Code's settings (your own hooks stay)"
  had_backup=""; [ -f "$CLAUDE.baneyspaces-backup" ] && had_backup=1
  CLI=""; [ -n "$BIN" ] && CLI="$(dirname "$(dirname "$BIN")")/Resources/bin/polycarp-spaces"
  # The real CLI edits the real home, so the test uses the JavaScript below.
  if [ -z "$TEST" ] && [ -n "$CLI" ] && [ -x "$CLI" ]; then "$CLI" hooks uninstall >/dev/null 2>&1 || true; fi
  if grep -Eq "$ours" "$CLAUDE"; then
    osascript -l JavaScript - "$CLAUDE" >/dev/null 2>&1 <<'JS' || true
ObjC.import('Foundation')
function run(argv) {
  // Through a symlink (settings kept in a dotfiles repo) to the file itself, written in place so
  // its permissions stay.
  const path = $(argv[0]).stringByResolvingSymlinksInPath.js
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js
  const settings = JSON.parse(text)
  const ours = h => /(ghostdeck|baneyspaces|polycarp-spaces)'?"?\s+hook\s+(claude|grok)/.test((h && h.command) || '')
  const hooks = settings.hooks || {}
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue
    const kept = []
    for (const g of hooks[event]) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue }
      const rest = g.hooks.filter(h => !ours(h))
      if (rest.length === 0 && g.hooks.length > 0) continue
      g.hooks = rest
      kept.push(g)
    }
    if (kept.length) hooks[event] = kept; else delete hooks[event]
  }
  if (settings.hooks && Object.keys(hooks).length === 0) delete settings.hooks
  if (!$(JSON.stringify(settings, null, 2) + '\n').writeToFileAtomicallyEncodingError(path, false, $.NSUTF8StringEncoding, null)) throw new Error('write failed')
}
JS
  fi
  if grep -Eq "$ours" "$CLAUDE"; then
    problem "Claude Code's settings ($CLAUDE) still have hooks that run 'polycarp-spaces hook' or 'baneyspaces hook': remove those entries by hand."
  fi
  if [ -n "$had_backup" ]; then
    echo "  Your settings from before Polycarp are still at $CLAUDE.baneyspaces-backup"
  fi
fi
[ -n "$LEGACY_APP" ] || rm -f "$HOME/.grok/hooks/baneyspaces.json"

step "Removing the polycarp-spaces command (and baneyspaces and ghostdeck, its other names)"
for link in "$HOME/.local/bin/polycarp-spaces" "$HOME/.local/bin/baneyspaces" "$HOME/.local/bin/ghostdeck"; do
  # Only the links Polycarp made: ones into a Polycarp.app, even if it's gone already.
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in *Polycarp.app/*) rm -f "$link" ;; esac
  fi
done
# The browser command, only if it links into Polycarp's helper; a tabkyra Polycarp took the name from is put back.
tabkyra_link="$HOME/.local/bin/tabkyra"
if [ -L "$tabkyra_link" ]; then
  case "$(readlink "$tabkyra_link")" in
    *Polycarp.app/Contents/Resources/browser/polycarp-browser)
      rm -f "$tabkyra_link"
      previous="$HOME/Library/Application Support/Polycarp/tabkyra-previous-link"
      [ ! -s "$previous" ] || ln -s "$(cat "$previous")" "$tabkyra_link"
      ;;
  esac
fi
# BEGIN restore-browser-previous
# What Settings > Browser > Connect found before `install --force` wrote its manifests and launchers (BrowserPrevious): put
# back, or removed where there was nothing. Only a file that still points into Polycarp.app is touched.
STORE="${STORE:-$HOME/Library/Application Support/Polycarp/browser-previous}"
if [ -s "$STORE/index.tsv" ]; then
  while IFS=$'\t' read -r target saved; do
    [ -n "$target" ] || continue
    if [ -e "$target" ] || [ -L "$target" ]; then
      grep -q "Polycarp.app" "$target" 2>/dev/null || continue
    fi
    if [ "$saved" = "-" ]; then rm -f "$target"; elif [ -f "$saved" ]; then cp "$saved" "$target"; fi
  done < "$STORE/index.tsv"
fi
# END restore-browser-previous
# Links the installer repointed on request (install.sh's retire_tabkyra) go back to what they were.
retired="$HOME/Library/Application Support/Polycarp/tabkyra-retired-links"
if [ -s "$retired" ]; then
  while IFS=$'\t' read -r link target; do
    if [ -L "$link" ]; then
      case "$(readlink "$link")" in *Polycarp.app/Contents/Resources/browser/polycarp-browser) ln -sf "$target" "$link" ;; esac
    fi
  done < "$retired"
fi
if [ -n "$LEGACY_APP" ] && [ -x "$LEGACY_APP/Contents/Resources/bin/baneyspaces" ]; then
  # Polycarp took these two names over from BaneySpaces; give them back to it.
  for name in baneyspaces ghostdeck; do
    [ -e "$HOME/.local/bin/$name" ] || [ -L "$HOME/.local/bin/$name" ] || ln -s "$LEGACY_APP/Contents/Resources/bin/baneyspaces" "$HOME/.local/bin/$name"
  done
else
  rm -rf "$HOME/.claude/skills/baneyspaces"
fi

step "Removing settings and the local signing key"
# On the owner's Mac this keychain holds the key every release is signed with (the pinned
# requirement below names its certificate). That one is moved aside, never deleted. Only the
# certificate's public fingerprint is read; the private key is never touched or printed.
RELEASE_REQUIREMENT='identifier "com.baney.polycarp" and certificate leaf = H"d1cfbd7446f84f6c625b9db83c5bf96da33b157e"'
SIGNING_KC="$DATA/Signing/polycarp-signing.keychain-db"
KEEP_SIGNING=""
KEEP_WHY=""
if [ -f "$SIGNING_KC" ]; then
  release_leaf=${RELEASE_REQUIREMENT##*H\"}; release_leaf=$(printf '%s' "${release_leaf%\"}" | tr 'A-F' 'a-f')
  local_leaf=$(security find-certificate -c "Polycarp Local Signing" -Z "$SIGNING_KC" 2>/dev/null \
    | sed -n 's/^SHA-1 hash: *//p' | head -1 | tr 'A-F' 'a-f' || true)
  # Deleted only when the fingerprint is readable and is not the release key's. If it can't be
  # read, the key might be the release key, so it is kept.
  if [ -z "$local_leaf" ]; then KEEP_SIGNING=1; KEEP_WHY="its fingerprint couldn't be read, so it might sign Polycarp releases"
  elif [ "$local_leaf" = "$release_leaf" ]; then KEEP_SIGNING=1; KEEP_WHY="it signs Polycarp releases"; fi
fi
if [ -n "$KEEP_SIGNING" ]; then
  KEPT="$HOME/Library/Polycarp Release Signing"
  [ ! -e "$KEPT" ] || KEPT="$KEPT $(date +%Y%m%d-%H%M%S)"
  if mv "$DATA/Signing" "$KEPT"; then
    echo "Kept the signing key because $KEEP_WHY: moved to $KEPT"
    echo "The next Polycarp build on this Mac puts it back by itself."
  else
    problem "The signing key ($KEEP_WHY) couldn't be moved aside, so it stays in $DATA/Signing."
  fi
elif [ -f "$SIGNING_KC" ]; then
  sys security delete-keychain "$SIGNING_KC" 2>/dev/null || true
fi
if [ -d "$DATA/Signing" ] && [ -n "$KEEP_SIGNING" ]; then
  find "$DATA" -mindepth 1 -maxdepth 1 ! -name Signing -exec rm -rf {} +
else
  rm -rf "$DATA"
fi
rm -rf "$HOME/Library/Caches/$ID" "$HOME/Library/HTTPStorages/$ID" \
  "$HOME/Library/Saved Application State/$ID.savedState"
# Its record of shortcuts it turned off stays while they're still off, so a reinstall can finish.
if ! shortcuts_off; then
  sys defaults delete "$ID" >/dev/null 2>&1 || true
fi

step "Removing its Accessibility permission"
# A fresh install gets a new signature; an old entry left here would show "on" but not work.
sys tccutil reset ScreenCapture "$ID" >/dev/null 2>&1 || true
sys tccutil reset ListenEvent "$ID" >/dev/null 2>&1 || true
sys tccutil reset Accessibility "$ID" >/dev/null 2>&1 \
  || problem "Polycarp may still be listed in System Settings › Privacy & Security › Accessibility: remove it there."

step "Removing the app"
# Last, so a failure here leaves nothing else half done. Open at Login goes with it.
for app in "${INSTALLED[@]}"; do
  rm -rf "$app" 2>/dev/null || true
  if [ -e "$app" ]; then problem "Couldn't remove $app: move it to the Trash yourself."; fi
done

echo
if [ ${#problems[@]} -eq 0 ]; then
  printf '%sPolycarp is removed.%s\n' "$bold" "$reset"
  echo "Your windows, Dock, shortcuts and agent settings are back as they were."
  echo "Its permission, settings and login item are gone too."
  echo "The polycarp command and your theme files stay on purpose: Voice and Browser use them too."
  echo "To remove the command as well: cargo uninstall --root ~/.local polycarp"
  exit 0
fi
printf '%sPolycarp is removed, but some things need a hand:%s\n' "$bold" "$reset"
for p in "${problems[@]}"; do echo "  - $p"; done
exit 2
