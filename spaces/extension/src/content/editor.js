/* Change this page by hand: point at a part, then hide, reword, restyle, move it or leave a note by it. Put on the page
   when asked for (popup, menu, shortcut), and again to close; the script's value says whether the page took it. Every
   change is a page edit kept in this browser (src/shared/edits-store.js), which src/content/edits.js applies: nothing
   here changes the page itself.
   A clear layer over the page takes the pointer, so the page hears no click meant for the editor. */
(function () {
  "use strict";
  const P = globalThis.Polycarp, E = globalThis.PolycarpEdits, S = globalThis.PolycarpEditsStore, K = globalThis.PolycarpEditsPick;
  if (P.editor) { const on = P.editor.on(); P.editor.close(); if (on) return true; } // a page may have taken it away
  const site = E.site(location.hostname);
  if (!site || !P.pageEdits) return false;
  const STAYS = E.EDITORS + "," + E.CARRY; // what may not be moved, nor be in what is

  const CSS_TEXT = `
    :host{all:initial !important;display:contents !important}
    *{box-sizing:border-box} [hidden]{display:none !important}
    /* In the top layer: over the page, and out of reach of its transforms. */
    .top{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none}
    .layer{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;touch-action:pan-x pan-y pinch-zoom}
    .mark{position:fixed;pointer-events:none;border:2px solid var(--pc-accent);border-radius:var(--pc-radius-small);outline:1px solid var(--pc-on-accent)}
    .mark.like{border-style:dashed}
    .bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);pointer-events:auto;width:min(560px,calc(100vw - 24px));max-height:60vh;overflow:auto;padding:8px;
      border:var(--pc-border-width) solid var(--pc-border);border-radius:var(--pc-radius);background:var(--pc-surface);color:var(--pc-foreground);
      box-shadow:0 8px 24px color-mix(in srgb,var(--pc-strong) calc(var(--pc-shadow) * 100%),transparent);font:var(--pc-font-weight) 14px/1.5 var(--pc-font-ui);text-align:start}
    .bar.up{bottom:auto;top:16px}
    .row{display:flex;flex-wrap:wrap;align-items:center;gap:4px} .row + .row,.scope{margin-top:8px}
    .what{flex:1;min-width:0;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .what b{color:var(--pc-strong)}
    button,select,input,textarea{font:inherit;color:inherit}
    button{min-height:40px;padding:0 12px;border:0;border-radius:var(--pc-radius-small);background:none;font-weight:600;cursor:pointer}
    button:hover{background:var(--pc-sunken)} button[aria-expanded=true],button[aria-pressed=true]{background:var(--pc-selection)} button:disabled{color:var(--pc-muted);cursor:default;background:none}
    button.main{background:var(--pc-accent);color:var(--pc-on-accent)}
    :focus-visible{outline:2px solid var(--pc-strong);outline-offset:1px}
    select,textarea{border:var(--pc-border-width) solid var(--pc-border);border-radius:var(--pc-radius-small);background:var(--pc-background)}
    select{min-height:40px;flex:1 1 160px;min-width:0;padding:0 8px} textarea{display:block;width:100%;min-height:72px;padding:8px;resize:vertical;font-size:16px}
    .tool{margin-top:8px;padding:8px;border-radius:var(--pc-radius-small);background:var(--pc-sunken)} .tool .row:first-child{margin-top:0} .tool textarea + .row{margin-top:8px}
    label.color{display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 8px;font-weight:600} input[type=color]{width:32px;height:28px;padding:0;border:0;background:none}
    .say{margin:0;padding:4px 8px 0;color:var(--pc-muted);font-size:13px} .say:empty{display:none}
    @media (max-width:430px){.tools,.tool .row{gap:0;justify-content:space-between} .tools button,.tool button:not(.main),label.color{padding:0 8px}}
    @media (prefers-reduced-motion:no-preference){.mark{transition:opacity var(--pc-motion-fast)}}`;

  const host = document.createElement("polycarp-edits");
  host.setAttribute("data-polycarp-skip", "");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style></style><div class="top" popover="manual"><div class="layer"></div><div class="marks"></div>
    <div class="bar" role="dialog" aria-label="Edit this page" tabindex="-1">
      <div class="row"><span class="what" role="status"></span><button data-do="undo" disabled>Undo</button><button data-do="done" class="main">Done</button></div>
      <div class="row tools" hidden>
        <button data-do="hide">Hide</button><button data-tool="text">Text</button><button data-tool="style">Style</button><button data-tool="move">Move</button><button data-tool="note">Note</button><button data-do="wider">Wider</button>
      </div>
      <div class="tool" hidden></div>
      <div class="row scope" hidden><select data-scope="which" aria-label="Which parts"></select><select data-scope="where" aria-label="Which pages"></select></div>
      <p class="say" role="status"></p>
    </div></div>`;
  const $ = (sel) => root.querySelector(sel);
  const bar = $(".bar"), layer = $(".layer"), marks = $(".marks"), tools = $(".tools"), tool = $(".tool"), scope = $(".scope"), what = $(".what"), say = $(".say");
  const which = $("[data-scope=which]"), where = $("[data-scope=where]");
  let sel = null, open = "", raf = 0, over = null, history = [], off = "", color = null, wait = 0;
  const unwatch = P.watchTheme((css) => { $("style").textContent = P.shadowThemeCss(css) + CSS_TEXT; });

  // ---------------------------------------------------------------- pointing
  const ours = (el) => !!el.closest(E.OURS);
  const moved = (el) => P.pageEdits.shown(el);
  const box = (el) => { const m = moved(el); return ((m && m.firstElementChild) || el).getBoundingClientRect(); };
  const fit = (el) => !!el && el.nodeType === 1 && !/^(HTML|BODY|HEAD|SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(el.tagName) && !ours(el) && !el.contains(host) && box(el).width > 0;
  function under(x, y) {
    layer.style.pointerEvents = "none";
    let el = document.elementFromPoint(x, y);
    layer.style.pointerEvents = "";
    el = (el && P.pageEdits.part(el)) || el; // a moved part is pointed at where it shows
    // Polycarp's own letters inside words are the words' part.
    while (el && /^POLYCARP-[TBR]$/.test(el.tagName)) el = el.parentElement;
    return fit(el) ? el : null;
  }
  function drawMarks() {
    raf = 0;
    const at = [];
    if (sel && sel.isConnected) {
      if (which.value === "all") for (const el of K.all(document, selector())) if (el !== sel && at.length < 100) at.push([el, "mark like"]);
      at.push([sel, "mark"]);
    }
    if (over && over !== sel && over.isConnected) at.push([over, "mark like"]);
    while (marks.children.length < at.length) marks.append(document.createElement("div"));
    [...marks.children].forEach((m, i) => {
      const r = at[i] && box(at[i][0]);
      m.className = r ? at[i][1] : "";
      m.hidden = !r || !r.width;
      if (r) Object.assign(m.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
    });
    const r = sel && box(sel);
    const tall = bar.offsetHeight + 32;
    bar.classList.toggle("up", !!r && r.bottom > innerHeight - tall && r.top > tall);
  }
  const draw = () => { if (!raf) raf = requestAnimationFrame(drawMarks); };
  // What the panel says under its tools; with nothing to say, whether Polycarp is off here.
  const tell = (text) => { say.textContent = text || off; };
  // Clearing a tool takes the focused button with it: the panel keeps the keyboard.
  function clear() { const held = tool.contains(root.activeElement); tool.textContent = ""; if (held) bar.focus(); }
  function choose(el) {
    flush();
    sel = el;
    over = null;
    tools.hidden = scope.hidden = !el;
    openTool("");
    tell(el && moved(el) && el.firstElementChild ? "A moved part is changed as one. Take the move back to change what is in it." : "");
    page.textContent = location.search || path() !== location.pathname ? "Every page at " + path() : "This page";
    if (!el) { what.textContent = "Click a part of the page to change it."; draw(); return; }
    const words = (el.innerText || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ");
    what.textContent = "";
    what.append(Object.assign(document.createElement("b"), { textContent: K.name(el) }), words ? " " + words.slice(0, 60) : "");
    const one = K.one(el), like = K.like(el), n = like ? K.count(document, like) : 0;
    which.innerHTML = "";
    if (one) which.append(new Option("Only this one", "one"));
    if (like) which.append(new Option("All " + n + " like it", "all"));
    which.dataset.one = one;
    which.dataset.all = like;
    which.hidden = !one && !like;
    for (const b of tools.querySelectorAll("[data-tool],[data-do=hide]")) b.disabled = !one && !like;
    if (!one && !like) tell("This part can't be named. Try a wider one.");
    draw();
  }
  const page = new Option("This page", "page");
  const selector = () => which.dataset[which.value] || "";
  function step(key) {
    const next = (el, dir) => { do el = el[dir]; while (el && !fit(el)); return el; };
    if (!sel) return choose([...document.body.children].find(fit) || null);
    const to = key === "ArrowUp" ? sel.parentElement : key === "ArrowDown" ? [...sel.children].find(fit) : next(sel, key === "ArrowLeft" ? "previousElementSibling" : "nextElementSibling");
    if (fit(to)) { choose(to); (moved(to) || to).scrollIntoView({ block: "nearest" }); }
  }

  // ---------------------------------------------------------------- changing
  const hash = (s) => { let h = 5381; for (const c of s) h = (Math.imul(h, 33) ^ c.codePointAt(0)) >>> 0; return h.toString(36); };
  const path = () => (location.pathname.length > 180 ? location.pathname.slice(0, 180) + "*" : location.pathname);
  // One record for this page and one for the site hold every change made by hand there.
  function draft(scope) {
    const at = scope === "page" ? path() : "";
    return { id: "mine-" + hash(site + " " + at), name: ("My changes on " + site + at).slice(0, 80), sites: [site], paths: at ? [at] : [], changes: [], css: "" };
  }
  const mine = async (id) => (await S.load()).edits.find((e) => e.source === "local" && e.id === id) || null;
  const plain = (e, changes = e.changes) => ({ id: e.id, name: e.name, enabled: e.enabled !== false, sites: e.sites, paths: e.paths, changes, css: e.css });
  const store = (e, changes) => S.put(e.id, changes.length || e.css ? plain(e, changes) : null);
  const OFF = "Your changes here are off. Turn them on in Polycarp's popup first.";
  // One at a time: each starts from what the one before it kept.
  let last = Promise.resolve();
  const turn = (act) => (last = last.then(act).catch(() => {
    tell("Not changed: this browser could not save it.");
    P.pageEdits.apply(); // with the extension gone, this takes the edits back
    return false;
  }));
  // Why the page didn't take a change that is in force, or "".
  async function refused(id, i) {
    await P.pageEdits.settle();
    const e = document.readyState !== "loading" && P.pageEdits.report().find((x) => x.source === "local" && x.id === id);
    const c = e && e.changes[i];
    return c && !c.hits && c.note ? c.note[0].toUpperCase() + c.note.slice(1) + "." : "";
  }
  // Adds one change. One that adjusts the change before it takes its place, and a color picked on the way is one step.
  async function keep(change, picking, part, scope) {
    if (!part || !part.isConnected) { if (sel === part) choose(null); tell("That part is gone from the page."); return false; }
    const base = draft(scope), { edits } = await S.load();
    const before = edits.find((e) => e.source === "local" && e.id === base.id) || null;
    if (before && !before.enabled) { tell(OFF); return false; }
    if (/hide|move/.test(change.do) && K.all(document, change.at).some((el) => el.contains(host))) { tell("This panel is in that dialog. Close the dialog with its own button."); return false; }
    const changes = before ? before.changes.slice() : [], was = [];
    const drop = (f) => { for (let i = changes.length - 1; i >= 0; i--) if (f(changes[i])) was.unshift(...changes.splice(i, 1)); };
    if (change.do === "move") {
      const it = (c) => c.do === "move" && K.all(document, c.at)[0] === part;
      const on = E.active(edits, location.hostname, location.pathname), by = (at) => part.contains(K.all(document, at).find((el) => !el.closest("[data-polycarp-moved]")) || null);
      const held = on.flatMap((e) => e.changes).find((c) => (c.do === "insert" && by(c.at)) || (c.do === "move" && !it(c) && by(c.to)));
      if (held) { tell(held.do === "insert" ? "A note hangs on this part. Take the note back first." : "Another part was moved beside this one. Move that one instead."); return false; }
      const other = on.find((e) => (e.source !== "local" || e.id !== base.id) && e.changes.some(it));
      if (other) { tell((other.source === "app" ? "Your agent's edit" : "\u201c" + other.name + "\u201d") + " already moves this part. Take that back first."); return false; }
      drop(it);
    }
    if (change.do === "text") drop((c) => c.do === "text" && c.at === change.at && !c.find);
    const same = changes[changes.length - 1];
    if (change.do === "style" && same && same.do === "style" && same.at === change.at) { was.push(changes.pop()); change = { ...same, style: { ...same.style, ...change.style } }; }
    changes.push(change);
    const why = await store(before || base, changes);
    if (why) { tell("Not changed: " + why + "."); return false; }
    const no = await refused(base.id, changes.length - 1);
    if (no) { await S.put(base.id, before ? plain(before) : null); tell(no); return false; }
    const now = JSON.stringify((await mine(base.id)).changes.at(-1)), top = history.at(-1);
    if (picking && top && top.picking && top.id === base.id && was.length === 1 && JSON.stringify(was[0]) === top.now) top.now = now;
    else history.push({ id: base.id, now, was, picking });
    tell("");
    await steps();
    return true;
  }
  function add(change, picking) { const part = sel, scope = where.value; return turn(() => keep(change, picking, part, scope)); }
  // Undo takes back what was done since the panel opened, then what this page and this site already had.
  async function older() {
    for (const scope of ["page", "site"]) { const e = await mine(draft(scope).id); if (e && e.enabled && e.changes.length) return { id: e.id, now: JSON.stringify(e.changes.at(-1)), was: [] }; }
    return null;
  }
  async function steps() {
    const b = $("[data-do=undo]"), none = !history.length && !(await older());
    if (none && root.activeElement === b) bar.focus();
    b.disabled = none;
    setTimeout(draw, 120);
  }
  const undo = () => turn(async () => {
    const h = history.at(-1) || (await older());
    if (!h) return;
    const e = await mine(h.id), i = e ? e.changes.findLastIndex((c) => JSON.stringify(c) === h.now) : -1;
    if (e && !e.enabled) { tell(OFF); return; }
    const changes = e ? e.changes.slice() : [];
    if (i >= 0) changes.splice(i, 1, ...h.was);
    const why = i >= 0 ? await store(e, changes) : "";
    if (why) { tell("Not taken back: " + why + "."); return; }
    history.pop();
    await P.pageEdits.settle();
    tell(i >= 0 ? "Taken back: " + E.describe(JSON.parse(h.now)) + "." : "That change was already gone.");
    await steps();
  });

  const px = (v) => parseFloat(v) || 16;
  const hex = (v) => { const m = (v.match(/[\d.]+/g) || []).map(Number); return m.length >= 3 && m[3] !== 0 ? "#" + m.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("") : ""; };
  // The color seen behind a part: its own, or the nearest one around it.
  const behind = (el) => { for (; el; el = el.parentElement) { const h = hex(getComputedStyle(el).backgroundColor); if (h) return h; } return ""; };
  const TOOLS = {
    text() {
      if (sel.isContentEditable || sel.querySelector(STAYS + ",video,audio,canvas") || sel.matches(E.NEVER + ",img,video,audio,canvas")) { tool.textContent = "Choose a smaller part, one that holds only words."; return; }
      const words = (sel.innerText || sel.textContent).trim().replace(/\s+/g, " ");
      if (words.length > E.MAX.text) { tool.textContent = "Choose a smaller part. This one has too many words."; return; }
      tool.innerHTML = '<textarea aria-label="Words"></textarea><div class="row"><button class="main" data-do="text">Change words</button></div>';
      tool.querySelector("textarea").value = words;
    },
    note() { tool.innerHTML = '<textarea aria-label="Note" placeholder="A note to yourself, shown under this part"></textarea><div class="row"><button class="main" data-do="note">Add note</button></div>'; },
    move() { tool.innerHTML = '<div class="row"><button data-do="before">Up</button><button data-do="after">Down</button></div>'; },
    style() {
      const c = getComputedStyle(sel);
      tool.innerHTML = '<div class="row"><button data-do="smaller">Smaller</button><button data-do="larger">Larger</button><button data-do="bold">Bold</button>' +
        '<label class="color">Text <input type="color" data-color="color"></label><label class="color">Fill <input type="color" data-color="background-color"></label></div>';
      tool.querySelector("[data-color=color]").value = hex(c.color);
      tool.querySelector("[data-color=background-color]").value = behind(sel);
    }
  };
  function openTool(name) {
    open = name === open ? "" : name;
    clear();
    // Moving and noting are about one part.
    const like = [...which.options].find((o) => o.value === "all");
    if (like) { like.disabled = /move|note/.test(open) && which.options.length > 1; if (like.disabled) which.value = "one"; }
    tool.hidden = !open;
    for (const b of tools.querySelectorAll("[data-tool]")) b.setAttribute("aria-expanded", String(b.dataset.tool === open));
    if (open) TOOLS[open]();
    const t = tool.querySelector("textarea");
    if (t) { t.focus(); t.select(); }
    draw();
  }
  const ACTS = {
    done: close,
    undo,
    wider: () => step("ArrowUp"),
    async hide() { if (await add({ do: "hide", at: selector() })) { choose(null); bar.focus(); } },
    async text() { await add({ do: "text", at: selector(), text: tool.querySelector("textarea").value }); },
    async note() {
      const blocks = tool.querySelector("textarea").value.split(/\n+/).map((t) => t.trim()).filter(Boolean).slice(0, E.MAX.blocks).map((text) => ({ kind: "text", text }));
      if (!blocks.length) { tell("Write the note first."); return; }
      if (moved(sel)) { tell("This part was moved. Leave the note by another one."); return; }
      if (!which.dataset.one) { tell("This part can't be told from others. Try a wider one."); return; }
      if (await add({ do: "insert", at: which.dataset.one, where: "after", blocks })) openTool("");
    },
    smaller: () => add({ do: "style", at: selector(), style: { "font-size": Math.max(6, Math.round(px(getComputedStyle(sel).fontSize) / 1.1)) + "px" } }),
    larger: () => add({ do: "style", at: selector(), style: { "font-size": Math.round(px(getComputedStyle(sel).fontSize) * 1.1 + 0.5) + "px" } }),
    bold: () => add({ do: "style", at: selector(), style: { "font-weight": Number(getComputedStyle(sel).fontWeight) >= 600 ? "400" : "700" } }),
    before: () => shift("previousElementSibling", "before"),
    after: () => shift("nextElementSibling", "after")
  };
  async function shift(dir, put) {
    const el = sel;
    let to = (moved(el) || el)[dir];
    // What a moved part left behind, this one's own included, isn't a place; the copy of one can't be named, so not passed.
    const copy = (n) => { const p = P.pageEdits.part(n); return p && p !== el && box(p).width > 0; };
    while (to && !copy(to) && (to === el || moved(to) || !fit(to))) to = to[dir];
    if (to && copy(to)) { tell("It can't pass a part that was moved. Move that one instead."); return; }
    const at = which.dataset.one, next = to && K.one(to);
    if (!to) { tell("It is already " + (put === "before" ? "first" : "last") + " here. Try a wider part."); return; }
    if (!at || !next) { tell("This part can't be moved. Try a wider one."); return; }
    if (await add({ do: "move", at, to: next, where: put })) setTimeout(() => { if (sel === el) { choose(el); openTool("move"); tool.querySelector("[data-do=" + put + "]").focus(); (moved(el) || el).scrollIntoView({ block: "nearest" }); } }, 150);
  }

  // ---------------------------------------------------------------- wiring
  layer.addEventListener("pointermove", (e) => { over = under(e.clientX, e.clientY); draw(); });
  layer.addEventListener("pointerleave", () => { over = null; draw(); });
  layer.addEventListener("click", (e) => { if (e.isTrusted) { choose(under(e.clientX, e.clientY)); bar.focus(); } });
  layer.addEventListener("contextmenu", (e) => e.preventDefault());
  layer.addEventListener("wheel", (e) => { // the part under the layer scrolls, as it would without it
    if (e.ctrlKey) return;
    for (let el = under(e.clientX, e.clientY); el && el !== document.body; el = el.parentElement) {
      const room = e.deltaY < 0 ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop;
      if (room > 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { el.scrollBy(e.deltaX, e.deltaY); e.preventDefault(); return; }
    }
  }, { passive: false });
  bar.addEventListener("click", (e) => {
    const b = e.isTrusted && e.target.closest("button");
    if (!b) return;
    if (b.dataset.tool) openTool(b.dataset.tool); else ACTS[b.dataset.do]();
  });
  // A color goes to the part it was picked for, once the picking rests or another part is chosen.
  function flush() {
    clearTimeout(wait);
    const c = color;
    color = null;
    if (c) add(c, true);
  }
  function picking(field) {
    const prop = field && field.dataset.color, at = selector();
    if (!prop || !sel) return;
    if (color && color.at !== at) flush();
    color = { do: "style", at, style: { ...(color && color.style), [prop]: field.value } };
    clearTimeout(wait);
    wait = setTimeout(flush, 150);
  }
  which.addEventListener("change", draw);
  // The page's handlers for clicks anywhere don't hear the panel's.
  for (const type of ["click", "dblclick", "auxclick", "contextmenu", "change"]) root.addEventListener(type, (e) => e.stopPropagation());
  // Nor do its shortcuts, focus traps and closing menus hear what is typed or pressed in it. Caught first at the window:
  // only a listener the page put there itself, before the panel opened, comes sooner.
  const TYPING = ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut", "compositionstart", "compositionupdate", "compositionend", "focusin", "focusout",
    "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"];
  function typing(e) {
    if (e.type === "focusout" && e.relatedTarget === host) e.stopImmediatePropagation();
    if (e.target !== host) { if (e.type === "keydown" && e.isTrusted && e.key === "Escape") { e.preventDefault(); close(); } return; }
    e.stopImmediatePropagation();
    if (e.type === "input") picking(root.activeElement);
    if (e.type !== "keydown" || !e.isTrusted || e.isComposing) return;
    const on = root.activeElement;
    if (e.key === "Escape") { e.preventDefault(); if (open) openTool(""); else if (sel) choose(null); else return close(); bar.focus(); return; }
    if (/^Arrow/.test(e.key) && !(on && on.matches("textarea,select,input"))) { e.preventDefault(); step(e.key); }
  }
  function close() {
    flush();
    unwatch();
    cancelAnimationFrame(raf);
    removeEventListener("scroll", draw, true);
    removeEventListener("resize", draw);
    for (const type of TYPING) removeEventListener(type, typing, true);
    document.removeEventListener("polycarp:edits-handover", close);
    host.remove();
    P.editor = null;
  }
  addEventListener("scroll", draw, true);
  addEventListener("resize", draw);
  for (const type of TYPING) addEventListener(type, typing, true);
  document.addEventListener("polycarp:edits-handover", close); // a newer copy of the extension takes over
  P.editor = { close, on: () => host.isConnected && bar.offsetWidth > 0 }; // the dialog it is in may have closed
  where.append(page, new Option("All of " + site, "site"));
  choose(null);
  // All but an open modal dialog is out of reach: the panel goes in it.
  ([...document.querySelectorAll("dialog:modal")].pop() || document.documentElement).append(host);
  $(".top").showPopover();
  bar.focus();
  steps();
  P.getSettings().then((s) => {
    if (s.enabled && !P.paused(s) && s.sites[P.hostOf(location.href)] !== "off") return;
    off = "Polycarp is off here, so changes show once it is on.";
    tell(say.textContent);
  });
  return true;
})();
