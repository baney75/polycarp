/* Polycarp Hub safe HTML: how an HTML message is shown. Two walls, so either alone still holds:
   1. DOMPurify (lib/purify.min.js, pinned) keeps only inert markup. Forms, frames, embeds, SVG and MathML go, along
      with every script and event handler, and links only to http, https and mailto stay. Pictures and CSS that would
      load from the web are dropped and counted: remote content is off, so no tracking pixel ever loads.
   2. The result is shown in an <iframe sandbox> with no scripts and no same origin, under a CSP of default-src 'none'
      that allows only inline styles and data: pictures, so even markup that slipped past step 1 can neither run nor
      load anything.
   Every link says where it goes: its full address is its tooltip, and when a link's text names one site but the link
   goes to another, `clean` lists the pair, so the page can warn outside the frame where the mail's own CSS can't
   hide it. Links open in a new tab, outside the sandbox. */
(function () {
  "use strict";

  const LINKS = /^(?:https?:|mailto:)/i;
  const REMOTE_CSS = /url\s*\(|@import|image-set\s*\(|expression\s*\(|-moz-binding|behavior\s*:/i;
  const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
  const CONFIG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "input", "button", "select", "textarea", "option", "iframe", "frame", "frameset", "object", "embed",
      "applet", "base", "link", "meta", "audio", "video", "source", "track", "picture", "portal", "template", "dialog", "noscript"],
    FORBID_ATTR: ["srcset", "background", "poster", "action", "formaction", "ping", "lowsrc", "dynsrc", "xlink:href", "usemap"],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    FORCE_BODY: true,
    RETURN_TRUSTED_TYPE: false
  };

  // A host as the browser would go to it: lower case, in punycode, without "www." or a final dot.
  const hostOf = (s) => { try { return new URL(s).hostname.replace(/^www\./, "").replace(/\.$/, ""); } catch (e) { return ""; } };
  // Invisible characters a sender can put inside a name to break a match: zero-width, joiners, bidi marks, fillers.
  const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/gu;
  // Names that end like a file, not a site, so "report.pdf" in a link's text is not a site it names.
  const FILES = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "jpg", "jpeg", "png", "gif", "htm", "html"]);
  // Every site a link's text names, anywhere in it and in any script ("Log in at paypal.com now", "p\u0430ypal.com."),
  // in the same form as hostOf, so a look-alike spelled in another alphabet compares as the different site it is.
  function namedHosts(text) {
    // Wide and styled letters need nothing here (hostOf maps them as the browser does), but dots other than "." do,
    // or "paypal\u3002com" would not read as a name at all.
    const s = String(text || "").replace(INVISIBLE, "").replace(/[\u3002\uff0e\uff61]/g, ".");
    const out = new Set();
    for (const m of s.matchAll(/(?:[\p{L}\p{N}\p{M}-]+\.)+[\p{L}\p{M}]{2,}/gu)) {
      if (FILES.has(m[0].split(".").pop().toLowerCase())) continue;
      const h = hostOf("http://" + m[0]);
      if (h) out.add(h);
    }
    return Array.from(out);
  }

  // Sanitizes `html` and answers { html, blocked, links, misleading } where `blocked` counts pictures and styles from
  // the web that were left out, `links` lists each kept link's address and `misleading` lists {named, real} for each
  // link whose text names a site it doesn't go to.
  function clean(html) {
    const P = globalThis.DOMPurify;
    if (!P || !P.isSupported) throw new Error("the HTML cleaner is missing");
    let blocked = 0;
    const links = [];
    const purify = P(globalThis);
    purify.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "style" && REMOTE_CSS.test(node.textContent || "")) {
        const css = (node.textContent || "").replace(/@import[^;]*;?/gi, "").replace(/url\s*\([^)]*\)/gi, "none");
        node.textContent = REMOTE_CSS.test(css) ? "" : css;
        blocked++;
      }
    });
    purify.addHook("afterSanitizeAttributes", (node) => {
      if (node.hasAttribute && node.hasAttribute("style") && REMOTE_CSS.test(node.getAttribute("style"))) {
        const css = node.getAttribute("style").replace(/url\s*\([^)]*\)/gi, "none");
        if (REMOTE_CSS.test(css)) node.removeAttribute("style"); else node.setAttribute("style", css);
        blocked++;
      }
      if (node.tagName === "IMG") {
        const src = node.getAttribute("src") || "";
        if (!/^data:image\/(?:png|gif|jpe?g|webp);/i.test(src)) {
          if (src) blocked++;
          node.removeAttribute("src");
          node.setAttribute("alt", node.getAttribute("alt") || "");
        }
      }
      if (node.tagName === "A") {
        const href = (node.getAttribute("href") || "").trim();
        if (!LINKS.test(href)) { node.removeAttribute("href"); return; }
        node.setAttribute("href", href);
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
        node.setAttribute("referrerpolicy", "no-referrer");
        node.setAttribute("title", href);
        links.push(href);
      }
    });
    const out = purify.sanitize(String(html || ""), CONFIG);
    // A second pass finds links whose text names a different site than they go to. The note in the frame is only an
    // extra, since the mail's CSS can hide it; `misleading` is what the page shows.
    const doc = new DOMParser().parseFromString("<body>" + out + "</body>", "text/html");
    const misleading = [];
    for (const a of doc.querySelectorAll("a[href]")) {
      const real = hostOf(a.getAttribute("href"));
      if (!real) continue;
      const named = namedHosts(a.textContent).find((n) => n !== real && !real.endsWith("." + n));
      if (!named) continue;
      if (!misleading.some((x) => x.named === named && x.real === real)) misleading.push({ named, real });
      const s = doc.createElement("span");
      s.className = "pc-real";
      s.textContent = " (goes to " + real + ")";
      a.after(s);
    }
    return { html: doc.body.innerHTML, blocked, links, misleading };
  }

  // The whole document for the sandboxed frame. Mail is drawn on its own light paper, as most HTML mail expects.
  function frameDoc(clean) {
    return "<!doctype html><html><head><meta charset=\"utf-8\">" +
      "<meta http-equiv=\"Content-Security-Policy\" content=\"" + CSP + "\">" +
      "<style>html{color-scheme:light}body{margin:16px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1d1d1b;background:#fff;overflow-wrap:anywhere}" +
      "img{max-width:100%;height:auto}table{max-width:100%}.pc-real{color:#8a3b12;font-weight:600}</style></head><body>" +
      clean + "</body></html>";
  }

  // An iframe showing `html` behind both walls.
  function frame(html, title) {
    const c = clean(html);
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("csp", CSP);
    f.setAttribute("loading", "lazy");
    f.title = title || "Message";
    f.srcdoc = frameDoc(c.html);
    return { frame: f, blocked: c.blocked, links: c.links, misleading: c.misleading };
  }

  globalThis.PolycarpHubSafeHtml = { CSP, CONFIG, clean, frameDoc, frame, namedHosts };
})();
