# polycarp-theme

The theme format as a library: the schema, the checks, contrast, resolving `extends` and
per-product overrides, and the text of `theme.json` and each surface's CSS. The `polycarp theme`
command (`cli/src/theme.rs`) and Local Studio both use it, so a theme reads, checks and resolves the
same way in each.

Done: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`, here and in `cli/`.

Rules:

- It writes no files and takes no lock. Writes go through `polycarp theme`, which holds the lock.
- Reading is fine: the built-in themes are compiled in from `themes/`, and `read_theme_file` reads a
  user theme. Anything else a caller supplies through `Themes`.
- No behavior change without a test. `cli/tests/theme.rs` holds the output of every built-in theme
  byte for byte (`cli/tests/fixtures/theme-outputs/`).
- Other repos take it as a git dependency pinned to a tag `polycarp-theme-v<version>`. No workflow
  starts on that tag.
