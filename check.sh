#!/bin/bash
# Run each directory's done check, in order. Keep going past a failure; exit non-zero if any failed.
# Set CARGO_TARGET_DIR to keep Rust build output out of the checkout.
cd "$(dirname "$0")" || exit 1
root="$PWD"
failed=0

run() {
	local name="$1" dir="$2" cmd="$3"
	echo "=== $name ($dir)"
	if (cd "$root/$dir" && bash -c "set -e; $cmd"); then
		echo "PASS $name"
	else
		echo "FAIL $name"
		failed=1
	fi
}

run cli cli 'cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check'
run spaces spaces 'swift build && swift test'
run voice voice 'bun install --frozen-lockfile && bun run build && bun run check:theme && bun test && (cd src-tauri && cargo test --lib && cargo clippy --lib -- -D warnings)'
run browser browser 'scripts/setup-siblings.sh && npm ci && (cd cli && npm ci) && npx biome check . && npx tsc --noEmit && node scripts/check-theme.mjs && node --import tsx --test test/*.test.mjs && (cd cli && npx tsc --noEmit && npm test) && node cli/dist/index.js skill lint skills && (cd cli && node --test test/skill-lint.test.mjs)'

exit "$failed"
