# Changelog

## Unreleased

- Records (cookie, bookmark, extension, setting, tab, history) with stable keys, hybrid logical clock stamps and a merge that gives every device the same result in any order. Cookies are off until turned on, sites can be excluded, and cookies that would be no use on another device never move.
- Each device has its own Ed25519 identity and storage key, made on the device and kept in the macOS Keychain or the Windows Credential Manager; on a system with neither, in a private file and only with `--allow-key-file`.
