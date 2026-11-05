# The polycarp command

Done: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.

Rules:

- Hand off exactly: arguments, input, output and exit code stay what the tool gave. On Unix the process is replaced.
- Nothing runs through a shell.
- Nothing runs from the current folder. Every candidate passes `usable()`, whether it came from an override, `PATH` or a fixed spot. It must be an absolute path, outside the current folder, including through a symlink.
- Tests get their own home and `PATH`. They never reach a real installed tool.
