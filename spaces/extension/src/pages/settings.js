/* Polycarp settings page. Built from a small schema so every option has one row and one source of truth. */
(async function () {
  "use strict";
  const P = globalThis.Polycarp;
  const IC = globalThis.PolycarpIcons;
  const I = IC.icon;
  const M = globalThis.PolycarpMemory;
  const V = globalThis.PolycarpVoice;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  $("navRead").innerHTML = I("book") + "<span>Reader</span>";

  $("navSearch").innerHTML = I("search") + "<span>Search</span>";
  $("navLib").innerHTML = I("library") + "<span>Library</span>";
  $("navReview").innerHTML = I("layers") + "<span>Review</span>";
  $("navSettings").innerHTML = I("sliders") + "<span>Settings</span>";

  let s = await P.getSettings();
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), s);
  const patchOf = (path, v) => path.split(".").reduceRight((acc, k) => ({ [k]: acc }), v);
  // Style changes move the profile to "custom"; housekeeping options keep it.
  const KEEP = /^(enabled|autoApply|helpers\.|pausedUntil|goal|celebrate|reader\.|force\.unlockCopy|force\.frames)/;
  async function set(path, v) { s = await P.patchSettings(patchOf(path, v), { keepProfile: KEEP.test(path) }); sync(); }

  // ---------- Row builders ----------
  const id = (path) => "f-" + path.replace(/\./g, "-");
  const lbl = (label, desc) => '<span class="lbl"><b>' + label + "</b>" + (desc ? "<span>" + desc + "</span>" : "") + "</span>";
  const toggle = (path, label, desc) => ({ path, kind: "toggle", html: '<label class="row" for="' + id(path) + '">' + lbl(label, desc) + '<span class="switch"><input type="checkbox" id="' + id(path) + '"></span></label>' });
  const range = (path, label, desc, min, max, step, fmt, toStore, fromStore) => ({
    path, kind: "range", fmt, toStore, fromStore,
    html: '<label class="row range" for="' + id(path) + '">' + lbl(label, desc) + '<input type="range" id="' + id(path) + '" min="' + min + '" max="' + max + '" step="' + step + '"><output id="' + id(path) + '-o"></output></label>'
  });
  const choice = (path, label, desc, opts) => ({
    path, kind: "choice", opts,
    html: '<div class="row">' + lbl(label, desc) + '<div class="chips" role="group" aria-label="' + label + '" id="' + id(path) + '">' +
      opts.map(([v, t]) => '<button class="chip" data-v="' + esc(JSON.stringify(v)) + '">' + t + "</button>").join("") + "</div></div>"
  });
  const raw = (html, bind) => ({ kind: "raw", html, bind });

  const em = (v) => Number(v).toFixed(2) + " em";
  const GROUPS = [
    ["Reading profile", "A starting point for how you read. Adjust anything below and Polycarp remembers it as your own mix.", [
      raw('<div class="chips" id="profiles"></div><p class="note" id="blurb"></p>')
    ]],
    ["On web pages", "", [
      toggle("enabled", "Polycarp on web pages", "Turn off to pause Polycarp everywhere. The Reader still works."),
      raw('<div class="row stack"><span class="lbl"><b>Take a break</b><span id="pauseNote">Pause Polycarp on every site for a while. It comes back on its own.</span></span><div class="acts" id="pauseActs"></div></div>', bindPause),
      toggle("autoApply", "Start on every site", "Off means Polycarp runs only on sites you switch on from the toolbar."),
      raw('<div id="siteBox"></div>')
    ]],
    ["Site helpers", "Extra help on sites Polycarp knows well. Press Alt Shift S on any page to search it.", [
      toggle("helpers.youtube", "YouTube", "Search a video's transcript, chapters and comments, jump to the moment, and read the transcript in the Reader"),
      toggle("helpers.x", "X", "Search posts you have scrolled past, and read a thread in the Reader"),
      toggle("helpers.audible", "Audible", "Offer to make your Audible library searchable in Polycarp"),
      toggle("helpers.kindle", "Kindle", "Offer to make your Kindle library searchable in Polycarp"),
      toggle("helpers.web", "Every other site", "Search headings, links, images and video on any page")
    ]],
    ["Search and your NAS", "", [
      raw('<div class="row"><span class="lbl"><b>Polycarp Search</b><span>Your library, YouTube, free books and papers, and any site you add, in one search. Type pc and a space in the address bar to search from anywhere.</span></span><a class="btn" href="search.html">' + I("search") + '<span>Open Search</span></a></div>' +
        '<div class="row"><span class="lbl"><b>Your NAS</b><span id="nasNote">Not connected</span></span><a class="btn quiet" href="search.html#nasBlock">Set up</a></div>', bindNas)
    ]],
    ["Bold anchors", "The start of each word in bold. A careful study found no speed gain from this (Snell 2024), but some readers find it easier on the eyes. Keep it only if it helps you.", [
      toggle("bionic.on", "Bold anchors"),
      range("bionic.strength", "Strength", "How much of each word is bold", 1, 5, 1, (v) => v),
      range("bionic.weight", "Boldness", "How thick the bold letters are", 500, 800, 50, (v) => ({ 500: "Light", 550: "Light", 600: "Medium", 650: "Medium", 700: "Bold", 750: "Bold", 800: "Heavy" })[v] || v),
      range("bionic.fade", "Fade the rest", "Lightens the unbolded part of each word", 0, 0.4, 0.02, (v) => Math.round(v * 100) + "%"),
      choice("bionic.every", "Which words", "", [[1, "Every word"], [2, "Every other word"]])
    ]],
    ["Type and spacing", "Extra letter spacing helped children with dyslexia read better in one study (Zorzi et al. 2012).", [
      choice("type.font", "Font", "", Object.entries(P.FONTS).map(([k, f]) => [k, k === "page" ? "Keep the page font" : f.label])),
      range("type.letter", "Letter spacing", "", 0, 0.2, 0.01, em),
      range("type.word", "Word spacing", "", 0, 0.5, 0.02, em),
      range("type.line", "Line height", "All the way left keeps the page's own", 1.15, 2.4, 0.05, (v) => (v <= 1.15 ? "Page" : Number(v).toFixed(2)), (v) => (v <= 1.15 ? 0 : v), (v) => v || 1.15)
    ]],
    ["Color and calm", "Some readers with visual stress or visual snow find a tint calmer. The evidence is mixed, so there is no right color: pick the one that feels best.", [
      raw('<div class="row"><span class="lbl"><b>Tint</b></span><div class="swatches" id="tints" role="radiogroup" aria-label="Tint"></div></div>'),
      range("tint.strength", "Tint strength", "", 0.05, 0.35, 0.01, (v) => Math.round(v * 100) + "%"),
      toggle("calm.still", "Stop animations", "Pauses animations, autoplaying video and smooth scrolling on pages"),
      toggle("calm.soft", "Soften contrast", "Takes the edge off pure black on bright white")
    ]],
    ["Focus", "", [
      toggle("ruler.on", "Focus ruler", "Dims everything above and below the lines you are reading"),
      range("ruler.lines", "Ruler height", "Lines kept clear", 1, 6, 1, (v) => v),
      toggle("doneMarks", "Mark paragraphs once read", "A small green edge shows what you have already read, so you can move on")
    ]],
    ["Make every site readable", "Polycarp overrides the page when a site makes reading hard.", [
      choice("force.minSize", "Smallest text size", "", [[0, "Off"], [14, "14"], [16, "16"], [18, "18"], [20, "20"]]),
      toggle("force.contrast", "Strong contrast", "Dark text on a light page, whatever the site picked"),
      toggle("force.leftAlign", "Left align", "No justified text with uneven gaps"),
      toggle("force.noItalic", "No italics", "Sets slanted text upright"),
      toggle("force.unlockCopy", "Let me copy and select", "Undoes sites that block selecting text"),
      toggle("force.frames", "Inside embedded frames", "Also applies inside frames on the page")
    ]],
    ["Goal and celebrations", "", [
      choice("goal", "Daily goal", "Words a day. Small and steady beats big and rare.", [[500, "500"], [1000, "1,000"], [2000, "2,000"], [3000, "3,000"], [5000, "5,000"]]),
      choice("celebrate", "Celebrations", "", [["full", "Confetti"], ["gentle", "Gentle"], ["off", "Off"]])
    ]],
    ["Reader and memory", "", [
      choice("reader.rounds", "Recall breaks", "A short quiz every few pages", [["off", "Off"], ["long", "Rarely"], ["medium", "Normal"], ["short", "Often"]]),
      toggle("reader.pretest", "Warm-up guess", "One question before you start. Guessing first makes the answer stick."),
      toggle("reader.sound", "Soft sounds"),
      raw('<div class="row"><span class="lbl"><b>Reading voice</b><span id="kStatus">Checking</span></span><select class="select" id="voice" aria-label="Reading voice"></select></div><div class="acts" id="kActs"></div>' +
        '<div class="row"><span class="lbl"><b>Dialogue voice</b><span>Quoted speech in a second voice, like an audiobook with two narrators.</span></span><select class="select" id="dialogue" aria-label="Dialogue voice"></select></div>', bindVoice)
    ]],
    ["Library", "Every document, link, audiobook and note you save, linked by shared ideas and your [[links]].", [
      raw('<div class="row"><span class="lbl"><b>Your library</b><span id="libCount">Counting</span></span><a class="btn" href="library.html">' + I("library") + '<span>Open Library</span></a></div>' +
        '<div class="row"><span class="lbl"><b>Obsidian and Notion</b><span>Send your library, highlights and notes to your vault or a Notion database, with links between related items.</span></span><a class="btn quiet" href="library.html#sync">Set up</a></div>', bindLibrary)
    ]],
    ["Keyboard", "", [
      raw('<dl class="kbd-list"><dt><kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>P</kbd></dt><dd>Turn Polycarp on or off for this site</dd>' +
        '<dt><kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>R</kbd></dt><dd>Open the page or PDF in the Reader</dd>' +
        '<dt><kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>F</kbd></dt><dd>Focus ruler on or off</dd>' +
        '<dt>In the Reader</dt><dd><kbd>J</kbd> <kbd>K</kbd> next and previous paragraph · <kbd>C</kbd> contents · <kbd>L</kbd> listen · <kbd>R</kbd> speed read · <kbd>S</kbd> remember · <kbd>A</kbd> text settings · <kbd>+</kbd> <kbd>-</kbd> text size · <kbd>N</kbd> notes · <kbd>H</kbd> highlight · <kbd>P</kbd> print</dd>' +
        '<dt>In the Library</dt><dd><kbd>/</kbd> search · <kbd>A</kbd> add · <kbd>Esc</kbd> close</dd></dl>' +
        '<div class="acts"><button class="btn" id="keys">Change shortcuts</button></div>', () => {
        $("keys").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
      })
    ]],
    ["Your data", "Polycarp has no account and no server. Settings, stats, the ideas in your memory garden and your library live in this browser. Three things leave it, and only when you use them: Notion sync sends your library to Notion, your NAS gets the files and backups you save to it, and Polycarp Search sends what you type to the sources you have switched on.", [
      raw('<div class="acts"><button class="btn" id="export">' + I("download") + '<span>Export a backup</span></button><button class="btn" id="importBtn">' + I("upload") + '<span>Restore a backup</span></button><input type="file" id="importFile" accept=".json,application/json" hidden>' +
        '<button class="btn quiet" id="resetSettings">Reset settings</button></div><p class="note" id="dataNote"></p>', bindData)
    ]],
    ["About", "", [
      raw('<div class="row"><span class="lbl"><b id="ver"></b><span id="updText">With the Polycarp app installed, this extension updates with it. A new version starts as soon as no Reader tab is open.</span></span><button class="btn" id="checkUpd">' + I("rotate") + '<span>Check for updates</span></button></div><p class="note" id="updNote" aria-live="polite"></p>' +
        '<div class="row" id="appRow" hidden><span class="lbl"><b>Polycarp app</b><span id="appText">If the Polycarp app is on this computer, connect to it so its filters and settings reach this browser.</span></span><button class="btn" id="appConnect">' + I("link") + '<span>Connect to the Polycarp app</span></button></div>' +
        '<div class="acts"><a class="btn quiet" href="welcome.html#science">The research behind Polycarp</a><a class="btn quiet" href="welcome.html#new">What is new</a><a class="btn quiet" href="welcome.html">Welcome page</a></div>', bindAbout)
    ]]
  ];

  // ---------- Build ----------
  const rows = [];
  $("groups").innerHTML = GROUPS.map(([title, desc, rs], gi) =>
    '<section class="group" aria-labelledby="g' + gi + '"><h2 id="g' + gi + '">' + title + "</h2>" + (desc ? "<p>" + desc + "</p>" : "") +
    rs.map((r) => { rows.push(r); return r.html; }).join("") + "</section>").join("");

  for (const r of rows) {
    if (r.kind === "toggle") $(id(r.path)).addEventListener("change", (e) => set(r.path, e.target.checked));
    if (r.kind === "range") {
      const el = $(id(r.path));
      el.addEventListener("input", () => { paint(el); $(id(r.path) + "-o").textContent = r.fmt(Number(el.value)); });
      el.addEventListener("change", () => set(r.path, r.toStore ? r.toStore(Number(el.value)) : Number(el.value)));
    }
    if (r.kind === "choice") $(id(r.path)).addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) set(r.path, JSON.parse(b.dataset.v)); });
    if (r.bind) r.bind();
  }
  function paint(el) { el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min)) * 100 + "%"); }

  // Profiles
  const order = ["everyday", "focus", "dyslexia", "calm", "steady"];
  $("profiles").innerHTML = order.map((p) => '<button class="chip" data-id="' + p + '">' + P.PROFILES[p].label + "<small>" + P.PROFILES[p].tag + "</small></button>").join("");
  $("profiles").addEventListener("click", async (e) => { const b = e.target.closest(".chip"); if (b) { s = await P.setSettings(P.applyProfile(s, b.dataset.id)); sync(); } });
  // Tints
  $("tints").innerHTML = ["none"].concat(Object.keys(P.TINTS)).map((t) => {
    const c = P.TINTS[t];
    return '<button class="swatch' + (t === "none" ? " none" : "") + '" role="radio" data-id="' + t + '" aria-label="' + (c ? c.label : "No") + ' tint" title="' + (c ? c.label : "No tint") + '"' + (c ? ' style="background:' + c.color + '"' : "") + "></button>";
  }).join("");
  $("tints").addEventListener("click", async (e) => {
    const b = e.target.closest(".swatch"); if (!b) return;
    s = await P.patchSettings(b.dataset.id === "none" ? { tint: { on: false } } : { tint: { on: true, color: b.dataset.id } }); sync();
  });

  // ---------- Sync values ----------
  function sync() {
    for (const r of rows) {
      if (!r.path) continue;
      const v = get(r.path);
      if (r.kind === "toggle") $(id(r.path)).checked = !!v;
      if (r.kind === "range") {
        const el = $(id(r.path));
        if (document.activeElement !== el) el.value = r.fromStore ? r.fromStore(v) : v;
        paint(el);
        $(id(r.path) + "-o").textContent = r.fmt(Number(el.value));
      }
      if (r.kind === "choice") $(id(r.path)).querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", String(JSON.parse(b.dataset.v) === v)));
    }
    document.querySelectorAll("#profiles .chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === s.profile)));
    const p = P.PROFILES[s.profile];
    $("blurb").innerHTML = p ? "<b>" + p.tag + ".</b> " + p.blurb : "<b>Custom.</b> Your own mix. Pick a profile to start over.";
    const tint = s.tint.on ? s.tint.color : "none";
    document.querySelectorAll("#tints .swatch").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === tint)));
    renderSites();
    paintPause();
  }
  function renderSites() {
    const list = Object.entries(s.sites || {});
    $("siteBox").innerHTML = list.length
      ? '<ul class="sites">' + list.sort().map(([h, v]) => '<li><b>' + esc(h) + '</b><span class="tag' + (v === "on" ? " on" : "") + '">' + (v === "on" ? "Always on" : "Off") + '</span><button class="btn icon quiet" data-host="' + esc(h) + '" aria-label="Forget ' + esc(h) + '">' + I("x") + "</button></li>").join("") + "</ul>"
      : '<p class="note">No site exceptions yet. Use the switch in the toolbar popup to turn Polycarp off for a site.</p>';
  }
  $("siteBox").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-host]"); if (!b) return;
    const sites = { ...s.sites }; delete sites[b.dataset.host];
    s.sites = sites; s = await P.setSettings(s); sync();
  });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[P.SETTINGS_KEY]) { s = P.migrate(ch[P.SETTINGS_KEY].newValue); sync(); } });

  // ---------- Voice ----------
  function bindVoice() {
    if (!V) { $("kStatus").textContent = "Voices are not available in this browser."; return; }
    V.listVoices().then((vs) => {
      const o = (v) => '<option value="' + esc(v.id) + '">' + esc(v.label) + "</option>";
      $("voice").innerHTML = vs.map(o).join("");
      $("voice").value = vs.some((v) => v.id === s.reader.voice) ? s.reader.voice : vs[0].id;
      $("dialogue").innerHTML = '<option value="auto">A contrasting voice</option><option value="off">Off, one voice</option>' +
        vs.map((v) => '<option value="' + esc(v.id) + '">' + esc(v.name) + "</option>").join("");
      $("dialogue").value = s.reader.dialogue || "auto";
    });
    $("voice").addEventListener("change", (e) => set("reader.voice", e.target.value));
    $("dialogue").addEventListener("change", (e) => set("reader.dialogue", e.target.value));
    kokoro();
  }
  async function kokoro() {
    const st = await V.kokoroStatus();
    const acts = $("kActs");
    if (st.state === "ready") {
      $("kStatus").textContent = "Downloaded and works offline" + (st.bytes ? ", " + Math.round(st.bytes / 1e6) + " MB" : "") + (st.device === "webgpu" ? ", on your graphics card." : ".");
      acts.innerHTML = '<button class="btn" id="kTry">' + I("play") + '<span>Hear it</span></button><button class="btn quiet" id="kRemove">Remove download</button>';
      $("kTry").addEventListener("click", () => V.preview($("voice").value || "kokoro:af_heart"));
      $("kRemove").addEventListener("click", async () => { await V.removeKokoro(); kokoro(); });
    } else if (st.state === "missing") {
      $("kStatus").textContent = "Natural Kokoro voices that run on this computer. One download of about " + Math.round((st.downloadBytes || 0) / 1e6) + " MB, the first time you listen.";
      acts.innerHTML = '<button class="btn" id="kGet">' + I("download") + "<span>Download now</span></button>";
      $("kGet").addEventListener("click", async () => {
        $("kGet").disabled = true;
        try { await V.downloadKokoro((p) => { $("kStatus").textContent = "Downloading " + Math.round(p * 100) + "%"; }); } catch (e) { $("kStatus").textContent = e.message; }
        kokoro();
      });
    } else if (st.state === "downloading") {
      $("kStatus").textContent = "Downloading " + Math.round(st.progress * 100) + "%";
      setTimeout(kokoro, 1000);
    } else {
      $("kStatus").textContent = "This browser cannot run Polycarp\u2019s voices.";
      acts.textContent = "";
    }
  }

  // ---------- Data ----------
  function bindData() {
    $("export").addEventListener("click", async () => {
      const B = globalThis.PolycarpBackup;
      const backup = await B.make();
      const blob = new Blob([B.stringify(backup)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: B.fileName(new Date()) });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      $("dataNote").textContent = "Backup saved to your downloads. " + B.describe(backup);
    });
    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const j = globalThis.PolycarpBackup.upgrade(JSON.parse(await f.text()));
        if (j.app !== "polycarp" || !j.data) throw new Error("This is not a Polycarp backup.");
        const keep = Object.fromEntries(Object.entries(j.data).filter(([k]) => k.startsWith("polycarp.")));
        await chrome.storage.local.set(keep);
        let lib = null;
        if (j.library && globalThis.PolycarpLibrary) lib = await PolycarpLibrary.importData(j.library);
        s = await P.getSettings(); sync(); bindLibrary();
        $("dataNote").textContent = "Restored your settings and memory garden" +
          (lib ? ", plus " + lib.items + (lib.items === 1 ? " library item" : " library items") + " and " + lib.notes + (lib.notes === 1 ? " note" : " notes") : "") + ", from " + f.name + ".";
      } catch (err) { $("dataNote").textContent = err.message; }
    });
    $("resetSettings").addEventListener("click", async () => {
      if (!confirm("Reset every setting to the default? Your stats, library and memory garden stay.")) return;
      s = await P.setSettings(P.clone(P.DEFAULTS)); sync();
      $("dataNote").textContent = "Settings reset.";
    });
  }

  // ---------- Pause ----------
  function bindPause() {
    const acts = $("pauseActs");
    const mk = (label, msg, cls) => { const b = document.createElement("button"); b.className = "btn" + (cls ? " " + cls : ""); b.textContent = label; b.addEventListener("click", () => chrome.runtime.sendMessage(msg)); acts.appendChild(b); };
    mk("1 hour", { type: "polycarp:pause", minutes: 60 });
    mk("Until tomorrow", { type: "polycarp:pause", until: "tomorrow" });
    mk("Resume now", { type: "polycarp:resume" }, "quiet");
  }
  function paintPause() {
    const note = $("pauseNote"); if (!note) return;
    const paused = P.paused ? P.paused(s, Date.now()) : false;
    note.textContent = paused
      ? "Paused until " + new Date(s.pausedUntil).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + "."
      : "Pause Polycarp on every site for a while. It comes back on its own.";
    const btns = $("pauseActs").children;
    if (btns.length === 3) btns[2].hidden = !paused;
  }

  // ---------- NAS ----------
  async function bindNas() {
    const N = globalThis.PolycarpNAS;
    if (!N) return;
    try {
      const c = await N.getConfig();
      if (c && c.url) {
        let host = c.url; try { host = new URL(c.url).host; } catch (e) {}
        $("nasNote").textContent = "Connected to " + host + (c.autoBackup ? ". Daily backup is on." : ".");
        document.querySelector('a[href="search.html#nasBlock"]').textContent = "Manage";
      }
    } catch (e) { /* not connected */ }
  }

  // ---------- Library ----------
  async function bindLibrary() {
    const L = globalThis.PolycarpLibrary;
    if (!L) { $("libCount").textContent = "Open the Library to see your items."; return; }
    try {
      const [items, notes] = await Promise.all([L.allItems(), L.allNotes()]);
      $("libCount").textContent = items.length
        ? items.length + (items.length === 1 ? " item" : " items") + " and " + notes.length + (notes.length === 1 ? " note" : " notes")
        : "Empty so far. Anything you open in the Reader is added.";
    } catch (e) { $("libCount").textContent = "Could not count your items. Open the Library to see them."; }
  }

  // ---------- About ----------
  function bindAbout() {
    const m = chrome.runtime.getManifest();
    $("ver").textContent = "Polycarp " + (m.version_name || m.version);
    if (m.update_url) {
      // A Chrome Web Store copy: the store updates it, and talking to the Polycarp app is a permission the user grants here.
      $("updText").textContent = "The Chrome Web Store keeps this extension up to date.";
      $("checkUpd").hidden = true;
      const optional = (m.optional_permissions || []).includes("nativeMessaging");
      const showApp = async () => {
        const has = await chrome.permissions.contains({ permissions: ["nativeMessaging"] }).catch(() => false);
        $("appRow").hidden = !optional;
        $("appConnect").hidden = has;
        $("appText").textContent = has ? "Connected. If the Polycarp app is on this computer, its filters and settings reach this browser."
          : "If the Polycarp app is on this computer, connect to it so its filters and settings reach this browser.";
      };
      $("appConnect").addEventListener("click", async () => {
        await chrome.permissions.request({ permissions: ["nativeMessaging"] }).catch(() => false);
        showApp();
      });
      showApp();
    }
    $("checkUpd").addEventListener("click", async () => {
      $("updNote").textContent = "Checking for updates...";
      const r = await chrome.runtime.sendMessage({ type: "polycarp:checkUpdate" }).catch((e) => ({ status: "error", message: e.message }));
      const msg = {
        update_available: "Update " + ((r && r.version) || "") + " found. Polycarp restarts with it as soon as no Reader tab is open.",
        no_update: "You have the newest version on this computer."
      }[r && r.status] || "Could not check right now" + (r && r.message ? ": " + r.message : "") + ". Polycarp checks again on its own.";
      $("updNote").textContent = msg;
    });
  }

  sync();
})();
