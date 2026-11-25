/* Polycarp service worker: install and update flow, menus, shortcuts, stats and reminders. */
importScripts("shared/core.js");
try { importScripts("shared/memory.js"); } catch (e) { /* memory engine optional at load */ }
try { importScripts("shared/library.js"); } catch (e) { /* library optional at load */ }
try { importScripts("shared/backup.js", "shared/nas.js"); } catch (e) { /* NAS optional at load */ }
try { importScripts("shared/filters.js"); } catch (e) { /* feed filters optional at load */ }
try { importScripts("shared/edits.js"); } catch (e) { /* page edits optional at load */ }

const P = globalThis.Polycarp;
const READER = "src/reader/reader.html";

// ---------- Install and update ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await P.getSettings();
  await P.setSettings(settings); // writes defaults or migrates an older schema
  if (details.reason === "install") {
    await chrome.storage.local.set({ [SEEN_VERSION]: runningVersion() });
    chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/welcome.html") });
  } else await noteVersion(details.previousVersion);
  buildMenus();
  injectIntoOpenTabs();
  refreshBadge();
  chrome.alarms.create("polycarp-badge", { periodInMinutes: 30 });
  nasAlarm();
});

// An app update changes only version_name (the app's full version), not version, so the last version seen is kept
// here and compared on every update and browser start; a change lists what is new in the popup.
const SEEN_VERSION = "polycarp.seenVersion";
async function noteVersion(previous) {
  const now = runningVersion();
  const seen = (await chrome.storage.local.get(SEEN_VERSION))[SEEN_VERSION] || previous || "";
  if (seen && seen !== now) await chrome.storage.local.set({ "polycarp.whatsNew": { from: seen, to: now, seen: false } });
  if (seen !== now) await chrome.storage.local.set({ [SEEN_VERSION]: now });
}

// The daily NAS backup alarm can go missing after a browser update; put it back.
function nasAlarm() { const N = globalThis.PolycarpNAS; if (N && N.ensureAlarm) N.ensureAlarm().catch(() => {}); }
chrome.runtime.onStartup.addListener(() => { refreshBadge(); nasAlarm(); noteVersion(); });

// Polycarp's app ships this extension inside Polycarp.app, and Helium runs it unpacked from there; without the app it
// runs unpacked from a checkout. When the app or the checkout updates, the files on disk change but the running copy does not. Compare the
// version on disk with the running one; when they differ, reload right away unless a Polycarp
// page (Reader, Review) is open, in which case wait until those tabs close.
let updatePending = false;
const runningVersion = () => { const m = chrome.runtime.getManifest(); return m.version_name || m.version; };
async function diskVersion() {
  try {
    const m = await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json();
    return m.version_name || m.version || "";
  } catch (e) { return ""; }
}
async function checkDisk() {
  const disk = await diskVersion();
  if (disk && disk !== runningVersion()) { updatePending = true; tryApplyUpdate(); }
  return disk;
}
chrome.tabs.onRemoved.addListener(() => { if (updatePending) setTimeout(tryApplyUpdate, 500); });
chrome.tabs.onActivated.addListener(() => { if (updatePending) setTimeout(tryApplyUpdate, 500); });
async function tryApplyUpdate() {
  if (!updatePending) return;
  try {
    // Any other Polycarp page (Reader, Library, Review) holds the update back. A new tab holds it back only while it
    // is the tab in front of its window, where someone may be typing; a reload closes it, and one in the background
    // has nothing to lose.
    // Tab ids, not URLs: without the tabs permission an overridden new tab's URL is not ours to read.
    const NEWTAB = /\/newtab\//;
    const tabs = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
    if (tabs.some((c) => !NEWTAB.test(c.documentUrl || ""))) return;
    const front = new Set((await chrome.tabs.query({ active: true })).map((t) => t.id));
    if (tabs.some((c) => front.has(c.tabId))) return;
  } catch (e) { /* older Chrome: fall through */ }
  chrome.runtime.reload();
}
// A Chrome Web Store copy (its manifest has an update_url) is updated by the store; there is no disk copy to watch.
if (!chrome.runtime.getManifest().update_url) {
  chrome.runtime.onStartup.addListener(checkDisk);
  chrome.alarms.get("polycarp-update").then((a) => { if (!a) chrome.alarms.create("polycarp-update", { periodInMinutes: 15 }); });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "polycarp-update") checkDisk(); });

