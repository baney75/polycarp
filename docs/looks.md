# Looks

A look is how Polycarp looks, as one file a friend can send you: the theme with its mode and accents.

```sh
polycarp look export evening-desk ~/Desktop/evening-desk.polycarp-look
polycarp look import friend.polycarp-look   # checked and saved; nothing on screen changes
polycarp look show friend               # what it holds
```

Every command takes `--json` and answers as `polycarp theme` does (the same envelope and exit codes).

## Commands

| Command | What it does |
| --- | --- |
| `list` | The shipped look and yours |
| `show <name\|file>` | What a look holds |
| `export <name> <file\|-> [--force]` | Writes one file to share. `-` prints it |
| `import <file\|-> [--name N] [--force]` | Checks someone's look and saves it |

Yours are in `<config>/looks/`. `polycarp` is the shipped look: it can't be replaced.

Error codes, beside the theme's: `invalid_look`, `unknown_look`, `exists`, `builtin_read_only` (the name `polycarp`).

## The file

`<name>.polycarp-look` is JSON, whole in itself, at most 32 MB.

```json
{
  "schema": 1,
  "name": "evening-desk",
  "title": "Evening desk",
  "description": "Warm paper and a quiet bar",
  "theme": {"builtin": "evening"},
  "mode": "auto",
  "accent": {"light": "#59693f", "dark": "#a9bb8a"}
}
```

- `theme` is `{"builtin": name}`, or `{"document": {...}}`: a whole theme that extends nothing.

## What a look can't do

A look from a stranger may change only how things look.

Any key Polycarp doesn't know is refused with its path. Names are lowercase letters, digits and hyphens,
so none leaves the folder, and nothing is read or written through a symbolic link.
