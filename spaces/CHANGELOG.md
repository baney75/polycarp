## Unreleased

- **Row click: a press that selected an item under a hidden item is never undone by a write.** An outline row under a hidden parent row, or a cell a table selects by, now reads back selected from its own state, so the click reports the press instead of writing the selection again. A container ref that is no good now still falls back to the plain press, now tested by value, and a read's view is always given as a view, never parsed from a name. A shown row under a selected hidden row no longer reads selected from it, and the view a find reads in is tested by value. Pinned by `ClickFallbackTests`. Untested live. Linux and Windows: the press only, unchanged.
- **Menu: the watch sees every window a command raises, and more commands are refused.** The watch kept only its first sighting, so a Save panel after a helper's window was neither cancelled nor named; it now looks for its whole second, closes each tied window once (untied if any look found Donovan's input), and cancels the panel. Input from Donovan in the moment before the press now unties a helper too. An Open or Save panel that was already up before the press is not blamed on the command; it is cancelled before the press, and the answer says so (`cancelled_earlier_panel`). A panel that is a window of its own is cancelled as the panel, not also reported as a window Polycarp couldn't close, and a window that closed on its own before the undo is reported as closed, not as still open. A helper that is an XPC service (Writing Tools) is matched by the bundle around its executable, since LaunchServices doesn't list it. Browse All Versions, Move To and Rename are refused by identifier, and Use Selection for Find (cmd+E) is refused because it puts the selection on the find text every app shares (a search typed into a find bar still writes it). A path that stops at a submenu after Select All (Edit > Find) is judged by the submenu's own items, and refused when they can't be read; only Edit-menu submenus are read that way, so a listing of another submenu doesn't fail on one slow item. Pinned by `MenuPathTests`. Untested live. Linux and Windows: no `menu` tool, unchanged.
- **Row click: a refusal keeps its code, a hidden row keeps its selection, and a find's rows read back right.** A write refused by any check, including the one on the container just before the write, is known by its code and decides the next call. A click whose container's ref no longer resolves is the plain press. A row the read hid (no ref, name or value) passes its selected state to the cells it moved up, so a press that selected it is never followed by the write. A row with no text under it takes its label from a named group or image. Reads are keyed by a typed view built from the request; a find reads and replays compact. The click's answer is built in core and tested by value. Pinned by `ClickFallbackTests`. Untested live. Linux and Windows: the press only, unchanged.
- **An agent clipboard that never touches yours.** `get` with `copy: true` holds the text it read for this agent session, and `type` with `paste: true` types it into another element, through accessibility as `type` always does. The text lives in Polycarp's memory only, one entry per session, at most 100,000 characters and 64 sessions, and goes when the session ends or after an hour unused. A call with no session of its own (none, or the `default` every caller without a terminal shares) gets no clipboard, so two agents never share one. Any other session id is trusted as given: a CLI caller that sets `BANEYSPACES_SESSION` to another agent's id reads what that agent copied. Polycarp never reads or writes the Mac's pasteboard: `press` refuses cut, copy and paste chords (cmd+c, cmd+x, cmd+v with any other modifiers) by key code and by what the key types in the current layouts, with and without command (read on the main thread, and only for a chord with command held), so cmd+i on Dvorak is refused too; `click` and `select` refuse Cut, Copy and Paste items by their AppKit action in any language, or by English title when an item has none (an item titled Copy that AppKit wires to another action is the app's own); a click is checked against the snapshot's own record of its refs, however many reads came after, and a `select` also by the item the engine finds once the popup or menu is open, before it is pressed (`engine/patches/0003`), so a closed popup's "Kopieren" is refused; and the engine's advice to use its clipboard and the paste shortcut is replaced. A button an app itself titles Copy can still write it. Pinned by `SessionClipboardTests`. Untested live. Linux and Windows: no agent clipboard; `copy` and `paste` are unknown arguments there.
- **Menu: commands that reach past the app are refused, and what one raises outside the agent workspace is caught.** `menu` now refuses the Help menu and the items macOS adds or that leave the app (Emoji & Symbols, Start and Stop Dictation, Speech, AutoFill, Writing Tools, Show Substitutions, Print, Page Setup, Share, Import from iPhone or iPad, screenshots), by identifier and key equivalent first, English title last. In the Edit menu, an item after Select All's group is used only when it has a command key equivalent, or is a submenu with one inside (Find, Spelling and Grammar), so what AppKit appends (AutoFill, Start Dictation, Writing Tools) is refused in any language. An item whose attributes can't be read (a busy app times out) is refused instead of passing as harmless. A watch runs from the press until 1 s after it: an Open or Save panel is cancelled, and a new window outside the agent workspace fails the call, naming the command. It is closed only when it is tied to the press (the app's own, a child process of the app, or a system helper such as the Character Viewer or Tips with no input from Donovan in that time) and Polycarp tracks it; otherwise the call says it is still open, or that it was left alone. A sheet or alert on the agent's window is not counted. A panel later than the watch stays open on the agent workspace. Untested live.
- **A row click names the row by its own text, and keeps working after an interactive snapshot.** The selection write took its label from the first named thing in the row, so a row holding a checkbox "Wi-Fi on" before its text "Wi-Fi" was written as "Wi-Fi on" and failed; a control and all it holds are now skipped. A cell with no row above it (a list whose items are cells) now gets the fallback instead of the plain press only. The readbacks read in the view of the agent's snapshot (interactive, compact, depth), so a plan from an `interactive: true` read finds its container again. A failed press is reported in `press_error`, and a write the acting check refused answers with that refusal and its next call. Pinned by `ClickFallbackTests`. Untested live. Linux and Windows: the press only, unchanged.
- **Window pictures: a failed capture is said, and a zoom outside the window is refused.** Over MCP, a `snapshot` with `screenshot: true` whose capture fails (no Screen Recording, a refused gate, the window gone) adds a `screenshot failed: ...` part after the rows. A `zoom` that starts outside the window answers `bad_arguments` naming the window size, on `shot` and `snapshot`, over MCP and the CLI, before anything is captured or written, so a refused call leaves no file. Non-finite zooms and any value above 100000 points are refused. When a zoom's crop can't be made, the label says the picture is the whole window. A fractional zoom origin keeps its decimals in the `click_at` map, and the snapshot example carries `screenshot: true`. The capture order (find, gate, zoom against the window size, capture) is `ShotImage.attach` and `ShotImage.beforeCapture`, tested by value in `ShotImageTests`. Untested live.
- **`click-at` double and triple clicks.** `count` 2 or 3 posts that many clicks with the click state counting up, through the same pointer route, in-use wait and proof as one click. `button: right` answers `not_supported` until a context menu can be proved and kept off Donovan's screen. Pinned by `ClickStyleTests`. Untested live. Linux and Windows still answer `not_supported` for `click-at`.
- **Window pictures a model can use.** Over MCP, `shot` and `snapshot` with `screenshot: true` return the picture fitted to a longest side of 1280 pixels (a 2x capture of a large window was over 3000), with a text line before it that says it is untrusted window content and how to turn an image pixel into a `click_at` point. `zoom: "x,y,width,height"` (window points) returns only that region, at up to full resolution. Pinned by `ShotImageTests`. Untested live. Linux and Windows: their `shot` is unchanged and they have no `screenshot` on `snapshot` yet.
- **Settings > Browser keeps checking when Tailscale is stuck, and a failed check keeps a button.** A Tailscale that doesn't answer within 15 seconds shows "Tailscale didn't answer, checking again" and reads status every 4 seconds until it answers, on a saved route and before one, instead of the helper-silent step after 30 seconds or "Setup stopped" whose Try again ran setup. It comes ahead of an older setup answer. A failed check whose Repair has nothing planned shows Check again, which runs `remote test` again, instead of only "Turn off and start over". The rules are `RemoteFlow.isMoreBasic`, `problemAction` and `checkAgainTests`, tested by value in `BrowserRemotePR136R2Tests`. Untested live.
- **The shared remote copy has the side panel's "Check again" operator step.** `RemoteSharedCopy.swift` gains `tailscale_operator_check`, the operator refusal with a Check again button for when nothing retries it, so the Mac app's table stays equal to `remote-copy.ts` (`browser/test/remote-copy.test.mjs`).
- **Remote access in Settings > Browser keeps its place when you look elsewhere.** Switching tab or closing Settings during the Funnel step no longer stops the automatic retry for good: coming back resumes it at once, with a fresh 10 minutes, and doesn't reopen Tailscale's page. A retry that times out or prints no JSON leaves the step as it is instead of saying the helper is silent. Turn on on a Cloudflare name step sets up the typed name, never Tailscale, and the step keeps its name field. The passcode shown once survives a tab switch, shows on the "helper didn't answer" step too, and is forgotten when the window closes. The name step's words come only from name problems. A `remote test` whose only failure is deleting its probe token shows that failure ("Test token removed") instead of passing. A setup answer that names `remote fix` shows Repair and takes no connect code. `RemoteSharedCopy.key` and `copyKey` are held to one fixture, `browser/test/fixtures/remote-copy-keys.json`. Pinned by `BrowserRemoteReviewR1Tests`. Untested live.
- **Turn on Claude, ChatGPT and Grok access in Settings > Browser without a terminal.** The steps now use the side panel's words from one shared table (`RemoteSharedCopy.swift`, held equal to `remote-copy.ts` by `browser/test/remote-copy.test.mjs`), with "Step N of 3" headers. "Get it for me" replaces the brew command: it asks for the address and lets the helper download Cloudflare's pinned cloudflared. Every problem code the helper sends has its own sentence and one button, with the helper's words under Details. Allowing Funnel needs no button: the window opens Tailscale's page once and runs setup again every 15 seconds for up to 10 minutes. The result lists the assistants' steps, the address, a one-time connect code with a countdown and New code, the passcode only when this run made it (labeled for re-approving), and the checks from the internet, with Repair when one failed and the helper has `remote fix`. The code and passcode stay in memory only and are forgotten when Settings closes. Pinned by `BrowserRemoteTests`. Untested live.
- **A new Tailscale name that is still being published shows On, not a failure.** Setup and `remote test` now mark a check that waiting fixes as pending (public DNS lagging, a tunnel still connecting). The window lands on the On screen with the address and connect code, says the address is still being published, marks the check Waiting instead of failed, offers no Repair for it, and runs `remote test` again every 30 seconds until it passes. The automatic Funnel retry no longer asks setup for a connect code, so a code is made only when you press Turn on, Check again or New code; after the retry, the code line says to press New code. Repair shows only when `remote fix` has something to do, on a step as well as on the result. After 10 minutes of Funnel retries the step says it stopped checking and its button is Check again.
- **Settings > Browser's remote steps say what went wrong, and Repair can be pressed again.** A "Get it for me" for cloudflared that stops before cloudflared is installed (a dropped download, a checksum that didn't match) shows the helper's words under Details instead of the same step again. A Repair that stops shows the helper's words under Details, or says to try again when it gave none, and a Repair that leaves a check needing `remote fix` can be pressed again instead of the button going away. A step's command (such as the Tailscale operator command) comes from the answer on screen, so a status read's step shows its own. The passcode and connect code are also removed from the stored setup answer, so closing Settings forgets every copy. Public DNS answering that a lookup failed (`dns_lookup`, often broken DNSSEC) has its own step with Check again, not "Setup stopped". The window's decisions moved into `RemoteSession` (BaneySpacesCore), tested by value instead of by reading source (`BrowserRemoteReviewR2Tests`).
- **Linux: agents manage their own workspace, with the Mac's verbs.** On Hyprland `agent workspaces` lists the nine and `special:agent` (shown, current, window counts, never titles of your windows); `agent open` records the window for the agent's session and takes `--new_window=false` (reuse it) and `--wait`, and answers `reused` and `focus`; `agent arrange full|halves|thirds|grid|frames` and `agent move --window W [--frame x,y,w,h]` give the agent's windows the Mac's frames while the workspace stays hidden; `agent close --window W` closes only a window this session's `open` made (address, pid and start time) through its close request. A dialog of an agent process is usable; any other process's is not. Your windows are never moved or laid out, not even one you parked on the agent workspace: what the Mac allows only through a lend or Full Access is `not_supported` on Linux, which has no lend sheet yet. Each target is checked again right before every dispatch, and a call stops at the first window you took back, saying which were and were not changed. An `open` that answers before its window comes (`pending: true`) still gets that window for its session. Every dispatch names its window and none shows a workspace or moves focus (`agentws::loud`, checked on every string the tests send). CLI only for now; the shared MCP catalog is unchanged. Untested on a live Hyprland; steps in `platforms/linux/README.md`. Windows: not supported yet.
- **One command shows whether every part matches, and one updates them together.** `polycarp version` lists the command, the app, `polycarp-spaces`, the browser helper, each browser's extension, the voice core and the agent skill with the commit each was built from, and says in one line whether they all match (`--check` exits 1 when they don't; `polycarp doctor` prints the same line). `polycarp update` brings them all to the newest commit: for an app from the download it asks the app's own updater, and for a source install it builds `origin/main` in a clean copy, never in your checkout, then hands the last steps (reload, restart, final check) to the command it just installed, so the first run can be a build in a checkout. A browser that is connected but slow is listed as "no answer in time" and never fails an update; on Linux the browser helper is installed into `~/.local/share/polycarp/browser/source`, not left in the cache; on Windows `polycarp update` still exits 2 with the build steps. For that, the app's Info.plist now records whether the build had uncommitted changes (`PolycarpCommitDirty`), `polycarp-spaces --version` prints the app's version and commit, `polycarp-spaces update --check|--now` reaches the app's updater from a terminal (exit 100 when a release is waiting; another machine can never ask), and the Linux `baneyspaces` carries its commit and prints it with `--version`. See "Updating" in the main README. Tests: `cli/src/update.rs`, `cli/src/version.rs`, `cli/tests/cli.rs`, `Tests/BaneySpacesCoreTests/UpdatesTests.swift`.
- **No more app icons popping out of the hidden macOS Dock.** An app asking for you (Word with a dialog waiting, once a minute) showed its icon alone above the bottom edge while the Workspace Dock was on. The macOS Dock no longer bounces while it is hidden (`no-bouncing`, saved and put back with its other settings, uninstaller included). Instead the Workspace Dock puts a still dot on the tile of the workspace where a modal window waits; clicking the tile goes there with that window in front, and `trace.log` says `dock attention set:` and `cleared:`. An agent's claim no longer takes a lent app's modal window.
- **Agents no longer ask you to leave an app idle.** An agent had told Donovan "Polycarp refused access because Word is in front or was used within the last 30 seconds. Please switch to this chat, leave Word idle for 30 seconds". Now reads (`windows`, `snapshot`, `find`, `get`, `shot`) never look at whether you are using the app, and `windows` lists such a window with `in_use: true`. An app counts as in use while it is in front and for 5 seconds after it leaves the front (was 30). An action on it waits by itself, off the main thread, rechecking Read Only and the scope every 250 ms, for up to `wait` seconds (a new argument on every action tool and CLI verb, 0 to 120, default 20; 0 answers at once), then answers `in_use` with "<App> is in front" or "<App> left the front N s ago; free in M s" and a suggestion that tells the agent to retry or work elsewhere, not to ask you. `click`, `type`, `set-value`, `select`, `toggle` and `scroll` on a window of that app on the agent workspace that is neither its focused nor its main window go ahead at once: they take the engine's Headless accessibility path, with no keyboard focus and no events. Asking you to lend an app you are using is no longer refused; the sheet is your decision. Pinned by `InUseTests`.
- **Linux: `agent shot` captures one agent window while it stays hidden.** On Hyprland the daemon runs `grim -T` with the window's `stableId`, so the compositor captures that window alone through `ext-image-copy-capture-v1`; nothing is shown, focused or moved, and only windows on `special:agent` that BaneySpaces started for an agent pass the scope guard, which runs again before every capture and before the file is written. A hidden window repaints only after it is captured, so the daemon captures until two pictures in a row agree. The result has the Mac's shape (`path`, `width`, `height`, `cursor`, `evidence.sha256`). Needs grim 1.5 or later. Pinned by `shot.rs` unit tests, `shot_refuses_every_window_outside_scope_before_anything_is_captured`, and the `shot` checks in `platforms/linux/tests/hands.sh`.
- **Agent access modes: Read Only, Default and Full Access.** Settings > Agents has a picker for what agent tools may use. Read Only lets agents list, read and capture but refuses every action, `agent open`, `agent run` and `agent move`. Default is the rule until now. Full Access opens every window on every workspace and any app to agents, still from behind: no activation, no global input, nothing while you're using the app, never an Open or Save panel. Widening asks in a sheet that takes only a real click; the socket can't change the mode. While it isn't Default the menu shows a row to switch back, and the menu bar shows "Full". Pinned by `AgentAccessTests`.
- **The three-finger trackpad swipe is gone.** It opened the overview on accidental three- or four-finger touches, so BaneySpaces no longer reads the trackpad at all (no private MultitouchSupport framework). The Mission Control key, ⌃↑ and hot corners still open the overview, and macOS's own swipe to Mission Control stays off while BaneySpaces holds it. Pinned by `MissionControlGuardTests.testNoTrackpadSwipeCodeIsLeft`.
- **The Workspace Dock has a "Background" tile for apps running with no window.** After the dashed "+" tile, a small tile with a count appears while any regular app is running with no window on any workspace: hidden, only minimized windows, or none at all (an app that opened itself in the background). Rest on it or click it for a list, one row per app with its icon, name and a short state (hidden, minimized, no window); click a row to bring that app to the workspace you're on (unhidden, its most recent minimized window restored here, or, for an app with no window, a new window opened here the way the launcher does). Not listed: Finder, menu bar apps, an app launched in the last 3 seconds, an app showing a dialog or a full-screen window, and any app with a window on some workspace, hidden (by you or BaneySpaces) or not; that workspace's tile shows it. The list follows apps launching, quitting, hiding and unhiding and the window model's changes, with no timer. `trace.log` says `dock background: tile appears|gone` and `dock background: <app> picked (<state>)`. The rule is `BackgroundApps` in the core, pinned by `BackgroundAppsTests`.
- **The name "Deck" is gone from the product and docs.** The engine behind the launcher's terminal and agent rows, the hooks and the command socket is now the session engine. The socket is `baneyspaces.sock` (was `deck.sock`; the app still listens on the old name, and `baneyspaces` tries both, so a running client keeps working), its state file is `session.json`, and the optional extra-apps file is `~/.config/baneyspaces/session.json` (was `deck.json`; the first launch copies it over, and the old file stays). `baneyspaces doctor` prints `app:` instead of `deck:`. Past release notes keep the old name.
- Soak gate: `scripts/soak-check.sh` before promoting a build to stable / GitHub Latest (does not unpublish 0.3.0).

