/**
 * The browser side of captures (capture.ts has the rules): DevTools Network events folded into a
 * HAR (har.ts), and a tab's screencast sent to the hidden page, which encodes it (offscreen/recorder.ts).
 * One manager for the whole extension, so every session's captures are in one place and each is
 * checked against its own session.
 */

import { ERR } from "../bridge/protocol.js";
import { ensureOffscreen } from "../offscreen/document.js";
import { RECORDER_MESSAGE } from "../offscreen/recorder-message.js";
import { type CaptureBackend, CaptureError, CaptureManager, type CaptureOutput, type Run } from "./capture.js";
import { cdpSend, ensureAttached, networkCapturing, screencastOwner, startScreencast, stopScreencast } from "./cdp.js";
import { HAR_SIZE_CAP, HarBuilder } from "./har.js";
import { BrowserSession } from "./session.js";

const VIDEO_MAX_BYTES = 32 * 1024 * 1024;
const VIDEO_MAX_MS = 10 * 60 * 1000;
const FLIGHT_MAX_MS = 30 * 60 * 1000;
const FRAME_MS = 100;
const SWEEP_MS = 2000;

// ---- Network ------------------------------------------------------------------------------

interface NetworkState {
	tabId: number;
	builder: HarBuilder;
	/** Events are handled in order: a body fetch for one request waits for the events before it. */
	chain: Promise<void>;
	halted: boolean;
	onEnd: (why: string) => void;
}

const networkStates = new Map<number, NetworkState>();
let listening = false;

async function handleNetwork(state: NetworkState, method: string, params: Record<string, unknown>): Promise<void> {
	if (state.halted) return;
	const { builder, tabId } = state;
	const id = String(params.requestId ?? "");
	try {
		builder.event(method, params);
		if (method === "Network.loadingFinished" && builder.wantsResponseBody(id)) {
			try {
				const body = (await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", {
					requestId: id,
				})) as { body: string; base64Encoded: boolean };
				const text = body.base64Encoded
					? new TextDecoder().decode(Uint8Array.from(atob(body.body), (c) => c.charCodeAt(0)))
					: body.body;
				builder.setResponseBody(id, text);
			} catch {
				builder.complete(id);
			}
		}
		if (builder.full) {
			state.halted = true;
			state.onEnd(`it reached the ${Math.round(HAR_SIZE_CAP / 1_000_000)} MB size limit`);
		}
	} catch (err) {
		console.warn("[Capture] network event dropped:", method, err);
	}
}

function listen(): void {
	if (listening) return;
	listening = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const state = source.tabId === undefined ? undefined : networkStates.get(source.tabId);
		if (!state || state.halted || !method.startsWith("Network.")) return;
		const p = (params ?? {}) as Record<string, unknown>;
		state.chain = state.chain.then(() => handleNetwork(state, method, p));
	});
	chrome.debugger.onDetach.addListener((source, reason) => {
		const state = source.tabId === undefined ? undefined : networkStates.get(source.tabId);
		if (state && !state.halted) {
			state.halted = true;
			state.onEnd(`the browser detached the debugger from the tab (${reason})`);
		}
	});
	chrome.tabs.onRemoved.addListener((tabId) => captures.tabClosed(tabId));
}

function creator() {
	return { name: "Polycarp", version: chrome.runtime.getManifest().version };
}

async function startNetwork(tabId: number, _id: string, onEnd: (why: string) => void): Promise<Run> {
	listen();
	if (networkStates.has(tabId)) throw new CaptureError(ERR.BAD_PARAMS, `Tab ${tabId} is already being captured.`);
	await ensureAttached(tabId);
	const state: NetworkState = { tabId, builder: new HarBuilder(), chain: Promise.resolve(), halted: false, onEnd };
	networkStates.set(tabId, state);
	try {
		await cdpSend(tabId, "Network.enable");
	} catch (err) {
		networkStates.delete(tabId);
		throw err;
	}
	const release = async () => {
		state.halted = true;
		// Events already received finish first, but a stuck body read must not hold the stop.
		await Promise.race([state.chain, new Promise((r) => setTimeout(r, 3000))]);
		if (networkStates.get(tabId) === state) networkStates.delete(tabId);
		// read_network or a newer capture of this tab may be using the domain too: only switch it off when neither is.
		if (!networkCapturing(tabId) && !networkStates.has(tabId))
			await chrome.debugger.sendCommand({ tabId }, "Network.disable").catch(() => undefined);
	};
	return {
		async stats() {
			return { bytes: state.builder.size, entries: state.builder.count, full: state.builder.full };
		},
		halt: release,
		async finish(): Promise<CaptureOutput> {
			await release();
			const b = state.builder;
			const har = b.toHar(creator());
			const notes = [
				"Secrets are redacted: credential headers and query parameters, sign-in and password-page bodies, values under secret names. JSON responses from the page's own origin are included (64 KB at most); other bodies are not.",
				"Requests made by cross-site frames and by other tabs the page opened are not in it.",
			];
			if (b.full)
				notes.unshift(
					`It stopped at the ${Math.round(HAR_SIZE_CAP / 1_000_000)} MB size limit; ${b.dropped} later request(s) are not in it.`,
				);
			return {
				file: { kind: "har", encoding: "json", data: har, bytes: b.size },
				notes,
				entries: har.log.entries.length,
			};
		},
		async discard() {
			await release();
		},
	};
}