async function injectIntoOpenTabs() {
  const manifest = chrome.runtime.getManifest();
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (tab.discarded) continue;
    for (const cs of manifest.content_scripts) { // each runs on every page
      if (cs.css) chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: cs.css }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js }).catch(() => {});
    }
  }
}

// ---------- The page editor (src/content/editor.js) ----------
// Asked for again, it closes. Answers whether the page could take it.
async function editPage(tab) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/shared/core.js", "src/shared/edits.js", "src/shared/edits-store.js", "src/shared/edits-pick.js", "src/content/editor.js"] });
    return !!(res && res.result);
  } catch (e) { return false; }
}

// "Share with my agent" in the popup: the page's parts go to the Polycarp app on this computer, which keeps them for an
// hour for the person's agents. `tabId` null takes back what was shared. Answers { ok } or { ok: false, error }.
const SHARED_KEY = "polycarp.shared"; // session storage: { url, title, at } of the page last shared
async function sharePage(tabId) {
  let page = null;
  if (tabId !== null) {
    try {
      const target = { tabId };
      await chrome.scripting.executeScript({ target, files: ["src/shared/edits.js", "src/shared/edits-pick.js", "src/shared/edits-outline.js"] });
      const [res] = await chrome.scripting.executeScript({ target, func: () => {
        const p = globalThis.Polycarp && globalThis.Polycarp.pageEdits;
        return globalThis.PolycarpEditsOutline.page(document, p ? p.report() : []);
      } });
      page = res && res.result;
    } catch (e) { page = null; }
    if (!page) return { ok: false, error: "This page can't be shared" };
    if (!page.parts.length) return { ok: false, error: "Nothing on this page to share" };
  }
  const r = await askFiltersHost({ op: "sharePage", page });
  if (!r || r.ok !== true) {
    const why = String((r && (r.error || r.failed)) || "");
    return { ok: false, error: why === "there is no request called sharePage" ? "Update Polycarp on this computer to share pages" : r && r.failed ? "Polycarp on this computer didn't answer" : "Polycarp refused it: " + (why || "no reason given").slice(0, 200) };
  }
  if (page) await chrome.storage.session.set({ [SHARED_KEY]: { url: page.url, title: page.title, at: Date.now() } });
  else await chrome.storage.session.remove(SHARED_KEY);
  return { ok: true };
}