# Changelog

## Unreleased

- **The workspace grid no longer pops up on its own.** The small 3×3 grid that flashed after every number-key switch, and after focusing an app on another workspace, is now off unless you turn it on with `defaults write com.baney.baneyspaces showSwitchHUD -bool true`. ⌘Tab's workspace panel still opens only when you hold ⌘Tab. Pinned by `SwitchHUDPolicyTests` and `SwitchHUDWiringTests`.
- **⌘Tab lists a workspace only when it has windows you can see on its card.** The list and each card's window count now come from the same windows, so no card other than the one you're on can read "empty". With windows on 1 and 2 only, the panel shows 1 and 2. The 1, 4, 3, 2, 5… order seen before was the most recently used order with the empty workspaces still listed; the order is unchanged, the empties are gone. Pinned by new `WorkspaceSwitcherOrderTests` cases.
- **Rotating `trace.log`.** When the active file would pass 200 KB it becomes `trace.log.1` (and `.2`), instead of being deleted. `os.Logger` (subsystem `com.baney.baneyspaces`) is unchanged. Guarded by `FileTraceTests`.
- **Dock tiles and ⌘Tab cards put the app you used last first.** Each workspace keeps when each of its apps last had the focus there, so the tile's icons, its "+N" list and the ⌘Tab workspace card all follow one order, most recent first, and reorder as you switch apps (an open dock reorders at once). Apps not used on that workspace since BaneySpaces started follow in their windows' order. An agent's app still moves into view ahead of the "+N". Pinned by `DockAppOrderTests` and `DockAppOrderWiringTests`.
- **⌘Tab workspaces mode shows only the workspaces you're using.** Empty workspaces are left out again, except the one you're on, which is always first and marked with its color and "Here". The rest follow most recently used first, then by number. The panel is one row tall for one row of tiles, wraps only when the display you're on is too narrow, and is centered inside that display's visible area (left of the main display too), never past its edges. Tab, ⇧Tab and now the arrow keys (→ ↓ forward, ← ↑ back) step through the cards in the order drawn. Pinned by `WorkspaceSwitcherOrderTests`, `SwitcherLayoutTests`, `SwitcherPanelFrameTests`, `SwitcherSelectionTests`, `SwitcherWiringTests` and `WindowBarGateTests`.

