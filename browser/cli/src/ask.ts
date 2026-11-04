/**
 * The ask_user MCP tool: an external agent asks the user 1 to 4 multiple-choice questions in the
 * Tabkyra side panel and waits for the answer (src/ask/bridge-worker.ts shows it there). The
 * answer comes back only to the session that asked. Remote sessions need the `user.ask` scope.
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ASK_BRIDGE_TIMEOUT_MS, ASK_LIMITS, ASK_USER_DESCRIPTION, type AskOutcome, noAnswer, outcomeText, validateAskParams } from "../../src/ask/core.ts";
import { type BridgeClient, BridgeRpcError, isConnectionError, NOT_CONNECTED } from "./client.ts";

/** The one line the server instructions add about it (dropped when a session lacks the tool). */
export const ASK_USER_INSTRUCTION =
	"When you need a decision only the user can make and the answer changes what you do (which of several options, a preference, an ambiguous request), call ask_user instead of guessing; don't use it for routine confirmations. If it returns No answer, don't assume one.";

export const askUserInputSchema = {
	questions: z
		.array(
			z.object({
				header: z.string().min(1).max(ASK_LIMITS.header).describe('A short label, a few words, e.g. "Format"'),
				question: z.string().min(1).max(ASK_LIMITS.question).describe("The question, as a full sentence"),
				options: z
					.array(
						z.object({
							label: z.string().min(1).max(ASK_LIMITS.label).describe('The choice, 1 to 5 words. Add "(Recommended)" to the one you recommend'),
							description: z.string().max(ASK_LIMITS.description).describe("One line on what this choice means"),
						}),
					)
					.min(ASK_LIMITS.minOptions)
					.max(ASK_LIMITS.maxOptions),
				multiSelect: z.boolean().optional().describe("true lets the user pick more than one option"),
			}),
		)
		.min(ASK_LIMITS.minQuestions)
		.max(ASK_LIMITS.maxQuestions)
		.describe("1 to 4 questions, shown together on one card"),
};

/** How often a waiting call reports progress (tests shorten it). */
const PROGRESS_EVERY_MS = Number(process.env.TABKYRA_ASK_PROGRESS_MS) || 15_000;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Turn the bridge's reply (or failure) into what the model reads. Exported for tests. */
export function askResultText(questions: AskOutcome["questions"], reply: unknown, err?: unknown): ToolResult {
	if (err === undefined) {
		const r = reply as Partial<AskOutcome> & { text?: unknown };
		if (typeof r?.text === "string" && (r.status === "answered" || r.status === "no_answer")) return { content: [{ type: "text", text: r.text }] };
		return { content: [{ type: "text", text: "Tabkyra returned an unexpected reply to ask_user." }], isError: true };
	}
	if (err instanceof BridgeRpcError) {
		if (err.rpc.code === "not_found")
			return { content: [{ type: "text", text: "This Tabkyra extension doesn't support ask_user yet. Ask the user to update Tabkyra, and ask your question in the chat instead." }], isError: true };
		return { content: [{ type: "text", text: `${err.rpc.code}: ${err.rpc.message}` }], isError: true };
	}
	const message = err instanceof Error ? err.message : String(err);
	if (/timed out after/.test(message)) return { content: [{ type: "text", text: outcomeText(noAnswer(questions, "timeout")) }] };
	if (message === NOT_CONNECTED && reply === "asked") return { content: [{ type: "text", text: outcomeText(noAnswer(questions, "disconnected")) }] };
	if (message === NOT_CONNECTED || isConnectionError(err)) return { content: [{ type: "text", text: NOT_CONNECTED }], isError: true };
	return { content: [{ type: "text", text: message }], isError: true };
}

export function registerAskUser(server: McpServer, client: BridgeClient): void {
	server.registerTool(
		"ask_user",
		{
			title: "Ask the user",
			description:
				`${ASK_USER_DESCRIPTION} The question shows in the Tabkyra side panel (the toolbar icon gets a badge when the panel is closed) and waits up to ` +
				`${ASK_BRIDGE_TIMEOUT_MS / 60000} minutes, or until your client's own tool-call timeout if that is shorter. ` +
				'Example: {"questions":[{"header":"Format","question":"Which format should the report use?","options":[{"label":"PDF (Recommended)","description":"One file that prints cleanly"},{"label":"Markdown","description":"Plain text you can edit"}]}]}',
			inputSchema: askUserInputSchema,
		},
		async (args, extra): Promise<ToolResult> => {
			let questions: AskOutcome["questions"];
			try {
				questions = validateAskParams(args).questions;
			} catch (err) {
				return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
			}
			let sent = false;
			// Waiting minutes is normal here. Clients that reset their timeout on progress keep waiting.
			const token = extra._meta?.progressToken;
			let ticks = 0;
			const startedAt = Date.now();
			const progress =
				token === undefined
					? undefined
					: setInterval(() => {
							extra
								.sendNotification({
									method: "notifications/progress",
									params: {
										progressToken: token,
										progress: ++ticks,
										message: `Waiting for the user's answer in the Tabkyra side panel (${Math.max(0, Math.ceil((ASK_BRIDGE_TIMEOUT_MS - (Date.now() - startedAt)) / 60000))} min left)`,
									},
								})
								.catch(() => undefined);
						}, PROGRESS_EVERY_MS);
			// The agent gave up on the call: take the question off the user's screen.
			const askId = randomUUID();
			const onAbort = () => void client.call("ask_user.cancel", { askId }, 5000, { retry: false }).catch(() => undefined);
			extra.signal.addEventListener("abort", onAbort, { once: true });
			try {
				if (!client.connected) await client.connect();
				// A host with no extension behind it has no panel to show the question in.
				if (!client.extensionConnected) return { content: [{ type: "text", text: NOT_CONNECTED }], isError: true };
				if (extra.signal.aborted) return { content: [{ type: "text", text: outcomeText(noAnswer(questions, "aborted")) }] };
				sent = true;
				// No retry: a retry after a dropped bridge would ask the user a second time.
				const reply = await client.call("ask_user", { questions, askId }, ASK_BRIDGE_TIMEOUT_MS + 30_000, { retry: false });
				return askResultText(questions, reply);
			} catch (err) {
				return askResultText(questions, sent ? "asked" : undefined, err);
			} finally {
				clearInterval(progress);
				extra.signal.removeEventListener("abort", onAbort);
			}
		},
	);
}
