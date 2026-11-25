/* Polycarp Hub model: one shape for a message from any account, the key that groups it into a thread, and a thread's
   summary. Pure functions; no storage, no network. Classic script for extension pages and Node tests. */
(function () {
  "use strict";

  const FOLDERS = ["inbox", "archive", "sent", "drafts", "trash", "spam"];
  const SNIPPET_LEN = 160;

  // "Ada Lovelace <ada@example.com>" or a bare address into {name, addr}. The address is lowercased; the name is kept.
  function address(v) {
    if (v && typeof v === "object") return { name: String(v.name || "").trim(), addr: String(v.addr || "").trim().toLowerCase() };
    const s = String(v || "").trim();
    const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim(), addr: m[2].trim().toLowerCase() };
    return { name: "", addr: s.toLowerCase() };
  }

  function addresses(v) {
    if (!v) return [];
    const list = Array.isArray(v) ? v : String(v).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    return list.map(address).filter((a) => a.addr);
  }

  // Message-IDs as written in headers: "<a@b>" pieces, brackets kept so they compare exactly.
  function ids(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    return String(v).match(/<[^<>\s]+>/g) || [];
  }

  function snippetOf(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN);
  }

  // Subjects compare without reply and forward prefixes, case or extra spaces.
  function baseSubject(s) {
    let out = String(s || "").trim();
    for (;;) {
      const next = out.replace(/^(re|fwd?|aw|sv|tr)(\[\d+\])?\s*:\s*/i, "").trim();
      if (next === out) break;
      out = next;
    }
    return out.replace(/\s+/g, " ").toLowerCase();
  }

  // What an adapter hands over becomes one stored message. `raw.headers` holds only the headers the Hub reads.
  function normalize(accountId, raw) {
    if (!accountId || !raw || raw.remoteId == null) throw new Error("a message needs an account and a remoteId");
    const h = raw.headers || {};
    const folder = String(raw.folder || "inbox");
    const text = raw.text == null ? "" : String(raw.text);
    return {
      id: accountId + ":" + raw.remoteId,
      account: accountId,
      remoteId: String(raw.remoteId),
      threadHint: raw.threadHint ? String(raw.threadHint) : "",
      messageId: ids(raw.messageId)[0] || "",
      inReplyTo: ids(raw.inReplyTo)[0] || "",
      references: ids(raw.references),
      from: address(raw.from),
      to: addresses(raw.to),
      cc: addresses(raw.cc),
      replyTo: addresses(raw.replyTo),
      subject: String(raw.subject || ""),
      date: Number(raw.date) || 0,
      snippet: snippetOf(raw.snippet || text),
      unread: raw.unread !== false,
      flagged: raw.flagged === true,
      folder,
      labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
      headers: {
        listId: String(h.listId || ""),
        listUnsubscribe: String(h.listUnsubscribe || ""),
        listUnsubscribePost: String(h.listUnsubscribePost || ""),
        precedence: String(h.precedence || "").toLowerCase(),
        autoSubmitted: String(h.autoSubmitted || "").toLowerCase(),
        authResults: String(h.authResults || ""),
        contentType: String(h.contentType || "").toLowerCase()
      },
      text,
      html: raw.html == null ? "" : String(raw.html),
      attachments: Array.isArray(raw.attachments)
        ? raw.attachments.map((a) => ({ id: String(a.id), name: String(a.name || "attachment"), type: String(a.type || ""), size: Number(a.size) || 0 }))
        : [],
      snoozeUntil: Number(raw.snoozeUntil) || 0,
      remindAt: Number(raw.remindAt) || 0,
      draftBy: raw.draftBy ? String(raw.draftBy) : ""
    };
  }

  // Stable hash for thread ids: two FNV-1a passes from different starts, 64 bits in base 36, so a mailbox of a million
  // threads has about one chance in 36,000 of two sharing an id. Not for security.
  function fnv(s, h) {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36).padStart(7, "0");
  }
  function hash(s) { return fnv(s, 0x811c9dc5) + fnv(s, 0x2b8f1d3a); }

  // The thread a message joins. A provider's own thread id wins; then any message already stored that this one names
  // or that names it (`known` maps a Message-ID to its thread id); then the root of its References, so replies whose
  // parent never arrived still meet; then the subject with the people in it.
  function threadKey(msg, known) {
    if (msg.threadHint) return msg.account + ":t" + hash(msg.threadHint);
    const named = [...msg.references, msg.inReplyTo, msg.messageId].filter(Boolean);
    if (known) for (const id of named) { const t = known.get(id); if (t) return t; }
    const root = msg.references[0] || msg.inReplyTo;
    if (root) return msg.account + ":r" + hash(root);
    if (msg.messageId && !/^(re|fwd?|aw|sv)\s*:/i.test(msg.subject)) return msg.account + ":r" + hash(msg.messageId);
    const people = [msg.from.addr, ...msg.to.map((a) => a.addr)].sort().join(",");
    return msg.account + ":s" + hash(baseSubject(msg.subject) + "|" + people);
  }

  // A thread's summary from its messages. A thread sits in the inbox while any of its messages does.
  function summarize(threadId, messages) {
    const list = messages.slice().sort((a, b) => a.date - b.date);
    const last = list[list.length - 1];
    const folders = new Set(list.map((m) => m.folder));
    const folder = folders.has("inbox") ? "inbox" : last.folder;
    const people = [];
    const seen = new Set();
    for (const m of list) {
      if (m.folder === "sent" || seen.has(m.from.addr)) continue;
      seen.add(m.from.addr);
      people.push(m.from);
    }
    const first = list.find((m) => m.subject) || last;
    return {
      id: threadId,
      account: last.account,
      subject: first.subject,
      people,
      lastDate: last.date,
      count: list.length,
      unread: list.filter((m) => m.unread).length,
      flagged: list.some((m) => m.flagged),
      folder,
      snippet: last.snippet,
      snoozeUntil: Math.max(0, ...list.map((m) => m.snoozeUntil)),
      remindAt: Math.max(0, ...list.map((m) => m.remindAt)),
      hasAttachments: list.some((m) => m.attachments.length > 0),
      replied: list.some((m) => m.folder === "sent"),
      headers: last.headers,
      from: last.from
    };
  }

  globalThis.PolycarpHubModel = { FOLDERS, address, addresses, ids, baseSubject, normalize, threadKey, summarize, hash };
})();
