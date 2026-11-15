/**
 * A model request that goes quiet ends. Nothing else on the panel's path times one out: not the agent loop, not the
 * providers, not the guard. So a stream that stops sending without closing left the chat "working" until the person
 * pressed Stop, and a summary call for compaction held the turn the same way (issue 365, case 2). Each event the stream
 * sends resets the clock; after `idleMs` with none, the request is aborted and the stream ends with an error the
 * person and the model can read. A Stop from the person still goes through as before.
 */
import type { AssistantMessage, AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

/** Long enough for a slow first token or a long silent think; a stream quiet this long has stalled. */
export const STREAM_IDLE_MS = 300_000;
/** After the person's Stop, how long the inner stream has to end itself. */
const STOP_GRACE_MS = 5_000;

type Inner = (
	model: Model<any>,
	context: Context,
	options?: any,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export function stalledMessage(idleMs: number): string {
	return `The model sent nothing for ${Math.round(idleMs / 1000)} seconds, so Polycarp stopped waiting. Send your message again to retry, or pick another model.`;
}

function stalled(model: Model<any>, idleMs: number, last?: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...(last ?? {}),
		stopReason: "error",
		errorMessage: stalledMessage(idleMs),
	};
}

/** Wrap a stream function so a request with no event for `idleMs` is aborted and ends with an error. */
export function watchStream<F extends Inner>(inner: F, idleMs = STREAM_IDLE_MS): F {
	return ((model: Model<any>, context: Context, options?: any) => {
		const out = createAssistantMessageEventStream();
		const controller = new AbortController();
		const outer: AbortSignal | undefined = options?.signal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let ended = false;
		let last: AssistantMessage | undefined;
		const forward = () => {
			controller.abort(outer?.reason);
			// The inner stream ends itself as aborted; one that doesn't is ended for it, soon.
			arm(STOP_GRACE_MS);
		};
		const finish = () => {
			ended = true;
			if (timer) clearTimeout(timer);
			outer?.removeEventListener("abort", forward);
		};
		function arm(ms = idleMs) {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				if (ended) return;
				finish();
				const stopped = outer?.aborted === true;
				if (!stopped) controller.abort(new Error("stalled"));
				const error = stalled(model, idleMs, last);
				if (stopped) Object.assign(error, { stopReason: "aborted", errorMessage: "Request was aborted." });
				out.push({ type: "error", reason: stopped ? "aborted" : "error", error });
				out.end(error);
			}, ms);
		}
		arm();
		if (outer?.aborted) forward();
		else outer?.addEventListener("abort", forward, { once: true });
		void (async () => {
			try {
				const stream = await inner(model, context, { ...options, signal: controller.signal });
				for await (const event of stream) {
					if (ended) return;
					if (!outer?.aborted) arm();
					if ("partial" in event) last = event.partial;
					out.push(event);
				}
				if (ended) return;
				finish();
				out.end(await stream.result());
			} catch (err) {
				if (ended) return;
				finish();
				const error = {
					...stalled(model, idleMs, last),
					errorMessage: err instanceof Error ? err.message : String(err),
				};
				if (outer?.aborted) error.stopReason = "aborted";
				out.push({ type: "error", reason: error.stopReason as "error" | "aborted", error });
				out.end(error);
			}
		})();
		return out;
	}) as F;
}
