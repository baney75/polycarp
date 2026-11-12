/**
 * How much a request may hold, measured against the model's context window. Pure: no browser, no storage, so the
 * tests run it in Node.
 *
 * A tool result can be any size (a whole book from extract_document was 706,000 characters), and so can a file the
 * person attaches or text they paste; a provider refuses a request over its window, often with a bare
 * "400 status code (no body)". So everything on its way to the model is fitted to the window before it is sent:
 * tool results and attached documents first, the person's own words only when nothing else is left to cut. Stored
 * history keeps every byte; only what is sent is cut.
 */
import type { Context, Message, Model, ToolResultMessage } from "@mariozechner/pi-ai";

/** A window we can't read is taken as this small, so a guess errs toward fitting. */
export const DEFAULT_CONTEXT_TOKENS = 32000;
/** Characters per token for Latin text in the estimate. Real prose runs near 4; 3 overcounts, the safe side. */
export const CHARS_PER_TOKEN = 3;
/** What one image costs in the estimate, in tokens. Providers charge roughly 1,000 to 1,600 for a screenshot. */
export const IMAGE_TOKENS = 1600;
/** One tool result may take this share of the window ... */
export const TOOL_RESULT_SHARE = 0.25;
/** ... and this share of what the system prompt and tool definitions leave ... */
const TOOL_RESULT_SHARE_OF_FREE = 0.5;
/** ... and never more than this many tokens, whatever the window ... */
export const TOOL_RESULT_HARD_CAP_TOKENS = 20000;
/** ... and never less, so a tiny window still gets a useful page. */
export const TOOL_RESULT_FLOOR_TOKENS = 500;
/** A part that has to give way is first cut to this, oldest first. */
const STUB_TOKENS = 500;
/** The least a part keeps when the request still doesn't fit. */
const MIN_PART_TOKENS = 100;
/** The reply the request asks for when the model lists none. */
const DEFAULT_REPLY_TOKENS = 4096;

/** A user message's text part that carries an attached document (message-transformer.ts writes it). */
export const ATTACHMENT_MARK = "[Document: ";

export interface Budget {
	/** Tokens the request (system prompt, tools, messages) may hold. */
	inputTokens: number;
	/** Tokens kept for the reply: what the request asks the provider for (maxTokens). */
	replyTokens: number;
	/** Tokens one tool result may hold, before the fixed part of a request is known. */
	toolResultTokens: number;
	/** The window the budget came from, in tokens. */
	windowSize: number;
}

/** The model's window in tokens, or DEFAULT_CONTEXT_TOKENS when it isn't known. */
export function contextWindowOf(model: Pick<Model<never>, "contextWindow"> | undefined): number {
	const w = Number(model?.contextWindow);
	return Number.isFinite(w) && w > 0 ? w : DEFAULT_CONTEXT_TOKENS;
}

/**
 * The reply the request will ask for: `requested` (the stream's maxTokens) or what pi-ai asks by default (the model's
 * own cap, at most 32,000), held to a quarter of the window. When that is less than would be asked, the guard sends
 * this as maxTokens, so input plus reply always fits the window.
 */
export function replyReserve(
	model: Pick<Model<never>, "contextWindow" | "maxTokens"> | undefined,
	requested?: number,
	windowSize = contextWindowOf(model),
): number {
	const listed = Number(model?.maxTokens);
	const asked =
		Number.isFinite(requested) && Number(requested) > 0
			? Number(requested)
			: Number.isFinite(listed) && listed > 0
				? Math.min(listed, 32000)
				: DEFAULT_REPLY_TOKENS;
	return Math.max(1024, Math.min(asked, Math.floor(windowSize * 0.25)));
}

/**
 * The budget for one request. `ceilingTokens` lowers the window when a provider has refused a request under the
 * window it claims (a model list can overstate it). `requestedReply` is the maxTokens the request will ask for.
 */
