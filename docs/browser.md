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
polycarp browser import             # list the browsers on this Mac and their profiles
polycarp browser uninstall          # remove the app; your profile stays
```

| Command | What else it takes |
| --- | --- |
| `install` | `--dry-run` downloads, checks, builds and starts it, then throws it away. `--rollback` puts back the build before this one |
| `update` | `--when-quit`: if the browser is open, the new build goes in once you quit it. Without it, an open browser is a refusal |
| `status` | `--json` for scripts |
| `import` | `helium [--profile NAME] --yes` copies a Helium profile. `chrome`, `brave`, `edge`, `vivaldi`, `arc` or `chromium` copies bookmarks and history |
| `uninstall` | `--profile` names the folders your profile is in and removes nothing. `--profile --yes` removes them with the app |
| all | `--app-dir DIR`, the folder the app is in |

The app goes beside Polycarp.app when that folder can be written to, and otherwise in `~/Applications`. It stays where it
is after that. Your profile is in `~/Library/Application Support/Polycarp/Browser`.

## While it works

`install` and `update` show each step as it runs: Download, Verify, Build, Sign, Check and Swap in, each as "step N of 6"
with the time it took (a dry run stops after Check, step 5). In a terminal the download has a bar with the percent, bytes over the total and the speed. Piped
or in a log, each step is a plain line. Ctrl-C in any step stops it and leaves the installed browser as it was, whole; a
second Ctrl-C ends the command at once.

## Updates

Polycarp's own daily update check also runs `polycarp browser update --when-quit`, and turning that check off in
Settings turns this off too. `polycarp browser status` and `polycarp doctor` say when a newer release is out and for how many
days. Browser releases fix security holes, so being behind matters.

A new build is made beside the old one and swapped in as one step, so a crash or a power cut leaves the old browser or the
new one, whole. The build before is kept for `install --rollback`. After you go back, updates leave out the build you went
back from until a newer one is out or you run `install`.

## Importing

`polycarp browser import` lists the Chromium browsers on this Mac and their profiles by name, and reads nothing else of them.
The browser you import from is only ever read, and only while it is closed.

- **Helium.** `polycarp browser import helium --yes` copies the whole profile, with its sign-ins and extensions. The copy
  takes the place of an empty first profile; after that each import is a profile of its own. Caches are left out.
  When Polycarp Browser next opens, macOS asks whether it may use `Helium Storage Key`. Say no and the copied
  passwords and sign-ins can't be read; the rest of the profile works.
- **Chrome, Brave, Edge, Vivaldi, Arc, Chromium.** `polycarp browser import chrome --yes` makes a new profile with that
  profile's bookmarks and web history. The command names your Web Store extensions with their links, for you to add
  again. Passwords stay where they are. Polycarp Browser must be installed first.
- **Firefox and Safari.** Open `chrome://settings/importData` in Polycarp Browser. Chromium's own importer reads them.

Without an import the browser starts with an empty profile.

### Sign-ins from the other Chromium browsers

The import from Chrome, Brave, Edge, Vivaldi, Arc or Chromium also brings that profile's sign-ins, its cookies. macOS asks
for two keys in your keychain, that browser's and `Helium Storage Key`. Each cookie is opened with one and sealed with the
other in memory; say no to either and the rest still comes. No cookie value is shown or written anywhere but the new
profile. A password manager's extension brings its own passwords. Open Polycarp Browser once before, so that it has a key.

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

## On Windows

