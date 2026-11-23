#!/usr/bin/env node
/* Records exactly what a listener hears from PolycarpVoice.speak, as a WAV file: every audio clip the
   player schedules, placed at the time it was scheduled to start, so pauses between sentences and
   paragraphs are part of the file. Use it to compare voice changes by ear.

   Usage:
     node tests/voice-render.mjs --deps <dir> [--profile <dir>] [--voice kokoro:af_heart] [--dialogue off|auto|kokoro:id]
                                 [--story] [--out file.wav]

   --story reads a short passage with dialogue instead of the honeybee article.

   --deps and --profile are the same as tests/voice.spec.mjs (reuse its profile so Kokoro is cached).
   Also prints the measured pauses between clips. */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./pw.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const depsDir = path.resolve(arg("--deps", process.env.POLYCARP_AUDIO_DEPS || "."));
const require = createRequire(path.join(depsDir, "package.json"));
let pw;
try { pw = require("playwright"); } catch { pw = await loadPlaywright(); }
const profile = path.resolve(arg("--profile", path.join(depsDir, "voice-test", "profile")));
const voice = arg("--voice", "kokoro:af_heart");
const dialogue = arg("--dialogue", "auto");
const out = path.resolve(arg("--out", "voice-render.wav"));

// Original sample text (store/articles.mjs): two paragraphs with long and short sentences.
const ARTICLE = [
  "A forager honeybee may fly more than three kilometers from her hive, visit hundreds of flowers, and still return in a nearly straight line. She does it with a brain smaller than a grain of rice. Researchers have spent a century working out how, and the answer turns out to be a set of simple tools that work together.",
  "The first tool is the sun. Bees use it as a compass, and they correct for its movement across the sky through the day. A bee that learned a route in the morning can fly the same route in the afternoon, even though the sun has moved, because her internal clock tells her how far it has traveled."
];
// Original dialogue passage, written for this test.
const STORY = [
  "The rain had started by the time Ana reached the dock. Her brother was already there, coiling rope.",
  "\u201cYou're late,\u201d he said, without looking up.",
  "\u201cThe bus broke down halfway across the bridge. Did the boat come in?\u201d",
  "He pointed at the gray shape beyond the breakwater. \u201cTwenty minutes. Maybe less if the wind holds.\u201d",
  "She set her bag down and watched the water. For a while neither of them said anything."
];
const PARAS = process.argv.includes("--story") ? STORY : ARTICLE;

const ext = root;
const ctx = await pw.chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"]
});
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    globalThis.__clips = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, ...rest) {
      if (this.buffer) globalThis.__clips.push({ when: when || this.context.currentTime, rate: this.buffer.sampleRate, data: Array.from(this.buffer.getChannelData(0)) });
      return start.call(this, when, ...rest);
    };
  });
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/audio/dev-voice.html`);
  await page.waitForFunction(() => !!globalThis.PolycarpVoice);
  const res = await page.evaluate(({ PARAS, voice, dialogue }) => new Promise((resolve, reject) => {
    const segs = PARAS.map((text, id) => ({ id, text }));
    const t0 = performance.now();
    PolycarpVoice.speak(segs, { voice, dialogue, rate: 1, onEnd: () => resolve({ ms: performance.now() - t0 }), onError: (e) => reject(String(e && e.message || e)) });
  }), { PARAS, voice, dialogue });
  const clips = await page.evaluate(() => globalThis.__clips);
  const rate = clips[0].rate;
  const first = clips[0].when;
  const end = Math.max(...clips.map((c) => c.when - first + c.data.length / c.rate));
  const mix = new Float32Array(Math.ceil((end + 0.3) * rate));
  const pauses = [], detail = [];
  let prevEnd = null;
  for (const c of clips) {
    const off = Math.round((c.when - first) * rate);
    for (let i = 0; i < c.data.length; i++) mix[off + i] += c.data[i];
    // Silence between the last sound of one clip and the first sound of the next.
    const loud = (x) => Math.abs(x) > 0.01;
    const a = c.data.findIndex(loud), b = c.data.length - 1 - [...c.data].reverse().findIndex(loud);
    const s = c.when - first + a / c.rate, e = c.when - first + b / c.rate;
    if (prevEnd != null) pauses.push(Math.round((s - prevEnd) * 1000));
    detail.push({ at: +(c.when - first).toFixed(2), dur: +(c.data.length / c.rate).toFixed(2), leadMs: Math.round(a / c.rate * 1000), tailMs: Math.round((c.data.length - 1 - b) / c.rate * 1000) });
    prevEnd = e;
  }
  const buf = Buffer.alloc(44 + mix.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + mix.length * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(mix.length * 2, 40);
  for (let i = 0; i < mix.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(out, buf);
  console.log(JSON.stringify({ out, voice, dialogue, clips: clips.length, seconds: +(mix.length / rate).toFixed(2), pausesMs: pauses, clipsDetail: detail, wallMs: Math.round(res.ms) }));
} finally {
  await ctx.close();
}
