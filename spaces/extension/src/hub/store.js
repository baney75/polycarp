/* Polycarp Hub store: accounts, messages, thread summaries, drafts and sync cursors in this browser profile's
   IndexedDB ("polycarp-hub"). Nothing here leaves the profile. Classic script for extension pages and Node tests
   (call useMemoryStore() in tests). Needs model.js. */
(function () {
  "use strict";

  const M = globalThis.PolycarpHubModel;
  const DB_NAME = "polycarp-hub";
  const DB_VERSION = 1;
  const STORES = ["accounts", "messages", "threads", "drafts", "meta"];

  // ---------- Backends: get, all, put, del, byIndex, page ----------

  function idbBackend() {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore("accounts", { keyPath: "id" });
          const ms = d.createObjectStore("messages", { keyPath: "id" });
          ms.createIndex("threadId", "threadId");
          ms.createIndex("messageId", "messageId");
          ms.createIndex("account", "account");
          d.createObjectStore("threads", { keyPath: "id" }).createIndex("folderDate", ["folder", "lastDate"]);
          d.createObjectStore("drafts", { keyPath: "id" });
          d.createObjectStore("meta", { keyPath: "key" });
        };
        r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; res(d); };
        r.onerror = () => { dbp = null; rej(r.error); };
      });
      return dbp;
    }
    function run(store, mode, fn) {
      return open().then((d) => new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        let out;
        const req = fn(t.objectStore(store), (v) => { out = v; });
        if (req) req.onsuccess = () => { out = req.result; };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error("Hub write was stopped"));
      }));
    }
    return {
      open,
      get: (s, k) => run(s, "readonly", (st) => st.get(k)),
      all: (s) => run(s, "readonly", (st) => st.getAll()).then((v) => v || []),
      put: (s, list) => run(s, "readwrite", (st) => { for (const v of list) st.put(v); }),
      del: (s, keys) => run(s, "readwrite", (st) => { for (const k of keys) st.delete(k); }),
      byIndex: (s, i, v) => run(s, "readonly", (st) => st.index(i).getAll(v)).then((v2) => v2 || []),
      // Newest first within [lower, upper] on a compound index, at most `limit`.
      page: (s, i, lower, upper, limit) => run(s, "readonly", (st, set) => {
        const out = [];
        const c = st.index(i).openCursor(IDBKeyRange.bound(lower, upper), "prev");
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur || out.length >= limit) { set(out); return; }
          out.push(cur.value);
          cur.continue();
        };
      })
    };
  }

  function memoryBackend() {
    const stores = Object.fromEntries(STORES.map((s) => [s, new Map()]));
    const keyOf = (s, v) => (s === "meta" ? v.key : v.id);
    const copy = (v) => structuredClone(v);
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const tuple = (a, b) => { for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; } return 0; };
    return {
      open: () => Promise.resolve(true),
      get: async (s, k) => { const v = stores[s].get(k); return v === undefined ? undefined : copy(v); },
      all: async (s) => Array.from(stores[s].values(), copy),
      put: async (s, list) => { for (const v of list) stores[s].set(keyOf(s, v), copy(v)); },
      del: async (s, keys) => { for (const k of keys) stores[s].delete(k); },
      byIndex: async (s, i, val) => Array.from(stores[s].values()).filter((v) => v[i] === val).map(copy),
      page: async (s, i, lower, upper, limit) => {
        const fields = i === "folderDate" ? ["folder", "lastDate"] : [i];
        return Array.from(stores[s].values())
          .map((v) => [fields.map((f) => v[f]).concat(keyOf(s, v)), v])
          .filter(([k]) => tuple(k.slice(0, -1), lower) >= 0 && tuple(k.slice(0, -1), upper) <= 0)
          .sort((a, b) => tuple(b[0], a[0]))
          .slice(0, limit)
          .map(([, v]) => copy(v));
      }
    };
  }

  let db = null;
  function backend() {
    if (!db) db = typeof indexedDB !== "undefined" ? idbBackend() : memoryBackend();
    return db;
  }
  function useMemoryStore() { db = memoryBackend(); }

  // Writes run one at a time, so a read, change and write never race.
  let chain = Promise.resolve();
  function queue(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  // ---------- Change events ----------

  const listeners = new Set();
  let channel = null;
  function emit(ev) {
    for (const fn of Array.from(listeners)) { try { fn(ev); } catch (e) { /* one bad listener must not stop the rest */ } }
    if (channel) { try { channel.postMessage(ev); } catch (e) { /* closed */ } }
  }
  function onChange(fn) {
    if (!channel && typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(DB_NAME);
        channel.onmessage = (e) => { for (const f of Array.from(listeners)) { try { f(e.data); } catch (err) { /* next */ } } };
        if (typeof channel.unref === "function") channel.unref();
      } catch (e) { channel = null; }
    }
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ---------- Accounts ----------

  async function putAccount(a) {
    if (!a || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(a.id || "")) throw new Error("an account id is 1 to 41 of a-z, 0-9 and -");
    await queue(() => backend().put("accounts", [{ id: a.id, kind: String(a.kind || ""), label: String(a.label || a.id), address: String(a.address || ""), route: String(a.route || "") }]));
    emit({ type: "accounts" });
  }
  const accounts = () => backend().all("accounts");

  // Takes the account and everything stored for it out of this profile.
  function removeAccount(id) {
    return queue(async () => {
      const msgs = await backend().byIndex("messages", "account", id);
      const threads = new Set(msgs.map((m) => m.threadId));
      await backend().del("messages", msgs.map((m) => m.id));
      await backend().del("threads", Array.from(threads));
      await backend().del("accounts", [id]);
      await backend().del("meta", ["cursor:" + id]);
    }).then(() => emit({ type: "accounts" }));
  }

  // ---------- Messages and threads ----------

  async function resummarize(threadIds) {
    const put = [];
    const gone = [];
    for (const t of threadIds) {
      const msgs = await backend().byIndex("messages", "threadId", t);
      if (msgs.length) put.push(M.summarize(t, msgs)); else gone.push(t);
    }
    if (put.length) await backend().put("threads", put);
    if (gone.length) await backend().del("threads", gone);
  }

  // Stores what an adapter sent (raw messages for one account) and returns the threads they touched.
  function upsert(accountId, raws) {
    return queue(async () => {
      const touched = new Set();
      const known = new Map();
      const out = [];
      for (const raw of raws) {
        const msg = M.normalize(accountId, raw);
        const old = await backend().get("messages", msg.id);
        for (const id of [...msg.references, msg.inReplyTo, msg.messageId].filter(Boolean)) {
          if (known.has(id)) continue;
          const hit = (await backend().byIndex("messages", "messageId", id)).find((m) => m.account === accountId);
          if (hit) known.set(id, hit.threadId);
        }
        msg.threadId = old ? old.threadId : M.threadKey(msg, known);
        if (old) { msg.snoozeUntil = msg.snoozeUntil || old.snoozeUntil; msg.remindAt = msg.remindAt || old.remindAt; }
        if (msg.messageId) known.set(msg.messageId, msg.threadId);
        touched.add(msg.threadId);
        out.push(msg);
      }
      await backend().put("messages", out);
      await resummarize(touched);
      return Array.from(touched);
    }).then((threads) => { emit({ type: "messages", threads }); return threads; });
  }

  function remove(ids) {
    return queue(async () => {
      const touched = new Set();
      for (const id of ids) { const m = await backend().get("messages", id); if (m) touched.add(m.threadId); }
      await backend().del("messages", ids);
      await resummarize(touched);
      return Array.from(touched);
    }).then((threads) => { emit({ type: "messages", threads }); return threads; });
  }

  // Local change to stored messages: unread, flagged, folder, snoozeUntil, remindAt. Returns the messages before it,
  // so a failed call to the account can put them back.
  const PATCHABLE = ["unread", "flagged", "folder", "snoozeUntil", "remindAt", "labels"];
  function update(ids, patch) {
    const keys = Object.keys(patch);
    const bad = keys.filter((k) => !PATCHABLE.includes(k));
    if (bad.length) return Promise.reject(new Error("can't change " + bad.join(", ")));
    return queue(async () => {
      const before = [];
      const after = [];
      const touched = new Set();
      for (const id of ids) {
        const m = await backend().get("messages", id);
        if (!m) continue;
        before.push(m);
        after.push(Object.assign({}, m, patch));
        touched.add(m.threadId);
      }
      await backend().put("messages", after);
      await resummarize(touched);
      return { before, threads: Array.from(touched) };
    }).then((r) => { emit({ type: "messages", threads: r.threads }); return r; });
  }

  // Puts messages back exactly as `update` returned them.
  function restore(before) {
    return queue(async () => {
      await backend().put("messages", before);
      const touched = new Set(before.map((m) => m.threadId));
      await resummarize(touched);
      return Array.from(touched);
    }).then((threads) => { emit({ type: "messages", threads }); return threads; });
  }

  const message = (id) => backend().get("messages", id);

  async function thread(id) {
    const summary = await backend().get("threads", id);
    if (!summary) return null;
    const messages = (await backend().byIndex("messages", "threadId", id)).sort((a, b) => a.date - b.date);
    return { summary, messages };
  }

  // Thread summaries in a folder, newest first, older than `before` when given. `account` narrows to one account.
  async function threads(opts) {
    const o = Object.assign({ folder: "inbox", limit: 50, before: Infinity, account: "" }, opts || {});
    const upper = [o.folder, Number.isFinite(o.before) ? o.before - 1 : Number.MAX_SAFE_INTEGER];
    if (!o.account) return backend().page("threads", "folderDate", [o.folder, 0], upper, o.limit);
    const out = [];
    let cursor = upper;
    while (out.length < o.limit) {
      const batch = await backend().page("threads", "folderDate", [o.folder, 0], cursor, 200);
      for (const t of batch) if (t.account === o.account && out.length < o.limit) out.push(t);
      if (batch.length < 200) break;
      cursor = [o.folder, batch[batch.length - 1].lastDate - 1];
    }
    return out;
  }

  const allMessages = () => backend().all("messages");
  const allThreads = () => backend().all("threads");

  // ---------- Meta: sync cursors and settings ----------

  async function getMeta(key) { const v = await backend().get("meta", key); return v ? v.value : undefined; }
  function setMeta(key, value) { return queue(() => backend().put("meta", [{ key, value }])); }
  const cursor = (account) => getMeta("cursor:" + account);
  const setCursor = (account, c) => setMeta("cursor:" + account, c);

  globalThis.PolycarpHubStore = {
    DB_NAME, useMemoryStore, open: () => backend().open().then(() => true), onChange,
    putAccount, accounts, removeAccount,
    upsert, remove, update, restore, message, thread, threads, allMessages, allThreads,
    getMeta, setMeta, cursor, setCursor
  };
})();
