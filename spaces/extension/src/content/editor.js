/* Change this page by hand: point at a part, then hide, reword, restyle, move it or leave a note by it. Put on the page
   when asked for (popup, menu, shortcut), and again to close. Every change is a page edit kept in this browser
   (src/shared/edits-store.js), which src/content/edits.js applies: nothing here changes the page itself.
   A clear layer over the page takes the pointer, so the page hears no click meant for the editor. */
(function () {
  "use strict";
  const P = globalThis.Polycarp, E = globalThis.PolycarpEdits, S = globalThis.PolycarpEditsStore, K = globalThis.PolycarpEditsPick;
  if (P.editor) { const on = P.editor.on(); P.editor.close(); if (on) return; } // a page may have taken it away
  const site = E.site(location.hostname);
  if (!site || !P.pageEdits) return;
  const STAYS = E.EDITORS + "," + E.CARRY; // what may not be moved, nor be in what is

  const CSS_TEXT = `
    :host{all:initial !important;display:contents !important}
    *{box-sizing:border-box} [hidden]{display:none !important}
    /* In the top layer: over the page, and out of reach of its transforms. */
    .top{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none}
    .layer{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;touch-action:none}
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
  let sel = null, open = "", raf = 0, over = null, history = [];
  P.themeCss().then((css) => { $("style").textContent = P.shadowThemeCss(css) + CSS_TEXT; });

  // ---------------------------------------------------------------- pointing
  const ours = (el) => !!el.closest(E.OURS);
  const moved = (el) => P.pageEdits.shown(el);
  const box = (el) => { const m = moved(el); return ((m && m.firstElementChild) || el).getBoundingClientRect(); };
  const fit = (el) => !!el && el.nodeType === 1 && !/^(HTML|BODY|HEAD|SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(el.tagName) && !ours(el) && box(el).width > 0;
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
      if (which.value === "all") for (const el of document.querySelectorAll(selector())) if (el !== sel && at.length < 100) at.push([el, "mark like"]);
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
  function choose(el) {
    sel = el;
    over = null;
    tools.hidden = scope.hidden = !el;
    openTool("");
    say.textContent = "";
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
    if (!one && !like) { tools.querySelectorAll("[data-tool],[data-do=hide]").forEach((b) => { b.disabled = true; }); say.textContent = "This part can't be named. Try a wider one."; } else tools.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    draw();
  }
  const selector = () => which.dataset[which.value] || "";
  function step(key) {
    const next = (el, dir) => { do el = el[dir]; while (el && !fit(el)); return el; };
    if (!sel) return choose([...document.body.children].find(fit) || null);
    const to = key === "ArrowUp" ? sel.parentElement : key === "ArrowDown" ? [...sel.children].find(fit) : next(sel, key === "ArrowLeft" ? "previousElementSibling" : "nextElementSibling");
    if (fit(to)) { choose(to); (moved(to) || to).scrollIntoView({ block: "nearest" }); }
  }

  // ---------------------------------------------------------------- changing
  const hash = (s) => { let h = 5381; for (const c of s) h = (Math.imul(h, 33) ^ c.codePointAt(0)) >>> 0; return h.toString(36); };
  function draft() {
    const path = where.value === "page" ? (location.pathname.length > 180 ? location.pathname.slice(0, 180) + "*" : location.pathname) : "";
    return { id: "mine-" + hash(site + " " + path), name: ("My changes on " + site + path).slice(0, 80), sites: [site], paths: path ? [path] : [], changes: [], css: "" };
  }
  // One at a time: each starts from what the one before it kept.
  let last = Promise.resolve();
  const turn = (act) => (last = last.then(act).catch(() => {
    say.textContent = "Not changed: this browser could not save it.";
    P.pageEdits.apply(); // with the extension gone, this takes the edits back
    return false;
  }));
  // Adds one change; one that only adjusts the change before it takes its place.
  async function keep(change) {
    if (!sel || !sel.isConnected) { choose(null); say.textContent = "That part is gone from the page."; return false; }
    const base = draft();
    const before = (await S.load()).edits.find((e) => e.source === "local" && e.id === base.id) || null;
    const next = before ? { ...before, enabled: true, changes: before.changes.slice() } : base;
    delete next.source;
    if (change.do === "move") next.changes = next.changes.filter((c) => c.do !== "move" || c.at !== change.at);
    const same = next.changes[next.changes.length - 1];
    if (same && same.do === change.do && same.at === change.at && (change.do === "style" || change.do === "text")) {
      next.changes[next.changes.length - 1] = change.do === "style" ? { ...same, style: { ...same.style, ...change.style } } : change;
    } else next.changes.push(change);
    const why = await S.put(base.id, next);
    say.textContent = why ? "Not changed: " + why + "." : "";
    if (why) return false;
    if (before) delete before.source;
    history.push({ id: base.id, before });
    $("[data-do=undo]").disabled = false;
    setTimeout(draw, 120);
    return true;
  }
  const add = (change) => turn(() => keep(change));
  const undo = () => turn(async () => {
    const h = history[history.length - 1];
    if (!h) return;
    await S.put(h.id, h.before);
    history.pop();
    $("[data-do=undo]").disabled = !history.length;
    say.textContent = "Taken back.";
    setTimeout(draw, 120);
  });

  const px = (v) => parseFloat(v) || 16;
  const hex = (v) => { const m = (v.match(/[\d.]+/g) || []).map(Number); return m.length >= 3 && m[3] !== 0 ? "#" + m.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("") : ""; };
  // The color seen behind a part: its own, or the nearest one around it.
  const behind = (el) => { for (; el; el = el.parentElement) { const h = hex(getComputedStyle(el).backgroundColor); if (h) return h; } return ""; };
  const TOOLS = {
    text() {
      if (sel.isContentEditable || sel.querySelector(STAYS + ",video,audio,canvas") || sel.matches(E.NEVER + ",img,video,audio,canvas")) { tool.textContent = "Choose a smaller part, one that holds only words."; return; }
      tool.innerHTML = '<textarea aria-label="Words"></textarea><div class="row"><button class="main" data-do="text">Change words</button></div>';
      tool.querySelector("textarea").value = sel.textContent.trim().replace(/\s+/g, " ").slice(0, E.MAX.text);
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
    tool.textContent = "";
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
      if (!blocks.length) { say.textContent = "Write the note first."; return; }
      if (moved(sel)) { say.textContent = "This part was moved. Leave the note by another one."; return; }
      if (await add({ do: "insert", at: which.dataset.one || selector(), where: "after", blocks })) openTool("");
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
    while (to && !fit(to)) to = to[dir];
    const at = which.dataset.one, next = to && K.one(to);
    if (!to) { say.textContent = put === "before" ? "It is already first here. Try a wider part." : "It is already last here. Try a wider part."; return; }
    if (sel.matches(STAYS) || sel.querySelector(STAYS)) { say.textContent = "It holds a button or a field, so it stays where it is."; return; }
    if (!at || !next) { say.textContent = "This part can't be moved. Try a wider one."; return; }
    if (await add({ do: "move", at, to: next, where: put })) setTimeout(() => { if (sel === el) { choose(el); openTool("move"); tool.querySelector("[data-do=" + put + "]").focus(); (moved(el) || el).scrollIntoView({ block: "nearest" }); } }, 150);
  }

  // ---------------------------------------------------------------- wiring
  layer.addEventListener("pointermove", (e) => { over = under(e.clientX, e.clientY); draw(); });
  layer.addEventListener("pointerleave", () => { over = null; draw(); });
  layer.addEventListener("click", (e) => { if (e.isTrusted) { choose(under(e.clientX, e.clientY)); bar.focus(); } });
  layer.addEventListener("contextmenu", (e) => e.preventDefault());
  layer.addEventListener("wheel", (e) => { // the part under the layer scrolls, as it would without it
    for (let el = under(e.clientX, e.clientY); el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY) && el !== document.body) { el.scrollBy(e.deltaX, e.deltaY); e.preventDefault(); return; }
    }
  }, { passive: false });
  bar.addEventListener("click", (e) => {
    const b = e.isTrusted && e.target.closest("button");
    if (!b) return;
    if (b.dataset.tool) openTool(b.dataset.tool); else ACTS[b.dataset.do]();
  });
  let wait = 0;
  bar.addEventListener("input", (e) => {
    const prop = e.target.dataset.color, v = e.target.value;
    if (!prop || !sel) return;
    clearTimeout(wait);
    wait = setTimeout(() => add({ do: "style", at: selector(), style: { [prop]: v } }), 150);
  });
  which.addEventListener("change", draw);
  // Nor do its handlers for clicks anywhere, such as those that close a menu.
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "touchstart", "touchend"]) root.addEventListener(type, (e) => e.stopPropagation());
  // The page's own shortcuts don't fire on keys typed in the editor.
  for (const type of ["keydown", "keyup", "keypress"]) root.addEventListener(type, (e) => {
    e.stopPropagation();
    if (type !== "keydown" || !e.isTrusted) return;
    if (e.key === "Escape") { e.preventDefault(); if (open) openTool(""); else if (sel) choose(null); else close(); bar.focus(); return; }
    if (/^Arrow/.test(e.key) && !e.target.matches("textarea,select,input")) { e.preventDefault(); step(e.key); }
  });
  function escape(e) { if (e.isTrusted && e.key === "Escape" && e.target !== host) { e.preventDefault(); close(); } }
  function close() {
    cancelAnimationFrame(raf);
    removeEventListener("scroll", draw, true);
    removeEventListener("resize", draw);
    removeEventListener("keydown", escape, true);
    host.remove();
    P.editor = null;
  }
  addEventListener("scroll", draw, true);
  addEventListener("resize", draw);
  addEventListener("keydown", escape, true);
  P.editor = { close, on: () => host.isConnected };
  where.append(new Option("This page", "page"), new Option("All of " + site, "site"));
  choose(null);
  document.documentElement.append(host);
  $(".top").showPopover();
  bar.focus();
  P.getSettings().then((s) => {
    if (!s.enabled || P.paused(s) || s.sites[P.hostOf(location.href)] === "off") say.textContent = "Polycarp is off here, so changes show once it is on.";
  });
})();
