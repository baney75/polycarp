/* Polycarp bionic engine.
   Renders each text node as <polycarp-t> with bold fixation points in <polycarp-b>.
   The original text node stays in the DOM, emptied, right before its <polycarp-t>, so page
   frameworks that hold a reference to it (React, Vue, Svelte) can still update or remove it.
   A MutationObserver sees those updates and re-renders. Revert restores the exact text. */
(function () {
  "use strict";

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "CODE", "PRE",
    "KBD", "SAMP", "VAR", "SVG", "MATH", "CANVAS", "IFRAME", "OBJECT", "EMBED", "BUTTON",
    "TITLE", "HEAD", "POLYCARP-T", "POLYCARP-B", "POLYCARP-R", "POLYCARP-UI"
  ]);
  // Controls and widgets: their labels are UI, not reading text, and rewriting them can break
  // a site's own layout or event handling.
  const SKIP_ROLES = new Set(["button", "tab", "menu", "menubar", "menuitem", "menuitemradio", "menuitemcheckbox",
    "option", "switch", "slider", "spinbutton", "combobox", "listbox", "searchbox", "textbox", "toolbar", "tooltip",
    "progressbar", "timer", "img"]);
  // Code editors draw text in plain elements and track it by position.
  const SKIP_SEL = ".monaco-editor,.CodeMirror,.cm-editor,.ace_editor,[data-polycarp-skip]";
  const RATIOS = [0, 0.22, 0.34, 0.45, 0.56, 0.68];
  const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu;
  // Scripts where bolding the start of a word does not make sense: no spaces (CJK, Thai), or
  // joined cursive letters that a mid-word split would break (Hebrew, Arabic and their neighbors).
  const NON_SPACED = /[぀-ヿ㐀-鿿가-힯฀-๿\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

  function boldCount(word, strength) {
    const len = [...word].length;
    if (len <= 1) return len;
    if (len <= 3) return 1;
    const n = Math.round(len * RATIOS[Math.max(1, Math.min(5, strength))]);
    return Math.max(1, Math.min(len - 1, n));
  }

  // Build a fragment for one string. Returns null when nothing would change.
  function render(text, opt, doc) {
    if (!text || text.length < 2 || NON_SPACED.test(text)) return null;
    const frag = doc.createDocumentFragment();
    let last = 0, idx = 0, changed = false, m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(text))) {
      const w = m[0];
      const take = idx % (opt.every || 1) === 0;
      idx++;
      if (!take || !/\p{L}/u.test(w)) continue;
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      const chars = [...w];
      const n = boldCount(w, opt.strength);
      const b = doc.createElement("polycarp-b");
      b.textContent = chars.slice(0, n).join("");
      frag.appendChild(b);
      const rest = chars.slice(n).join("");
      if (rest) {
        if (opt.fade > 0) {
          const r = doc.createElement("polycarp-r");
          r.textContent = rest;
          frag.appendChild(r);
        } else frag.appendChild(doc.createTextNode(rest));
      }
      last = m.index + w.length;
      changed = true;
    }
    if (!changed) return null;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    return frag;
  }

  function skipEl(n, extra) {
    if (SKIP_TAGS.has(n.tagName) || n.isContentEditable) return true;
    const role = n.getAttribute("role");
    if (role && SKIP_ROLES.has(role)) return true;
    return n.matches(extra || SKIP_SEL);
  }
  function skippable(el, extra) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (skipEl(n, extra)) return true;
    return false;
  }

  class Engine {
    constructor(doc, opt) {
      this.doc = doc || document;
      this.opt = Object.assign({ strength: 3, every: 1, fade: 0 }, opt);
      this.map = new WeakMap(); // original text node -> polycarp-t
      this.live = new Set();    // polycarp-t elements we created
      this.queue = [];      // text nodes waiting to render
      this.qi = 0;
      this.jobs = [];       // subtrees still being walked, resumable across idle slices
      this.fresh = [];      // holders made since the last takeFresh()
      this.fought = new WeakMap(); // text node -> times the page removed our markup
      this.sweepAt = 2000;
      this.scheduled = false;
      this.observer = null;
      this.busy = false;
      this.onWork = null;
      this.onShadowRoot = null;
      this.roots = new Set();
      this.skipSel = opt && opt.skip ? SKIP_SEL + "," + opt.skip : SKIP_SEL;
      this.accept = (n) => {
        if (n.nodeType === 1) {
          if (skipEl(n, this.skipSel)) return NodeFilter.FILTER_REJECT;
          const sr = this.shadowOf(n);
          if (sr) this.pendingShadows.push(sr);
          return NodeFilter.FILTER_SKIP;
        }
        return this.ok(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      };
      this.pendingShadows = [];
    }

    takeFresh() { const f = this.fresh; this.fresh = []; return f; }
    stats() { return { live: this.live.size, queued: this.queue.length - this.qi, jobs: this.jobs.length, roots: this.roots.size }; }

    setOptions(opt) {
      const o = Object.assign({}, this.opt, opt);
      const changed = o.strength !== this.opt.strength || o.every !== this.opt.every || (o.fade > 0) !== (this.opt.fade > 0);
      this.opt = o;
      if (changed && this.observer) { this.revertAll(); this.scan(this.doc.body); }
    }

    // Shadow roots, open or closed. chrome.dom reaches closed roots from a content script.
    shadowOf(el) {
      if (el.shadowRoot) return el.shadowRoot;
      if (!el.tagName || el.tagName.indexOf("-") < 0) return null;
      try { return globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null; }
      catch (e) { return null; }
    }

    adoptRoot(root) {
      if (!root || this.roots.has(root)) return;
      this.roots.add(root);
      if (this.observer) this.observer.observe(root, { childList: true, subtree: true, characterData: true });
      if (this.onShadowRoot) this.onShadowRoot(root);
    }

    // Collect candidate text nodes under root at once, descending into shadow roots (the Reader).
    collect(root, out) {
      if (!root) return;
      if (root.nodeType === 3) { if (this.ok(root)) out.push(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 11) return;
      if (root.nodeType === 1 && skippable(root, this.skipSel)) return;
      if (root.nodeType === 1) { const sr = this.shadowOf(root); if (sr) this.pendingShadows.push(sr); }
      const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, this.accept);
      let n;
      while ((n = walker.nextNode())) out.push(n);
      const shadows = this.pendingShadows.splice(0);
      for (const sr of shadows) {
        if (!this.roots.has(sr)) this.adoptRoot(sr);
        this.collect(sr, out);
      }
    }

    // Queue a subtree to walk a slice at a time, so a huge page or a big batch of new posts
    // never blocks the main thread.
    enqueue(root) {
      if (!root) return;
      if (root.nodeType === 3) { if (this.ok(root) && !skippable(root.parentElement, this.skipSel)) this.queue.push(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 11) return;
      if (root.nodeType === 1 && skippable(root, this.skipSel)) return;
      if (root.nodeType === 1) { const sr = this.shadowOf(root); if (sr) this.pendingShadows.push(sr); }
      this.jobs.push(this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, this.accept));
      this.takeShadows();
    }
    takeShadows() {
      for (const sr of this.pendingShadows.splice(0)) {
        if (!this.roots.has(sr)) this.adoptRoot(sr);
        this.jobs.push(this.doc.createTreeWalker(sr, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, this.accept));
      }
    }

    ok(t) {
      const v = t.nodeValue;
      if (!v || v.length < 2 || !/\p{L}/u.test(v)) return false;
      const p = t.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName)) return false;
      // Never touch text someone is editing: rewriting it moves the caret and scrambles the typing.
      if (p.isContentEditable || p.closest("[role=textbox]")) return false;
      if (this.map.has(t) || (this.fought.get(t) || 0) >= 2) return false;
      return true;
    }

    // Render one text node. The original stays in place, emptied.
    apply(t) {
      if (!t.parentNode || !this.ok(t)) return;
      const text = t.nodeValue;
      const frag = render(text, this.opt, this.doc);
      if (!frag) return;
      const holder = this.doc.createElement("polycarp-t");
      holder.appendChild(frag);
      holder.__polycarpSrc = text;
      t.parentNode.insertBefore(holder, t.nextSibling);
      t.nodeValue = "";
      this.map.set(t, holder);
      holder.__polycarpOrig = t;
      this.live.add(holder);
      this.fresh.push(holder);
    }

    scan(root) {
      this.enqueue(root);
      this.pump();
    }

    pump() {
      if (this.scheduled) return;
      this.scheduled = true;
      const run = (deadline) => {
        this.scheduled = false;
        if (!this.observer) return;
        this.busy = true;
        const start = performance.now();
        const spent = () => (deadline && !deadline.didTimeout ? deadline.timeRemaining() < 2 : performance.now() - start > 10);
        let ops = 0;
        for (;;) {
          if (this.qi < this.queue.length) {
            const t = this.queue[this.qi++];
            if (t.isConnected) this.apply(t);
          } else {
            this.queue.length = 0; this.qi = 0;
            const w = this.jobs[0];
            if (!w) break;
            let n, k = 0;
            while (k < 100 && (n = w.nextNode())) { this.queue.push(n); k++; }
            if (k < 100) this.jobs.shift();
            this.takeShadows();
          }
          if (++ops % 25 === 0 && spent()) break;
        }
        if (this.observer) this.observer.takeRecords();
        this.busy = false;
        if (this.live.size > this.sweepAt) this.sweep();
        if (this.onWork) this.onWork();
        if (this.qi < this.queue.length || this.jobs.length) this.pump();
      };
      if (globalThis.requestIdleCallback) requestIdleCallback(run, { timeout: 250 });
      else setTimeout(run, 16);
    }

    // Forget holders the page threw away (an infinite feed drops old posts), so memory stays flat.
    sweep() {
      for (const h of this.live) {
        if (h.isConnected) continue;
        this.live.delete(h);
        const t = h.__polycarpOrig;
        if (t) this.map.delete(t);
      }
      this.sweepAt = Math.max(2000, this.live.size * 2);
    }

    // React to page changes: new nodes, text updates on originals, removed originals.
    handle(records) {
      if (this.busy) return;
      const add = [];
      for (const r of records) {
        if (r.type === "characterData") {
          const t = r.target;
          const holder = this.map.get(t);
          if (holder) {
            if (t.nodeValue === "") continue;
            holder.remove();
            this.live.delete(holder);
            this.map.delete(t);
          }
          add.push(t);
        } else if (r.type === "childList") {
          for (const n of r.removedNodes) {
            if (n.nodeType === 3) {
              const holder = this.map.get(n);
              if (holder) { holder.remove(); this.live.delete(holder); this.map.delete(n); }
            } else if (n.tagName === "POLYCARP-T" && this.live.has(n)) {
              // The page removed our markup but kept its own text node: give the text back so
              // nothing disappears. After two rounds of this, leave that node alone.
              const t = n.__polycarpOrig;
              this.live.delete(n);
              if (t) {
                this.map.delete(t);
                if (t.isConnected && t.nodeValue === "") {
                  this.fought.set(t, (this.fought.get(t) || 0) + 1);
                  this.busy = true;
                  t.nodeValue = n.__polycarpSrc;
                  if (this.observer) this.observer.takeRecords();
                  this.busy = false;
                  add.push(t);
                }
              }
            }
          }
          for (const n of r.addedNodes) {
            if (n.nodeType === 1 && n.tagName && n.tagName.startsWith("POLYCARP-")) continue;
            add.push(n);
          }
        }
      }
      for (const n of add) this.enqueue(n);
      if (this.qi < this.queue.length || this.jobs.length) this.pump();
    }

    start() {
      if (this.observer) return;
      // Clean up markup left by a previous version of the extension (after an update).
      this.doc.querySelectorAll("polycarp-t").forEach((h) => {
        if (this.live.has(h)) return;
        const prev = h.previousSibling;
        if (prev && prev.nodeType === 3 && prev.nodeValue === "") prev.nodeValue = h.textContent;
        else h.before(this.doc.createTextNode(h.textContent));
        h.remove();
      });
      // A block can become editable after it was styled (an editor that turns on late): give it its
      // plain text back before the first keystroke lands.
      // Pointer first, before the browser places the caret inside our markup; focus covers the keyboard.
      this.onFocus = (e) => {
        let el = e.target;
        if (el && el.nodeType === 3) el = el.parentElement;
        if (!el || el.nodeType !== 1) return;
        if (!el.isContentEditable && !el.closest("[role=textbox]")) return;
        let host = el;
        while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
        host = el.closest("[role=textbox]") || host;
        if (!this.revertIn(host)) return;
        // The node under the pointer is gone, so the browser would place no caret: place it ourselves.
        const sel = this.doc.getSelection && this.doc.getSelection();
        if (!sel) return;
        let range = null;
        if (e.type === "mousedown" && this.doc.caretRangeFromPoint) range = this.doc.caretRangeFromPoint(e.clientX, e.clientY);
        if (!range || !host.contains(range.startContainer)) { range = this.doc.createRange(); range.setStart(host, 0); range.collapse(true); }
        if (e.type === "mousedown") { e.preventDefault(); host.focus({ preventScroll: true }); }
        sel.removeAllRanges();
        sel.addRange(range);
      };
      this.doc.addEventListener("mousedown", this.onFocus, true);
      this.doc.addEventListener("focusin", this.onFocus, true);
      this.observer = new MutationObserver((recs) => this.handle(recs));
      this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, characterData: true });
      for (const r of this.roots) this.observer.observe(r, { childList: true, subtree: true, characterData: true });
      this.scan(this.doc.body);
    }

    revertIn(el) {
      let n = 0;
      for (const holder of el.querySelectorAll("polycarp-t")) {
        if (!this.live.has(holder)) continue;
        const t = holder.__polycarpOrig;
        this.busy = true;
        if (t && t.nodeValue === "") t.nodeValue = holder.__polycarpSrc;
        holder.remove();
        if (t) this.map.delete(t);
        this.live.delete(holder);
        if (this.observer) this.observer.takeRecords();
        this.busy = false;
        n++;
      }
      return n;
    }

    revertAll() {
      const wasObserving = !!this.observer;
      if (this.observer) this.observer.disconnect();
      this.busy = true;
      for (const holder of this.live) {
        const t = holder.__polycarpOrig;
        if (t && t.nodeValue === "") t.nodeValue = holder.__polycarpSrc;
        holder.remove();
        if (t) this.map.delete(t);
      }
      this.live.clear();
      this.fresh = [];
      this.queue.length = 0; this.qi = 0;
      this.jobs.length = 0;
      this.busy = false;
      if (wasObserving) {
        this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, characterData: true });
        for (const r of this.roots) this.observer.observe(r, { childList: true, subtree: true, characterData: true });
      }
    }

    stop() {
      if (this.onFocus) { this.doc.removeEventListener("mousedown", this.onFocus, true); this.doc.removeEventListener("focusin", this.onFocus, true); this.onFocus = null; }
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      this.revertAll();
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
    }
  }

  // Static transform for a detached or owned subtree (the Reader). Replaces text nodes directly.
  function transformTree(root, opt) {
    const doc = root.ownerDocument || document;
    const e = new Engine(doc, opt);
    const nodes = [];
    e.collect(root, nodes);
    for (const t of nodes) {
      const frag = render(t.nodeValue, e.opt, doc);
      if (frag) t.parentNode.replaceChild(frag, t);
    }
  }
  function untransformTree(root) {
    root.querySelectorAll("polycarp-b, polycarp-r").forEach((el) => el.replaceWith(el.textContent));
    root.normalize();
  }

  globalThis.Polycarp = Object.assign(globalThis.Polycarp || {}, {
    bionic: true, BionicEngine: Engine, renderBionic: render, boldCount, transformTree, untransformTree
  });
})();
