# Polycarp plan

BaneySpaces, Tabkyra and Silas become one product on Mac, Windows, Linux, iPhone, iPad and Android. Old apps keep
working until step 5. A box is checked only when its check has passed.

## 1. Bring the code together
- [x] Full history of all three in `spaces/`, `voice/`, `browser/`
- [x] Brand files in `brand/`
- [x] Every suite in `./check.sh` passes on a Mac and in CI

## 2. One name, one command
- [x] `polycarp spaces`, `polycarp browser`, `polycarp voice`. Check: `polycarp spaces ls` and `polycarp browser --version` match the old commands on a real Mac, and CI passes on all three systems
- [ ] `polycarp voice` gains commands once baney75/silas#6 lands. Until then it only opens the app
- [ ] Polycarp MCP server, keeping `tabkyra` and `baneyspaces` as aliases. Check: an agent reaches the same tools under both names

## 3. One core, a native app on each device
- [ ] Shared Rust core for workspaces, voice and sync, growing from `spaces/crates/baneyspaces-core` and `voice/src-tauri`. Check: `spaces/spec/conformance` passes on every platform
- [ ] Mac: the Swift app hosts voice, with one settings window. Check: `spaces/AGENTS.md` probes and live gestures, and `voice/AGENTS.md` rules (never paste, never auto-unload)
- [ ] Windows and Linux: voice, workspaces and browser agents in one app. Check: run on a Windows VM and on Omarchy
- [ ] iPhone, iPad, Android: voice in its own app and keyboard, plus control of your computer's workspaces and browser. Check: Simulator, emulator and a real device. To verify: iOS limits microphone use inside keyboards
- [ ] Dictionary and settings sync directly between your own devices, with no Polycarp cloud. Check: an edit on one device appears on another with no third-party server in the path
- [ ] Each app follows its platform's conventions. Check: screenshots from the real target, plus keyboard, touch, focus, reduced motion and text size

## Spaces: replace the top bar
Asked for by Donovan, 2026-11-04.
- [ ] Mac: a Polycarp bar replaces the system menu bar, with the system bar auto-hidden, so app menus, status items, clock and Control Center stay reachable. Check: live on a real Mac across displays, full screen and every workspace; nothing from today's bar is lost
- [ ] Windows: a bar that reserves space across the top of the screen. Check: on a Windows VM, maximized windows stop below it
- [ ] Omarchy: modify the existing Waybar instead of replacing it, easy to change and to undo. Check: live on Omarchy; the user's own Waybar changes survive, and uninstall restores the original
- [ ] Linux outside Omarchy: decide after Omarchy works
- [ ] Phones: not possible. iOS and Android don't let an app replace the status bar

## Quality bar
Asked for by Donovan, 2026-11-04: quality software, a quality site and docs, all hyper themable and customizable.
- [ ] One theme file drives every product and the site. Check: `polycarp theme set still-water` changes Spaces, Voice, Browser and a local site build, read back from each
- [ ] Agents can customize everything for their user. Check: from a schema read alone, an agent applies a change over MCP, previews it and undoes it, with its name in the history
- [x] A person can get the apps' own look back from the command. Check: `polycarp theme off` removes the theme files, and `theme on` or `undo` brings them back
- [ ] Spaces falls back to its own look when the theme files are gone. Check: a Spaces test that removes `current/theme.json` and reads back its own look
- [ ] Voice falls back to its own look when the theme files are gone. Check: a Voice test that removes `current/theme.json` and reads back its own look
- [ ] Browser falls back to its own look when the theme files are gone. Check: a Browser test that removes `current/theme.json` and reads back its own look
- [x] The default themes look good, not just pass contrast. Check: `theme preview` of each, both modes, judged on a contact sheet
- [ ] Every color, radius, font and duration in every surface comes from the theme. Check: a test fails on a hard-coded value in product UI, with a written allowlist
- [ ] Browser reads the theme. Check: `polycarp theme set still-water` changes the installed panel within 5 seconds, read back in a real browser
- [ ] Any value can be overridden per product. Check: a `[surface.*]` override changes only that product
- [x] Unreadable themes are refused. Check: contrast tests on every built-in and surface
- [ ] Keys, motion and behavior are configurable from one file, by people and by agents, with undo and a recovery key. Check: `spaces/spec/config.md` conformance across products
- [ ] Voice reads the theme. Check: `polycarp theme set still-water` changes the installed app within 2 seconds, read back on a real Mac
- [ ] Site passes on phone and desktop, in every built-in theme and both modes. Check: `design_check.js` plus screenshots at 390 and 1280
- [ ] Docs cover install, every command, every setting and theming, for each device. Check: every command in `--help` appears in the docs, tested
- [ ] Accessibility: keyboard, screen reader, reduced motion and text size on each surface. Check: per-surface checklist with evidence

## 4. Move the fleet
- [ ] BaneyFleet PR for the files that name these products, plus skills, agents and `CLAUDE.md`. Field notes keep old names as history. Check: agents reach Polycarp's tools on each machine

## 5. Switch over
- [ ] Polycarp installs and updates on each device. Settings, dictionary and skills move across
- [ ] Old apps get a final release that points to Polycarp
- [ ] Donovan grants Accessibility and Microphone once on his Mac, since macOS ties them to the app's identity

## 6. Archive
- [ ] Land or move open PRs (on 2026-11-04: BaneySpaces 10, Silas 2)
- [ ] Archive `baneyspaces`, `silas`, `tabkyra`. Check: no open PRs, no fleet references outside history, old install links still resolve

## Later, with an owner's decision
- Paid: domains, Apple Developer and Google Play accounts, Windows code signing
- An attorney's trademark search, including logos, before filing or a big launch
