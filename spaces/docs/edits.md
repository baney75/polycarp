# Page edits

Polycarp's browser extension can change web pages for you: hide parts, restyle them, reword them, move them, or add a note. You make edits in the browser, and the agents on your computer make them through Polycarp. Both kinds show in the extension's Settings, where you turn each one off or remove it.

An edit stays with the sites it names and applies each time you open them. It changes how a page looks and reads in your browser and nothing else. It can't click, type, submit a form, load anything from the network or run a script, and it leaves form fields, text editors, frames and stylesheet links alone. Agents never drive the browser through it.

## Where edits live

Agents' edits are in `edits.json`, beside `filters.json` in `~/Library/Application Support/Polycarp/`. The extension asks Polycarp for them through its native host, so they work on a Mac with Polycarp installed. The edits you make in the browser stay in the browser.

Open pages pick a change up within 30 seconds, new pages at once. The first time an agent's edit reaches a page, the page says so and offers Undo.

## From a terminal

```sh
polycarp-spaces edits set '{"id":"quiet-news","name":"Quiet news","sites":["news.example.com"],"paths":["/story/*"],
  "changes":[{"do":"hide","at":".promo"},{"do":"style","at":"article","style":{"font-size":"18px"}}]}'
polycarp-spaces edits set - < edit.json
polycarp-spaces edits ls
polycarp-spaces edits off quiet-news
polycarp-spaces edits rm quiet-news
polycarp-spaces edits reset        # every edit gone
```

`--json` prints the `{ok, data}` envelope. An agent on your computer runs the same commands.

## An edit

| Field | What it takes |
| --- | --- |
| `id` | 1 to 64 of a-z, 0-9 and `-`. `set` with an id in use replaces that edit. |
| `name` | What to call it, up to 80 characters. Optional. |
| `enabled` | `true` unless set `false`. |
| `sites` | 1 to 50 hosts. `example.com` covers its subdomains; `www.` is kept as written. |
| `paths` | Up to 50 paths such as `/home` or `/watch/*`, where `*` is anything. Empty is the whole site. |
| `changes` | Up to 50 changes, below. |
| `css` | A stylesheet for those pages, up to 20,000 characters. |

An edit needs at least one change or `css`. Each change names where it acts with `at`, a CSS selector, and what it does with `do`:

| `do` | Also takes | What it does |
| --- | --- | --- |
| `hide` | | Takes the part out of view. |
| `style` | `style`: `{property: value}` | Sets CSS properties. |
| `text` | `text`, `find` | Replaces the words, or only the words in `find`. |
| `attr` | `name`, `value` | Sets `alt`, `aria-label`, `dir`, `lang` or `title`. `null` removes it. |
| `move` | `to`, `where` | Moves the first match `before`, `after`, or inside `to` as its `first` or `last` part. |
| `insert` | `where`, `blocks` | Adds a note: `heading`, `text`, `list` and `link` blocks. Plain words, never HTML. |

`hide` and `insert` hold up best. A page that rebuilds itself, as web apps do, can undo a `move` or trip over one, and a part that holds a button, a field, a frame or an editor stays where it is.

Styles may not load anything, because a stylesheet that can load something can tell another site what is on the page. So `css` and style values may not hold a backslash, `url(`, `image(` or another function that loads, or any at-rule but `@media`, `@supports`, `@container`, `@keyframes`, `@layer` and `@starting-style`.

`edits.json` holds at most 100 edits and 256 KiB. A refusal names the field and writes nothing. The cases both Polycarp and the extension check are in [spec/edits.json](../spec/edits.json).
