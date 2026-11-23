/* Polycarp Reader notes: highlight a passage, write a note on it or on the current paragraph, see every
   note for this document in the Notes sheet, and see what else in the library connects to it.
   Notes are written in the reader's own words, which is generative work that aids memory
   (Fiorella and Mayer 2016); the Library links them to everything else you read. */
(function () {
  "use strict";
  const R = globalThis.PolycarpReader;
  const L = globalThis.PolycarpLibrary;
  const N = globalThis.PolycarpNotesUI;
  const IC = globalThis.PolycarpIcons;
  const I = IC.icon;
  const $ = (id) => document.getElementById(id);
  if (!R || !L || !N) return;

  const hl = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
  let notes = [];
  let items = [];
  let resolve = () => null;
  const libUrl = (id) => "../pages/library.html" + (id ? "#item=" + encodeURIComponent(id) : "");

  $("selHi").innerHTML = I("highlighter") + "<span>Highlight</span>";
  $("selNote").innerHTML = I("pen") + "<span>Note</span>";
  $("openInLib").innerHTML = I("library") + "<span>Open in Library</span>";
  N.autocomplete($("noteText"), () => items);

  async function loadItems() {
    try { items = await L.allItems(); } catch (e) { items = []; }
    resolve = N.resolver(items);
  }
  function itemReady() {
    if (R.itemId) return Promise.resolve(R.itemId);
    return new Promise((res) => {
      const t = setTimeout(() => res(R.itemId), 4000);
      R.on("item", (it) => { clearTimeout(t); res(it && it.id); });
    });
  }
  function blockOf(range) {
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const blk = node && node.closest(".blk");
    return blk ? Number(blk.dataset.b) : R.cur;
  }
  // The printed page a block sits on, from the PDF importer's page markers.
  function pageOf(b) {
    const el = R.blocks[b];
    if (!el) return null;
    let page = null;
    for (const m of document.querySelectorAll("#article .ph-pagemark[data-page]")) {
      if (m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) page = Number(m.dataset.page);
      else break;
    }
    return page;
  }

  // ---------- Highlight ----------
  R.highlight = async function (withNote) {
    const sel = R.selectionInArticle && R.selectionInArticle();
    if (!sel) { R.toast("Select a passage first", "Then press H to highlight it."); return; }
    const b = blockOf(sel.range);
    const quote = sel.text.slice(0, 2000);
    getSelection().removeAllRanges();
    $("selbar").hidden = true;
    const itemId = await itemReady();
    if (!itemId) { R.toast("Not saved", "This document is not in your library yet. Try again in a moment."); return; }
    const page = pageOf(b);
    const note = await L.addNote({ itemId, quote, text: "", anchor: page != null ? { block: b, page } : { block: b } });
    await refresh();
    if (withNote) { R.openSheet("notesSheet"); edit(note.id); }
    else R.toast("Highlighted", "It is saved with your notes for this document.");
  };
  $("selHi").addEventListener("click", () => R.highlight(false));
  $("selNote").addEventListener("click", () => R.highlight(true));

  // ---------- Paint highlights in the text ----------
  function paint() {
    document.querySelectorAll("#article .blk.has-note").forEach((el) => el.classList.remove("has-note"));
    if (hl) CSS.highlights.delete("polycarp-hl");
    const ranges = [];
    for (const n of notes) {
      const b = n.anchor && n.anchor.block;
      const el = b != null ? R.blocks[b] : null;
      if (!el) continue;
      if (n.text) el.classList.add("has-note");
      if (n.quote && hl) {
        let r = N.findRange(el, n.quote);
        if (!r) for (let j = 1; j <= 3 && !r; j++) r = N.findRange(R.blocks[b + j], n.quote);
        if (r) ranges.push(r);
      }
    }
    if (hl && ranges.length) CSS.highlights.set("polycarp-hl", new Highlight(...ranges));
  }

  // ---------- Notes sheet ----------
  function where() {
    const page = pageOf(R.cur);
    $("noteWhere").textContent = page != null ? "On page " + page : "At paragraph " + (R.cur + 1);
  }
  function renderList() {
    const ul = $("notesList");
    if (!notes.length) {
      ul.innerHTML = '<li class="empty">No notes yet. Select a passage and choose Highlight or Note, or write one above. Notes in your own words are the ones you keep.</li>';
      return;
    }
    ul.innerHTML = notes.map((n) => {
      const label = N.anchorLabel(n.anchor);
      return '<li data-id="' + N.esc(n.id) + '">' +
        (n.quote ? "<blockquote>" + N.esc(n.quote) + "</blockquote>" : "") +
        (n.text ? '<div class="nt">' + N.render(n.text, resolve) + "</div>" : "") +
        '<div class="meta">' + (label ? '<button data-go>' + N.esc(label) + "</button>" : "") +
        '<span class="grow"></span><button data-edit>' + (n.text ? "Edit" : "Add note") + '</button><button data-del aria-label="Delete note">Delete</button></div></li>';
    }).join("");
  }
  async function renderRelated() {
    const box = $("relatedBox");
    if (!R.itemId) { box.hidden = true; return; }
    let rel = [];
    try { rel = await L.related(R.itemId, { limit: 5 }); } catch (e) {}
    box.hidden = !rel.length;
    $("relatedList").innerHTML = rel.map((r) => '<li><a href="' + libUrl(r.item.id) + '"><b>' + N.esc(r.item.title) + "</b><span>" + N.esc(r.why) + "</span></a></li>").join("");
  }
  async function refresh() {
    if (!R.itemId) { notes = []; paint(); renderList(); return; }
    try { notes = await L.notesFor(R.itemId); } catch (e) { notes = []; }
    paint();
    renderList();
    const count = notes.length;
    $("tNotes").querySelector("span").textContent = count ? "Notes " + count : "Notes";
  }
  function edit(id) {
    const li = $("notesList").querySelector('li[data-id="' + CSS.escape(id) + '"]');
    const n = notes.find((x) => x.id === id);
    if (!li || !n) return;
    const box = document.createElement("form");
    box.className = "note-new";
    box.innerHTML = '<textarea class="field" rows="3" aria-label="Note"></textarea><div class="note-acts"><span></span><span><button class="btn quiet" type="button" data-cancel>Cancel</button> <button class="btn" type="submit">Save</button></span></div>';
    const ta = box.querySelector("textarea");
    ta.value = n.text || "";
    const old = li.querySelector(".nt");
    if (old) old.replaceWith(box); else li.insertBefore(box, li.querySelector(".meta"));
    li.querySelector(".meta").hidden = true;
    N.autocomplete(ta, () => items);
    ta.focus();
    box.querySelector("[data-cancel]").addEventListener("click", renderList);
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); box.requestSubmit(); } });
    box.addEventListener("submit", async (e) => {
      e.preventDefault();
      await L.updateNote(id, { text: ta.value.trim() });
      await refresh();
    });
  }
  $("notesList").addEventListener("click", async (e) => {
    const li = e.target.closest("li[data-id]");
    const wl = e.target.closest("a.wl[data-item]");
    if (wl) { e.preventDefault(); location.href = libUrl(wl.dataset.item); return; }
    if (!li) return;
    const n = notes.find((x) => x.id === li.dataset.id);
    if (!n) return;
    if (e.target.closest("[data-go]") && n.anchor && n.anchor.block != null) { R.closeSheet(); R.go(Number(n.anchor.block)); }
    else if (e.target.closest("[data-edit]")) edit(n.id);
    else if (e.target.closest("[data-del]")) { await L.removeNote(n.id); await refresh(); }
  });
  $("noteText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("noteForm").requestSubmit(); } });
  $("noteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("noteText").value.trim();
    if (!text) return;
    const itemId = await itemReady();
    if (!itemId) return;
    const page = pageOf(R.cur);
    await L.addNote({ itemId, text, anchor: page != null ? { block: R.cur, page } : { block: R.cur } });
    $("noteText").value = "";
    await refresh();
    renderRelated();
  });

  R.on("sheet", (id) => {
    if (id !== "notesSheet") return;
    where();
    $("openInLib").href = libUrl(R.itemId);
    loadItems().then(() => { renderList(); renderRelated(); });
    setTimeout(() => $("noteText").focus(), 30);
  });
  R.on("current", () => { if (!$("notesSheet").hidden) where(); });
  R.on("item", () => { loadItems(); refresh(); });
  // Bold anchors rebuild the text nodes, so highlights are painted again after a settings change.
  R.on("settings", () => setTimeout(paint, 0));
  let t = 0;
  L.onChange((ev) => { clearTimeout(t); t = setTimeout(() => { if (R.itemId) refresh(); }, 250); });
})();
