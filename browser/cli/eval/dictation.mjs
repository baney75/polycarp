// Dictation eval: does on-device speech to text work in the built extension, how well, and how
// fast? Two parts, no model API involved:
//
//   models  each model in src/dictation/tiers.ts (or --models a,b) loads in the real dictation
//           worker inside the extension and transcribes the clips; word error rate and time
//   button  the composer's microphone end to end: Chromium's fake microphone plays a clip, the
//           button is pressed, then pressed again, and the words must land in the message box
//
//   node cli/eval/dictation.mjs --extension <built extension dir> [--models moonshine,base|none] [--out file.json]
//
// Clips are WAV files with a reference transcript: --clips dir holds <name>.wav and <name>.txt.
// Needs Playwright's Chromium. The first run downloads the models (up to about 1 GB for all).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";

const arg = (name) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const EXTENSION = arg("extension");
const CLIPS = arg("clips");
const OUT = arg("out");
const MODELS = arg("models") === "none" ? [] : arg("models")?.split(",");
const PROFILE = arg("profile") ?? mkdtempSync(join(tmpdir(), "tk-dictation-"));
if (!EXTENSION || !CLIPS) {
	console.error("usage: node cli/eval/dictation.mjs --extension <dir> --clips <dir of name.wav + name.txt> [--models a,b] [--profile dir] [--out file.json]");
	process.exit(1);
}

/** Word error rate: edit distance over words, lowercase, punctuation removed. */
export function wer(reference, hypothesis) {
	const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/-/g, " ").split(/\s+/).filter(Boolean);
	const r = words(reference);
	const h = words(hypothesis);
	const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
	for (let j = 1; j <= h.length; j++) d[0][j] = j;
	for (let i = 1; i <= r.length; i++)
		for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
	return r.length ? d[r.length][h.length] / r.length : 0;
}

/** A WAV file's length in seconds, read from its fmt and data chunks (other chunks, such as JUNK, skipped). */
function wavSeconds(wav) {
	let byteRate = 0;
	for (let at = 12; at + 8 <= wav.length; ) {
		const id = wav.toString("ascii", at, at + 4);
		const size = wav.readUInt32LE(at + 4);
		if (id === "fmt ") byteRate = wav.readUInt32LE(at + 16);
		if (id === "data" && byteRate) return size / byteRate;
		at += 8 + size + (size % 2);
	}
	throw new Error("not a PCM WAV file");
}

const clips = readdirSync(CLIPS)
	.filter((f) => f.endsWith(".wav"))
	.map((f) => ({ name: basename(f, ".wav"), wav: join(CLIPS, f), reference: readFileSync(join(CLIPS, `${basename(f, ".wav")}.txt`), "utf8").trim() }));

