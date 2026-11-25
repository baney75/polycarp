# Changelog

## Unreleased

- Records (cookie, bookmark, extension, setting, tab, history) with stable keys, hybrid logical clock stamps and a merge that gives every device the same result in any order. Cookies are off until turned on, a site can be excluded by any of its host names, and cookies that would be no use on another device never move. A clock that was wrong once is put right: no stamp is given or taken more than ten minutes ahead, a stamp another device may hold is never lowered, and an edit goes over the record it replaces.
- Sealing and hashing, the only crypto here: XChaCha20-Poly1305 bound to the place a value belongs, HKDF-SHA256 keys made for one use, and SHA-256 hashes whose labels and parts never run together.
- Each device has its own Ed25519 identity and storage key, made on the device and kept in the macOS Keychain or the Windows Credential Manager; on a system with neither, in a private file and only with `--allow-key-file`.
- Passkey answers are checked: the right request, the right page, the person verified, a counter that went up, and one of the group's own passkeys. A proof keeps what was signed and no extension output.
