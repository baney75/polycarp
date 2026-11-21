/**
 * What Free mode takes out before anything reaches a free model, since those may keep what they get: keys, card numbers
 * and US Social Security numbers. Only text can be cleaned. Addresses and long ids stay, because the agent has to use them,
 * and screenshots go as they are; the consent text says so.
 */
import { redactKnownSecrets } from "./bug-reports.js";

function passesLuhn(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

export function redactForFree(text: string): string {
	return redactKnownSecrets(text)
		.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (passesLuhn(m.replace(/[ -]/g, "")) ? "[card number]" : m))
		.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]");
}

type Part = { type?: string; text?: string } & Record<string, unknown>;
type Message = { content?: string | Part[] } & Record<string, unknown>;

/** A copy of the conversation with every text part cleaned. The chat the person sees keeps the original. */
export function redactContext<C>(context: C): C {
	const messages = (context as { messages?: Message[] }).messages;
	if (!Array.isArray(messages)) return context;
	return {
		...context,
		messages: messages.map((m) => {
			if (typeof m.content === "string") return { ...m, content: redactForFree(m.content) };
			if (!Array.isArray(m.content)) return m;
			return {
				...m,
				content: m.content.map((p) => (typeof p.text === "string" ? { ...p, text: redactForFree(p.text) } : p)),
			};
		}),
	};
}