`polycarp browser install --dry-run` downloads the newest full release of
[helium-windows](https://github.com/imputnet/helium-windows) for your processor (x64 or arm64) into Polycarp's cache, checks
that the zip has the SHA-256 GitHub lists, unpacks it into a private folder and checks that every `.exe` and `.dll` in it
carries a valid Authenticode signature from imput LLC, Helium's maker. Then it builds Polycarp Browser from that copy: it
removes Helium's updater, turns Helium's update checks off for the first profile (with the updater gone, no update can be put in
place for any profile), puts Polycarp's name in the browser's text and adds
Polycarp's launcher and extension. Then it starts that build once with no window and a throwaway profile in the same
folder, with no network and without Local Studio, and the start must show Polycarp's own new tab within 3 minutes; any of
its processes still running are stopped. Then it deletes it all. Nothing is installed. The build needs Polycarp's parts: run `browser/scripts/build-parts-windows.sh DEST` from a checkout and set
`POLYCARP_BROWSER_RESOURCES` to `DEST`.

`polycarp browser install` does all of that, then installs the build. It adds Local Studio's part (left out of the start), and
refuses, changing nothing, while Polycarp Browser is open. The new build goes in beside the old one and is swapped in, so a
failed install leaves the old one as it was. The browser goes in `%LOCALAPPDATA%\Programs\Polycarp Browser`, with a Start Menu
shortcut, `Polycarp Browser`, and your profile is `%LOCALAPPDATA%\Polycarp\Browser`, which install never touches. No admin
rights are needed. Each install builds the newest release again, even when it is already installed; updates on Windows come
later. `polycarp browser status` (or `status --json`) says which Helium release is installed. `polycarp browser uninstall`
removes the browser and its shortcut and keeps your profile; `uninstall --profile --yes` removes the profile too, and without
`--yes` it only lists what would go. Every other `polycarp browser` command on Windows says what works there so far.

## On Linux

`polycarp browser install --dry-run` downloads the newest full release of
[helium-linux](https://github.com/imputnet/helium-linux) for your processor (x86_64 or arm64) into Polycarp's cache: the
`.tar.xz` and its `.asc` signature. It checks that each has the SHA-256 GitHub lists, then has `gpg`, with a keyring of its
own that holds only Helium's signing key, check the signature: it must be good and made by the key
`BE67 7C19 89D3 5EAB 2C5F 26C9 3516 01AD 01D6 378E`. Only then does it unpack the tarball into a private folder and check that it
is laid out as Helium's. Then it builds Polycarp Browser from that copy: it turns Helium's update checks off for the first profile
(the Linux release has no updater program to remove), puts Polycarp's name in the browser's text and adds Polycarp's launcher,
`polycarp-browser`, and extension. Then it starts the build once headless, without Local Studio's part, with a throwaway profile
and `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` and `TMPDIR` all inside the work
folder. It
takes `POLYCARP_GITHUB_TOKEN`, `DISPLAY`, `WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` out of its environment, so it reaches no
session, passes `--password-store=basic`, so it never touches a desktop keyring, and opens no remote debugging. It runs under
Chromium's own sandbox, which needs unprivileged user namespaces (Ubuntu 24.04's AppArmor restricts them; Polycarp never turns the
sandbox off). On Ubuntu 23.10 and later AppArmor does this by default
(`kernel.apparmor_restrict_unprivileged_userns=1`), so the dry run refuses with check `sandbox` before it downloads anything, and
says so when the browser reports no usable sandbox; an AppArmor profile for the browser or
`sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` lets it start. The dumped page must be Polycarp's new tab within 180 s, or it refuses with check `start`. Whatever still runs from
the build is then stopped, and it deletes it all, the keyring too. Nothing is installed. The build needs Polycarp's parts: run `browser/scripts/build-parts-linux.sh DEST` from a checkout and set
`POLYCARP_BROWSER_RESOURCES` to `DEST`; without them it stops before downloading. Every other `polycarp browser` command on
Linux says that only `install --dry-run` works there so far. Installing the browser on Linux comes later.

## What is different from Helium

- Its name, identifier (`com.baney.polycarp.browser`), icon and data folder. It can be open beside Helium and shares no
  profile with it.
- Its icon is Polycarp's olive branch. While a Polycarp theme is in force it is drawn in the theme's colors, the same as
  Polycarp's own: `install` and `update` build it in from `browser-theme/icon.icns` in Polycarp's folder, and sign it with
  the rest. A new, changed or removed theme icon makes the next `update` build again. The small 32 px picture inside the
  browser's own pages stays the shipped one.
- Polycarp's extension is inside the app and loads at every start. It needs no developer mode and can't be lost in an update.
- Local Studio's extension is inside it too, when Polycarp's build carries it, built from a pinned Local Studio commit, and
  loads after Polycarp's. It talks to the Local Studio helper you installed for Helium; install Local Studio first, then
  `polycarp browser install`. `polycarp browser status` shows both extensions' versions and the Local Studio commit.
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
