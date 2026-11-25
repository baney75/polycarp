# Looks

A look is how all of Polycarp looks, as one thing: the theme with its mode and accents, your `style.css`, how the
bar and the other surfaces are drawn, and the paper, in one file a friend can send you.

```sh
polycarp look export evening-desk ~/Desktop/evening-desk.polycarp-look
polycarp look import friend.polycarp-look   # checked and saved; nothing on screen changes
polycarp look show friend               # what it holds and leaves alone
```

Every command takes `--json` and answers as `polycarp theme` does (the same envelope and exit codes).

## Commands

| Command | What it does |
| --- | --- |
| `list` | The shipped look and yours |
| `show <name\|file\|->` | What a look holds and what it leaves alone |
| `export <name> <file\|-> [--force]` | Writes one file to share. `-` prints it |
| `import <file\|-> [--name N] [--force]` | Checks someone's look and saves it |

Yours are in `<config>/looks/`. `polycarp` is the shipped look: it can't be replaced.

Error codes, beside the theme's: `invalid_look`, `unknown_look`, `exists`, `builtin_read_only` (the name `polycarp`).

Without Polycarp Spaces (Linux, Windows) the theme part is checked, and the output says the rest waits for it.

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
  "accent": {"light": "#59693f", "dark": "#a9bb8a"},
  "style": "bar { border-radius: 6px; }\n",
  "surfaces": {"bar": {"height": 32, "style": "solid"}},
  "paper": {"all": {"picture": "<sha256>"}, "idle": "olive"},
  "pictures": {"<sha256>": {"type": "image/png", "base64": "..."}}
}
```

- `theme` is `{"builtin": name}`, or `{"document": {...}}`: a whole theme that extends nothing.
- `style` is a sheet's text, or `null` for none. `surfaces` holds only what isn't at its default.
- `paper` has `all`, `desktop`, `newtab` and `idle`: a `#RRGGBB` color, a scene, or a picture in `pictures`, named by
  its sha256. A picture is PNG, JPEG, HEIC or WebP, at most 25 MB (about 23 MB in practice, since the file holds it as
  base64).
- Leave out `style`, `surfaces` or `paper` and applying the look leaves that part as it is.

## What a look can't do

A look from a stranger may change only how things look. The list of settings it may hold is `FIELDS` in
`cli/src/look/fields.rs`, with a reason for each, and a test keeps it complete against
[surfaces.md](../spaces/docs/surfaces.md).

| In | Out, and dropped with a note |
| --- | --- |
| `bar.height`, `bar.style`, `bar.modules`, `bar.clockFormat`, `bar.hourNames` | `bar.enabled`; a `custom:` module |
| `desktop.scene`, `followDaylight`, `verse`, `versePosition`, `verseRotation` | an `image:` scene, which names a file |
| | `menu.*`, which could hide a control; `dock.*`, which went with the Workspace Dock |
| `newtab.verse` | `newtab.question`, `newtab.searchURL`, `search.engine` |
| `idle.style`, `idle.effects`, `idle.showVerse`, `idle.showKierkegaard` | `idle.enabled`, `idle.showMachineName`, `idle.startAfterMinutes` |
| | `text.*`, `rooms.*` |

Any key Polycarp doesn't know is refused with its path, as is a value that names a URL, a path or a command. Names are
lowercase letters, digits and hyphens, so none leaves the folder, and nothing is read or written through a symbolic link.
