# Polycarp privacy policy

Last updated: November 25, 2026

Polycarp is a browser extension that makes text easier to read and helps you remember it. It has no server and no account. Nothing you read, save or write is sent to the developer.

## What stays on your computer

Polycarp keeps all of this in your browser's own storage, on your device:

- Your settings, such as fonts, spacing and colors, and the sites where Polycarp is on or off.
- Your reading progress and reading stats.
- The ideas you choose to remember, and when each one is due for review.
- Your library: the pages, links, PDFs, ebooks, audio files and notes you add, with your highlights.
- The voice model for reading aloud, once you download it.
- The search index Polycarp builds for sources you add, and the lists of titles from libraries you make searchable (for example your Audible or Kindle library).
- Feed filters you set: the words, accounts and sites they cover.
- Page edits: the sites they cover and what they hide, restyle, reword, move or add there.
- Your NAS address and user name, if you connect one. The NAS password is kept only for this browser session unless you choose to remember it, and it is never written into a backup file.

Polycarp reads the text of the pages you visit so it can restyle them. That text is processed on your device and is not stored or sent anywhere, unless you save the page to your library or share it with your agent.

You can delete any item or note in your library at any time, reset your settings from Settings > Your data, or remove the extension, which deletes all of it.

## When Polycarp uses the network

Polycarp connects to other services only in these cases, each one started by you:

- **Opening a link in the Reader or saving it to your library.** Polycarp downloads that page or file from its own website, the same way your browser would.
- **Downloading a reading voice.** The first time you listen, Polycarp downloads the voice model (90 to 330 MB, depending on your computer) from Hugging Face (huggingface.co). Your text is never sent; the voice runs on your device.
- **Syncing with Notion.** If you connect Notion and press Sync, Polycarp sends the items and notes in your library to your own Notion workspace through the Notion API (api.notion.com), using the integration secret you created. The secret is stored on your device and is sent only to Notion. Nothing is sent until you press Sync. Notion's own privacy policy covers what Notion does with it.
- **Polycarp Search.** When you search, Polycarp sends what you typed to each source you have switched on: by default YouTube, Wikipedia, Project Gutenberg (through gutendex.com), Open Library and LibriVox, plus the Internet Archive, arXiv and OpenAlex if you turn them on. Each one receives only the search words, as if you searched on its own site. Your Polycarp library, the sources you add and your NAS are searched on your device.
- **Sources you add.** When you paste a link to make a site searchable, Polycarp reads that site, its feed or its catalog, and keeps the index on your device. If the site has its own search, Polycarp sends your search words to that site instead. For a whole site it reads up to 300 pages by default, one at a time, and follows the site's robots.txt.
- **Making a library searchable.** On a library page you are signed in to, such as Audible or Kindle, Polycarp reads the list of titles in your own tab when you press "Make this library searchable". Your sign-in never leaves that site. The list is stored on your device.
- **YouTube and X pages.** To show a video's transcript in the Reader, Polycarp reads the transcript YouTube already sends to your browser. To search posts on X, Polycarp reads the posts you have scrolled past in that tab. Nothing is kept unless you save it.
- **Your NAS.** If you connect a NAS or home server, Polycarp talks only to the address you gave, to list, open and save files and, if you turn it on, to write a daily backup. Outside your home network it requires an https address, so your NAS password is never sent unencrypted.
- **Pictures in search results and the library.** Video thumbnails and book covers load from the sites that host them: i.ytimg.com (YouTube), covers.openlibrary.org (Open Library) and archive.org (the Internet Archive). Your browser sends those sites the usual request for an image, as it would on their own pages.
- **The Polycarp app.** In the copy that comes with the Polycarp app, the extension and the app talk to each other on their own. In the Chrome Web Store copy, they talk only after you press Connect to the Polycarp app in Settings. Either way, the extension and the app talk to each other directly on your computer through your browser's native messaging. The app sends your feed filters, the page edits you or your agents keep there and the colors and fonts of your Polycarp theme, and to the copy that comes with it, the new tab's wallpaper and search settings. When you press Share with my agent in the popup, the extension sends the app that page's address without its query, its title, and an outline: the names, selectors and first words of its parts, which on some pages include messages you sent. Form fields, editors and what is in them are left out. The app keeps it on your computer for an hour, or until you press Stop sharing (the browser keeps the address and title as long, to show you), for the agents you connected to it with the files scope, web assistants such as claude.ai included; what an agent does with it is up to that agent. The extension itself sends none of this off your computer.
- **The new tab page (only in the copy that comes with the Polycarp app).** What you type there is matched against your open windows and tabs by the Polycarp app on your computer. Pressing Return on a web search sends your words to the search engine set in Polycarp, Google by default, or to DuckDuckGo if the app hasn't answered yet. The Chrome Web Store copy does not change your new tab page.

Exporting to Obsidian writes Markdown files to a folder you choose on your computer, or to a zip file you download. Nothing is uploaded.

Summaries and key ideas use the AI built into Chrome, which runs on your device, when your browser has it. Polycarp does not use any cloud AI service.

## What Polycarp never does

- It does not collect analytics, crash reports or usage data.
- It does not sell or share your data, or use it for advertising or credit decisions.
- It does not use or transfer your data for any purpose other than the features described here.
- It does not load code from the internet. All of its code ships inside the extension.

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements. Polycarp uses the data it handles only for the features described here.

## Children

Polycarp does not knowingly collect any data from anyone, including children, because it does not collect data at all.

## Changes

If this policy changes, the new version will be posted here with a new date, and Polycarp's "What is new" page will say so.

## Contact

Questions about this policy: open an issue at https://github.com/baney75/polycarp/issues.
