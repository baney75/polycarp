#!/bin/bash
# What the two installers build from source. spaces/install.sh takes the nightly tag, or main while a publish has that tag
# down, and never swaps a ref or commit it was given. Neither installer passes a release variable on to bundle.sh. Runs the
# real installers with stand-ins for the Mac's tools, curl and git (CI: channels.yml). Exit 0 only when every check passed.
set -uo pipefail
cd "$(dirname "$0")/../.."
status=0
bad() { echo "install-source-test: $*"; status=1; }
expect() { [ "$2" = "$3" ] || bad "$1: got \"$2\", want \"$3\""; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
b="$tmp/bin"; mkdir -p "$b"
stub() { printf '#!/bin/bash\n%s\n' "$2" > "$b/$1"; chmod +x "$b/$1"; }
stub uname 'case "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac'
stub sw_vers 'echo 15.0'
stub xcode-select 'exit 0'
stub xcrun 'exit 0'
stub cargo 'exit 0'
stub codesign 'exit 0'
stub curl 'printf 404'
# The checkout both installers build: its bundle.sh records the release variables it was given.
src="$tmp/src/spaces"; mkdir -p "$src/scripts"
printf '#!/bin/bash\nexit 0\n' > "$src/scripts/build-engine.sh"
cp "$src/scripts/build-engine.sh" "$src/scripts/install-app.sh"
cat > "$src/scripts/bundle.sh" <<'SH'
#!/bin/bash
cd "$(dirname "$0")/.."
echo "release=${POLYCARP_RELEASE-unset} channel=${POLYCARP_CHANNEL-unset}" > "$STUB_OUT/bundle"
mkdir -p build/Polycarp.app/Contents/Resources
cp scripts/install-app.sh build/Polycarp.app/Contents/Resources/install-app.sh
SH
chmod +x "$src"/scripts/*.sh
# STUB_LSREMOTE: what ls-remote exits with (2: no such ref). clone records the ref and copies the checkout.
stub git '
while [ "$1" = -c ]; do shift 2; done
case "$1" in
  ls-remote) exit "${STUB_LSREMOTE:-0}" ;;
  clone) while [ $# -gt 1 ]; do [ "$1" != --branch ] || echo "$2" > "$STUB_OUT/ref"; shift; done; cp -R "$STUB_SRC" "$1" ;;
  rev-parse|-C) echo "$STUB_HEAD" ;;
esac'
# The ref spaces/install.sh clones, under the environment given.
ref() {
  local o; o=$(mktemp -d "$tmp/run.XXXX"); mkdir -p "$o/dest" "$o/t"
  env -u BANEYSPACES_ZIP -u BANEYSPACES_FROM_SOURCE -u BANEYSPACES_COMMIT -u BANEYSPACES_REF HOME="$o" TMPDIR="$o/t" STUB_OUT="$o" \
    STUB_SRC="$tmp/src" BANEYSPACES_DEST_DIR="$o/dest" PATH="$b:$PATH" "$@" bash install.sh </dev/null >"$o/out" 2>&1
  out=$o; got=$(cat "$o/ref" 2>/dev/null || cat "$o/out")
}
ref; expect "nightly is there" "$got" nightly
ref STUB_LSREMOTE=2; expect "nightly is being replaced" "$got" main
ref STUB_LSREMOTE=2 BANEYSPACES_FROM_SOURCE=1; expect "a source build while nightly is being replaced" "$got" main
ref STUB_LSREMOTE=128; expect "GitHub didn't answer" "$got" nightly
ref STUB_LSREMOTE=2 BANEYSPACES_REF=nightly; expect "nightly asked for by name" "$got" nightly
ref STUB_LSREMOTE=2 BANEYSPACES_REF=v0.2.0; expect "another tag" "$got" v0.2.0
ref STUB_LSREMOTE=2 BANEYSPACES_COMMIT=abc STUB_HEAD=abc; expect "a pinned commit" "$got" nightly
ref POLYCARP_RELEASE=1 POLYCARP_CHANNEL=nightly
expect "spaces/install.sh: the build's variables" "$(cat "$out/bundle" 2>/dev/null)" "release=unset channel=unset"

# The root install.sh on a checkout, in its test mode.
o="$tmp/root"; mkdir -p "$o/dest"
env -u POLYCARP_ZIP -u POLYCARP_REF HOME="$o" STUB_OUT="$o" BANEYSPACES_DEST_DIR="$o/dest" POLYCARP_SOURCE="$tmp/src" \
  POLYCARP_RELEASE=1 POLYCARP_CHANNEL=nightly PATH="$b:$PATH" bash ../install.sh </dev/null >"$o/out" 2>&1 || bad "install.sh: $(cat "$o/out")"
expect "install.sh: the build's variables" "$(cat "$o/bundle" 2>/dev/null)" "release=unset channel=unset"

[ $status = 0 ] && echo "install-source-test: pass"
exit $status
