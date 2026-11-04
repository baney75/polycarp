#!/bin/bash
# Check out the sibling repos this extension builds against, apply the pi-mono patch,
# and build the pi-mono declarations that type checking needs.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
parent="$(dirname "$here")"
pi_mono_rev="ff1ea1232"
mini_lit_rev="dee21bf1175de0cb16a946ba8fb62c1e590fbd3c"

[ -d "$parent/mini-lit" ] || git clone https://github.com/badlogic/mini-lit.git "$parent/mini-lit"
[ -d "$parent/pi-mono" ] || git clone https://github.com/badlogic/pi-mono.git "$parent/pi-mono"

# A pinned revision an older clone doesn't have yet (the pin moved in a pull) is fetched first.
ensure_rev() { git cat-file -e "$1^{commit}" 2>/dev/null || git fetch -q origin "$1" || git fetch -q origin; }

cd "$parent/pi-mono"
ensure_rev "$pi_mono_rev"
# The patch can add files. Mark the ones it adds (in this or any earlier revision) intent-to-add,
# so `git diff` shows them and an applied patch compares equal to its own text. Other untracked
# files are left alone.
added_files() { git apply --summary 2>/dev/null | awk '$1 == "create" { print $4 }'; }
marked=()
for f in $( { added_files < "$here/patches/pi-mono.patch"; for rev in $(git -C "$here" log --format=%H -- patches/pi-mono.patch); do git -C "$here" show "$rev:patches/pi-mono.patch" 2>/dev/null | added_files; done; } | sort -u); do
	if [ -f "$f" ] && ! git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
		git add --intent-to-add -- "$f"
		marked+=("$f")
	fi
done
# On a refusal, leave the index as we found it.
unmark() { if [ "${#marked[@]}" -gt 0 ]; then git reset -q -- "${marked[@]}"; fi; }
# Compare with HEAD, so a staged hand edit counts as a local change too.
if ! git diff HEAD --quiet; then
	if git apply --reverse --check "$here/patches/pi-mono.patch" 2>/dev/null; then
		if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$pi_mono_rev^{commit}")" ]; then
			echo "pi-mono patch already applied"
		else
			# The same patch on an old pin: take it off, move to the pin, put it back.
			echo "pi-mono is not at the pinned $pi_mono_rev; moving it there"
			git apply --reverse "$here/patches/pi-mono.patch"
			cur_added=( $(added_files < "$here/patches/pi-mono.patch") )
			if [ "${#cur_added[@]}" -gt 0 ]; then git reset -q -- "${cur_added[@]}"; fi
			git checkout -q "$pi_mono_rev"
			git apply "$here/patches/pi-mono.patch"
		fi
	else
		# An older revision of the patch is applied: swap it for the current one, but only
		# when the local changes are exactly that older patch, so no hand edits are lost.
		current="$(git diff HEAD)"
		upgraded=""
		for rev in $(git -C "$here" log --format=%H -- patches/pi-mono.patch); do
			old_patch="$(git -C "$here" show "$rev:patches/pi-mono.patch" 2>/dev/null || true)"
			if [ -n "$old_patch" ] && [ "$old_patch" = "$current" ]; then
				echo "pi-mono has an older patch (${rev:0:7}); updating it"
				git -C "$here" show "$rev:patches/pi-mono.patch" | git apply --reverse
				# Drop only the intent-to-add entries of files that revision added; nothing else in the index.
				old_added=( $(git -C "$here" show "$rev:patches/pi-mono.patch" | added_files) )
				if [ "${#old_added[@]}" -gt 0 ]; then git reset -q -- "${old_added[@]}"; fi
				# Make sure it sits on the pin before patching.
				git checkout -q "$pi_mono_rev"
				git apply "$here/patches/pi-mono.patch"
				upgraded=1
				break
			fi
		done
		if [ -z "$upgraded" ]; then
			echo "pi-mono has local changes that are not patches/pi-mono.patch; resolve them first" >&2
			unmark
			exit 1
		fi
	fi
else
	git checkout -q "$pi_mono_rev"
	git apply "$here/patches/pi-mono.patch"
fi

# Pin mini-lit too: the release build runs its install scripts, so it must be a known revision.
(cd "$parent/mini-lit" && ensure_rev "$mini_lit_rev")
if [ "$(git -C "$parent/mini-lit" rev-parse HEAD)" != "$mini_lit_rev" ]; then
	if git -C "$parent/mini-lit" diff --quiet; then
		git -C "$parent/mini-lit" checkout -q "$mini_lit_rev"
	else
		echo "mini-lit has local changes and is not at $mini_lit_rev; resolve them first" >&2
		exit 1
	fi
fi
(cd "$parent/mini-lit" && npm install --no-audit --no-fund && npm run build)
npm install --no-audit --no-fund
# Never run `npm run build` in packages/ai: it regenerates the model list.
for pkg in tui ai agent web-ui; do
	(cd "packages/$pkg" && npx tsgo -p tsconfig.build.json)
done

cd "$here"
npm install --no-audit --no-fund
(cd cli && npm install --no-audit --no-fund)
