/* What a person shares with their agents when they press "Share with my agent": the parts of the page, each with the
   selector that names it and its first words, so an agent can write an edit for a page it can't see. Run in the page on
   that press only. Nothing a person typed is in it: form fields and editors are left out, and so are parts that don't
   show. The app checks it again (SharedPage.swift). */
(function () {
  "use strict";
  const E = globalThis.PolycarpEdits, K = globalThis.PolycarpEditsPick;
  const MAX = { parts: 250, looked: 6000, words: 160, bytes: 180000 };
  const SKIP = ["script,style,noscript,template,link,meta,head,iframe,object,embed,svg *,br,wbr,hr,source,track", E.OURS].join(",");
  // Where a person types, code editors that draw the typed text themselves included.
  const TYPED = "input,textarea,select,option,datalist,output,[role=searchbox],[role=combobox],[role=spinbutton],.monaco-editor,.CodeMirror,.cm-editor,.ace_editor," + E.EDITORS.join(",");
  const NAMED = "main,header,footer,nav,aside,section,article,form,h1,h2,h3,h4,h5,h6,ul,ol,table,figure,img,picture,video,button,dialog,[id],[role],[aria-label],[data-testid],[data-test],[data-qa]";
  const ALIKE = 3; // this many neighbours of one shape are shown as one part with a count

  const getKids = Object.getOwnPropertyDescriptor(Element.prototype, "children").get; // a form's field named "children" hides its own
  const kids = (el) => [...getKids.call(el)];
  const hollow = (s) => s.display === "contents"; // no box of its own, though what is in it shows
  function shows(el) {
    const s = getComputedStyle(el);
    if (hollow(s)) return true;
    if (!el.getClientRects().length || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const b = el.getBoundingClientRect(), shut = /hidden|clip/.test(s.overflow) && (b.width <= 1 || b.height <= 1);
    return !shut && b.right + scrollX > 0 && b.bottom + scrollY > 0; // drawn, but shut or off the page, where no one sees it
  }
  // Parts with a name of their own aren't alike. One with digits is likely a number in a list.
  const own = (el) => (el.id && !/\d/.test(el.id) ? "#" + el.id : "") + (el.matches("section,nav,aside,form") ? el.getAttribute("aria-label") || "" : "");
  const shape = (el) => el.localName + own(el) + "." + [...el.classList].sort().join(".") + "[" + (el.getAttribute("role") || "") + (el.getAttribute("data-testid") || "") + "]";
  // Cut between characters, not inside one.
  const cut = (s, most) => [...s.slice(0, most)].filter((c) => !/^[\uD800-\uDFFF]$/.test(c)).join("");
  let mirrors = new Set(); // what an editor draws of a field's typed words, beside the field
  const skip = (el) => el.matches(SKIP) || el.matches(TYPED) || mirrors.has(el) || !shows(el);
  // Its nearest part that isn't in a line of text: words in one run together, as they're drawn.
  function block(el) {
    while (el.parentElement && /^(inline$|contents$|ruby)/.test(getComputedStyle(el).display)) el = el.parentElement;
    return el;
  }
  // The words in it that a person didn't type, from its start.
  function words(el) {
    const doc = el.ownerDocument;
    let out = "", looked = 0, last = null;
    const walk = doc.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (n) =>
      n.nodeType === 1 ? (skip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT);
    for (let n = walk.nextNode(); n && out.length < MAX.words && looked < 400; n = walk.nextNode(), looked++) {
      const b = block(n.parentElement);
      out = (out + (b === last ? "" : " ") + n.data.slice(0, 400)).replace(/\s+/g, " ").trimStart();
      last = b;
    }
    out = out.trim() || (el.getAttribute("alt") || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    return cut(out, MAX.words);
  }
  // Reading aids wrap a line's words in Polycarp's own elements: they're the part's words, not parts of the page.
  const ours = (n) => n.nodeType === 1 && n.localName.startsWith("polycarp-");
  const holds = (el) => [...el.childNodes].some((n) => (n.nodeType === 3 || ours(n)) && n.textContent.trim());

  function outline(doc) {
    const parts = [], seen = new Set();
    const size = new TextEncoder();
    mirrors = new Set([...doc.querySelectorAll("textarea")].filter((t) => t.value.trim() && t.parentElement).flatMap((t) => kids(t.parentElement).filter((el) => el !== t && el.textContent.includes(t.value.trim().split("\n")[0]))));
    let bytes = 0, looked = 0;
    // A page that is one big editor is all typed text.
    const queue = doc.body && doc.designMode !== "on" && !doc.documentElement.matches(TYPED) && !doc.body.matches(TYPED) ? [doc.body] : [];
    while (queue.length && parts.length < MAX.parts && looked < MAX.looked) {
      const up = queue.shift();
      const alike = new Map();
      for (const el of kids(up)) alike.set(shape(el), (alike.get(shape(el)) || 0) + 1);
      const shown = new Map();
      for (const el of kids(up)) {
        if (++looked > MAX.looked || parts.length >= MAX.parts) break;
        if (ours(el) || skip(el)) continue;
        const kind = shape(el);
        if (shown.has(kind) && el.matches(shown.get(kind))) continue; // the first of them stands for the rest
        queue.push(el);
        if (hollow(getComputedStyle(el))) continue;
        const like = alike.get(kind) >= ALIKE ? K.like(el) : "";
        if (like) shown.set(kind, like);
        else if (!el.matches(NAMED) && !holds(el)) continue;
        const at = like || K.one(el);
        if (!at || seen.has(at)) continue;
        seen.add(at);
        const part = { at, is: K.name(el) }, n = K.count(doc, at), w = words(el);
        if (w) part.words = w;
        if (n > 1) part.count = n;
        bytes += size.encode(JSON.stringify(part)).length;
        if (bytes > MAX.bytes) return parts;
        parts.push(part);
      }
    }
    return parts;
  }
  // The page as the app takes it, with what its agents' edits found here.
  function page(doc, report) {
    const at = new URL(doc.location.href);
    return {
      url: at.origin + at.pathname,
      title: cut(String(doc.title || ""), 300),
      parts: outline(doc),
      edits: (report || []).filter((e) => e.source === "app").map((e) => ({ id: e.id, hits: e.changes.map((c) => c.hits) }))
    };
  }
  globalThis.PolycarpEditsOutline = { page, outline };
})();