// ---------- Menus ----------
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "reader", title: "Open in Polycarp Reader", contexts: ["page"] });
    chrome.contextMenus.create({ id: "reader-link", title: "Open link in Polycarp Reader", contexts: ["link"] });
    chrome.contextMenus.create({ id: "remember", title: "Remember this with Polycarp", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "note-selection", title: "Highlight in Polycarp", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "save-page", title: "Save page to your Polycarp library", contexts: ["page"] });
    chrome.contextMenus.create({ id: "save-link", title: "Save link to your Polycarp library", contexts: ["link"] });
    chrome.contextMenus.create({ id: "edit-page", title: "Edit this page with Polycarp", contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
    chrome.contextMenus.create({ id: "site", title: "Turn Polycarp on or off for this site", contexts: ["page"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "reader") openReaderForTab(tab);
  else if (info.menuItemId === "reader-link") openReader({ src: info.linkUrl });
  else if (info.menuItemId === "site") toggleSite(tab);
  else if (info.menuItemId === "edit-page") editPage(tab);
  else if (info.menuItemId === "remember") rememberFromTab(info.selectionText, tab);
  else if (info.menuItemId === "save-page") saveTab(tab).then((it) => tell(tab, it ? "Saved to your library" : "Could not save this page", it ? it.title : ""));
  else if (info.menuItemId === "save-link") saveLinkOnly(info.linkUrl, info.selectionText || "").then((it) => tell(tab, it ? "Link saved to your library" : "Could not save that link", it ? it.title : ""));
  else if (info.menuItemId === "note-selection") noteSelection(info.selectionText, tab).then((ok) => tell(tab, ok ? "Highlighted" : "Could not save that highlight", ok ? "Saved with this page in your library." : ""));
});

// ---------- Library ----------
// Saves the page's readable text, so the Library can connect it to everything else.
function tell(tab, name, desc) {
  if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: "polycarp:events", events: [{ type: "badge", name, desc }] }).catch(() => {});
}
async function pageText(tab) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const root = document.querySelector("article, main, [role=main]") || document.body;
        const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
        const h1 = document.querySelector("h1");
        const og = document.querySelector('meta[property="og:title"]');
        return {
          title: (og && og.content) || document.title || (h1 && h1.textContent) || "",
          text: root ? String(root.innerText || "").slice(0, 300000) : "",
          excerpt: meta ? meta.content : ""
        };
      }
    });
    return (res && res.result) || null;
  } catch (e) { return null; }
}
async function saveTab(tab) {
  const L = globalThis.PolycarpLibrary;
  if (!L || !tab || !/^https?:/i.test(tab.url || "")) return null;
  const page = isPdfUrl(tab.url) ? null : await pageText(tab);
  return L.saveLink({ url: tab.url, title: (page && page.title) || tab.title || "", text: page ? page.text : "", excerpt: page ? page.excerpt : "" }).catch(() => null);
}
async function saveLinkOnly(url, title) {
  const L = globalThis.PolycarpLibrary;
  if (!L || !/^https?:/i.test(url || "")) return null;
  return L.saveLink({ url, title }).catch(() => null);
}
async function noteSelection(text, tab) {
  const L = globalThis.PolycarpLibrary;
  const quote = String(text || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!L || !quote || !tab) return false;
  const item = (await L.itemByUrl(tab.url)) || (await saveTab(tab));
  if (!item) return false;
  await L.addNote({ itemId: item.id, quote, text: "" });
  return true;
}

// Ask the page for an exact link back to the passage (the post on X, the moment in a video,
// or a text fragment), then plant the card.
async function rememberFromTab(text, tab) {
  let where = null;
  try { where = await chrome.tabs.sendMessage(tab.id, { type: "polycarp:where", text }, { frameId: 0 }); } catch (e) {}
  return remember(text, tab, where && where.url);
}

async function remember(text, tab, exactUrl) {
  const M = globalThis.PolycarpMemory;
  if (!M || !text) return false;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 600);
  const stats = M.docStats ? M.docStats(clean) : null;
  const cloze = M.makeCloze ? M.makeCloze(clean, stats) : null;
  const source = { title: tab && tab.title, url: exactUrl || (tab && tab.url), docKey: tab && tab.url, section: null };
  const card = cloze
    ? M.newCard({ type: "cloze", prompt: cloze.prompt, answer: cloze.answer, hint: cloze.hint, context: clean, source }, Date.now())
    : M.newCard({ type: "quote", prompt: "Recall this passage in your own words.", answer: clean, hint: "", context: clean, source }, Date.now());
  const added = await M.add(card);
  if (!added) {
    if (tab && tab.id) tell(tab, "Already in your garden", "Polycarp is already growing this idea.");
    return true;
  }
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "polycarp:events", events: [{ type: "badge", name: "Seed planted", desc: "Polycarp will ask you about this tomorrow" }] }).catch(() => {});
  }
  refreshBadge();
  return true;
}

// ---------- Commands ----------
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (cmd === "toggle-page") toggleSite(tab);
  else if (cmd === "open-reader") openReaderForTab(tab);
  else if (cmd === "open-finder") openFinder(tab);
  else if (cmd === "edit-page") editPage(tab);
  else if (cmd === "toggle-ruler") {
    const s = await P.getSettings();
    await P.patchSettings({ ruler: { on: !s.ruler.on } }, { keepProfile: true });
  }
});

async function openFinder(tab) {
  if (!tab || !tab.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "polycarp:find" }, { frameId: 0 }); }
  catch (e) { openSearch(""); } // no content script here (a browser page): open Polycarp Search instead
}

function openSearch(q, extra) {
  const params = new URLSearchParams(Object.assign(q ? { q } : {}, extra || {})).toString();
  return chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/search.html") + (params ? "?" + params : "") });
}

