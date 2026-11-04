# Polycarp agent rules

This repo holds three apps with their full history. Each directory keeps its own `AGENTS.md`
rules; read the one for the directory you touch before you change it. No renaming of the products
yet.

## Done checks

Run each from its directory.

- `spaces/`: `swift build` and `swift test` (its `AGENTS.md` adds probes and a live check).
- `voice/`: `bun install --frozen-lockfile`, then
  `bun run build && (cd src-tauri && cargo test --lib && cargo clippy --lib -- -D warnings)`.
- `browser/`: `scripts/setup-siblings.sh`, `npm ci` (and in `cli/`), then `npx biome check .`,
  `npx tsc --noEmit`, `node --import tsx --test test/*.test.mjs`,
  `(cd cli && npx tsc --noEmit && npm test)`, `node cli/dist/index.js skill lint skills` and
  `(cd cli && node --test test/skill-lint.test.mjs)`. Do not run `browser/check.sh` (it writes with
  `--write`), `./dev.sh` or `npm run dev`. Build only with `TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=<scratch dir>`.

`./check.sh` at the root runs all three in order and continues past a failure.

## Siblings

`browser/` needs `mini-lit/` and `pi-mono/` beside it. `browser/scripts/setup-siblings.sh` clones
them into the repo root, where `.gitignore` ignores them.
