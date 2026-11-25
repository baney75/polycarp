/* Popup: the edits for the page in front, each with a switch. */
(async function () {
  "use strict";
  const P = globalThis.Polycarp, E = globalThis.PolycarpEdits, S = globalThis.PolycarpEditsStore;
  const box = document.getElementById("edits"), ul = document.getElementById("editsList");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let at;
  try { at = new URL(tab.url); } catch (e) { return; }
  if (!/^https?:$/.test(at.protocol)) return;

  async function render() {
    const [{ edits }, settings] = await Promise.all([S.load(), P.getSettings()]);
    const away = !settings.enabled || P.paused(settings) || settings.sites[P.hostOf(tab.url)] === "off";
    const here = edits.filter((e) => E.onSite(e, at.hostname) && E.onPath(e, at.pathname));
    const state = await chrome.tabs.sendMessage(tab.id, { type: "polycarp:edits" }, { frameId: 0 }).catch(() => null);
    const did = new Map(((state && state.edits) || []).map((e) => [e.source + ":" + e.id, e]));
    const held = document.activeElement && ul.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    ul.textContent = "";
    for (const e of here) {
      const key = e.source + ":" + e.id, r = did.get(key);
      const li = document.createElement("li"), label = document.createElement("label"), words = document.createElement("span");
      const name = document.createElement("b"), small = document.createElement("small"), sw = document.createElement("span"), input = document.createElement("input");
      name.textContent = e.name || E.summary(e);
      const idle = r && !r.css && r.changes.every((c) => !c.did) && (r.changes.find((c) => c.note) || { note: "nothing here to change" });
      const why = e.appOff ? "off in the Polycarp app" : away ? "Polycarp is off here" : idle ? idle.note : "";
      small.textContent = (e.source === "app" ? "By your agent" : "By you") + (e.name ? " · " + E.summary(e) : "") + (why ? " · " + why : "");
      sw.className = "switch";
      input.type = "checkbox";
      input.checked = e.enabled;
      input.disabled = !!e.appOff;
      input.dataset.key = key;
      input.addEventListener("change", () => S.turn(e, input.checked));
      words.append(name, small);
      sw.append(input);
      label.append(words, sw);
      li.append(label);
      ul.append(li);
    }
    const again = held && [...ul.querySelectorAll("input")].find((x) => x.dataset.key === held);
    if (again) again.focus();
  }
  chrome.storage.onChanged.addListener((ch, area) => { if (S.changed(ch, area) || (area === "local" && ch[P.SETTINGS_KEY])) setTimeout(render, 80); });
  document.getElementById("editPage").addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ type: "polycarp:editPage", tabId: tab.id }).catch(() => null);
    if (r && r.ok) window.close();
    else document.getElementById("editPage").textContent = "This page can't be edited";
  });

  // Sharing this page with the person's agents, through the app on this computer: shown only when there is one.
  const row = document.getElementById("share"), note = document.getElementById("shareNote"), go = document.getElementById("shareGo"), halt = document.getElementById("shareStop");
  const HOUR = 3600e3, KEY = "polycarp.shared";
  async function share(error) {
    row.hidden = !(await S.load()).app.connected;
    const got = (await chrome.storage.session.get(KEY))[KEY];
    const on = got && Date.now() - got.at < HOUR ? got : null;
    const until = on && new Date(on.at + HOUR).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const same = on && on.url === at.origin + at.pathname;
    note.textContent = error || (on ? "Shared until " + until + ": " + (same ? "this page" : on.title || on.url) : "Lets agents on this computer see this page's parts and words for an hour. Nothing you typed is sent.");
    go.textContent = same ? "Share again" : "Share with my agent";
    halt.hidden = !on;
  }
  async function send(tabId) {
    go.disabled = halt.disabled = true;
    const r = await chrome.runtime.sendMessage({ type: "polycarp:sharePage", tabId }).catch(() => null);
    go.disabled = halt.disabled = false;
    await share(r && r.ok ? "" : (r && r.error) || "That didn't work. Try again");
    go.focus();
  }
  go.addEventListener("click", () => send(tab.id));
  halt.addEventListener("click", () => send(null));
  chrome.storage.onChanged.addListener((ch, area) => { if (S.changed(ch, area)) share(); });

  box.hidden = false;
  render();
  share();
})();
