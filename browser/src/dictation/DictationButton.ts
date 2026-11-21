/**
 * The composer's microphone: press to dictate, press again to stop; the words are added to the
 * message. Speech becomes text on this device (src/dictation/worker.ts); the first use downloads
 * the model the device can run best (src/dictation/tiers.ts), once.
 */

import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Loader2, Mic, Square } from "lucide";
import { Toast } from "../components/Toast.js";
import type { DictationRequest, DictationResponse, ModelSpec } from "./protocol.js";
import { MAX_SECONDS, MicPermissionError, type Recording, startRecording, trimSilence } from "./recorder.js";
import { modelCached, resolveModel, transcribeTimeoutMs } from "./settings.js";
import { MODELS } from "./tiers.js";

type Phase = "idle" | "starting" | "recording" | "transcribing";

/** A first download at least this big is asked for, not just announced. */
const ASK_ABOVE_MB = 200;
/** A model load that reports nothing for this long (no download progress) has stalled. */
const LOAD_IDLE_MS = 3 * 60_000;

let worker: Worker | undefined;
let seq = 0;
/** When the worker last said anything; a load's stall timer reads it. */
let lastHeard = 0;
const waiting = new Map<number, (r: DictationResponse) => void>();
const progressListeners = new Set<(loaded: number, total: number) => void>();

/** A worker that fails to start or crashes answers nothing: settle every request and start over next time. */
function failWorker(message: string): void {
	worker?.terminate();
	worker = undefined;
	for (const [id, resolve] of waiting) resolve({ type: "error", id, message });
	waiting.clear();
}

function dictationWorker(): Worker {
	if (worker) return worker;
	worker = new Worker(chrome.runtime.getURL("dictation-worker.js"), { type: "module" });
	worker.onmessage = (event: MessageEvent<DictationResponse>) => {
		const m = event.data;
		lastHeard = Date.now();
		if (m.type === "progress") {
			for (const l of progressListeners) l(m.loaded, m.total);
			return;
		}
		waiting.get(m.id)?.(m);
		waiting.delete(m.id);
	};
	worker.onerror = (event) => failWorker(`the speech worker stopped (${event.message || "no reason given"})`);
	worker.onmessageerror = () => failWorker("the speech worker sent a message that couldn't be read");
	return worker;
}

function ask(request: DictationRequest, timeoutMs?: number): Promise<DictationResponse> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs)
			timer = setTimeout(
				() => failWorker("transcription took too long; the speech worker was restarted"),
				timeoutMs,
			);
		else if (request.type === "load") {
			// A download can take many minutes; one that reports nothing for LOAD_IDLE_MS has stalled.
			lastHeard = Date.now();
			const check = () => {
				if (Date.now() - lastHeard >= LOAD_IDLE_MS)
					failWorker("the speech model stopped downloading; check the connection and try again");
				else timer = setTimeout(check, 15_000);
			};
			timer = setTimeout(check, 15_000);
		}
		waiting.set(request.id, (r) => {
			clearTimeout(timer);
			resolve(r);
		});
		const transfer = request.type === "transcribe" ? [request.audio.buffer] : [];
		dictationWorker().postMessage(request, transfer);
	});
}

/** Start loading the model while the user talks, so the first transcript isn't kept waiting. */
function preload(model: ModelSpec): Promise<DictationResponse> {
	return ask({ type: "load", id: ++seq, model });
}

/**
 * A large first download is the user's call. Cancel (or Esc, which a native dialog reads as
 * Cancel) only stops this dictation and changes no setting; a smaller model is a choice made in
 * Settings. `live` is false once the start was cancelled: then no prompt is shown.
 */
async function confirmDownload(spec: ModelSpec, live: () => boolean): Promise<boolean> {
	if (spec.downloadMB < ASK_ABOVE_MB || (await modelCached(spec))) return true;
	if (!live()) return false;
	const light = [MODELS.moonshine, MODELS.base].map((m) => `${m.label} (${m.downloadMB} MB)`).join(" or ");
	return confirm(
		`Dictation runs ${spec.label} on this computer. It's a ${spec.downloadMB} MB download, once.\n\n` +
			`OK downloads it now. Cancel stops; for a smaller model, such as ${light}, pick one in Settings > Privacy > Dictation.`,
	);
}

@customElement("tabkyra-dictation")
export class DictationButton extends LitElement {
	/** The composer's text now, and how to replace it. */
	@property({ attribute: false }) value = "";
	@property({ attribute: false }) setValue?: (value: string) => void;
	@state() private phase: Phase = "idle";
	@state() private level = 0;
	@state() private download?: { loaded: number; total: number };
	private recording?: Recording;
	private meter?: number;
	private model?: { spec: ModelSpec; language?: string };
	private loaded?: Promise<DictationResponse>;
	/** Bumped by every start and cancel: a start whose number is stale was cancelled while it waited. */
	private startSeq = 0;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	private readonly onProgress = (loaded: number, total: number) => {
		this.download = total > 0 && loaded < total ? { loaded, total } : undefined;
	};

