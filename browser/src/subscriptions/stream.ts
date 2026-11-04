/**
 * Models and streaming for the two subscription providers.
 *
 * ChatGPT plan: pi-ai's own OpenAI Responses provider, pointed at the native host's loopback
 * proxy with the proxy secret as its key. The body is shaped for the plan route (siwcRequestBody)
 * here and again in the host, which adds the user's token and forwards to api.openai.com.
 *
 * Copilot: a pi-ai api of its own. Each turn goes to the host's proxy, which runs it in a Copilot
 * SDK session (cli/src/subscriptions/copilot-turns.ts) and streams events back.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	registerModels,
	resetProviderModels,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "@mariozechner/pi-ai";
import { trySubscriptionStatus } from "./client.js";
import {
	CHATGPT_PROVIDER,
	COPILOT_API,
	COPILOT_PROVIDER,
	explainSubscriptionError,
	SIWC,
	SUBSCRIPTION_PROVIDERS,
	siwcRequestBody,
} from "./constants.js";
import type { CopilotTurnEvent, CopilotTurnRequest, WireMessage } from "./copilot-wire.js";

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Stand-in base URLs: what private mode checks before the request is pointed at the loopback proxy. */
const CHATGPT_BASE = SIWC.apiBase;
const COPILOT_BASE = "https://github.com";

export function isSubscriptionProvider(provider: string): boolean {
	return SUBSCRIPTION_PROVIDERS.has(provider);
}

/** Register the signed-in accounts' models with pi-ai (so the model selector lists them); drop the rest. */
export async function refreshSubscriptionModels(): Promise<string[]> {
	const status = await trySubscriptionStatus(true);
	const available: string[] = [];
	if (status?.chatgpt.signedIn && status.chatgpt.planUsage) {
		try {
			const response = await fetch(`${status.proxy.url}/chatgpt/v1/models`, {
				headers: { Authorization: `Bearer ${status.proxy.secret}` },
			});
			if (!response.ok) throw new Error(`${response.status}`);
			const body = (await response.json()) as {
				models?: Array<{ slug?: string; display_name?: string; visibility?: string }>;
			};
			const models = (body.models ?? [])
				.filter((m) => m.slug && m.visibility === "list")
				.map(
					(m): Model<Api> => ({
						id: m.slug as string,
						name: `${m.display_name ?? m.slug} (ChatGPT plan)`,
						api: "openai-responses",
						provider: CHATGPT_PROVIDER,
						baseUrl: CHATGPT_BASE,
						reasoning: true,
						input: ["text", "image"],
						cost: NO_COST,
						contextWindow: 272000,
						maxTokens: 128000,
					}),
				);
			registerModels(CHATGPT_PROVIDER, models);
			if (models.length) available.push(CHATGPT_PROVIDER);
		} catch (err) {
			console.warn("[subscriptions] ChatGPT models unavailable:", err);
			resetProviderModels(CHATGPT_PROVIDER);
		}
	} else resetProviderModels(CHATGPT_PROVIDER);

	if (status?.copilot.signedIn && status.copilot.sdkInstalled) {
		try {
			const response = await fetch(`${status.proxy.url}/copilot/models`, {
				headers: { Authorization: `Bearer ${status.proxy.secret}` },
			});
			if (!response.ok) throw new Error(`${response.status}`);
			const body = (await response.json()) as { models?: Array<{ id: string; name: string }> };
			const models = (body.models ?? []).map(
				(m): Model<Api> => ({
					id: m.id,
					name: `${m.name} (Copilot plan)`,
					api: COPILOT_API as Api,
					provider: COPILOT_PROVIDER,
					baseUrl: COPILOT_BASE,
					reasoning: false,
					input: ["text", "image"],
					cost: NO_COST,
					contextWindow: 128000,
					maxTokens: 16000,
				}),
			);
			registerModels(COPILOT_PROVIDER, models);
			if (models.length) available.push(COPILOT_PROVIDER);
		} catch (err) {
			console.warn("[subscriptions] Copilot models unavailable:", err);
			resetProviderModels(COPILOT_PROVIDER);
		}
	} else resetProviderModels(COPILOT_PROVIDER);
	return available;
}

/**
 * Point a subscription model at the host's proxy, after private mode has checked its real
 * destination. Returns undefined for any other model.
 */
export async function routeSubscriptionModel(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): Promise<{ model: Model<Api>; options: SimpleStreamOptions } | undefined> {
	if (!isSubscriptionProvider(model.provider)) return undefined;
	// Fresh every turn: a restarted host has a new proxy port and secret, and a sign-out stops use at once.
	const status = await trySubscriptionStatus(true);
	if (!status)
		throw new Error(
			"Tabkyra's native host isn't connected, so subscription sign-ins can't run. Run `tabkyra doctor`.",
		);
	const next: SimpleStreamOptions = { ...(options ?? {}), apiKey: status.proxy.secret };
	if (model.provider === CHATGPT_PROVIDER) {
		if (!status.chatgpt.signedIn) throw new Error("Sign in with ChatGPT in Settings first.");
		const userPayload = options?.onPayload;
		next.onPayload = async (payload, m) => {
			const shaped = (await userPayload?.(payload, m)) ?? payload;
			return siwcRequestBody(shaped as Record<string, unknown>);
		};
		return { model: { ...model, api: "openai-responses", baseUrl: `${status.proxy.url}/chatgpt/v1` }, options: next };
	}
	if (!status.copilot.signedIn) throw new Error("Sign in with GitHub Copilot in Settings first.");
	return { model: { ...model, baseUrl: status.proxy.url }, options: next };
}

