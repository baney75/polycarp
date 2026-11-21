#!/usr/bin/env bash
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
check=$here/../check-channels.sh
status=0
out=$("$check" "$here/fixtures/good-channels" 2>&1) || { echo "good fixture failed: $out"; status=1; }
out=$("$check" "$here/fixtures/bad-channels" 2>&1) && { echo "bad fixture passed"; status=1; }
for want in "release.yml starts on a pushed tag" "stable.yml uses the stable environment but also runs on push" "docs/remote.md does not state min_protocol"; do
  grep -qF "$want" <<<"$out" || { echo "bad fixture did not report: $want"; status=1; }
done
exit $status