export function budgetFor(
	model: Pick<Model<never>, "contextWindow" | "maxTokens"> | undefined,
	ceilingTokens?: number,
	requestedReply?: number,
): Budget {
	const claimed = contextWindowOf(model);
	const windowSize = ceilingTokens && ceilingTokens > 0 ? Math.min(claimed, ceilingTokens) : claimed;
	const replyTokens = replyReserve(model, requestedReply, windowSize);
	const toolResultTokens = Math.max(
		TOOL_RESULT_FLOOR_TOKENS,
		Math.min(TOOL_RESULT_HARD_CAP_TOKENS, Math.floor(windowSize * TOOL_RESULT_SHARE)),
	);
	return { inputTokens: Math.max(1024, windowSize - replyTokens), replyTokens, toolResultTokens, windowSize };
}

/**
 * Tokens one tool result may hold once the fixed part of the request (system prompt and tool definitions, `fixed`
 * tokens) is known: a share of what is left, never more than the window's share, never under the floor.
 */
export function resultTokensFor(budget: Budget, fixed: number): number {
	const free = Math.floor((budget.inputTokens - fixed) * TOOL_RESULT_SHARE_OF_FREE);
	return Math.max(TOOL_RESULT_FLOOR_TOKENS, Math.min(budget.toolResultTokens, free));
}

/** Characters of Latin text one tool result may hold for this model, before the fixed part is known. */
export function toolResultBudgetChars(
	model: Pick<Model<never>, "contextWindow" | "maxTokens"> | undefined,
	windowSize?: number,
): number {
	return budgetFor(model, windowSize).toolResultTokens * CHARS_PER_TOKEN;
}

/**
 * Estimated tokens of a text, by script: Chinese, Japanese and Korean characters (and anything outside the Basic
 * Multilingual Plane, like emoji) run near one token each; other non-Latin letters and ASCII punctuation, which code is
 * dense with, about two characters a token; Latin letters, digits and spaces CHARS_PER_TOKEN.
 */
export function estimateTextTokens(text: string): number {
	let wide = 0;
	let dense = 0;
	let plain = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) {
			// Letters, digits and whitespace are the plain case; everything else in ASCII is punctuation.
			if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c <= 0x20) plain++;
			else dense++;
		} else if ((c >= 0x2e80 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xffef) || (c >= 0xd800 && c <= 0xdbff)) wide++;
		else if (c < 0xdc00 || c > 0xdfff) dense++;
		// The second half of a surrogate pair is counted with the first.
	}
	return Math.ceil(wide + dense / 2 + plain / CHARS_PER_TOKEN);
}

/** Estimated tokens of one message as a provider would see it. */
export function estimateMessageTokens(message: Message): number {
	let tokens = 6;
	const content = message.content as unknown;
	if (typeof content === "string") tokens += estimateTextTokens(content);
	else if (Array.isArray(content)) {
		for (const part of content as Array<Record<string, unknown>>) {
			if (part.type === "text") tokens += estimateTextTokens(String(part.text ?? ""));
			else if (part.type === "thinking") tokens += estimateTextTokens(String(part.thinking ?? ""));
			else if (part.type === "toolCall")
				tokens += estimateTextTokens(String(part.name ?? "") + JSON.stringify(part.arguments ?? {}));
			else if (part.type === "image") tokens += IMAGE_TOKENS;
		}
	}
	return tokens;
}

/** Estimated tokens of the part of a request every turn repeats: the system prompt and tool definitions. */
export function estimateFixedTokens(context: Pick<Context, "systemPrompt" | "tools">): number {
	let tokens = estimateTextTokens(context.systemPrompt ?? "");
	for (const tool of context.tools ?? [])
		tokens += estimateTextTokens(tool.name + tool.description + JSON.stringify(tool.parameters ?? {}));
	return tokens;
}

/** Estimated tokens of a whole request: system prompt, tool definitions and messages. */
export function estimateContextTokens(context: Context): number {
	let tokens = estimateFixedTokens(context);
	for (const m of context.messages) tokens += estimateMessageTokens(m);
	return tokens;
}

const fmt = (x: number) => Math.round(x).toLocaleString("en-US");

