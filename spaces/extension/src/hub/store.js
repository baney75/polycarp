/* Polycarp Hub store: accounts, messages, thread summaries, drafts and sync cursors in this browser profile's
   IndexedDB ("polycarp-hub"). Nothing here leaves the profile. Classic script for extension pages and Node tests
   (call useMemoryStore() in tests). Needs model.js. */
(function () {
  "use strict";

  const M = globalThis.PolycarpHubModel;
  const DB_NAME = "polycarp-hub";
  const DB_VERSION = 2;
  const STORES = ["accounts", "messages", "threads", "drafts", "meta"];

  // ---------- Backends: get, all, put, del, byIndex, page ----------

  function idbBackend() {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = (e) => {
          const d = r.result;
          if (e.oldVersion < 1) {
            d.createObjectStore("accounts", { keyPath: "id" });
            const ms = d.createObjectStore("messages", { keyPath: "id" });
            ms.createIndex("threadId", "threadId");
            ms.createIndex("messageId", "messageId");
            ms.createIndex("account", "account");
            d.createObjectStore("drafts", { keyPath: "id" });
            d.createObjectStore("meta", { keyPath: "key" });
          }
          // Version 2 lists the threads you wrote in by when you last wrote. Version 1 held only a copy of account mail,
          // so it is dropped with the cursors and the next pull brings it back; accounts and drafts stay.
          if (d.objectStoreNames.contains("threads")) {
            d.deleteObjectStore("threads");
            r.transaction.objectStore("messages").clear();
            r.transaction.objectStore("meta").clear();
          }
          // The id ends each key so threads with the same date still have one order, and a page can start after any of them.
          const ts = d.createObjectStore("threads", { keyPath: "id" });
          ts.createIndex("folderDate", ["folder", "lastDate", "id"]);
          ts.createIndex("sentDate", ["sentAt", "id"]);
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
      // Up to `limit` records after key `after` ("" for the start), in key order.
      after: (s, after, limit) => run(s, "readonly", (st) => st.getAll(after ? IDBKeyRange.lowerBound(after, true) : null, limit)).then((v) => v || []),
      // Newest first from just below `upper` down to `lower` on a compound index, at most `limit`.
      page: (s, i, lower, upper, limit) => run(s, "readonly", (st, set) => {
        const out = [];
        const c = st.index(i).openCursor(IDBKeyRange.bound(lower, upper, false, true), "prev");
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
    // IndexedDB's order for array keys: element by element, then the shorter first.
    const tuple = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; } return a.length - b.length; };
    return {
      open: () => Promise.resolve(true),
      get: async (s, k) => { const v = stores[s].get(k); return v === undefined ? undefined : copy(v); },
      all: async (s) => Array.from(stores[s].values(), copy),
      put: async (s, list) => { for (const v of list) stores[s].set(keyOf(s, v), copy(v)); },
      del: async (s, keys) => { for (const k of keys) stores[s].delete(k); },
      byIndex: async (s, i, val) => Array.from(stores[s].values()).filter((v) => v[i] === val).map(copy),
      after: async (s, after, limit) => Array.from(stores[s].keys()).filter((k) => !after || k > after).sort(cmp).slice(0, limit).map((k) => copy(stores[s].get(k))),
      page: async (s, i, lower, upper, limit) => {
        const fields = i === "folderDate" ? ["folder", "lastDate", "id"] : i === "sentDate" ? ["sentAt", "id"] : [i];
        return Array.from(stores[s].values())
          .map((v) => [fields.map((f) => v[f]), v])
          .filter(([k]) => tuple(k, lower) >= 0 && tuple(k, upper) < 0)
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
    openChannel();
    for (const fn of Array.from(listeners)) { try { fn(ev); } catch (e) { /* one bad listener must not stop the rest */ } }
    if (channel) { try { channel.postMessage(ev); } catch (e) { /* closed */ } }
  }
  function openChannel() {
    if (!channel && typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(DB_NAME);
        channel.onmessage = (e) => { for (const f of Array.from(listeners)) { try { f(e.data); } catch (err) { /* next */ } } };
        if (typeof channel.unref === "function") channel.unref();
      } catch (e) { channel = null; }
    }
  }
  function onChange(fn) {
    openChannel();
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ---------- Accounts ----------

  async function putAccount(a) {
    if (!a || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(a.id || "")) throw new Error("an account id is 1 to 41 of a-z, 0-9 and -");
    // `options` holds what the route needs to reach the account (a server, a port), never a password or token.
    const options = a.options && typeof a.options === "object" ? JSON.parse(JSON.stringify(a.options)) : {};
    await queue(() => backend().put("accounts", [{ id: a.id, kind: String(a.kind || ""), label: String(a.label || a.id), address: String(a.address || ""), route: String(a.route || ""), options }]));
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
      const drafts = (await backend().all("drafts")).filter((d) => d.account === id);
      await backend().del("drafts", drafts.map((d) => d.id));
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

  // Puts back the fields `keys` (all of them when none are named) of messages as `update` returned them, so a change
  // made since to other fields stays.
  function restore(before, keys) {
    return queue(async () => {
      const put = [];
      for (const old of before) {
        const now = await backend().get("messages", old.id);
        if (!now) continue;
        put.push(keys ? Object.assign(now, Object.fromEntries(keys.map((k) => [k, old[k]]))) : old);
      }
      await backend().put("messages", put);
      const touched = new Set(before.map((m) => m.threadId));
      await resummarize(touched);
      return Array.from(touched);
    }).then((threads) => { emit({ type: "messages", threads }); return threads; });
  }

  const message = (id) => backend().get("messages", id);
  const summary = (id) => backend().get("threads", id);

  async function thread(id) {
    const summary = await backend().get("threads", id);
    if (!summary) return null;
    const messages = (await backend().byIndex("messages", "threadId", id)).sort((a, b) => a.date - b.date);
    return { summary, messages };
  }

  // Where the next page starts: just after this thread. In Sent, threads go by when you last wrote in them.
  const after = (t, sent) => ({ date: sent ? t.sentAt : t.lastDate, id: t.id });

  // Thread summaries in a folder, newest first. `before` is a date (older than it) or `after(thread)` (everything after
  // that thread, ties on its date included). `account` narrows to one account.
  async function threads(opts) {
    const o = Object.assign({ folder: "inbox", limit: 50, before: Infinity, account: "" }, opts || {});
    // Sent is every thread you wrote in, whatever folder the rest of it is in.
    const ix = o.folder === "sent" ? "sentDate" : "folderDate";
    const head = ix === "sentDate" ? [] : [o.folder];
    const lower = ix === "sentDate" ? [1] : head;
    let upper = o.before && typeof o.before === "object" ? [...head, o.before.date, o.before.id] : [...head, o.before];
    if (!o.account) return backend().page("threads", ix, lower, upper, o.limit);
    const out = [];
    while (out.length < o.limit) {
      const batch = await backend().page("threads", ix, lower, upper, 200);
      for (const t of batch) if (t.account === o.account && out.length < o.limit) out.push(t);
      if (batch.length < 200) break;
      const last = batch[batch.length - 1];
      upper = [...head, ix === "sentDate" ? last.sentAt : last.lastDate, last.id];
    }
    return out;
  }

  const allMessages = () => backend().all("messages");
  // A page of messages in id order after `after` (pass the last id of the page before), so a reader of every message
  // never holds them all at once.
  const messagesAfter = (after, limit) => backend().after("messages", after || "", limit);
  const allThreads = () => backend().all("threads");

  // ---------- Drafts ----------

  // A draft lives only here until it is sent. `replyTo` is the remote id of the message it answers ("" for new mail).
  // `by` names an agent that wrote it ("" when the person did); only the person sends, whoever wrote it.
  const newDraftId = () => "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  async function saveDraft(d) {
    if (!d || !d.account) throw new Error("a draft needs an account");
    const old = d.id ? await backend().get("drafts", d.id) : null;
    const rec = {
      id: d.id || newDraftId(),
      account: String(d.account),
      to: M.addresses(d.to), cc: M.addresses(d.cc), bcc: M.addresses(d.bcc),
      subject: String(d.subject || ""), text: String(d.text || ""),
      replyTo: String(d.replyTo || ""), threadId: String(d.threadId || ""),
      by: old ? old.by : String(d.by || ""),
      // Any change to a draft takes back a send that was waiting on it.
      sendAt: 0,
      updated: Date.now()
    };
    await queue(() => backend().put("drafts", [rec]));
    emit({ type: "drafts" });
    return rec;
  }
  const draft = (id) => backend().get("drafts", id);
  async function drafts(account) {
    const all = await backend().all("drafts");
    return all.filter((d) => !account || d.account === account).sort((a, b) => b.updated - a.updated);
  }
  // When a waiting send of this draft goes, or 0 for none. Kept in the store, so a reload or a second page finds it.
  function setSendAt(id, at) {
    return queue(async () => {
      const d = await backend().get("drafts", id);
      if (!d) return null;
      const rec = Object.assign({}, d, { sendAt: at });
      await backend().put("drafts", [rec]);
      return rec;
    }).then((rec) => { emit({ type: "drafts" }); return rec; });
  }
  async function deleteDraft(id) {
    await queue(() => backend().del("drafts", [id]));
    emit({ type: "drafts" });
  }

  // ---------- Meta: sync cursors and settings ----------

  async function getMeta(key) { const v = await backend().get("meta", key); return v ? v.value : undefined; }
  function setMeta(key, value) { return queue(() => backend().put("meta", [{ key, value }])); }
  const cursor = (account) => getMeta("cursor:" + account);
  const setCursor = (account, c) => setMeta("cursor:" + account, c);

  globalThis.PolycarpHubStore = {
    DB_NAME, useMemoryStore, open: () => backend().open().then(() => true), onChange,
    putAccount, accounts, removeAccount,
    upsert, remove, update, restore, message, summary, thread, threads, after, allMessages, messagesAfter, allThreads,
    saveDraft, draft, drafts, setSendAt, deleteDraft,
    getMeta, setMeta, cursor, setCursor
  };
})();