// ---- Video --------------------------------------------------------------------------------

type RecorderAnswer = { ok: true; [key: string]: unknown } | { ok: false; error: string };

async function recorder(op: string, id: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const answer = (await chrome.runtime.sendMessage({ type: RECORDER_MESSAGE, op, id, ...extra })) as
		| RecorderAnswer
		| undefined;
	if (!answer) throw new CaptureError(ERR.INTERNAL, "The video encoder didn't answer. Try again.");
	if (!answer.ok) throw new CaptureError(ERR.INTERNAL, answer.error);
	return answer;
}

async function startVideo(
	tabId: number,
	id: string,
	mode: "record" | "flight",
	onEnd: (why: string) => void,
): Promise<Run> {
	listen();
	const owner = `capture:${id}`;
	if (screencastOwner(tabId))
		throw new CaptureError(
			ERR.BAD_PARAMS,
			"This tab is already streaming to a live view. Try again when that has stopped.",
		);
	await ensureOffscreen();
	await recorder("start", id, {
		mode,
		maxBytes: VIDEO_MAX_BYTES,
		maxMs: mode === "flight" ? FLIGHT_MAX_MS : VIDEO_MAX_MS,
		windowMs: 60_000,
	});
	let latest: string | undefined;
	let fresh = false;
	let halted = false;
	const end = (why: string) => {
		if (!halted) onEnd(why);
	};
	try {
		await startScreencast(
			tabId,
			owner,
			{ format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, maxFps: 10 },
			(frame) => {
				latest = frame.data;
				fresh = true;
			},
			end,
		);
	} catch (err) {
		await recorder("discard", id).catch(() => undefined);
		throw err;
	}
	// Steady frames: a still page sends none, and a video needs one every 100 ms.
	const timer = setInterval(() => {
		if (halted) return;
		const jpeg = fresh ? latest : undefined;
		fresh = false;
		void chrome.runtime.sendMessage({ type: RECORDER_MESSAGE, op: "frame", id, jpeg }).catch(() => undefined);
	}, FRAME_MS);
	const halt = async () => {
		if (halted) return;
		halted = true;
		clearInterval(timer);
		// Another live view may have taken the tab over meanwhile; it is not ours to stop then.
		if (screencastOwner(tabId) === owner) await stopScreencast(tabId).catch(() => undefined);
		await recorder("halt", id).catch(() => undefined);
	};
	const output = (a: Record<string, unknown>, extra: string[] = []): CaptureOutput => {
		const notes = ["WebM video, no sound, 10 frames a second, at most 1280 by 800.", ...extra];
		if (typeof a.truncated === "string") notes.unshift(`The recording stopped when ${a.truncated}.`);
		return {
			file: { kind: "webm", encoding: "base64", data: String(a.data), bytes: Number(a.bytes) },
			notes,
			durationMs: Number(a.durationMs),
		};
	};
	return {
		async stats() {
			const a = await recorder("status", id);
			return { bytes: Number(a.bytes), spanMs: Number(a.spanMs) };
		},
		halt,
		async finish() {
			await halt();
			return output(await recorder("finish", id));
		},
		...(mode === "flight"
			? {
					async snapshot() {
						return output(await recorder("save", id), [
							"It covers the last 60 seconds and up to about 10 more: the video must start at a key frame, and the recorder makes one every 10 seconds or so.",
						]);
					},
				}
			: {}),
		async discard() {
			await halt();
			await recorder("discard", id).catch(() => undefined);
		},
	};
}

// ---- The manager --------------------------------------------------------------------------

const backend: CaptureBackend = {
	startNetwork,
	startVideo,
	async owns(sessionId, tabId) {
		const session = await BrowserSession.existing(sessionId);
		return session?.tabIds.includes(tabId) === true;
	},
};

let sweeper: ReturnType<typeof setInterval> | undefined;

export const captures = new CaptureManager(backend, {
	onActive: (active) => {
		if (active && !sweeper) sweeper = setInterval(() => void captures.sweep().catch(() => undefined), SWEEP_MS);
		else if (!active && sweeper) {
			clearInterval(sweeper);
			sweeper = undefined;
		}
	},
});
