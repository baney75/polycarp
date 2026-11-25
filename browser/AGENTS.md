# Polycarp Browser rules

- Source: a published `imputnet/helium-macos` release. Nothing is unpacked, changed or run before its code signature
  verifies, its Team ID is the pinned one and Gatekeeper accepts it. A check that can't run is a refusal.
- The result is built on the person's machine, from scratch, beside the old one, and swapped in only after it starts
  headless. The running browser is never replaced under the person. Nothing here needs admin rights.
- No Helium binary, name, logo or non-free asset is committed or published. `browser/` is GPL-3.0-or-later.
- Helium, Chrome and every other browser's data is read, never written. Import copies; the original stays. Cookies, keys and
  passwords never reach a log, an error, a test fixture or an agent. No MCP tool or CLI output carries one.
- Sync sends ciphertext between the person's own devices. No Polycarp server holds data or keys. A new device joins only
  after a passkey or security key says so on one that is already in.
- No agent tool drives pages (Tychicus does that). The command-line debugging port is never opened.
- Tests use throwaway profiles and homes, never a real browser's.
