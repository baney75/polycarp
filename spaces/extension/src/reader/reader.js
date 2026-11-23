/* Polycarp Reader core: open a document, set it in the reader's type, track real reading,
   save progress and keep a small local library. Feature modules (learn, listen, sprint, print)
   attach to globalThis.PolycarpReader before boot runs on DOMContentLoaded. */
(function () {
  "use strict";
  const P = globalThis.Polycarp;
  const IC = globalThis.PolycarpIcons;
  const I = IC.icon;
  const $ = (id) => document.getElementById(id);

  // A picture that fails to load becomes one quiet line with its description, not a broken icon.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.closest("#article")) return;
    const alt = (img.getAttribute("alt") || "").trim();
    if (!alt) { img.remove(); return; }
    const s = document.createElement("span");
    s.className = "img-missing";
    s.textContent = "Image: " + alt;
    img.replaceWith(s);
  }, true);

  const DOCS_KEY = "polycarp.docs";
  const WPM = 230;
  const ROUND_WORDS = { short: 400, medium: 700, long: 1200 };
  const BLOCK_SEL = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd,figcaption";
  // Reading themes map onto the Polycarp theme: each picks a mode and which theme color fills the page.
  const THEMES = [
    { id: "paper", label: "Paper", mode: "light", bg: "background" },
    { id: "white", label: "White", mode: "light", bg: "surface" },
    { id: "dusk", label: "Dusk", mode: "dark", bg: "surface" },
    { id: "night", label: "Night", mode: "dark", bg: "background" }
  ];
  const FONT_LABEL = { page: "Book", lexend: "Lexend", atkinson: "Atkinson", opendyslexic: "OpenDyslexic" };
  const BOOK_STACK = "var(--pc-font-display)"; // the theme's book face, the Reader's default

  const R = globalThis.PolycarpReader = {
    settings: null, doc: null, key: null, kind: "html",
    blocks: [], words: [], cum: [], total: 0, sections: [], rounds: [],
    cur: 0, done: new Set(), doneWords: 0, finished: false,
    hooks: { rendered: [], current: [], settings: [], done: [] },
    on(name, fn) { (this.hooks[name] || (this.hooks[name] = [])).push(fn); },
    emit(name, ...a) { (this.hooks[name] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); }
  };

  // ---------- Small helpers ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  R.esc = esc;
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  function minutes(words) { const m = Math.max(1, Math.round(words / WPM)); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; }
  R.minutes = minutes;
  const KIND_LABEL = { pdf: "PDF", epub: "EPUB", docx: "Word", txt: "Text", md: "Markdown", html: "Web page", fb2: "FB2" };
  function setState(s) { document.body.dataset.state = s; }

  // ---------- Toasts, party, chime ----------
  R.toast = function (title, body, art) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = (art || IC.mascot("happy")) + "<div><b>" + esc(title) + "</b>" + (body ? esc(body) : "") + "</div>";
    $("toasts").appendChild(t);
    const slow = P.ms(getComputedStyle(document.documentElement).getPropertyValue("--pc-motion-slow"));
    setTimeout(() => { t.style.transition = "opacity var(--slow) var(--ease)"; t.style.opacity = "0"; setTimeout(() => t.remove(), slow); }, slow * 13);
  };
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  R.party = () => globalThis.PolycarpFx.party(R.settings);
  R.chime = (kind) => globalThis.PolycarpFx.chime(kind, R.settings);
  R.showEvents = function (events) {
    let party = false;
    for (const e of events || []) {
      if (e.type === "goal") { R.toast("Daily goal reached", e.goal.toLocaleString() + " words today. Nice work."); party = true; }
      else if (e.type === "level") { R.toast("Level " + e.level, "New title: " + e.title + "."); party = true; R.chime("level"); }
      else if (e.type === "streak" && e.count > 1) R.toast(e.count + " day streak", "A steady rhythm is how reading becomes a habit.");
      else if (e.type === "badge") R.toast(e.name, e.desc + ".", IC.mascot("wow"));
    }
    if (party) R.party();
  };

  // ---------- Library (IndexedDB) and progress (storage) ----------
  // Full documents live in the shared store (docstore.js); the Library indexes them (library.js).
  const Lib = globalThis.PolycarpDocs;
  R.Lib = Lib;

  async function getProgress(key) {
    const got = await chrome.storage.local.get(DOCS_KEY);
    return (got[DOCS_KEY] || {})[key] || null;
  }
  function packDone(set) {
    const xs = [...set].sort((a, b) => a - b), out = [];
    for (const x of xs) { const last = out[out.length - 1]; if (last && last[0] + last[1] === x) last[1]++; else out.push([x, 1]); }
    return out;
  }
  function unpackDone(runs) { const s = new Set(); for (const [a, n] of runs || []) for (let i = 0; i < n; i++) s.add(a + i); return s; }
  let saveTimer = 0;
  R.saveProgress = function (now) {
    clearTimeout(saveTimer);
    const run = async () => {
      if (!R.key) return;
      const got = await chrome.storage.local.get(DOCS_KEY);
      const all = got[DOCS_KEY] || {};
      all[R.key] = {
        cur: R.cur, done: packDone(R.done), pct: R.total ? R.doneWords / R.total : 0,
        finished: R.finished, updated: Date.now(), title: R.doc.title, extra: R.extra || {}
      };
      const keys = Object.keys(all);
      if (keys.length > 200) keys.sort((a, b) => all[a].updated - all[b].updated).slice(0, keys.length - 200).forEach((k) => delete all[k]);
      await chrome.storage.local.set({ [DOCS_KEY]: all });
    };
    if (now) return run();
    saveTimer = setTimeout(run, 1200);
  };

  // ---------- Settings ----------
  function themeOf(s) {
    const t = s.reader.theme;
    if (t === "auto" || !THEMES.some((x) => x.id === t)) return matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper";
    return t;
  }
  function applySettings(prev) {
    const s = R.settings;
    const root = document.documentElement;
    const theme = themeOf(s);
    root.dataset.rt = theme;
    root.dataset.themeMode = THEMES.find((x) => x.id === theme).mode;
    const f = P.FONTS[s.type.font];
    root.style.setProperty("--r-font", (f && f.family) || BOOK_STACK);
    root.style.setProperty("--r-size", s.reader.size + "px");
    root.style.setProperty("--r-line", s.type.line || 1.65);
    root.style.setProperty("--r-letter", s.type.letter + "em");
    root.style.setProperty("--r-word", s.type.word + "em");
    root.style.setProperty("--r-width", s.reader.width + "ch");
    root.style.setProperty("--polycarp-weight", s.bionic.weight);
    root.style.setProperty("--polycarp-fade", (1 - s.bionic.fade).toFixed(2));
    const art = $("article");
    art.classList.toggle("focus", !!s.reader.focus);
    art.classList.toggle("left", !!s.force.leftAlign);
    document.body.classList.toggle("marks-off", !s.doneMarks && !s.reader.marks);
    const tint = $("tint"), tc = P.TINTS[s.tint.color];
    if (s.tint.on && tc) { tint.style.display = "block"; tint.style.background = tc.color; tint.style.opacity = Math.min(0.6, s.tint.strength * 1.6); }
    else tint.style.display = "none";
    const bionicChanged = !prev || prev.bionic.on !== s.bionic.on || prev.bionic.strength !== s.bionic.strength || prev.bionic.every !== s.bionic.every;
    if (bionicChanged && R.blocks.length) setBionic();
    const roundsChanged = prev && prev.reader.rounds !== s.reader.rounds;
    if (roundsChanged && R.blocks.length) buildRounds();
    renderTypeSheet();
    R.emit("settings", s, prev);
  }
  // Long documents get anchors paragraph by paragraph as they come near the screen, so a book
  // opens at once instead of freezing while every word is restyled.
  const LAZY_WORDS = 15000;
  let bioIO = null;
  function setBionic() {
    const art = $("article");
    if (bioIO) { bioIO.disconnect(); bioIO = null; }
    P.untransformTree(art);
    if (!R.settings.bionic.on) return;
    const opt = { strength: R.settings.bionic.strength, every: R.settings.bionic.every, fade: R.settings.bionic.fade };
    if (R.total < LAZY_WORDS || !R.blocks || typeof IntersectionObserver === "undefined") { P.transformTree(art, opt); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); P.transformTree(e.target, opt); }
    }, { rootMargin: "1600px 0px" });
    R.blocks.forEach((b) => io.observe(b));
    bioIO = io;
  }
  // Printing shows every page at once: finish the anchors first.
  R.finishBionic = function () {
    if (!bioIO) return;
    const opt = { strength: R.settings.bionic.strength, every: R.settings.bionic.every, fade: R.settings.bionic.fade };
    bioIO.disconnect(); bioIO = null;
    for (const b of R.blocks) if (!b.querySelector("polycarp-b")) P.transformTree(b, opt);
  };
  addEventListener("beforeprint", () => R.finishBionic());
  // Reader-only changes keep the profile; reading-style changes make it "custom".
  R.patch = async function (patch, keepProfile) {
    const prev = R.settings;
    R.settings = await P.patchSettings(patch, { keepProfile: !!keepProfile });
    applySettings(prev);
  };

  // ---------- Text settings sheet ----------
  function buildTypeSheet() {
    $("themes").innerHTML = '<button class="theme auto" role="radio" data-id="auto" title="Light or dark, the same as your system">Auto</button>' + THEMES.map((t) =>
      '<button class="theme" role="radio" data-id="' + t.id + '">' + t.label + "</button>").join("");
    P.themeCss().then((css) => {
      for (const t of THEMES) {
        const v = P.themeVars(css, t.mode), b = $("themes").querySelector('[data-id="' + t.id + '"]');
        if (b) { b.style.background = v[t.bg]; b.style.color = v.foreground; }
      }
    });
    $("fonts").innerHTML = Object.keys(P.FONTS).map((id) => {
      const fam = (P.FONTS[id].family || BOOK_STACK).replace(/"/g, "'");
      return '<button class="chip" data-id="' + id + '" style="font-family:' + fam + '">' + FONT_LABEL[id] + "</button>";
    }).join("");
    $("tints").innerHTML = ["none"].concat(Object.keys(P.TINTS)).map((id) => {
      const t = P.TINTS[id];
      return '<button class="swatch' + (id === "none" ? " none" : "") + '" role="radio" data-id="' + id + '" aria-label="' + (t ? t.label : "No") + ' tint" title="' + (t ? t.label : "No tint") + '"' + (t ? ' style="background:' + t.color + '"' : "") + "></button>";
    }).join("");
    $("themes").addEventListener("click", (e) => { const b = e.target.closest(".theme"); if (b) R.patch({ reader: { theme: b.dataset.id } }, true); });
    $("fonts").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) R.patch({ type: { font: b.dataset.id } }); });
    $("tints").addEventListener("click", (e) => {
      const b = e.target.closest(".swatch"); if (!b) return;
      R.patch(b.dataset.id === "none" ? { tint: { on: false } } : { tint: { on: true, color: b.dataset.id } });
    });
    const slider = (id, fn) => {
      const el = $(id);
      el.addEventListener("input", () => { paintRange(el); fn(Number(el.value), false); });
      el.addEventListener("change", () => fn(Number(el.value), true));
    };
    // Live preview on input, save on release.
    const live = (prop, unit) => (v, save) => { document.documentElement.style.setProperty(prop, v + unit); return save; };
    slider("size", (v, save) => { live("--r-size", "px")(v); $("sizeOut").textContent = v; if (save) R.patch({ reader: { size: v } }, true); });
    slider("lineH", (v, save) => { live("--r-line", "")(v); $("lineOut").textContent = v.toFixed(2); if (save) R.patch({ type: { line: v } }); });
    slider("letter", (v, save) => { live("--r-letter", "em")(v); $("letterOut").textContent = v.toFixed(2); if (save) R.patch({ type: { letter: v } }); });
    slider("word", (v, save) => { live("--r-word", "em")(v); $("wordOut").textContent = v.toFixed(2); if (save) R.patch({ type: { word: v } }); });
    slider("width", (v, save) => { live("--r-width", "ch")(v); $("widthOut").textContent = v; if (save) R.patch({ reader: { width: v } }, true); });
    slider("strength", (v, save) => { $("strengthOut").textContent = v || "Off"; if (save) R.patch({ bionic: v ? { on: true, strength: v } : { on: false } }); });
    $("focusMode").addEventListener("change", (e) => R.patch({ reader: { focus: e.target.checked } }, true));
    $("marks").addEventListener("change", (e) => R.patch({ doneMarks: e.target.checked }, true));
    $("sound").addEventListener("change", (e) => R.patch({ reader: { sound: e.target.checked } }, true));
    $("rounds").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) R.patch({ reader: { rounds: b.dataset.v } }, true); });
  }
  function paintRange(el) {
    const min = Number(el.min), max = Number(el.max);
    el.style.setProperty("--fill", ((Number(el.value) - min) / (max - min)) * 100 + "%");
  }
  function renderTypeSheet() {
    const s = R.settings;
    const theme = THEMES.some((x) => x.id === s.reader.theme) ? s.reader.theme : "auto";
    document.querySelectorAll(".theme").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === theme)));
    document.querySelectorAll("#fonts .chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === s.type.font)));
    const tint = s.tint.on ? s.tint.color : "none";
    document.querySelectorAll("#tints .swatch").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === tint)));
    const set = (id, v, out, txt) => { const el = $(id); el.value = v; paintRange(el); $(out).textContent = txt; };
    set("size", s.reader.size, "sizeOut", s.reader.size);
    const line = s.type.line || 1.65;
    set("lineH", line, "lineOut", Number(line).toFixed(2));
    set("letter", s.type.letter, "letterOut", Number(s.type.letter).toFixed(2));
    set("word", s.type.word, "wordOut", Number(s.type.word).toFixed(2));
    set("width", s.reader.width, "widthOut", s.reader.width);
    const st = s.bionic.on ? s.bionic.strength : 0;
    set("strength", st, "strengthOut", st || "Off");
    $("focusMode").checked = !!s.reader.focus;
    $("marks").checked = !!s.doneMarks;
    $("sound").checked = !!s.reader.sound;
    document.querySelectorAll("#rounds button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === s.reader.rounds)));
  }

  // ---------- Sheets ----------
  let openSheet = null;
  R.openSheet = function (id) {
    R.closeSheet();
    openSheet = id;
    $(id).hidden = false; $("scrim").hidden = false;
    const btn = { tocSheet: $("tToc"), typeSheet: $("tType"), notesSheet: $("tNotes") }[id];
    if (btn) btn.setAttribute("aria-pressed", "true");
    if (id === "tocSheet") renderToc();
    R.emit("sheet", id);
    const first = $(id).querySelector("button, input, a");
    if (first) first.focus();
  };
  R.closeSheet = function () {
    if (!openSheet) return;
    $(openSheet).hidden = true; $("scrim").hidden = true;
    ["tToc", "tType", "tNotes"].forEach((t) => $(t).setAttribute("aria-pressed", "false"));
    openSheet = null;
  };
  function toggleSheet(id) { if (openSheet === id) R.closeSheet(); else R.openSheet(id); }
  R.toggleSheet = toggleSheet;

  function renderToc() {
    const curSec = R.sectionOf(R.cur);
    $("toc").innerHTML = R.sections.map((s, i) => {
      let read = 0;
      for (let b = s.start; b <= s.end; b++) if (R.done.has(b)) read += R.words[b];
      const pct = s.words ? Math.round((read / s.words) * 100) : 0;
      return '<li><a href="#' + s.el.id + '" data-i="' + i + '"' + (i === curSec ? ' class="here" aria-current="true"' : "") + ">" +
        esc(s.title) + "<span>" + (pct >= 98 ? I("check").replace('class="i"', 'class="i" style="width:16px;height:16px;color:var(--ok)"') : pct ? pct + "%" : minutes(s.words)) + "</span></a></li>";
    }).join("");
  }

  // ---------- Loading ----------
  function showLoading(title, note) {
    setState("loading");
    $("loadTitle").textContent = title || "Opening";
    $("loadNote").textContent = note || "Getting it ready.";
    $("loadFill").style.width = "5%";
  }
  const onProgress = (f) => { $("loadFill").style.width = Math.max(5, Math.round(f * 100)) + "%"; };
  function showError(err, original) {
    setState("error");
    $("errText").textContent = (err && err.message) || String(err || "Something went wrong.");
    if (original) { const a = $("errOriginal"); a.hidden = false; a.href = original; }
    document.title = "Polycarp Reader";
  }
  function googleDocExport(url) {
    const m = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/.exec(url);
    return m ? "https://docs.google.com/document/d/" + m[1] + "/export?format=html" : null;
  }
  R.openUrl = async function (url) {
    showLoading("Opening link", url.replace(/^https?:\/\//, "").slice(0, 80));
    const g = googleDocExport(url);
    try {
      const doc = await PolycarpImport.fromUrl(g || url, { onProgress });
      if (g) { doc.source = Object.assign({}, doc.source, { url }); }
      await present(doc, { key: "u:" + url.replace(/#.*$/, "") });
    } catch (e) { showError(e, url); }
  };
  R.openFile = async function (file) {
    showLoading("Opening " + file.name, "Reading " + Math.max(1, Math.round(file.size / 1024)).toLocaleString() + " KB on this computer.");
    try {
      const doc = await PolycarpImport.fromFile(file, { onProgress });
      await present(doc, { key: "f:" + file.name + ":" + file.size, store: true });
    } catch (e) { showError(e); }
  };
  async function openText(text) {
    try {
      const doc = PolycarpImport.fromText(text, "Pasted text.txt");
      await present(doc, { key: "t:" + hash(text), store: true });
    } catch (e) { showError(e); }
  }
  async function openSnapshot(id) {
    showLoading("Opening page");
    const got = await chrome.storage.session.get(id);
    const snap = got[id];
    if (!snap) return showError(new Error("This page snapshot has expired. Open the page again and choose Read this page in Polycarp."));
    chrome.storage.session.remove(id);
    try {
      const doc = PolycarpImport.fromHtml(snap.html, snap.url, snap.title);
      await present(doc, { key: "u:" + String(snap.url || "").replace(/#.*$/, ""), store: true });
    } catch (e) { showError(e, snap.url); }
  }
  async function openLibrary(key) {
    showLoading("Opening");
    const entry = await Lib.get(key).catch(() => null);
    if (!entry) return showError(new Error("This document is no longer in your library. Open the file again."));
    await present(entry.doc, { key, store: true });
  }

  // ---------- Library index ----------
  // Every document read is indexed in the Library so it can be searched, noted and linked to others.
  // A saved link that is now opened becomes a document instead of a second entry.
  R.itemId = null;
  async function indexInLibrary(doc, words) {
    const L = globalThis.PolycarpLibrary;
    if (!L) return;
    const key = R.key;
    try {
      const text = Lib.textOf(doc);
      const url = (doc.source && doc.source.url) || null;
      let item = await L.itemByDocKey(key);
      if (!item && url) {
        const link = await L.itemByUrl(url);
        if (link && !link.docKey) {
          await L.updateItem(link.id, { kind: "doc", docKey: key, text, source: R.kind, words, title: doc.title || link.title, author: doc.author || link.author || "" });
          item = await L.getItem(link.id);
        }
      }
      if (!item) item = await L.upsertDoc({ docKey: key, title: doc.title, author: doc.author, url, sourceKind: R.kind, text });
      if (R.key !== key || !item) return;
      R.itemId = item.id;
      R.emit("item", item);
    } catch (e) { console.warn("Polycarp library index", e); }
  }

  // ---------- Render ----------
  async function present(doc, opts) {
    R.doc = doc;
    R.key = opts.key;
    R.kind = (doc.source && doc.source.kind) || "html";
    const words = doc.sections.reduce((n, s) => n + P.countWords(s.html.replace(/<[^>]+>/g, " ")), 0);
    if (opts.store) {
      Lib.put({ key: R.key, title: doc.title, author: doc.author, kind: R.kind, words, added: Date.now(), opened: Date.now(), doc }).catch(() => {});
    } else {
      // Linked documents are cached too, so they reopen offline from the library.
      Lib.put({ key: R.key, title: doc.title, author: doc.author, kind: R.kind, words, added: Date.now(), opened: Date.now(), doc, url: doc.source && doc.source.url }).catch(() => {});
    }
    const q = new URLSearchParams(location.search);
    if (!q.get("lib") || q.get("lib") !== R.key) {
      const next = new URL(location.href);
      ["src", "doc", "print", "b"].forEach((k) => next.searchParams.delete(k));
      next.searchParams.set("lib", R.key);
      history.replaceState(null, "", next);
    }
    indexInLibrary(doc, words);
    render();
    const prog = await getProgress(R.key);
    restore(prog);
    setState("reading");
    document.title = doc.title + " · Polycarp";
    R.emit("rendered", R);
    startTracking();
    if (prog && prog.cur > 2) {
      R.go(prog.cur, false);
      R.toast("Welcome back", "Picked up where you left off, " + Math.round(prog.pct * 100) + "% read.", IC.mascot("open"));
    }
  }

  function render() {
    const doc = R.doc;
    const art = $("article");
    art.textContent = "";
    $("docTitle").textContent = doc.title;
    doc.sections.forEach((s, i) => {
      const sec = document.createElement("section");
      sec.className = "sec";
      sec.id = "s-" + i;
      sec.innerHTML = s.html;
      // The importer drops a chapter's own heading; print a real chapter title back, skip made-up ones.
      if (doc.sections.length > 1 && s.title && s.title !== doc.title && !/^(Pages? \d|Part \d+$)/.test(s.title)) {
        const h = document.createElement("h2");
        h.className = "sec-title";
        h.textContent = s.title;
        sec.prepend(h);
      }
      art.appendChild(sec);
    });
    art.querySelectorAll("a[href]").forEach((a) => { if (!a.getAttribute("href").startsWith("#")) { a.target = "_blank"; a.rel = "noopener noreferrer"; } });
    // Blocks: the smallest text containers, in reading order.
    const all = [...art.querySelectorAll(BLOCK_SEL)];
    R.blocks = all.filter((el) => !el.querySelector(BLOCK_SEL) && /\S/.test(el.textContent));
    R.words = R.blocks.map((el) => P.countWords(el.textContent));
    R.cum = []; let acc = 0;
    R.words.forEach((w) => { R.cum.push(acc); acc += w; });
    R.total = acc;
    // Each block takes its direction from its own text, so Arabic or Hebrew reads right to left.
    R.blocks.forEach((el, i) => { el.classList.add("blk"); el.dataset.b = i; el.dir = "auto"; });
    art.lang = doc.lang || (/[\u0590-\u08FF]/.test(art.textContent.slice(0, 2000)) ? "" : "en");
    R.sections = [...art.querySelectorAll(".sec")].map((el, i) => {
      const bl = [...el.querySelectorAll(".blk")].map((b) => Number(b.dataset.b));
      const start = bl.length ? bl[0] : -1, end = bl.length ? bl[bl.length - 1] : -2;
      let w = 0; for (let b = start; b <= end; b++) w += R.words[b] || 0;
      return { el, title: doc.sections[i].title, start, end, words: w };
    }).filter((s) => s.start >= 0);
    $("docMeta").textContent = [doc.author, KIND_LABEL[R.kind] || "Document", minutes(R.total)].filter(Boolean).join(" · ");
    $("docH1").textContent = doc.title;
    $("docByline").textContent = [doc.author, KIND_LABEL[R.kind] || "Document", minutes(R.total)].filter(Boolean).join(" · ");
    setBionic();
    buildRounds();
    R.done = new Set(); R.doneWords = 0; R.finished = false; R.cur = 0;
  }
  R.sectionOf = function (b) {
    for (let i = R.sections.length - 1; i >= 0; i--) if (b >= R.sections[i].start) return i;
    return 0;
  };
  R.blockText = (i) => (R.blocks[i] ? R.blocks[i].textContent.replace(/\s+/g, " ").trim() : "");
  R.rangeText = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(R.blockText(i)); return out.join("\n\n"); };

  // Recall rounds: a short checkpoint after every few hundred words.
  function buildRounds() {
    document.querySelectorAll("#article .checkpoint:not(.answered)").forEach((el) => el.remove());
    R.rounds = [];
    const target = ROUND_WORDS[R.settings.reader.rounds];
    if (!target || !R.settings.reader.recall) { R.emit("rounds", R.rounds); return; }
    let acc = 0, start = 0;
    const isHead = (el) => /^H[1-6]$/.test(el.tagName);
    for (let i = 0; i < R.blocks.length; i++) {
      acc += R.words[i];
      const next = R.blocks[i + 1];
      const nextIsHead = next && isHead(next);
      const last = i === R.blocks.length - 1;
      if ((acc >= target && !isHead(R.blocks[i])) || (nextIsHead && acc >= target * 0.6) || (last && acc >= target * 0.4)) {
        R.rounds.push({ n: R.rounds.length + 1, start, end: i, words: acc });
        acc = 0; start = i + 1;
      }
    }
    const answered = new Set([...document.querySelectorAll("#article .checkpoint.answered")].map((el) => Number(el.dataset.end)));
    for (const r of R.rounds) {
      if (answered.has(r.end)) continue;
      const el = document.createElement("div");
      el.className = "checkpoint";
      el.dataset.round = r.n; el.dataset.end = r.end;
      el.setAttribute("data-polycarp-skip", "");
      // Insert after the top-level block so it never lands inside a list or quote.
      let host = R.blocks[r.end];
      while (host.parentElement && !host.parentElement.classList.contains("sec")) host = host.parentElement;
      host.after(el);
      r.el = el;
    }
    R.emit("rounds", R.rounds);
  }

  function restore(prog) {
    if (!prog) return;
    R.done = unpackDone(prog.done);
    R.doneWords = 0;
    for (const i of R.done) { if (R.blocks[i]) { R.blocks[i].classList.add("done"); R.doneWords += R.words[i]; } else R.done.delete(i); }
    R.finished = !!prog.finished;
    R.extra = prog.extra || {};
    R.cur = Math.min(prog.cur || 0, R.blocks.length - 1);
    paintProgress();
  }

  // ---------- Tracking ----------
  // A paragraph counts as read only after it sits in the reading band for about as long as a fast
  // reader needs (words / 9 per second, 540 wpm), while the tab is visible and the reader is active.
  let lastActive = Date.now();
  const pending = {};
  let band = new Set();
  const dwell = new Map();
  function active() { return document.visibilityState === "visible" && (Date.now() - lastActive < 60000 || R.busy); }
  ["scroll", "keydown", "pointermove", "wheel", "touchstart", "pointerdown"].forEach((ev) =>
    addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true }));

  // Two zones: the narrow band near the middle decides the current paragraph; the wider zone
  // (top four fifths) collects reading time, credited to the first unread paragraph in it, because
  // people read top to bottom.
  const zone = new Set();
  function startTracking() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number(e.target.dataset.b);
        if (e.isIntersecting) band.add(i); else band.delete(i);
      }
      pickCur();
    }, { rootMargin: "-38% 0px -50% 0px" });
    const zo = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number(e.target.dataset.b);
        if (e.isIntersecting) zone.add(i); else zone.delete(i);
      }
      pickCur();
    }, { rootMargin: "-56px 0px -20% 0px" });
    R.blocks.forEach((el) => { io.observe(el); zo.observe(el); });
    setInterval(tick, 500);
    setInterval(flush, 8000);
    addEventListener("pagehide", () => { flush(); R.saveProgress(true); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { flush(); R.saveProgress(true); } });
    addEventListener("scroll", () => $("bar").classList.toggle("scrolled", scrollY > 4), { passive: true });
  }
  function pickCur() {
    if (R.lockCur) return;
    // At the very top, nothing has reached the middle band yet: start with the first paragraph.
    // A short first line (a byline, a dateline) is read at a glance, so start on the first real paragraph.
    if (scrollY < 80 && zone.size) {
      const top = [...zone].sort((a, b) => a - b);
      return setCur(top.find((i) => R.words[i] >= 10 || /^H[1-6]$/.test(R.blocks[i].tagName)) ?? top[0]);
    }
    if (band.size) setCur(Math.min(...band));
  }
  function tick() {
    if (!active() || R.sprinting) return;
    let i = -1;
    for (const z of zone) if (!R.done.has(z) && (i < 0 || z < i)) i = z;
    if (i < 0) return;
    const need = Math.max(700, (R.words[i] / 9) * 1000);
    const t = (dwell.get(i) || 0) + 500;
    dwell.set(i, t);
    if (t >= need) R.markDone(i, R.kind);
  }
  function setCur(i) {
    if (i === R.cur && R.blocks[i] && R.blocks[i].classList.contains("cur")) return;
    if (R.blocks[R.cur]) R.blocks[R.cur].classList.remove("cur");
    R.cur = i;
    if (R.blocks[i]) R.blocks[i].classList.add("cur");
    paintProgress();
    R.saveProgress();
    R.emit("current", i);
  }
  R.setCur = setCur;
  R.markDone = function (i, kind, opts) {
    if (R.done.has(i) || !R.blocks[i]) return;
    R.done.add(i);
    R.blocks[i].classList.add("done");
    R.doneWords += R.words[i];
    const k = kind || R.kind;
    pending[k] = pending[k] || { words: 0, sprint: false };
    pending[k].words += R.words[i];
    if (opts && opts.sprint) pending[k].sprint = true;
    paintProgress();
    R.saveProgress();
    R.emit("done", i);
    if (!R.finished && R.total && (R.doneWords / R.total >= 0.98 || (R.done.has(R.blocks.length - 1) && R.doneWords / R.total >= 0.85))) {
      R.finished = true;
      flush(true);
      R.emit("finished");
    }
  };
  async function flush(finished) {
    const kinds = Object.keys(pending).filter((k) => pending[k].words > 0);
    if (!kinds.length && !finished) return;
    if (!kinds.length) kinds.push(R.kind);
    for (const k of kinds) {
      const p = pending[k] || { words: 0 };
      const msg = { type: "polycarp:read", words: p.words, kind: k === "listen" ? R.kind : k, sprint: !!p.sprint, finished: !!finished };
      pending[k] = { words: 0, sprint: false };
      finished = false;
      try {
        const res = await chrome.runtime.sendMessage(msg);
        if (res && res.events) R.showEvents(res.events);
      } catch (e) { /* service worker asleep; words are lost only on a crash */ }
    }
  }
  R.flush = flush;
  R.report = async function (msg) {
    try { const res = await chrome.runtime.sendMessage(Object.assign({ type: "polycarp:read", words: 0, kind: R.kind }, msg)); if (res && res.events) R.showEvents(res.events); } catch (e) {}
  };

  function paintProgress() {
    if (!R.total) return;
    const at = (R.cum[R.cur] || 0) + (R.words[R.cur] || 0);
    $("progressFill").style.width = Math.min(100, (at / R.total) * 100) + "%";
    const left = Math.max(0, R.total - R.doneWords);
    const pct = Math.round((R.doneWords / R.total) * 100);
    $("docMeta").textContent = [R.doc.author, pct ? pct + "% read" : KIND_LABEL[R.kind] || "Document", left ? minutes(left) + " left" : "Finished"].filter(Boolean).join(" · ");
  }

  // ---------- Navigation ----------
  R.go = function (i, smooth) {
    i = Math.max(0, Math.min(R.blocks.length - 1, i));
    const el = R.blocks[i];
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: smooth === false || reduced() ? "auto" : "smooth" });
    setCur(i);
  };

  // ---------- Landing ----------
  async function renderShelf() {
    let list = [];
    try { list = await Lib.all(); } catch (e) {}
    if (!list.length) return;
    const got = await chrome.storage.local.get(DOCS_KEY);
    const prog = got[DOCS_KEY] || {};
    list.sort((a, b) => ((prog[b.key] && prog[b.key].updated) || b.opened) - ((prog[a.key] && prog[a.key].updated) || a.opened));
    $("shelf").hidden = false;
    $("shelfList").innerHTML = list.slice(0, 12).map((d) => {
      const p = prog[d.key];
      const pct = p ? Math.round(p.pct * 100) : 0;
      return '<li data-key="' + esc(d.key) + '" tabindex="0">' +
        '<span class="t"><span class="kind">' + esc(KIND_LABEL[d.kind] || d.kind) + '</span><b>' + esc(d.title) + "</b><span>" + esc([d.author, p && p.finished ? "Finished" : pct ? pct + "% read" : minutes(d.words || 0)].filter(Boolean).join(" · ")) + "</span></span>" +
        '<span class="pct"><span class="mini"><i style="width:' + pct + '%"></i></span></span>' +
        '<button class="btn icon quiet x" data-del aria-label="Remove ' + esc(d.title) + ' from library">' + I("x") + "</button></li>";
    }).join("");
  }
  function bindLanding() {
    $("heroPip").innerHTML = IC.mascot("open");
    $("dropIcon").innerHTML = I("upload");
    $("pasteBtn").innerHTML = I("type") + "<span>Paste text</span>";
    $("navRead").innerHTML = I("book") + "<span>Reader</span>";
    $("navSearch").innerHTML = I("search") + "<span>Search</span>";
    $("libLink").innerHTML = I("library") + "<span>Library</span>";
    $("reviewLink").innerHTML = I("layers") + "<span>Review</span>";
    $("settingsLink").innerHTML = I("sliders") + "<span>Settings</span>";
    const h1 = $("landTitle");
    if (R.settings.bionic.on) { const t = h1.textContent; h1.textContent = ""; h1.appendChild(P.renderBionic(t, R.settings.bionic, document)); }
    $("file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) R.openFile(f); });
    const drop = $("drop");
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
    ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === drop) drop.classList.remove("over"); }));
    document.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) return R.openFile(f);
      const u = e.dataTransfer && (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain"));
      if (u && /^https?:\/\//.test(u.trim())) R.openUrl(u.trim());
    });
    $("urlForm").addEventListener("submit", (e) => {
      e.preventDefault();
      let u = $("url").value.trim();
      if (!u) return;
      if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
      R.openUrl(u);
    });
    $("pasteBtn").addEventListener("click", () => { $("pasteForm").hidden = !$("pasteForm").hidden; if (!$("pasteForm").hidden) $("pasteText").focus(); });
    $("pasteForm").addEventListener("submit", (e) => { e.preventDefault(); const t = $("pasteText").value; if (t.trim()) openText(t); });
    $("shelfList").addEventListener("click", async (e) => {
      const li = e.target.closest("li"); if (!li) return;
      if (e.target.closest("[data-del]")) { await Lib.del(li.dataset.key); li.remove(); if (!$("shelfList").children.length) $("shelf").hidden = true; return; }
      location.search = "?lib=" + encodeURIComponent(li.dataset.key);
    });
    $("shelfList").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("li")) e.target.click(); });
    // Review count
    const M = globalThis.PolycarpMemory;
    if (M) M.load().then((cards) => { const d = M.counts(cards, Date.now()).due; if (d) { $("reviewLink").innerHTML = I("layers") + '<span>Review <b class="due">' + d + "</b></span>"; $("reviewLink").title = d + (d === 1 ? " idea is" : " ideas are") + " ready to review"; } }).catch(() => {});
    renderShelf();
  }

  // ---------- Keys ----------
  function bindKeys() {
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p" && document.body.dataset.state === "reading") {
        e.preventDefault(); if (R.openPrint) R.openPrint(); return;
      }
      if (e.key === "Escape") { R.closeSheet(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || R.sprinting) return;
      if (e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (document.body.dataset.state !== "reading") return;
      const k = e.key.toLowerCase();
      const act = {
        j: () => R.go(R.cur + 1), k: () => R.go(R.cur - 1),
        c: () => toggleSheet("tocSheet"), a: () => toggleSheet("typeSheet"),
        l: () => R.toggleListen && R.toggleListen(), r: () => R.startSprint && R.startSprint(),
        p: () => R.openPrint && R.openPrint(), s: () => R.snap && R.snap(),
        n: () => toggleSheet("notesSheet"), h: () => R.highlight && R.highlight(),
        "=": () => R.patch({ reader: { size: Math.min(34, R.settings.reader.size + 1) } }, true),
        "+": () => R.patch({ reader: { size: Math.min(34, R.settings.reader.size + 1) } }, true),
        "-": () => R.patch({ reader: { size: Math.max(14, R.settings.reader.size - 1) } }, true)
      }[k];
      if (act) { e.preventDefault(); act(); }
    });
  }

  // ---------- Boot ----------
  async function boot() {
    R.settings = await P.getSettings();
    $("tToc").innerHTML = I("list") + "<span>Contents</span>";
    $("tListen").innerHTML = I("headphones") + "<span>Listen</span>";
    $("tSprint").innerHTML = I("zap") + "<span>Speed read</span>";
    $("tType").innerHTML = '<b class="aa" aria-hidden="true">Aa</b><span>Text</span>';
    $("tPrint").innerHTML = I("printer") + "<span>Print</span>";
    $("tNotes").innerHTML = I("pen") + "<span>Notes</span>";
    $("tNotes").addEventListener("click", () => toggleSheet("notesSheet"));
    document.querySelectorAll("[data-close]").forEach((b) => { b.innerHTML = I("x"); b.addEventListener("click", R.closeSheet); });
    $("scrim").addEventListener("click", R.closeSheet);
    $("tToc").addEventListener("click", () => toggleSheet("tocSheet"));
    $("tType").addEventListener("click", () => toggleSheet("typeSheet"));
    $("toc").addEventListener("click", (e) => {
      const a = e.target.closest("a"); if (!a) return;
      e.preventDefault();
      const s = R.sections[Number(a.dataset.i)];
      R.closeSheet();
      R.go(s.start);
    });
    buildTypeSheet();
    applySettings(null);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applySettings(R.settings));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !ch[P.SETTINGS_KEY]) return;
      const prev = R.settings;
      R.settings = P.migrate(ch[P.SETTINGS_KEY].newValue);
      applySettings(prev);
    });
    bindKeys();
    const q = new URLSearchParams(location.search);
    if (q.get("doc")) await openSnapshot(q.get("doc"));
    else if (q.get("src")) await R.openUrl(q.get("src"));
    else if (q.get("nas") && globalThis.PolycarpNAS) {
      // A book or document on the user's own NAS: fetch it with their saved login, open it as a file.
      const path = q.get("nas");
      const blob = await PolycarpNAS.get(path);
      await R.openFile(new File([blob], path.split("/").pop() || "document", { type: blob.type }));
    }
    else if (q.get("lib")) await openLibrary(q.get("lib"));
    else { setState("landing"); bindLanding(); }
    // A note in the Library links to its paragraph with ?b=N.
    if (q.get("b") && document.body.dataset.state === "reading") setTimeout(() => R.go(Number(q.get("b")) || 0), 250);
    if (q.get("print") === "1" && document.body.dataset.state === "reading" && R.openPrint) setTimeout(R.openPrint, 400);
  }
  document.addEventListener("DOMContentLoaded", () => { boot().catch((e) => { console.error(e); showError(e); }); });
})();
