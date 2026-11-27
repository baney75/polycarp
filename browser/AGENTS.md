# Polycarp Browser rules

- Source: a published `imputnet/helium-macos` release. The disk image may be mounted read-only or unpacked into a private folder;
  nothing from it is changed, run or installed until the `.app` inside passes a strict code signature check, carries the pinned
  Team ID and Gatekeeper accepts it. A check that can't run is a refusal.
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
  `spaces/spec/browser.md` R-B20), does that under Local Studio's own rules. The remote debugging port is never opened in a person's browser.
- The label `com.polycarp.browser` and `~/.config/polycarp/browser/` belong to the retired helper and are never used. This browser is
  `com.baney.polycarp.browser`, its data folder `Polycarp/Browser` in Application Support.
- Tests use throwaway profiles and homes, never a real browser's.
