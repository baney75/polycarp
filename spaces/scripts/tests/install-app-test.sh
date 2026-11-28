#!/bin/bash
# Tests spaces/scripts/install-app.sh's atomic bundle swap and LaunchAgent reload (#935):
# - Copies into a sibling staging path with ditto while the old bundle still exists (new inode, rollback-safe).
# - Boots out loaded Polycarp CLI LaunchAgents before the swap and re-bootstraps them after.
# - Leaves unloaded, non-Polycarp, and custom-binary agents alone.
# - Retries transient launchctl bootstrap failures and restores booted-out agents if staging fails.
# - Also reloads loaded Polycarp LaunchAgents on --in-place installs.
# Runs on Linux and macOS with stubbed system tools; never touches real ~/Applications or launchd.
set -uo pipefail
cd "$(dirname "$0")/../.."
status=0
bad() { echo "install-app-test: $*" >&2; status=1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

inode_of() {
  python3 -c 'import os, sys; print(os.stat(sys.argv[1]).st_ino)' "$1"
}

make_app() {
  local dir=$1 tag=$2
  mkdir -p "$dir/Contents/Resources/bin" "$dir/Contents/MacOS"
  cat > "$dir/Contents/Resources/bin/polycarp" <<SH
#!/bin/sh
echo "$tag"
exit 0
SH
  cat > "$dir/Contents/Resources/bin/polycarp-spaces" <<SH
#!/bin/sh
exit 0
SH
  chmod +x "$dir/Contents/Resources/bin/polycarp" "$dir/Contents/Resources/bin/polycarp-spaces"
  echo "$tag" > "$dir/Contents/version.txt"
}

write_plist() {
  local path=$1 label=$2 program=$3
  mkdir -p "$(dirname "$path")"
  cat > "$path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$program</string>
    <string>sync</string>
    <string>now</string>
    <string>--background</string>
  </array>
</dict>
</plist>
PLIST
}

make_stubs() {
  local bin=$1 log=$2
  mkdir -p "$bin"
  cat > "$bin/codesign" <<'SH'
#!/bin/sh
echo "Authority=BaneySpaces Local Signing"
exit 0
SH
  cat > "$bin/defaults" <<'SH'
#!/bin/sh
exit 0
SH
  cat > "$bin/osascript" <<'SH'
#!/bin/sh
exit 0
SH
  cat > "$bin/pgrep" <<'SH'
#!/bin/sh
exit 1
SH
  cat > "$bin/lsregister" <<SH
#!/bin/sh
echo "lsregister \$*" >> "$log"
exit 0
SH
  cat > "$bin/ditto" <<SH
#!/bin/sh
echo "ditto \$1 \$2 dest_exists=\$([ -d "\$TEST_DEST" ] && echo 1 || echo 0)" >> "$log"
if [ "\${STUB_DITTO_FAIL:-0}" = 1 ]; then
  mkdir -p "\$2"
  exit 1
fi
cp -R "\$1" "\$2"
SH
  cat > "$bin/launchctl" <<SH
#!/bin/sh
echo "launchctl \$*" >> "$log"
case "\$1" in
  print)
    case " \${STUB_LOADED:-} " in
      *" \$2 "*) exit 0 ;;
      *) exit 113 ;;
    esac
    ;;
  bootout)
    exit 0
    ;;
  bootstrap)
    if [ -n "\${STUB_BOOTSTRAP_FAIL_ONCE:-}" ] && [ ! -f "\$STUB_BOOTSTRAP_FAIL_ONCE" ]; then
      : > "\$STUB_BOOTSTRAP_FAIL_ONCE"
      exit 5
    fi
    exit 0
    ;;
