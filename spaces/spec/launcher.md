# Launcher rules

What the launcher finds for what you type, and in what order. The macOS app's implementation is the
`LauncherMatch` module (`Sources/LauncherMatch/LauncherMatch.swift`), which uses Foundation only and
no Apple frameworks. Another platform either builds that module or ports it to these rules, then
passes the same ranking table (`Tests/LauncherMatchTests/RankingTableTests.swift`): every query
there must put its listed entry first.

Terms. **Entry**: one thing the launcher can find from memory: an app, a window (or tab or
terminal), a command, a workspace or a menu. **Name**: a string an entry answers to; an entry can
have several, each with a **cost** taken off its score. **Query**: what was typed. **Word** (of a
query): a run of non-space characters.

## Matching

### R-L1 Letters in order
A query word matches a name when each of its letters appears in the name in the same order, not
necessarily together ("sfr" matches "Safari"). Every query word must match the name, each on its
own and in any order ("set sys" matches "System Settings"). An empty query matches every entry with
score 0.

### R-L2 Case and accents never matter
Both sides are folded before matching: lowercase, accents dropped ("CAFÉ" matches "café notes").
Folding happens per character; ASCII needs no library call.

### R-L3 One typo in a long word
A query word of 4 letters or more that does not match by R-L1 still matches when it is at most one
edit from the start of some word of the name, counting a letter changed, added, dropped, or two
neighbors swapped (optimal string alignment distance 1 against a prefix of that word, the prefix
1 shorter to 1 longer than the query word). "safaru", "chorme", "slakc", "termimal" match.
Words of 3 letters or fewer are never forgiven.

## Scoring

Higher is better. These numbers are the contract; a port must use them as written.

### R-L4 A letter's bonus
Each letter of a name gets a bonus from the character before it:

| Before it | Bonus |
| --- | --- |
| Start of the name, or whitespace | 10 |
| A delimiter: `/ - _ . : , ; \| \ + &` | 9 |
| Any other non-letter, non-digit | 8 |
| lowercase then Uppercase, or a letter then a digit, or a digit then a letter | 7 |
| anything else | 0 |

A non-word character (whitespace, delimiter, symbol) itself has bonus 8. A word starts at each letter
or digit whose bonus is 7 or more; typos (R-L3) compare against these word starts.

### R-L5 A query word's score
The best placement of the word's letters in the name, found by dynamic programming over every
placement (not the first one found):

- Each matched letter scores 16 plus a bonus.
- The first matched letter's bonus counts twice, minus `min(position, 16) / 4` (integer division),
  so a match that starts later scores a little less.
- A letter right after the previous matched letter is in a run. Its bonus is the larger of its own
  bonus and the bonus of the letter that started the run, and at least 4.
- A letter after a gap gets its own bonus, and the gap costs 3 for its first skipped character
  plus 1 for each more.
- A word matched only by a typo (R-L3) scores `16 × (letters − 1) − 8`.

### R-L6 A name's score
The sum of its query words' scores, plus 40 when the whole folded name equals the folded query
(words joined by single spaces), minus `min(name length, 40) / 2`, so of two names matched alike the
shorter wins.

### R-L7 An entry's score
The best of its names' scores, each less that name's cost, plus the entry's boost (R-L10) when the
query is not empty.

### R-L8 Entries and their names

| Kind | Names (cost) |
| --- | --- |
| App | its display name (0) |
| Window | its title (0); app name, a space, then the title (0); its detail line, such as a path (20) |
| Command | its title (0) |
| Workspace n | "Workspace n" (0); "n" (0); each app with a window on it (25) |
| Menu | its title (0) |

### R-L9 Order
Highest score first. Ties go by kind (app, window, workspace, command, menu, the order of the
launcher's sections), then by the order the entries were added.

### R-L10 Boost
A platform may add a boost per entry (what you pick often). It applies only once something is typed;
with an empty query the launcher shows its own fixed list.

## Showing results

### R-L11 Top Hit
With something typed, the launcher's first row is the best entry by R-L9 across every kind,
under the section "Top Hit", and Return runs it. The other sections follow in their usual order, each
ranked by R-L9 and without the Top Hit row.

### R-L12 From memory, every keystroke
Apps, windows, commands, workspaces and menus are found from names prepared ahead (folded, bonuses
worked out) whenever the list changes, never per keystroke. The budget for scoring is 8 ms at p90 for
200 queries against 2,000 entries, built optimized as it ships (`LatencyTests`).

### R-L13 Timing, without the query
Each keystroke logs `launcher key->paint=<ms> results=<n>` to `timing.log`: from the key event to the
end of the frame that draws its list, and the number of rows. The first files for a query log
`launcher files first=<ms>`, from the key event to the end of the frame that shows them. The query
text, titles, names and paths are never logged.

### R-L14 Files stream in below, and never move your row
Files come from a disk search, so they arrive after the rows from memory, below them. A search
starts once typing pauses for 40 ms, and every keystroke stops the one in flight at once. Each batch
the search finds is ranked with what came before and shown as it comes. Rows at or above the one you
moved the selection to since your last keystroke never move:

- selection above the file rows, or not moved: the file rows take the newest ranking;
- selection on a file row: that row and the file rows above it stay; the rest fill in below;
- selection below the file rows: no file row is added or dropped.

Until a search finds something, the last search's files that still match stay up (`LateRows`,
pinned by `LateRowsTests`).
