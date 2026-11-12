/**
 * How much a request may hold, measured against the model's context window. Pure: no browser, no storage, so the
 * tests run it in Node.
 *
 * A tool result can be any size (a whole book from extract_document was 706,000 characters), and a provider refuses
 * a request over its window, often with a bare "400 status code (no body)". So every tool result on its way to the
 * model is cut to a budget, and the whole request is fitted to the window before it is sent. Stored history keeps
 * every byte; only what is sent is cut.
 */
import type { Context, Message, Model, ToolResultMessage } from "@mariozechner/pi-ai";

/** A window we can't read is taken as this small, so a guess errs toward fitting. */
export const DEFAULT_CONTEXT_TOKENS = 32000;
/** Characters per token for the estimate. Real text runs near 4; 3 overcounts, which is the safe side. */
export const CHARS_PER_TOKEN = 3;
/** What one image costs in the estimate, in tokens. Providers charge roughly 1,000 to 1,600 for a screenshot. */
export const IMAGE_TOKENS = 1600;
/** One tool result may take this share of the window. */
export const TOOL_RESULT_SHARE = 0.25;
/** ... and never more than this many characters, whatever the window. */
export const TOOL_RESULT_HARD_CAP = 60000;
/** ... and never less, so a tiny window still gets a useful page. */
export const TOOL_RESULT_FLOOR = 2000;
/** A tool result that has to give way is first cut to this, oldest first. */
const STUB_CHARS = 1500;
/** The least a tool result keeps when the request still doesn't fit. */
const MIN_RESULT_CHARS = 300;
/** A text part this short is never worth cutting. */
const NOT_WORTH_CUTTING = 400;

export interface Budget {
	/** Tokens the request (system prompt, tools, messages) may hold. */
	inputTokens: number;
	/** Characters one tool result may hold. */
	toolResultChars: number;
	/** The window the budget came from, in tokens. */
	windowSize: number;
}

/** The model's window in tokens, or DEFAULT_CONTEXT_TOKENS when it isn't known. */
export function contextWindowOf(model: Pick<Model<never>, "contextWindow"> | undefined): number {
	const w = Number(model?.contextWindow);
	return Number.isFinite(w) && w > 0 ? w : DEFAULT_CONTEXT_TOKENS;
}

/** Tokens kept free for the reply: the model's own output cap, held to a quarter of the window. */
export function replyReserve(model: Pick<Model<never>, "contextWindow" | "maxTokens"> | undefined): number {
	const window = contextWindowOf(model);
	const max = Number(model?.maxTokens);
	const wanted = Number.isFinite(max) && max > 0 ? max : 4096;
	return Math.max(1024, Math.min(wanted, Math.floor(window * 0.25)));
}

/** Characters one tool result may hold for this model. */
export function toolResultBudgetChars(
	model: Pick<Model<never>, "contextWindow"> | undefined,
	windowSize?: number,
): number {
	const window = windowSize ?? contextWindowOf(model);
	const chars = Math.floor(window * TOOL_RESULT_SHARE * CHARS_PER_TOKEN);
	return Math.max(TOOL_RESULT_FLOOR, Math.min(TOOL_RESULT_HARD_CAP, chars));
}

/**
 * The budget for one request. `ceilingTokens` lowers the window when a provider has refused a request under the
 * window it claims (a model list can overstate it).
 */
