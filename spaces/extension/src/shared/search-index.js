/* Polycarp search index: a local full-text index for custom search sources (feeds, OPDS
   catalogs, crawled sites and imported lists). Stored in IndexedDB ("polycarp-search").
   Stores: "sources" (custom source definitions, keyPath id) and "docs" (keyPath
   [sourceId, docId]). Ranking is BM25F over title (weight 3), by (2) and text (1),
   accent and case folded, with prefix match on the last query word and a phrase bonus.
   Classic script for extension pages. */
(function () {
  "use strict";

  const DB_NAME = "polycarp-search";
  const DB_VERSION = 1;
  const TEXT_CAP = 20000;
  const W_TITLE = 3, W_BY = 2, W_TEXT = 1;
  const K1 = 1.2, B = 0.75;
  const PREFIX_MAX = 200;
  const SNIPPET_LEN = 240;

  // ---------- IndexedDB ----------

  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("sources")) d.createObjectStore("sources", { keyPath: "id" });
        if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs", { keyPath: ["sourceId", "docId"] });
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onversionchange = () => { d.close(); dbp = null; };
        res(d);
      };
      r.onerror = () => { dbp = null; rej(r.error); };
    });
    return dbp;
  }

  function tx(stores, mode, fn) {
    return open().then((d) => new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      const r = fn(t, (v) => { out = v; });
      if (r && typeof r === "object" && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Index write was stopped"));
    }));
  }

  const range = (sid) => IDBKeyRange.bound([sid], [sid, []]);

  // ---------- Text helpers ----------

  const MARKS = /[̀-ͯ]/g;
  const ASCII = /^[\x00-\x7f]*$/;
  function fold(s) {
    s = String(s || "");
    return ASCII.test(s) ? s.toLowerCase() : s.normalize("NFD").replace(MARKS, "").toLowerCase();
  }
  const WORD = /[\p{L}\p{N}]+/gu;
  function tokens(s) { return fold(s).match(WORD) || []; }

  // Folded text plus a map from each folded index back to the original index, so a
  // snippet can be cut from the original text around a match found in folded text.
  function foldWithMap(s) {
    if (ASCII.test(s)) return { f: s.toLowerCase(), map: null };
    let f = "";
    const map = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      let piece;
      if (c < 128) piece = s[i].toLowerCase();
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { piece = s.slice(i, i + 2).toLowerCase(); for (let k = 0; k < piece.length; k++) map.push(i); f += piece; i++; continue; }
      else piece = s[i].normalize("NFD").replace(MARKS, "").toLowerCase();
      for (let k = 0; k < piece.length; k++) map.push(i);
      f += piece;
    }
    return { f, map };
  }

  function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // ---------- In-memory index per source ----------

  // cache: sourceId -> { docs, n, avgLen, lens, postings: Map(term -> {d: Int32Array, w: Float32Array}), terms: sorted array }
  const cache = new Map();
  const building = new Map();
  let chan = null;
  try {
    chan = new BroadcastChannel("polycarp-search");
    chan.onmessage = (e) => { const sid = e && e.data && e.data.dirty; if (sid) cache.delete(sid); };
  } catch (e) { chan = null; }
  function dirty(sid) {
    cache.delete(sid);
    building.delete(sid);
    try { if (chan) chan.postMessage({ dirty: sid }); } catch (e) { /* ignore */ }
  }

  function build(docs) {
    const n = docs.length;
    const lens = new Float32Array(n);
    const tmp = new Map();
    let total = 0;
    for (let i = 0; i < n; i++) {
      const doc = docs[i];
      const tf = new Map();
      let len = 0;
      const add = (text, w) => {
        const t = tokens(text);
        for (let k = 0; k < t.length; k++) tf.set(t[k], (tf.get(t[k]) || 0) + w);
        len += t.length * w;
      };
      add(doc.title, W_TITLE);
      add(doc.by, W_BY);
      add(doc.text, W_TEXT);
      lens[i] = len;
      total += len;
      for (const [term, w] of tf) {
        let p = tmp.get(term);
        if (!p) { p = { d: [], w: [] }; tmp.set(term, p); }
        p.d.push(i);
        p.w.push(w);
      }
    }
    const postings = new Map();
    for (const [term, p] of tmp) postings.set(term, { d: Int32Array.from(p.d), w: Float32Array.from(p.w) });
    const terms = Array.from(postings.keys()).sort();
    return { docs, n, lens, avgLen: n ? total / n : 1, postings, terms };
  }

  function load(sid) {
    const hit = cache.get(sid);
    if (hit) return Promise.resolve(hit);
    if (building.has(sid)) return building.get(sid);
    const p = tx("docs", "readonly", (t) => t.objectStore("docs").getAll(range(sid))).then((docs) => {
      const idx = build(docs || []);
      if (building.get(sid) === p) { cache.set(sid, idx); building.delete(sid); }
      return idx;
    });
    building.set(sid, p);
    return p;
  }

  // Binary search the sorted term list for every term that starts with prefix.
  function expand(idx, prefix) {
    const t = idx.terms;
    let lo = 0, hi = t.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < prefix) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < t.length && out.length < PREFIX_MAX && t[i].startsWith(prefix); i++) out.push(t[i]);
    return out;
  }

  function scoreSource(idx, groups, phrase) {
    const n = idx.n;
    if (!n) return [];
    const score = new Float64Array(n);
    const hits = new Uint8Array(n);
    const seen = new Int32Array(n).fill(-1);
    groups.forEach((terms, g) => {
      for (const term of terms) {
        const p = idx.postings.get(term);
        if (!p) continue;
        const df = p.d.length;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        // An exact word counts fully; a prefix expansion counts a little less.
        const exact = term === terms.base ? 1 : 0.8;
        for (let k = 0; k < df; k++) {
          const i = p.d[k], tf = p.w[k];
          const norm = K1 * (1 - B + B * idx.lens[i] / idx.avgLen);
          score[i] += exact * idf * (tf * (K1 + 1)) / (tf + norm);
          if (seen[i] !== g) { seen[i] = g; hits[i]++; }
        }
      }
    });
    const nGroups = groups.length;
    const cand = [];
    for (let i = 0; i < n; i++) {
      if (!score[i]) continue;
      const cover = hits[i] / nGroups;
      cand.push({ i, s: score[i] * cover * cover });
    }
    cand.sort((a, b) => b.s - a.s);
    if (phrase && nGroups > 1) {
      const top = cand.slice(0, 60);
      for (const c of top) {
        const d = idx.docs[c.i];
        if (fold(d.title).includes(phrase)) c.s *= 1.6;
        else if (fold(d.text).includes(phrase)) c.s *= 1.3;
      }
      cand.sort((a, b) => b.s - a.s);
    }
    return cand;
  }

  function snippetFor(text, groups) {
    text = String(text || "");
    if (!text) return "";
    const { f, map } = foldWithMap(text);
    let pos = -1;
    for (const terms of groups) {
      const base = terms.base;
      let from = 0;
      while (from < f.length) {
        const at = f.indexOf(base, from);
        if (at < 0) break;
        const before = at > 0 ? f[at - 1] : " ";
        if (!/[\p{L}\p{N}]/u.test(before)) { if (pos < 0 || at < pos) pos = at; break; }
        from = at + 1;
      }
    }
    if (pos < 0) return cut(text, 0);
    const orig = map ? map[pos] : pos;
    return cut(text, Math.max(0, orig - 70));
  }

  function cut(text, start) {
    if (start > 0) {
      const sp = text.indexOf(" ", start);
      if (sp > 0 && sp - start < 20) start = sp + 1;
    }
    let end = Math.min(text.length, start + SNIPPET_LEN);
    if (end < text.length) {
      const sp = text.lastIndexOf(" ", end);
      if (sp > start + SNIPPET_LEN / 2) end = sp;
    }
    return (start > 0 ? "..." : "") + clean(text.slice(start, end)) + (end < text.length ? "..." : "");
  }

  function parseQuery(q) {
    const words = tokens(q);
    const folded = words.join(" ");
    return { words, phrase: words.length > 1 ? folded : "" };
  }

  function toResult(doc, groups, score) {
    return {
      id: doc.docId,
      source: doc.sourceId,
      title: doc.title || "",
      url: doc.url || "",
      snippet: snippetFor(doc.text || doc.snippet || "", groups),
      by: doc.by || "",
      year: doc.year || "",
      kind: doc.kind || "page",
      image: doc.image || null,
      readUrl: doc.readUrl || null,
      files: Array.isArray(doc.files) ? doc.files : [],
      duration: doc.duration || "",
      score,
    };
  }

  // ---------- Public API ----------

  // docs: [{ docId (or id or url), title, url, by, text, ...any result fields }]
  async function put(sourceId, docs) {
    const list = (docs || []).map((d) => {
      const docId = String(d.docId || d.id || d.url || d.title || "");
      const rec = Object.assign({}, d, {
        sourceId,
        docId,
        title: clean(d.title),
        by: clean(d.by),
        text: String(d.text == null ? (d.snippet || "") : d.text).slice(0, TEXT_CAP),
      });
      delete rec.id;
      delete rec.score;
      return rec;
    }).filter((d) => d.docId);
    if (!list.length) return 0;
    await tx("docs", "readwrite", (t) => { const s = t.objectStore("docs"); for (const d of list) s.put(d); });
    dirty(sourceId);
    return list.length;
  }

  async function remove(sourceId, docIds) {
    const ids = Array.from(docIds || []);
    if (!ids.length) return 0;
    await tx("docs", "readwrite", (t) => { const s = t.objectStore("docs"); for (const id of ids) s.delete([sourceId, String(id)]); });
    dirty(sourceId);
    return ids.length;
  }

  async function clear(sourceId) {
    await tx("docs", "readwrite", (t) => { t.objectStore("docs").delete(range(sourceId)); });
    dirty(sourceId);
  }

  function count(sourceId) {
    return tx("docs", "readonly", (t) => t.objectStore("docs").count(range(sourceId))).then((n) => n || 0);
  }

  function docIds(sourceId) {
    return tx("docs", "readonly", (t) => t.objectStore("docs").getAllKeys(range(sourceId))).then((keys) => (keys || []).map((k) => k[1]));
  }

  // Search one or more sources. Returns results sorted by score, best first.
  async function search(sourceIds, q, limit) {
    const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
    const max = Math.max(1, Math.min(500, limit || 20));
    const { words, phrase } = parseQuery(q);
    if (!words.length) return [];
    const idxs = await Promise.all(ids.map((sid) => load(sid)));
    const all = [];
    idxs.forEach((idx) => {
      const groups = words.map((w, k) => {
        const last = k === words.length - 1;
        const terms = last ? expand(idx, w) : (idx.postings.has(w) ? [w] : []);
        terms.base = w;
        return terms;
      });
      for (const c of scoreSource(idx, groups, phrase).slice(0, max)) all.push({ doc: idx.docs[c.i], s: c.s, groups });
    });
    all.sort((a, b) => b.s - a.s);
    return all.slice(0, max).map((c) => toResult(c.doc, c.groups, Math.round(c.s * 1000) / 1000));
  }

  // Warm a source's in-memory index ahead of the first search.
  function warm(sourceId) { return load(sourceId).then((idx) => idx.n); }

  // ---------- Source definitions (used by sources.js) ----------

  function getSource(id) { return tx("sources", "readonly", (t) => t.objectStore("sources").get(id)); }
  function allSources() { return tx("sources", "readonly", (t) => t.objectStore("sources").getAll()).then((a) => a || []); }
  function putSource(def) { return tx("sources", "readwrite", (t) => { t.objectStore("sources").put(def); }).then(() => def); }
  function deleteSource(id) { return tx("sources", "readwrite", (t) => { t.objectStore("sources").delete(id); }); }

  globalThis.PolycarpSearchIndex = {
    DB_NAME, TEXT_CAP,
    open: () => open().then(() => true),
    put, remove, clear, count, docIds, search, warm,
    getSource, allSources, putSource, deleteSource,
    fold, tokens,
  };
})();
