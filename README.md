<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-on-dark.svg"><img src="brand/wordmark.svg" alt="Polycarp" height="66"></picture></p>

# Polycarp

Polycarp is being assembled from three apps: [BaneySpaces](https://github.com/baney75/baneyspaces)
(`spaces/`), [Tabkyra](https://github.com/baney75/tabkyra) (`browser/`) and
[Silas](https://github.com/baney75/silas) (`voice/`). Each directory holds the full git history of
its original repo. For now those three repos remain the apps to install; this repo does not
replace them yet.

## The name

Polycarp means "much fruit". John 15:5 (ESV): "Whoever abides in me and I in him, he it is that
bears much fruit, for apart from me you can do nothing."

## The command

`polycarp` is one command that hands off to the three apps. The apps must already be installed.

```
polycarp spaces ls          # runs baneyspaces ls
polycarp browser --version  # runs tabkyra --version
polycarp voice              # opens Silas
polycarp doctor             # shows which tools it found
```

Build it with `cd cli && cargo build`. See [cli/](cli/).

## Plan

See [PLAN.md](PLAN.md). The name, logo and colors are in [brand/](brand/README.md).

## Checks

`./check.sh` runs each directory's done check. See `AGENTS.md` and `LICENSING.md`.
