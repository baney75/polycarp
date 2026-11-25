# Changelog

## Unreleased

- Settings has "Match Polycarp's theme", on at first. Off, Polycarp's pages and panels go back to their own look at once. A backup holds the choice and not the theme.
- Every page of the extension (new tab, popup, Reader, Library, Search, Settings, Review, Welcome) follows the Polycarp theme in force, colors, faces, radii and durations, and changes with it while it is open: the app is asked on opening, on coming back to a page and every 30 seconds. The last theme is drawn before the page's first paint. A theme that is always light or always dark pins that mode, and the badge takes the theme's accent. With no app, no theme or the connection not granted, everything looks as it did.
- The stylesheet for a Polycarp theme is built here from the theme's values: only the names in `theme.css`, each checked by its kind, with all 13 colors of both modes or none of them. Nothing the app sends reaches a page as CSS text.
- `scripts/stage.sh --store` makes the Chrome Web Store copy: no fixed key, no new tab page, and the link to the Polycarp app only when the user connects it in Settings. A store install shows no update button, since the store updates it.
- A NAS outside the home network needs an https address, so its password is never sent unencrypted.
- The privacy policy lists every site Polycarp loads pictures from, the link to the Polycarp app, the new tab page and the Chrome Web Store Limited Use statement.
- Feed filters: hide posts by word, pattern, account or kind (Shorts, promoted posts, reposts) on X, YouTube, Reddit, Hacker News, Bluesky, LinkedIn, Mastodon and other feeds. A hidden post shrinks to one line that says why; Show brings it back for the rest of the visit.
- Words match whole words in any language, including Chinese, Japanese, Thai and other scripts written without spaces. A pattern that could freeze a page is refused, and Settings says why.
- Settings has a Feed filters section to add, switch off and delete your own filters. With the Polycarp app, its filters show there too, read-only, and reach open pages within 30 seconds, without a reload.
- Filters pause with the rest of Polycarp and stay off on sites where Polycarp is off.

## 2.0.0 (2026-11-22)

- The reading extension and Polycarp's new tab are one extension, named Polycarp, carried and updated by the Polycarp app. The earlier name, Phont, is gone.
- Every color, face, radius and duration comes from the Polycarp theme, in light and dark; the olive branch replaces the old mascot.
- Restoring a backup made under the earlier name brings its settings, memory garden and library across.
- Where Polycarp is off for a page, its content script sets no timer and no observer.
- A note being typed in the Library survives the page refreshing around it.

## 1.1.0 (2026-11-20)

- Phont Search: one box for your library, YouTube, Wikipedia, Project Gutenberg, Open Library and LibriVox, with the Internet Archive, arXiv and OpenAlex one switch away. Results open in the Reader or save to your library.
- Paste any link to make that site searchable: Phont finds its own search, feed, book catalog or sitemap, or reads the site (up to 300 pages, following robots.txt).
- On a library you sign in to, such as Audible or Kindle, press "Make this library searchable" and its titles join your search.
- Connect a NAS or home server over WebDAV: browse it, index its files for search, save downloads to it and keep a daily backup there.
- A page finder (Alt+Shift+S) on every site lists headings, links, images and video, and searches a YouTube video's transcript or the X posts you have scrolled past.
- Turning Phont off is quicker: pause for an hour or until tomorrow from the popup or Settings, turn it off everywhere, or switch off each site helper.
- The Reader keeps more of a page's pictures, video and audio, and shows a short note when an image can't load.
- Review offers to reword or let go of an idea you keep missing.

## 1.0.0 (2026-11-20)

First release.

- Bold word anchors, reading fonts, spacing, tints, a switch that stops animations, and a focus ruler on every site, with five starting profiles.
- Pages that block copying, use tiny text or hide in frames are opened up for reading.
- A Reader for web pages, PDF, EPUB, DOCX, Markdown, HTML, FB2 and text, with contents, saved place and printing.
- Read-aloud with word highlighting in natural Kokoro voices that run on the device (on the graphics card when it can), with an optional second voice for dialogue.
- Key ideas and a warm-up guess before reading, recall breaks while reading, and spaced review in a memory garden.
- A library of links, documents, audiobooks and notes that connects itself by shared ideas, people, sites and `[[links]]`, with a map, search, highlights and timestamped audio notes.
- Export to Obsidian (folder or zip) and sync to Notion on request.
- Text boxes and editors you type in are left alone, so typing never jumps or scrambles.
- The Reader shows the title, byline and chapter titles, follows your system's light or dark setting by default, reads right-to-left scripts, and opens very long books without a pause.
- Settings backups now include your library and notes; search finds `#tags` in notes too.
- Review explains each garden stage, and tapping a stage lists its ideas.
- Updates install through the Chrome Web Store; the welcome page lists what changed.
