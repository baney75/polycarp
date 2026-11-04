/**
 * Free mode: the side panel runs on the best free OpenRouter model for Tabkyra's work, with
 * the next-best free models as OpenRouter fallbacks, so one rate limit doesn't fail a turn.
 *
 * "Best" is measured: `free-ranking.json` holds the scores from `cli/eval/free-models.mjs`
 * (real browser tasks through Tabkyra's tools). At run time the live list decides what is
 * still free and still takes tools; measured models keep their measured order, unmeasured
 * new ones follow (longest context first, then newest), and OpenRouter's own free router
 * comes last. Every model in a request is checked free against the live list, so a turn can
 * never fall through to a paid model (D26).
 *
 * Pure functions only: the side panel, the tests and the eval import this file.
 */

/** The model id Free mode is selected as. OpenRouter has no such model, so it can't be sent by mistake. */
export const FREE_MODEL_ID = "tabkyra-free";
export const FREE_MODEL_NAME = "Free (best available)";
/** OpenRouter's router over its free models; always the last fallback. */
export const OPENROUTER_FREE_ROUTER = "openrouter/free";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
export const OPENROUTER_ZDR_URL = `${OPENROUTER_BASE_URL}/endpoints/zdr`;
/** The live list is refreshed about once a day. */
export const FREE_LIST_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * Models per request, the router included. OpenRouter's `models` fallback list takes at most
 * this many (checked live 2026-10-28; see docs/decisions.md D26).
 */
export const MAX_CHAIN = 3;
/** Sent as OpenRouter's `provider.max_price`: a second guard, beside the free-only chain. */
export const FREE_MAX_PRICE = { prompt: 0, completion: 0, request: 0, image: 0 } as const;

export const FREE_PRIVACY_NOTE =
	"Free providers may log and train on your prompts. Private mode allows only free models with zero data retention.";
export const FREE_KEY_NOTE =
	"Free mode needs a free OpenRouter key: sign up at openrouter.ai/keys and paste the key here.";

/** One entry of OpenRouter's GET /api/v1/models. */
export interface OpenRouterListing {
	id: string;
	name?: string;
	created?: number;
	context_length?: number;
	architecture?: { input_modalities?: string[] };
	pricing?: Record<string, string | number | undefined>;
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
}

/** One entry of OpenRouter's GET /api/v1/endpoints/zdr. */
export interface ZdrEndpoint {
	model_id: string;
	pricing?: Record<string, string | number | undefined>;
}

export interface MeasuredModel {
	id: string;
	/** Tasks passed over tasks run, 0 to 1. */
	score: number;
	passed: number;
	runs: number;
	meanToolCalls: number;
	meanSeconds: number;
}

export interface FreeRanking {
	measuredAt: string;
	method: string;
	models: MeasuredModel[];
	/** Rate-limited on every run, so never measured; these rank with new, unmeasured models. */
	unmeasured?: string[];
}

export class FreeModeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FreeModeError";
	}
}

function zeroPrice(pricing: Record<string, string | number | undefined> | undefined): boolean {
	if (!pricing || pricing.prompt === undefined || pricing.completion === undefined) return false;
	return Object.values(pricing).every((v) => v === undefined || Number(v) === 0);
}

/**
 * Free for OpenRouter's purposes: a `:free` variant (or the free router) whose every listed
 * price is zero. A zero-priced model without the `:free` suffix is not trusted: its price
 * can change without its id changing.
 */
export function isFreeListing(m: OpenRouterListing): boolean {
	return (m.id.endsWith(":free") || m.id === OPENROUTER_FREE_ROUTER) && zeroPrice(m.pricing);
}

/** Free and able to call tools; everything else is dropped. */
export function usableFreeModels(list: OpenRouterListing[]): OpenRouterListing[] {
	return list.filter((m) => isFreeListing(m) && (m.supported_parameters ?? []).includes("tools"));
}

/**
 * Usable free model ids, best first: measured models with a score above 0 in score order
 * (ties keep the file's order), then unmeasured ones by context length and then newest, then
 * the free router. A measured model that passed nothing is left out.
 */
