#!/bin/bash
# A real-pointer window drag inside a throwaway Tart guest, so an agent can drag a window with real events without
# Donovan's pointer. In the guest, posted CGEvents are real events for its own window server: macOS's edge tiling and an
# app's own drag code (Chromium's tab strip) behave as on a real Mac. Donovan's Mac is never touched: no pointer, no
# window, no permission. The guest is a clone of the pinned sandbox image (sandbox/PIN), on Softnet with the sandbox's own
# block rules, and it is deleted on every way out.
#
#   scripts/guest-drag.sh [--polycarp APP|--no-polycarp] [--browser APP] [--keep] [--display WxH] -- <real-drag args>
#   scripts/guest-drag.sh --dry-run ...       print the tart commands and exit (no VM)
#
# Inside the guest it installs the Polycarp build (default: build/guest/Polycarp.app, made from `swift build -c release`
# by this script) and the browser (default: Helium, copied read-only from /Applications/Helium.app), grants both and
# the driver Accessibility in the guest's TCC database (the image runs with SIP off), starts Polycarp, starts the
# browser on a fresh profile, then runs scripts/real-drag.swift (compiled here) with --guest and the args you gave.
# Results land in the folder it prints: summary.txt, frames.txt, trace.txt, plus the guest's whole trace.log.
#
# Example, the 11-12/11-16 bug: a Helium window grabbed by its tab strip, rested 1 s at the top, let go there:
#   scripts/guest-drag.sh -- --app Helium --start 200,120,1100,780 --grab strip --to top --rest 1 --expect fill
#
# Exit: the driver's (0 pass, 1 fail, 2 bad args, 3 not run), or 4 when the guest couldn't be made (busy, no image).
# A second guest slot must be free: Apple Virtualization runs two macOS guests at most.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

POLYCARP=build/guest/Polycarp.app
BROWSER=/Applications/Helium.app
KEEP=0 DRY=0 DISPLAY_SIZE=1512x982 NO_POLYCARP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --polycarp) POLYCARP=$2; shift 2 ;;
    --no-polycarp) NO_POLYCARP=1; shift ;;
    --browser) BROWSER=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --display) DISPLAY_SIZE=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --) shift; break ;;
    *) echo "guest-drag: unknown option $1 (driver args go after --)" >&2; exit 2 ;;
  esac
