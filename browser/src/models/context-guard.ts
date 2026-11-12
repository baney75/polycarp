/**
 * The last step before a request leaves: fit it to the model's window (context-budget.ts), and when the provider still
 * refuses it for size, cut harder and try once more. A thread that already holds an oversized tool result heals here:
 * the stored history keeps it, and what is sent fits.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@mariozechner/pi-ai";
import {
	type Budget,
	budgetFor,
	CHARS_PER_TOKEN,
	CONVERSATION_FLOOR_TOKENS,
	estimateFixedTokens,
	type Fitted,
	fitContext,
	minimumWindow,
	sizeEvidence,
	sizeRefusalMessage,
	turnTooLargeMessage,
	unclearRefusalMessage,
	windowTooSmallMessage,
} from "./context-budget.js";

type Inner = (
	model: Model<any>,
	context: Context,
	options?: any,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** After this many turns that worked under a learned window, the next one tries the model's own window again. */
export const PROBE_AFTER_TURNS = 10;

/**
 * What the guard knows about one model (provider and id), kept for the panel's life. A model list can claim a larger
 * window than the provider takes; `learned` is the size of a request that the provider took after it refused a larger
 * one, stored only on proof (the provider's words named size, or a refusal on two turns in a row) and never below
 * what the fixed part needs. A later turn that works at a larger size clears it.
 */
interface ModelState {
	learned?: { window: number; evidence: "words" | "strikes" };
	/** Turns in a row whose first request was refused for size and cured by the retry. */
	strikes: number;
	/** Turns that worked first time under the learned window, since it was learned or last probed. */
	okSince: number;
	/** The fixed part (system prompt and tools) of the last request, so a tool can size its answer. */
	fixed?: number;
}
const states = new Map<string, ModelState>();
const keyOf = (model: Pick<Model<any>, "provider" | "id">) => `${model.provider}/${model.id}`;
const stateOf = (key: string): ModelState => {
	const known = states.get(key);
	if (known) return known;
	const state: ModelState = { strikes: 0, okSince: 0 };
	states.set(key, state);
	return state;
};

/** Forget what was learned (tests). */
export function resetLearnedWindows(): void {
	states.clear();
}

/** The window learned for a model, if any (tests and diagnostics). */
export function learnedWindow(model: Pick<Model<any>, "provider" | "id">): number | undefined {
	return states.get(keyOf(model))?.learned?.window;
}

/**
 * Characters one tool result may hold on this model's next request: the same budget the guard will fit it to, from the
 * learned window and the last request's fixed part. A tool that answers within it is never cut after.
 */
export function toolBudgetChars(model: Model<any> | undefined): number {
	if (!model) return budgetFor(undefined).toolResultTokens * CHARS_PER_TOKEN;
	const state = states.get(keyOf(model));
	return budgetFor(model, state?.learned?.window, undefined, state?.fixed ?? 0).toolResultTokens * CHARS_PER_TOKEN;
}

/** `options` asking for no more reply than the budget kept room for. */
function withReply(options: any, budget: Budget): any {
	const asked = Number(options?.maxTokens);
	if (Number.isFinite(asked) && asked > 0 && asked <= budget.replyTokens) return options;
	return { ...(options ?? {}), maxTokens: budget.replyTokens };
}

function errorEvent(text: string, base?: AssistantMessage): AssistantMessageEvent {
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "",
		model: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...(base ?? {}),
		stopReason: "error",
		errorMessage: text,
	};
	return { type: "error", reason: "error", error };
}

/** The detail a provider gave, when it is more than a status line. */
function providerDetail(message: string): string | undefined {
	return /^\s*\d{3}\s+status code\s*\(no body\)\s*$/i.test(message) ? undefined : message.slice(0, 200);
}

/** Push `held` and `first`, then the rest of the stream; `onEnd` gets the type of the last event pushed. */
async function follow(
	from: AsyncIterator<AssistantMessageEvent>,
	out: AssistantMessageEventStream,
	held: AssistantMessageEvent[],
	first: AssistantMessageEvent | undefined,
	onEnd: (last: AssistantMessageEvent["type"] | undefined) => void,
): Promise<void> {
	let last: AssistantMessageEvent["type"] | undefined;
	for (const event of first ? [...held, first] : held) {
		out.push(event);
		last = event.type;
	}
	if (first && first.type !== "done" && first.type !== "error")
		for (let next = await from.next(); !next.done; next = await from.next()) {
			out.push(next.value);
			last = next.value.type;
		}
	out.end();
	onEnd(last);
}

/**
 * The first event that says how a request went, and the `start` events before it, held back. A provider stream can
 * announce its start before the HTTP status arrives, so a size refusal may come second; it still gets its retry.
 */
async function opening(
	from: AsyncIterator<AssistantMessageEvent>,
): Promise<{ held: AssistantMessageEvent[]; event?: AssistantMessageEvent }> {
	const held: AssistantMessageEvent[] = [];
	for (;;) {
		const next = await from.next();
		if (next.done) return { held };
		if (next.value.type !== "start") return { held, event: next.value };
		held.push(next.value);
	}
}

