/* Polycarp Search: one box over the user's library, YouTube, free and open sources, sources they
   add by pasting a link, captured libraries (Audible, Kindle) and their own NAS. */
(async function () {
  "use strict";
  const P = globalThis.Polycarp;
  const I = globalThis.PolycarpIcons.icon;
  const SRC = globalThis.PolycarpSources || null;
  const NAS = globalThis.PolycarpNAS || null;
  const LIB = globalThis.PolycarpLibrary || null;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const READER = chrome.runtime.getURL("src/reader/reader.html");
  const PREFS = "polycarp.search";

  $("navRead").innerHTML = I("book") + "<span>Reader</span>";
  $("navSearch").innerHTML = I("search") + "<span>Search</span>";
  $("navLib").innerHTML = I("library") + "<span>Library</span>";
  $("navReview").innerHTML = I("layers") + "<span>Review</span>";
  $("navSettings").innerHTML = I("sliders") + "<span>Settings</span>";
  $("sIcon").innerHTML = I("search");
  $("browseClose").innerHTML = I("x");

  const ICONS = { library: "library", youtube: "video", wikipedia: "globe", gutenberg: "book", openlibrary: "book", archive: "library",
    librivox: "headphones", arxiv: "file", openalex: "file", nas: "server", list: "list", feed: "sync", opds: "book", crawl: "globe",
    template: "search", opensearch: "search", audible: "headphones", kindle: "book" };
  const KIND = { page: "Page", book: "Book", audiobook: "Audiobook", video: "Video", paper: "Paper", file: "File", item: "", note: "Note" };

  function toast(title, body) {
    const t = el("div", "toast");
    t.appendChild(el("b", null, title));
    if (body) t.appendChild(el("span", null, body));
    $("toasts").append(t);
    setTimeout(() => t.remove(), 4200);
  }
  function notice(text, kind) {
    const n = $("notice");
    n.hidden = !text;
    n.className = "notice" + (kind ? " " + kind : "");
    n.textContent = text || "";
  }

  // ---------- Sources and which are on ----------
  let prefs = (await chrome.storage.local.get(PREFS))[PREFS] || { off: {} };
  const savePrefs = () => chrome.storage.local.set({ [PREFS]: prefs });
  let nasCfg = NAS ? await NAS.getConfig().catch(() => null) : null;

  async function allSources() {
    // The user's own things first: the Polycarp library, libraries and sites they added, their NAS.
    const builtin = (SRC ? SRC.BUILTIN : []).map((b) => ({ id: b.id, name: b.name, blurb: b.blurb, kind: b.kind || b.id, builtin: true, defaultOn: b.defaultOn !== false }));
    const own = (SRC ? await SRC.listCustom() : []).map((c) => ({ id: c.id, name: c.name, blurb: [c.count ? c.count.toLocaleString() + (c.type === "list" ? (c.count === 1 ? " title" : " titles") : c.count === 1 ? " page indexed" : " pages indexed") : "", c.url ? hostOf(c.url) : ""].filter(Boolean).join(" · "), kind: c.type, custom: c, defaultOn: c.on !== false }));
    if (NAS && nasCfg && nasCfg.url) own.push({ id: "nas", name: "Your NAS", blurb: hostOf(nasCfg.url), kind: "nas", defaultOn: true });
    const lib = builtin.filter((b) => b.id === "library");
    return lib.concat(own, builtin.filter((b) => b.id !== "library"));
  }
  const isOn = (s) => (prefs.off[s.id] == null ? s.defaultOn : !prefs.off[s.id]);
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }

  let sources = await allSources();

  function renderChips() {
    const box = $("chips");
    box.textContent = "";
    for (const s of sources) {
      const b = el("button", "chip");
      b.type = "button";
      b.setAttribute("aria-pressed", String(isOn(s)));
      b.innerHTML = I(ICONS[s.id] || ICONS[s.kind] || "search");
      b.appendChild(el("span", null, s.name));
      b.addEventListener("click", () => {
        prefs.off[s.id] = isOn(s);
        savePrefs();
        renderChips();
        if (lastQ) run(lastQ);
      });
      box.appendChild(b);
    }
    const add = el("button", "chip add");
    add.type = "button";
    add.innerHTML = I("plus");
    add.appendChild(el("span", null, "Add a source"));
    add.addEventListener("click", () => { showHome(); $("addUrl").focus(); $("addBlock").scrollIntoView({ block: "start" }); });
    box.appendChild(add);
  }

  // ---------- Results ----------
  let lastQ = "";
  let ctrl = null;
  const SHOW = 4;

  function showHome() { $("results").hidden = true; $("home").hidden = false; $("chips").hidden = true; }

  async function run(q) {
    lastQ = q;
    const u = new URL(location.href);
    if (q) u.searchParams.set("q", q); else u.searchParams.delete("q");
    u.searchParams.delete("import");
    history.replaceState(null, "", u);
    if (!q) { showHome(); return; }
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    $("home").hidden = true;
    $("chips").hidden = false;
    const box = $("results");
    box.hidden = false;
    box.textContent = "";
    const on = sources.filter(isOn);
    if (!on.length) { box.appendChild(el("p", "empty", "Every source is turned off. Tap one above to search it.")); return; }
    const sections = new Map();
    for (const s of on) {
      const sec = el("section", "rsec loading");
      sec.dataset.id = s.id;
      const h = el("h2");
      h.innerHTML = I(ICONS[s.id] || ICONS[s.kind] || "search");
      h.appendChild(el("span", null, s.name));
      const count = el("small", null, "Searching...");
      h.appendChild(count);
      sec.appendChild(h);
      sec.appendChild(el("ul", "rlist"));
      box.appendChild(sec);
      sections.set(s.id, { sec, count, src: s });
    }
    const fill = (id, results, error) => {
      const it = sections.get(id);
      if (!it || signal.aborted) return;
      it.sec.classList.remove("loading");
      const list = it.sec.querySelector(".rlist");
      list.textContent = "";
      if (error) { it.count.textContent = ""; list.appendChild(el("li", "rerr", error)); return; }
      results = results || [];
      it.count.textContent = results.length ? String(results.length) : "";
      if (!results.length) { it.sec.classList.add("none"); list.appendChild(el("li", "rnone", "Nothing found here.")); box.appendChild(it.sec); return; }
      results.forEach((r, i) => { const li = row(r, it.src); if (i >= SHOW) li.hidden = true; list.appendChild(li); });
      if (results.length > SHOW) {
        const more = el("button", "btn quiet more", "Show all " + results.length);
        more.type = "button";
        more.addEventListener("click", () => { list.querySelectorAll("li[hidden]").forEach((x) => (x.hidden = false)); more.remove(); });
        it.sec.appendChild(more);
      }
    };
    const ids = on.map((s) => s.id).filter((id) => id !== "nas");
    const jobs = [];
    if (SRC && ids.length) jobs.push(SRC.search(q, { sources: ids, signal, limit: 20, onResults: fill }).catch(() => {}));
    if (on.some((s) => s.id === "nas")) {
      jobs.push(NAS.search(q, 50).then((r) => fill("nas", r), (e) => fill("nas", null, friendly(e))));
    }
    await Promise.all(jobs);
  }
  function friendly(e) { return (e && e.message) || "This source did not answer."; }

  function row(r, src) {
    const li = el("li", "res" + (r.kind === "video" ? " vid" : ""));
    if (r.image) {
      const img = el("img", "thumb");
      img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.decoding = "async";
      img.src = r.image;
      img.addEventListener("error", () => img.remove());
      li.appendChild(img);
    }
    const body = el("div", "rb");
    const href = r.source === "library" && r.libId ? chrome.runtime.getURL("src/pages/library.html#item=" + encodeURIComponent(r.libId)) : r.url;
    const a = el("a", "rt", r.title || r.url || "Untitled");
    if (href) { a.href = href; if (!href.startsWith("chrome-extension:")) { a.target = "_blank"; a.rel = "noopener noreferrer"; } }
    body.appendChild(a);
    const meta = [KIND[r.kind] || "", r.by, r.year, r.duration].filter(Boolean).join(" · ");
    if (meta) body.appendChild(el("div", "rm", meta));
    if (r.snippet) body.appendChild(el("p", "rs", r.snippet));
    const acts = el("div", "ra");
    const btn = (label, icon, fn, primary) => {
      const b = el("button", "btn" + (primary ? "" : " quiet"));
      b.type = "button";
      b.innerHTML = I(icon);
      b.appendChild(el("span", null, label));
      b.addEventListener("click", () => fn(b));
      acts.appendChild(b);
      return b;
    };
    const fileUrl = r.readUrl || (r.files && r.files[0] && r.files[0].url) || "";
    if (r.source === "nas" && r.nasPath) btn("Read in Polycarp", "book", () => openReader({ nas: r.nasPath }), true);
    else if (r.source === "youtube" || r.kind === "video" && /youtube\.com|youtu\.be/.test(r.url || "")) btn("Read transcript", "book", () => readVideo(r.url), true);
    else if (r.readUrl) btn("Read in Polycarp", "book", () => openReader({ src: r.readUrl }), true);
    else if (r.url && /^https?:/.test(r.url) && r.kind !== "audiobook") btn("Read in Polycarp", "book", () => openReader({ src: r.url }), true);
    if (NAS && nasCfg && nasCfg.url && r.source !== "nas" && downloadable(r)) btn("Save to NAS", "server", (b) => saveToNas(r, b));
    if (downloadable(r)) btn("Download", "download", (b) => download(r, b));
    if (LIB && r.url && /^https?:/.test(r.url) && r.source !== "library") btn("Save", "bookmark", (b) => saveToLibrary(r, b));
    if (acts.children.length) body.appendChild(acts);
    if (r.files && r.files.length > 1) {
      const d = el("details", "formats");
      d.appendChild(el("summary", null, r.files.length + " formats"));
      const ul = el("ul");
      for (const f of r.files) {
        const fl = el("li");
        const fa = el("a", null, f.label || f.type || "File");
        fa.href = f.url; fa.target = "_blank"; fa.rel = "noopener noreferrer";
        fl.appendChild(fa);
        ul.appendChild(fl);
      }
      d.appendChild(ul);
      body.appendChild(d);
    }
    li.appendChild(body);
    return li;
  }
  function downloadable(r) {
    const u = (r.files && r.files.find((f) => f.type !== "link") || {}).url || (r.kind !== "page" ? r.readUrl : "");
    return !!(u && /^https?:/.test(u) && r.source !== "youtube" && r.source !== "library");
  }
  function fileOf(r) { return (r.files && r.files.find((f) => f.type !== "link") || {}).url || r.readUrl; }
  function openReader(params) { chrome.tabs.create({ url: READER + "?" + new URLSearchParams(params) }); }
  function readVideo(url) { chrome.runtime.sendMessage({ type: "polycarp:readUrl", url }); toast("Opening the video", "Polycarp reads its transcript and opens it in the Reader."); }

  async function saveToNas(r, b) {
    const label = b.querySelector("span");
    b.disabled = true;
    const folder = "Polycarp/" + ({ book: "Books", audiobook: "Audiobooks", paper: "Papers", video: "Video" }[r.kind] || "Downloads");
    try {
      const out = await NAS.saveUrl(fileOf(r), { folder, name: r.title, onProgress: (done, total) => { label.textContent = total ? Math.round((done / total) * 100) + "%" : "Saving..."; } });
      label.textContent = "On your NAS";
      b.title = out.path;
      toast("Saved to your NAS", out.path);
    } catch (e) {
      label.textContent = "Save to NAS";
      b.disabled = false;
      toast("Could not save to your NAS", friendly(e));
    }
  }
  async function download(r, b) {
    const label = b.querySelector("span");
    b.disabled = true;
    label.textContent = "Downloading...";
    try {
      const url = fileOf(r);
      const res = await fetch(url);
      if (!res.ok) throw new Error("The site answered " + res.status + ".");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (r.title || "download").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 120) + extOf(url, blob.type);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      label.textContent = "Downloaded";
    } catch (e) {
      label.textContent = "Download";
      b.disabled = false;
      toast("Could not download this", friendly(e));
    }
  }
  function extOf(url, type) {
    const m = String(url).split("?")[0].match(/\.(epub|pdf|txt|mp3|m4b|zip|html?|mobi|azw3)$/i);
    if (m) return "." + m[1].toLowerCase();
    return { "application/epub+zip": ".epub", "application/pdf": ".pdf", "audio/mpeg": ".mp3", "application/zip": ".zip", "text/plain": ".txt" }[type] || "";
  }
  async function saveToLibrary(r, b) {
    b.disabled = true;
    try {
      await LIB.saveLink({ url: r.url, title: r.title, excerpt: r.snippet, text: r.snippet });
      b.querySelector("span").textContent = "Saved";
      b.innerHTML = I("check") + b.innerHTML.replace(/^<svg[\s\S]*?<\/svg>/, "");
    } catch (e) { b.disabled = false; toast("Could not save this", friendly(e)); }
  }

  // ---------- Home: the source list ----------
  function renderList() {
    const ul = $("slist");
    ul.textContent = "";
    for (const s of sources) {
      const li = el("li");
      const ic = el("span", "sic");
      ic.innerHTML = I(ICONS[s.id] || ICONS[s.kind] || "search");
      li.appendChild(ic);
      const t = el("div", "st");
      t.appendChild(el("b", null, s.name));
      let sub = s.blurb || "";
      if (sub) t.appendChild(el("span", null, sub));
      li.appendChild(t);
      if (s.custom) {
        if (/feed|opds|crawl/.test(s.kind)) {
          const re = el("button", "btn quiet", "Update");
          re.type = "button";
          re.addEventListener("click", () => refresh(s.custom, re));
          li.appendChild(re);
        }
        const rm = el("button", "btn quiet icon");
        rm.type = "button";
        rm.innerHTML = I("trash");
        rm.setAttribute("aria-label", "Remove " + s.name);
        rm.title = "Remove";
        rm.addEventListener("click", async () => {
          if (!confirm("Remove " + s.name + " and its index? Your own files and accounts are not touched.")) return;
          await SRC.removeCustom(s.id);
          await reload();
          toast("Removed", s.name);
        });
        li.appendChild(rm);
      }
      const sw = el("span", "switch");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = isOn(s);
      cb.setAttribute("aria-label", "Search " + s.name);
      cb.addEventListener("change", () => { prefs.off[s.id] = !cb.checked; savePrefs(); renderChips(); });
      sw.appendChild(cb);
      li.appendChild(sw);
      ul.appendChild(li);
    }
  }
  async function reload() { sources = await allSources(); renderChips(); renderList(); }

  // ---------- Add a source ----------
  const TYPE_LABEL = { opensearch: "Site search", template: "Your search link", feed: "Feed", opds: "Book catalog", crawl: "Whole site", list: "Saved list" };
  let proposal = null;
  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = $("addUrl").value.trim();
    if (!url || !SRC) return;
    const box = $("proposal");
    box.hidden = false;
    box.textContent = "Looking at " + hostOf(url) + "...";
    $("addGo").disabled = true;
    try {
      proposal = await SRC.detect(url);
      renderProposal();
    } catch (err) {
      box.textContent = "Polycarp could not open that link. Check the address and try again.";
    } finally { $("addGo").disabled = false; }
  });
  function renderProposal() {
    const box = $("proposal");
    box.textContent = "";
    const name = el("input", "pname");
    name.value = proposal.name || hostOf(proposal.url);
    name.setAttribute("aria-label", "Name for this source");
    const kind = el("span", "tag", TYPE_LABEL[proposal.type] || "Source");
    const note = proposal.note ? el("p", "pnote", proposal.note + (proposal.estimate ? " About " + proposal.estimate.toLocaleString() + " pages." : "")) : null;
    const acts = el("div", "acts");
    const ok = el("button", "btn primary", "Make it searchable");
    ok.type = "button";
    const no = el("button", "btn quiet", "Cancel");
    no.type = "button";
    acts.append(ok, no);
    const top = el("div", "ptop");
    top.append(name, kind);
    box.append(top);
    if (note) box.appendChild(note);
    box.appendChild(acts);
    no.addEventListener("click", () => { box.hidden = true; proposal = null; });
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      const def = await SRC.addCustom(Object.assign({}, proposal, { name: name.value.trim() || proposal.name }));
      box.hidden = true;
      $("addUrl").value = "";
      await reload();
      if (/feed|opds|crawl|list/.test(def.type)) await refresh(def);
      else toast("Added " + def.name, "It is searched along with everything else.");
    });
  }
  async function refresh(def, btn) {
    if (btn) btn.disabled = true;
    notice("Indexing " + def.name + "...");
    try {
      await SRC.refresh(def.id, (done, total) => notice("Indexing " + def.name + ": " + done.toLocaleString() + (total ? " of about " + total.toLocaleString() : "") + " done."));
      notice("");
      toast(def.name + " is searchable", "Try a search above.");
    } catch (e) {
      notice("Polycarp could not finish indexing " + def.name + ". " + friendly(e), "bad");
    }
    if (btn) btn.disabled = false;
    await renderList();
  }
  $("libTip").textContent = "Audible, Kindle or another library you sign in to: open its library page and choose Make this library searchable. Polycarp reads the list in your own tab; your sign-in never leaves the site.";

  // A library captured from a signed-in page arrives through session storage.
  const params = new URLSearchParams(location.search);
  async function takeImport(key) {
    const got = (await chrome.storage.session.get(key))[key];
    if (!got || !SRC) return;
    notice("Adding " + got.def.name + ": " + got.items.length.toLocaleString() + " titles...");
    try {
      await SRC.importItems(got.def, got.items);
      await chrome.storage.session.remove(key);
      await reload();
      notice(got.def.name + " is searchable: " + got.items.length.toLocaleString() + (got.items.length === 1 ? " title" : " titles") + ". Search for a title, author or narrator.", "good");
    } catch (e) { notice("Polycarp could not save that library. " + friendly(e), "bad"); }
  }

  // ---------- NAS ----------
  function renderNas() {
    const body = $("nasBody");
    body.textContent = "";
    if (!NAS) { body.appendChild(el("p", "note", "The NAS connection is not available in this build.")); return; }
    if (!nasCfg || !nasCfg.url) {
      const b = el("button", "btn", "Connect your NAS");
      b.type = "button";
      b.addEventListener("click", openNasDialog);
      body.appendChild(b);
      return;
    }
    const st = el("div", "nasst");
    const ic = el("span", "sic");
    ic.innerHTML = I("server");
    const t = el("div", "st");
    t.appendChild(el("b", null, hostOf(nasCfg.url) + (nasCfg.folder && nasCfg.folder !== "/" ? " · " + nasCfg.folder : "")));
    t.appendChild(el("span", null, nasCfg.lastIndexed ? "Files indexed " + new Date(nasCfg.lastIndexed).toLocaleDateString() : "Not indexed yet"));
    st.append(ic, t);
    body.appendChild(st);
    const acts = el("div", "acts");
    const mk = (label, fn, cls) => { const b = el("button", "btn" + (cls ? " " + cls : ""), label); b.type = "button"; b.addEventListener("click", () => fn(b)); acts.appendChild(b); return b; };
    mk("Browse", () => browse(nasCfg.folder || "/"));
    const idx = mk("Index files", async (b) => {
      b.disabled = true;
      try {
        const n = await NAS.index({ onProgress: (p) => notice("Looking through your NAS: " + p.files.toLocaleString() + " files in " + p.folders.toLocaleString() + " folders so far...") });
        notice(n.truncated ? "Polycarp stopped at " + n.files.toLocaleString() + " files. Point Polycarp at a smaller folder to index the rest." : "");
        toast("Your NAS is searchable", n.files.toLocaleString() + " files. Search for any title above.");
        nasCfg = await NAS.getConfig();
        renderNas();
      } catch (e) { notice("Polycarp could not index your NAS. " + friendly(e), "bad"); b.disabled = false; }
    });
    if (!nasCfg.lastIndexed) idx.classList.add("primary");
    mk("Back up now", async (b) => {
      b.disabled = true;
      try { const r = await NAS.backupNow(); toast("Backed up to your NAS", r && r.path ? r.path : ""); }
      catch (e) { toast("Backup failed", friendly(e)); }
      b.disabled = false;
    });
    mk("Disconnect", async () => {
      if (!confirm("Disconnect your NAS? Polycarp forgets the address and password. Files on the NAS stay as they are.")) return;
      await NAS.forget();
      nasCfg = null;
      await reload();
      renderNas();
    }, "quiet");
    body.appendChild(acts);
    const auto = el("label", "row autob");
    const lbl = el("span", "lbl");
    lbl.appendChild(el("b", null, "Daily backup"));
    lbl.appendChild(el("span", null, "Settings, memory cards, library and notes, saved to Polycarp/Backups. Polycarp keeps the last 14."));
    const sw = el("span", "switch");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!(nasCfg.autoBackup);
    cb.addEventListener("change", async () => { await NAS.setAutoBackup(cb.checked); nasCfg = await NAS.getConfig(); chrome.runtime.sendMessage({ type: "polycarp:nasAlarm" }); });
    sw.appendChild(cb);
    auto.append(lbl, sw);
    body.appendChild(auto);
  }
  function openNasDialog() {
    $("nasUrl").value = (nasCfg && nasCfg.url) || "";
    $("nasUser").value = (nasCfg && nasCfg.user) || "";
    $("nasPass").value = "";
    $("nasFolder").value = (nasCfg && nasCfg.folder) || "";
    $("nasRemember").checked = !!(nasCfg && nasCfg.remember);
    $("nasErr").hidden = true;
    $("nasDlg").showModal();
    $("nasUrl").focus();
  }
  $("nasForm").addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    const save = $("nasSave");
    save.disabled = true;
    save.textContent = "Testing...";
    try {
      await NAS.setConfig({ url: $("nasUrl").value.trim(), user: $("nasUser").value.trim(), password: $("nasPass").value, folder: $("nasFolder").value.trim() || "/", remember: $("nasRemember").checked });
      const r = await NAS.test();
      if (!r.ok) throw new Error(r.error);
      nasCfg = await NAS.getConfig();
      $("nasDlg").close();
      await reload();
      renderNas();
      toast("Connected to your NAS", "Choose Index files to make it searchable.");
    } catch (err) {
      $("nasErr").textContent = friendly(err);
      $("nasErr").hidden = false;
    } finally { save.disabled = false; save.textContent = "Test and connect"; }
  });

  async function browse(path) {
    const dlg = $("browseDlg");
    if (!dlg.open) dlg.showModal();
    const crumbs = $("crumbs");
    crumbs.textContent = "";
    const parts = path.split("/").filter(Boolean);
    const home = el("button", "crumb", "Home");
    home.type = "button";
    home.addEventListener("click", () => browse("/"));
    crumbs.appendChild(home);
    parts.forEach((p, i) => {
      crumbs.appendChild(el("span", "sep", "/"));
      const b = el("button", "crumb", p);
      b.type = "button";
      b.addEventListener("click", () => browse("/" + parts.slice(0, i + 1).join("/") + "/"));
      crumbs.appendChild(b);
    });
    const ul = $("files");
    ul.textContent = "";
    ul.appendChild(el("li", "rnone", "Loading..."));
    let list;
    try { list = await NAS.list(path); } catch (e) { ul.textContent = ""; ul.appendChild(el("li", "rerr", friendly(e))); return; }
    ul.textContent = "";
    if (!list.length) ul.appendChild(el("li", "rnone", "This folder is empty."));
    for (const f of list) {
      const li = el("li");
      const b = el("button", "file");
      b.type = "button";
      b.innerHTML = I(f.dir ? "folder" : /\.(epub|mobi|azw3|fb2)$/i.test(f.name) ? "book" : /\.(mp3|m4b|m4a)$/i.test(f.name) ? "headphones" : "file");
      b.appendChild(el("span", "fn", f.name));
      if (!f.dir && f.size) b.appendChild(el("small", null, size(f.size)));
      b.addEventListener("click", () => {
        if (f.dir) browse(f.path.endsWith("/") ? f.path : f.path + "/");
        else if (/\.(epub|pdf|docx|txt|md|html?|fb2|mobi|azw3|rtf)$/i.test(f.name)) openReader({ nas: f.path });
        else toast("Polycarp can't open this kind of file", "It reads books, PDFs and documents.");
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
  }
  function size(n) { return n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB"; }
  $("browseClose").addEventListener("click", () => $("browseDlg").close());

  // ---------- Start ----------
  $("form").addEventListener("submit", (e) => { e.preventDefault(); run($("q").value.trim()); });
  renderChips();
  renderList();
  renderNas();
  if (!SRC) notice("Search sources are not available in this build.", "bad");
  if (params.get("import")) await takeImport(params.get("import"));
  const q = params.get("q") || "";
  $("q").value = q;
  if (q) run(q); else { showHome(); $("q").focus(); }
})();
