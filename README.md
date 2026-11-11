<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-on-dark.svg"><img src="brand/wordmark.svg" alt="Polycarp" height="66"></picture></p>

# Polycarp

Polycarp is one app for your workspaces, your voice and the browser your agents use. On a Mac they all
live in `Polycarp.app`, with one Settings window, one set of permissions and one command. The Windows,
Linux, iPhone, iPad and Android versions share the same Rust core and are on the way; see [the plan](PLAN.md).

It grew from three apps, whose full history is here: [BaneySpaces](https://github.com/baney75/baneyspaces)
(`spaces/`), [Silas](https://github.com/baney75/silas) (`voice/`) and [Tabkyra](https://github.com/baney75/tabkyra)
(`browser/`). Those repos stay up, so you can keep using the independent apps. The shared engine is in `core/`.

## Install on a Mac

```sh
curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
```

This downloads the signed app for Apple silicon and opens it; no developer tools are needed. A window walks you
through the permissions. If you have BaneySpaces, it goes to the Trash, because it can't run beside Polycarp, and
Polycarp copies its settings. The voice part keeps its name, Silas: hold a key, speak and it types. If you have the Silas app, it stays installed and
working: Polycarp copies its dictionary, history and speech models, and Silas inside Polycarp takes over only when it is
on, a speech model is installed and the copy has finished. After the first dictation that really typed text, one
notification says dictation is working; Settings > Silas then offers "Move the Silas app to the Trash" when you're
ready. Nothing moves on its own. With Silas off, the Silas app runs freely, untouched.
On an Intel Mac, or with
`POLYCARP_FROM_SOURCE=1`, it builds on your Mac, which needs Apple's command line tools, Rust, Bun and Node.

### Download and open

[Download Polycarp](https://github.com/baney75/polycarp/releases/download/preview/Polycarp.dmg), open the file, and drag
Polycarp onto Applications. This download is for newer Macs with Apple silicon. To check, open the Apple menu, choose
About This Mac, and look for a chip whose name starts with Apple.

The first time, your Mac says it can't check the app. That's expected: open System Settings, choose Privacy & Security,
scroll down and press Open Anyway. If you open Polycarp from the file or your Downloads folder instead of Applications, it
offers to move itself there. If you used BaneySpaces, Polycarp moves it to the Trash once it is running, with your settings
copied first.

## The name

Polycarp means "much fruit". John 15:5 (ESV): "Whoever abides in me and I in him, he it is that
bears much fruit, for apart from me you can do nothing."

## The command

`polycarp` is one command that hands off to the three apps. It comes with the Mac app and with the install
script; [Updating](#updating) keeps it current with everything else.

```
polycarp spaces ls          # runs baneyspaces ls
polycarp browser --version  # runs tabkyra --version
polycarp voice              # opens Silas's settings in Polycarp (the Silas app only if Polycarp isn't installed)
polycarp doctor             # shows which tools it found, and whether their builds match
polycarp version            # every part, the commit it was built from, and whether they all match
polycarp update             # brings every part to the newest commit together
polycarp mcp                # serves the theme tools to an agent over MCP (stdio)
```

Build it with `cd cli && cargo build`. See [cli/](cli/).

## Updating

Polycarp is several parts on one device: the `polycarp` command, the app, the `polycarp-spaces` command, the browser
helper, the extension in each browser, the voice core and the agent skill. They are built from one repo and are meant to
come from the same commit. Two commands keep them that way:

```sh
polycarp version    # what is installed, and whether it all matches
polycarp update     # bring every part to the newest commit, together
```

`polycarp version` lists each part with its version, the commit it was built from and where it is, then says in one
line whether every installed part comes from the same commit. A part that isn't installed is listed as such and is not
an error. `--json` prints the same as JSON; `--check` exits 0 when they match and 1 when one differs, and names it.
`polycarp doctor` ends with the same line.

`polycarp update` shows its steps and asks once before it runs them. `--dry-run` prints the steps and runs nothing,
`--yes` skips the question (needed where there is no terminal), and `--check` only says whether an update is waiting
(exit 0 when up to date, 100 when there is one). It stops at the first step that fails, shows that step's output, says
whether anything installed was changed, and can be run again.

What it does depends on how Polycarp got onto the device:

| Install | What `polycarp update` does |
| --- | --- |
| **Mac app from the download or the install script** | Asks the app's own updater (`polycarp-spaces update --now`): the same check, signature check and installer as **Settings > Updates > Update Now**. The app restarts itself when it is done. |
| **Built from source, Mac** | Fetches `origin/main`, makes a clean copy of it in `~/Library/Caches/polycarp`, and runs `make -C spaces install` there: the app with the command, the helper, the extension and the skill inside, installed and restarted. Then it reloads the extension unless an agent is working in the browser. |
| **Built from source, Linux** | The same clean copy (in `~/.cache/polycarp`), then: the `polycarp` command into `~/.local/bin`; on Hyprland the spaces daemon, the engine and `spaces/platforms/linux/omarchy/install.sh`; with Node, the browser helper and the extension; then the daemon is stopped and Hyprland reloaded, which starts the new one. |
| **Windows** | Not supported yet: it prints the build-from-source steps from [spaces/platforms/windows/README.md](spaces/platforms/windows/README.md) and exits 2. `polycarp version` works. |

For a source install, tell it once where your checkout is:

```sh
polycarp update --source ~/src/polycarp
```

It remembers the path in `source.toml` in Polycarp's config folder (`~/.config/polycarp` on a Mac and Linux), and from
then on `polycarp update` is enough. Only `origin/main` is ever installed, and only from the clean copy: never a
branch, never files you have changed, never the checkout you work in, which is used for `git fetch` and nothing else.
It refuses a checkout whose `origin` is not this repo. When every installed part is already at that commit it says so
and stops before building anything. On Linux the browser helper and the extension run from the clean copy, so keep
that folder; a deleted one is rebuilt by the next update.

A source build needs what the first build needed: Rust everywhere; on a Mac Apple's command line tools, Bun and Node;
on Linux Node for the browser part.

The older per-part ways still exist and say when this is the better one: the app's **Settings > Updates**
([spaces/README.md](spaces/README.md#updates)), and the standalone browser's updater
([browser/docs/updates.md](browser/docs/updates.md)). `polycarp browser update` inside Polycarp.app tells you to run
`polycarp update`.

## Plan

See [PLAN.md](PLAN.md). The name, logo and colors are in [brand/](brand/README.md).

## Checks

`./check.sh` runs each directory's done check. See `AGENTS.md` and `LICENSING.md`.
