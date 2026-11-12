/**
 * Runs compaction (compaction.ts) for one chat: before each request (the agent's transformContext) and when the person
 * asks for it. It writes the notes with a model call, records them with onCompacted (the panel appends the record to
 * the stored chat), and when the call fails it says so once and leaves the request to the trimming guard
 * (context-guard.ts).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import {
	applyCompaction,
	type CompactionMessage,
	type CompactionPlan,
	canCompact,
	chooseCut,
	compactionPlan,
	conversation,
	estimateAgentMessages,
	latestCompaction,
	normalizeSummary,
	summaryPrompt,
	summaryRequest,
	transcriptChunks,
} from "./compaction.js";
import { estimateFixedTokens } from "./context-budget.js";

export interface SummarizeRequest {
	model: Model<any>;
	systemPrompt: string;
	text: string;
	maxTokens: number;
	signal?: AbortSignal;
}

export interface CompactorDeps {
	model: () => Model<any> | undefined;
	/** Estimated tokens of what every request carries besides messages: the system prompt and tool schemas. */
	fixedTokens: () => number;
	/** One summarizer call: the model's text answer. Throws on a model error. */
	summarize: (request: SummarizeRequest) => Promise<string>;
	/** A new record, to keep in the stored chat. */
	onCompacted: (record: CompactionMessage) => void;
	/** Compaction failed; called at most once per chat. */
	onFailure: (message: string) => void;
	now?: () => number;
}

/** How full the window is for the next request. */
export interface Meter {
	used: number;
	window: number;
	threshold: number;
	/** used / window as a whole percent; over 100 when the chat is past the window (the guard then trims). */
	percent: number;
}

export type ManualResult = { record: CompactionMessage } | { nothing: string };

export interface Compactor {
	/** For the agent's transformContext: the messages to send. Returns `messages` itself when nothing changes. */
	transform: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** The person asked: summarize what is older than the recent turns now, whatever the threshold. */
	compactNow: (messages: AgentMessage[], signal?: AbortSignal) => Promise<ManualResult>;
	meter: (messages: readonly AgentMessage[]) => Meter;
	/** The latest record this chat has, stored or still to be stored. */
	current: (messages: readonly AgentMessage[]) => CompactionMessage | undefined;
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

	const estimateSent = (
		messages: readonly AgentMessage[],
		record: CompactionMessage | undefined,
		plan: CompactionPlan,
	) => deps.fixedTokens() + estimateAgentMessages(applyCompaction(messages, record, plan.userTokens));

	async function compact(
		messages: readonly AgentMessage[],
		plan: CompactionPlan,
		previous: CompactionMessage | undefined,
		before: number,
		manual: boolean,
		signal?: AbortSignal,
	): Promise<CompactionMessage | undefined> {
		const model = deps.model();
		if (!model) return undefined;
		const convo = conversation(messages);
		const from = previous?.cut ?? 0;
		const cut = chooseCut(convo, plan.keepTokens, from);
		if (cut <= from) return undefined;
		const chunks = transcriptChunks(convo.slice(from, cut), plan.chunkTokens);
		if (!chunks.length) return undefined;
		let notes = previous?.summary;
		let round = previous?.round ?? 0;
		const maxWords = Math.max(120, Math.floor(plan.summaryTokens * 0.6));
		const maxTokens = Math.min(Number(model.maxTokens) || 8192, Math.ceil(plan.summaryTokens * 1.5) + 400);
		for (const chunk of chunks) {
			const answer = await deps.summarize({
				model,
				systemPrompt: summaryPrompt(maxWords),
				text: summaryRequest(notes, chunk),
				maxTokens,
				signal,
			});
			const normalized = normalizeSummary(answer, notes, plan.summaryTokens);
			if (!normalized) throw new Error("the summary came back without its sections");
			notes = normalized;
			round++;
		}
		const record: CompactionMessage = {
			role: "compaction",
			summary: notes as string,
			cut,
			round,
			tokensBefore: before,
			tokensAfter: 0,
			timestamp: now(),
			...(manual ? { manual: true } : {}),
		};
		record.tokensAfter = estimateSent(messages, record, plan);
		made = record;
		failedAt = undefined;
		deps.onCompacted(record);
		return record;
	}

	async function tryCompact(
		messages: readonly AgentMessage[],
		plan: CompactionPlan,
		previous: CompactionMessage | undefined,
		before: number,
		manual: boolean,
		signal?: AbortSignal,
	): Promise<CompactionMessage | undefined> {
		try {
			return await compact(messages, plan, previous, before, manual, signal);
		} catch (err) {
			// An abort ends the run; a manual compaction reports its own failure to whoever pressed the button.
			if (signal?.aborted || manual) throw err;
			failedAt = before;
			const why = err instanceof Error ? err.message : String(err);
			if (!warned) {
				warned = true;
				deps.onFailure(
					`Polycarp couldn't summarize the earlier messages (${why.slice(0, 160)}), so it cut older tool results to fit instead.`,
				);
			}
			return undefined;
		}
	}

	return {
		current,
		async transform(messages, signal) {
			const plan = compactionPlan(deps.model(), deps.fixedTokens());
			const record = current(messages);
			const before = estimateSent(messages, record, plan);
			const unchanged = () => (record ? applyCompaction(messages, record, plan.userTokens) : messages);
			if (before <= plan.threshold || !canCompact(plan)) return unchanged();
			// After a failure, wait until the chat has grown by a turn or so before calling the model again.
			if (failedAt !== undefined && before < failedAt + plan.keepTokens / 2) return unchanged();
			const next = await tryCompact(messages, plan, record, before, false, signal);
			return next ? applyCompaction(messages, next, plan.userTokens) : unchanged();
		},
		async compactNow(messages, signal) {
			const plan = compactionPlan(deps.model(), deps.fixedTokens());
			const record = current(messages);
			const before = estimateSent(messages, record, plan);
			const next = await tryCompact(messages, plan, record, before, true, signal);
			return next ? { record: next } : { nothing: "Nothing older than the last turns to summarize yet." };
		},
		meter(messages) {
			const plan = compactionPlan(deps.model(), deps.fixedTokens());
			const used = estimateSent(messages, current(messages), plan);
			return {
				used,
				window: plan.window,
				threshold: plan.threshold,
				percent: Math.round((used / plan.window) * 100),
			};
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
): (request: SummarizeRequest) => Promise<string> {
	return async ({ model, systemPrompt, text, maxTokens, signal }) => {
		const apiKey = await getApiKey(model.provider);
		const stream = await streamFn(
			model,
			{ systemPrompt, messages: [{ role: "user", content: text, timestamp: Date.now() }], tools: [] },
			{ apiKey, signal, maxTokens },
		);
		const answer = await stream.result();
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

/** Estimated tokens every request carries besides its messages: the guard's own count (estimateFixedTokens). */
export function fixedRequestTokens(
	state: Pick<Context, "systemPrompt" | "tools"> | { systemPrompt?: string; tools?: ReadonlyArray<any> } | undefined,
): number {
	if (!state) return 0;
	return estimateFixedTokens({ systemPrompt: state.systemPrompt, tools: state.tools as Context["tools"] });
}
