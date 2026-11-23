/* Polycarp popup. */
(async function () {
  "use strict";
  const P = globalThis.Polycarp;
  const I = globalThis.PolycarpIcons.icon;
  const $ = (id) => document.getElementById(id);
  const SAMPLE = "This is how pages will look. Change anything below and every open tab follows along.";

  let settings = await P.getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";
  const host = P.hostOf(url);
  const webPage = /^(https?|file):/.test(url) && !/^https:\/\/chrome(webstore)?\.google\.com\/webstore/.test(url);
  let pageState = null;
  if (webPage) { try { pageState = await chrome.tabs.sendMessage(tab.id, { type: "polycarp:state" }); } catch (e) {} }
  const isPdf = (pageState && pageState.isPdf) || /\.pdf($|[?#])/i.test(url);

  // ---------- Static labels ----------
  $("read").innerHTML = I("book") + "<span>" + (isPdf ? "Read this PDF in Polycarp" : "Read this page in Polycarp") + "</span>";
  $("openFile").innerHTML = I("file") + "<span>Open</span>";
  $("save").innerHTML = I("bookmark") + "<span>Save</span>";
  $("save").title = "Save this page to your Polycarp library";
  $("print").innerHTML = I("printer") + "<span>Print</span>";
  $("review").innerHTML = I("layers") + "<span>Review</span>";
  $("settings").innerHTML = I("sliders") + "<span>Settings</span>";
  $("power").innerHTML = I("power");
  $("findIcon").innerHTML = I("search");

  // Profiles
  const order = ["everyday", "focus", "dyslexia", "calm", "steady"];
  $("profiles").innerHTML = order.map((id) =>
    '<button class="chip" data-id="' + id + '" title="' + P.PROFILES[id].tag + '">' + P.PROFILES[id].label + "</button>").join("");

  // Fonts
  $("font").innerHTML = Object.entries(P.FONTS).map(([id, f]) => '<option value="' + id + '">' + f.label + "</option>").join("");

  // Tints
  const tintIds = ["none"].concat(Object.keys(P.TINTS));
  $("tints").innerHTML = tintIds.map((id) => {
    const t = P.TINTS[id];
    return '<button class="swatch' + (id === "none" ? " none" : "") + '" role="radio" data-id="' + id + '" aria-label="' +
      (t ? t.label + " tint" : "No tint") + '" title="' + (t ? t.label : "No tint") + '"' + (t ? ' style="background:' + t.color + '"' : "") + "></button>";
  }).join("");

  // ---------- Render ----------
  // One clear line when Polycarp is resting, with one button to bring it back.
  function renderStatus() {
    const box = $("status");
    const until = settings.pausedUntil || 0;
    if (P.paused(settings)) {
      const d = new Date(until);
      const sameDay = d.toDateString() === new Date().toDateString();
      $("statusText").textContent = "Paused until " + (sameDay ? "" : "tomorrow ") + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ".";
      $("statusBtn").textContent = "Resume now";
      box.hidden = false;
    } else if (!settings.enabled) {
      $("statusText").textContent = "Polycarp is off everywhere.";
      $("statusBtn").textContent = "Turn on";
      box.hidden = false;
    } else box.hidden = true;
    document.body.classList.toggle("resting", !box.hidden);
  }

  function renderSite() {
    renderStatus();
    const row = $("siteRow");
    const sw = $("siteSwitch");
    if (!webPage || !host) {
      $("siteName").textContent = "Not available on this page";
      sw.disabled = true; sw.checked = false; row.classList.add("disabled");
      return;
    }
    // The switch shows this site's own choice, even while Polycarp rests everywhere.
    const on = P.activeFor(Object.assign({}, settings, { enabled: true, pausedUntil: 0 }), host);
    sw.checked = on;
    $("siteName").textContent = (on ? "On for " : "Off for ") + (host === "file" ? "local files" : host);
  }

  function renderProfile() {
    document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.id === settings.profile)));
    const p = P.PROFILES[settings.profile];
    $("blurb").innerHTML = p ? "<b>" + p.tag + ".</b> " + p.blurb : "<b>Custom.</b> Your own mix. Pick a profile to start over.";
  }

  function renderControls() {
    const b = settings.bionic;
    const strength = b.on ? b.strength : 0;
    $("strength").value = strength;
    $("strength").style.setProperty("--fill", (strength / 5) * 100 + "%");
    $("strength").setAttribute("aria-valuetext", strength ? "Strength " + strength + " of 5" : "Bold anchors off");
    $("font").value = settings.type.font;
    const tint = settings.tint.on ? settings.tint.color : "none";
    document.querySelectorAll(".swatch").forEach((s) => s.setAttribute("aria-checked", String(s.dataset.id === tint)));
    $("ruler").checked = settings.ruler.on;
  }

  function renderSpec() {
    const spec = $("spec");
    const s = settings;
    spec.textContent = "";
    const frag = s.bionic.on ? P.renderBionic(SAMPLE, { strength: s.bionic.strength, every: s.bionic.every, fade: s.bionic.fade }, document) : null;
    spec.appendChild(frag || document.createTextNode(SAMPLE));
    const fam = P.FONTS[s.type.font] && P.FONTS[s.type.font].family;
    spec.style.fontFamily = fam || "Georgia, 'Times New Roman', serif";
    spec.style.letterSpacing = s.type.letter + "em";
    spec.style.wordSpacing = s.type.word + "em";
    spec.style.lineHeight = s.type.line || 1.55;
    spec.style.setProperty("--polycarp-weight", s.bionic.weight);
    spec.style.setProperty("--polycarp-fade", (1 - s.bionic.fade).toFixed(2));
    const t = P.TINTS[s.tint.color];
    spec.style.setProperty("--tint", s.tint.on && t ? t.color : "transparent");
    spec.style.setProperty("--tint-a", s.tint.on ? Math.min(0.6, s.tint.strength * 1.6) : 0);
  }

  async function renderToday() {
    const stats = await P.getStats();
    const sum = P.summary(stats, settings.goal);
    const meter = $("meterFill");
    meter.style.width = Math.round(sum.goalPct * 100) + "%";
    $("today").querySelector(".meter").classList.toggle("hit", sum.goalPct >= 1);
    const left = "<span><b>" + sum.today.toLocaleString() + "</b> of " + sum.goal.toLocaleString() + " words today</span>";
    const right = "<span>" + (sum.streak ? I("flame") .replace('class="i"', 'class="i" style="width:14px;height:14px;vertical-align:-2px;color:var(--accent)"') + " <b>" + sum.streak + "</b> day" + (sum.streak === 1 ? "" : "s") + " · " : "") +
      "Level <b>" + sum.level.level + "</b></span>";
    $("todayText").innerHTML = left + right;
    const M = globalThis.PolycarpMemory;
    if (M && M.load) {
      try {
        const due = M.counts(await M.load(), Date.now()).due;
        if (due > 0) $("review").innerHTML = I("layers") + "<span>Review</span><span class=\"count\">" + Math.min(due, 99) + "</span>";
      } catch (e) {}
    }
  }

  async function renderNews() {
    const got = await chrome.storage.local.get("polycarp.whatsNew");
    const n = got["polycarp.whatsNew"];
    if (!n || n.seen) return;
    const a = $("news");
    a.hidden = false;
    a.innerHTML = I("sparkle") + "<span>Polycarp updated to " + n.to + ". See what is new</span>";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/welcome.html#new") });
      window.close();
    });
    n.seen = true;
    chrome.storage.local.set({ "polycarp.whatsNew": n });
  }

  function renderAll() { renderSite(); renderProfile(); renderControls(); renderSpec(); }

  async function save(next) {
    settings = await P.setSettings(next);
    renderAll();
  }
  async function patch(p) {
    settings = await P.patchSettings(p);
    renderAll();
  }

  // ---------- Events ----------
  $("siteSwitch").addEventListener("change", async () => {
    await chrome.runtime.sendMessage({ type: "polycarp:toggleSite", tabId: tab.id });
    settings = await P.getSettings();
    renderSite();
  });
  const menu = $("powerMenu");
  function setMenu(open) { menu.hidden = !open; $("power").setAttribute("aria-expanded", String(open)); if (open) menu.querySelector("button").focus(); }
  $("power").addEventListener("click", () => setMenu(menu.hidden));
  menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { setMenu(false); $("power").focus(); } });
  menu.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    const what = b.dataset.p;
    if (what === "off") settings = await P.patchSettings({ enabled: false }, { keepProfile: true });
    else { await chrome.runtime.sendMessage({ type: "polycarp:pause", minutes: 60, until: what === "tomorrow" ? "tomorrow" : null }); settings = await P.getSettings(); }
    setMenu(false);
    renderSite();
  });
  $("statusBtn").addEventListener("click", async () => {
    if (P.paused(settings)) await chrome.runtime.sendMessage({ type: "polycarp:resume" });
    if (!settings.enabled) await P.patchSettings({ enabled: true }, { keepProfile: true });
    settings = await P.getSettings();
    renderSite();
  });
  $("findForm").addEventListener("submit", (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "polycarp:openSearch", q: $("q").value.trim() });
    window.close();
  });
  $("findPage").addEventListener("click", async () => {
    const r = webPage ? await chrome.runtime.sendMessage({ type: "polycarp:find", tabId: tab.id, query: $("q").value.trim() }).catch(() => null) : null;
    if (!r || !r.ok) chrome.runtime.sendMessage({ type: "polycarp:openSearch", q: $("q").value.trim() });
    window.close();
  });
  if (!webPage) $("findPage").hidden = true;

  $("profiles").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (b) save(P.applyProfile(settings, b.dataset.id));
  });
  $("strength").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    patch({ bionic: v === 0 ? { on: false } : { on: true, strength: v } });
  });
  $("font").addEventListener("change", (e) => patch({ type: { font: e.target.value } }));
  $("tints").addEventListener("click", (e) => {
    const b = e.target.closest(".swatch");
    if (!b) return;
    patch(b.dataset.id === "none" ? { tint: { on: false } } : { tint: { on: true, color: b.dataset.id } });
  });
  $("tints").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const all = [...document.querySelectorAll(".swatch")];
    const i = all.indexOf(document.activeElement);
    const n = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    n.focus(); n.click(); e.preventDefault();
  });
  $("ruler").addEventListener("change", (e) => patch({ ruler: { on: e.target.checked } }));

  $("read").addEventListener("click", async () => {
    if (webPage) await chrome.runtime.sendMessage({ type: "polycarp:openReaderForTab", tabId: tab.id });
    else chrome.tabs.create({ url: chrome.runtime.getURL("src/reader/reader.html") });
    window.close();
  });
  $("openFile").addEventListener("click", () => { chrome.tabs.create({ url: chrome.runtime.getURL("src/reader/reader.html") }); window.close(); });
  $("print").addEventListener("click", async () => {
    if (webPage) await chrome.runtime.sendMessage({ type: "polycarp:openReaderForTab", tabId: tab.id, extra: { print: "1" } });
    else chrome.tabs.create({ url: chrome.runtime.getURL("src/reader/reader.html") });
    window.close();
  });
  let savedId = null;
  $("save").addEventListener("click", async () => {
    const lib = chrome.runtime.getURL("src/pages/library.html");
    if (savedId || !webPage) { chrome.tabs.create({ url: lib + (savedId ? "#item=" + encodeURIComponent(savedId) : "") }); window.close(); return; }
    $("save").disabled = true;
    const r = await chrome.runtime.sendMessage({ type: "polycarp:saveTab", tabId: tab.id }).catch(() => null);
    $("save").disabled = false;
    if (r && r.ok) { savedId = r.id; $("save").innerHTML = I("check") + "<span>Saved</span>"; $("save").title = "Open it in your library"; }
    else { $("save").innerHTML = I("library") + "<span>Could not save</span>"; $("save").title = "Polycarp could not read this page. Open your library"; }
  });
  $("review").addEventListener("click", () => { chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/review.html") }); window.close(); });
  $("settings").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });

  if (!webPage) { $("read").innerHTML = I("file") + "<span>Open a PDF, ebook or document</span>"; $("openFile").hidden = true; }

  renderAll();
  renderToday();
  renderNews();
})();
