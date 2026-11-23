/* Polycarp content script: applies the reading profile to web pages. */
(function () {
  "use strict";
  // A live copy is already running. An orphaned copy (left by an update) returns false.
  if (typeof window.__polycarpContent === "function" && window.__polycarpContent()) return;
  window.__polycarpContent = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  if (document.documentElement.tagName !== "HTML") return; // skip XML and SVG documents

  const P = globalThis.Polycarp;
  const host = P.hostOf(location.href);
  const isPdf = document.contentType === "application/pdf";
  const isTop = window === window.top;
  const S = P.sites;
  const site = S ? S.siteFor(location.hostname) : null;

  let settings = null;
  let active = false;
  let engine = null;
  let ui = null;
  let sheet = null;       // constructed stylesheet: page CSP cannot block it
  let styleEl = null;     // fallback for very old engines
  let fontsLoaded = false;
  let tracker = null;

  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };

  // ---------- Page CSS ----------
  const PROSE = "p,li,dd,dt,blockquote,figcaption,article" + (site && site.prose ? "," + site.prose : "");
  const HEADS = "h1,h2,h3,h4,h5,h6";
  const NOT_ICON = ":not([class*='icon' i]):not([class*='fa-' i]):not([class*='symbol' i]):not([class*='glyph' i]):not([aria-hidden='true']):not(code, kbd, samp, code *, kbd *, samp *)";

  function pageCss(s) {
    const css = [];
    const b = s.bionic;
    css.push(":root{--polycarp-weight:" + b.weight + ";--polycarp-fade:" + (1 - b.fade).toFixed(2) + ";" + (pageTheme && pageTheme.done ? "--polycarp-done:" + pageTheme.done + ";" : "") + "}");
    const fam = P.FONTS[s.type.font] && P.FONTS[s.type.font].family;
    if (fam) {
      css.push(":is(" + PROSE + "," + HEADS + ")" + NOT_ICON + ", :is(" + PROSE + "," + HEADS + ") *" + NOT_ICON +
        ", polycarp-t, polycarp-b, polycarp-r{font-family:" + fam + " !important;}");
    }
    if (s.type.letter || s.type.word) {
      css.push(":is(" + PROSE + "){letter-spacing:" + s.type.letter + "em !important;word-spacing:" + s.type.word + "em !important;}");
    }
    if (s.type.line) css.push(":is(p,li,dd,blockquote,figcaption){line-height:" + s.type.line + " !important;}");
    if (s.calm.still) {
      css.push("*,*::before,*::after{animation-duration:0.001s !important;animation-iteration-count:1 !important;transition-duration:0.001s !important;scroll-behavior:auto !important;}");
    }
    if (s.calm.soft && isTop) css.push("html{filter:contrast(0.88) brightness(0.98) !important;}");
    const f = s.force || {};
    if (f.minSize > 0) css.push(":is(p,li,dd,blockquote,figcaption,td){font-size:max(" + f.minSize + "px,1em) !important;}");
    if (f.leftAlign) css.push(":is(p,li,dd,blockquote,article,section){text-align:start !important;hyphens:none !important;}");
    if (f.noItalic) css.push(":is(em,i,cite,dfn,address,blockquote){font-style:normal !important;} :is(em,i,cite,dfn){font-weight:600 !important;}");
    if (f.unlockCopy) css.push("body,body *:not(input):not(textarea):not(button){-webkit-user-select:text !important;user-select:text !important;}");
    if (f.contrast && pageTheme && pageTheme.strong) {
      const ink = pageTheme.strong;
      css.push(":is(p,li,dd,dt,blockquote,figcaption,td,th,h1,h2,h3,h4,h5,h6,article)" + ":not(a), :is(p,li,dd,blockquote,figcaption,td) :not(a):not(a *){color:" + ink + " !important;opacity:1 !important;}");
    }
    return css.join("\n");
  }

  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
      return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.45;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches && false;
  }

  // Load the reading fonts as bytes so a page's font-src policy cannot block them.
  const FONT_FILES = [["Polycarp Lexend", "lexend"], ["Polycarp Atkinson", "atkinson-hyperlegible"], ["Polycarp OpenDyslexic", "opendyslexic"]];
  async function ensureFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    for (const [family, file] of FONT_FILES) {
      for (const weight of [400, 700]) {
        try {
          const buf = await (await fetch(chrome.runtime.getURL("fonts/" + file + "-latin-" + weight + "-normal.woff2"))).arrayBuffer();
          const face = new FontFace(family, buf, { weight: String(weight), style: "normal", display: "swap" });
          await face.load();
          document.fonts.add(face);
        } catch (e) { /* the page keeps its own font */ }
      }
    }
  }

  function setCss(text) {
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(text);
      if (engine) for (const r of engine.roots) adoptInto(r);
      return;
    } catch (e) { sheet = null; }
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "polycarp-style";
      (document.head || document.documentElement).appendChild(styleEl);
    }
    styleEl.textContent = text;
  }
  function adoptInto(root) {
    if (!sheet || !root.adoptedStyleSheets) return;
    try { if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; } catch (e) {}
  }
  function clearCss() {
    if (sheet) {
      try { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet); } catch (e) {}
      if (engine) for (const r of engine.roots) { try { r.adoptedStyleSheets = r.adoptedStyleSheets.filter((x) => x !== sheet); } catch (e) {} }
      sheet = null;
    }
    if (styleEl) { styleEl.remove(); styleEl = null; }
  }

  // Some sites block copy, selection and the context menu. Stop their handlers first.
  const UNLOCK = ["copy", "cut", "contextmenu", "selectstart"];
  const unlockHandler = (e) => { e.stopImmediatePropagation(); };
  let unlocked = false;
  function setUnlock(on) {
    if (on === unlocked) return;
    unlocked = on;
    for (const ev of UNLOCK) (on ? addEventListener : removeEventListener)(ev, unlockHandler, true);
  }

  // ---------- Overlay UI (shadow DOM, never touches page styles) ----------
  // Colors, font, radius and motion come from the theme (core.js themeCss); the toast and buttons use its dark
  // mode, like a tooltip, and the ruler shades with the light mode's ink so it always darkens the page around the line.
  const UI_CSS = `
    :host{all:initial}
    .tint{position:fixed;inset:0;pointer-events:none;mix-blend-mode:multiply;z-index:2147483646;display:none}
    .ruler{position:fixed;inset:0;pointer-events:none;z-index:2147483645;display:none}
    .ruler div{position:absolute;left:0;right:0;background:color-mix(in srgb,var(--pc-strong) 34%,transparent)}
    .ruler .top{top:0}
    .ruler .bot{bottom:0}
    .ruler.soft div{background:color-mix(in srgb,var(--pc-strong) 20%,transparent)}
    .stack{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;align-items:flex-end;z-index:2147483647;font:var(--pc-font-weight) 14px/1.4 var(--pc-font-ui)}
    .toast{display:flex;gap:12px;align-items:center;max-width:320px;padding:12px 16px;border-radius:var(--pc-radius);background:var(--pc-background);color:var(--pc-foreground);border:var(--pc-border-width) solid var(--pc-border);box-shadow:0 8px 24px color-mix(in srgb,var(--pc-background) 60%,transparent)}
    .toast b{display:block;font-weight:650}
    .toast span{color:var(--pc-muted)}
    .toast .mark{flex:none;width:32px;height:32px;border-radius:var(--pc-radius-small);background:var(--pc-accent);color:var(--pc-on-accent);display:grid;place-items:center}
    .toast.in{animation:in var(--pc-motion-normal) var(--pc-motion-easing)}
    @keyframes in{from{transform:translateY(8px);opacity:0}}
    .pdf{all:unset;cursor:pointer;display:flex;gap:8px;align-items:center;padding:12px 16px;border-radius:var(--pc-radius);background:var(--pc-accent);color:var(--pc-on-accent);font:650 14px/1.4 var(--pc-font-ui);box-shadow:0 8px 24px color-mix(in srgb,var(--pc-background) 50%,transparent)}
    .pdf:focus-visible{outline:3px solid var(--pc-foreground);outline-offset:2px}
    .pill{display:flex;align-items:center;gap:4px}
    .dismiss{all:unset;cursor:pointer;width:44px;height:44px;border-radius:var(--pc-radius);display:grid;place-items:center;background:var(--pc-background);color:var(--pc-foreground);font:22px/1 var(--pc-font-ui);box-shadow:0 8px 24px color-mix(in srgb,var(--pc-background) 50%,transparent)}
    .dismiss:focus-visible{outline:3px solid var(--pc-foreground);outline-offset:2px}
    .pdf[disabled]{opacity:.85;cursor:progress}
    canvas{position:fixed;inset:0;pointer-events:none;z-index:2147483647}
    @media (prefers-reduced-motion:reduce){.toast.in{animation:none}}
  `;
  const MARK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const STAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
  const BOOK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>';

  function buildUi() {
    if (ui) return ui;
    const hostEl = document.createElement("polycarp-ui");
    hostEl.setAttribute("data-polycarp-skip", "");
    const root = hostEl.attachShadow({ mode: "closed" });
    root.innerHTML = '<style class="theme"></style><style>' + UI_CSS + '</style><div class="tint"></div><div class="ruler pc-light"><div class="top"></div><div class="bot"></div></div><div class="stack pc-dark"></div>';
    document.documentElement.appendChild(hostEl);
    P.themeCss().then((css) => { root.querySelector("style.theme").textContent = P.shadowThemeCss(css); });
    ui = {
      host: hostEl, root,
      tint: root.querySelector(".tint"),
      ruler: root.querySelector(".ruler"),
      top: root.querySelector(".top"),
      bot: root.querySelector(".bot"),
      stack: root.querySelector(".stack")
    };
    return ui;
  }

  function toast(title, sub, icon) {
    if (!ui) buildUi();
    const t = document.createElement("div");
    t.className = "toast in";
    t.setAttribute("role", "status");
    t.innerHTML = '<div class="mark">' + (icon || MARK) + '</div><div><b></b><span></span></div>';
    t.querySelector("b").textContent = title;
    t.querySelector("span").textContent = sub || "";
    ui.stack.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  async function confetti() {
    if (!settings || settings.celebrate !== "full") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || settings.calm.still) return;
    const th = P.themeVars(await P.themeCss(), "light");
    const colors = [th.accent, th.working, th.done, th.urgent, th.strong].filter(Boolean);
    const life = P.ms(th["motion-slow"] || "0ms") * 4.5;
    if (!colors.length || !life) return;
    if (!ui) buildUi();
    const c = document.createElement("canvas");
    const dpr = devicePixelRatio || 1;
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    c.style.width = innerWidth + "px"; c.style.height = innerHeight + "px";
    ui.root.appendChild(c);
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    const bits = Array.from({ length: 90 }, () => ({
      x: innerWidth - 120 + Math.random() * 60, y: innerHeight - 60,
      vx: -2 - Math.random() * 6, vy: -8 - Math.random() * 8,
      r: Math.random() * Math.PI, s: 4 + Math.random() * 5, c: colors[(Math.random() * colors.length) | 0]
    }));
    const t0 = performance.now();
    (function frame(t) {
      const k = (t - t0) / life;
      g.clearRect(0, 0, innerWidth, innerHeight);
      for (const b of bits) {
        b.x += b.vx; b.y += b.vy; b.vy += 0.32; b.vx *= 0.99; b.r += 0.2;
        g.save(); g.translate(b.x, b.y); g.rotate(b.r); g.globalAlpha = Math.max(0, 1 - k);
        g.fillStyle = b.c; g.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); g.restore();
      }
      if (k < 1) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

  function showEvents(events) {
    if (!events || !events.length || !settings || settings.celebrate === "off") return;
    let party = false;
    for (const e of events) {
      if (e.type === "goal") { toast("Daily goal reached", e.goal.toLocaleString() + " words today. Nice work.", STAR); party = true; }
      else if (e.type === "level") { toast("Level " + e.level, "New title: " + e.title + ".", STAR); party = true; }
      else if (e.type === "streak" && e.count > 1) toast(e.count + " day streak", "A steady rhythm is how reading becomes a habit.");
      else if (e.type === "badge") toast(e.name, e.desc + ".");
    }
    if (party) confetti();
  }

  // ---------- Tint and ruler ----------
  let rulerY = innerHeight / 2;
  let rulerH = 84;
  let rulerRaf = 0;
  function placeRuler() {
    rulerRaf = 0;
    if (!ui) return;
    const half = rulerH / 2;
    ui.top.style.height = Math.max(0, rulerY - half) + "px";
    ui.bot.style.height = Math.max(0, innerHeight - rulerY - half) + "px";
  }
  function onPointer(e) {
    rulerY = e.clientY;
    const el = e.target && e.target.nodeType === 1 ? e.target : null;
    let lh = 28;
    if (el && el !== ui.host) {
      const cs = getComputedStyle(el);
      lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 28;
    }
    rulerH = Math.min(240, Math.max(36, lh * settings.ruler.lines));
    if (!rulerRaf) rulerRaf = requestAnimationFrame(placeRuler);
  }

  function applyOverlays() {
    const s = settings;
    const needUi = s.tint.on || s.ruler.on || isPdf;
    if (!needUi && !ui) return;
    buildUi();
    const tint = P.TINTS[s.tint.color] || P.TINTS.yellow;
    ui.tint.style.display = s.tint.on ? "block" : "none";
    ui.tint.style.background = tint.color;
    ui.tint.style.opacity = String(s.tint.strength);
    ui.ruler.style.display = s.ruler.on ? "block" : "none";
    ui.ruler.classList.toggle("soft", s.calm.soft);
    if (s.ruler.on) { addEventListener("pointermove", onPointer, { passive: true }); placeRuler(); }
    else removeEventListener("pointermove", onPointer);
  }

  // ---------- Reading tracker ----------
  // A block counts as read only after it has sat in the middle of the screen long enough to
  // read it at a brisk 540 words per minute, while the tab is visible and the reader is active.
  const BLOCK_SEL = "p,li,blockquote,dd,dt,td,figcaption,h1,h2,h3,h4,h5,h6,pre,div,article,section";
  class Tracker {
    constructor() {
      this.seen = new WeakSet();
      this.state = new Map();
      this.inView = new Set();
      this.pending = 0;
      this.lastInput = Date.now();
      this.io = new IntersectionObserver((es) => this.onIntersect(es), { rootMargin: "-30% 0px -30% 0px" });
      this.tick = setInterval(() => this.step(), 1000);
      this.flushT = setInterval(() => this.flush(), 8000);
      this.mark = () => { this.lastInput = Date.now(); };
      for (const ev of ["scroll", "pointermove", "keydown", "wheel", "touchmove"]) addEventListener(ev, this.mark, { passive: true, capture: true });
    }
    observeHolders(fresh) {
      if (!engine) return;
      for (const h of fresh || engine.live) {
        const block = h.parentElement && h.parentElement.closest(BLOCK_SEL);
        if (!block || this.seen.has(block)) continue;
        this.seen.add(block);
        const words = Math.min(1500, P.countWords(block.textContent));
        if (words < 4) continue;
        this.state.set(block, { words, dwell: 0, inView: false, done: false });
        this.io.observe(block);
      }
      // Drop blocks the page has thrown away (infinite feeds), so the tracker stays small.
      if (this.state.size > 1500) for (const [b] of this.state) if (!b.isConnected) { this.io.unobserve(b); this.state.delete(b); this.inView.delete(b); }
    }
    onIntersect(entries) {
      for (const e of entries) {
        const st = this.state.get(e.target);
        if (!st) continue;
        st.inView = e.isIntersecting;
        if (e.isIntersecting) this.inView.add(e.target); else this.inView.delete(e.target);
      }
    }
    step() {
      if (document.hidden || Date.now() - this.lastInput > 60000) return;
      for (const block of this.inView) {
        const st = this.state.get(block);
        if (!st || st.done) continue;
        st.dwell += 1;
        if (st.dwell >= Math.max(1, st.words / 9)) {
          st.done = true;
          this.pending += st.words;
          this.io.unobserve(block);
          this.inView.delete(block);
          if (settings.doneMarks) block.classList.add("polycarp-done");
        }
      }
    }
    flush() {
      if (!this.pending || !alive()) return;
      const words = this.pending;
      this.pending = 0;
      chrome.runtime.sendMessage({ type: "polycarp:read", words, kind: "web" }).then((r) => r && showEvents(r.events)).catch(() => {});
    }
    stop() {
      this.flush();
      clearInterval(this.tick); clearInterval(this.flushT);
      this.io.disconnect();
      for (const ev of ["scroll", "pointermove", "keydown", "wheel", "touchmove"]) removeEventListener(ev, this.mark, { capture: true });
      document.querySelectorAll(".polycarp-done").forEach((el) => el.classList.remove("polycarp-done"));
    }
  }

  // ---------- Apply / remove ----------
  // Theme colors for page CSS (read marks, forced contrast), in the mode that matches the page's own darkness.
  // Read once, and only when a setting that needs them is on.
  let pageTheme = null;
  function loadPageTheme() {
    if (pageTheme) return;
    pageTheme = {};
    P.themeCss().then((css) => {
      pageTheme = P.themeVars(css, pageIsDark() ? "dark" : "light");
      if (active) setCss(pageCss(settings));
    });
  }

  function apply() {
    const s = settings;
    if (s.doneMarks || (s.force && s.force.contrast)) loadPageTheme();
    if (s.type.font !== "page") ensureFonts();
    setCss(pageCss(s));
    setUnlock(!!(s.force && s.force.unlockCopy));
    document.documentElement.classList.toggle("polycarp-marks", !!s.doneMarks);

    if (!isPdf && s.bionic.on) {
      const opt = { strength: s.bionic.strength, every: s.bionic.every, fade: s.bionic.fade, skip: site && site.skip };
      if (!engine) {
        engine = new P.BionicEngine(document, opt);
        engine.onWork = () => tracker && tracker.observeHolders(engine.takeFresh());
        engine.onShadowRoot = adoptInto;
        engine.start();
      } else engine.setOptions(opt);
    } else if (engine) { engine.stop(); engine = null; }

    if (!isPdf && !tracker) tracker = new Tracker();
    if (tracker && !s.doneMarks) document.querySelectorAll(".polycarp-done").forEach((el) => el.classList.remove("polycarp-done"));
    if (tracker && engine) tracker.observeHolders(engine.takeFresh());
    if (isTop) applyOverlays();
    if (isPdf && isTop) showPdfButton();
  }

  function remove() {
    if (engine) { engine.stop(); engine = null; }
    if (tracker) { tracker.stop(); tracker = null; }
    clearCss();
    setUnlock(false);
    document.documentElement.classList.remove("polycarp-marks");
    if (ui) {
      ui.tint.style.display = "none";
      ui.ruler.style.display = "none";
      removeEventListener("pointermove", onPointer);
    }
  }

  function showPdfButton() {
    buildUi();
    if (ui.root.querySelector(".pdf")) return;
    const b = document.createElement("button");
    b.className = "pdf";
    b.innerHTML = BOOK + "<span>Read this PDF in Polycarp</span>";
    b.addEventListener("click", () => {
      if (alive()) chrome.runtime.sendMessage({ type: "polycarp:openReader", url: location.href });
    });
    ui.stack.appendChild(b);
  }

  async function refresh() {
    if (!alive()) return teardown();
    settings = await P.getSettings();
    const topHost = isTop ? host : (P.hostOf(document.referrer) || host);
    const want = P.activeFor(settings, isTop ? host : topHost) && (isTop || !settings.force || settings.force.frames !== false);
    if (want) { active = true; apply(); }
    else if (active) { active = false; remove(); }
    watchPage(active);
  }

  async function sitePage() {
    if (site && site.doc && helperOn()) {
      try { const d = await site.doc(); if (d) return d; } catch (e) { /* fall back to the page */ }
    }
    return snapshotPage();
  }
  function helperOn() { return !settings || !settings.helpers || settings.helpers[site ? site.id : "web"] !== false; }

  function snapshotPage() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("polycarp-ui, #polycarp-style, script, noscript").forEach((n) => n.remove());
    clone.querySelectorAll("polycarp-t").forEach((h) => h.replaceWith(h.textContent));
    return { html: "<!doctype html>" + clone.outerHTML, url: location.href, title: document.title };
  }

  function onMessage(msg, _sender, reply) {
    if (!msg || typeof msg.type !== "string") return;
    if (!isTop) return;
    if (msg.type === "polycarp:state") {
      reply({ active, host, isPdf, url: location.href, title: document.title, site: site ? site.id : null, library: !!(S && S.capturerFor(location.hostname)), stats: engine ? engine.stats() : null });
    } else if (msg.type === "polycarp:snapshot") {
      sitePage().then(reply, () => reply(snapshotPage()));
      return true;
    } else if (msg.type === "polycarp:events") {
      showEvents(msg.events);
    } else if (msg.type === "polycarp:find") {
      if (P.finder) P.finder.toggle({ query: msg.query, group: msg.group });
      reply({ ok: !!P.finder });
    } else if (msg.type === "polycarp:where") {
      // An exact link back to the selected passage: the post on X, the moment in a YouTube video,
      // or a text fragment on any other page.
      const sel = getSelection();
      const node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
      const text = msg.text || (sel ? String(sel) : "");
      const a = site && helperOn() ? site : (S && S.generic);
      reply({ url: a ? a.where(node, text) : location.href, title: document.title });
    } else if (msg.type === "polycarp:capture") {
      captureLibrary().then(reply, (e) => reply({ error: String(e && e.message || e) }));
      return true;
    }
  }

  function onStorage(changes, area) {
    if (area === "local" && changes[P.SETTINGS_KEY]) refresh().then(() => { if (isTop) showCaptureButton(); });
  }

  function teardown() {
    try { chrome.storage.onChanged.removeListener(onStorage); } catch (e) {}
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) {}
    if (tracker) { clearInterval(tracker.tick); clearInterval(tracker.flushT); tracker = null; }
    watchPage(false);
    // Leave the rendered page as is; a fresh content script takes over after an update.
    if (engine && engine.observer) { engine.observer.disconnect(); engine.observer = null; }
  }

  // ---------- Library capture (Audible, Kindle, any list page) ----------
  async function captureLibrary() {
    const cap = S && S.capturerFor(location.hostname);
    const got = cap ? await cap.capture((n) => setCaptureLabel("Adding " + n + "...")) : S.listPage.capture();
    if (!got.items.length) return { error: "Polycarp found no list of titles on this page." };
    await chrome.runtime.sendMessage({ type: "polycarp:import", def: got.def, items: got.items });
    return { ok: true, count: got.items.length };
  }
  let captureBtn = null;
  function setCaptureLabel(t) { if (captureBtn) captureBtn.querySelector("span").textContent = t; }
  function showCaptureButton() {
    const cap = isTop && S ? S.capturerFor(location.hostname) : null;
    const capOn = cap && (!settings || !settings.helpers || settings.helpers[cap.id] !== false);
    if (!cap || !capOn || !active) { if (captureBtn) { captureBtn.parentElement.remove(); captureBtn = null; } return; }
    buildUi();
    if (captureBtn) return;
    const wrap = document.createElement("div");
    wrap.className = "pill";
    const b = document.createElement("button");
    b.className = "pdf";
    b.innerHTML = BOOK + "<span></span>";
    b.querySelector("span").textContent = "Make this library searchable in Polycarp";
    b.addEventListener("click", async () => {
      b.disabled = true;
      setCaptureLabel("Reading your library...");
      const r = await captureLibrary().catch((e) => ({ error: String(e) }));
      if (r.error) { setCaptureLabel(r.error); b.disabled = false; }
      else { wrap.remove(); captureBtn = null; }
    });
    const x = document.createElement("button");
    x.className = "dismiss";
    x.setAttribute("aria-label", "Not now");
    x.title = "Not now";
    x.textContent = "\u00d7";
    x.addEventListener("click", () => { wrap.remove(); captureBtn = null; });
    wrap.append(b, x);
    ui.stack.appendChild(wrap);
    captureBtn = b;
  }

  // Single-page sites (YouTube, X, Reddit) change the address without loading a new page.
  // Watched only while Polycarp is on for this page: where it is off, the page gets no timer,
  // no observer and no listener beyond the settings one that can turn it back on.
  let lastUrl = location.href;
  let watching = false;
  let urlTimer = 0;
  const nav = typeof navigation !== "undefined" ? navigation : null;
  function onUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (P.finder && P.finder.isOpen()) P.finder.close();
    showCaptureButton();
  }
  function watchPage(on) {
    if (!isTop || on === watching) return;
    watching = on;
    const how = on ? "addEventListener" : "removeEventListener";
    if (nav) nav[how]("currententrychange", onUrl);
    else if (on) urlTimer = setInterval(() => { if (!document.hidden && alive()) onUrl(); }, 1000);
    else clearInterval(urlTimer);
    window[how]("popstate", onUrl);
    document[how]("yt-navigate-finish", onUrl);
    if (on) { lastUrl = location.href; if (site && site.watch && helperOn()) site.watch(); }
    else if (site && site.unwatch) site.unwatch();
  }
  P.contentState = () => ({ active, host });

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  addEventListener("pagehide", () => tracker && tracker.flush());
  document.addEventListener("visibilitychange", () => { if (document.hidden && tracker) tracker.flush(); });
  refresh().then(() => { if (isTop) showCaptureButton(); });
})();
