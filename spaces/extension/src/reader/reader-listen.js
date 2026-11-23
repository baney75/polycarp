/* Polycarp Reader, listening. Reads paragraphs aloud with Kokoro voices that run on this computer,
   lights the sentence and the word being spoken, and keeps the page in step. The first Play
   downloads the voice once, with progress in the dock.
   Reading while listening (dual coding of print and speech) helps weaker decoders follow longer
   text; it is offered, never forced. */
(function () {
  "use strict";
  const R = globalThis.PolycarpReader;
  const V = globalThis.PolycarpVoice;
  const I = globalThis.PolycarpIcons.icon;
  const $ = (id) => document.getElementById(id);
  const RATES = [0.8, 1, 1.15, 1.3, 1.5, 1.75, 2];
  const BATCH = 300;

  let ctl = null, base = 0, lastSeg = -1, open = false, voices = [];
  const hl = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";

  $("tListen").addEventListener("click", () => R.toggleListen());
  if (!V) { $("tListen").hidden = true; return; }
  $("lPrev").innerHTML = I("skipB");
  $("lNext").innerHTML = I("skipF");
  $("lClose").innerHTML = I("x");
  setPlayIcon(false);

  function setPlayIcon(playing) {
    $("lPlay").innerHTML = I(playing ? "pause" : "play");
    $("lPlay").setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  function status(html) { $("lStatus").innerHTML = html; }
  const voiceName = () => { const v = voices.find((x) => x.id === R.settings.reader.voice); return v ? v.name : "Voice"; };

  async function fillVoices() {
    voices = await V.listVoices();
    $("voice").innerHTML = voices.map((v) => '<option value="' + R.esc(v.id) + '">' + R.esc(v.name) + "</option>").join("");
    let want = R.settings.reader.voice;
    if (!voices.some((v) => v.id === want)) want = voices[0].id;
    $("voice").value = want;
    await showReady();
  }
  // Says what Play will do. Returns false only when this browser cannot run the voices at all.
  async function showReady() {
    const st = await V.kokoroStatus();
    if (st.state === "unsupported") { status("This browser cannot run Polycarp's voices."); $("lPlay").disabled = true; return false; }
    if (st.state === "missing") status("First play downloads the voice, " + Math.round((st.downloadBytes || 0) / 1e6) + " MB");
    else if (st.state === "downloading") status("Downloading the voice, " + Math.round(st.progress * 100) + "%");
    else status(R.esc(voiceName()) + " · ready");
    return true;
  }
  // Download progress while Play waits for the first download, from here or from Settings.
  V.onStatus((st) => {
    if (!open || st.state !== "downloading") return;
    status("Downloading the voice, " + Math.round(st.progress * 100) + "%");
  });

  R.toggleListen = function () {
    open = !open;
    $("dock").hidden = !open;
    document.body.classList.toggle("docked", open);
    $("tListen").setAttribute("aria-pressed", String(open));
    if (open) { if (!voices.length) fillVoices(); else showReady(); $("lPlay").focus(); }
    else stop();
  };

  function stop() {
    if (ctl) { try { ctl.stop(); } catch (e) {} }
    ctl = null; lastSeg = -1; R.busy = false; R.lockCur = false;
    setPlayIcon(false);
    if (hl) { CSS.highlights.delete("polycarp-word"); CSS.highlights.delete("polycarp-sent"); }
  }

  function start(from) {
    stop();
    base = Math.max(0, from);
    const segs = [];
    for (let i = base; i < Math.min(R.blocks.length, base + BATCH); i++) segs.push({ id: i, text: R.blocks[i].textContent });
    if (!segs.length) return;
    R.busy = true; R.lockCur = true;
    ctl = V.speak(segs, {
      voice: $("voice").value,
      dialogue: R.settings.reader.dialogue || "auto",
      rate: R.settings.reader.rate || 1,
      onState(s) {
        setPlayIcon(s === "playing" || s === "loading");
        if (s === "loading") V.kokoroStatus().then((st) => { if (ctl && ctl.state === "loading" && st.state !== "downloading") status("Warming up " + R.esc(voiceName()) + "…"); });
        else if (s === "playing") status(R.esc(voiceName()) + " · reading");
        else if (s === "paused") status("Paused");
        R.busy = s === "playing" || s === "loading";
      },
      onSegment(id) {
        if (lastSeg >= 0 && id === lastSeg + 1) R.markDone(lastSeg, "listen");
        lastSeg = id;
        R.setCur(id);
        if (R.settings.reader.follow !== false) R.blocks[id].scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        if (hl) { const r = document.createRange(); r.selectNodeContents(R.blocks[id]); CSS.highlights.set("polycarp-sent", new Highlight(r)); }
      },
      onWord(id, a, b) {
        if (!hl) return;
        const r = rangeIn(R.blocks[id], a, b);
        if (r) CSS.highlights.set("polycarp-word", new Highlight(r));
      },
      onEnd() {
        if (lastSeg >= 0) R.markDone(lastSeg, "listen");
        const next = base + BATCH;
        if (next < R.blocks.length) start(next);
        else { stop(); status("Finished reading aloud"); }
      },
      onError(e) {
        stop();
        status(R.esc(e.message || "The voice stopped."));
      }
    });
  }

  // Map character offsets in a block's text to a DOM range across its text nodes.
  function rangeIn(el, a, b) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let pos = 0, n, r = null;
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length;
      if (!r && a < pos + len) { r = document.createRange(); r.setStart(n, a - pos); }
      if (r && b <= pos + len) { r.setEnd(n, b - pos); return r; }
      pos += len;
    }
    return null;
  }

  $("lPlay").addEventListener("click", async () => {
    if (ctl && ctl.state === "playing") return ctl.pause();
    if (ctl && ctl.state === "paused") return ctl.resume();
    if (!(await showReady())) return;
    start(R.cur);
  });
  $("lPrev").addEventListener("click", () => { if (ctl) ctl.seek(Math.max(0, ctl.segmentIndex - 1)); else R.go(R.cur - 1); });
  $("lNext").addEventListener("click", () => { if (ctl) ctl.seek(ctl.segmentIndex + 1); else R.go(R.cur + 1); });
  $("lClose").addEventListener("click", () => R.toggleListen());
  $("lRate").addEventListener("click", () => {
    const cur = R.settings.reader.rate || 1;
    const next = RATES[(RATES.findIndex((x) => x >= cur - 0.001) + 1) % RATES.length];
    $("lRate").textContent = next + "×";
    if (ctl) ctl.setRate(next);
    R.patch({ reader: { rate: next } }, true);
  });
  $("voice").addEventListener("change", async () => {
    const was = ctl && (ctl.state === "playing" || ctl.state === "loading");
    R.patch({ reader: { voice: $("voice").value } }, true);
    stop();
    if ((await showReady()) && was) start(R.cur);
  });
  // While listening, a click on a paragraph jumps the voice there.
  $("article").addEventListener("click", (e) => {
    if (!ctl || !getSelection().isCollapsed || e.target.closest("a, button, input, .checkpoint")) return;
    const b = e.target.closest(".blk");
    if (b) start(Number(b.dataset.b));
  });
  R.on("settings", (s) => { $("lRate").textContent = (s.reader.rate || 1) + "×"; });
  addEventListener("pagehide", stop);
})();
