# Polycarp plan

Polycarp is Spaces and themes for macOS and Windows, with its own browser extension for reading and the new tab (`spaces/extension`, Donovan, 2026-11-21). The agent browser extension (the side panel), its CLI helper, MCP server and computer-use tools moved to Tychicus: https://github.com/baney75/tychicus. The voice app moved to Silas: https://github.com/baney75/silas. The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

The rest of this plan is Spaces and themes, on Mac and Windows first. Old apps keep working, and their repos stay up. A box is checked only when its check has passed.

## 1. Bring the code together
- [x] Full history of all three in `spaces/`, `voice/`, `browser/` (the browser and voice trees moved out on 2026-11-17)
- [x] Brand files in `brand/`
- [x] Every suite in `./check.sh` passes on a Mac and in CI

## 2. One name, one command
- [x] `polycarp spaces`, `polycarp browser` (now a pointer to Tychicus). Check: `polycarp spaces ls` and `polycarp browser --version` match the old commands on a real Mac, and CI passes on all three systems
- Moved to Silas (baney75/silas), 2026-11-18: `polycarp voice` only says Silas is its own app and where to get it
- [ ] Polycarp MCP server, keeping `tabkyra` and `baneyspaces` as aliases. Check: an agent reaches the same tools under both names

## 3. One core, a native app on each device
- [ ] Shared Rust core for workspaces and sync, growing from `spaces/crates/baneyspaces-core`. Check: `spaces/spec/conformance` passes on every platform
- Moved to Silas (baney75/silas), 2026-11-18: dictation on every device, the Mac's included, is the Silas app, not part of Polycarp
- [ ] Windows: workspaces in one app. Check: run on a Windows VM
- [ ] iPhone, iPad, Android: control of your computer's workspaces. Check: Simulator, emulator and a real device
- [ ] Dictionary and settings sync directly between your own devices, with no Polycarp cloud. Check: an edit on one device appears on another with no third-party server in the path
- [ ] Each app follows its platform's conventions. Check: screenshots from the real target, plus keyboard, touch, focus, reduced motion and text size

## Spaces: replace the top bar
Asked for by Donovan, 2026-11-04.
- [ ] Mac: a Polycarp bar replaces the system menu bar, with the system bar auto-hidden, so app menus, status items, clock and Control Center stay reachable. Check: live on a real Mac across displays, full screen and every workspace; nothing from today's bar is lost
- [ ] Windows: a bar that reserves space across the top of the screen. Check: on a Windows VM, maximized windows stop below it

Phones get no bar: iOS and Android don't let an app replace the status bar.

## Quality bar
Asked for by Donovan, 2026-11-04: quality software, a quality site and docs, all hyper themable and customizable.
- [ ] One theme file drives every product and the site. Check: `polycarp theme set still-water` changes Spaces, Voice, Browser and a local site build, read back from each
- [ ] Agents can customize everything for their user. Check: from a schema read alone, an agent applies a change over MCP, previews it and undoes it, with its name in the history
- [x] A person can get the apps' own look back from the command. Check: `polycarp theme off` removes the theme files, and `theme on` or `undo` brings them back
- [ ] Spaces falls back to its own look when the theme files are gone. Check: a Spaces test that removes `current/theme.json` and reads back its own look
- Moved to Silas (baney75/silas): Voice falls back to its own look when the theme files are gone. Check: a Voice test that removes `current/theme.json` and reads back its own look
- Moved to Tychicus (baney75/tychicus): Browser falls back to its own look when the theme files are gone. Check: a Browser test that removes `current/theme.json` and reads back its own look
- [x] The default themes look good, not just pass contrast. Check: `theme preview` of each, both modes, judged on a contact sheet
- [ ] Every color, radius, font and duration in every surface comes from the theme. Check: a test fails on a hard-coded value in product UI, with a written allowlist
- Moved to Tychicus (baney75/tychicus): Browser reads the theme. Check: `polycarp theme set still-water` changes the installed panel within 5 seconds, read back in a real browser
- [ ] Spaces reads the theme. Check: `polycarp theme set still-water` changes the installed app within 2 seconds on every surface, read back on a real Mac with the probes in `spaces/AGENTS.md`
- [ ] Any value can be overridden per product. Check: a `[surface.*]` override changes only that product
- [x] Unreadable themes are refused. Check: contrast tests on every built-in and surface
- [ ] Keys, motion and behavior are configurable from one file, by people and by agents, with undo and a recovery key. Check: `spaces/spec/config.md` conformance across products
- Moved to Silas (baney75/silas): Voice reads the theme. Check: `polycarp theme set still-water` changes the installed app within 2 seconds, read back on a real Mac
- [ ] Site passes on phone and desktop, in every built-in theme and both modes. Check: `design_check.js` plus screenshots at 390 and 1280
- [ ] Docs cover install, every command, every setting and theming, for each device. Check: every command in `--help` appears in the docs, tested
- [ ] Accessibility: keyboard, screen reader, reduced motion and text size on each surface. Check: per-surface checklist with evidence

