#!/usr/bin/env node
/* End to end check of the Polycarp audio module in headless Chromium.

   Usage:
     node tests/voice.spec.mjs --deps <dir> [--profile <dir>] [--fresh] [--wav <file>]

   <dir> is the folder holding node_modules with `playwright` (outside the project, the same one
   scripts/build-audio.mjs uses). --profile keeps the browser profile, so the Kokoro download is
   cached between runs; --fresh wipes it first to prove the real download path.

   Prints one PASS or FAIL line per check and exits 1 if any check fails. */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./pw.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const depsDir = path.resolve(arg("--deps", process.env.POLYCARP_AUDIO_DEPS || ""));
const require = createRequire(path.join(depsDir, "package.json"));
let pw;
try { pw = require("playwright"); } catch { pw = await loadPlaywright(); }
const { chromium } = pw;

const work = path.resolve(arg("--work", path.join(depsDir, "voice-test")));
// --wasm hides WebGPU. --coi also tests a scratch copy whose manifest adds cross-origin isolation
// (COEP credentialless, COOP same-origin), which turns on threaded WASM.
const forceWasm = process.argv.includes("--wasm") || process.argv.includes("--coi");
const coi = process.argv.includes("--coi");
const mode = coi ? "wasm-coi" : forceWasm ? "wasm" : "default";
const profile = path.resolve(arg("--profile", path.join(work, "profile-" + mode)));
const wavOut = path.resolve(arg("--wav", path.join(depsDir, `kokoro-sample-${mode}.wav`)));
if (process.argv.includes("--fresh")) fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
}
function note(msg) {
  console.log(`INFO ${msg}`);
}

/* Use the real extension unless a file the manifest names is missing (the lead may still be
   writing them); then test a scratch copy with empty stubs for the missing files. */
function extensionDir() {
  const src = root;
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
  const named = [manifest.background && manifest.background.service_worker,
    manifest.action && manifest.action.default_popup,
    manifest.options_ui && manifest.options_ui.page,
    ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])].filter(Boolean);
  const missing = named.filter((f) => !fs.existsSync(path.join(src, f)));
  if (!missing.length && !coi) return src;
  const copy = path.join(work, coi ? "extension-copy-coi" : "extension-copy");
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(src, copy, { recursive: true });
  if (coi) {
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
    m.cross_origin_embedder_policy = { value: "credentialless" };
    m.cross_origin_opener_policy = { value: "same-origin" };
    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
    note("testing a scratch copy with cross-origin isolation added to its manifest");
  }
  if (!missing.length) return copy;
  for (const f of missing) {
    fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
    fs.writeFileSync(path.join(copy, f), f.endsWith(".html") ? "<!doctype html><title>stub</title>" : "/* test stub */\n");
  }
  note(`extension is missing ${missing.join(", ")}; testing a scratch copy with stubs at ${copy}`);
  return copy;
}

function wav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const ext = extensionDir();
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    "--autoplay-policy=no-user-gesture-required"
  ]
});

// --wasm hides WebGPU from extension pages, so voice.js picks q8 weights on WASM.
if (forceWasm) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true }));

// Count any use of the browser's robotic speechSynthesis voices (there must be none), and record
// where every audio clip is scheduled and where its sound starts and stops, to measure pauses.
await context.addInitScript(() => {
  globalThis.__synthCalls = 0;
  if (globalThis.speechSynthesis) {
    for (const k of ["speak", "getVoices"]) {
      const f = speechSynthesis[k].bind(speechSynthesis);
      speechSynthesis[k] = (...a) => { globalThis.__synthCalls++; return f(...a); };
    }
  }
  globalThis.__sched = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, ...rest) {
    const b = this.buffer;
    if (b) {
      const d = b.getChannelData(0);
      let a = 0, z = d.length - 1;
      while (a < d.length && Math.abs(d[a]) < 0.01) a++;
      while (z > a && Math.abs(d[z]) < 0.01) z--;
      globalThis.__sched.push({ when: when || this.context.currentTime, on: a / b.sampleRate, off: z / b.sampleRate, dur: b.duration });
    }
    return start.call(this, when, ...rest);
  };
});

