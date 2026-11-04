/**
 * Free mode at run time: the live free list (refreshed about once a day), the chain for a
 * request, and a stream wrapper that moves on to the next free models when a whole chain is
 * rate-limited. The rules themselves are in free-mode.ts.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@mariozechner/pi-ai";
import {
	assertFreeChain,
	FREE_LIMIT_MESSAGE,
	FREE_LIST_STALE_MS,
	FREE_MODEL_ID,
	FREE_MODEL_NAME,
	FreeModeError,
	type FreeRanking,
	fallbackChain,
	freePayload,
	isFreeLimitError,
	isFreeListing,
	MAX_CHAIN,
	OPENROUTER_BASE_URL,
	OPENROUTER_FREE_ROUTER,
	OPENROUTER_MODELS_URL,
	OPENROUTER_ZDR_URL,
	type OpenRouterListing,
	privateFreeChain,
	rankFreeModels,
	type ZdrEndpoint,
} from "./free-mode.js";
import ranking from "./free-ranking.json";

export const FREE_LIST_KEY = "freeMode.list";
/** The last model that answered in Free mode, for the composer label. */
export const FREE_ANSWERED_KEY = "freeMode.answered";

export interface FreeList {
	fetchedAt: number;
	models: OpenRouterListing[];
	zdr: ZdrEndpoint[];
}

export interface SettingsLike {
	get<T>(key: string): Promise<T | null | undefined>;
	set<T>(key: string, value: T): Promise<void>;
}

export const FREE_RANKING = ranking as FreeRanking;

