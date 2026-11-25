# Polycarp Browser

Polycarp Browser is a Chromium browser with Polycarp's new tab page and reading tools built in. Your Mac makes it from
[Helium](https://github.com/imputnet/helium-macos)'s own release: nothing is downloaded from Polycarp but the app you
already have, and no browser is in this repository. It needs Polycarp.app and macOS. It needs no admin password.

## Commands

```sh
polycarp browser install            # make it and put it in
polycarp browser update             # put in a newer one, when there is one
polycarp browser status             # which one you have, and how far behind it is
polycarp browser open https://example.com
polycarp browser uninstall          # remove the app; your profile stays
```

| Command | What else it takes |
| --- | --- |
| `install` | `--dry-run` downloads, checks, builds and starts it, then throws it away. `--rollback` puts back the build before this one |
| `update` | `--when-quit`: if the browser is open, the new build goes in once you quit it. Without it, an open browser is a refusal |
| `status` | `--json` for scripts |
| `uninstall` | `--profile` names the folders your profile is in and removes nothing. `--profile --yes` removes them with the app |
| all | `--app-dir DIR`, the folder the app is in |

The app goes beside Polycarp.app when that folder can be written to, and otherwise in `~/Applications`. It stays where it
is after that. Your profile is in `~/Library/Application Support/Polycarp/Browser`.

## Updates

Polycarp's own daily update check also runs `polycarp browser update --when-quit`, and turning that check off in
Settings turns this off too. `polycarp browser status` and `polycarp doctor` say when a newer release is out and for how many
days. Browser releases fix security holes, so being behind matters.

A new build is made beside the old one and swapped in as one step, so a crash or a power cut leaves the old browser or the
new one, whole. The build before is kept for `install --rollback`. After you go back, updates leave out the build you went
back from until a newer one is out or you run `install`.

## What is checked

Each of these must say yes before anything of a release is changed or run. A check that can't run is a no, and what was
installed stays as it was.

1. The release is a full release of `imputnet/helium-macos`, at the address it must have, with a SHA-256 digest.
2. The download has that digest.
3. `codesign` finds the app's signature whole, with every piece inside it.
4. The signature is from Helium's own team (Team ID `S4Q33XPHB4`) and names Helium's identifier.
5. Gatekeeper says it is notarized.
6. The version inside is the version that was listed.

After the changes, the app is signed again on your Mac, with the same local identity Polycarp itself uses, and started
without a window on an empty profile that is then deleted. It is swapped in only if its new tab is Polycarp's. Without that identity it
is signed ad hoc and the command says so: macOS then asks for permissions and saved passwords again after each update.

## What is different from Helium

- Its name, identifier (`com.baney.polycarp.browser`), icon and data folder. It can be open beside Helium and shares no
  profile with it.
- Polycarp's extension is inside the app and loads at every start. It needs no developer mode and can't be lost in an update.
- Helium's own updater does nothing: it has no key, no address and no schedule left.
- A new profile starts at Polycarp's new tab, without the welcome tour. Helium's online services stay off until you choose
  them at `helium://settings/privacy/services`. Vertical tabs and other looks are yours to choose.

Some of Helium stays visible, because it is compiled in or is someone's credit:

- the file names of the program, its helpers and its framework inside the app, and some of their text in Activity Monitor
- a few logos drawn by the pages of Settings and About
- names of Helium's online services, and "The Helium Authors" in the copyright notices

## Things to know

- **Passkeys in iCloud Keychain don't work.** Apple grants that to Helium's own team, and an app signed on your Mac can't
  claim it. Passkeys in Proton Pass's extension work, and so do USB security keys.
- **Saved passwords.** The browser encrypts cookies and passwords with a key in your login keychain, the item
  `Helium Storage Key`, whose name is compiled in. If you also use Helium it is the same item. macOS asks once whether
  Polycarp Browser may use it. The browser is removed without removing that item.
- **An imported profile** may show "The new tab page has changed" once. That is Chromium, asking about Polycarp's.
- **Removing Polycarp** leaves the browser's app and profile. Run `polycarp browser uninstall` first if you want them gone.

Helium is GPL-3.0, by the Helium Authors, and builds on ungoogled-chromium and Chromium. The parts Polycarp adds are in
[`browser/`](../browser), GPL-3.0-or-later.
