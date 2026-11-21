/**
 * Dictation worker: speech to text on this device, off the side panel's thread. The audio never
 * leaves the browser; only the model's files are downloaded, once, from Hugging Face at a pinned
 * revision and cached in this extension's storage. The ONNX runtime is the copy shipped inside the
 * extension (<out>/ort/): no code is fetched from anywhere.
 */

import { env, pipeline } from "@huggingface/transformers";
import type { DictationRequest, DictationResponse } from "./protocol.js";
import { splitAtQuiet } from "./recorder.js";

// Everything from the extension or the pinned model repo; nothing from a CDN.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// The runtime's own cache would turn its factory script into a blob: URL, which the extension's
// script-src 'self' refuses. Load it from the extension instead.
env.useWasmCache = false;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };
if (onnx.wasm) {
	// A worker has no chrome.* namespace; its own URL is on the extension's origin.
	onnx.wasm.wasmPaths = {
		mjs: new URL("ort/ort-wasm-simd-threaded.asyncify.mjs", self.location.href).href,
		wasm: new URL("ort/ort-wasm-simd-threaded.asyncify.wasm", self.location.href).href,
	};
	// Threads need cross-origin isolation, which extension pages don't have.
	onnx.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated
		? Math.min(4, navigator.hardwareConcurrency || 1)
		: 1;
}

type Transcriber = (
	audio: Float32Array,
	options: Record<string, unknown>,
) => Promise<{ text: string } | Array<{ text: string }>>;

let loaded: { key: string; run: Transcriber } | undefined;
const loading = new Map<string, Promise<Transcriber>>();
/** Loads run one after another, so a model is always disposed before the next one loads. */
let queue: Promise<unknown> = Promise.resolve();

const post = (message: DictationResponse) => (self as unknown as Worker).postMessage(message);

async function load(request: Extract<DictationRequest, { type: "load" }>): Promise<Transcriber> {
	const { model } = request;
	const key = `${model.id}@${model.revision}:${model.device}:${JSON.stringify(model.dtype)}`;
	if (loaded?.key === key) return loaded.run;
	const pending = loading.get(key);
	if (pending) return pending;
	const task = queue.then(async () => {
		if (loaded?.key === key) return loaded.run;
		// One model in memory at a time: the previous one's GPU and wasm memory is freed first.
		const previous = loaded;
		loaded = undefined;
		await (previous?.run as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
		const files = new Map<string, { loaded: number; total: number }>();
		const run = (await pipeline("automatic-speech-recognition", model.id, {
			revision: model.revision,
			device: model.device,
			dtype: model.dtype as never,
			// Every event is posted, so the side panel can tell a slow download from a stalled one.
			progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
				if (p.status === "progress" && p.file) files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
				let done = 0;
				let total = 0;
				for (const f of files.values()) {
					done += f.loaded;
					total += f.total;
				}
				post({ type: "progress", loaded: done, total });
			},
		})) as unknown as Transcriber;
		loaded = { key, run };
		return run;
	});
	queue = task.catch(() => undefined);
	loading.set(key, task);
	try {
		return await task;
	} finally {
		loading.delete(key);
	}
}

const textOf = (out: { text: string } | Array<{ text: string }>) =>
	(Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();

/** Whisper: the pipeline windows long audio itself, 30 s with overlap, and stitches the text. */
async function whisper(run: Transcriber, audio: Float32Array, language?: string): Promise<string> {
	return textOf(
		await run(audio, {
			chunk_length_s: 30,
			stride_length_s: 5,
			task: "transcribe",
			...(language ? { language } : {}),
		}),
	);
}

/** Moonshine reads a clip in one pass and the pipeline doesn't window it: pieces of 20 s or less, cut where it's quiet. */
async function inPieces(run: Transcriber, audio: Float32Array): Promise<string> {
	const parts: string[] = [];
	for (const piece of splitAtQuiet(audio, 20)) {
		// Moonshine sizes its output by the clip's length; under a second it can return nothing.
		const input = piece.length >= 16_000 ? piece : Float32Array.from({ length: 16_000 }, (_, i) => piece[i] ?? 0);
		parts.push(textOf(await run(input, {})));
	}
	return parts.filter(Boolean).join(" ");
}

self.onmessage = async (event: MessageEvent<DictationRequest>) => {
	const request = event.data;
	try {
		if (request.type === "load") {
			await load(request);
			post({ type: "ready", id: request.id });
			return;
		}
		if (request.type === "transcribe") {
			const run = await load({ type: "load", id: request.id, model: request.model });
			const t0 = performance.now();
			const text = request.model.id.includes("whisper")
				? await whisper(run, request.audio, request.language)
				: await inPieces(run, request.audio);
			post({ type: "text", id: request.id, text, ms: Math.round(performance.now() - t0) });
		}
	} catch (err) {
		post({ type: "error", id: request.id, message: err instanceof Error ? err.message : String(err) });
	}
};