// ---------- Pause ----------
async function pause(minutes, until) {
  let end = Date.now() + (minutes || 60) * 60000;
  if (until === "tomorrow") { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(6, 0, 0, 0); end = d.getTime(); }
  await P.patchSettings({ pausedUntil: end }, { keepProfile: true });
  chrome.alarms.create("polycarp-resume", { when: end + 500 });
  return end;
}
async function resume() {
  await P.patchSettings({ pausedUntil: 0 }, { keepProfile: true });
  chrome.alarms.clear("polycarp-resume");
}

async function toggleSite(tab) {
  if (!tab || !tab.url) return;
  const host = P.hostOf(tab.url);
  if (!host) return;
  const s = await P.getSettings();
  const now = P.activeFor(s, host);
  const sites = { ...s.sites };
  const want = !now;
  if (want === !!s.autoApply && s.enabled) delete sites[host];
  else sites[host] = want ? "on" : "off";
  s.sites = sites;
  if (want && !s.enabled) s.enabled = true;
  await P.setSettings(s);
}

// ---------- Reader ----------
function isPdfUrl(url) {
  try { return /\.pdf$/i.test(new URL(url).pathname); } catch (e) { return false; }
}

async function openReader(params) {
  const q = new URLSearchParams(params).toString();
  return chrome.tabs.create({ url: chrome.runtime.getURL(READER) + (q ? "?" + q : "") });
}

async function openReaderForTab(tab, extra) {
  if (!tab) return;
  const url = tab.url || "";
  if (url.startsWith(chrome.runtime.getURL(""))) return;
  let state = null;
  try { state = await chrome.tabs.sendMessage(tab.id, { type: "polycarp:state" }); } catch (e) {}
  if (isPdfUrl(url) || (state && state.isPdf)) return openReader({ src: url, ...extra });
  let snap = null;
  try { snap = await chrome.tabs.sendMessage(tab.id, { type: "polycarp:snapshot" }); } catch (e) {}
  if (!snap) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({ html: "<!doctype html>" + document.documentElement.outerHTML, url: location.href, title: document.title })
      });
      snap = res && res.result;
    } catch (e) {}
  }
  if (!snap) return openReader({ src: url, ...extra });
  const id = "doc-" + Date.now();
  await chrome.storage.session.set({ [id]: snap });
  return openReader({ doc: id, ...extra });
}

