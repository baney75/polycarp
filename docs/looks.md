# Looks

A look is how Polycarp looks, as one file a friend can send you: the theme with its mode and accents.

```sh
polycarp look show friend.polycarp-look   # checked, and what it holds; nothing changes
```

Every command takes `--json` and answers as `polycarp theme` does (the same envelope and exit codes).

Error codes, beside the theme's: `invalid_look`.

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
so none leaves the folder, and nothing is read through a symbolic link.
