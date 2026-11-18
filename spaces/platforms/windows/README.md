# BaneySpaces for Windows

Part 1: the workspace model on Windows 11, the keys, the agent workspace and the agent hands. No dock,
launcher or overview yet (part 2). The shared contract is `spec/`; the model, the scope guard and the
envelope are `crates/baneyspaces-core`, the same code the Linux daemon runs.

```
platforms/windows/baneyspaces/   the `baneyspaces` binary: CLI, `daemon`, `mcp`
platforms/windows/scripts/       build-engine.ps1: the pinned agent-desktop, built with --locked
platforms/windows/tests/         live.sh (the live test in the VM), readback.ps1, watch.ps1, evidence/
platforms/windows/tests/ci/      live.ps1 and Desk.cs: the live test on a GitHub Actions Windows runner
platforms/windows/vm/            provision-toolchain.ps1: Rust + the MSVC build tools inside the test VM
```

## Hiding windows: which way, and why

Three ways to take a window out of sight on Windows, measured on Windows 11 (build 26100) in the VM.
"Animation" was counted by sampling the window's pixels as fast as the VM could while the call ran.

| | Animation | Taskbar | Explorer restart | A window can be lost if the daemon dies |
| --- | --- | --- | --- | --- |
| `ShowWindow(SW_HIDE)` | **yes**: 6 distinct frames (a fade) | button disappears (churn) | fine | yes, nothing brings it back |
| Move off-screen | none | button stays | fine | yes, it sits at -32000 |
| `DwmSetWindowAttribute(DWMWA_CLOAK)` | none | n/a | n/a | **does not work across processes**: `E_ACCESSDENIED` |
| **Shell cloak**: `IApplicationView::SetCloak` through ImmersiveShell COM | none: one frame | button stays (no churn) | **survives**: cloaked at 2 before and after killing explorer.exe, and undone afterwards | recoverable (below) |

komorebi (`HidingBehaviour::Cloak`, its default) and GlazeWM (`set_cloaked`) both make the shell cloak
call, with the same undocumented interface ids. So did this daemon, after checking the numbers above.

**Your workspaces: the shell cloak, with a fallback.** The window stays where it is, un-drawn. The
interfaces are undocumented, so if the call is refused (a Windows build changes the ids) or does not
take (the window reads back as not cloaked), the window is **parked** at (-32000, -32000) instead, the
place Windows itself puts minimized windows. Nothing is ever hidden with `SW_HIDE`.

**The agent workspace: a ghost, not a cloak.** The hands engine (UI Automation) skips cloaked windows:
`list-windows` does not list them and `snapshot` returns `WINDOW_NOT_FOUND` (measured). An agent's window
must stay drivable, so it is made fully transparent (`WS_EX_LAYERED`, alpha 0), click-through
(`WS_EX_TRANSPARENT`) and unable to take focus (`WS_EX_NOACTIVATE`), and its taskbar button is removed.
It is still on screen and un-cloaked, and you cannot see or touch it. (`WS_EX_TOOLWINDOW` would also
hide it from the engine, so it is not used.)

**Never losing a window.** Three rules, all in `daemon.rs`:

