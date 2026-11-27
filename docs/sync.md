# Sync

`polycarp sync` keeps Polycarp's settings the same on each of your own devices. There is no Polycarp cloud: the devices meet at a relay you own, and the relay holds only files it can't read.

What syncs today:

- The workspace and bar settings in `surfaces.json`.
- `config.toml`: keys, hotkeys, appearance and the rest of it. A change keeps your comments and spacing.
- Your themes in `themes/` and `style.css`.
- The Settings window's preferences: the modifier, Overview and Cmd-Tab choices, the launcher and quick terminal keys, which agent answers questions, the daily update check and the apps hidden by parking. A synced preference takes effect the next time Polycarp starts. Machine-only preferences, such as the login item, update state and privacy choices like letting agents see your tabs or remote control, stay on each device; both lists are in `cli/src/sync/prefs.rs`. On Windows and Linux they are kept in the sync folder and passed back unchanged. Preferences travel in their own bundle, `prefs.age.json`, so a device on an older Polycarp never deletes them.

Not yet: a run every few minutes, and the browser (cookies, bookmarks, extensions and its settings). They come in later steps.

## Set it up

On the first device:

```sh
polycarp sync init --name mac
polycarp sync now
```

On each device after it:

```sh
polycarp sync init --name laptop
```

It prints a pairing code and this device's fingerprint. On a device that is already in, approve it with both:

```sh
polycarp sync approve <code> --fingerprint <the new device's fingerprint>
```

The approving device checks the fingerprint, adds the new device to the device list, signs the list and prints one line to run on the new device:

```sh
polycarp sync now --approver <the approving device's fingerprint>
```

The new device takes its first device list only when that fingerprint signed it. After that, `polycarp sync now` on any device sends its changes and takes the others'.

```sh
polycarp sync devices          # the devices that take part
polycarp sync remove laptop    # drop one
```

## The relay

By default the relay is Parish1 over SSH, in `~/.local/share/polycarp-sync/`. Before the first device's `init`, make that folder and its marker file on the relay once:

```sh
ssh parish1 'mkdir -p ~/.local/share/polycarp-sync && touch ~/.local/share/polycarp-sync/polycarp-sync'
```

A relay folder without the marker, such as an unmounted share or a folder name with a typo, counts as a relay that can't be reached, never as an empty one, so no device starts over on its own.

Choose another relay at `init`:

- `--relay ssh:HOST` or `--relay ssh:HOST:DIR` for any host you can reach with `ssh HOST` and no password prompt. DIR is relative to the home folder there.
- `--relay dir:/ABSOLUTE/PATH` for a folder, such as a share on a second device. It needs the same marker: `mkdir -p DIR && touch DIR/polycarp-sync`.

Polycarp runs the system's own `ssh` with `BatchMode`, so it never asks for a password, and a stalled link gives up after about 30 seconds. The relay needs nothing installed: a home folder and `sh` are enough. A file is replaced only once all of it has arrived, so a sync cut off partway leaves the last good copy.

The relay sees file names, sizes and times. It never sees a setting.

## What keeps it private

- Each device makes its own key at `init` and keeps it in the Keychain on a Mac, in Credential Manager on Windows and in the Secret Service (`secret-tool`) on Linux. Where none of those is there, the key is a file only you can read, and `init` says so. A key never leaves the device that made it.
- Settings are encrypted with [age](https://age-encryption.org) to every device on the list, and each bundle is signed by the device that wrote it. A bundle changed on the relay, or signed by a device not on the list, is refused, nothing of it is applied, and the error names it.
- The device list is signed too, and its version only goes up, so an older list can't be put back.
- Some settings belong to one machine and never leave it: display ids, window frames, paths, caches, screens and wallpapers. They are listed in one place in the code (`cli/src/sync/settings.rs`), with a test.

## How two edits meet

Each setting is merged on its own. Two devices that change different settings both keep both changes. When both change the same setting, the newer change wins; a tie goes to the device id, so every device picks the same one. A deleted setting is remembered for 90 days so it stays deleted. A setting this device doesn't use, such as a Mac-only one on Windows, is kept and passed back as it came.

A device's first sync joins what the others have: where the relay already has a setting, its value stands, and the new device adds only the settings the relay never had. A fresh install's defaults never replace the settings you made on your other devices.

When the relay can't be reached, nothing here changes, and the next `polycarp sync now` catches up.

## Removing a device

`polycarp sync remove NAME` takes it off the list and seals the settings again without it, so it can't open anything written after. It can still read what it already had. Also take away its SSH access to the relay (its line in `~/.ssh/authorized_keys` there), because the relay can't tell devices apart.

## Limits

- A removed device that still has relay access can delete or replace files there. It can't forge them, so the other devices refuse what it writes, but sync stops until the files are put back. Taking away its SSH access closes this.
- Two devices that approve or remove at the same moment can each write a list of the same version. The one written last stands, and the other device refuses it as not newer than its own. Approve or remove once more on the device whose list stands; the newer list it writes brings both back together.
- A Mac whose preferences read as empty, as after a reset, never deletes the synced ones: the last synced values are written back to it.

## Passwords

Polycarp never syncs passwords or history. Keep passwords in Proton Pass, which syncs them itself, end to end encrypted.

## Phones

Phones come later. On iPhone and iPad every browser has to use Apple's WebKit, so the browser half of sync can't be the same there as on a computer.
