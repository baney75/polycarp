# Polycarp Browser rules

- Source: a published `imputnet/helium-macos` release. The disk image may be mounted read-only or unpacked into a private folder;
  nothing from it is changed, run or installed until the `.app` inside passes a strict code signature check, carries the pinned
  Team ID and Gatekeeper accepts it. A check that can't run is a refusal. On Windows the source is a published
  `imputnet/helium-windows` release zip with the sha256 GitHub's listing gives, and every `.exe` and `.dll` in it must be
  Authenticode-valid from the pinned signer imput LLC; nothing from it is run or installed before that. Its dry run then builds
  Polycarp Browser from the checked copy in a work folder (parts from `POLYCARP_BROWSER_RESOURCES`, made by
  `scripts/build-parts-windows.sh`): `helium_update_helper.exe` is removed and must be there to remove, `initial_preferences`
  beside `chrome.exe` turns Helium's update fetching off, the `locales` text packs are renamed, and no program or DLL is edited. It is then started once headless, without Local Studio's part, with a throwaway profile (`--user-data-dir`) and
  `TEMP`, `TMP`, `LOCALAPPDATA`, `APPDATA` and `USERPROFILE` pointed inside the work folder, `POLYCARP_GITHUB_TOKEN` taken out of its environment and no remote debugging, and
  must show Polycarp's new tab within 180 s; whatever still runs from the build is stopped and the work folder deleted. `install` then adds Local Studio's part, refuses while anything runs from `%LOCALAPPDATA%\Programs\Polycarp Browser`, and swaps the build in through `Polycarp Browser.new` and `.old` beside it, writing `polycarp\installed.json` and a Start Menu shortcut; `uninstall` keeps the profile unless `--profile --yes`. On Linux the source is a
  published `imputnet/helium-linux` release tarball with the sha256 GitHub's listing gives, and its detached OpenPGP signature
  must be valid from the pinned key `BE67 7C19 89D3 5EAB 2C5F 26C9 3516 01AD 01D6 378E`; nothing from it is unpacked, run or
  installed before that. Its dry run then builds Polycarp Browser in a work folder as on Windows (parts made by
  `scripts/build-parts-linux.sh`): the tarball has no updater program, `initial_preferences` goes beside `helium`, not its
  wrapper, and the launcher is `polycarp-browser` (mode 0755) beside `helium-wrapper`. It is then started once headless as on
  Windows, under Chromium's own sandbox (never `--no-sandbox`), with `--password-store=basic`, `HOME`, the `XDG_*` folders and
  `TMPDIR` inside a private folder of its own under `/tmp` (short, so Chromium's socket path fits), and `POLYCARP_GITHUB_TOKEN`, `DISPLAY`, `WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` taken
  out of its environment; every process whose `/proc/<pid>/exe` is inside the build is then stopped and that folder and the work folder deleted.
  `install` then works as on Windows, in `$XDG_DATA_HOME/polycarp-browser` (else `~/.local/share/polycarp-browser`): it refuses
  while any `/proc/<pid>/exe` is inside it (never stopping one), swaps the build in through `.new` and `.old` beside it, writes
  `polycarp/installed.json` and a menu entry, `applications/polycarp-browser.desktop` (0644, its `Exec` path quoted, a path with
  a line break or `%` refused); `uninstall` keeps the profile unless `--profile --yes`.
- The result is built on the person's machine, from scratch, beside the old one, and swapped in only after it starts headless on a
  fresh throwaway profile, deleted afterwards. The running browser is never replaced under the person. Nothing here needs admin rights.
- No Helium binary, logo or non-free asset is committed or published, and Helium's name is never the product's name or brand.
  Source references and license credits name it. `browser/` is GPL-3.0-or-later; `cli/` (MIT) neither links nor embeds its code.
- Helium, Chrome and every other browser's data is read, never written. Import copies; the original stays. Cookies, tokens, keys,
  passwords, payment and autofill data, history, and mail or message content never reach a log, an error, a test fixture or, unless
  the person turned on a scope for it, an agent. Fixtures hold made-up values. No MCP tool or CLI output ever carries a cookie, token, key or password.
- Sync sends ciphertext between the person's own devices. No Polycarp server holds data or keys. A new device joins only
  after a passkey or security key says so on one that is already in.
- No Polycarp agent tool drives pages. Local Studio's extension, built in from a pinned commit (Donovan, 2026-11-26;
  `spaces/spec/browser.md` R-B20), does that under Local Studio's own rules: it reaches only the helper the person installed for Helium, with that helper's own approvals, and Polycarp grants it no scope. The remote debugging port is never opened in a person's browser.
- The label `com.polycarp.browser` and `~/.config/polycarp/browser/` belong to the retired helper and are never used. This browser is
  `com.baney.polycarp.browser`, its data folder `Polycarp/Browser` in Application Support.
  On Windows its profile is `%LOCALAPPDATA%\Polycarp\Browser` and on Linux `$XDG_CONFIG_HOME/Polycarp/Browser` (default
  `~/.config/Polycarp/Browser`), and the launcher passes it, so Helium's own profile is never used.
- Tests use throwaway profiles and homes, never a real browser's.
