/* The first time an edit from the Polycarp app changes a page, this says so, with a way to take it back: an agent's change
   to a page is never silent. It stays until answered, and comes again when the agent changes the edit. An edit that changed
   nothing on a page isn't announced there; one with a stylesheet always is. The box is in the top layer, over the page and
   out of reach of its styles and the edit's. */
(function () {
  "use strict";
  const P = globalThis.Polycarp, S = globalThis.PolycarpEditsStore, E = globalThis.PolycarpEdits;
  if (!P || !P.pageEdits || P.pageEditsNotice || !S) return;
  const CSS = `
    .box{position:fixed;inset:auto;inset-inline-end:16px;bottom:16px;margin:0;box-sizing:border-box;width:min(340px,calc(100vw - 32px));padding:12px 16px;
      border:var(--pc-border-width) solid var(--pc-border);border-radius:var(--pc-radius);background:var(--pc-surface);color:var(--pc-foreground);
      box-shadow:0 8px 24px color-mix(in srgb,var(--pc-strong) calc(var(--pc-shadow) * 100%),transparent);font:var(--pc-font-weight) 14px/1.5 var(--pc-font-ui);text-align:start}
    p{margin:0} b{display:block;color:var(--pc-strong);font-size:15px}
    ul{margin:4px 0 0;padding-inline-start:16px;max-height:30vh;overflow:auto;overflow-wrap:anywhere}
    .acts{display:flex;gap:8px;margin-top:12px}
    button{min-height:36px;padding:0 16px;border:var(--pc-border-width) solid var(--pc-border);border-radius:var(--pc-radius-small);background:none;color:var(--pc-foreground);font:600 14px/1 var(--pc-font-ui);cursor:pointer}
    button:hover{background:var(--pc-sunken)} button:focus-visible{outline:2px solid var(--pc-strong);outline-offset:2px}
    @media print{.box{display:none}}`;
  const BACK = 20; // times a page may take the box away before it stays away
  const LATE = 4000; // a page that is still loading this long after it was read is told anyway
  const key = (e) => e.id + E.fingerprint(e);
  let host = null, box = null, shown = "", turn = 0, back = 0, edits = [], ready = document.readyState === "complete", timer = 0, wait = 500, forced = null;
  const said = new Set(); // what this page has announced: it stays up when what it changed goes away
  const watcher = new MutationObserver(() => { if (host && !(host.parentNode === document.documentElement && box.matches(":popover-open")) && back++ < BACK) attach(); });
  // An edit that has changed nothing yet may, when the page does: each look that finds nothing waits longer for the next.
  const later = new MutationObserver(() => { later.disconnect(); timer = timer || setTimeout(check, wait = Math.min(wait * 2, 8000)); });

  function hide() {
    watcher.disconnect();
    if (host) host.remove();
    if (forced) forced.style.removeProperty("display");
    host = box = forced = null;
    shown = "";
  }
  function attach() {
    const top = document.documentElement;
    watcher.disconnect();
    watcher.observe(document, { childList: true });
    if (!top) return;
    watcher.observe(top, { childList: true });
    top.append(host);
    if (!box.matches(":popover-open")) box.showPopover();
    // An edit that leaves nothing of the page drawn would take the box with it.
    if (!box.getClientRects().length) { forced = top; top.style.setProperty("display", "block", "important"); }
  }
  async function show() {
    clearTimeout(timer);
    timer = 0;
    later.disconnect();
    if (!ready) return; // once the page's own scripts have run: one that takes up its whole document would trip on the box
    const mine = ++turn;
    const unseen = edits.length ? await S.unseen(edits) : [];
    if (mine !== turn) return;
    const did = new Set(unseen.length ? P.pageEdits.report().filter((e) => e.css || e.changes.some((c) => c.did)).map((e) => e.source + e.id) : []);
    const fresh = unseen.filter((e) => said.has(key(e)) || did.has(e.source + e.id));
    if (fresh.length < unseen.length) later.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const sig = fresh.map(key).join(" ");
    if (sig === shown) return;
    const theme = fresh.length ? await P.themeCss().catch(() => "") : "";
    if (mine !== turn) return;
    hide();
    if (!fresh.length) return;
    host = document.createElement("polycarp-edits");
    host.setAttribute("data-polycarp-skip", "");
    host.style.cssText = "all:initial !important;display:contents !important";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = P.shadowThemeCss(theme) + CSS;
    const el = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
    box = el("div");
    box.className = "box";
    box.popover = "manual";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Polycarp");
    const say = el("p");
    say.setAttribute("role", "status");
    const trouble = el("span");
    say.append(el("b", "Your agent edited this page"), trouble);
    const ul = el("ul");
    for (const e of fresh) ul.append(el("li", (e.name ? e.name + ": " : "") + E.summary(e)));
    const acts = el("div");
    acts.className = "acts";
    const answer = (text, act) => {
      const b = el("button", text);
      b.addEventListener("click", async (ev) => {
        if (!ev.isTrusted) return; // the page itself can't answer for the person
        try { await act(); hide(); } catch (e) {
          trouble.textContent = "Polycarp could not save that.";
          P.pageEdits.apply(); // with the extension gone, this takes the edits back
        }
      });
      acts.append(b);
    };
    answer("Keep", () => S.keep(fresh));
    answer("Undo", async () => { await S.turnApp(fresh, false); await S.keep(fresh); });
    box.append(say, ul, acts);
    root.append(style, box);
    back = 0;
    attach();
    shown = sig;
    for (const e of fresh) said.add(key(e));
  }
  const check = () => { show().catch(() => {}); };
  P.pageEditsNotice = true;
  const start = () => { ready = true; check(); };
  addEventListener("load", start, { once: true });
  addEventListener("DOMContentLoaded", () => setTimeout(start, LATE), { once: true });
  if (document.readyState === "interactive") setTimeout(start, LATE);
  addEventListener("pageshow", (ev) => { if (ev.persisted) check(); }); // the page cache hears of no answer given elsewhere
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[S.SEEN_KEY]) check(); });
  P.pageEdits.watch((now) => { edits = now; wait = 500; check(); });
})();
