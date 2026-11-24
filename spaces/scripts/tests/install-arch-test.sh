#!/bin/bash
# spaces/install.sh picks the download by chip: releases are Apple silicon only (release.sh), so an Intel Mac builds its
# own copy and never takes the ready-made app. Runs the real installer with stand-in uname, curl and xcode-select, on a
# Mac (CI: channels.yml). Exit 0 only when every check passed.
set -uo pipefail
cd "$(dirname "$0")/../.."
status=0
bad() { echo "install-arch-test: $*"; status=1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
arch_install() {
  local b="$tmp/arch-$1"; mkdir -p "$b" "$b/dest"; rm -f "$b/curl-ran"
  printf '#!/bin/sh\ncase "$1" in -m) echo %s ;; *) echo Darwin ;; esac\n' "$1" > "$b/uname"
  printf '#!/bin/sh\necho "$*" >> "%s/curl-ran"\nprintf 404\n' "$b" > "$b/curl"
  printf '#!/bin/sh\nexit 1\n' > "$b/xcode-select"
  chmod +x "$b/uname" "$b/curl" "$b/xcode-select"
  env -u BANEYSPACES_ZIP -u BANEYSPACES_FROM_SOURCE -u BANEYSPACES_COMMIT -u BANEYSPACES_REF HOME="$b" \
    BANEYSPACES_DEST_DIR="$b/dest" PATH="$b:$PATH" bash install.sh </dev/null 2>&1
}
out=$(arch_install x86_64)
grep -q 'Polycarp.zip' "$tmp/arch-x86_64/curl-ran" 2>/dev/null && bad "spaces/install.sh downloaded the Apple silicon app on an Intel Mac"
case $out in *"Intel chip"*) ;; *) bad "spaces/install.sh on Intel didn't say it builds here: $out" ;; esac
arch_install arm64 >/dev/null
grep -q 'download/nightly/Polycarp.zip' "$tmp/arch-arm64/curl-ran" 2>/dev/null || bad "spaces/install.sh on Apple silicon didn't try the nightly download"

[ $status = 0 ] && echo "install-arch-test: pass"
exit $status