/** Wrap a stream function so every request fits the model's window, with one harder retry on a size refusal. */
export function guardContext<F extends Inner>(inner: F): F {
	return (async (model: Model<any>, context: Context, options?: any) => {
		const key = keyOf(model);
		const state = stateOf(key);
		const fixed = estimateFixedTokens(context);
		state.fixed = fixed;
		const out = createAssistantMessageEventStream();
		const fail = (text: string, base?: AssistantMessage) => {
			out.push(errorEvent(text, base));
			out.end();
			return out;
		};
		// A learned window is what one past request proved, not a law: when the instructions or tools have grown past what
		// it can hold, it says nothing about today's request, so it is dropped and the model's own window is tried.
		if (state.learned && state.learned.window < minimumWindow(fixed)) {
			state.learned = undefined;
			state.okSince = 0;
		}
		// Every so often a model with a learned window tries its own again, so one bad hour doesn't last all day.
		const probing = state.learned !== undefined && state.okSince >= PROBE_AFTER_TURNS;
		if (probing) state.okSince = 0;
		const known = state.learned;
		const budget = budgetFor(model, probing ? undefined : known?.window, options?.maxTokens, fixed);
		if (budget.tooSmall)
			return fail(windowTooSmallMessage({ fixed, windowSize: budget.windowSize, needed: minimumWindow(fixed) }));
		const first = fitContext(context, budget);
		if (!first.fits) return fail(turnTooLargeMessage({ windowSize: budget.windowSize }));
		const sentSize = (f: Fitted, b: Budget) => f.estimate + b.replyTokens;
		// A probe goes past the learned window; one that is refused falls back to it, the size known to work.
		const probedPast = probing && known !== undefined && sentSize(first, budget) > known.window;
		// What a refusal teaches: never more than was learned before, and never less than the fixed part needs.
		const learn = (window: number, evidence: "words" | "strikes") => {
			const floor = Math.max(minimumWindow(fixed), window);
			state.learned = { window: known ? Math.min(known.window, floor) : floor, evidence };
			state.okSince = 0;
		};
		const stream = await inner(model, first.context, withReply(options, budget));
		void (async () => {
			const iterator = stream[Symbol.asyncIterator]();
			const { held, event } = await opening(iterator);
			if (!event) return follow(iterator, out, held, undefined, () => {});
			const evidence =
				event.type === "error" && event.reason === "error"
					? sizeEvidence(event.error.errorMessage, first.estimate, budget.windowSize, first.original)
					: undefined;
			if (event.type !== "error" || !evidence) {
				// Only a reply that ran to its end counts as the request working: a stream can start and then fail.
				return follow(iterator, out, held, event, (last) => {
					if (last !== "done") return;
					// A first try that worked ends a run of refusals, and counts toward trying the full window again.
					state.strikes = 0;
					if (state.learned) {
						if (probedPast) state.learned = undefined;
						else state.okSince++;
					}
				});
			}
			const refused = event.error.errorMessage ?? "";
			const proven = (again?: string) =>
				evidence === "words" ||
				evidence === "likely" ||
				(again !== undefined && sizeEvidence(again, 0, 1) === "words");
			const report = (estimate: number, again?: string) =>
				proven(again)
					? sizeRefusalMessage({ estimate, provider: model.provider, detail: providerDetail(again ?? refused) })
					: unclearRefusalMessage({ estimate, first: refused });
			// The retry halves the conversation, never the fixed part: it can't go under what the instructions and tools
			// need plus the least conversation, so it is never sent knowing it can't fit. A refused probe retries at the
			// learned window instead.
			const conversation = first.estimate - fixed;
			const ceiling = probedPast
				? known.window
				: fixed + Math.max(CONVERSATION_FLOOR_TOKENS, Math.floor(conversation / 2)) + budget.replyTokens;
			const harder = budgetFor(model, ceiling, options?.maxTokens, fixed);
			const second = harder.tooSmall ? undefined : fitContext(context, harder);
			if (!second?.fits || sentSize(second, harder) >= sentSize(first, budget)) {
				// Nothing smaller can be sent: say why it was refused instead of sending the same request again. When the
				// provider named size, the next turn starts below what it refused, so the same refusal doesn't repeat.
				if (evidence === "words") learn(Math.floor(sentSize(first, budget) * 0.75), "words");
				out.push(errorEvent(report(first.estimate), event.error));
				return out.end();
			}
			// A refused probe is no new strike: the learned window already says the provider takes less.
			if (!probedPast) state.strikes++;
			const retry = (await inner(model, second.context, withReply(options, harder)))[Symbol.asyncIterator]();
			const again = await opening(retry);
			if (!again.event) return follow(retry, out, again.held, undefined, () => {});
			const next = again.event;
			if (next.type === "error" && next.reason === "error") {
				const message = next.error.errorMessage ?? "";
				if (message === refused || sizeEvidence(message, second.estimate, harder.windowSize)) {
					// The smaller request was refused too. On proof, the next turn starts below it, so a model that claims far
					// more than it takes gets there in a few turns instead of failing the same way on every one.
					if (evidence === "words" || sizeEvidence(message, 0, 1) === "words" || state.strikes >= 2)
						learn(Math.floor(sentSize(second, harder) * 0.75), evidence === "words" ? "words" : "strikes");
					out.push(errorEvent(report(second.estimate, message), next.error));
					return out.end();
				}
			}
			return follow(retry, out, again.held, next, (last) => {
				if (last !== "done") return;
				// A refused probe that worked at the learned window keeps it as it was, and the next probe waits its turn.
				if (probedPast) state.okSince = 0;
				// The provider took this size after refusing a larger one: keep to it, but never to less than the fixed
				// part needs, which the request that just worked carried.
				else if (evidence === "words" || state.strikes >= 2)
					learn(sentSize(second, harder), evidence === "words" ? "words" : "strikes");
			});
		})().catch((err) => {
			out.push(errorEvent(err instanceof Error ? err.message : String(err)));
			out.end();
		});
		return out;
	}) as F;
}
