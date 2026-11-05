# The polycarp command

Done: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.

Rules:

- Hand off exactly: arguments, input, output and exit code stay what the tool gave. On Unix the process is replaced.
- `polycarp browser` runs the helper inside Polycarp.app (`Contents/Resources/browser/polycarp-browser`, in `~/Applications` then `/Applications`) first, after only the `POLYCARP_BROWSER_BIN` override and before `PATH`; `tabkyra` on `PATH` and its older spots are the fallback. The `bundled` list on `Tool` holds those spots.
- Nothing runs through a shell.
- Nothing runs from inside the current folder's tree. Every candidate passes `check()`, whether it came from an override, `PATH` or a fixed spot. It must be an absolute path and not under the current folder (`$PWD/node_modules/.bin` counts), including through a symlink. Two narrow exceptions: from `/` nothing is refused, so the system spots work; and when the current folder is the home folder or an ancestor of it, a candidate in a specific per-user install place is still allowed (`HOME_ALLOWED` in `main.rs`: `~/.local/bin`, `~/.local/lib/node_modules`, `~/.local/share/mise`, `~/.cargo/bin`, `~/.bun/bin`, `~/.bun/install/global`, `~/.volta/bin`, `~/.nvm/versions`, `~/.asdf/shims`, `~/.asdf/installs`, `~/.npm-global`, `~/Library/pnpm`, `~/.config/tabkyra`, the Windows `AppData/Local/Programs` and `scoop` folders, and a real app bundle in `~/Applications`, only under `Contents/`). Whole trees such as `~/.local` are not listed, since a repo can be cloned into them. The home folder is checked first; `/opt` and `/usr` apply only to candidates outside it. Both the candidate's target and the folder it sits in are judged; an app bundle is judged by itself only. Everything else under the current folder is refused, including `~/node_modules/.bin`, a file directly in `~` and anything in a project folder. If the current folder, or the candidate, can't be resolved, the answer is no. A refusal for being in the current folder is said so, with the path, and still exits 127.
- Nothing runs through a shell, so on Windows a `.cmd` or `.bat` (an override, or `tabkyra.cmd` from npm) is refused with the reason, and `doctor` calls it present but not runnable.
- On a Mac, `voice` and `doctor` use the same app: `/Applications/Silas.app`, else `~/Applications/Silas.app`.
- `doctor` gives each `--version` 10 seconds, reading its output included, and stops printing on a write error (a closed pipe is a quiet end) but still finishes the checks, so the exit code stays true.
- Test hooks, never set in real use: `POLYCARP_NO_SYSTEM_SPOTS`, `POLYCARP_DOCTOR_LIMIT_MS`, `POLYCARP_SHIM_CHECK` (applies the `.cmd` rule on any system), `POLYCARP_OPEN_BIN` (stands in for macOS `open`, so tests launch no app; it passes `check()` too), `POLYCARP_TEST_SYSTEM_ALLOWED` (replaces `/opt` and `/usr`).
- Tests get their own home and `PATH`. They never reach a real installed tool.