/** How to get the rest of a cut part, by tool. `kept` is what was sent, so the hint can say where it stopped. */
export function restHint(toolName: string | undefined, kept = ""): string {
	switch (toolName) {
		case "extract_document": {
			const pages = [...kept.matchAll(/--- (Page|Slide|Sheet|Part) (\d+)\b[^\n]* of (\d+) ---/g)];
			const last = pages.at(-1);
			if (last) {
				const word = last[1].toLowerCase();
				return `It stopped inside ${word} ${last[2]}: call extract_document with pages starting at ${last[2]} (like "${last[2]}-${Math.min(Number(last[3]), Number(last[2]) + 2)}") for the rest, fewer at a time.`;
			}
			return 'Call extract_document again with fewer pages (like "40-42") or a query to read the part you need.';
		}
		case "repl":
			return "Return less from the code: a count, a filter or a slice.";
		case "attachment":
			return 'Read the file in parts with extract_document {"attachment": "<its file name>"} and pages or a query.';
		case "user":
			return "Ask the person for the part that matters, or to attach long text as a file.";
		default:
			return "Ask the tool for a smaller part (a range, offset, selector or query).";
	}
}

/**
 * The head of `text` within `maxChars`, then one line that says how much was not sent and how to get it. The cut is
 * at the end and nothing after it is kept: a tool's own "read on from here" note, measured on the whole text, would
 * point past what was dropped. Text already within the cap comes back as is.
 */
export function capText(
	text: string,
	maxChars: number,
	hint: string | ((kept: string) => string) = restHint(undefined),
): string {
	if (text.length <= maxChars) return text;
	const say = (kept: string) =>
		`\n\n[Polycarp cut this here to fit the model's context: ${fmt(text.length - kept.length)} of ${fmt(text.length)} characters after this point were not sent. ${typeof hint === "function" ? hint(kept) : hint}]`;
	// The note's own length depends on what is kept, so measure it at its widest first.
	const room = Math.max(0, maxChars - say(text.slice(0, maxChars)).length);
	const kept = text.slice(0, room);
	return `${kept}${say(kept)}`;
}

/** The part of `text` that fits `maxTokens`, by its own density (a CJK text keeps fewer characters). */
function capTextTokens(text: string, maxTokens: number, hint: string | ((kept: string) => string)): string {
	const tokens = estimateTextTokens(text);
	if (tokens <= maxTokens) return text;
	let chars = Math.floor((text.length * maxTokens) / tokens);
	for (;;) {
		const cut = capText(text, Math.max(0, chars), hint);
		if (estimateTextTokens(cut) <= maxTokens || chars <= 0) return cut;
		chars = Math.floor(chars * 0.9);
	}
}

/** A message part the fitting may cut: a tool result's text, an attached document, or the person's own text. */
type Kind = "result" | "attachment" | "user";

function kindOf(m: Message): Kind | undefined {
	if (m.role === "toolResult") return "result";
	if (m.role === "user") return "user";
	return undefined;
}

const isAttachmentPart = (text: string) => text.trimStart().startsWith(ATTACHMENT_MARK);

/** The text parts of `m` that `kind` covers. */
function partsOf(m: Message, kind: Kind): string[] {
	const content = m.content as unknown;
	if (typeof content === "string") return kind === "user" ? [content] : [];
	const texts = (content as Array<{ type: string; text?: string }>)
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "");
	if (kind === "result") return m.role === "toolResult" ? texts : [];
	if (m.role !== "user") return [];
	return texts.filter((t) => (kind === "attachment" ? isAttachmentPart(t) : !isAttachmentPart(t)));
}

function partsTokens(m: Message, kind: Kind): number {
	return partsOf(m, kind).reduce((n, t) => n + estimateTextTokens(t), 0);
}

/**
 * `m` with the text parts of `kind` held to `maxTokens` in all, however many parts there are: they are kept whole in
 * order while they fit, the first one that doesn't is cut, and the ones after it are left out, with the cut note
 * saying so. Images and other parts stay. The same object comes back when it already fits.
 */
