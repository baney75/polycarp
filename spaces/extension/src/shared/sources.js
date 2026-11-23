/* Polycarp sources: the engine behind Polycarp Search. Searches the user's Polycarp library,
   YouTube, free and open sources, and custom sources the user adds by pasting a link
   (a site search, a feed, an OPDS book catalog, a {q} link, or a site Polycarp reads politely
   and indexes on this device). Classic script for extension pages only: it needs
   DOMParser and cross-origin fetch through the extension's host permission.
   Depends on search-index.js (PolycarpSearchIndex). library.js (PolycarpLibrary) is optional. */
(function () {
  "use strict";

  // Every fetched base URL. Tests point these at local mocks.
  const ENDPOINTS = {
    youtube: "https://www.youtube.com/results",
    wikipedia: "https://en.wikipedia.org/w/rest.php/v1/search/page",
    gutenberg: "https://gutendex.com/books",
    openlibrary: "https://openlibrary.org/search.json",
    archive: "https://archive.org/advancedsearch.php",
    librivox: "https://librivox.org/api/feed/audiobooks",
    arxiv: "https://export.arxiv.org/api/query",
    openalex: "https://api.openalex.org/works",
  };

  const BUILTIN = [
    { id: "library", name: "Polycarp library", blurb: "Your saved pages, documents, audio and notes.", kind: "library", defaultOn: true },
    { id: "youtube", name: "YouTube", blurb: "Videos, talks and lectures.", kind: "video", defaultOn: true },
    { id: "wikipedia", name: "Wikipedia", blurb: "The free encyclopedia.", kind: "page", defaultOn: true },
    { id: "gutenberg", name: "Project Gutenberg", blurb: "Free public domain ebooks.", kind: "book", defaultOn: true },
    { id: "openlibrary", name: "Open Library", blurb: "Books, with free scans where the law allows.", kind: "book", defaultOn: true },
    { id: "archive", name: "Internet Archive", blurb: "Texts, audio and films in the public archive.", kind: "item", defaultOn: false },
    { id: "librivox", name: "LibriVox", blurb: "Free public domain audiobooks read by volunteers.", kind: "audiobook", defaultOn: true },
    { id: "arxiv", name: "arXiv", blurb: "Open preprints in science and math.", kind: "paper", defaultOn: false },
    { id: "openalex", name: "OpenAlex", blurb: "Open access research papers.", kind: "paper", defaultOn: false },
  ];

  const KINDS = ["page", "book", "audiobook", "video", "paper", "file", "item", "note"];
  const CUSTOM_TYPES = ["opensearch", "feed", "opds", "template", "crawl", "list"];
  const INDEXED_TYPES = ["feed", "opds", "crawl", "list"];
  const SNIPPET_MAX = 280;
  const PAGE_TEXT_CAP = 20000;
  const CRAWL_DEFAULT = 300;
  const CRAWL_MAX = 2000;
  const FEED_PAGES_MAX = 10;
  const SITEMAP_FILES_MAX = 25;
  const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|zip|gz|tgz|rar|7z|exe|dmg|pkg|msi|mp3|m4a|ogg|wav|flac|mp4|m4v|mov|webm|avi|mkv|css|js|json|xml|rss|atom|woff2?|ttf|otf|epub|mobi|docx?|xlsx?|pptx?)$/i;
  const STRIP = "script,style,noscript,template,svg,iframe,object,nav,header,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo],[role=search],[aria-hidden=true]";

  // ---------- Errors ----------

  class SourceError extends Error {
    constructor(code, detail) { super(detail || code); this.code = code; }
  }
  const stopped = () => new SourceError("stopped", "Stopped");

  function plainError(e, name) {
    const code = e && e.code;
    if (code === "stopped") return "Search stopped";
    if (code === "timeout" || code === "network") return name + " did not answer";
    if (code === "http") return name + " returned an error";
    return name + " sent results Polycarp could not read";
  }

  // ---------- Small helpers ----------

  function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  let parser = null;
  function dom(html) {
    if (!parser) parser = new DOMParser();
    return parser.parseFromString(String(html || ""), "text/html");
  }
  function xml(text) {
    if (!parser) parser = new DOMParser();
    const d = parser.parseFromString(String(text || "").replace(/^﻿/, "").trim(), "application/xml");
    if (d.getElementsByTagName("parsererror").length) return null;
    return d;
  }

  function stripHtml(s) {
    s = String(s == null ? "" : s);
    if (!/[<&]/.test(s)) return clean(s);
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<(br|p|div|li|h\d)\b[^>]*>/gi, " $&");
    if (typeof DOMParser === "function") return clean(dom("<body>" + s + "</body>").body.textContent);
    return clean(s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'"));
  }

  function snip(s, max) {
    max = max || SNIPPET_MAX;
    s = stripHtml(s);
    if (s.length <= max) return s;
    let cut = s.slice(0, max - 3);
    const sp = cut.lastIndexOf(" ");
    if (sp > max * 0.6) cut = cut.slice(0, sp);
    return cut.replace(/[\s,;:.]+$/, "") + "...";
  }

  // Absolute http(s) URL or "". Blocks javascript:, data: and other schemes.
  function safeUrl(u, base) {
    if (!u) return "";
    try {
      const x = new URL(String(u).trim(), base || undefined);
      return /^https?:$/.test(x.protocol) ? x.href : "";
    } catch (e) { return ""; }
  }

  function yearOf(v) {
    if (v == null || v === "") return "";
    const m = /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(String(v));
    return m ? m[1] : clean(v);
  }

  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }

  function sameSite(a, b) {
    if (a === b) return true;
    if (/^[\d.]+$|:/.test(a) || /^[\d.]+$|:/.test(b)) return false;
    const tail = (h) => h.split(".").slice(-2).join(".");
    return tail(a) === tail(b);
  }

  function makeId(prefix) {
    let r = "";
    try { r = crypto.randomUUID().replace(/-/g, "").slice(0, 12); } catch (e) { r = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
    return prefix + r;
  }

  function sleep(ms, signal) {
    return new Promise((res, rej) => {
      if (signal && signal.aborted) return rej(stopped());
      const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", on); res(); }, ms);
      function on() { clearTimeout(t); rej(stopped()); }
      if (signal) signal.addEventListener("abort", on, { once: true });
    });
  }

  function joinNames(list, max) {
    const names = (list || []).map(clean).filter(Boolean);
    max = max || 3;
    if (names.length <= max) return names.join(", ");
    return names.slice(0, max).join(", ") + " and others";
  }

  // One result in the shared shape. Every string trimmed, snippet capped, URLs checked.
  function norm(source, r, base) {
    r = r || {};
    const url = safeUrl(r.url, base);
    const files = (Array.isArray(r.files) ? r.files : []).map((f) => f && {
      label: clean(f.label) || "File", url: safeUrl(f.url, base), type: clean(f.type),
    }).filter((f) => f && f.url);
    return {
      id: clean(r.id) || url || clean(r.title),
      source,
      title: stripHtml(r.title) || url || "Untitled",
      url,
      snippet: snip(r.snippet),
      by: stripHtml(r.by),
      year: yearOf(r.year),
      kind: KINDS.indexOf(r.kind) >= 0 ? r.kind : "page",
      image: safeUrl(r.image, base) || null,
      readUrl: safeUrl(r.readUrl, base) || null,
      files,
      duration: clean(r.duration),
    };
  }

  // ---------- Fetch ----------

  // Fetch text with a timeout and an outside AbortSignal. Never sends the user's cookies.
  async function get(url, o) {
    o = o || {};
    const parent = o.signal;
    if (parent && parent.aborted) throw stopped();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (parent) parent.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeout || API.TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow",
        headers: Object.assign({ Accept: o.accept || "*/*" }, o.headers || {}),
      });
      const type = (r.headers.get("content-type") || "").toLowerCase();
      if (o.only && !o.only.test(type)) {
        try { if (r.body) await r.body.cancel(); } catch (e) { /* ignore */ }
        return { status: r.status, ok: r.ok, type, text: "", url: r.url || url, skipped: true };
      }
      const text = await r.text();
      if (!r.ok && !o.allowError) throw new SourceError("http", "HTTP " + r.status);
      return { status: r.status, ok: r.ok, type, text, url: r.url || url };
    } catch (e) {
      if (e instanceof SourceError) throw e;
      if (parent && parent.aborted) throw stopped();
      if (timedOut) throw new SourceError("timeout", "Timed out");
      throw new SourceError("network", e && e.message);
    } finally {
      clearTimeout(t);
      if (parent) parent.removeEventListener("abort", onAbort);
    }
  }

  function asJson(res) {
    try { return JSON.parse(res.text); } catch (e) { throw new SourceError("parse", "Not JSON"); }
  }

  function qs(params) {
    return Object.keys(params).map((k) => {
      const v = params[k];
      return Array.isArray(v) ? v.map((x) => encodeURIComponent(k) + "=" + encodeURIComponent(x)).join("&") : encodeURIComponent(k) + "=" + encodeURIComponent(v);
    }).join("&");
  }

  // ---------- Built-in sources ----------

  async function srcLibrary(q, ctx) {
    const L = globalThis.PolycarpLibrary;
    if (!L || typeof L.search !== "function") return [];
    const out = await L.search(q);
    const items = (out && out.items) || [];
    const notes = (out && out.notes) || [];
    const byId = new Map(items.map((it) => [it.id, it]));
    const kindOf = (it) => {
      if (it.kind === "link") return "page";
      if (it.kind === "note") return "note";
      if (it.kind === "audio") return "file";
      return /^(epub|fb2|mobi)$/.test(it.source || "") ? "book" : "file";
    };
    const res = items.slice(0, ctx.limit).map((it) => ({
      id: it.id, title: it.title, url: it.url, snippet: it.excerpt || it.text, by: it.author,
      kind: kindOf(it), year: it.updated ? new Date(it.updated).getFullYear() : "",
    }));
    for (const n of notes.slice(0, Math.max(0, ctx.limit - res.length))) {
      const parent = byId.get(n.itemId);
      const first = String(n.text || n.quote || "").split("\n").map(clean).find(Boolean) || "Note";
      res.push({ id: n.id, title: (n.quote ? "Highlight: " : "") + first.slice(0, 120), url: parent && parent.url, snippet: n.quote || n.text, by: parent ? parent.title : "", kind: "note" });
    }
    return res;
  }

  // Find a JSON object assigned to ytInitialData in the results page.
  function extractObject(src, at) {
    let depth = 0, inStr = false, esc = false;
    for (let i = at; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === "\"") inStr = false;
        continue;
      }
      if (c === "\"") inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return src.slice(at, i + 1);
    }
    return null;
  }

  function ytInitialData(html) {
    const re = /ytInitialData"?\]?\s*=\s*/g;
    let m;
    while ((m = re.exec(html))) {
      const at = m.index + m[0].length;
      if (html[at] !== "{") continue;
      const json = extractObject(html, at);
      if (json) { try { return JSON.parse(json); } catch (e) { /* try the next one */ } }
    }
    return null;
  }

  const runs = (t) => !t ? "" : t.simpleText || (Array.isArray(t.runs) ? t.runs.map((r) => r.text || "").join("") : "") || t.content || "";

  function findAll(root, keys, out, depth) {
    if (!root || typeof root !== "object" || depth > 40) return out;
    if (Array.isArray(root)) { for (const v of root) findAll(v, keys, out, depth + 1); return out; }
    for (const k of Object.keys(root)) {
      if (keys.indexOf(k) >= 0) out.push([k, root[k]]);
      else findAll(root[k], keys, out, depth + 1);
    }
    return out;
  }

  function ytVideo(v) {
    if (!v || !v.videoId) return null;
    const thumbs = (v.thumbnail && v.thumbnail.thumbnails) || [];
    let duration = runs(v.lengthText);
    if (!duration) {
      const ov = findAll(v.thumbnailOverlays, ["thumbnailOverlayTimeStatusRenderer"], [], 0)[0];
      duration = ov ? runs(ov[1].text) : "";
    }
    const snippet = (v.detailedMetadataSnippets && v.detailedMetadataSnippets[0] && runs(v.detailedMetadataSnippets[0].snippetText)) || runs(v.descriptionSnippet);
    return {
      id: v.videoId, title: runs(v.title), url: "https://www.youtube.com/watch?v=" + v.videoId,
      by: runs(v.ownerText) || runs(v.longBylineText) || runs(v.shortBylineText),
      duration, image: thumbs.length ? thumbs[thumbs.length - 1].url : "https://i.ytimg.com/vi/" + v.videoId + "/hqdefault.jpg",
      year: runs(v.publishedTimeText), snippet, kind: "video",
    };
  }

  function ytLockup(v) {
    if (!v || !v.contentId) return null;
    if (v.contentType && v.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
    const meta = (v.metadata && v.metadata.lockupMetadataViewModel) || {};
    const rows = (meta.metadata && meta.metadata.contentMetadataViewModel && meta.metadata.contentMetadataViewModel.metadataRows) || [];
    const parts = rows.map((r) => (r.metadataParts || []).map((p) => runs(p.text)).filter(Boolean));
    const flat = [].concat.apply([], parts);
    const badges = findAll(v.contentImage, ["thumbnailBadgeViewModel"], [], 0).map((b) => clean(b[1] && b[1].text));
    const img = findAll(v.contentImage, ["sources"], [], 0)[0];
    return {
      id: v.contentId, title: runs(meta.title), url: "https://www.youtube.com/watch?v=" + v.contentId,
      by: parts[0] ? parts[0][0] : "",
      duration: badges.find((b) => /^\d+(:\d{2})+$/.test(b)) || "",
      image: img && img[1] && img[1][0] ? img[1][0].url : "https://i.ytimg.com/vi/" + v.contentId + "/hqdefault.jpg",
      year: flat.find((p) => /\bago\b|\b(19|20)\d{2}\b|streamed/i.test(p)) || "",
      snippet: "", kind: "video",
    };
  }

  async function srcYoutube(q, ctx) {
    const res = await get(ENDPOINTS.youtube + "?" + qs({ search_query: q, hl: "en" }), { signal: ctx.signal, accept: "text/html" });
    const data = ytInitialData(res.text);
    if (!data) throw new SourceError("parse", "No ytInitialData");
    const seen = new Set();
    const out = [];
    for (const [k, v] of findAll(data, ["videoRenderer", "lockupViewModel"], [], 0)) {
      const r = k === "videoRenderer" ? ytVideo(v) : ytLockup(v);
      if (!r || !r.title || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }

  async function srcWikipedia(q, ctx) {
    const res = await get(ENDPOINTS.wikipedia + "?" + qs({ q, limit: 10 }), {
      signal: ctx.signal, accept: "application/json", headers: { "Api-User-Agent": "Polycarp browser extension" },
    });
    const pages = (asJson(res).pages) || [];
    return pages.map((p) => {
      const url = "https://en.wikipedia.org/wiki/" + encodeURI(String(p.key || p.title || "").replace(/ /g, "_"));
      let img = p.thumbnail && p.thumbnail.url;
      if (img && img.startsWith("//")) img = "https:" + img;
      return {
        id: String(p.id || p.key), title: p.title, url, readUrl: url,
        snippet: [p.description, stripHtml(p.excerpt)].filter(Boolean).join(". "), image: img, kind: "page",
      };
    });
  }

  function flipName(n) {
    const m = /^([^,]+),\s*(.+)$/.exec(clean(n));
    return m ? m[2] + " " + m[1] : clean(n);
  }

  async function srcGutenberg(q, ctx) {
    const res = await get(ENDPOINTS.gutenberg + "?" + qs({ search: q }), { signal: ctx.signal, accept: "application/json" });
    const list = asJson(res).results || [];
    return list.map((b) => {
      const f = b.formats || {};
      const keys = Object.keys(f);
      const epubs = keys.filter((k) => /epub/.test(k)).map((k) => f[k]).sort((a, z) => (/epub3/.test(z) ? 2 : 0) + (/images/.test(z) ? 1 : 0) - ((/epub3/.test(a) ? 2 : 0) + (/images/.test(a) ? 1 : 0)));
      const txt = keys.filter((k) => /^text\/plain/.test(k)).map((k) => f[k]).find((u) => !/\.zip$/.test(u));
      const html = keys.filter((k) => /^text\/html/.test(k)).map((k) => f[k]).find((u) => !/\.zip$/.test(u));
      const files = [];
      if (epubs[0]) files.push({ label: "EPUB", url: epubs[0], type: "application/epub+zip" });
      if (txt) files.push({ label: "Plain text", url: txt, type: "text/plain" });
      if (html) files.push({ label: "HTML", url: html, type: "text/html" });
      return {
        id: String(b.id), title: b.title, url: "https://www.gutenberg.org/ebooks/" + b.id,
        by: joinNames((b.authors || []).map((a) => flipName(a.name))),
        snippet: (b.summaries && b.summaries[0]) || (b.subjects || []).slice(0, 3).join("; "),
        image: f["image/jpeg"], readUrl: epubs[0] || html || txt, files, kind: "book",
      };
    });
  }

  async function srcOpenLibrary(q, ctx) {
    const res = await get(ENDPOINTS.openlibrary + "?" + qs({ q, limit: 15, fields: "key,title,author_name,first_publish_year,cover_i,ia,ebook_access" }), { signal: ctx.signal, accept: "application/json" });
    const docs = asJson(res).docs || [];
    return docs.map((d) => {
      const pub = d.ebook_access === "public" && Array.isArray(d.ia) && d.ia[0];
      const pdf = pub ? "https://archive.org/download/" + encodeURIComponent(d.ia[0]) + "/" + encodeURIComponent(d.ia[0]) + ".pdf" : "";
      const access = d.ebook_access === "public" ? "Free to read." : d.ebook_access === "borrowable" ? "Borrow it free with an Open Library account." : "";
      return {
        id: d.key, title: d.title, url: "https://openlibrary.org" + d.key,
        by: joinNames(d.author_name), year: d.first_publish_year,
        snippet: [d.first_publish_year ? "First published " + d.first_publish_year + "." : "", access].filter(Boolean).join(" "),
        image: d.cover_i ? "https://covers.openlibrary.org/b/id/" + d.cover_i + "-M.jpg" : "",
        readUrl: pdf, files: pdf ? [{ label: "PDF", url: pdf, type: "application/pdf" }] : [], kind: "book",
      };
    });
  }

  async function srcArchive(q, ctx) {
    // A plain q= search matches full text and returns radio logs first; title and creator
    // fields sorted by downloads give the books, audio and films people expect.
    const words = clean(q.replace(/[():"^~*?\\[\]{}!+\-&|/]/g, " "));
    const lq = "(title:(" + words + ") OR creator:(" + words + ")) AND mediatype:(texts OR audio OR movies)";
    const res = await get(ENDPOINTS.archive + "?" + qs({ q: lq, "fl[]": ["identifier", "title", "creator", "mediatype", "year", "description"], "sort[]": "downloads desc", rows: 15, output: "json" }), { signal: ctx.signal, accept: "application/json" });
    const docs = (asJson(res).response || {}).docs || [];
    const kindOf = { texts: "book", audio: "audiobook", movies: "video" };
    return docs.map((d) => {
      const id = String(d.identifier || "");
      const creator = Array.isArray(d.creator) ? joinNames(d.creator) : d.creator;
      const desc = Array.isArray(d.description) ? d.description[0] : d.description;
      return {
        id, title: d.title, url: "https://archive.org/details/" + encodeURIComponent(id), by: creator, year: d.year,
        snippet: desc, image: "https://archive.org/services/img/" + encodeURIComponent(id), kind: kindOf[d.mediatype] || "item",
      };
    });
  }

  function lvMap(b) {
    const files = [];
    if (b.url_zip_file) files.push({ label: "All chapters (zip)", url: b.url_zip_file, type: "application/zip" });
    for (const s of b.sections || []) if (s.listen_url) files.push({ label: clean(s.title) || "Section " + s.section_number, url: s.listen_url, type: "audio/mpeg" });
    const ia = /archive\.org\/details\/([^/?#]+)/.exec(b.url_iarchive || "");
    return {
      id: String(b.id), title: b.title, url: b.url_librivox || ("https://librivox.org/search?q=" + encodeURIComponent(b.title || "")),
      by: joinNames((b.authors || []).map((a) => clean((a.first_name || "") + " " + (a.last_name || "")))),
      year: b.copyright_year, snippet: b.description, duration: b.totaltime,
      image: ia ? "https://archive.org/services/img/" + ia[1] : "", files, kind: "audiobook",
    };
  }

  async function srcLibrivox(q, ctx) {
    const ask = async (params) => {
      const res = await get(ENDPOINTS.librivox + "?" + qs(Object.assign({ format: "json", extended: 1 }, params)), { signal: ctx.signal, accept: "application/json", allowError: true });
      if (res.status === 404) return [];
      if (!res.ok) throw new SourceError("http", "HTTP " + res.status);
      const d = asJson(res);
      return Array.isArray(d.books) ? d.books : [];
    };
    let books = await ask({ title: "^" + q });
    if (!books.length) {
      const words = clean(q).split(" ");
      books = await ask({ author: words[words.length - 1] });
    }
    return books.map(lvMap);
  }

  // XML helpers that ignore namespaces.
  const kids = (el, name) => el ? Array.prototype.filter.call(el.children, (c) => c.localName === name) : [];
  const kid = (el, name) => kids(el, name)[0] || null;
  const txt = (el, name) => { const k = kid(el, name); return k ? clean(k.textContent) : ""; };

  async function srcArxiv(q, ctx) {
    const words = clean(q).split(" ").filter(Boolean).map((w) => "all:" + encodeURIComponent(w.replace(/["()]/g, "")));
    const res = await get(ENDPOINTS.arxiv + "?search_query=" + words.join("+AND+") + "&max_results=10", { signal: ctx.signal, accept: "application/atom+xml" });
    const doc = xml(res.text);
    if (!doc) throw new SourceError("parse", "Bad Atom");
    return kids(doc.documentElement, "entry").map((e) => {
      const links = kids(e, "link");
      const alt = links.find((l) => l.getAttribute("rel") === "alternate");
      const pdf = links.find((l) => l.getAttribute("title") === "pdf" || l.getAttribute("type") === "application/pdf");
      const pdfUrl = pdf ? pdf.getAttribute("href") : "";
      return {
        id: txt(e, "id"), title: txt(e, "title"), url: alt ? alt.getAttribute("href") : txt(e, "id"),
        by: joinNames(kids(e, "author").map((a) => txt(a, "name"))), year: txt(e, "published"),
        snippet: txt(e, "summary"), readUrl: pdfUrl, files: pdfUrl ? [{ label: "PDF", url: pdfUrl, type: "application/pdf" }] : [], kind: "paper",
      };
    });
  }

  function abstractOf(inv) {
    if (!inv || typeof inv !== "object") return "";
    const words = [];
    for (const w of Object.keys(inv)) for (const i of inv[w]) if (i < 80) words[i] = w;
    return words.filter(Boolean).join(" ");
  }

  async function srcOpenAlex(q, ctx) {
    const res = await get(ENDPOINTS.openalex + "?" + qs({ search: q, "per-page": 10, filter: "is_oa:true" }), { signal: ctx.signal, accept: "application/json" });
    const list = asJson(res).results || [];
    return list.map((w) => {
      const pl = w.primary_location || {};
      const oa = w.best_oa_location || {};
      const pdf = oa.pdf_url || "";
      const venue = pl.source && pl.source.display_name;
      return {
        id: w.id, title: w.display_name || w.title, url: w.doi || pl.landing_page_url || oa.landing_page_url || w.id,
        by: joinNames((w.authorships || []).map((a) => a.author && a.author.display_name)), year: w.publication_year,
        snippet: abstractOf(w.abstract_inverted_index) || venue || "", readUrl: pdf,
        files: pdf ? [{ label: "PDF", url: pdf, type: "application/pdf" }] : [], kind: "paper",
      };
    });
  }

  const RUNNERS = {
    library: srcLibrary, youtube: srcYoutube, wikipedia: srcWikipedia, gutenberg: srcGutenberg,
    openlibrary: srcOpenLibrary, archive: srcArchive, librivox: srcLibrivox, arxiv: srcArxiv, openalex: srcOpenAlex,
  };

  // ---------- Feeds (RSS, Atom, RDF, JSON Feed) and OPDS ----------

  function isOpdsType(type) { return /opds|kind=(navigation|acquisition)/i.test(type || ""); }

  // Parse a feed document. Returns { kind: "rss"|"atom"|"json", title, icon, items, next, opds, links } or null.
  function parseFeed(text, base, type) {
    const t = String(text || "").trim();
    if (/^[{[]/.test(t)) {
      let j;
      try { j = JSON.parse(t); } catch (e) { return null; }
      if (!j || !Array.isArray(j.items)) return null;
      return {
        kind: "json", title: clean(j.title), icon: safeUrl(j.icon || j.favicon, base) || null, next: safeUrl(j.next_url, base),
        items: j.items.map((it) => {
          const authors = it.authors || (it.author ? [it.author] : []);
          const att = (it.attachments || []).map((a) => ({ label: clean(a.title) || labelFor(a.mime_type, a.url), url: a.url, type: a.mime_type }));
          const body = it.content_text || stripHtml(it.content_html);
          return {
            docId: String(it.id || it.url || it.title || ""), title: it.title || snip(body, 80), url: it.url || it.external_url,
            snippet: it.summary || body, text: body, by: joinNames(authors.map((a) => a && a.name)), year: it.date_published,
            image: it.image || it.banner_image, files: att, kind: kindForFiles(att),
          };
        }),
      };
    }
    const doc = xml(t);
    if (!doc) return null;
    const root = doc.documentElement;
    const name = root.localName.toLowerCase();
    if (name === "feed") return parseAtom(root, base, type);
    if (name === "rss" || name === "rdf") {
      const ch = kid(root, "channel") || root;
      const items = kids(ch, "item").concat(name === "rdf" ? kids(root, "item") : []);
      const img = kid(ch, "image") || kid(root, "image");
      return {
        kind: "rss", title: txt(ch, "title"), icon: img ? safeUrl(txt(img, "url") || img.getAttribute("href"), base) || null : null,
        next: "", items: items.map((it) => rssItem(it, base)),
      };
    }
    return null;
  }

  function labelFor(type, url) {
    type = String(type || "").toLowerCase();
    if (/epub/.test(type) || /\.epub/i.test(url || "")) return "EPUB";
    if (/pdf/.test(type)) return "PDF";
    if (/mobipocket|x-mobi/.test(type)) return "MOBI";
    if (/cbz|comicbook\+zip/.test(type)) return "CBZ";
    if (/cbr|comicbook-rar/.test(type)) return "CBR";
    if (/^audio\//.test(type)) return "Audio";
    if (/^video\//.test(type)) return "Video";
    if (/^text\/plain/.test(type)) return "Plain text";
    if (/html/.test(type)) return "Web page";
    return "File";
  }

  function kindForFiles(files) {
    if (files.some((f) => /^video\//.test(f.type || ""))) return "video";
    return "page";
  }

  function rssItem(it, base) {
    const link = txt(it, "link") || ((kid(it, "guid") && kid(it, "guid").getAttribute("isPermaLink") !== "false") ? txt(it, "guid") : "") || it.getAttribute("rdf:about");
    const desc = txt(it, "description");
    const body = txt(it, "encoded") || desc;
    const files = kids(it, "enclosure").map((e) => ({ label: labelFor(e.getAttribute("type"), e.getAttribute("url")), url: e.getAttribute("url"), type: e.getAttribute("type") }));
    const media = kids(it, "thumbnail").concat(kids(it, "content").filter((c) => /^image/.test(c.getAttribute("type") || "") || c.getAttribute("medium") === "image"));
    const itimg = kid(it, "image");
    const imgFile = files.find((f) => /^image\//.test(f.type || ""));
    return {
      docId: txt(it, "guid") || link || txt(it, "title"), title: stripHtml(txt(it, "title")), url: safeUrl(link, base),
      snippet: desc, text: stripHtml(body).slice(0, PAGE_TEXT_CAP), by: txt(it, "creator") || txt(it, "author"),
      year: txt(it, "pubDate") || txt(it, "date"), duration: txt(it, "duration"),
      image: (media[0] && media[0].getAttribute("url")) || (itimg && itimg.getAttribute("href")) || (imgFile && imgFile.url) || firstImg(body, base),
      files: files.filter((f) => !/^image\//.test(f.type || "")), kind: kindForFiles(files),
    };
  }

  function firstImg(html, base) {
    const m = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(String(html || ""));
    return m ? safeUrl(m[1], base) : "";
  }

  function atomLinks(el, base) {
    return kids(el, "link").map((l) => ({
      rel: (l.getAttribute("rel") || "alternate").trim(), type: (l.getAttribute("type") || "").toLowerCase(),
      href: safeUrl(l.getAttribute("href"), base), title: clean(l.getAttribute("title")),
    })).filter((l) => l.href);
  }

  function parseAtom(root, base, type) {
    const links = atomLinks(root, base);
    const next = links.find((l) => l.rel === "next");
    const opds = isOpdsType(type) || links.some((l) => isOpdsType(l.type) || /^http:\/\/opds-spec\.org\//.test(l.rel)) ||
      /opds-spec\.org/.test(root.namespaceURI + " " + Array.prototype.map.call(root.attributes, (a) => a.value).join(" "));
    const items = kids(root, "entry").map((e) => {
      const el = atomLinks(e, base);
      const alt = el.find((l) => l.rel === "alternate" && (!l.type || /html/.test(l.type))) || el.find((l) => l.rel === "alternate");
      const acq = el.filter((l) => /^http:\/\/opds-spec\.org\/acquisition/.test(l.rel));
      const img = el.find((l) => l.rel === "http://opds-spec.org/image" || l.rel === "x-stanza-cover-image") || el.find((l) => /opds-spec\.org\/image\/thumbnail|thumbnail/.test(l.rel));
      const enc = el.filter((l) => l.rel === "enclosure");
      const nav = el.filter((l) => !acq.length && /atom\+xml|opds/.test(l.type) && !/^http:\/\/opds-spec\.org\/(image|acquisition)/.test(l.rel));
      const authors = kids(e, "author").map((a) => txt(a, "name"));
      const contentEl = kid(e, "content");
      const content = contentEl ? (/html/.test(contentEl.getAttribute("type") || "") ? stripHtml(contentEl.textContent) : clean(contentEl.textContent)) : "";
      const summary = txt(e, "summary");
      const files = acq.map((l) => ({ label: l.title || labelFor(l.type, l.href), url: l.href, type: l.type.split(";")[0] }))
        .concat(enc.map((l) => ({ label: labelFor(l.type, l.href), url: l.href, type: l.type })));
      const epub = files.find((f) => /epub/.test(f.type)) || files.find((f) => /pdf/.test(f.type));
      const idText = txt(e, "id");
      return {
        docId: idText || (alt && alt.href) || txt(e, "title"), title: txt(e, "title"),
        url: (alt && alt.href) || (acq[0] && acq[0].href) || safeUrl(idText, base),
        snippet: summary || content, text: (content || stripHtml(summary)).slice(0, PAGE_TEXT_CAP),
        by: joinNames(authors), year: txt(e, "issued") || txt(e, "published") || txt(e, "updated"),
        image: img ? img.href : "", files, readUrl: acq.length && epub ? epub.url : "",
        kind: acq.length ? "book" : kindForFiles(files), isBook: acq.length > 0,
        nav: nav.map((l) => l.href),
      };
    });
    const icon = txt(root, "icon") || txt(root, "logo");
    return { kind: "atom", title: txt(root, "title"), icon: icon ? safeUrl(icon, base) || null : null, next: next ? next.href : "", opds, items, links };
  }

  function feedResults(feed, sourceId, base) {
    return feed.items.filter((it) => it.title || it.url).map((it) => norm(sourceId, Object.assign({}, it, { id: it.docId }), base));
  }

  // ---------- Live results from a site's own search (template and opensearch) ----------

  function parseLive(res, sourceId, q) {
    const t = res.text.trim();
    const feed = (/json|xml|rss|atom/.test(res.type) || /^[<{[]/.test(t)) && !/html/.test(res.type) ? parseFeed(t, res.url, res.type) : null;
    if (feed) return feedResults(feed, sourceId, res.url).slice(0, 20);
    if (/json/.test(res.type) || /^[{[]/.test(t)) {
      let j;
      try { j = JSON.parse(t); } catch (e) { throw new SourceError("parse", "Bad JSON"); }
      return genericJson(j, sourceId, res.url);
    }
    if (/^<\?xml|^<rss|^<feed/i.test(t) && !/html/.test(res.type)) throw new SourceError("parse", "Unknown XML");
    return htmlResults(t, res.url, sourceId);
  }

  // A JSON answer that is not a JSON Feed: find the first array of objects with a title and a link.
  function genericJson(j, sourceId, base) {
    const titleKeys = ["title", "name", "display_name", "headline", "label"];
    const urlKeys = ["url", "link", "href", "permalink", "html_url", "web_url"];
    const pick = (o, keys) => { for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k]; return ""; };
    const queue = [j];
    let n = 0;
    while (queue.length && n++ < 2000) {
      const v = queue.shift();
      if (Array.isArray(v)) {
        const objs = v.filter((o) => o && typeof o === "object" && !Array.isArray(o));
        if (objs.length && objs.some((o) => pick(o, titleKeys) && pick(o, urlKeys))) {
          return objs.map((o) => norm(sourceId, {
            id: pick(o, ["id", ...urlKeys]), title: pick(o, titleKeys), url: pick(o, urlKeys),
            snippet: pick(o, ["snippet", "summary", "description", "excerpt", "body", "content"]),
            by: pick(o, ["author", "by", "creator"]), year: pick(o, ["date", "published", "year", "created_at"]),
            image: pick(o, ["image", "thumbnail", "cover"]),
          }, base)).filter((r) => r.url).slice(0, 20);
        }
        for (const x of v) if (x && typeof x === "object") queue.push(x);
      } else if (v && typeof v === "object") {
        for (const k of Object.keys(v)) if (v[k] && typeof v[k] === "object") queue.push(v[k]);
      }
    }
    return [];
  }

  // Keep result-like links from an HTML results page: same site, text of at least 12 chars,
  // inside main or the largest repeated block, not nav, header or footer, deduped, max 20.
  function htmlResults(html, pageUrl, sourceId) {
    const doc = dom(html);
    const page = new URL(pageUrl);
    doc.querySelectorAll(STRIP).forEach((e) => e.remove());
    const scope = doc.querySelector("main,[role=main]") || doc.body;
    if (!scope) return [];
    const okLink = (a) => {
      const href = safeUrl(a.getAttribute("href"), pageUrl);
      if (!href) return "";
      const u = new URL(href);
      if (!sameSite(u.hostname, page.hostname)) return "";
      u.hash = "";
      if (u.pathname === page.pathname && u.search === page.search) return "";
      if (clean(a.textContent).length < 12) return "";
      return u.href;
    };
    const linksIn = (el) => el.matches("a[href]") ? [el] : Array.from(el.querySelectorAll("a[href]"));
    let best = null, bestN = 0;
    const all = [scope].concat(Array.from(scope.querySelectorAll("*")).slice(0, 8000));
    for (const el of all) {
      if (el.children.length < 3) continue;
      const groups = new Map();
      for (const c of el.children) {
        const sig = c.localName + "." + Array.from(c.classList).filter((x) => !/^(active|selected|first|last|odd|even)$/.test(x)).sort().join(".");
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(c);
      }
      for (const list of groups.values()) {
        if (list.length < 3) continue;
        const n = list.filter((k) => linksIn(k).some(okLink)).length;
        if (n >= 3 && n > bestN) { best = list; bestN = n; }
      }
    }
    const seen = new Set();
    const out = [];
    const push = (a, block) => {
      const url = okLink(a);
      if (!url || seen.has(url) || out.length >= 20) return;
      seen.add(url);
      const head = block && block.querySelector("h1,h2,h3,h4,h5");
      const title = clean((head && head.contains(a) ? head : a).textContent);
      const blockText = block ? clean(block.textContent) : "";
      const img = block && block.querySelector("img[src]");
      out.push(norm(sourceId, {
        id: url, url, title, snippet: blockText.replace(title, "").trim(),
        image: img ? img.getAttribute("src") : "", kind: "page",
      }, pageUrl));
    };
    if (best) {
      for (const k of best) {
        const links = linksIn(k).filter(okLink);
        const inHead = links.find((a) => a.closest("h1,h2,h3,h4,h5"));
        if (links.length) push(inHead || links[0], k);
      }
    } else {
      for (const a of scope.querySelectorAll("a[href]")) push(a, a.closest("li,article,section,p,div") || a.parentElement);
    }
    return out;
  }

  function fillTemplate(t, q) { return String(t).replace(/\{q\}/g, encodeURIComponent(q)); }

  // ---------- OpenSearch description ----------

  function osdTemplate(t) {
    return String(t).replace(/\{([^}]+)\}/g, (m, name) => {
      const opt = /\?$/.test(name);
      const local = name.replace(/\?$/, "").split(":").pop();
      if (local === "searchTerms") return "{q}";
      if (opt) return "";
      if (local === "count") return "20";
      if (local === "startIndex" || local === "startPage") return "1";
      if (local === "language") return "*";
      if (local === "inputEncoding" || local === "outputEncoding") return "UTF-8";
      return "";
    });
  }

  function absTemplate(t, base) {
    // new URL() would escape the braces, so swap {q} out while resolving.
    const MARK = "POLYCARPQUERYMARK";
    try { return new URL(t.replace(/\{q\}/g, MARK), base).href.replace(new RegExp(MARK, "g"), "{q}"); } catch (e) { return ""; }
  }

  function parseOsd(text, base) {
    const doc = xml(text);
    if (!doc || doc.documentElement.localName !== "OpenSearchDescription") return null;
    const root = doc.documentElement;
    const urls = kids(root, "Url").map((u) => ({
      type: (u.getAttribute("type") || "").toLowerCase(), rel: (u.getAttribute("rel") || "results").toLowerCase(),
      method: (u.getAttribute("method") || "get").toLowerCase(), template: u.getAttribute("template") || "",
    })).filter((u) => u.template && u.method === "get" && u.rel.split(/\s+/).indexOf("results") >= 0 && !/suggestions/.test(u.type));
    const pick = urls.find((u) => /rss|atom/.test(u.type)) || urls.find((u) => /json/.test(u.type)) || urls.find((u) => /html/.test(u.type)) || urls[0];
    if (!pick) return null;
    const template = absTemplate(osdTemplate(pick.template), base);
    if (!template || template.indexOf("{q}") < 0) return null;
    return {
      name: txt(root, "ShortName") || txt(root, "LongName"), icon: safeUrl(txt(root, "Image"), base) || null,
      template, format: /rss|atom/.test(pick.type) ? "feed" : /json/.test(pick.type) ? "json" : "html",
    };
  }

  // ---------- Robots and sitemaps ----------

  function parseRobots(text) {
    const groups = [];
    const sitemaps = [];
    let cur = null, lastWasAgent = false;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase(), val = m[2].trim();
      if (key === "user-agent") {
        if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
        cur.agents.push(val.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (key === "sitemap") { if (val) sitemaps.push(val); continue; }
      if (!cur) continue;
      if (key === "disallow" || key === "allow") cur.rules.push({ allow: key === "allow", path: val });
      else if (key === "crawl-delay") cur.delay = parseFloat(val) || 0;
    }
    const mine = groups.filter((g) => g.agents.some((a) => a.indexOf("polycarp") >= 0));
    const use = mine.length ? mine : groups.filter((g) => g.agents.indexOf("*") >= 0);
    const rules = [].concat.apply([], use.map((g) => g.rules)).filter((r) => r.path);
    const delay = Math.max(0, ...use.map((g) => g.delay));
    const compiled = rules.map((r) => {
      const anchored = r.path.endsWith("$");
      const body = (anchored ? r.path.slice(0, -1) : r.path).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      return { allow: r.allow, len: r.path.length, re: new RegExp("^" + body + (anchored ? "$" : "")) };
    });
    return {
      sitemaps, delay,
      allowed(pathAndQuery) {
        let best = null;
        for (const r of compiled) {
          if (!r.re.test(pathAndQuery)) continue;
          if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
        }
        return !best || best.allow;
      },
    };
  }

  async function readSitemaps(urls, fetcher, opts) {
    opts = opts || {};
    const queue = urls.slice();
    const seen = new Set();
    const pages = [];
    let files = 0, indexChildren = 0, indexRead = 0, found = "";
    while (queue.length && files < (opts.maxFiles || SITEMAP_FILES_MAX) && pages.length < (opts.maxPages || 50000)) {
      const u = queue.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      let res;
      try { res = await fetcher(u); } catch (e) { if (e && e.code === "stopped") throw e; continue; }
      files++;
      if (!res || !res.ok || !res.text) continue;
      const doc = xml(res.text);
      if (!doc) continue;
      const root = doc.documentElement.localName;
      const locs = Array.prototype.map.call(doc.getElementsByTagNameNS("*", "loc"), (l) => clean(l.textContent)).filter(Boolean);
      if (root === "sitemapindex") {
        if (!found) found = u;
        indexChildren += locs.length;
        for (const l of locs) queue.push(l);
      } else if (root === "urlset") {
        if (!found) found = u;
        if (indexChildren) indexRead++;
        for (const l of locs) pages.push(l);
      }
    }
    // When a sitemap index has more files than were read, scale the count up.
    let estimate = pages.length;
    if (indexChildren > indexRead && indexRead > 0) estimate = Math.round(pages.length / indexRead * indexChildren);
    return { pages, sitemapUrl: found, estimate };
  }

  // ---------- Crawl scope ----------

  function scopeOf(startUrl) {
    const u = new URL(startUrl);
    const path = u.pathname || "/";
    let prefix, exact = "";
    if (path.endsWith("/")) prefix = path;
    else {
      const last = path.slice(path.lastIndexOf("/") + 1);
      if (/\.[a-z0-9]{1,5}$/i.test(last)) prefix = path.slice(0, path.lastIndexOf("/") + 1);
      else { prefix = path + "/"; exact = path; }
    }
    return {
      origin: u.origin, prefix,
      inPrefix(p) { return p === exact || p.startsWith(prefix); },
    };
  }

  // One request at a time, at least delayMs after the previous one ended.
  function politeFetcher(signal, delayMs) {
    let last = 0;
    const f = async (url, o) => {
      const wait = last + f.delay - Date.now();
      if (last && wait > 0) await sleep(wait, signal);
      try { return await get(url, Object.assign({ signal, timeout: 15000, allowError: true }, o || {})); }
      finally { last = Date.now(); }
    };
    f.delay = delayMs;
    return f;
  }

  // ---------- Page extraction for the crawler ----------

  function extractPage(html, url) {
    const doc = dom(html);
    const meta = (sel) => { const m = doc.querySelector(sel); return m ? clean(m.getAttribute("content")) : ""; };
    const robots = (meta("meta[name=robots]") + " " + meta("meta[name=polycarp]")).toLowerCase();
    const links = Array.from(doc.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    const h1 = doc.querySelector("h1");
    const title = meta("meta[property='og:title']") || clean(doc.title) || (h1 ? clean(h1.textContent) : "");
    doc.querySelectorAll(STRIP).forEach((e) => e.remove());
    const main = doc.querySelector("main,[role=main]") || doc.querySelector("article") || doc.body;
    const imgEl = main && main.querySelector("img[src]:not([src^='data:'])");
    const image = safeUrl(meta("meta[property='og:image']"), url) || (imgEl ? safeUrl(imgEl.getAttribute("src"), url) : "");
    let text = "";
    if (main) {
      main.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,br,tr,td,th,section,article,blockquote,pre,dd,dt,figcaption").forEach((e) => e.append(" "));
      text = clean(main.textContent).slice(0, PAGE_TEXT_CAP);
    }
    return {
      title: title || url, image, text, links,
      noindex: /noindex|none/.test(robots), nofollow: /nofollow|none/.test(robots),
      description: meta("meta[name=description]") || meta("meta[property='og:description']"),
    };
  }

  function normPageUrl(href, base) {
    const s = safeUrl(href, base);
    if (!s) return "";
    const u = new URL(s);
    u.hash = "";
    const drop = [];
    u.searchParams.forEach((v, k) => { if (/^(utm_|fbclid$|gclid$|ref$|mc_)/i.test(k)) drop.push(k); });
    drop.forEach((k) => u.searchParams.delete(k));
    return u.href;
  }

  async function crawl(def, opts) {
    const signal = opts.signal;
    const cap = Math.max(1, Math.min(CRAWL_MAX, opts.maxPages || def.maxPages || CRAWL_DEFAULT));
    const http = politeFetcher(signal, opts.delayMs == null ? API.CRAWL_DELAY_MS : opts.delayMs);
    const start = normPageUrl(def.url);
    if (!start) throw new SourceError("parse", "Bad start URL");
    const scope = scopeOf(start);
    let robots = parseRobots("");
    try {
      const r = await http(scope.origin + "/robots.txt", { accept: "text/plain" });
      if (r.ok && !/html/.test(r.type)) robots = parseRobots(r.text);
    } catch (e) { if (e.code === "stopped") throw e; }
    if (robots.delay) http.delay = Math.max(http.delay, Math.min(10000, robots.delay * 1000));
    const pathOf = (u) => { const x = new URL(u); return x.pathname + x.search; };

    const smUrls = def.sitemapUrl ? [def.sitemapUrl] : robots.sitemaps.length ? robots.sitemaps : [scope.origin + "/sitemap.xml"];
    const sm = await readSitemaps(smUrls, (u) => http(u, { accept: "application/xml,text/xml" }), { maxPages: cap * 4 });
    const listed = sm.pages.map((p) => normPageUrl(p)).filter((p) => p && p.startsWith(scope.origin + "/"));
    const inPrefix = listed.filter((p) => scope.inPrefix(new URL(p).pathname));
    const fromSitemap = scope.prefix !== "/" && inPrefix.length ? inPrefix : listed;
    const follow = !fromSitemap.length;

    const queue = [start].concat(fromSitemap);
    const queued = new Set(queue);
    const saved = new Set();
    let batch = [];
    let fetched = 0, skipped = 0;
    const flush = async () => { if (batch.length) { await globalThis.PolycarpSearchIndex.put(def.id, batch); batch = []; } };
    const total = () => Math.min(cap, follow ? saved.size + queue.length : queued.size);
    const progress = () => { try { if (opts.onProgress) opts.onProgress(saved.size, total()); } catch (e) { /* UI errors stay in the UI */ } };

    try {
      while (queue.length && saved.size < cap && fetched < cap * 3) {
        const url = queue.shift();
        const p = pathOf(url);
        if (!robots.allowed(p)) { skipped++; continue; }
        if (SKIP_EXT.test(new URL(url).pathname)) { skipped++; continue; }
        let res;
        try { res = await http(url, { accept: "text/html,application/xhtml+xml", only: /html|^$/ }); }
        catch (e) { if (e.code === "stopped") throw e; skipped++; continue; }
        fetched++;
        if (res.skipped || !res.ok) { skipped++; continue; }
        const finalUrl = normPageUrl(res.url) || url;
        if (!finalUrl.startsWith(scope.origin + "/")) { skipped++; continue; }
        const page = extractPage(res.text, finalUrl);
        if (!page.noindex && !saved.has(finalUrl)) {
          saved.add(finalUrl);
          batch.push({ docId: finalUrl, url: finalUrl, title: page.title, text: page.text || page.description, image: page.image, kind: "page" });
          if (batch.length >= 20) await flush();
        }
        if (follow && !page.nofollow) {
          for (const href of page.links) {
            const n = normPageUrl(href, finalUrl);
            if (!n || queued.has(n) || !n.startsWith(scope.origin + "/")) continue;
            const np = new URL(n).pathname;
            if (!scope.inPrefix(np) || SKIP_EXT.test(np)) continue;
            queued.add(n);
            queue.push(n);
          }
        }
        progress();
      }
      await flush();
    } catch (e) {
      await flush().catch(() => {});
      if (e && e.code === "stopped") return { count: saved.size, stopped: true, skipped };
      throw e;
    }
    // Drop pages that are gone since the last full crawl.
    const old = await globalThis.PolycarpSearchIndex.docIds(def.id);
    await globalThis.PolycarpSearchIndex.remove(def.id, old.filter((id) => !saved.has(id)));
    return { count: saved.size, skipped };
  }

  async function refreshFeed(def, opts) {
    const http = politeFetcher(opts.signal, opts.delayMs == null ? API.CRAWL_DELAY_MS : opts.delayMs);
    let next = def.feedUrl || def.url;
    const seen = new Set();
    let pages = 0, n = 0;
    while (next && !seen.has(next) && pages < FEED_PAGES_MAX) {
      seen.add(next);
      const res = await http(next, { accept: "application/rss+xml,application/atom+xml,application/feed+json,application/xml;q=0.9,*/*;q=0.5", allowError: false });
      const feed = parseFeed(res.text, res.url, res.type);
      if (!feed) { if (!pages) throw new SourceError("parse", "Not a feed"); break; }
      pages++;
      const docs = feed.items.filter((it) => it.title || it.url).map((it) => Object.assign({}, norm(def.id, Object.assign({}, it, { id: it.docId }), res.url), { docId: it.docId || it.url, text: it.text || it.snippet }));
      n += await globalThis.PolycarpSearchIndex.put(def.id, docs);
      try { if (opts.onProgress) opts.onProgress(pages, Math.max(pages, feed.next ? pages + 1 : pages)); } catch (e) { /* ignore */ }
      next = feed.next;
    }
    return { count: await globalThis.PolycarpSearchIndex.count(def.id), added: n };
  }

  async function refreshOpds(def, opts) {
    const cap = Math.max(1, Math.min(CRAWL_MAX, opts.maxPages || def.maxPages || CRAWL_DEFAULT));
    const http = politeFetcher(opts.signal, opts.delayMs == null ? API.CRAWL_DELAY_MS : opts.delayMs);
    const start = def.opdsUrl || def.url;
    const origin = new URL(start).origin;
    const queue = [start];
    const seen = new Set(queue);
    const books = new Map();
    let reads = 0, batch = [];
    const flush = async () => { if (batch.length) { await globalThis.PolycarpSearchIndex.put(def.id, batch); batch = []; } };
    try {
      while (queue.length && reads < cap) {
        const u = queue.shift();
        let res;
        try { res = await http(u, { accept: "application/atom+xml;profile=opds-catalog,application/atom+xml,application/xml;q=0.9", allowError: false }); }
        catch (e) { if (e.code === "stopped") throw e; if (!reads) throw e; continue; }
        reads++;
        const feed = parseFeed(res.text, res.url, res.type);
        if (!feed || feed.kind !== "atom") { if (reads === 1) throw new SourceError("parse", "Not an OPDS catalog"); continue; }
        const more = [];
        if (feed.next) more.push(feed.next);
        for (const it of feed.items) {
          if (it.isBook) {
            const id = it.docId || it.url;
            if (!books.has(id)) {
              const r = norm(def.id, Object.assign({}, it, { id }), res.url);
              books.set(id, true);
              batch.push(Object.assign(r, { docId: id, text: it.text || it.snippet }));
              if (batch.length >= 50) await flush();
            }
          } else for (const l of it.nav) more.push(l);
        }
        for (const l of more) if (l && !seen.has(l) && l.startsWith(origin + "/")) { seen.add(l); queue.push(l); }
        try { if (opts.onProgress) opts.onProgress(reads, Math.min(cap, reads + queue.length)); } catch (e) { /* ignore */ }
      }
      await flush();
    } catch (e) {
      await flush().catch(() => {});
      if (e && e.code === "stopped") return { count: books.size, stopped: true };
      throw e;
    }
    const old = await globalThis.PolycarpSearchIndex.docIds(def.id);
    await globalThis.PolycarpSearchIndex.remove(def.id, old.filter((id) => !books.has(id)));
    return { count: books.size };
  }

  function listDocs(def) {
    return (def.items || []).map((it) => Object.assign({}, it, { docId: it.id, text: it.text || it.snippet || "" }));
  }

  // ---------- detect ----------

  const NOTES = {
    opensearch: "Found this site's own search. Polycarp will ask it directly.",
    feed: "Found a feed. Polycarp will save its posts on this device and search them here.",
    opds: "Found a book catalog. Polycarp will list its books on this device and search them here.",
    template: "Polycarp will put your search words into this link and read the results.",
  };

  function siteName(doc, fallback) {
    if (!doc) return fallback;
    const og = doc.querySelector("meta[property='og:site_name']");
    const t = (og && clean(og.getAttribute("content"))) || clean(doc.title);
    return t ? t.slice(0, 80) : fallback;
  }

  function pageIcon(doc, base) {
    const l = doc && (doc.querySelector("link[rel~='icon' i]") || doc.querySelector("link[rel='apple-touch-icon' i]"));
    return (l && safeUrl(l.getAttribute("href"), base)) || safeUrl("/favicon.ico", base) || null;
  }

  function opdsLink(doc, base) {
    for (const l of doc.querySelectorAll("link[href]")) {
      const type = (l.getAttribute("type") || "").toLowerCase();
      if (isOpdsType(type)) return safeUrl(l.getAttribute("href"), base);
    }
    return "";
  }

  function feedLink(doc, base) {
    for (const l of doc.querySelectorAll("link[rel~='alternate' i][href]")) {
      const type = (l.getAttribute("type") || "").toLowerCase();
      if (/rss\+xml|atom\+xml|feed\+json|rdf\+xml/.test(type) && !isOpdsType(type)) return safeUrl(l.getAttribute("href"), base);
    }
    return "";
  }

  async function osdFrom(doc, base, signal) {
    const l = doc && doc.querySelector("link[rel~='search' i][type='application/opensearchdescription+xml' i][href]");
    if (!l) return null;
    const osdUrl = safeUrl(l.getAttribute("href"), base);
    if (!osdUrl) return null;
    try {
      const r = await get(osdUrl, { signal, accept: "application/opensearchdescription+xml,application/xml" });
      return parseOsd(r.text, r.url);
    } catch (e) { if (e.code === "stopped") throw e; return null; }
  }

  async function detect(input, opts) {
    opts = opts || {};
    const signal = opts.signal;
    let url = clean(input);
    if (!url) throw new Error("Paste a link first.");
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    if (/\{q\}|%s/.test(url)) {
      const template = url.replace(/%s/g, "{q}");
      if (!safeUrl(template.replace(/\{q\}/g, "x"))) throw new Error("That does not look like a web link.");
      return { type: "template", name: hostOf(template) || "Custom search", icon: null, url: template, template, note: NOTES.template };
    }
    if (!safeUrl(url)) throw new Error("Polycarp can only use web links that start with http or https.");
    let res;
    try { res = await get(url, { signal, accept: "text/html,application/xhtml+xml,application/atom+xml,application/rss+xml,application/feed+json,application/xml;q=0.9,*/*;q=0.8" }); }
    catch (e) { if (e.code === "stopped") throw e; throw new Error("Polycarp could not open that link."); }
    const final = res.url || url;
    const body = res.text.trim();
    const host = hostOf(final);
    const isHtml = /html/.test(res.type) || (!res.type && /^<(!doctype|html)/i.test(body));

    if (!isHtml) {
      if (/^<\?xml|^</.test(body)) {
        const osd = parseOsd(body, final);
        if (osd) return { type: "opensearch", name: osd.name || host, icon: osd.icon, url: final, template: osd.template, format: osd.format, note: NOTES.opensearch };
        const d = xml(body);
        const root = d && d.documentElement.localName;
        if (root === "urlset" || root === "sitemapindex") return crawlProposal(final, null, signal, final);
      }
      const feed = parseFeed(body, final, res.type);
      if (feed) {
        if (feed.kind === "atom" && feed.opds) return { type: "opds", name: feed.title || host, icon: feed.icon, url: final, opdsUrl: final, estimate: null, note: NOTES.opds };
        return { type: "feed", name: feed.title || host, icon: feed.icon, url: final, feedUrl: final, estimate: feed.items.length, note: NOTES.feed };
      }
      return crawlProposal(final, null, signal);
    }

    const doc = dom(body);
    const name = siteName(doc, host);
    const icon = pageIcon(doc, final);
    let osd = await osdFrom(doc, final, signal);
    if (!osd) {
      const root = new URL(final).origin + "/";
      if (final !== root) {
        try {
          const r = await get(root, { signal, accept: "text/html" });
          if (/html/.test(r.type)) osd = await osdFrom(dom(r.text), r.url, signal);
        } catch (e) { if (e.code === "stopped") throw e; }
      }
    }
    if (osd) return { type: "opensearch", name: osd.name || name, icon: osd.icon || icon, url: final, template: osd.template, format: osd.format, note: NOTES.opensearch };
    const opds = opdsLink(doc, final);
    if (opds) return { type: "opds", name, icon, url: final, opdsUrl: opds, estimate: null, note: NOTES.opds };
    const feedUrl = feedLink(doc, final);
    if (feedUrl) return { type: "feed", name, icon, url: final, feedUrl, estimate: null, note: NOTES.feed };
    return crawlProposal(final, { name, icon }, signal);
  }

  async function crawlProposal(url, info, signal, sitemapUrl) {
    const scope = scopeOf(url);
    const name = (info && info.name) || hostOf(url);
    const icon = (info && info.icon) || safeUrl("/favicon.ico", url) || null;
    let robots = parseRobots("");
    try {
      const r = await get(scope.origin + "/robots.txt", { signal, accept: "text/plain", allowError: true, timeout: 8000 });
      if (r.ok && !/html/.test(r.type)) robots = parseRobots(r.text);
    } catch (e) { if (e.code === "stopped") throw e; }
    const start = new URL(url);
    if (!sitemapUrl && !robots.allowed(start.pathname + start.search)) {
      return { type: "crawl", name, icon, url, estimate: 0, note: "This site asks automated readers to stay out of this part, so Polycarp will not save it." };
    }
    const smUrls = sitemapUrl ? [sitemapUrl] : robots.sitemaps.length ? robots.sitemaps : [scope.origin + "/sitemap.xml"];
    let sm = { pages: [], sitemapUrl: "", estimate: 0 };
    try { sm = await readSitemaps(smUrls, (u) => get(u, { signal, accept: "application/xml,text/xml", allowError: true, timeout: 8000 }), { maxFiles: 5 }); }
    catch (e) { if (e.code === "stopped") throw e; }
    const out = { type: "crawl", name, icon, url: sitemapUrl ? scope.origin + "/" : url };
    if (sm.sitemapUrl) {
      const inPrefix = sm.pages.filter((p) => { try { const x = new URL(p); return x.origin === scope.origin && scope.inPrefix(x.pathname); } catch (e) { return false; } });
      const est = scope.prefix !== "/" && inPrefix.length ? Math.round(sm.estimate * inPrefix.length / Math.max(1, sm.pages.length)) : sm.estimate;
      out.sitemapUrl = sm.sitemapUrl;
      out.estimate = est;
      out.note = "Found a site map with about " + est + " page" + (est === 1 ? "" : "s") + ". Polycarp will save up to " + Math.min(est, CRAWL_DEFAULT) + " of them on this device, one at a time.";
    } else {
      out.estimate = null;
      out.note = "Polycarp will read up to " + CRAWL_DEFAULT + " pages under this address, one at a time, and save them on this device.";
    }
    return out;
  }

  // ---------- Custom sources ----------

  const IDX = () => {
    const I = globalThis.PolycarpSearchIndex;
    if (!I) throw new Error("search-index.js must load before sources.js");
    return I;
  };

  const DEF_FIELDS = ["type", "name", "icon", "url", "template", "format", "feedUrl", "opdsUrl", "sitemapUrl", "estimate", "note", "on", "maxPages", "key", "items", "blurb"];

  async function addCustom(def) {
    def = def || {};
    if (CUSTOM_TYPES.indexOf(def.type) < 0) throw new Error("Unknown source type: " + def.type);
    const now = Date.now();
    const rec = { id: def.id && !RUNNERS[def.id] ? String(def.id) : makeId("c-"), created: now, updated: now, lastRefresh: 0, count: 0 };
    for (const k of DEF_FIELDS) if (def[k] !== undefined) rec[k] = def[k];
    rec.name = clean(def.name) || hostOf(def.url || def.template || "") || "Custom source";
    rec.on = def.on !== false;
    if (rec.type === "list") rec.items = (def.items || []).map((it) => norm(rec.id, it, def.url));
    await IDX().putSource(rec);
    return rec;
  }

  async function listCustom() {
    const all = await IDX().allSources();
    return all.sort((a, b) => (a.created || 0) - (b.created || 0));
  }

  async function getCustom(id) { return IDX().getSource(id); }

  async function updateCustom(id, patch) {
    const cur = await IDX().getSource(id);
    if (!cur) throw new Error("No source with id " + id);
    const next = Object.assign({}, cur);
    for (const k of DEF_FIELDS.concat(["lastRefresh", "count", "partial"])) if (patch && patch[k] !== undefined) next[k] = patch[k];
    next.id = cur.id;
    next.type = cur.type;
    next.updated = Date.now();
    await IDX().putSource(next);
    return next;
  }

  async function removeCustom(id) {
    await IDX().clear(id);
    await IDX().deleteSource(id);
    return true;
  }

  // Build or update the local index for feed, opds, crawl and list sources.
  // opts: { signal, maxPages (crawl and opds, up to 2000), delayMs }
  async function refresh(id, onProgress, opts) {
    opts = Object.assign({}, opts || {}, { onProgress });
    const def = await IDX().getSource(id);
    if (!def) throw new Error("No source with id " + id);
    let out;
    if (def.type === "feed") out = await refreshFeed(def, opts);
    else if (def.type === "opds") out = await refreshOpds(def, opts);
    else if (def.type === "crawl") out = await crawl(def, opts);
    else if (def.type === "list") {
      await IDX().clear(id);
      await IDX().put(id, listDocs(def));
      out = { count: (def.items || []).length };
      try { if (onProgress) onProgress(out.count, out.count); } catch (e) { /* ignore */ }
    } else return { count: 0, live: true };
    const count = await IDX().count(id);
    await updateCustom(id, { lastRefresh: Date.now(), count, partial: !!out.stopped });
    return Object.assign(out, { count });
  }

  // The lead's content script captures item lists (an Audible or Kindle library, say) and
  // hands them here. Creates or replaces a "list" source and indexes the items.
  // sourceDef: { id?, key?, name, url?, icon?, blurb? }. Matches an existing list by id, then key, then name.
  async function importItems(sourceDef, items) {
    sourceDef = sourceDef || {};
    const all = await listCustom();
    const lists = all.filter((d) => d.type === "list");
    const hit = (sourceDef.id && lists.find((d) => d.id === sourceDef.id)) ||
      (sourceDef.key && lists.find((d) => d.key === sourceDef.key)) ||
      (!sourceDef.key && sourceDef.name && lists.find((d) => d.name === clean(sourceDef.name) && !d.key));
    let def;
    if (hit) {
      def = Object.assign({}, hit, { updated: Date.now() });
      for (const k of ["name", "url", "icon", "blurb"]) if (sourceDef[k]) def[k] = k === "name" ? clean(sourceDef[k]) : sourceDef[k];
    } else {
      def = await addCustom(Object.assign({}, sourceDef, { type: "list", items: [] }));
    }
    const seen = new Set();
    def.items = (items || []).map((it, i) => {
      const r = norm(def.id, Object.assign({ kind: "item" }, it), def.url);
      if (!r.id || seen.has(r.id)) r.id = (r.id || "item") + "#" + i;
      seen.add(r.id);
      if (it && it.text) r.text = String(it.text).slice(0, PAGE_TEXT_CAP);
      return r;
    });
    await IDX().putSource(def);
    await IDX().clear(def.id);
    await IDX().put(def.id, listDocs(def));
    const count = await IDX().count(def.id);
    return updateCustom(def.id, { count, lastRefresh: Date.now() });
  }

  async function searchCustom(def, q, ctx) {
    if (INDEXED_TYPES.indexOf(def.type) >= 0) {
      const hits = await IDX().search([def.id], q, ctx.limit);
      return hits.map((h) => Object.assign(norm(def.id, h), { id: h.id, snippet: snip(h.snippet) }));
    }
    if (def.type === "template" || def.type === "opensearch") {
      const res = await get(fillTemplate(def.template, q), { signal: ctx.signal, accept: "application/rss+xml,application/atom+xml,application/json,text/html;q=0.9,*/*;q=0.5" });
      return parseLive(res, def.id, q);
    }
    return [];
  }

  // ---------- search ----------

  // search(q, { sources, signal, limit, onResults(sourceId, results, error) }) -> { [sourceId]: results }
  async function search(q, opts) {
    opts = opts || {};
    const query = clean(q);
    const limit = Math.max(1, Math.min(100, opts.limit || 20));
    let customs = [];
    const needCustom = !opts.sources || opts.sources.some((id) => !RUNNERS[id]);
    if (needCustom) { try { customs = await listCustom(); } catch (e) { customs = []; } }
    const ids = opts.sources || BUILTIN.filter((b) => b.defaultOn).map((b) => b.id).concat(customs.filter((c) => c.on !== false).map((c) => c.id));
    const out = {};
    const report = (id, res, err) => {
      out[id] = res;
      try { if (opts.onResults) opts.onResults(id, res, err); } catch (e) { /* UI errors stay in the UI */ }
    };
    await Promise.all(ids.map(async (id) => {
      const builtin = BUILTIN.find((b) => b.id === id);
      const def = builtin ? null : customs.find((c) => c.id === id);
      const name = builtin ? builtin.name : def ? def.name : id;
      if (!builtin && !def) return report(id, [], name + " is not a Polycarp source");
      if (!query) return report(id, [], null);
      const ctl = new AbortController();
      let timedOut = false;
      const parent = opts.signal;
      const onAbort = () => ctl.abort();
      if (parent) { if (parent.aborted) ctl.abort(); else parent.addEventListener("abort", onAbort, { once: true }); }
      let timer;
      const ms = opts.timeout || API.TIMEOUT_MS;
      const guard = new Promise((res, rej) => {
        timer = setTimeout(() => { timedOut = true; ctl.abort(); rej(new SourceError("timeout")); }, ms);
        ctl.signal.addEventListener("abort", () => { if (!timedOut) rej(stopped()); }, { once: true });
      });
      guard.catch(() => {});
      try {
        const ctx = { signal: ctl.signal, limit };
        const work = builtin ? RUNNERS[id](query, ctx) : searchCustom(def, query, ctx);
        const raw = await Promise.race([work, guard]);
        const res = (raw || []).map((r) => r && r.source === id && "files" in r ? r : norm(id, r)).filter((r) => r.title || r.url).slice(0, limit);
        report(id, res, null);
      } catch (e) {
        if (timedOut) e = new SourceError("timeout");
        else if (parent && parent.aborted) e = stopped();
        report(id, [], plainError(e, name));
      } finally {
        clearTimeout(timer);
        if (parent) parent.removeEventListener("abort", onAbort);
      }
    }));
    return out;
  }

  const API = {
    ENDPOINTS, BUILTIN, KINDS, CUSTOM_TYPES,
    TIMEOUT_MS: 12000,
    CRAWL_DELAY_MS: 400,
    CRAWL_DEFAULT, CRAWL_MAX,
    search, detect,
    addCustom, listCustom, getCustom, updateCustom, removeCustom, refresh, importItems,
    // Exposed for the Search page and tests.
    parseFeed, parseOsd, parseRobots, htmlResults, extractPage, norm,
  };
  globalThis.PolycarpSources = API;
})();
