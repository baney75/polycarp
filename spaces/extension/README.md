# Polycarp

Polycarp's browser extension makes any page easier to read, helps you remember what you read, and gives the browser Polycarp's new tab (`newtab/`, see `../docs/newtab.md`). It works in Helium, Chrome and other Chromium browsers. It takes every color, face, radius and duration from the Polycarp theme (`src/shared/theme.css`, written by `polycarp theme export css polycarp --surface browser`).

- **Read:** bold word anchors, reading fonts (Lexend, Atkinson Hyperlegible, OpenDyslexic), spacing, tints and a focus ruler on every site.
- **Reader:** web pages, PDF, EPUB, DOCX, Markdown, HTML, FB2 and text in a clean reader, with read-aloud and word highlighting, sprint mode and printing.
- **Remember:** key ideas and a warm-up guess before you read, recall breaks while you read, and spaced review afterward.
- **Library:** links, documents, audiobooks and notes that connect themselves, with a map, search, and export to Obsidian or Notion.
- **Search:** one box for your library, YouTube, Wikipedia, free book catalogs and any site, feed or catalog you add by pasting a link. Audible and Kindle libraries become searchable from their own pages, and a NAS can be browsed, indexed and used for downloads and backups.
- **Busy sites:** on YouTube, X and any page, Alt+Shift+S searches headings, links, media, a video's transcript or the posts you've scrolled past. Polycarp pauses for an hour or until tomorrow from the popup.

Every feature cites the research behind it, rated by strength, on the welcome page. Polycarp has no server and no account; see [PRIVACY.md](PRIVACY.md).

## Install and update

The Polycarp app carries the extension: `scripts/bundle.sh` runs `scripts/stage.sh` into
`Polycarp.app/Contents/Resources/extension`, with the app's full version as the manifest's `version_name`.

1. Open `helium://extensions` (or `chrome://extensions`) and turn on Developer mode.
2. Click **Load unpacked** and pick `~/Applications/Polycarp.app/Contents/Resources/extension`. This is the one step done by hand.
3. From then on, each app update updates the extension: every 15 minutes and at browser start, the extension compares the
   `version_name` on disk with the one running and reloads itself when they differ, unless a Reader, Library or other
   Polycarp page is open, or a Polycarp new tab is the tab in front of its window; it waits for those to close or
   move behind. A reload closes Polycarp's tabs, so only new tabs in the background are let go.

For work on the extension itself, load this folder instead.

```sh
sh scripts/stage.sh <dest> [version_name]   # the shipped copy: no tests, scripts, docs or dev pages; checks every file it names
```

## Tests

The browser tests load the unpacked extension in headless Chromium through Playwright (`npm i -g playwright`, or set `POLYCARP_PLAYWRIGHT`).

```sh
node --test tests/library.test.mjs tests/memory.test.mjs
node tests/pages.spec.mjs
node tests/reader.spec.mjs
node tests/importers.spec.mjs
node tests/library.spec.mjs
node tests/package.spec.mjs      # the staged copy installs, carries the app version and updates itself
node tests/sites.spec.mjs        # YouTube, X, Audible and feed fixtures, finder and pause
node tests/sources.spec.mjs      # Search sources against saved fixtures
node tests/nas.spec.mjs          # NAS against a local WebDAV fake
node tests/contact.mjs [piece]   # screenshots of every surface to tests/out/contact
node tests/voice.spec.mjs --deps <folder with playwright>   # downloads the Kokoro voice once
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/content` | The script that restyles pages, the page finder and the site helpers |
| `src/reader` | The Reader, importers, read-aloud, recall and print |
| `src/pages` | Welcome, Library, Review, Search and Settings |
| `src/shared` | Settings, memory, library, search sources, NAS, sync and icons, shared by all pages |
| `lib` | Bundled third-party code, each with its license |
| `newtab` | The new tab page and its field logic |
| `docs/research` | The research notes behind the features |

## License

GPL-3.0-or-later, because the bundled eSpeak NG phonemizer is GPL-3.0. Fonts and other libraries keep their own licenses, next to each file.
