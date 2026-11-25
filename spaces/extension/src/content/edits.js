/* Polycarp page edits on a page: applies the edits of this site and path (src/shared/edits.js) and takes them back whole
   when they change, when Polycarp is off here, or when the page moves on. Top frame only, from the start of the document.

   - hide, style and css are stylesheets, so they are in force as early as a page can be and hold for parts that come
     later. Each edit has its own sheet: one that doesn't parse leaves the others alone.
   - text, attr, move and insert change the document, and again for parts that come later, through one MutationObserver
     handled once a frame. What each one replaced is kept, and put back unless the page has changed it since.
   - move shows a copy where the part should be and hides the page's own, which stays where the page put it: a page that
     holds on to its own nodes (React, Vue) breaks when one isn't where it left it.
   - A part the page puts back REDO times in a row is left alone, so an edit never fights a page forever.
   - Form fields, editors and scripts are never touched: nothing a person typed or will send changes. */
(function () {
  "use strict";
  const P = globalThis.Polycarp || (globalThis.Polycarp = {});
  const E = globalThis.PolycarpEdits, S = globalThis.PolycarpEditsStore;
  if (!E || !S || P.pageEdits || !/html/.test(document.contentType) || window !== window.top) return;

  const NOTE = "polycarp-note";
  const MOVED = "polycarp-moved", AWAY = "data-polycarp-moved";
  const OFF_LIMITS = E.NEVER + "," + E.EDITORS + "," + E.OURS;
  const STAYS = E.EDITORS + "," + E.CARRY; // what a moved part may not be or hold
  const HOLDS = STAYS + ",video,audio,canvas";
  const VOID = "img,input,br,hr,video,audio,canvas,iframe,embed,object,textarea,select";
  const MOST = 2000; // matches one text or attr change acts on
  const REDO = 30;   // times in a row, each within REST ms of the last, one change is made on one part of the page
  const REST = 1000;
  const KEPT = 1000; // what was replaced is kept for parts still on the page once there are more than this many
  const NOTE_CSS = `
    :host{all:initial !important;display:block !important;margin:12px 0 !important}
    .note{box-sizing:border-box;padding:12px 16px;border:var(--pc-border-width) solid var(--pc-border);
      border-radius:var(--pc-radius);background:var(--pc-surface);color:var(--pc-foreground);font:var(--pc-font-weight) 15px/1.5 var(--pc-font-ui);text-align:start;overflow-wrap:anywhere}
    .from{display:block;color:var(--pc-muted);font-size:12px;margin-bottom:4px}
    h2{font-size:17px;line-height:1.3;margin:0 0 4px;color:var(--pc-strong)} p,ul{margin:0 0 6px} ul{padding-inline-start:20px}
    a{color:var(--pc-accent)} a:focus-visible{outline:2px solid var(--pc-strong);outline-offset:2px} :last-child{margin-bottom:0}`;

  function create(doc) {
    const win = doc.defaultView;
    let edits = [], sheets = [], undo = [], notes = [];
    let room = KEPT, observer = null, timer = 0, frame = 0, lastMs = 0, themeCss = null, unwatch = null, inert = null, more = false;
    let state = new Map(); // a change -> { tries: WeakMap, last: WeakMap, count, did, note, host, at, el, html }
    let wrote = new WeakMap(); // a text node -> { orig, now }: the page's words, and ours

    const tagIs = (el, sel) => { try { return el.matches(sel); } catch (e) { return false; } };
    const offLimits = (el) => el.isContentEditable || !!el.closest(OFF_LIMITS);
    const isRoot = (el) => tagIs(el, "html,body,head");
    const ok = (sel) => { try { doc.querySelector(sel); return true; } catch (e) { return false; } };
    const all = (sel) => { try { return [...doc.querySelectorAll(sel)]; } catch (e) { return []; } };
    const first = (sel, not) => all(sel).find((el) => !el.closest(E.OURS) && !(not && not(el))) || null;
    const st = (c) => { let s = state.get(c); if (!s) state.set(c, s = { tries: new WeakMap(), last: new WeakMap(), count: 0, did: false, note: "", host: null, at: null, el: null, html: "" }); return s; };
    // Whether a change may act on this part again. New words each time (a price, a counter) aren't a page fighting back.
    function again(s, el, was = "") {
      const t = s.tries.get(el), now = win.performance.now();
      const n = t && (t.n > REDO || (t.was === was && now - t.at < REST)) ? t.n + 1 : 1;
      s.tries.set(el, { n, at: now, was });
      if (n > REDO) { s.note = "the page keeps changing it back, so it was left alone"; return false; }
      return true;
    }

    function keep(el, back) {
      undo.push({ el, back });
      if (undo.length <= room) return;
      undo = undo.filter((u) => u.el.isConnected);
      room = Math.max(KEPT, undo.length * 2);
    }

    // -------------------------------------------------------------- words
    // Polycarp's own bold anchors (bionic.js) empty a text node and draw its words in a wrapper just after it. Writing to
    // the node takes the wrapper away; the restyler sees that and draws its markup again.
    const wrapper = (t) => { const n = t.nextSibling; return t.nodeValue === "" && n && n.nodeName === "POLYCARP-T" ? n : null; };
    const words = (t) => { const w = wrapper(t); return w ? w.textContent : t.nodeValue; };
    function write(t, v) {
      const w = wrapper(t);
      if (w) w.remove();
      t.nodeValue = v;
    }
    function textNodes(el, skip) {
      const out = [], no = OFF_LIMITS + ",polycarp-t,svg title,svg desc" + skip;
      const w = doc.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (n) =>
        n.nodeType === 3 ? NodeFilter.FILTER_ACCEPT : tagIs(n, no) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (words(n).trim()) out.push(n);
      return out;
    }
    // Words change inside the text nodes the page made, never by replacing them: a page that holds on to its own nodes
    // (React, Vue) goes on working.
    function swapped(v, c) {
      const swap = (x) => x.split(c.find).join(c.text);
      // "cat" to "cats" must not make "catss" the next time.
      return c.text.includes(c.find) ? v.split(c.text).map(swap).join(c.text) : swap(v);
    }
    function reword(t, was, now) {
      let r = wrote.get(t);
      if (!r) {
        wrote.set(t, r = { orig: was, now });
        keep(t, () => { if (words(t) === r.now) write(t, r.orig); });
      } else if (was !== r.now) {
        // A page that only added to a text node we changed added to its own words.
        r.orig = r.now && was.startsWith(r.now) ? r.orig + was.slice(r.now.length) : was;
      }
      r.now = now;
      write(t, now);
    }
    // The deepest last node: while the page loads, the parser may still be adding to it and to every part around it.
    function filling() {
      if (doc.readyState !== "loading") return null;
      let n = doc.documentElement;
      while (n && n.lastChild) n = n.lastChild;
      return n;
    }
    // What a part needs while the page loads: the last of its kind so far may not be the last.
    const early = (c) => !/:(?!is\(|where\()/.test(c.at);
    function text(c, s) {
      const end = filling(), asked = new Map();
      let work = 0;
      s.count = 0; s.note = "";
      const may = (p, was) => { if (!asked.has(p)) asked.set(p, again(s, p, was)); return asked.get(p); };
      for (const el of all(c.at)) {
        if (isRoot(el) || offLimits(el)) continue;
        if (!c.find && el.querySelector(HOLDS)) { s.note = "holds a form field, media or a button; name a smaller part"; continue; }
        s.count++;
        const is = el.textContent;
        if (s.last.get(el) === is || (c.find ? !is.includes(c.find) : is.trim() === c.text.trim())) continue;
        if (!c.find && end && el.contains(end)) continue;
        if (work >= MOST) { more = true; continue; }
        let did = false;
        textNodes(el, c.find ? "" : ",svg").forEach((t, i) => {
          if (t === end) return;
          const was = words(t), now = c.find ? swapped(was, c) : i ? "" : c.text;
          if (now === was || !may(c.find ? t.parentNode : el, was)) return;
          reword(t, was, now);
          did = true;
        });
        if (did) { work++; s.did = true; }
        if (!end) s.last.set(el, el.textContent);
      }
    }

    function attr(c, s) {
      let work = 0;
      s.count = 0; s.note = "";
      for (const el of all(c.at)) {
        if (offLimits(el) || (isRoot(el) && c.name !== "lang" && c.name !== "dir")) continue;
        s.count++;
        const had = el.getAttribute(c.name);
        if (had === c.value) continue;
        if (work >= MOST) { more = true; continue; }
        if (!again(s, el)) continue;
        work++;
        s.did = true;
        const set = (v) => (v === null ? el.removeAttribute(c.name) : el.setAttribute(c.name, v));
        set(c.value);
        keep(el, () => { if (el.getAttribute(c.name) === c.value) set(had); });
      }
    }

    // -------------------------------------------------------------- places
    const away = (el) => el.closest("[" + AWAY + "]");
    const inside = (at, where) => (where === "first" || where === "last") && !tagIs(at, VOID);
    function put(node, at, where) {
      if (!inside(at, where) && where !== "before") where = "after";
      if (isRoot(at) && (at.tagName !== "BODY" || where === "before" || where === "after")) return false;
      if (where === "before") at.before(node); else if (where === "after") at.after(node);
      else if (where === "first") at.prepend(node); else at.append(node);
      return true;
    }
    // Keeps a change's host beside the part it was put by while that part is there and still matches, and puts it by the
    // one that does when it isn't.
    function place(s, sel, where, not, make) {
      const no = (x) => offLimits(x) || not(x), by = s.at;
      if (s.host && by && by.isConnected && s.host.parentNode === (inside(by, where) ? by : by.parentNode) && tagIs(by, sel) && !no(by)) return true;
      const at = first(sel, no);
      s.note = "";
      if (s.host) s.host.remove();
      if (!at || !again(s, doc.documentElement)) return false;
      s.host = s.host || make();
      s.at = at;
      if (put(s.host, at, where)) return true;
      s.note = "it can't go there";
      return false;
    }
    const closedRoot = (n) => { try { return chrome.dom.openOrClosedShadowRoot(n); } catch (e) { return null; } };
    // A part made of the page's own elements can't be copied: each copy would start its code again.
    const held = (x) => tagIs(x, HOLDS) || !!x.querySelector(HOLDS)
      || [x, ...x.querySelectorAll("*")].some((n) => !n.localName.startsWith("polycarp-") && (n.shadowRoot || closedRoot(n) || n.localName.includes("-")));
    // Made in a document with no window, so nothing in it loads or runs before it is cleaned. The page's ids stay with its
    // own parts; what the copy names by id is in the copy. Edits that hide or style a part do so in its copy.
    function copyOf(el) {
      inert = inert || doc.implementation.createHTMLDocument("");
      const box = inert.createElement("div");
      box.append(inert.importNode(el, true));
      const from = [el, ...el.querySelectorAll("*")], copies = [...box.querySelectorAll("*")];
      const ids = new Set(from.map((n) => n.id)), id = (v) => (ids.has(v) ? MOVED + "-" + v : v);
      const looks = edits.flatMap((e) => e.changes).filter((c) => c.do === "hide" || c.do === "style");
      copies.forEach((x, i) => {
        for (const a of [...x.attributes]) {
          const v = a.value;
          if (/^(is|name|on.*)$/i.test(a.name) || a.name === AWAY) { x.removeAttribute(a.name); continue; }
          const now = a.name === "id" ? MOVED + "-" + v : /^(for|aria-.*)$/.test(a.name) ? v.split(" ").map(id).join(" ") : v.replace(/(url\(\s*["']?#|^#)([^"')\s]+)/g, (_, start, name) => start + id(name));
          if (now !== v) a.value = now;
        }
        for (const c of looks) {
          if (!tagIs(from[i], c.at)) continue;
          if (c.do === "hide") x.remove(); else for (const [k, v] of E.declared(c.style)) x.style.setProperty(k, v, "important");
        }
        if (i && from[i].hasAttribute(AWAY)) x.remove(); // moved somewhere else itself
      });
      for (const x of box.querySelectorAll("polycarp-t")) x.replaceWith(x.textContent);
      for (const x of box.querySelectorAll("base,link,meta,noscript,script,style,template," + E.OURS)) x.remove();
      return box;
    }
    // Brings a copy up to date in place: where a person scrolled to, what has focus and what they opened stay as they are.
    function renew(to, from) {
      const had = [...to.childNodes], want = [...from.childNodes];
      want.forEach((n, i) => {
        const o = had[i];
        if (!o) to.append(n);
        else if (o.nodeName !== n.nodeName) o.replaceWith(n);
        else if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; } else {
          for (const a of [...o.attributes]) if (!n.hasAttribute(a.name) && a.name !== "open") o.removeAttribute(a.name);
          for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
          renew(o, n);
        }
      });
      for (const o of had.slice(want.length)) o.remove();
    }
    function drop(s) {
      if (s.el) s.el.removeAttribute(AWAY);
      if (s.host) s.host.remove();
      s.el = s.host = s.at = null; s.html = "";
    }
    function move(c, s) {
      const el = first(c.at);
      s.count = 0; s.note = "";
      if (el !== s.el) drop(s);
      if (!el) return;
      if ([...state.values()].some((o) => o !== s && o.el === el)) { s.note = "another change moves it"; return drop(s); }
      if (isRoot(el) || offLimits(el) || held(el)) { s.note = "holds a form field, a button, media or the page's own element; name a smaller part"; return drop(s); }
      if (!place(s, c.to, c.where, (x) => el.contains(x) || away(x), () => doc.createElement(MOVED))) { const why = s.note || "there is nowhere to move it to on this page"; drop(s); s.note = why; return; }
      s.el = el; s.count = 1;
      if (!el.hasAttribute(AWAY)) { el.setAttribute(AWAY, ""); more = true; } // what was put by it goes elsewhere
    }
    // What the page made of our own parts (a saved view, innerHTML) goes; each copy shows its part as it now is.
    function tidy() {
      const on = [...state.values()], hosts = new Set(on.map((s) => s.host)), els = new Set(on.map((s) => s.el));
      for (const x of all(MOVED + "," + NOTE)) if (!hosts.has(x)) x.remove();
      for (const x of all("[" + AWAY + "]")) if (!els.has(x)) x.removeAttribute(AWAY);
      for (const s of on) if (s.el && s.el.outerHTML !== s.html) { renew(s.host, copyOf(s.el)); s.html = s.el.outerHTML; }
    }
    function noteFor(c, source) {
      const host = doc.createElement(NOTE);
      host.setAttribute("data-polycarp-skip", "");
      const root = host.attachShadow({ mode: "closed" });
      const css = new win.CSSStyleSheet();
      css.replaceSync((themeCss ? P.shadowThemeCss(themeCss) : "") + NOTE_CSS);
      root.adoptedStyleSheets = [css];
      notes.push(css);
      const box = doc.createElement("div");
      box.className = "note";
      box.setAttribute("role", "note");
      const from = doc.createElement("span");
      from.className = "from";
      from.textContent = source === "app" ? "Added by your agent" : "Added by you";
      box.append(from);
      for (const b of c.blocks) {
        if (b.kind === "list") {
          const ul = doc.createElement("ul");
          for (const it of b.items) ul.appendChild(doc.createElement("li")).textContent = it;
          box.append(ul);
        } else if (b.kind === "link") {
          const a = doc.createElement("a");
          a.href = b.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = b.text;
          box.appendChild(doc.createElement("p")).append(a);
        } else box.appendChild(doc.createElement(b.kind === "heading" ? "h2" : "p")).textContent = b.text;
      }
      root.append(box);
      return host;
    }
    function insert(c, s, source) {
      s.count = place(s, c.at, c.where, away, () => noteFor(c, source)) ? 1 : 0;
    }

    // -------------------------------------------------------------- one pass
    const DOM = { text, attr, move, insert };
    function pass() {
      timer = frame = 0;
      if (!edits.length) return;
      const t0 = win.performance.now(), loading = doc.readyState === "loading";
      more = false;
      // Moves first: a note goes by what is in sight, and a copy has the new words.
      for (const moves of [true, false]) for (const e of edits) for (const c of e.changes) if (DOM[c.do] && (c.do === "move") === moves && !(loading && (moves || c.do === "insert" || !early(c)))) { try { DOM[c.do](c, st(c), e.source); } catch (err) { st(c).note = String(err && err.message || err).slice(0, 200); } }
      tidy();
      dress();
      if (observer) observer.takeRecords(); // our own changes
      lastMs = win.performance.now() - t0;
      if (more) schedule();
    }
    // Before the next frame is drawn; a pass that took long waits ten times as long, so it costs a tenth of the time at most.
    function schedule() {
      if (timer || frame) return;
      if (lastMs > 0.8) timer = win.setTimeout(pass, lastMs * 10);
      else if (doc.visibilityState === "hidden") timer = win.setTimeout(pass, 250);
      else frame = win.requestAnimationFrame(pass);
    }

    // A page that sets its own list of sheets drops ours from it.
    function dress() {
      const on = doc.adoptedStyleSheets;
      if (sheets.some((x) => !on.includes(x))) doc.adoptedStyleSheets = [...on.filter((x) => !sheets.includes(x)), ...sheets];
    }

    // The attributes a pass depends on: what attr sets, and what the selectors ask of a part.
    function attributes() {
      const changes = edits.flatMap((e) => e.changes).filter((c) => DOM[c.do]);
      const asked = changes.map((c) => c.at + " " + (c.to || "")).join(" ");
      const names = new Set([...asked.matchAll(/\[\s*([\w-]+)/g)].map((m) => m[1]));
      if (asked.includes(".")) names.add("class");
      if (asked.includes("#")) names.add("id");
      if (changes.some((c) => c.do === "attr")) for (const a of E.ATTRS) names.add(a);
      return [...names];
    }

    function update(next) {
      stop();
      edits = next;
      if (!edits.length) return;
      for (const e of edits) {
        for (const text of [E.sheet([e], ok), e.css]) {
          if (!text) continue;
          const sheet = new win.CSSStyleSheet();
          try { sheet.replaceSync(text); } catch (err) { continue; }
          sheets.push(sheet);
        }
      }
      const verbs = new Set(edits.flatMap((e) => e.changes.map((c) => c.do)).filter((d) => DOM[d]));
      if (verbs.has("move")) { const sheet = new win.CSSStyleSheet(); sheet.replaceSync("[" + AWAY + "]{display:none !important}" + MOVED + "{display:contents !important}"); sheets.push(sheet); }
      dress();
      observer = new win.MutationObserver(schedule);
      const named = attributes();
      observer.observe(doc, { childList: true, subtree: true, characterData: verbs.has("text") || verbs.has("move"),
        ...(verbs.has("move") ? { attributes: true } : named.length ? { attributes: true, attributeFilter: named } : {}) });
      // A theme switch marks the page itself, and may set its own list of sheets.
      if (doc.documentElement) observer.observe(doc.documentElement, { attributes: true });
      if (verbs.has("insert") && P.watchTheme) unwatch = P.watchTheme((css) => { themeCss = css; for (const n of notes) n.replaceSync(P.shadowThemeCss(css) + NOTE_CSS); });
      pass();
    }
    function stop() {
      if (observer) { observer.disconnect(); observer = null; }
      if (unwatch) { unwatch(); unwatch = null; }
      if (timer) win.clearTimeout(timer);
      if (frame) win.cancelAnimationFrame(frame);
      timer = frame = 0;
      if (sheets.length) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => !sheets.includes(s));
      for (const s of state.values()) drop(s);
      tidy();
      for (const u of undo.reverse()) { try { u.back(); } catch (e) { /* the page took that part away */ } }
      edits = []; sheets = []; undo = []; notes = []; state = new Map(); wrote = new WeakMap(); room = KEPT;
    }
    // What each edit in force did here: how many parts each change found, whether it changed any, and why one didn't.
    function report() {
      return edits.map((e) => ({ id: e.id, source: e.source, name: e.name, css: !!e.css, changes: e.changes.map((c) => {
        const s = state.get(c);
        const out = { do: c.do, hits: s ? s.count : all(c.at).length, did: false, note: s ? s.note : "" };
        out.did = c.do === "hide" ? all(c.at).some((el) => !isRoot(el) && !tagIs(el, E.OURS)) : c.do === "text" || c.do === "attr" ? !!s && s.did : out.hits > 0;
        if (!ok(c.at) || (c.to && !ok(c.to))) out.note = "this browser can't read that selector";
        else if (!out.hits && !out.note) out.note = "nothing on this page matches";
        return out;
      }) }));
    }
    // Where a moved part shows, and the moved part a piece of its copy belongs to: what a person points at is the copy.
    const shown = (el) => { for (const s of state.values()) if (s.el === el) return s.host; return null; };
    const part = (n) => { for (const s of state.values()) if (s.el && s.host.contains(n)) return s.el; return null; };
    return { update, stop, report, shown, part, flush: () => { dress(); if (observer) { observer.takeRecords(); pass(); } } };
  }

  // ---------------------------------------------------------------- wiring
  // Settings and edits come from storage: the app's (kept fresh by the service worker) and this browser's own. A change
  // there, or a new address on a page that doesn't reload, reaches this page at once.
  const page = create(document);
  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  let applied = "", turn = 0, watching = true, here = [], onapply = [];

  let running = null;
  const apply = () => (running = run());
  // Once what storage holds now is in force.
  async function settle() { apply(); for (let r = null; r !== running;) { r = running; await r; } }
  async function run() {
    if (!alive()) return end();
    const mine = ++turn;
    let edits = [];
    try {
      const [settings, all] = await Promise.all([P.getSettings(), S.load()]);
      // Off only where the person turned Polycarp off: an edit names its sites, so the restyle default isn't asked.
      if (settings.enabled && !P.paused(settings) && settings.sites[P.hostOf(location.href)] !== "off") edits = E.active(all.edits, location.hostname, location.pathname);
    } catch (e) { return; }
    if (!watching || mine !== turn) return;
    const sig = JSON.stringify(edits);
    if (sig === applied) return;
    applied = sig;
    here = edits;
    try { page.update(edits); } catch (e) { /* a broken edit never breaks the page */ }
    for (const f of onapply) f(edits);
  }
  const onStorage = (changes, area) => { if (S.changed(changes, area) || (area === "local" && changes[P.SETTINGS_KEY])) apply(); };
  const onUrl = () => { if (alive()) apply(); else end(); };
  const onShow = (e) => { if (e.persisted) onUrl(); }; // back from the page cache, which hears no storage changes
  function onMessage(msg, _sender, reply) {
    if (msg && msg.type === "polycarp:edits") reply({ edits: page.report() });
  }
  function end() {
    watching = false;
    page.stop();
    for (const f of onapply) f([]);
    applied = "";
    try { chrome.storage.onChanged.removeListener(onStorage); chrome.runtime.onMessage.removeListener(onMessage); } catch (e) {}
    if (globalThis.navigation) navigation.removeEventListener("currententrychange", onUrl);
    removeEventListener("popstate", onUrl);
    removeEventListener("pageshow", onShow);
    document.removeEventListener("DOMContentLoaded", page.flush);
    removeEventListener("load", page.flush);
  }
  P.pageEdits = { apply, settle, report: page.report, shown: page.shown, part: page.part, watch: (f) => { onapply.push(f); f(here); } };

  // A copy from before an extension update is still on the page with its edits made: it takes them back first, so this
  // copy starts from the page as the site made it. All a page could do with this is ask for itself unedited.
  document.dispatchEvent(new Event("polycarp:edits-handover"));
  document.addEventListener("polycarp:edits-handover", end, { once: true });
  chrome.storage.onChanged.addListener(onStorage);
  chrome.runtime.onMessage.addListener(onMessage);
  if (globalThis.navigation) navigation.addEventListener("currententrychange", onUrl);
  addEventListener("popstate", onUrl);
  addEventListener("pageshow", onShow);
  document.addEventListener("DOMContentLoaded", page.flush);
  addEventListener("load", page.flush);
  apply();
  try { chrome.runtime.sendMessage({ type: "polycarp:filtersFresh" }).catch(() => {}); } catch (e) {}
})();
