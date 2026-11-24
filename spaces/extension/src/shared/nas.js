/* Polycarp NAS: connect the user's own NAS or home server over WebDAV.
   Works with Synology, QNAP, TrueNAS, Unraid (WebDAV container), Nextcloud, ownCloud and most others.
   Runs in extension pages and in the MV3 service worker: it uses only fetch, Blob, IndexedDB
   and chrome.storage, and parses WebDAV XML with regular expressions (no DOMParser, no XHR).

   All paths are relative to the connected folder (address + folder), written with "/",
   for example "Polycarp/Downloads/book.epub". "" is the connected folder itself.

   Privacy: the password never goes into a log, an error message or a backup. It is kept in
   chrome.storage.local only when the user asks Polycarp to remember it, otherwise in
   chrome.storage.session, which the browser clears when it closes.

   Polycarp never deletes the user's files. The one delete is backup pruning: old
   "polycarp-backup-YYYY-MM-DD.json" files that Polycarp itself wrote in Polycarp/Backups. */
(function () {
  "use strict";

  const KEY = "polycarp.nas";
  const PASS = "polycarp.nasPass";
  const ALARM = "polycarp-nas-backup";
  const DB_NAME = "polycarp-nas";
  const DOWNLOAD_DIR = "Polycarp/Downloads";
  const BACKUP_DIR = "Polycarp/Backups";
  const BACKUP_KEEP = 14;
  const BACKUP_RE = /^polycarp-backup-\d{4}-\d{2}-\d{2}\.json$/;

  const DEFAULTS = { url: "", user: "", folder: "", remember: false, lastIndexed: null, autoBackup: false, lastBackup: null };

  // ---------- Errors ----------
  const MSG = {
    config: "Connect your NAS first: add its WebDAV address in Settings.",
    password: "Polycarp needs your NAS password again. Enter it in Settings.",
    address: "That does not look like a web address. Try one like http://192.168.1.20:5005",
    insecure: "Use an https address for a NAS outside your home network. Plain http, which sends your password unencrypted, works only for home and private network addresses.",
    unreachable: "Polycarp could not reach your NAS at that address. Check the address, that this computer is on the same network as the NAS, and that WebDAV is turned on in the NAS settings.",
    auth: "Your NAS did not accept that user name or password.",
    forbidden: "That NAS account does not have permission to use this folder.",
    notWebdav: "That address answered, but not as a WebDAV folder. Check that WebDAV is turned on and that the address points to it. On a Synology, WebDAV usually uses port 5005 for http or 5006 for https.",
    cert: "The browser does not trust your NAS security certificate. Open the address once in a browser tab and choose to trust it, or use http on your home network.",
    notFound: "That folder or file was not found on your NAS.",
    exists: "A file with that name is already on your NAS.",
    full: "Your NAS is out of space.",
    tooBig: "Your NAS would not take a file that large.",
  };

  class NASError extends Error {
    constructor(code, message, status) {
      super(message || MSG[code] || "Something went wrong talking to your NAS.");
      this.name = "NASError";
      this.code = code;
      if (status) this.status = status;
    }
  }

  function statusError(res) {
    const s = res.status;
    if (s === 401) return new NASError("auth", null, s);
    if (s === 403) return new NASError("forbidden", null, s);
    if (s === 404 || s === 410) return new NASError("notFound", null, s);
    if (s === 405 || s === 501) return new NASError("notWebdav", null, s);
    if (s === 412) return new NASError("exists", null, s);
    if (s === 413) return new NASError("tooBig", null, s);
    if (s === 507) return new NASError("full", null, s);
    return new NASError("http", "Your NAS answered with an error (status " + s + ").", s);
  }

  // Private, link-local, loopback, Tailscale range and home network names.
  function isLocalHost(host) {
    const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!h) return false;
    if (h === "localhost" || h === "::1") return true;
    // Number ranges only for an IPv4 literal: "10.nas-provider.com" is a public name, not a home address.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      if (/^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
      let m = /^172\.(\d+)\./.exec(h); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
      m = /^100\.(\d+)\./.exec(h); if (m && +m[1] >= 64 && +m[1] <= 127) return true;
      return false;
    }
    if (/^(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/.test(h)) return true;
    // ts.net: Tailscale names, which ride the same encrypted tailnet as its 100.64/10 addresses.
    if (/\.(local|lan|home|internal|home\.arpa|localdomain|ts\.net)$/.test(h)) return true;
    return !h.includes(".") && !h.includes(":");
  }

  function netError(url, aborted) {
    if (aborted) return new NASError("unreachable", "Your NAS did not answer in time. " + MSG.unreachable);
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && isLocalHost(u.hostname)) return new NASError("cert");
    } catch (e) { /* fall through */ }
    return new NASError("unreachable");
  }

  // ---------- Storage ----------
  let memPass = null; // used only when chrome.storage.session is missing
  const session = () => (chrome.storage && chrome.storage.session) || null;

  async function readConf() {
    const o = await chrome.storage.local.get(KEY);
    return Object.assign({}, DEFAULTS, o[KEY] || {});
  }
  async function writeConf(c) {
    const keep = {};
    for (const k of Object.keys(DEFAULTS)) keep[k] = c[k] === undefined ? DEFAULTS[k] : c[k];
    await chrome.storage.local.set({ [KEY]: keep });
    return keep;
  }
  async function patchConf(p) { return writeConf(Object.assign(await readConf(), p)); }

  async function readPass() {
    const a = (await chrome.storage.local.get(PASS))[PASS];
    if (typeof a === "string") return a;
    const s = session();
    if (s) { const b = (await s.get(PASS))[PASS]; if (typeof b === "string") return b; }
    return memPass;
  }
  async function storePass(pass, remember) {
    const s = session();
    if (pass === null) {
      await chrome.storage.local.remove(PASS);
      if (s) await s.remove(PASS);
      memPass = null;
      return;
    }
    if (remember) {
      await chrome.storage.local.set({ [PASS]: pass });
      if (s) await s.remove(PASS);
      memPass = null;
    } else {
      await chrome.storage.local.remove(PASS);
      if (s) await s.set({ [PASS]: pass }); else memPass = pass;
    }
  }

  // ---------- Paths and URLs ----------
  function segs(p) { return String(p == null ? "" : p).split(/[\\/]+/).filter((s) => s && s !== "." && s !== ".."); }
  function join(a) { return a.join("/"); }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function normUrl(raw) {
    let u = String(raw || "").trim();
    if (!u) return { url: "", user: "", pass: "" };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
      let host = "";
      try { host = new URL("http://" + u).hostname; } catch (e) { throw new NASError("address"); }
      u = (isLocalHost(host) ? "http://" : "https://") + u;
    }
    let p;
    try { p = new URL(u); } catch (e) { throw new NASError("address"); }
    if (p.protocol !== "http:" && p.protocol !== "https:") throw new NASError("address");
    if (p.protocol === "http:" && !isLocalHost(p.hostname)) throw new NASError("insecure");
    const user = safeDecode(p.username), pass = safeDecode(p.password);
    p.username = ""; p.password = ""; p.hash = ""; p.search = "";
    return { url: p.href.replace(/\/+$/, ""), user, pass };
  }

  function absUrl(c, abs, dir) {
    const tail = abs.map(encodeURIComponent).join("/");
    return c.url + "/" + tail + (dir && tail ? "/" : "");
  }
  function urlFor(c, path, dir) { return absUrl(c, segs(c.folder).concat(segs(path)), dir); }
  function urlSegs(u) {
    try { return new URL(u).pathname.split("/").filter(Boolean).map(safeDecode); } catch (e) { return []; }
  }
  const sameSegs = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function basic(user, pass) {
    const b = new TextEncoder().encode(user + ":" + pass);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return "Basic " + btoa(s);
  }

  // The working context: config plus password. Never returned to callers.
  async function ctx(override) {
    const conf = await readConf();
    let url = conf.url, user = conf.user, folder = conf.folder, pass;
    if (override) {
      if (override.url !== undefined) { const n = normUrl(override.url); url = n.url; if (n.user && override.user === undefined) user = n.user; if (n.pass && override.password === undefined) pass = n.pass; }
      if (override.user !== undefined) user = String(override.user || "").trim();
      if (override.folder !== undefined) folder = join(segs(override.folder));
      if (override.password !== undefined) pass = String(override.password);
    }
    if (!url) throw new NASError("config");
    // An address saved before the https rule, or written by an old backup, is checked here too, before any password goes.
    let host = "";
    try { host = new URL(url).hostname; } catch (e) { throw new NASError("address"); }
    if (/^http:/i.test(url) && !isLocalHost(host)) throw new NASError("insecure");
    if (pass === undefined) pass = await readPass();
    if (user && (pass === null || pass === undefined)) throw new NASError("password");
    return { url, user, folder, pass: pass || "", key: url + "|" + folder };
  }

  async function dav(c, method, abs, o) {
    o = o || {};
    const url = absUrl(c, abs, o.dir);
    const headers = Object.assign({}, o.headers || {});
    if (c.user) headers.Authorization = basic(c.user, c.pass);
    const ac = new AbortController();
    const ms = o.timeout === undefined ? 20000 : o.timeout;
    const timer = ms ? setTimeout(() => ac.abort(), ms) : null;
    try {
      return await fetch(url, { method, headers, body: o.body, credentials: "omit", cache: "no-store", redirect: "follow", signal: ac.signal });
    } catch (e) {
      throw netError(url, ac.signal.aborted);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- WebDAV XML (regex parser, any namespace prefix) ----------
  const NS = "(?:[A-Za-z_][\\w.-]*:)?";
  function tagRe(name, flags) {
    return new RegExp("<" + NS + name + "\\b[^>]*?(?:/>|>([\\s\\S]*?)</" + NS + name + "\\s*>)", flags || "i");
  }
  const RE_HREF = tagRe("href"), RE_STATUS = tagRe("status"), RE_RTYPE = tagRe("resourcetype");
  const RE_COLL = new RegExp("<" + NS + "collection\\b", "i");
  const RE_LEN = tagRe("getcontentlength"), RE_MOD = tagRe("getlastmodified"), RE_TYPE = tagRe("getcontenttype");

  function decodeXml(s) {
    return String(s || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
        const k = e.toLowerCase();
        if (k[0] === "#") { const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : m; }
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k];
      });
  }
  const isOkStatus = (s) => /\s2\d\d(\s|$)/.test(" " + String(s || "").trim());

  function parseMultistatus(xml) {
    const out = [];
    const re = tagRe("response", "gi");
    let m;
    while ((m = re.exec(xml))) {
      const body = m[1] || "";
      const hm = RE_HREF.exec(body);
      if (!hm) continue;
      let props = "", any = false, p;
      const pre = tagRe("propstat", "gi");
      while ((p = pre.exec(body))) {
        any = true;
        const st = RE_STATUS.exec(p[1] || "");
        if (!st || isOkStatus(st[1])) props += p[1] || "";
      }
      if (!any) {
        const st = RE_STATUS.exec(body);
        if (st && !isOkStatus(st[1])) continue;
        props = body;
      }
      const val = (r) => { const x = r.exec(props); return x ? decodeXml((x[1] || "").trim()) : ""; };
      const rt = RE_RTYPE.exec(props);
      const mod = Date.parse(val(RE_MOD));
      out.push({
        href: decodeXml(hm[1].trim()),
        dir: !!(rt && rt[1] && RE_COLL.test(rt[1])),
        size: Number(val(RE_LEN)) || 0,
        modified: isFinite(mod) ? mod : null,
        type: val(RE_TYPE).split(";")[0].trim(),
      });
    }
    return out;
  }

  const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
    "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>";

  async function propfind(c, abs, depth, dir) {
    const res = await dav(c, "PROPFIND", abs, { dir, headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" }, body: PROPFIND_BODY });
    if (res.status !== 207) {
      if (res.ok) throw new NASError("notWebdav", null, res.status);
      throw statusError(res);
    }
    const text = await res.text();
    if (!new RegExp("<" + NS + "multistatus\\b", "i").test(text)) throw new NASError("notWebdav", null, res.status);
    return { rows: parseMultistatus(text), url: absUrl(c, abs, dir) };
  }

  // ---------- File kinds ----------
  const MIME = {
    epub: "application/epub+zip", pdf: "application/pdf", mobi: "application/x-mobipocket-ebook", azw3: "application/vnd.amazon.ebook",
    azw: "application/vnd.amazon.ebook", fb2: "application/x-fictionbook+xml", txt: "text/plain", md: "text/markdown", html: "text/html",
    htm: "text/html", json: "application/json", xml: "application/xml", csv: "text/csv", rtf: "application/rtf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", odt: "application/vnd.oasis.opendocument.text",
    zip: "application/zip", cbz: "application/vnd.comicbook+zip", mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", aac: "audio/aac",
    ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav", mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska",
    webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", djvu: "image/vnd.djvu",
  };
  const EXT_FOR_MIME = {
    "application/pdf": "pdf", "application/epub+zip": "epub", "application/zip": "zip", "application/x-zip-compressed": "zip",
    "application/x-mobipocket-ebook": "mobi", "application/vnd.amazon.ebook": "azw3", "application/x-fictionbook+xml": "fb2",
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/x-m4b": "m4b", "audio/ogg": "ogg",
    "audio/flac": "flac", "audio/wav": "wav", "video/mp4": "mp4", "video/webm": "webm", "text/plain": "txt", "text/markdown": "md",
    "text/html": "html", "application/json": "json", "text/csv": "csv", "application/rtf": "rtf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "image/png": "png", "image/jpeg": "jpg",
    "image/gif": "gif", "image/webp": "webp",
  };
  const KNOWN_EXT = new Set(Object.keys(MIME).concat(["7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "cbr", "tex", "bib", "xlsx", "pptx", "ods", "odp", "srt", "vtt"]));
  const BOOK = new Set(["epub", "mobi", "azw3", "azw", "fb2"]);
  const AUDIO_TRACK = new Set(["mp3", "m4a", "aac", "ogg", "opus", "flac", "wav"]);
  const VIDEO = new Set(["mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "mpg", "mpeg", "ts"]);

  function splitExt(name) {
    const m = /^(.+?)\.([A-Za-z0-9]{1,8})$/.exec(name);
    return m ? { base: m[1], ext: m[2].toLowerCase() } : { base: name, ext: "" };
  }
  const extOf = (name) => splitExt(name).ext;
  const guessType = (name) => MIME[extOf(name)] || "application/octet-stream";

  function kindOf(name, dir) {
    if (dir) return "audiobook"; // only audiobook folders are ever indexed as entries
    const e = extOf(name);
    if (BOOK.has(e)) return "book";
    if (e === "pdf") return "paper";
    if (e === "m4b" || AUDIO_TRACK.has(e)) return "audiobook";
    if (VIDEO.has(e)) return "video";
    return "file";
  }

  // ---------- Config API ----------
  async function getConfig() {
    const c = await readConf();
    const p = await readPass();
    return Object.assign(c, { hasPassword: typeof p === "string" && p.length > 0 });
  }

  // Accepts any of { url, user, password, folder, remember }. A password of null clears it.
  async function setConfig(patch) {
    patch = patch || {};
    const old = await readConf();
    const next = Object.assign({}, old);
    let pass;
    if (patch.url !== undefined) {
      const n = normUrl(patch.url);
      next.url = n.url;
      if (n.user && patch.user === undefined) next.user = n.user;
      if (n.pass && patch.password === undefined) pass = n.pass;
    }
    if (patch.user !== undefined) next.user = String(patch.user || "").trim();
    if (patch.folder !== undefined) next.folder = join(segs(patch.folder));
    if (patch.remember !== undefined) next.remember = !!patch.remember;
    if (patch.password !== undefined) pass = patch.password === null ? null : String(patch.password);

    const moved = next.url !== old.url || next.folder !== old.folder || next.user !== old.user;
    if (moved) { next.lastIndexed = null; made.clear(); await clearIndex(); }
    await writeConf(next);

    if (pass !== undefined) await storePass(pass, next.remember);
    else if (next.remember !== old.remember) { const cur = await readPass(); if (typeof cur === "string") await storePass(cur, next.remember); }
    return getConfig();
  }

  async function forget() {
    await chrome.storage.local.remove([KEY, PASS]);
    const s = session(); if (s) await s.remove(PASS);
    memPass = null;
    made.clear();
    if (chrome.alarms) await chrome.alarms.clear(ALARM);
    await dropDb();
  }

  async function isConfigured() { return !!(await readConf()).url; }

  // Never throws. Pass { url, user, password, folder } to try values before saving them.
  async function test(override) {
    try {
      const c = await ctx(override);
      await propfind(c, segs(c.folder), 0, true);
      return { ok: true, error: null, code: null };
    } catch (e) {
      const err = e instanceof NASError ? e : new NASError("unreachable");
      return { ok: false, error: err.message, code: err.code };
    }
  }

  // ---------- Files ----------
  const made = new Set(); // folders known to exist this session, per connection

  async function mkdirAbs(c, abs) {
    if (!abs.length) return;
    const key = c.key + "|" + join(abs);
    if (made.has(key)) return;
    let res = await dav(c, "MKCOL", abs, { dir: true });
    if (res.status === 409 || res.status === 404) {
      await mkdirAbs(c, abs.slice(0, -1));
      res = await dav(c, "MKCOL", abs, { dir: true });
    }
    if (!(res.ok || res.status === 405)) {
      // Some servers answer oddly for a folder that is already there. Check before failing.
      const e = await statAbs(c, abs).catch(() => null);
      if (!e || !e.dir) throw statusError(res);
    }
    made.add(key);
  }

  async function statAbs(c, abs) {
    try {
      const r = await propfind(c, abs, 0, false);
      const row = r.rows[0];
      if (!row) return null;
      const name = abs[abs.length - 1] || "";
      return { name, dir: row.dir, size: row.size, modified: row.modified, type: row.dir ? "folder" : row.type || guessType(name) };
    } catch (e) {
      if (e.code === "notFound") return null;
      throw e;
    }
  }

  function absOf(c, path) { return segs(c.folder).concat(segs(path)); }

  // Hides NAS system folders and dotfiles unless opts.all is true.
  async function list(path, opts) {
    const all = !!(opts && opts.all);
    const c = await ctx();
    const rel = segs(path);
    const { rows, url } = await propfind(c, absOf(c, path), 1, true);
    const self = urlSegs(url);
    const out = [], seen = new Set();
    let selfSeen = false;
    rows.forEach((r, i) => {
      let s;
      try { s = urlSegs(new URL(r.href, url).href); } catch (e) { return; }
      if (!selfSeen && sameSegs(s, self)) { selfSeen = true; return; }
      if (!selfSeen && i === 0 && rows.length > 1 && s.length < self.length + 1) { selfSeen = true; return; }
      const name = s[s.length - 1];
      if (!name || seen.has(name) || (!all && skipName(name))) return;
      seen.add(name);
      out.push({ name, path: join(rel.concat(name)), dir: r.dir, size: r.dir ? 0 : r.size, modified: r.modified,
        type: r.dir ? "folder" : r.type || guessType(name), kind: r.dir ? "folder" : kindOf(name, false) });
    });
    return out.sort(byFolderThenName);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  function byFolderThenName(a, b) { return (b.dir - a.dir) || collator.compare(a.name, b.name); }

  async function mkdir(path) {
    const c = await ctx();
    await mkdirAbs(c, absOf(c, path));
  }

  async function exists(path) {
    const c = await ctx();
    return !!(await statAbs(c, absOf(c, path)));
  }
  async function stat(path) {
    const c = await ctx();
    return statAbs(c, absOf(c, path));
  }

  async function readBody(res, onProgress, phase) {
    const total = Number(res.headers.get("content-length")) || 0;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!onProgress || !res.body) return { blob: await res.blob(), type };
    const reader = res.body.getReader();
    const parts = [];
    let loaded = 0;
    onProgress({ phase, loaded, total });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      onProgress({ phase, loaded, total });
    }
    return { blob: new Blob(parts, { type }), type };
  }

  // Returns a File (a Blob with a name) so importers can read the extension.
  async function get(path, opts) {
    opts = opts || {};
    const c = await ctx();
    const abs = absOf(c, path);
    if (!abs.length) throw new NASError("notFound");
    const res = await dav(c, "GET", abs, { timeout: 30000 });
    if (!res.ok) throw statusError(res);
    const { blob, type } = await readBody(res, opts.onProgress, "download");
    const name = abs[abs.length - 1];
    const t = type && type !== "application/octet-stream" ? type : guessType(name);
    return typeof File === "function" ? new File([blob], name, { type: t }) : new Blob([blob], { type: t });
  }

  // Never replaces a file unless opts.overwrite is true.
  async function putAt(c, abs, data, opts) {
    opts = opts || {};
    if (!abs.length) throw new NASError("address", "Give the file a name.");
    const name = abs[abs.length - 1];
    const body = typeof data === "string" ? new Blob([data], { type: guessType(name) }) : data;
    if (!body || typeof body.size !== "number") throw new NASError("http", "Polycarp can only save text or files to your NAS.");
    await mkdirAbs(c, abs.slice(0, -1));
    const headers = { "Content-Type": body.type || guessType(name) };
    if (!opts.overwrite) {
      if (await statAbs(c, abs)) throw new NASError("exists");
      headers["If-None-Match"] = "*";
    }
    const onProgress = opts.onProgress;
    if (onProgress) onProgress({ phase: "upload", loaded: 0, total: body.size });
    // fetch cannot report upload progress without HTTP/2 streaming; allow 50 KB/s at worst.
    const res = await dav(c, "PUT", abs, { body, headers, timeout: Math.max(60000, Math.ceil(body.size / 50)) });
    if (!res.ok) throw statusError(res);
    if (onProgress) onProgress({ phase: "upload", loaded: body.size, total: body.size });
    return { path: join(abs.slice(segs(c.folder).length)), size: body.size };
  }

  async function put(path, data, opts) {
    const c = await ctx();
    return putAt(c, absOf(c, path), data, opts);
  }

  // ---------- Safe names ----------
  function nameFromDisposition(cd) {
    if (!cd) return "";
    let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
    if (m) return safeDecode(m[2].trim().replace(/^"|"$/g, ""));
    m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
    return m ? m[1].replace(/\\(.)/g, "$1").trim() : "";
  }
  function nameFromUrl(href) {
    try { const s = new URL(href).pathname.split("/").filter(Boolean); return safeDecode(s[s.length - 1] || ""); } catch (e) { return ""; }
  }
  function cleanName(raw) {
    let s = String(raw || "").normalize("NFC")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ").trim()
      .replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
    if (s.length > 150) { const { base, ext } = splitExt(s); s = base.slice(0, 149 - ext.length).trim() + (ext ? "." + ext : ""); }
    return s;
  }
  // given name first, then Content-Disposition, then the URL; add an extension the content type implies.
  function pickName(o) {
    const fromCd = cleanName(nameFromDisposition(o.disposition));
    const fromUrl = cleanName(nameFromUrl(o.url || ""));
    let name = cleanName(o.given) || fromCd || fromUrl || "download";
    if (!KNOWN_EXT.has(extOf(name))) {
      const t = String(o.type || "").split(";")[0].trim().toLowerCase();
      const ext = EXT_FOR_MIME[t] || [fromCd, fromUrl].map(extOf).find((e) => KNOWN_EXT.has(e));
      if (ext) name += "." + ext;
    }
    return name;
  }
  function numbered(name, n) {
    if (n < 2) return name;
    const { base, ext } = splitExt(name);
    return base + " (" + n + ")" + (ext ? "." + ext : "");
  }

  // Writes the blob under folder with a name no file there uses yet.
  async function saveUnique(c, folder, name, blob, onProgress) {
    const dirAbs = absOf(c, folder);
    await mkdirAbs(c, dirAbs);
    let taken = new Set();
    try {
      const { rows, url } = await propfind(c, dirAbs, 1, true);
      for (const r of rows) { try { const s = urlSegs(new URL(r.href, url).href); taken.add((s[s.length - 1] || "").toLowerCase()); } catch (e) { /* skip */ } }
    } catch (e) { if (e.code !== "notFound") throw e; }
    for (let n = 1; n < 1000; n++) {
      const cand = numbered(name, n);
      if (taken.has(cand.toLowerCase())) continue;
      try {
        return await putAt(c, dirAbs.concat(cand), blob, { onProgress });
      } catch (e) {
        if (e.code !== "exists") throw e;
        taken.add(cand.toLowerCase());
      }
    }
    throw new NASError("exists", "That folder already has too many files with this name.");
  }

  async function saveUrl(url, opts) {
    opts = opts || {};
    let u;
    try { u = new URL(url); } catch (e) { throw new NASError("address", "That link is not a web address."); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new NASError("address", "Polycarp can only save http and https links.");
    const c = await ctx();
    let res;
    try { res = await fetch(u.href, { redirect: "follow", cache: "no-store" }); }
    catch (e) { throw new NASError("download", "Polycarp could not download that link. Check that it opens in a browser tab."); }
    if (!res.ok) throw new NASError("download", "The download failed: the site answered with status " + res.status + ".", res.status);
    const { blob, type } = await readBody(res, opts.onProgress, "download");
    const name = pickName({ given: opts.name, disposition: res.headers.get("content-disposition"), url: res.url || u.href, type });
    const typed = blob.type ? blob : new Blob([blob], { type: guessType(name) });
    return saveUnique(c, opts.folder == null ? DOWNLOAD_DIR : opts.folder, name, typed, opts.onProgress);
  }

  async function saveBlob(blob, opts) {
    opts = opts || {};
    if (!blob || typeof blob.size !== "number") throw new NASError("http", "Polycarp can only save files to your NAS.");
    const c = await ctx();
    const name = pickName({ given: opts.name || blob.name, type: blob.type });
    return saveUnique(c, opts.folder == null ? DOWNLOAD_DIR : opts.folder, name, blob, opts.onProgress);
  }

  // ---------- Index (IndexedDB "polycarp-nas") ----------
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "path" });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; res(d); };
      r.onerror = () => { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  function tx(stores, mode, fn) {
    return db().then((d) => new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      const r = fn(t);
      if (r && typeof r === "object" && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }
  async function clearIndex() {
    if (typeof indexedDB === "undefined") return;
    await tx(["files", "meta"], "readwrite", (t) => { t.objectStore("files").clear(); t.objectStore("meta").clear(); });
  }
  async function dropDb() {
    if (typeof indexedDB === "undefined") return;
    if (dbp) { try { (await dbp).close(); } catch (e) { /* already closed */ } dbp = null; }
    await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  }
  async function cachedFiles() { return (await tx(["files"], "readonly", (t) => t.objectStore("files").getAll())) || []; }
  async function indexInfo() { return (await tx(["meta"], "readonly", (t) => t.objectStore("meta").get("index"))) || null; }

  // NAS system and trash folders: Synology @eaDir, #recycle, #snapshot; QNAP @Recycle, .@__thumb;
  // macOS .Trashes and ._ files; Windows $RECYCLE.BIN; Linux lost+found.
  const SKIP_NAMES = new Set(["lost+found", "system volume information", "thumbs.db", "desktop.ini", "network trash folder", "temporary items", "recycle bin", "recycled"]);
  function skipName(name) { return /^[.@#$~]/.test(name) || SKIP_NAMES.has(name.toLowerCase()); }

  async function index(opts) {
    opts = opts || {};
    const limit = opts.limit || 5000, depth = opts.depth === undefined ? 6 : opts.depth;
    const onProgress = opts.onProgress;
    const c = await ctx();
    const files = [], queue = [{ path: "", d: 0 }];
    let folders = 0, truncated = false;
    while (queue.length && !truncated) {
      const { path, d } = queue.shift();
      let rows;
      try { rows = await list(path); }
      catch (e) { if (!path) throw e; continue; } // an unreadable subfolder is skipped, a broken root is an error
      folders++;
      for (const r of rows) {
        if (skipName(r.name)) continue;
        if (r.dir) { if (d < depth) queue.push({ path: r.path, d: d + 1 }); continue; }
        if (files.length >= limit) { truncated = true; break; }
        files.push({ name: r.name, path: r.path, size: r.size, modified: r.modified, type: r.type });
      }
      if (onProgress) onProgress({ folders, files: files.length, path });
    }

    // Folders of audio tracks become one audiobook entry; their tracks point to it.
    const byDir = new Map();
    for (const f of files) {
      if (!AUDIO_TRACK.has(extOf(f.name))) continue;
      const dir = f.path.split("/").slice(0, -1).join("/");
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    const records = files.slice();
    for (const [dir, tracks] of byDir) {
      if (tracks.length < 2) continue;
      tracks.sort((a, b) => collator.compare(a.name, b.name));
      for (const t of tracks) t.group = dir;
      const name = dir ? dir.split("/").pop() : (segs(c.folder).pop() || "Audio");
      records.push({ name, path: dir, dir: true, size: tracks.reduce((s, t) => s + t.size, 0),
        modified: Math.max(...tracks.map((t) => t.modified || 0)) || null, type: "folder", tracks: tracks.map((t) => t.path) });
    }

    const at = Date.now();
    await tx(["files", "meta"], "readwrite", (t) => {
      const st = t.objectStore("files");
      st.clear();
      for (const r of records) st.put(r);
      t.objectStore("meta").put({ key: "index", at, files: files.length, folders, truncated, base: c.key });
    });
    await patchConf({ lastIndexed: at });
    return { files: files.length, folders, truncated, at };
  }

  // ---------- Search ----------
  const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  function titleOf(name, dir) {
    const base = dir ? name : splitExt(name).base;
    return base.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim() || name;
  }

  async function search(q, limit) {
    limit = limit || 50;
    const ws = words(q);
    if (!ws.length) return [];
    const conf = await readConf();
    if (!conf.url) return [];
    const recs = await cachedFiles();
    const hits = [];
    for (const r of recs) {
      if (r.group !== undefined) continue;
      const pathF = fold(r.path).replace(/[_.]+/g, " ");
      if (!ws.every((w) => pathF.includes(w))) continue;
      const title = titleOf(r.name, r.dir);
      const nameF = fold(title);
      const nameWords = new Set(words(title));
      const inName = ws.filter((w) => nameF.includes(w)).length;
      const whole = ws.filter((w) => nameWords.has(w)).length;
      const score = (inName === ws.length ? 1000 : 0) + inName * 50 + whole * 10 + (nameF.startsWith(ws[0]) ? 5 : 0);
      hits.push({ r, title, score });
    }
    hits.sort((a, b) => (b.score - a.score) || (a.title.length - b.title.length) || collator.compare(a.title, b.title));
    return hits.slice(0, limit).map(({ r, title }) => {
      const parent = r.path.split("/").slice(0, -1).join("/");
      return {
        id: "nas:" + r.path,
        source: "nas",
        title,
        url: urlFor(conf, r.path, !!r.dir),
        snippet: "/" + parent,
        kind: kindOf(r.name, !!r.dir),
        readUrl: null,
        nasPath: r.path,
        size: r.size || 0,
        files: r.tracks ? r.tracks.slice() : [],
      };
    });
  }

  const searchSource = {
    id: "nas",
    name: "Your NAS",
    blurb: "Books, papers and audio on your own NAS or home server, from the last time Polycarp looked through it.",
    kind: "nas",
    search(q, opts) { return search(q, (opts && opts.limit) || 50); },
  };

  // ---------- Backups ----------
  async function backupNow() {
    const B = globalThis.PolycarpBackup;
    if (!B) throw new NASError("backup", "Polycarp could not build a backup here.");
    try {
      const c = await ctx();
      const json = B.stringify(await B.make());
      const name = B.fileName(new Date());
      const abs = absOf(c, BACKUP_DIR).concat(name);
      const r = await putAt(c, abs, new Blob([json], { type: "application/json" }), { overwrite: true });
      const pruned = await pruneBackups(c);
      await patchConf({ lastBackup: { at: Date.now(), ok: true, path: r.path, size: r.size, error: null } });
      return { path: r.path, size: r.size, pruned };
    } catch (e) {
      const msg = e instanceof NASError ? e.message : "The backup did not finish.";
      await patchConf({ lastBackup: { at: Date.now(), ok: false, path: null, size: 0, error: msg } }).catch(() => {});
      throw e instanceof NASError ? e : new NASError("backup", msg);
    }
  }

  // The only delete Polycarp ever sends: its own dated backup files in Polycarp/Backups, past the newest 14.
  async function pruneBackups(c) {
    const dirAbs = absOf(c, BACKUP_DIR);
    const { rows, url } = await propfind(c, dirAbs, 1, true);
    const mine = [];
    for (const r of rows) {
      if (r.dir) continue;
      let s;
      try { s = urlSegs(new URL(r.href, url).href); } catch (e) { continue; }
      const name = s[s.length - 1] || "";
      if (s.length === urlSegs(url).length + 1 && BACKUP_RE.test(name)) mine.push(name);
    }
    mine.sort().reverse();
    const gone = [];
    for (const name of mine.slice(BACKUP_KEEP)) {
      if (!BACKUP_RE.test(name)) continue;
      const res = await dav(c, "DELETE", dirAbs.concat(name));
      if (!res.ok && res.status !== 404) throw statusError(res);
      gone.push(name);
    }
    return gone;
  }

  async function setAutoBackup(on) {
    await patchConf({ autoBackup: !!on });
    if (chrome.alarms) {
      if (on) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
      else await chrome.alarms.clear(ALARM);
    }
    return getConfig();
  }

  // Call on service worker start: puts the daily alarm back if it went missing.
  async function ensureAlarm() {
    if (!chrome.alarms) return false;
    const c = await readConf();
    if (!c.autoBackup || !c.url) return false;
    if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
    return true;
  }

  // Wire into chrome.alarms.onAlarm in the service worker. Returns the backup result, or null when skipped.
  async function onAlarm(alarm) {
    if (!alarm || alarm.name !== ALARM) return null;
    const c = await readConf();
    if (!c.autoBackup || !c.url) return null;
    try { return await backupNow(); } catch (e) { return null; } // backupNow records the error in lastBackup
  }

  globalThis.PolycarpNAS = {
    getConfig, setConfig, forget, isConfigured, test,
    list, mkdir, get, put, exists, stat,
    saveUrl, saveBlob,
    index, indexInfo, cachedFiles, search, searchSource,
    backupNow, setAutoBackup, ensureAlarm, onAlarm,
    url: async (path, dir) => { const c = await readConf(); return c.url ? urlFor(c, path, dir) : null; },
    ALARM, DOWNLOAD_DIR, BACKUP_DIR, NASError,
    _parse: parseMultistatus, _pickName: pickName,
  };
})();
