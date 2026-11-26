/* Polycarp Hub search: an index over every stored message, in memory, so a search over 100,000 messages answers in
   well under 50 ms. Words come from the subject, the people and the whole text; `from:`, `to:`, `subject:` and `list:`
   look in one field, and `in:`, `is:` and `has:` filter. The last word matches as a prefix while it is being typed.
   Classic script for extension pages and Node tests. */
(function () {
  "use strict";

  const MAX_TEXT = 20000;
  const FIELDS = { from: "f:", to: "t:", cc: "t:", subject: "s:", list: "l:" };
  const IS = {
    unread: (d) => d.unread, read: (d) => !d.unread, flagged: (d) => d.flagged, starred: (d) => d.flagged,
    // A snooze or a reminder belongs to the thread and is read from its newest message (`t`, in the index), since a
    // newer message ends it.
    snoozed: (d) => (d.t || d).snoozeUntil > Date.now(), waiting: (d) => (d.t || d).remindAt > Date.now(),
    due: (d) => { const s = d.t || d; return (s.snoozeUntil > 0 && s.snoozeUntil <= Date.now()) || (s.remindAt > 0 && s.remindAt <= Date.now()); }
  };

  // Lowercase words without accents. Letters need two or more; numbers count at any length.
  function words(s) {
    const out = String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    return out.filter((w) => w.length > 1 || /\d/.test(w));
  }
  // The words of an HTML-only body, for the index: scripts, styles and the head dropped, tags removed, the common
  // entities read. Linear in the text, which is cut first; the page shows such mail through its own DOM parser.
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  function htmlText(html) {
    if (!html) return "";
    return String(html).slice(0, MAX_TEXT * 5)
      .replace(/<(script|style|head|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
        if (e[0] !== "#") return ENTITIES[e.toLowerCase()] || " ";
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      })
      .slice(0, MAX_TEXT);
  }
  const addrWords = (a) => (a && a.addr ? [String(a.addr).toLowerCase(), ...words(a.name), ...words(a.addr)] : []);

  // Every token a message is found by: each word bare, and again under its field. A thread summary works too: its
  // people count as senders and its snippet as the text.
  function tokensOf(m) {
    const out = new Set();
    const both = (w, f) => { out.add(w); out.add(f + w); };
    for (const a of [m.from, ...(m.people || [])]) for (const w of addrWords(a)) both(w, "f:");
    for (const a of [...(m.to || []), ...(m.cc || [])]) for (const w of addrWords(a)) both(w, "t:");
    for (const w of words(m.subject)) both(w, "s:");
    for (const w of words(m.headers && m.headers.listId)) both(w, "l:");
    const body = m.text ? String(m.text) : m.html ? htmlText(m.html) : String(m.snippet || "");
    for (const w of words(body.slice(0, MAX_TEXT))) out.add(w);
    return out;
  }
  const docOf = (m) => ({ id: m.id, threadId: m.threadId || m.id, date: m.date || m.lastDate || 0, folder: m.folder, unread: !!m.unread, flagged: !!m.flagged,
    att: !!((m.attachments && m.attachments.length) || m.hasAttachments), snoozeUntil: m.snoozeUntil || 0, remindAt: m.remindAt || 0 });

  // Whether one message or thread summary matches a parsed query, whole words only.
  function matches(parsed, m) {
    if (!parsed.terms.length && !parsed.filters.length) return false;
    const doc = docOf(m);
    if (!parsed.filters.every((f) => f(doc))) return false;
    if (!parsed.terms.length) return true;
    const ts = tokensOf(m);
    return parsed.terms.every((t) => ts.has(t.token));
  }

  // A query into terms (each a token or a prefix to look up) and filters.
  //   ada plans           both words, anywhere
  //   from:ada  to:bo     a word or the whole address in that field
  //   subject:"roof"      in the subject; quotes hold several words, each required
  //   list:almanac       a word of the List-Id
  //   in:inbox is:unread is:flagged is:snoozed is:waiting has:attachment
  // The last word is a prefix unless the query ends in a space.
  function parse(q) {
    const s = String(q || "");
    const terms = [];
    const filters = [];
    const bad = [];
    const re = /(\w+):"([^"]*)"?|(\w+):(\S+)|"([^"]*)"?|(\S+)/g;
    let m;
    while ((m = re.exec(s))) {
      const key = (m[1] || m[3] || "").toLowerCase();
      const val = m[2] != null ? m[2] : m[4] != null ? m[4] : m[5] != null ? m[5] : m[6];
      const end = re.lastIndex === s.length;
      if (key === "in") { const f = val.toLowerCase(); filters.push((d) => d.folder === f); continue; }
      if (key === "is") { const f = IS[val.toLowerCase()]; if (f) filters.push(f); else bad.push(m[0]); continue; }
      if (key === "has") { if (/^attach/i.test(val)) filters.push((d) => d.att); else bad.push(m[0]); continue; }
      const field = key ? FIELDS[key] : "";
      if (key && field == null) { bad.push(m[0]); continue; }
      const prefix = field || "";
      const quoted = m[2] != null || m[5] != null;
      // A whole address in from: or to: is one token, as the index stores it.
      if (field && field !== "s:" && /@/.test(val)) { terms.push({ token: prefix + val.toLowerCase(), prefix: end && !quoted }); continue; }
      const ws = words(val);
      ws.forEach((w, i) => terms.push({ token: prefix + w, prefix: end && !quoted && i === ws.length - 1 }));
    }
    return { terms, filters, bad };
  }

  function create() {
    let docs = [];            // doc number -> {id, threadId, date, folder, unread, flagged, att, snoozed} or null
    let post = new Map();     // token -> doc numbers, ascending
    let keys = null;          // sorted tokens, built at the first prefix query
    let fresh = [];           // tokens added since, merged in at the next one
    const byThread = new Map(); // thread id -> doc numbers
    const newest = new Map();   // thread id -> {date, snoozeUntil, remindAt} of its newest message, shared by its docs
    let dead = 0;

    function addOne(m) {
      const d = docs.length;
      const doc = docOf(m);
      let s = newest.get(doc.threadId);
      if (!s) newest.set(doc.threadId, (s = { date: -Infinity, snoozeUntil: 0, remindAt: 0 }));
      if (doc.date >= s.date) Object.assign(s, { date: doc.date, snoozeUntil: doc.snoozeUntil, remindAt: doc.remindAt });
      doc.t = s;
      docs.push(doc);
      for (const t of tokensOf(m)) {
        let p = post.get(t);
        if (!p) { p = []; post.set(t, p); if (keys) fresh.push(t); }
        p.push(d);
      }
      let set = byThread.get(m.threadId);
      if (!set) byThread.set(m.threadId, (set = []));
      set.push(d);
    }

    // Puts these messages in, replacing any already there for their threads, so a thread is always indexed whole.
    function setThreads(threadIds, messages) {
      for (const t of threadIds) dropThread(t);
      for (const m of messages) addOne(m);
      if (dead > 1000 && dead > docs.length / 2) compact();
    }
    function dropThread(t) {
      const set = byThread.get(t);
      if (!set) return;
      for (const d of set) if (docs[d]) { docs[d] = null; dead++; }
      byThread.delete(t);
      newest.delete(t);
    }
    function compact() {
      const old = { docs, post };
      docs = []; post = new Map(); keys = null; fresh = []; byThread.clear(); dead = 0;
      const map = new Map();
      for (let i = 0; i < old.docs.length; i++) if (old.docs[i]) { map.set(i, docs.length); docs.push(old.docs[i]); }
      for (const [t, p] of old.post) {
        const np = [];
        for (const d of p) { const n = map.get(d); if (n != null) np.push(n); }
        if (np.length) post.set(t, np);
      }
      for (let i = 0; i < docs.length; i++) {
        let set = byThread.get(docs[i].threadId);
        if (!set) byThread.set(docs[i].threadId, (set = []));
        set.push(i);
      }
    }

    function merged(a, b) {
      const out = new Array(a.length + b.length);
      let i = 0, j = 0, k = 0;
      while (i < a.length && j < b.length) out[k++] = a[i] < b[j] ? a[i++] : b[j++];
      while (i < a.length) out[k++] = a[i++];
      while (j < b.length) out[k++] = b[j++];
      return out;
    }
    function lists(term) {
      if (!term.prefix) { const p = post.get(term.token); return p ? [p] : []; }
      // New words are sorted alone and merged in, so the first prefix query after new mail doesn't sort every word.
      if (!keys) { keys = Array.from(post.keys()).sort(); fresh = []; }
      else if (fresh.length) { keys = merged(keys, fresh.sort()); fresh = []; }
      let lo = 0, hi = keys.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid] < term.token) lo = mid + 1; else hi = mid; }
      const out = [];
      for (let i = lo; i < keys.length && keys[i].startsWith(term.token); i++) out.push(post.get(keys[i]));
      return out;
    }

    // Threads whose messages match, newest first: [{threadId, date, hits}].
    function query(q, opts) {
      const o = Object.assign({ limit: 50 }, opts || {});
      const { terms, filters } = typeof q === "string" ? parse(q) : q;
      if (!terms.length && !filters.length) return [];
      const n = docs.length;
      let cand;
      if (terms.length) {
        const sets = terms.map(lists).map((ls) => ({ ls, size: ls.reduce((a, p) => a + p.length, 0) })).sort((a, b) => a.size - b.size);
        if (sets[0].size === 0) return [];
        const mark = new Uint8Array(n);
        cand = [];
        for (const p of sets[0].ls) for (const d of p) if (mark[d] === 0) { mark[d] = 1; cand.push(d); }
        for (let i = 1; i < sets.length; i++) {
          for (const p of sets[i].ls) for (const d of p) if (mark[d] === i) mark[d] = i + 1;
          const k = i + 1;
          cand = cand.filter((d) => mark[d] === k);
          if (!cand.length) return [];
        }
      } else {
        cand = [];
        for (let d = 0; d < n; d++) cand.push(d);
      }
      const best = new Map();
      for (const d of cand) {
        const doc = docs[d];
        if (!doc || !filters.every((f) => f(doc))) continue;
        const b = best.get(doc.threadId);
        if (!b) best.set(doc.threadId, { threadId: doc.threadId, date: doc.date, hits: 1 });
        else { b.hits++; if (doc.date > b.date) b.date = doc.date; }
      }
      return Array.from(best.values()).sort((a, b) => b.date - a.date).slice(0, o.limit);
    }

    return {
      setThreads, dropThread, query,
      clear() { docs = []; post = new Map(); keys = null; fresh = []; byThread.clear(); newest.clear(); dead = 0; },
      get size() { return docs.length - dead; },
      get tokens() { return post.size; }
    };
  }

  // An index kept up to date with the store. `warm` builds it ahead of the first search (the page calls it at start),
  // reading CHUNK messages at a time and giving the page back between them, so it never holds every message at once
  // and typing and scrolling go on while it reads 100,000.
  // After that each changed thread is read again. Updates run one at a time and every query waits for them, so a
  // query never sees an index half built.
  const CHUNK = 500;
  function live(store, o) {
    const S = store || globalThis.PolycarpHubStore;
    const pause = (o && o.pause) || (() => new Promise((ok) => setTimeout(ok, 0)));
    const ix = create();
    let started = false;
    let full = true;
    let building = false;
    let changed = new Set();
    let sync = Promise.resolve();
    async function build() {
      building = true;
      try {
        ix.clear();
        for (let last = "";;) {
          const page = await S.messagesAfter(last, CHUNK);
          if (!page.length) break;
          ix.setThreads([], page);
          if (page.length < CHUNK) break;
          last = page[page.length - 1].id;
          await pause();
        }
      } catch (e) {
        full = true;
        throw e;
      } finally {
        building = false;
      }
    }
    S.onChange((ev) => {
      if (!started) return;
      if (ev && ev.type === "messages" && Array.isArray(ev.threads)) for (const t of ev.threads) changed.add(t);
      else if (ev && ev.type === "accounts") full = true;
    });
    function update() {
      started = true;
      const run = sync.then(async () => {
        if (full) { full = false; changed = new Set(); await build(); }
        if (!changed.size) return;
        const ts = Array.from(changed);
        changed = new Set();
        const msgs = [];
        for (const t of ts) { const got = await S.thread(t); if (got) msgs.push(...got.messages); }
        ix.setThreads(ts, msgs);
      });
      sync = run.catch(() => {});
      return run;
    }
    return {
      index: ix,
      get building() { return building || (started && full); },
      warm: update,
      async query(q, opts) {
        await update();
        return ix.query(q, opts);
      }
    };
  }

  globalThis.PolycarpHubSearch = { words, htmlText, parse, tokensOf, matches, create, live };
})();
