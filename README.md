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
Polycarp copies its settings. If you have Silas, it stays installed and working: Polycarp copies its dictionary,
history and speech models, and takes over dictation only when voice is on, a speech model is installed and the copy has
finished. After the first dictation that really typed text, one notification says dictation is working; Settings > Voice
then offers "Move Silas to the Trash" when you're ready. Nothing moves on its own. With voice off, Silas runs freely, untouched. On an Intel Mac, or with
`POLYCARP_FROM_SOURCE=1`, it builds on your Mac, which needs Apple's command line tools, Rust, Bun and Node.

## The name

Polycarp means "much fruit". John 15:5 (ESV): "Whoever abides in me and I in him, he it is that
bears much fruit, for apart from me you can do nothing."

## The command

`polycarp` is one command that hands off to the three apps. The apps must already be installed. Install it with `cargo install --path cli`.

```
polycarp spaces ls          # runs baneyspaces ls
polycarp browser --version  # runs tabkyra --version
polycarp voice              # opens Polycarp's Voice settings (Silas only if Polycarp isn't installed)
polycarp doctor             # shows which tools it found
polycarp mcp                # serves the theme tools to an agent over MCP (stdio)
```

Build it with `cd cli && cargo build`. See [cli/](cli/).

## Plan

See [PLAN.md](PLAN.md). The name, logo and colors are in [brand/](brand/README.md).

## Checks

`./check.sh` runs each directory's done check. See `AGENTS.md` and `LICENSING.md`.
