/* Polycarp backup: the one place that builds a full backup.
   Runs in extension pages and in the service worker (no DOM needed).
   Format, unchanged from the Settings export:
   { app: "polycarp", version, at, data: <all of chrome.storage.local>, library: { items, notes } | null }
   Keys that hold secrets (the saved NAS password) are left out. */
(function () {
  "use strict";

  // Never written into a backup file, even when the user chose to remember them.
  const SECRET_KEYS = ["polycarp.nasPass"];

  function dayKey(d) {
    d = d || new Date();
    if (globalThis.Polycarp && typeof globalThis.Polycarp.dayKey === "function") return globalThis.Polycarp.dayKey(d);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  async function make() {
    const all = await chrome.storage.local.get(null);
    for (const k of SECRET_KEYS) delete all[k];
    const L = globalThis.PolycarpLibrary;
    let library = null;
    try { library = L ? await L.exportData() : null; } catch (e) { library = null; }
    const m = chrome.runtime.getManifest();
    return { app: "polycarp", version: m.version_name || m.version, at: new Date().toISOString(), data: all, library };
  }

  function stringify(backup) { return JSON.stringify(backup, null, 2); }

  function fileName(d) { return "polycarp-backup-" + dayKey(d) + ".json"; }

  // A short line for the user: what the backup holds.
  function describe(backup) {
    const lib = backup && backup.library;
    if (!lib) return "It has your settings and memory garden, but not your library.";
    const n = lib.items.length, m = lib.notes.length;
    const audio = lib.items.filter((i) => i.kind === "audio").length;
    return "It has " + n + (n === 1 ? " library item" : " library items") + " and " + m + (m === 1 ? " note" : " notes") + "." +
      (audio ? " Audio files are not included; keep your own copies." : "");
  }

  // A backup from the reading extension that became Polycarp's carries its old app name and key
  // prefix; read it as a Polycarp backup. Anything else passes through unchanged.
  function upgrade(j) {
    if (j && j.data && j.app === "phont") return Object.assign({}, j, { app: "polycarp", data: Object.fromEntries(Object.entries(j.data).map(([k, v]) => [k.replace(/^phont\./, "polycarp."), v])) });
    return j;
  }

  globalThis.PolycarpBackup = { make, stringify, fileName, describe, upgrade, SECRET_KEYS };
})();