esac
exit 0
SH
  chmod +x "$bin"/*
}

uid=$(id -u)

# 1. Normal install over an existing app: atomic swap with fresh inode, bootout before ditto, bootstrap after.
run1="$tmp/run1"
mkdir -p "$run1/home/Applications" "$run1/src"
make_stubs "$run1/bin" "$run1/events.log"
make_app "$run1/home/Applications/Polycarp.app" "v1"
make_app "$run1/src/Polycarp.app" "v2"
old_inode=$(inode_of "$run1/home/Applications/Polycarp.app/Contents/Resources/bin/polycarp")

agents="$run1/home/Library/LaunchAgents"
write_plist "$agents/com.polycarp.sync.plist" "com.polycarp.sync" "$run1/home/.local/bin/polycarp"
write_plist "$agents/com.polycarp.files.plist" "com.polycarp.files" "$run1/home/.local/bin/polycarp"
write_plist "$agents/com.polycarp.agent.plist" "com.polycarp.agent" "$run1/home/.local/bin/polycarp"
write_plist "$agents/com.polycarp.agent-tunnel.plist" "com.polycarp.agent-tunnel" "/opt/custom/bin/polycarp"
write_plist "$agents/com.example.other.plist" "com.example.other" "$run1/home/.local/bin/polycarp"
mkdir -p "$run1/home/.config/polycarp"
: > "$run1/home/.config/polycarp/config.toml"

out1=$(env HOME="$run1/home" \
  BANEYSPACES_INSTALL_DIR="$run1/home/Applications" \
  BANEYSPACES_NO_LAUNCH=1 \
  POLYCARP_LAUNCHCTL="$run1/bin/launchctl" \
  POLYCARP_LSREGISTER="$run1/bin/lsregister" \
  POLYCARP_LAUNCHCTL_RETRY_SLEEP=0 \
  TEST_DEST="$run1/home/Applications/Polycarp.app" \
  STUB_LOADED="gui/$uid/com.polycarp.sync gui/$uid/com.polycarp.agent gui/$uid/com.polycarp.agent-tunnel gui/$uid/com.example.other" \
  STUB_BOOTSTRAP_FAIL_ONCE="$run1/boot-failed-once" \
  PATH="$run1/bin:/usr/bin:/bin" \
  bash scripts/install-app.sh "$run1/src/Polycarp.app" 2>&1) || bad "run1 failed: $out1"

new_inode=$(inode_of "$run1/home/Applications/Polycarp.app/Contents/Resources/bin/polycarp")
[ "$old_inode" != "$new_inode" ] || bad "run1 reused inode $old_inode"
[ "$(cat "$run1/home/Applications/Polycarp.app/Contents/version.txt")" = "v2" ] || bad "run1 did not install v2"
[ -z "$(find "$run1/home/Applications" -maxdepth 1 -name '.Polycarp.install.*')" ] || bad "run1 left staging dir behind"
[ "$(readlink "$run1/home/.local/bin/polycarp")" = "$run1/home/Applications/Polycarp.app/Contents/Resources/bin/polycarp" ] || bad "run1 symlink wrong"

log1=$(cat "$run1/events.log")
grep -q 'dest_exists=1' <<<"$log1" || bad "run1 deleted DEST before staging copy: $log1"
line_of() { grep -n -F "$1" "$2" | head -1 | cut -d: -f1; }
bo_sync=$(line_of "launchctl bootout gui/$uid/com.polycarp.sync" "$run1/events.log")
bo_agent=$(line_of "launchctl bootout gui/$uid/com.polycarp.agent" "$run1/events.log")
ditto_line=$(line_of "ditto " "$run1/events.log")
bs_sync=$(line_of "launchctl bootstrap gui/$uid $agents/com.polycarp.sync.plist" "$run1/events.log")
bs_agent=$(line_of "launchctl bootstrap gui/$uid $agents/com.polycarp.agent.plist" "$run1/events.log")
[ -n "$bo_sync" ] && [ -n "$bo_agent" ] && [ -n "$ditto_line" ] && [ -n "$bs_sync" ] && [ -n "$bs_agent" ] \
  || bad "run1 missing expected launchctl/ditto calls: $log1"
[ "$bo_sync" -lt "$ditto_line" ] && [ "$bo_agent" -lt "$ditto_line" ] || bad "run1 did not bootout before ditto: $log1"
[ "$ditto_line" -lt "$bs_sync" ] && [ "$ditto_line" -lt "$bs_agent" ] || bad "run1 did not bootstrap after ditto: $log1"
# Transient bootstrap failure was retried and succeeded without warning.
[ "$(grep -c -F "launchctl bootstrap gui/$uid $agents/com.polycarp.sync.plist" "$run1/events.log")" = "2" ] \
  || bad "run1 did not retry transient bootstrap failure: $log1"
! grep -q 'warning: could not reload' <<<"$out1" || bad "run1 warned despite retry success: $out1"
# Unloaded, custom-binary, and unrelated agents were never booted out or bootstrapped.
for untouched in com.polycarp.files com.polycarp.agent-tunnel com.example.other; do
  ! grep -qE "launchctl (bootout|bootstrap) .*$untouched" "$run1/events.log" \
    || bad "run1 touched $untouched: $log1"
done

# 2. Failed copy leaves existing Polycarp.app intact, cleans staging dir, and restores booted-out agents.
run2="$tmp/run2"
mkdir -p "$run2/home/Applications" "$run2/src"
make_stubs "$run2/bin" "$run2/events.log"
make_app "$run2/home/Applications/Polycarp.app" "v1"
make_app "$run2/src/Polycarp.app" "v2"
agents2="$run2/home/Library/LaunchAgents"
write_plist "$agents2/com.polycarp.sync.plist" "com.polycarp.sync" "$run2/home/.local/bin/polycarp"

rc2=0
env HOME="$run2/home" \
  BANEYSPACES_INSTALL_DIR="$run2/home/Applications" \
  BANEYSPACES_NO_LAUNCH=1 \
  POLYCARP_LAUNCHCTL="$run2/bin/launchctl" \
  POLYCARP_LSREGISTER="$run2/bin/lsregister" \
  POLYCARP_LAUNCHCTL_RETRY_SLEEP=0 \
  TEST_DEST="$run2/home/Applications/Polycarp.app" \
  STUB_LOADED="gui/$uid/com.polycarp.sync" \
  STUB_DITTO_FAIL=1 \
  PATH="$run2/bin:/usr/bin:/bin" \
  bash scripts/install-app.sh "$run2/src/Polycarp.app" >/dev/null 2>&1 || rc2=$?
[ "$rc2" != 0 ] || bad "run2 succeeded despite ditto failure"
[ "$(cat "$run2/home/Applications/Polycarp.app/Contents/version.txt")" = "v1" ] || bad "run2 damaged existing app on failed copy"
[ -z "$(find "$run2/home/Applications" -maxdepth 1 -name '.Polycarp.install.*')" ] || bad "run2 left staging dir behind"
grep -qF "launchctl bootstrap gui/$uid $agents2/com.polycarp.sync.plist" "$run2/events.log" \
  || bad "run2 did not restore com.polycarp.sync after failed copy: $(cat "$run2/events.log")"

# 3. --in-place install also reloads loaded Polycarp LaunchAgents.
run3="$tmp/run3"
mkdir -p "$run3/home/Applications" "$run3/home/.config/polycarp"
: > "$run3/home/.config/polycarp/config.toml"
make_stubs "$run3/bin" "$run3/events.log"
make_app "$run3/home/Applications/Polycarp.app" "v3"
agents3="$run3/home/Library/LaunchAgents"
write_plist "$agents3/com.polycarp.sync.plist" "com.polycarp.sync" "$run3/home/Applications/Polycarp.app/Contents/Resources/bin/polycarp"

out3=$(env HOME="$run3/home" \
  POLYCARP_LAUNCHCTL="$run3/bin/launchctl" \
  POLYCARP_LSREGISTER="$run3/bin/lsregister" \
  POLYCARP_LAUNCHCTL_RETRY_SLEEP=0 \
  STUB_LOADED="gui/$uid/com.polycarp.sync" \
  PATH="$run3/bin:/usr/bin:/bin" \
  bash scripts/install-app.sh --in-place "$run3/home/Applications/Polycarp.app" 2>&1) || bad "run3 failed: $out3"
bo3=$(line_of "launchctl bootout gui/$uid/com.polycarp.sync" "$run3/events.log")
bs3=$(line_of "launchctl bootstrap gui/$uid $agents3/com.polycarp.sync.plist" "$run3/events.log")
[ -n "$bo3" ] && [ -n "$bs3" ] && [ "$bo3" -lt "$bs3" ] || bad "run3 did not reload com.polycarp.sync on --in-place: $(cat "$run3/events.log")"

[ $status = 0 ] && echo "install-app-test: pass"
exit $status
