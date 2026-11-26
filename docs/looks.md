# Looks

A look is how all of Polycarp looks, as one thing: the theme with its mode and accents, your `style.css`, how the
bar and the other surfaces are drawn, and the paper. Save how everything looks now, try something else, come back,
or send yours to a friend as one file.

```sh
polycarp look save evening-desk --title "Evening desk"
polycarp look apply polycarp            # everything as Polycarp comes
polycarp look undo                      # back to how it was
polycarp look export evening-desk ~/Desktop/evening-desk.polycarp-look
polycarp look import friend.polycarp-look   # checked and saved; nothing on screen changes
polycarp look show friend               # what applying it would change, in plain words
polycarp look apply friend
```

Every command takes `--json` and answers as `polycarp theme` does (the same envelope and exit codes). Agents have
`look_list`, `look_show`, `look_save`, `look_apply`, `look_undo`, `look_export` and `look_import` in `polycarp mcp`.
In the Mac app it is Settings > Appearance > Looks.

## Commands

| Command | What it does |
| --- | --- |
| `list` | The shipped look and yours, with a `*` on the one in force. None is in force while the theme is off |
| `show <name\|file\|->` | What a look holds, what it would change and what it leaves alone |
| `save <name> [--title T] [--force]` | Keeps how everything looks now. `--force` replaces one of yours |
| `apply <name\|file\|-> [--dry-run]` | Puts a look on, all of it or none |
| `undo` | Back to how it was before the last apply. Undo again to come forward |
| `delete <name> [--force]` | Removes a saved look. The one in force needs `--force`; how things look doesn't change |
| `export <name> <file\|-> [--force]` | Writes one file to share. `-` prints it |
| `import <file\|-> [--name N] [--force]` | Checks someone's look and saves it |

Yours are in `<config>/looks/`. `polycarp` is the shipped look: it can be applied and undone, not replaced.

## Apply and undo

Everything is checked before anything changes: the theme by every theme rule, contrast included, the sheet by
`style check`, the settings by `surfaces validate`, and each picture by its own bytes. Then the theme, the sheet, the
settings and the paper change, in that order. If one fails, what changed is put back, and the error names the step
(`step_failed`). In the rare case that putting back fails too, the error is `stuck` and says what is left; `look undo`
tries again.

Before each apply the present state is kept in `<config>/looks/.history/`, the newest 10. A look puts on the parts it
has and leaves the others alone, and undo puts back only the theme and those parts, so a change made since to a part
the look didn't hold stays. A look that carries its own theme saves it among your themes under a free name, and
undo takes it away again unless you have edited it. Bar modules of your own (`custom:`) stay where they were, and a
sheet you wrote by hand is also kept in `style.css.bak`.

Error codes, beside the theme's: `invalid_look`, `unknown_look`, `exists`, `builtin_read_only` (the name `polycarp`),
`current_look`, `nothing_to_undo`, `step_failed`, `stuck`, `not_yours` (MCP only).

Without Polycarp Spaces (Linux, Windows) the theme part still works, and the output says the rest waits for it.

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
  its sha256. A picture is PNG, JPEG, HEIC or WebP, at most 25 MB. The file holds pictures as base64, so together
  they fit in about 23 MB; `save` names each picture and its size when they don't.
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
| | `text.*`, `rooms.*`, `tiling.*` |

A setting the installed Polycarp Spaces is too old to know is left out of `save` with a note naming it; `show` names
one that a look holds, and `apply` refuses that look. Any key Polycarp doesn't know is refused with its path, as is a
value that names a URL, a path or a command. Names are lowercase letters, digits and hyphens, so none leaves the
folder, and nothing is read or written through a symbolic link.
