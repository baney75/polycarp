# Rooms: the Baney Extended System in Polycarp

The [Baney Extended System](https://github.com/baney75/baney-extended-system) (BES) sorts everything by what it asks of
you, into five folders under one root:

| Folder | Room | Mark | What goes here |
| --- | --- | --- | --- |
| `0 Inbox` | Inbox | | Only what the machine could not decide. |
| `1 Do` | Do | `>` | Anything that asks something of you. |
| `2 Keep` | Keep | `<` | Your story and your records. |
| `3 Know` | Know | `=` | The world's knowledge you gathered. |
| `4 Let Go` | Let Go | `x` | Everything else, held until you empty it. |

Polycarp reads the same folders and files into them the way the `bes` command does. It never makes the rooms, never
asks you anything about them, and never deletes: it offers the rooms where you already look (the launcher, the menu
bar menu, and soon the dock) and does what you pick.

## Setting it up

1. Make the rooms with bes: `python3 -m bes init ~/BES`.
2. That's all, if your root is `~/BES`. Elsewhere, tell Polycarp:
   `polycarp-spaces surfaces set rooms.root /Volumes/Drive/BES`.

The rooms show once the root has `.bes/` or `0 Inbox/` in it. Settings (in `surfaces.json`, see [surfaces.md](surfaces.md)):

| Path | Default | What it does |
| --- | --- | --- |
| `rooms.root` | `"~/BES"` | The folder that holds the rooms. `~/` starts at your home folder. |
| `rooms.menu` | `true` | The Rooms section in the menu bar menu. |

## The launcher

- Type a room's name or its mark and that room is the first row: `inbox`, `do` or `>`, `keep` or `<`, `know` or `=`,
  `let go` or `x`. Return opens it in Finder. The Inbox row says how many items wait there. A bare number is never
  a room (`3` stays workspace 3), and a word that only starts like a room (`kno`, `xcode`) isn't one.
- Put `room:` and a room in what you type to search only that room's files: `room:know tax`, `tax room:kn`,
  `room:= syllabus`, `room:x`. The room is the first row and its files follow, up to 60, ranked as Files ranks them.
  A start of the name works when it is unique (`kn` is Know, `k` is Keep or Know). While the word is still ambiguous
  (`room:`, `room:k`) the launcher lists the rooms it could mean.

Speed: the rooms answer every keystroke from memory. Opening the launcher reads the root and lists the Inbox once.
`RoomsLauncherTests` holds both to budgets in `spec/speed.json` (`launcherRooms`): measured on rectory1 (M-series,
debug build), p90 0.04 ms a keystroke against a 0.2 ms budget, and 1.1 ms to read a root with 500 items waiting
against 6 ms.

## The menu bar menu

Below Show All Workspaces and Find, five rows: `Inbox (3)`, `Do`, `Keep`, `Know`, `Let Go`. Each opens its room in
Finder. An empty Inbox shows no count. The section is there only while the root is set up and `rooms.menu` is on.

## Filing, and undo

`Rooms.file(_:into:)` (`Sources/BaneySpacesCore/Rooms.swift`) moves files or folders into a room, the way `bes` moves:

- The name stays. A name the room already holds gets ` (2)`, ` (3)` and so on before its last extension, exactly as
  bes's `unique_path` does (`Paper.pdf` becomes `Paper (2).pdf`, a folder `Project` becomes `Project (2)`). Nothing is
  overwritten; nothing is deleted.
- A room folder that isn't there is made, and recorded so an undo removes it again once it is empty.
- What is already at the top of that room is left alone. A room itself, or the root, is never moved.
- Every move is appended to `ROOT/.bes/journal.jsonl` in bes's own format, one batch per drop:

  ```json
  {"id": "3f9c2a1b7e40", "batch": "a81d0c55e2f9", "ts": "2026-11-22T21:04:05-06:00", "op": "move", "from": "/Users/you/Downloads/Paper.pdf", "to": "3 Know/Paper.pdf", "rule": "polycarp:know", "made_dirs": []}
  ```

  Paths inside the root are relative to it and paths outside it are absolute, so a drive keeps a working journal
  wherever it mounts. If the journal can't be written, nothing moves.

So `bes undo ~/BES` reverses the last drop, and `bes undo ~/BES --last N` the last N moves, Polycarp's and bes's alike.
`RoomsTests.testBesUndoReversesAPolycarpDrop` runs the real `bes undo` against a temp root to prove it; point it at a
bes checkout with `BES_REPO` (it looks in `~/Projects/baney-extended-system` otherwise, and is skipped without one).

Polycarp does not rename what you file. Renaming to `YYYY-MM-DD Title (People).ext` stays with `bes sort`, which
works the Inbox; a file you put in a room yourself is your correction, and keeps the name you gave it.

## Dock tiles (ready, not yet wired)

`Rooms.dropHandler(_:)` is the drop action for a room tile:

```swift
let fileIntoKnow = Rooms.dropHandler(.know)   // ([URL]) -> Rooms.Filing, root read from surfaces.json at drop time
let filing = fileIntoKnow(urls)
Toast.show(filing.summary(.know), symbol: Room.know.symbol)   // "Filed 3 in Know", "Filed 2 in Keep, 1 could not move"
Trace.log("rooms: \(filing.summary(.know)) by dock drop")
```

Non-file URLs (a link dragged from a browser) are left out. A drop of local files takes milliseconds; one from another
drive copies first, so a drop handler that may see big drops calls it off the main thread and shows the toast on main.
The dock's generic drop support is being built separately; once a tile can take a drop with a closure of URLs, a room
tile passes this handler and draws `Room.symbol`, `Room.name` and, for the Inbox, `Rooms.count(.inbox)`.
