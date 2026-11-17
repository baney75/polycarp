# Launcher extensions

A launcher extension is a folder with a script and a small manifest. The Mac launcher runs them today;
the Windows launcher reads the same folders by the same rules. A rule that isn't here doesn't ship on
one platform alone.

## Where they live

`<config>/extensions/<id>/extension.toml`, where `<config>` is the Polycarp config folder by the rules
`polycarp theme` uses (`POLYCARP_CONFIG_DIR`, then the pinned folder, then `$XDG_CONFIG_HOME/polycarp`,
then `~/.config/polycarp`; on Windows `%APPDATA%\Polycarp`). The folder name `<id>` is the extension's
id. Folders whose names start with `.` are skipped.

Everything in this folder is code the person put there. Polycarp never downloads, installs or updates an
extension.

## The manifest

```toml
title = "Word Count"          # required: the row's title
keyword = "wc"                # required: no spaces, doesn't start with ! or ?, unique among extensions
command = ["./count.sh", "--words"]  # required: the program and its fixed arguments
output = "text"               # "text" (default) or "list"
timeout = 5                   # seconds, default 5, at most 30 (a larger value means 30)
description = "Counts words"  # optional, shown in the Extensions menu
```

The file is TOML. Polycarp's reader takes `key = value`, `[table]`, `[[array]]`, strings (basic,
literal and both multi-line kinds), integers, floats, booleans and arrays. Dotted keys, inline tables and
dates are refused with a line number. Unknown keys are ignored, so newer manifests still load.

A manifest that can't be read is listed with its reason in the launcher's Extensions menu, and the other
extensions still load. Two extensions with the same keyword (case ignored): the first by folder name
wins, the other is listed as a problem.

## Running

Typing the keyword, a space and some text offers a row at the top: "Return runs it with “text”". Return
runs it. An extension never runs on a keystroke, only on Return.

- `command[0]` is the program. A path with a `/` that doesn't start with one (`./count.sh`,
  `bin/tool`) is inside the extension's folder and must stay inside it. A path starting with `/` is used
  as written. A bare name (`python3`) is looked up in the path below.
- The arguments are `command[1...]`, then what was typed after the keyword (trimmed) as **one more
  argument**, left off when nothing was typed. No shell is involved: quotes, `$`, `;`, backticks and
  globs in the typed text reach the program as plain characters.
- The working folder is the extension's folder. Standard input is empty (`/dev/null`).
- The environment is only: `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  (Windows: the system path), `HOME`, `LANG` and `LC_ALL` set to `en_US.UTF-8`,
  `POLYCARP_EXTENSION_DIR` (the folder) and `POLYCARP_INPUT` (the typed text, also the last argument).
- It runs in its own process group (Windows: a job object). At the timeout the group gets SIGTERM, one
  second later SIGKILL. When the program exits, anything it left in its group is killed too.
- Standard output is kept up to 64 KB and standard error up to 4 KB; the rest is read and dropped, so
  a program never blocks on a full pipe.

## Output

Exit status 0 is success. Anything else, a timeout, or a program that can't be found shows one row
with the reason and the first line of standard error.

- `text`: one row with the output (trimmed; newlines drawn as ⏎, cut at 200 characters on screen).
  Return copies all of it.
- `list`: one row per non-empty line, at most 50, each `title<TAB>subtitle<TAB>value`. Subtitle and
  value are optional; the value defaults to the title. Return opens a value that starts with `http://`
  or `https://` in the default browser, and copies any other value.

The output rows stay at the top for as long as the same keyword and text stay typed.

## Example

`extensions/wc/extension.toml`:

```toml
title = "Word Count"
keyword = "wc"
command = ["./count.sh"]
```

`extensions/wc/count.sh` (executable):

```sh
#!/bin/sh
printf '%s' "$1" | wc -w | tr -d ' '
```

Typing `wc the quick brown fox` and Return shows `4`; Return again copies it.
