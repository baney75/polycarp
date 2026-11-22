#!/bin/bash
# The owner's Mac only, run by the owner: puts the release signing identity into the repository's secrets,
# POLYCARP_SIGNING_P12 and POLYCARP_SIGNING_P12_PASSWORD (docs/releases.md). It finds the keychain signing-identity.sh
# keeps the key in, checks it holds only the key release-requirement.txt pins, and sets the keychain file itself (in
# base64) and its password through gh on stdin. It exports nothing: the key's access list trusts only
# /usr/bin/codesign, so macOS would ask on screen before `security` could export it, and the runner's codesign is the
# same path, so the keychain signs there as it is (ci-signing.sh). Nothing secret is printed or put on a command line.
# It never makes a key: without the pinned one it stops, having changed nothing.
#   spaces/scripts/set-ci-signing.sh [owner/repo]
set -euo pipefail
REPO=${1:-baney75/polycarp}
HERE=$(cd "$(dirname "$0")" && pwd)
PIN=$(sed -n 's/.*certificate leaf = H"\([0-9a-fA-F]\{40\}\)".*/\1/p' "$HERE/release-requirement.txt" | tr a-f A-F)
[ -n "$PIN" ] || { echo "set-ci-signing.sh: release-requirement.txt pins no certificate" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "set-ci-signing.sh: sign in to GitHub first: gh auth login" >&2; exit 1; }

# `security -i` reads commands from stdin, so the passwords never reach `ps`. Both are hex: nothing to quote.
keychain() { printf '%s\n' "$1" | security -i >/dev/null; }

# The two places signing-identity.sh keeps the key: Polycarp's, then BaneySpaces' (the key every release is pinned to).
# Each is unlocked with its own password before it is read, so one locked since a restart is still found.
KC=""; PW=""
for dir in "$HOME/Library/Application Support/Polycarp/Signing" "$HOME/Library/Application Support/BaneySpaces/Signing"; do
  for f in "$dir"/*-signing.keychain-db; do
    [ -f "$f" ] && [ -s "$dir/keychain-password" ] || continue
    keychain "unlock-keychain -p $(cat "$dir/keychain-password") \"$f\""
    # One identity, and it is the pinned one: find-identity lists each by its certificate's SHA-1.
    ids=$(security find-identity "$f" 2>/dev/null | sed -n 's/^ *[0-9][0-9]*) \([0-9A-F]\{40\}\) .*/\1/p' | sort -u)
    # And one certificate: the whole file goes to the secret, so it may hold nothing but what signing-identity.sh
    # imported (the pinned identity's .p12).
    certs=$(security find-certificate -a -Z "$f" 2>/dev/null | sed -n 's/^SHA-1 hash: \([0-9A-F]\{40\}\)$/\1/p' | sort -u)
    if [ "$ids" = "$PIN" ] && [ "$certs" = "$PIN" ]; then KC=$f; PW="$dir/keychain-password"; break 2; fi
  done
done
[ -n "$KC" ] || { echo "set-ci-signing.sh: no keychain here holds only the pinned key and its certificate ($PIN); nothing was set" >&2; exit 1; }

# ci-signing.sh unlocks with it through `security -i`, which splits on spaces and quotes, so it must be plain.
tr -d '\n' < "$PW" | grep -qE '^[A-Za-z0-9._-]+$' \
  || { echo "set-ci-signing.sh: $(basename "$KC")'s password isn't plain letters and digits; nothing was set" >&2; exit 1; }
base64 < "$KC" | tr -d '\n' | gh secret set POLYCARP_SIGNING_P12 -R "$REPO" >/dev/null
tr -d '\n' < "$PW" | gh secret set POLYCARP_SIGNING_P12_PASSWORD -R "$REPO" >/dev/null
have=$(gh secret list -R "$REPO" | awk '$1 == "POLYCARP_SIGNING_P12" || $1 == "POLYCARP_SIGNING_P12_PASSWORD"' | wc -l | tr -d ' ')
[ "$have" = 2 ] || { echo "set-ci-signing.sh: GitHub lists $have of the 2 secrets on $REPO" >&2; exit 1; }
echo "set-ci-signing.sh: set POLYCARP_SIGNING_P12 and POLYCARP_SIGNING_P12_PASSWORD on $REPO from $(basename "$KC") ($PIN)"
