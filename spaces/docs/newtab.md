# The new tab page's host

Polycarp's new tab page is a small Chrome extension (`extension/newtab/`, ID `kdaddaaobomjfjcgjeabgbenfddkcfcl`, fixed
by the `key` in its manifest). It asks Polycarp what to show over Chrome native messaging. The host that answers is
the bundled command, `polycarp-spaces`. The code is `NewTabHost` in `Sources/BaneySpacesCore/NewTabHost.swift`.

## The page

One field whose placeholder is `newtab.question` ("Search or type an address"), and the day's verse (BSB) under it
when `newtab.verse` is on. Return opens what you typed when it is an address (`https://...`, `example.com`,
`localhost:3000`) and otherwise searches with `newtab.searchURL`. The page asks nothing and names nothing. The page paints the last answer it had first, so it is never blank while the host answers, and with no host at all it
still searches with DuckDuckGo. It loads nothing from the network. The field logic is `extension/newtab/logic.js`;
`NewTabPageTests` runs it in JavaScriptCore.

To load it in Helium (or Chrome): open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick
`/Applications/Polycarp.app/Contents/Resources/newtab-extension`. Polycarp writes the host manifest on its next launch.
A new tab opens with the keyboard in the address bar, as Chrome does for every extension's new tab; click the field to type there.

## What the host does

Chrome starts the host's `path` with the page's origin as the first argument
(`chrome-extension://kdaddaaobomjfjcgjeabgbenfddkcfcl/`). When `polycarp-spaces` sees a first argument that starts with
`chrome-extension://`, it runs the host before reading any other argument. `polycarp-spaces newtab-host` runs the same
host by name, for trying it by hand.

The host reads one request, writes one reply, and exits 0. It writes nothing else to stdout. With no whole request on
stdin it writes nothing and exits 1.

It reads surfaces.json from disk the way `polycarp-spaces surfaces get` does, so the app need not be running. It never
talks to the running app.

## The contract

Host name: `com.polycarp.newtab`. Framing is Chrome's: each message is a 4 byte native endian (little endian on a Mac)
unsigned length, then that many bytes of UTF-8 JSON, on stdin and on stdout. A request over 1 MiB is not read.

### `{"op":"page"}`

```json
{"ok": true, "question": "Search or type an address",
 "verse": {"text": "Be still, and know that I am God.", "ref": "Psalm 46:10"},
 "searchURL": "https://duckduckgo.com/?q={query}"}
```

- `question` and `searchURL` (the template, with `{query}` in it) are surfaces.json's `newtab.question` and
  `newtab.searchURL`.
- `verse` is the day's verse when `newtab.verse` is true: the same pick as the desktop's daily rotation
  (`Verses.pick(.daily, at:)`), so it changes at local midnight. Otherwise `null`.

### Anything else

`page` is the only request. An unknown `op` (the retired `name` and `go` included), a missing `op`, or a request that
isn't a JSON object gets `{"ok":false,"error":...}`.

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
registers nothing. `scripts/bundle.sh` copies the page itself to `Contents/Resources/newtab-extension`.

## Trying it by hand

Frame a request with python3 and pipe it in. The reply comes back framed too; `tail -c +5` drops its 4 length bytes:

```sh
python3 -c 'import sys,json,struct; m=json.dumps({"op":"page"}).encode(); sys.stdout.buffer.write(struct.pack("<I",len(m))+m)' \
  | polycarp-spaces newtab-host | tail -c +5; echo
```

The same works with `printf` for a fixed request: `{"op":"page"}` is 13 bytes, so its length is `\x0d\x00\x00\x00`:

```sh
printf '\x0d\x00\x00\x00{"op":"page"}' | polycarp-spaces newtab-host | tail -c +5; echo
```

To check what a browser will run, read its
manifest: `cat ~/Library/Application\ Support/net.imput.helium/NativeMessagingHosts/com.polycarp.newtab.json`.
