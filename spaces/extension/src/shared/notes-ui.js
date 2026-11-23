/* Polycarp notes UI helpers shared by the Reader and the Library: safe rendering of a note's light
   Markdown with [[wiki links]] and #tags, a [[ autocomplete for any textarea, and anchor labels. */
(function () {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function clock(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const two = (n) => String(n).padStart(2, "0");
    return h ? h + ":" + two(m) + ":" + two(s) : m + ":" + two(s);
  }
  function anchorLabel(a) {
    if (!a) return "";
    if (a.page != null && a.page !== "") return "Page " + a.page;
    if (a.time != null && a.time !== "") return clock(a.time);
    if (a.block != null && a.block !== "") return "Paragraph " + (Number(a.block) + 1);
    return "";
  }

  // Inline pieces: [[Title|alias]], #tag, **bold**, *italic*, `code`, bare links. Everything is escaped first.
  function inline(text, resolve) {
    let out = esc(text);
    out = out.replace(/\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g, (m, target, alias) => {
      const t = target.trim();
      const item = resolve ? resolve(t) : null;
      const label = (alias || t).trim();
      return item
        ? '<a class="wl" href="#" data-item="' + esc(item.id) + '" title="' + esc(item.title) + '">' + label + "</a>"
        : '<span class="wl missing" title="Nothing in your library is called ' + t + ' yet">' + label + "</span>";
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    out = out.replace(/(^|\s)(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    out = out.replace(/(^|\s)#([A-Za-z][\w-]{1,40})/g, '$1<span class="ntag">#$2</span>');
    return out;
  }
  // Block structure: paragraphs, "- " bullets and "# " headings.
  function render(text, resolve) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const html = [];
    let list = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) { if (!list) { html.push("<ul>"); list = true; } html.push("<li>" + inline(bullet[1], resolve) + "</li>"); continue; }
      if (list) { html.push("</ul>"); list = false; }
      const head = /^(#{1,3})\s+(.*)$/.exec(line);
      if (head) html.push("<p><b>" + inline(head[2], resolve) + "</b></p>");
      else if (line.trim()) html.push("<p>" + inline(line, resolve) + "</p>");
    }
    if (list) html.push("</ul>");
    return html.join("");
  }

  // Build a resolver from the library's items: exact title first, then a title that starts with it.
  function resolver(items) {
    const exact = new Map(), list = [];
    for (const it of items || []) {
      const t = String(it.title || "").trim().toLowerCase();
      if (!t) continue;
      if (!exact.has(t)) exact.set(t, it);
      list.push([t, it]);
    }
    return (target) => {
      const t = String(target || "").trim().toLowerCase();
      if (!t) return null;
      if (exact.has(t)) return exact.get(t);
      const hit = list.find(([title]) => title.startsWith(t));
      return hit ? hit[1] : null;
    };
  }

  // Typing [[ opens a menu of library titles; Enter or Tab inserts [[Title]].
  function autocomplete(field, getItems) {
    let menu = null, matches = [], pick = 0, start = -1;
    function close() { if (menu) { menu.remove(); menu = null; } start = -1; }
    function open(q) {
      const items = (getItems() || []).filter((it) => it.title);
      const ql = q.toLowerCase();
      matches = items
        .map((it) => ({ it, t: it.title.toLowerCase() }))
        .filter((x) => !ql || x.t.includes(ql))
        .sort((a, b) => (b.t.startsWith(ql) - a.t.startsWith(ql)) || a.t.length - b.t.length)
        .slice(0, 8).map((x) => x.it);
      if (!matches.length) return close();
      if (!menu) {
        menu = document.createElement("ul");
        menu.className = "wl-menu";
        menu.setAttribute("role", "listbox");
        menu.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const li = e.target.closest("li");
          if (li) insert(matches[Number(li.dataset.i)]);
        });
        document.body.appendChild(menu);
      }
      pick = Math.min(pick, matches.length - 1);
      menu.innerHTML = matches.map((it, i) => '<li role="option" data-i="' + i + '" aria-selected="' + (i === pick) + '">' + esc(it.title) + "</li>").join("");
      const r = field.getBoundingClientRect();
      menu.style.left = r.left + scrollX + "px";
      menu.style.top = r.bottom + scrollY + 4 + "px";
      menu.style.minWidth = Math.min(r.width, 320) + "px";
    }
    function insert(it) {
      if (!it || start < 0) return close();
      const v = field.value, end = field.selectionStart;
      const tail = v.slice(end).startsWith("]]") ? v.slice(end + 2) : v.slice(end);
      const ins = "[[" + it.title + "]]";
      field.value = v.slice(0, start) + ins + tail;
      const at = start + ins.length;
      field.setSelectionRange(at, at);
      close();
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    field.addEventListener("input", () => {
      const v = field.value.slice(0, field.selectionStart);
      const i = v.lastIndexOf("[[");
      if (i < 0 || v.indexOf("]]", i) >= 0 || /\n/.test(v.slice(i))) return close();
      start = i;
      open(v.slice(i + 2));
    });
    field.addEventListener("keydown", (e) => {
      if (!menu) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        pick = (pick + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        menu.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", String(i === pick)));
      } else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insert(matches[pick]); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    field.addEventListener("blur", () => setTimeout(close, 120));
    return { close };
  }

  // Find a quote inside an element, tolerant of whitespace differences, and return a DOM Range.
  function findRange(el, quote) {
    const want = String(quote || "").replace(/\s+/g, " ").trim();
    if (!el || !want) return null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let norm = "", map = [], n, space = true;
    while ((n = w.nextNode())) {
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const ws = /\s/.test(v[i]);
        if (ws && space) continue;
        norm += ws ? " " : v[i];
        map.push([n, i]);
        space = ws;
      }
    }
    let at = norm.indexOf(want);
    let len = want.length;
    if (at < 0) {
      const head = want.slice(0, 80);
      at = norm.indexOf(head);
      len = head.length;
    }
    if (at < 0) return null;
    const a = map[at], b = map[at + len - 1];
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1] + 1);
    return r;
  }

  globalThis.PolycarpNotesUI = { esc, clock, anchorLabel, render, inline, resolver, autocomplete, findRange };
})();
