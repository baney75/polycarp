/* Polycarp document store: the full text of every document opened in the Reader or added to the
   Library, kept in IndexedDB so it reopens offline. The Library index (library.js) points here by key. */
(function () {
  "use strict";
  let db = null;
  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("polycarp-reader", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("docs", { keyPath: "key" });
      r.onsuccess = () => { db = r.result; res(db); };
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction("docs", mode);
      const out = fn(t.objectStore("docs"));
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  // Plain text of a document, for search and linking.
  function textOf(doc) {
    const parts = [];
    for (const s of (doc && doc.sections) || []) {
      parts.push(String(s.html || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|li|h\d|div|blockquote|dd|dt|pre|tr)>/gi, "\n").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    }
    return parts.join("\n").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  }
  globalThis.PolycarpDocs = {
    open,
    get(key) { return tx("readonly", (s) => s.get(key)); },
    all() { return tx("readonly", (s) => s.getAll()); },
    del(key) { return tx("readwrite", (s) => s.delete(key)); },
    put(entry) { return tx("readwrite", (s) => s.put(entry)); },
    textOf
  };
})();
