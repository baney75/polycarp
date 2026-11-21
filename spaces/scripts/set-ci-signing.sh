#!/bin/bash
# The owner's Mac only, run by the owner: puts the release signing identity into the repository's secrets,
# POLYCARP_SIGNING_P12 and POLYCARP_SIGNING_P12_PASSWORD (docs/release-gate.md, step 5). It finds the keychain
# signing-identity.sh keeps the key in, checks the key's certificate is the one release-requirement.txt pins, exports
# that one identity with a new password, sets both secrets through gh on stdin and removes the export. Nothing secret
# is printed or put on a command line. It never makes a key: without the pinned one it stops, having changed nothing.
#   spaces/scripts/set-ci-signing.sh [owner/repo]
set -euo pipefail
REPO=${1:-baney75/polycarp}
HERE=$(cd "$(dirname "$0")" && pwd)
PIN=$(sed -n 's/.*certificate leaf = H"\([0-9a-fA-F]\{40\}\)".*/\1/p' "$HERE/release-requirement.txt" | tr a-f A-F)
[ -n "$PIN" ] || { echo "set-ci-signing.sh: release-requirement.txt pins no certificate" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "set-ci-signing.sh: sign in to GitHub first: gh auth login" >&2; exit 1; }

# The two places signing-identity.sh keeps the key: Polycarp's, then BaneySpaces' (the key every release is pinned to).
KC=""
for dir in "$HOME/Library/Application Support/Polycarp/Signing" "$HOME/Library/Application Support/BaneySpaces/Signing"; do
  for f in "$dir"/*-signing.keychain-db; do
    [ -f "$f" ] && [ -s "$dir/keychain-password" ] || continue
    # One identity, and it is the pinned one: find-identity lists each by its certificate's SHA-1.
    ids=$(security find-identity "$f" 2>/dev/null | sed -n 's/^ *[0-9][0-9]*) \([0-9A-F]\{40\}\) .*/\1/p' | sort -u)
    if [ "$ids" = "$PIN" ]; then KC=$f; break 2; fi
  done
done
[ -n "$KC" ] || { echo "set-ci-signing.sh: no keychain here holds only the pinned key ($PIN); nothing was set" >&2; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
umask 077
# `security -i` reads commands from stdin, so the passwords never reach `ps`. Both are hex: nothing to quote.
keychain() { printf '%s\n' "$1" | security -i >/dev/null; }
keychain "unlock-keychain -p $(cat "$(dirname "$KC")/keychain-password") \"$KC\""
openssl rand -hex 24 | tr -d '\n' > "$TMP/p12pass"   # no newline: gh stores stdin as it is
keychain "export -k \"$KC\" -t identities -f pkcs12 -P $(cat "$TMP/p12pass") -o \"$TMP/id.p12\""
[ -s "$TMP/id.p12" ] || { echo "set-ci-signing.sh: the export came back empty; nothing was set" >&2; exit 1; }

base64 < "$TMP/id.p12" | gh secret set POLYCARP_SIGNING_P12 -R "$REPO" >/dev/null
gh secret set POLYCARP_SIGNING_P12_PASSWORD -R "$REPO" < "$TMP/p12pass" >/dev/null
have=$(gh secret list -R "$REPO" | awk '$1 == "POLYCARP_SIGNING_P12" || $1 == "POLYCARP_SIGNING_P12_PASSWORD"' | wc -l | tr -d ' ')
[ "$have" = 2 ] || { echo "set-ci-signing.sh: GitHub lists $have of the 2 secrets on $REPO" >&2; exit 1; }
echo "set-ci-signing.sh: set POLYCARP_SIGNING_P12 and POLYCARP_SIGNING_P12_PASSWORD on $REPO from $(basename "$KC") ($PIN)"
