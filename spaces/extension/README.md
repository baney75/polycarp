# Polycarp

Polycarp's browser extension makes any page easier to read and helps you remember what you read. It works on its own in Helium, Chrome and other Chromium browsers, with or without the Polycarp app. When Polycarp is installed on the same computer, the extension also joins it: the new tab (`newtab/`, see `../docs/newtab.md`) gets the day's verse and Polycarp's search settings, and the extension updates with the app. It takes every color, face, radius and duration from the Polycarp theme (`src/shared/theme.css`, written by `polycarp theme export css polycarp --surface browser`). With the app, the theme in force goes over it: `src/shared/core.js` checks the values the app sends and builds the rules, and `src/shared/theme-live.js` draws them on every page.

- **Read:** bold word anchors, reading fonts (Lexend, Atkinson Hyperlegible, OpenDyslexic), spacing, tints and a focus ruler on every site.
- **Reader:** web pages, PDF, EPUB, DOCX, Markdown, HTML, FB2 and text in a clean reader, with read-aloud and word highlighting, sprint mode and printing.
- **Remember:** key ideas and a warm-up guess before you read, recall breaks while you read, and spaced review afterward.
- **Library:** links, documents, audiobooks and notes that connect themselves, with a map, search, and export to Obsidian or Notion.
- **Search:** one box for your library, YouTube, Wikipedia, free book catalogs and any site, feed or catalog you add by pasting a link. Audible and Kindle libraries become searchable from their own pages, and a NAS can be browsed, indexed and used for downloads and backups.
- **Feed filters:** hide posts by word, pattern, account or kind (Shorts, promoted posts, reposts) on X, YouTube, Reddit, Hacker News, Bluesky, LinkedIn, Mastodon and other feeds. A hidden post shrinks to one line that says why, with a Show button. Add your own in Settings; with the Polycarp app, its filters (set there or by your agents) apply too, and can hide parts of a site by CSS selector.
- **Busy sites:** on YouTube, X and any page, Alt+Shift+S searches headings, links, media, a video's transcript or the posts you've scrolled past. Polycarp pauses for an hour or until tomorrow from the popup.

Every feature cites the research behind it, rated by strength, on the welcome page. Polycarp has no server and no account; see [PRIVACY.md](PRIVACY.md).

## Install and update

### On its own

Without the Polycarp app, load this folder (or a copy made with `scripts/stage.sh`) as an unpacked extension, as in
steps 1 and 2 below. Every feature works. The new tab searches with DuckDuckGo and shows no verse, since there is no
Polycarp to ask. Update by pulling the checkout; the extension reloads itself when `version_name` changes on disk.

### With Polycarp

The Polycarp app carries the extension: `scripts/bundle.sh` runs `scripts/stage.sh` into
`Polycarp.app/Contents/Resources/extension`, with the app's full version as the manifest's `version_name`.

1. Open `helium://extensions` (or `chrome://extensions`) and turn on Developer mode.
2. Click **Load unpacked**, press ⌘⇧G in the file picker (it won't open an app) and paste
   `~/Applications/Polycarp.app/Contents/Resources/extension`. This is the one step done by hand.
3. From then on, each app update updates the extension: every 15 minutes and at browser start, the extension compares the
   `version_name` on disk with the one running and reloads itself when they differ, unless a Reader, Library or other
   Polycarp page is open, or a Polycarp new tab is the tab in front of its window; it waits for those to close or
   move behind. A reload closes Polycarp's tabs, so only new tabs in the background are let go.

For work on the extension itself, load this folder instead.

```sh
sh scripts/stage.sh <dest> [version_name]   # the shipped copy: no tests, scripts, docs or dev pages; checks every file it names
sh scripts/stage.sh --store <dest>          # the Chrome Web Store copy (below)
```

### From the Chrome Web Store

`scripts/stage.sh --store <dest>` makes the copy for the Chrome Web Store. It differs from the app's copy in three ways:
it has no fixed `key`, since the store assigns the ID; it leaves out the new tab page, which stays with the Polycarp app
because a store new tab must keep the user's own search engine; and it asks for `nativeMessaging` only when the user
presses **Connect to the Polycarp app** in Settings. The store updates that copy, so its Settings shows no update
button. The Polycarp app's native messaging host must list the store item's ID in `allowed_origins` before the
connection works. The store refuses an upload whose `version` is not above the last one it took, so raise `version`
in `manifest.json` before each store upload; `version_name` alone is not enough.
`node tests/store-shots.mjs` makes the listing's screenshots (1280x800) and small promo tile (440x280) in
`tests/out/store` from the real pages, with a demo article written for them.

## Tests

The browser tests load the unpacked extension in headless Chromium through Playwright (`npm i -g playwright`, or set `POLYCARP_PLAYWRIGHT`).

```sh
node --test tests/*.test.mjs
node tests/pages.spec.mjs
node tests/reader.spec.mjs
node tests/importers.spec.mjs
node tests/library.spec.mjs
node tests/package.spec.mjs      # the staged copy installs, carries the app version and updates itself
node tests/store.spec.mjs        # the Chrome Web Store copy: no key, no new tab, optional app link, store updates
node tests/sites.spec.mjs        # YouTube, X, Audible and feed fixtures, finder and pause
node tests/filters.spec.mjs      # feed filters on X, YouTube, Reddit and Mastodon fixtures
node tests/filters-sync.spec.mjs # filters from the Polycarp app through a fake native host, and Settings
node tests/theme-live.spec.mjs   # the person's Polycarp theme on every page, through a fake native host
node tests/sources.spec.mjs      # Search sources against saved fixtures
node tests/nas.spec.mjs          # NAS against a local WebDAV fake
node --test tests/hub.test.mjs   # the Hub's model, store and account interface, with a made-up account
node tests/hub-store.spec.mjs    # the Hub's store on real IndexedDB matches the memory store
node tests/contact.mjs [piece]   # screenshots of every surface to tests/out/contact
node tests/store-shots.mjs       # the Chrome Web Store screenshots and promo tile to tests/out/store
node tests/voice.spec.mjs --deps <folder with playwright>   # downloads the Kokoro voice once
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/content` | The script that restyles pages, the page finder and the site helpers |
| `src/reader` | The Reader, importers, read-aloud, recall and print |
| `src/pages` | Welcome, Library, Review, Search and Settings |
| `src/hub` | The Hub (mail and messages in one place): its model, store and the one interface every account implements |
| `src/shared` | Settings, memory, library, search sources, NAS, sync and icons, shared by all pages |
| `lib` | Bundled third-party code, each with its license |
| `newtab` | The new tab page and its field logic |
| `docs/research` | The research notes behind the features |

## License

GPL-3.0-or-later, because the bundled eSpeak NG phonemizer is GPL-3.0. Fonts and other libraries keep their own licenses, next to each file.