export function rankFreeModels(list: OpenRouterListing[], ranking: FreeRanking): string[] {
	const usable = usableFreeModels(list);
	const live = new Map(usable.map((m) => [m.id, m]));
	const measured = new Map(ranking.models.map((m, i) => [m.id, { ...m, order: i }]));
	const good = [...measured.values()]
		.filter((m) => m.score > 0 && live.has(m.id) && m.id !== OPENROUTER_FREE_ROUTER)
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.map((m) => m.id);
	const unmeasured = usable
		.filter((m) => !measured.has(m.id) && m.id !== OPENROUTER_FREE_ROUTER)
		.sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0) || (b.created ?? 0) - (a.created ?? 0))
		.map((m) => m.id);
	const router = live.has(OPENROUTER_FREE_ROUTER) ? [OPENROUTER_FREE_ROUTER] : [];
	return [...good, ...unmeasured, ...router];
}

/** The request chain: the best `max - 1` models, then the free router (if it is still listed). */
export function fallbackChain(ranked: string[], max = MAX_CHAIN): string[] {
	const router = ranked.includes(OPENROUTER_FREE_ROUTER);
	const models = ranked.filter((id) => id !== OPENROUTER_FREE_ROUTER);
	return router ? [...models.slice(0, max - 1), OPENROUTER_FREE_ROUTER] : models.slice(0, max);
}

/** Throws unless every id in the chain is a free, tool-capable model on the live list. */
export function assertFreeChain(chain: string[], list: OpenRouterListing[]): void {
	if (chain.length === 0) throw new FreeModeError(noFreeModelsMessage());
	const usable = new Set(usableFreeModels(list).map((m) => m.id));
	for (const id of chain) {
		if (!usable.has(id)) throw new FreeModeError(`Free mode refused to send: ${id} is not a free model right now.`);
	}
}

/**
 * Private mode: keep only models with a free zero-data-retention endpoint. The free router
 * picks its model on OpenRouter's side, so it is dropped too. Throws when nothing is left.
 */
export function privateFreeChain(ranked: string[], zdr: ZdrEndpoint[], max = MAX_CHAIN): string[] {
	const zdrFree = new Set(
		zdr.filter((e) => e.model_id.endsWith(":free") && zeroPrice(e.pricing)).map((e) => e.model_id),
	);
	const chain = ranked.filter((id) => id !== OPENROUTER_FREE_ROUTER && zdrFree.has(id)).slice(0, max);
	if (chain.length === 0) {
		throw new FreeModeError(
			"Private mode is on, and no free model guarantees zero data retention right now, so nothing was sent. Pick a paid OpenRouter model or a model on your own machine, or turn private mode off in Settings > Privacy.",
		);
	}
	return chain;
}

/** The request body Free mode sends: the chain as OpenRouter's fallback list, and a zero price cap. */
export function freePayload<P extends Record<string, unknown>>(params: P, chain: string[]): P {
	const provider = (params.provider ?? {}) as Record<string, unknown>;
	const body: Record<string, unknown> = {
		...params,
		model: chain[0],
		provider: { ...provider, max_price: FREE_MAX_PRICE },
	};
	if (chain.length > 1) body.models = chain;
	else delete body.models;
	return body as P;
}

/** "Google: Gemma 4 31B (free)" -> "Gemma 4 31B"; with no name, the id without ":free". */
export function shortModelName(name: string | undefined, id: string): string {
	if (!name) return id.replace(/:free$/, "");
	const base = name
		.replace(/^[^:]+:\s*/, "")
		.replace(/\s*\(free\)\s*$/i, "")
		.trim();
	return base || id;
}

/** The composer label: "Free", or "Free · <model>" once a model has answered. */
export function freeLabel(answered?: { id: string; name?: string }): string {
	if (!answered) return "Free";
	if (answered.id === OPENROUTER_FREE_ROUTER) return "Free · OpenRouter free router";
	return `Free · ${shortModelName(answered.name, answered.id)}`;
}

/** A 429, an overloaded upstream or a pulled model: the kind of failure the next free models can fix. */
export function isFreeLimitError(message: string | undefined): boolean {
	return /\b429\b|rate.?limit|free-models-per-day|quota|no endpoints found|no allowed providers|not a valid model|only available on|overloaded|temporarily/i.test(
		message ?? "",
	);
}

export function noFreeModelsMessage(): string {
	return "No free OpenRouter model can run Tabkyra's tools right now. Try again later, or pick another model.";
}

/** Shown when every free model in the chain was limited. */
export const FREE_LIMIT_MESSAGE =
	"Every free model is rate-limited right now. OpenRouter allows 50 free requests a day (1,000 once you have bought at least $10 of credits) and about 20 a minute. Wait a minute and retry, or pick another model.";