// Open a page in a background tab, let Polycarp's site helper build its Reader doc (a YouTube
// transcript loads after the page), open that in the Reader, then close the helper tab.
async function readUrl(url) {
  if (!/^https?:/.test(url || "")) return false;
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 500));
      const cur = await chrome.tabs.get(tab.id).catch(() => null);
      if (!cur) return false;
      if (cur.status !== "complete") continue;
      let st = null;
      try { st = await chrome.tabs.sendMessage(tab.id, { type: "polycarp:state" }); } catch (e) {}
      if (st) break;
    }
    await openReaderForTab(await chrome.tabs.get(tab.id));
    return true;
  } catch (e) {
    await openReader({ src: url });
    return false;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------- Messages ----------
let statsChain = Promise.resolve();
function record(ev) {
  const job = statsChain.then(async () => {
    const [stats, settings] = await Promise.all([P.getStats(), P.getSettings()]);
    const out = P.recordReading(stats, ev, settings.goal, new Date());
    await chrome.storage.local.set({ [P.STATS_KEY]: out.stats });
    return out.events;
  });
  statsChain = job.catch(() => {});
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "polycarp:read") {
    record({ words: msg.words, kind: msg.kind, sprint: msg.sprint, finished: msg.finished, print: msg.print })
      .then((events) => reply({ events })).catch(() => reply({ events: [] }));
    return true;
  }
  if (msg.type === "polycarp:openReader") {
    openReader({ src: msg.url }).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === "polycarp:openReaderForTab") {
    chrome.tabs.get(msg.tabId).then((tab) => openReaderForTab(tab, msg.extra || {})).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === "polycarp:toggleSite") {
    (msg.tabId ? chrome.tabs.get(msg.tabId) : Promise.resolve(sender.tab)).then(toggleSite).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === "polycarp:pause") {
    pause(msg.minutes, msg.until).then((until) => reply({ ok: true, until }));
    return true;
  }
  if (msg.type === "polycarp:resume") { resume().then(() => reply({ ok: true })); return true; }
  if (msg.type === "polycarp:editPage") { if (!String(sender.url).startsWith(chrome.runtime.getURL("src/popup/"))) return; editPage({ id: msg.tabId }).then((ok) => reply({ ok })); return true; }
  if (msg.type === "polycarp:sharePage") { if (!String(sender.url).startsWith(chrome.runtime.getURL("src/popup/"))) return; sharePage(msg.tabId === null ? null : +msg.tabId).then(reply); return true; }
  if (msg.type === "polycarp:openSettings") { chrome.runtime.openOptionsPage(); return; }
  if (msg.type === "polycarp:openSearch") { openSearch(msg.q || "", msg.extra); return; }
  if (msg.type === "polycarp:find") {
    chrome.tabs.sendMessage(msg.tabId, { type: "polycarp:find", query: msg.query, group: msg.group }, { frameId: 0 })
      .then(reply, () => reply({ ok: false }));
    return true;
  }
  if (msg.type === "polycarp:readUrl") {
    readUrl(msg.url).then((ok) => reply({ ok }), () => reply({ ok: false }));
    return true;
  }
  if (msg.type === "polycarp:nasAlarm") {
    const N = globalThis.PolycarpNAS;
    if (N && N.ensureAlarm) N.ensureAlarm().catch(() => {});
    reply({ ok: true });
    return;
  }
  if (msg.type === "polycarp:readTab") {
    if (sender.tab) openReaderForTab(sender.tab);
    return;
  }
  if (msg.type === "polycarp:remember") {
    const tab = sender.tab ? Object.assign({}, sender.tab, { title: msg.title || sender.tab.title }) : null;
    remember(msg.text, tab, msg.url).then((ok) => reply({ ok: !!ok })).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === "polycarp:import") {
    // A library captured from a signed-in page (Audible, Kindle, any list). The Search page
    // indexes it, then shows what arrived.
    const key = "import-" + Date.now();
    chrome.storage.session.set({ [key]: { def: msg.def, items: msg.items } })
      .then(() => openSearch("", { import: key })).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  if (msg.type === "polycarp:checkUpdate") {
    checkDisk().then((disk) => reply(!disk ? { status: "error", message: "manifest unreadable" }
      : disk === runningVersion() ? { status: "no_update" } : { status: "update_available", version: disk }));
    return true;
  }
  if (msg.type === "polycarp:refreshBadge") { refreshBadge(); return; }
  if (msg.type === "polycarp:saveTab") {
    chrome.tabs.get(msg.tabId).then(saveTab).then((it) => reply(it ? { ok: true, id: it.id, title: it.title } : { ok: false })).catch(() => reply({ ok: false }));
    return true;
  }
});

// ---------- Badge: reviews due ----------
async function refreshBadge() {
  const M = globalThis.PolycarpMemory;
  let due = 0;
  try { if (M && M.load) due = M.counts(await M.load(), Date.now()).due; } catch (e) {}
  const v = P.themeVars(await P.themeCss(), "light");
  if (v.accent) chrome.action.setBadgeBackgroundColor({ color: v.accent });
  if (v["on-accent"] && chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: v["on-accent"] });
  chrome.action.setBadgeText({ text: due > 0 ? String(Math.min(due, 99)) : "" });
  chrome.action.setTitle({ title: due > 0 ? "Polycarp: " + due + " idea" + (due === 1 ? "" : "s") + " ready to review" : "Polycarp" });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "polycarp-badge") refreshBadge();
  else if (a.name === "polycarp-resume") resume();
  else if (globalThis.PolycarpNAS && a.name === globalThis.PolycarpNAS.ALARM) globalThis.PolycarpNAS.onAlarm(a).catch(() => {});
});

