<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-on-dark.svg"><img src="brand/wordmark.svg" alt="Polycarp" height="66"></picture></p>

# Polycarp

Polycarp is its own OS on a Mac or a Windows PC: workspaces, the top bar, the launcher and one theme over all of them.

The Workspace Dock was removed on 2026-11-23: workspaces are on ⌘1 to ⌘9 and the top bar's numbers, the overview is on the
Mission Control key, the hot corner and the status menu, and apps running with no window are in the launcher (⌃⌘K) under
"Running, no window".

It is a personal tool: Donovan Baney builds it for his own machines. The code and the releases are public.

The Polycarp browser extension ([`spaces/extension`](spaces/extension)) is the reading and accessibility extension that was
Phont. It works on its own in Helium, Chrome and other Chromium browsers. With Polycarp installed on the same computer it
also gives the browser Polycarp's new tab and updates with the app. The browser-driving extension, its CLI helper, MCP
server and computer-use tools were removed from Polycarp.
The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

On a Mac it lives in `Polycarp.app`, with one Settings window, one set of permissions and one command. The Windows
version is on the way; see [the plan](PLAN.md). It grew from [BaneySpaces](https://github.com/baney75/baneyspaces)
(`spaces/`). That repo stays up, so you can keep using the independent app.

Every keyboard shortcut, by group and with where it works, is in [docs/keys.md](docs/keys.md); `polycarp-spaces keys`
prints the same list with your modifier.

Dictation is [Silas](https://github.com/baney75/silas) and screenshots are [Shotate](https://github.com/baney75/shotate).
Each is its own app: install and update it on its own.

## Install on a Mac

```sh
curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
```

This downloads the signed app for Apple silicon and opens it; no developer tools are needed. A window walks you
through the permissions. If you have BaneySpaces, it goes to the Trash, because it can't run beside Polycarp, and
Polycarp copies its settings. On an Intel Mac, or with
`POLYCARP_FROM_SOURCE=1`, it builds on your Mac, which needs Apple's command line tools and Rust.

### Download and open

[Download Polycarp](https://github.com/baney75/polycarp/releases/download/nightly/Polycarp.dmg), open the file, and drag
Polycarp onto Applications. This download is for newer Macs with Apple silicon. To check, open the Apple menu, choose
About This Mac, and look for a chip whose name starts with Apple.

The first time, your Mac says it can't check the app. That's expected: open System Settings, choose Privacy & Security,
scroll down and press Open Anyway. If you open Polycarp from the file or your Downloads folder instead of Applications, it
offers to move itself there. If you used BaneySpaces, Polycarp moves it to the Trash once it is running, with your settings
copied first.

## Linux

The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces. Run on Linux, the install
line above says so and installs nothing, and so does
`polycarp update`.

An earlier install that is still in place keeps its block in `~/.config/hypr/hyprland.lua`, which binds your
workspace keys to the retired daemon. `spaces/platforms/linux/omarchy/uninstall.sh` takes it out and gives Omarchy its
own keys back; run it with `--dry-run` first to see what it does. Nothing runs it for you.

## The name

Polycarp means "much fruit". John 15:5 (ESV): "Whoever abides in me and I in him, he it is that
bears much fruit, for apart from me you can do nothing."

## The command

`polycarp` is one command for Polycarp Spaces and themes. It comes with the Mac app and with the install
script; [Updating](#updating) keeps it current with everything else. `polycarp browser` only says the agent browser
extension was removed and exits 2.

```
polycarp spaces ls          # runs baneyspaces ls
polycarp doctor             # shows which tools it found, and whether their builds match
polycarp version            # every part, the commit it was built from, and whether they all match
polycarp update             # brings every part to the newest commit together
polycarp look save mine     # keeps how everything looks under a name; apply, undo, export, import
polycarp mcp                # serves the theme tools to an agent over MCP (stdio)
```

Build it with `cd cli && cargo build`. See [cli/](cli/).

## Updating

Polycarp is several parts on one device: the `polycarp` command, the app, the `polycarp-spaces` command and the agent
skill. They are built from one repo and are meant to
come from the same commit. Two commands keep them that way:

```sh
polycarp version    # what is installed, and whether it all matches
polycarp update     # bring every part to the newest commit, together
```

`polycarp version` lists each part with its version, the commit it was built from and where it is, then says in one
line whether every installed part comes from the same commit. A part that isn't installed is listed as such and is not
an error. `--json` prints the same as JSON; `--check` exits 0 when they match and 1 when one differs, and names it.
`polycarp doctor` ends with the same line, then one indented line for each part that is missing or does not match:
what is wrong and the one command that fixes it on this platform.

The agent skill is compared with the copy the installed spaces command carries, the one in the app.

On a Mac, the `polycarp` command in the list is the installed one (`~/.local/bin/polycarp`), whichever `polycarp` you
ran, so a build in a checkout reports what is installed and not itself. On Windows it is the one that is running; the
rest is the same. Nothing in the list is run to learn its build.

`polycarp update` shows its steps and asks once before it runs them. `--dry-run` prints the steps and runs nothing,
`--yes` skips the question (needed where there is no terminal), and `--check` only says whether an update is waiting
(exit 0 when up to date, 100 when there is one). It stops at the first step that fails, shows that step's output, says
whether anything installed was changed, and can be run again.

What it does depends on how Polycarp got onto the device:

| Install | What `polycarp update` does |
| --- | --- |
| **Mac app from the download or the install script** | Asks the app's own updater (`polycarp-spaces update --now`): the same check, signature check and installer as **Settings > Updates > Update Now**. The app restarts itself when it is done. |
| **Built from source, Mac** | Fetches `origin/main`, makes a clean copy of it in `~/Library/Caches/polycarp`, and runs `make -C spaces install` there: the app with the command and the skill inside, installed and restarted. Then the newly installed command checks every part. |
| **Windows** | Not supported yet: it prints the build-from-source steps from [spaces/platforms/windows/README.md](spaces/platforms/windows/README.md) and exits 2. `polycarp version` works. |

For a source install, tell it once where your checkout is:

```sh
polycarp update --source ~/src/polycarp
```

It remembers the path in `source.toml` in Polycarp's config folder (`~/.config/polycarp` on a Mac), and from
then on `polycarp update` is enough. Only `origin/main` is ever installed, and only from the clean copy: never a
branch, never files you have changed, never the checkout you work in, which is used for `git fetch` and
`git worktree` and nothing else. It refuses a checkout whose `origin` is not this repo. When every part this update
installs is already there and at that commit it says so and stops before building anything. A part that is missing
counts as an update.

Nothing that is installed runs from the clean copy, so the cache folder can be deleted at any time; the next update
makes it again.

**The first run.** An installed `polycarp` from before this command does not know `update`. Build one and run it:

```sh
cd ~/src/polycarp/cli && cargo build --release
./target/release/polycarp update --source ~/src/polycarp
```

That works on a Mac. The `polycarp` that starts an update fetches, builds and installs. After the step
that replaces the installed command, it runs nothing more itself: it hands over to the installed command
(`~/.local/bin/polycarp update --finish`), which checks by its own rules. So an updater that is
older than what it installs cannot finish an update the old way, and the plan (`--dry-run`) prints which command runs
each step. If the handover fails, every part is already installed and the report says the final check did not run.
On Windows there is no update yet, so there is no first run: it exits 2 with the build steps.

A source build needs what the first build needed: Rust and Apple's command line tools.

**From a build that still had the browser.** An older installed `polycarp` runs its own plan, which first sets up the
browser's packages. That script is gone from `main`, so the update stops at that step and nothing installed changes.
Install once from a checkout of `main` (`make -C spaces install`, or the install line with `POLYCARP_SOURCE` set to the
checkout), and updates work again. A remote connector the old helper set up (`com.polycarp.serve`, `.cloudflared`,
`.hub`, `.link`) keeps running while the program it runs is still on disk; an install retires a job whose program is
gone. Every install also retires `com.polycarp.browser` and `com.tabkyra.*` jobs whose program was inside Polycarp.app
or in a folder only Polycarp wrote.

The app's **Settings > Updates** ([spaces/README.md](spaces/README.md#updates)) still updates the app on its own.

## Plan

See [PLAN.md](PLAN.md). The name, logo and colors are in [brand/](brand/README.md).

## Checks

`./check.sh` runs each directory's done check. See `AGENTS.md` and `LICENSING.md`.
