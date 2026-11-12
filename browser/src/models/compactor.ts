/**
 * Runs compaction (compaction.ts) for one chat, before each request (the agent's transformContext). When the guard
 * (context-guard.ts) would drop earlier turns to fit the request, the older part is summarized instead: notes written
 * by a model call, recorded with onCompacted (the panel appends the record to the stored chat, so it holds across
 * reloads). When the call fails it says so once and leaves the request to the guard, which cuts as before. The notes
 * apply only while the whole chat doesn't fit: on a larger model, or after the guard would keep everything, the full
 * history is sent. A turn compacts at most twice, however many tool steps it takes.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEventStream, Context, Message, Model } from "@mariozechner/pi-ai";
import {
	applyCompaction,
	type CompactionMessage,
	canCompact,
	chooseCut,
	compactionPlan,
	conversation,
	estimateAgentMessages,
	isPerson,
	latestCompaction,
} from "./compaction.js";
import { budgetFor, estimateFixedTokens, fitContext } from "./context-budget.js";
import { learnedWindow } from "./context-guard.js";

export interface SummarizeRequest {
	model: Model<any>;
	systemPrompt: string;
	text: string;
	maxTokens: number;
	signal?: AbortSignal;
}

export interface CompactorDeps {
	model: () => Model<any> | undefined;
	/** What every request carries besides messages: the system prompt and the tools. */
	request: () => Pick<Context, "systemPrompt" | "tools">;
	/** The stored messages as the model gets them (the agent's convertToLlm, without its side effects). */
	toLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** One summarizer call: the model's text answer. Throws on a model error. Its cost is the caller's to record. */
	summarize: (request: SummarizeRequest) => Promise<string>;
	/** A new record, to keep in the stored chat. */
	onCompacted: (record: CompactionMessage) => void;
	/** Compaction failed; called at most once per chat. */
	onFailure: (message: string) => void;
	now?: () => number;
}

export interface Compactor {
	/** For the agent's transformContext: the messages to send. Returns `messages` itself when nothing changes. */
	transform: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
}

