/* Polycarp voice: read-aloud for extension pages.
   Classic script. Defines globalThis.PolycarpVoice.

   One engine: Kokoro-82M on this computer, on WebGPU when it works and WASM otherwise, run in
   kokoro-worker.js. The browser's speechSynthesis voices are never used: they sound robotic.
   Weights download from Hugging Face once, the first time the user listens (or from Settings),
   then load from the browser's Cache API and work offline.

   Cast: quoted dialogue can be read by a second Kokoro voice, as in a two-narrator audiobook.

   Word timing: Kokoro gives no word timestamps, so each clip's speaking time is spread across
   its words by character count, with small extra weights for punctuation pauses, and onWord
   fires on the AudioContext clock. */
(function () {
  "use strict";

  const HF_BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";
  const MODEL_FILES = { fp32: "onnx/model.onnx", q8: "onnx/model_quantized.onnx" };
  const MODEL_BYTES = { fp32: 325532232, q8: 92361116 };
  const SIDE_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"];
  const SIDE_BYTES = 3654;
  const TF_CACHE = "transformers-cache";
  const VOICE_CACHE = "kokoro-voices";
  const VOICE_BIN_BYTES = 522240;
  const SAMPLE_RATE = 24000;
  const MAX_PART_CHARS = 220;  // one generation stays under Kokoro's 510 phoneme limit
  const PACK_CHARS = 260;      // short sentences are joined up to this, so phrasing has context
  const MIN_CLAUSE_CHARS = 30;
  // Silence put back between clips after Kokoro's own padding (about 0.3 s before and 0.5 s
  // after every clip) is trimmed. Seconds at rate 1; faster reading shortens them.
  const PAUSE = { clause: 0.14, sentence: 0.32, para: 0.62 };
  const BUFFER_AHEAD = 2;
  const IDLE_UNLOAD_MS = 5 * 60 * 1000;
  const RATE_MIN = 0.6;
  const RATE_MAX = 2.0;

  // The best graded English voices on the Kokoro-82M model card (VOICES.md), best first. Lower
  // grades were dropped: they sound flat or synthetic over a long read.
  const KOKORO_VOICES = [
    { key: "af_heart", name: "Heart", accent: "US", gender: "female", grade: "A", note: "warm, natural" },
    { key: "af_bella", name: "Bella", accent: "US", gender: "female", grade: "A-", note: "bright, expressive" },
    { key: "bf_emma", name: "Emma", accent: "UK", gender: "female", grade: "B-", note: "clear, British" },
    { key: "af_nicole", name: "Nicole", accent: "US", gender: "female", grade: "B-", note: "soft, close" },
    { key: "am_michael", name: "Michael", accent: "US", gender: "male", grade: "C+", note: "steady, calm" },
    { key: "am_fenrir", name: "Fenrir", accent: "US", gender: "male", grade: "C+", note: "deep" },
    { key: "bm_george", name: "George", accent: "UK", gender: "male", grade: "C", note: "British" }
  ];
  const DEFAULT_VOICE = "af_heart";
  // Second voice for dialogue when the reader picks "auto": a contrasting voice, so speech stands
  // out from narration the way it does with two audiobook narrators.
  const CAST_PARTNER = { female: "am_michael", male: "af_heart" };

  const workerUrl = (function () {
    const src = document.currentScript && document.currentScript.src;
    if (src) return new URL("kokoro-worker.js", src).href;
    return chrome.runtime.getURL("src/audio/kokoro-worker.js");
  })();

  /* ---------- text: words, parts, timing ---------- */

  const WORD_RE = /[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu;

  function splitWords(text) {
    const out = [];
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  }

  // Pause weight (in characters) for the text between two words.
  function pauseWeight(gap) {
    if (/[.!?…]/.test(gap)) return 6;
    if (/[;:]/.test(gap)) return 4;
    if (/[,\u2013\u2014]|\s-\s|\(|\)/.test(gap)) return 3;
    return 0;
  }

  // Word start/end times in seconds within [t0, t1] for the words of text[from..to).
  function wordTimes(text, words, t0, t1) {
    if (!words.length) return [];
    const weights = [];
    let total = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const len = w.end - w.start;
      const pause = i + 1 < words.length ? pauseWeight(text.slice(w.end, words[i + 1].start)) : 0;
      weights.push({ len, gap: 1 + pause });
      total += len + (i + 1 < words.length ? 1 + pause : 0);
    }
    const span = Math.max(0.01, t1 - t0);
    const out = [];
    let acc = 0;
    for (let i = 0; i < words.length; i++) {
      const s = t0 + (acc / total) * span;
      acc += weights[i].len;
      const e = t0 + (acc / total) * span;
      out.push({ t: s, end: e });
      if (i + 1 < words.length) acc += weights[i].gap;
    }
    return out;
  }

  // Sentence ends: . ! ? or … (with closing quotes or brackets) before a space and a capital,
  // digit or quote, or at the end of the text. Abbreviations and initials are not ends.
  const ABBR = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|fig|no|vol|ch|p|pp|approx|dept|est|inc|ltd|co|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[a-z])\.$/i;
  function splitSentences(text) {
    const out = [];
    const re = /[.!?\u2026]+["'\u201d\u2019)\]]*(?=\s+["'\u201c\u2018(\[]?[\p{Lu}\p{N}]|\s*$)/gu;
    let from = 0, m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      if (m[0][0] === "." && ABBR.test(text.slice(Math.max(0, m.index - 12), m.index + 1))) continue;
      if (text.slice(from, end).trim()) out.push([from, end]);
      from = end;
    }
    if (text.slice(from).trim()) out.push([from, text.length]);
    return out;
  }

  // Cut one over-long sentence at the clause break nearest its middle (then a space), repeatedly,
  // until every piece fits. Returns [start, end] ranges.
  function splitLong(text, start, end) {
    if (end - start <= MAX_PART_CHARS) return [[start, end]];
    const slice = text.slice(start, end);
    const mid = slice.length / 2;
    let best = -1;
    for (const re of [/[;:\u2013\u2014)]\s/g, /,\s/g, /\s/g]) {
      let m;
      while ((m = re.exec(slice))) {
        const cut = m.index + 1;
        if (cut < MIN_CLAUSE_CHARS || slice.length - cut < MIN_CLAUSE_CHARS) continue;
        if (best < 0 || Math.abs(cut - mid) < Math.abs(best - mid)) best = cut;
      }
      if (best > 0) break;
    }
    if (best <= 0) best = Math.min(MAX_PART_CHARS, Math.floor(mid));
    return splitLong(text, start, start + best).concat(splitLong(text, start + best, end));
  }

  // Split a paragraph into the pieces Kokoro generates one at a time. Pieces end at sentence ends;
  // a sentence is cut only when it is too long for one generation, and then at a clause break.
  // Short sentences are packed together (up to PACK_CHARS) so Kokoro phrases them as speech, not
  // as isolated lines. With `clauses` (WASM, where generation is close to playback speed) every
  // sentence is its own piece so the first one plays sooner. Each piece says how it ends:
  // "sentence" or "clause", which sets the pause after it.
  function splitParts(text, clauses) {
    const pieces = [];
    for (const [a, b] of splitSentences(text)) {
      const r = splitLong(text, a, b);
      r.forEach(([x, y], k) => pieces.push({ start: x, end: y, join: k === r.length - 1 ? "sentence" : "clause" }));
    }
    const packed = [];
    for (const p of pieces) {
      const last = packed[packed.length - 1];
      if (!clauses && last && last.join === "sentence" && p.end - last.start <= PACK_CHARS) { last.end = p.end; last.join = p.join; }
      else packed.push({ ...p });
    }
    const parts = [];
    for (const p of packed) {
      let { start, end } = p;
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      const slice = text.slice(start, end);
      if (/[\p{L}\p{N}]/u.test(slice)) parts.push({ text: slice, start, end, join: p.join });
    }
    return parts;
  }

  // Quoted speech in a paragraph, as [start, end] ranges that include the quote marks. A quote
  // counts as dialogue when it reads like speech: three or more words, or it ends in . , ! ? or a
  // dash inside the marks. Short scare quotes ("simple tools") and titles stay with the narrator.
  // An opening curly quote with no close runs to the end of the paragraph, the convention for
  // speech that continues into the next paragraph.
  function dialogueRanges(text) {
    const out = [];
    const re = /\u201c([^\u201c\u201d]*)(\u201d|$)|"([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const inner = m[1] != null ? m[1] : m[3];
      const words = (inner.match(/[\p{L}\p{N}]+/gu) || []).length;
      if (!words) continue;
      if (words >= 3 || /[.,!?\u2026\u2014-]\s*$/.test(inner)) out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }

  // Split a paragraph into parts, each with the voice that reads it. Without a cast every part is
  // the narrator's. With one, narration and dialogue are split apart first, so packing never joins
  // the two, and the pause after a quote depends on how it ends.
  function castParts(text, clauses, cast) {
    const ranges = cast ? dialogueRanges(text) : [];
    if (!ranges.length) return splitParts(text, clauses).map((p) => ({ ...p, voice: cast ? cast.narrator : undefined }));
    const runs = [];
    let at = 0;
    for (const [a, b] of ranges) {
      if (a > at) runs.push([at, a, false]);
      runs.push([a, b, true]);
      at = b;
    }
    if (at < text.length) runs.push([at, text.length, false]);
    const parts = [];
    for (const [a, b, dlg] of runs) {
      const sub = splitParts(text.slice(a, b), clauses);
      sub.forEach((p, k) => {
        let join = p.join;
        if (k === sub.length - 1) join = /[.!?\u2026]["'\u201d\u2019)\]]*$/.test(p.text) ? "sentence" : "clause";
        parts.push({ text: p.text, start: p.start + a, end: p.end + a, join, voice: dlg ? cast.dialogue : cast.narrator });
      });
    }
    return parts;
  }

  // Cut Kokoro's padding off a clip, keeping a little air around the speech so soft word ends are
  // not clipped, with short fades so the cut never clicks.
  function trimClip(samples, sampleRate) {
    const frame = Math.max(1, Math.round(sampleRate * 0.01));
    let peak = 0;
    const rms = [];
    for (let i = 0; i < samples.length; i += frame) {
      let sum = 0;
      const stop = Math.min(samples.length, i + frame);
      for (let j = i; j < stop; j++) sum += samples[j] * samples[j];
      const r = Math.sqrt(sum / Math.max(1, stop - i));
      rms.push(r);
      if (r > peak) peak = r;
    }
    if (!peak) return samples;
    const thr = Math.max(0.002, peak * 0.02);
    let a = 0;
    while (a < rms.length && rms[a] < thr) a++;
    let b = rms.length - 1;
    while (b > a && rms[b] < thr) b--;
    const from = Math.max(0, a * frame - Math.round(sampleRate * 0.04));
    const to = Math.min(samples.length, (b + 1) * frame + Math.round(sampleRate * 0.08));
    const out = samples.slice(from, to);
    const fade = Math.min(Math.round(sampleRate * 0.008), out.length >> 2);
    for (let i = 0; i < fade; i++) { const g = i / fade; out[i] *= g; out[out.length - 1 - i] *= g; }
    return out;
  }

  // First and last audible sample of a clip region, in seconds from the region start.
  function voicedRange(samples, from, to, sampleRate) {
    const frame = Math.max(1, Math.round(sampleRate * 0.01));
    const rms = [];
    let peak = 0;
    for (let i = from; i < to; i += frame) {
      let sum = 0;
      const stop = Math.min(to, i + frame);
      for (let j = i; j < stop; j++) sum += samples[j] * samples[j];
      const r = Math.sqrt(sum / Math.max(1, stop - i));
      rms.push(r);
      if (r > peak) peak = r;
    }
    const dur = (to - from) / sampleRate;
    if (!peak) return [0, dur];
    const thr = Math.max(0.005, peak * 0.06);
    let a = 0;
    while (a < rms.length && rms[a] < thr) a++;
    let b = rms.length - 1;
    while (b > a && rms[b] < thr) b--;
    return [Math.max(0, (a * frame) / sampleRate - 0.02), Math.min(dur, ((b + 1) * frame) / sampleRate)];
  }

  function clampRate(r) {
    const n = Number(r);
    if (!isFinite(n)) return 1;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, n));
  }

  function makeError(message, code, cause) {
    const err = new Error(message);
    err.code = code;
    if (cause) err.cause = cause;
    return err;
  }

  /* ---------- device and cache ---------- */

  function supported() {
    return typeof WebAssembly === "object" && typeof Worker === "function" &&
      typeof (window.AudioContext || window.webkitAudioContext) === "function" && typeof caches === "object";
  }

  let gpuPromise = null;
  function detectGpu() {
    if (!gpuPromise) {
      gpuPromise = (async () => {
        try {
          if (!navigator.gpu) return false;
          const adapter = await navigator.gpu.requestAdapter();
          if (!adapter) return false;
          const info = adapter.info || {};
          return !(adapter.isFallbackAdapter || info.isFallbackAdapter);
        } catch (_) {
          return false;
        }
      })();
    }
    return gpuPromise;
  }

  async function cachedUrls() {
    const have = new Set();
    try {
      for (const name of [TF_CACHE, VOICE_CACHE]) {
        if (!(await caches.has(name))) continue;
        const c = await caches.open(name);
        for (const req of await c.keys()) have.add(req.url);
      }
    } catch (_) { /* no Cache API: report missing */ }
    return have;
  }

  function dtypeComplete(have, dtype) {
    return have.has(HF_BASE + MODEL_FILES[dtype]) && SIDE_FILES.every((f) => have.has(HF_BASE + f));
  }

  // Which weights to run. fp32 on WebGPU. On WASM fp32 is also the pick: measured 20 to 30%
  // faster than q8 at 1, 4 and 8 threads (q8's integer kernels are slow in onnxruntime-web) and
  // full quality; q8 only saves download (92 MB instead of 326 MB). Set WASM_DTYPE to "q8" to
  // trade speed for size. q4 is avoided: it has no WASM kernel for GatherBlockQuantized.
  // Already cached weights win, so a machine that loses WebGPU keeps working without a download.
  const WASM_DTYPE = "fp32";
  async function pickConfig() {
    const gpu = await detectGpu();
    const have = await cachedUrls();
    const preferred = gpu ? "fp32" : WASM_DTYPE;
    let dtype = null;
    if (dtypeComplete(have, preferred)) dtype = preferred;
    else if (dtypeComplete(have, preferred === "fp32" ? "q8" : "fp32")) dtype = preferred === "fp32" ? "q8" : "fp32";
    const run = dtype || preferred;
    const device = run === "fp32" && gpu ? "webgpu" : "wasm";
    // WebGPU and threaded WASM keep up with playback; one-thread WASM runs 2 to 3 times slower
    // than real time, so sentences will have pauses between them.
    const realtime = device === "webgpu" || !!globalThis.crossOriginIsolated;
    const voiceBytes = KOKORO_VOICES.filter((v) => have.has(HF_BASE + "voices/" + v.key + ".bin")).length * VOICE_BIN_BYTES;
    return { cached: !!dtype, dtype: run, device, realtime, bytes: dtype ? MODEL_BYTES[dtype] + SIDE_BYTES + voiceBytes : 0 };
  }

  /* ---------- Kokoro engine (one worker per page) ---------- */

  const engine = {
    worker: null,
    loadPromise: null,
    loaded: null, // { dtype, device, warmupMs, fallback? }
    reqs: new Map(),
    nextId: 1,
    progressListeners: new Set(),
    active: 0,
    idleTimer: 0
  };

  const download = { active: null, progress: 0, device: null, bytes: 0 };
  const statusListeners = new Set();

  function emitStatus(status) {
    for (const fn of statusListeners) {
      try { fn(status); } catch (_) { /* listener error */ }
    }
  }

  function failAll(err) {
    for (const r of engine.reqs.values()) r.reject(err);
    engine.reqs.clear();
  }

  function killWorker() {
    if (engine.worker) engine.worker.terminate();
    engine.worker = null;
    engine.loadPromise = null;
    engine.loaded = null;
  }

  function ensureWorker() {
    if (engine.worker) return engine.worker;
    const w = new Worker(workerUrl, { type: "module", name: "polycarp-kokoro" });
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "progress") {
        for (const fn of engine.progressListeners) fn(m);
      } else if (m.type === "part") {
        const r = engine.reqs.get(m.id);
        if (r) r.onPart({ samples: m.samples, sampleRate: m.sampleRate, start: m.start, end: m.end });
      } else if (m.type === "done" || m.type === "genError") {
        const r = engine.reqs.get(m.id);
        if (!r) return;
        engine.reqs.delete(m.id);
        if (m.type === "done") r.resolve();
        else r.reject(makeError("The voice could not read this sentence. Press Play to go on.", "kokoro-failed", m.message));
      }
    };
    w.onerror = (e) => {
      e.preventDefault();
      const err = makeError("The voice could not start. Reload the page to try again.", "kokoro-failed", e.message);
      failAll(err);
      if (engine.rejectLoad) engine.rejectLoad(err);
      killWorker();
    };
    engine.worker = w;
    return w;
  }

  function loadEngine(onProgress) {
    if (engine.loadPromise) {
      if (onProgress) engine.progressListeners.add(onProgress);
      return engine.loadPromise.finally(() => onProgress && engine.progressListeners.delete(onProgress));
    }
    engine.loadPromise = (async () => {
      const cfg = await pickConfig();
      const w = ensureWorker();
      if (onProgress) engine.progressListeners.add(onProgress);
      try {
        return await new Promise((resolve, reject) => {
          engine.rejectLoad = reject;
          const onMsg = (e) => {
            const m = e.data || {};
            if (m.type === "loaded") {
              w.removeEventListener("message", onMsg);
              engine.loaded = { dtype: m.dtype, device: m.device, warmupMs: m.warmupMs, threads: m.threads, fallback: m.fallback };
              resolve(engine.loaded);
            } else if (m.type === "loadError") {
              w.removeEventListener("message", onMsg);
              reject(makeError("The voice could not start. Reload the page to try again.", "kokoro-failed", m.message));
            }
          };
          w.addEventListener("message", onMsg);
          w.postMessage({ type: "load", dtype: cfg.dtype, device: cfg.device });
        });
      } finally {
        engine.rejectLoad = null;
        if (onProgress) engine.progressListeners.delete(onProgress);
      }
    })();
    engine.loadPromise.catch(() => killWorker());
    return engine.loadPromise;
  }

  // Ask the worker for one sentence; onPart gets each piece as soon as it is made.
  function requestClip(parts, voice, speed, onPart) {
    const id = engine.nextId++;
    const promise = new Promise((resolve, reject) => engine.reqs.set(id, { resolve, reject, onPart }));
    ensureWorker().postMessage({ type: "gen", id, parts, voice, speed });
    return { id, promise };
  }

  function cancelClips(ids) {
    if (!ids.length) return;
    for (const id of ids) engine.reqs.delete(id);
    if (engine.worker) engine.worker.postMessage({ type: "cancel", ids });
  }

  function engineBusy(delta) {
    engine.active += delta;
    clearTimeout(engine.idleTimer);
    if (engine.active <= 0 && !download.active) {
      engine.active = 0;
      // Free the model's memory when nothing has been read for a while.
      engine.idleTimer = setTimeout(() => { if (!engine.active && !engine.reqs.size) killWorker(); }, IDLE_UNLOAD_MS);
    }
  }

  async function kokoroStatus() {
    if (!supported()) return { state: "unsupported", progress: 0, device: null };
    if (download.active) return { state: "downloading", progress: download.progress, device: download.device, bytes: download.bytes };
    const cfg = await pickConfig();
    if (!cfg.cached) return { state: "missing", progress: 0, device: cfg.device, realtime: cfg.realtime, bytes: 0, downloadBytes: MODEL_BYTES[cfg.dtype] + SIDE_BYTES + KOKORO_VOICES.length * VOICE_BIN_BYTES };
    const device = engine.loaded ? engine.loaded.device : cfg.device;
    const realtime = device === "webgpu" || !!globalThis.crossOriginIsolated;
    return { state: "ready", progress: 1, device, realtime, bytes: cfg.bytes };
  }

  function downloadKokoro(onProgress) {
    if (download.active) {
      if (onProgress) download.listeners.add(onProgress);
      return download.active;
    }
    if (!supported()) return Promise.reject(makeError("This browser cannot run the Kokoro voice.", "kokoro-unsupported"));
    download.listeners = new Set(onProgress ? [onProgress] : []);
    download.progress = 0;
    download.bytes = 0;
    const tell = () => {
      const s = { state: "downloading", progress: download.progress, device: download.device, bytes: download.bytes };
      for (const fn of download.listeners) {
        try { fn(s.progress, s); } catch (_) { /* listener error */ }
      }
      emitStatus(s);
    };
    download.active = (async () => {
      const cfg = await pickConfig();
      download.device = cfg.device;
      const voiceUrls = KOKORO_VOICES.map((v) => HF_BASE + "voices/" + v.key + ".bin");
      const expected = MODEL_BYTES[cfg.dtype] + SIDE_BYTES + voiceUrls.length * VOICE_BIN_BYTES;
      const files = new Map();
      const sum = () => { let s = 0; for (const v of files.values()) s += v; return s; };
      tell();
      await loadEngine((p) => {
        if (!p.file) return;
        if (p.status === "done") files.set(p.file, Math.max(files.get(p.file) || 0, p.total || files.get(p.file) || 0));
        else files.set(p.file, p.loaded || 0);
        download.bytes = sum();
        download.progress = Math.min(0.97, download.bytes / expected);
        tell();
      });
      // Voice styles (about 0.5 MB each), cached the way kokoro-js reads them.
      const cache = await caches.open(VOICE_CACHE);
      let done = 0;
      await Promise.all(voiceUrls.map(async (url) => {
        if (!(await cache.match(url))) {
          const res = await fetch(url);
          if (!res.ok) throw makeError(`The voice did not download (error ${res.status}). Check your connection and try again.`, "kokoro-download");
          const buf = await res.arrayBuffer();
          await cache.put(url, new Response(buf, { headers: res.headers }));
        }
        done++;
        download.bytes = sum() + done * VOICE_BIN_BYTES;
        download.progress = Math.min(0.999, download.bytes / expected);
        tell();
      }));
      download.device = engine.loaded ? engine.loaded.device : cfg.device;
    })();
    const finish = download.active.then(async () => {
      download.active = null;
      download.progress = 1;
      const s = await kokoroStatus();
      for (const fn of download.listeners) {
        try { fn(1, s); } catch (_) { /* listener error */ }
      }
      emitStatus(s);
      engineBusy(0);
    }, async (err) => {
      download.active = null;
      emitStatus(await kokoroStatus());
      throw err.code ? err : makeError("Kokoro download failed: " + (err && err.message || err), "kokoro-download", err);
    });
    download.active = finish;
    return finish;
  }

  async function removeKokoro() {
    killWorker();
    failAll(makeError("Kokoro was removed.", "kokoro-missing"));
    await caches.delete(TF_CACHE);
    await caches.delete(VOICE_CACHE);
    const s = await kokoroStatus();
    emitStatus(s);
    return s;
  }

  /* ---------- voices ---------- */

  function listVoices() {
    return Promise.resolve(KOKORO_VOICES.map((v) => ({
      id: "kokoro:" + v.key,
      name: v.name,
      label: `${v.name}, ${v.note}`,
      engine: "kokoro",
      lang: v.accent === "UK" ? "en-GB" : "en-US",
      accent: v.accent,
      gender: v.gender,
      grade: v.grade
    })));
  }

  // Any id maps to a Kokoro voice. Old settings that named a system voice, or a Kokoro voice that
  // is no longer offered, get Heart.
  function voiceKey(id) {
    const s = String(id || "");
    const key = s.startsWith("kokoro:") ? s.slice(7) : s;
    return KOKORO_VOICES.some((v) => v.key === key) ? key : DEFAULT_VOICE;
  }
  function resolveVoice(id) {
    return { engine: "kokoro", key: voiceKey(id) };
  }

  // opts.dialogue: "off", "auto" (a contrasting voice) or a voice id. Returns null when there is no
  // second voice.
  function castFor(narrator, dialogue) {
    if (!dialogue || dialogue === "off") return null;
    let key;
    if (dialogue === "auto") {
      const meta = KOKORO_VOICES.find((v) => v.key === narrator);
      key = CAST_PARTNER[meta ? meta.gender : "female"];
    } else key = voiceKey(dialogue);
    return key === narrator ? null : { narrator, dialogue: key };
  }

  /* ---------- shared controller plumbing ---------- */

  function normalizeSegments(segments) {
    return (segments || []).map((s, i) => {
      const text = String(s && s.text != null ? s.text : "");
      return { id: s && s.id != null ? s.id : i, text, words: splitWords(text) };
    });
  }

  function callbacks(opts) {
    const safe = (fn) => (typeof fn === "function" ? (...a) => {
      try { fn(...a); } catch (e) { setTimeout(() => { throw e; }); }
    } : () => {});
    return {
      onSegment: safe(opts.onSegment),
      onWord: safe(opts.onWord),
      onEnd: safe(opts.onEnd),
      onError: safe(opts.onError),
      onState: safe(opts.onState),
      onClip: safe(opts._onClip)
    };
  }

  /* ---------- Kokoro controller ---------- */

  // Plays sentences as a chain of parts on one AudioContext timeline. Each part is an
  // AudioBufferSourceNode started exactly where the previous one ends, so there is no gap
  // whenever generation keeps ahead. Pause suspends the context, which freezes the clock that
  // word events run on.
  function speakKokoro(segs, voice, cast, opts) {
    const cb = callbacks(opts);
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: "playback" });
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    let rate = clampRate(opts.rate);
    let state = "loading";
    let head = 0; // first segment not finished playing
    let next = { seg: 0, part: 0 }; // next part to put on the timeline
    let timer = 0;
    let fatal = false;
    let clauses = false;
    const clips = new Map(); // seg -> { req, rate, parts: [], count, done }
    const scheduled = []; // { seg, part, last, source, start, end, words, fired, started }

    engineBusy(1);

    const setState = (s) => {
      if (state === s) return;
      state = s;
      cb.onState(s);
    };
    const heardTime = () => ctx.currentTime - (ctx.outputLatency || 0);

    function fail(err) {
      if (fatal) return;
      fatal = true;
      teardown();
      finish();
      setState("error");
      cb.onError(err);
    }

    function unschedule(list) {
      for (const s of list) {
        try { s.source.stop(); } catch (_) { /* not started */ }
        s.source.disconnect();
      }
    }

    function dropClips(test) {
      const ids = [];
      for (const [i, c] of clips) {
        if (!test(i, c)) continue;
        if (!c.done && c.req) ids.push(c.req.id);
        clips.delete(i);
      }
      cancelClips(ids);
    }

    function teardown() {
      clearInterval(timer);
      timer = 0;
      unschedule(scheduled);
      scheduled.length = 0;
      dropClips(() => true);
    }

    function finish() {
      clearInterval(timer);
      timer = 0;
      ctx.close().catch(() => {});
      engineBusy(-1);
    }

    function request(i) {
      const seg = segs[i];
      const parts = castParts(seg.text, clauses, cast);
      if (!parts.length) {
        const n = Math.round(SAMPLE_RATE * 0.25);
        clips.set(i, { rate, count: 1, done: true, parts: [{ samples: new Float32Array(n), sampleRate: SAMPLE_RATE, start: 0, end: seg.text.length }] });
        return;
      }
      const entry = { rate, count: parts.length, done: false, parts: [], meta: parts };
      entry.req = requestClip(parts, voice, rate, (p) => {
        if (clips.get(i) !== entry) return; // dropped by seek, stop or a rate change
        entry.parts.push(p);
        pump();
      });
      clips.set(i, entry);
      entry.req.promise.then(() => {
        if (clips.get(i) !== entry) return;
        entry.done = true;
        if (opts._onClip) {
          const total = entry.parts.reduce((n, p) => n + p.samples.length, 0);
          const all = new Float32Array(total);
          let off = 0;
          for (const p of entry.parts) { all.set(p.samples, off); off += p.samples.length; }
          cb.onClip(seg.id, all, SAMPLE_RATE);
        }
        pump();
      }, (err) => {
        if (clips.get(i) !== entry) return;
        fail(err);
      });
    }

    function partWords(seg, p) {
      const words = seg.words.filter((w) => w.start >= p.start && w.start < p.end);
      const [a, b] = voicedRange(p.samples, 0, p.samples.length, p.sampleRate);
      const times = wordTimes(seg.text, words, a, b);
      return words.map((w, k) => ({ start: w.start, end: w.end, t: times[k].t }));
    }

    // Each clip is trimmed, then placed after the previous one plus the pause its ending calls
    // for: a short one inside a sentence, a breath between sentences, a longer one between
    // paragraphs. Pauses shrink as the reading rate goes up.
    function schedule(i, k, p, last) {
      const trimmed = { ...p, samples: trimClip(p.samples, p.sampleRate) };
      const buffer = ctx.createBuffer(1, trimmed.samples.length, p.sampleRate);
      buffer.copyToChannel(trimmed.samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const c = clips.get(i);
      const join = last ? "para" : ((c && c.meta && c.meta[k] && c.meta[k].join) || "sentence");
      const prev = scheduled[scheduled.length - 1];
      const start = Math.max(prev ? prev.end + prev.pause : 0, ctx.currentTime + 0.05);
      source.start(start);
      scheduled.push({ seg: i, part: k, last, source, start, end: start + buffer.duration, pause: PAUSE[join] / Math.sqrt(rate),
        words: partWords(segs[i], trimmed), fired: 0, started: false });
    }

    function pump() {
      if (fatal || state === "stopped" || state === "ended") return;
      // Generate the current sentence plus BUFFER_AHEAD more.
      for (let i = head; i < Math.min(segs.length, head + 1 + BUFFER_AHEAD); i++) {
        if (!clips.has(i)) request(i);
      }
      // Put ready parts on the timeline, at most one sentence past the one playing.
      while (next.seg < segs.length && next.seg <= head + 1) {
        const c = clips.get(next.seg);
        if (!c || next.part >= c.parts.length) break;
        const last = next.part === c.count - 1;
        schedule(next.seg, next.part, c.parts[next.part], last);
        next = last ? { seg: next.seg + 1, part: 0 } : { seg: next.seg, part: next.part + 1 };
      }
      if (!timer) timer = setInterval(tick, 20);
    }

    function fireWords(s, upTo) {
      while (s.fired < s.words.length && s.words[s.fired].t <= upTo) {
        const w = s.words[s.fired++];
        cb.onWord(segs[s.seg].id, w.start, w.end);
      }
    }

    function tick() {
      if (fatal) return;
      const t = heardTime();
      while (scheduled.length) {
        const s = scheduled[0];
        if (!s.started) {
          if (t < s.start) break;
          s.started = true;
          if (s.part === 0) cb.onSegment(segs[s.seg].id);
          if (state === "loading") setState("playing");
        }
        fireWords(s, t - s.start);
        if (t < s.end) break;
        fireWords(s, Infinity);
        s.source.disconnect();
        scheduled.shift();
        if (s.last) {
          clips.delete(s.seg);
          head = s.seg + 1;
        }
      }
      if (head >= segs.length && !scheduled.length) {
        setState("ended");
        finish();
        cb.onEnd();
        return;
      }
      if (!scheduled.length && state === "playing") setState("loading");
      pump();
    }

    const controller = {
      pause() {
        if (state === "playing" || state === "loading") {
          setState("paused");
          ctx.suspend();
        }
      },
      resume() {
        if (state === "paused") {
          ctx.resume();
          setState(scheduled.length ? "playing" : "loading");
          pump();
        }
      },
      stop() {
        if (state === "stopped" || state === "ended" || fatal) return;
        teardown();
        setState("stopped");
        finish();
      },
      seek(index) {
        if (state === "stopped" || state === "ended" || fatal) return;
        const i = Math.max(0, Math.min(segs.length - 1, index | 0));
        unschedule(scheduled);
        scheduled.length = 0;
        // Keep finished or running work that is still inside the new window at this rate.
        dropClips((k, c) => k < i || k > i + BUFFER_AHEAD || c.rate !== rate);
        head = i;
        next = { seg: i, part: 0 };
        if (state !== "paused") setState("loading");
        pump();
      },
      setRate(r) {
        const n = clampRate(r);
        if (n === rate) return;
        rate = n;
        // The sentence playing now finishes at its rate; everything after it is made again.
        const playing = scheduled.find((s) => s.started);
        const keep = playing ? playing.seg : head - 1;
        const later = scheduled.filter((s) => s.seg > keep);
        unschedule(later);
        scheduled.splice(scheduled.length - later.length, later.length);
        dropClips((k) => k > keep);
        if (next.seg > keep) next = { seg: keep + 1, part: 0 };
        pump();
      },
      get state() { return state; },
      get rate() { return rate; },
      get segmentIndex() { return head; },
      get device() { return engine.loaded ? engine.loaded.device : null; },
      get engine() { return "kokoro"; }
    };

    cb.onState(state);
    ctx.resume().catch(() => {});
    (async () => {
      const status = await kokoroStatus();
      if (status.state === "unsupported") throw makeError("This browser cannot run Polycarp's voices. Update Chrome or Helium and try again.", "kokoro-unsupported");
      // First listen: fetch the voice now (progress goes to onStatus listeners), then read.
      if (status.state === "missing") await downloadKokoro();
      else if (status.state === "downloading") await download.active;
      const loaded = await loadEngine();
      clauses = loaded.device !== "webgpu";
    })().then(() => {
      if (state === "stopped" || fatal) return;
      pump();
    }, fail);

    return controller;
  }

  /* ---------- public API ---------- */

  function speak(segments, opts) {
    opts = opts || {};
    const key = voiceKey(opts.voice);
    return speakKokoro(normalizeSegments(segments), key, castFor(key, opts.dialogue), opts);
  }

  function preview(voiceId, opts) {
    const v = resolveVoice(voiceId);
    const meta = KOKORO_VOICES.find((k) => k.key === v.key);
    const name = meta ? meta.name : "your reading voice";
    const text = `Hi, I'm ${name}. I can read this page aloud while you follow along.`;
    return speak([{ id: "preview", text }], Object.assign({}, opts || {}, { voice: voiceId, dialogue: "off" }));
  }

  function onStatus(fn) {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
  }

  globalThis.PolycarpVoice = Object.freeze({
    listVoices,
    kokoroStatus,
    downloadKokoro,
    removeKokoro,
    onStatus,
    speak,
    preview,
    unload: killWorker,
    // Exposed for tests and the dev page.
    _internal: Object.freeze({ splitWords, splitSentences, splitParts, castParts, dialogueRanges, castFor, voiceKey, trimClip, wordTimes, voicedRange, engine, pickConfig })
  });
})();
