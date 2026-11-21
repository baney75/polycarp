/**
 * Questions the side panel's own agent is waiting on, by tool call id. The ask_user tool parks
 * its promise here; the card in the chat answers or skips it. Lives in the panel document, so a
 * closed or reloaded panel takes its waiting questions with it (the model then gets a no-answer
 * result, see src/messages/message-transformer.ts).
 */

import { type AskOutcome, type AskQuestion, buildAnswer, noAnswer } from "./core.js";

interface Waiting {
	questions: AskQuestion[];
	settle: (outcome: AskOutcome) => void;
}

const waiting = new Map<string, Waiting>();
/** Calls this panel document asked; one of them without a result is finishing, not cut off. */
const askedHere = new Set<string>();

export function wasAskedHere(toolCallId: string): boolean {
	return askedHere.has(toolCallId);
}
const listeners = new Set<() => void>();

function changed(): void {
	for (const l of listeners) l();
}

/** Call `fn` whenever a question starts or stops waiting. Returns the unsubscribe. */
export function onPendingChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function isWaiting(toolCallId: string): boolean {
	return waiting.has(toolCallId);
}

/** Wait for the card to answer or skip, or for `signal` (Stop, Escape) to abort: no answer. */
export function waitForAnswer(toolCallId: string, questions: AskQuestion[], signal?: AbortSignal): Promise<AskOutcome> {
	askedHere.add(toolCallId);
	if (signal?.aborted) return Promise.resolve(noAnswer(questions, "aborted"));
	return new Promise<AskOutcome>((resolve) => {
		const onAbort = () => finish(noAnswer(questions, "aborted"));
		const finish = (outcome: AskOutcome) => {
			if (waiting.get(toolCallId)?.settle !== finish) return;
			waiting.delete(toolCallId);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
			changed();
		};
		waiting.set(toolCallId, { questions, settle: finish });
		signal?.addEventListener("abort", onAbort, { once: true });
		changed();
	});
}

/** Answer a waiting question. Throws when the selections don't fit the questions. */
export function answerWaiting(toolCallId: string, selections: unknown): void {
	const w = waiting.get(toolCallId);
	if (!w) return;
	w.settle(buildAnswer(w.questions, selections));
}

export function skipWaiting(toolCallId: string): void {
	const w = waiting.get(toolCallId);
	if (!w) return;
	w.settle(noAnswer(w.questions, "skipped"));
}
