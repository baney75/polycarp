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
	formatPageResult,
	PAGE_TOOLS,
	PANEL_ABORT,
	PANEL_CALL,
	PageToolArgsError,
	type PageToolDetails,
	type PanelAbortMessage,
	type PanelCallMessage,
	type PanelCallReply,
	routePageTool,
} from "../bridge/page-tools.js";
import { getCurrentBrowserSession } from "../browser/current.js";
import { stepLabel } from "../transcript/group.js";

/** Runs one bridge method for the panel and returns its result, or throws the error text the model reads. */
export type PanelSend = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** Send one call to the service worker on the panel's current session; the stop button aborts it there. */
export const sendToWorker: PanelSend = async (method, params, signal) => {
	if (signal?.aborted) throw new Error("interrupted: The chat was stopped before this call ran.");
	// Unique across every open panel: each window's panel sends to the same worker.
	const callId = crypto.randomUUID();
	const request: PanelCallMessage = {
		type: PANEL_CALL,
		callId,
		sessionId: getCurrentBrowserSession().id,
		method,
		params,
	};
	const onAbort = () => {
		const stop: PanelAbortMessage = { type: PANEL_ABORT, callId };
		chrome.runtime.sendMessage(stop).catch(() => undefined);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const reply = (await chrome.runtime.sendMessage(request)) as PanelCallReply | undefined;
		if (!reply) throw new Error("internal: The Polycarp service worker did not answer. Try again.");
		if (!reply.ok) throw new Error(reply.message);
		return reply.result;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
};

/** One AgentTool per page tool spec. `send` runs the routed call (the service worker; tests stand in). */
export function createPageTools(send: PanelSend = sendToWorker): AgentTool<any, PageToolDetails>[] {
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
			const result = await send(call.method, call.params, signal);
			const { content, details } = formatPageResult(spec.name, result, call.action);
			return { content: content as (TextContent | ImageContent)[], details };
		},
	}));
}

/** The page tools the panel's model gets. */
export function panelPageTools(): AgentTool<any, PageToolDetails>[] {
	return createPageTools();
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
