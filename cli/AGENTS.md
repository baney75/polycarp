# The polycarp command

Done: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.

Rules:

- Hand off exactly: arguments, input, output and exit code stay what the tool gave. On Unix the process is replaced.
- Nothing runs through a shell.
- Nothing runs from inside the current folder's tree. Every candidate passes `check()`, whether it came from an override, `PATH` or a fixed spot. It must be an absolute path and not under the current folder (`$PWD/node_modules/.bin` counts), including through a symlink. One exception: when the current folder is the home folder or an ancestor of it (`~` or `/`), `~/.local/bin` is allowed. If the current folder, or the candidate, can't be resolved, the answer is no. A refusal for being in the current folder is said so, with the path, and still exits 127.
- Nothing runs through a shell, so on Windows a `.cmd` or `.bat` (an override, or `tabkyra.cmd` from npm) is refused with the reason, and `doctor` calls it present but not runnable.
- On a Mac, `voice` and `doctor` use the same app: `/Applications/Silas.app`, else `~/Applications/Silas.app`.
- `doctor` gives each `--version` 10 seconds, reading its output included, and treats a closed pipe as a quiet end.
- Test hooks, never set in real use: `POLYCARP_NO_SYSTEM_SPOTS`, `POLYCARP_DOCTOR_LIMIT_MS`, `POLYCARP_SHIM_CHECK` (applies the `.cmd` rule on any system).
- Tests get their own home and `PATH`. They never reach a real installed tool.
