/** Messages between the side panel and the dictation worker (src/dictation/worker.ts). */

/** A speech model the worker can run: a Hugging Face repo at a pinned commit, on a device. */
export interface ModelSpec {
	/** onnx-community/... repo id. */
	id: string;
	/** A commit id, never a branch: a model swapped upstream is not loaded silently. */
	revision: string;
	device: "webgpu" | "wasm";
	/** Per-file data types, as transformers.js takes them. */
	dtype: string | Record<string, string>;
	/** Whisper models take a language; English-only models don't. */
	multilingual: boolean;
	/** Approximate download, for the setting that offers it. */
	downloadMB: number;
	/** What the user sees: "Whisper large-v3 turbo (GPU)". */
	label: string;
}

export type DictationRequest =
	| { type: "load"; id: number; model: ModelSpec }
	| { type: "transcribe"; id: number; model: ModelSpec; audio: Float32Array; language?: string };

export type DictationResponse =
	| { type: "progress"; loaded: number; total: number }
	| { type: "ready"; id: number }
	| { type: "text"; id: number; text: string; ms: number }
	| { type: "error"; id: number; message: string };