export function budgetFor(
	model: Pick<Model<never>, "contextWindow" | "maxTokens"> | undefined,
	ceilingTokens?: number,
): Budget {
	const claimed = contextWindowOf(model);
	const windowSize = ceilingTokens && ceilingTokens > 0 ? Math.min(claimed, ceilingTokens) : claimed;
	const reserve = Math.min(replyReserve(model), Math.floor(windowSize * 0.25));
	return {
		inputTokens: Math.max(1024, windowSize - reserve),
		toolResultChars: toolResultBudgetChars(model, windowSize),
		windowSize,
	};
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimated tokens of one message as a provider would see it. */
export function estimateMessageTokens(message: Message): number {
	let chars = 16;
	let images = 0;
	const content = message.content as unknown;
	if (typeof content === "string") chars += content.length;
	else if (Array.isArray(content)) {
		for (const part of content as Array<Record<string, unknown>>) {
			if (part.type === "text") chars += String(part.text ?? "").length;
			else if (part.type === "thinking") chars += String(part.thinking ?? "").length;
			else if (part.type === "toolCall")
				chars += String(part.name ?? "").length + JSON.stringify(part.arguments ?? {}).length;
			else if (part.type === "image") images++;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

/** Estimated tokens of a whole request: system prompt, tool definitions and messages. */
export function estimateContextTokens(context: Context): number {
	let tokens = estimateTextTokens(context.systemPrompt ?? "");
	for (const tool of context.tools ?? [])
		tokens += estimateTextTokens(tool.name + tool.description + JSON.stringify(tool.parameters ?? {}));
	for (const m of context.messages) tokens += estimateMessageTokens(m);
	return tokens;
}

/** How to get the rest of a cut result, by tool. */
export function restHint(toolName: string | undefined): string {
	switch (toolName) {
		case "extract_document":
			return 'Call extract_document again with pages (like "40-55") or query to read the part you need.';
		case "repl":
			return "Return less from the code: a count, a filter or a slice.";
		default:
			return "Ask the tool for a smaller part (a range, offset, selector or query).";
	}
}

/**
 * Keep the head and the tail of `text` within `maxChars`, with a notice in the middle that says how much was left
 * out and how to get it. Text already within the cap comes back as is.
 */
export function capText(text: string, maxChars: number, hint = restHint(undefined)): string {
	if (text.length <= maxChars) return text;
	const notice = (dropped: number) =>
		`\n\n[Polycarp left out ${dropped.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters here to fit the model's context. ${hint}]\n\n`;
	// The notice's own length depends on the count, so measure it with the widest count it can show.
	const room = Math.max(0, maxChars - notice(text.length).length);
	const head = Math.ceil(room * 0.7);
	const tail = room - head;
	return `${text.slice(0, head)}${notice(text.length - head - tail)}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

function resultTextLength(m: ToolResultMessage): number {
	let n = 0;
	for (const part of m.content) if (part.type === "text") n += part.text.length;
	return n;
}

/** The tool result with its text cut to `maxChars` in all, or the same object when it already fits. */
function capResult(m: ToolResultMessage, maxChars: number): ToolResultMessage {
	const total = resultTextLength(m);
	if (total <= maxChars) return m;
	const hint = restHint(m.toolName);
	let left = maxChars;
	const texts = m.content.filter((p) => p.type === "text").length;
	let seen = 0;
	const content = m.content.map((part) => {
		if (part.type !== "text") return part;
		seen++;
		// Each part gets its share of what is left, the last one all of it.
		const share =
			seen === texts ? left : Math.max(NOT_WORTH_CUTTING, Math.floor((maxChars * part.text.length) / total));
		const text = capText(part.text, Math.max(0, share), hint);
		left = Math.max(0, left - text.length);
		return text === part.text ? part : { ...part, text };
	});
	return { ...m, content };
}

/** The result with its images replaced by a line saying so. */
function withoutImages(m: ToolResultMessage): ToolResultMessage {
	if (!m.content.some((p) => p.type === "image")) return m;
	return {
		...m,
		content: m.content.map((p) =>
			p.type === "image"
				? { type: "text" as const, text: "[Polycarp left out an image here to fit the model's context.]" }
				: p,
		),
	};
}

export interface Fitted {
	context: Context;
	/** Estimated tokens of what is sent. */
	estimate: number;
	/** Estimated tokens before anything was cut. */
	original: number;
	/** True when something was cut. */
	trimmed: boolean;
	/** True when the request still doesn't fit after every cut allowed (user messages are never cut). */
	over: boolean;
}

/**
 * Fit a request to a budget. Every tool result is first cut to the per-result cap. When the whole request is still
 * over, tool results give way: older ones to a stub first, oldest first; then every result is halved, largest first,
 * down to a floor; then images in tool results go, oldest first. No message is removed and nothing else changes, so
 * each tool call keeps its result and user messages arrive whole. A request that already fits comes back as the same
 * object.
 */
export function fitContext(context: Context, budget: Budget): Fitted {
	const messages = context.messages.slice();
	const original = estimateContextTokens(context);
	let changed = false;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "toolResult") continue;
		const capped = capResult(m, budget.toolResultChars);
		if (capped !== m) {
			messages[i] = capped;
			changed = true;
		}
	}
	const fixed = original - context.messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
	const perMessage = messages.map(estimateMessageTokens);
	let total = fixed + perMessage.reduce((a, b) => a + b, 0);
	const replace = (i: number, next: ToolResultMessage) => {
		if (next === messages[i]) return;
		messages[i] = next;
		const tokens = estimateMessageTokens(next);
		total += tokens - perMessage[i];
		perMessage[i] = tokens;
		changed = true;
	};
	const results = messages.flatMap((m, i) => (m.role === "toolResult" ? [i] : []));
	// The results of the latest turn are what the model is working on: they give way last.
	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--)
		if (messages[i].role === "assistant") {
			lastAssistant = i;
			break;
		}
	const older = results.filter((i) => i < lastAssistant);

	for (const i of older) {
		if (total <= budget.inputTokens) break;
		replace(i, capResult(messages[i] as ToolResultMessage, STUB_CHARS));
	}
	for (
		let cap = Math.floor(budget.toolResultChars / 2);
		total > budget.inputTokens && cap >= MIN_RESULT_CHARS;
		cap = Math.floor(cap / 2)
	) {
		const bySize = results
			.slice()
			.sort(
				(a, b) =>
					resultTextLength(messages[b] as ToolResultMessage) -
						resultTextLength(messages[a] as ToolResultMessage) || a - b,
			);
		for (const i of bySize) {
			if (total <= budget.inputTokens) break;
			replace(i, capResult(messages[i] as ToolResultMessage, cap));
		}
	}
	for (const i of results) {
		if (total <= budget.inputTokens) break;
		replace(i, withoutImages(messages[i] as ToolResultMessage));
	}
	if (!changed) return { context, estimate: original, original, trimmed: false, over: original > budget.inputTokens };
	return {
		context: { ...context, messages },
		estimate: total,
		original,
		trimmed: true,
		over: total > budget.inputTokens,
	};
}

/** Words providers use when a request is over the window. */
const SIZE_WORDS =
	/context[ _-]?(length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long|too large|request entity|payload too large|reduce the length|exceeds? (the )?(model'?s? )?(maximum|max|context|token)|token limit|maximum (number of )?tokens|\b413\b/i;
/** A refusal that says nothing at all: "400 status code (no body)" and the like. */
const BARE_400 = /^\s*(error:\s*)?400\b[^a-z]*(status code)?\s*(\(no body\))?\s*$/i;

/**
 * Whether a provider's error is a refusal for size. A plain 400 with no body counts only when size is the likely
 * cause: the request sent was over or near the window, or the chat itself (before Polycarp cut it) was over the
 * window, which happens when a model list claims a bigger window than the provider takes. Any other 400 keeps its
 * own message.
 */
export function isSizeRefusal(
	errorMessage: string | undefined,
	estimate: number,
	windowSize: number,
	uncut = estimate,
): boolean {
	if (!errorMessage) return false;
	if (SIZE_WORDS.test(errorMessage)) return true;
	return BARE_400.test(errorMessage) && (estimate >= windowSize * 0.5 || uncut > windowSize);
}

const n = (x: number) => Math.round(x).toLocaleString("en-US");

/** What the person reads when a size refusal survived the retry. */
export function sizeRefusalMessage(info: {
	estimate: number;
	windowSize: number;
	provider: string;
	detail?: string;
}): string {
	const detail = info.detail ? ` (${info.provider} said: ${info.detail})` : "";
	return `This chat is too long for the model${detail}. Polycarp cut older tool results to about ${n(info.estimate)} tokens and tried again, and it was still refused. Start a new chat, or pick a model with a larger context window, and ask for a smaller part (a page range or a search) of what you need.`;
}