function capParts(m: Message, kind: Kind, maxTokens: number): Message {
	if (partsTokens(m, kind) <= maxTokens) return m;
	const hintFor = kind === "result" ? (m as ToolResultMessage).toolName : kind;
	const content = m.content as unknown;
	if (typeof content === "string")
		return { ...m, content: capTextTokens(content, maxTokens, (k) => restHint(hintFor, k)) } as Message;
	const all = content as Array<{ type: string; text?: string }>;
	const covered = (p: { type: string; text?: string }) =>
		p.type === "text" &&
		(kind === "result" || (m.role === "user" && (kind === "attachment") === isAttachmentPart(p.text ?? "")));
	const total = all.filter(covered).length;
	let left = maxTokens;
	let dropped = 0;
	let droppedChars = 0;
	let cutDone = false;
	const out: Array<{ type: string; text?: string }> = [];
	for (const part of all) {
		if (!covered(part)) {
			out.push(part);
			continue;
		}
		const text = part.text ?? "";
		if (cutDone) {
			dropped++;
			droppedChars += text.length;
			continue;
		}
		const tokens = estimateTextTokens(text);
		if (tokens <= left) {
			out.push(part);
			left -= tokens;
			continue;
		}
		cutDone = true;
		out.push({ ...part, text: capTextTokens(text, Math.max(MIN_PART_TOKENS, left), (k) => restHint(hintFor, k)) });
		left = 0;
	}
	if (dropped)
		out.push({
			type: "text",
			text: `[Polycarp left out ${dropped} more of the ${total} text parts here (${fmt(droppedChars)} characters) to fit the model's context. ${restHint(hintFor)}]`,
		});
	return { ...m, content: out } as Message;
}

/** The result with its images replaced by a line saying so. */
function withoutImages(m: Message): Message {
	const content = m.content as unknown;
	if (!Array.isArray(content) || !content.some((p) => p.type === "image")) return m;
	return {
		...m,
		content: (content as Array<{ type: string }>).map((p) =>
			p.type === "image"
				? { type: "text" as const, text: "[Polycarp left out an image here to fit the model's context.]" }
				: p,
		),
	} as Message;
}

export interface Fitted {
	context: Context;
	/** Estimated tokens of what is sent. */
	estimate: number;
	/** Estimated tokens before anything was cut. */
	original: number;
	/** Estimated tokens of the system prompt and tool definitions. */
	fixed: number;
	/** Tokens one tool result was held to. */
	resultTokens: number;
	/** True when something was cut. */
	trimmed: boolean;
}

/**
 * Fit a request to a budget. Every tool result and every attached document in a user message is first held to the
 * per-result cap. When the whole request is still over, they give way: older ones to a stub first, oldest first; then
 * all are halved, largest first, down to a floor; then images go. Only when that is not enough is the person's own
 * text cut, oldest message first, the newest last. No message is removed, so each tool call keeps its result. A
 * request that already fits comes back as the same object.
 */
export function fitContext(context: Context, budget: Budget): Fitted {
	const messages = context.messages.slice();
	const original = estimateContextTokens(context);
	const fixed = estimateFixedTokens(context);
	const resultTokens = resultTokensFor(budget, fixed);
	const perMessage = messages.map(estimateMessageTokens);
	let total = fixed + perMessage.reduce((a, b) => a + b, 0);
	let changed = false;
	const replace = (i: number, next: Message) => {
		if (next === messages[i]) return;
		messages[i] = next;
		const tokens = estimateMessageTokens(next);
		total += tokens - perMessage[i];
		perMessage[i] = tokens;
		changed = true;
	};
	const over = () => total > budget.inputTokens;
	const cuttable = (kind: "result" | "attachment") => messages.flatMap((m, i) => (partsOf(m, kind).length ? [i] : []));
	const results = cuttable("result");
	const attachments = cuttable("attachment");
	const both = [...new Set([...results, ...attachments])].sort((a, b) => a - b);
	const cap = (i: number, tokens: number) => {
		let next = messages[i];
		if (kindOf(next) === "result") next = capParts(next, "result", tokens);
		else next = capParts(next, "attachment", tokens);
		replace(i, next);
	};

	for (const i of both) cap(i, resultTokens);
	// The latest turn is what the model is working on: it gives way last.
	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--)
		if (messages[i].role === "assistant") {
			lastAssistant = i;
			break;
		}
	for (const i of both.filter((j) => j < lastAssistant)) {
		if (!over()) break;
		cap(i, STUB_TOKENS);
	}
	const size = (i: number) => partsTokens(messages[i], kindOf(messages[i]) === "result" ? "result" : "attachment");
	for (let c = Math.floor(resultTokens / 2); over() && c >= MIN_PART_TOKENS; c = Math.floor(c / 2)) {
		for (const i of both.slice().sort((a, b) => size(b) - size(a) || a - b)) {
			if (!over()) break;
			cap(i, c);
		}
	}
	for (const i of both) {
		if (!over()) break;
		replace(i, withoutImages(messages[i]));
	}
	// Last: the person's own words (typed, pasted, a skill they chose, a page they shared), oldest first. A message is
	// kept whole whenever the request fits with it whole.
	const users = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
	for (let c = STUB_TOKENS * 4; over() && c >= MIN_PART_TOKENS; c = Math.floor(c / 2)) {
		for (const i of users) {
			if (!over()) break;
			replace(i, capParts(messages[i], "user", c));
		}
	}
	if (!changed) return { context, estimate: original, original, fixed, resultTokens, trimmed: false };
	return { context: { ...context, messages }, estimate: total, original, fixed, resultTokens, trimmed: true };
}

