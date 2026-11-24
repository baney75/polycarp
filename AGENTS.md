# Polycarp agent rules

Polycarp is its own OS on macOS and Windows: Spaces, the dock, the bar, the launcher and themes (Donovan, 2026-11-23). Its browser extension for reading and the new tab (`spaces/extension`, Donovan, 2026-11-21) is the accessibility extension that was Phont: it works on its own, with no Polycarp app, and joins Polycarp (new tab host, updates with the app) when Polycarp is installed on the same computer (Donovan, 2026-11-23). The agent browser extension (the side panel), its CLI helper, MCP server and computer-use tools were removed from Polycarp. The voice app moved to Silas: https://github.com/baney75/silas. The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

Browser agent and computer-use work does not belong here, voice work goes to Silas, and Linux desktop work is retired. A PR here that adds any of it is refused. Polycarp's reading extension in `spaces/extension` is not browser agent work and belongs here.

This repo holds the Spaces app (`spaces/`), the themes (`themes/`) and one small command (`cli/`) with their full
history. Each directory keeps its own `AGENTS.md` rules; read the one for the directory you
touch before you change it. No renaming of the products yet.

`cli/` has its own rules in `cli/AGENTS.md`.

## Done checks

Run each from its directory.

- `cli/`: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.
- `spaces/`: `swift build` and `swift test` (its `AGENTS.md` adds probes and a live check).
- The root `install.sh`: `bash -n install.sh`. Never run `install.sh` itself against your real home to test it.

`./check.sh` at the root runs them in order and continues past a failure.

## Themes

Themes live in `themes/` (one TOML file each, built into the `polycarp` command) and must validate:
`polycarp theme validate themes/<name>.toml`. The `cli/` tests do this for every file. Format and rules are in
`themes/README.md`. Products take every color, radius, font and duration from the theme, never from a
hard-coded value. When you test the `theme` command by hand, set `POLYCARP_CONFIG_DIR` to a temp absolute path, never your real config folder.
