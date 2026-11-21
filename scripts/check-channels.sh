#!/usr/bin/env bash
set -euo pipefail
root=${1:-$(git rev-parse --show-toplevel)}
fail=0
err() { echo "check-channels: $*" >&2; fail=1; }

triggers() {
  awk '/^on:/{on=1;next} on&&/^[^ #]/{on=0} on&&/^  [a-z_]+:/{sub(/^  /,"");sub(/:.*/,"");print}' "$1"
}

shopt -s nullglob
for wf in "$root"/.github/workflows/*.yml "$root"/.github/workflows/*.yaml; do
  name=${wf#"$root"/}
  if awk '/^on:/{on=1;next} on&&/^[^ #]/{on=0} on&&/^  push:/{p=1;next} on&&/^  [a-z_]+:/{p=0} on&&p&&/^    tags:/{f=1} END{exit !f}' "$wf"; then
    err "$name starts on a pushed tag; stable builds start only from promote.yml"
  fi
  if awk '/^ +environment: *["'"'"']?stable["'"'"']? *$/{f=1} /^ +environment: *$/{e=1;next} e&&/^ +name: *["'"'"']?stable["'"'"']? *$/{f=1} {e=0} END{exit !f}' "$wf"; then
    for t in $(triggers "$wf"); do
      case $t in workflow_call|workflow_dispatch) ;; *) err "$name uses the stable environment but also runs on $t" ;; esac
    done
  fi
done

order=(0.2.0 0.2.1 0.3.0-dev.20261117131042 0.3.0-dev.20261118090500 0.3.0-nightly.202611160700 0.3.0-nightly.20261117070000 0.3.0)
if [ "$(npx -y semver@7.6.3 "${order[@]}" 2>/dev/null)" != "$(printf '%s\n' "${order[@]}")" ]; then
  err "versions do not sort stable < hotfix < dev < nightly < next stable"
fi

if [ -f "$root/docs/remote.md" ] && ! grep -q 'min_protocol' "$root/docs/remote.md"; then
  err "docs/remote.md does not state min_protocol; docs/channels.md requires both sides to speak their protocol and the one before it"
fi

exit $fail
