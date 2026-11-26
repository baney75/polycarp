/* Polycarp Hub fake account: a made-up mailbox in memory, the same every time for a seed, for tests, the design pass
   and trying the Hub with no account. Every name, address and word here is invented (example.com and .example
   domains). Classic script; needs adapter.js for the interface it implements. */
(function () {
  "use strict";

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  const FIRST = ["Ada", "Bram", "Cleo", "Dov", "Esme", "Femi", "Greta", "Hugo", "Iris", "Jonah", "Kaia", "Lars", "Mina", "Nico", "Oona", "Pavel"];
  const LAST = ["Arden", "Blake", "Corran", "Dunmore", "Ellery", "Fenwick", "Garrow", "Hale", "Ingram", "Joss"];
  const TOPICS = ["the garden plan", "Thursday's meeting", "the shed roof", "the reading list", "a ride on Sunday", "the budget sheet", "photos from the trip", "the book club", "the porch light", "next week's dinner"];
  const LINES = [
    "Could you look this over when you have a minute?",
    "I put the numbers in the shared sheet; the second tab has the totals.",
    "Thanks for the help yesterday. It made the whole afternoon easier.",
    "Let me know if Tuesday works better than Wednesday.",
    "I found the receipt and attached a copy for your records.",
    "No rush on this. Whenever you get to it is fine.",
    "Here is the short version: we are on track, with one open question."
  ];
  const LISTS = [
    { name: "Field Notes Weekly", addr: "letters@fieldnotes.example", id: "<weekly.fieldnotes.example>" },
    { name: "Garden Almanac", addr: "news@almanac.example", id: "<almanac.example>" },
    { name: "Quiet Tech Digest", addr: "digest@quiettech.example", id: "<digest.quiettech.example>" }
  ];

  // A mailbox of `size` messages for one account, newest last, dated up to 60 days before `now`.
  function corpus(opts) {
    const o = Object.assign({ seed: 7, size: 120, now: Date.UTC(2026, 10, 20, 15, 0), me: "me@home.example" }, opts || {});
    const r = rng(o.seed);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const out = [];
    let n = 0;
    const id = () => "<m" + o.seed + "." + (++n) + "@mail.example>";
    while (out.length < o.size) {
      const date = o.now - Math.floor(r() * 60 * 864e5);
      const kind = r();
      if (kind < 0.45) {
        const who = { name: pick(FIRST) + " " + pick(LAST), addr: "" };
        who.addr = who.name.toLowerCase().replace(" ", ".") + "@example.com";
        const subject = "About " + pick(TOPICS);
        const root = id();
        const replies = Math.floor(r() * 4);
        const refs = [];
        let prev = root;
        for (let i = 0; i <= replies && out.length < o.size; i++) {
          const mine = i % 2 === 1;
          const mid = i === 0 ? root : id();
          out.push({
            remoteId: "f" + n + "-" + i, messageId: mid, inReplyTo: i ? prev : "", references: refs.slice(),
            from: mine ? { name: "Me", addr: o.me } : who, to: [mine ? who : { name: "Me", addr: o.me }],
            subject: (i ? "Re: " : "") + subject, date: date + i * 3600e3, folder: mine ? "sent" : "inbox",
            unread: !mine && r() < 0.4, flagged: r() < 0.08,
            text: pick(LINES) + "\n\n" + pick(LINES) + (mine ? "" : "\n\n" + who.name.split(" ")[0]),
            headers: { authResults: "mx.home.example; dkim=pass header.d=example.com; spf=pass" }
          });
          refs.push(mid);
          prev = mid;
        }
      } else if (kind < 0.7) {
        const list = pick(LISTS);
        out.push({
          remoteId: "f" + (++n), messageId: id(), from: { name: list.name, addr: list.addr }, to: [{ name: "", addr: o.me }],
          subject: list.name + ": " + pick(TOPICS), date, folder: "inbox", unread: r() < 0.7,
          text: "This week: " + pick(LINES) + "\n\nUnsubscribe at any time.",
          html: "<h1>" + list.name + "</h1><p>" + pick(LINES) + "</p><p><a href=\"https://" + list.addr.split("@")[1] + "/read\">Read online</a></p>",
          headers: {
            listId: list.name + " " + list.id, precedence: "bulk",
            listUnsubscribe: "<https://" + list.addr.split("@")[1] + "/unsubscribe?u=1>, <mailto:leave@" + list.addr.split("@")[1] + ">",
            listUnsubscribePost: "List-Unsubscribe=One-Click",
            authResults: "mx.home.example; dkim=pass header.d=" + list.addr.split("@")[1]
          }
        });
      } else if (kind < 0.82) {
        const total = (5 + Math.floor(r() * 9000) / 100).toFixed(2);
        out.push({
          remoteId: "f" + (++n), messageId: id(), from: { name: "Corner Shop", addr: "orders@shop.example" }, to: [{ name: "", addr: o.me }],
          subject: "Your receipt for order " + (1000 + n), date, folder: "inbox", unread: r() < 0.3,
          text: "Thanks for your order. Total: $" + total + ".",
          attachments: [{ id: "a1", name: "receipt-" + (1000 + n) + ".pdf", type: "application/pdf", size: 18000 }],
          headers: { autoSubmitted: "auto-generated", authResults: "mx.home.example; dkim=pass header.d=shop.example" }
        });
      } else if (kind < 0.9) {
        out.push({
          remoteId: "f" + (++n), messageId: id(), from: { name: pick(FIRST) + " " + pick(LAST), addr: "calendar@meet.example" }, to: [{ name: "", addr: o.me }],
          subject: "Invitation: " + pick(TOPICS), date, folder: "inbox", unread: r() < 0.5,
          text: "You are invited. Accept or decline in your calendar.",
          headers: { contentType: "text/calendar; method=request", authResults: "mx.home.example; dkim=pass header.d=meet.example" }
        });
      } else {
        const repo = pick(["garden-app", "shed-tools", "reading-list"]);
        out.push({
          remoteId: "f" + (++n), messageId: id(), from: { name: "Code Host", addr: "notifications@code.example" }, to: [{ name: "", addr: o.me }],
          subject: "[" + repo + "] Pull request #" + (n % 90 + 1) + " was merged", date, folder: "inbox", unread: r() < 0.6,
          text: "The pull request was merged into main.",
          headers: { listId: repo + " <" + repo + ".code.example>", precedence: "list", authResults: "mx.home.example; dkim=pass header.d=code.example" }
        });
      }
    }
    return out.slice(0, o.size).sort((a, b) => a.date - b.date);
  }

  // An adapter over a corpus. `fail` names methods that throw, to test what the Hub does when an account refuses.
  function create(opts) {
    const o = Object.assign({ label: "Made-up mail", address: "me@home.example", fail: [] }, opts || {});
    const box = new Map();
    const log = [];
    const sent = [];
    function add(raw, kind) { box.set(raw.remoteId, Object.assign({}, raw)); log.push({ kind: kind || "put", id: raw.remoteId }); }
    for (const raw of corpus(Object.assign({ me: o.address }, o))) add(raw);
    let next = 1;
    const guard = (name) => { if (o.fail.includes(name)) throw new Error("the made-up account refused " + name); };
    const change = (ids, fn) => { for (const id of ids) { const m = box.get(id); if (m) { fn(m); log.push({ kind: "put", id }); } } return true; };

    return {
      async info() { return { kind: "fake", label: o.label, address: o.address, route: "fake", can: { send: true, change: true } }; },
      async list() { return ["inbox", "archive", "sent", "drafts", "trash", "spam"].map((f) => ({ id: f, name: f[0].toUpperCase() + f.slice(1), role: f })); },
      async threads(q) {
        const qq = Object.assign({ folder: "inbox", limit: 50 }, q || {});
        return Array.from(box.values()).filter((m) => m.folder === qq.folder).sort((a, b) => b.date - a.date).slice(0, qq.limit);
      },
      async read(id) { const m = box.get(id); if (!m) throw new Error("no message " + id); return Object.assign({}, m); },
      async search(query) {
        const q = String(query || "").toLowerCase();
        return Array.from(box.values()).filter((m) => (m.subject + " " + m.text).toLowerCase().includes(q)).map((m) => m.remoteId);
      },
      async send(draft) {
        guard("send");
        const raw = {
          remoteId: "s" + (next++), messageId: "<s" + next + "@home.example>", from: { name: "Me", addr: o.address },
          to: draft.to, cc: draft.cc || [], subject: draft.subject || "", date: Date.now(), folder: "sent", unread: false,
          text: draft.text || "", inReplyTo: draft.inReplyTo || "", references: draft.references || []
        };
        sent.push(raw);
        add(raw);
        return { remoteId: raw.remoteId };
      },
      async reply(id, draft) {
        const m = box.get(id);
        if (!m) throw new Error("no message " + id);
        const refs = [...(m.references || []), m.messageId].filter(Boolean);
        return this.send(Object.assign({ to: [m.from], subject: /^re:/i.test(m.subject) ? m.subject : "Re: " + m.subject, inReplyTo: m.messageId, references: refs }, draft));
      },
      async archive(ids) { guard("archive"); return change(ids, (m) => { m.folder = "archive"; }); },
      async move(ids, folder) { guard("move"); return change(ids, (m) => { m.folder = folder; }); },
      async flag(ids, on) { guard("flag"); return change(ids, (m) => { m.flagged = !!on; }); },
      async markRead(ids, on) { guard("markRead"); return change(ids, (m) => { m.unread = !on; }); },
      async attachment(id, aid) {
        const m = box.get(id);
        const a = m && (m.attachments || []).find((x) => x.id === aid);
        if (!a) throw new Error("no attachment " + aid);
        return { name: a.name, type: a.type, bytes: new TextEncoder().encode("made-up attachment " + a.name) };
      },
      async changesSince(cursor) {
        guard("changesSince");
        const from = Number(cursor) || 0;
        const ids = new Set(log.slice(from).map((e) => e.id));
        const messages = [];
        const removed = [];
        for (const id of ids) { const m = box.get(id); if (m) messages.push(Object.assign({}, m)); else removed.push(id); }
        return { messages, removed, cursor: log.length };
      },
      // Test hooks: new mail arrives, or a message goes away on the account's side.
      deliver(raw) { add(raw); },
      drop(id) { box.delete(id); log.push({ kind: "del", id }); },
      sent
    };
  }

  globalThis.PolycarpHubFake = { corpus, create };
})();