/** The model Free mode is selected as. The stream gate swaps in a real free model per request. */
export function freeModeModel(): Model<"openai-completions"> {
	return {
		id: FREE_MODEL_ID,
		name: FREE_MODEL_NAME,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: OPENROUTER_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

export function isFreeModeModel(model: { provider: string; id: string } | null | undefined): boolean {
	return model?.provider === "openrouter" && model.id === FREE_MODEL_ID;
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
		return (await response.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The live free list: cached for a day, refetched when stale or forced. Only free entries are
 * kept. A failed fetch falls back to the cached list, however old.
 */
export async function loadFreeList(settings: SettingsLike, options: { force?: boolean } = {}): Promise<FreeList> {
	const cached = await settings.get<FreeList>(FREE_LIST_KEY);
	if (cached && !options.force && Date.now() - cached.fetchedAt < FREE_LIST_STALE_MS) return cached;
	try {
		const [models, zdr] = await Promise.all([
			getJson<{ data: OpenRouterListing[] }>(OPENROUTER_MODELS_URL, 8000),
			getJson<{ data: ZdrEndpoint[] }>(OPENROUTER_ZDR_URL, 8000).catch(() => ({ data: [] as ZdrEndpoint[] })),
		]);
		const list: FreeList = {
			fetchedAt: Date.now(),
			models: models.data.filter(isFreeListing),
			zdr: zdr.data
				.filter((e) => e.model_id.endsWith(":free"))
				.map(({ model_id, pricing }) => ({ model_id, pricing })),
		};
		await settings.set(FREE_LIST_KEY, list);
		return list;
	} catch (err) {
		if (cached) return cached;
		throw new FreeModeError(
			`Couldn't load OpenRouter's free model list (${err instanceof Error ? err.message : String(err)}). Check your connection and try again.`,
		);
	}
}

/** Every usable free model, best first. */
export function rankedFree(list: FreeList): string[] {
	return rankFreeModels(list.models, FREE_RANKING);
}

/**
 * The chains to try, in order: the best models with the free router last, then (if that whole
 * chain is limited) the next-best ones. Private mode keeps only zero-data-retention models.
 */
export function freeChains(list: FreeList, privateMode: boolean, attempts = 2): string[][] {
	const ranked = rankedFree(list);
	if (privateMode) {
		const zdrRanked = privateFreeChain(ranked, list.zdr, ranked.length);
		const chains: string[][] = [];
		for (let i = 0; i < attempts && i * MAX_CHAIN < zdrRanked.length; i++)
			chains.push(zdrRanked.slice(i * MAX_CHAIN, (i + 1) * MAX_CHAIN));
		return chains;
	}
	const models = ranked.filter((id) => id !== OPENROUTER_FREE_ROUTER);
	const per = MAX_CHAIN - 1;
	const chains: string[][] = [];
	for (let i = 0; i < attempts && (i === 0 || i * per < models.length); i++) {
		const rest = [
			...models.slice(i * per),
			...(ranked.includes(OPENROUTER_FREE_ROUTER) ? [OPENROUTER_FREE_ROUTER] : []),
		];
		const chain = fallbackChain(rest);
		if (chain.length > 0) chains.push(chain);
	}
	for (const chain of chains) assertFreeChain(chain, list.models);
	if (chains.length === 0) throw new FreeModeError("No free OpenRouter model can run Tabkyra's tools right now.");
	return chains;
}

/** The real model sent for a chain: the first model's id, and limits every model in the chain meets. */
export function resolveFreeModel<M extends Model<Api>>(model: M, chain: string[], list: FreeList): M {
	const entries = chain.map((id) => list.models.find((m) => m.id === id));
	const first = entries[0];
	const contexts = entries.map((m) => m?.context_length).filter((n): n is number => typeof n === "number" && n > 0);
	const outputs = entries
		.map((m) => m?.top_provider?.max_completion_tokens)
		.filter((n): n is number => typeof n === "number" && n > 0);
	const images = entries.every((m) => m?.architecture?.input_modalities?.includes("image"));
	return {
		...model,
		id: chain[0],
		name: first?.name ?? chain[0],
		reasoning: false,
		input: images ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contexts.length ? Math.min(...contexts) : model.contextWindow,
		maxTokens: Math.min(outputs.length ? Math.min(...outputs) : model.maxTokens, 16384),
	};
}

type Options = { onPayload?: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown> } & Record<
	string,
	unknown
>;
type Inner = (model: Model<Api>, context: unknown, options?: Options) => unknown;

/** Add the chain to the request body after any other payload hook. */
export function withFreePayload(options: Options | undefined, chain: string[]): Options {
	const previous = options?.onPayload;
	return {
		...(options ?? {}),
		onPayload: async (payload: unknown, model: Model<Api>) => {
			const next = (await previous?.(payload, model)) ?? payload;
			return freePayload(next as Record<string, unknown>, chain);
		},
	};
}

/**
 * Run each chain in turn until one starts answering. A chain that fails before its first event
 * with a rate limit or a pulled model moves on to the next; anything else (and any failure
 * after the answer started) is passed through as is. When every chain is limited, the turn
 * ends with FREE_LIMIT_MESSAGE.
 */
export function streamFreeChains(
	inner: Inner,
	makeModel: (chain: string[]) => Model<Api>,
	chains: string[][],
	context: unknown,
	options: Options | undefined,
	onLimited?: (message: string | undefined) => void,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		let lastError: AssistantMessage | undefined;
		for (const chain of chains) {
			const stream = (await inner(
				makeModel(chain),
				context,
				withFreePayload(options, chain),
			)) as AsyncIterable<AssistantMessageEvent>;
			const iterator = stream[Symbol.asyncIterator]();
			const first = await iterator.next();
			if (first.done) {
				out.end();
				return;
			}
			const event = first.value;
			if (event.type === "error" && event.reason === "error" && isFreeLimitError(event.error.errorMessage)) {
				lastError = event.error;
				onLimited?.(event.error.errorMessage);
				continue;
			}
			out.push(event);
			for (let next = await iterator.next(); !next.done; next = await iterator.next()) out.push(next.value);
			out.end();
			return;
		}
		out.push({
			type: "error",
			reason: "error",
			error: errorMessage(
				`${FREE_LIMIT_MESSAGE}${lastError?.errorMessage ? ` (${lastError.errorMessage})` : ""}`,
				lastError,
			),
		});
		out.end();
	})().catch((err) => {
		out.push({
			type: "error",
			reason: "error",
			error: errorMessage(err instanceof Error ? err.message : String(err)),
		});
		out.end();
	});
	return out;
}

function errorMessage(text: string, base?: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openrouter",
		model: FREE_MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...base,
		stopReason: "error",
		errorMessage: text,
	};
}

/** The model that answered an assistant message: what the provider reported, else what was asked for. */
export function answeredBy(message: { model: string; responseModel?: string }): string {
	return message.responseModel ?? message.model;
}
