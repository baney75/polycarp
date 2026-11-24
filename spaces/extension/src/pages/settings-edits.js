/* Settings > Page edits: every edit, from the Polycarp app and from this browser, with a switch; this browser's own can be
   deleted, or added as a stylesheet for a site. */
(function () {
  "use strict";
  const E = globalThis.PolycarpEdits, S = globalThis.PolycarpEditsStore;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const HTML = '<ul class="sites flist" id="eList"></ul><p class="note" id="eApp"></p><div id="eRefused"></div>' +
    '<h3 class="fhead">Add a stylesheet</h3><form class="fadd" id="eAdd" novalidate>' +
    '<label class="ffield"><b>Sites</b><span>One or more, with commas.</span><input class="ftext" id="eSites" autocomplete="off" placeholder="example.com"></label>' +
    '<label class="ffield"><b>Pages</b><span>Leave empty for the whole site.</span><input class="ftext" id="ePaths" autocomplete="off" placeholder="/watch/*"></label>' +
    '<label class="ffield"><b>CSS</b><span>It loads nothing from the network.</span><textarea class="ftext emono" id="eCss" rows="4" spellcheck="false" placeholder="aside { display: none }"></textarea></label>' +
    '<div class="acts"><button class="btn primary" type="submit">Add stylesheet</button></div><p class="note" id="eNote" role="status" aria-live="polite"></p></form>';
  const list = (v) => String(v || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  function row(e) {
    const label = esc(e.name || E.summary(e));
    const key = esc(e.source + ":" + e.id);
    return '<li><b><span class="fsum">' + label + "</span><small>" + esc(e.sites.concat(e.paths).join(", ")) + " · " + (e.source === "app" ? "from your agent" : "yours") + "</small></b>" +
      '<span class="switch"><input type="checkbox" data-on="' + key + '"' + (e.enabled ? " checked" : "") + ' aria-label="Edit on: ' + label + '"></span>' +
      (e.source === "local" ? '<button class="btn icon quiet" data-del="' + key + '" aria-label="Delete edit: ' + label + '" title="Delete">×</button>' : "") + "</li>";
  }
  function bind(box) {
    if (!E || !S || !box) return;
    box.innerHTML = HTML;
    const $ = (sel) => box.querySelector(sel);
    let edits = [];
    const find = (key) => edits.find((e) => e.source + ":" + e.id === key);
    async function render() {
      const r = await S.load();
      edits = r.edits;
      // Rebuilding the list drops the focused switch.
      const held = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute("data-on") : null;
      $("#eList").innerHTML = edits.length ? edits.map(row).join("") : '<li class="empty"><span class="note">No edits yet.</span></li>';
      const again = held && [...box.querySelectorAll("[data-on]")].find((x) => x.getAttribute("data-on") === held);
      if (again) again.focus();
      $("#eApp").textContent = r.app.error ? "Polycarp did not answer: " + r.app.error + ". Its last edits still apply."
        : r.app.connected ? "Your agents set edits through the Polycarp app; switch one off here and it stays off until they change it."
        : "With the Polycarp app on this computer, edits your agents make show here.";
      $("#eRefused").innerHTML = r.refused.length ? '<h3 class="fhead">Not used</h3><ul class="sites flist">' + r.refused.map((x) =>
        '<li><b><span class="fsum">' + esc(x.id || "An edit") + "</span><small>" + esc(x.why) + (x.source === "app" ? " · from your agent" : "") + "</small></b></li>").join("") + "</ul>" : "";
    }
    box.addEventListener("change", (ev) => {
      const key = ev.target.getAttribute && ev.target.getAttribute("data-on");
      const e = key && find(key);
      if (e) S.turn(e, ev.target.checked);
    });
    box.addEventListener("click", async (ev) => {
      const b = ev.target.closest && ev.target.closest("[data-del]");
      const e = b && find(b.getAttribute("data-del"));
      if (!e) return;
      await S.put(e.id, null);
      $("#eNote").textContent = "Edit deleted.";
      $("#eSites").focus();
    });
    $("#eAdd").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = "css-" + Date.now().toString(36);
      const why = await S.put(id, { id, sites: list($("#eSites").value), paths: list($("#ePaths").value), css: $("#eCss").value });
      $("#eNote").textContent = why ? "Not added: " + why + "." : "Stylesheet added. Open pages update now.";
      if (!why) $("#eAdd").reset();
      $(why ? "#eCss" : "#eSites").focus();
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (S.changed(ch, area)) render(); });
    render();
  }
  globalThis.PolycarpEditsUI = { bind };
})();
