/* Polycarp page edits: what an edit may say, and what it turns into on a page. Plain functions, so the content script,
   the service worker, the editor, the Settings page and the Node tests share one definition. The Polycarp app checks
   edits by the same rules (Edits.swift); spec/edits.json holds the cases both must pass.

   An edit: { id, name, enabled, sites, paths, changes, css }.
   - sites: host names ("x.com" covers its subdomains), at least one.
   - paths: "/watch/*" style, where * is anything; empty means the whole site.
   - changes: each names where it acts (`at`, a CSS selector) and what it does:
     { do: "hide" }, { do: "style", style: { property: value } }, { do: "text", text, find },
     { do: "attr", name, value }, { do: "move", to, where }, { do: "insert", where, blocks }.
   - css: a stylesheet for those pages.
   An edit changes how a page looks and reads here. It cannot click, type, submit, load from the network or run code.
   `check` answers { edit } or { why, path }; nothing here throws on a bad edit. */
(function () {
  "use strict";

  const LOCAL_KEY = "polycarp.edits.local"; // the edits made in this browser
  const APP_KEY = "polycarp.edits.app";     // { edits, connected, error } from the Polycarp app, kept by the service worker
  const OFF_KEY = "polycarp.edits.off";     // app edits the person switched off here: { id: hash of the edit }
  const MAX = { edits: 100, changes: 50, sites: 50, paths: 50, selector: 500, text: 2000, css: 20000, blocks: 20, items: 30, url: 2000, name: 80 };
  const WHERES = ["before", "after", "first", "last"];
  const ATTRS = ["alt", "aria-label", "dir", "lang", "title"];
  // Elements only hide and style may act on, places a person types in, and what a moved part may not hold (the rules in spec/edits.json).
  const NEVER = ["base", "embed", "iframe", "input", "link", "meta", "noscript", "object", "option", "script", "select", "source", "style", "template", "textarea", "track"];
  const EDITORS = ["[contenteditable]:not([contenteditable=false])", "[role=textbox]"];
  const CARRY = ["button", "embed", "iframe", "input", "object", "select", "textarea"];
  const FIELDS = { hide: [], style: ["style"], text: ["text", "find"], attr: ["name", "value"], move: ["to", "where"], insert: ["where", "blocks"] };
  const FETCHES = ["url(", "src(", "image(", "image-set(", "image-rect(", "filter(", "cross-fade(", "element(", "paint(", "expression("];
  const AT_RULES = ["container", "keyframes", "layer", "media", "starting-style", "supports"];
  const OURS = "polycarp-ui,polycarp-find,polycarp-filter-bar,polycarp-edits,polycarp-note,polycarp-moved"; // Polycarp's own parts of a page
  const CONTROL = /[\p{Cc}\p{Cf}]/u;

  class Refusal extends Error { constructor(path, why) { super(why); this.path = path; } }
  const refuse = (path, why) => { throw new Refusal(path, why); };
  const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

  // Why a stylesheet or a value is refused, or "". A stylesheet that can load something can tell another site what is on
  // the page (input[value^=a]{background:url(...)}), so nothing here may load.
  // A string kept in a custom property is refused too: a page's own image-set(var(--x)) would load it.
  function cssProblem(css, prop) {
    if (css.includes("\\")) return "may not hold a backslash";
    if (css.includes("\0")) return "may not hold a null character";
    const low = css.toLowerCase();
    for (const f of FETCHES) if (low.includes(f)) return "may not use " + f + "...): an edit loads nothing from the network";
    if (low.includes("</")) return "may not hold </";
    const plain = bare(low);
    if (stringInCustomProperty(prop && prop.startsWith("--") ? prop + ":" + plain : plain)) return "may not keep a quoted string in a custom property";
    // A page's own function could load the string it is given.
    if (/--[-\w\u0080-\uffff]*\(/.test(plain)) return "may not call a function the page defines (--name(...))";
    for (const m of plain.matchAll(/@([a-z-]*)/g)) if (!AT_RULES.includes(m[1])) return "may not use @" + m[1] + "; only " + AT_RULES.map((r) => "@" + r).join(", ");
    return "";
  }
  // CSS with each string cut to its quote mark and each comment to a space. It holds no backslash to mind.
  function bare(css) { return css.replace(/(")[^"\n\r\f]*"?|(')[^'\n\r\f]*'?|\/\*[\s\S]*?(?:\*\/|$(?![\s\S]))/g, "$1$2 "); }
  // Whether a "--name:" value, to the semicolon or brace that ends it and not one in its own brackets, holds a string.
  function stringInCustomProperty(plain) {
    for (const m of plain.matchAll(/(^|[;{}\s])--[^\s:;{}]*\s*:/g)) {
      let depth = 0;
      for (let i = m.index + m[0].length; i < plain.length; i++) {
        const ch = plain[i];
        if (ch === '"' || ch === "'") return true;
        if (depth === 0 && (ch === ";" || ch === "}")) break;
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
      }
    }
    return false;
  }
  // Why the quotes, brackets and parentheses in it don't pair up, or "".
  function unbalanced(s) {
    const open = [];
    let quote = "";
    for (const c of s) {
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === "[" || c === "(") open.push(c);
      else if (c === "]" || c === ")") { if (open.pop() !== (c === "]" ? "[" : "(")) return "closes " + c + " without opening it"; }
    }
    return quote || open.length ? "leaves a quote, bracket or parenthesis open" : "";
  }
  // The element names a selector list plainly ends at: "div > style.x, a" is style and a.
  function subjects(sel) {
    let t = bare(sel.toLowerCase()), was = "";
    while (t !== was) { was = t; t = t.replace(/\([^()[\]]*\)|\[[^()[\]]*\]/g, ""); }
    return t.split(",").map((part) => /^[^.#:[*&]*/.exec(part.split(/[ \t>+~|]/).filter(Boolean).pop() || "")[0]);
  }
  // One CSS selector list that cannot end its rule or reach past it.
  function selectorProblem(sel) {
    const bad = /[{};\\@<]/.exec(sel);
    if (bad) return "may not hold " + bad[0];
    if (CONTROL.test(sel)) return "may not hold a line break";
    if (sel.includes("/*") || sel.includes("*/")) return "may not hold a comment mark";
    const low = sel.toLowerCase();
    if (low.includes("url(")) return "may not hold url("; // CSS reads what follows by other quote rules than `unbalanced`
    if (/::|:(before|after|first-line|first-letter)(?![a-z0-9_-])/.test(bare(low))) return "names a pseudo-element; use css for that";
    return unbalanced(sel);
  }
  // "https://X.com/home" and "X.com:443" are "x.com"; "" when it is not a whole host. "www.x.com" stays itself.
  function site(raw) {
    const h = String(raw).trim().toLowerCase().replace(/^.*?:\/\//, "").replace(/[/?#][\s\S]*$/, "").replace(/:\d+$/, "");
    return h === "localhost" || (h.includes(".") && h.split(".").every((l) => /^[a-z0-9-]+$/.test(l))) ? h : "";
  }
  function webUrl(s) {
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?([/?#][^\s\\]*)?$/.test(s) || CONTROL.test(s)) return false;
    try { return !!new URL(s).host; } catch (e) { return false; }
  }

  function known(o, keys, p, what) {
    for (const k of Object.keys(o).sort()) if (!keys.includes(k)) refuse(p + k, "is not a field of " + what + " (" + keys.join(", ") + ")");
  }
  function string(o, key, p, max) {
    const v = o[key];
    if (typeof v !== "string") refuse(p + key, v === undefined ? "is required" : "must be a string");
    if (v.length > max) refuse(p + key, "is over " + max + " characters");
    return v;
  }
  function filled(o, key, p) {
    const s = string(o, key, p, MAX.text);
    if (!s.trim()) refuse(p + key, "is empty");
    return s;
  }
  function strings(o, key, p, most, chars, norm, twice) {
    const v = o[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) refuse(p + key, "must be a list of strings");
    if (v.length > most) refuse(p + key, "has " + v.length + " entries; at most " + most);
    const out = [];
    v.forEach((s, i) => {
      const at = p + key + "[" + i + "]";
      if (typeof s !== "string" || s.length > chars || !s.trim()) refuse(at, "must be a string of 1 to " + chars + " characters");
      const n = norm(s, at);
      if (twice || !out.includes(n)) out.push(n);
    });
    return out;
  }
  function selector(o, key, p, opts) {
    const s = string(o, key, p, MAX.selector).trim();
    if (!s) refuse(p + key, "is empty");
    const why = selectorProblem(s) || (opts && opts.checkSelector && !opts.checkSelector(s) ? "is not a CSS selector this browser can read" : "");
    if (why) refuse(p + key, "is not one CSS selector: it " + why);
    return s;
  }
  function place(o, p) {
    if (!WHERES.includes(o.where)) refuse(p + "where", "must be " + WHERES.join(", "));
    return o.where;
  }
  function block(o, p) {
    if (!isObject(o)) refuse(p.slice(0, -1), "a block is a JSON object");
    if (o.kind === "heading" || o.kind === "text") { known(o, ["kind", "text"], p, "a " + o.kind + " block"); return { kind: o.kind, text: filled(o, "text", p) }; }
    if (o.kind === "list") {
      known(o, ["kind", "items"], p, "a list block");
      const items = strings(o, "items", p, MAX.items, MAX.text, (s) => s, true);
      if (!items.length) refuse(p + "items", "holds at least one item");
      return { kind: "list", items };
    }
    if (o.kind === "link") {
      known(o, ["kind", "text", "url"], p, "a link block");
      const url = string(o, "url", p, MAX.url);
      if (!webUrl(url)) refuse(p + "url", "must be a full https:// or http:// address with no user name in it");
      return { kind: "link", text: filled(o, "text", p), url };
    }
    return refuse(p + "kind", "must be heading, text, list or link");
  }
  function change(o, p, opts) {
    if (!isObject(o)) refuse(p.slice(0, -1), "a change is a JSON object");
    const own = typeof o.do === "string" && Object.prototype.hasOwnProperty.call(FIELDS, o.do) ? FIELDS[o.do] : refuse(p + "do", "must be " + Object.keys(FIELDS).join(", "));
    known(o, ["do", "at", ...own], p, "a " + o.do + " change");
    const out = { do: o.do, at: selector(o, "at", p, opts) };
    if (o.do === "style") {
      const names = isObject(o.style) ? Object.keys(o.style).sort() : [];
      if (!names.length || names.length > 40) refuse(p + "style", 'is 1 to 40 CSS properties, as {"font-size": "18px"}');
      out.style = {};
      for (const k of names) {
        const at = p + "style." + k, prop = k.startsWith("--") ? k : k.toLowerCase(), raw = o.style[k];
        if (prop.length > 60 || !/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(prop)) refuse(at, "is not a CSS property");
        if (Object.prototype.hasOwnProperty.call(out.style, prop)) refuse(at, "is there twice");
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value || value.length > 300) refuse(at, "must be a string of 1 to 300 characters");
        if (/[{};!@<]/.test(value) || CONTROL.test(value)) refuse(at, "may not hold { } ; ! @ < or a line break");
        if (value.includes("/*") || value.includes("*/")) refuse(at, "may not hold a comment mark");
        const why = unbalanced(value) || cssProblem(value, prop);
        if (why) refuse(at, why);
        out.style[prop] = value;
      }
    } else if (o.do === "text") {
      out.text = string(o, "text", p, MAX.text);
      out.find = o.find === undefined ? "" : string(o, "find", p, MAX.text);
    } else if (o.do === "attr") {
      out.name = string(o, "name", p, 40).toLowerCase();
      if (!ATTRS.includes(out.name)) refuse(p + "name", "must be one of " + ATTRS.join(", "));
      if (o.value !== null && (typeof o.value !== "string" || o.value.length > MAX.text)) refuse(p + "value", "must be a string of at most " + MAX.text + " characters, or null to take the attribute away");
      out.value = o.value;
    } else if (o.do === "move") {
      out.to = selector(o, "to", p, opts);
      out.where = place(o, p);
    } else if (o.do === "insert") {
      out.where = place(o, p);
      if (!Array.isArray(o.blocks) || !o.blocks.length || o.blocks.length > MAX.blocks) refuse(p + "blocks", "is a list of 1 to " + MAX.blocks + " blocks");
      out.blocks = o.blocks.map((b, i) => block(b, p + "blocks[" + i + "]."));
    }
    if (o.do !== "hide" && o.do !== "style") {
      for (const key of ["at", "to"].filter((k) => out[k])) {
        for (const el of subjects(out[key])) if (NEVER.includes(el)) refuse(p + key, "names a <" + el + ">; only hide and style may");
        if (/contenteditable/i.test(out[key])) refuse(p + key, "names an editor; only hide and style may");
      }
    }
    return out;
  }
  function normalized(o, opts) {
    if (!isObject(o)) refuse("$", "an edit is a JSON object");
    known(o, ["id", "name", "enabled", "sites", "paths", "changes", "css"], "", "an edit");
    const id = string(o, "id", "", 64);
    if (!/^[a-z0-9-]+$/.test(id)) refuse("id", "must be 1 to 64 of a-z, 0-9 and -");
    const name = o.name === undefined ? "" : string(o, "name", "", MAX.name);
    if (o.enabled !== undefined && typeof o.enabled !== "boolean") refuse("enabled", "must be true or false");
    const sites = strings(o, "sites", "", MAX.sites, 200, (s, at) => site(s) || refuse(at, "is not a host such as x.com"));
    if (!sites.length) refuse("sites", 'names at least one site, as ["example.com"]');
    const paths = strings(o, "paths", "", MAX.paths, 200, (s, at) => { const t = s.trim(); if (!/^\/[^?# ]*$/.test(t) || CONTROL.test(t)) refuse(at, "is not a path such as /home or /watch/*"); return t; });
    if (o.changes !== undefined && !Array.isArray(o.changes)) refuse("changes", "must be a list of changes");
    const raw = o.changes || [];
    if (raw.length > MAX.changes) refuse("changes", "has " + raw.length + " changes; at most " + MAX.changes);
    const changes = raw.map((c, i) => change(c, "changes[" + i + "].", opts));
    let css = "";
    if (o.css !== undefined) {
      css = string(o, "css", "", MAX.css).trim();
      const why = cssProblem(css);
      if (why) refuse("css", why);
    }
    if (!changes.length && !css) refuse("$", "an edit needs at least one change, or css");
    return { id, name, enabled: o.enabled !== false, sites, paths, changes, css };
  }
  // opts.checkSelector(sel): whether this browser reads it; only a page has one.
  function check(raw, opts) {
    try { return { edit: normalized(raw, opts) }; } catch (e) {
      if (e instanceof Refusal) return { why: e.message, path: e.path };
      throw e;
    }
  }

  // Every edit that checks, the app's first; the rest in `refused` with the reason. An id may be in both lists.
  // off: the app edits switched off here, by the fingerprint they had, so an edit its agent changed comes back on.
  function merge(app, local, off) {
    const edits = [], refused = [];
    for (const [list, source] of [[app, "app"], [local, "local"]]) {
      for (const raw of (Array.isArray(list) ? list : []).slice(0, MAX.edits)) {
        const r = check(raw);
        if (!r.edit) { refused.push({ id: isObject(raw) && typeof raw.id === "string" ? raw.id : "", source, why: r.path + " " + r.why }); continue; }
        const e = Object.assign(r.edit, { source });
        if (source === "app" && isObject(off) && off[e.id] === fingerprint(e)) e.enabled = false;
        edits.push(e);
      }
    }
    return { edits, refused };
  }
  // What an edit does, as a short string: the same edit, the same string (its name and switch are not part of it).
  function fingerprint(e) {
    const s = JSON.stringify([e.sites, e.paths, e.changes, e.css]);
    let a = 0x811c9dc5, b = 0x1b873593;
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193); b = Math.imul(b + s.charCodeAt(i), 0x85ebca6b) ^ (b >>> 13); }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36) + s.length.toString(36);
  }

  // A site covers its subdomains; "www.x.com" also covers "x.com", without the rest of its subdomains.
  function onSite(edit, hostname) {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    return !!h && edit.sites.some((s) => h === s || h.endsWith("." + s) || s === "www." + h);
  }
  // "/watch/*" covers "/watch/1"; a path with no * is that page, with or without a last slash.
  function onPath(edit, pathname) {
    if (!edit.paths.length) return true;
    const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
    // As a browser writes it: "/wiki/Zürich" is "/wiki/Z%C3%BCrich".
    const coded = (p) => p.replace(/[^\x00-\x7f]+/g, (s) => new URLSearchParams({ s }).toString().slice(2)).replace(/%[0-9a-f]{2}/gi, (s) => s.toUpperCase());
    pathname = coded(pathname);
    return edit.paths.some((path) => {
      const glob = coded(path), parts = glob.split("*");
      if (parts.length === 1) return trim(pathname) === trim(glob);
      if (!pathname.startsWith(parts[0])) return false;
      let i = parts[0].length;
      for (const mid of parts.slice(1, -1)) { const k = pathname.indexOf(mid, i); if (k < 0) return false; i = k + mid.length; }
      const end = parts[parts.length - 1];
      return pathname.length - i >= end.length && pathname.endsWith(end);
    });
  }
  const active = (edits, hostname, pathname) => edits.filter((e) => e.enabled && onSite(e, hostname) && onPath(e, pathname));

  // Properties that reset others go first, so {"inset": "auto", "bottom": "0"} keeps its bottom.
  const BROAD = [["all"], ["border"], ["border-block", "border-inline", "border-color", "border-image", "border-radius", "border-style", "border-width", "columns", "flex-flow", "gap", "grid-gap", "inset", "place-content", "place-items", "place-self"],
    ["border-block-color", "border-block-style", "border-block-width", "border-inline-color", "border-inline-style", "border-inline-width", "inset-block", "inset-inline"]];
  const rank = (prop) => { const i = BROAD.findIndex((r) => r.includes(prop)); return i < 0 ? BROAD.length : i; };
  const declared = (style) => Object.entries(style).sort((x, y) => rank(x[0]) - rank(y[0]));
  // The stylesheet the active edits' hide and style changes make; an edit's own css is a sheet of its own. Hide leaves
  // Polycarp's own parts and the page's root. `ok` says whether
  // this browser reads a selector: one it can't is left out, so it doesn't take the rest with it.
  function sheet(edits, ok) {
    const out = [];
    for (const e of edits) {
      for (const c of e.changes) {
        if (ok && !ok(c.at)) continue;
        if (c.do === "hide") out.push(":is(" + c.at + "):not(html,body,head," + OURS + "){display:none !important}");
        else if (c.do === "style") out.push(":is(" + c.at + "):not(" + OURS + "){" + declared(c.style).map(([k, v]) => k + ":" + v + " !important").join(";") + "}");
      }
    }
    return out.join("\n");
  }

  // One line for a person: what a change does.
  function describe(c) {
    switch (c.do) {
      case "hide": return "Hides " + c.at;
      case "style": return "Restyles " + c.at + " (" + Object.keys(c.style).join(", ") + ")";
      case "text": return c.find ? "Changes “" + c.find + "” to “" + c.text + "” in " + c.at : "Rewrites " + c.at;
      case "attr": return (c.value === null ? "Removes the " : "Sets the ") + c.name + " of " + c.at;
      case "move": return "Moves " + c.at + " " + ({ before: "before", after: "after", first: "to the start of", last: "to the end of" })[c.where] + " " + c.to;
      case "insert": return "Adds a note at " + c.at;
      default: return "";
    }
  }
  function summary(e) {
    const parts = e.changes.slice(0, 3).map(describe);
    if (e.changes.length > 3) parts.push((e.changes.length - 3) + " more");
    if (e.css) parts.push("Its own stylesheet");
    return parts.join(" · ");
  }

  globalThis.PolycarpEdits = { LOCAL_KEY, APP_KEY, OFF_KEY, MAX, WHERES, ATTRS, NEVER, EDITORS, CARRY, OURS, check, merge, fingerprint, cssProblem, selectorProblem, site, onSite, onPath, active, declared, sheet, describe, summary };
})();
