/* Naming a part of a page: a CSS selector that finds it again tomorrow, and one for every part like it. */
(function () {
  "use strict";
  const E = globalThis.PolycarpEdits;
  const NAMES = { H1: "Heading", H2: "Heading", H3: "Heading", H4: "Heading", H5: "Heading", H6: "Heading", P: "Paragraph", A: "Link", IMG: "Picture", PICTURE: "Picture", SVG: "Picture",
    VIDEO: "Video", NAV: "Navigation", ASIDE: "Sidebar", HEADER: "Header", FOOTER: "Footer", MAIN: "Main part", SECTION: "Section", ARTICLE: "Article", UL: "List", OL: "List", LI: "List item",
    BUTTON: "Button", FORM: "Form", INPUT: "Field", TEXTAREA: "Field", SELECT: "Field", TABLE: "Table", TR: "Row", TD: "Cell", TH: "Cell", IFRAME: "Frame", FIGURE: "Figure", BLOCKQUOTE: "Quote" };
  const name = (el) => NAMES[el.tagName.toUpperCase()] || "Part";
  // Names a build made up (css-1x2y3z, sc-bdVaJa, _3kx9, button__Ab12c) change with the site's next release.
  const made = (s) => s.length > 40 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(s) || /\d{2,}|^(css|sc|jsx|emotion|svelte|ng)-|[a-z]\d[a-zA-Z]|(__|--|_)(?=[A-Za-z0-9]{5,}$)[A-Za-z0-9]*?(\d|[a-z][A-Z]|[A-Z][a-zA-Z]*[A-Z])/.test(s);
  const classes = (el) => [...el.classList].filter((c) => !made(c) && !/^(is|has|js)-|active|hover|focus|open|selected|polycarp/i.test(c)).slice(0, 4);
  const quote = (s) => (/["\\<@{};\n]/.test(s) || s.length > 80 ? "" : '"' + s + '"');
  const tag = (el) => CSS.escape(el.localName);

  // What a selector finds on the page itself: the copy of a moved part isn't another part.
  function all(doc, sel) {
    if (!sel || E.selectorProblem(sel)) return [];
    try { return [...doc.querySelectorAll(sel)].filter((el) => !el.closest(E.OURS)); } catch (e) { return []; }
  }
  const count = (doc, sel) => all(doc, sel).length;
  // What sets this element apart by itself, the surest first.
  function marks(el) {
    const out = [];
    if (el.id && !made(el.id)) out.push("#" + el.id);
    for (const a of ["data-testid", "data-test", "data-qa", "name", "aria-label", "role"]) {
      const v = el.getAttribute(a);
      const q = v && quote(v);
      if (q) out.push(tag(el) + "[" + a + "=" + q + "]");
    }
    const c = classes(el);
    if (c.length) out.push(tag(el) + "." + c.join("."));
    if (/^(MAIN|HEADER|FOOTER|NAV|ASIDE|H1|BODY|HTML)$/.test(el.tagName)) out.push(tag(el));
    return out;
  }
  // A selector only this element matches, or "".
  function one(el) {
    const doc = el.ownerDocument;
    if (el.getRootNode() !== doc) return "";
    let tail = "";
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      for (const m of marks(e)) { const on = all(doc, m + tail); if (on.length === 1 && on[0] === el) return m + tail; }
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === e.localName) n++;
      tail = " > " + tag(e) + ":nth-of-type(" + n + ")" + tail;
      const sel = tail.slice(3);
      if (sel.length > E.MAX.selector) return "";
      if (count(doc, sel) === 1) return sel;
    }
    return "";
  }
  // A selector for this element and those like it (2 to 500 of them), or "".
  function like(el) {
    const doc = el.ownerDocument;
    const tries = marks(el).filter((m) => m[0] !== "#").concat(classes(el).map((c) => tag(el) + "." + c));
    const up = el.parentElement && !/^(BODY|HTML)$/.test(el.parentElement.tagName) ? el.parentElement : null;
    if (up) {
      for (const m of marks(up).filter((x) => x[0] !== "#")) tries.push(m + " > " + tag(el));
      const only = one(up);
      if (only) tries.push(only + " > " + tag(el));
    }
    for (const t of tries) { const n = count(doc, t); if (n > 1 && n <= 500 && el.matches(t)) return t; }
    return "";
  }
  globalThis.PolycarpEditsPick = { name, one, like, all, count };
})();