/** Rewrite a provider's error text into what the user should do (usage limits link to ChatGPT settings). */
export function explainErrors(stream: AssistantMessageEventStream, provider: string): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	(async () => {
		for await (const event of stream) {
			if (event.type === "error" && event.error.errorMessage)
				event.error.errorMessage = explainSubscriptionError(provider, event.error.errorMessage);
			out.push(event);
		}
		out.end();
	})().catch(() => out.end());
	return out;
}

// ---- Copilot ------------------------------------------------------------------------------

function wireMessages(context: Context): WireMessage[] {
	const out: WireMessage[] = [];
	for (const m of context.messages) {
		if (m.role === "user") {
			if (typeof m.content === "string") out.push({ role: "user", text: m.content });
			else
				out.push({
					role: "user",
					text: m.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n"),
					images: m.content.flatMap((c) => (c.type === "image" ? [{ data: c.data, mimeType: c.mimeType }] : [])),
				});
		} else if (m.role === "assistant") {
			out.push({
				role: "assistant",
				text: m.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join(""),
				toolCalls: m.content.flatMap((c) =>
					c.type === "toolCall" ? [{ id: c.id, name: c.name, arguments: c.arguments }] : [],
				),
			});
		} else {
			out.push({
				role: "toolResult",
				toolCallId: m.toolCallId,
				toolName: m.toolName,
				isError: m.isError,
				text: m.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n"),
				images: m.content.flatMap((c) => (c.type === "image" ? [{ data: c.data, mimeType: c.mimeType }] : [])),
			});
		}
	}
	return out;
}

/** One chat's id across turns: its first user message (time and text) and the system prompt. */
async function conversationKey(context: Context): Promise<string> {
	const first = context.messages.find((m) => m.role === "user");
	const seed = JSON.stringify([context.systemPrompt ?? "", first?.timestamp ?? 0, first?.content ?? ""]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<CopilotTurnEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let cut = buffer.indexOf("\n\n");
		while (cut >= 0) {
			const chunk = buffer.slice(0, cut);
			buffer = buffer.slice(cut + 2);
			for (const line of chunk.split("\n"))
				if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as CopilotTurnEvent;
			cut = buffer.indexOf("\n\n");
		}
	}
}

export function streamCopilot(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...NO_COST, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	(async () => {
		let block: TextContent | ThinkingContent | undefined;
		const index = () => output.content.length - 1;
		const closeBlock = () => {
			if (!block) return;
			const event: AssistantMessageEvent =
				block.type === "text"
					? { type: "text_end", contentIndex: index(), content: block.text, partial: output }
					: { type: "thinking_end", contentIndex: index(), content: block.thinking, partial: output };
			stream.push(event);
			block = undefined;
		};
		try {
			const turn: CopilotTurnRequest = {
				conversation: await conversationKey(context),
				model: model.id,
				systemPrompt: context.systemPrompt ?? "",
				tools: (context.tools ?? []).map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters as unknown as Record<string, unknown>,
				})),
				messages: wireMessages(context),
			};
			const response = await fetch(`${model.baseUrl}/copilot/turn`, {
				method: "POST",
				headers: { Authorization: `Bearer ${options?.apiKey ?? ""}`, "Content-Type": "application/json" },
				body: JSON.stringify(turn),
				signal: options?.signal,
			});
			if (!response.ok || !response.body) {
				const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
				throw new Error(body.error?.message ?? `Copilot request failed (${response.status}).`);
			}
			stream.push({ type: "start", partial: output });
			let ended = false;
			for await (const event of sseEvents(response.body)) {
				if (event.type === "text" || event.type === "thinking") {
					const want = event.type === "text" ? "text" : "thinking";
					if (block?.type !== want) {
						closeBlock();
						block = want === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
						output.content.push(block);
						stream.push({
							type: want === "text" ? "text_start" : "thinking_start",
							contentIndex: index(),
							partial: output,
						});
					}
					if (block.type === "text") block.text += event.delta;
					else block.thinking += event.delta;
					stream.push({
						type: want === "text" ? "text_delta" : "thinking_delta",
						contentIndex: index(),
						delta: event.delta,
						partial: output,
					});
				} else if (event.type === "tool_call") {
					closeBlock();
					const call: ToolCall = {
						type: "toolCall",
						id: event.id,
						name: event.name,
						arguments: (event.arguments && typeof event.arguments === "object" ? event.arguments : {}) as Record<
							string,
							unknown
						>,
					};
					output.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: index(), partial: output });
					stream.push({ type: "toolcall_end", contentIndex: index(), toolCall: call, partial: output });
				} else if (event.type === "done") {
					closeBlock();
					output.stopReason = event.reason;
					if (event.usage) {
						output.usage.input = event.usage.input;
						output.usage.output = event.usage.output;
						output.usage.totalTokens = event.usage.input + event.usage.output;
					}
					ended = true;
				} else if (event.type === "error") throw new Error(event.message);
			}
			if (!ended) throw new Error("The Copilot turn ended without finishing.");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
			stream.end();
		} catch (err) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

let registered = false;

/** Register the Copilot api with pi-ai once. */
export function registerSubscriptionApis(): void {
	if (registered) return;
	registered = true;
	registerApiProvider({ api: COPILOT_API as Api, stream: streamCopilot, streamSimple: streamCopilot });
}
