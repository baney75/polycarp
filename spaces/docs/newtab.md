# The new tab page's host

Polycarp's new tab page is part of the Polycarp browser extension (`extension/`, page in `extension/newtab/`, ID
`kdaddaaobomjfjcgjeabgbenfddkcfcl`, fixed by the `key` in `extension/manifest.json`; see `extension/README.md`). It asks Polycarp what to show over Chrome native messaging. The host that answers is
the bundled command, `polycarp-spaces`. The code is `NewTabHost` in `Sources/BaneySpacesCore/NewTabHost.swift`.

## The page

One field whose placeholder is `newtab.question` ("Search or type an address"), and the day's verse (BSB) under it
when `newtab.verse` is on. The field is one search with the launcher: Return does what the launcher's Return does with the
same words. A bang (`!yt cats`, `cats !yt`, `!claude a question`) goes where that bang goes, from the same table (the
built-ins plus yours from `bangs.json`); an agent bang opens a new chat with the question asked; a bang with no words
opens its site; a bang Polycarp doesn't list goes to DuckDuckGo with it. An address (`https://...`, `example.com`,
`localhost:3000`) opens. Anything else searches with `search.engine` (Google until chosen; see
[surfaces.md](surfaces.md) for how `newtab.searchURL` still counts). The page paints the last answer it had first (engine and bangs included), so it
is never blank while the host answers. With no host and nothing cached it searches with DuckDuckGo, and a bang goes to
DuckDuckGo, which knows the same ones. It loads nothing from the network. The field logic is `extension/newtab/logic.js`, the finder is
`extension/newtab/finder.js`; `NewTabPageTests` runs them in JavaScriptCore and checks they answer every input as
`OneSearch` (Swift) does. A `?` question (the launcher's ask-your-agent row) isn't on the page.

### The finder

As you type, a list under the field (`#finder`, at most seven rows) shows, in this order:

1. Open tabs and windows that match, from Polycarp's session engine (the host's `find`), and this browser's own tabs
   (`chrome.tabs`). Choosing one switches to it instead of opening the page twice: a tab in this browser is activated with
   `chrome.tabs`, and the new tab closes once that took; anything else (another browser's tab, a window, a terminal
   split) is brought forward by Polycarp (the host's `focus`, the path `polycarp-spaces focus` takes). A session row is
   paired with this browser's tab only when its `bundleID` is the `browser` the host reported, so the same page open in
   two browsers lists both. A tab closed since the list was drawn isn't switched to: Polycarp tries it, or Return's
   search goes instead, and the new tab stays.
2. Bang completions while a bang is being typed (`!y` lists `!yt` and the rest).
3. What Return does with the text: "Search Google for ...", "Open example.com", or "Ask Claude ...".

| Key | Does |
| --- | --- |
| Down or Control-N | The next row. |
| Up or Control-P | The row before. |
| Return | Opens the chosen row: the first one until you move, even when rows arrive after you stop typing. |
| Tab | Fills in the chosen bang, or the first bang listed, as `!yt `. |
| Esc | Clears the field. |

The page asks the host once typing pauses (60 ms), one `find` at a time; a reply for older text is dropped. With no host,
the list still shows this browser's tabs and the search, and the bangs from the last answer the page cached (none
before the host has ever answered).

To load it in Helium (or Chrome): open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick
`~/Applications/Polycarp.app/Contents/Resources/extension`. Polycarp writes the host manifest on its next launch. App
updates update the extension too: it reloads itself when the copy in the app has a new `version_name`.
A new tab opens with the keyboard in the address bar, as Chrome does for every extension's new tab; click the field to type there.

## Paper

