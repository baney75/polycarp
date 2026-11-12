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
import { budgetFor, fitContext, isSizeRefusal, sizeRefusalMessage } from "./context-budget.js";

type Inner = (
	model: Model<any>,
	context: Context,
	options?: any,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** The retry asks for half of what was refused, and no more than this. */
const RETRY_CEILING_TOKENS = 24000;

/**
 * Windows learned from refusals, per provider and model: a model list can claim more than the provider takes. Kept for
 * the panel's life, so later turns don't hit the same refusal first.
 */
const learned = new Map<string, number>();
const keyOf = (model: Model<any>) => `${model.provider}/${model.id}`;

/** Forget what was learned (tests). */
export function resetLearnedWindows(): void {
	learned.clear();
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

async function pipe(from: AsyncIterator<AssistantMessageEvent>, out: AssistantMessageEventStream): Promise<void> {
	for (let next = await from.next(); !next.done; next = await from.next()) out.push(next.value);
	out.end();
}

/** Wrap a stream function so every request fits the model's window, with one harder retry on a size refusal. */
export function guardContext<F extends Inner>(inner: F): F {
	return (async (model: Model<any>, context: Context, options?: any) => {
		const key = keyOf(model);
		const budget = budgetFor(model, learned.get(key));
		const first = fitContext(context, budget);
		const stream = await inner(model, first.context, options);
		const out = createAssistantMessageEventStream();
		void (async () => {
			const iterator = stream[Symbol.asyncIterator]();
			const head = await iterator.next();
			if (head.done) return out.end();
			const event = head.value;
			// Only a refusal before anything streamed can be retried unseen; anything else passes through.
			if (
				event.type !== "error" ||
				event.reason !== "error" ||
				!isSizeRefusal(event.error.errorMessage, first.estimate, budget.windowSize, first.original)
			) {
				out.push(event);
				return pipe(iterator, out);
			}
			const refused = event.error.errorMessage ?? "";
			const ceiling = Math.max(2048, Math.min(Math.floor(first.estimate / 2), RETRY_CEILING_TOKENS));
			const harder = budgetFor(model, ceiling);
			const second = fitContext(context, harder);
			const retry = (await inner(model, second.context, options))[Symbol.asyncIterator]();
			const head2 = await retry.next();
			if (head2.done) return out.end();
			const again = head2.value;
			if (again.type === "error" && again.reason === "error") {
				const message = again.error.errorMessage ?? "";
				if (message === refused || isSizeRefusal(message, second.estimate, harder.windowSize)) {
					out.push(
						errorEvent(
							sizeRefusalMessage({
								estimate: second.estimate,
								windowSize: harder.windowSize,
								provider: model.provider,
								detail: providerDetail(refused),
							}),
							again.error,
						),
					);
					return out.end();
				}
			} else learned.set(key, ceiling);
			out.push(again);
			return pipe(retry, out);
		})().catch((err) => {
			out.push(errorEvent(err instanceof Error ? err.message : String(err)));
			out.end();
		});
		return out;
	}) as F;
}
