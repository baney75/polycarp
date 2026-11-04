/**
 * Which sign-ins Tabkyra offers, and the guard that keeps the removed ones out.
 * docs/auth-policy.md has the provider terms behind each decision.
 *
 * Every subscription sign-in this fork inherited borrowed another product's identity
 * (Codex CLI's, VS Code Copilot Chat's and Gemini CLI's OAuth clients and headers).
 * Providers ban accounts for that, so they are gone. The only subscription sign-ins are the
 * sanctioned ones in src/subscriptions (Sign in with ChatGPT, the Copilot SDK), under their
 * own provider ids; everything here keeps the removed ones out.
 */

/** Provider ids whose only route was a borrowed subscription sign-in. */
export const REMOVED_SIGN_IN_PROVIDERS = new Set([
	"openai-codex",
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);

/** pi-ai APIs that only exist to talk to those subscriptions; a model on one never runs. */
export const BLOCKED_APIS = new Set(["openai-codex-responses", "google-gemini-cli"]);

export const API_BILLING_NOTE = "API use is billed by the provider to the account that owns the key.";

export class RemovedSignInError extends Error {
	constructor(provider: string) {
		super(
			`${provider}: subscription sign-in was removed from Tabkyra because it used another app's identity, which the provider's terms forbid. Add an API key in Settings > Providers instead.`,
		);
		this.name = "RemovedSignInError";
	}
}

/** Stored OAuth credentials are JSON; API keys never start with "{". */
function isStoredSignIn(value: string): boolean {
	return value.trimStart().startsWith("{");
}

/** Claude subscription tokens (sk-ant-oat...) pasted into the Anthropic key field. */
function isClaudeSubscriptionToken(provider: string, value: string): boolean {
	return provider === "anthropic" && value.trim().startsWith("sk-ant-oat");
}

/** True when a model must not run: a removed provider or a subscription-only API. */
export function isBlockedModel(model: { provider: string; api: string }): boolean {
	return REMOVED_SIGN_IN_PROVIDERS.has(model.provider) || BLOCKED_APIS.has(model.api);
}

/** The stored value is the API key. Anything left over from a removed sign-in is refused. */
export function resolveApiKey(stored: string, provider: string): string {
	if (
		REMOVED_SIGN_IN_PROVIDERS.has(provider) ||
		isStoredSignIn(stored) ||
		isClaudeSubscriptionToken(provider, stored)
	) {
		throw new RemovedSignInError(provider);
	}
	return stored;
}

/**
 * Delete credentials a removed sign-in left in storage. They only worked through the
 * borrowed client, so keeping them would invite a retry. Returns the providers cleared.
 */
export async function purgeRemovedSignIns(keys: {
	list: () => Promise<string[]>;
	get: (provider: string) => Promise<string | null | undefined>;
	delete: (provider: string) => Promise<void>;
}): Promise<string[]> {
	const cleared: string[] = [];
	for (const provider of await keys.list()) {
		const stored = await keys.get(provider);
		if (!stored) continue;
		if (
			REMOVED_SIGN_IN_PROVIDERS.has(provider) ||
			isStoredSignIn(stored) ||
			isClaudeSubscriptionToken(provider, stored)
		) {
			await keys.delete(provider);
			cleared.push(provider);
		}
	}
	return cleared;
}
