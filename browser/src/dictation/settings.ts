/** The dictation setting: which model (automatic by device, or a chosen one) and which language. */

import type { ModelSpec } from "./protocol.js";
import { chooseModel, MODELS, type ModelKey, profileDevice } from "./tiers.js";

export const DICTATION_KEY = "tabkyra.dictation";
/** Where transformers.js keeps downloaded model files (its default Cache Storage name). */
export const MODEL_CACHE = "transformers-cache";

/**
 * Longest a transcription may take before the button gives up and recovers: scaled to the audio,
 * since a processor model with one thread can take several times the clip's length.
 */
export const transcribeTimeoutMs = (seconds: number) => Math.max(2 * 60_000, seconds * 8_000);

export interface DictationSetting {
	model: "auto" | ModelKey;
	/** "auto" lets a multilingual model detect it; otherwise an ISO code such as "de". */
	language: string;
}

export const DEFAULT_SETTING: DictationSetting = { model: "auto", language: "auto" };

export async function readSetting(): Promise<DictationSetting> {
	const stored = (await chrome.storage.local.get(DICTATION_KEY))[DICTATION_KEY] as
		| Partial<DictationSetting>
		| undefined;
	const model =
		stored?.model === "auto" || (typeof stored?.model === "string" && Object.hasOwn(MODELS, stored.model))
			? stored.model
			: "auto";
	const language =
		typeof stored?.language === "string" && /^(auto|[a-z]{2,3})$/.test(stored.language) ? stored.language : "auto";
	return { model, language };
}

export async function writeSetting(setting: DictationSetting): Promise<void> {
	await chrome.storage.local.set({ [DICTATION_KEY]: setting });
}

/** The model to run now, and the language to ask it for (none: let it detect). */
export async function resolveModel(): Promise<{ spec: ModelSpec; language?: string; why: string }> {
	const setting = await readSetting();
	const device = await profileDevice();
	const auto = chooseModel(device, setting.language);
	let key: ModelKey = setting.model === "auto" ? auto.key : setting.model;
	// A chosen model that can't do the job falls back to the automatic one: a GPU model on a device
	// without a GPU, or an English-only model asked for another language.
	// "auto" means the browser's language, as in chooseModel.
	const otherLanguage = setting.language === "auto" ? !/^en\b/i.test(device.language) : setting.language !== "en";
	if (MODELS[key].device === "webgpu" && !device.webgpu) key = auto.key;
	if (otherLanguage && !MODELS[key].multilingual) key = auto.key;
	const spec = MODELS[key];
	return {
		spec,
		language: spec.multilingual && setting.language !== "auto" ? setting.language : undefined,
		why: setting.model === "auto" || key === auto.key ? auto.why : "chosen in Settings",
	};
}

/**
 * Downloaded model files: how many, and their size where the cached response says it (reading a
 * cached model to measure it would load hundreds of MB). Files without a size still count, so
 * Remove is offered.
 */
export async function cachedModels(): Promise<{ files: number; bytes: number }> {
	try {
		const cache = await caches.open(MODEL_CACHE);
		const requests = await cache.keys();
		let bytes = 0;
		for (const request of requests) {
			const response = await cache.match(request);
			bytes += Number(response?.headers.get("content-length") ?? 0);
		}
		return { files: requests.length, bytes };
	} catch {
		return { files: 0, bytes: 0 };
	}
}

/** transformers.js's file name suffix for each dtype (DEFAULT_DTYPE_SUFFIX_MAPPING). */
const DTYPE_SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4", q4f16: "_q4f16" };

/** The model's weight files, as transformers.js names them in the repo. */
export function modelFiles(spec: ModelSpec): string[] {
	return Object.entries(spec.dtype).map(([name, dtype]) => `onnx/${name}${DTYPE_SUFFIX[dtype] ?? `_${dtype}`}.onnx`);
}

/**
 * Whether this model's weights are downloaded (transformers.js keys its cache by file URL). Its
 * small files alone don't count: a download cut off after them still has the weights to fetch.
 */
export async function modelCached(spec: ModelSpec): Promise<boolean> {
	try {
		const cache = await caches.open(MODEL_CACHE);
		const base = `/${spec.id}/resolve/${spec.revision}/`;
		const urls = (await cache.keys()).map((request) => request.url);
		return modelFiles(spec).every((file) => urls.some((url) => url.includes(base + file)));
	} catch {
		return false;
	}
}

export async function removeCachedModels(): Promise<void> {
	await caches.delete(MODEL_CACHE);
}
