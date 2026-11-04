// On-device dictation: the model each device gets, what is sent to it, the setting, and the
// build that lets the speech runtime load without a CDN. The model itself runs in
// cli/eval/dictation.mjs (a real browser); these tests need none.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { splitAtQuiet, trimSilence } from "../src/dictation/recorder.ts";
import { modelFiles, readSetting, resolveModel, transcribeTimeoutMs } from "../src/dictation/settings.ts";
import { chooseModel, MODELS } from "../src/dictation/tiers.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const device = (over) => ({ webgpu: false, f16: false, memoryGB: 8, language: "en-US", ...over });

test("each device gets the strongest model it can run", () => {
	assert.equal(chooseModel(device({ webgpu: true, f16: true, memoryGB: 16, maxBufferBytes: 4 * 1024 ** 3 })).key, "turbo");
	assert.equal(chooseModel(device({ webgpu: true, f16: true, memoryGB: undefined })).key, "turbo", "browsers that hide memory still get the GPU model");
	assert.equal(chooseModel(device({ webgpu: true, f16: true, maxBufferBytes: 256 * 1024 ** 2 })).key, "small", "small GPU buffers");
	assert.equal(chooseModel(device({ webgpu: true, f16: false })).key, "small", "no half precision");
	assert.equal(chooseModel(device({ webgpu: true, f16: true, memoryGB: 4 })).key, "small");
	assert.equal(chooseModel(device({ webgpu: true, memoryGB: 2 })).key, "moonshineTiny");
	assert.equal(chooseModel(device({ memoryGB: 2, language: "de-DE" })).key, "tiny");
	assert.equal(chooseModel(device({})).key, "moonshine", "English on the processor");
	assert.equal(chooseModel(device({ language: "es" })).key, "base", "other languages on the processor");
	// The language chosen in Settings wins over the browser's: German speech never gets an English-only model.
	assert.equal(chooseModel(device({}), "de").key, "base");
	assert.equal(chooseModel(device({ memoryGB: 2 }), "es").key, "tiny");
	assert.equal(chooseModel(device({ language: "de-DE" }), "en").key, "moonshine");
	assert.equal(chooseModel(device({ language: "de-DE" }), "auto").key, "base");
	for (const spec of Object.values(MODELS)) {
		assert.match(spec.revision, /^[0-9a-f]{40}$/, `${spec.id} is pinned to a commit`);
		assert.match(spec.id, /^onnx-community\//);
	}
	// 4-bit encoders drop speech; decoders tolerate it. Every dtype is one transformers.js knows,
	// so none falls back to a default silently.
	for (const spec of Object.values(MODELS)) {
		assert.doesNotMatch(spec.dtype.encoder_model, /q4|int4/, spec.id);
		for (const dtype of Object.values(spec.dtype)) assert.match(dtype, /^(fp32|fp16|q8|q4|q4f16)$/, spec.id);
	}
	assert.deepEqual(modelFiles(MODELS.turbo), ["onnx/encoder_model_fp16.onnx", "onnx/decoder_model_merged_q4f16.onnx"]);
	assert.deepEqual(modelFiles(MODELS.small), ["onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"]);
	assert.deepEqual(modelFiles(MODELS.base), ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]);
});

test("silence is cut before the model, and talk from press to stop is kept whole", () => {
	const rate = 16000;
	const tone = (seconds, amp) => Float32Array.from({ length: seconds * rate }, (_, i) => amp * Math.sin(i / 3));
	const join = (...parts) => {
		const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	};
	assert.equal(trimSilence(new Float32Array(rate * 3)).length, 0, "silence sends nothing");
	assert.equal(trimSilence(tone(3, 0.002)).length, 0, "a quiet hum sends nothing");
	// A click or a cough in a silent recording: two loud frames aren't speech.
	assert.equal(trimSilence(join(tone(2, 0.0005), tone(0.06, 0.5), tone(2, 0.0005))).length, 0, "a click sends nothing");
	const speech = join(tone(2, 0.0005), tone(1, 0.3), tone(2, 0.0005));
	const trimmed = trimSilence(speech);
	assert.ok(trimmed.length >= rate && trimmed.length <= rate * 1.6, `kept ${trimmed.length / rate} s of 5 s`);
	// Steady sound (a fan, a hum) is flat; speech has gaps between words well below its peaks.
	assert.equal(trimSilence(tone(4, 0.3)).length, 0, "a steady sound sends nothing");
	const syllables = (amp, count) => join(...Array.from({ length: count }, () => join(tone(0.25, amp), tone(0.1, amp / 30))));
	const talking = syllables(0.3, 12);
	assert.ok(trimSilence(talking).length >= talking.length * 0.9, "talk from press to stop is kept");
	const quiet = syllables(0.006, 12);
	assert.ok(trimSilence(quiet).length >= quiet.length * 0.9, "a quiet microphone still gets through");
	// Speech over a loud steady noise: it rises and falls, so it's kept, uncut.
	const noise = (seconds, amp) => Float32Array.from({ length: seconds * rate }, (_, i) => amp * Math.sin(i * 1.7));
	const hiss = noise(5, 0.08);
	const noisy = syllables(0.2, 12).map((x, i) => x + hiss[i % hiss.length]);
	assert.equal(trimSilence(noisy).length, noisy.length, "speech over steady noise reaches the model");
	// A short phrase in a long, mostly quiet recording: a few loud frames among hundreds of quiet ones.
	const phrase = join(tone(5, 0.0005), syllables(0.3, 2), tone(5, 0.0005));
	const kept = trimSilence(phrase);
	assert.ok(kept.length >= 0.6 * rate && kept.length <= 1.3 * rate, `kept ${kept.length / rate} s of a 0.7 s phrase`);
});

