/* The person's Polycarp theme on the extension's own pages. Loaded in <head> right after theme.css, so the rules kept from
   the last page are in place before anything is painted. Once core.js is there, the theme in storage is read, the app
   is asked for its own (core.js, askTheme), and what changed is drawn and kept. <script data-ask="page"> is for the new
   tab, whose own first request to the app brings the theme. */
(function () {
  "use strict";
  const KEPT = "polycarp.theme.css"; // localStorage, shared by the extension's pages and nobody else
  const AGAIN = 2000; // the app is asked at most this often as pages are switched between
  const me = document.currentScript;
  let style = null;

  function draw(rules) {
    if (!rules) { if (style) style.remove(); style = null; return; }
    if (!style) {
      style = document.createElement("style");
      style.id = "polycarp-theme";
      me.after(style);
    }
    style.textContent = rules;
  }
  // core.js wrote these from checked values and writes them again below; anything else that got in here is not drawn.
  function kept() {
    let rules = "";
    try { rules = localStorage.getItem(KEPT) || ""; } catch (e) { /* no storage: the theme comes a moment later */ }
    return /^:root \{/.test(rules) && !/[<\\]|url\(|@import|image\(/i.test(rules) ? rules : "";
  }
  draw(kept());

  function start() {
    const P = globalThis.Polycarp;
    if (!P || !P.watchTheme) return;
    P.watchTheme((_css, live) => {
      draw(live);
      try { if (live) localStorage.setItem(KEPT, live); else localStorage.removeItem(KEPT); } catch (e) { /* asked again next time */ }
    });
    let asked = 0;
    const ask = () => {
      const now = Date.now();
      if (document.visibilityState === "hidden" || now - asked < AGAIN) return;
      asked = now;
      P.askTheme().catch(() => {});
    };
    if (me.dataset.ask === "page") asked = Date.now(); else ask();
    document.addEventListener("visibilitychange", ask);
    addEventListener("focus", ask);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