const requests = [];
context.on("request", (r) => requests.push(r.url()));
const consoleErrors = [];

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  note(`extension id ${extId}`);

  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") consoleErrors.push("worker: " + m.text()); }));
  const devUrl = `chrome-extension://${extId}/src/audio/dev-voice.html`;
  await page.goto(devUrl);
  await page.waitForFunction(() => !!globalThis.PolycarpVoice);

  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return "no navigator.gpu";
    const a = await navigator.gpu.requestAdapter();
    return a ? `adapter (fallback ${!!(a.isFallbackAdapter || (a.info || {}).isFallbackAdapter)})` : "no adapter";
  });
  note(`WebGPU in this browser: ${gpu}`);

  // 1. Voices
  const voices = await page.evaluate(() => PolycarpVoice.listVoices());
  const kokoro = voices.filter((v) => v.engine === "kokoro");
  check("listVoices returns only curated Kokoro voices, Heart first", voices.length >= 5 && kokoro.length === voices.length &&
    voices[0].id === "kokoro:af_heart" && voices.every((v) => v.id.startsWith("kokoro:") && v.name && v.label && v.lang && v.accent && v.gender),
    `${voices.length} voices: ${voices.map((v) => v.name).join(", ")}`);
  check("listVoices offers male and female voices", voices.some((v) => v.gender === "male") && voices.some((v) => v.gender === "female"));

  // 1b. Text splitting and casting (no audio needed).
  const unit = await page.evaluate(() => {
    const I = PolycarpVoice._internal;
    const sents = (t) => I.splitSentences(t).map(([a, b]) => t.slice(a, b).trim());
    const cast = { narrator: "af_heart", dialogue: "am_michael" };
    const who = (t) => I.castParts(t, true, cast).map((p) => (p.voice === "am_michael" ? "D:" : "N:") + p.text);
    return {
      abbr: sents("Dr. Smith met Mr. J. Doe at 5 p.m. on Main Street. They talked. Then e.g. this stays one."),
      quote: sents("She said, \u201cCome here.\u201d Then she left."),
      long: I.splitParts("word ".repeat(120).trim(), false).every((p) => p.text.length <= 220),
      dlg: who("\u201cCome here,\u201d she said. \u201cWe have to leave before the rain starts.\u201d He nodded."),
      scare: who("Bees use a set of \u201csimple tools\u201d that work together."),
      open: who("He said: \u201cThis speech runs on into the next paragraph"),
      off: I.castParts("\u201cCome here,\u201d she said.", true, null).map((p) => p.voice || "none"),
      keys: [I.voiceKey("system:com.apple.speech.Daniel"), I.voiceKey("kokoro:af_sky"), I.voiceKey("kokoro:bf_emma"), I.voiceKey("")],
      auto: [I.castFor("af_heart", "auto"), I.castFor("am_michael", "auto"), I.castFor("af_heart", "off"), I.castFor("af_heart", "kokoro:af_heart")]
    };
  });
  check("sentences split at real ends, not abbreviations or initials", JSON.stringify(unit.abbr) === JSON.stringify(["Dr. Smith met Mr. J. Doe at 5 p.m. on Main Street.", "They talked.", "Then e.g. this stays one."]), JSON.stringify(unit.abbr));
  check("a closing quote stays with its sentence", JSON.stringify(unit.quote) === JSON.stringify(["She said, \u201cCome here.\u201d", "Then she left."]), JSON.stringify(unit.quote));
  check("long text is cut into pieces Kokoro can say in one go", unit.long);
  check("dialogue goes to the second voice, narration to the first", JSON.stringify(unit.dlg) === JSON.stringify(["D:\u201cCome here,\u201d", "N:she said.", "D:\u201cWe have to leave before the rain starts.\u201d", "N:He nodded."]), JSON.stringify(unit.dlg));
  check("short scare quotes stay with the narrator", unit.scare.length === 1 && unit.scare[0].startsWith("N:"), JSON.stringify(unit.scare));
  check("an unclosed quote runs to the end of the paragraph", JSON.stringify(unit.open) === JSON.stringify(["N:He said:", "D:\u201cThis speech runs on into the next paragraph"]), JSON.stringify(unit.open));
  check("dialogue voice off reads everything in one voice", unit.off.every((v) => v === "none"), JSON.stringify(unit.off));
  check("old system voice ids and retired voices fall back to Heart", JSON.stringify(unit.keys) === JSON.stringify(["af_heart", "af_heart", "bf_emma", "af_heart"]), JSON.stringify(unit.keys));
  check("auto dialogue voice contrasts the narrator", unit.auto[0].dialogue === "am_michael" && unit.auto[1].dialogue === "af_heart" && unit.auto[2] === null && unit.auto[3] === null, JSON.stringify(unit.auto));

  // 2. Download
  const before = await page.evaluate(() => PolycarpVoice.kokoroStatus());
  note(`status before download: ${JSON.stringify(before)}`);
  const dl = await page.evaluate(async () => {
    const t0 = performance.now();
    const ticks = [];
    await PolycarpVoice.downloadKokoro((p) => ticks.push(p));
    const status = await PolycarpVoice.kokoroStatus();
    const keys = [];
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const r of await c.keys()) keys.push(name + " " + r.url);
    }
    const monotonic = ticks.every((p, i) => i === 0 || p >= ticks[i - 1]);
    return { ms: Math.round(performance.now() - t0), ticks: ticks.length, last: ticks[ticks.length - 1], monotonic, status, keys, loaded: PolycarpVoice._internal.engine.loaded };
  });
  check("downloadKokoro completes and status is ready", dl.status.state === "ready" && dl.last === 1,
    `${dl.ms} ms, ${dl.ticks} progress ticks, monotonic ${dl.monotonic}, status ${JSON.stringify(dl.status)}`);
  note(`engine loaded: ${JSON.stringify(dl.loaded)}`);
  note(`cache entries: ${dl.keys.length}\n     ${dl.keys.filter((k) => !k.includes("/voices/")).join("\n     ")}`);

  // Fresh page: proves the cache is detected without downloading, and gives a cold start time.
  await page.goto(devUrl);
  await page.waitForFunction(() => !!globalThis.PolycarpVoice);
  const reqBefore = requests.length;
  const statusReload = await page.evaluate(() => PolycarpVoice.kokoroStatus());
  check("kokoroStatus detects cached weights without downloading", statusReload.state === "ready" &&
    !requests.slice(reqBefore).some((u) => /huggingface|hf\.co/.test(u)), JSON.stringify(statusReload));

  // Helper run inside the page: speak and record everything.
  const runSpeak = (segments, plan) => page.evaluate(async ({ segments, plan }) => {
    const ev = [];
    const clips = {};
    const t0 = performance.now();
    const now = () => Math.round(performance.now() - t0);
    let ctl;
    const done = new Promise((resolve) => {
      ctl = PolycarpVoice.speak(segments, {
        voice: plan.voice || "kokoro:af_heart",
        dialogue: plan.dialogue || "off",
        rate: plan.rate || 1,
        onSegment: (id) => ev.push({ k: "seg", id, t: now() }),
        onWord: (id, a, b) => ev.push({ k: "word", id, a, b, t: now() }),
        onEnd: () => { ev.push({ k: "end", t: now() }); resolve("end"); },
        onError: (e) => { ev.push({ k: "error", msg: e.message, code: e.code, t: now() }); resolve("error"); },
        onState: (s) => ev.push({ k: "state", s, t: now() }),
        _onClip: (id, samples, sr) => {
          let sum = 0;
          for (let i = 0; i < samples.length; i++) sum += Math.abs(samples[i]);
          clips[id] = { sum, duration: samples.length / sr, sampleRate: sr, samples: plan.keepSamples ? Array.from(samples) : null };
        }
      });
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 60000) => {
      const end = performance.now() + ms;
      while (!fn()) {
        if (performance.now() > end) return false;
        await sleep(10);
      }
      return true;
    };
    const marks = {};
    if (plan.pauseAfterWords) {
      await waitFor(() => ev.filter((e) => e.k === "word").length >= plan.pauseAfterWords);
      ctl.pause();
      marks.pausedAt = now();
      marks.stateAfterPause = ctl.state;
      const n = ev.length;
      await sleep(plan.pauseMs);
      marks.eventsDuringPause = ev.slice(n).filter((e) => e.k === "word" || e.k === "seg").length;
      ctl.resume();
      marks.resumedAt = now();
    }
    if (plan.stopAfterWords) {
      await waitFor(() => ev.filter((e) => e.k === "word").length >= plan.stopAfterWords);
      ctl.stop();
      marks.stoppedAt = now();
      marks.stateAfterStop = ctl.state;
      const n = ev.length;
      await sleep(plan.afterStopMs);
      marks.eventsAfterStop = ev.slice(n).filter((e) => e.k === "word" || e.k === "seg" || e.k === "end").length;
      return { ev, clips, marks, result: "stopped" };
    }
    if (plan.seekTo != null) {
      await waitFor(() => ev.some((e) => e.k === "word"));
      ctl.seek(plan.seekTo);
      marks.seekAt = now();
    }
    if (plan.setRateAfterSeg) {
      await waitFor(() => ev.some((e) => e.k === "seg"));
      ctl.setRate(plan.setRateAfterSeg);
      marks.rateAt = now();
    }
    const result = await Promise.race([done, sleep(120000).then(() => "timeout")]);
    return { ev, clips, marks, result };
  }, { segments, plan });

  const words = (text) => [...text.matchAll(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu)].map((m) => [m.index, m.index + m[0].length]);
  function wordsInOrder(run, segments) {
    const expected = segments.flatMap((s) => words(s.text).map(([a, b]) => `${s.id}:${a}-${b}`));
    const got = run.ev.filter((e) => e.k === "word").map((e) => `${e.id}:${e.a}-${e.b}`);
    return { ok: JSON.stringify(expected) === JSON.stringify(got), expected: expected.length, got: got.length };
  }

  // 3. Two sentences, cold start (fresh worker loads the cached model).
  const two = [
    { id: "a", text: "The cat sat on the mat." },
    { id: "b", text: "Reading aloud, one clear word at a time, helps a busy mind stay with the page until the very end." }
  ];
  const cold = await runSpeak(two, { keepSamples: true });
  const segIds = cold.ev.filter((e) => e.k === "seg").map((e) => e.id);
  check("speak finishes with onEnd", cold.result === "end", cold.result === "error" ? JSON.stringify(cold.ev.find((e) => e.k === "error")) : "");
  check("onSegment fires for each segment in order", JSON.stringify(segIds) === '["a","b"]', JSON.stringify(segIds));
  const wo = wordsInOrder(cold, two);
  check("onWord fires for every word in order", wo.ok, `${wo.got}/${wo.expected} words`);
  const ca = cold.clips.a;
  const cb = cold.clips.b;
  check("Kokoro produces audio (sum of samples nonzero)", ca && cb && ca.sum > 1 && cb.sum > 1,
    ca && cb ? `sum a=${ca.sum.toFixed(1)} b=${cb.sum.toFixed(1)}` : "missing clips");
  if (ca && cb) {
    const ratio = (cb.duration / ca.duration) / (two[1].text.length / two[0].text.length);
    check("duration roughly proportional to text", ratio > 0.5 && ratio < 2 && ca.duration / two[0].text.length > 0.03 && ca.duration / two[0].text.length < 0.15,
      `a ${ca.duration.toFixed(2)} s for ${two[0].text.length} chars, b ${cb.duration.toFixed(2)} s for ${two[1].text.length} chars, ratio vs length ${ratio.toFixed(2)}`);
    const segT = Object.fromEntries(cold.ev.filter((e) => e.k === "seg").map((e) => [e.id, e.t]));
    const lastWordA = cold.ev.filter((e) => e.k === "word" && e.id === "a").pop();
    check("word timing stays inside its clip", lastWordA && lastWordA.t - segT.a <= ca.duration * 1000 + 60,
      lastWordA ? `last word of a at ${lastWordA.t - segT.a} ms of ${Math.round(ca.duration * 1000)} ms` : "");
    fs.writeFileSync(wavOut, wav(cb.samples, cb.sampleRate));
    note(`wrote ${wavOut} (${cb.duration.toFixed(2)} s, sentence b)`);
  }
  const firstSegCold = cold.ev.find((e) => e.k === "seg");
  note(`time to first audio, cold (worker start + model load from cache + first sentence): ${firstSegCold ? firstSegCold.t : "n/a"} ms`);

  // 4. Warm start: the model is loaded; this is the time the Reader sees on Play.
  const warm = await runSpeak([{ id: "w", text: "This is a warm start test sentence for timing." }], {});
  const firstSegWarm = warm.ev.find((e) => e.k === "seg");
  check("warm speak finishes", warm.result === "end");
  note(`time to first audio, warm (${dl.loaded && dl.loaded.device}/${dl.loaded && dl.loaded.dtype}, ${warm.clips.w ? warm.clips.w.duration.toFixed(2) : "?"} s sentence): ${firstSegWarm ? firstSegWarm.t : "n/a"} ms`);

  // 5. Pause and resume
  const three = [
    { id: "p1", text: "First we read this sentence slowly and clearly." },
    { id: "p2", text: "Then we take a short break in the middle." },
    { id: "p3", text: "Finally we finish the paragraph." }
  ];
  const pr = await runSpeak(three, { pauseAfterWords: 3, pauseMs: 1500 });
  const wpr = wordsInOrder(pr, three);
  check("pause stops words and audio", pr.marks.stateAfterPause === "paused" && pr.marks.eventsDuringPause === 0,
    `state ${pr.marks.stateAfterPause}, ${pr.marks.eventsDuringPause} events during 1500 ms pause`);
  check("resume continues to the end with every word in order", pr.result === "end" && wpr.ok, `${wpr.got}/${wpr.expected} words`);

  // 6. Stop
  const st = await runSpeak(three, { stopAfterWords: 2, afterStopMs: 1500 });
  check("stop ends speech with no further events", st.marks.stateAfterStop === "stopped" && st.marks.eventsAfterStop === 0,
    `state ${st.marks.stateAfterStop}, ${st.marks.eventsAfterStop} events after stop`);

  // 7. Seek
  const sk = await runSpeak(three, { seekTo: 2 });
  const skSegs = sk.ev.filter((e) => e.k === "seg").map((e) => e.id);
  check("seek jumps to the chosen segment", sk.result === "end" && skSegs[skSegs.length - 1] === "p3" && !skSegs.includes("p2"), JSON.stringify(skSegs));

  // 8. Rate change: later sentences are made at the new rate.
  const rt = await runSpeak(three, { setRateAfterSeg: 1.6 });
  const perChar = (id) => rt.clips[id] && rt.clips[id].duration / three.find((s) => s.id === id).text.length;
  check("setRate speeds up the following sentences", rt.result === "end" && perChar("p3") < perChar("p1") * 0.85,
    `s/char p1 ${perChar("p1") ? perChar("p1").toFixed(3) : "?"}, p3 ${perChar("p3") ? perChar("p3").toFixed(3) : "?"}`);

  // 9. Pauses sound like a person reading: silence between clips measured from the scheduled
  // audio itself. Kokoro pads every clip with about 0.3 s before and 0.5 s after; that padding is
  // trimmed and replaced with a short breath between sentences and a longer one between paragraphs.
  const paras = [
    { id: "q1", text: "The first tool is the sun. Bees use it as a compass, and they correct for its movement across the sky through the day." },
    { id: "q2", text: "A bee that learned a route in the morning can fly the same route in the afternoon." }
  ];
  await page.evaluate(() => { globalThis.__sched = []; });
  const ps = await runSpeak(paras, {});
  const sched = await page.evaluate(() => globalThis.__sched);
  const gaps = sched.slice(1).map((c, i) => Math.round(((c.when + c.on) - (sched[i].when + sched[i].off)) * 1000));
  const leads = sched.map((c) => Math.round(c.on * 1000)), tails = sched.map((c) => Math.round((c.dur - c.off) * 1000));
  check("paragraphs read to the end", ps.result === "end");
  check("clip padding is trimmed (under 120 ms of silence at either end)", leads.every((x) => x < 120) && tails.every((x) => x < 160), `lead ${leads.join("/")} ms, tail ${tails.join("/")} ms`);
  if (dl.status.realtime) {
    check("pauses between clips are natural (120 to 1000 ms)", gaps.length >= 1 && gaps.every((g) => g >= 120 && g <= 1000), `${gaps.join(", ")} ms`);
    check("the paragraph pause is the longest", gaps.length >= 2 && Math.max(...gaps) === gaps[gaps.length - 1] || gaps.length === 1, `${gaps.join(", ")} ms`);
  } else note(`WARN not real time on this device (one-thread WASM): pauses ${gaps.join(", ")} ms`);

  // 10. Dialogue in a second voice: narration and speech are made by different Kokoro voices.
  const story = [{ id: "s1", text: "\u201cCome here,\u201d she said. \u201cWe have to leave before the rain starts.\u201d He nodded and picked up the bag." }];
  await page.evaluate(() => { globalThis.__sched = []; });
  const one = await runSpeak(story, { dialogue: "off", keepSamples: true });
  const two2 = await runSpeak(story, { dialogue: "auto", keepSamples: true });
  const ws = wordsInOrder(two2, story);
  check("a cast read finishes with every word in order", two2.result === "end" && ws.ok, `${ws.got}/${ws.expected} words, result ${two2.result}`);
  // Same text, different voices for the first quote: compare its median pitch (autocorrelation
  // over voiced 40 ms frames) between a one-voice read and a cast read.
  function pitch(arr, sr, upto) {
    const N = Math.round(sr * 0.04), out = [];
    for (let s0 = 0; s0 + N * 2 < Math.min(arr.length, upto); s0 += N) {
      let e = 0;
      for (let i = 0; i < N; i++) e += arr[s0 + i] * arr[s0 + i];
      if (Math.sqrt(e / N) < 0.03) continue;
      let best = 0, lag = 0;
      for (let L = Math.round(sr / 400); L <= Math.round(sr / 70); L++) {
        let c = 0;
        for (let i = 0; i < N; i++) c += arr[s0 + i] * arr[s0 + i + L];
        if (c > best) { best = c; lag = L; }
      }
      if (lag && best / e > 0.5) out.push(sr / lag);
    }
    out.sort((x, y) => x - y);
    return out.length ? out[out.length >> 1] : 0;
  }
  const f1 = one.clips.s1 ? pitch(one.clips.s1.samples, one.clips.s1.sampleRate, 21600) : 0;
  const f2 = two2.clips.s1 ? pitch(two2.clips.s1.samples, two2.clips.s1.sampleRate, 21600) : 0;
  check("the dialogue voice sounds different from the narrator (pitch of the first quote)", f1 && f2 && Math.abs(f1 - f2) / f1 > 0.2,
    `median pitch Heart ${Math.round(f1)} Hz, dialogue voice ${Math.round(f2)} Hz`);
  fs.writeFileSync(wavOut.replace(/\.wav$/, "-cast.wav"), wav(two2.clips.s1.samples, two2.clips.s1.sampleRate));
  note(`wrote ${wavOut.replace(/\.wav$/, "-cast.wav")} (dialogue in a second voice)`);

  // 11. Play with no voice downloaded starts the download and then reads, instead of failing.
  // The page is made to see an empty cache; the worker still loads from the real one, so no
  // network is needed.
  const auto = await page.evaluate(async () => {
    const has = caches.has.bind(caches);
    caches.has = async () => false;
    const states = [];
    const off = PolycarpVoice.onStatus((s) => states.push(s.state));
    const before = (await PolycarpVoice.kokoroStatus()).state;
    const r = await new Promise((resolve) => PolycarpVoice.speak([{ id: "x", text: "The voice was fetched first." }], {
      onEnd: () => resolve("end"), onError: (e) => resolve("error: " + e.message)
    }));
    off();
    caches.has = has;
    return { before, r, states };
  });
  check("Play with no voice downloaded fetches it, then reads", auto.before === "missing" && auto.r === "end" && auto.states.includes("downloading"),
    `before ${auto.before}, result ${auto.r}, statuses ${[...new Set(auto.states)].join(",")}`);

  const synth = await page.evaluate(() => globalThis.__synthCalls);
  check("the robotic system voice (speechSynthesis) is never used", synth === 0, `${synth} calls`);

  // 12. Network: only Hugging Face data and extension files.
  const allowed = (u) => {
    if (/^(chrome-extension|data|blob):/.test(u)) return true;
    try {
      const h = new URL(u).hostname;
      return /(^|\.)huggingface\.co$/.test(h) || /(^|\.)hf\.co$/.test(h);
    } catch (_) {
      return false;
    }
  };
  const bad = requests.filter((u) => !allowed(u));
  const cdn = requests.filter((u) => /jsdelivr|unpkg|cdnjs/.test(u));
  const workerSeen = requests.some((u) => u.endsWith("/lib/audio/ort-wasm-simd-threaded.jsep.wasm"));
  check("no request to a CDN or any non Hugging Face host", bad.length === 0 && cdn.length === 0, bad.slice(0, 5).join(" "));
  check("request log sees worker traffic (local ort wasm load observed)", workerSeen);
  const hosts = [...new Set(requests.map((u) => { try { return new URL(u).protocol === "chrome-extension:" ? "chrome-extension" : new URL(u).hostname; } catch (_) { return u.slice(0, 20); } }))];
  note(`hosts contacted: ${hosts.join(", ")} (${requests.length} requests)`);
  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
} catch (err) {
  check("test ran", false, err.stack || String(err));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