## Unreleased

- **Agent hands, phase 4: keys and a pointer for windows that are not in front.** `agent press` now sends keys (several,
  separated by spaces) to the one process, and `agent click-at` and `agent drag` post window-local mouse events to it,
  without activating, raising, switching a Space, moving the real pointer, or posting to the session. Only to a process
  BaneySpaces started (checked when the call executes) or a window Donovan lent; each is proved by reading the same window
  back, and an unproved one is `unverified` (retry never). SkyLight's per-process post is found by name at run time with
  the public call as the fallback. Prepared and unit-tested; `scripts/agent-keys-probe.swift` runs on `main` after merge
  when Donovan has been idle 10 minutes. Logic ported from cua-driver (MIT), see NOTICE.
- **Themes, 22 palettes and a dock switch.** Settings › Appearance has a theme (**BaneySpaces**, the
  look it has always had; **Omarchy**, square corners, 2 px borders, monospace and numbered blocks;
  **Minimal**) and a palette (**Auto** or one of Omarchy's 22), shared with the other platforms from
  `spec/themes.json` and `spec/palettes.json`. The dock, the "+N" list and strip, ⌘Tab, the launcher, the
  overview, the HUD, the menu bar number and Settings all draw from the theme and apply at once. The
  BaneySpaces theme renders pixel for pixel what it did (every product shot compares equal).
  `baneyspaces set|get appearance.theme|appearance.palette|dock.enabled` from a terminal. Agents may use them too (each change is logged with its caller in `trace.log`); workspace and window commands stay user-only. The dock
  switch (Settings › Dock, now also in the menu bar item's menu) takes the dock down completely: no
  panel, no edge watcher, no "+N" list and no bottom drag, while the top drag and everything else
  stay. Settings › Appearance loses the small dock strip; each theme's card is its preview.
- **BaneySpaces for Linux, part 1 (Omarchy, Hyprland).** `spec/` now holds the workspace rules, the
  key map, the JSON envelope, the MCP tools and 89 conformance cases every platform replays;
  `crates/baneyspaces-core` implements them in Rust; `platforms/linux` is a daemon that drives
  Hyprland's workspaces (one shared set of nine, each display shows one, instant) and an agent workspace (`special:agent`) that
  agents' windows open on without ever taking your screen, plus agent hands over AT-SPI through the
  pinned agent-desktop. Install files for Omarchy are included but applied nowhere yet. See
  [platforms/linux/README.md](platforms/linux/README.md).
- **BaneySpaces' overview replaces macOS's Mission Control.** The trackpad swipe up with three or four
  fingers (as your trackpad settings have it), a hot corner set to Mission Control, the Mission Control
  key and ⌃↑ all open the overview, and a swipe down closes it. macOS's own "Desktop" view is switched
  off in the Dock, and any hot corner that was Mission Control is remapped to nothing and answered by
  BaneySpaces. Settings › Keys › **Use BaneySpaces' overview instead of Mission Control** (on) turns it
  back off: every setting returns exactly as it was, as does uninstalling. The trackpad swipe uses
  macOS's private trackpad framework, loaded at run time and checked against the touches it gets; if
  it can't load or isn't recognised, Settings says so. Mission Control comes back when BaneySpaces quits;
  if it stops any other way (a crash, the app dragged to the Trash), a launch agent puts it back after
  a minute, 30 seconds after an update's quit, and Mission Control is switched off only once that agent
  is loaded and what was there is saved to disk (so a crash in between still leaves the way back); if
  either can't be done, Mission Control stays on and Settings says why. The launch agent being
  switched off later, or Mission Control turned back on by hand, makes BaneySpaces let go; an older
  build started later doesn't keep it off. A Magic Mouse's two-finger
  double tap opens nothing while this is on.
- **The "+N" list lets go, and the dock moves.** The window strip and the "+N" list are a panel of their
  own, so opening one no longer resizes or jumps the dock. The dock stays up only while the pointer is
  on its bar or on the list (each with a little room), not anywhere over the whole panel; the list
  closes 250 ms after the pointer leaves it, at once on Esc or a click elsewhere. The dock slides 8 pt
  and fades in and out, the list grows from its tile and fades, rows light in 80 ms, and a picked-up
  row or icon lifts and settles. All of it is instant with Reduce Motion on.
- **A drag out of the "+N" list ends cleanly if its app goes.** Closing the window or quitting the app
  mid-drag, or the list closing under the pointer, cancels the drag instead of leaving the dock in
  drag mode; a window that closed is never moved. Settings > Automation waits for BaneySpaces to
  start (and says whether it's Accessibility or AeroSpace), the menu badge counts only agents the
  menu can list, and the Automation app list reads when the tab opens or an app launches or quits.
- **Drag an app out of a tile's "+N" list.** Each app in the list that opens over a workspace tile
  drags like the tile's own icons: onto another workspace's tile, or the dashed "+", to move its
  windows there. A click still goes to the app, and the list stays open as the drag starts.
- **A shorter menu bar menu.** It keeps the workspaces, Show All Workspaces, Find or Install an App,
  Settings (⌘,) and Quit. What was under Options, Updates and About is in Settings: the switches are
  where they were, Keep Usable by Automation and Bring Every Window Back are under **Automation**,
  and the update channel, daily check, Check for Updates Now, and About are under **Updates**. Agents
  that finished while you were away list under **Dock**. When agents have finished, or an update
  is waiting, a row for it appears in the menu (and goes away when there's nothing to act on); the
  update controls are also in Settings > Updates.
- **Agent hands, phase 1.** `baneyspaces agent snapshot|find|get|click|type|set-value|press|scroll|select|toggle|shot|open|windows`
  read and act on apps on the agent workspace (or an app you lend with `baneyspaces agent lend`, which asks you in a sheet) without touching your screen, and print one
  JSON envelope each; `baneyspaces mcp` serves the same tools to Claude Code and Codex. Built on agent-desktop
  (Apache-2.0, pinned). Cua Spaces no longer starts on the Keep Usable by Automation list.
- **`agent open` starts a separate copy of an app, and its windows are on the agent workspace,** not yours. Only TextEdit and Preview (on a file from the handoff folder) and Calculator start; everything else answers `needs_sandbox`.

- **The Workspace Dock goes down once the pointer leaves it.** It used to stay up while the pointer
  rested above or beside it, over the app underneath, because it counted the empty room it keeps for
  its hover label. Now only the dock itself counts, plus the window strip while it's open.
- **Clearer dock logs.** `trace.log` notes when the dock comes up, when it goes down and why, and
  anything holding it up with the pointer off it. Each line also goes to the macOS log, so a Shotate
  debug recording includes it.

## 0.3.0 (2026-10-30)

- **Install without building, and a disk image.** A stable release now carries the finished,
  signed app. The one-line install downloads a few MB instead of building on your Mac, and needs no
  command line tools. Browser users get `BaneySpaces.dmg` with the drag-to-Applications window;
  the first open needs **System Settings › Privacy & Security › Open Anyway**, because
  BaneySpaces isn't notarized. The installer checks the app against BaneySpaces' release key
  and refuses anything else. Updating from 0.2.2 builds 0.3.0 on your Mac, so keep the command line
  tools until then. After that, a copy you built keeps building while the tools are installed, so
  macOS keeps its Accessibility permission; without them, an update installs the ready-made app
  instead, and macOS asks you to allow BaneySpaces again in **System Settings › Privacy & Security ›
  Accessibility**. Nightly builds still build from source.
- **Change the colors and looks in Settings › Appearance.** Pick an accent (nine colors, System
  to follow macOS, or any color you choose), a palette for the nine workspace colors (Rainbow,
  Accent, Calm or Mono) and a color of your own for any one workspace, a panel style (Glass,
  Tinted or Solid) with an opacity slider, and a Small, Medium or Large Workspace Dock. It applies
  to the dock, ⌘Tab, the launcher, the overview and the switch overlay as you change it, and a
  strip at the top of the tab previews it. A workspace color that's too bright for the white
  numbers is dimmed. The defaults are the look it has always had.
- **One search for everything: ⌃⌘K.** The launcher opens from any app and finds apps, files,
  workspaces, Ghostty splits and tabs, Helium and other Chromium tabs, Terminal and iTerm2
  sessions, and the Claude, ChatGPT, T3 Code and Grok Bot windows, each with its folder and
  whether an agent there is working, waiting or done. It reads every app's tabs as it opens.
  **New Claude Session** and **New Terminal** are launcher commands and open in the folder of the
  terminal you were in. If you used Ghostdeck, the launcher takes over its search, agent status
  and New Claude and New Terminal; its sidebar, window layouts (Stack, Split, Free) and back and
  forward keys don't carry over. Ghostdeck.app goes to the Trash on install.
- **Find files from the launcher.** Type a name and the best five matching files and folders come
  in under the apps, from your home folder, iCloud Drive and other cloud drives; Tab into the
  **Files** menu for more. Every word you type must start a word of the name, so `tax 2025` finds
  `2025 Tax Return.pdf`. Return opens it, ⌘Return shows it in Finder. Files you opened lately
  come first, and Library, hidden and build folders stay out of the way. macOS may ask once to
  let BaneySpaces see your Documents, Desktop, Downloads or iCloud Drive.
- **Agents tell you when they're done.** `baneyspaces hooks install` (or the button in
  **Settings › Dock**) adds Claude Code and Grok hooks. A small turning ring sits on the icon of
  the app an agent works in (Ghostty, T3 Code), the hover label names it ("Claude working: Fix the
  flaky upload test"), a finished agent gets an orange count and a notice in the corner, and
  **⌃⌘U** from any app goes to it. With several sessions in one T3 Code window, the window shows a
  question first, then any session still working, else the latest; a turn stopped without a hook
  stops counting as work after 15 minutes.
- **Each display shows a workspace of its own.** With a second monitor or Sidecar, ⌘3 changes
  only the display you're on: the one you last clicked, anywhere on it, or whose window you
  switched to. Press the number of the workspace the other display shows and you go there
  instead, as in AeroSpace. Drag a window onto the other display and it joins that display's
  workspace. A display you plug in starts on an empty workspace. With one display nothing changes.
- **Drag a window to the top of the screen.** After a quarter second at the top, BaneySpaces' 3×3
  overview opens instead of Mission Control, with the window's card under your pointer. Let go
  over a workspace and the window goes there, back in the spot you picked it up from. Let go at
  the top and macOS fills the screen with it, as before. Only Mission Control stays off for that
  drag, and its setting comes back when you turn this off in **Settings › Keys** or uninstall.
  Arrow keys and Return pick a workspace in the overview.
- **Drag a window down to the dock to move it to another workspace.** Pull a window by its title
  bar to the bottom edge, and the dock comes up for it, the tile under the pointer lights, and the
  label says where it's going. Let go on a tile, or the dashed one for an empty workspace, and the
  window moves there; you stay where you are. This needs the dock on the bottom edge.
- **Drag a file to the dock to drop it in a window on another workspace.** Hold over an app's icon
  and that app's window there comes forward; hold over a tile and you go to that workspace. Drop
  on an app's icon and the app opens the file or link, as in the macOS Dock.
- **The Workspace Dock comes and goes with the pointer.** It comes up when the pointer rests on
  its edge under it, stays while a menu near the pointer is open, and goes back down as soon as the
  pointer leaves, including after you close a right-click menu.
- **Reads other apps only when it needs to.** BaneySpaces reads Ghostty and your browser by
  AppleScript only when there's a reason: the terminal an agent runs in, while it works, and every app at most once a
  minute or when you search. An agent's events read only the app it runs in, and an app whose
  script keeps failing waits about a minute before the next try.
- **The Workspace Dock can sit on any side:** bottom, left, right or top, from setup, the menu
  bar menu, or a tile's right-click menu. The label and window strip open on its inner side, and
  a dock too long for the screen shrinks to fit. At the top it sits under the menu bar and waits
  half a second, so reaching for a menu doesn't bring it up.
- **Drag windows between workspaces in the Workspace Dock.** Drag an app's icon onto another
  tile and its windows on that workspace move there; drag a window out of the strip to move just
  that one. Dropping on the dashed tile sends it to the first empty workspace.
- **Shorter menus.** The menu bar menu lists only the workspaces in use, the one you're on and
  one empty one, and shortens a long app list. The switches moved under **Options**, and **Check
  for Updates** lives in **Updates** unless one is waiting. Right-click an app in the dock for
  Show and Quit (hold ⌥ for Force Quit); a tile offers Go to and Move Front Window Here; Position
  and Turn Off sit in one **Dock** submenu.
- **See every app on a full tile.** Rest on a tile's "+2" and the apps it stands for open in a
  list; click one to go straight to it. Rest on an app with more than one window and a strip of
  its windows opens, each labeled with its title.
- **An agent workspace.** `baneyspaces agent on 9` gives agents and Cua a workspace of their own.
  Its apps are parked instead of hidden so background clicks still land, nothing on it ever pulls
  you there, and a window an agent opens from behind joins it instead of yours. `agent run`
  starts a command there in a Terminal window of its own; `agent open` opens a file or app there.
- **`baneyspaces` is a command-line tool too** (`ls`, `focus`, `send`, `notify`, `event`, `agent`,
  `phone`, `remote`, `doctor`), and a Claude Code skill teaches agents to use it. Phones: Android
  over adb (`baneyspaces phone tap|type|swipe|ui|shot|shell`) and iPhones through devicectl and
  iPhone Mirroring. `baneyspaces remote on` (off by default) listens only on the tailnet address and
  lets another Mac on your tailnet give this one's agent workspace work, with a token; it can't
  focus, type into or move anything you see.
- **Closed windows and hidden tabs stay out of the way.** Ghostty and some other apps keep a window
  alive after you close it, and a tab behind another tab looks the same. Neither counts as a window
  on a workspace, so ⌘Tab, the dock and the launcher only send you to windows that can come forward.
- **Windows no longer slide to the corner.** Apps with the accessibility setting
  AXEnhancedUserInterface on animated every move, so an app split across workspaces had its other
  windows glide across the screen on every switch. The move is instant now, and those switches went
  from about 300 ms to under 100.
- Going to an empty workspace no longer bounces you back, and opening an app here that's open on
  another workspace opens it here.
- **Bangs, web search and agents in the launcher.** `!yt cats`, `!i sunsets`, `cats !yt`, and
  about 35 more built in; any other bang goes to DuckDuckGo. `?` asks your agent (Claude, ChatGPT,
  Perplexity, Grok, Copilot or Le Chat, picked in setup) in a new browser tab. Type `claude` or
  `codex` to start it in your terminal. Add your own bangs in setup or with `BaneySpaces --bangs add`.
- **Pick a window, not just an app.** In ⌘Tab, hold Tab (0.6 s) on an app with more than one
  window to open its window bar: every window of that app, on any workspace, labeled with its
  title and its workspace color. Tab through it and let go of ⌘ to go to that window.
- **⌘Tab across workspaces.** Setup's ⌘Tab choice is now macOS, Apps on every workspace, or
  Workspaces. Apps steps through every app with a window, most recently used first, each marked
  with its workspace; let go and you land on that app's window wherever it is.
- **Launcher** (menu bar menu, the Workspace Dock, ⌃⌘K, or ⌘Space if you choose): one box to
  open, find, install, update and remove apps. Install searches Homebrew's full app list and the
  Mac App Store and asks first; picking an app that's already open goes to the workspace it's on.
  The **⌘Space opens the BaneySpaces launcher** switch takes ⌘Space from Spotlight and gives it back
  when turned off, when BaneySpaces quits, and in the uninstaller.
- **Every workspace has its own color**, used the same in the dock, ⌘Tab and the launcher. An app
  with windows on two workspaces shows once for each.
- **Workspace Dock** (optional, in setup and the menu bar menu): a dock of your workspaces in place
  of the macOS Dock. Click an app icon to go to that app, or the tile to go to the workspace;
  numbers sit under the tiles and a dashed tile goes to the first empty workspace. The macOS
  Dock's own settings are saved and restored when it's turned off or BaneySpaces quits, and after
  a crash by the next launch or the uninstaller.
- The switch overlay is redrawn: the workspace you went to filled in its color with its number,
  workspaces with windows lit, and its apps underneath.

## 0.2.2 (2026-10-11)

- **Updates from the menu bar, Stable or Nightly.** BaneySpaces checks once a day (or on
  request) and offers a newer build with its release notes; it installs only when you press
  Update Now, keeps running if the build fails, and shows what changed after it restarts.
  Nightly builds are published automatically each night `main` changed, and stable releases
  when a version is tagged, with notes written from this changelog and the commit history.
- **Keep Usable by Automation** (menu bar menu): apps on this list are never hidden whole.
  Their windows on other workspaces are parked out of view instead, because macOS refuses
  background clicks and keys to a hidden app, which cut off tools like Cua. Cua Spaces is on the
  list by default, so its picture-in-picture window no longer disappears on a switch. A window
  automation opens in a parked app joins that app's workspace instead of yours.
- Nothing slides across the screen when windows are parked. Parking happens behind the windows
  of the workspace you go to, and windows come back behind the ones you leave. An app that
  animates its window moves (Chromium browsers like Helium take a quarter second) is noticed
  once and hidden instead, even on the Keep Usable by Automation list; its menu entry says so.
- Switching workspaces no longer jumps to a parked app's workspace. Hiding the app you left made
  macOS bring the parked app forward, its window sliding out of the corner, and BaneySpaces took
  that as you picking it.
- A full-screen window that refuses to leave full screen no longer takes focus on every switch.
- `trace.log` records each ⌘Tab gesture (shown, committed, cancelled, passed to macOS) to help
  diagnose the switcher. It never records other keys.

## 0.2.1 (2026-10-11)

Full screen that stays put, and fixes from a second adversarial review, focused on apps that
are slow to answer.

- **Full screen stays full screen.** YouTube, slideshows and anything else you put in full screen
  stay there; BaneySpaces used to pull every window back out within a second. Switching
  workspaces takes it out of full screen first, however you switch (keys, ⌘Tab, the Dock, the
  overview), and macOS puts it back where it was. Works with the full screen below a camera notch.
- **Two windows of one app on different workspaces work.** Clicking the app in the Dock or ⌘Tab
  keeps you on the workspace you're on when it has a window there; picking its other window
  yourself (Window menu, ⌘`) takes you to that window's workspace.
- **A window that's slow to answer keeps its workspace** across a restart instead of being
  forgotten; its app comes back when you go to its workspace.
- **A busy app no longer stalls a switch.** Raising a window waits at most 0.1 s per call and
  stops at the first timeout, instead of up to 0.75 s; a missed raise is retried a moment later.
- **Closing or minimizing a window keeps you where you are,** even when the app's next window
  lives on another workspace, and even when the app only hid the window it "closed".
- **⌘Q and ⌘W can't reach the app in front while the ⌘Tab switcher is open.**
- An app that comes forward late after a switch no longer bounces you to its other workspace.
- **No window is left parked off screen** after a permission hiccup; Bring Every Window Back also
  rescues windows another tool stranded.
- Saved windows only come back to the app that owned them, a late window doesn't steal a
  workspace's remembered focus, and frozen apps aren't asked again on every scan.
- `state.json` lists apps that aren't answering (`unsure`) and saved windows still waiting for
  theirs (`waiting`).

## 0.2.0 (2026-10-10)

Faster switching, an easier first run, and fixes from an adversarial review.

- **Switching is about six times faster.** A switch that changes nothing on screen dropped from a
  91 ms median to about 15 ms; a real switch takes 20–50 ms. Background apps hide at once, only
  the app in front waits for focus to move (checked every 10 ms), the window scan is skipped when
  no window opened or closed, apps are asked in parallel, and apps with no windows aren't asked
  at all. `make bench` fails if the median goes over 40 ms.
- **Workspaces survive restarts.** Which window lives on which workspace is saved on every
  change and restored when BaneySpaces starts again (an update, a crash, logging back in), so
  nothing gets sent back to workspace 1.
- **⌘Tab can switch workspaces** (optional, in setup): hold ⌘ and tap Tab to step through the
  workspaces that have windows, most recent first; release to go there.
- **A small HUD** shows the workspace grid for half a second on every keyboard switch, and the
  menu bar number changes the moment you press the key.
- **Setup is one button.** Allow BaneySpaces puts it in the Accessibility list and opens the
  right page; setup notices the switch within a quarter second, confirms, and closes itself.
  Fix Permission repairs a permission macOS kept from an older copy.
- **Losing permission is safe.** BaneySpaces gives your keys back, shows every window and app,
  and starts again when permission returns.
- Typing can no longer land in a hidden window after ⌘W or ⌘` moves focus inside an app.
- Rapid presses land on the last workspace pressed instead of replaying each one.
- A hung app is skipped for 5 seconds instead of stalling every switch; a window that refuses to
  leave full screen is no longer asked again on every desktop change.
- Display changes keep focus where it is. Restores move a window without resizing it.
- AeroSpace, Login Items approval and freed screenshot shortcuts are handled in setup, and the
  uninstaller turns the shortcuts back on and clears the permission.

## 0.1.0 · 2026-10-10

The first release.

- Nine workspaces on ⌘1–⌘9. ⌘⇧1–⌘⇧9 sends the front window to a workspace and follows it.
  Pick ⌃, ⌥ or ⌃⌥ instead of ⌘ in setup.
- Windows on other workspaces are hidden by hiding their app, as ⌘H does, so nothing is moved,
  minimized or shown in Mission Control. An app split across workspaces parks its other windows
  just off screen and puts them back exactly.
- The overview: the Mission Control key or ⌃↑ shows all nine workspaces in a 3×3 grid. Click a
  workspace or a window to go there, press 1–9, or drag a window onto another workspace.
- Full screen fills the screen instead of creating a separate macOS desktop, so every window
  stays on a workspace.
- The Dock and ⌘Tab take you to the workspace a window lives on.
- A setup window checks Accessibility access, shortcut conflicts, the overview keys, the number
  of macOS desktops and Open at Login, and fixes what it can in one click.
- Quitting brings every window back; after a crash, the next launch does.
- `baneyspaces://` URLs for scripts: switch, move, restore and viewer.
