#!/bin/bash
# Prints the version string a build carries on its channel (docs/releases.md, after docs/channels.md in
# baney75/local-studio). These are SemVer 2.0 strings, so for one base version dev < nightly < stable.
#   scripts/channel-version.sh stable    0.4.0
#   scripts/channel-version.sh nightly   0.4.0-nightly.20261118070000+1a2b3c4
#   scripts/channel-version.sh dev       0.4.0-dev.20261117131042+9f8e7d6
#   scripts/channel-version.sh local     0.4.0-dev.0+local.9f8e7d6
#   scripts/channel-version.sh --bundle-version   20261118.070000 (CFBundleVersion: the build time, always rising)
# The base is VERSION. POLYCARP_BUILD_TIME (YYYYMMDDHHMMSS, UTC) pins the build time and POLYCARP_COMMIT the
# commit, so every step of one build prints the same string.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "channel-version.sh: $*" >&2; exit 1; }
BASE=$(tr -d '[:space:]' < VERSION)
[[ "$BASE" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail "VERSION is \"$BASE\", not X.Y.Z."
TIME="${POLYCARP_BUILD_TIME:-$(date -u +%Y%m%d%H%M%S)}"
[[ "$TIME" =~ ^20[0-9]{12}$ ]] || fail "POLYCARP_BUILD_TIME is \"$TIME\", not YYYYMMDDHHMMSS."
sha7() {
  local c="${POLYCARP_COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}"
  [[ "$c" =~ ^[0-9a-f]{7,40}$ ]] || fail "no commit: set POLYCARP_COMMIT or run inside a git checkout."
  printf '%s' "${c:0:7}"
}
case "${1:-}" in
  stable) echo "$BASE" ;;
  nightly|dev) echo "$BASE-$1.$TIME+$(sha7)" ;;
  local) echo "$BASE-dev.0+local.$(sha7)" ;;
  --bundle-version) echo "${TIME:0:8}.${TIME:8:6}" ;;
  *) fail "usage: scripts/channel-version.sh stable|nightly|dev|local|--bundle-version" ;;
esac
