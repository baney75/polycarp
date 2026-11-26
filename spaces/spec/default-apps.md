# Default apps

Which app does each job, kept in one place and used by everything in Polycarp: the keys, the launcher, the bar, the CLI
and agents. Built on the Mac. Windows and Linux: unchanged, and the file format is theirs to read too.

**Roles:** `agent`, `browser`, `terminal`, `editor`, `files`, `mail`, `messages`, `calendar`, `notes`, `music`, `passwords`.

### R-D1 Who does the job
Your choice, if it is installed. Then the system's own default for the job, if that is installed: on the Mac what opens
`http`, `mailto`, `webcal`, plain text, folders, and programs
(`public.unix-executable`). Then the first app of the catalog that is installed.
Terminal opening programs, as it does on every new Mac, is no choice of a terminal, so it comes after the others,
and for a terminal only an app the catalog lists counts as the system's. An identifier is one app in any case.

### R-D2 A choice that is gone stays yours
A choice that isn't installed falls through to the next answer, which says so, and is not erased.

### R-D3 One role at a time
Choosing for one role changes no other role, whatever else the app can do.

### R-D4 Any installed app
Any installed app can be chosen. The catalog only says which to offer first. A program in a terminal (an agent or an
editor) is named by its id in the catalog, so no text from a file or a person is ever run as a program's name.

### R-D5 No agent is chosen for you
With no choice, the `agent` role has no answer, and opening it asks. Starting an agent can cost money.

### R-D6 Finding runs nothing
What is installed is read from Launch Services and the disk. No program, shell or app is run to find out.

### R-D7 Terminals that take a command
A program opens in your terminal when that terminal can be told what to run, else in the first installed one that can.
A terminal that can't says so where it is offered.

### R-D8 macOS's own defaults change only by a person's click
Choosing an app here changes what Polycarp opens. Making a browser or a mail app the whole Mac's is a button a person
presses in Settings, and macOS asks them. The CLI, MCP, agents, updates and timers can't do it.

### R-D10 Words stay words
What a person types for an agent reaches it as one argument, whole: quotes, newlines, a leading dash, `$()` and
backticks are characters in it. It is never part of a command line a shell or a terminal reads. On the Mac the words go
into a file only this account can read, read once and deleted; the terminal is told to run Polycarp's own command with
that file's name. An agent that can't be given a prompt as one argument opens without it, and the prompt is put on the
clipboard. No agent is given an option that turns off its permission questions.

### R-D9 The file
The choices are the `[defaults]` table of the configuration file (config.md), a role to an id, only for roles you chose:

```toml
[defaults]
terminal = "com.mitchellh.ghostty"
agent = "claude"
```

A bundle identifier is the Mac's id for an app; Windows and Linux put their own there (an AppUserModelID, a desktop
file). A line that can't be read costs only itself: a warning names the key, and the rest applies, whatever else in the
file is wrong. A write changes that role's line and nothing else.
