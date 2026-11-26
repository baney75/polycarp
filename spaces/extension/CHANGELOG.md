# Changelog

## Unreleased

- Snooze and reminders in Polycarp Mail. H snoozes a conversation until later today, tomorrow morning, the weekend, next week or a time you pick; it leaves the inbox, G then H lists it, and new mail in it ends the snooze. W, on a conversation where you wrote last, asks for it back in a day, three days or a week if no one replies. Either way it returns at the top of the inbox under Back now, and opening it or pressing E clears that. Both live in this profile only; the account is never told.
- Polycarp Mail draws only the newest list it loaded, so switching views while an older list is still loading, such as G then D just after new mail arrives, no longer shows the inbox under the Drafts name.
- Rules in Polycarp Mail, written as plain lines: a search, then "then", then what to do, such as `list:almanac then keep with people` or `from:shop.example then mark read and archive`. A rule can archive, mark read, flag, put mail in a bundle or keep it with people. Edit rules in the command bar opens them; a line Polycarp can't read is named by its number and nothing saves until it is fixed. Bundle rules change the list at once; the rest act only on mail that arrives after the rules were saved, through the account, so mail already there, a newly added account's included, is never touched.
- A very long link text in HTML mail no longer stalls Polycarp Mail: the check for a site the text names reads it in one pass (200 KB of a.a.a took about 20 seconds before).
- HTML mail in Polycarp Mail shows behind two walls, so either alone still holds. DOMPurify 3.4.17 (bundled in lib with its license) keeps only inert markup, and the result is shown in a frame with no scripts, no shared origin and a content policy of default-src none that allows only inline styles and pictures carried in the mail. Pictures and styles from the web never load, so tracking pixels stay quiet, and the message says how many were left out. Every link shows its full address, opens in a new tab, and when its text names one site but it goes to another (even with a trailing dot, extra words, hidden or invisible letters, or a look-alike alphabet), the page says so above the message, where the mail's own styles can't hide it. Any HTML message can switch to its plain text.
- Unsubscribe in Polycarp Mail. A conversation from a mailing list offers Unsubscribe, and a dialog shows exactly what will be sent before anything is. When the list supports one-click unsubscribe (List-Unsubscribe-Post) and the mail is signed by the sender's own domain, Polycarp sends that one request for you, with no cookies, sign-in or referrer, and remembers it was sent. A list that asks for an email opens a draft you send; one that asks you to visit its page opens it in a new tab. Polycarp never follows a redirect with that request. An address that is plain http, written as numbers, or named as this machine or a home or office network gets no button; a public name that points at a private address can't be told apart, which is why the dialog shows the address first. Leaving a list with one account says nothing about another account on the same list.
- Search in Polycarp Mail looks through every stored message, its subject, people and whole text, and answers in under 50 ms over 100,000 messages. `from:`, `to:` and `subject:` look in one field; `in:`, `is:unread`, `is:flagged` and `has:attachment` narrow it; the word being typed matches as a start of a word. The command bar shows the first matches, and Return lists them all.
- Writing in Polycarp Mail. C starts new mail and R a reply under its conversation; what you type is kept as a draft in this profile, through a reload, and G then D lists drafts. Send (or Command Return) waits 10 seconds, and Z or Undo takes it back; the draft leaves only once the account takes the message, so a refused send stays in Drafts and says why. Closing the page during those 10 seconds asks first; if it closes anyway, the send goes when Mail opens again, and two open Mail pages send it once. A draft an agent wrote is marked in the list and says so when opened, and only your own Send sends it. Made-up mail is now dated in the past, so a reply sent now is the newest message.
- Polycarp Mail (src/pages/hub.html), the Hub's first page: one list for every account with unread mail from people first under "Needs you", then the rest by day, and newsletters, receipts, calendar and code notices folded into one line a day that opens as its own list. The bundle comes from the headers alone, and a thread you replied in stays with people. J and K move, Return opens, E archives, S flags, U marks read or unread, Z undoes, G then I, A or S goes to the inbox, Archive or Sent, and Command K or / opens a bar of commands and search. HTML-only mail shows as plain text for now, with nothing in it run or loaded. Under 760 px the list fills the page and a conversation opens over it. With no account the page offers made-up mail to try it; no page links to it yet.
- The Hub's store: mail from every account in one IndexedDB in this browser profile, grouped into threads by the provider's own thread id, then References and In-Reply-To in any order of arrival, then subject and people. Every account route implements one interface (list, threads, read, search, send, reply, archive, move, flag, mark read, attachments, changes since). A pull moves an account's cursor only after its mail is stored, and a change shows at once and goes back if the account refuses it. A made-up account, the same for a seed, stands in for real ones in tests. Nothing shows it yet.
- Sent lists every conversation you wrote in, by when you last wrote, wherever the rest of it is; archiving a conversation you answered puts it in Archive. Your own sent mail never moves to the inbox. The store moves to version 2 for this: the copy of account mail is dropped and fetched again on the next pull, and accounts and drafts stay.
- "Find ... with Polycarp" in the menu for chosen text opens the Polycarp app's launcher on it, while the app is there; never from a private window. The app can send a tab to the Reader or the library, as the page's menu does. Untested live.
- Opens a web app in a window of its own when Polycarp asks, and says which window is which app's. Kept in memory until the browser quits. Untested live.
- A download row says when the download finished, so the app can list it as done. Untested live.
- While a download runs, the app is told once a second how far it is, for the bar (with downloads switched on). Untested live.
- The app can be shown tab groups and move one to another window, once you switch it on in Settings and the browser grants the optional `tabGroups` permission. Untested live.
- The app can ask the browser for a site's icon (the browser's own copy, nothing loaded), and to open an address or a search with the browser's own engine in a window that isn't private. New permissions: `favicon` and `search`, which add no warning to what the browser already says of the extension. Untested live.
- The Polycarp app can know what this browser has open. A line to the app on this computer carries the open tabs (title, address, site, playing, pinned, which window), and bookmarks, the last 90 days of history and downloads when you switch them on in Settings > In the Polycarp app; the browser asks before each of those three. Nothing from a private window is sent, a download's folder never is, the app keeps it in memory only, and nothing is sent while the app isn't there. The app can ask the browser to go to a tab or show a download in Finder. `docs/newtab.md`, `spec/browser.md`. Untested live.
- A theme's font name CSS would not read unquoted, such as `Source Sans 3`, is quoted in the stylesheet; before, the browser dropped the whole stack. A page restored from the back/forward cache reads the theme again.
- What Polycarp draws on web pages (the page finder, the editor, the notice about an agent's edits, notes, feed filter lines, messages, strong text) takes the theme and restyles when it changes, with no reload. Under a theme of one mode those panels take that mode. The Reader on Auto does too; a paper or night surface picked by hand stays, and is there from the first paint.
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