1. **Record first.** A window is written to `%LOCALAPPDATA%\BaneySpaces\state.json` (`hidden`) and flushed
   to disk *before* it is hidden. The write retries its rename with a backoff (an antivirus or backup
   may hold the file). If it still fails, **nothing is hidden**: a `switch`, `move` or agent-workspace
   request is refused with an error (`retry: safe`, "nothing was hidden") and the model is put back.
   (An agent's window is the exception to the exception: it is kept off your screen even when the record
   cannot be saved, because it is the agent's, not yours.)
2. **Forget last.** An entry is removed only after the window reads back as shown (cloak off, back in place,
   and for a ghost every property that decides what you see: the layered bit, the alpha, click-through, no-activate,
   each as it was before the ghost; the original alpha and styles are in the record). A show that fails (explorer.exe restarting, the shell's COM down) keeps its entry
   and the daemon retries it every 400 ms until it takes; `TaskbarCreated` (explorer.exe rebuilt the taskbar) triggers a look at once.
3. **Tracked while it exists.** A hidden window stays in the set for as long as `IsWindow` is true, whatever its
   title or styles become (an empty title, a tool-window style, an owner). Only a destroyed window leaves.

A handle is only touched if it is still **the window that was hidden**: the record keeps its class and the
process that owned it (pid and start time). After a reboot, or once a window was destroyed and its handle reused,
those no longer match and the entry is dropped and logged without touching anything.

**Virtual desktops.** Windows cloaks every window of the desktop you leave. Those windows have not gone: they stay
tracked, on their workspace, are neither shown nor hidden while off the current desktop
(`IVirtualDesktopManager`), and come back as they were. (Driven live: a second desktop is created and closed
and every window keeps its workspace.)

And what is hidden is **read back from Windows**, never taken from memory, keeping the position it will be
restored to. The daemon waits on events, not a timer (`hook.rs`, `daemon.rs`): WinEvent hooks report windows
created, shown, hidden, destroyed, minimized, renamed, moved or resized, cloaked and uncloaked, and the foreground.
A cloak someone else took off (a virtual-desktop switch re-evaluates them, or another tool) is put back as soon as
`EVENT_OBJECT_UNCLOAKED` arrives. A parked window an app moved back or a ghost an app reset sends no event, so
while one exists (or a show waits to be retried) the hidden set alone is read back every 400 ms. Behind all of it,
a full look at every window runs every 3 s as a safety net, or every 400 ms if the WinEvent hooks could not be
installed. A switch writes `state.json` once, and an unchanged state is never written again.

**Speed, measured in CI.** `tests/ci/switch-bench.ps1` (job `spaces-windows-speed`) opens 30 windows over nine
workspaces on a `windows-latest` runner, types Win+n 200 times with `SendInput`, and times each switch from the keys
going in until DWM reads every window right; a screenshot after each must hold no pixel of another workspace's
color. It fails at p90 100 ms, p99 250 ms (the max is reported, not gated), or 25% over `windowsSwitch` in `spec/speed.json`, and when a window
uncloaked from outside is not cloaked again within 100 ms at p90 (a 400 ms poll misses that).
Like the live suite, it kills BaneySpaces and deletes `state.json`, so off a runner it refuses (exit 2) unless given
`-Disposable`.

- On a clean exit (`baneyspaces stop`, Ctrl+C or closing a foreground console) every window is shown.
  **Sign-out and shutdown:** a background daemon has no console, so it owns a hidden *top-level* window (a
  message-only one is never sent these) that hears `WM_QUERYENDSESSION` / `WM_ENDSESSION`, and puts every
  window back before apps are asked to save. A cancelled sign-out resumes. A panic in any thread restores and
  then ends the process; it never runs on stale state.
- After a crash or `taskkill /F`, the next start reads the list and shows every window on it, before doing
  anything else. Only windows in BaneySpaces' own record are ever uncloaked: one that Windows or another tool
  (komorebi, GlazeWM) cloaked is left alone.
- **Agent windows are the exception.** They belong off your screen, so after a restart they stay ghosted while
  their process (pid and start time) still runs. If it is gone they are shown, never lost. The daemon does
  not close an agent's app when it exits: use `agent-workspace show` after a restart.
- **Sign-out and shutdown vs a request in flight.** Restoring takes the daemon's lock, sets "stopping" under it,
  restores and reloads the record, all before anyone else can write; from then on requests that would hide a
  window are refused. Every write of `state.json` uses its own temporary file.
- **One daemon.** A named mutex and the pipe's first instance (`FILE_FLAG_FIRST_PIPE_INSTANCE`) are taken
  before anything is touched, so a second start exits without putting the first one's windows back. Two
  listeners keep a free pipe instance at all times, and the client waits out `ERROR_PIPE_BUSY`.

Taskbar: a cloaked window keeps its taskbar button (as with komorebi and GlazeWM), so the taskbar shows
every workspace's windows. An agent's window has no button.

## Keys

Explorer owns Win+1 to Win+9, so `RegisterHotKey` fails for them. The daemon runs a `WH_KEYBOARD_LL` hook on its
own thread with its own message loop. The callback matches a small table and posts to the worker over a
channel; it takes no lock and never waits (Windows drops a hook whose callback is slow). It swallows only
the chords in force: the Windows column of `spec/keys.json` (**Win+1-9** switch, **Win+Shift+1-9** move,
**Win+`** show or hide the agent workspace, **Win+Alt+arrow** focus, **Win+Alt+Shift+arrow** swap,
**Win+Ctrl+Alt+arrow** resize, **Win+Alt+.** send to the next display) with `%APPDATA%\BaneySpaces\config.toml`
over them. The daemon watches that file and swaps in a new table within 1 s of a save; a bad file keeps the keys
in force and says why in `state` (`keys.error`). The full rules are in `spec/keymap.md`. It keeps its own count of which modifiers are down, but only as a
hint: on every candidate chord each modifier it believes down is confirmed against `GetAsyncKeyState` (or a
key-down within 40 ms, when the system's state has not caught up), so a key-up that was missed (Win+L and the
secure desktop, Ctrl+Alt+Del, a UAC prompt) cannot leave Win "stuck". The count is also cleared on session lock
and unlock and when the input desktop changes. The hook swallows the digit's key-up too. So the shell never sees
a bare Win tap and opens Start (Search), and an Alt release that comes after the mask never reaches an app as a bare
Alt tap that opens its menu bar, the hook sends an unassigned key (0xE8) the moment it takes a Win or Alt chord. A
person's Win release comes after it and goes through as typed. A release already queued ahead of it (a chord typed in
one SendInput batch) is held back and sent again behind 0xE8, unless SendInput refuses, when the real release goes
through instead. A release a second after the chord goes through too, in case another hook ate the 0xE8. Known
limit: when the hook thread falls behind and keys typed right after the release are already queued, they reach the
shell ahead of the re-sent release, so Win+1 then a quick E can open Explorer. Known limit: an Alt chord that arrives
in one batch (AutoHotkey, RDP, a VM's send-key) already has Alt's release queued ahead of 0xE8, so the app sees a bare
Alt tap and opens its menu bar; only Win's release is held back and sent again. A fresh Win press, by the system's key state, starts clean, so a release the hook missed (an
elevated window) never eats a later tap. Sending 0xE8 from the daemon's worker instead lost the race to a quick
release (#557).

Limit (by design): Windows keeps a normal-level hook from seeing keys typed into an **elevated** window
(UIPI), so **the chords do nothing while an elevated window has focus** (Task Manager, an administrator
terminal). The daemon is not elevated and does not ask for UI access. It says so instead of failing silently: when an
elevated window comes to the front the log names it and `state` shows it under `keys.blocked_by`.

## Focus

An activation reaches the daemon as `EVENT_SYSTEM_FOREGROUND`. Windows does not say who caused it, so
input in the last 300 ms (`GetLastInputInfo`) counts as yours (R-F1) and anything else as the app's
(R-F2): the model refuses to follow it and the daemon puts your previous window back. A window that
opens joins the workspace its display shows (R-P1). Focus never rests on a window that is out of sight: when a
window is minimized (`EVENT_SYSTEM_MINIMIZESTART`), Windows hands the front to the next window in z-order, which may
be a hidden one, so the daemon checks the front when the minimize starts and again on the foreground change that
follows, and moves it to a window you can see.

## The agent workspace

`baneyspaces agent open <app>` starts the app as its own process, **in the user's agent job object** (named, so a restarted daemon opens the same job and an agent's app that is still running is still recognized; a process that cannot join the job is not started) (Linux
uses a launch token in the environment; a job answers "is this process one we started, or a child of
one?" directly), minimized and without focus, so a window that honors the show command is never drawn
on your screen. The model registers the pid and its start time (read from the process handle before it runs) before the first window can be seen. A registration only holds for that process: the live start time must still match, and a process that exits is unregistered within one full look (3 s), so a pid Windows hands to another program is never taken for an agent's. Every window of an
agent's process is ghosted, owned or not: a dialog or popup its app opens is caught from the WinEvent when it is
created (if it has a frame) or shown, and is an agent window like the first, so the agent can still drive it. This
is measured, not claimed away: one dialog was visible in 1 of ~110,000 polls (under a frame) before the ghost took.
Every action runs the scope guard first (`check_scope`: on the agent workspace, a registered process,
the same pid and start time), and the engine is run as a child process with no `--headed`: it sends
no `SendInput`, never moves the cursor and never draws the cursor overlay. The engine's own `type` is
`SendInput`, so **`agent type` is a UI Automation insert instead**: it reads the field's value and
sets it to value + text, and the engine reads that back (`verified` is true only then). `shot` passes
through to the engine. `press`, `key` and `pointer` are `not_supported` (phase 3-4).

- **In production, `agent open` on Windows refuses every app with `needs_sandbox`, before launch.** No
  Windows app is safe to hand an agent yet. Notepad restores your unsaved tabs into a new process, so an
  agent's Notepad could show text you never saved, and it also forwards a second launch into a copy you
  already run (seen live). Explorer, the Store apps and browsers forward too. Until there is a
  Windows sandbox, an agent can drive nothing on Windows except through a test daemon (below).
  **Follow-up: a Windows sandbox phase**, where the agent's apps run apart from your session
  (Windows Sandbox or a Hyper-V VM). Single-instance forwarding is handled there as well; the
  `single_instance` error, with `windows_that_appeared`, stays as the backstop if an app forwards anyway.
- **A window that refuses the ghost** (Windows would not take a constant alpha, as for a window that draws with per-pixel alpha) is
  parked, recorded as parked, and left alone: it is not tried again on every read-back. If it later takes the ghost it is
  recorded as a ghost with the styles to put back. `agent move` of one of *your* windows hides it the way yours
  are hidden (recorded first, `agent: false`), not as an agent's ghost.
- **Tests only: `bs-testapp`** (`platforms/windows/testapp`) is a window with a text box: its own exe,
  its own process every time, nothing remembered, no forwarding. A daemon **built with the
  `test-ops` feature** and started with `BANEYSPACES_TEST_OPS` set may start it (and `cmd`, for the agent-peer
  check). A release build made without the feature ignores the variable, whatever the environment holds. `live.sh` starts a test daemon for the agent flow.
- `agent run` is `needs_sandbox`: a console window belongs to Windows Terminal, not to the process we
  would start, so it cannot be tied to the agent.
- An agent's own process (a pid in a job, or registered) is refused every user operation
  (`switch`, `move`, `stop`, the agent workspace toggles, parking a window...) with `not_in_scope`. The pipe's
  client pid decides, never the request. The control pipe is `\\.\pipe\baneyspaces-<your SID>` (not the user name, which can collide), with an ACL for you and
  SYSTEM only and remote clients rejected; the client checks that the server process runs as you and opens the pipe for
  identification only.
- The engine is found in `%LOCALAPPDATA%\BaneySpaces\engine` only. A test build (`test-ops`, debug) also honors
  `BANEYSPACES_ENGINE` and looks in the source tree above the exe; a release build never walks up directories (they
  reach the drive root, where another account may have planted a file).
- The job and the peer check are **advisory**: any process of your own user can open the job by name or start a
  process outside it, so this stops an agent's own app and its children by accident, not a hostile process of your user.
  Only the sandbox phase makes it a boundary.
- The engine keeps its snapshots in `%LOCALAPPDATA%\BaneySpaces\engine-state` (`AGENT_DESKTOP_HOME`),
  because it refuses a directory an elevated process created.

## Settings

`baneyspaces set|get` stores `appearance.theme` (`baneyspaces`, `omarchy`, `minimal`),
`appearance.palette` (`auto` or a palette name) and `dock.enabled` in `settings.json` and returns them
(`spec/themes.md`). Part 1 has no dock or themed UI, so they have no effect yet. Agents may `set` these
three too (Donovan, 2026-11-01); every `set` is logged with the agent id and the caller's pid (never the
value). Workspace and window operations stay user-only.

## Build and test

```powershell
cargo test -p baneyspaces-core -p baneyspaces-windows --locked   # the Linux crate is unix-only, so test by package
cargo build --release --locked -p baneyspaces-windows
cargo build --release -p baneyspaces-windows --features baneyspaces-windows/test-ops -p baneyspaces-testapp   # what live.sh runs
platforms/windows/scripts/build-engine.ps1 -Install              # the pinned agent-desktop (platforms/windows/engine.pin), copied to %LOCALAPPDATA%\BaneySpaces\engine
baneyspaces daemon --background                                  # no console window; --log FILE, --trace
```

On seat-a the test VM is `/home/alex/Projects/_work/win11-vm`. `vm/provision-toolchain.ps1` installs Rust,
the Build Tools and MinGit in it (about 10 minutes, redo after `reset`); the tree is built there. The
Windows crate also cross-checks on Linux with `cargo xwin check --target x86_64-pc-windows-msvc`.
`tests/live.sh` is the live test: it opens Notepad, Explorer and Calculator at normal level, moves
and switches with the CLI and with real Win+n keys (`virsh send-key`), kills the daemon with
`taskkill /F` and starts it again, and runs the agent flow with `bs-testapp` (after checking that production refuses every launch), reading back the windows (EnumWindows,
visibility, DWM cloak state, layered alpha) after every step. `tests/evidence/` has its log and screenshots.


### CI live suite

`tests/ci/live.ps1` (with `tests/ci/Desk.cs` for the Win32 read-backs) ports `live.sh` sections 0 to 8 to the
`spaces-windows-live` CI job on a GitHub-hosted `windows-latest` runner: the real daemon on the runner's own
interactive desktop (session 2, explorer.exe and DWM running), real Notepad, Explorer and `bs-testapp` windows, and
the keyboard hook fed with SendInput. It reads the windows back after every step, saves screenshots, prints
`RESULT: PASS|FAIL passed= failed= skipped=`, lists failures and skips in the job summary, and uploads `live.log`,
`daemon.log` and the screenshots as the `windows-live` artifact. It kills BaneySpaces, deletes its recovery record
(`state.json`, what puts hidden windows back) and force-closes every Notepad, so off a CI runner it refuses (exit 2)
unless given `-Disposable`. By hand only on a disposable Windows desktop (a VM), after the test-ops build and
`build-engine.ps1 -Install`: `powershell -File platforms/windows/tests/ci/live.ps1 -Bin target/release -Out <dir> -Disposable`.
The CLI helper in the script is `bsc`: `cli` is a built-in PowerShell alias for Clear-Item, and aliases win over
functions.

Section 6c has the test app's own thread hide and then show (SW_HIDE, SW_SHOWNA) its window on hidden workspace 3,
five times, while a watch polls every visible window as fast as it can. The shell decides a window's cloak again when
it is shown, so this is the moment a tray app's restored window could draw on your workspace before the daemon's next
look; any poll that sees it fails the check.

What the runner can't run, so it stays untested live on Windows hardware:

- Two displays (section 8, R-M2 and R-M3). The runner has one 1024x768 display, and a second needs a display
  driver install. The suite reports it as a skip.
- Real hardware keys. Only SendInput reaches the hook, and only input marked with `TEST_INPUT_MARK` in a test-ops
  build run with `BANEYSPACES_TEST_OPS` counts as typed. The negative check sends an unmarked Win+7: an unmarked
  Win+2 reaches the shell and opens the second taskbar item (Edge).
- A standard user. The runner's account is an elevated administrator (High integrity), so UIPI never stands
  between the daemon and an elevated window the way it does for a person who doesn't run as admin.
- Calculator and Store apps. The runner has neither, so the suite uses Notepad, Explorer and `bs-testapp`.
- Windows 11's shell. The runner is Windows Server 2025 (10.0.26100) with classic Notepad: no Snap layouts and no
  Windows 11 taskbar.
- A real sign-out. The suite sends WM_QUERYENDSESSION and WM_ENDSESSION to the session window; it can't end the
  runner's session.

Not done in part 1: multi-monitor placement (windows are not moved between displays; the model is, and
this is untested without a second display), the Startup shortcut, the overview, the dock and themed UI.
