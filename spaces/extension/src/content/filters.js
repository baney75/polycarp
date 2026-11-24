/* Polycarp feed filters on a page: finds a site's posts, collapses the ones a rule matches (src/shared/filters.js) to a
   one-line bar that says why, with a Show button, and hides a rule's `hide` selectors. Started and stopped by
   content.js with the rest of Polycarp on this page, top frame only; while stopped it keeps no observer and no timer.

   - A collapsed post keeps its own box, so the site's grid, list or virtual scroller keeps its slot: the bar goes inside
     it as the first child and the post's other children are hidden by one class. Nothing of the page is removed.
   - New posts (endless feeds) come through one MutationObserver whose added nodes are gathered and handled once per
     frame, before it is drawn. Each batch looks only under what was added, never the whole page again.
   - Show reveals a post for good on this page, through later rule changes too, and when the site builds the post
     anew (X drops posts that scroll away and makes new ones on the way back): a post is known by its permalink. */
(function () {
  "use strict";
  const P = globalThis.Polycarp || (globalThis.Polycarp = {});
  const F = globalThis.PolycarpFilters;
  if (!F || P.feedFilter) return; // injected twice into one page: the first copy keeps its posts

  const FILTERED = "polycarp-filtered";  // a collapsed post: its children but the bar are hidden
  const ALSO = "polycarp-filtered-also"; // a row that belongs to a collapsed post (Hacker News), hidden whole
  const BAR = "polycarp-filter-bar";
  const PAGE_ROOTS = "html,body,head,main,[role=main]";
  const BASE_CSS =
    "." + FILTERED + ">:not(" + BAR + "):not([data-polycarp-bar]){display:none !important}" +
    "." + FILTERED + "{min-height:0 !important;height:auto !important;font-size:0 !important}" +
    "." + ALSO + "{display:none !important}";
  const BAR_CSS = `
    :host{all:initial;display:block}
    .bar{display:flex;align-items:center;gap:8px;min-height:28px;box-sizing:border-box;margin:0;padding:0 4px 0 12px;
      border:var(--pc-border-width) solid var(--pc-border);border-radius:var(--pc-radius);background:var(--pc-surface);
      color:var(--pc-muted);font:var(--pc-font-weight) 13px/1.3 var(--pc-font-ui)}
    .why{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    button{all:unset;cursor:pointer;padding:3px 10px;border-radius:var(--pc-radius-small);color:var(--pc-foreground);font-weight:650}
    button:hover{background:var(--pc-sunken)}
    button:focus-visible{outline:2px solid var(--pc-strong);outline-offset:1px}`;

  // ---------------------------------------------------------------- post text
  // Text as a person reads it: blocks apart, inline runs whole. textContent runs a name, a time and the post together
  // ("1hcrypto"), so a word at the edge of one would miss; <b>cry</b>pto must stay one word.
  const INLINE = new Set("A ABBR B BDI BDO CITE CODE DATA DEL DFN EM FONT I INS KBD LABEL MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME U VAR POLYCARP-T POLYCARP-B POLYCARP-R".split(" "));
  const NO_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  function itemText(root, max) {
    max = max || F.MAX_TEXT;
    const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let out = "", lastBlock = null;
    for (let n = w.nextNode(); n && out.length < max; n = w.nextNode()) {
      const parent = n.parentNode;
      if (!n.nodeValue || (parent && NO_TEXT.has(parent.tagName))) continue;
      let block = parent;
      while (block && block !== root && INLINE.has(block.tagName)) block = block.parentNode;
      if (lastBlock && block !== lastBlock) out += "\n";
      out += n.nodeValue;
      lastBlock = block;
    }
    return out.slice(0, max);
  }

  // ---------------------------------------------------------------- site adapters
  // Each: items (one post), and optionally target (what collapses), also (rows that go with it), text, accounts, kinds,
  // shelf (an item whose own items are posts too), key (the post's permalink, the same when the site builds it again). Selectors are the sites' own stable hooks (data-testid, element names).
  function linkHandle(a, re) {
    const m = re.exec(a.getAttribute("href") || "");
    if (!m) return "";
    try { return F.normalizeHandle(decodeURIComponent(m[1])); } catch (e) { return F.normalizeHandle(m[1]); }
  }
  function firstHandle(root, sel, re, keep) {
    if (!root) return [];
    for (const a of root.querySelectorAll(sel)) { const h = (!keep || keep(a)) ? linkHandle(a, re) : ""; if (h) return [h]; }
    return [];
  }
  const textIs = (item, sel, re, skip) => [...item.querySelectorAll(sel)].some((e) => (!skip || !e.closest(skip)) && re.test((e.textContent || "").trim()));

  const X = {
    id: "x",
    items: 'article[data-testid="tweet"]',
    key(item) {
      const a = item.querySelector('[data-testid="User-Name"] a[href*="/status/"]');
      const m = a && /^\/([^/]+)\/status\/(\d+)/.exec(a.getAttribute("href") || "");
      return m ? "x:" + m[1].toLowerCase() + "/" + m[2] : "";
    },
    // The author is the post's first name line; a quoted post below it names its own author.
    accounts(item) {
      const out = firstHandle(item.querySelector('[data-testid="User-Name"]'), "a[href]", /^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/);
      const av = item.querySelector('[data-testid^="UserAvatar-Container-"]');
      if (av) out.push(F.normalizeHandle(av.getAttribute("data-testid").slice("UserAvatar-Container-".length)));
      return out;
    },
    kinds(item) {
      const out = [];
      if (textIs(item, "span", /^(Ad|Promoted)$/, '[data-testid="tweetText"]')) out.push("promoted");
      const ctx = item.querySelector('[data-testid="socialContext"]');
      if (ctx && /repost|retweet/i.test(ctx.textContent)) out.push("reposts");
      return out;
    }
  };

  // Any other site, Mastodon included: articles, with their author read from one author-shaped link (/@name,
  // /user/name, /u/name): the first in a header or with rel=author, else the first at all. A link inside an article
  // nested in this one is that article's. Mastodon's "Bob boosted" line names who shared the post, not who wrote it.
  const ARTICLE = "article,[role=article]";
  const AUTHOR_LINK = /\/(?:@|users?\/|u\/)([^/?#]+)/;
  const PREPEND = ".status__prepend";
  const GENERIC = {
    id: "web",
    items: ARTICLE,
    // Conservative: a long article is the page's own reading, not a post in a feed.
    maxText: 4000,
    // The post's own time link (Mastodon's status link), not one in a post nested in it.
    key(item) {
      for (const t of item.querySelectorAll("a[href] time")) {
        const a = t.closest("a[href]");
        if (a.closest(ARTICLE) === item) return "web:" + a.href;
      }
      return "";
    },
    accounts(item) {
      const own = (a) => { if (a.closest(PREPEND)) return false; const art = a.closest(ARTICLE); return !art || art.contains(item); };
      const byline = firstHandle(item, ':scope header a[href], a[rel~="author"][href]', AUTHOR_LINK, own);
      return byline.length ? byline : firstHandle(item, "a[href]", AUTHOR_LINK, own);
    },
    kinds(item) {
      const pre = item.querySelector(PREPEND);
      return pre && (/boost|reblog|shared/i.test(pre.textContent) || pre.querySelector("[class*=retweet],[class*=repeat],[class*=boost]")) ? ["reposts"] : [];
    }
  };

  const SITES = [[/(^|\.)(x|twitter)\.com$/, X]];
  function adapterFor(hostname, doc) {
    const h = String(hostname || "").toLowerCase();
    for (const [re, a] of SITES) if (re.test(h)) return a;
    return GENERIC;
  }

  // ---------------------------------------------------------------- the filter on one page
  function create(doc, hostname) {
    const win = doc.defaultView;
    const site = adapterFor(hostname, doc);
    let compiled = null;
    let sheet = null, styleEl = null;
    let barSheet = null, barMode = "pc-light";
    const hidden = new Map();        // item -> { target, bar, also }
    const revealed = new WeakSet();  // items the person chose to see
    const revealedKeys = new Set();  // and their permalinks, for when the site builds the same post again
    const keyOf = (item) => (site.key ? site.key(item) : "");
    const pending = new Set();
    let scheduled = false, observer = null, running = false;
    const stats = { hidden: 0, batches: 0, checked: 0, maxBatchMs: 0, rules: 0, refused: 0, hideSelectors: 0 };

    function setCss(text) {
      try {
        if (!sheet) { sheet = new win.CSSStyleSheet(); doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]; }
        sheet.replaceSync(text);
        return;
      } catch (e) { sheet = null; }
      if (!styleEl) { styleEl = doc.createElement("style"); styleEl.id = "polycarp-filter-style"; (doc.head || doc.documentElement).appendChild(styleEl); }
      styleEl.textContent = text;
    }
    function clearCss() {
      if (sheet) { try { doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet); } catch (e) {} sheet = null; }
      if (styleEl) { styleEl.remove(); styleEl = null; }
    }
    // The page's html and body are never hidden, whatever a selector says.
    const hideCss = (list) => list.map((s) => ":is(" + s + "):not(html,body,head," + BAR + "){display:none !important}").join("\n");
    const selectorOk = (s) => { try { doc.querySelector(s); return true; } catch (e) { return false; } };

    function pageIsDark() {
      for (const el of [doc.body, doc.documentElement]) {
        if (!el) continue;
        const m = win.getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
        if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
        return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.45;
      }
      return win.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    function ensureBarSheet() {
      if (barSheet) return;
      barSheet = new win.CSSStyleSheet();
      barSheet.replaceSync(BAR_CSS);
      barMode = pageIsDark() ? "pc-dark" : "pc-light";
      if (P.themeCss) P.themeCss().then((css) => { try { barSheet.replaceSync(P.shadowThemeCss(css) + BAR_CSS); } catch (e) {} });
    }

    function makeBar(item, reason) {
      ensureBarSheet();
      const host = doc.createElement(BAR);
      host.setAttribute("data-polycarp-skip", "");
      const root = host.attachShadow({ mode: "open" });
      root.adoptedStyleSheets = [barSheet];
      const box = doc.createElement("div");
      box.className = "bar " + barMode;
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", "Post hidden by your Polycarp filter");
      const why = doc.createElement("span");
      why.className = "why";
      why.textContent = "Hidden: " + reason;
      const show = doc.createElement("button");
      show.type = "button";
      show.textContent = "Show";
      show.setAttribute("aria-label", "Show this post, hidden for " + reason);
      show.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); reveal(item); });
      box.append(why, show);
      root.append(box);
      return host;
    }

    function collapse(item, target, also, reason) {
      const had = hidden.get(item);
      if (had && had.reason === reason) return;
      if (had) unhide(item);
      let bar = makeBar(item, reason);
      if (target.tagName === "TR") { // a table row takes a cell, across every column
        const td = doc.createElement("td");
        td.colSpan = 99;
        td.setAttribute("data-polycarp-bar", "");
        td.appendChild(bar);
        bar = td;
      }
      target.insertBefore(bar, target.firstChild);
      target.classList.add(FILTERED);
      for (const a of also) a.classList.add(ALSO);
      hidden.set(item, { target, bar, also, reason });
    }
    function unhide(item) {
      const h = hidden.get(item);
      if (!h) return;
      hidden.delete(item);
      h.bar.remove();
      h.target.classList.remove(FILTERED);
      for (const a of h.also) a.classList.remove(ALSO);
    }
    function reveal(item) {
      revealed.add(item);
      const k = keyOf(item);
      if (k) revealedKeys.add(k);
      unhide(item);
      stats.hidden = hidden.size;
    }

    function check(item) {
      if (revealed.has(item) || item.matches(PAGE_ROOTS)) return;
      if (revealedKeys.size && revealedKeys.has(keyOf(item))) { revealed.add(item); unhide(item); return; }
      // An item inside another item is the outer one's, unless the outer one is a shelf of posts.
      const outer = item.parentElement && item.parentElement.closest(site.items);
      if (outer && !(site.shelf && outer.matches(site.shelf))) return;
      const text = site.text ? site.text(item) : itemText(item);
      if (site.maxText && text.length >= site.maxText) return;
      const target = site.target ? site.target(item) : item;
      if (!target || target.matches(PAGE_ROOTS)) return;
      stats.checked++;
      const hit = compiled.test({
        text,
        accounts: () => (site.accounts ? site.accounts(item) : []).filter(Boolean),
        kinds: () => (site.kinds ? site.kinds(item) : [])
      });
      if (hit) collapse(item, target, site.also ? site.also(item).filter((a) => !a.matches(PAGE_ROOTS)) : [], hit.reason);
      else unhide(item);
    }

    const ours = (n) => n.nodeType === 1 && (n.tagName === BAR || n.tagName.startsWith("POLYCARP-") || n.hasAttribute("data-polycarp-bar"));
    function batch() {
      scheduled = false;
      if (!compiled || !compiled.size) { pending.clear(); return; }
      const t0 = performance.now();
      const roots = [...pending];
      pending.clear();
      const found = new Set();
      for (const root of roots) {
        if (!root.isConnected) continue;
        const up = root.closest(site.items); // text that arrived inside a post already here: check the post again
        if (up) found.add(up);
        for (const el of root.querySelectorAll(site.items)) found.add(el);
      }
      for (const item of found) check(item);
      for (const [item, h] of hidden) if (!item.isConnected) { hidden.delete(item); if (h.bar.isConnected) h.bar.remove(); }
      stats.hidden = hidden.size;
      stats.batches++;
      stats.maxBatchMs = Math.max(stats.maxBatchMs, performance.now() - t0);
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      // Before the next frame is drawn; a background tab draws none, so it gets a timer.
      if (doc.visibilityState !== "hidden") win.requestAnimationFrame(batch); else setTimeout(batch, 0);
    }
    function onMutations(records) {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) { if (!ours(n)) pending.add(n); }
          else if (n.parentElement && !ours(n.parentElement)) pending.add(n.parentElement);
        }
      }
      if (pending.size) schedule();
    }
    const onVisibility = () => { if (pending.size) batch(); };

    function showAll() { for (const item of [...hidden.keys()]) unhide(item); stats.hidden = 0; }

    // New rules: everything is checked again at once, with no frame drawn in between.
    function update(rules) {
      compiled = F.compile(rules, hostname, { checkSelector: selectorOk });
      stats.rules = compiled.size;
      stats.refused = compiled.refused.length;
      stats.hideSelectors = compiled.hide.length;
      showAll();
      if (!compiled.size && !compiled.hide.length) { stop(); return; }
      setCss(BASE_CSS + "\n" + hideCss(compiled.hide));
      if (!compiled.size) { disconnect(); return; }
      if (!observer) {
        observer = new win.MutationObserver(onMutations);
        observer.observe(doc.documentElement, { childList: true, subtree: true });
        doc.addEventListener("visibilitychange", onVisibility);
      }
      running = true;
      pending.add(doc.documentElement);
      batch();
    }
    function disconnect() {
      if (observer) { observer.disconnect(); observer = null; doc.removeEventListener("visibilitychange", onVisibility); }
      pending.clear();
    }
    function stop() {
      running = false;
      disconnect();
      showAll();
      clearCss();
    }
    function flush() {
      if (observer) onMutations(observer.takeRecords());
      if (pending.size) batch();
    }
    return { update, stop, flush, site: site.id, running: () => running, stats: () => Object.assign({}, stats, { site: site.id }) };
  }

  // ---------------------------------------------------------------- wiring for content.js
  // Rules come from storage: the app's (kept fresh by the service worker) and this browser's own. A change there
  // reaches this page through storage.onChanged, with no reload.
  let page = null, listening = false, want = false;
  async function load() {
    const got = await chrome.storage.local.get([F.APP_KEY, F.LOCAL_KEY]);
    const app = got[F.APP_KEY] && Array.isArray(got[F.APP_KEY].rules) ? got[F.APP_KEY].rules : [];
    return F.merge(app, got[F.LOCAL_KEY]);
  }
  function onStorage(changes, area) {
    if (area === "local" && want && (changes[F.APP_KEY] || changes[F.LOCAL_KEY])) apply();
  }
  async function apply() {
    let rules = [];
    try { rules = await load(); } catch (e) { return; }
    if (!want) return;
    if (!page) page = create(document, location.hostname);
    try { page.update(rules); } catch (e) { /* a broken rule never breaks the page */ }
  }
  P.feedFilter = {
    start() {
      want = true;
      if (!listening) { chrome.storage.onChanged.addListener(onStorage); listening = true; }
      return apply();
    },
    stop() {
      want = false;
      if (listening) { try { chrome.storage.onChanged.removeListener(onStorage); } catch (e) {} listening = false; }
      if (page) page.stop();
    },
    stats: () => (page ? page.stats() : null),
    create, adapterFor, itemText
  };
})();