test("long audio is cut into pieces at quiet points for one-pass models, and transcription time scales with it", () => {
	const rate = 16000;
	const audio = Float32Array.from({ length: 50 * rate }, (_, i) => (Math.floor(i / rate) % 7 === 6 ? 0 : 0.3 * Math.sin(i / 3)));
	const pieces = splitAtQuiet(audio, 20);
	assert.ok(pieces.length >= 3);
	assert.equal(pieces.reduce((n, p) => n + p.length, 0), audio.length, "nothing lost or repeated");
	for (const p of pieces.slice(0, -1)) {
		assert.ok(p.length <= 20 * rate);
		assert.ok(Math.abs(p[p.length - 1]) < 0.01, "cut in a quiet second");
	}
	assert.deepEqual(splitAtQuiet(new Float32Array(rate * 5)).length, 1, "short audio is one piece");
	// Just over the limit with its quietest moment near the end: the last piece still gets 2 s.
	const near = Float32Array.from({ length: Math.round(20.5 * rate) }, (_, i) => (i > 19.7 * rate && i < 19.9 * rate ? 0 : 0.3 * Math.sin(i / 3)));
	const tail = splitAtQuiet(near, 20);
	assert.equal(tail.length, 2);
	assert.ok(tail[1].length >= 2 * rate, `last piece ${tail[1].length / rate} s`);
	assert.equal(transcribeTimeoutMs(5), 120_000);
	assert.equal(transcribeTimeoutMs(300), 2_400_000, "five minutes of audio gets 40");
});

test("the setting falls back to automatic, and a GPU model on a device without one isn't used", async () => {
	const stored = {};
	globalThis.chrome = { storage: { local: { get: async (key) => ({ [key]: stored.value }) } } };
	stored.value = { model: "nonsense", language: "<script>" };
	assert.deepEqual(await readSetting(), { model: "auto", language: "auto" });
	stored.value = { model: "base", language: "de" };
	assert.deepEqual(await readSetting(), { model: "base", language: "de" });
	// Node has no navigator.gpu: the device has no WebGPU, so a chosen GPU model gives way.
	stored.value = { model: "turbo", language: "auto" };
	const resolved = await resolveModel();
	assert.equal(resolved.spec.device, "wasm");
	stored.value = { model: "moonshine", language: "en" };
	const english = await resolveModel();
	assert.equal(english.spec.id, MODELS.moonshine.id, "English keeps the English-only model");
	assert.equal(english.language, undefined, "an English-only model gets no language");
	stored.value = { model: "toString", language: "auto" };
	assert.equal((await readSetting()).model, "auto", "prototype names aren't models");
	stored.value = { model: "moonshine", language: "es" };
	assert.equal((await resolveModel()).spec.multilingual, true, "an English-only model chosen with Spanish gives way");
	// "Detect it" on a German browser is German: an English-only model gives way there too.
	const browserLanguage = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "language");
	Object.defineProperty(navigator, "language", { value: "de-DE", configurable: true });
	stored.value = { model: "moonshine", language: "auto" };
	assert.equal((await resolveModel()).spec.multilingual, true, "auto on a German browser");
	delete navigator.language;
	if (browserLanguage) assert.equal(navigator.language, browserLanguage.get.call(navigator));
	stored.value = { model: "auto", language: "de" };
	const german = await resolveModel();
	assert.equal(german.spec.multilingual, true, "automatic with German picks a multilingual model");
	assert.equal(german.language, "de");
	delete globalThis.chrome;
});

test("a fresh build ships the speech runtime and points nothing at a CDN", () => {
	const repo = fileURLToPath(new URL("..", import.meta.url));
	const out = mkdtempSync(join(tmpdir(), "tabkyra-dictation-build-"));
	try {
		execFileSync(process.execPath, [join(repo, "scripts", "build.mjs")], {
			cwd: repo,
			env: { ...process.env, TABKYRA_NO_BUMP: "1", TABKYRA_OUT_DIR: out },
			stdio: "pipe",
		});
		assert.deepEqual(readdirSync(join(out, "ort")).sort(), ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]);
		const worker = readFileSync(join(out, "dictation-worker.js"), "utf8");
		assert.doesNotMatch(worker, /cdn\.jsdelivr\.net/);
		assert.match(worker, /[`"']\/ort\/[`"']/, "the runtime's default points at the extension's copy");
		assert.ok(existsSync(join(out, "mic-permission.js")));
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("the speech runtime ships with the extension: no CDN, wasm allowed by the CSP, models from Hugging Face only", () => {
	const manifest = JSON.parse(read("static/manifest.chrome.json"));
	assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
	const build = read("scripts/build.mjs");
	assert.match(build, /ort-wasm-simd-threaded\.asyncify\.wasm/);
	assert.match(build, /cdn\.jsdelivr\.net/, "the build rewrites the runtime's CDN default");
	assert.match(build, /no longer defaults to jsDelivr/, "and fails if that default moves");
	assert.match(build, /transformers\.web\.js wasn't bundled/, "or if the file holding it isn't bundled");
	const worker = read("src/dictation/worker.ts");
	assert.match(worker, /allowLocalModels = false/);
	assert.match(worker, /ort\/ort-wasm-simd-threaded\.asyncify\.mjs/);
	assert.doesNotMatch(worker, /await import\(/);
});
