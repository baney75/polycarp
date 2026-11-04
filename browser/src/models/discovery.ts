/**
 * Runtime model discovery. Each adapter asks a provider which models the current
 * credential can use and returns bare entries; metadata (cost, context, modalities)
 * is merged in by registry.ts from the generated table and models.dev.
 *
 * Only providers with a list endpoint are here. The rest keep the static table.
 */

import type { Api } from "@mariozechner/pi-ai";

export interface DiscoveredModel {
	id: string;
	name?: string;
	api: Api;
	baseUrl: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	headers?: Record<string, string>;
}

export interface DiscoveryCredential {
	/** The provider API key. */
	token: string;
}

type Adapter = (credential: DiscoveryCredential, signal: AbortSignal) => Promise<DiscoveredModel[]>;

const NON_CHAT =
	/embed|embedding|tts|whisper|transcri|audio|dall-e|image|moderation|realtime|rerank|guard|vision-preview-only|davinci|babbage|curie|ada|search|similarity|edit|instruct-preview|computer-use-preview|-preview-\d{4}/i;

function looksLikeChatModel(id: string): boolean {
	return !NON_CHAT.test(id);
}

async function getJson<T>(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<T> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText} from ${new URL(url).host}`);
	}
	return (await response.json()) as T;
}

interface OpenAIListResponse {
	data: Array<{
		id: string;
		context_length?: number;
		/** vLLM / SGLang / Local Studio report the served context here. */
		max_model_len?: number;
		max_tokens?: number;
		capabilities?: Record<string, unknown>;
	}>;
}

function openAiCompatible(baseUrl: string, api: Api, extraHeaders: Record<string, string> = {}): Adapter {
	return async ({ token }, signal) => {
		const data = await getJson<OpenAIListResponse>(
			`${baseUrl}/models`,
			{ Authorization: `Bearer ${token}`, ...extraHeaders },
			signal,
		);
		return data.data
			.filter((m) => looksLikeChatModel(m.id))
			.map((m) => ({
				id: m.id,
				api,
				baseUrl,
				contextWindow: m.context_length ?? m.max_model_len,
				maxTokens: m.max_tokens,
			}));
	};
}

interface AnthropicListResponse {
	data: Array<{
		id: string;
		display_name: string;
		max_input_tokens?: number | null;
		max_tokens?: number | null;
		capabilities?: {
			thinking?: { supported: boolean };
			image_input?: { supported: boolean };
		} | null;
	}>;
	has_more: boolean;
	last_id: string | null;
}

const anthropic: Adapter = async ({ token }, signal) => {
	// API keys only: see docs/auth-policy.md.
	const headers: Record<string, string> = { "anthropic-version": "2023-06-01", "x-api-key": token };
	const out: DiscoveredModel[] = [];
	let after: string | undefined;
	for (let page = 0; page < 5; page++) {
		const url = new URL("https://api.anthropic.com/v1/models");
		url.searchParams.set("limit", "1000");
		if (after) url.searchParams.set("after_id", after);
		const data = await getJson<AnthropicListResponse>(url.toString(), headers, signal);
		for (const m of data.data) {
			out.push({
				id: m.id,
				name: m.display_name,
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				reasoning: m.capabilities?.thinking?.supported,
				input: m.capabilities?.image_input?.supported === false ? ["text"] : ["text", "image"],
				contextWindow: m.max_input_tokens || undefined,
				maxTokens: m.max_tokens || undefined,
			});
		}
		if (!data.has_more || !data.last_id) break;
		after = data.last_id;
	}
	return out;
};

interface GeminiListResponse {
	models: Array<{
		name: string;
		displayName?: string;
		inputTokenLimit?: number;
		outputTokenLimit?: number;
		supportedGenerationMethods?: string[];
		thinking?: boolean;
	}>;
	nextPageToken?: string;
}

const google: Adapter = async ({ token }, signal) => {
	const out: DiscoveredModel[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < 5; page++) {
		const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
		url.searchParams.set("key", token);
		url.searchParams.set("pageSize", "1000");
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		const data = await getJson<GeminiListResponse>(url.toString(), {}, signal);
		for (const m of data.models) {
			if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
			const id = m.name.replace(/^models\//, "");
			if (!looksLikeChatModel(id)) continue;
			out.push({
				id,
				name: m.displayName,
				api: "google-generative-ai",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				contextWindow: m.inputTokenLimit,
				maxTokens: m.outputTokenLimit,
				reasoning: m.thinking ?? /gemini-(2\.5|3)/.test(id),
			});
		}
		if (!data.nextPageToken) break;
		pageToken = data.nextPageToken;
	}
	return out;
};

interface OpenRouterListResponse {
	data: Array<{
		id: string;
		name?: string;
		context_length?: number;
		architecture?: { input_modalities?: string[] };
		pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
		top_provider?: { max_completion_tokens?: number };
		supported_parameters?: string[];
	}>;
}

const openrouter: Adapter = async (_credential, signal) => {
	const data = await getJson<OpenRouterListResponse>("https://openrouter.ai/api/v1/models", {}, signal);
	const perMillion = (v?: string) => (v ? Number.parseFloat(v) * 1_000_000 : 0);
	return data.data
		.filter((m) => m.supported_parameters?.includes("tools"))
		.map((m) => ({
			id: m.id,
			name: m.name,
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: m.supported_parameters?.includes("reasoning") ?? false,
			input: m.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
			contextWindow: m.context_length,
			maxTokens: m.top_provider?.max_completion_tokens,
			cost: {
				input: perMillion(m.pricing?.prompt),
				output: perMillion(m.pricing?.completion),
				cacheRead: perMillion(m.pricing?.input_cache_read),
				cacheWrite: perMillion(m.pricing?.input_cache_write),
			},
		}));
};

interface MistralListResponse {
	data: Array<{
		id: string;
		name?: string;
		max_context_length?: number;
		capabilities?: { completion_chat?: boolean; function_calling?: boolean; vision?: boolean };
	}>;
}

const mistral: Adapter = async ({ token }, signal) => {
	const data = await getJson<MistralListResponse>(
		"https://api.mistral.ai/v1/models",
		{ Authorization: `Bearer ${token}` },
		signal,
	);
	return data.data
		.filter((m) => m.capabilities?.completion_chat !== false && m.capabilities?.function_calling !== false)
		.map((m) => ({
			id: m.id,
			name: m.name,
			api: "mistral-conversations",
			baseUrl: "https://api.mistral.ai",
			input: m.capabilities?.vision ? ["text", "image"] : ["text"],
			contextWindow: m.max_context_length,
		}));
};

/** Providers that can be listed at runtime, keyed by pi-ai provider id. */
export const DISCOVERY_ADAPTERS: Record<string, Adapter> = {
	anthropic,
	openai: openAiCompatible("https://api.openai.com/v1", "openai-responses"),
	google,
	openrouter,
	mistral,
	groq: openAiCompatible("https://api.groq.com/openai/v1", "openai-completions"),
	xai: openAiCompatible("https://api.x.ai/v1", "openai-completions"),
	cerebras: openAiCompatible("https://api.cerebras.ai/v1", "openai-completions"),
	huggingface: openAiCompatible("https://router.huggingface.co/v1", "openai-completions"),
};

export function canDiscover(provider: string): boolean {
	return provider in DISCOVERY_ADAPTERS;
}

export async function discoverProviderModels(
	provider: string,
	credential: DiscoveryCredential,
	timeoutMs = 8000,
): Promise<DiscoveredModel[]> {
	const adapter = DISCOVERY_ADAPTERS[provider];
	if (!adapter) throw new Error(`No discovery adapter for ${provider}`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await adapter(credential, controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
