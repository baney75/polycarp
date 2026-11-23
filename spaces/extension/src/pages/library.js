/* Polycarp Library: every document, link, audiobook and note in one place, linked to each other.
   Connections come from library.js: [[wiki links]] and backlinks in notes, shared key terms
   (TF-IDF), shared names, and the same site. Ideas you are remembering come from memory.js.
   Sync writes Markdown into an Obsidian vault folder, or pages into a Notion database. */
(async function () {
  "use strict";
  const P = globalThis.Polycarp;
  const L = globalThis.PolycarpLibrary;
  const D = globalThis.PolycarpDocs;
  const M = globalThis.PolycarpMemory;
  const N = globalThis.PolycarpNotesUI;
  const O = globalThis.PolycarpObsidian;
  const NO = globalThis.PolycarpNotion;
  const IC = globalThis.PolycarpIcons;
  const I = IC.icon;
  const $ = (id) => document.getElementById(id);
  const esc = N.esc;
  const NOTION_KEY = "polycarp.notion";
  const POS_KEY = "polycarp.audiopos";

  $("navRead").innerHTML = I("book") + "<span>Reader</span>";

  $("navSearch").innerHTML = I("search") + "<span>Search</span>";
  $("navLib").innerHTML = I("library") + "<span>Library</span>";
  $("navReview").innerHTML = I("layers") + "<span>Review</span>";
  $("navSettings").innerHTML = I("sliders") + "<span>Settings</span>";
  $("openAdd").innerHTML = I("plus") + "<span>Add</span>";
  $("emptyAdd").innerHTML = I("plus") + "<span>Add your first item</span>";
  $("openSync").innerHTML = I("sync") + "<span>Obsidian and Notion</span>";
  $("vList").innerHTML = I("list") + "<span>List</span>";
  $("vMap").innerHTML = I("graph") + "<span>Map</span>";
  $("searchIcon").innerHTML = I("search");
  $("emptyPip").innerHTML = IC.mascot("happy");
  $("dropIcon").innerHTML = I("upload");
  document.querySelectorAll("[data-close]").forEach((b) => { if (b.classList.contains("icon")) b.innerHTML = I("x"); });

  const KIND = {
    doc: { label: "Document", plural: "Documents" },
    link: { label: "Link", plural: "Links" },
    audio: { label: "Audio", plural: "Audio" },
    note: { label: "Note", plural: "Notes" }
  };
  const SOURCE = { pdf: "PDF", epub: "EPUB", docx: "Word", txt: "Text", md: "Markdown", html: "Web page", web: "Web page", fb2: "FB2", audio: "Audio" };
  function kindIcon(it) {
    if (it.kind === "link") return "link";
    if (it.kind === "audio") return "headphones";
    if (it.kind === "note") return "pen";
    return it.source === "epub" || it.source === "fb2" ? "book" : "file";
  }
  function kindLabel(it) {
    if (it.kind === "doc") return SOURCE[it.source] || "Document";
    return KIND[it.kind].label;
  }
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  function length(it) {
    if (it.kind === "audio") return it.duration ? N.clock(it.duration) : "";
    if (!it.words) return "";
    const min = Math.max(1, Math.round(it.words / 230));
    return min >= 60 ? Math.round(min / 6) / 10 + " hr read" : min + " min read";
  }

  // ---------- State ----------
  let items = [];
  let notes = [];
  let cards = [];
  let notesBy = new Map();
  let byId = new Map();
  let kind = "all";
  let query = "";
  let view = "list";
  let sel = null;
  let results = null;

  function toast(title, body) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = "<b>" + esc(title) + "</b>" + (body ? esc(body) : "");
    $("toasts").append(t);
    setTimeout(() => t.remove(), 3600);
  }

  async function load() {
    [items, notes, cards] = await Promise.all([L.allItems(), L.allNotes(), M ? M.load().catch(() => []) : []]);
    byId = new Map(items.map((i) => [i.id, i]));
    notesBy = new Map();
    for (const n of notes) {
      if (!notesBy.has(n.itemId)) notesBy.set(n.itemId, []);
      notesBy.get(n.itemId).push(n);
    }
  }

  // ---------- Summary, filters and list ----------
  function renderHead() {
    const empty = !items.length;
    $("empty").hidden = !empty;
    $("panes").hidden = empty;
    $("tools").hidden = empty;
    $("openSync").hidden = empty;
    $("openAdd").hidden = empty;
    if (empty) { $("sum").textContent = "Documents, links, audiobooks and notes, connected."; return; }
    const noteCount = notes.filter((n) => (n.text || "").trim() || n.quote).length;
    $("sum").textContent = plural(items.length, "item") + (noteCount ? " with " + plural(noteCount, "note") + " written on them" : "") + ", connected by shared ideas.";
    const counts = { all: items.length, doc: 0, link: 0, audio: 0, note: 0 };
    for (const it of items) counts[it.kind]++;
    const order = ["all", "doc", "link", "audio", "note"].filter((k) => k === "all" || counts[k]);
    if (!order.includes(kind)) kind = "all";
    $("kinds").innerHTML = order.map((k) => '<button class="chip" data-k="' + k + '" aria-pressed="' + (k === kind) + '">' + (k === "all" ? "All" : KIND[k].plural) + '<span class="n">' + counts[k] + "</span></button>").join("");
  }

  function hiTitle(t) {
    const e = esc(t);
    if (!query) return e;
    const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return e.replace(new RegExp("(" + q + ")", "ig"), "<mark>$1</mark>");
  }
  function rowMeta(it) {
    const parts = [kindLabel(it)];
    if (it.author) parts.push(it.author);
    else if (it.domain && it.kind !== "doc") parts.push(it.domain);
    const len = length(it);
    if (len) parts.push(len);
    const nc = (notesBy.get(it.id) || []).length;
    if (nc) parts.push(plural(nc, "note"));
    return parts.join(" · ");
  }
  function visible() {
    let list = results ? results.items : items.slice().sort((a, b) => b.updated - a.updated);
    if (kind !== "all") list = list.filter((i) => i.kind === kind);
    return list;
  }
  function renderList() {
    const list = visible();
    const ul = $("items");
    ul.innerHTML = list.length
      ? list.map((it) => '<li><button data-id="' + esc(it.id) + '" aria-current="' + (it.id === sel) + '"><span class="kind-i ' + it.kind + '">' + I(kindIcon(it)) + "</span><span><b>" + hiTitle(it.title) + "</b><small>" + esc(rowMeta(it)) + "</small></span></button></li>").join("")
      : '<li class="none">' + (query ? "Nothing matches “" + esc(query) + "”." : "Nothing here yet.") + "</li>";
    const hits = results ? results.notes.filter((n) => byId.has(n.itemId)).slice(0, 12) : [];
    $("noteHits").hidden = !hits.length || view !== "list";
    $("noteHitList").innerHTML = hits.map((n) => {
      const it = byId.get(n.itemId);
      const text = (n.text || n.quote || "").replace(/\s+/g, " ").slice(0, 160);
      return '<li><button data-id="' + esc(it.id) + '">' + esc(text) + "<span>" + esc(it.title) + "</span></button></li>";
    }).join("");
  }

  // ---------- Detail ----------
  function readUrl(it, block) {
    const base = "../reader/reader.html?";
    if (it.docKey) return base + "lib=" + encodeURIComponent(it.docKey) + (block != null ? "&b=" + block : "");
    if (it.url) return base + "src=" + encodeURIComponent(it.url);
    return "";
  }
  function noteList(it) {
    const list = notesBy.get(it.id) || [];
    if (!list.length) return "";
    return '<ul class="d-notes">' + list.map((n) => {
      const label = N.anchorLabel(n.anchor);
      return '<li data-note="' + esc(n.id) + '">' +
        (n.quote ? "<blockquote>" + esc(n.quote) + "</blockquote>" : "") +
        (n.text ? '<div class="nt">' + N.render(n.text, resolve) + "</div>" : "") +
        '<div class="meta">' + (label ? "<button data-go>" + esc(label) + "</button>" : "") + '<span class="grow"></span><button data-edit>' + (n.text ? "Edit" : "Add note") + "</button><button data-del>Delete</button></div></li>";
    }).join("") + "</ul>";
  }
  let resolve = () => null;

  async function renderDetail() {
    const box = $("detail");
    const it = sel && byId.get(sel);
    document.body.classList.toggle("has-item", !!it);
    if (!it) { box.innerHTML = ""; return; }
    resolve = N.resolver(items);
    const rel = await L.related(it.id, { limit: 8 }).catch(() => []);
    if (sel !== it.id) return;
    const ideas = L.ideasFor(it, cards);
    const meta = [it.author, it.kind !== "doc" || !it.author ? it.domain : "", length(it), "Added " + fmtDate(it.created)].filter(Boolean);
    const read = readUrl(it);
    const acts = [];
    if (read) acts.push('<a class="btn primary" href="' + esc(read) + '">' + I("book") + "<span>Read</span></a>");
    if (it.kind === "note") acts.push('<button class="btn" data-act="edit">' + I("pen") + "<span>Edit</span></button>");
    if (it.url && /^https?:/i.test(it.url)) acts.push('<a class="btn quiet" href="' + esc(it.url) + '" target="_blank" rel="noopener">' + I("external") + "<span>Original</span></a>");
    acts.push('<button class="btn quiet danger-quiet" data-act="delete">' + I("trash") + "<span>Delete</span></button>");

    let html = '<button class="btn quiet back" data-act="back">' + I("back") + "<span>Library</span></button>" +
      '<div class="d-kind">' + I(kindIcon(it)) + esc(kindLabel(it)) + "</div>" +
      "<h2>" + esc(it.title) + "</h2>" +
      '<p class="d-meta">' + esc(meta.join(" · ")) + "</p>" +
      '<div class="acts">' + acts.join("") + "</div>";

    if (it.kind === "audio") {
      html += '<div class="player"><audio id="aud" controls preload="metadata"></audio><div class="ctl">' +
        '<button class="btn quiet icon" data-act="b15" aria-label="Back 15 seconds" title="Back 15 seconds">' + I("skipB") + "</button>" +
        '<button class="btn quiet icon" data-act="f30" aria-label="Forward 30 seconds" title="Forward 30 seconds">' + I("skipF") + "</button>" +
        '<div class="seg" role="group" aria-label="Speed" id="speeds">' + [1, 1.25, 1.5, 2].map((r) => '<button data-rate="' + r + '" aria-pressed="false">' + r + "×</button>").join("") + "</div>" +
        '<span class="grow"></span><button class="btn" data-act="mark">' + I("pen") + '<span id="markLbl">Note at this time</span></button></div></div>';
    }
    if (it.kind === "note") {
      html += '<div class="note-body nt" id="noteBodyView">' + (N.render(it.text, resolve) || '<p class="muted">Empty note.</p>') + "</div>";
    } else if (it.excerpt) {
      html += '<blockquote class="excerpt">' + esc(it.excerpt) + "</blockquote>";
    }

    if (it.kind !== "note") {
      const nc = (notesBy.get(it.id) || []).length;
      html += '<section class="d-sec"><h3>Your notes' + (nc ? " <small>" + nc + "</small>" : "") + "</h3>" +
        '<form class="note-form" id="dNoteForm"><textarea class="field" id="dNote" rows="3" aria-label="New note" placeholder="' +
        (it.kind === "audio" ? "A thought at this moment. Type [[ to link." : "What stood out, in your own words. Type [[ to link.") +
        '"></textarea><div class="row2"><span>' + (it.kind === "audio" ? "Saved with the current time" : "Ctrl or ⌘ + Enter to save") + '</span><button class="btn" type="submit">Save note</button></div></form>' +
        noteList(it) + "</section>";
    }

    const connLi = (r) => '<li><button data-id="' + esc(r.item.id) + '"><span class="kind-i ' + r.item.kind + '">' + I(kindIcon(r.item)) + "</span><span><b>" + esc(r.item.title) + "</b><span>" + esc(r.why) + "</span></span></button></li>";
    const SHOW = 4;
    html += '<section class="d-sec"><h3>Connected' + (rel.length ? " <small>" + rel.length + "</small>" : "") + "</h3>";
    html += rel.length
      ? '<ul class="conn">' + rel.slice(0, SHOW).map(connLi).join("") + "</ul>" +
        (rel.length > SHOW ? '<details class="conn-more"><summary>Show ' + (rel.length - SHOW) + " more</summary><ul class=\"conn\">" + rel.slice(SHOW).map(connLi).join("") + "</ul></details>" : "")
      : '<p class="muted">Nothing connected yet. Items link up when they share key ideas, the same people or the same site, or when a note names one with <code>[[' + esc(it.title.slice(0, 40)) + "]]</code>.</p>";
    html += "</section>";

    if (ideas.length) {
      html += '<section class="d-sec"><h3>Ideas you are remembering <small>' + ideas.length + '</small></h3><ul class="ideas">' +
        ideas.slice(0, 8).map((c) => "<li>" + IC.plant(c.tier) + "<span>" + esc(O.ideaLine(c)) + "</span></li>").join("") +
        '</ul><p class="muted" style="margin-top:12px"><a href="review.html">Review them</a> to keep them growing.</p></section>';
    }
    // A re-render (the audio length arriving, a sync) keeps a note being typed for the same item.
    const draftEl = box.dataset.item === it.id ? $("dNote") : null;
    const draft = draftEl ? draftEl.value : "";
    const typing = draftEl && document.activeElement === draftEl;
    box.innerHTML = html;
    box.dataset.item = it.id;
    const form = $("dNoteForm");
    if (form && draft) { $("dNote").value = draft; if (typing) $("dNote").focus(); }
    if (form) {
      N.autocomplete($("dNote"), () => items);
      $("dNote").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } });
      form.addEventListener("submit", (e) => { e.preventDefault(); addNote(it); });
    }
    if (it.kind === "audio") setupAudio(it);
  }

  async function refreshDetail() {
    const keep = $("detail").scrollTop;
    await load();
    renderHead();
    renderList();
    await renderDetail();
    $("detail").scrollTop = keep;
  }

  async function addNote(it) {
    const ta = $("dNote");
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const anchor = {};
    const aud = $("aud");
    if (aud && it.kind === "audio") anchor.time = Math.round(aud.currentTime);
    await L.addNote({ itemId: it.id, text, anchor });
    ta.value = "";
    await refreshDetail();
  }

  // ---------- Audio ----------
  let audioUrl = "";
  async function setupAudio(it) {
    const aud = $("aud");
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const blob = await L.getBlob(it.blobId);
    if (!blob) { aud.replaceWith(Object.assign(document.createElement("p"), { className: "muted", textContent: "The audio file is missing. Add it again." })); return; }
    audioUrl = URL.createObjectURL(blob);
    aud.src = audioUrl;
    const st = await chrome.storage.local.get([POS_KEY, "polycarp.audiorate"]);
    const pos = (st[POS_KEY] || {})[it.id] || 0;
    const rate = st["polycarp.audiorate"] || 1;
    aud.addEventListener("loadedmetadata", () => { if (pos && pos < aud.duration - 5) aud.currentTime = pos; }, { once: true });
    aud.playbackRate = rate;
    paintRate(rate);
    let last = 0;
    const save = async () => {
      const s = (await chrome.storage.local.get(POS_KEY))[POS_KEY] || {};
      s[it.id] = Math.floor(aud.currentTime);
      await chrome.storage.local.set({ [POS_KEY]: s });
    };
    aud.addEventListener("timeupdate", () => {
      $("markLbl").textContent = "Note at " + N.clock(aud.currentTime);
      if (Math.abs(aud.currentTime - last) > 10) { last = aud.currentTime; save(); }
    });
    aud.addEventListener("pause", save);
    $("speeds").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rate]");
      if (!b) return;
      aud.playbackRate = Number(b.dataset.rate);
      paintRate(aud.playbackRate);
      chrome.storage.local.set({ "polycarp.audiorate": aud.playbackRate });
    });
  }
  function paintRate(r) {
    document.querySelectorAll("#speeds button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === r)));
  }

  // ---------- Detail actions ----------
  let delArmed = 0;
  $("detail").addEventListener("click", async (e) => {
    const it = sel && byId.get(sel);
    if (!it) return;
    const wl = e.target.closest("a.wl[data-item]");
    if (wl) { e.preventDefault(); select(wl.dataset.item); return; }
    const jump = e.target.closest("button[data-id]");
    if (jump) { select(jump.dataset.id); return; }
    const act = e.target.closest("[data-act]");
    const aud = $("aud");
    if (act) {
      const a = act.dataset.act;
      if (a === "back") select(null);
      else if (a === "b15" && aud) aud.currentTime = Math.max(0, aud.currentTime - 15);
      else if (a === "f30" && aud) aud.currentTime = Math.min(aud.duration || 1e9, aud.currentTime + 30);
      else if (a === "mark") { $("dNote").focus(); if (aud) aud.pause(); }
      else if (a === "edit") editNoteItem(it);
      else if (a === "delete") {
        if (Date.now() - delArmed > 4000) {
          delArmed = Date.now();
          act.classList.add("confirm");
          act.querySelector("span").textContent = "Delete for good?";
          setTimeout(() => { if (act.isConnected) { act.classList.remove("confirm"); act.querySelector("span").textContent = "Delete"; } }, 4000);
          return;
        }
        delArmed = 0;
        await L.removeItem(it.id);
        if (it.docKey) await D.del(it.docKey).catch(() => {});
        if (it.kind === "audio") {
          const s = (await chrome.storage.local.get(POS_KEY))[POS_KEY] || {};
          delete s[it.id];
          await chrome.storage.local.set({ [POS_KEY]: s });
        }
        toast("Deleted", it.title);
        select(null);
        await refreshDetail();
      }
      return;
    }
    const li = e.target.closest("li[data-note]");
    if (!li) return;
    const n = (notesBy.get(it.id) || []).find((x) => x.id === li.dataset.note);
    if (!n) return;
    if (e.target.closest("[data-go]")) {
      if (n.anchor && n.anchor.time != null && aud) { aud.currentTime = n.anchor.time; aud.play().catch(() => {}); }
      else if (readUrl(it)) location.href = readUrl(it, n.anchor && n.anchor.block);
    } else if (e.target.closest("[data-del]")) { await L.removeNote(n.id); await refreshDetail(); }
    else if (e.target.closest("[data-edit]")) editNote(li, n);
  });

  function editNote(li, n) {
    const form = document.createElement("form");
    form.className = "note-form";
    form.innerHTML = '<textarea class="field" rows="3" aria-label="Note"></textarea><div class="row2"><span></span><span><button class="btn quiet" type="button" data-cancel>Cancel</button> <button class="btn" type="submit">Save</button></span></div>';
    const ta = form.querySelector("textarea");
    ta.value = n.text || "";
    const old = li.querySelector(".nt");
    if (old) old.replaceWith(form); else li.insertBefore(form, li.querySelector(".meta"));
    li.querySelector(".meta").hidden = true;
    N.autocomplete(ta, () => items);
    ta.focus();
    form.querySelector("[data-cancel]").addEventListener("click", refreshDetail);
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await L.updateNote(n.id, { text: ta.value.trim() });
      await refreshDetail();
    });
  }

  function editNoteItem(it) {
    const view = $("noteBodyView");
    if (!view) return;
    const form = document.createElement("form");
    form.className = "note-edit";
    form.innerHTML = '<label class="fld"><b>Title</b><input class="field" autocomplete="off"></label><label class="fld"><b>Note</b><textarea class="field"></textarea></label><div class="acts"><button class="btn primary" type="submit">Save</button><button class="btn quiet" type="button" data-cancel>Cancel</button></div>';
    const [ti, ta] = [form.querySelector("input"), form.querySelector("textarea")];
    ti.value = it.title;
    ta.value = it.text;
    view.replaceWith(form);
    N.autocomplete(ta, () => items.filter((x) => x.id !== it.id));
    ta.focus();
    form.querySelector("[data-cancel]").addEventListener("click", refreshDetail);
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await L.updateItem(it.id, { title: ti.value.trim() || it.title, text: ta.value });
      await refreshDetail();
    });
  }

  // ---------- Selection and routing ----------
  function select(id) {
    sel = id && byId.has(id) ? id : null;
    history.replaceState(null, "", sel ? "#item=" + encodeURIComponent(sel) : location.pathname);
    $("items").querySelectorAll("button[data-id]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === sel)));
    renderDetail().then(() => {
      if (sel && matchMedia("(max-width: 860px)").matches) { scrollTo(0, 0); $("detail").focus({ preventScroll: true }); }
      else {
        $("detail").scrollTop = 0;
        const row = $("items").querySelector('button[aria-current="true"]');
        const pane = $("listPane");
        if (row && pane.scrollHeight > pane.clientHeight) {
          // Positions inside the pane's scrolled content, measured from its top edge.
          const top = pane.getBoundingClientRect().top + pane.clientTop;
          const at = (el) => el.getBoundingClientRect().top - top + pane.scrollTop;
          const seen = Math.min(pane.clientHeight, innerHeight - top);
          const y = at(row) - pane.scrollTop;
          if (y < 0 || y + row.offsetHeight > seen) {
            // Center the row when we can, keep it fully in view, and start the list on a whole row.
            const pad = parseFloat(getComputedStyle(pane).paddingTop);
            const need = at(row) + row.offsetHeight - seen;
            const max = pane.scrollHeight - pane.clientHeight;
            const want = at(row) - seen / 2;
            const edges = [...pane.querySelectorAll("#items > li")].map((li) => at(li) - pad).filter((e) => e >= need && e <= Math.min(max, at(row) - pad));
            pane.scrollTop = edges.length ? edges.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)) : Math.max(0, need);
          }
        }
      }
    });
    if (view === "map") paintMapFocus();
  }
  $("items").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (b) select(b.dataset.id); });
  $("noteHitList").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (b) select(b.dataset.id); });
  $("kinds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    kind = b.dataset.k;
    $("kinds").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.k === kind)));
    renderList();
    if (view === "map") drawMap();
  });
  let qt = 0;
  $("q").addEventListener("input", () => {
    clearTimeout(qt);
    qt = setTimeout(async () => {
      query = $("q").value.trim();
      results = query ? await L.search(query) : null;
      if (query && view === "map") setView("list");
      renderList();
    }, 120);
  });

  function setView(v) {
    view = v;
    $("vList").setAttribute("aria-pressed", String(v === "list"));
    $("vMap").setAttribute("aria-pressed", String(v === "map"));
    $("items").hidden = v !== "list";
    $("map").hidden = v !== "map";
    $("panes").classList.toggle("map-mode", v === "map");
    renderList();
    if (v === "map") drawMap();
    try { localStorage.setItem("polycarp.libview", v); } catch (e) { /* private window */ }
  }
  $("vList").addEventListener("click", () => setView("list"));
  $("vMap").addEventListener("click", () => setView("map"));

  // ---------- Map: a small force layout, computed once per draw ----------
  let mapData = null;
  async function drawMap() {
    const svg = $("mapSvg");
    const g = await L.graph({ minScore: 0.12 });
    const keep = new Set(visible().map((i) => i.id));
    const nodes = g.nodes.filter((n) => keep.has(n.id));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = g.edges.filter((e) => ids.has(e.a) && ids.has(e.b));
    // One unit is one pixel, so labels stay at their real size. Items with no connection yet sit
    // in a row along the bottom instead of drifting to the corners.
    const W = Math.max(320, Math.round(svg.clientWidth || 900)), H = Math.max(320, Math.round(svg.clientHeight || 600));
    const deg = new Map(nodes.map((n) => [n.id, 0]));
    edges.forEach((e) => { deg.set(e.a, deg.get(e.a) + 1); deg.set(e.b, deg.get(e.b) + 1); });
    const linked = nodes.filter((n) => deg.get(n.id) > 0);
    const alone = nodes.filter((n) => deg.get(n.id) === 0);
    const cols = Math.max(1, Math.floor((W - 48) / 150));
    const rows = Math.ceil(alone.length / cols);
    const rowH = 30;
    const bottom = alone.length ? rows * rowH + 40 : 0;
    const pos = layout(linked, edges, W, Math.max(160, H - bottom));
    alone.forEach((n, i) => pos.set(n.id, { x: 32 + (i % cols) * 150, y: H - bottom + 34 + Math.floor(i / cols) * rowH }));
    const short = (t, max) => (t.length > max ? t.slice(0, max - 2).trim() + "\u2026" : t);
    const rad = (n) => 5 + Math.min(deg.get(n.id), 6) * 1.2;
    const label = (n) => short(n.title, deg.get(n.id) ? 30 : 18);
    let out = alone.length && linked.length ? '<text class="sep" x="24" y="' + (H - bottom + 12) + '">Not connected yet</text>' : "";
    for (const e of edges) {
      const a = pos.get(e.a), b = pos.get(e.b);
      out += '<line class="e ' + e.kind + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke-width="' + (1 + e.score * 2.5).toFixed(2) + '"/>';
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      const r = rad(n);
      const shape = n.kind === "audio"
        ? '<rect x="' + (-r).toFixed(1) + '" y="' + (-r).toFixed(1) + '" width="' + (2 * r).toFixed(1) + '" height="' + (2 * r).toFixed(1) + '" rx="3"/>'
        : '<circle r="' + r.toFixed(1) + '"/>';
      out += '<g class="n ' + n.kind + '" data-id="' + esc(n.id) + '" transform="translate(' + p.x.toFixed(1) + " " + p.y.toFixed(1) + ')" tabindex="0" role="button" aria-label="' + esc(n.title) + '"><title>' + esc(n.title) + "</title>" + shape +
        '<text x="' + (r + 4).toFixed(1) + '" y="4" visibility="hidden">' + esc(label(n)) + "</text></g>";
    }
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.innerHTML = out;
    mapData = { W, H, edges, nodes, pos, rad, label, deg, box: { x: 0, y: 0, w: W, h: H } };
    const kinds = new Set(nodes.map((n) => n.kind));
    $("mapKey").innerHTML = ["doc", "link", "audio", "note"].filter((k) => kinds.has(k)).map((k) => '<span><i class="' + k + '"></i>' + KIND[k].plural + "</span>").join("") +
      "<span>" + plural(edges.length, "connection") + "</span>" + (nodes.length ? "" : "<span>Nothing to map yet.</span>");
    paintMapFocus();
  }
  // Labels: the best-connected nodes pick a spot first. Each label tries the right side, then the
  // left, below, above and the four corners, and stays hidden (shown on hover) when every spot hits another label,
  // a node or the edge of the map.
  let measureCtx = null;
  function textWidth(t) {
    if (!measureCtx) {
      measureCtx = document.createElement("canvas").getContext("2d");
      measureCtx.font = "700 11px " + getComputedStyle(document.body).fontFamily;
    }
    return measureCtx.measureText(t).width;
  }
  function placeLabels(nodes, pos, rad, label, W, H, rank) {
    const out = new Map();
    const hit = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    const dots = nodes.map((n) => { const p = pos.get(n.id), r = rad(n) + 2; return { id: n.id, x1: p.x - r, x2: p.x + r, y1: p.y - r, y2: p.y + r }; });
    const boxes = [];
    const order = nodes.slice().sort((a, b) => (rank(b) - rank(a)) || (rad(b) - rad(a)));
    for (const n of order) {
      const p = pos.get(n.id), r = rad(n), t = label(n), w = textWidth(t) + 4, h = 14;
      const spots = [
        { x: r + 4, y: 4, anchor: "start", bx: p.x + r + 2, by: p.y - 9 },
        { x: -r - 4, y: 4, anchor: "end", bx: p.x - r - 2 - w, by: p.y - 9 },
        { x: 0, y: r + 14, anchor: "middle", bx: p.x - w / 2, by: p.y + r + 2 },
        { x: 0, y: -r - 6, anchor: "middle", bx: p.x - w / 2, by: p.y - r - 18 },
        { x: r + 4, y: 14, anchor: "start", bx: p.x + r + 2, by: p.y + 1 },
        { x: r + 4, y: -6, anchor: "start", bx: p.x + r + 2, by: p.y - 19 },
        { x: -r - 4, y: 14, anchor: "end", bx: p.x - r - 2 - w, by: p.y + 1 },
        { x: -r - 4, y: -6, anchor: "end", bx: p.x - r - 2 - w, by: p.y - 19 }
      ];
      let chosen = null;
      for (const sp of spots) {
        const b = { x1: sp.bx, x2: sp.bx + w, y1: sp.by, y2: sp.by + h };
        if (b.x1 < 2 || b.x2 > W - 2 || b.y1 < 2 || b.y2 > H - 2) continue;
        if (boxes.some((o) => hit(o, b)) || dots.some((d) => d.id !== n.id && hit(d, b))) continue;
        chosen = { sp, b };
        break;
      }
      const shown = !!chosen && (rank(n) > 0 || boxes.length < 14);
      if (shown) boxes.push(chosen.b);
      const sp = (chosen || { sp: spots[0] }).sp;
      out.set(n.id, { x: sp.x, y: sp.y, anchor: sp.anchor, text: t, shown });
    }
    return out;
  }
  function layout(nodes, edges, W, H) {
    const n = nodes.length;
    const idx = new Map(nodes.map((d, i) => [d.id, i]));
    const x = new Float64Array(n), y = new Float64Array(n);
    for (let i = 0; i < n; i++) { const r = 18 * Math.sqrt(i + 0.5), a = i * 2.39996; x[i] = Math.cos(a) * r; y[i] = Math.sin(a) * r; }
    const E = edges.map((e) => [idx.get(e.a), idx.get(e.b), e.score]);
    const k = 70;
    const iters = n > 400 ? 80 : n > 150 ? 160 : 300;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let it = 0; it < iters; it++) {
      const temp = 30 * (1 - it / iters) + 0.5;
      dx.fill(0); dy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ex = x[i] - x[j], ey = y[i] - y[j];
          const d2 = Math.max(ex * ex + ey * ey, 1);
          const f = (k * k) / d2;
          ex *= f; ey *= f;
          dx[i] += ex; dy[i] += ey; dx[j] -= ex; dy[j] -= ey;
        }
      }
      for (const [a, b, s] of E) {
        const ex = x[b] - x[a], ey = y[b] - y[a];
        const d = Math.sqrt(ex * ex + ey * ey) || 1;
        const f = (d * d) / (k * (1.6 - s));
        const fx = (ex / d) * f, fy = (ey / d) * f;
        dx[a] += fx; dy[a] += fy; dx[b] -= fx; dy[b] -= fy;
      }
      for (let i = 0; i < n; i++) {
        dx[i] -= x[i] * 0.06; dy[i] -= y[i] * 0.06;
        const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
        const m = Math.min(d, temp);
        x[i] += (dx[i] / d) * m; y[i] += (dy[i] / d) * m;
      }
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
    if (!n) return new Map();
    // Labels can sit on either side, so leave room for one on both.
    const pad = 40, padX = Math.min(110, W * 0.18);
    const sx = (W - 2 * padX) / Math.max(maxX - minX, 1), sy = (H - 2 * pad) / Math.max(maxY - minY, 1);
    // Small maps spread out to use the room; big ones keep labels at a readable density. A flat
    // layout may stretch up to twice as tall, so it fills the box instead of leaving it empty.
    const cap = n <= 12 ? 3 : 1.6;
    const s = Math.min(sx, sy, cap), sY = Math.min(sy, cap, s * 2);
    const ox = padX + (W - 2 * padX - (maxX - minX) * s) / 2, oy = pad + (H - 2 * pad - (maxY - minY) * sY) / 2;
    const out = new Map();
    nodes.forEach((d, i) => out.set(d.id, { x: n === 1 ? W / 2 : ox + (x[i] - minX) * s, y: n === 1 ? H / 2 : oy + (y[i] - minY) * sY }));
    return out;
  }
  function paintMapFocus() {
    const wrap = $("map");
    if (!mapData) return;
    const near = new Set(sel ? [sel] : []);
    if (sel) mapData.edges.forEach((e) => { if (e.a === sel) near.add(e.b); if (e.b === sel) near.add(e.a); });
    wrap.classList.toggle("focused", !!sel && near.size > 0);
    // The selected item and its neighbors claim label spots first, then unconnected items.
    const { nodes, pos, rad, label, deg, W, H } = mapData;
    const place = placeLabels(nodes, pos, rad, label, W, H, (n) => (n.id === sel ? 3 : near.has(n.id) ? 2 : deg.get(n.id) ? 0 : 1));
    $("mapSvg").querySelectorAll(".n").forEach((g) => {
      const on = near.has(g.dataset.id), lp = place.get(g.dataset.id), t = g.querySelector("text");
      g.classList.toggle("near", on);
      g.classList.toggle("sel", g.dataset.id === sel);
      g.classList.toggle("lab", lp.shown);
      t.setAttribute("x", lp.x.toFixed(1)); t.setAttribute("y", lp.y.toFixed(1)); t.setAttribute("text-anchor", lp.anchor);
      t.setAttribute("visibility", lp.shown ? "visible" : "hidden");
    });
    $("mapSvg").querySelectorAll(".e").forEach((l) => l.classList.toggle("near", l.dataset.a === sel || l.dataset.b === sel));
  }
  const svgEl = $("mapSvg");
  svgEl.addEventListener("click", (e) => { const g = e.target.closest(".n"); if (g && !dragMoved) select(g.dataset.id); });
  svgEl.addEventListener("keydown", (e) => { const g = e.target.closest(".n"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(g.dataset.id); } });
  svgEl.addEventListener("mouseover", (e) => { const g = e.target.closest(".n"); if (g) g.querySelector("text").setAttribute("visibility", "visible"); });
  svgEl.addEventListener("mouseout", (e) => { const g = e.target.closest(".n"); if (g && !g.classList.contains("lab")) g.querySelector("text").setAttribute("visibility", "hidden"); });
  // Pan with a drag, zoom with the wheel or a pinch on a trackpad.
  let drag = null, dragMoved = false;
  function setBox(b) { mapData.box = b; svgEl.setAttribute("viewBox", [b.x, b.y, b.w, b.h].map((v) => v.toFixed(1)).join(" ")); }
  svgEl.addEventListener("pointerdown", (e) => { if (!mapData) return; drag = { x: e.clientX, y: e.clientY, box: Object.assign({}, mapData.box) }; dragMoved = false; });
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    const sc = drag.box.w / svgEl.clientWidth;
    const mx = (e.clientX - drag.x) * sc, my = (e.clientY - drag.y) * sc;
    if (Math.abs(mx) + Math.abs(my) > 3 * sc) dragMoved = true;
    if (dragMoved) setBox({ x: drag.box.x - mx, y: drag.box.y - my, w: drag.box.w, h: drag.box.h });
  });
  addEventListener("pointerup", () => { drag = null; setTimeout(() => { dragMoved = false; }, 0); });
  svgEl.addEventListener("wheel", (e) => {
    if (!mapData) return;
    e.preventDefault();
    const b = mapData.box;
    const f = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.002)));
    const w = Math.max(mapData.W / 6, Math.min(mapData.W * 2, b.w * f));
    const h = w * (b.h / b.w);
    const r = svgEl.getBoundingClientRect();
    const px = b.x + ((e.clientX - r.left) / r.width) * b.w, py = b.y + ((e.clientY - r.top) / r.height) * b.h;
    setBox({ x: px - (px - b.x) * (w / b.w), y: py - (py - b.y) * (h / b.h), w, h });
  }, { passive: false });

  // ---------- Add: link, file, note ----------
  const addDlg = $("addDlg");
  let tab = "link";
  const GO = { link: "Save link", file: "Done", note: "Save note" };
  function setTab(t) {
    tab = t;
    $("addTabs").querySelectorAll("[data-tab]").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.tab === t)); });
    addDlg.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== t; });
    $("addGo").textContent = GO[t];
    status("");
    const f = { link: "addUrl", note: "noteBody" }[t];
    if (f) setTimeout(() => $(f).focus(), 0);
  }
  $("addTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
  function openAdd(t) {
    $("queue").innerHTML = "";
    $("addUrl").value = "";
    if (!addDlg.open) addDlg.showModal();
    setTab(t || "link");
  }
  $("openAdd").addEventListener("click", () => openAdd());
  $("emptyAdd").addEventListener("click", () => openAdd());
  document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  function status(text, cls) { const s = $("addStatus"); s.textContent = text; s.className = "status" + (cls ? " " + cls : ""); }
  N.autocomplete($("noteBody"), () => items);

  async function saveDoc(doc, key, url) {
    const text = D.textOf(doc);
    const kindOf = (doc.source && doc.source.kind) || "html";
    await D.put({ key, title: doc.title, author: doc.author, kind: kindOf, words: P.countWords(text), added: Date.now(), opened: Date.now(), doc, url: url || undefined });
    return L.upsertDoc({ docKey: key, title: doc.title, author: doc.author, url: url || "", sourceKind: kindOf, text });
  }
  async function addLink(raw) {
    let url = String(raw || "").trim();
    if (!url) { status("Paste a web address first.", "err"); $("addUrl").focus(); return null; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    try { url = new URL(url).href; } catch (e) { status("That does not look like a web address.", "err"); return null; }
    status("Reading " + (L.domainOf(url) || "the page") + "...");
    let doc = null;
    try { doc = await PolycarpImport.fromUrl(url); } catch (e) { doc = null; }
    if (doc && doc.source && doc.source.kind && !/^(html|web)$/.test(doc.source.kind)) {
      return saveDoc(doc, "u:" + url.replace(/#.*$/, ""), url);
    }
    const item = await L.saveLink({ url, title: doc ? doc.title : "", text: doc ? D.textOf(doc) : "" });
    if (!doc) toast("Saved the link", "Polycarp could not read the page, so it connects by site and title only.");
    return item;
  }
  const AUDIO_RE = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm)$/i;
  function durationOf(file) {
    return new Promise((res) => {
      const a = document.createElement("audio");
      const u = URL.createObjectURL(file);
      const done = () => { URL.revokeObjectURL(u); res(Number.isFinite(a.duration) ? a.duration : 0); };
      a.preload = "metadata";
      a.onloadedmetadata = done;
      a.onerror = done;
      setTimeout(done, 6000);
      a.src = u;
    });
  }
  async function addFiles(files) {
    let last = null;
    for (const f of files) {
      const li = document.createElement("li");
      li.innerHTML = "<b>" + esc(f.name) + "</b><span>Reading</span>";
      $("queue").append(li);
      try {
        if (/^audio\//.test(f.type) || AUDIO_RE.test(f.name)) {
          last = await L.addAudio(f, { title: f.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " "), duration: await durationOf(f), mime: f.type });
        } else {
          const doc = await PolycarpImport.fromFile(f);
          last = await saveDoc(doc, "f:" + f.name + ":" + f.size, "");
        }
        li.className = "ok";
        li.querySelector("span").textContent = "Added";
      } catch (e) {
        li.className = "err";
        li.querySelector("span").textContent = (e && e.message) || "Polycarp could not read this file.";
      }
    }
    await refreshDetail();
    if (last) select(last.id);
  }
  $("addFiles").addEventListener("change", (e) => { const fs = Array.from(e.target.files || []); e.target.value = ""; if (fs.length) addFiles(fs); });
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); addFiles(Array.from(e.dataTransfer.files || [])); });

  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = $("addGo");
    if (tab === "file") { addDlg.close(); return; }
    go.disabled = true;
    try {
      let item = null;
      if (tab === "link") item = await addLink($("addUrl").value);
      else {
        const text = $("noteBody").value;
        if (!text.trim()) { status("Write something first.", "err"); return; }
        item = await L.addItem({ kind: "note", title: $("noteTitle").value.trim(), text });
        $("noteBody").value = "";
        $("noteTitle").value = "";
      }
      if (item) {
        addDlg.close();
        await refreshDetail();
        select(item.id);
        toast("Added to your library", item.title);
      }
    } catch (err) {
      status((err && err.message) || "Something went wrong. Try again.", "err");
    } finally { go.disabled = false; }
  });

  // Drop files anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  addEventListener("dragenter", (e) => { if (!hasFiles(e) || addDlg.open) return; dragDepth++; $("dropzone").hidden = false; });
  addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropzone").hidden = true; } });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("drop", (e) => {
    if (!hasFiles(e) || addDlg.open) return;
    e.preventDefault();
    dragDepth = 0;
    $("dropzone").hidden = true;
    openAdd("file");
    addFiles(Array.from(e.dataTransfer.files));
  });

  // ---------- Sync: Obsidian and Notion ----------
  const syncDlg = $("syncDlg");
  $("openSync").addEventListener("click", async () => { syncDlg.showModal(); await Promise.all([renderObsidian(), renderNotion()]); });
  function sstatus(id, text, cls) { const s = $(id); s.textContent = text; s.className = "status" + (cls ? " " + cls : ""); }

  async function exportFiles() {
    await load();
    const names = O.basenames(items);
    const files = [];
    for (const it of items) {
      const rel = await L.related(it.id, { limit: 8 }).catch(() => []);
      files.push(O.toMarkdown(it, { notes: notesBy.get(it.id) || [], related: rel, ideas: L.ideasFor(it, cards), names }));
    }
    files.push(O.indexNote(items, names));
    return files;
  }
  async function renderObsidian() {
    const h = await O.loadHandle().catch(() => null);
    const last = await L.getMeta("obsidian.last");
    const acts = [];
    if (h) {
      acts.push('<button class="btn" data-o="sync">' + I("sync") + "<span>Sync to Obsidian</span></button>");
      acts.push('<a class="btn quiet" href="' + esc(O.obsidianUrl(h.name, O.FOLDER + "/" + O.INDEX_NAME)) + '">' + I("external") + "<span>Open in Obsidian</span></a>");
      acts.push('<button class="btn quiet" data-o="pick">Change folder</button>');
    } else if (typeof showDirectoryPicker === "function") {
      acts.push('<button class="btn" data-o="pick">' + I("upload") + "<span>Choose your vault folder</span></button>");
    }
    acts.push('<button class="btn quiet" data-o="zip">' + I("download") + "<span>Download as Markdown</span></button>");
    $("obsActs").innerHTML = acts.join("");
    if (h) sstatus("obsStatus", "Vault: " + h.name + (last ? ". Last synced " + new Date(last).toLocaleString() + "." : ". Not synced yet."));
    else sstatus("obsStatus", "Choose the top folder of your vault. Polycarp asks your browser for access to that folder only.");
  }
  $("obsActs").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-o]");
    if (!b) return;
    const a = b.dataset.o;
    try {
      if (a === "pick") {
        let h;
        try { h = await showDirectoryPicker({ id: "polycarp-vault", mode: "readwrite" }); } catch (err) { return; }
        await O.saveHandle(h);
        await syncObsidian(h);
      } else if (a === "sync") {
        const h = await O.loadHandle();
        if (!(await O.ensurePermission(h))) { sstatus("obsStatus", "Your browser did not allow access to the vault folder. Choose it again.", "err"); return; }
        await syncObsidian(h);
      } else if (a === "zip") {
        sstatus("obsStatus", "Preparing your Markdown files...");
        const blob = await O.zip(await exportFiles());
        const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "Polycarp Library.zip" });
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 4000);
        sstatus("obsStatus", "Downloaded. Unzip it into your vault, or into any notes app that reads Markdown.", "ok");
      }
    } catch (err) {
      sstatus("obsStatus", "Sync stopped: " + ((err && err.message) || err), "err");
    }
  });
  async function syncObsidian(h) {
    if (!(await O.ensurePermission(h))) { sstatus("obsStatus", "Your browser did not allow access to that folder.", "err"); return; }
    sstatus("obsStatus", "Writing notes...");
    const files = await exportFiles();
    const r = await O.writeVault(h, files, { onProgress: (p) => sstatus("obsStatus", "Writing " + p.done + " of " + p.total + "...") });
    await L.setMeta("obsidian.last", Date.now());
    await renderObsidian();
    sstatus("obsStatus", "Synced to " + h.name + ": " + plural(r.written, "file") + " written, " + r.skipped + " unchanged" + (r.renamed ? ", " + r.renamed + " renamed to avoid your own files" : "") + ".", "ok");
  }

  async function notionCfg() { return (await chrome.storage.local.get(NOTION_KEY))[NOTION_KEY] || {}; }
  async function setNotionCfg(c) { await chrome.storage.local.set({ [NOTION_KEY]: c }); }
  async function renderNotion() {
    const cfg = await notionCfg();
    const box = $("notionBox");
    if (!cfg.token) {
      box.innerHTML = "<p>Each item becomes a page in a <b>Polycarp Library</b> database, with its highlights, notes and a Related column that links connected pages.</p>" +
        '<ol><li>Create an internal integration at <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener">notion.so/profile/integrations</a> and copy its secret.</li>' +
        "<li>In Notion, open the page that should hold your library, choose the ••• menu, then Connections, and add the integration.</li>" +
        "<li>Paste the secret here.</li></ol>" +
        '<div class="pair"><input class="field" id="nToken" type="password" placeholder="Secret (starts with ntn_)" autocomplete="off" aria-label="Notion integration secret"><button class="btn" id="nConnect">Connect</button></div>';
      sstatus("notionStatus", "The secret is saved on this computer and sent only to Notion.");
      $("nConnect").addEventListener("click", connectNotion);
      $("nToken").addEventListener("keydown", (e) => { if (e.key === "Enter") connectNotion(); });
      return;
    }
    box.innerHTML = "<p>Connected" + (cfg.bot ? " as <b>" + esc(cfg.bot) + "</b>" : "") + ". Choose the page that holds your library.</p>" +
      '<select class="select" id="nPage" aria-label="Notion page"><option value="">Loading your pages...</option></select>' +
      '<div class="acts"><button class="btn" id="nSync">' + I("sync") + '<span>Sync to Notion</span></button><button class="btn quiet" id="nOff">Disconnect</button></div>';
    sstatus("notionStatus", cfg.last ? "Last synced " + new Date(cfg.last).toLocaleString() + "." : "");
    $("nSync").addEventListener("click", syncNotion);
    $("nOff").addEventListener("click", async () => { await chrome.storage.local.remove(NOTION_KEY); renderNotion(); });
    try {
      const pages = await NO.create({ token: cfg.token }).searchPages("");
      const sel = $("nPage");
      sel.innerHTML = pages.length
        ? pages.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === cfg.pageId ? " selected" : "") + ">" + esc(p.title) + "</option>").join("")
        : '<option value="">No pages shared with the integration yet</option>';
      sel.addEventListener("change", async () => {
        const c = await notionCfg();
        if (c.pageId !== sel.value) { c.pageId = sel.value; c.dbId = ""; c.pageIds = {}; await setNotionCfg(c); }
      });
      if (pages.length && !pages.some((p) => p.id === cfg.pageId)) sel.dispatchEvent(new Event("change"));
    } catch (err) {
      sstatus("notionStatus", "Could not reach Notion: " + ((err && err.message) || err), "err");
    }
  }
  async function connectNotion() {
    const token = $("nToken").value.trim();
    if (!token) { sstatus("notionStatus", "Paste the secret first.", "err"); return; }
    sstatus("notionStatus", "Checking with Notion...");
    try {
      const me = await NO.create({ token }).me();
      await setNotionCfg({ token, bot: (me && me.name) || "" });
      await renderNotion();
    } catch (err) {
      sstatus("notionStatus", "Notion did not accept that secret. Copy it again from the integration page.", "err");
    }
  }
  async function syncNotion() {
    const cfg = await notionCfg();
    const pageId = $("nPage").value || cfg.pageId;
    if (!pageId) { sstatus("notionStatus", "Choose a page first. If none are listed, add the integration to a page in Notion.", "err"); return; }
    const btn = $("nSync");
    btn.disabled = true;
    try {
      const client = NO.create({ token: cfg.token });
      sstatus("notionStatus", "Preparing the database...");
      const dbId = await client.ensureDatabase(pageId, cfg.pageId === pageId ? cfg.dbId : "");
      await load();
      const res = await client.syncItems(dbId, items, {
        notesFor: (id) => notesBy.get(id) || [],
        relatedFor: (id) => L.related(id, { limit: 8 }),
        ideasFor: (it) => L.ideasFor(it, cards),
        pageIds: cfg.pageId === pageId ? cfg.pageIds : {},
        onProgress: (p) => sstatus("notionStatus", (p.phase === "links" ? "Linking related pages " : "Sending ") + p.done + " of " + p.total + "...")
      });
      await setNotionCfg(Object.assign({}, cfg, { pageId, dbId, pageIds: res.pageIds, last: Date.now() }));
      const bits = [res.created + " new", res.updated + " updated", res.unchanged + " unchanged"];
      sstatus("notionStatus", "Synced: " + bits.join(", ") + "." + (res.errors.length ? " " + plural(res.errors.length, "item") + " failed: " + (res.errors[0].message || res.errors[0].error || "") : ""), res.errors.length ? "err" : "ok");
    } catch (err) {
      sstatus("notionStatus", "Sync stopped: " + ((err && err.message) || err), "err");
    } finally { btn.disabled = false; }
  }

  // ---------- Keys ----------
  addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); }
    else if (e.key === "Escape" && typing && document.activeElement === $("q")) { $("q").value = ""; $("q").dispatchEvent(new Event("input")); $("q").blur(); }
    else if (e.key === "Escape" && !typing && sel) select(null);
    else if ((e.key === "a" || e.key === "A") && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openAdd(); }
  });

  // ---------- Live updates from the Reader or other tabs ----------
  let ct = 0;
  L.onChange(() => {
    clearTimeout(ct);
    ct = setTimeout(async () => {
      const busy = document.activeElement && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName) && $("detail").contains(document.activeElement);
      const playing = $("aud") && !$("aud").paused;
      await load();
      renderHead();
      renderList();
      if (sel && !byId.has(sel)) select(null);
      else if (!busy && !playing) await renderDetail();
      if (view === "map") drawMap();
    }, 300);
  });

  // ---------- Boot ----------
  // Documents opened in the Reader before the Library existed are indexed once.
  if (!(await L.getMeta("readerDocsImported"))) {
    try {
      const docs = await D.all();
      const have = new Set(items.map((i) => i.docKey));
      await L.importReaderDocs(docs.filter((d) => !have.has(d.key)).map((d) => ({ key: d.key, title: d.title, author: d.author, kind: d.kind, url: d.url, doc: d.doc })));
      await L.setMeta("readerDocsImported", Date.now());
    } catch (e) { console.warn("Polycarp library import", e); }
  }
  await load();
  renderHead();
  let startView = "list";
  try { startView = localStorage.getItem("polycarp.libview") || "list"; } catch (e) { /* private window */ }
  setView(startView === "map" ? "map" : "list");
  const h = /#item=([^&]+)/.exec(location.hash);
  if (h) select(decodeURIComponent(h[1]));
  else if (matchMedia("(min-width: 861px)").matches && items.length) select(visible()[0].id);
  if (/#add/.test(location.hash)) openAdd();
  if (/#sync/.test(location.hash)) $("openSync").click();
})();
