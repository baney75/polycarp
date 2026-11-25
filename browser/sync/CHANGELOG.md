# Changelog

## Unreleased

- Records (cookie, bookmark, extension, setting, tab, history) with stable keys, hybrid logical clock stamps and a merge that gives every device the same result in any order. Cookies are off until turned on, sites can be excluded, and cookies that would be no use on another device never move.
- Each device has its own Ed25519 identity and storage key, made on the device and kept in the macOS Keychain or the Windows Credential Manager; on a system with neither, in a private file and only with `--allow-key-file`.
- Passkey answers are checked: the right request, the right page, the person verified, a counter that went up, and one of the group's own passkeys. A proof keeps what was signed and no extension output.
- The member list: signed entries that only grow, each allowed by one of the group's passkeys for exactly that change, that device and that place in the list. Every device checks every entry; two lists changed apart are refused, the last passkey and the last device stay, and a removed device's key never comes back.
- The passkey page: one page for one question on `http://localhost`, on a port of its own with both loopback addresses taken, behind a random path that works once. It answers only to its own host name and origin, sends no CORS header, can't be framed, expires after five minutes, and hands a PRF key back apart from the proof.
- A SQLite file on disk whose every value is sealed with the device's storage key. Row names are keyed hashes, a row does not open under another name or revision, deleted values are overwritten, and only the owner can read the file.
- The vault: the group and its key, the records, what syncs here and what is known of each peer, kept across restarts. Everything from another device meets this one's rules again; turning a type off forgets it here and deletes it nowhere; removing a device needs the new group key in the same step.
- The network: iroh (QUIC, encrypted end to end) with a door that decides right after the handshake. A device that is not in the member list gets no stream, in or out, and is not told whether there is a group. Messages are length-limited, time out, and can be sealed with the group key for one sender, one receiver, one session and one place in it.
