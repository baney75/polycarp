# Changelog

## Unreleased

- Records (cookie, bookmark, extension, setting, tab, history) with stable keys, hybrid logical clock stamps and a merge that gives every device the same result in any order. Cookies are off until turned on, a site can be excluded by any of its host names, and cookies that would be no use on another device never move. A clock that was wrong once is put right: no stamp is given or taken more than ten minutes ahead, a stamp another device may hold is never lowered, and an edit goes over the record it replaces.
- Sealing and hashing, the only crypto here: XChaCha20-Poly1305 bound to the place a value belongs, HKDF-SHA256 keys made for one use, and SHA-256 hashes whose labels and parts never run together.
- Each device has its own Ed25519 identity and storage key, made on the device and kept in the macOS Keychain or the Windows Credential Manager; on a system with neither, in a private file and only with `--allow-key-file`.
- Passkey answers are checked: the right request, a localhost page outside any frame, the person verified, a counter that went up where the passkey keeps one, and one of the group's own passkeys. One passkey that can't be read doesn't stop the others. A proof keeps what was signed and no extension output.
- The member list: signed entries that only grow, each allowed by one of the group's passkeys for exactly that change, that device and that place in the list. Every device checks every entry; two lists changed apart are refused, the last passkey and the last device stay, and a removed device's key never comes back.
- The passkey page: one page for one question on `http://localhost`, on a port of its own with both loopback addresses taken, behind a random path that works once. It answers only to its own host name and origin, sends no CORS header, can't be framed, expires after five minutes, and hands a PRF key back apart from the proof.
