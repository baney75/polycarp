/**
 * External agents' questions (ask_user over the bridge) at the top of every open side panel.
 * The service worker keeps them in chrome.storage.session (src/ask/bridge-worker.ts); the panel
 * answers one by writing `bridge_answer_<requestId>`, which only that question takes.
 */

import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { Toast } from "../components/Toast.js";
import "./AskCard.js";
import { ANSWER_KEY_PREFIX, type PanelReply, PENDING_QUESTIONS_KEY, type PendingQuestion } from "./bridge-worker.js";
import { type AskSelection, buildAnswer } from "./core.js";

let pending: PendingQuestion[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

function apply(value: unknown): void {
	pending = Array.isArray(value) ? (value as PendingQuestion[]) : [];
}

/** Load the waiting questions and call `onChange` whenever they change. */
export async function watchBridgeQuestions(onChange: () => void): Promise<() => void> {
	listeners.add(onChange);
	loading ??= chrome.storage.session.get(PENDING_QUESTIONS_KEY).then((data) => {
		apply(data[PENDING_QUESTIONS_KEY]);
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== "session" || !(PENDING_QUESTIONS_KEY in changes)) return;
			apply(changes[PENDING_QUESTIONS_KEY].newValue);
			for (const l of listeners) l();
		});
	});
	await loading;
	onChange();
	return () => listeners.delete(onChange);
}

async function reply(p: PendingQuestion, value: PanelReply): Promise<void> {
	// The worker drops an answer to a question that already ended; say so instead of "sent".
	const data = await chrome.storage.session.get(PENDING_QUESTIONS_KEY);
	const list = (data[PENDING_QUESTIONS_KEY] as PendingQuestion[] | undefined) ?? [];
	if (!list.some((q) => q.requestId === p.requestId) || p.expiresAt <= Date.now())
		throw new Error("This question has already ended.");
	await chrome.storage.session.set({ [`${ANSWER_KEY_PREFIX}${p.requestId}`]: value });
}

async function submit(p: PendingQuestion, selections: AskSelection[]): Promise<void> {
	// Checked here too, so a mistake shows on the card instead of being dropped by the worker.
	buildAnswer(p.questions, selections);
	await reply(p, { selections });
	Toast.success(`Answer sent to ${p.agentName}`);
}

async function skip(p: PendingQuestion): Promise<void> {
	await reply(p, { skip: true });
	Toast.show(`Skipped. ${p.agentName} was told you didn't answer`);
}

/** The cards, newest last; nothing when no agent is asking. */
export function bridgeQuestions(): TemplateResult | typeof nothing {
	const now = Date.now();
	const open = pending.filter((p) => p.expiresAt > now);
	if (open.length === 0) return nothing;
	return html`<div
		class="shrink-0 max-h-[60vh] overflow-y-auto px-3 py-2 space-y-2 border-b border-border"
		data-testid="bridge-questions"
	>
		${repeat(
			open,
			(p) => p.requestId,
			(p) => html`<tabkyra-ask-card
				data-request-id=${p.requestId}
				.questions=${p.questions}
				.mode=${"asking"}
				.agentName=${p.agentName}
				.expiresAt=${p.expiresAt}
				.onSubmit=${(selections: AskSelection[]) => submit(p, selections)}
				.onSkip=${() => skip(p)}
			></tabkyra-ask-card>`,
		)}
	</div>`;
}