done
DRIVER_ARGS=("$@")
[ ${#DRIVER_ARGS[@]} -gt 0 ] || { echo "guest-drag: give the drag after --, e.g. -- --app Helium --grab strip --to top --rest 1 --expect fill" >&2; exit 2; }

TART=$(command -v tart || true)
[ -n "$TART" ] || { echo "guest-drag: Tart isn't installed (scripts/install-sandbox.sh)" >&2; exit 4; }
SOFTNET_DIR=/usr/local/lib/baneyspaces/bin
IMAGE=$(sed -n 's/.*static let image = "\(.*@sha256:[0-9a-f]*\)".*/\1/p' Sources/BaneySpacesCore/Sandbox/SandboxPin.swift)
[ -n "$IMAGE" ] || { echo "guest-drag: no pinned image in SandboxPin.swift" >&2; exit 4; }
VM="drag-harness-$(date +%s)-$$"
export PATH="$SOFTNET_DIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Builds run at background priority, or through a shared compile gate when BUILDGATE names one (a busy Mac).
if [ -n "${BUILDGATE:-}" ]; then BUILD=("$BUILDGATE"); else BUILD=(taskpolicy -b nice -n 15); fi

# The sandbox's Softnet rules (SandboxNetwork.rules): private, tailnet and link-local ranges, each of this Mac's own
# IPv4 addresses, and the gateway, blocked; only the gateway's DNS allowed. The guest needs no network at all here.
OWN=$(ifconfig | awk '/inet / {print $2}' | grep -v '^127\.' | sort -u | sed 's/$/\/32/' | paste -sd, -)
BLOCK="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16${OWN:+,$OWN},out @host"
ALLOW="out proto udp @host port 53,out proto tcp @host port 53"

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/guest-drag-stage.XXXXXX")
OUT=$(mktemp -d "${TMPDIR:-/tmp}/guest-drag-out.XXXXXX")
RUN_PID=""
cleanup() {
  local rc=$?
  if [ "$DRY" = 0 ] && [ "$KEEP" = 0 ]; then
    [ -n "$RUN_PID" ] && kill "$RUN_PID" 2>/dev/null || true
    "$TART" stop "$VM" >/dev/null 2>&1 || true
    "$TART" delete "$VM" >/dev/null 2>&1 || true
    if "$TART" list --source local --quiet 2>/dev/null | grep -qx "$VM"; then
      echo "guest-drag: WARNING: $VM is still in tart list; delete it: tart delete $VM" >&2
    else
      echo "guest-drag: $VM deleted"
    fi
  elif [ "$KEEP" = 1 ]; then
    echo "guest-drag: kept $VM running (--keep). Delete it when done: tart stop $VM; tart delete $VM"
  fi
  rm -rf "$STAGE"
  [ "$DRY" = 0 ] || rm -rf "$OUT"
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

run_args=(run --no-graphics --no-clipboard --no-audio --no-usb-accessories
  --net-softnet "--net-softnet-allow=$ALLOW" "--net-softnet-block=$BLOCK"
  "--dir=stage:$STAGE:ro" "--dir=out:$OUT" "--dir=browser:$BROWSER:ro" "$VM")
if [ "$DRY" = 1 ]; then
  echo "tart clone $IMAGE $VM"
  echo "tart set $VM --memory 4096 --cpu 2 --display $DISPLAY_SIZE"
  printf 'tart'; printf ' %q' "${run_args[@]}"; echo
  echo "driver: real-drag --guest$(printf ' %q' "${DRIVER_ARGS[@]}")"
  exit 0
fi

[ -d "$BROWSER" ] || { echo "guest-drag: no browser at $BROWSER" >&2; exit 4; }
running=$("$TART" list --source local --format json | /usr/bin/python3 -c 'import json,sys; print(sum(1 for v in json.load(sys.stdin) if v.get("Running")))')
[ "$running" -lt 2 ] || { echo "guest-drag: two macOS guests are running already (Apple's limit); try again later" >&2; exit 4; }

# The Polycarp build for the guest: the release binary and its engine in a bare, ad-hoc signed bundle. Never distribute it.
if [ "$NO_POLYCARP" = 0 ] && [ "$POLYCARP" = build/guest/Polycarp.app ]; then
  BIN=$("${BUILD[@]}" swift build -c release --arch arm64 -j 3 --show-bin-path 2>/dev/null | tail -1)/BaneySpaces
  [ -x "$BIN" ] || { echo "guest-drag: build first: scripts/build-engine.sh && scripts/build-core.sh && swift build -c release --arch arm64" >&2; exit 4; }
  rm -rf "$POLYCARP" && mkdir -p "$POLYCARP/Contents/MacOS" "$POLYCARP/Contents/Frameworks"
  cp "$BIN" "$POLYCARP/Contents/MacOS/Polycarp"
  cp engine/lib/libagent_desktop_ffi.dylib "$POLYCARP/Contents/Frameworks/"
  install_name_tool -add_rpath @executable_path/../Frameworks "$POLYCARP/Contents/MacOS/Polycarp" 2>/dev/null || true
  # shellcheck source=product.env
  . scripts/product.env
  cat > "$POLYCARP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string><key>CFBundleName</key><string>Polycarp</string>
<key>CFBundleExecutable</key><string>Polycarp</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$(cat VERSION)</string><key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
  codesign --force --deep --sign - "$POLYCARP" >/dev/null
fi
[ "$NO_POLYCARP" = 1 ] || cp -R "$POLYCARP" "$STAGE/Polycarp.app"
"${BUILD[@]}" swiftc -O -target arm64-apple-macos13 -j 3 scripts/real-drag.swift -o "$STAGE/real-drag" 2>&1 | grep -v warning || true
[ -x "$STAGE/real-drag" ] || { echo "guest-drag: real-drag didn't compile" >&2; exit 4; }
codesign --force --sign - --identifier com.baney.polycarp.realdrag "$STAGE/real-drag" >/dev/null
cp scripts/guest-drag-setup.sh "$STAGE/setup.sh"

echo "guest-drag: cloning $IMAGE into $VM"
"$TART" clone "$IMAGE" "$VM"
"$TART" set "$VM" --memory 4096 --cpu 2 --display "$DISPLAY_SIZE"
"$TART" "${run_args[@]}" >"$OUT/tart-run.log" 2>&1 &
RUN_PID=$!
for _ in $(seq 1 120); do
  "$TART" exec "$VM" /usr/bin/true >/dev/null 2>&1 && break
  kill -0 "$RUN_PID" 2>/dev/null || { echo "guest-drag: the VM exited while booting:" >&2; tail -5 "$OUT/tart-run.log" >&2; exit 4; }
  sleep 2
done
"$TART" exec "$VM" /usr/bin/true >/dev/null || { echo "guest-drag: the guest agent never answered" >&2; exit 4; }

echo "guest-drag: setting up the guest"
"$TART" exec "$VM" /bin/bash "/Volumes/My Shared Files/stage/setup.sh" "$NO_POLYCARP" || { echo "guest-drag: guest setup failed" >&2; exit 4; }

echo "guest-drag: dragging"
set +e
"$TART" exec "$VM" /bin/bash -c 'exec "$0" --guest --out "/Volumes/My Shared Files/out/drag" "$@"' /Users/admin/real-drag "${DRIVER_ARGS[@]}"
rc=$?
set -e
"$TART" exec "$VM" /bin/bash -c 'cp "$HOME/Library/Application Support/Polycarp/trace.log" "/Volumes/My Shared Files/out/guest-trace.log" 2>/dev/null; sw_vers > "/Volumes/My Shared Files/out/guest-macos.txt"' || true
echo "guest-drag: results in $OUT (exit $rc)"
exit $rc
