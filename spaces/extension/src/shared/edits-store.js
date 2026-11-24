/* Polycarp page edits: what the extension keeps about them, for the popup, the Settings page, the notice and the editor.
   The app's edits are only read here: switching one off is this browser's own note about it (E.OFF_KEY). */
(function () {
  "use strict";
  const E = globalThis.PolycarpEdits;
  const SEEN_KEY = "polycarp.edits.seen"; // app edits the person has kept: { id: fingerprint }
  const get = (keys) => chrome.storage.local.get(keys);
  const set = (key, v) => chrome.storage.local.set({ [key]: v });
  const object = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

  // { edits, refused, app: { connected, error } }
  async function load() {
    const got = await get([E.APP_KEY, E.LOCAL_KEY, E.OFF_KEY]);
    const app = object(got[E.APP_KEY]);
    return Object.assign(E.merge(app.edits, got[E.LOCAL_KEY], got[E.OFF_KEY]), { app: { connected: !!app.connected, error: app.error || "" } });
  }
  async function locals() {
    const v = (await get(E.LOCAL_KEY))[E.LOCAL_KEY];
    return Array.isArray(v) ? v : [];
  }
  // Adds or replaces one of this browser's own edits; null takes it away. Answers why not, or "".
  async function put(id, edit) {
    const all = await locals();
    const at = all.findIndex((e) => e && e.id === id);
    if (!edit) { if (at >= 0) { all.splice(at, 1); await set(E.LOCAL_KEY, all); } return ""; }
    const r = E.check(edit);
    if (!r.edit) return r.path + " " + r.why;
    if (at < 0 && all.length >= E.MAX.edits) return "there are " + E.MAX.edits + " edits already; delete one first";
    if (at < 0) all.push(r.edit); else all[at] = r.edit;
    await set(E.LOCAL_KEY, all);
    return "";
  }
  async function turn(edit, on) {
    if (edit.source === "local") {
      const all = await locals();
      const e = all.find((x) => x && x.id === edit.id);
      if (e) { e.enabled = on; await set(E.LOCAL_KEY, all); }
      return;
    }
    const off = object((await get(E.OFF_KEY))[E.OFF_KEY]);
    if (on) delete off[edit.id]; else off[edit.id] = E.fingerprint(edit);
    await set(E.OFF_KEY, off);
  }
  async function unseen(edits) {
    const seen = object((await get(SEEN_KEY))[SEEN_KEY]);
    return edits.filter((e) => e.source === "app" && seen[e.id] !== E.fingerprint(e));
  }
  async function keep(edits) {
    const seen = object((await get(SEEN_KEY))[SEEN_KEY]);
    for (const e of edits) seen[e.id] = E.fingerprint(e);
    await set(SEEN_KEY, seen);
  }
  const KEYS = [E.APP_KEY, E.LOCAL_KEY, E.OFF_KEY];
  const changed = (changes, area) => area === "local" && KEYS.some((k) => changes[k]);

  globalThis.PolycarpEditsStore = { SEEN_KEY, KEYS, load, put, turn, unseen, keep, changed };
})();