export function createCompactor(deps: CompactorDeps): Compactor {
	const now = deps.now ?? Date.now;
	/** The record made in this panel, which the running loop's own copy of the chat doesn't hold yet. */
	let made: CompactionMessage | undefined;
	/** The estimate when the last compaction failed: no new try until the chat grows past it. */
	let failedAt: number | undefined;
	let warned = false;

	const current = (messages: readonly AgentMessage[]) => {
		const stored = latestCompaction(messages);
		if (!made) return stored;
		if (!stored) return made;
		return made.cut >= stored.cut ? made : stored;
	};

	async function compact(
		model: Model<any>,
		messages: readonly AgentMessage[],
		plan: ReturnType<typeof compactionPlan>,
		previous: CompactionMessage | undefined,
		before: number,
		signal?: AbortSignal,
	): Promise<CompactionMessage | undefined> {
		const convo = conversation(messages);
		const from = previous?.cut ?? 0;
		let turn = convo.length - 1;
		while (turn >= 0 && !isPerson(convo[turn])) turn--;
		// Once this turn has compacted, the next one takes everything before the person's latest message, so the turn's
		// further steps find nothing new to summarize and cost no model call.
		const cut = chooseCut(convo, previous?.turn === turn ? 0 : plan.keepTokens, from);
		if (cut <= from) return undefined;
		const s = await import("./compaction-summary.js");
		const chunks = s.transcriptChunks(convo.slice(from, cut), plan.chunkTokens);
		if (!chunks.length) return undefined;
		const sources = s.sourcesOf(convo);
		let notes = previous?.summary;
		let round = previous?.round ?? 0;
		const maxWords = Math.max(120, Math.floor(plan.summaryTokens * 0.6));
		const maxTokens = Math.min(Number(model.maxTokens) || 8192, Math.ceil(plan.summaryTokens * 1.5) + 400);
		for (const chunk of chunks) {
			const answer = await deps.summarize({
				model,
				systemPrompt: s.summaryPrompt(maxWords),
				text: s.summaryRequest(notes, chunk),
				maxTokens,
				signal,
			});
			const normalized = s.normalizeSummary(answer, notes, plan.summaryTokens, sources);
			if (!normalized) throw new Error("the summary came back without its sections");
			notes = normalized;
			round++;
		}
		const record: CompactionMessage = {
			role: "compaction",
			summary: notes as string,
			cut,
			round,
			turn,
			tokensBefore: before,
			tokensAfter: 0,
			timestamp: now(),
		};
		record.tokensAfter = estimateAgentMessages(applyCompaction(messages, record, plan.userTokens));
		made = record;
		failedAt = undefined;
		deps.onCompacted(record);
		return record;
	}

	return {
		async transform(messages, signal) {
			const model = deps.model();
			if (!model) return messages;
			const record = current(messages);
			const request = deps.request();
			const fixed = estimateFixedTokens(request);
			const budget = budgetFor(model, learnedWindow(model), undefined, fixed);
			const plan = compactionPlan(budget, fixed);
			const sent = record ? applyCompaction(messages, record, plan.userTokens) : messages;
			if (budget.tooSmall || !canCompact(plan)) return sent;
			const drops = async (m: AgentMessage[]) =>
				fitContext({ ...request, messages: await deps.toLlm(m) }, budget).dropped > 0;
			// The whole chat when the guard would keep all of it, notes or no notes (a larger model, say).
			const whole = record ? conversation(messages) : messages;
			if (record && !(await drops(whole))) return whole;
			// The guard's own verdict on what would be sent: compaction runs only when it would drop earlier turns. A
			// latest turn too large on its own is the guard's to cut: notes on the past wouldn't make it fit.
			if (!(await drops(sent))) return sent;
			// Before and after on one measure: the conversation's messages, without the fixed part.
			const before = estimateAgentMessages(whole);
			// After a failure, wait until the chat has grown by a turn or so before calling the model again.
			if (failedAt !== undefined && before < failedAt + plan.keepTokens / 2) return sent;
			try {
				const next = await compact(model, messages, plan, record, before, signal);
				return next ? applyCompaction(messages, next, plan.userTokens) : sent;
			} catch (err) {
				if (signal?.aborted) throw err;
				failedAt = before;
				if (!warned) {
					warned = true;
					const why = err instanceof Error ? err.message : String(err);
					deps.onFailure(
						`Polycarp couldn't summarize the earlier messages (${why.slice(0, 160)}), so it cut older ones to fit instead.`,
					);
				}
				return sent;
			}
		},
	};
}

type StreamLike = (
	model: Model<any>,
	context: Context,
	options?: Record<string, unknown>,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * A summarizer over the panel's own stream function, so the notes go through the same provider route, proxy and
 * guard as the chat. No tools and no reasoning: one text answer.
 */
export function streamSummarizer(
	streamFn: StreamLike,
	getApiKey: (provider: string) => Promise<string | undefined>,
	/** Each call's cost, for the Costs tab: a summary is billed like any other request. */
	onCost?: (model: Model<any>, cost: number) => void,
): (request: SummarizeRequest) => Promise<string> {
	return async ({ model, systemPrompt, text, maxTokens, signal }) => {
		const apiKey = await getApiKey(model.provider);
		const stream = await streamFn(
			model,
			{ systemPrompt, messages: [{ role: "user", content: text, timestamp: Date.now() }], tools: [] },
			{ apiKey, signal, maxTokens },
		);
		const answer = await stream.result();
		const cost = answer.usage?.cost?.total ?? 0;
		if (cost > 0) onCost?.(model, cost);
		if (answer.stopReason === "error" || answer.stopReason === "aborted")
			throw new Error(answer.errorMessage || "the model gave no summary");
		const out = answer.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (!out) throw new Error("the model gave no summary");
		return out;
	};
}
