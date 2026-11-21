# The built-in terminal

Polycarp's terminal is Ghostty's engine, libghostty (MIT), linked into the app. Ghostty draws the text with Metal,
reads the keyboard, runs the shell and handles the clipboard; Polycarp gives it windows, a quick terminal, its
theme and a command.

## Use

| Do | What opens |
| --- | --- |
| `polycarp-spaces term` | a terminal window with your login shell |
| `polycarp-spaces term claude` / `term codex` | a window running Claude Code or Codex, in your login shell |
| `polycarp-spaces term --cmd "htop -d 5"` | a window running that command |
| `polycarp-spaces term --host parish1` | a shell on that tailnet device: `tailscale ssh parish1`, or `ssh parish1` when the Tailscale command isn't installed |
| `polycarp-spaces term --quick` | the quick terminal |
| ⌃` | the quick terminal, down from the top of the screen the pointer is on, and back up |
| the launcher: "terminal", "claude", "codex", "ssh parish1" | the same |

`--host` takes a device name, `user@device`, a MagicDNS name or a tailnet address, and nothing that could be read as
an option or a shell word: the name is checked, then quoted twice. It never goes through Cloudflare. Run a command on
another device from its own shell; `--host` with `--cmd` is refused. Only this Mac opens its terminals: a request from
another machine on the tailnet is refused even with a token.

## Config

Your own Ghostty config is the base: `~/.config/ghostty/config` and Ghostty's Application Support file, with their
`config-file` includes, load first, as in Ghostty. Polycarp then writes its theme as Ghostty keys to
`~/Library/Application Support/Polycarp/terminal-theme.ghostty` and loads that on top: background, foreground,
cursor, selection, and the theme's `mono` font stack at the UI size scaled to a terminal's (16 px is 13 pt). Every
other key you set (keybinds, scrollback, shell integration) stays yours. A theme change recolors open terminals.
Problems in your config go to trace.log, five at most.

## Build

libghostty is built from the commit in `ghostty/PIN` by `scripts/build-ghostty.sh` into `ghostty/lib` (not
committed). It refuses a tarball whose sha256 or embedded commit differs from the pin, and a header that differs from
`Sources/CGhostty/include/ghostty.h`. It needs zig at the pinned version and the Metal Toolchain; without them it exits
3 with one line, `terminal not built: needs the Metal Toolchain (xcodebuild -downloadComponent MetalToolchain)` (or
the zig version it wants), and nothing else changes.

`Package.swift` links the terminal when `ghostty/lib/libghostty.a` exists, or as `POLYCARP_TERMINAL=1` or `0` says.
SwiftPM caches the manifest on its environment, not on files, so after building the library run
`POLYCARP_TERMINAL=1 swift build` once; `scripts/bundle.sh` sets it itself. Every file that touches libghostty sits
inside `#if POLYCARP_TERMINAL`, so `swift build && swift test` pass without it.

Who builds it:

- CI (`spaces-terminal` in `ci.yml`): fetches the pinned zig (`scripts/fetch-zig.sh`, checksum checked), gets the
  Metal Toolchain if the runner lacks it, builds the library once per pin (cached), then builds, tests and bundles
  Polycarp with it linked.
- Channel builds (`channel-build.yml`): the same, then `bundle.sh` links it, since nightly and dev builds are Apple
  silicon only.
- Universal and Intel builds, and any Mac without the library: no terminal. `bundle.sh` says so once.

## Limits in phase 1

- Apple silicon only. Ghostty v1.3.1, not v1.4.0, which needs zig 0.17.0.
- No tabs or splits; one surface per window.
- Polycarp's workspaces place other apps' windows, not its own, so a terminal window shows on every workspace.
- Ghostty's own keybind actions for tabs, splits and its inspector do nothing here.
