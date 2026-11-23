/* Polycarp Kokoro worker: runs Kokoro-82M (onnx-community/Kokoro-82M-v1.0-ONNX) with transformers.js.
   Module worker started by voice.js. A worker has no chrome.* APIs, so every asset URL is built
   from self.location.href. All code and wasm are bundled in lib/audio; only model data is fetched.

   Messages in:
     { type: "load", dtype: "fp32"|"q8", device: "webgpu"|"wasm" }
     { type: "gen", id, voice, speed, parts: [{ text, start, end }] }
     { type: "cancel", ids: [id] }
   Messages out:
     { type: "progress", status, file, loaded, total }
     { type: "loaded", dtype, device, warmupMs, threads, fallback? }
     { type: "loadError", message }
     { type: "part", id, samples: Float32Array, sampleRate, start, end }   one per piece, in order
     { type: "done", id }
     { type: "genError", id, message } */

import { KokoroTTS, transformersEnv } from "../../lib/audio/kokoro.mjs";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const LIB_URL = new URL("../../lib/audio/", self.location.href);

const onnx = transformersEnv.backends.onnx;
onnx.wasm.wasmPaths = { wasm: new URL("ort-wasm-simd-threaded.jsep.wasm", LIB_URL).href };
// Threaded wasm needs SharedArrayBuffer, which needs cross-origin isolation. Extension pages
// get it only when the manifest sets cross_origin_embedder_policy and cross_origin_opener_policy;
// without it, run one thread.
const THREADS = self.crossOriginIsolated ? Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)) : 1;
onnx.wasm.numThreads = THREADS;
onnx.wasm.proxy = false;
// onnxruntime prints node placement warnings through console.error; keep real errors only.
onnx.logLevel = "error";
// Session warnings ignore env.logLevel (sessions default to severity "warning", and kokoro-js
// passes no session options), so drop onnxruntime warning lines here. [E:...] errors still print.
const consoleError = console.error.bind(console);
console.error = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("[W:onnxruntime:")) return;
  consoleError(...args);
};
transformersEnv.allowLocalModels = false;
transformersEnv.allowRemoteModels = true;
transformersEnv.useBrowserCache = true;

let tts = null;
let loading = null;
let current = null;
const queue = [];
const cancelled = new Set();
let busy = false;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function progress(p) {
  if (p && (p.status === "progress" || p.status === "done" || p.status === "initiate")) {
    post({ type: "progress", status: p.status, file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
  }
}

function audible(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v !== v) return false; // NaN
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak > 0.001;
}

async function tryLoad(dtype, device) {
  const model = await KokoroTTS.from_pretrained(MODEL_ID, { dtype, device, progress_callback: progress });
  // Prove the device really runs this model before using it (a broken GPU path can load
  // fine and then throw or return silence on the first run).
  const t0 = performance.now();
  const out = await model.generate("Ready.", { voice: "af_heart", speed: 1 });
  if (!audible(out.audio)) throw new Error(`${device}/${dtype} produced no audio`);
  return { model, warmupMs: Math.round(performance.now() - t0) };
}

async function load(dtype, device) {
  try {
    const r = await tryLoad(dtype, device);
    tts = r.model;
    current = { dtype, device, warmupMs: r.warmupMs, threads: device === "wasm" ? THREADS : 0 };
  } catch (err) {
    if (device !== "webgpu") throw err;
    // WebGPU failed: run the same weights on WASM so nothing new is downloaded.
    const r = await tryLoad(dtype, "wasm");
    tts = r.model;
    current = { dtype, device: "wasm", warmupMs: r.warmupMs, threads: THREADS, fallback: String(err && err.message || err) };
  }
  return current;
}

// Generate a sentence piece by piece and post each piece as soon as it exists.
async function generate(job) {
  for (const p of job.parts) {
    if (cancelled.has(job.id)) return false;
    const out = await tts.generate(p.text, { voice: p.voice || job.voice, speed: job.speed });
    const samples = out.audio;
    post({ type: "part", id: job.id, samples, sampleRate: 24000, start: p.start, end: p.end }, [samples.buffer]);
  }
  return true;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      if (loading) {
        try { await loading; } catch (_) { /* reported by load */ }
      }
      const job = queue.shift();
      if (!tts) {
        post({ type: "genError", id: job.id, message: "Kokoro is not loaded." });
        continue;
      }
      try {
        if (await generate(job)) post({ type: "done", id: job.id });
      } catch (err) {
        post({ type: "genError", id: job.id, message: String(err && err.message || err) });
      }
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "load") {
    if (!loading) {
      loading = load(m.dtype, m.device);
      loading.then(
        (cur) => post({ type: "loaded", ...cur }),
        (err) => {
          loading = null;
          post({ type: "loadError", message: String(err && err.message || err) });
        }
      );
    } else {
      loading.then((cur) => post({ type: "loaded", ...cur }), () => {});
    }
  } else if (m.type === "gen") {
    queue.push(m);
    pump();
  } else if (m.type === "cancel") {
    const ids = new Set(m.ids || []);
    for (const id of ids) cancelled.add(id);
    for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].id)) queue.splice(i, 1);
    if (cancelled.size > 500) cancelled.clear();
  }
};