The page can lie on a paper: a picture, a color or a scene behind the field and the verse. Set it with
`polycarp-spaces paper set <what> --on newtab` (or for every place at once); see
[surfaces.md](surfaces.md#paper-the-desktop-the-new-tab-and-the-idle-screen-in-one-command). The host sends it in the
`page` reply as `paper`; with no paper the key is left out and the page looks as it always did.

The page keeps the last paper in `chrome.storage.local` (`polycarpNewTabPaper`) and paints it before the host answers,
so a new tab never goes blank or flashes; a reply with no `paper` forgets it. Nothing is loaded from the network: a
picture comes inside the reply as a `data:` URL. Over a picture or a scene a soft scrim from the theme's background
sits under the words, and the verse sits on a panel of the theme's background, so both read on any picture. A scene is
drawn from the theme's own colors. The code is `extension/newtab/paper.js` and the `Paper` block of `newtab.css`;
`NewTabPageTests` runs `paper.js` in JavaScriptCore.

## What the host does

Chrome starts the host's `path` with the page's origin as the first argument
(`chrome-extension://kdaddaaobomjfjcgjeabgbenfddkcfcl/`). When `polycarp-spaces` sees a first argument that starts with
`chrome-extension://`, it runs the host before reading any other argument. `polycarp-spaces newtab-host` runs the same
host by name, for trying it by hand.

The host reads one request, writes one reply, and exits 0. It writes nothing else to stdout. With no whole request on
stdin it writes nothing and exits 1.

It reads surfaces.json and bangs.json from disk the way `polycarp-spaces surfaces get` does, so `page` needs no running
app. `find` and `focus` talk to the running app over its socket, the path `polycarp-spaces ls` and `focus` take; with
the app away they answer what they can (below).

## The contract

Host name: `com.polycarp.newtab`. Framing is Chrome's: each message is a 4 byte native endian (little endian on a Mac)
unsigned length, then that many bytes of UTF-8 JSON, on stdin and on stdout. A request over 1 MiB is not read.

### `{"op":"page"}`

```json
{"ok": true, "question": "Search or type an address",
 "verse": {"text": "Be still, and know that I am God.", "ref": "Psalm 46:10"},
 "searchURL": "https://www.google.com/search?q={query}",
 "engine": {"trigger": "g", "name": "Google", "url": "https://www.google.com/search?q={q}", "agent": false},
 "bangs": [{"trigger": "yt", "name": "YouTube", "url": "https://www.youtube.com/results?search_query={q}", "agent": false},
           {"trigger": "claude", "name": "Claude", "url": "https://claude.ai/new?q={q}", "home": "https://claude.ai/new", "agent": true}]}
```

- `question` is surfaces.json's `newtab.question`.
- `engine` is `search.engine` resolved against the bangs (`OneSearch.engine`): `trigger` (empty for an engine given as
  an address), `name`, `url` with `{q}` where the encoded words go, `home` when it has one, and `agent`.
- `bangs` is every bang in force, yours from `bangs.json` first, then the built-ins, each in the same shape, at most 500.
  Should the reply pass 1 MiB, it carries the built-ins alone.
- `searchURL` is the same engine as a template with `{query}`, for a page from before `engine`.
- `verse` is the day's verse when `newtab.verse` is true: the same pick as the desktop's daily rotation
  (`Verses.pick(.daily, at:)`), so it changes at local midnight. Otherwise `null`.
- `paper`, only when the page has one (`newtab.paper`, else `paper`): `{"color":"#RRGGBB"}`, `{"scene":"field"}`
  (`field`, `olive`, `water`, `parchment` or `solid`) or `{"image":"data:image/jpeg;base64,..."}`. A picture is sent as
  a JPEG at most 1920 pixels wide and under 700 KB, lower in quality and then smaller until it fits, so the reply stays
  under Chrome's 1 MB limit for a native message. The host makes that copy once, in `Papers/.newtab/`, and reads it
  after. A picture that is gone or won't decode is sent as no paper.

### `{"op":"find","q":"..."}`

```json
{"ok": true, "partial": false, "browser": "com.example.browser",
 "items": [{"id": "tab:com.example.browser:1:2", "kind": "tab", "title": "Inbox - Gmail", "app": "Browser",
            "bundleID": "com.example.browser", "activity": "shell", "detail": "mail.google.com/mail/u/0"},
           {"id": "win:5", "kind": "window", "title": "Notes about Gmail", "app": "Notes",
            "bundleID": "com.apple.Notes", "activity": "shell", "workspace": 3}]}
```

- The open tabs, windows, terminal splits and devices from the session engine that match `q`, best first
  (`OneSearch.sessions`, the launcher's ranking: a match must be a word or a prefix, not letters scattered through a
  title), at most seven. `activity` is `working`, `waiting` (an agent waiting on you) or `shell`; `detail` and
  `workspace` appear when they have a value.
- `browser` is the bundle ID of the browser that started the host (its parent process, the outermost `.app` on its
  path), left out when it can't be told.
- One request, one reply, under 1 MiB. The host waits at most 150 ms (`NewTabHost.findBudget`) for the app's list and
  answers with what it has: `partial` is true, with no items, when the app didn't answer in time or isn't running.
- A bang or blank `q` gets no items, and the app isn't asked. A missing `q`, or one over 512 characters, gets
  `{"ok":false,"error":...}`.

### `{"op":"focus","id":"..."}`

Brings a row from `find` forward, as `polycarp-spaces focus <id>` does: `{"ok":true,"label":"Inbox - Gmail"}`, or
`{"ok":false,"error":"Polycarp isn't running"}` (or the app's own reason). A missing `id` is an error.

### `{"op":"filters"}`

The feed filters and page edits in `filters.json` (beside `bangs.json`; `polycarp-spaces filters`, docs/guide.md),
each rule normalized with every key: `{"ok":true,"filters":[{"id":"no-shorts","enabled":true,"sites":["youtube.com"],
"words":[],"patterns":[],"accounts":[],"kinds":["shorts"],"hide":[]}]}`. No file is `{"ok":true,"filters":[]}`; a file
that doesn't read or check is `{"ok":false,"error":...}` naming the field. Each pattern compiled as an
NSRegularExpression and passed the slow-pattern rule in `Filters.pattern`; JavaScript's syntax differs at the edges, so
the extension still skips a pattern its `RegExp` refuses.

### Anything else

An unknown `op` (the retired `name` and `go` included), a missing `op`, or a request that isn't a JSON object gets
`{"ok":false,"error":...}`.

## Where the manifest goes

On launch the app writes `com.polycarp.newtab.json` into each of these browser folders that already exists, never
making a browser's own folder:

- `~/Library/Application Support/net.imput.helium/` (Helium)
- `~/Library/Application Support/Google/Chrome/`
- `~/Library/Application Support/Chromium/`

as `<that folder>/NativeMessagingHosts/com.polycarp.newtab.json`, making `NativeMessagingHosts` when it is missing:

```json
{"name": "com.polycarp.newtab", "description": "Polycarp's new tab page",
 "path": "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces",
 "type": "stdio", "allowed_origins": ["chrome-extension://kdaddaaobomjfjcgjeabgbenfddkcfcl/"]}
```

`path` is wherever the running app's bundled command is. The write happens off the main thread and only when the file's
content differs. trace.log gets one line: `newtab host: manifest written for Helium`, `already current for ...`,
`failed for ...`, or `no Helium, Chrome or Chromium folder, nothing registered`. A debug build (not in a .app)
registers nothing. `scripts/bundle.sh` stages the whole extension, page included, to `Contents/Resources/extension`.

## Trying it by hand

Frame a request with python3 and pipe it in. The reply comes back framed too; `tail -c +5` drops its 4 length bytes:

```sh
python3 -c 'import sys,json,struct; m=json.dumps({"op":"page"}).encode(); sys.stdout.buffer.write(struct.pack("<I",len(m))+m)' \
  | polycarp-spaces newtab-host | tail -c +5; echo
```

`{"op":"find","q":"gmail"}` the same way shows what the finder would list. The same works with `printf` for a fixed
request: `{"op":"page"}` is 13 bytes, so its length is `\x0d\x00\x00\x00`:

```sh
printf '\x0d\x00\x00\x00{"op":"page"}' | polycarp-spaces newtab-host | tail -c +5; echo
```

To check what a browser will run, read its
manifest: `cat ~/Library/Application\ Support/net.imput.helium/NativeMessagingHosts/com.polycarp.newtab.json`.