	/** Esc cancels from anywhere in the panel while recording, not only on the button. */
	private readonly onDocumentKeydown = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || (this.phase !== "recording" && this.phase !== "starting")) return;
		e.preventDefault();
		e.stopPropagation();
		this.cancel();
	};

	override connectedCallback(): void {
		super.connectedCallback();
		progressListeners.add(this.onProgress);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		progressListeners.delete(this.onProgress);
		this.cancel();
	}

	private cancel(): void {
		this.startSeq++;
		this.recording?.cancel();
		this.recording = undefined;
		document.removeEventListener("keydown", this.onDocumentKeydown, true);
		if (this.meter) cancelAnimationFrame(this.meter);
		if (this.phase === "recording" || this.phase === "starting") this.phase = "idle";
	}

	private async start(): Promise<void> {
		// Set before any await, so a second click can't open a second microphone.
		this.phase = "starting";
		this.loaded = undefined;
		const run = ++this.startSeq;
		// Esc or the panel closing during any wait below abandons this start.
		const live = () => run === this.startSeq && this.isConnected;
		document.addEventListener("keydown", this.onDocumentKeydown, true);
		let recording: Recording;
		try {
			const model = await resolveModel();
			if (!live()) return;
			if (!(await confirmDownload(model.spec, live))) {
				if (live()) this.cancel();
				return;
			}
			if (!live()) return;
			this.model = model;
			recording = await startRecording(() => {
				Toast.info(`Dictation stops at ${MAX_SECONDS / 60} minutes; here is what you said.`);
				void this.stop();
			});
		} catch (err) {
			if (!live()) return;
			this.phase = "idle";
			document.removeEventListener("keydown", this.onDocumentKeydown, true);
			if (err instanceof MicPermissionError) {
				Toast.info("Allow the microphone in the tab that opened, then press the microphone again.", 6000);
				void chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html"), active: true });
			} else Toast.error(`Dictation couldn't start: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		// Esc, or the panel closing, while the microphone was opening.
		if (!live()) {
			recording.cancel();
			return;
		}
		const spec = this.model.spec;
		// The load starts before the button can be pressed to stop, so a stop always waits for it.
		this.loaded = preload(spec);
		this.recording = recording;
		this.phase = "recording";
		void modelCached(spec).then((cached) => {
			if (!cached)
				Toast.info(
					`First dictation: downloading ${spec.label}, about ${spec.downloadMB} MB, once. Keep talking.`,
					6000,
				);
		});
		const tick = () => {
			this.level = this.recording?.level() ?? 0;
			if (this.phase === "recording") this.meter = requestAnimationFrame(tick);
		};
		tick();
	}

	private async stop(): Promise<void> {
		const recording = this.recording;
		const model = this.model;
		this.recording = undefined;
		document.removeEventListener("keydown", this.onDocumentKeydown, true);
		if (!recording || !model) return;
		this.phase = "transcribing";
		try {
			const audio = trimSilence(await recording.stop());
			if (audio.length === 0) {
				Toast.info("No speech heard. Check the microphone and try again.");
				return;
			}
			const loaded = await this.loaded;
			if (loaded?.type === "error") throw new Error(loaded.message);
			const reply = await ask(
				{ type: "transcribe", id: ++seq, model: model.spec, audio, language: model.language },
				transcribeTimeoutMs(audio.length / 16_000),
			);
			if (reply.type === "error") throw new Error(reply.message);
			if (reply.type === "text" && reply.text) {
				const before = this.value.replace(/\s+$/, "");
				this.setValue?.(before ? `${before} ${reply.text}` : reply.text);
			}
		} catch (err) {
			Toast.error(`Dictation failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.phase = "idle";
			this.download = undefined;
		}
	}

	private onClick = () => {
		if (this.phase === "idle") void this.start();
		else if (this.phase === "recording") void this.stop();
	};

	override render(): TemplateResult {
		const recording = this.phase === "recording";
		const busy = this.phase === "transcribing" || this.phase === "starting";
		const pct = this.download ? Math.round((this.download.loaded / this.download.total) * 100) : undefined;
		const label = recording
			? "Stop dictating and add the text"
			: this.phase === "starting"
				? "Opening the microphone"
				: busy
					? pct !== undefined
						? `Downloading the speech model (${pct}%)`
						: "Turning speech into text on this device"
					: "Dictate (speech to text on this device)";
		return html`<button
				type="button"
				class="relative h-8 w-8 inline-flex items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:cursor-wait ${
					recording ? "bg-destructive/15 text-destructive" : "text-foreground hover:bg-accent"
				}"
				aria-label=${label}
				aria-pressed=${recording ? "true" : "false"}
				title=${label}
				?disabled=${busy}
				@click=${this.onClick}
			>
				${busy ? icon(Loader2, "sm", "animate-spin") : recording ? icon(Square, "sm") : icon(Mic, "sm")}
				${
					recording
						? html`<span
								class="absolute bottom-0.5 left-1.5 right-1.5 h-0.5 rounded-full bg-destructive origin-left"
								style="transform: scaleX(${Math.max(0.08, this.level)})"
								aria-hidden="true"
							></span>`
						: nothing
				}
			</button>
			<span class="sr-only" role="status">${recording ? "Listening" : busy ? label : ""}</span>`;
	}
}