## 4. Move the fleet
- [ ] BaneyFleet PR for the files that name these products, plus skills, agents and `CLAUDE.md`. Field notes keep old names as history. Check: agents reach Polycarp's tools on each machine

## 5. Switch over
- [ ] Polycarp installs and updates on each device. Settings, dictionary and skills move across. Check: on each device, `polycarp update` ends with `polycarp version` showing every part at one commit, and the old settings, dictionary and skills read back in Polycarp
- [ ] Old apps get a final release that points to Polycarp. Check: each old repo's latest release names Polycarp and links to it
- [ ] Donovan grants Accessibility once on his Mac, since macOS ties it to the app's identity. Check: `polycarp-spaces doctor` shows it granted, and an update keeps it

## 6. The old apps
Decided by Donovan, 2026-11-05: the `baneyspaces`, `silas` and `tabkyra` repos stay up, so people can keep using the independent apps. They are not archived.
- [ ] Land or move open PRs that belong in Polycarp. Check: `gh pr list` in each old repo shows none that belong here
- [ ] On Donovan's Mac: uninstall each old app once its Polycarp version works. Workspaces first (the installer moves BaneySpaces to the Trash). The browser is Tychicus now, and Silas is its own app. Check: workspaces work through Polycarp before BaneySpaces goes

## One app, everywhere
Decided by Donovan, 2026-11-05: ALL the apps together as ONE ultrafast app on every device. One Rust core in `core/`; a native Swift interface on Mac, iPhone and iPad; a shared Tauri interface on Windows and Android. Phones get voice plus control of your computer, since they can't arrange other apps' windows.
- Moved to Silas (baney75/silas), 2026-11-18: the voice engine and its C interface. `core/` left this repo with them
- Moved to Tychicus (baney75/tychicus): the browser agents, the extension and its helper
- [x] Mac: workspaces inside `Polycarp.app`, with one Settings window, one welcome window and one install. Check: tests and renders
- [ ] Windows: one Tauri app with workspaces. Check: a Windows VM
- [ ] iPhone, iPad, Android: one app with control of your computer. Check: Simulator, emulator and a real device
- [ ] Speed: launch, workspace switch and agent tools each have a target in `spaces/spec/speed.json`, and a regression fails. Check: the ratchets, including the two still unmeasured

## Install and permissions
Asked for by Donovan, 2026-11-05: installation and permissions need to be excellent.
- [x] One command installs the Mac app and the `polycarp` command. Check: `install.sh` run end to end against a temporary home, with an old app planted
- [x] One first-run window explains each permission in plain words, with live status. Check: `WelcomeTests`, and renders of the real view in light and dark
- [ ] First run on a real Mac: each switch updates the window, and Polycarp starts without a restart. Check: Donovan's first install
- [ ] A ready-made download that needs no developer tools, from a Polycarp release. Check: installs on a Mac with no command line tools

## Omarchy
Retired with the Linux desktop, 2026-11-17. The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

## Agents' computer use
Moved to Tychicus (baney75/tychicus, issue #27), 2026-11-18. Polycarp keeps the agent workspace and its two-call API (`spaces/docs/agent-workspace-api.md`).

## Voice
Moved to Silas (baney75/silas), 2026-11-18. Silas is its own app. Polycarp has no dictation, no voice core and no
microphone permission; what an earlier build stored under `~/Library/Application Support/Polycarp/voice` is left in place.

## Later, with an owner's decision
- Paid: domains, Apple Developer and Google Play accounts, Windows code signing
- An attorney's trademark search, including logos, before filing or a big launch
- The free install route (Download, disk image, Open Anyway) shows Apple's own warning the first time Polycarp opens, because the app isn't notarized. An owner decision on Apple Developer enrollment would remove it.
- [ ] A BaneySpaces login item starts nothing once BaneySpaces is in the Trash. Check: live on a real Mac, after a person installs from the download and BaneySpaces goes to the Trash, with BaneySpaces set to start at login: restart the Mac and check nothing starts it, or that Polycarp quits it if it does (`LegacyWatcher`). Polycarp doesn't launch the old app to clear its login item.
- Moved to Silas (baney75/silas), 2026-11-18: its name, pen-nib mark and listening dot left Polycarp's menu bar and Settings with it.
