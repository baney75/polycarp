/* Polycarp Hub organizing: which bundle a thread belongs in, read from its headers alone (never a model), and how a
   list of threads is grouped on screen. Pure functions. Classic script for extension pages and Node tests. */
(function () {
  "use strict";

  const BUNDLES = [
    { id: "newsletters", name: "Newsletters" },
    { id: "receipts", name: "Receipts" },
    { id: "calendar", name: "Calendar" },
    { id: "code", name: "Code" }
  ];

  // A thread you wrote in stays with people. Otherwise, first match wins:
  //   calendar     Content-Type text/calendar, or a .ics attachment
  //   code         a List-Id, sent by a notifications or no-reply address, with a "[project]" subject
  //   newsletters  a List-Id or List-Unsubscribe, or Precedence bulk or list
  //   receipts     Auto-Submitted auto-generated (a vacation reply, auto-replied, is a person's)
  function bundleOf(t) {
    if (t.replied) return "";
    const h = t.headers || {};
    if (/text\/calendar/.test(h.contentType)) return "calendar";
    const from = (t.from && t.from.addr) || "";
    if (h.listId && /^(notifications?|no-?reply|noreply)@/.test(from) && /^\s*\[[^\]]+\]/.test(t.subject)) return "code";
    if (h.listId || h.listUnsubscribe || h.precedence === "bulk" || h.precedence === "list") return "newsletters";
    if (h.autoSubmitted === "auto-generated") return "receipts";
    return "";
  }

  const DAY = 864e5;
  function dayStart(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

  // Groups for the inbox: unread mail from people first ("Needs you"), then the rest by day, each day closing with one
  // line per bundle that got mail that day. `fold` false lists bundled threads in place (a folder or a bundle's own view).
  function groups(threads, now, fold) {
    const today = dayStart(now);
    const spans = [["Today", today], ["Yesterday", today - DAY], ["This week", today - 6 * DAY], ["Earlier", -Infinity]];
    const out = [];
    const needs = fold ? threads.filter((t) => !bundleOf(t) && t.unread > 0) : [];
    if (needs.length) out.push({ name: "Needs you", threads: needs, bundles: [] });
    const rest = threads.filter((t) => !needs.includes(t));
    let i = 0;
    for (const [name, from] of spans) {
      const g = { name, threads: [], bundles: [] };
      const counts = new Map();
      while (i < rest.length && rest[i].lastDate >= from) {
        const t = rest[i++];
        const b = fold ? bundleOf(t) : "";
        if (!b) { g.threads.push(t); continue; }
        const c = counts.get(b) || { id: b, name: BUNDLES.find((x) => x.id === b).name, count: 0, unread: 0 };
        c.count++;
        if (t.unread) c.unread++;
        counts.set(b, c);
      }
      g.bundles = BUNDLES.map((b) => counts.get(b.id)).filter(Boolean);
      if (g.threads.length || g.bundles.length) out.push(g);
    }
    return out;
  }

  globalThis.PolycarpHubOrganize = { BUNDLES, bundleOf, groups };
})();
