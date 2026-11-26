/* Polycarp Hub unsubscribe: what leaving a mailing list would take, read from the message's own headers, and the one
   request Polycarp sends itself, the one-click POST of RFC 8058. Nothing is sent until the person has seen it.
   Classic script for extension pages and Node tests. */
(function () {
  "use strict";

  const BODY = "List-Unsubscribe=One-Click";
  const MAX = 2048;

  // The <...> entries of a List-Unsubscribe header, in order.
  function entries(header) {
    const s = String(header || "").slice(0, 8 * MAX);
    const out = [];
    const re = /<([^<>]*)>/g;
    let m;
    while ((m = re.exec(s))) { const u = m[1].replace(/\s+/g, ""); if (u && u.length <= MAX) out.push(u); }
    return out;
  }

  // A host Polycarp will POST to: a name with a dot, never an address written as numbers, never a name this machine or
  // a home or office network uses. (An IPv6 address reads back as "[...]" with no dot, so it is refused too.) This reads
  // names only: a public name can still point at a private address, which a page can't see, so the dialog shows the
  // address before anything is sent.
  function publicHost(h) {
    if (!h || /^[\d.]+$/.test(h) || !h.includes(".")) return false;
    return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|test|invalid)$/.test(h.replace(/\.$/, ""));
  }

  function https(u) {
    let url;
    try { url = new URL(u); } catch (e) { return null; }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (!publicHost(url.hostname)) return null;
    return url;
  }
  function mailto(u) {
    if (!/^mailto:/i.test(u)) return null;
    const [addr, query] = u.slice(7).split("?");
    let to;
    try { to = decodeURIComponent(addr); } catch (e) { return null; }
    if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(to)) return null;
    const q = new URLSearchParams(query || "");
    return { to: to.toLowerCase(), subject: (q.get("subject") || "unsubscribe").slice(0, 200), body: (q.get("body") || "").slice(0, 2000) };
  }

  // The DKIM domain that passed, when it is the sender's own domain or one above it.
  function signer(authResults, fromAddr) {
    const domain = String(fromAddr || "").split("@")[1];
    if (!domain) return "";
    for (const part of String(authResults || "").toLowerCase().split(";")) {
      if (!/^\s*dkim=pass\b/.test(part)) continue;
      const d = (/header\.d=([a-z0-9.-]+)/.exec(part) || [])[1];
      if (d && d.includes(".") && (domain.toLowerCase() === d || domain.toLowerCase().endsWith("." + d))) return d;
    }
    return "";
  }

  // What leaving takes, best first:
  //   {kind: "post", url, body, signer}   one click, sent by Polycarp after the person agrees
  //   {kind: "mail", to, subject, body}   a message the person sends themselves
  //   {kind: "page", url}                 the sender's page, opened for the person
  // or null when the headers offer nothing usable.
  function plan(m) {
    const h = (m && m.headers) || {};
    const list = entries(h.listUnsubscribe);
    if (!list.length) return null;
    const pages = list.map(https).filter(Boolean);
    const oneClick = String(h.listUnsubscribePost || "").trim().toLowerCase() === BODY.toLowerCase();
    const d = signer(h.authResults, m.from && m.from.addr);
    if (pages.length && oneClick && d) return { kind: "post", url: pages[0].href, body: BODY, signer: d };
    const mail = list.map(mailto).find(Boolean);
    if (mail) return Object.assign({ kind: "mail" }, mail);
    if (pages.length) return { kind: "page", url: pages[0].href };
    return null;
  }

  // Sends the one-click request, once: a form POST with no cookies, no sign-in and no referrer. A redirect is refused,
  // so the address the dialog showed is the only one that gets it. The extension may read any site's answer, so the
  // answer says what the list did; no answer throws, and nothing is counted as sent.
  async function send(p, fetchImpl) {
    if (!p || p.kind !== "post" || !https(p.url)) throw new Error("not a one-click request");
    const f = fetchImpl || globalThis.fetch;
    const init = { method: "POST", body: BODY, headers: { "Content-Type": "application/x-www-form-urlencoded" },
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" };
    let r;
    try { r = await f(p.url, init); } catch (e) {
      throw new Error("no answer came back, or it tried to send the request on to another address");
    }
    return { ok: r.ok, status: r.status };
  }

  globalThis.PolycarpHubUnsubscribe = { BODY, entries, publicHost, signer, plan, send };
})();
