/*
 * Polycarp importers.
 *
 * Turns PDF, EPUB, DOCX, FB2, TXT, Markdown and HTML into the reader Doc shape:
 *   { title, author, source: { kind, name, url, pages? }, sections: [{ title, html }] }
 *
 * Classic script (no import or export statements). Depends on globals that the
 * host page loads first: JSZip, mammoth, Readability. pdf.js is loaded on demand
 * with a dynamic import of the bundled module.
 *
 * Every section's html goes through sanitize(): a whitelist of reading tags,
 * no styles, no handlers, no script, safe link and image URLs only.
 */
(function () {
  'use strict';

  var SCRIPT_SRC = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';

  function extUrl(path) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(path);
    return new URL('../../' + path, SCRIPT_SRC || location.href).href;
  }

  function fail(code, message) {
    return Object.assign(new Error(message), { code: code });
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  var HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESC[c]; });
  }

  function collapse(s) {
    return String(s || '').replace(/[\s\u00A0]+/g, ' ').trim();
  }

  function normKey(s) {
    return collapse(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function extOf(name) {
    var m = /\.([a-z0-9]{1,10})$/i.exec(String(name || '').replace(/[?#].*$/, ''));
    return m ? m[1].toLowerCase() : '';
  }

  function titleFromName(name) {
    var base = String(name || '').replace(/[?#].*$/, '').split(/[\\/]/).pop() || '';
    base = base.replace(/(\.[a-z0-9]{1,10})+$/i, '');
    if (!/\s/.test(base)) base = base.replace(/[_-]+/g, ' ');
    base = collapse(base);
    return base || 'Untitled';
  }

  function progressFn(opts) {
    var cb = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var last = -1;
    return function (f) {
      if (!cb) return;
      f = Math.max(0, Math.min(1, f));
      if (f === last) return;
      last = f;
      try { cb(f); } catch (e) { /* a progress callback must never break an import */ }
    };
  }

  function latin1(u8, start, end) {
    var s = '';
    end = Math.min(end, u8.length);
    for (var i = start; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var idx = Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))));
    return a[idx];
  }

  function byLocal(root, name) {
    if (!root) return [];
    return Array.prototype.slice.call(root.getElementsByTagNameNS('*', name));
  }

  function childByLocal(el, name) {
    if (!el) return [];
    var out = [];
    for (var n = el.firstElementChild; n; n = n.nextElementSibling) if (n.localName === name) out.push(n);
    return out;
  }

  function parseXml(text) {
    var d = new DOMParser().parseFromString(text, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) return null;
    return d;
  }

  // Event handler attributes never run here (the sanitizer drops them too), but an XHTML document
  // parsed under the Reader's CSP still reports each one as a violation, so they go before parsing.
  function dropHandlers(text) {
    return text.replace(/<[^>]+>/g, function (tag) { return tag.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''); });
  }

  // Every page, chapter and fragment goes through this parser, never DOMParser itself.
  var markupParser = { parseFromString: function (text, type) { return new DOMParser().parseFromString(dropHandlers(String(text)), type); } };

  function parseXhtml(text) {
    var d = markupParser.parseFromString(text, 'application/xhtml+xml');
    if (d.getElementsByTagName('parsererror').length || !d.documentElement) {
      d = markupParser.parseFromString(text, 'text/html');
    }
    return d;
  }

  function decodeBytes(u8, charset) {
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    if (charset) {
      try { return new TextDecoder(charset.trim().toLowerCase()).decode(u8); } catch (e) { /* unknown label, sniff below */ }
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) {
      return new TextDecoder('windows-1252').decode(u8);
    }
  }

  function charsetFromContentType(ct) {
    var m = /charset\s*=\s*"?([\w.:-]+)/i.exec(ct || '');
    return m ? m[1] : null;
  }

  // An inert document: nothing parsed into it runs scripts or loads images.
  var INERT = document.implementation.createHTMLDocument('');

  // ---------------------------------------------------------------------------
  // Sanitizer
  // ---------------------------------------------------------------------------

  var DROP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed',
    'applet', 'svg', 'head', 'title', 'meta', 'link', 'base', 'button', 'input', 'select', 'option', 'optgroup',
    'textarea', 'canvas', 'video', 'audio', 'source', 'track', 'map', 'area', 'dialog', 'datalist', 'output',
    'progress', 'meter', 'param', 'colgroup', 'col', 'caption', 'rp', 'portal', 'slot']);

  // Source tag to output tag, for tags we keep.
  var KEEP = {
    h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
    p: 'p', ul: 'ul', ol: 'ol', li: 'li', blockquote: 'blockquote', pre: 'pre', code: 'code',
    em: 'em', strong: 'strong', b: 'b', i: 'i', a: 'a', img: 'img', figure: 'figure', figcaption: 'figcaption',
    table: 'table', thead: 'thead', tbody: 'tbody', tfoot: 'tbody', tr: 'tr', th: 'th', td: 'td',
    hr: 'hr', br: 'br', sup: 'sup', sub: 'sub',
    kbd: 'code', samp: 'code', tt: 'code', var: 'em', cite: 'em', dfn: 'em'
  };

  // Containers we drop but whose contents we keep as separate blocks.
  var BLOCK_UNWRAP = new Set(['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center',
    'address', 'details', 'summary', 'form', 'fieldset', 'legend', 'hgroup', 'body', 'html', 'dl', 'dt', 'dd',
    'menu', 'dir', 'listing', 'xmp', 'plaintext', 'search', 'picture']);

  var BLOCK_OUT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'div']);
  var INLINE_CTX = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'em', 'strong', 'b', 'i', 'code', 'sup', 'sub', 'pre']);
  var TABLE_CTX = new Set(['table', 'thead', 'tbody', 'tr']);
  var BOUNDARY = 'ph-b';

  function safeUrl(raw, base, forImg) {
    if (raw == null) return null;
    raw = String(raw).trim();
    if (!raw) return null;
    if (forImg && /^data:image\//i.test(raw)) return raw;
    if (forImg && /^blob:/i.test(raw)) return raw;
    var u;
    try { u = base ? new URL(raw, base) : new URL(raw); } catch (e) { return null; }
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    if (!forImg && u.protocol === 'mailto:') return u.href;
    return null;
  }

  function lname(n) { return (n.localName || n.nodeName || '').toLowerCase(); }

  // ---------------------------------------------------------------------------
  // Media, ids and links
  // ---------------------------------------------------------------------------

  // fromHtml swaps embeds and players for placeholder images before Readability
  // runs (Readability drops most of them) and parks the originals here, keyed by
  // a per-call nonce, so sanitizeInto can turn them into link cards and players.
  var MEDIA_STASH = null;
  var MEDIA_TAGS = new Set(['iframe', 'embed', 'object', 'video', 'audio']);
  var MEDIA_SEL = 'img, video, audio';
  var HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  var ID_PREFIX = 'ph-';
  var TARGET_W = 1200;
  var PLACEHOLDER_STEM = /^(?:[\w.-]*[-_.])?(?:1x1|blank|spacer|pixel|placeholder|lazy|lazyload|lazy-load|transparent|loading|empty)(?:[-_]?\d+(?:x\d+)?(?:px)?)?$/i;
  var AD_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.(com|net))$/i;
  // Classes the sanitizer itself writes; kept on a second pass so sanitize is idempotent.
  var OWN_CLASS = {
    a: ['embed-card', 'ext', 'media-open', 'media-note'],
    span: ['embed-meta', 'embed-provider', 'embed-title'],
    img: ['embed-thumb'],
    blockquote: ['tweet']
  };

  function isWebUrl(s) { return /^https?:/i.test(String(s || '')); }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function ownClasses(node, tag) {
    var allowed = OWN_CLASS[tag];
    if (!allowed) return '';
    var have = (node.getAttribute('class') || '').split(/\s+/);
    return allowed.filter(function (c) { return have.indexOf(c) !== -1; }).join(' ');
  }

  function cleanId(raw) {
    if (raw == null) return '';
    var s = String(raw).trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep as written */ }
    s = s.replace(/[^\w:.-]+/g, '-').slice(0, 80);
    if (!/[A-Za-z0-9]/.test(s)) return '';
    return s.indexOf(ID_PREFIX) === 0 ? s : ID_PREFIX + s;
  }

  // The fragment of a link that points into the same page, '' for a bare "#",
  // or null when the link goes somewhere else.
  function inPageFragment(raw, bases) {
    if (raw == null) return null;
    raw = String(raw).trim();
    if (raw.charAt(0) === '#') return raw.slice(1);
    for (var i = 0; i < bases.length; i++) {
      if (!bases[i]) continue;
      try {
        var u = new URL(raw, bases[i]);
        if (u.hash && u.href.split('#')[0] === new URL(bases[i]).href.split('#')[0]) return u.hash.slice(1);
      } catch (e) { /* not a URL */ }
    }
    return null;
  }

  function isPlaceholderSrc(raw) {
    raw = String(raw == null ? '' : raw).trim();
    if (!raw || /^(data|about|javascript):/i.test(raw)) return true;
    var path = raw.split(/[?#]/)[0];
    var stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.[a-z0-9]{2,5}$/i, '');
    try { stem = decodeURIComponent(stem); } catch (e) { /* keep as written */ }
    return PLACEHOLDER_STEM.test(stem);
  }

  function parseSrcset(s) {
    var out = [];
    if (!s) return out;
    s = String(s);
    var i = 0, n = s.length;
    while (i < n) {
      while (i < n && /[\s,]/.test(s.charAt(i))) i++;
      if (i >= n) break;
      var start = i;
      while (i < n && !/\s/.test(s.charAt(i))) i++;
      var url = s.slice(start, i), desc = '';
      if (/,$/.test(url)) url = url.replace(/,+$/, '');
      else {
        var ds = i;
        while (i < n && s.charAt(i) !== ',') i++;
        desc = s.slice(ds, i).trim();
      }
      var w = /^(\d+)w$/i.exec(desc), x = /^(\d*\.?\d+)x$/i.exec(desc);
      out.push({ url: url, w: w ? +w[1] : 0, x: x ? +x[1] : (w ? 0 : 1) });
    }
    return out;
  }

  // Closest to TARGET_W wide, or the largest density when no widths are given.
  function pickSrcset(cands) {
    cands = cands.filter(function (c) { return !isPlaceholderSrc(c.url); });
    if (!cands.length) return null;
    var widths = cands.filter(function (c) { return c.w > 0; });
    if (widths.length) {
      widths.sort(function (a, b) { return Math.abs(a.w - TARGET_W) - Math.abs(b.w - TARGET_W) || b.w - a.w; });
      return widths[0].url;
    }
    cands.sort(function (a, b) { return b.x - a.x; });
    return cands[0].url;
  }

  function embedSource(node) {
    var attrs = lname(node) === 'object' ? ['data', 'src', 'data-src'] : ['src', 'data-src', 'data-lazy-src', 'data-url'];
    for (var i = 0; i < attrs.length; i++) {
      var v = node.getAttribute(attrs[i]);
      if (v && /\S/.test(v) && !/^\s*(about|javascript|data|blob|vbscript):/i.test(v)) return v;
    }
    return null;
  }

  // Provider, canonical page URL, title and thumbnail for an embedded frame.
  function embedInfo(raw, base) {
    var href = safeUrl(raw, base, false);
    if (!href || !isWebUrl(href)) return null;
    var u = new URL(href);
    var host = u.hostname.toLowerCase().replace(/^www\./, '');
    var p = u.pathname, m;
    if (AD_HOST.test(host)) return null;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host) || host === 'youtu.be') {
      var id = null;
      if (host === 'youtu.be') id = p.slice(1).split('/')[0];
      else if ((m = /^\/(?:embed|v|shorts|live)\/([^/?#]+)/.exec(p))) id = m[1];
      else if (p === '/watch') id = u.searchParams.get('v');
      var list = u.searchParams.get('list');
      if (id === 'videoseries' && list && /^[\w-]+$/.test(list)) {
        return { provider: 'YouTube', href: 'https://www.youtube.com/playlist?list=' + list, title: 'YouTube playlist' };
      }
      if (id && /^[\w-]{6,20}$/.test(id)) {
        var t = parseInt(u.searchParams.get('start') || u.searchParams.get('t') || '', 10);
        return { provider: 'YouTube', href: 'https://www.youtube.com/watch?v=' + id + (t > 0 ? '&t=' + t + 's' : ''),
          title: 'YouTube video', thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' };
      }
      return { provider: 'YouTube', href: href, title: 'YouTube video' };
    }
    if (host === 'player.vimeo.com' && (m = /^\/video\/(\d+)/.exec(p))) {
      var hash = u.searchParams.get('h');
      return { provider: 'Vimeo', href: 'https://vimeo.com/' + m[1] + (hash && /^\w+$/.test(hash) ? '/' + hash : ''), title: 'Vimeo video' };
    }
    if (/(^|\.)(twitter|x)\.com$/.test(host)) {
      var tid = u.searchParams.get('id');
      return { provider: 'X', href: tid && /^\d+$/.test(tid) ? 'https://x.com/i/status/' + tid : href, title: 'Post on X' };
    }
    if (host === 'open.spotify.com' && (m = /^\/embed(?:-podcast)?\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/.exec(p))) {
      return { provider: 'Spotify', href: 'https://open.spotify.com/' + m[1] + '/' + m[2], title: 'Spotify ' + m[1] };
    }
    if (/(^|\.)soundcloud\.com$/.test(host)) {
      var target = safeUrl(u.searchParams.get('url'), null, false);
      return { provider: 'SoundCloud', href: target && /^https?:\/\/(www\.|m\.)?soundcloud\.com\//i.test(target) ? target : href, title: 'SoundCloud audio' };
    }
    if (host === 'codepen.io' && (m = /^\/([^/]+)\/embed\/(?:preview\/)?([^/?#]+)/.exec(p))) {
      return { provider: 'CodePen', href: 'https://codepen.io/' + m[1] + '/pen/' + m[2], title: 'CodePen demo' };
    }
    return { provider: host, href: href, title: 'Embedded content from ' + host };
  }

  function sanitizeInto(src, out, base) {
    var ctx = out.ownerDocument;
    // Web page imports (fromHtml with a page URL) get the strict rules: only
    // http, https, mailto and # URLs, and "ext" links decided by the page host.
    // Files and the public sanitize() keep data: and blob: pictures.
    var stash = MEDIA_STASH;
    var web = !!(stash && stash.pageUrl);
    var pageUrl = web ? stash.pageUrl : (isWebUrl(base) ? base : null);
    var pageHost = web ? hostOf(pageUrl) : '';
    var pageBases = [base, stash && stash.pageUrl];

    function insideAnchor(parent) {
      for (var p = parent; p && p !== out; p = p.parentNode) if (lname(p) === 'a') return true;
      return false;
    }

    function insideHeading(parent) {
      for (var p = parent; p && p !== out; p = p.parentNode) if (HEADINGS.has(lname(p))) return true;
      return false;
    }

    function setId(el, node) {
      var id = cleanId(node.getAttribute('id'));
      if (id && !el.hasAttribute('id')) el.setAttribute('id', id);
    }

    // Links to other sites open in a new tab and carry the "ext" arrow.
    function decorateLink(a, href, cls) {
      var classes = (cls || '').split(' ').filter(Boolean);
      // Without a page host, only links this sanitizer already marked count.
      var external = isWebUrl(href) && (pageHost ? hostOf(href) !== pageHost :
        classes.indexOf('ext') !== -1 || classes.indexOf('embed-card') !== -1);
      if (external) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
      if (external && classes.indexOf('embed-card') === -1 && /\S/.test(a.textContent) && classes.indexOf('ext') === -1) classes.push('ext');
      if (classes.length) a.setAttribute('class', classes.join(' '));
    }

    function textLink(href, text, cls, parent) {
      var a = ctx.createElement('a');
      a.setAttribute('href', href);
      a.appendChild(ctx.createTextNode(text));
      decorateLink(a, href, cls);
      parent.appendChild(a);
      return a;
    }

    function pickImageSrc(node) {
      var cands = [];
      ['srcset', 'data-srcset', 'data-lazy-srcset'].forEach(function (k) { cands = cands.concat(parseSrcset(node.getAttribute(k))); });
      var pic = node.parentNode && node.parentNode.nodeType === 1 && lname(node.parentNode) === 'picture' ? node.parentNode : null;
      if (pic) {
        for (var c = pic.firstElementChild; c; c = c.nextElementSibling) {
          if (lname(c) !== 'source') continue;
          var ss = c.getAttribute('srcset') || c.getAttribute('data-srcset');
          if (ss) { cands = cands.concat(parseSrcset(ss)); break; }
        }
      }
      var order = [pickSrcset(cands), node.getAttribute('src'), node.getAttribute('data-src'), node.getAttribute('data-original'),
        node.getAttribute('data-lazy-src'), node.getAttribute('data-url')];
      for (var i = 0; i < order.length; i++) {
        if (order[i] == null || isPlaceholderSrc(order[i])) continue;
        var u = safeUrl(order[i], base, false);
        if (u && isWebUrl(u) && !/\.invalid$/i.test(hostOf(u))) return u;
      }
      // Files (EPUB, DOCX, FB2) carry their pictures as data: or blob: URLs.
      if (!web) {
        var own = node.getAttribute('src');
        if (own && !/^\s*data:image\/gif/i.test(own)) return safeUrl(own, base, true);
      }
      return null;
    }

    function isTrackingPixel(node) {
      return ['width', 'height'].some(function (k) { return /^\s*[01](px)?\s*$/i.test(node.getAttribute(k) || ''); });
    }

    function embedCard(info, parent) {
      if (insideAnchor(parent)) { parent.appendChild(ctx.createTextNode(' ' + info.title + ' ')); return; }
      var a = ctx.createElement('a');
      a.setAttribute('href', info.href);
      decorateLink(a, info.href, 'embed-card');
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      if (info.thumb) {
        var im = ctx.createElement('img');
        im.setAttribute('class', 'embed-thumb');
        im.setAttribute('src', info.thumb);
        im.setAttribute('alt', '');
        im.setAttribute('loading', 'lazy');
        im.setAttribute('decoding', 'async');
        a.appendChild(im);
      }
      var meta = ctx.createElement('span');
      meta.setAttribute('class', 'embed-meta');
      var prov = ctx.createElement('span');
      prov.setAttribute('class', 'embed-provider');
      prov.textContent = info.provider;
      var title = ctx.createElement('span');
      title.setAttribute('class', 'embed-title');
      title.textContent = info.title;
      meta.appendChild(prov);
      meta.appendChild(ctx.createTextNode(' '));
      meta.appendChild(title);
      a.appendChild(meta);
      parent.appendChild(a);
    }

    // A native player with controls that never starts on its own, or a note
    // when the page fed the player from blob: or MediaSource.
    function player(node, parent, kind) {
      var raw = [node.getAttribute('src'), node.getAttribute('data-src')];
      Array.prototype.forEach.call(node.querySelectorAll('source'), function (s) { raw.push(s.getAttribute('src'), s.getAttribute('data-src')); });
      var src = null;
      raw.forEach(function (r) {
        if (src || r == null || !/\S/.test(r)) return;
        var u = safeUrl(r, base, false);
        if (u && isWebUrl(u)) src = u;
      });
      var Kind = kind === 'video' ? 'Video' : 'Audio';
      if (!src) {
        if (isWebUrl(pageUrl) && !insideAnchor(parent)) textLink(pageUrl, Kind + ' on the original page', 'media-note', parent);
        else {
          var em = ctx.createElement('em');
          em.textContent = Kind + ' on the original page';
          parent.appendChild(em);
        }
        return;
      }
      var el = ctx.createElement(kind);
      el.setAttribute('controls', '');
      el.setAttribute('preload', 'none');
      if (kind === 'video') {
        el.setAttribute('playsinline', '');
        var poster = node.getAttribute('poster');
        var pu = poster && !isPlaceholderSrc(poster) ? safeUrl(poster, base, false) : null;
        if (pu && isWebUrl(pu)) el.setAttribute('poster', pu);
      }
      el.setAttribute('src', src);
      parent.appendChild(el);
      var next = node.nextElementSibling;
      var hasOpen = next && lname(next) === 'a' && /(^|\s)media-open(\s|$)/.test(next.getAttribute('class') || '');
      if (!insideAnchor(parent) && !hasOpen) textLink(src, 'Open ' + kind, 'media-open', parent);
    }

    // Each card or player gets its own paragraph when it sits at block level.
    function mediaEl(node, parent) {
      var own = !inInline(parent) && !TABLE_CTX.has(outTag(parent));
      if (own) boundary(parent);
      mediaInner(node, parent);
      if (own) boundary(parent);
    }

    function mediaInner(node, parent) {
      var name = lname(node);
      if (name === 'video' || name === 'audio') { player(node, parent, name); return; }
      if (isTrackingPixel(node) || node.hasAttribute('hidden')) return;
      var raw = embedSource(node);
      var info = raw ? embedInfo(raw, base) : null;
      if (!info) {
        var inner = name === 'object' ? node.querySelector('iframe, embed, video, audio') : null;
        if (inner) mediaInner(inner, parent);
        return;
      }
      var t = collapse(node.getAttribute('title') || '');
      if (t) info.title = t.slice(0, 160);
      embedCard(info, parent);
    }

    // The link in a heading that only holds a link back to that heading.
    function soleSelfLink(node) {
      var only = null;
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 && !/\S/.test(c.nodeValue)) continue;
        if (c.nodeType === 8) continue;
        if (only || c.nodeType !== 1 || lname(c) !== 'a') return null;
        only = c;
      }
      return only && inPageFragment(only.getAttribute('href'), pageBases) !== null ? only : null;
    }

    function boundary(parent) { parent.appendChild(ctx.createComment(BOUNDARY)); }

    function outTag(parent) { return parent === out ? '#root' : lname(parent); }

    function inInline(parent) {
      for (var p = parent; p && p !== out; p = p.parentNode) if (INLINE_CTX.has(lname(p))) return true;
      return false;
    }

    function walkChildren(node, parent) {
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c, parent);
    }

    function unwrapBlock(node, parent) {
      if (TABLE_CTX.has(outTag(parent))) return;
      if (inInline(parent)) {
        parent.appendChild(ctx.createTextNode(' '));
        walkChildren(node, parent);
        parent.appendChild(ctx.createTextNode(' '));
        return;
      }
      boundary(parent);
      walkChildren(node, parent);
      boundary(parent);
    }

    function walk(node, parent) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        if (TABLE_CTX.has(outTag(parent))) return;
        parent.appendChild(ctx.createTextNode(node.nodeValue));
        return;
      }
      if (node.nodeType !== 1) return;
      var name = lname(node);
      if (name === 'math') {
        var alt = node.getAttribute('alttext') || node.textContent || '';
        if (!TABLE_CTX.has(outTag(parent))) parent.appendChild(ctx.createTextNode(' ' + collapse(alt) + ' '));
        return;
      }
      if (MEDIA_TAGS.has(name)) { mediaEl(node, parent); return; }
      if (DROP.has(name)) return;
      if (name === 'span' && ownClasses(node, 'span') && !TABLE_CTX.has(outTag(parent))) {
        var sp = ctx.createElement('span');
        sp.setAttribute('class', ownClasses(node, 'span'));
        parent.appendChild(sp);
        walkChildren(node, sp);
        return;
      }
      if (name === 'div' && /(^|\s)ph-pagemark(\s|$)/.test(node.getAttribute('class') || '')) {
        var page = node.getAttribute('data-page');
        if (/^\d{1,6}$/.test(page || '') && !inInline(parent) && !TABLE_CTX.has(outTag(parent))) {
          var pm = ctx.createElement('div');
          pm.setAttribute('class', 'ph-pagemark');
          pm.setAttribute('data-page', page);
          parent.appendChild(pm);
        }
        return;
      }
      var tag = KEEP[name];
      if ((tag === 'h5' || tag === 'h6') && !stash) tag = 'h4'; // only web pages keep every level
      if (!tag) {
        if (BLOCK_UNWRAP.has(name)) { unwrapBlock(node, parent); return; }
        if (name === 'wbr') return;
        if (TABLE_CTX.has(outTag(parent))) { walkChildren(node, parent); return; }
        walkChildren(node, parent); // span, font, u, small, mark, abbr, q, label and unknown tags
        return;
      }
      var ptag = outTag(parent);
      var inline = inInline(parent);

      // Table structure rules.
      if (tag === 'thead' || tag === 'tbody') {
        if (ptag !== 'table') { unwrapBlock(node, parent); return; }
      } else if (tag === 'tr') {
        if (ptag !== 'table' && ptag !== 'thead' && ptag !== 'tbody') { unwrapBlock(node, parent); return; }
      } else if (tag === 'td' || tag === 'th') {
        if (ptag !== 'tr') { unwrapBlock(node, parent); return; }
      } else if (TABLE_CTX.has(ptag)) {
        return; // stray content inside table structure
      }

      if (tag === 'li' && ptag !== 'ul' && ptag !== 'ol') tag = inline ? null : 'p';
      if (tag === 'figcaption' && ptag !== 'figure') tag = inline ? null : 'p';
      if (tag && BLOCK_OUT.has(tag) && inline && tag !== 'li') {
        if (tag === 'hr') return;
        unwrapBlock(node, parent);
        return;
      }
      if (!tag) { walkChildren(node, parent); return; }

      if (tag === 'a') {
        var rawHref = node.getAttribute('href');
        var frag = inPageFragment(rawHref, pageBases);
        var href = null;
        if (frag !== null) {
          var fid = cleanId(frag);
          // A pilcrow or "#" next to a heading is the page's own anchor widget.
          if (insideHeading(parent) && !/[\p{L}\p{N}]/u.test(node.textContent) && !node.querySelector('img')) return;
          if (fid) href = '#' + fid;
        } else {
          href = safeUrl(rawHref, base, false);
        }
        if (!href) {
          var anchorId = cleanId(node.getAttribute('id') || node.getAttribute('name'));
          if (anchorId && parent !== out && !parent.hasAttribute('id')) parent.setAttribute('id', anchorId);
          walkChildren(node, parent);
          return;
        }
        var a = ctx.createElement('a');
        a.setAttribute('href', href);
        setId(a, node);
        parent.appendChild(a);
        walkChildren(node, a);
        decorateLink(a, href, ownClasses(node, 'a'));
        return;
      }
      if (tag === 'img') {
        var hold = node.getAttribute('data-ph-media');
        var hm = hold && /^(\w+):(\d+)$/.exec(hold);
        if (hm && stash && hm[1] === stash.nonce && stash.nodes[+hm[2]]) { mediaEl(stash.nodes[+hm[2]], parent); return; }
        if (isTrackingPixel(node)) return;
        var src = pickImageSrc(node);
        if (!src) return;
        var img = ctx.createElement('img');
        var icls = ownClasses(node, 'img');
        if (icls) img.setAttribute('class', icls);
        img.setAttribute('src', src);
        var altText = node.getAttribute('alt');
        img.setAttribute('alt', altText == null ? '' : collapse(altText));
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        var iw = node.getAttribute('width'), ih = node.getAttribute('height');
        if (/^\s*\d{1,5}\s*$/.test(iw || '') && /^\s*\d{1,5}\s*$/.test(ih || '')) {
          img.setAttribute('width', iw.trim());
          img.setAttribute('height', ih.trim());
        }
        parent.appendChild(img);
        return;
      }
      var el = ctx.createElement(tag);
      parent.appendChild(el);
      if (tag === 'br' || tag === 'hr') return;
      setId(el, node);
      if (tag === 'blockquote') {
        var tweet = (stash && node.getAttribute('data-ph-tweet') === stash.nonce) ||
          /(^|\s)(twitter-tweet|twitter-video|tweet)(\s|$)/.test(node.getAttribute('class') || '');
        walkChildren(node, el);
        if (tweet) {
          el.setAttribute('class', 'tweet');
          var status = Array.prototype.filter.call(el.querySelectorAll('a[href]'), function (l) {
            return /^https:\/\/(www\.|mobile\.)?(twitter|x)\.com\/\w+\/status(es)?\/\d+/i.test(l.getAttribute('href'));
          }).pop();
          if (status) status.setAttribute('href', status.getAttribute('href').split(/[?#]/)[0]);
        }
        return;
      }
      if (HEADINGS.has(tag)) {
        var self = soleSelfLink(node);
        walkChildren(self || node, el);
        return;
      }
      walkChildren(node, el);
    }

    walk(src, out);
  }

  function isInlineNode(n) {
    if (n.nodeType === 3) return true;
    if (n.nodeType !== 1) return false;
    return !BLOCK_OUT.has(lname(n));
  }

  function hasContent(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
      if (n.nodeType === 1 && (lname(n) === 'img' || lname(n) === 'video' || lname(n) === 'audio' || /\S/.test(n.textContent) || n.querySelector(MEDIA_SEL))) return true;
    }
    return false;
  }

  // Wrap loose inline runs at block level into paragraphs; split runs at
  // boundary markers and at double line breaks.
  function wrapLoose(container, always) {
    var kids = Array.prototype.slice.call(container.childNodes);
    var needs = always;
    if (!needs) {
      var sawBlock = false, sawInline = false, sawBoundary = false;
      kids.forEach(function (n) {
        if (n.nodeType === 8) sawBoundary = true;
        else if (isInlineNode(n) && hasContent([n])) sawInline = true;
        else if (n.nodeType === 1 && !isInlineNode(n)) sawBlock = true;
      });
      needs = sawInline && (sawBlock || sawBoundary);
    }
    if (needs) {
      var run = [];
      var flush = function (before) {
        if (run.length && hasContent(run)) {
          var p = container.ownerDocument.createElement('p');
          container.insertBefore(p, before);
          run.forEach(function (n) { p.appendChild(n); });
        } else {
          run.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
        }
        run = [];
      };
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 8) { flush(n); continue; }
        if (n.nodeType === 1 && lname(n) === 'br' && always) {
          var j = i + 1;
          while (j < kids.length && kids[j].nodeType === 3 && !/\S/.test(kids[j].nodeValue)) j++;
          if (j < kids.length && kids[j].nodeType === 1 && lname(kids[j]) === 'br') {
            flush(n);
            for (var k = i; k <= j; k++) if (kids[k].parentNode) kids[k].parentNode.removeChild(kids[k]);
            i = j;
            continue;
          }
        }
        if (isInlineNode(n)) run.push(n);
        else flush(n);
      }
      flush(null);
    }
    Array.prototype.slice.call(container.childNodes).forEach(function (n) {
      if (n.nodeType === 8) container.removeChild(n);
    });
  }

  function tidy(root) {
    // Recurse first so inner containers are tidied before outer ones.
    var all = Array.prototype.slice.call(root.querySelectorAll('blockquote, li, td, th, figure'));
    all.reverse().forEach(function (el) { wrapLoose(el, lname(el) === 'blockquote'); });
    wrapLoose(root, true);
    // Any boundary comments left inside other containers.
    var walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    var dead = [];
    while (walker.nextNode()) dead.push(walker.currentNode);
    dead.forEach(function (c) { c.parentNode.removeChild(c); });
    // Trim leading and trailing br in paragraphs and headings; drop empty blocks.
    Array.prototype.slice.call(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, figcaption')).forEach(function (el) {
      while (el.firstChild && ((el.firstChild.nodeType === 1 && lname(el.firstChild) === 'br') ||
        (el.firstChild.nodeType === 3 && !/\S/.test(el.firstChild.nodeValue)))) el.removeChild(el.firstChild);
      while (el.lastChild && ((el.lastChild.nodeType === 1 && lname(el.lastChild) === 'br') ||
        (el.lastChild.nodeType === 3 && !/\S/.test(el.lastChild.nodeValue)))) el.removeChild(el.lastChild);
      if (!/\S/.test(el.textContent) && !el.querySelector(MEDIA_SEL)) el.parentNode.removeChild(el);
    });
    Array.prototype.slice.call(root.querySelectorAll('ul, ol, blockquote, figure, table')).forEach(function (el) {
      if (!/\S/.test(el.textContent) && !el.querySelector(MEDIA_SEL)) el.parentNode.removeChild(el);
    });
    Array.prototype.slice.call(root.querySelectorAll('em, strong, b, i, code, sup, sub')).forEach(function (el) {
      if (!el.firstChild) el.parentNode.removeChild(el);
    });
    // Links with nothing to click: no text and no picture.
    Array.prototype.slice.call(root.querySelectorAll('a')).forEach(function (el) {
      if (!/\S/.test(el.textContent) && !el.querySelector(MEDIA_SEL)) el.parentNode.removeChild(el);
    });
  }

  function sanitizeNodeToContainer(node, baseUrl) {
    var box = INERT.createElement('div');
    sanitizeInto(node, box, baseUrl || null);
    tidy(box);
    return box;
  }

  function sanitizeNode(node, baseUrl) {
    return sanitizeNodeToContainer(node, baseUrl).innerHTML;
  }

  /**
   * Sanitize an HTML string to the reader whitelist.
   * @param {string} html
   * @param {string} [baseUrl] used to resolve relative links and images; without it relative URLs are dropped.
   * @returns {string}
   */
  function sanitize(html, baseUrl) {
    var d = markupParser.parseFromString('<!doctype html><html><head></head><body>' + String(html == null ? '' : html) + '</body></html>', 'text/html');
    return sanitizeNode(d.body, baseUrl);
  }

  // Final per-section pass: sanitize, drop a leading heading that repeats the
  // section title (the reader prints the title as h1), and map heading levels
  // by rank to h2, h3, h4. Web pages (keepLevels) keep h2 to h6 as written and
  // only move a stray h1 down to h2.
  function finishSection(html, title, baseUrl, keepLevels) {
    var d = markupParser.parseFromString('<!doctype html><html><head></head><body>' + html + '</body></html>', 'text/html');
    var box = sanitizeNodeToContainer(d.body, baseUrl);
    var tkey = normKey(title);
    if (tkey) {
      for (var n = box.firstElementChild; n; n = n.nextElementSibling) {
        if (lname(n) === 'div') continue; // page markers
        if (/^h[1-6]$/.test(lname(n))) {
          var hk = normKey(n.textContent);
          if (hk && (hk === tkey || (tkey.length > 8 && hk.indexOf(tkey) === 0 && hk.length - tkey.length < 4) ||
              (hk.length > 3 && tkey.length > hk.length && tkey.slice(-hk.length) === hk && /^(chapter|part|book|section)\b/.test(tkey)))) {
            box.removeChild(n);
          }
        }
        break;
      }
    }
    var heads = Array.prototype.slice.call(box.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    var levels = Array.from(new Set(heads.map(function (h) { return +lname(h)[1]; }))).sort();
    heads.forEach(function (h) {
      var lvl = keepLevels ? Math.max(2, +lname(h)[1]) : Math.min(4, 2 + levels.indexOf(+lname(h)[1]));
      if (lname(h) !== 'h' + lvl) {
        var nh = INERT.createElement('h' + lvl);
        if (h.hasAttribute('id')) nh.setAttribute('id', h.getAttribute('id'));
        while (h.firstChild) nh.appendChild(h.firstChild);
        h.parentNode.replaceChild(nh, h);
      }
    });
    return box.innerHTML;
  }

  function htmlTextLength(html) {
    var d = markupParser.parseFromString('<body>' + html + '</body>', 'text/html');
    return collapse(d.body.textContent).length;
  }

  function makeDoc(title, author, source, sections) {
    var out = [];
    var anyText = false;
    sections.forEach(function (s, i) {
      var t = collapse(s.title) || ('Section ' + (i + 1));
      var html = finishSection(s.html || '', t, s.baseUrl || null, !!s.keepLevels);
      var hasText = /\S/.test(html.replace(/<[^>]*>/g, ''));
      var keep = hasText || /<(img|video|audio)\b/.test(html) || /ph-pagemark/.test(html);
      if (hasText) anyText = true;
      if (keep) out.push({ title: t, html: html });
    });
    if (!anyText) throw fail('NO_TEXT', 'This file has no readable text.');
    return {
      title: collapse(title) || 'Untitled',
      author: author ? collapse(author) || null : null,
      source: source,
      sections: out
    };
  }

  // ---------------------------------------------------------------------------
  // Type sniffing
  // ---------------------------------------------------------------------------

  var EXT_KIND = { pdf: 'pdf', epub: 'epub', docx: 'docx', docm: 'docx', dotx: 'docx', txt: 'txt', text: 'txt',
    log: 'txt', csv: 'txt', md: 'md', markdown: 'md', mdown: 'md', mkd: 'md', html: 'html', htm: 'html',
    xhtml: 'html', shtml: 'html', fb2: 'fb2' };

  var KINDLE_MSG = 'This is a Kindle book (MOBI, AZW or KFX), which Polycarp cannot open. Convert it to EPUB with the free Calibre app, then open the EPUB in Polycarp.';
  var UNSUPPORTED_EXT = {
    mobi: KINDLE_MSG, azw: KINDLE_MSG, azw3: KINDLE_MSG, azw4: KINDLE_MSG, kfx: KINDLE_MSG, prc: KINDLE_MSG, tpz: KINDLE_MSG,
    doc: 'This is an old Word .doc file. Open it in Word, Pages, Google Docs or LibreOffice, save it as .docx, then open that in Polycarp.',
    rtf: 'Polycarp cannot open RTF files. Save it as .docx or .txt from your word processor, then open that.',
    odt: 'Polycarp cannot open OpenDocument files yet. Save it as .docx from LibreOffice, then open that.',
    pages: 'Polycarp cannot open Pages files. In Pages choose File, Export To, Word, then open the .docx.',
    djvu: 'Polycarp cannot open DjVu files. Convert it to PDF first.',
    cbz: 'Comic archives are images only, so there is no text for Polycarp to read.',
    cbr: 'Comic archives are images only, so there is no text for Polycarp to read.'
  };

  function sniffBytes(u8) {
    var head = latin1(u8, 0, 1024);
    if (head.indexOf('%PDF-') !== -1) return 'pdf';
    if (u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7)) return 'zip';
    var tag = latin1(u8, 60, 68);
    if (tag === 'BOOKMOBI' || tag === 'TEXtREAd') return 'mobi';
    if (head.slice(0, 4) === 'TPZ0' || head.slice(0, 8) === '\xeaDRMION\xee') return 'mobi';
    if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) return 'ole';
    if (head.slice(0, 5) === '{\\rtf') return 'rtf';
    if (head.slice(0, 8) === 'AT&TFORM') return 'djvu';
    if (head.slice(0, 4) === 'Rar!') return 'rar';
    var t = head.replace(/^\xef\xbb\xbf/, '').replace(/^\s+/, '').toLowerCase();
    if (/<fictionbook[\s>]/.test(t)) return 'fb2';
    if (/^<!doctype html/.test(t) || /^<html[\s>]/.test(t) || /^(<!--[\s\S]*?-->\s*)*<(html|head|body)[\s>]/.test(t)) return 'html';
    return null;
  }

  function looksBinary(u8) {
    var n = Math.min(u8.length, 4096);
    if (n >= 2 && ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff))) return false;
    var bad = 0;
    for (var i = 0; i < n; i++) {
      var c = u8[i];
      if (c === 0) return true;
      if (c < 9 || (c > 13 && c < 32)) bad++;
    }
    return bad > n * 0.02;
  }

  function zipEntry(zip, path) {
    if (!path) return null;
    var f = zip.file(path);
    if (f) return f;
    try { f = zip.file(decodeURIComponent(path)); if (f) return f; } catch (e) { /* malformed escape */ }
    var lower = path.toLowerCase();
    var hit = Object.keys(zip.files).find(function (k) { return k.toLowerCase() === lower; });
    return hit ? zip.file(hit) : null;
  }

  async function zipText(zip, path) {
    var f = zipEntry(zip, path);
    if (!f) return null;
    return decodeBytes(await f.async('uint8array'));
  }

  async function sniffZip(zip) {
    var mt = zipEntry(zip, 'mimetype');
    if (mt) {
      var s = (await mt.async('string')).trim();
      if (s.indexOf('application/epub+zip') === 0) return 'epub';
      if (s.indexOf('application/vnd.oasis.opendocument') === 0) return 'odt';
    }
    if (zipEntry(zip, 'META-INF/container.xml')) return 'epub';
    if (zipEntry(zip, 'word/document.xml')) return 'docx';
    var names = Object.keys(zip.files);
    if (names.some(function (n) { return /\.fb2$/i.test(n); })) return 'fb2zip';
    if (names.some(function (n) { return /\.(jpe?g|png|webp|gif)$/i.test(n); }) &&
      names.every(function (n) { return /\.(jpe?g|png|webp|gif|xml|txt)$/i.test(n) || zip.files[n].dir; })) return 'cbz';
    return null;
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------

  async function fromFile(file, name, opts) {
    if (name && typeof name === 'object') { opts = name; name = undefined; }
    opts = opts || {};
    if (!file || typeof file.arrayBuffer !== 'function') throw fail('UNSUPPORTED', 'Nothing to open.');
    name = name || file.name || 'Untitled';
    var buf = await file.arrayBuffer();
    return fromBuffer(buf, { name: name, url: null, contentType: file.type || '', opts: opts });
  }

  function filenameFromDisposition(cd) {
    if (!cd) return null;
    var m = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
    if (m) { try { return decodeURIComponent(m[1].trim()); } catch (e) { /* fall through */ } }
    m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    return m ? m[1].trim() : null;
  }

  function nameFromUrl(url) {
    try {
      var u = new URL(url);
      var seg = u.pathname.split('/').filter(Boolean).pop();
      if (seg) { try { return decodeURIComponent(seg); } catch (e) { return seg; } }
      return u.hostname || url;
    } catch (e) { return url; }
  }

  function xhrArrayBuffer(url) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'arraybuffer';
      x.onload = function () { (x.status === 0 || (x.status >= 200 && x.status < 300)) && x.response ? resolve(x.response) : reject(new Error('status ' + x.status)); };
      x.onerror = function () { reject(new Error('network')); };
      x.send();
    });
  }

  async function readBody(res, report) {
    var total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !res.body.getReader || !total) return res.arrayBuffer();
    var reader = res.body.getReader();
    var chunks = [], got = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      got += r.value.length;
      report(Math.min(1, got / total));
    }
    var out = new Uint8Array(got), off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });
    return out.buffer;
  }

  async function fromUrl(url, opts) {
    opts = opts || {};
    var prog = progressFn(opts);
    var buf, ct = '', finalUrl = url, name = null;
    if (/^file:/i.test(url)) {
      try { buf = await xhrArrayBuffer(url); } catch (e) {
        throw fail('FETCH', 'Chrome blocked Polycarp from reading this local file. Open chrome://extensions, choose Details under Polycarp, turn on "Allow access to file URLs", then try again.');
      }
    } else {
      var res;
      try { res = await fetch(url, { credentials: 'include', redirect: 'follow' }); } catch (e) {
        throw fail('FETCH', 'Could not download ' + url + '. Check your connection and try again.');
      }
      if (!res.ok) throw fail('FETCH', 'That page did not load (error ' + res.status + '). Check the link, or open the page in a tab and choose Read this page in Polycarp.');
      ct = res.headers.get('content-type') || '';
      finalUrl = res.url || url;
      name = filenameFromDisposition(res.headers.get('content-disposition'));
      try { buf = await readBody(res, function (f) { prog(f * 0.3); }); } catch (e) {
        throw fail('FETCH', 'The download of ' + url + ' was cut off. Try again.');
      }
    }
    prog(0.3);
    var inner = { onProgress: function (f) { prog(0.3 + 0.7 * f); }, password: opts.password };
    return fromBuffer(buf, { name: name || nameFromUrl(finalUrl), url: finalUrl, contentType: ct, opts: inner });
  }

  async function fromBuffer(buf, info) {
    var u8 = new Uint8Array(buf);
    var name = info.name || 'Untitled';
    var ext = extOf(name);
    var ct = (info.contentType || '').toLowerCase();
    var opts = info.opts || {};
    var prog = progressFn(opts);
    var kind = sniffBytes(u8);
    var zip = null;

    if (kind === 'zip') {
      if (typeof JSZip === 'undefined') throw new Error('JSZip is not loaded');
      try { zip = await JSZip.loadAsync(buf); } catch (e) {
        throw fail('UNSUPPORTED', 'This file looks like a ZIP archive but it is damaged, so Polycarp cannot open it.');
      }
      kind = await sniffZip(zip);
      if (kind === 'odt') throw fail('UNSUPPORTED', UNSUPPORTED_EXT.odt);
      if (kind === 'cbz') throw fail('UNSUPPORTED', UNSUPPORTED_EXT.cbz);
      if (!kind) {
        throw fail('UNSUPPORTED', UNSUPPORTED_EXT[ext] || 'This ZIP file is not an EPUB or a Word document, so Polycarp cannot open it.');
      }
    }
    if (kind === 'mobi') throw fail('UNSUPPORTED', KINDLE_MSG);
    if (kind === 'ole') throw fail('UNSUPPORTED', 'This is an old Word .doc file or a password-protected Word file. Open it in Word, Pages, Google Docs or LibreOffice, save it as an unprotected .docx, then open that in Polycarp.');
    if (kind === 'rtf') throw fail('UNSUPPORTED', UNSUPPORTED_EXT.rtf);
    if (kind === 'djvu') throw fail('UNSUPPORTED', UNSUPPORTED_EXT.djvu);
    if (kind === 'rar') throw fail('UNSUPPORTED', UNSUPPORTED_EXT[ext] || 'Polycarp cannot open RAR archives.');

    if (!kind) {
      if (UNSUPPORTED_EXT[ext]) throw fail('UNSUPPORTED', UNSUPPORTED_EXT[ext]);
      if (looksBinary(u8)) {
        if (EXT_KIND[ext] === 'pdf' || /pdf/.test(ct)) throw fail('UNSUPPORTED', 'This file is named like a PDF but it is not a valid PDF, so Polycarp cannot open it.');
        if (EXT_KIND[ext] === 'epub' || EXT_KIND[ext] === 'docx') throw fail('UNSUPPORTED', 'This file is damaged, so Polycarp cannot open it.');
        throw fail('UNSUPPORTED', 'Polycarp cannot read this kind of file. It opens PDF, EPUB, Word (.docx), FB2, HTML, Markdown, plain text and web pages.');
      }
      kind = EXT_KIND[ext];
      if (kind === 'pdf' || kind === 'epub' || kind === 'docx') kind = null; // named so, but bytes say text
      if (!kind) {
        if (/html|xhtml/.test(ct)) kind = 'html';
        else if (/markdown/.test(ct)) kind = 'md';
        else kind = 'txt';
      }
    }

    var doc;
    switch (kind) {
      case 'pdf':
        doc = await importPdf(u8, { name: name, url: info.url, password: opts.password, prog: prog });
        break;
      case 'epub':
        doc = await importEpub(zip, { name: name, url: info.url });
        break;
      case 'docx':
        doc = await importDocx(buf, zip, { name: name, url: info.url });
        break;
      case 'fb2':
        doc = importFb2(decodeXmlBytes(u8), { name: name, url: info.url });
        break;
      case 'fb2zip': {
        var fbName = Object.keys(zip.files).find(function (n) { return /\.fb2$/i.test(n); });
        doc = importFb2(decodeXmlBytes(await zip.file(fbName).async('uint8array')), { name: name, url: info.url });
        break;
      }
      case 'html': {
        var html = decodeBytes(u8, charsetFromContentType(ct) || metaCharset(u8));
        doc = fromHtml(html, info.url, titleFromName(name));
        doc.source.name = name;
        break;
      }
      case 'md':
      case 'txt': {
        var text = decodeBytes(u8, charsetFromContentType(ct));
        doc = textDoc(text, name, kind, info.url);
        break;
      }
      default:
        throw fail('UNSUPPORTED', 'Polycarp cannot read this kind of file.');
    }
    prog(1);
    return doc;
  }

  function metaCharset(u8) {
    var m = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(latin1(u8, 0, 2048));
    return m ? m[1] : null;
  }

  function decodeXmlBytes(u8) {
    var m = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(latin1(u8, 0, 200));
    return decodeBytes(u8, m ? m[1] : null);
  }

  // ---------------------------------------------------------------------------
  // HTML (web pages)
  // ---------------------------------------------------------------------------

  // Swap players and embeds for placeholder images so Readability keeps their
  // place, and park the originals for sanitizeInto. Tweets get a marker that
  // survives Readability dropping class names.
  function stashMedia(doc, pageUrl) {
    var stash = { nonce: 'm' + Math.random().toString(36).slice(2, 10), nodes: [], pageUrl: pageUrl || null };
    Array.prototype.slice.call(doc.querySelectorAll('iframe, embed, object, video, audio')).forEach(function (el) {
      for (var p = el.parentNode; p; p = p.parentNode) if (p.nodeType === 1 && MEDIA_TAGS.has(lname(p))) return;
      if (!el.parentNode) return;
      var holder = doc.createElement('img');
      holder.setAttribute('src', 'https://polycarp.invalid/media.png');
      holder.setAttribute('alt', '');
      holder.setAttribute('data-ph-media', stash.nonce + ':' + stash.nodes.length);
      stash.nodes.push(el);
      el.parentNode.replaceChild(holder, el);
    });
    Array.prototype.forEach.call(doc.querySelectorAll('blockquote.twitter-tweet, blockquote.twitter-video'), function (b) {
      b.setAttribute('data-ph-tweet', stash.nonce);
    });
    return stash;
  }

  function fromHtml(html, baseUrl, fallbackTitle) {
    var doc = markupParser.parseFromString(String(html || ''), 'text/html');
    var base = null;
    if (baseUrl) {
      var existing = doc.querySelector('base[href]');
      var target = baseUrl;
      if (existing) { try { target = new URL(existing.getAttribute('href'), baseUrl).href; } catch (e) { /* keep page URL */ } }
      if (!existing) {
        existing = doc.createElement('base');
        (doc.head || doc.documentElement).insertBefore(existing, (doc.head || doc.documentElement).firstChild);
      }
      existing.setAttribute('href', target);
      base = target;
    }
    var metaAuthor = doc.querySelector('meta[name="author"], meta[property="article:author"], meta[name="byl"]');
    var pageTitle = collapse(doc.title);
    var stash = stashMedia(doc, isWebUrl(baseUrl) ? baseUrl : null);
    var article = null;
    if (typeof Readability !== 'undefined') {
      try {
        article = new Readability(doc.cloneNode(true), { charThreshold: 300, keepClasses: false }).parse();
      } catch (e) { article = null; }
    }
    var contentHtml;
    if (article && article.content && collapse(article.textContent).length >= 120) {
      contentHtml = article.content;
    } else {
      var body = doc.body ? doc.body.cloneNode(true) : doc.documentElement.cloneNode(true);
      Array.prototype.slice.call(body.querySelectorAll('nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]'))
        .forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      contentHtml = body.innerHTML;
      article = null;
    }
    var title = collapse((article && article.title) || pageTitle || fallbackTitle || (baseUrl ? nameFromUrl(baseUrl) : '')) || 'Untitled';
    var h1 = doc.querySelector('h1');
    var h1Text = h1 ? collapse(h1.textContent) : '';
    if (h1Text.length >= 3 && h1Text !== title && title.indexOf(h1Text) !== -1 && /\s[|\-\u2013\u2014:\u00b7\u2022]\s/.test(title)) title = h1Text;
    var author = collapse((article && article.byline) || (metaAuthor && metaAuthor.getAttribute('content')) || '') || null;
    if (author && author.length > 120) author = null;
    var name = fallbackTitle || (baseUrl ? nameFromUrl(baseUrl) : title);
    MEDIA_STASH = stash;
    try {
      return makeDoc(title, author, { kind: 'html', name: name, url: baseUrl || null },
        [{ title: title, html: contentHtml, baseUrl: base, keepLevels: true }]);
    } finally {
      MEDIA_STASH = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Plain text and Markdown
  // ---------------------------------------------------------------------------

  var NUM_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final';
  var CHAPTER_RE = new RegExp('^(chapter|chap\\.|book|part|volume|letter)\\s+(\\d{1,4}|[ivxlcdm]{1,8}|(?:' + NUM_WORDS + ')(?:[- ](?:' + NUM_WORDS + '))?)\\b(\\s*[.:\\-]\\s*.*|\\s+\\p{Lu}[^.!?,;]*[.!?]?)?$', 'iu');
  var EXTRA_HEAD_RE = /^(prologue|epilogue|preface|introduction|foreword|afterword|conclusion|appendix|acknowledg(e)?ments)\.?$/i;

  function isChapterLine(line) {
    var t = line.trim();
    return t.length > 0 && t.length <= 70 && CHAPTER_RE.test(t);
  }

  function fromText(text, name) {
    name = name || 'Untitled.txt';
    var ext = extOf(name);
    var kind = EXT_KIND[ext] === 'md' ? 'md' : 'txt';
    return textDoc(String(text == null ? '' : text), name, kind, null);
  }

  function textDoc(text, name, kind, url) {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (kind === 'md') return markdownDoc(text, name, url);
    var lines = text.split('\n');
    var title = null, author = null;
    var skip = new Set();
    for (var i = 0; i < Math.min(lines.length, 60); i++) {
      var mt = /^\s*Title:\s*(.+?)\s*$/i.exec(lines[i]);
      var ma = /^\s*(?:Author|By):\s*(.+?)\s*$/i.exec(lines[i]);
      if (mt && !title) { title = mt[1]; skip.add(i); }
      else if (ma && !author) { author = ma[1]; skip.add(i); }
    }
    var docTitle = title || titleFromName(name);
    var nonEmpty = lines.filter(function (l) { return /\S/.test(l); });
    var hasBlank = false;
    var started = false;
    for (var b = 0; b < lines.length; b++) {
      if (/\S/.test(lines[b])) started = true;
      else if (started) {
        var rest = lines.slice(b).some(function (l) { return /\S/.test(l); });
        if (rest) { hasBlank = true; break; }
      }
    }
    var lineMode = !hasBlank && nonEmpty.length > 3;
    var typicalLen = median(nonEmpty.map(function (l) { return l.trim().length; }));
    var hasChapters = lines.some(isChapterLine);

    var sections = [];
    var cur = { title: null, parts: [] };
    var para = [];

    function flushPara() {
      if (!para.length) return;
      var shortLines = para.length >= 2 && typicalLen >= 55 && para.every(function (l) { return l.trim().length < 48; });
      var html;
      if (shortLines) {
        html = para.map(function (l) { return esc(l.trim()); }).join('<br>');
      } else {
        var joined = '';
        para.forEach(function (l) {
          var t = l.trim();
          if (!joined) joined = t;
          else if (/\p{L}-$/u.test(joined)) joined += t;
          else joined += ' ' + t;
        });
        html = esc(joined);
      }
      cur.parts.push('<p>' + html + '</p>');
      para = [];
    }

    function startSection(t) {
      flushPara();
      sections.push(cur);
      cur = { title: t, parts: [] };
    }

    for (var k = 0; k < lines.length; k++) {
      if (skip.has(k)) continue;
      var line = lines[k];
      var trimmed = line.trim();
      if (!trimmed) { flushPara(); continue; }
      if (hasChapters && (isChapterLine(line) || EXTRA_HEAD_RE.test(trimmed))) {
        var prevBlank = k === 0 || !/\S/.test(lines[k - 1]) || lineMode;
        if (prevBlank) {
          var t = trimmed.replace(/[.:]\s*$/, '');
          // A short subtitle line right after the heading, such as "The Boy Who Lived".
          var j = k + 1;
          while (j < lines.length && !/\S/.test(lines[j])) j++;
          if (!lineMode && j < lines.length && j > k + 1) {
            var sub = lines[j].trim();
            var after = j + 1 >= lines.length || !/\S/.test(lines[j + 1]);
            if (after && sub.length <= 60 && !/[.,;:!?]$/.test(sub) && !isChapterLine(sub) && /^\p{Lu}/u.test(sub)) {
              t += ': ' + sub;
              k = j;
            }
          }
          startSection(t);
          continue;
        }
      }
      if (lineMode) { para.push(line); flushPara(); }
      else para.push(line);
    }
    flushPara();
    sections.push(cur);

    var out = [];
    var front = sections[0];
    var rest2 = sections.slice(1);
    var frontHtml = front.parts.join('');
    if (!rest2.length) {
      out.push({ title: docTitle, html: frontHtml });
    } else {
      if (htmlTextLength(frontHtml) >= 200) out.push({ title: docTitle, html: frontHtml });
      else rest2[0].parts.unshift(frontHtml);
      rest2.forEach(function (s) { out.push({ title: s.title, html: s.parts.join('') }); });
    }
    return makeDoc(docTitle, author, { kind: 'txt', name: name, url: url || null }, out);
  }

  // Minimal Markdown: ATX and setext headings, paragraphs, emphasis, strong,
  // inline code, fenced and indented code, lists (nested by indent),
  // blockquotes, links, images, autolinks, hr. Raw HTML is shown as text.
  var MD_LIST_RE = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
  var MD_HR_RE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;

  function mdIndent(l) { var m = /^ */.exec(l); return m[0].length; }

  function mdIsBlockStart(l) {
    return /^ {0,3}(#{1,6}[ \t]|>|```|~~~)/.test(l) || MD_HR_RE.test(l) || MD_LIST_RE.test(l);
  }

  function mdInline(s) {
    var codes = [];
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, function (_, t, c) {
      codes.push('<code>' + esc(c.replace(/^ (.*) $/, '$1')) + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = esc(s);
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, function (_, c) { return '&#' + c.charCodeAt(0) + ';'; });
    s = s.replace(/!\[([^\]]*)\]\(\s*(?:&lt;)?([^)\s]+?)(?:&gt;)?(?:\s+&quot;[^)]*?&quot;)?\s*\)/g, function (_, alt, src) {
      return '<img src="' + src + '" alt="' + alt + '">';
    });
    s = s.replace(/\[([^\]]+)\]\(\s*(?:&lt;)?([^)\s]+?)(?:&gt;)?(?:\s+&quot;[^)]*?&quot;)?\s*\)/g, function (_, text, href) {
      return '<a href="' + href + '">' + text + '</a>';
    });
    s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
    s = s.replace(/(^|[^\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
    s = s.replace(/( {2,}|\\)\n/g, '<br>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, n) { return codes[+n]; });
    return s;
  }

  function mdBlocks(lines) {
    var out = '';
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!/\S/.test(line)) { i++; continue; }
      var m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m) {
        var fence = m[1], buf = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) { buf.push(lines[i]); i++; }
        i++;
        out += '<pre><code>' + esc(buf.join('\n')) + '</code></pre>';
        continue;
      }
      m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line) || /^ {0,3}(#{1,6})[ \t]*$/.exec(line);
      if (m) {
        out += '<h' + m[1].length + '>' + mdInline(m[2] || '') + '</h' + m[1].length + '>';
        i++;
        continue;
      }
      if (MD_HR_RE.test(line)) { out += '<hr>'; i++; continue; }
      if (/^ {0,3}>/.test(line)) {
        var q = [];
        while (i < lines.length && /\S/.test(lines[i])) {
          if (/^ {0,3}>/.test(lines[i])) q.push(lines[i].replace(/^ {0,3}> ?/, ''));
          else if (!mdIsBlockStart(lines[i])) q.push(lines[i]);
          else break;
          i++;
        }
        out += '<blockquote>' + mdBlocks(q) + '</blockquote>';
        continue;
      }
      m = MD_LIST_RE.exec(line);
      if (m) {
        var res = mdList(lines, i);
        out += res.html;
        i = res.next;
        continue;
      }
      if (/^ {4}/.test(line)) {
        var code = [];
        while (i < lines.length && (/^ {4}/.test(lines[i]) || !/\S/.test(lines[i]))) { code.push(lines[i].slice(4)); i++; }
        while (code.length && !/\S/.test(code[code.length - 1])) code.pop();
        out += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
        continue;
      }
      var para = [line];
      i++;
      while (i < lines.length && /\S/.test(lines[i]) && !mdIsBlockStart(lines[i])) {
        if (/^ {0,3}(=+|-+)[ \t]*$/.test(lines[i])) break;
        para.push(lines[i]);
        i++;
      }
      if (i < lines.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i]) && para.length) {
        var lvl = lines[i].trim()[0] === '=' ? 1 : 2;
        out += '<h' + lvl + '>' + mdInline(para.join(' ').trim()) + '</h' + lvl + '>';
        i++;
        continue;
      }
      out += '<p>' + mdInline(para.map(function (l) { return l.replace(/^\s+/, ''); }).join('\n')) + '</p>';
    }
    return out;
  }

  function mdList(lines, i) {
    var first = MD_LIST_RE.exec(lines[i]);
    var ordered = /\d/.test(first[2]);
    var baseIndent = first[1].length;
    var items = [];
    var loose = false;
    while (i < lines.length) {
      var m = MD_LIST_RE.exec(lines[i]);
      if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
      var contentIndent = m[1].length + m[2].length + 1;
      var buf = [m[3]];
      i++;
      while (i < lines.length) {
        var l = lines[i];
        if (!/\S/.test(l)) {
          var j = i + 1;
          while (j < lines.length && !/\S/.test(lines[j])) j++;
          if (j < lines.length && mdIndent(lines[j]) >= contentIndent) { buf.push(''); i++; loose = true; continue; }
          if (j < lines.length) {
            var sib = MD_LIST_RE.exec(lines[j]);
            if (sib && sib[1].length === baseIndent && /\d/.test(sib[2]) === ordered) { loose = true; i = j; }
          }
          break;
        }
        var lm = MD_LIST_RE.exec(l);
        if (lm && lm[1].length <= baseIndent) break;
        if (mdIndent(l) >= Math.min(contentIndent, baseIndent + 2)) { buf.push(l.slice(Math.min(mdIndent(l), contentIndent))); i++; continue; }
        if (mdIsBlockStart(l)) break;
        buf.push(l.trim());
        i++;
      }
      items.push(buf);
    }
    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + '>' + items.map(function (b) {
      var inner = mdBlocks(b);
      if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      return '<li>' + inner + '</li>';
    }).join('') + '</' + tag + '>';
    return { html: html, next: i };
  }

  function splitAtH1(html, docTitle) {
    var d = markupParser.parseFromString('<!doctype html><html><head></head><body>' + html + '</body></html>', 'text/html');
    var parts = [{ title: null, nodes: [] }];
    Array.prototype.slice.call(d.body.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && lname(n) === 'h1') {
        parts.push({ title: collapse(n.textContent), nodes: [] });
        return;
      }
      parts[parts.length - 1].nodes.push(n);
    });
    var ser = function (nodes) {
      var box = d.createElement('div');
      nodes.forEach(function (n) { box.appendChild(n); });
      return box.innerHTML;
    };
    var preHtml = ser(parts[0].nodes);
    var rest = parts.slice(1);
    if (!rest.length) return { sections: [{ title: docTitle, html: preHtml }], h1Count: 0, firstH1: null };
    var out = [];
    var preBig = htmlTextLength(preHtml) >= 200 || /<img\b/i.test(preHtml) && htmlTextLength(preHtml) >= 40;
    if (preBig) out.push({ title: docTitle, html: preHtml });
    rest.forEach(function (p, i) {
      out.push({ title: p.title || ('Part ' + (i + 1)), html: (i === 0 && !preBig ? preHtml : '') + ser(p.nodes) });
    });
    return { sections: out, h1Count: rest.length, firstH1: rest[0].title };
  }

  function markdownDoc(text, name, url) {
    var lines = text.replace(/\t/g, '    ').split('\n');
    // YAML front matter: keep title and author, drop the rest.
    var fmTitle = null, fmAuthor = null;
    if (/^---\s*$/.test(lines[0] || '')) {
      var end = lines.indexOf('---', 1);
      if (end === -1) end = lines.indexOf('...', 1);
      if (end > 0 && end < 80) {
        lines.slice(1, end).forEach(function (l) {
          var m = /^(title|author)\s*:\s*["']?(.*?)["']?\s*$/i.exec(l);
          if (m && m[1].toLowerCase() === 'title') fmTitle = m[2];
          if (m && m[1].toLowerCase() === 'author') fmAuthor = m[2];
        });
        lines = lines.slice(end + 1);
      }
    }
    var html = mdBlocks(lines);
    var fallback = fmTitle || titleFromName(name);
    var split = splitAtH1(html, fallback);
    var title = fmTitle || (split.h1Count === 1 ? split.firstH1 : fallback);
    return makeDoc(title, fmAuthor, { kind: 'md', name: name, url: url || null }, split.sections);
  }

  // ---------------------------------------------------------------------------
  // DOCX
  // ---------------------------------------------------------------------------

  async function importDocx(buf, zip, info) {
    if (typeof mammoth === 'undefined') throw new Error('mammoth is not loaded');
    var opts = {};
    if (mammoth.images && mammoth.images.dataUri) opts.convertImage = mammoth.images.dataUri;
    var result;
    try { result = await mammoth.convertToHtml({ arrayBuffer: buf }, opts); } catch (e) {
      throw fail('UNSUPPORTED', 'This Word document is damaged or uses a format Polycarp cannot read.');
    }
    var title = null, author = null;
    try {
      var core = zip ? await zipText(zip, 'docProps/core.xml') : null;
      var cd = core && parseXml(core);
      if (cd) {
        var t = byLocal(cd, 'title')[0], c = byLocal(cd, 'creator')[0];
        title = t ? collapse(t.textContent) : null;
        author = c ? collapse(c.textContent) : null;
      }
    } catch (e) { /* metadata is optional */ }
    var fallback = title || titleFromName(info.name);
    var split = splitAtH1(result.value || '', fallback);
    if (!title) title = split.h1Count === 1 ? split.firstH1 : fallback;
    return makeDoc(title, author, { kind: 'docx', name: info.name, url: info.url || null }, split.sections);
  }

  // ---------------------------------------------------------------------------
  // EPUB
  // ---------------------------------------------------------------------------

  var XLINK = 'http://www.w3.org/1999/xlink';
  var OPS = 'http://www.idpf.org/2007/ops';
  var XHTML = 'http://www.w3.org/1999/xhtml';

  function dirOf(path) {
    var i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i + 1);
  }

  function resolvePath(dir, href) {
    href = String(href || '').replace(/[#?].*$/, '');
    try { href = decodeURIComponent(href); } catch (e) { /* keep raw */ }
    var parts = (href.charAt(0) === '/' ? href.slice(1) : dir + href).split('/');
    var out = [];
    parts.forEach(function (p) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    });
    return out.join('/');
  }

  async function checkEpubDrm(zip) {
    var enc = await zipText(zip, 'META-INF/encryption.xml');
    if (!enc) return;
    var drmMsg = 'This EPUB is locked with DRM, so Polycarp cannot read it. Polycarp opens DRM-free books only. Many stores and libraries offer DRM-free EPUBs.';
    var OBF = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
    var d = parseXml(enc);
    if (!d) {
      if (/CipherReference[^>]+URI\s*=\s*["'][^"']+\.(x?html?|xml|ncx|opf)["']/i.test(enc)) throw fail('DRM', drmMsg);
      return;
    }
    byLocal(d, 'EncryptedData').forEach(function (ed) {
      var em = byLocal(ed, 'EncryptionMethod')[0];
      var cr = byLocal(ed, 'CipherReference')[0];
      var alg = em ? em.getAttribute('Algorithm') || '' : '';
      var uri = cr ? cr.getAttribute('URI') || '' : '';
      if (OBF.indexOf(alg) !== -1) return;
      if (/\.(otf|ttf|woff2?|eot)$/i.test(uri)) return;
      throw fail('DRM', drmMsg);
    });
  }

  async function epubToc(zip, opf, manifest) {
    var map = new Map();
    var items = Array.from(manifest.values());
    var navItem = items.find(function (it) { return /(^|\s)nav(\s|$)/.test(it.properties || ''); });
    if (navItem) {
      var txt = await zipText(zip, navItem.path);
      if (txt) {
        var d = parseXhtml(txt);
        var navs = byLocal(d, 'nav');
        var toc = navs.find(function (n) {
          return /\btoc\b/.test(n.getAttributeNS(OPS, 'type') || n.getAttribute('epub:type') || n.getAttribute('role') || '');
        }) || navs[0];
        if (toc) {
          byLocal(toc, 'a').forEach(function (a) {
            var href = a.getAttribute('href');
            if (!href) return;
            var p = resolvePath(dirOf(navItem.path), href);
            var label = collapse(a.textContent);
            if (label && !map.has(p)) map.set(p, label);
          });
        }
      }
    }
    if (!map.size) {
      var spine = byLocal(opf, 'spine')[0];
      var tocId = spine && spine.getAttribute('toc');
      var ncxItem = (tocId && manifest.get(tocId)) || items.find(function (it) { return it.type === 'application/x-dtbncx+xml'; });
      if (ncxItem) {
        var ntxt = await zipText(zip, ncxItem.path);
        var nd = ntxt && parseXml(ntxt);
        if (nd) {
          byLocal(nd, 'navPoint').forEach(function (np) {
            var labelEl = byLocal(np, 'text')[0];
            var content = byLocal(np, 'content')[0];
            if (!labelEl || !content) return;
            var p = resolvePath(dirOf(ncxItem.path), content.getAttribute('src'));
            var label = collapse(labelEl.textContent);
            if (label && !map.has(p)) map.set(p, label);
          });
        }
      }
    }
    return map;
  }

  async function epubImages(root, docPath, zip, byPath, cache) {
    var doc = root.ownerDocument;
    var dir = dirOf(docPath);
    byLocal(root, 'svg').forEach(function (svg) {
      var im = byLocal(svg, 'image')[0];
      if (!im) return;
      var href = im.getAttributeNS(XLINK, 'href') || im.getAttribute('href') || im.getAttribute('xlink:href');
      if (!href) return;
      var img = doc.createElementNS(XHTML, 'img');
      img.setAttribute('src', href);
      img.setAttribute('alt', '');
      svg.parentNode.replaceChild(img, svg);
    });
    var imgs = byLocal(root, 'img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute('src');
      if (!src || /^(data|blob|https?):/i.test(src)) continue;
      var path = resolvePath(dir, src);
      var url = cache.get(path);
      if (url === undefined) {
        var f = zipEntry(zip, path);
        url = null;
        if (f) {
          var item = byPath.get(path);
          var type = (item && item.type) || guessImageType(path);
          url = URL.createObjectURL(new Blob([await f.async('uint8array')], { type: type }));
        }
        cache.set(path, url);
      }
      if (url) img.setAttribute('src', url);
      else img.parentNode.removeChild(img);
    }
  }

  function guessImageType(path) {
    var e = extOf(path);
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[e] || 'application/octet-stream';
  }

  async function importEpub(zip, info) {
    await checkEpubDrm(zip);
    var opfPath = null;
    var containerXml = await zipText(zip, 'META-INF/container.xml');
    var cd = containerXml && parseXml(containerXml);
    var rf = cd && byLocal(cd, 'rootfile')[0];
    if (rf) opfPath = rf.getAttribute('full-path');
    if (!opfPath || !zipEntry(zip, opfPath)) opfPath = Object.keys(zip.files).find(function (p) { return /\.opf$/i.test(p); });
    if (!opfPath) throw fail('UNSUPPORTED', 'This EPUB is damaged, so Polycarp cannot open it. Try downloading it again.');
    var opfText = await zipText(zip, opfPath);
    var opf = opfText && parseXml(opfText);
    if (!opf) throw fail('UNSUPPORTED', 'This EPUB is damaged, so Polycarp cannot open it. Try downloading it again.');
    var opfDir = dirOf(opfPath);
    var manifest = new Map(), byPath = new Map();
    byLocal(opf, 'item').forEach(function (it) {
      var rec = {
        id: it.getAttribute('id'),
        path: resolvePath(opfDir, it.getAttribute('href') || ''),
        type: it.getAttribute('media-type') || '',
        properties: it.getAttribute('properties') || ''
      };
      if (rec.id) manifest.set(rec.id, rec);
      byPath.set(rec.path, rec);
    });
    var metadata = byLocal(opf, 'metadata')[0] || opf;
    var titleEl = byLocal(metadata, 'title')[0];
    var creatorEl = byLocal(metadata, 'creator')[0];
    var docTitle = (titleEl && collapse(titleEl.textContent)) || titleFromName(info.name);
    var author = creatorEl ? collapse(creatorEl.textContent) : null;

    var toc = await epubToc(zip, opf, manifest);
    var spine = byLocal(opf, 'itemref').map(function (r) { return manifest.get(r.getAttribute('idref')); }).filter(Boolean);
    var cache = new Map();
    var sections = [];
    var pending = '';
    for (var i = 0; i < spine.length; i++) {
      var item = spine[i];
      if (!/html|xml/i.test(item.type) && !/\.(x?html?|xml)$/i.test(item.path)) continue;
      if (/(^|\s)nav(\s|$)/.test(item.properties) && spine.length > 2) continue;
      var text = await zipText(zip, item.path);
      if (text == null) continue;
      var d = parseXhtml(text);
      var body = d.body || byLocal(d, 'body')[0];
      if (!body) continue;
      await epubImages(body, item.path, zip, byPath, cache);
      var heading = body.querySelector ? body.querySelector('h1, h2, h3, h4, h5, h6') : byLocal(body, 'h1')[0];
      var html = sanitizeNode(body, null);
      if (htmlTextLength(html) < 200) { pending += html; continue; }
      var title = toc.get(item.path) || (heading && collapse(heading.textContent)) || ('Chapter ' + (sections.length + 1));
      sections.push({ title: title, html: pending + html });
      pending = '';
    }
    if (pending) {
      if (sections.length) sections[sections.length - 1].html += pending;
      else sections.push({ title: docTitle, html: pending });
    }
    return makeDoc(docTitle, author, { kind: 'epub', name: info.name, url: info.url || null }, sections);
  }

  // ---------------------------------------------------------------------------
  // FB2 (FictionBook XML)
  // ---------------------------------------------------------------------------

  function importFb2(text, info) {
    var d = parseXml(text);
    if (!d) throw fail('UNSUPPORTED', 'This FB2 file is damaged and cannot be read.');
    var root = d.documentElement;
    var titleInfo = byLocal(root, 'title-info')[0];
    var bt = titleInfo && byLocal(titleInfo, 'book-title')[0];
    var docTitle = (bt && collapse(bt.textContent)) || titleFromName(info.name);
    var author = null;
    var a = titleInfo && byLocal(titleInfo, 'author')[0];
    if (a) {
      author = ['first-name', 'middle-name', 'last-name'].map(function (k) {
        var e = byLocal(a, k)[0];
        return e ? collapse(e.textContent) : '';
      }).filter(Boolean).join(' ');
      if (!author) { var nick = byLocal(a, 'nickname')[0]; author = nick ? collapse(nick.textContent) : null; }
    }
    var binaries = new Map();
    childByLocal(root, 'binary').forEach(function (b) { binaries.set(b.getAttribute('id'), b); });
    var urls = new Map();
    function binaryUrl(id) {
      if (urls.has(id)) return urls.get(id);
      var b = binaries.get(id), url = null;
      if (b) {
        try {
          var bin = atob(b.textContent.replace(/\s+/g, ''));
          var u8 = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          url = URL.createObjectURL(new Blob([u8], { type: b.getAttribute('content-type') || guessImageType(id) }));
        } catch (e) { url = null; }
      }
      urls.set(id, url);
      return url;
    }
    function href(n) {
      return n.getAttributeNS(XLINK, 'href') || n.getAttribute('l:href') || n.getAttribute('xlink:href') || n.getAttribute('href') || '';
    }
    function kids(n, depth) {
      var s = '';
      for (var c = n.firstChild; c; c = c.nextSibling) s += node(c, depth);
      return s;
    }
    function titleText(t) {
      var ps = childByLocal(t, 'p');
      return collapse(ps.length ? ps.map(function (p) { return p.textContent; }).join('. ').replace(/\.\.\s/g, '. ') : t.textContent);
    }
    function node(n, depth) {
      if (n.nodeType === 3 || n.nodeType === 4) return esc(n.nodeValue);
      if (n.nodeType !== 1) return '';
      switch (n.localName) {
        case 'p': return '<p>' + kids(n, depth) + '</p>';
        case 'emphasis': return '<em>' + kids(n, depth) + '</em>';
        case 'strong': return '<strong>' + kids(n, depth) + '</strong>';
        case 'sup': return '<sup>' + kids(n, depth) + '</sup>';
        case 'sub': return '<sub>' + kids(n, depth) + '</sub>';
        case 'code': return '<code>' + kids(n, depth) + '</code>';
        case 'a': {
          var h = href(n);
          if (/^https?:/i.test(h)) return '<a href="' + esc(h) + '">' + kids(n, depth) + '</a>';
          if (h.charAt(0) === '#') return '<sup>' + kids(n, depth) + '</sup>';
          return kids(n, depth);
        }
        case 'empty-line': return '';
        case 'subtitle': return '<p><strong>' + kids(n, depth) + '</strong></p>';
        case 'title': return '<h' + Math.min(4, depth + 1) + '>' + esc(titleText(n)) + '</h' + Math.min(4, depth + 1) + '>';
        case 'section': return kids(n, depth + 1);
        case 'epigraph': case 'cite': case 'poem': return '<blockquote>' + kids(n, depth) + '</blockquote>';
        case 'stanza': return '<p>' + childByLocal(n, 'v').map(function (v) { return kids(v, depth); }).join('<br>') + '</p>';
        case 'text-author': return '<p><em>' + kids(n, depth) + '</em></p>';
        case 'image': {
          var url = binaryUrl(href(n).replace(/^#/, ''));
          return url ? '<figure><img src="' + url + '" alt=""></figure>' : '';
        }
        case 'table': return '<table>' + kids(n, depth) + '</table>';
        case 'tr': return '<tr>' + kids(n, depth) + '</tr>';
        case 'td': return '<td>' + kids(n, depth) + '</td>';
        case 'th': return '<th>' + kids(n, depth) + '</th>';
        default: return kids(n, depth);
      }
    }
    var bodies = childByLocal(root, 'body');
    var main = bodies.filter(function (b) { return !/notes/i.test(b.getAttribute('name') || ''); });
    var notes = bodies.filter(function (b) { return /notes/i.test(b.getAttribute('name') || ''); });
    var sections = [];
    var pending = '';
    main.forEach(function (body) {
      var secs = childByLocal(body, 'section');
      if (!secs.length) { sections.push({ title: docTitle, html: kids(body, 0) }); return; }
      // Content in the body before the first section (cover image, epigraph).
      for (var c = body.firstChild; c && c.localName !== 'section'; c = c.nextSibling) {
        if (c.localName !== 'title') pending += node(c, 0);
      }
      secs.forEach(function (sec) {
        var t = childByLocal(sec, 'title')[0];
        var title = t ? titleText(t) : '';
        var html = '';
        for (var c2 = sec.firstChild; c2; c2 = c2.nextSibling) if (c2 !== t) html += node(c2, 1);
        if (!title && htmlTextLength(html) < 200) { pending += html; return; }
        sections.push({ title: title || ('Chapter ' + (sections.length + 1)), html: pending + html });
        pending = '';
      });
    });
    if (pending) {
      if (sections.length) sections[sections.length - 1].html += pending;
      else sections.push({ title: docTitle, html: pending });
    }
    notes.forEach(function (nb) { sections.push({ title: 'Notes', html: kids(nb, 1) }); });
    return makeDoc(docTitle, author, { kind: 'fb2', name: info.name, url: info.url || null }, sections);
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  var pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(extUrl('lib/pdfjs/pdf.min.mjs')).then(function (m) {
        m.GlobalWorkerOptions.workerSrc = extUrl('lib/pdfjs/pdf.worker.min.mjs');
        return m;
      }, function (e) { pdfjsPromise = null; throw e; });
    }
    return pdfjsPromise;
  }

  var BULLET_RE = /^[\u2022\u25E6\u25AA\u25AB\u2023\u2219\u00B7\u25CF\u25CB\u25A0\u25A1\u2043\u2013\-\*\u2192\u27A2\u25BA\uF0B7\uF0A7\uF0D8\uF076\uF0FC]\s*/;
  var ORDERED_RE = /^\(?(\d{1,3}|[a-z])[.)]\s+/;
  var SENTENCE_END_RE = /[.!?:;]["'\u201D\u2019)\]]*$/;

  function startsLower(t) { return /^["'\u201C\u2018(\[]?\p{Ll}/u.test(t); }

  function isPageNumberText(t) {
    var s = t.replace(/[\u2013\u2014\-]/g, ' ').trim();
    return /^(page\s*)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|\/)\s*\d{1,4})?$/i.test(s);
  }

  function boilerKey(t) {
    return collapse(t).toLowerCase().replace(/\d+/g, '#').replace(/\b[ivxlcdm]{1,7}\b/g, '#').replace(/\s+/g, ' ');
  }

  // Group positioned items into lines by baseline.
  function groupRows(items) {
    var sorted = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    var rows = [];
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i], target = null;
      for (var k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
        var r = rows[k];
        if (Math.abs(r.y - it.y) <= 0.5 * Math.max(r.size, it.size)) { target = r; break; }
      }
      if (!target) { target = { y: it.y, size: it.size, items: [] }; rows.push(target); }
      target.items.push(it);
      if (it.size > target.size && it.str.trim()) { target.size = it.size; target.y = it.y; }
    }
    return rows;
  }

  function buildLine(items) {
    items = items.slice().sort(function (a, b) { return a.x - b.x; });
    var weights = new Map();
    items.forEach(function (it) {
      var k = Math.round(it.size * 2) / 2;
      weights.set(k, (weights.get(k) || 0) + it.str.trim().length);
    });
    var size = 0, best = -1;
    weights.forEach(function (w, k) { if (w > best || (w === best && k > size)) { best = w; size = k; } });
    var mainYs = items.filter(function (it) { return Math.abs(it.size - size) < 0.6; }).map(function (it) { return it.y; });
    var baseline = mainYs.length ? median(mainYs) : items[0].y;
    var runs = [], text = '', prevEnd = -Infinity, prev = null;
    var boldChars = 0, italicChars = 0, monoChars = 0, total = 0, x0 = null, x1 = -Infinity;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (prev && it.str === prev.str && Math.abs(it.x - prev.x) < 0.3 * size && Math.abs(it.y - prev.y) < 1) continue;
      var s = it.str;
      if (prev) {
        var gap = it.x - prevEnd;
        if (gap > 0.15 * size && !/\s$/.test(text) && !/^\s/.test(s)) s = ' ' + s;
      }
      var small = it.size < 0.85 * size;
      var sup = small && baseline - it.y > 0.2 * size;
      var sub = small && !sup && it.y - baseline > 0.1 * size;
      runs.push({ t: s, b: it.bold, i: it.italic, sup: sup, sub: sub });
      text += s;
      var n = it.str.replace(/\s/g, '').length;
      if (n) {
        total += n;
        if (it.bold) boldChars += n;
        if (it.italic) italicChars += n;
        if (it.mono) monoChars += n;
        if (x0 === null) x0 = it.x;
        x1 = Math.max(x1, it.x + it.w);
      }
      prevEnd = Math.max(prevEnd, it.x + it.w);
      prev = it;
    }
    return {
      runs: runs, text: collapse(text), size: size, y: baseline,
      x0: x0 === null ? items[0].x : x0, x1: x1 === -Infinity ? items[0].x : x1,
      bold: total > 0 && boldChars / total > 0.8,
      italic: total > 0 && italicChars / total > 0.8,
      mono: total > 0 && monoChars / total > 0.8,
      chars: total
    };
  }

  // Split a page's items into reading-order flows (columns), recursively.
  function orderFlows(items, depth) {
    var content = items.filter(function (it) { return it.str.trim(); });
    if (depth > 2 || content.length < 8) return [items];
    var rows = groupRows(content);
    if (rows.length < 6) return [items];
    var minX = Infinity, maxX = -Infinity;
    content.forEach(function (it) { minX = Math.min(minX, it.x); maxX = Math.max(maxX, it.x + it.w); });
    var span = maxX - minX;
    if (span < 120) return [items];
    var nb = Math.ceil(span) + 1;
    var cov = new Int32Array(nb);
    rows.forEach(function (r) {
      var mark = new Uint8Array(nb);
      r.items.forEach(function (it) {
        var a = Math.max(0, Math.floor(it.x - minX)), b = Math.min(nb, Math.ceil(it.x + it.w - minX));
        for (var k = a; k < b; k++) mark[k] = 1;
      });
      for (var k = 0; k < nb; k++) cov[k] += mark[k];
    });
    var limit = Math.max(1, Math.floor(rows.length * 0.12));
    var lo = Math.floor(span * 0.2), hi = Math.ceil(span * 0.8);
    var bestStart = -1, bestLen = 0, runStart = -1;
    for (var k = lo; k <= hi; k++) {
      if (k < hi && cov[k] <= limit) { if (runStart < 0) runStart = k; }
      else if (runStart >= 0) {
        if (k - runStart > bestLen) { bestLen = k - runStart; bestStart = runStart; }
        runStart = -1;
      }
    }
    // A gutter must be clearly wider than the gaps between words, or justified
    // lines that happen to line up would look like columns.
    // Gaps that overlap the candidate gutter are the gutter itself, not word gaps.
    var gs = minX + bestStart, ge = gs + bestLen;
    var wordGaps = [];
    rows.forEach(function (r) {
      var its = r.items.slice().sort(function (p, q) { return p.x - q.x; });
      for (var k = 1; k < its.length; k++) {
        var end = its[k - 1].x + its[k - 1].w;
        var gap = its[k].x - end;
        if (end < ge && its[k].x > gs) continue;
        if (gap > 0.1 * its[k].size && gap < 3 * its[k].size) wordGaps.push(gap);
      }
    });
    if (bestLen < Math.max(6, 1.6 * median(wordGaps))) return [items];
    var gc = minX + bestStart + bestLen / 2;

    var allRows = groupRows(items);
    var marked = allRows.map(function (r) {
      var spans = r.items.some(function (it) { return it.str.trim() && it.x < gc - 1 && it.x + it.w > gc + 1; });
      return { y: r.y, items: r.items, spans: spans };
    });
    var leftChars = 0, rightChars = 0, leftW = [], rightW = [], rightX0 = [];
    marked.forEach(function (r) {
      if (r.spans) return;
      var L = r.items.filter(function (it) { return it.x + it.w / 2 < gc; });
      var R = r.items.filter(function (it) { return it.x + it.w / 2 >= gc; });
      var lc = L.reduce(function (s, it) { return s + it.str.trim().length; }, 0);
      var rc = R.reduce(function (s, it) { return s + it.str.trim().length; }, 0);
      leftChars += lc; rightChars += rc;
      if (lc) leftW.push(Math.max.apply(null, L.map(function (it) { return it.x + it.w; })) - Math.min.apply(null, L.map(function (it) { return it.x; })));
      if (rc) {
        var rx0 = Math.min.apply(null, R.filter(function (it) { return it.str.trim(); }).map(function (it) { return it.x; }));
        rightW.push(Math.max.apply(null, R.map(function (it) { return it.x + it.w; })) - rx0);
        rightX0.push(rx0);
      }
      r.L = L; r.R = R;
    });
    var totalChars = leftChars + rightChars;
    if (!totalChars || leftChars < totalChars * 0.2 || rightChars < totalChars * 0.2) return [items];
    if (leftW.length < 3 || rightW.length < 3) return [items];
    if (median(leftW) < span * 0.25 || median(rightW) < span * 0.25) return [items];
    // A real column has a shared left edge. A gap that only lines up by chance
    // between words of justified text does not.
    var edge = median(rightX0);
    var onEdge = rightX0.filter(function (x) { return Math.abs(x - edge) <= 3; }).length;
    if (onEdge < rightX0.length * 0.6) return [items];

    var flows = [];
    var curL = [], curR = [], curSpan = [];
    var flushCols = function () {
      if (curL.length) flows.push.apply(flows, orderFlows(curL, depth + 1));
      if (curR.length) flows.push.apply(flows, orderFlows(curR, depth + 1));
      curL = []; curR = [];
    };
    var flushSpan = function () { if (curSpan.length) flows.push(curSpan); curSpan = []; };
    marked.forEach(function (r) {
      if (r.spans) { flushCols(); curSpan = curSpan.concat(r.items); }
      else { flushSpan(); curL = curL.concat(r.L); curR = curR.concat(r.R); }
    });
    flushCols();
    flushSpan();
    return flows;
  }

  function cleanPdfTitle(t) {
    t = collapse(t);
    if (!t) return null;
    t = t.replace(/^microsoft (word|powerpoint|excel)\s*-\s*/i, '').replace(/\.(docx?|pdf|pptx?|xlsx?|odt|rtf|txt)$/i, '');
    if (/^(untitled|document\d*|title|slide \d+|doc\d*)$/i.test(t)) return null;
    return t || null;
  }

  async function importPdf(u8, info) {
    var pdfjs = await loadPdfjs();
    var prog = info.prog || function () {};
    var pdf;
    try {
      pdf = await pdfjs.getDocument({
        data: u8,
        password: info.password || undefined,
        cMapUrl: extUrl('lib/pdfjs/cmaps/'),
        cMapPacked: true,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        enableXfa: false
      }).promise;
    } catch (e) {
      if (e && (e.name === 'PasswordException' || /password/i.test(e.message || ''))) {
        throw fail('PASSWORD', 'This PDF is protected with a password. Polycarp cannot open password-protected PDFs. Save an unlocked copy and open that.');
      }
      if (e && (e.name === 'InvalidPDFException' || e.name === 'MissingPDFException')) {
        throw fail('UNSUPPORTED', 'This PDF is damaged, so Polycarp cannot open it.');
      }
      throw e;
    }
    try {
      return await readPdf(pdf, pdfjs, info, prog);
    } finally {
      try { pdf.destroy(); } catch (e) { /* already gone */ }
    }
  }

  async function readPdf(pdf, pdfjs, info, prog) {
    var n = pdf.numPages;
    var pages = [];
    var fontCache = new Map();
    var chars = 0;
    var NO_TEXT_MSG = 'This PDF is a scan: its pages are pictures of text with no text layer, so there is nothing for Polycarp to read. Run it through text recognition (OCR) (for example in Adobe Acrobat, Preview on a Mac, or Google Drive) and open the result.';
    for (var p = 1; p <= n; p++) {
      var page = await pdf.getPage(p);
      var vp = page.getViewport({ scale: 1 });
      var tc = await page.getTextContent();
      var needFonts = tc.items.some(function (it) { return it.fontName && !fontCache.has(it.fontName); });
      if (needFonts) { try { await page.getOperatorList(); } catch (e) { /* fonts are a hint only */ } }
      var items = [];
      for (var i = 0; i < tc.items.length; i++) {
        var it = tc.items[i];
        if (typeof it.str !== 'string' || !it.str) continue;
        var tx = pdfjs.Util.transform(vp.transform, it.transform);
        var size = Math.hypot(tx[2], tx[3]);
        if (!size || size < 1) continue;
        if (Math.abs(tx[1]) > 0.1 * size || Math.abs(tx[2]) > 0.1 * size) continue;
        var f = fontCache.get(it.fontName);
        if (!f) {
          f = { bold: false, italic: false, mono: false };
          var fname = '';
          try {
            if (page.commonObjs.has(it.fontName)) {
              var fo = page.commonObjs.get(it.fontName);
              fname = fo.name || '';
              f.bold = !!(fo.bold || fo.black);
              f.italic = !!fo.italic;
            }
          } catch (e) { /* font object not ready */ }
          var fam = (tc.styles[it.fontName] && tc.styles[it.fontName].fontFamily) || '';
          if (/bold|black|heavy|semibold|demi/i.test(fname)) f.bold = true;
          if (/italic|oblique/i.test(fname)) f.italic = true;
          f.mono = /mono|courier|consol/i.test(fname) || fam === 'monospace';
          if (fname || page.commonObjs.has(it.fontName)) fontCache.set(it.fontName, f);
        }
        items.push({ str: it.str, x: tx[4], y: tx[5], w: Math.abs(it.width) || it.str.length * size * 0.5, size: size, bold: f.bold, italic: f.italic, mono: f.mono });
        chars += it.str.replace(/\s/g, '').length;
      }
      pages.push({ num: p, w: vp.width, h: vp.height, items: items, vp: vp });
      try { page.cleanup(); } catch (e) { /* ignore */ }
      prog(0.85 * p / n);
      if ((p === Math.min(n, 5) && n <= 5 && chars < 20) || (p === Math.min(n, 12) && chars < 20)) throw fail('NO_TEXT', NO_TEXT_MSG);
    }
    if (chars < 20) throw fail('NO_TEXT', NO_TEXT_MSG);

    // Body size: character-weighted median of item sizes.
    var sizeChars = [];
    pages.forEach(function (pg) {
      pg.items.forEach(function (it) {
        var c = it.str.trim().length;
        if (c) sizeChars.push([Math.round(it.size * 2) / 2, c]);
      });
    });
    sizeChars.sort(function (a, b) { return a[0] - b[0]; });
    var half = sizeChars.reduce(function (s, x) { return s + x[1]; }, 0) / 2, acc = 0, bodySize = 10;
    for (var s = 0; s < sizeChars.length; s++) { acc += sizeChars[s][1]; if (acc >= half) { bodySize = sizeChars[s][0]; break; } }

    // Running headers, footers and page numbers.
    var bandRows = [];
    pages.forEach(function (pg) {
      groupRows(pg.items).forEach(function (r) {
        var inTop = r.y < pg.h * 0.12, inBottom = r.y > pg.h * 0.88;
        if (!inTop && !inBottom) return;
        var text = collapse(r.items.slice().sort(function (a, b) { return a.x - b.x; }).map(function (it) { return it.str; }).join(' '));
        if (!text) return;
        bandRows.push({ page: pg.num, y: r.y, h: pg.h, items: r.items, text: text, key: boilerKey(text) + (inTop ? '|t' : '|b') });
      });
    });
    var byKey = new Map();
    bandRows.forEach(function (r) {
      if (!byKey.has(r.key)) byKey.set(r.key, []);
      byKey.get(r.key).push(r);
    });
    var removed = new Set();
    byKey.forEach(function (rows) {
      var my = median(rows.map(function (r) { return r.y; }));
      var near = rows.filter(function (r) { return Math.abs(r.y - my) <= r.h * 0.02; });
      var pagesHit = new Set(near.map(function (r) { return r.page; }));
      if (n >= 2 && pagesHit.size > n * 0.4 && pagesHit.size >= 2) near.forEach(function (r) { r.items.forEach(function (it) { removed.add(it); }); });
    });
    bandRows.forEach(function (r) { if (isPageNumberText(r.text)) r.items.forEach(function (it) { removed.add(it); }); });

    // Lines per flow per page.
    var allLines = [];
    pages.forEach(function (pg) {
      var items = pg.items.filter(function (it) { return !removed.has(it); });
      if (!items.length) return;
      var flows = orderFlows(items, 0);
      flows.forEach(function (flowItems, fi) {
        var lines = groupRows(flowItems).map(function (r) { return buildLine(r.items); }).filter(function (l) { return l.text; });
        lines.sort(function (a, b) { return a.y - b.y; });
        if (!lines.length) return;
        var body = lines.filter(function (l) { return l.text.length > 15; });
        var ref = body.length ? body : lines;
        var flow = {
          left: percentile(ref.map(function (l) { return l.x0; }), 0.1),
          right: percentile(ref.map(function (l) { return l.x1; }), 0.9)
        };
        if (flow.right - flow.left < 20) flow.right = flow.left + 20;
        lines.forEach(function (l, li) {
          l.page = pg.num; l.flow = flow; l.flowStart = li === 0; l.flowIndex = fi;
          allLines.push(l);
        });
      });
    });

    // Line spacing between consecutive body lines.
    var gaps = [];
    for (var g = 1; g < allLines.length; g++) {
      var a = allLines[g - 1], b = allLines[g];
      if (b.flowStart || a.page !== b.page) continue;
      if (Math.abs(a.size - bodySize) > 0.15 * bodySize || Math.abs(b.size - bodySize) > 0.15 * bodySize) continue;
      var dy = b.y - a.y;
      if (dy > 0.5 * bodySize && dy < 3 * bodySize) gaps.push(dy);
    }
    var spacing = gaps.length ? percentile(gaps, 0.4) : bodySize * 1.2;

    // Words written with a hyphen inside a line, for hyphen joins.
    var compounds = new Set();
    allLines.forEach(function (l) {
      var re = /(\p{L}+)-(\p{L}+)/gu, m;
      while ((m = re.exec(l.text))) compounds.add((m[1] + '-' + m[2]).toLowerCase());
    });

    var bodyBold = false;
    (function () {
      var bc = 0, tc2 = 0;
      allLines.forEach(function (l) { if (Math.abs(l.size - bodySize) < 0.6) { tc2 += l.chars; if (l.bold) bc += l.chars; } });
      bodyBold = tc2 > 0 && bc / tc2 > 0.6;
    })();

    allLines.forEach(function (l) {
      l.heading = l.size >= 1.2 * bodySize && /\p{L}/u.test(l.text) && l.text.length < 160;
      l.bullet = !l.heading && (BULLET_RE.test(l.text) && l.text.replace(BULLET_RE, '').length > 0 && !/^[\-\*\u2013]\S/.test(l.text) || ORDERED_RE.test(l.text) && /^\(?\d/.test(l.text));
    });

    // Does this document mark paragraphs with a first-line indent?
    var indentStyle = (function () {
      var bodyLines = 0, indents = 0;
      // A first-line indent: the line before and the line after sit on the
      // margin, and the line after follows at normal line spacing.
      for (var k = 1; k < allLines.length - 1; k++) {
        var l = allLines[k], pl = allLines[k - 1], nl = allLines[k + 1];
        if (l.flowStart || l.heading || Math.abs(l.size - bodySize) > 0.15 * bodySize) continue;
        bodyLines++;
        if (nl.flowStart || nl.flow !== l.flow || BULLET_RE.test(l.text) || ORDERED_RE.test(l.text)) continue;
        var ind = l.x0 - l.flow.left;
        if (ind > 0.6 * l.size && ind < 5 * l.size && pl.x0 - pl.flow.left < 0.3 * l.size &&
            nl.x0 - nl.flow.left < 0.3 * l.size && nl.y - l.y < spacing * 1.3) indents++;
      }
      return indents >= 3 && indents >= bodyLines * 0.04;
    })();

    // Is body text justified (most lines end on the right margin)?
    var justified = (function () {
      var n2 = 0, onRight = 0;
      allLines.forEach(function (l) {
        if (l.heading || Math.abs(l.size - bodySize) > 0.15 * bodySize) return;
        n2++;
        if (l.x1 >= l.flow.right - 0.01 * (l.flow.right - l.flow.left)) onRight++;
      });
      return n2 >= 4 && onRight >= n2 * 0.5;
    })();

    // Assemble paragraphs in reading order.
    var blocks = [];
    var para = null;
    var lastPage = 0;

    function trimRunsEnd(runs) {
      while (runs.length) {
        var r = runs[runs.length - 1];
        r.t = r.t.replace(/\s+$/, '');
        if (r.t) return r;
        runs.pop();
      }
      return null;
    }

    function appendLine(P, L) {
      var runs = L.runs.map(function (r) { return { t: r.t, b: r.b, i: r.i, sup: r.sup, sub: r.sub }; });
      if (runs.length) runs[0].t = runs[0].t.replace(/^\s+/, '');
      if (!P.runs.length) { P.runs = runs; P.text = L.text; P.lines.push(L); return; }
      var last = trimRunsEnd(P.runs);
      var m = /(\p{L}+)([\-\u00AD\u2010])$/u.exec(P.text);
      var nm = /^(\p{L}+)/u.exec(L.text);
      var glue = ' ';
      if (m && nm && last) {
        glue = '';
        var soft = m[2] === '\u00AD';
        var keep = !soft && (/^\p{Lu}/u.test(nm[1]) || compounds.has((m[1] + '-' + nm[1]).toLowerCase()));
        if (!keep) last.t = last.t.slice(0, -1);
        P.text = P.text.slice(0, keep ? P.text.length : -1);
      } else if (last) {
        last.t += ' ';
      }
      P.runs = P.runs.concat(runs);
      P.text = P.text + glue + L.text;
      P.lines.push(L);
    }

    function newBlock(L, type) {
      return { type: type, runs: [], text: '', lines: [], page: L.page, y: L.y, size: L.size, x0: L.x0, ordered: false };
    }

    function breaksBetween(P, L) {
      var prev = P.lines[P.lines.length - 1];
      if (L.heading !== prev.heading) return true;
      var dy = L.y - prev.y;
      if (L.heading) return Math.abs(L.size - prev.size) > 0.1 * prev.size || dy > 1.8 * L.size;
      if (Math.abs(L.size - prev.size) > 0.15 * Math.max(L.size, prev.size)) return true;
      var expected = spacing * (L.size / bodySize);
      if (dy > expected * 1.4 || dy < -0.5 * L.size) return true;
      if (L.bullet) return true;
      var width = L.flow.right - L.flow.left;
      var shortPrev = prev.x1 < L.flow.right - Math.max(0.15 * width, 2 * L.size);
      if (P.type === 'li') {
        if (L.x0 > P.x0 + 0.3 * L.size) return false;
        return shortPrev && !startsLower(L.text);
      }
      if (L.mono !== prev.mono) return true;
      if (L.x0 - prev.x0 > 0.6 * L.size && L.x0 - L.flow.left < 0.3 * width) return true;
      if (shortPrev && !startsLower(L.text) && (SENTENCE_END_RE.test(prev.text) || prev.x1 < L.flow.right - 0.35 * width)) return true;
      if (prev.bold !== L.bold && !bodyBold && (prev.text.length < 90 && prev.bold)) return true;
      return false;
    }

    // At the top of a new column or page, decide whether the paragraph goes on.
    function continuesAcrossFlow(P, L) {
      if (!P || P.type !== 'p' || L.heading || L.bullet) return false;
      var prev = P.lines[P.lines.length - 1];
      if (Math.abs(L.size - prev.size) > 0.15 * Math.max(L.size, prev.size)) return false;
      if (L.mono !== prev.mono) return false;
      if (/\p{L}[\-\u00AD]$/u.test(P.text)) return true;
      var ends = SENTENCE_END_RE.test(P.text);
      var indented = L.x0 - L.flow.left > 0.6 * L.size;
      if (!ends && startsLower(L.text)) return true;
      // In a document that marks paragraphs by indent, an unindented line
      // carries on the paragraph even after a full stop.
      if (indentStyle) return !indented;
      // In ragged-right text a line that reaches the margin proves nothing, so
      // after a full stop only justified text counts as carrying on.
      if (ends && !justified) return false;
      var pw = prev.flow.right - prev.flow.left;
      var full = prev.x1 >= prev.flow.right - (ends ? 0.02 : 0.1) * pw;
      return full && !indented;
    }

    for (var li = 0; li < allLines.length; li++) {
      var L = allLines[li];
      if (L.page !== lastPage) {
        for (var pn = lastPage + 1; pn <= L.page; pn++) blocks.push({ type: 'pagemark', page: pn, y: -Infinity });
        lastPage = L.page;
        var lastText = null;
        for (var q = blocks.length - 1; q >= 0; q--) if (blocks[q].type !== 'pagemark') { lastText = blocks[q]; break; }
        if (para && continuesAcrossFlow(para, L) && lastText === para) { appendLine(para, L); continue; }
        para = null;
      } else if (L.flowStart && para) {
        if (continuesAcrossFlow(para, L)) { appendLine(para, L); continue; }
        para = null;
      }
      if (para && !breaksBetween(para, L)) { appendLine(para, L); continue; }
      var type = L.heading ? 'h' : (L.bullet ? 'li' : 'p');
      para = newBlock(L, type);
      if (type === 'li') para.ordered = ORDERED_RE.test(L.text) && /^\(?\d/.test(L.text);
      appendLine(para, L);
      blocks.push(para);
    }
    for (var pn2 = lastPage + 1; pn2 <= n; pn2++) blocks.push({ type: 'pagemark', page: pn2, y: -Infinity });

    // Bold standalone short lines become headings.
    blocks.forEach(function (b) {
      if (b.type !== 'p' || bodyBold) return;
      if (b.lines.length > 2 || b.text.length > 90 || b.text.length < 2) return;
      if (!b.lines.every(function (l) { return l.bold; })) return;
      if (/[.,;]$/.test(b.text) || !/\p{L}/u.test(b.text)) return;
      b.type = 'h';
      b.boldHead = true;
    });

    // Heading levels by size rank.
    var headSizes = Array.from(new Set(blocks.filter(function (b) { return b.type === 'h' && !b.boldHead; })
      .map(function (b) { return Math.round(b.size * 2) / 2; }))).sort(function (a, b) { return b - a; });
    blocks.forEach(function (b) {
      if (b.type !== 'h') return;
      b.level = b.boldHead ? Math.min(4, headSizes.length + 2) : Math.min(4, 2 + headSizes.indexOf(Math.round(b.size * 2) / 2));
    });

    // Metadata.
    var meta = null;
    try { meta = await pdf.getMetadata(); } catch (e) { meta = null; }
    var title = null, author = null;
    if (meta) {
      var md = meta.metadata;
      title = cleanPdfTitle((md && md.get && md.get('dc:title')) || (meta.info && meta.info.Title) || '');
      author = collapse((md && md.get && md.get('dc:creator')) || (meta.info && meta.info.Author) || '') || null;
      if (Array.isArray(author)) author = author.join(', ');
    }
    if (!title) {
      var firstBig = blocks.find(function (b) { return b.type === 'h' && b.page === 1 && b.size >= 1.4 * bodySize; });
      title = firstBig ? collapse(firstBig.text) : titleFromName(info.name);
    }

    // Sections: PDF outline when present, else 15-page chunks.
    var starts = await outlineStarts(pdf, pages);
    var sections = [];
    if (starts && starts.length >= 2) {
      var bounds = [];
      var from = 0;
      starts.forEach(function (st) {
        var tk = normKey(st.title);
        var idx = -1;
        for (var k2 = from; k2 < blocks.length; k2++) {
          var bk = blocks[k2];
          if (bk.page > st.page) break;
          if (bk.page === st.page && bk.type !== 'pagemark' && tk) {
            var bkKey = normKey(bk.text);
            if (bkKey && (bkKey === tk || (bkKey.indexOf(tk) === 0 && bk.type === 'h') || (bk.type === 'h' && tk.indexOf(bkKey) === 0 && bkKey.length > 3))) { idx = k2; break; }
          }
        }
        if (idx < 0) {
          for (var k3 = from; k3 < blocks.length; k3++) {
            var bb = blocks[k3];
            if (bb.page > st.page || (bb.page === st.page && bb.type !== 'pagemark' && bb.y >= st.y - 2)) { idx = k3; break; }
          }
        }
        if (idx < 0) idx = blocks.length;
        // A section that starts at the top of a page takes that page's marker.
        while (idx > from && blocks[idx - 1].type === 'pagemark' && blocks[idx - 1].page === (blocks[idx] ? blocks[idx].page : -1)) idx--;
        bounds.push(idx);
        from = idx;
      });
      var preBlocks = blocks.slice(0, bounds[0]);
      var preText = preBlocks.reduce(function (s2, b) { return s2 + (b.text || '').length; }, 0);
      starts.forEach(function (st, k4) {
        var part = blocks.slice(bounds[k4], k4 + 1 < bounds.length ? bounds[k4 + 1] : blocks.length);
        if (k4 === 0 && preText < 200) part = preBlocks.concat(part);
        sections.push({ title: st.title || ('Part ' + (k4 + 1)), html: renderBlocks(part) });
      });
      if (preText >= 200) sections.unshift({ title: title, html: renderBlocks(preBlocks) });
    } else {
      for (var c0 = 1; c0 <= n; c0 += 15) {
        var c1 = Math.min(n, c0 + 14);
        var part2 = blocks.filter(function (b) { return b.page >= c0 && b.page <= c1; });
        sections.push({ title: c0 === c1 ? 'Page ' + c0 : 'Pages ' + c0 + ' to ' + c1, html: renderBlocks(part2) });
      }
    }
    prog(1);
    return makeDoc(title, author, { kind: 'pdf', name: info.name, url: info.url || null, pages: n }, sections);
  }

  async function outlineStarts(pdf, pages) {
    var outline;
    try { outline = await pdf.getOutline(); } catch (e) { return null; }
    if (!outline || !outline.length) return null;
    var top = outline;
    if (top.length === 1 && top[0].items && top[0].items.length > 1) top = top[0].items;
    var starts = [];
    for (var i = 0; i < top.length; i++) {
      var it = top[i];
      try {
        var dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (!Array.isArray(dest) || !dest.length) continue;
        var ref = dest[0];
        var idx = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
        var pg = pages[idx];
        if (!pg) continue;
        var y = -Infinity;
        var mode = dest[1] && dest[1].name;
        var topY = mode === 'XYZ' ? dest[3] : (mode === 'FitH' || mode === 'FitBH') ? dest[2] : null;
        if (typeof topY === 'number') y = pg.vp.convertToViewportPoint(0, topY)[1];
        starts.push({ title: collapse(it.title), page: idx + 1, y: y });
      } catch (e) { /* unresolved destination */ }
    }
    starts.sort(function (a, b) { return a.page - b.page || a.y - b.y; });
    return starts;
  }

  function runsToHtml(runs) {
    var allBold = runs.every(function (r) { return !r.t.trim() || r.b; });
    var allItalic = runs.every(function (r) { return !r.t.trim() || r.i; });
    var merged = [];
    runs.forEach(function (r) {
      var b = r.b && !allBold, it = r.i && !allItalic;
      var last = merged[merged.length - 1];
      if (last && last.b === b && last.i === it && last.sup === r.sup && last.sub === r.sub) last.t += r.t;
      else merged.push({ t: r.t, b: b, i: it, sup: r.sup, sub: r.sub });
    });
    return merged.map(function (r) {
      var t = r.t.replace(/\s+/g, ' ');
      if (!t.trim()) return t ? ' ' : '';
      var lead = /^\s/.test(t) ? ' ' : '', trail = /\s$/.test(t) ? ' ' : '';
      var h = esc(t.trim());
      if (r.sup) h = '<sup>' + h + '</sup>';
      else if (r.sub) h = '<sub>' + h + '</sub>';
      if (r.i) h = '<em>' + h + '</em>';
      if (r.b) h = '<strong>' + h + '</strong>';
      return lead + h + trail;
    }).join('').trim();
  }

  function renderBlocks(blocks) {
    var out = '';
    var list = null;
    blocks.forEach(function (b) {
      if (b.type !== 'li' && list) { out += '</' + list + '>'; list = null; }
      if (b.type === 'pagemark') { out += '<div class="ph-pagemark" data-page="' + b.page + '"></div>'; return; }
      if (b.type === 'h') { out += '<h' + b.level + '>' + esc(collapse(b.text)) + '</h' + b.level + '>'; return; }
      if (b.type === 'li') {
        var tag = b.ordered ? 'ol' : 'ul';
        if (list !== tag) { if (list) out += '</' + list + '>'; out += '<' + tag + '>'; list = tag; }
        var runs = b.runs.slice();
        if (runs.length) {
          var re = b.ordered ? ORDERED_RE : BULLET_RE;
          var joined = '';
          // Strip the marker, which may span several runs.
          while (runs.length && !re.test(joined + runs[0].t) && (joined + runs[0].t).length < 6) { joined += runs.shift().t; }
          if (runs.length) runs[0] = Object.assign({}, runs[0], { t: (joined + runs[0].t).replace(re, '') });
        }
        out += '<li>' + runsToHtml(runs) + '</li>';
        return;
      }
      out += '<p>' + runsToHtml(b.runs) + '</p>';
    });
    if (list) out += '</' + list + '>';
    return out;
  }

  globalThis.PolycarpImport = {
    fromFile: fromFile,
    fromUrl: fromUrl,
    fromHtml: fromHtml,
    fromText: fromText,
    sanitize: sanitize
  };
})();
