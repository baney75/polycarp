/**
 * The side panel's ref tools (read_page, find, act, ...): the specs in src/bridge/page-tools.ts, run by the service
 * worker on the bridge's own handlers and the panel's browser session (src/bridge/panel-calls.ts holds the gates and
 * says why they run there). This page routes each call, sends it, and prints the result for the model.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { MousePointerClick } from "lucide";
import {
	fitPageCall,
	formatPageResult,
	PAGE_TOOLS,
	PANEL_ABORT,
	PANEL_CALL,
	PANEL_KEEPALIVE,
	PageToolArgsError,
	type PageToolDetails,
	type PanelAbortMessage,
	type PanelCallMessage,
	type PanelCallReply,
	type PanelKeepaliveMessage,
	routePageTool,
} from "../bridge/page-tools.js";
import { getCurrentBrowserSession, hasCurrentBrowserSession } from "../browser/current.js";
import { CHARS_PER_TOKEN, estimateTextTokens } from "../models/context-budget.js";
import { stepLabel } from "../transcript/group.js";

/** The least room a read is fitted to: below it a part says too little to be worth the call. */
const MIN_ROOM = 1100;

const textOf = (content: Array<{ type: string; text?: string }>) =>
	content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

/** Runs one bridge method for the panel and returns its result, or throws the error text the model reads. */
export type PanelSend = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** Chrome stops an idle worker after about 30 seconds; a ping every 20 keeps it, and what it holds, alive. */
export const KEEPALIVE_EVERY_MS = 20_000;
/** A model's turn pauses between page tool calls to think; pings stop after this long with no call. */
export const KEEPALIVE_IDLE_MS = 5 * 60_000;

let keepalive: ReturnType<typeof setInterval> | undefined;
let lastCallAt = 0;

/** Keep the worker running from this call until KEEPALIVE_IDLE_MS pass with no page tool call. */
function keepWorkerAwake(): void {
	lastCallAt = Date.now();
	if (keepalive !== undefined) return;
	keepalive = setInterval(() => {
		if (Date.now() - lastCallAt > KEEPALIVE_IDLE_MS) {
			clearInterval(keepalive);
			keepalive = undefined;
			return;
		}
		const ping: PanelKeepaliveMessage = { type: PANEL_KEEPALIVE };
		chrome.runtime.sendMessage(ping).catch(() => undefined);
	}, KEEPALIVE_EVERY_MS);
	// Node (the unit tests) would wait on the timer before exiting; a browser has no unref.
	(keepalive as { unref?: () => void }).unref?.();
}

/** @internal Stop the pings (tests start each case from no timer). */
export function stopKeepalive(): void {
	clearInterval(keepalive);
	keepalive = undefined;
}

/**
 * Send one call to the service worker on the panel's current session. Stop answers at once: the panel stops waiting
 * and the worker stops the handler between steps (a handler that hangs is cut off by the worker's time limit).
 */
export const sendToWorker: PanelSend = async (method, params, signal) => {
	if (signal?.aborted) throw new Error("interrupted: The chat was stopped before this call ran.");
	if (!hasCurrentBrowserSession())
		throw new Error("no_tab: Your browser session has ended. navigate to start a new one.");
	const session = getCurrentBrowserSession();
	// Unique across every open panel: each window's panel sends to the same worker.
	const callId = crypto.randomUUID();
	const request: PanelCallMessage = { type: PANEL_CALL, callId, sessionId: session.id, method, params };
	keepWorkerAwake();
	let onAbort = () => {};
	const stopped = new Promise<never>((_, reject) => {
		onAbort = () => {
			const stop: PanelAbortMessage = { type: PANEL_ABORT, callId };
			chrome.runtime.sendMessage(stop).catch(() => undefined);
			reject(
				new Error(
					"interrupted: You stopped the chat while this call ran; it may have run. read_page before you repeat it.",
				),
			);
		};
	});
	stopped.catch(() => undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		// Chrome rejects with its own words ("The message port closed...") when the worker stops mid-call.
		const sent = chrome.runtime.sendMessage(request).catch(() => {
			throw new Error(
				"interrupted: The browser restarted the extension while this call ran; it may have run. read_page, then try again.",
			);
		});
		const reply = (await Promise.race([sent, stopped])) as PanelCallReply | undefined;
		if (!reply) throw new Error("internal: The Polycarp service worker did not answer. Try again.");
		if (!reply.ok) throw new Error(reply.message);
		return reply.result;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		// The stored session is the one source of truth for the current tab; a handler may have changed it.
		await session.currentTab().catch(() => undefined);
	}
};

/**
 * One AgentTool per page tool spec. `send` runs the routed call (the service worker; tests stand in). `budgetChars`,
 * when given, sizes reads to what the model's next request keeps for one tool result (fitPageCall).
 */
