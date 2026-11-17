#!/bin/bash
# CI only (channel-build.yml, stable-build.yml): puts the release signing identity from the workflow's secrets into
# a throwaway keychain on the runner, so bundle.sh signs with it, and writes POLYCARP_SIGNING_IDENTITY and
# POLYCARP_SIGNING_KEYCHAIN to $GITHUB_ENV. Exit 3, having changed nothing, when the secrets are not set: then the
# workflow publishes nothing and the build is made on the owner's Mac (docs/releases.md).
#   POLYCARP_SIGNING_P12 (base64 of a .p12 holding the key release-requirement.txt pins), POLYCARP_SIGNING_P12_PASSWORD
# Nothing secret is printed. Passwords go to `security` on stdin, as in signing-identity.sh.
set -euo pipefail
[ -n "${POLYCARP_SIGNING_P12:-}" ] && [ -n "${POLYCARP_SIGNING_P12_PASSWORD:-}" ] || { echo "ci-signing.sh: no signing secrets"; exit 3; }
[ -n "${RUNNER_TEMP:-}" ] && [ -n "${GITHUB_ENV:-}" ] || { echo "ci-signing.sh: runs only in GitHub Actions" >&2; exit 1; }
# `security -i` splits its line on spaces and quotes, so the .p12 password must be plain (docs/releases.md makes it
# with `openssl rand -hex 24`).
[[ "$POLYCARP_SIGNING_P12_PASSWORD" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "ci-signing.sh: POLYCARP_SIGNING_P12_PASSWORD must be letters, digits, dot, dash or underscore" >&2; exit 1; }
DIR=$(mktemp -d "$RUNNER_TEMP/signing.XXXXXX")
KC="$DIR/polycarp-ci.keychain-db"
PASS=$(openssl rand -hex 24)
keychain() { printf '%s\n' "$1" | security -i >/dev/null; }
keychain "create-keychain -p $PASS \"$KC\""
keychain "set-keychain-settings -lut 7200 \"$KC\""
keychain "unlock-keychain -p $PASS \"$KC\""
printf '%s' "$POLYCARP_SIGNING_P12" | base64 --decode > "$DIR/id.p12"
keychain "import \"$DIR/id.p12\" -k \"$KC\" -P $POLYCARP_SIGNING_P12_PASSWORD -T /usr/bin/codesign"
rm -f "$DIR/id.p12"
keychain "set-key-partition-list -S apple-tool:,apple: -s -k $PASS \"$KC\""
NAME=$(security find-identity -p codesigning "$KC" | sed -n 's/^ *1) [0-9A-F]* "\(.*\)".*/\1/p' | head -1)
[ -n "$NAME" ] || { echo "ci-signing.sh: the secret holds no code-signing identity" >&2; exit 1; }
{ echo "POLYCARP_SIGNING_IDENTITY=$NAME"; echo "POLYCARP_SIGNING_KEYCHAIN=$KC"; } >> "$GITHUB_ENV"
echo "ci-signing.sh: signing as \"$NAME\""
