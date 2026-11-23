# Polycarp

Polycarp is a Chrome extension that makes any page easier to read and helps you remember what you read. It works in Chrome, Helium and other Chromium browsers.

![Polycarp on a web page: bold word anchors, a focus ruler and the toolbar popup](store/screenshots/1-any-page.jpg)

- **Read:** bold word anchors, reading fonts (Lexend, Atkinson Hyperlegible, OpenDyslexic), spacing, tints and a focus ruler on every site.
- **Reader:** web pages, PDF, EPUB, DOCX, Markdown, HTML, FB2 and text in a clean reader, with read-aloud and word highlighting, sprint mode and printing.
- **Remember:** key ideas and a warm-up guess before you read, recall breaks while you read, and spaced review afterward.
- **Library:** links, documents, audiobooks and notes that connect themselves, with a map, search, and export to Obsidian or Notion.
- **Search:** one box for your library, YouTube, Wikipedia, free book catalogs and any site, feed or catalog you add by pasting a link. Audible and Kindle libraries become searchable from their own pages, and a NAS can be browsed, indexed and used for downloads and backups.
- **Busy sites:** on YouTube, X and any page, Alt+Shift+S searches headings, links, media, a video's transcript or the posts you've scrolled past. Polycarp pauses for an hour or until tomorrow from the popup.

Every feature cites the research behind it, rated by strength, on the welcome page. Polycarp has no server and no account; see [PRIVACY.md](PRIVACY.md).

## Try it

1. Open `chrome://extensions` (or `helium://extensions`) and turn on Developer mode.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Open any article. Click the Polycarp icon to change the profile.

## Build the store package

```sh
sh scripts/build.sh            # writes dist/polycarp-<version>.zip and checks every file it names
node store/make-shots.mjs      # rebuilds the store screenshots and promo tiles
```

`store/listing.md` has every Web Store field, ready to paste.

## Tests

The browser tests load the unpacked extension in headless Chromium through Playwright (`npm i -g playwright`, or set `POLYCARP_PLAYWRIGHT`).

```sh
node --test tests/library.test.mjs tests/memory.test.mjs
node tests/pages.spec.mjs
node tests/reader.spec.mjs
node tests/importers.spec.mjs
node tests/library.spec.mjs
node tests/sites.spec.mjs        # YouTube, X, Audible and feed fixtures, finder and pause
node tests/sources.spec.mjs      # Search sources against saved fixtures
node tests/nas.spec.mjs          # NAS against a local WebDAV fake
node tests/contact.mjs [piece]   # screenshots of every surface to tests/out/contact
node tests/voice.spec.mjs --deps <folder with playwright>   # downloads the Kokoro voice once
```

## Layout

| Path | What it holds |
| --- | --- |
| `extension/src/content` | The script that restyles pages, the page finder and the site helpers |
| `extension/src/reader` | The Reader, importers, read-aloud, recall and print |
| `extension/src/pages` | Welcome, Library, Review, Search and Settings |
| `extension/src/shared` | Settings, memory, library, search sources, NAS, sync and icons, shared by all pages |
| `extension/lib` | Bundled third-party code, each with its license |
| `docs/research` | The research notes behind the features |

## License

GPL-3.0-or-later, because the bundled eSpeak NG phonemizer is GPL-3.0. Fonts and other libraries keep their own licenses, next to each file.
