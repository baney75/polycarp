#!/bin/bash
# set-ci-signing.sh against a stand-in security and gh. Runs anywhere with bash and openssl (CI: channels.yml).
# Exit 0 only when every check passed.
set -uo pipefail
cd "$(dirname "$0")/../.."
status=0
bad() { echo "set-ci-signing-test: $*"; status=1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
PIN=$(sed -n 's/.*certificate leaf = H"\([0-9a-fA-F]\{40\}\)".*/\1/p' scripts/release-requirement.txt | tr a-f A-F)
OTHER=0123456789ABCDEF0123456789ABCDEF01234567
mkdir -p "$tmp/bin"
# STUB_IDS: the certificate hashes find-identity lists, only once the keychain is unlocked (a locked one lists none
# here, as it may on the Mac after a restart). `security -i` logs each command; an export writes a stand-in .p12.
cat > "$tmp/bin/security" <<'SH'
#!/bin/bash
case "$1" in
  find-identity)
    grep -q "^unlock-keychain " "$STUB_DIR/security.log" 2>/dev/null || STUB_IDS=""
    echo "Policy: X.509 Basic"; echo "  Matching identities"
    n=0; for h in $STUB_IDS; do n=$((n + 1)); echo "  $n) $h \"Some Signing\""; done
    echo "     $n identities found"; echo ""; echo "  Valid identities only"
    n=0; for h in $STUB_IDS; do n=$((n + 1)); echo "  $n) $h \"Some Signing\""; done ;;
  -i)
    while IFS= read -r line; do
      echo "$line" >> "$STUB_DIR/security.log"
      case "$line" in
        export*) out=${line##*-o \"}; out=${out%\"}; printf 'P12 BYTES' > "$out" ;;
      esac
    done ;;
  *) echo "security stand-in: $*" >&2; exit 1 ;;
esac
SH
cat > "$tmp/bin/gh" <<'SH'
#!/bin/bash
case "$1 $2" in
  "auth status") exit 0 ;;
  "secret set") cat > "$STUB_DIR/secret.$3"; echo "$*" >> "$STUB_DIR/gh.log" ;;
  "secret list") for f in "$STUB_DIR"/secret.*; do [ -e "$f" ] && printf '%s\tUpdated now\n' "${f##*/secret.}"; done ;;
  *) echo "gh stand-in: $*" >&2; exit 1 ;;
esac
SH
chmod +x "$tmp/bin/security" "$tmp/bin/gh"

run() { # <case> <ids> [keychain password]: a fresh home with the BaneySpaces keychain; sets $code and $out
  local d="$tmp/$1"; mkdir -p "$d/home/Library/Application Support/BaneySpaces/Signing" "$d/t"
  printf 'kych KEYCHAIN BYTES' > "$d/home/Library/Application Support/BaneySpaces/Signing/baneyspaces-signing.keychain-db"
  printf '%s\n' "${3:-kcpass}" > "$d/home/Library/Application Support/BaneySpaces/Signing/keychain-password"
  out=$(HOME="$d/home" TMPDIR="$d/t" STUB_DIR="$d" STUB_IDS="$2" PATH="$tmp/bin:$PATH" bash scripts/set-ci-signing.sh r/r 2>&1); code=$?
}

run pinned "$PIN"
[ "$code" = 0 ] || bad "the pinned key: exit $code: $out"
d="$tmp/pinned"
[ "$(base64 --decode < "$d/secret.POLYCARP_SIGNING_P12" 2>/dev/null)" = "kych KEYCHAIN BYTES" ] || bad "POLYCARP_SIGNING_P12 isn't the keychain in base64"
[ "$(cat "$d/secret.POLYCARP_SIGNING_P12_PASSWORD" 2>/dev/null)" = kcpass ] && [ "$(wc -c < "$d/secret.POLYCARP_SIGNING_P12_PASSWORD" | tr -d ' ')" = 6 ] \
  || bad "POLYCARP_SIGNING_P12_PASSWORD isn't the keychain's password with no newline"
grep -q "^export" "$d/security.log" && bad "an export was tried (macOS asks on screen before security can export the key)"
grep -q "^unlock-keychain -p kcpass " "$d/security.log" || bad "the keychain wasn't unlocked with its own password"
case "$out" in *kcpass*) bad "a password was printed" ;; esac

run spaced "$PIN" 'a b'
[ "$code" != 0 ] || bad "a password security -i would split was set"
[ ! -e "$tmp/spaced/gh.log" ] || bad "secrets were set with a password ci-signing.sh refuses"

run other "$OTHER"
[ "$code" != 0 ] || bad "a key that isn't pinned was taken"
[ ! -e "$tmp/other/gh.log" ] || bad "secrets were set from a key that isn't pinned"

run two "$PIN $OTHER"
[ "$code" != 0 ] || bad "a keychain with a second identity was exported whole"
[ ! -e "$tmp/two/gh.log" ] || bad "secrets were set from a keychain with two identities"

[ "$status" = 0 ] && echo "set-ci-signing-test: pass"
exit "$status"
