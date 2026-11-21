/**
 * Which speech model this device should run: the strongest one it can run at a usable speed.
 * Pure, so the choice is tested without a browser. Sizes are the downloads at the pinned commits
 * (onnx-community repos on Hugging Face, measured 2026-10-28).
 */

import type { ModelSpec } from "./protocol.js";

export interface DeviceProfile {
	/** navigator.gpu returned an adapter. */
	webgpu: boolean;
	/** The adapter has shader-f16 (half-precision models run at full speed). */
	f16: boolean;
	/** navigator.deviceMemory in GB; undefined where the browser doesn't say. */
	memoryGB?: number;
	/** The adapter's maxBufferSize in bytes, when known. */
	maxBufferBytes?: number;
	/** navigator.language, e.g. "en-US". */
	language: string;
}

// 4-bit encoders are left out: they have been reported to drop speech. Decoders tolerate it.
export const MODELS = {
	turbo: {
		id: "onnx-community/whisper-large-v3-turbo",
		revision: "360ebcde2559d60bb474678be3c1de9ef347d01a",
		device: "webgpu",
		dtype: { encoder_model: "fp16", decoder_model_merged: "q4f16" },
		multilingual: true,
		downloadMB: 1470,
		label: "Whisper large-v3 turbo",
	},
	small: {
		id: "onnx-community/whisper-small",
		revision: "36050c46d777d46dc4b5f43f6d90574fc38f8732",
		device: "webgpu",
		dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
		multilingual: true,
		downloadMB: 590,
		label: "Whisper small",
	},
	moonshine: {
		id: "onnx-community/moonshine-base-ONNX",
		revision: "b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad",
		device: "wasm",
		dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
		multilingual: false,
		downloadMB: 63,
		label: "Moonshine base (English)",
	},
	base: {
		id: "onnx-community/whisper-base",
		revision: "1846881b6b3a3024392c1eea3ad983695bc23925",
		device: "wasm",
		dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
		multilingual: true,
		downloadMB: 77,
		label: "Whisper base",
	},
	moonshineTiny: {
		id: "onnx-community/moonshine-tiny-ONNX",
		revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
		device: "wasm",
		dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
		multilingual: false,
		downloadMB: 28,
		label: "Moonshine tiny (English)",
	},
	tiny: {
		id: "onnx-community/whisper-tiny",
		revision: "ff4177021cc41f7db950912b73ea4fdf7d01d8e7",
		device: "wasm",
		dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
		multilingual: true,
		downloadMB: 41,
		label: "Whisper tiny",
	},
} as const satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;

/**
 * The model for this device, and why, in words the setting can show. `language` is the one chosen
 * in Settings: "auto" goes by the browser's language, and only English gets an English-only model.
 */
export function chooseModel(device: DeviceProfile, language = "auto"): { key: ModelKey; why: string } {
	const english = language === "auto" ? /^en\b/i.test(device.language) : language === "en";
	const memory = device.memoryGB;
	const bigBuffers = device.maxBufferBytes === undefined || device.maxBufferBytes >= 1024 ** 3;
	if (device.webgpu && device.f16 && (memory === undefined || memory >= 8) && bigBuffers)
		return { key: "turbo", why: "a GPU with half precision and 8 GB or more of memory" };
	if (device.webgpu && (memory === undefined || memory >= 4))
		return { key: "small", why: device.f16 ? "a GPU, with less memory" : "a GPU without half precision" };
	if (memory !== undefined && memory < 4)
		return english
			? { key: "moonshineTiny", why: "little memory; the lightest strong English model" }
			: { key: "tiny", why: "little memory; the lightest multilingual model" };
	return english
		? { key: "moonshine", why: "no usable GPU; the fastest strong English model on the processor" }
		: { key: "base", why: "no usable GPU; a multilingual model small enough for the processor" };
}

/** What the browser says about this device. Runs in a page or worker. */
export async function profileDevice(): Promise<DeviceProfile> {
	const nav = navigator as Navigator & {
		gpu?: { requestAdapter(): Promise<{ features: Set<string>; limits: { maxBufferSize?: number } } | null> };
		deviceMemory?: number;
	};
	let adapter: Awaited<ReturnType<NonNullable<typeof nav.gpu>["requestAdapter"]>> = null;
	try {
		adapter = (await nav.gpu?.requestAdapter()) ?? null;
	} catch {
		adapter = null;
	}
	return {
		webgpu: !!adapter,
		f16: !!adapter?.features.has("shader-f16"),
		memoryGB: nav.deviceMemory,
		maxBufferBytes: adapter?.limits.maxBufferSize,
		language: nav.language || "en",
	};
}
