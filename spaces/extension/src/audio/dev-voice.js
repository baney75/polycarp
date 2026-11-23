/* Dev page for PolycarpVoice. Not shipped (the build excludes dev-* files). */
(function () {
  "use strict";
  const V = globalThis.PolycarpVoice;
  const $ = (id) => document.getElementById(id);
  const log = (msg) => {
    const el = $("log");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  };

  let controller = null;
  let sentences = [];

  async function refreshStatus() {
    const s = await V.kokoroStatus();
    $("bar").value = s.progress;
    const mb = s.bytes ? ` (${(s.bytes / 1048576).toFixed(0)} MB)` : "";
    $("status").textContent = `Kokoro: ${s.state}${s.device ? " on " + s.device : ""}${mb}`;
    $("download").disabled = s.state === "ready" || s.state === "downloading" || s.state === "unsupported";
    $("remove").disabled = s.state !== "ready";
    return s;
  }

  async function fillVoices() {
    const list = await V.listVoices();
    const sel = $("voice");
    sel.textContent = "";
    for (const engine of ["kokoro", "system"]) {
      const group = document.createElement("optgroup");
      group.label = engine === "kokoro" ? "Kokoro (on device)" : "System voices";
      for (const v of list.filter((x) => x.engine === engine)) {
        const o = document.createElement("option");
        o.value = v.id;
        o.textContent = v.name + (v.grade ? `  grade ${v.grade}` : v.lang ? `  ${v.lang}` : "");
        group.appendChild(o);
      }
      if (group.children.length) sel.appendChild(group);
    }
  }

  function render() {
    const text = $("source").value;
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    const box = $("reading");
    box.textContent = "";
    sentences = [];
    let i = 0;
    for (const part of seg.segment(text)) {
      const span = document.createElement("span");
      span.textContent = part.segment;
      box.appendChild(span);
      sentences.push({ id: "s" + i++, text: part.segment, node: span.firstChild });
    }
  }

  function highlight(name, node, start, end) {
    if (!("highlights" in CSS)) return;
    const r = new Range();
    r.setStart(node, start);
    r.setEnd(node, end);
    CSS.highlights.set(name, new Highlight(r));
  }

  function clearHighlights() {
    if ("highlights" in CSS) CSS.highlights.clear();
  }

  function play() {
    if (controller) controller.stop();
    render();
    clearHighlights();
    const byId = new Map(sentences.map((s) => [s.id, s]));
    const t0 = performance.now();
    let first = true;
    controller = V.speak(sentences.map((s) => ({ id: s.id, text: s.text })), {
      voice: $("voice").value,
      rate: Number($("rate").value),
      onSegment(id) {
        if (first) {
          first = false;
          log(`first audio after ${Math.round(performance.now() - t0)} ms`);
        }
        const s = byId.get(id);
        highlight("polycarp-sentence", s.node, 0, s.text.length);
      },
      onWord(id, a, b) {
        highlight("polycarp-word", byId.get(id).node, a, b);
      },
      onEnd() {
        log("end");
        clearHighlights();
      },
      onError(err) {
        log(`error (${err.code}): ${err.message}`);
      },
      onState(st) {
        log("state: " + st);
      }
    });
  }

  $("play").onclick = play;
  $("pause").onclick = () => controller && controller.pause();
  $("resume").onclick = () => controller && controller.resume();
  $("stop").onclick = () => { if (controller) controller.stop(); clearHighlights(); };
  $("prev").onclick = () => controller && controller.seek(controller.segmentIndex - 1);
  $("next").onclick = () => controller && controller.seek(controller.segmentIndex + 1);
  $("rate").oninput = () => {
    $("rateVal").textContent = Number($("rate").value).toFixed(1);
    if (controller) controller.setRate(Number($("rate").value));
  };
  $("preview").onclick = () => {
    if (controller) controller.stop();
    controller = V.preview($("voice").value, { onError: (e) => log(`error (${e.code}): ${e.message}`) });
  };
  $("download").onclick = async () => {
    $("download").disabled = true;
    const t0 = performance.now();
    try {
      await V.downloadKokoro((p, s) => {
        $("bar").value = p;
        $("status").textContent = `Downloading ${Math.round(p * 100)}%${s.device ? " for " + s.device : ""}`;
      });
      log(`download and load took ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      log(`download failed: ${err.message}`);
    }
    refreshStatus();
  };
  $("remove").onclick = async () => {
    await V.removeKokoro();
    refreshStatus();
  };
  V.onStatus(() => refreshStatus());

  render();
  fillVoices();
  refreshStatus();
})();
