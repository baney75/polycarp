/**
 * Private mode: the side panel agent may only send prompts where the data is not kept.
 * That means OpenRouter with zero-data-retention routing enforced on every request
 * (provider.zdr, data_collection "deny", no fallbacks to other endpoints), or a model
 * served from this machine, the local network, or a host the user has named as their own
 * (for example their tailnet machines). Every other provider is refused at the stream gate,
 * whatever model was left selected.
 * OpenRouter docs: https://openrouter.ai/docs/guides/routing/provider-selection
 */

export const PRIVATE_MODE_KEY = "privacy.privateMode";
/** Host names the user trusts as their own, such as tailnet machines (mac.example.ts.net). */
export const TRUSTED_HOSTS_KEY = "privacy.trustedHosts";

/** Sent as OpenRouter's `provider` object; account-level ZDR settings still apply on top. */
export const OPENROUTER_PRIVATE_ROUTING = { zdr: true, data_collection: "deny", allow_fallbacks: false } as const;

/**
 * The only pi-ai adapter that sends `compat.openRouterRouting` as OpenRouter's `provider`
 * object. A model on any other adapter would go out without the routing, so it's refused.
 */
const ROUTING_API = "openai-completions";

export class PrivateModeError extends Error {
	constructor(what: string) {
		super(
			`Private mode is on, so ${what} can't be used: it doesn't guarantee your prompts aren't kept. Pick an OpenRouter model (sent with zero data retention) or a model on your own machine or network, or turn private mode off in Settings > Privacy.`,
		);
		this.name = "PrivateModeError";
	}
}

function ipv4(host: string): number[] | undefined {
	const parts = host.split(".").map(Number);
	return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : undefined;
}

/**
 * A base URL on this machine, or a host the user listed as their own. Nothing else is
 * trusted on its own: a LAN range at home is a stranger's network at a hotel, `.local`
 * names can be answered by anyone on the network, Funnel publishes `*.ts.net` names to the
 * internet, and 100.64.0.0/10 is also ISPs' carrier-grade NAT space.
 */
export function isLocalBaseUrl(baseUrl: string, trustedHosts: string[] = []): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	if (trustedHosts.some((t) => t.trim().toLowerCase() === host)) return true;
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
	return ipv4(host)?.[0] === 127;
}

export interface RoutableModel {
	provider: string;
	baseUrl: string;
	api?: string;
	compat?: object;
}

/** The model to send in private mode, with ZDR routing added; throws for a provider that isn't allowed. */
export function privateModel<M extends RoutableModel>(model: M, trustedHosts: string[] = []): M {
	// OpenRouter always takes the ZDR route below, even if its host was listed as trusted.
	if (!isOpenRouterHost(model.baseUrl) && isLocalBaseUrl(model.baseUrl, trustedHosts)) return model;
	let url: URL | undefined;
	try {
		url = new URL(model.baseUrl);
	} catch {
		/* not a URL: refused below */
	}
	const host = url?.hostname ?? "";
	// HTTPS only: the prompts and the key would otherwise cross the network in the clear.
	if (
		model.provider === "openrouter" &&
		model.api === ROUTING_API &&
		url?.protocol === "https:" &&
		(host === "openrouter.ai" || host.endsWith(".openrouter.ai"))
	) {
		const compat = (model.compat ?? {}) as { openRouterRouting?: object };
		return {
			...model,
			compat: {
				...compat,
				openRouterRouting: { ...(compat.openRouterRouting ?? {}), ...OPENROUTER_PRIVATE_ROUTING },
			},
		};
	}
	throw new PrivateModeError(model.provider);
}

function isOpenRouterHost(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
	} catch {
		return false;
	}
}

/** A host as the user typed it: a name, an IP, a URL or host:port; undefined if it isn't one. */
export function hostOf(entry: string): string | undefined {
	const e = entry.trim();
	if (!e) return undefined;
	try {
		const bare = /^[0-9a-f:]+$/i.test(e) && e.includes(":") ? `[${e}]` : e;
		return (
			new URL(bare.includes("://") ? bare : `http://${bare}`).hostname.toLowerCase().replace(/^\[|\]$/g, "") ||
			undefined
		);
	} catch {
		return undefined;
	}
}

/** A CORS proxy would see every prompt, so private mode allows only one on the user's own machines. */
export function assertPrivateProxy(
	enabled: boolean | null | undefined,
	proxyUrl: string | null | undefined,
	trustedHosts: string[] = [],
): void {
	if (enabled && proxyUrl && !isLocalBaseUrl(proxyUrl, trustedHosts))
		throw new PrivateModeError("the CORS proxy in Settings > Privacy");
}