/** Words providers use when a request is over the window. */
const SIZE_WORDS =
	/context[ _-]?(length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long|too large|request entity|payload too large|reduce the length|exceeds? (the )?(model'?s? )?(maximum|max|context|token)|token limit|maximum (number of )?tokens|\b413\b/i;
/** A refusal that says nothing at all: "400 status code (no body)" and the like. */
const BARE_400 = /^\s*(error:\s*)?400\b[^a-z]*(status code)?\s*(\(no body\))?\s*$/i;

/**
 * What a provider's error says about size. "words": it names size, which is proof. "likely": a bare 400 on a request
 * at three quarters of the window or more. "maybe": a bare 400 on a request at half the window or more, or in a chat
 * whose history (before Polycarp cut it) is over the window, which is how a model list that claims too big a window
 * shows. Each of those gets one retry, cut harder; only "words" and "likely" are reported as too long if the retry
 * fails too, and a window is learned only from "words" or a second refusal.
 */
export function sizeEvidence(
	errorMessage: string | undefined,
	estimate: number,
	windowSize: number,
	uncut = estimate,
): "words" | "likely" | "maybe" | undefined {
	if (!errorMessage) return undefined;
	if (SIZE_WORDS.test(errorMessage)) return "words";
	if (!BARE_400.test(errorMessage)) return undefined;
	if (estimate >= windowSize * 0.75) return "likely";
	if (estimate >= windowSize * 0.5 || uncut > windowSize) return "maybe";
	return undefined;
}

/** Whether a provider's error may be a refusal for size (sizeEvidence finds any). */
export function isSizeRefusal(
	errorMessage: string | undefined,
	estimate: number,
	windowSize: number,
	uncut = estimate,
): boolean {
	return sizeEvidence(errorMessage, estimate, windowSize, uncut) !== undefined;
}

/** What the person reads when a size refusal survived the retry. */
export function sizeRefusalMessage(info: { estimate: number; provider: string; detail?: string }): string {
	const detail = info.detail ? ` (${info.provider} said: ${info.detail})` : "";
	return `This chat is too long for the model${detail}. Polycarp cut older tool results to about ${fmt(info.estimate)} tokens and tried again, and it was still refused. Start a new chat, or pick a model with a larger context window, and ask for a smaller part (a page range or a search) of what you need.`;
}

/** What the person reads when a bare 400 came back twice and nothing says it was about length. */
export function unclearRefusalMessage(info: { estimate: number; first: string }): string {
	return `The provider refused this request (${info.first.trim()}), and refused it again when Polycarp sent a shorter one of about ${fmt(info.estimate)} tokens, without saying why. It may not be the chat's length. Try again, or another model; if it keeps happening, start a new chat.`;
}

/** What the person reads when the model's window can't hold Polycarp's instructions and tools at all. */
export function windowTooSmallMessage(info: { fixed: number; inputTokens: number; windowSize: number }): string {
	return `This model's context window (${fmt(info.windowSize)} tokens) is too small for Polycarp: its instructions and tools alone take about ${fmt(info.fixed)} tokens, and only ${fmt(info.inputTokens)} can be sent with room for a reply. Pick a model with a window of at least ${fmt(Math.ceil((info.fixed * 2.5) / 1024) * 1024)} tokens.`;
}
