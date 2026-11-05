<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-on-dark.svg"><img src="brand/wordmark.svg" alt="Polycarp" height="66"></picture></p>

# Polycarp

Polycarp is bringing three apps into one: [BaneySpaces](https://github.com/baney75/baneyspaces)
(`spaces/`), [Tabkyra](https://github.com/baney75/tabkyra) (`browser/`) and
[Silas](https://github.com/baney75/silas) (`voice/`). Each directory holds the full git history of
its original repo. Those repos stay up, so you can keep using the independent apps.

## Install on a Mac

```sh
curl -fsSL https://raw.githubusercontent.com/baney75/polycarp/main/install.sh | bash
```

This builds the workspace app and the `polycarp` command on your Mac, which takes a few minutes the
first time. It needs Apple's free command line tools and [Rust](https://rustup.rs). If BaneySpaces is
installed, it goes to the Trash, because the two can't run together, and Polycarp imports its settings.
Voice and Browser are next; until then Silas and Tabkyra keep working alongside it.

## The name

Polycarp means "much fruit". John 15:5 (ESV): "Whoever abides in me and I in him, he it is that
bears much fruit, for apart from me you can do nothing."

## The command

`polycarp` is one command that hands off to the three apps. The apps must already be installed. Install it with `cargo install --path cli`.

```
polycarp spaces ls          # runs baneyspaces ls
polycarp browser --version  # runs tabkyra --version
polycarp voice              # opens Silas
polycarp doctor             # shows which tools it found
polycarp mcp                # serves the theme tools to an agent over MCP (stdio)
```

Build it with `cd cli && cargo build`. See [cli/](cli/).

## Plan

See [PLAN.md](PLAN.md). The name, logo and colors are in [brand/](brand/README.md).

## Checks

`./check.sh` runs each directory's done check. See `AGENTS.md` and `LICENSING.md`.
