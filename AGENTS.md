# Polycarp agent rules

Polycarp is for macOS and Windows. The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

Browser and voice work goes to Tychicus and Silas; Linux desktop work is retired. A PR here that adds any of it is refused.
Until `voice/` and `browser/` leave this repo, a fix for something that broke in them still lands here.

This repo holds three apps, one small command (`cli/`) and the theme library it uses (`crates/polycarp-theme/`) with their full history. Each directory keeps its own `AGENTS.md`
rules; read the one for the directory you touch before you change it. No renaming of the products
yet.

`cli/` has its own rules in `cli/AGENTS.md`.

## Done checks

Run each from its directory.

- `cli/`: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.
- `crates/polycarp-theme/`: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.
  `cli/` builds it in, so run both after a change to either.
- `spaces/`: `swift build` and `swift test` (its `AGENTS.md` adds probes and a live check).
- `voice/`: `bun install --frozen-lockfile`, then
  `bun run build && (cd src-tauri && cargo test --lib && cargo clippy --lib -- -D warnings)`.
- `browser/`: `scripts/setup-siblings.sh`, `npm ci` (and in `cli/`), then `npx biome check .`,
  `npx tsc --noEmit`, `node --import tsx --test test/*.test.mjs`,
  `(cd cli && npx tsc --noEmit && npm test)`, `node cli/dist/index.js skill lint skills` and
  `(cd cli && node --test test/skill-lint.test.mjs)`. Do not run `browser/check.sh` (it writes with
  `--write`), `./dev.sh` or `npm run dev`. Build only with `TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=<scratch dir>`.

- The root `install.sh`: `bash -n install.sh`. Never run `install.sh` itself against your real home to test it.

`./check.sh` at the root runs them all in order and continues past a failure.

## Themes

Themes live in `themes/` (one TOML file each, built into the `polycarp` command) and must validate:
`polycarp theme validate themes/<name>.toml`. The `cli/` tests do this for every file. Format and rules are in
`themes/README.md`. Products take every color, radius, font and duration from the theme, never from a
hard-coded value. When you test the `theme` command by hand, set `POLYCARP_CONFIG_DIR` to a temp absolute path, never your real config folder.

## Siblings

`browser/` needs `mini-lit/` and `pi-mono/` beside it. `browser/scripts/setup-siblings.sh` clones
them into the repo root, where `.gitignore` ignores them.
