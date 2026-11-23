/* Polycarp site helpers for the content script: what to read, search and leave alone on YouTube,
   X and every other page, plus clean documents for the Reader and exact source links. */
(function () {
  "use strict";
  const P = globalThis.Polycarp || (globalThis.Polycarp = {});

  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const fold = (s) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function seconds(text) {
    const m = String(text || "").match(/(\d+):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
  }
  // Text of an element, with emoji and other images read from their alt text.
  function textOf(el) {
    if (!el) return "";
    let out = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.tagName === "IMG" && n.alt) out += n.alt;
      else if (n.tagName === "BR") out += "\n";
    }
    return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  async function until(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v && (!Array.isArray(v) || v.length)) return v;
      if (Date.now() > end) return v;
      await sleep(150);
    }
  }
  // Every element matching sel, in light DOM and inside open or closed shadow roots.
  function deepAll(sel, root, out, budget) {
    root = root || document;
    out = out || [];
    budget = budget || { hosts: 400 };
    for (const el of root.querySelectorAll(sel)) out.push(el);
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName.indexOf("-") < 0) continue;
      let sr = el.shadowRoot;
      if (!sr) { try { sr = chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null; } catch (e) { sr = null; } }
      if (sr && budget.hosts-- > 0) deepAll(sel, sr, out, budget);
    }
    return out;
  }
  function visible(el) { return !!(el && el.isConnected && el.getClientRects().length); }

  // A link that opens the page scrolled to this exact passage (a text fragment).
  function fragmentUrl(text, url) {
    const words = norm(text).split(" ").filter(Boolean);
    const base = String(url || location.href).split("#")[0];
    if (!words.length) return base;
    const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D");
    if (words.length <= 10) return base + "#:~:text=" + enc(words.join(" "));
    return base + "#:~:text=" + enc(words.slice(0, 5).join(" ")) + "," + enc(words.slice(-4).join(" "));
  }

  // Build Reader documents with DOM calls so page text is never parsed as markup.
  function makeDoc(title) {
    const d = document.implementation.createHTMLDocument(title);
    const art = d.createElement("article");
    d.body.appendChild(art);
    const add = (parent, tag, text, attrs) => {
      const e = d.createElement(tag);
      if (text != null) e.textContent = text;
      if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      (parent || art).appendChild(e);
      return e;
    };
    const paras = (parent, text) => {
      for (const block of String(text || "").split(/\n{2,}/)) {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        if (!lines.length) continue;
        const p = add(parent, "p");
        lines.forEach((l, i) => { if (i) p.appendChild(d.createElement("br")); p.appendChild(d.createTextNode(l)); });
      }
    };
    return { d, art, add, paras, html: () => "<!doctype html>" + d.documentElement.outerHTML };
  }

  // ---------------------------------------------------------------- generic page
  const BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,td,th,figcaption,pre,summary,caption";
  const generic = {
    id: "web",
    blocks(limit) {
      const out = [];
      for (const el of deepAll(BLOCKS)) {
        if (out.length >= (limit || 4000)) break;
        if (el.closest("polycarp-ui,polycarp-find,script,style,noscript,[aria-hidden=true]")) continue;
        if (!/^H\d$/.test(el.tagName) && el.querySelector(BLOCKS)) continue; // keep the innermost block
        const text = norm(el.textContent);
        if (text.length < 3 || !visible(el)) continue;
        out.push({ group: "text", text, el, meta: /^H\d$/.test(el.tagName) ? "Heading" : "" });
      }
      return out;
    },
    headings() {
      const out = [];
      for (const el of deepAll("h1,h2,h3,h4,h5,h6,[role=heading][aria-level]")) {
        if (el.closest("polycarp-ui,polycarp-find,[aria-hidden=true]")) continue;
        const text = norm(el.textContent);
        if (!text || !visible(el)) continue;
        const level = /^H\d$/.test(el.tagName) ? +el.tagName[1] : (+el.getAttribute("aria-level") || 2);
        out.push({ group: "headings", text, el, level, meta: "H" + level });
      }
      return out;
    },
    links() {
      const out = [], seen = new Set();
      for (const a of deepAll("a[href]")) {
        if (out.length >= 1500) break;
        const href = a.href;
        if (!/^https?:|^mailto:/i.test(href) || seen.has(href) || a.closest("polycarp-ui,polycarp-find")) continue;
        let text = norm(a.textContent) || norm(a.getAttribute("aria-label")) || norm(a.title);
        if (!text) { const img = a.querySelector("img[alt]"); text = img ? norm(img.alt) : ""; }
        if (!text) continue;
        seen.add(href);
        let where = "";
        try { const u = new URL(href); where = u.host === location.host ? u.pathname + u.search : u.host; } catch (e) { where = href; }
        out.push({ group: "links", text, el: a, url: href, meta: where, external: (() => { try { return new URL(href).host !== location.host; } catch (e) { return false; } })() });
      }
      return out;
    },
    media() {
      const out = [];
      for (const el of deepAll("img,video,audio,iframe,svg[role=img],[role=img][aria-label]")) {
        if (out.length >= 600) break;
        if (el.closest("polycarp-ui,polycarp-find")) continue;
        const tag = el.tagName.toLowerCase();
        const r = el.getBoundingClientRect();
        if (tag === "img" && (r.width < 40 || r.height < 40) && (el.naturalWidth < 40 || el.naturalHeight < 40)) continue;
        if (tag !== "audio" && !visible(el)) continue;
        let label = norm(el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title"));
        const fig = el.closest("figure");
        const cap = fig && fig.querySelector("figcaption");
        if (cap) label = label || norm(cap.textContent);
        const src = tag === "img" ? (el.currentSrc || el.src) : tag === "iframe" ? el.src : (el.currentSrc || el.src || (el.querySelector("source[src]") || {}).src || "");
        let kind = { img: "Image", video: "Video", audio: "Audio", iframe: "Embed", svg: "Graphic" }[tag] || "Graphic";
        if (tag === "iframe") {
          try { const h = new URL(src).host.replace(/^www\./, ""); kind = /youtube|youtu\.be/.test(h) ? "YouTube video" : /vimeo/.test(h) ? "Vimeo video" : /twitter|x\.com/.test(h) ? "Post" : /spotify|soundcloud/.test(h) ? "Audio" : "Embed from " + h; } catch (e) { /* keep Embed */ }
        }
        const missing = !label && tag === "img";
        out.push({
          group: "media", el, kind, thumb: tag === "img" ? src : (tag === "video" ? el.poster : ""),
          text: label || (missing ? "No description" : kind),
          meta: kind + (r.width ? " · " + Math.round(r.width) + "×" + Math.round(r.height) : "") + (missing ? " · missing alt text" : ""),
          url: /^https?:/i.test(src) ? src : "", missing
        });
      }
      return out;
    },
    where(node, text) { return fragmentUrl(text, location.href); }
  };

  // ---------------------------------------------------------------- YouTube
  const youtube = {
    id: "youtube",
    match: (h) => /(^|\.)youtube\.com$/.test(h) && !/^music\./.test(h),
    prose: "#content-text,yt-attributed-string,ytd-text-inline-expander,#video-title,h1.ytd-watch-metadata,.ytp-caption-segment,ytd-transcript-segment-renderer .segment-text,yt-formatted-string.ytd-comment-renderer",
    skip: "#masthead-container,#guide,ytd-mini-guide-renderer,tp-yt-app-drawer,.ytp-chrome-top,.ytp-chrome-bottom,.ytp-popup,.ytp-tooltip,.ytp-ce-element,yt-chip-cloud-renderer,ytd-searchbox,#chips",
    videoId() {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/);
      return m ? m[1] : null;
    },
    isWatch() { return !!this.videoId(); },
    title() {
      const h = document.querySelector("h1.ytd-watch-metadata, ytd-watch-metadata h1, #title h1");
      return norm(h && h.textContent) || document.title.replace(/\s*-\s*YouTube$/, "");
    },
    channel() {
      const c = document.querySelector("ytd-watch-metadata #owner #channel-name a, ytd-video-owner-renderer #channel-name a, #upload-info #channel-name a, ytd-channel-name a");
      return norm(c && c.textContent);
    },
    description() {
      const d = document.querySelector("ytd-watch-metadata #description-inline-expander yt-attributed-string, #description-inline-expander, ytd-text-inline-expander, #description yt-formatted-string");
      const t = d ? textOf(d) : "";
      if (t) return t.replace(/\s*(Show less|\.\.\.more)\s*$/i, "");
      const meta = document.querySelector('meta[name="description"]');
      return meta ? meta.content : "";
    },
    readSegments() {
      const out = [];
      for (const el of document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model")) {
        const tsEl = el.querySelector(".segment-timestamp, [class*='imestamp']");
        const all = norm(el.textContent);
        const t = seconds(tsEl ? tsEl.textContent : all);
        const txEl = el.querySelector(".segment-text, [class*='egmentText'], [class*='segment-text']");
        let text = norm(txEl ? txEl.textContent : all.replace(/^\s*\d+:\d{2}(?::\d{2})?/, ""));
        if (t == null || !text) continue;
        out.push({ t, text, el });
      }
      return out;
    },
    // Caption tracks named in the watch page, read as JSON. YouTube may refuse these; the open
    // transcript panel is tried first.
    async fromCaptions() {
      try {
        const html = await (await fetch(location.href, { credentials: "include" })).text();
        const at = html.indexOf('"captionTracks":');
        if (at < 0) return [];
        let i = html.indexOf("[", at), depth = 0, j = i;
        for (; j < html.length; j++) {
          const ch = html[j];
          if (ch === '"') { for (j++; j < html.length && html[j] !== '"'; j++) if (html[j] === "\\") j++; continue; }
          if (ch === "[" || ch === "{") depth++;
          else if ((ch === "]" || ch === "}") && --depth === 0) break;
        }
        const tracks = JSON.parse(html.slice(i, j + 1));
        if (!tracks.length) return [];
        const lang = (navigator.language || "en").slice(0, 2);
        const pick = tracks.find((t) => t.languageCode && t.languageCode.startsWith(lang) && t.kind !== "asr") ||
          tracks.find((t) => t.languageCode && t.languageCode.startsWith(lang)) || tracks[0];
        const body = await (await fetch(pick.baseUrl + "&fmt=json3", { credentials: "include" })).text();
        if (!body) return [];
        const out = [];
        for (const e of JSON.parse(body).events || []) {
          const text = norm((e.segs || []).map((s) => s.utf8).join(""));
          if (text) out.push({ t: (e.tStartMs || 0) / 1000, text });
        }
        return out;
      } catch (e) { return []; }
    },
    async transcript(open) {
      let segs = this.readSegments();
      if (!segs.length && open) {
        const btn = document.querySelector("ytd-video-description-transcript-section-renderer button, #description button[aria-label*='transcript' i], button[aria-label='Show transcript']");
        if (btn) {
          if (!document.querySelector("ytd-watch-metadata #description-inline-expander[is-expanded]")) {
            const more = document.querySelector("tp-yt-paper-button#expand, #description-inline-expander #expand");
            if (more) more.click();
          }
          btn.click();
          segs = await until(() => this.readSegments(), 6000);
        }
      }
      if (!segs.length) segs = await this.fromCaptions();
      return segs;
    },
    comments() {
      const out = [];
      for (const c of document.querySelectorAll("ytd-comment-thread-renderer, ytd-comment-view-model, ytd-comment-renderer")) {
        if (c.parentElement && c.parentElement.closest("ytd-comment-view-model, ytd-comment-renderer")) continue;
        const text = norm((c.querySelector("#content-text") || {}).textContent);
        if (!text) continue;
        const author = norm((c.querySelector("#author-text") || {}).textContent);
        const a = c.querySelector("#published-time-text a, a[href*='lc=']");
        out.push({ group: "comments", text, el: c, meta: author, url: a ? a.href : "" });
      }
      return out;
    },
    videos() {
      const out = [], seen = new Set();
      for (const v of document.querySelectorAll("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model, ytd-reel-item-renderer")) {
        if (v.parentElement && v.parentElement.closest("ytd-rich-item-renderer, yt-lockup-view-model")) continue;
        const t = v.querySelector("#video-title, .yt-lockup-metadata-view-model__title, h3");
        const a = v.querySelector("a#video-title-link, a#video-title, a#thumbnail[href], a[href*='/watch'], a[href*='/shorts/']");
        const text = norm(t && (t.getAttribute("title") || t.textContent));
        const url = a ? a.href : "";
        if (!text || !url || seen.has(url)) continue;
        seen.add(url);
        const ch = v.querySelector("#channel-name #text, ytd-channel-name #text, .yt-content-metadata-view-model__metadata-text");
        out.push({ group: "videos", text, el: v, url, meta: norm(ch && ch.textContent) });
      }
      return out;
    },
    video() { return document.querySelector("#movie_player video, video.html5-main-video, video"); },
    seek(t) {
      const v = this.video();
      if (!v) return false;
      v.currentTime = t;
      if (v.paused) { try { v.play(); } catch (e) { /* the page keeps control */ } }
      v.scrollIntoView({ block: "nearest" });
      return true;
    },
    url(t) {
      const id = this.videoId();
      return "https://www.youtube.com/watch?v=" + id + (t != null ? "&t=" + Math.max(0, Math.floor(t)) + "s" : "");
    },
    async sources(onUpdate) {
      if (!this.isWatch()) return [{ id: "videos", label: "Videos", items: this.videos(), refresh: () => this.videos() }];
      const groups = [
        { id: "transcript", label: "Transcript", items: [], loading: true },
        { id: "description", label: "Description", items: [] },
        { id: "comments", label: "Comments", items: this.comments(), refresh: () => this.comments() }
      ];
      const desc = this.description();
      for (const line of desc.split("\n")) {
        const text = norm(line);
        if (!text) continue;
        const t = seconds(text.match(/^\(?\d+:\d{2}(?::\d{2})?\)?/) ? text : "");
        groups[1].items.push({ group: "description", text, t: t == null ? undefined : t, meta: t != null ? clock(t) : "" });
      }
      this.transcript(true).then((segs) => {
        groups[0].items = segs.map((s) => ({ group: "transcript", text: s.text, t: s.t, meta: clock(s.t), el: s.el }));
        groups[0].loading = false;
        onUpdate && onUpdate();
      });
      return groups;
    },
    where(node, text) {
      if (!this.isWatch()) return fragmentUrl(text, location.href);
      const seg = node && node.closest && node.closest("ytd-transcript-segment-renderer, transcript-segment-view-model");
      if (seg) { const t = seconds(seg.textContent); if (t != null) return this.url(t); }
      const v = this.video();
      return this.url(v ? Math.max(0, v.currentTime - 3) : null);
    },
    actions() { return this.isWatch() ? [{ id: "read", label: "Read transcript in Reader" }] : []; },
    async doc() {
      if (!this.isWatch()) return null;
      const title = this.title();
      const segs = await this.transcript(true);
      const m = makeDoc(title);
      m.add(null, "h1", title);
      const ch = this.channel();
      if (ch) m.add(null, "p", ch, { class: "byline" });
      const top = m.add(null, "p");
      const a = m.d.createElement("a");
      a.href = this.url(); a.textContent = "Watch on YouTube";
      top.appendChild(a);
      const desc = this.description();
      if (desc) { m.add(null, "h2", "Description"); m.paras(null, desc); }
      m.add(null, "h2", "Transcript");
      if (!segs.length) m.add(null, "p", "This video has no transcript Polycarp could read. Captions turned off by the uploader, or YouTube did not share them.");
      // Group lines into paragraphs of about 40 seconds, ending on a sentence where possible.
      let para = null, startT = 0;
      for (const s of segs) {
        if (!para || (s.t - startT > 40 && /[.!?]["')\]]?$/.test(para.lastChild.nodeValue || "")) || s.t - startT > 75) {
          para = m.add(null, "p");
          startT = s.t;
          const link = m.d.createElement("a");
          link.href = this.url(s.t); link.textContent = clock(s.t);
          para.appendChild(link);
          para.appendChild(m.d.createTextNode(" " + s.text));
        } else para.lastChild.nodeValue += " " + s.text;
      }
      const cs = this.comments().slice(0, 40);
      if (cs.length) {
        m.add(null, "h2", "Comments");
        for (const c of cs) {
          const p = m.add(null, "p");
          const b = m.d.createElement("strong"); b.textContent = c.meta || "Viewer";
          p.appendChild(b);
          p.appendChild(m.d.createTextNode(": " + c.text));
        }
      }
      return { html: m.html(), url: this.url(), title: title + " (transcript)", site: "youtube" };
    }
  };

  // ---------------------------------------------------------------- X (Twitter)
  const seenPosts = new Map(); // status url -> post, in the order first seen; survives X dropping offscreen posts
  const X_CAP = 3000;
  const x = {
    id: "x",
    match: (h) => /(^|\.)(x|twitter)\.com$/.test(h),
    prose: "[data-testid=tweetText],[data-testid=UserDescription],[data-testid=birdwatch-pivot]",
    skip: "nav,[data-testid=SideNav_NewTweet_Button],[data-testid^=tweetTextarea],.DraftEditor-root,[data-testid=toolBar],[data-testid=ScrollSnap-List],[role=tablist],[data-testid=app-bar-back]",
    statusId() { const m = location.pathname.match(/\/status\/(\d+)/); return m ? m[1] : null; },
    parse(a) {
      const time = a.querySelector("time");
      const link = time && time.closest("a[href*='/status/']");
      const url = link ? link.href.replace(/\/(photo|video|analytics)\/.*$/, "") : "";
      if (!url) return null;
      const texts = a.querySelectorAll("[data-testid=tweetText]");
      const name = a.querySelector("[data-testid=User-Name]");
      const nameText = name ? textOf(name) : "";
      const handle = (nameText.match(/@[A-Za-z0-9_]{1,20}/) || [""])[0];
      const display = norm(name && name.querySelector("span") ? textOf(name.querySelector("span")) : nameText.split("@")[0]);
      const images = [...a.querySelectorAll("[data-testid=tweetPhoto] img")].map((i) => ({
        src: i.src.replace(/name=\w+/, "name=large"), alt: i.alt && i.alt !== "Image" ? i.alt : ""
      }));
      return {
        url, el: a, handle, name: display,
        text: texts[0] ? textOf(texts[0]) : "",
        quoted: texts[1] ? textOf(texts[1]) : "",
        time: time ? time.dateTime : "",
        images, video: !!a.querySelector("[data-testid=videoPlayer], video"),
        page: location.pathname
      };
    },
    collect() {
      for (const a of document.querySelectorAll("article[data-testid=tweet], article[role=article]")) {
        const p = this.parse(a);
        if (!p || (!p.text && !p.images.length && !p.video)) continue;
        const had = seenPosts.get(p.url);
        if (had) { had.el = a; if (!had.text && p.text) Object.assign(had, p); continue; }
        seenPosts.set(p.url, p);
        if (seenPosts.size > X_CAP) seenPosts.delete(seenPosts.keys().next().value);
      }
    },
    watch() {
      if (this.observer) return;
      let t = 0;
      this.observer = new MutationObserver(() => { if (!t) t = setTimeout(() => { t = 0; this.collect(); }, 400); });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
      this.collect();
    },
    unwatch() { if (this.observer) { this.observer.disconnect(); this.observer = null; } },
    posts() { this.collect(); return [...seenPosts.values()]; },
    sources() {
      const items = this.posts().map((p) => ({
        group: "posts", text: p.text + (p.quoted ? "\n" + p.quoted : "") || (p.video ? "Video" : "Image"),
        meta: [p.name, p.handle].filter(Boolean).join(" ") + (p.time ? " · " + new Date(p.time).toLocaleDateString() : ""),
        url: p.url, el: p.el, post: p,
        extra: p.handle + " " + p.name
      }));
      return [{ id: "posts", label: "Posts you've seen", items: items.reverse(), refresh: () => this.sources()[0].items }];
    },
    where(node, text) {
      const a = node && node.closest && node.closest("article");
      const p = a && this.parse(a);
      return p ? p.url : fragmentUrl(text, location.href);
    },
    actions() { return [{ id: "read", label: this.statusId() ? "Read thread in Reader" : "Read these posts in Reader" }]; },
    async doc() {
      const here = this.posts().filter((p) => p.page === location.pathname);
      if (!here.length) return null;
      const id = this.statusId();
      const main = (id && here.find((p) => p.url.endsWith("/status/" + id))) || here[0];
      const thread = id ? here.filter((p) => p.handle === main.handle) : here;
      const replies = id ? here.filter((p) => p.handle !== main.handle) : [];
      const title = id ? "Thread by " + (main.name || main.handle) : "Posts on " + location.host + location.pathname;
      const m = makeDoc(title);
      m.add(null, "h1", title);
      if (id) m.add(null, "p", [main.handle, main.time ? new Date(main.time).toLocaleString() : ""].filter(Boolean).join(" · "), { class: "byline" });
      const post = (p, withAuthor) => {
        if (withAuthor) {
          const by = m.add(null, "p");
          const b = m.d.createElement("strong"); b.textContent = p.name || p.handle;
          by.appendChild(b);
          if (p.handle) by.appendChild(m.d.createTextNode(" " + p.handle));
        }
        m.paras(null, p.text);
        if (p.quoted) { const q = m.add(null, "blockquote"); m.paras(q, p.quoted); }
        for (const img of p.images) m.add(null, "img", null, { src: img.src, alt: img.alt });
        const meta = m.add(null, "p");
        const a = m.d.createElement("a");
        a.href = p.url;
        a.textContent = (p.video ? "Video on X · " : "") + (p.time ? new Date(p.time).toLocaleString() : "Open post");
        meta.appendChild(a);
      };
      for (const p of thread) post(p, !id);
      if (replies.length) {
        m.add(null, "h2", "Replies");
        for (const p of replies) post(p, true);
      }
      return { html: m.html(), url: id ? main.url : location.href, title, site: "x" };
    }
  };


  // ---------------------------------------------------------------- library capture
  // Turn a page that lists books, audiobooks or videos into a searchable Polycarp source. Runs in
  // the user's own signed-in tab and reads only what that page shows them; nothing is sent
  // anywhere but Polycarp's own storage.
  const audible = {
    id: "audible",
    match: (h) => /(^|\.)audible\.(com|co\.uk|ca|com\.au|de|fr|it|es|in|co\.jp)$/.test(h),
    isLibrary() { return /^\/library/.test(location.pathname); },
    parseRows(doc) {
      const out = [];
      for (const row of doc.querySelectorAll("[id^='adbl-library-content-row-'], .adbl-library-content-row")) {
        const asin = (row.id.match(/row-([A-Z0-9]{10})/) || [])[1] || row.getAttribute("data-asin") || "";
        const titleEl = row.querySelector(".bc-size-headline3, [class*='title'] span, h2, h3");
        const title = norm(titleEl && titleEl.textContent);
        if (!title) continue;
        const pick = (sel) => [...row.querySelectorAll(sel)].map((a) => norm(a.textContent)).filter(Boolean).join(", ");
        const by = pick(".authorLabel a, [class*='author'] a");
        const narr = pick(".narratorLabel a, [class*='narrator'] a");
        const img = row.querySelector("img");
        const len = norm((row.querySelector(".bc-text.bc-color-secondary[class*='time'], [class*='runtime'], [class*='time-remaining']") || {}).textContent);
        const base = location.origin;
        out.push({
          id: asin || title, title, by, kind: "audiobook",
          url: asin ? base + "/pd/" + asin : base + "/library/titles",
          snippet: [narr && "Narrated by " + narr, len].filter(Boolean).join(" · "),
          image: img ? img.src : "",
          files: asin ? [{ label: "Listen in Audible", url: base + "/webplayer?asin=" + asin, type: "link" }] : []
        });
      }
      return out;
    },
    async capture(onProgress) {
      const all = new Map();
      for (let page = 1; page <= 60; page++) {
        const url = location.origin + "/library/titles?pageSize=50&page=" + page;
        let html;
        try { html = await (await fetch(url, { credentials: "include" })).text(); } catch (e) { break; }
        const doc = new DOMParser().parseFromString(html, "text/html");
        const rows = this.parseRows(doc);
        let fresh = 0;
        for (const r of rows) if (!all.has(r.id)) { all.set(r.id, r); fresh++; }
        onProgress && onProgress(all.size);
        if (!fresh) break;
        await sleep(400);
      }
      if (!all.size) for (const r of this.parseRows(document)) all.set(r.id, r);
      return { def: { id: "audible", name: "Your Audible library", type: "list", url: location.origin + "/library/titles" }, items: [...all.values()] };
    }
  };

  const kindle = {
    id: "kindle",
    match: (h) => /^read\.amazon\./.test(h),
    isLibrary() { return /kindle-library/.test(location.pathname) || location.pathname === "/"; },
    async capture(onProgress) {
      const all = new Map();
      let token = "";
      for (let i = 0; i < 80; i++) {
        const u = location.origin + "/kindle-library/search?query=&libraryType=BOOKS&sortType=recency&querySize=50" + (token ? "&paginationToken=" + encodeURIComponent(token) : "");
        let j;
        try { j = await (await fetch(u, { credentials: "include" })).json(); } catch (e) { break; }
        for (const b of j.itemsList || []) {
          all.set(b.asin, {
            id: b.asin, title: norm(b.title), by: (b.authors || []).map((a) => norm(String(a).replace(/:$/, ""))).join(", "),
            kind: "book", image: b.productUrl || "", url: location.origin + "/?asin=" + b.asin,
            snippet: b.percentageRead ? Math.round(b.percentageRead) + "% read" : "", files: []
          });
        }
        onProgress && onProgress(all.size);
        token = j.paginationToken;
        if (!token) break;
        await sleep(300);
      }
      return { def: { id: "kindle", name: "Your Kindle library", type: "list", url: location.origin + "/kindle-library" }, items: [...all.values()] };
    }
  };

  // Any page: find the largest group of repeated items that each carry a link and a title.
  const listPage = {
    id: "list",
    capture() {
      const groups = new Map();
      for (const a of deepAll("a[href]")) {
        if (!/^https?:/.test(a.href) || a.closest("nav,header,footer,polycarp-ui,polycarp-find")) continue;
        const text = norm(a.textContent) || norm(a.getAttribute("aria-label")) || norm(a.title);
        if (text.length < 4) continue;
        // The item card: climb while the parent still holds only this one link target.
        let card = a;
        while (card.parentElement && card.parentElement !== document.body && new Set([...card.parentElement.querySelectorAll("a[href]")].map((x) => x.href)).size <= 2) card = card.parentElement;
        const key = card.tagName + "." + [...card.classList].sort().join(".") + "|" + (card.parentElement ? card.parentElement.tagName : "");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ a, card, text });
      }
      let best = [];
      for (const g of groups.values()) if (g.length > best.length) best = g;
      const seen = new Set();
      const items = [];
      for (const { a, card, text } of best) {
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        const img = card.querySelector("img");
        const rest = norm(card.textContent).replace(text, "").trim();
        items.push({ id: a.href, title: text, url: a.href, snippet: rest.slice(0, 280), image: img ? (img.currentSrc || img.src) : "", kind: "item", by: "", files: [] });
      }
      return { def: { id: "page:" + location.host + location.pathname, name: (document.title || location.host).slice(0, 80), type: "list", url: location.href }, items: best.length >= 3 ? items : [] };
    }
  };

  const ADAPTERS = [youtube, x];
  function siteFor(host) { return ADAPTERS.find((a) => a.match(host)) || null; }

  function capturerFor(host) { return [audible, kindle].find((c) => c.match(host) && c.isLibrary()) || null; }

  P.sites = { generic, youtube, x, audible, kindle, listPage, siteFor, capturerFor, fragmentUrl, clock, seconds, norm, fold, textOf, deepAll };
})();
