/**
 * The encoder for tab recordings, in the hidden page (offscreen.html). A service worker has no
 * MediaRecorder, so the worker sends this page the tab's frames and asks for the file.
 *
 * Frames come from the debugger's screencast (a background tab renders into it with nobody
 * looking; chrome.tabCapture needs the user to have clicked the extension on that tab, which no
 * agent session has). The worker sends one message every 100 ms, with a new JPEG when the page
 * drew one, so the video has a steady 10 frames a second and its timing doesn't depend on this
 * page's timers, which the browser slows down for a hidden page.
 *
 * `record`: every chunk is kept and the file is the whole recording (capped in bytes).
 * `flight`: chunks go through a WebmRing, which keeps the last minute as a file that plays.
 * Video only: no audio track is ever requested.
 */

import { WebmRing } from "../browser/webm-ring.js";
import { RECORDER_MESSAGE } from "./recorder-message.js";

interface Options {
	id: string;
	mode: "record" | "flight";
	/** Most bytes a recording holds; a flight recorder's ring has the same limit. */
	maxBytes: number;
	/** A recording ends itself after this long. */
	maxMs: number;
	windowMs: number;
}

interface Rec extends Options {
	startedAt: number;
	lastMessageAt: number;
	canvas?: HTMLCanvasElement;
	g?: CanvasRenderingContext2D;
	track?: CanvasCaptureMediaStreamTrack;
	recorder?: MediaRecorder;
	latest?: ImageBitmap;
	chunks: Blob[];
	bytes: number;
	ring?: WebmRing;
	/** Chunks are processed in order. */
	queue: Promise<void>;
	/** The encoder is stopped; what it produced is what there is. */
	stopped: boolean;
	stoppedAt?: number;
	truncated?: string;
	done?: Promise<void>;
}

const recs = new Map<string, Rec>();
const BITRATE = 600_000;
/// A recording whose worker stopped talking (the worker restarted) is closed after this long.
const SILENT_MS = 90_000;

function fail(error: string): { ok: false; error: string } {
	return { ok: false, error };
}

function toBlobBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
		reader.onerror = () => reject(reader.error ?? new Error("could not read the recording"));
		reader.readAsDataURL(blob);
	});
}

function jpegBlob(base64: string): Blob {
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: "image/jpeg" });
}

function pickType(): string {
	for (const type of ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"])
		if (MediaRecorder.isTypeSupported(type)) return type;
	return "";
}

/** Start the encoder on the first frame, whose size the video keeps. */
function startEncoder(r: Rec, first: ImageBitmap): void {
	// Even sizes: the encoder rounds odd ones.
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(2, first.width - (first.width % 2));
	canvas.height = Math.max(2, first.height - (first.height % 2));
	const g = canvas.getContext("2d");
	if (!g) throw new Error("This browser gave no canvas to draw the recording on.");
	const stream = canvas.captureStream(0);
	const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
	const type = pickType();
	const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: BITRATE });
	r.canvas = canvas;
	r.g = g;
	r.track = track;
	r.recorder = recorder;
	if (r.mode === "flight") r.ring = new WebmRing({ windowMs: r.windowMs, maxBytes: r.maxBytes });
	recorder.ondataavailable = (e) => {
		const blob = e.data;
		if (!blob.size) return;
		r.queue = r.queue.then(async () => {
			if (r.ring) r.ring.push(new Uint8Array(await blob.arrayBuffer()));
			else if (r.bytes + blob.size <= r.maxBytes) {
				r.chunks.push(blob);
				r.bytes += blob.size;
			} else if (!r.truncated) {
				r.truncated = `the recording reached its ${Math.round(r.maxBytes / 1048576)} MB size limit`;
				void stopEncoder(r);
			}
		});
	};
	r.done = new Promise((resolve) => {
		recorder.onstop = () => resolve();
	});
	recorder.start(1000);
}

/** Stop the encoder and wait for its last bytes. Safe to call twice. */
async function stopEncoder(r: Rec): Promise<void> {
	if (!r.stopped) {
		r.stopped = true;
		r.stoppedAt = performance.now();
		if (r.recorder && r.recorder.state !== "inactive") r.recorder.stop();
		else if (!r.recorder) return;
	}
	await r.done;
	await r.queue;
	r.latest?.close();
	r.latest = undefined;
}

function draw(r: Rec): void {
	if (!r.g || !r.canvas || !r.latest || r.stopped) return;
	r.g.drawImage(r.latest, 0, 0, r.canvas.width, r.canvas.height);
	r.track?.requestFrame();
}

