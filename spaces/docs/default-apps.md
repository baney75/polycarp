# Default apps

Polycarp keeps one answer to "which app does this job?", and its keys, launcher and commands all use it. The jobs are
agent, browser, terminal, editor, files, mail, messages, calendar, notes, music and passwords.

## Who decides

1. Your choice, when it is installed.
2. macOS's own default for that job: browser, mail, calendar, editor, files, and a terminal you told macOS to use.
3. The first app Polycarp knows for the job that is installed.

A choice you uninstall is kept. Settings says it is gone and the next in the list does the job until it is back. Polycarp
picks no AI agent for you, because an agent can cost money: the first time you open one, it asks.

## Choosing

Settings > Default apps has one row a job. Pick an installed app, **Other app…** for any app on the disk, or the first
line to leave it to macOS.

For a browser or a mail app that macOS doesn't use already, Polycarp asks where:

- **Polycarp Only** changes what Polycarp opens.
- **Everywhere on This Mac** changes macOS's default too. macOS asks you again; if you say no there, nothing changes.

Only that button changes macOS's default. No command, agent, MCP tool, timer or update can.

Or from a terminal, with Polycarp running or not:

```sh
polycarp-spaces defaults                              # every job, the app, and who decided
polycarp-spaces defaults candidates terminal          # what is installed
polycarp-spaces defaults set terminal com.mitchellh.ghostty
polycarp-spaces defaults set agent claude             # a program, by name
polycarp-spaces defaults reset terminal               # back to macOS's
```

Each takes `--json`. The same choices are lines in `~/.config/baneyspaces/config.toml`:

```toml
[defaults]
terminal = "com.mitchellh.ghostty"
agent = "claude"
```

A saved edit applies at once. A line that can't be read is named in Settings and in `polycarp-spaces defaults`, and the
others still count. `BANEYSPACES_CONFIG_DIR`, then `XDG_CONFIG_HOME`, move the file; set them for the app as well as your
shell.

## Opening

| | |
| --- | --- |
| ⌃⌘Return | The terminal |
| ⌃⌘⇧B | The browser |
| ⌃⌘⇧A | The agent |

Each goes to the app's newest window on this workspace, else to its nearest workspace, else opens a window. It never
brings a window from another workspace to you. Add ⌥ for a new window.

Change a key in Settings > Keys, or in config.toml:

```toml
[keys.bindings]
"ctrl+cmd+t" = "open terminal"       # in place of ⌃⌘Return
"ctrl+cmd+shift+e" = "open mail"
"ctrl+cmd+n" = "open browser --new"
"ctrl+cmd+shift+a" = "none"          # no key for the agent
```

A chord macOS, another Polycarp key or another app has is never taken. Settings says who has it.

In the launcher, a job's name opens its app (`browser`, `mail`; ⌘Return for a new window), `terminal here` opens a terminal where you were working,
`set default browser` goes to Settings, and `> fix the build` gives your agent that prompt after Return.

```sh
polycarp-spaces open browser
polycarp-spaces open terminal --in ~/Projects/site --new
polycarp-spaces open agent --in ~/Projects/site --prompt "fix the build"
```

## Agents in a terminal

A program such as `claude` or `codex` opens in your terminal, in the folder you were working in. Polycarp finds programs
on your login shell's PATH and in the usual folders without running them, reads none of their sign-in files and passes no
option that skips their permission questions.

The prompt reaches the program as one argument, whatever is in it. It is never part of a command line a shell reads: the
words go in a file only your account can read, which is deleted as it is read. Crush, Kimi and Amp take no first prompt,
nor do apps; theirs goes on the clipboard, and Polycarp says so.

Ghostty, Terminal, iTerm2, WezTerm, kitty, Alacritty and Rio can be told what to run. Warp and Hyper can only open a
folder, so a program opens in the first of the others that is installed.

Linux and Windows: unchanged for now. The file's format is the same on all three.
