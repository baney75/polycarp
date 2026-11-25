# Default apps

Which app does each job, kept in one place and used by everything in Polycarp: the keys, the launcher, the bar, the CLI
and agents. Built on the Mac. Windows and Linux: unchanged, and the file format is theirs to read too.

**Roles:** `agent`, `browser`, `terminal`, `editor`, `files`, `mail`, `messages`, `calendar`, `notes`, `music`, `passwords`.

### R-D1 Who does the job
Your choice, if it is installed. Then the system's own default for the job, if that is installed: on the Mac what opens
`http`, `mailto`, `webcal`, plain text, folders, and shell scripts. Then the first app of the catalog that is installed.
Terminal opening shell scripts, as it does on every new Mac, is no choice of a terminal, so it comes after the others.

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