export function createPageTools(
	send: PanelSend = sendToWorker,
	budgetChars?: () => number,
): AgentTool<any, PageToolDetails>[] {
	return PAGE_TOOLS.map((spec) => ({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		parameters: spec.parameters,
		async execute(
			_id: string,
			args: Record<string, unknown>,
			signal?: AbortSignal,
		): Promise<AgentToolResult<PageToolDetails>> {
			let call: ReturnType<typeof routePageTool>;
			try {
				call = routePageTool(spec.name, args ?? {});
			} catch (err) {
				if (err instanceof PageToolArgsError) throw new Error(`bad_params: ${err.message}`);
				throw err;
			}
			if (!budgetChars) {
				const { content, details } = formatPageResult(
					spec.name,
					await send(call.method, call.params, signal),
					call.action,
				);
				return { content: content as (TextContent | ImageContent)[], details };
			}
			// The guard holds a result to its tokens (context-budget.ts), and a page of CJK text, code or long names holds
			// more of them than its characters suggest. A read over that would be cut again and lose its own note on how to
			// read on, so it is fitted again, smaller, until the guard's own estimate fits: read_page from the same answer
			// (it asked for its limits, which only shrink), get_page_text by asking for fewer characters, so the bridge's
			// "call again with offset N" stays exact.
			const chars = budgetChars();
			const allowed = Math.floor(chars / CHARS_PER_TOKEN);
			let room = chars;
			let fitted = fitPageCall(spec.name, call.params, room);
			let result = await send(call.method, fitted.params, signal);
			let out = formatPageResult(spec.name, result, call.action, fitted.limits);
			for (let i = 0; i < 6; i++) {
				const tokens = estimateTextTokens(textOf(out.content));
				if (tokens <= allowed) break;
				const share = (allowed * 0.95) / tokens;
				if (spec.name === "read_page" && fitted.limits) {
					// Measured, not assumed: the same answer, held to a share of the elements and text it showed.
					const { maxNodes = 300, maxTextChars = 3000 } = fitted.limits;
					if (maxNodes <= 1 && maxTextChars <= 100) break;
					fitted = {
						...fitted,
						limits: {
							maxNodes: Math.max(1, Math.floor(maxNodes * share)),
							maxTextChars: Math.max(100, Math.floor(maxTextChars * share)),
						},
					};
				} else if (spec.name === "act" && fitted.limits?.changesChars !== undefined) {
					// The change report is the part that grows with the page: the same answer, its report shorter.
					const { changesChars } = fitted.limits;
					if (changesChars <= 100) break;
					fitted = { ...fitted, limits: { changesChars: Math.max(100, Math.floor(changesChars * share)) } };
				} else if (spec.name === "get_page_text") {
					if (room <= MIN_ROOM) break;
					room = Math.max(MIN_ROOM, Math.floor(room * share));
					fitted = fitPageCall(spec.name, call.params, room);
					result = await send(call.method, fitted.params, signal);
				} else break;
				out = formatPageResult(spec.name, result, call.action, fitted.limits);
			}
			return { content: out.content as (TextContent | ImageContent)[], details: out.details };
		},
	}));
}

/** The page tools the panel's model gets, each read sized to `budgetChars` (the guard's budget for one result). */
export function panelPageTools(budgetChars?: () => number): AgentTool<any, PageToolDetails>[] {
	return createPageTools(sendToWorker, budgetChars);
}

/** Arguments as the renderer gets them: parsed, or still a JSON string while they stream. */
function argsOf(params: unknown): Record<string, unknown> {
	if (params && typeof params === "object") return params as Record<string, unknown>;
	if (typeof params === "string") {
		try {
			const parsed = JSON.parse(params);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

/** A page tool in the chat: its step label, then what it returned, screenshots as images. */
function pageToolRenderer(name: string): ToolRenderer<unknown, PageToolDetails> {
	return {
		render(params, result: ToolResultMessage<PageToolDetails> | undefined, isStreaming?: boolean): ToolRenderResult {
			const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
			const { label } = stepLabel({ type: "toolCall", id: "", name, arguments: argsOf(params) }, result);
			const texts = (result?.content ?? [])
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const images = (result?.content ?? []).filter((c): c is ImageContent => c.type === "image");
			return {
				content: html`
					${renderHeader(state, MousePointerClick, label)}
					${images.map(
						(c) =>
							html`<img src="data:${c.mimeType};base64,${c.data}" alt="Screenshot of the tab" class="max-w-full rounded mt-2" />`,
					)}
					${texts ? html`<pre class="mt-2 text-xs whitespace-pre-wrap break-words max-h-64 overflow-y-auto">${texts}</pre>` : ""}
				`,
				isCustom: false,
			};
		},
	};
}

export function registerPageToolRenderers(): void {
	for (const spec of PAGE_TOOLS) registerToolRenderer(spec.name, pageToolRenderer(spec.name));
}
