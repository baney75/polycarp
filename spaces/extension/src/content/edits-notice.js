/* The first time an edit from the Polycarp app changes a page, this says so, with a way to take it back: an agent's change
   to a page is never silent. It stays until answered, and comes again when the agent changes the edit. */
(function () {
  "use strict";
  const P = globalThis.Polycarp, S = globalThis.PolycarpEditsStore, E = globalThis.PolycarpEdits;
  if (!P || !P.pageEdits || P.pageEditsNotice || !S) return;
  const CSS = `
    .box{position:fixed;inset-inline-end:16px;bottom:16px;z-index:2147483646;box-sizing:border-box;width:min(340px,calc(100vw - 32px));padding:12px 16px;
      border:var(--pc-border-width) solid var(--pc-border);border-radius:var(--pc-radius);background:var(--pc-surface);color:var(--pc-foreground);
      box-shadow:0 8px 24px color-mix(in srgb,var(--pc-strong) calc(var(--pc-shadow) * 100%),transparent);font:var(--pc-font-weight) 14px/1.5 var(--pc-font-ui);text-align:start}
    p{margin:0} b{display:block;color:var(--pc-strong);font-size:15px}
    ul{margin:4px 0 0;padding-inline-start:16px;max-height:30vh;overflow:auto;overflow-wrap:anywhere}
    .acts{display:flex;gap:8px;margin-top:12px}
    button{min-height:36px;padding:0 16px;border:var(--pc-border-width) solid var(--pc-border);border-radius:var(--pc-radius-small);background:none;color:var(--pc-foreground);font:600 14px/1 var(--pc-font-ui);cursor:pointer}
    button:hover{background:var(--pc-sunken)} button:focus-visible{outline:2px solid var(--pc-strong);outline-offset:2px}
    @media print{.box{display:none}}`;
  let host = null, shown = "", turn = 0;

  function hide() { if (host) host.remove(); host = null; shown = ""; }
  async function show(edits) {
    const mine = ++turn;
    const fresh = edits.length ? await S.unseen(edits) : [];
    if (mine !== turn) return;
    const sig = fresh.map((e) => e.id + E.fingerprint(e)).join(" ");
    if (sig === shown && (!host || host.isConnected)) return;
    hide();
    if (!fresh.length) return;
    shown = sig;
    const theme = await P.themeCss();
    if (mine !== turn) return;
    host = document.createElement("polycarp-edits");
    host.setAttribute("data-polycarp-skip", "");
    host.style.cssText = "all:initial !important;display:contents !important";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = P.shadowThemeCss(theme) + CSS;
    const el = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
    const box = el("div");
    box.className = "box";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Polycarp");
    const say = el("p");
    say.setAttribute("role", "status");
    say.append(el("b", "Your agent edited this page"));
    const ul = el("ul");
    for (const e of fresh) ul.append(el("li", e.name || E.summary(e)));
    const acts = el("div");
    acts.className = "acts";
    const keep = el("button", "Keep"), undo = el("button", "Undo");
    // isTrusted: the page itself can't answer for the person.
    keep.addEventListener("click", async (ev) => { if (!ev.isTrusted) return; hide(); await S.keep(fresh); });
    undo.addEventListener("click", async (ev) => { if (!ev.isTrusted) return; hide(); for (const e of fresh) await S.turn(e, false); });
    acts.append(keep, undo);
    box.append(say, ul, acts);
    root.append(style, box);
    document.documentElement.append(host);
  }
  P.pageEditsNotice = true;
  P.pageEdits.watch((edits) => {
    const go = () => show(edits).catch(() => {});
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true }); else go();
  });
})();
