/* Polycarp find panel: search what is on this page (text, headings, links, media) and, on YouTube
   and X, the transcript, comments and posts. Top frame only. Every node holding page text is
   built with DOM calls, never from markup. */
(function () {
  "use strict";
  if (window !== window.top) return;
  const P = globalThis.Polycarp;
  const S = P.sites;
  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  const send = (msg) => (alive() ? chrome.runtime.sendMessage(msg).catch(() => null) : Promise.resolve(null));

  const CSS = `
    :host{all:initial}
    .panel{--bg:var(--pc-surface);--ink:var(--pc-foreground);--muted:var(--pc-muted);--line:var(--pc-border);--sunk:var(--pc-sunken);--accent:var(--pc-accent);--mark:color-mix(in srgb,var(--pc-working) 40%,transparent);--markInk:var(--pc-strong);
      position:fixed;top:12px;right:12px;z-index:2147483647;width:min(440px,calc(100vw - 24px));max-height:min(680px,calc(100vh - 24px));
      display:flex;flex-direction:column;background:var(--bg);color:var(--ink);border:var(--pc-border-width) solid var(--line);border-radius:var(--pc-radius-large);
      box-shadow:0 12px 40px color-mix(in srgb,var(--pc-strong) calc(var(--pc-shadow) * 180%),transparent);font:var(--pc-font-weight) 15px/1.45 var(--pc-font-ui);overflow:hidden}
    button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
    button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .head{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;border-bottom:1px solid var(--line)}
    .head svg{flex:none;color:var(--muted)}
    input{flex:1;min-width:0;height:40px;border:0;background:none;color:var(--ink);font:inherit;font-size:17px}
    input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;width:16px;height:16px;cursor:pointer;background:var(--muted);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M18 6 6 18M6 6l12 12'/%3E%3C/svg%3E") center/contain no-repeat}
    input::placeholder{color:var(--muted)}
    input:focus-visible{outline:none}
    .icon{flex:none;width:36px;height:36px;border-radius:var(--pc-radius-small);display:grid;place-items:center;color:var(--muted)}
    .icon:hover{background:var(--sunk);color:var(--ink)}
    .chips{display:flex;gap:4px;padding:8px 32px 8px 12px;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--line);-webkit-mask-image:linear-gradient(90deg,var(--ink) calc(100% - 32px),transparent);mask-image:linear-gradient(90deg,var(--ink) calc(100% - 32px),transparent)}
    .chip{flex:none;height:32px;padding:0 12px;border-radius:calc(var(--pc-radius-large) * 100);font-size:13px;font-weight:600;color:var(--muted);white-space:nowrap}
    .chip:hover{color:var(--ink);background:var(--sunk)}
    .chip[aria-pressed=true]{background:var(--ink);color:var(--bg)}
    .chip small{font-weight:500;opacity:.8;margin-left:4px}
    .acts{display:flex;flex-wrap:wrap;gap:8px;padding:8px 12px 0}
    .act{height:32px;padding:0 12px;border-radius:var(--pc-radius-small);font-size:13px;font-weight:600;border:1px solid var(--line)}
    .act:hover{background:var(--sunk)}
    .list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;margin:0;padding:8px;list-style:none}
    .row{display:flex;align-items:stretch;border-radius:var(--pc-radius-small)}
    .row:hover,.row.on{background:var(--sunk)}
    .go{flex:1;min-width:0;text-align:left;padding:8px;display:flex;gap:12px;align-items:flex-start;border-radius:var(--pc-radius-small)}
    .go .t{min-width:0;flex:1}
    .k{display:block;font-size:12px;color:var(--muted);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .x{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;overflow-wrap:anywhere}
    .lv2 .x{padding-left:12px}.lv3 .x{padding-left:24px}.lv4 .x,.lv5 .x,.lv6 .x{padding-left:36px}
    .lv1 .x,.lv2 .x{font-weight:650}
    .warn{color:var(--accent);font-weight:600}
    mark{background:var(--mark);color:var(--markInk);border-radius:var(--pc-radius-small)}
    .thumb{flex:none;width:48px;height:48px;border-radius:var(--pc-radius-small);object-fit:cover;background:var(--sunk)}
    .mem{flex:none;align-self:center;width:36px;height:36px;margin-right:4px;border-radius:var(--pc-radius-small);display:grid;place-items:center;color:var(--muted);opacity:0}
    .row:hover .mem,.row.on .mem,.mem:focus-visible{opacity:1}
    .mem:hover{color:var(--accent);background:var(--bg)}
    .empty{padding:16px 12px;color:var(--muted);font-size:14px}
    .foot{display:flex;justify-content:space-between;gap:12px;padding:8px 16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
    .menu{position:absolute;z-index:2;top:52px;right:8px;width:250px;padding:8px;border-radius:var(--pc-radius);background:var(--bg);border:1px solid var(--line);box-shadow:0 8px 24px color-mix(in srgb,var(--pc-strong) calc(var(--pc-shadow) * 150%),transparent);display:none}
    .menu.open{display:block}
    .menu button{display:block;width:100%;text-align:left;padding:8px 12px;border-radius:var(--pc-radius-small);font-size:14px}
    .menu button:hover{background:var(--sunk)}
    .menu hr{border:0;border-top:1px solid var(--line);margin:4px 0}
    .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
    @media (pointer:coarse){.mem{opacity:1}}
    @media (max-width:560px){.panel{top:auto;bottom:0;right:0;left:0;width:100%;max-height:75vh;border-radius:var(--pc-radius-large) var(--pc-radius-large) 0 0}.foot .keys{display:none}}
  `;
  const ICON = {
    search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    seed: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22V12"/><path d="M12 12C12 7 8 4 3 4c0 5 4 8 9 8z"/><path d="M12 12c0-4 3-7 8-7 0 4-3 7-8 7z"/></svg>'
  };
  // Static markup only: none of these strings carry page text.
  function svg(html) { const t = document.createElement("template"); t.innerHTML = html; return t.content.firstChild; }

  let F = null; // open panel state

  function pageDark() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
      return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.45;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // Fold text for matching and keep a map back to the original characters for highlights.
  function foldMap(s) {
    let out = "";
    const map = [];
    for (let i = 0; i < s.length; i++) {
      const f = s[i].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      for (let k = 0; k < f.length; k++) { out += f[k]; map.push(i); }
    }
    return { out, map };
  }
  function terms(q) { return S.fold(q).split(" ").filter(Boolean); }

  function buildGroups() {
    const g = [];
    const site = F.site;
    for (const sg of F.siteGroups) {
      if (sg.refresh) sg.items = sg.refresh();
      g.push(sg);
    }
    const gen = S.generic;
    g.push({ id: "headings", label: "Headings", items: gen.headings() });
    g.push({ id: "links", label: "Links", items: gen.links() });
    g.push({ id: "media", label: "Media", items: gen.media() });
    if (!site || !site.noText) g.push({ id: "text", label: "Page text", items: gen.blocks() });
    for (const grp of g) for (const it of grp.items) if (!it.f) it.f = S.fold(it.text + " " + (it.meta || "") + " " + (it.extra || ""));
    F.groups = g;
    F.builtAt = Date.now();
  }

  function results() {
    const q = terms(F.input.value);
    const pick = F.group === "all" ? F.groups : F.groups.filter((g) => g.id === F.group);
    const out = [];
    const seen = new Set(); // in All, one row per element: a heading is not listed again as page text
    for (const grp of pick) {
      if (!q.length && F.group === "all") continue;
      for (const it of grp.items) {
        if (q.length && !q.every((t) => it.f.includes(t))) continue;
        if (F.group === "all" && it.el) { if (seen.has(it.el)) continue; seen.add(it.el); }
        out.push(it);
        if (out.length >= 400) return out;
      }
    }
    return out;
  }

  function highlight(parent, text, q) {
    let show = text;
    if (q.length && text.length > 240) {
      const { out } = foldMap(text);
      const at = out.indexOf(q[0]);
      if (at > 80) show = "..." + text.slice(Math.max(0, at - 60));
    }
    if (!q.length) { parent.textContent = show; return; }
    const { out, map } = foldMap(show);
    const marks = [];
    for (const t of q) {
      let i = out.indexOf(t);
      while (i >= 0 && marks.length < 40) { marks.push([map[i], map[i + t.length - 1] + 1]); i = out.indexOf(t, i + t.length); }
    }
    marks.sort((a, b) => a[0] - b[0]);
    let last = 0;
    for (const [a, b] of marks) {
      if (a < last) continue;
      if (a > last) parent.appendChild(document.createTextNode(show.slice(last, a)));
      const m = document.createElement("mark");
      m.textContent = show.slice(a, b);
      parent.appendChild(m);
      last = b;
    }
    if (last < show.length) parent.appendChild(document.createTextNode(show.slice(last)));
  }

  const LABEL = { transcript: "Transcript", description: "Description", comments: "Comment", posts: "Post", videos: "Video", headings: "Heading", links: "Link", media: "", text: "" };

  function render() {
    const q = terms(F.input.value);
    // Chips with live counts
    F.chips.textContent = "";
    const chip = (id, label, n, loading) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.setAttribute("aria-pressed", String(F.group === id));
      b.textContent = label;
      if (n != null || loading) { const s = document.createElement("small"); s.textContent = loading ? "..." : String(n); b.appendChild(s); }
      b.addEventListener("click", () => { F.group = id; render(); F.input.focus(); });
      F.chips.appendChild(b);
    };
    chip("all", "All");
    for (const g of F.groups) {
      const n = q.length ? g.items.filter((it) => q.every((t) => it.f.includes(t))).length : g.items.length;
      if (!g.items.length && !g.loading && g.id !== F.group) continue;
      chip(g.id, g.label, n, g.loading);
    }

    const list = results();
    F.list.textContent = "";
    F.rows = [];
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "empty";
      const grp = F.groups.find((g) => g.id === F.group);
      li.textContent = grp && grp.loading ? "Loading " + grp.label.toLowerCase() + "..." :
        !q.length && F.group === "all" ? F.hint :
        q.length ? "Nothing matches. Try fewer or shorter words." : "Nothing here on this page.";
      F.list.appendChild(li);
    }
    for (const it of list) {
      const li = document.createElement("li");
      li.className = "row" + (it.level ? " lv" + it.level : "");
      const go = document.createElement("button");
      go.type = "button";
      go.className = "go";
      if (it.thumb) {
        const img = document.createElement("img");
        img.className = "thumb"; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
        img.src = it.thumb;
        go.appendChild(img);
      }
      const t = document.createElement("span");
      t.className = "t";
      const k = document.createElement("span");
      k.className = "k";
      const label = F.group === "all" ? LABEL[it.group] : "";
      k.textContent = [label, it.meta].filter(Boolean).join(" · ");
      if (it.missing) k.classList.add("warn");
      if (k.textContent) t.appendChild(k);
      const x = document.createElement("span");
      x.className = "x";
      highlight(x, it.text, q);
      t.appendChild(x);
      go.appendChild(t);
      go.addEventListener("click", () => jump(it));
      li.appendChild(go);
      if (/^(text|transcript|comments|posts|description)$/.test(it.group)) {
        const mem = document.createElement("button");
        mem.type = "button";
        mem.className = "mem";
        mem.title = "Remember this";
        mem.setAttribute("aria-label", "Remember this");
        mem.appendChild(svg(ICON.seed));
        mem.addEventListener("click", () => remember(it, mem));
        li.appendChild(mem);
      }
      F.list.appendChild(li);
      F.rows.push(go);
    }
    F.count.textContent = q.length || F.group !== "all" ? (list.length >= 400 ? "400+ results" : list.length + (list.length === 1 ? " result" : " results")) : "";
  }

  // ---------- Actions ----------
  let flashT = 0;
  function flash(el) {
    if (!el || !el.isConnected) return;
    const prev = [el.style.outline, el.style.outlineOffset, el.style.borderRadius];
    el.style.outline = "3px solid " + (findTheme.accent || "currentColor");
    el.style.outlineOffset = "4px";
    clearTimeout(flashT);
    flashT = setTimeout(() => { el.style.outline = prev[0]; el.style.outlineOffset = prev[1]; }, 1800);
    const q = terms(F ? F.input.value : "");
    if (!q.length || !globalThis.CSS || !CSS.highlights || typeof Highlight !== "function") return;
    // Mark the matched words inside the target, across Polycarp's bold-anchor pieces.
    const nodes = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n, text = "";
    while ((n = w.nextNode())) { nodes.push([n, text.length]); text += n.nodeValue; }
    const { out, map } = foldMap(text);
    const ranges = [];
    const at = (pos) => { let lo = 0; for (let i = 0; i < nodes.length; i++) if (nodes[i][1] <= pos) lo = i; return [nodes[lo][0], pos - nodes[lo][1]]; };
    for (const t of q) {
      let i = out.indexOf(t);
      while (i >= 0 && ranges.length < 50) {
        const r = document.createRange();
        const [sn, so] = at(map[i]);
        const [en, eo] = at(map[i + t.length - 1]);
        try { r.setStart(sn, so); r.setEnd(en, eo + 1); ranges.push(r); } catch (e) { /* skip */ }
        i = out.indexOf(t, i + t.length);
      }
    }
    if (!ensureHighlightCss()) return;
    CSS.highlights.set("polycarp-find", new Highlight(...ranges));
  }
  let hlSheet = null;
  function ensureHighlightCss() {
    if (hlSheet) return true;
    try {
      hlSheet = new CSSStyleSheet();
      hlSheet.replaceSync("::highlight(polycarp-find){background-color:color-mix(in srgb," + (findTheme.working || "currentColor") + " 45%,transparent);color:inherit}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, hlSheet];
      return true;
    } catch (e) { return false; }
  }

  function jump(it) {
    if (it.t != null && F.site && F.site.seek && F.site.seek(it.t)) { if (it.el && it.el.isConnected) flash(it.el); return; }
    if (it.el && it.el.isConnected) {
      it.el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      flash(it.el);
      if (it.group === "links") { try { it.el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
      return;
    }
    if (it.url) location.assign(it.url);
  }

  async function remember(it, btn) {
    let url = it.url || "";
    if (it.group === "transcript" && F.site && F.site.url) url = F.site.url(it.t);
    else if (it.group === "posts" && it.post) url = it.post.url;
    else if (!url) url = (F.site || S.generic).where(it.el, it.text);
    const text = it.group === "posts" && it.post ? it.post.text : it.text;
    const r = await send({ type: "polycarp:remember", text, url, title: document.title });
    btn.title = r && r.ok ? "Saved to your memory garden" : "Could not save this";
    btn.setAttribute("aria-label", btn.title);
    btn.style.color = r && r.ok ? "var(--accent)" : "";
    F.live.textContent = btn.title;
  }

  // ---------- Keys: keep typing away from the site's own shortcuts ----------
  function inPanel(e) { return F && e.composedPath().includes(F.host); }
  function guard(e) {
    if (!inPanel(e)) {
      if (e.type === "keydown" && e.key === "Escape" && F && F.host.matches(":focus-within")) close();
      return;
    }
    e.stopImmediatePropagation();
    if (e.type !== "keydown") return;
    const active = F.root.activeElement;
    if (e.key === "Escape") { e.preventDefault(); if (F.menu.classList.contains("open")) F.menu.classList.remove("open"); else close(); return; }
    const i = F.rows.indexOf(active);
    if (e.key === "ArrowDown") { e.preventDefault(); const r = F.rows[Math.min(F.rows.length - 1, i + 1)]; if (r) r.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) F.input.focus(); else F.rows[i - 1].focus(); }
    else if (e.key === "Enter" && active === F.input) { e.preventDefault(); if (F.rows[0]) F.rows[0].click(); }
  }

  // ---------- Open and close ----------
  let findTheme = {};
  async function open(opts) {
    const themeText = await P.themeCss();
    if (F) { F.input.focus(); F.input.select(); return; }
    findTheme = P.themeVars(themeText, pageDark() ? "dark" : "light");
    opts = opts || {};
    const site = S.siteFor(location.hostname);
    const host = document.createElement("polycarp-find");
    host.setAttribute("data-polycarp-skip", "");
    const root = host.attachShadow({ mode: "closed" });
    const themeStyle = document.createElement("style");
    themeStyle.textContent = P.shadowThemeCss(themeText);
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(themeStyle, style);
    const panel = document.createElement("div");
    panel.className = "panel " + (pageDark() ? "pc-dark" : "pc-light");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Search this page with Polycarp");
    root.appendChild(panel);

    const head = document.createElement("div");
    head.className = "head";
    head.appendChild(svg(ICON.search));
    const input = document.createElement("input");
    input.type = "search";
    input.setAttribute("aria-label", "Search this page");
    input.placeholder = site === S.youtube && S.youtube.isWatch() ? "Search the transcript, comments and page" :
      site === S.x ? "Search posts you've seen in this tab" : "Search this page";
    input.autocomplete = "off";
    input.spellcheck = false;
    head.appendChild(input);
    const moreBtn = document.createElement("button");
    moreBtn.className = "icon"; moreBtn.type = "button"; moreBtn.title = "Polycarp options for this site";
    moreBtn.setAttribute("aria-label", "Polycarp options for this site");
    moreBtn.setAttribute("aria-haspopup", "true");
    moreBtn.appendChild(svg(ICON.more));
    head.appendChild(moreBtn);
    const closeBtn = document.createElement("button");
    closeBtn.className = "icon"; closeBtn.type = "button"; closeBtn.title = "Close (Esc)";
    closeBtn.setAttribute("aria-label", "Close search");
    closeBtn.appendChild(svg(ICON.close));
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const menu = document.createElement("div");
    menu.className = "menu";
    panel.appendChild(menu);

    const chips = document.createElement("div");
    chips.className = "chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "What to search");
    panel.appendChild(chips);

    const acts = document.createElement("div");
    acts.className = "acts";
    panel.appendChild(acts);

    const list = document.createElement("ul");
    list.className = "list";
    list.setAttribute("aria-label", "Results");
    panel.appendChild(list);

    const foot = document.createElement("div");
    foot.className = "foot";
    const count = document.createElement("span");
    count.setAttribute("aria-live", "polite");
    const keys = document.createElement("span");
    keys.className = "keys";
    keys.textContent = "Arrows to move · Enter to go · Esc to close";
    foot.append(count, keys);
    panel.appendChild(foot);
    const live = document.createElement("div");
    live.className = "sr"; live.setAttribute("aria-live", "polite");
    panel.appendChild(live);

    document.documentElement.appendChild(host);
    F = { host, root, panel, input, chips, list, count, live, menu, site, group: opts.group || "all", rows: [], groups: [], siteGroups: [], back: document.activeElement };
    F.hint = site === S.youtube && S.youtube.isWatch() ? "Type to search what is said in this video, its description and the comments. Pick Transcript to read along." :
      site === S.x ? "Type to search every post you've scrolled past in this tab, even ones X has unloaded." :
      "Type to search this page. Pick Headings for an outline, Links for every link, or Media for images and video.";

    for (const ev of ["keydown", "keyup", "keypress"]) addEventListener(ev, guard, true);
    closeBtn.addEventListener("click", close);
    moreBtn.addEventListener("click", () => { buildMenu(); menu.classList.toggle("open"); });
    let t = 0;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { if (Date.now() - F.builtAt > 2500) buildGroups(); render(); }, 120);
    });

    // Site actions
    const actions = (site && site.actions ? site.actions() : []).concat(site ? [] : [{ id: "read", label: "Open page in Reader" }]);
    for (const a of actions) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "act"; b.textContent = a.label;
      b.addEventListener("click", () => { send({ type: "polycarp:readTab" }); close(); });
      acts.appendChild(b);
    }
    if (!actions.length) acts.remove();

    if (site && site.sources) F.siteGroups = await site.sources(() => { if (F) { buildGroups(); render(); } });
    if (!F) return;
    buildGroups();
    if (opts.group && !F.groups.some((g) => g.id === opts.group)) F.group = "all";
    if (opts.query) input.value = opts.query;
    render();
    input.focus();
  }

  async function buildMenu() {
    const menu = F.menu;
    menu.textContent = "";
    const item = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      b.addEventListener("click", async () => { menu.classList.remove("open"); await fn(); });
      menu.appendChild(b);
    };
    const on = P.contentState ? P.contentState().active : true;
    item(on ? "Turn Polycarp off on " + location.hostname : "Turn Polycarp on for " + location.hostname, () => send({ type: "polycarp:toggleSite" }));
    item("Pause Polycarp everywhere for 1 hour", () => send({ type: "polycarp:pause", minutes: 60 }));
    item("Pause until tomorrow", () => send({ type: "polycarp:pause", until: "tomorrow" }));
    menu.appendChild(document.createElement("hr"));
    item("All Polycarp settings", () => send({ type: "polycarp:openSettings" }));
  }

  function close() {
    if (!F) return;
    for (const ev of ["keydown", "keyup", "keypress"]) removeEventListener(ev, guard, true);
    try { CSS.highlights && CSS.highlights.delete("polycarp-find"); } catch (e) { /* none */ }
    const back = F.back;
    F.host.remove();
    F = null;
    if (back && back.focus) try { back.focus({ preventScroll: true }); } catch (e) { /* gone */ }
  }

  P.finder = { open, close, toggle: (o) => (F ? close() : open(o)), isOpen: () => !!F };
})();
