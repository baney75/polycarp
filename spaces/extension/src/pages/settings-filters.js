/* Settings > Feed filters: add a rule (words, accounts, sites, kinds), switch and delete this browser's own rules, see the
   Polycarp app's rules read-only, and see each pattern or selector that was refused and why. Rules live in
   chrome.storage.local (src/shared/filters.js); open pages pick up every change without a reload. */
(function () {
  "use strict";
  const F = globalThis.PolycarpFilters;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const list = (v) => String(v || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const KIND_TEXT = { shorts: "Shorts", promoted: "Promoted posts and ads", reposts: "Reposts and boosts" };

  const HTML = '<form class="fadd" id="fAdd" novalidate>' +
    '<label class="ffield"><b>Words or phrases</b><span>Separate with commas. Whole words, any case.</span><input class="ftext" id="fWords" autocomplete="off" placeholder="crypto, giveaway"></label>' +
    '<label class="ffield"><b>Accounts</b><span>Posts by these people or communities.</span><input class="ftext" id="fAccounts" autocomplete="off" placeholder="@name, r/subreddit"></label>' +
    '<label class="ffield"><b>Sites</b><span>Leave empty for every site.</span><input class="ftext" id="fSites" autocomplete="off" placeholder="x.com, youtube.com"></label>' +
    '<fieldset class="fkinds"><legend>Also hide</legend>' +
    F.KINDS.map((k) => '<label><input type="checkbox" name="fKind" value="' + k + '"> ' + KIND_TEXT[k] + "</label>").join("") + "</fieldset>" +
    '<div class="acts"><button class="btn primary" type="submit">Add filter</button></div>' +
    '<p class="note" id="fNote" role="status" aria-live="polite"></p></form>' +
    '<h3 class="fhead">Your filters</h3><ul class="sites flist" id="fLocal"></ul>' +
    '<h3 class="fhead">From Polycarp</h3><p class="note" id="fAppNote"></p><ul class="sites flist" id="fApp"></ul>' +
    '<div id="fRefused"></div>';

  async function read() {
    const got = await chrome.storage.local.get([F.LOCAL_KEY, F.APP_KEY]);
    return { local: Array.isArray(got[F.LOCAL_KEY]) ? got[F.LOCAL_KEY] : [], app: got[F.APP_KEY] || null };
  }
  const writeLocal = (rules) => chrome.storage.local.set({ [F.LOCAL_KEY]: rules });
  const where = (r) => (r.sites.length ? r.sites.join(", ") : "Every site");

  function row(r, i, own) {
    const label = esc(F.summary(r));
    const tail = own
      ? '<span class="switch"><input type="checkbox" data-toggle="' + i + '"' + (r.enabled ? " checked" : "") + ' aria-label="Filter on: ' + label + '"></span>' +
        '<button class="btn icon quiet" data-del="' + i + '" aria-label="Delete filter: ' + label + '" title="Delete">×</button>'
      : '<span class="tag' + (r.enabled ? " on" : "") + '">' + (r.enabled ? "On" : "Off") + "</span>";
    return '<li><b><span class="fsum">' + label + '</span><small>' + esc(where(r)) + (own ? "" : " · from Polycarp") + "</small></b>" + tail + "</li>";
  }

  async function render(box) {
    const { local, app } = await read();
    const mine = local.map((r) => F.normalizeRule(r, "local"));
    const theirs = (app && Array.isArray(app.rules) ? app.rules : []).map((r) => F.normalizeRule(r, "app"));
    box.querySelector("#fLocal").innerHTML = mine.length ? mine.map((r, i) => row(r, i, true)).join("")
      : '<li class="empty"><span class="note">No filters yet. Add one above.</span></li>';
    box.querySelector("#fApp").innerHTML = theirs.map((r, i) => row(r, i, false)).join("");
    box.querySelector("#fAppNote").textContent = app && app.error ? "Polycarp did not answer: " + app.error + ". Its last filters still apply."
      : theirs.length ? "Set in the Polycarp app or by your agents. Change them there."
      : app && app.connected ? "Polycarp has no filters for this browser." : "With the Polycarp app on this computer, its filters show here.";
    const selectorOk = (s) => { try { document.querySelector(s); return true; } catch (e) { return false; } };
    const refused = F.refusals(F.merge(theirs, mine), { checkSelector: selectorOk });
    box.querySelector("#fRefused").innerHTML = refused.length
      ? '<h3 class="fhead">Not used</h3><ul class="sites flist">' + refused.map((x) =>
        "<li><b><span class=\"fsum\">" + (x.what === "pattern" ? "Pattern " + esc("/" + x.value + "/") : "Selector " + esc(x.value)) +
        "</span><small>" + esc(x.why) + (x.source === "app" ? " · from Polycarp" : "") + "</small></b></li>").join("") + "</ul>"
      : "";
  }

  function bind(box) {
    if (!F || !box) return;
    box.innerHTML = HTML;
    const note = box.querySelector("#fNote");
    box.querySelector("#fAdd").addEventListener("submit", async (e) => {
      e.preventDefault();
      const kinds = [...box.querySelectorAll("input[name=fKind]:checked")].map((c) => c.value);
      const rule = F.normalizeRule({
        id: "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), enabled: true,
        words: list(box.querySelector("#fWords").value), accounts: list(box.querySelector("#fAccounts").value),
        sites: list(box.querySelector("#fSites").value), kinds
      }, "local");
      if (!rule.words.length && !rule.accounts.length && !rule.kinds.length) {
        note.textContent = "Add a word, an account or a kind of post to hide.";
        box.querySelector("#fWords").focus();
        return;
      }
      delete rule.source;
      const { local } = await read();
      await writeLocal(local.concat([rule]));
      box.querySelector("#fAdd").reset();
      note.textContent = "Filter added. Open pages update now.";
      box.querySelector("#fWords").focus();
    });
    box.addEventListener("change", async (e) => {
      const i = e.target.getAttribute && e.target.getAttribute("data-toggle");
      if (i == null) return;
      const { local } = await read();
      if (!local[i]) return;
      local[i] = Object.assign({}, local[i], { enabled: e.target.checked });
      await writeLocal(local);
    });
    box.addEventListener("click", async (e) => {
      const b = e.target.closest && e.target.closest("[data-del]");
      if (!b) return;
      const { local } = await read();
      local.splice(Number(b.getAttribute("data-del")), 1);
      await writeLocal(local);
      note.textContent = "Filter deleted.";
      box.querySelector("#fWords").focus();
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch[F.LOCAL_KEY] || ch[F.APP_KEY])) render(box); });
    render(box);
  }

  globalThis.PolycarpFiltersUI = { bind };
})();