const server = createServer((req, res) => {
	const clip = clips.find((c) => req.url === `/${c.name}.wav`);
	if (!clip) {
		res.writeHead(404);
		res.end();
		return;
	}
	res.writeHead(200, { "content-type": "audio/wav", "access-control-allow-origin": "*" });
	res.end(readFileSync(clip.wav));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(PROFILE, {
	channel: "chromium",
	headless: true,
	viewport: { width: 420, height: 860 },
	args: [
		`--disable-extensions-except=${EXTENSION}`,
		`--load-extension=${EXTENSION}`,
		"--enable-unsafe-webgpu",
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		`--use-file-for-fake-audio-capture=${clips[0].wav}`,
	],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
const report = { at: new Date().toISOString(), extension: EXTENSION, device: undefined, models: [], button: undefined };

try {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${id}/sidepanel.html`);
	await page.waitForTimeout(1500);
	report.device = await page.evaluate(async () => {
		const adapter = await navigator.gpu?.requestAdapter?.().catch(() => null);
		return { webgpu: !!adapter, f16: !!adapter?.features?.has("shader-f16"), memoryGB: navigator.deviceMemory, cores: navigator.hardwareConcurrency };
	});
	console.log("device", JSON.stringify(report.device));

	// ---- models ---------------------------------------------------------------------
	const tiers = readFileSync(new URL("../../src/dictation/tiers.ts", import.meta.url), "utf8");
	const specs = {};
	for (const m of tiers.matchAll(/^\t(\w+): \{\n([\s\S]*?)\n\t\},/gm)) {
		const body = m[2];
		const get = (k) => body.match(new RegExp(`${k}: "([^"]+)"`))?.[1];
		specs[m[1]] = {
			id: get("id"),
			revision: get("revision"),
			device: get("device"),
			dtype: JSON.parse(body.match(/dtype: (\{[^}]*\})/)[1].replace(/(\w+):/g, '"$1":')),
			multilingual: /multilingual: true/.test(body),
			downloadMB: Number(body.match(/downloadMB: (\d+)/)[1]),
			label: get("label"),
		};
	}
	const keys = MODELS ?? Object.keys(specs).filter((k) => specs[k].device === "wasm" || report.device.webgpu);
	for (const key of keys) {
		const spec = specs[key];
		if (!spec) throw new Error(`no model ${key} in tiers.ts`);
		if (spec.device === "webgpu" && !report.device.webgpu) {
			report.models.push({ key, skipped: "no WebGPU in this browser" });
			console.log(`${key.padEnd(10)} skipped: no WebGPU`);
			continue;
		}
		const result = await page.evaluate(
			async ({ spec, clips, base }) => {
				const worker = new Worker(chrome.runtime.getURL("dictation-worker.js"), { type: "module" });
				let seq = 0;
				// A worker that fails to start fires "error", never "message": answer either way, and
				// give up after 15 minutes (the largest model is about 1.5 GB to download).
				const ask = (msg) =>
					new Promise((resolve) => {
						const timer = setTimeout(() => resolve({ type: "error", message: "timed out" }), 15 * 60 * 1000);
						const listen = (e) => {
							if (e.data.id !== msg.id) return;
							clearTimeout(timer);
							worker.removeEventListener("message", listen);
							resolve(e.data);
						};
						worker.addEventListener("message", listen);
						worker.addEventListener("error", (e) => {
							clearTimeout(timer);
							resolve({ type: "error", message: `worker: ${e.message}` });
						});
						worker.postMessage(msg);
					});
				const t0 = performance.now();
				const loaded = await ask({ type: "load", id: ++seq, model: spec });
				const loadMs = Math.round(performance.now() - t0);
				if (loaded.type === "error") return { error: loaded.message, loadMs };
				const out = [];
				for (const clip of clips) {
					const encoded = await (await fetch(`${base}/${clip.name}.wav`)).arrayBuffer();
					const ctx = new AudioContext({ sampleRate: 16000 });
					const audio = (await ctx.decodeAudioData(encoded)).getChannelData(0).slice();
					await ctx.close();
					const t1 = performance.now();
					// No language: what the product sends by default ("auto"), so Whisper detects it.
						const reply = await ask({ type: "transcribe", id: ++seq, model: spec, audio, language: undefined });
					out.push({ name: clip.name, seconds: audio.length / 16000, ms: Math.round(performance.now() - t1), text: reply.text ?? "", error: reply.message });
				}
				worker.terminate();
				return { loadMs, clips: out };
			},
			{ spec, clips: clips.map((c) => ({ name: c.name })), base },
		);
		if (result.error) {
			report.models.push({ key, error: result.error, loadMs: result.loadMs });
			console.log(`${key.padEnd(10)} ERROR ${result.error}`);
			continue;
		}
		const rows = result.clips.map((c) => ({ ...c, wer: wer(clips.find((x) => x.name === c.name).reference, c.text), rtf: c.ms / 1000 / c.seconds }));
		const meanWer = rows.reduce((a, r) => a + r.wer, 0) / rows.length;
		const meanRtf = rows.reduce((a, r) => a + r.rtf, 0) / rows.length;
		report.models.push({ key, label: spec.label, device: spec.device, loadMs: result.loadMs, wer: meanWer, rtf: meanRtf, clips: rows });
		console.log(`${key.padEnd(10)} ${spec.device.padEnd(6)} WER ${(meanWer * 100).toFixed(1)}%  ${meanRtf.toFixed(2)}x real time  load ${result.loadMs} ms`);
		for (const r of rows) console.log(`           ${r.name}: ${JSON.stringify(r.text)}`);
	}

	// ---- button ----------------------------------------------------------------------
	// A first download of 200 MB or more asks with confirm(); accept it and record that it asked.
	page.on("dialog", (dialog) => {
		report.dialogs = [...(report.dialogs ?? []), dialog.message()];
		void dialog.accept();
	});
	await page.reload();
	await page.waitForTimeout(1500);
	await page.evaluate(() => {
		document.querySelector("welcome-setup-dialog")?.remove();
		document.querySelector("tabkyra-settings")?.close?.();
	});
	const mic = page.getByRole("button", { name: /^Dictate/ });
	await mic.click();
	// Chromium's fake microphone loops the file: stop as the clip ends, or its start comes again.
	const seconds = wavSeconds(readFileSync(clips[0].wav));
	await page.waitForTimeout(Math.round(seconds * 1000) + 250);
	await page.getByRole("button", { name: /^Stop dictating/ }).click();
	const box = page.locator("message-editor textarea");
	const text = await (async () => {
		for (let i = 0; i < 240; i++) {
			const v = await box.inputValue();
			if (v.trim()) return v;
			await page.waitForTimeout(500);
		}
		return "";
	})();
	report.button = { text, wer: text ? wer(clips[0].reference, text) : 1 };
	console.log(`button     composer got ${JSON.stringify(text)} (WER ${(report.button.wer * 100).toFixed(1)}%)`);
} finally {
	await context.close();
	server.close();
	if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
}
