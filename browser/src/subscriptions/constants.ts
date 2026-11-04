/**
 * The two subscription sign-ins Tabkyra offers, both on routes the provider documents for
 * third-party apps (docs/auth-policy.md). Shared by the extension and the native host
 * (cli/src/subscriptions), which imports this file directly.
 *
 * Tokens live only in the native host, in owner-only files. The extension never holds one:
 * it talks to the host's loopback proxy with a per-process secret instead.
 */

/** Provider id for ChatGPT plan usage through Sign in with ChatGPT (open-source path). */
export const CHATGPT_PROVIDER = "chatgpt-plan";
/** Provider id for GitHub Copilot through the Copilot SDK and Tabkyra's own OAuth App. */
export const COPILOT_PROVIDER = "copilot-plan";
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([CHATGPT_PROVIDER, COPILOT_PROVIDER]);

/** pi-ai api id for Copilot turns, which run in the host's Copilot SDK session. */
export const COPILOT_API = "tabkyra-copilot-sdk";

/**
 * Sign in with ChatGPT, open-source and locally hosted apps. Every value below is from
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in (read 2026-10-28).
 */
export const SIWC = {
	issuer: "https://auth.openai.com",
	authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
	tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
	discoveryUrl: "https://auth.openai.com/.well-known/openid-configuration",
	/** First-time registration entrypoint; never saved and never used for a token exchange. */
	dynamicClient: "dynamic_agent_client",
	/** Our app's actual name, the same in every installation. */
	agentName: "Tabkyra",
	scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
	/** The scope that allows ChatGPT plan usage; a valid ID token alone does not. */
	planScope: "chatgpt.tokens.use.direct",
	resource: "https://api.openai.com/v1",
	apiBase: "https://api.openai.com/v1",
	/** Loopback callback: http://127.0.0.1:<port>/auth/callback. Only the port may vary. */
	callbackHost: "127.0.0.1",
	callbackPath: "/auth/callback",
	preferredPort: 1455,
	usageUrl: "https://chatgpt.com/settings/usage",
	termsUrl: "https://developers.openai.com/siwc/token-sharing-open-source",
} as const;

/**
 * GitHub Copilot through the Copilot SDK with Tabkyra's own OAuth App (registered by
 * baney75, device flow on, no client secret issued). Source:
 * https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth (read 2026-10-28).
 */
export const COPILOT = {
	/** Tabkyra's OAuth App. A client id is public; the device flow needs no secret. */
	clientId: "Ov23li1qDiu9lRXbvcFh",
	deviceCodeUrl: "https://github.com/login/device/code",
	tokenUrl: "https://github.com/login/oauth/access_token",
	userUrl: "https://api.github.com/user",
	/** No OAuth scopes: the Copilot SDK only needs the user's identity and Copilot plan. */
	scope: "",
	/** Pinned SDK release; `tabkyra copilot-sdk install` installs exactly this. */
	sdkPackage: "@github/copilot-sdk",
	sdkVersion: "1.0.28",
	/** Where a user reviews or revokes Tabkyra's access (revoking needs the app's secret, which Tabkyra has none of). */
	revokeUrl: "https://github.com/settings/applications",
	termsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk",
} as const;

/**
 * Anthropic and Google forbid third-party apps from using subscription sign-ins, including
 * driving their CLIs on the user's behalf. Tabkyra offers the reverse: the user runs their own
 * Claude Code or Gemini CLI and connects it to Tabkyra's MCP server.
 */
export const CLI_MCP_SETUP = {
	claude: "claude mcp add --scope user tabkyra -- ~/.config/tabkyra/tabkyra mcp",
	gemini: "gemini mcp add --scope user tabkyra ~/.config/tabkyra/tabkyra mcp",
} as const;

/** Responses API fields the ChatGPT plan route rejects (preview limitations page, read 2026-10-28). */
export const SIWC_UNSUPPORTED_FIELDS = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
	"previous_response_id",
] as const;

/** Namespace Tabkyra's function tools are grouped in, as the ChatGPT plan route requires. */
export const SIWC_TOOL_NAMESPACE = "tabkyra";

type Json = Record<string, unknown>;

/**
 * Make a Responses API body fit the ChatGPT plan route: store false, stream true, no
 * unsupported fields, no system items, function tools grouped in a namespace. The extension
 * applies it before sending and the host applies it again before forwarding, so a body that
 * skipped the first pass still can't reach OpenAI in a shape the route forbids.
 */
export function siwcRequestBody(input: Json): Json {
	const body: Json = { ...input };
	for (const field of SIWC_UNSUPPORTED_FIELDS) delete body[field];
	body.store = false;
	body.stream = true;
	if (Array.isArray(body.input)) {
		body.input = body.input.map((item) => {
			if (!item || typeof item !== "object") return item;
			const entry = item as Json;
			if (entry.role === "system") return { ...entry, role: "developer" };
			if (entry.type === "function_call" && !entry.namespace) return { ...entry, namespace: SIWC_TOOL_NAMESPACE };
			return entry;
		});
	}
	if (Array.isArray(body.tools)) {
		const functions: Json[] = [];
		const others: unknown[] = [];
		for (const tool of body.tools) {
			const t = tool as Json;
			if (t && t.type === "function") {
				const { type, name, description, parameters, strict } = t;
				functions.push({ type, name, description, parameters, strict });
			} else others.push(tool);
		}
		body.tools = functions.length
			? [
					...others,
					{
						type: "namespace",
						name: SIWC_TOOL_NAMESPACE,
						description: "Tabkyra browser tools",
						tools: functions,
					},
				]
			: others;
	}
	return body;
}

/** Error codes from the ChatGPT plan route that need the "Manage usage" action. */
export const SIWC_USAGE_CODES = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"];

/** A provider error, rewritten so the user sees what to do (errors-and-recovery page). */
export function explainSubscriptionError(provider: string, message: string): string {
	if (provider !== CHATGPT_PROVIDER) return message;
	if (message.includes("subscription_sharing_usage_limit_exceeded"))
		return `Usage limit reached. Review your plan or this app's limit in ChatGPT settings: ${SIWC.usageUrl}`;
	if (message.includes("subscription_sharing_usage_unavailable"))
		return `ChatGPT couldn't check your plan's usage right now. Try again in a minute. (${message})`;
	if (message.includes("subscription_sharing_user_not_eligible"))
		return `ChatGPT plan usage isn't available for this account or workspace. Use an API key instead. (${message})`;
	return message;
}
