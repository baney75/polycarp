/* The line to the Polycarp app on this computer: a native messaging port that stays open (spaces/docs/newtab.md), so the
   app's launcher can find this browser's tabs, and its bookmarks, recent history and downloads when the person switched
   those on, and go to the exact tab. Nothing from a private window is sent, nothing leaves the computer, and nothing is
   kept here: the rows are read from the browser when the app asks. */
(function (root) {
  "use strict";
  const HOST = "com.polycarp.newtab";
  const SOURCES = ["tabs", "groups", "bookmarks", "history", "downloads"];
  // What each needs from the browser; tabs come with the site access the extension has.
  const NEEDS = { tabs: [], groups: ["tabGroups"], bookmarks: ["bookmarks"], history: ["history"], downloads: ["downloads"] };
  const KEY = "polycarp.bridge"; // { tabs: true, groups: false, bookmarks: false, ... }: what this browser's Settings page allows
  const DEFAULTS = { tabs: true, bookmarks: false, history: false, downloads: false };
  const MOST = { tabs: 5000, groups: 500, bookmarks: 20000, history: 50000, downloads: 500 };
  const HISTORY_DAYS = 90;
  const PIECE = 500; // rows in a message, which the host caps at 1 MB
  const PIECE_BYTES = 700000;
  const CHANGED = 300; // changed rows in a message: an address of 2,048 and a title of 300 three-byte letters each still fit
  const WAIT = 250; // changes are gathered this long
  const cut = (s, n) => String(s || "").slice(0, n);
  const address = (u) => (String(u || "").length <= 2048 ? String(u || "") : "");
  const web = (u) => (/^https?:/i.test(String(u || "")) ? address(u) : ""); // never a file:// path or a browser page

  // ---------- Rows ----------
  // A row must say it is not private; one that can't say so is never made.
  function tabRow(t) {
    if (!t || t.incognito !== false || typeof t.id !== "number" || t.id < 0) return null;
    const row = { id: t.id, window: t.windowId, title: cut(t.title, 300), url: address(t.url || t.pendingUrl), incognito: false, front: !!t.active };
    if (t.audible && !(t.mutedInfo && t.mutedInfo.muted)) row.audible = true;
    if (t.pinned) row.pinned = true;
    if (typeof t.groupId === "number" && t.groupId >= 0) row.group = t.groupId;
    return row;
  }
  // A group doesn't say whether it is private; its window does.
  function groupRow(g, open) {
    if (!g || !open.some((w) => w.id === g.windowId)) return null;
    return { id: g.id, window: g.windowId, title: cut(g.title, 300) || "Tab group (" + g.color + ")", incognito: false };
  }
  function bookmarkRows(tree) {
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.url && /^https?:/i.test(n.url)) out.push({ id: String(n.id), title: cut(n.title, 300), url: address(n.url) });
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  }
  const historyRow = (h) => (web(h.url)
    ? { url: h.url, title: cut(h.title, 300), visits: h.visitCount || 0, last: Math.round(h.lastVisitTime || 0) } : null);
  function downloadRow(d) {
    if (!d || d.incognito !== false || d.byExtensionId) return null;
    const name = String(d.filename || "").split(/[\\/]/).pop(); // the file's name, never its folder
    if (!name) return null;
    return { id: d.id, title: cut(name, 300), url: web(d.finalUrl || d.url), incognito: false, state: d.state, received: d.bytesReceived || 0, total: d.totalBytes || -1 };
  }
  // Rows in messages no bigger than the host takes.
  function pieces(source, rows) {
    const out = [];
    let piece = [], size = 0;
    for (const r of rows.slice(0, MOST[source])) {
      const n = JSON.stringify(r).length * 3; // three bytes a character at the most that isn't an astral pair
      if (piece.length && (piece.length >= PIECE || size + n > PIECE_BYTES)) { out.push(piece); piece = []; size = 0; }
      piece.push(r);
      size += n;
    }
    out.push(piece);
    return out.map((p, i) => ({ op: "browser.rows", source, first: i === 0, last: i === out.length - 1, rows: p }));
  }

  // ---------- The line ----------
  function make(chrome, { later = (fn, ms) => setTimeout(fn, ms), now = () => Date.now() } = {}) {
    let port = null;
    let wanted = []; // what the app asked for
    let sending = []; // of those, what this browser gives
    let refused = false; // an app from before the line, or none on this computer: asked again at the next start
    const dirty = { tabs: new Map(), groups: false, bookmarks: false, history: new Map(), downloads: new Map() };
    let timer = false;
    const told = new Set(); // the tabs the app knows of: one that goes away is news only then

    const post = (m) => { try { if (port) port.postMessage(m); } catch (e) { /* it closed */ } };
    const has = async (perms) => !perms.length || await chrome.permissions.contains({ permissions: perms }).catch(() => false);
    async function allowed() {
      const set = { ...DEFAULTS, ...((await chrome.storage.local.get(KEY))[KEY] || {}) };
      const out = [];
      for (const s of SOURCES) if (set[s] === true && await has(NEEDS[s])) out.push(s);
      return out;
    }
    async function all(source) {
      if (source === "tabs") return (await chrome.tabs.query({})).map(tabRow);
      if (source === "groups") {
        const open = await openWindows();
        return (await chrome.tabGroups.query({})).map((g) => groupRow(g, open));
      }
      if (source === "bookmarks") return bookmarkRows(await chrome.bookmarks.getTree());
      if (source === "history") {
        const got = await chrome.history.search({ text: "", startTime: now() - HISTORY_DAYS * 86400000, maxResults: MOST.history });
        return got.map(historyRow);
      }
      return (await chrome.downloads.search({ orderBy: ["-startTime"], limit: MOST.downloads })).map(downloadRow);
    }
    async function send(source) {
      const rows = (await all(source)).filter(Boolean);
      if (source === "tabs") for (const r of rows) told.add(r.id);
      if (!sending.includes(source)) return; // switched off while it was read
      for (const m of pieces(source, rows)) post(m);
    }
    const openWindows = async () => (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter((w) => w.incognito === false);
    async function refresh() {
      const give = (await allowed()).filter((s) => wanted.includes(s));
      const before = sending;
      sending = give;
      listen();
      // Switched off here: the app drops what it held.
      for (const s of before) if (!give.includes(s)) post({ op: "browser.rows", source: s, first: true, last: true, rows: [] });
      for (const s of give) if (!before.includes(s)) await send(s).catch(() => {});
    }

    function connect() {
      if (port || refused) return;
      let p;
      try { p = chrome.runtime.connectNative(HOST); } catch (e) { refused = true; return; }
      port = p;
      let heard = false;
      p.onMessage.addListener((m) => {
        if (p !== port || !m) return;
        if (m.ok === false) { // "there is no request called browser.join": an app from before the line
          if (!heard) { refused = true; port = null; wanted = []; sending = []; try { p.disconnect(); } catch (e) { /* gone */ } }
          return; // a working app turning down one message leaves the line as it is
        }
        heard = true;
        Promise.resolve(take(m)).catch(() => {});
      });
      p.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError; // read, so the browser doesn't log it
        if (p !== port) return;
        port = null;
        wanted = []; sending = [];
        if (!heard && err && /not found|forbidden/i.test(String(err.message || err))) refused = true;
      });
      post({ op: "browser.join" });
    }
    async function start() { if (await has(["nativeMessaging"])) connect(); else stop(); }
    function stop() { const p = port; port = null; wanted = []; sending = []; if (p) try { p.disconnect(); } catch (e) { /* gone */ } }

    async function take(m) {
      if (m.op === "browser.want") {
        wanted = (Array.isArray(m.sources) ? m.sources : []).filter((s) => SOURCES.includes(s));
        sending = []; // the app may be a new one: all of it again
        return refresh();
      }
      if (m.op === "browser.away") { wanted = []; sending = []; return; }
      if (m.op === "browser.group" && Number.isInteger(m.group) && sending.includes("groups")) return move(m);
      if (m.op === "browser.go" && Number.isInteger(m.group) && sending.includes("groups")) {
        const [first] = await chrome.tabs.query({ groupId: m.group });
        if (first) return take({ op: "browser.go", tab: first.id });
      }
      if (m.op === "browser.go" && Number.isInteger(m.tab)) {
        const there = await chrome.tabs.get(m.tab);
        if (there.incognito !== false) return;
        const t = await chrome.tabs.update(m.tab, { active: true });
        if (t) await chrome.windows.update(t.windowId, { focused: true });
      }
      if (m.op === "browser.open") return open(m);
      if (m.op === "browser.icon" && typeof m.url === "string") return icon(m.url);
      if (m.op === "browser.show" && Number.isInteger(m.download) && sending.includes("downloads")) await chrome.downloads.show(m.download);
    }

    // The browser's own copy of a site's icon, as a PNG; nothing is loaded from the network.
    async function icon(url) {
      if (!sending.length || !/^https?:\/\//i.test(url) || url.length > 2048) return;
      const r = await fetch(chrome.runtime.getURL("/_favicon/?size=32&pageUrl=" + encodeURIComponent(url)));
      if (!r.ok) return;
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 49152) return;
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      post({ op: "browser.icon", url, png: btoa(s) });
    }
    // A tab group to another window, or one of its own, as it is: its name, its color, its order.
    async function move(m) {
      const open = await openWindows(), has = (id) => open.some((w) => w.id === id);
      const g = await chrome.tabGroups.get(m.group);
      if (!has(g.windowId) || (m.window !== "new" && !has(m.window)) || m.window === g.windowId) return;
      if (m.window !== "new") { await chrome.tabGroups.move(g.id, { windowId: m.window, index: -1 }); return; }
      const made = await chrome.windows.create({ focused: false });
      await chrome.tabGroups.move(g.id, { windowId: made.id, index: -1 });
      await chrome.tabs.remove(made.tabs[0].id); // the new window's own empty tab
    }
    // A new tab in a window that isn't private: an address, a search with this browser's engine, or its new tab page.
    async function open(m) {
      const url = typeof m.url === "string" && /^https?:\/\//i.test(m.url) ? m.url : undefined;
      const text = typeof m.text === "string" && m.text.trim() ? cut(m.text.trim(), 2000) : undefined;
      if (m.url !== undefined && !url) return;
      const windows = await openWindows();
      const named = windows.find((w) => w.id === m.window);
      if (Number.isInteger(m.window) && !named) return;
      const w = named || (m.window === "new" ? null : windows.find((x) => x.focused) || windows[0]);
      const opts = url ? { url } : {};
      let t;
      if (w) {
        t = await chrome.tabs.create({ windowId: w.id, active: true, ...opts });
        await chrome.windows.update(w.id, { focused: true });
      } else {
        const made = await chrome.windows.create({ focused: true, ...opts });
        t = made && made.tabs && made.tabs[0];
      }
      if (text && t) await chrome.search.query({ text, tabId: t.id });
    }

    // ---------- Changes ----------
    function soon() {
      if (timer) return;
      timer = true;
      later(() => { timer = false; flush().catch(() => {}); }, WAIT);
    }
    async function flush() {
      for (const source of ["tabs", "history", "downloads"]) {
        const d = dirty[source];
        if (!d.size) continue;
        const entries = [...d];
        d.clear();
        if (!sending.includes(source)) continue;
        const rows = [], gone = [];
        for (const [k, v] of entries) { if (v) rows.push(v); else gone.push(k); }
        for (let i = 0; i < Math.max(rows.length, gone.length); i += CHANGED) post({ op: "browser.change", source, rows: rows.slice(i, i + CHANGED), gone: gone.slice(i, i + CHANGED) });
      }
      if (dirty.groups) { dirty.groups = false; if (sending.includes("groups")) await send("groups"); }
      if (dirty.bookmarks) { dirty.bookmarks = false; if (sending.includes("bookmarks")) await send("bookmarks"); }
    }
    const mark = (source, key, row) => {
      if (!sending.includes(source)) return;
      if (source === "tabs") { if (row) told.add(key); else if (!told.delete(key)) return; }
      dirty[source].set(key, row || null);
      soon();
    };
    async function tabNow(id) {
      const t = await chrome.tabs.get(id).catch(() => null);
      // A private tab is nothing to this line, not even a number that went away.
      if (t && t.incognito !== false) return;
      mark("tabs", id, tabRow(t));
    }
    // The tabs of a window, when which one is in front changed.
    async function fronts(windowId) {
      for (const t of await chrome.tabs.query({ windowId }).catch(() => [])) { const r = tabRow(t); if (r) mark("tabs", r.id, r); }
    }
    const on = new Set();
    function listen() {
      const once = (source, fn) => { if (sending.includes(source) && !on.has(source)) { on.add(source); fn(); } };
      once("groups", () => {
        for (const e of ["onCreated", "onUpdated", "onMoved", "onRemoved"]) chrome.tabGroups[e].addListener(() => { dirty.groups = true; soon(); });
      });
      once("bookmarks", () => {
        const b = () => { dirty.bookmarks = true; soon(); };
        for (const e of ["onCreated", "onRemoved", "onChanged", "onMoved", "onImportEnded"]) if (chrome.bookmarks[e]) chrome.bookmarks[e].addListener(b);
      });
      once("history", () => {
        chrome.history.onVisited.addListener((h) => { const r = historyRow(h); if (r) mark("history", r.url, r); });
        chrome.history.onVisitRemoved.addListener((r) => {
          if (r.allHistory) { if (sending.includes("history")) post({ op: "browser.rows", source: "history", first: true, last: true, rows: [] }); dirty.history.clear(); }
          else for (const u of r.urls || []) if (web(u)) mark("history", u, null);
        });
      });
      once("downloads", () => {
        const one = async (id) => {
          const [d] = await chrome.downloads.search({ id }).catch(() => []);
          if (d && d.incognito !== false) return;
          mark("downloads", id, d ? downloadRow(d) : null);
        };
        chrome.downloads.onCreated.addListener((d) => one(d.id));
        chrome.downloads.onChanged.addListener((d) => one(d.id));
        chrome.downloads.onErased.addListener((id) => mark("downloads", id, null));
      });
    }
    // Added when the worker starts, as a worker's listeners must be; they do nothing until the app wants tabs.
    function listenTabs() {
      chrome.tabs.onCreated.addListener((t) => tabNow(t.id));
      chrome.tabs.onUpdated.addListener((id, c) => { if (["title", "url", "audible", "pinned", "mutedInfo", "groupId", "status"].some((k) => k in c)) tabNow(id); });
      chrome.tabs.onAttached.addListener((id) => tabNow(id));
      chrome.tabs.onReplaced.addListener((id, old) => { mark("tabs", old, null); tabNow(id); });
      chrome.tabs.onRemoved.addListener((id) => mark("tabs", id, null));
      chrome.tabs.onActivated.addListener((a) => fronts(a.windowId));
    }
    return { start, stop, connect, refresh, listenTabs, again: () => { refused = false; return start(); }, get open() { return !!port; }, get sending() { return [...sending]; } };
  }

  const api = { HOST, SOURCES, NEEDS, KEY, DEFAULTS, MOST, tabRow, groupRow, bookmarkRows, historyRow, downloadRow, pieces, make };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PolycarpBridge = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
