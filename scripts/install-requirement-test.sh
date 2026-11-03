#!/usr/bin/env bash
# Exercises install.sh's macOS designated-requirement check with stand-in macOS tools, so it
# runs on any CI host. Each app's "signature" is the text in its Silas.app/req file.
#   scripts/install-requirement-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
installer="$PWD/install.sh"

fake() { printf '#!/bin/sh\n%s\n' "$2" > "$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
fake uname 'echo Darwin'
fake sysctl 'echo 1'
fake sw_vers 'echo 14.5'
fake xattr 'exit 0'
fake open 'exit 0'
# Quitting Silas goes through these; a refused install must never reach them.
fake ps 'echo quit >> "$FAKE_CALLS"'
fake osascript 'echo quit >> "$FAKE_CALLS"'
fake pgrep 'exit 1'
fake curl 'while [ $# -gt 0 ]; do [ "$1" = -o ] && cp "$FAKE_TARBALL" "$2"; shift; done'
fake codesign 'app=$3
if [ -f "$app/req" ]; then echo "Executable=$app/Contents/MacOS/silas" >&2; echo "designated => $(cat "$app/req")"
else echo "$app: code object is not signed at all" >&2; exit 1; fi'
export PATH="$tmp/bin:$PATH" FAKE_TARBALL="$tmp/silas.tar.gz" FAKE_CALLS="$tmp/calls" SILAS_NO_OPEN=1
unset SILAS_ALLOW_NEW_SIGNATURE SILAS_INSTALL_DIR

stable='identifier "com.baney.silas" and anchor apple generic and certificate leaf[subject.OU] = "54H7JX2PD4"'
devid='identifier "com.baney.silas" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "54H7JX2PD4"'
adhoc_old='cdhash H"1111111111111111111111111111111111111111"'
adhoc_new='cdhash H"2222222222222222222222222222222222222222"'
NONE='(none)'

download() { # requirement of the downloaded app, or $NONE for unsigned
  rm -rf "$tmp/pkg" && mkdir -p "$tmp/pkg/Silas.app/Contents"
  [ "$1" = "$NONE" ] || printf '%s\n' "$1" > "$tmp/pkg/Silas.app/req"
  tar -czf "$FAKE_TARBALL" -C "$tmp/pkg" Silas.app
}
installed() { # folder, requirement of the installed app, or $NONE for unsigned
  rm -rf "$1/Silas.app" && mkdir -p "$1/Silas.app/Contents"
  [ "$2" = "$NONE" ] || printf '%s\n' "$2" > "$1/Silas.app/req"
  touch "$1/Silas.app/old-copy"
}

failures=0
expect() { # pass|fail, description, folder, installed requirement or "" for no install, download requirement
  local want=$1 what=$2 dir=$3 old=$4 new=$5 got
  rm -rf "$dir" "$tmp/calls" && mkdir -p "$dir"
  [ -z "$old" ] || installed "$dir" "$old"
  download "$new"
  if sh "$installer" >"$tmp/out" 2>&1; then got=pass; else got=fail; fi
  local bad=""
  [ "$got" = "$want" ] || bad="wanted $want, got $got"
  if [ -z "$bad" ] && [ "$want" = fail ]; then
    [ -e "$dir/Silas.app/old-copy" ] || bad="the installed copy was replaced"
    [ ! -e "$tmp/calls" ] || bad="Silas was quit before the refusal"
  fi
  if [ -z "$bad" ] && [ "$want" = pass ] && [ -e "$dir/Silas.app/old-copy" ]; then bad="the old copy is still there"; fi
  if [ -z "$bad" ]; then echo "ok: $what"; else echo "FAIL: $what ($bad)"; cat "$tmp/out"; failures=$((failures + 1)); fi
}

d="$tmp/apps"
export SILAS_INSTALL_DIR="$d"
expect pass "a fresh install goes ahead" "$d" "" "$stable"
expect pass "the same certificate replaces the install" "$d" "$stable" "$stable"
expect pass "an ad-hoc install has nothing to keep" "$d" "$adhoc_old" "$stable"
expect pass "a new ad-hoc build replaces an ad-hoc install" "$d" "$adhoc_old" "$adhoc_new"
expect pass "an unsigned install has nothing to keep" "$d" "$NONE" "$stable"
expect fail "a different certificate is refused" "$d" "$stable" "$devid"
grep -q 'SILAS_ALLOW_NEW_SIGNATURE=1 sh' "$tmp/out" && echo "ok: the refusal names the override" \
  || { echo "FAIL: the refusal does not name the override"; cat "$tmp/out"; failures=$((failures + 1)); }
expect fail "an ad-hoc download over a signed install is refused" "$d" "$stable" "$adhoc_new"
expect fail "an unsigned download over a signed install is refused" "$d" "$stable" "$NONE"
SILAS_ALLOW_NEW_SIGNATURE=1 expect pass "SILAS_ALLOW_NEW_SIGNATURE=1 allows a planned certificate change" "$d" "$stable" "$devid"
SILAS_ALLOW_NEW_SIGNATURE=1 expect fail "SILAS_ALLOW_NEW_SIGNATURE=1 never allows an ad-hoc download" "$d" "$stable" "$adhoc_new"
SILAS_ALLOW_NEW_SIGNATURE=1 expect fail "SILAS_ALLOW_NEW_SIGNATURE=1 never allows an unsigned download" "$d" "$stable" "$NONE"

# The default folders: /Applications isn't writable here, so ~/Applications is checked too.
unset SILAS_INSTALL_DIR
export HOME="$tmp/home"
expect fail "a signed copy in ~/Applications is protected without SILAS_INSTALL_DIR" "$HOME/Applications" "$stable" "$devid"

[ "$failures" = 0 ] && echo "install-requirement: all passed" || { echo "install-requirement: $failures failed"; exit 1; }
