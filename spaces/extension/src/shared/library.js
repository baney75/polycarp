/* Polycarp library: every document, saved link, audio file and note in one place, with notes,
   highlights and links between related items. Stored in IndexedDB ("polycarp-library").
   Classic script for extension pages and Node tests (call useMemoryStore() in tests). */
(function () {
  "use strict";

  const DB_NAME = "polycarp-library";
  const DB_VERSION = 1;
  const TEXT_CAP = 300000;
  const EXCERPT_LEN = 240;
  const TOP_TERMS = 40;
  const TOP_NAMES = 15;
  const TOPIC_MIN = 0.12;
  const KINDS = ["doc", "link", "audio", "note"];
  const SOURCES = ["pdf", "epub", "docx", "txt", "md", "html", "fb2", "web", "audio"];

  function makeId(prefix) {
    let r = "";
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") r = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    } catch (e) { /* fall through */ }
    if (!r) r = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return prefix + r;
  }

  function clone(v) {
    if (v == null || typeof v !== "object") return v;
    try { return structuredClone(v); } catch (e) { return Object.assign({}, v); }
  }

  // ---------- Storage backends ----------

  // A backend offers get, all, put, del and byIndex on the four stores.
  function idbBackend() {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
          if (!d.objectStoreNames.contains("notes")) d.createObjectStore("notes", { keyPath: "id" }).createIndex("itemId", "itemId", { unique: false });
          if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
          if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => { dbp = null; rej(r.error); };
      });
      return dbp;
    }
    function run(store, mode, fn) {
      return open().then(d => new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let out;
        if (req) req.onsuccess = () => { out = req.result; };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      }));
    }
    return {
      open,
      get: (s, k) => run(s, "readonly", st => st.get(k)),
      all: (s) => run(s, "readonly", st => st.getAll()).then(v => v || []),
      put: (s, v) => run(s, "readwrite", st => st.put(v)),
      del: (s, k) => run(s, "readwrite", st => st.delete(k)),
      byIndex: (s, i, v) => run(s, "readonly", st => st.index(i).getAll(v)).then(v2 => v2 || [])
    };
  }

  function memoryBackend() {
    const stores = { items: new Map(), notes: new Map(), blobs: new Map(), meta: new Map() };
    const keyOf = (s, v) => (s === "meta" ? v.key : v.id);
    // Blobs are kept by reference: some runtimes cannot clone them.
    const copy = (s, v) => (s === "blobs" ? Object.assign({}, v) : clone(v));
    return {
      open: () => Promise.resolve(true),
      get: async (s, k) => { const v = stores[s].get(k); return v === undefined ? undefined : copy(s, v); },
      all: async (s) => Array.from(stores[s].values()).map(v => copy(s, v)),
      put: async (s, v) => { stores[s].set(keyOf(s, v), copy(s, v)); },
      del: async (s, k) => { stores[s].delete(k); },
      byIndex: async (s, i, val) => Array.from(stores[s].values()).filter(v => v[i] === val).map(v => copy(s, v))
    };
  }

  let store = null;
  function backend() {
    if (!store) store = typeof indexedDB !== "undefined" ? idbBackend() : memoryBackend();
    return store;
  }
  function useMemoryStore() { store = memoryBackend(); idfMemo = null; }
  function open() { return backend().open().then(() => true); }

  // Writes run one at a time so read, change, write never races.
  let chain = Promise.resolve();
  function queue(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  // ---------- Change events ----------

  const listeners = new Set();
  let channel = null;
  function getChannel() {
    if (channel || typeof BroadcastChannel === "undefined") return channel;
    try {
      channel = new BroadcastChannel(DB_NAME);
      channel.onmessage = (e) => { idfMemo = null; deliver(e.data); };
      // Node keeps a process alive for an open channel; tests must still exit.
      if (typeof channel.unref === "function") channel.unref();
    } catch (e) { channel = null; }
    return channel;
  }
  function deliver(ev) {
    for (const fn of Array.from(listeners)) {
      try { fn(ev); } catch (e) { /* one bad listener should not stop the rest */ }
    }
  }
  function emit(type, id) {
    const ev = { type, id };
    deliver(ev);
    const ch = getChannel();
    if (ch) { try { ch.postMessage(ev); } catch (e) { /* closed */ } }
  }
  function onChange(fn) {
    listeners.add(fn);
    getChannel();
    return () => listeners.delete(fn);
  }

  // ---------- Text helpers ----------

  const STOP = new Set((
    "a about above after again against all almost also although always am among an and another any are aren't around as at " +
    "be became because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't " +
    "doing don't down during each either else enough etc even ever every few first for from further get gets getting given " +
    "goes going gone got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's " +
    "however i i'd i'll i'm i've if in instead into is isn't it it's its itself just last least less let's like likely made " +
    "make makes many may me might more most mostly much must mustn't my myself near neither never new next no nor not now of " +
    "off often on once one only onto or other others otherwise ought our ours ourselves out over own per perhaps quite rather " +
    "really same second several shall shan't she she'd she'll she's should shouldn't since so some something sometimes still " +
    "such than that that's the their theirs them themselves then there there's therefore these they they'd they'll they're " +
    "they've this those though three through thus to together too toward towards two under until up upon us usually very via " +
    "was wasn't way we we'd we'll we're we've well were weren't what what's whatever when when's where where's whether which " +
    "while who who's whole whom whose why why's will with within without won't would wouldn't yet you you'd you'll you're " +
    "you've your yours yourself yourselves called known means mean meant include includes including use used uses using " +
    "said say says see seen take takes taken typically generally particularly especially simply certain various " +
    "throughout across beyond along behind beside besides inside outside despite except plus versus whereas unless already " +
    "fewer lower higher larger smaller greater lesser able also just like even much many any each every still yet " +
    "thing things lot lots kind part parts time times year years day days people person place places way ways also another " +
    "four five six seven eight nine ten first second third later early earlier often become becomes came come comes " +
    "went go goes gone give gives gave put puts let lets around back long great good small large big little"
  ).split(/\s+/));

  // Plurals and short words the stemmer must leave alone.
  const KEEP = new Set((
    "news series species physics mathematics economics politics ethics always perhaps whereas its his has was does yes thus " +
    "less bias atlas canvas chaos lens gas bus plus process access success address princess mass class glass " +
    "dress cross boss loss moss kiss miss pass gross stress analysis basis crisis thesis axis oasis virus status census " +
    "campus focus bonus genus corpus versus nucleus radius stimulus fungus cactus sinus apparatus christmas paris texas " +
    "louis james charles"
  ).split(" "));

  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu;

  function tokenize(text) {
    const out = [];
    const s = String(text || "").normalize("NFKC");
    const m = s.match(WORD_RE);
    if (!m) return out;
    for (let w of m) {
      w = w.toLowerCase().replace(/’/g, "'").replace(/'s$/, "").replace(/'+$/, "");
      if (w) out.push(w);
    }
    return out;
  }

  function hasVowel(s) { return /[aeiouy]/.test(s); }
  function undouble(s) { return /([bdfgklmnprtvz])\1$/.test(s) && !/(ll|ss|zz)$/.test(s) ? s.slice(0, -1) : s; }

  // Conservative suffix folding: plurals, -ing and -ed. Short words come back unchanged.
  function stem(word) {
    let w = String(word || "").toLowerCase();
    if (w.length <= 3 || KEEP.has(w) || /[^a-z]/.test(w)) return w;
    if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
    if (/sses$/.test(w)) return w.slice(0, -2);
    if (/(xes|zes|ches|shes)$/.test(w) && w.length > 4) return w.slice(0, -2);
    if (/s$/.test(w) && !/(ss|us|is|ys|as|os)$/.test(w)) return w.slice(0, -1);
    if (/ing$/.test(w) && w.length >= 6) {
      const base = w.slice(0, -3);
      if (hasVowel(base) && base.length >= 3) return undouble(base);
      return w;
    }
    if (/ed$/.test(w) && w.length >= 5 && !/eed$/.test(w)) {
      const base = w.slice(0, -2);
      if (hasVowel(base) && base.length >= 3) return undouble(base);
    }
    return w;
  }

  function isTermWord(w) {
    return w.length >= 3 && !STOP.has(w) && !/^\p{N}/u.test(w) && /\p{L}/u.test(w);
  }

  // Top terms of a text as [[surface, weight]]. weight is 1 + ln(count); the surface is the
  // most common spelling, so stem(surface) gives the shared key between items.
  function terms(text, limit) {
    const n = limit || TOP_TERMS;
    const groups = new Map();
    let pos = 0;
    for (const w of tokenize(text)) {
      pos++;
      if (!isTermWord(w)) continue;
      const k = stem(w);
      if (!isTermWord(k)) continue;
      let g = groups.get(k);
      if (!g) { g = { count: 0, first: pos, forms: new Map() }; groups.set(k, g); }
      g.count++;
      g.forms.set(w, (g.forms.get(w) || 0) + 1);
    }
    const list = Array.from(groups.values()).sort((a, b) => b.count - a.count || a.first - b.first).slice(0, n);
    return list.map(g => {
      let best = "", bc = -1;
      for (const [f, c] of g.forms) if (c > bc || (c === bc && f.length < best.length)) { best = f; bc = c; }
      return [best, Math.round((1 + Math.log(g.count)) * 1000) / 1000];
    });
  }

  // Sentence split good enough for names and excerpts.
  function sentencesOf(text) {
    const M = globalThis.PolycarpMemory;
    if (M && typeof M.sentences === "function") {
      try { return M.sentences(text); } catch (e) { /* fall back */ }
    }
    return String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n+|(?<=[.!?])\s+(?=["“(]?[\p{Lu}\p{N}])/u).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  const NAME_JOIN = new Set("de du da von van der den la le of al bin ibn y".split(" "));
  const NOT_NAMES = new Set((
    "january february march april may june july august september october november december " +
    "monday tuesday wednesday thursday friday saturday sunday chapter section figure table page part"
  ).split(" "));
  const CAP_RE = /^[\p{Lu}][\p{L}\p{M}'’.]*$/u;

  // Named phrases: runs of two or more capitalized words, or one capitalized word seen 3+ times
  // that is not only ever at the start of a sentence. Returns [[phrase, count]].
  function names(text) {
    const src = String(text || "");
    const lowerSeen = new Set();
    for (const m of src.matchAll(/(^|[^\p{L}])([\p{Ll}][\p{L}\p{M}'’]*)/gu)) lowerSeen.add(m[2].toLowerCase());
    const multi = new Map();
    const single = new Map();
    function add(map, phrase, atStart) {
      const k = phrase.toLowerCase();
      let e = map.get(k);
      if (!e) { e = { phrase, count: 0, inner: 0 }; map.set(k, e); }
      e.count++;
      if (!atStart) e.inner++;
    }
    const clean = (w) => w.replace(/['’]s$/, "").replace(/[.'’]+$/, "");
    for (const sent of sentencesOf(src)) {
      const words = sent.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’.]*/gu) || [];
      // Title Case headings ("Light Reactions") are not names.
      const caps = words.filter(w => CAP_RE.test(w)).length;
      if (!/[.!?;:"”)]$/.test(sent) && words.length > 1 && caps / words.length >= 0.5) continue;
      let i = 0;
      while (i < words.length) {
        if (!CAP_RE.test(words[i])) { i++; continue; }
        // Collect a run of capitalized words, allowing joiners such as "de" or "of" inside it.
        const run = [];
        let j = i;
        while (j < words.length) {
          const w = words[j];
          if (CAP_RE.test(w)) { run.push({ w: clean(w), at: j }); j++; if (/[.]$/.test(w) && !/^\p{Lu}\.$/u.test(w)) break; continue; }
          if (NAME_JOIN.has(w) && j + 1 < words.length && CAP_RE.test(words[j + 1]) && run.length) { run.push({ w, at: j, join: true }); j++; continue; }
          break;
        }
        // Drop sentence openers and stopwords at the edges.
        while (run.length && (run[0].join || STOP.has(run[0].w.toLowerCase()) || NOT_NAMES.has(run[0].w.toLowerCase()) ||
          (run[0].at === 0 && lowerSeen.has(run[0].w.toLowerCase())))) run.shift();
        while (run.length && (run[run.length - 1].join || STOP.has(run[run.length - 1].w.toLowerCase()))) run.pop();
        const real = run.filter(r => !r.join);
        if (real.length >= 2) {
          add(multi, run.map(r => r.w).join(" "), run[0].at === 0);
        } else if (real.length === 1) {
          const w = real[0].w;
          const k = w.toLowerCase();
          if (w.length > 1 && !STOP.has(k) && !NOT_NAMES.has(k) && !lowerSeen.has(k)) add(single, w, real[0].at === 0);
        }
        i = Math.max(j, i + 1);
      }
    }
    const out = [];
    for (const e of multi.values()) out.push([e.phrase, e.count]);
    for (const e of single.values()) if (e.count >= 3 && e.inner > 0) out.push([e.phrase, e.count]);
    return out.sort((a, b) => b[1] - a[1] || b[0].split(" ").length - a[0].split(" ").length).slice(0, TOP_NAMES);
  }

  // Cosine of two sparse vectors given as objects, Maps or [[key, weight]] arrays.
  function toMap(v) {
    if (v instanceof Map) return v;
    const m = new Map();
    if (Array.isArray(v)) { for (const [k, w] of v) m.set(k, (m.get(k) || 0) + Number(w)); }
    else if (v) { for (const k of Object.keys(v)) m.set(k, Number(v[k])); }
    return m;
  }
  function cosine(a, b) {
    const A = toMap(a), B = toMap(b);
    let dot = 0, na = 0, nb = 0;
    for (const [k, w] of A) { na += w * w; const x = B.get(k); if (x) dot += w * x; }
    for (const w of B.values()) nb += w * w;
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;
  function normalizeUrl(u) {
    const s = String(u || "").trim();
    if (!s) return "";
    let url;
    try { url = new URL(s); } catch (e) { return s; }
    url.hash = "";
    const keep = [];
    for (const [k, v] of url.searchParams) if (!TRACKING.test(k)) keep.push([k, v]);
    const qs = keep.length ? "?" + new URLSearchParams(keep).toString() : "";
    let p = url.pathname.replace(/\/+$/, "");
    if (!/^(https?|ftp):$/.test(url.protocol) && !url.host) return url.protocol + p + qs;
    return url.protocol + "//" + url.host.toLowerCase() + p + qs;
  }
  function domainOf(u) {
    try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
  }

  function wikilinks(text) {
    const out = [];
    for (const m of String(text || "").matchAll(/\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*?))?\]\]/g)) {
      const target = m[1].trim();
      if (target) out.push({ target, alias: (m[2] || "").trim() });
    }
    return out;
  }

  function tagsIn(text) {
    const seen = new Set();
    for (const m of String(text || "").matchAll(/(^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}_\-/]*\p{L}[\p{L}\p{N}_\-/]*)/gu)) {
      seen.add(m[2].toLowerCase());
    }
    return Array.from(seen);
  }

  function countWords(s) { return (String(s || "").match(WORD_RE) || []).length; }

  // First ~240 characters of real prose: skips headings, bylines and short fragments.
  function excerptOf(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n").map(l => l.replace(/\s+/g, " ").trim());
    const prose = lines.filter(l => countWords(l) >= 8 && /[.!?;:,"”)]/.test(l) && !/^#/.test(l)).join(" ");
    const base = prose || lines.filter(Boolean).join(" ");
    if (base.length <= EXCERPT_LEN) return base;
    const cut = base.slice(0, EXCERPT_LEN + 1);
    const sentEnd = cut.lastIndexOf(". ");
    if (sentEnd > EXCERPT_LEN * 0.6) return cut.slice(0, sentEnd + 1);
    const sp = cut.lastIndexOf(" ");
    return cut.slice(0, sp > 40 ? sp : EXCERPT_LEN).replace(/[,;:\s]+$/, "") + "…";
  }

  function htmlToText(html) {
    return String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|h\d|div|blockquote|dd|dt|pre|tr|section|article)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function titleFromFile(name) {
    return String(name || "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // ---------- Items ----------

  function indexFields(item) {
    const t = String(item.title || "");
    const body = t + "\n\n" + t + "\n\n" + String(item.text || "");
    item.terms = terms(body);
    item.names = names(String(item.text || ""));
  }

  function buildItem(fields, now) {
    const f = fields || {};
    const kind = KINDS.indexOf(f.kind) >= 0 ? f.kind : "doc";
    const text = String(f.text || "").slice(0, TEXT_CAP);
    let title = String(f.title || "").trim();
    if (!title && kind === "note") title = (text.split("\n").map(l => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "Untitled note").slice(0, 120);
    if (!title && f.url) title = domainOf(f.url) || String(f.url);
    if (!title) title = "Untitled";
    let source = SOURCES.indexOf(f.source) >= 0 ? f.source : "";
    if (!source) source = kind === "audio" ? "audio" : kind === "link" ? "web" : kind === "note" ? "md" : (f.url && /^https?:/i.test(f.url) ? "web" : "txt");
    const tags = new Set((Array.isArray(f.tags) ? f.tags : []).map(t => String(t).replace(/^#/, "").trim().toLowerCase()).filter(Boolean));
    if (kind === "note") for (const t of tagsIn(text)) tags.add(t);
    const item = {
      id: f.id || makeId("i_"),
      kind, title,
      author: String(f.author || ""),
      url: String(f.url || ""),
      docKey: String(f.docKey || ""),
      source, text,
      excerpt: f.excerpt ? String(f.excerpt).slice(0, 400) : excerptOf(text),
      tags: Array.from(tags),
      created: typeof f.created === "number" ? f.created : now,
      updated: typeof f.updated === "number" ? f.updated : now,
      words: countWords(text),
      duration: Number(f.duration) || 0,
      position: Number(f.position) || 0,
      blobId: String(f.blobId || ""),
      mime: String(f.mime || ""),
      size: Number(f.size) || 0,
      domain: f.url ? domainOf(f.url) : "",
      terms: [], names: []
    };
    indexFields(item);
    return item;
  }

  async function addItemImpl(fields) {
    const item = buildItem(fields, Date.now());
    await backend().put("items", item);
    idfMemo = null;
    emit("item:add", item.id);
    return item;
  }

  async function updateItemImpl(id, patch) {
    const cur = await backend().get("items", id);
    if (!cur) return null;
    const p = Object.assign({}, patch || {});
    delete p.id; delete p.created; delete p.terms; delete p.names; delete p.words; delete p.domain;
    const next = Object.assign({}, cur, p);
    const textChanged = "text" in p && String(p.text || "") !== cur.text;
    const titleChanged = "title" in p && String(p.title || "") !== cur.title;
    if ("text" in p) {
      next.text = String(p.text || "").slice(0, TEXT_CAP);
      next.words = countWords(next.text);
      if (!("excerpt" in p)) next.excerpt = excerptOf(next.text);
      if (next.kind === "note") next.tags = Array.from(new Set((next.tags || []).concat(tagsIn(next.text))));
    }
    if ("url" in p) next.domain = next.url ? domainOf(next.url) : "";
    if (Array.isArray(p.tags)) next.tags = Array.from(new Set(p.tags.map(t => String(t).replace(/^#/, "").trim().toLowerCase()).filter(Boolean)));
    if (textChanged || titleChanged) indexFields(next);
    next.updated = typeof p.updated === "number" ? p.updated : Math.max(Date.now(), cur.updated + 1);
    await backend().put("items", next);
    if (textChanged || titleChanged) idfMemo = null;
    emit("item:update", id);
    return next;
  }

  async function getItem(id) { return (await backend().get("items", id)) || null; }
  async function allItems() { return backend().all("items"); }

  async function itemByDocKey(key) {
    if (!key) return null;
    return (await allItems()).find(i => i.docKey === key) || null;
  }
  async function itemByUrl(url) {
    const n = normalizeUrl(url);
    if (!n) return null;
    return (await allItems()).find(i => i.url && normalizeUrl(i.url) === n) || null;
  }

  async function removeItemImpl(id) {
    const cur = await backend().get("items", id);
    const notes = await backend().byIndex("notes", "itemId", id);
    for (const n of notes) await backend().del("notes", n.id);
    if (cur && cur.blobId) await backend().del("blobs", cur.blobId);
    await backend().del("items", id);
    idfMemo = null;
    emit("item:remove", id);
    return !!cur;
  }

  async function upsertDocImpl(d) {
    const f = d || {};
    const existing = f.docKey ? await itemByDocKey(f.docKey) : null;
    const source = SOURCES.indexOf(f.sourceKind) >= 0 ? f.sourceKind : (f.url && /^https?:/i.test(f.url) ? "web" : "txt");
    if (!existing) {
      return addItemImpl({ kind: "doc", docKey: f.docKey, title: f.title, author: f.author, url: f.url, source, text: f.text });
    }
    const patch = {};
    if (f.title && f.title !== existing.title) patch.title = String(f.title);
    if (f.author != null && f.author !== "" && f.author !== existing.author) patch.author = String(f.author);
    if (f.url && f.url !== existing.url) patch.url = String(f.url);
    if (f.sourceKind && source !== existing.source) patch.source = source;
    if (f.text != null && String(f.text).slice(0, TEXT_CAP) !== existing.text) patch.text = String(f.text);
    if (!Object.keys(patch).length) return existing;
    return updateItemImpl(existing.id, patch);
  }

  async function saveLinkImpl(l) {
    const f = l || {};
    const url = String(f.url || "").trim();
    if (!url) throw new Error("saveLink needs a url");
    const existing = await itemByUrl(url);
    if (!existing) {
      return addItemImpl({ kind: "link", url, title: f.title, text: f.text, excerpt: f.excerpt, source: "web" });
    }
    const patch = {};
    if (f.title && f.title !== existing.title) patch.title = String(f.title);
    if (f.text && f.text !== existing.text) patch.text = String(f.text);
    if (f.excerpt && f.excerpt !== existing.excerpt) patch.excerpt = String(f.excerpt);
    if (!Object.keys(patch).length) return existing;
    return updateItemImpl(existing.id, patch);
  }

  async function addAudioImpl(blob, opts) {
    const o = opts || {};
    const blobId = makeId("b_");
    const mime = String(o.mime || (blob && blob.type) || "");
    const size = Number((blob && blob.size) || 0);
    await backend().put("blobs", { id: blobId, blob, mime, size, name: String((blob && blob.name) || "") });
    return addItemImpl({
      kind: "audio", source: "audio",
      title: o.title || titleFromFile(blob && blob.name) || "Audio",
      duration: o.duration, mime, size, blobId,
      text: o.text, author: o.author
    });
  }
  async function getBlob(blobId) {
    const rec = blobId ? await backend().get("blobs", blobId) : null;
    return rec ? rec.blob : null;
  }

  async function importReaderDocsImpl(entries) {
    const out = [];
    for (const e of entries || []) {
      if (!e || !e.key) continue;
      const sections = (e.doc && e.doc.sections) || [];
      const text = sections.map(s => htmlToText(s.html)).filter(Boolean).join("\n\n");
      out.push(await upsertDocImpl({ docKey: e.key, title: e.title, author: e.author, url: e.url, sourceKind: e.kind, text }));
    }
    return out;
  }

  // ---------- Notes ----------

  function cleanAnchor(a) {
    const out = {};
    if (!a || typeof a !== "object") return out;
    for (const k of ["block", "time", "page"]) if (a[k] != null && a[k] !== "") out[k] = a[k];
    return out;
  }

  async function addNoteImpl(fields) {
    const f = fields || {};
    if (!f.itemId) throw new Error("addNote needs an itemId");
    const now = Date.now();
    const quote = String(f.quote || "");
    const note = {
      id: f.id || makeId("n_"),
      itemId: String(f.itemId),
      kind: quote ? "highlight" : "note",
      text: String(f.text || ""),
      quote,
      anchor: cleanAnchor(f.anchor),
      color: String(f.color || ""),
      created: typeof f.created === "number" ? f.created : now,
      updated: typeof f.updated === "number" ? f.updated : now
    };
    await backend().put("notes", note);
    emit("note:add", note.id);
    return note;
  }

  async function updateNoteImpl(id, patch) {
    const cur = await backend().get("notes", id);
    if (!cur) return null;
    const p = Object.assign({}, patch || {});
    delete p.id; delete p.created;
    const next = Object.assign({}, cur, p);
    if ("anchor" in p) next.anchor = cleanAnchor(p.anchor);
    next.quote = String(next.quote || "");
    next.text = String(next.text || "");
    next.kind = next.quote ? "highlight" : "note";
    next.updated = typeof p.updated === "number" ? p.updated : Math.max(Date.now(), cur.updated + 1);
    await backend().put("notes", next);
    emit("note:update", id);
    return next;
  }

  async function removeNoteImpl(id) {
    await backend().del("notes", id);
    emit("note:remove", id);
    return true;
  }

  function anchorKey(n) {
    const a = n.anchor || {};
    const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? Infinity : Number(v));
    return [num(a.page), num(a.block), num(a.time)];
  }
  function noteOrder(a, b) {
    const x = anchorKey(a), y = anchorKey(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return (a.created || 0) - (b.created || 0);
  }
  async function notesFor(itemId) { return (await backend().byIndex("notes", "itemId", itemId)).sort(noteOrder); }
  async function allNotes() { return backend().all("notes"); }

  // ---------- Relatedness ----------

  let idfMemo = null;

  function signature(items) {
    let sum = 0;
    for (const it of items) sum = (sum + (it.updated || 0) % 1e9 + it.id.length) % 1e15;
    return items.length + ":" + sum;
  }

  function computeDf(items) {
    const df = {};
    for (const it of items) {
      const seen = new Set();
      for (const [t] of it.terms || []) seen.add(stem(t));
      for (const k of seen) df[k] = (df[k] || 0) + 1;
    }
    return df;
  }

  async function reindexImpl(itemsIn) {
    const items = itemsIn || await allItems();
    const rec = { key: "idf", sig: signature(items), n: items.length, df: computeDf(items), at: Date.now() };
    await backend().put("meta", rec);
    idfMemo = rec;
    return { n: rec.n, terms: Object.keys(rec.df).length };
  }

  // Backup: items and notes as plain records. Audio files stay out; they can run to hundreds of MB.
  async function exportDataImpl() {
    return { items: await allItems(), notes: await allNotes() };
  }
  // Restore merges by id: a record in the backup replaces the one with the same id, others stay.
  async function importDataImpl(d) {
    const items = Array.isArray(d && d.items) ? d.items.filter((i) => i && typeof i.id === "string" && KINDS.includes(i.kind)) : [];
    const notes = Array.isArray(d && d.notes) ? d.notes.filter((n) => n && typeof n.id === "string" && typeof n.itemId === "string") : [];
    for (const it of items) await backend().put("items", it);
    for (const n of notes) await backend().put("notes", n);
    idfMemo = null;
    await reindexImpl();
    emit("import", null);
    return { items: items.length, notes: notes.length };
  }

  async function idfFor(items) {
    const sig = signature(items);
    if (idfMemo && idfMemo.sig === sig) return idfMemo;
    const cached = await backend().get("meta", "idf");
    if (cached && cached.sig === sig) { idfMemo = cached; return cached; }
    await reindexImpl(items);
    return idfMemo;
  }

  function resolver(items) {
    const exact = new Map();
    for (const it of items) {
      const k = String(it.title || "").trim().toLowerCase();
      if (k && !exact.has(k)) exact.set(k, it);
    }
    const byLen = items.slice().sort((a, b) => a.title.length - b.title.length);
    return function resolve(target, selfId) {
      const t = String(target || "").replace(/#.*$/, "").replace(/\.md$/i, "").trim().toLowerCase();
      if (!t) return null;
      const e = exact.get(t);
      if (e && e.id !== selfId) return e;
      for (const it of byLen) if (it.id !== selfId && it.title.toLowerCase().startsWith(t)) return it;
      return null;
    };
  }

  // Everything pair scoring needs, built once per call.
  function buildContext(items, notes, idf) {
    const byId = new Map(items.map(i => [i.id, i]));
    const resolve = resolver(items);
    const notesBy = new Map();
    for (const n of notes) {
      if (!notesBy.has(n.itemId)) notesBy.set(n.itemId, []);
      notesBy.get(n.itemId).push(n);
    }
    // Wiki links out of each item: from its notes, and from its own text for note items.
    const links = new Map();
    for (const it of items) {
      const out = new Set();
      const texts = (notesBy.get(it.id) || []).map(n => n.text + "\n" + n.quote);
      if (it.kind === "note") texts.push(it.text);
      for (const t of texts) for (const l of wikilinks(t)) {
        const target = resolve(l.target, it.id);
        if (target) out.add(target.id);
      }
      links.set(it.id, out);
    }
    const N = Math.max(1, idf.n || items.length);
    const vec = new Map();
    const display = new Map();
    for (const it of items) {
      const v = new Map();
      const d = new Map();
      for (const [t, w] of it.terms || []) {
        const k = stem(t);
        const df = idf.df[k] || 1;
        const x = Number(w) * Math.log(1 + N / df);
        v.set(k, (v.get(k) || 0) + x);
        if (!d.has(k)) d.set(k, t);
      }
      let norm = 0;
      for (const x of v.values()) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (const [k, x] of v) v.set(k, x / norm);
      vec.set(it.id, v);
      display.set(it.id, d);
    }
    // Names shared by most of a large library say little; weigh them down.
    const nameDf = new Map();
    for (const it of items) for (const [p] of it.names || []) { const k = p.toLowerCase(); nameDf.set(k, (nameDf.get(k) || 0) + 1); }
    return { items, byId, links, vec, display, nameDf, N };
  }

  function listJoin(words) {
    if (words.length <= 1) return words.join("");
    if (words.length === 2) return words[0] + " and " + words[1];
    return words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
  }

  function sharedNames(a, b) {
    const out = [];
    const seen = new Set();
    for (const [pa] of a.names || []) {
      const la = pa.toLowerCase();
      for (const [pb] of b.names || []) {
        const lb = pb.toLowerCase();
        let hit = null;
        if (la === lb) hit = pa;
        else {
          const [short, long, shortRaw] = la.length < lb.length ? [la, lb, pa] : [lb, la, pb];
          if (short.includes(" ") && (" " + long + " ").includes(" " + short + " ")) hit = shortRaw;
        }
        if (hit && !seen.has(hit.toLowerCase())) { seen.add(hit.toLowerCase()); out.push(hit); }
      }
    }
    return out;
  }

  function pairSignals(ctx, a, b) {
    const sig = [];
    if (ctx.links.get(a.id).has(b.id)) sig.push({ kind: "wiki", score: 1, why: "You linked it in a note" });
    if (ctx.links.get(b.id).has(a.id)) sig.push({ kind: "backlink", score: 0.9, why: "Linked from a note in " + b.title });
    const va = ctx.vec.get(a.id), vb = ctx.vec.get(b.id);
    let dot = 0;
    const contrib = [];
    for (const [k, x] of va) { const y = vb.get(k); if (y) { dot += x * y; contrib.push([k, x * y]); } }
    if (dot >= TOPIC_MIN) {
      contrib.sort((p, q) => q[1] - p[1]);
      const top = contrib.slice(0, 3).filter((c, i) => i < 2 || c[1] >= contrib[0][1] * 0.25);
      const words = top.map(c => ctx.display.get(a.id).get(c[0]) || c[0]);
      sig.push({ kind: "topic", score: Math.min(1, dot), why: "Both cover " + listJoin(words) });
    }
    const shared = sharedNames(a, b);
    if (shared.length) {
      let s = Math.min(0.8, 0.4 + 0.15 * (shared.length - 1));
      const common = shared.every(p => (ctx.nameDf.get(p.toLowerCase()) || 1) > Math.max(3, ctx.N * 0.5));
      if (common) s *= 0.5;
      sig.push({ kind: "name", score: s, why: "Both mention " + listJoin(shared.slice(0, 2)) });
    }
    if (a.domain && a.domain === b.domain) sig.push({ kind: "source", score: 0.15, why: "Also from " + a.domain });
    else if (a.author && b.author && a.author.trim().toLowerCase() === b.author.trim().toLowerCase()) sig.push({ kind: "source", score: 0.15, why: "Also by " + b.author });
    if (!sig.length) return null;
    sig.sort((p, q) => q.score - p.score);
    let miss = 1;
    for (const s of sig) miss *= 1 - s.score;
    const score = Math.round(Math.min(1, Math.max(sig[0].score, 1 - miss)) * 1000) / 1000;
    return { score, kind: sig[0].kind, why: sig[0].why };
  }

  async function contextNow() {
    const items = await allItems();
    const notes = await allNotes();
    const idf = await idfFor(items);
    return buildContext(items, notes, idf);
  }

  async function related(itemId, opts) {
    const limit = (opts && opts.limit) || 6;
    const ctx = await contextNow();
    const self = ctx.byId.get(itemId);
    if (!self) return [];
    const out = [];
    for (const other of ctx.items) {
      if (other.id === self.id) continue;
      const r = pairSignals(ctx, self, other);
      if (r) out.push({ item: other, score: r.score, kind: r.kind, why: r.why });
    }
    out.sort((x, y) => y.score - x.score || (y.item.updated || 0) - (x.item.updated || 0));
    return out.slice(0, limit);
  }

  async function graph(opts) {
    const minScore = opts && opts.minScore != null ? opts.minScore : 0.15;
    const perNode = (opts && opts.maxEdges) || 6;
    const ctx = await contextNow();
    const cand = [];
    const list = ctx.items;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const r1 = pairSignals(ctx, list[i], list[j]);
        if (!r1) continue;
        // Undirected: a wiki link either way counts, so take the stronger reading.
        const r2 = pairSignals(ctx, list[j], list[i]);
        const r = r2 && r2.score > r1.score ? r2 : r1;
        if (r.score >= minScore) cand.push({ a: list[i].id, b: list[j].id, score: r.score, kind: r.kind });
      }
    }
    cand.sort((x, y) => y.score - x.score);
    const degree = new Map(list.map(i => [i.id, 0]));
    const edges = [];
    for (const e of cand) {
      if (degree.get(e.a) >= perNode || degree.get(e.b) >= perNode) continue;
      edges.push(e);
      degree.set(e.a, degree.get(e.a) + 1);
      degree.set(e.b, degree.get(e.b) + 1);
    }
    const nodes = list.map(i => ({ id: i.id, title: i.title, kind: i.kind, degree: degree.get(i.id) }));
    return { nodes, edges };
  }

  // ---------- Search ----------

  async function search(q) {
    const query = String(q || "").trim().toLowerCase();
    const items = await allItems();
    if (!query) return { items: items.sort((a, b) => b.updated - a.updated), notes: [] };
    // "#rivers" is a tag filter: items tagged rivers, items with a note that uses it, and those notes.
    const tagQ = /^#[\p{L}\p{N}_/-]+$/u.test(query) ? query.slice(1) : "";
    if (tagQ) {
      const notes = (await allNotes()).filter(n => tagsIn(n.text + " " + n.quote).includes(tagQ)).sort((a, b) => b.updated - a.updated);
      const viaNote = new Set(notes.map(n => n.itemId));
      return { items: items.filter(it => (it.tags || []).includes(tagQ) || viaNote.has(it.id)).sort((a, b) => b.updated - a.updated), notes };
    }
    const qTokens = tokenize(query).filter(w => !STOP.has(w));
    const qStems = qTokens.map(stem);
    const scored = [];
    for (const it of items) {
      const title = it.title.toLowerCase();
      let score = 0;
      if (title.includes(query)) score = title.startsWith(query) ? 400 : 300;
      else if (qTokens.length && qTokens.every(w => title.includes(w))) score = 250;
      else if ((it.tags || []).some(t => t === query.replace(/^#/, "")) || (it.author && it.author.toLowerCase().includes(query))) score = 220;
      else if (qStems.length) {
        const keys = new Map((it.terms || []).map(([t, w]) => [stem(t), w]));
        if (qStems.every(k => keys.has(k))) score = 200 + Math.min(50, qStems.reduce((s, k) => s + keys.get(k), 0) * 5);
      }
      if (!score) {
        const text = it.text.toLowerCase();
        if (text.includes(query)) score = 100;
        else if (qTokens.length && qTokens.every(w => text.includes(w))) score = 50;
      }
      if (score) scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score || b.it.updated - a.it.updated);
    const notes = (await allNotes()).filter(n => {
      const t = (n.text + "\n" + n.quote).toLowerCase();
      return t.includes(query) || (qTokens.length && qTokens.every(w => t.includes(w)));
    }).sort((a, b) => b.updated - a.updated);
    return { items: scored.map(s => s.it), notes };
  }

  // ---------- Memory cards ----------

  function ideasFor(item, cards) {
    if (!item) return [];
    const url = item.url ? normalizeUrl(item.url) : "";
    return (cards || []).filter(c => {
      const s = (c && c.source) || {};
      if (item.docKey && s.docKey && s.docKey === item.docKey) return true;
      return !!(url && s.url && normalizeUrl(s.url) === url);
    });
  }

  // ---------- Meta (for other modules, such as the Obsidian folder handle) ----------

  async function getMeta(key) {
    const rec = await backend().get("meta", key);
    return rec ? rec.value : undefined;
  }
  function setMeta(key, value) { return queue(() => backend().put("meta", { key, value })); }

  globalThis.PolycarpLibrary = {
    DB_NAME, TEXT_CAP, KINDS, SOURCES,
    open, useMemoryStore,
    addItem: (f) => queue(() => addItemImpl(f)),
    updateItem: (id, p) => queue(() => updateItemImpl(id, p)),
    getItem, allItems, itemByDocKey, itemByUrl,
    removeItem: (id) => queue(() => removeItemImpl(id)),
    upsertDoc: (d) => queue(() => upsertDocImpl(d)),
    saveLink: (l) => queue(() => saveLinkImpl(l)),
    addAudio: (b, o) => queue(() => addAudioImpl(b, o)),
    getBlob,
    addNote: (f) => queue(() => addNoteImpl(f)),
    updateNote: (id, p) => queue(() => updateNoteImpl(id, p)),
    removeNote: (id) => queue(() => removeNoteImpl(id)),
    notesFor, allNotes,
    related, graph, search, ideasFor,
    reindex: () => queue(() => reindexImpl()),
    importReaderDocs: (e) => queue(() => importReaderDocsImpl(e)),
    exportData: () => queue(() => exportDataImpl()),
    importData: (d) => queue(() => importDataImpl(d)),
    onChange, getMeta, setMeta,
    tokenize, stem, STOP, terms, names, cosine, normalizeUrl, wikilinks, tagsIn,
    excerptOf, htmlToText, domainOf
  };
})();
