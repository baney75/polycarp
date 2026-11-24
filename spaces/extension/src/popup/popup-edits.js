/* Popup: the edits for the page in front, each with a switch. */
(async function () {
  "use strict";
  const E = globalThis.PolycarpEdits, S = globalThis.PolycarpEditsStore;
  const box = document.getElementById("edits"), ul = document.getElementById("editsList");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let at;
  try { at = new URL(tab.url); } catch (e) { return; }
  if (!/^https?:$/.test(at.protocol)) return;

  async function render() {
    const { edits } = await S.load();
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
      const idle = r && !r.css && r.changes.every((c) => !c.hits);
      small.textContent = (e.source === "app" ? "By your agent" : "By you") + (idle ? ", and nothing here matches it" : "");
      sw.className = "switch";
      input.type = "checkbox";
      input.checked = e.enabled;
      input.dataset.key = key;
      input.addEventListener("change", () => S.turn(e, input.checked));
      words.append(name, small);
      sw.append(input);
      label.append(words, sw);
      li.append(label);
      ul.append(li);
    }
    box.hidden = !here.length;
    const again = held && [...ul.querySelectorAll("input")].find((x) => x.dataset.key === held);
    if (again) again.focus();
  }
  chrome.storage.onChanged.addListener((ch, area) => { if (S.changed(ch, area)) setTimeout(render, 80); });
  render();
})();
