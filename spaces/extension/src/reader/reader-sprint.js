/* Polycarp Reader, Sprint: one word at a time in a fixed spot (rapid serial visual presentation).
   The eye never has to move or find the next line, which removes a step that wandering attention
   trips on. Moussaoui et al. (2025) found RSVP helped readers with ADHD symptoms. Comprehension
   drops at high speed (Rayner et al. 2016), so Sprint pauses longer on sentence ends and long words,
   always shows the sentence around the word, and starts at a calm 300 words a minute. */
(function () {
  "use strict";
  const R = globalThis.PolycarpReader;
  const I = globalThis.PolycarpIcons.icon;
  const $ = (id) => document.getElementById(id);
  const MAX_WORDS = 80000;

  let list = [], sents = [], at = 0, timer = 0, playing = false, warm = 0;
  const wpm = () => R.settings.reader.sprintWpm || 300;

  $("tSprint").addEventListener("click", () => R.startSprint());
  $("spClose").innerHTML = I("x");
  $("spBack").innerHTML = I("back");
  $("spFwd").innerHTML = I("next");
  $("spSlower").innerHTML = '<b aria-hidden="true">−</b>';
  $("spFaster").innerHTML = '<b aria-hidden="true">+</b>';

  function build(from) {
    list = []; sents = [];
    let s = -1, newSent = true;
    for (let b = from; b < R.blocks.length && list.length < MAX_WORDS; b++) {
      const words = R.blockText(b).split(/\s+/).filter(Boolean);
      words.forEach((w, k) => {
        if (newSent || k === 0) { s++; sents.push(list.length); newSent = false; }
        list.push({ w, b, s, first: k === 0, last: k === words.length - 1 });
        if (/[.!?…]["'”’)\]]*$/.test(w)) newSent = true;
      });
      newSent = true;
    }
  }
  function orp(word) {
    const core = word.replace(/^[^\p{L}\p{N}]+/u, "");
    const lead = word.length - core.length;
    const n = [...core.replace(/[^\p{L}\p{N}]+$/u, "")].length;
    return lead + (n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4);
  }
  function show() {
    const it = list[at];
    if (!it) return;
    const chars = [...it.w];
    const k = Math.min(orp(it.w), chars.length - 1);
    const el = $("spWord");
    el.children[0].textContent = chars.slice(0, k).join("");
    el.children[1].textContent = chars[k] || "";
    el.children[2].textContent = chars.slice(k + 1).join("");
    // The sentence around the word, so meaning is never lost.
    const a = sents[it.s], b = sents[it.s + 1] != null ? sents[it.s + 1] : list.length;
    const ctx = $("spCtx");
    ctx.textContent = "";
    for (let i = a; i < b && i < a + 60; i++) {
      if (i > a) ctx.appendChild(document.createTextNode(" "));
      if (i === at) { const m = document.createElement("mark"); m.textContent = list[i].w; ctx.appendChild(m); }
      else ctx.appendChild(document.createTextNode(list[i].w));
    }
    $("spFill").style.width = ((at + 1) / list.length) * 100 + "%";
    const left = list.length - at;
    $("spLeft").textContent = Math.max(1, Math.round(left / wpm())) + " min left";
  }
  function delay(it) {
    let f = 1;
    const len = [...it.w].length;
    if (len > 8) f += 0.3;
    if (len > 12) f += 0.3;
    if (/[.!?…]["'”’)\]]*$/.test(it.w)) f += 1.2;
    else if (/[,;:\u2014\u2013-]["'”’)\]]*$/.test(it.w)) f += 0.5;
    if (it.first) f += 0.6;
    if (warm > 0) { f += warm * 0.12; warm--; }
    return (60000 / wpm()) * f;
  }
  function step() {
    if (!playing) return;
    const it = list[at];
    if (!it) return pause();
    show();
    timer = setTimeout(() => {
      if (it.last) R.markDone(it.b, R.kind, { sprint: true });
      at++;
      if (at >= list.length) { pause(); $("spCtx").textContent = "That is the end. Press Esc to go back to the page."; return; }
      step();
    }, delay(it));
  }
  function play() { if (playing) return; playing = true; warm = 6; R.busy = true; setIcon(); step(); }
  function pause() { playing = false; clearTimeout(timer); R.busy = false; setIcon(); }
  function setIcon() { $("spPlay").innerHTML = I(playing ? "pause" : "play"); $("spPlay").setAttribute("aria-label", playing ? "Pause" : "Play"); }
  function jumpSentence(d) {
    const s = list[at] ? list[at].s : 0;
    const target = Math.max(0, Math.min(sents.length - 1, s + d));
    at = sents[target];
    show();
  }
  function setWpm(v) {
    v = Math.max(100, Math.min(900, Math.round(v / 25) * 25));
    $("spWpm").textContent = v + " words/min";
    R.settings.reader.sprintWpm = v;
    R.patch({ reader: { sprintWpm: v } }, true);
  }

  R.startSprint = function () {
    if (!R.blocks.length) return;
    R.closeSheet();
    build(R.cur);
    at = 0;
    R.sprinting = true;
    $("sprint").hidden = false;
    $("spTitle").textContent = R.doc.title;
    $("spWpm").textContent = wpm() + " words/min";
    setIcon(); show();
    $("spPlay").focus();
  };
  function close() {
    pause();
    $("sprint").hidden = true;
    R.sprinting = false;
    const it = list[Math.min(at, list.length - 1)];
    if (it) R.go(it.b, false);
    $("tSprint").focus();
  }

  $("spPlay").addEventListener("click", () => (playing ? pause() : play()));
  $("spClose").addEventListener("click", close);
  $("spBack").addEventListener("click", () => jumpSentence(-1));
  $("spFwd").addEventListener("click", () => jumpSentence(1));
  $("spSlower").addEventListener("click", () => setWpm(wpm() - 25));
  $("spFaster").addEventListener("click", () => setWpm(wpm() + 25));
  document.addEventListener("keydown", (e) => {
    if (!R.sprinting) return;
    const k = e.key;
    if (k === " " || k === "Spacebar") { e.preventDefault(); playing ? pause() : play(); }
    else if (k === "Escape") { e.preventDefault(); close(); }
    else if (k === "ArrowLeft") { e.preventDefault(); jumpSentence(-1); }
    else if (k === "ArrowRight") { e.preventDefault(); jumpSentence(1); }
    else if (k === "ArrowUp") { e.preventDefault(); setWpm(wpm() + 25); }
    else if (k === "ArrowDown") { e.preventDefault(); setWpm(wpm() - 25); }
  });
})();