// ---------- Feed filters and page edits from the Polycarp app ----------
// The app's rules and edits come over native messaging ({op:"filters"} and {op:"edits"} to the new tab's host) and are
// kept in storage, where content scripts read them with this browser's own (merge in src/shared/filters.js and edits.js).
// Asked at browser start, every 30 seconds, when the app connection is granted, and when a page starts with an answer
// older than 5 seconds. Storage is written only when the answer changes, so open pages hear only real changes. With no
// app (the host missing, or the nativeMessaging permission not granted) there are none from it and nothing to report:
// the extension's own still work.
const FILTERS_HOST = "com.polycarp.newtab";
const FILTERS_ALARM = "polycarp-filters";
const FILTERS_AT = "polycarp.filters.appAt"; // session storage: when the app was last asked
let filtersAsking = null;
async function appConnected() {
  if (!chrome.runtime.sendNativeMessage || !chrome.permissions) return false;
  try { return await chrome.permissions.contains({ permissions: ["nativeMessaging"] }); } catch (e) { return false; }
}
function askFiltersHost(request) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(FILTERS_HOST, request, (reply) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { failed: String(err.message || err) } : reply);
      });
    } catch (e) { resolve({ failed: String(e && e.message || e) }); }
  });
}
// One list: ask for `op`, keep the reply's `op` list under `key` as { [field]: list, connected, error }.
async function keepAppList(op, key, field, most) {
  const cur = (await chrome.storage.local.get(key))[key] || null;
  let next;
  if (!(await appConnected())) next = { [field]: [], connected: false };
  else {
    const r = await askFiltersHost({ op });
    if (r && r.ok === true && Array.isArray(r[op])) next = { [field]: r[op].slice(0, most), connected: true };
    // No Polycarp on this computer (or not allowed to talk to it): nothing from it, and no error to show.
    else if (r && r.failed && /not found|forbidden/i.test(r.failed)) next = { [field]: [], connected: false };
    // An app from before this list existed.
    else if (r && r.ok === false && r.error === "there is no request called " + op) next = { [field]: [], connected: true };
    // The app answered with an error, or the call broke: keep the last list it sent and say why on the Settings page.
    else next = { [field]: (cur && cur[field]) || [], connected: true, error: (r && (r.error || r.failed)) ? String(r.error || r.failed).slice(0, 300) : "Polycarp gave no answer" };
  }
  if (JSON.stringify(next) !== JSON.stringify(cur)) await chrome.storage.local.set({ [key]: next });
}
function refreshAppFilters() {
  const F = globalThis.PolycarpFilters, E = globalThis.PolycarpEdits;
  if (filtersAsking) return filtersAsking;
  filtersAsking = Promise.allSettled([
    F ? keepAppList("filters", F.APP_KEY, "rules", 500) : null,
    E ? keepAppList("edits", E.APP_KEY, "edits", E.MAX.edits) : null
  ])
    // Only once both answers are kept: a page that asks before then waits for them.
    .then(() => chrome.storage.session.set({ [FILTERS_AT]: Date.now() })).catch(() => {})
    .finally(() => { filtersAsking = null; });
  return filtersAsking;
}
async function filtersFresh(maxAge) {
  const at = (await chrome.storage.session.get(FILTERS_AT).catch(() => ({})))[FILTERS_AT] || 0;
  if (Date.now() - at > maxAge) await refreshAppFilters();
}
chrome.alarms.get(FILTERS_ALARM).then((a) => { if (!a) chrome.alarms.create(FILTERS_ALARM, { periodInMinutes: 0.5 }); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === FILTERS_ALARM) refreshAppFilters(); });
chrome.runtime.onStartup.addListener(() => refreshAppFilters());
chrome.runtime.onInstalled.addListener(() => refreshAppFilters());
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => refreshAppFilters());
  chrome.permissions.onRemoved.addListener(() => refreshAppFilters());
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== "polycarp:filtersFresh") return;
  filtersFresh(5000).then(() => reply({ ok: true }), () => reply({ ok: false }));
  return true;
});

// ---------- Address bar: type "pc" then a space to search with Polycarp ----------
if (chrome.omnibox) {
  chrome.omnibox.setDefaultSuggestion({ description: "Search with Polycarp: your library, notes, YouTube, free books and your own sources" });
  chrome.omnibox.onInputEntered.addListener((text) => openSearch(text.trim()));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["polycarp.memory"]) refreshBadge();
});