async function frame(r: Rec, jpeg: string | undefined): Promise<void> {
	if (r.stopped) return;
	if (jpeg) {
		const bitmap = await createImageBitmap(jpegBlob(jpeg));
		const old = r.latest;
		r.latest = bitmap;
		old?.close();
		if (!r.recorder) startEncoder(r, bitmap);
	}
	draw(r);
}

function sizeSpan(r: Rec): { bytes: number; spanMs: number } {
	if (r.ring) return { bytes: r.ring.bytes, spanMs: r.ring.spanMs };
	return { bytes: r.bytes, spanMs: Math.round((r.stoppedAt ?? performance.now()) - r.startedAt) };
}

type Answer = { ok: true; [key: string]: unknown } | { ok: false; error: string };

async function handle(msg: Record<string, unknown>): Promise<Answer> {
	const op = String(msg.op);
	const id = String(msg.id ?? "");
	if (op === "start") {
		if (recs.has(id)) return fail("That recording is already running.");
		const r: Rec = {
			id,
			mode: msg.mode === "flight" ? "flight" : "record",
			maxBytes: Number(msg.maxBytes) || 32 * 1024 * 1024,
			maxMs: Number(msg.maxMs) || 10 * 60 * 1000,
			windowMs: Number(msg.windowMs) || 60_000,
			startedAt: performance.now(),
			lastMessageAt: performance.now(),
			chunks: [],
			bytes: 0,
			queue: Promise.resolve(),
			stopped: false,
		};
		recs.set(id, r);
		setTimeout(() => {
			if (!r.stopped && recs.get(id) === r) {
				r.truncated ??= "the recording reached its time limit";
				void stopEncoder(r);
			}
		}, r.maxMs);
		return { ok: true };
	}
	const r = recs.get(id);
	if (!r) return fail("That recording is not here (the browser's hidden page restarted).");
	r.lastMessageAt = performance.now();
	switch (op) {
		case "frame":
			await frame(r, typeof msg.jpeg === "string" ? msg.jpeg : undefined);
			return { ok: true };
		case "status":
			return { ok: true, ...sizeSpan(r) };
		case "save": {
			// A flight recorder's buffer as it stands; recording goes on.
			if (!r.recorder || !r.ring) return fail("Nothing has been recorded yet.");
			if (r.recorder.state === "recording") r.recorder.requestData();
			await r.queue;
			const file = r.ring.snapshot();
			if (!file) return fail("Nothing has been recorded yet: no full second of video is held.");
			return {
				ok: true,
				data: await toBlobBase64(new Blob([file as BlobPart], { type: "video/webm" })),
				bytes: file.length,
				durationMs: r.ring.spanMs,
			};
		}
		case "finish": {
			await stopEncoder(r);
			let answer: Answer;
			if (r.ring) {
				const file = r.ring.snapshot();
				answer = file
					? {
							ok: true,
							data: await toBlobBase64(new Blob([file as BlobPart], { type: "video/webm" })),
							bytes: file.length,
							durationMs: r.ring.spanMs,
						}
					: fail("Nothing was recorded.");
			} else if (r.chunks.length === 0) answer = fail("Nothing was recorded: no frame of the tab arrived.");
			else {
				const blob = new Blob(r.chunks, { type: "video/webm" });
				answer = {
					ok: true,
					data: await toBlobBase64(blob),
					bytes: blob.size,
					durationMs: Math.round((r.stoppedAt ?? performance.now()) - r.startedAt),
					...(r.truncated ? { truncated: r.truncated } : {}),
				};
			}
			recs.delete(id);
			return answer;
		}
		case "halt":
			// No more frames are coming (the tab went away or the time ran out): finish encoding, keep the bytes.
			await stopEncoder(r);
			return { ok: true };
		case "discard":
			await stopEncoder(r);
			recs.delete(id);
			return { ok: true };
		default:
			return fail(`Unknown recorder request ${op}.`);
	}
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	if (msg?.type !== RECORDER_MESSAGE || sender.id !== chrome.runtime.id) return false;
	handle(msg).then(reply, (err) => reply(fail(err instanceof Error ? err.message : String(err))));
	return true;
});

// A worker that restarted never comes back for its recording: stop encoding, keep the bytes until asked (the
// worker's own sweep throws them away after half an hour).
setInterval(() => {
	const now = performance.now();
	for (const r of recs.values())
		if (!r.stopped && now - r.lastMessageAt > SILENT_MS) {
			r.truncated ??= "the browser's background worker stopped sending frames";
			void stopEncoder(r);
		}
}, 15_000);
