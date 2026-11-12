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
/** ... and this share of what the conversation may hold ... */
const TOOL_RESULT_SHARE_OF_CONVERSATION = 0.5;
/** ... and never more than this many tokens, whatever the window. */
export const TOOL_RESULT_HARD_CAP_TOKENS = 20000;
/** A part that has to give way is first cut to this, oldest first. */
const STUB_TOKENS = 500;
/** The least a part keeps when the request still doesn't fit. */
const MIN_PART_TOKENS = 100;
/** The reply the request asks for when the model lists none. */
const DEFAULT_REPLY_TOKENS = 4096;
/** The smallest reply the guard asks for before it gives up on a window: room for a short answer or a tool call. */
export const REPLY_FLOOR_TOKENS = 1024;
/** The least room the conversation needs beside the fixed part: the latest message, cut, and the turn's tool calls. */
export const CONVERSATION_FLOOR_TOKENS = 512;

/** A user message's text part that carries an attached document (message-transformer.ts writes it). */
export const ATTACHMENT_MARK = "[Document: ";

/**
 * How a context note opens: a user-role message Polycarp adds, not the person (message-transformer.ts writes one for
 * each navigation, and reorders it after the tool results, so it can sit in the middle of a turn). The fitting treats
 * it as context that can be cut, like a tool result, and never as the person's words or the start of a turn.
 */
export const CONTEXT_NOTE_MARK = "<browser-context>";

/** True for a context note: a user-role message whose text opens with CONTEXT_NOTE_MARK. */
export function isContextNote(m: Message): boolean {
	if (m.role !== "user") return false;
	const content = m.content as unknown;
	const first =
		typeof content === "string"
			? content
			: (content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text;
	return (first ?? "").trimStart().startsWith(CONTEXT_NOTE_MARK);
}

/**
 * The budget for one request, from one rule: the window, minus the reply asked for, minus the fixed part (system
 * prompt and tool schemas, measured from the request itself), leaves what the conversation may hold. The reply shrinks
 * toward REPLY_FLOOR_TOKENS before the conversation goes under CONVERSATION_FLOOR_TOKENS; when even that leaves too
 * little, the window is too small and nothing is sent.
 */
export interface Budget {
	/** The window the budget came from, in tokens (the model's, or a smaller one learned from refusals). */
	windowSize: number;
	/** Tokens kept for the reply: what the request asks the provider for (maxTokens). */
	replyTokens: number;
	/** The system prompt and tool definitions, measured. */
	fixedTokens: number;
	/** Tokens the whole request (fixed part and messages) may hold: windowSize minus replyTokens. */
	inputTokens: number;
	/** Tokens the messages may hold: inputTokens minus fixedTokens. */
	conversationTokens: number;
	/** Tokens one tool result (or one attached document) may hold. */
	toolResultTokens: number;
	/** The window can't hold the fixed part, the smallest reply and the smallest conversation. */
	tooSmall: boolean;
}

/** The model's window in tokens, or DEFAULT_CONTEXT_TOKENS when it isn't known. */
export function contextWindowOf(model: Pick<Model<never>, "contextWindow"> | undefined): number {
	const w = Number(model?.contextWindow);
	return Number.isFinite(w) && w > 0 ? w : DEFAULT_CONTEXT_TOKENS;
}

/** The reply a request would ask for: `requested` (the stream's maxTokens), else pi-ai's default (the model's cap, at most 32,000). */
export function askedReply(model: Pick<Model<never>, "maxTokens"> | undefined, requested?: number): number {
	if (Number.isFinite(requested) && Number(requested) > 0) return Math.floor(Number(requested));
	const listed = Number(model?.maxTokens);
	return Number.isFinite(listed) && listed > 0 ? Math.min(listed, 32000) : DEFAULT_REPLY_TOKENS;
}

/** The smallest window that holds this fixed part: it, the smallest reply and the smallest conversation. */
export function minimumWindow(fixedTokens: number): number {
	return fixedTokens + REPLY_FLOOR_TOKENS + CONVERSATION_FLOOR_TOKENS;
}

/**
 * The budget for one request. `ceilingTokens` lowers the window when a provider has refused a request under the
 * window it claims (a model list can overstate it). `requestedReply` is the maxTokens the request would ask for;
 * `fixedTokens` the measured system prompt and tool definitions (estimateFixedTokens).
 */
export function budgetFor(
	model: Pick<Model<never>, "contextWindow" | "maxTokens"> | undefined,
	ceilingTokens?: number,
	requestedReply?: number,
	fixedTokens = 0,
): Budget {
	const claimed = contextWindowOf(model);
	const windowSize = ceilingTokens && ceilingTokens > 0 ? Math.min(claimed, Math.floor(ceilingTokens)) : claimed;
	const asked = askedReply(model, requestedReply);
	const floor = Math.min(asked, REPLY_FLOOR_TOKENS);
	// A quarter of the window for the reply, never under the floor, never over what was asked ...
	let replyTokens = Math.min(asked, Math.max(REPLY_FLOOR_TOKENS, Math.floor(windowSize * 0.25)));
	// ... and less, down to the floor, when the conversation would otherwise not have its room: then what the fixed
	// part leaves is shared evenly between the reply and the conversation.
	const free = windowSize - fixedTokens;
	if (replyTokens > free - CONVERSATION_FLOOR_TOKENS)
		replyTokens = Math.max(floor, Math.min(free - CONVERSATION_FLOOR_TOKENS, Math.floor(free / 2)));
	const inputTokens = windowSize - replyTokens;
	const conversationTokens = inputTokens - fixedTokens;
	const toolResultTokens = Math.max(
		MIN_PART_TOKENS,
		Math.min(
			TOOL_RESULT_HARD_CAP_TOKENS,
			Math.floor(windowSize * TOOL_RESULT_SHARE),
			Math.floor(conversationTokens * TOOL_RESULT_SHARE_OF_CONVERSATION),
		),
	);
	return {
		windowSize,
		replyTokens,
		fixedTokens,
		inputTokens,
		conversationTokens,
		toolResultTokens,
		tooSmall: conversationTokens < CONVERSATION_FLOOR_TOKENS,
	};
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
		tokens += estimateSchemaTokens(tool.name + tool.description + JSON.stringify(tool.parameters ?? {}));
	return tokens;
}

/**
 * ASCII characters a token in a tool definition: English descriptions and JSON schema, whose `{"type":"string"}` runs
 * tokenizers take in few tokens. The panel's 13 tools are 34,451 characters, 8,979 tokens in o200k and 8,943 in
 * cl100k (3.84 a token); 3.5 counts about 10% over. The general rule (punctuation at 2 a character) counted 1.4 times
 * the real figure and left no room on a 16k model for a request that fits it.
 */
const SCHEMA_CHARS_PER_TOKEN = 3.5;

/** Estimated tokens of a tool definition: ASCII at SCHEMA_CHARS_PER_TOKEN, anything else by the general rule. */
function estimateSchemaTokens(text: string): number {
	let ascii = 0;
	let other = "";
	for (const ch of text) {
		if (ch.charCodeAt(0) < 0x80) ascii++;
		else other += ch;
	}
	return Math.ceil(ascii / SCHEMA_CHARS_PER_TOKEN) + (other ? estimateTextTokens(other) : 0);
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
		case "note":
			return "This was Polycarp's note on the page; read_page or get_page_text reads the page again.";
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

/**
 * A message part the fitting may cut: a tool result's text, an attached document, the person's own text, or a context
 * note's text.
 */
type Kind = "result" | "attachment" | "user" | "note";

const isAttachmentPart = (text: string) => text.trimStart().startsWith(ATTACHMENT_MARK);

/** The text parts of `m` that `kind` covers. The caller says whether `m` is a note: a cut note may have lost its mark. */
function partsOf(m: Message, kind: Kind): string[] {
	const content = m.content as unknown;
	if (typeof content === "string") return m.role === "user" && (kind === "user" || kind === "note") ? [content] : [];
	const texts = (content as Array<{ type: string; text?: string }>)
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "");
	if (kind === "result") return m.role === "toolResult" ? texts : [];
	if (m.role !== "user") return [];
	if (kind === "note") return texts;
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
		(kind === "result" || kind === "note" || (kind === "attachment") === isAttachmentPart(p.text ?? ""));
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

/** The message with its images replaced by a line saying so. */
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

/** Tool call arguments larger than this are replaced by a line saying so when an old assistant message gives way. */
const ARGUMENT_STUB_TOKENS = 50;

/**
 * An assistant message held to `maxTokens`: thinking goes first (an old turn's reasoning is not needed again, and a
 * signed thinking block can't be edited, only left out), then large tool call arguments become a short note (the call
 * keeps its id and name, so its result stays paired), then the text is cut from the end.
 */
function capAssistant(m: Message, maxTokens: number): Message {
	if (estimateMessageTokens(m) <= maxTokens || !Array.isArray(m.content)) return m;
	let parts = (m.content as unknown as Array<Record<string, unknown>>).filter((p) => p.type !== "thinking");
	const sized = () => estimateMessageTokens({ ...m, content: parts } as unknown as Message);
	if (sized() > maxTokens)
		parts = parts.map((p) => {
			if (p.type !== "toolCall") return p;
			const json = JSON.stringify(p.arguments ?? {});
			if (estimateTextTokens(json) <= ARGUMENT_STUB_TOKENS) return p;
			return {
				...p,
				arguments: {
					left_out: `Polycarp left out these arguments (${fmt(json.length)} characters) to fit the model's context.`,
				},
			};
		});
	const texts = parts.filter((p) => p.type === "text");
	if (sized() > maxTokens && texts.length) {
		const other = estimateMessageTokens({
			...m,
			content: parts.filter((p) => p.type !== "text"),
		} as unknown as Message);
		let left = Math.max(MIN_PART_TOKENS, maxTokens - other);
		parts = parts.map((p) => {
			if (p.type !== "text") return p;
			const text = String(p.text ?? "");
			const kept = capTextTokens(text, Math.max(0, left), "The rest of this earlier reply was not sent.");
			left -= estimateTextTokens(kept);
			return kept === text ? p : { ...p, text: kept };
		});
	}
	return { ...m, content: parts } as unknown as Message;
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
	/** True when what is sent is within the budget. False only when even the latest message and its turn, cut to their least, don't fit. */
	fits: boolean;
}

/** `start`, then half of it and half again, ending at the floor itself, while `going()` holds. */
function* halving(start: number, going: () => boolean): Generator<number> {
	for (let c = Math.max(start, MIN_PART_TOKENS); going(); c = Math.max(MIN_PART_TOKENS, Math.floor(c / 2))) {
		yield c;
		if (c === MIN_PART_TOKENS) return;
	}
}

/**
 * Fit a request to a budget. Everything in the history can give way, in this order, until the request fits: tool
 * results and attached documents (to their cap, then older ones to a stub, then all halved, largest first), images,
 * earlier assistant replies (thinking, then large tool call arguments, then text), the person's earlier messages, then
 * whole earlier turns, oldest first, and last the person's latest message and the turn in progress, whose oldest tool
 * calls go with their results, then the newest call's own thinking, text and arguments. Each tool call keeps its
 * result, and the person's latest message is always sent. Context notes (CONTEXT_NOTE_MARK) are cut like tool results
 * and go with the call they follow; only the person's messages start a turn. Stored history is untouched: only what
 * is sent is cut. A request that already fits comes back as the same object.
 */
export function fitContext(context: Context, budget: Budget): Fitted {
	let messages = context.messages.slice();
	const original = estimateContextTokens(context);
	const fixed = estimateFixedTokens(context);
	const resultTokens = budget.toolResultTokens;
	let perMessage = messages.map(estimateMessageTokens);
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
	// Whose each message is, decided once from the history as it came and kept with it: a cut can take a note's mark
	// away, and must never make it the person's. Notes are Polycarp's: they never start a turn or stand for the person.
	let notes = messages.map(isContextNote);
	const isPerson = (i: number) => messages[i].role === "user" && !notes[i];
	const latestUser = () => {
		for (let i = messages.length - 1; i >= 0; i--) if (isPerson(i)) return i;
		return -1;
	};
	// The kind cut as context (steps 1 to 3): a result, a note, or else an attached document.
	const kindAt = (i: number): Kind =>
		messages[i].role === "toolResult" ? "result" : notes[i] ? "note" : "attachment";
	const capPart = (i: number, tokens: number) => replace(i, capParts(messages[i], kindAt(i), tokens));
	const cuttable = () => messages.flatMap((m, i) => (partsOf(m, kindAt(i)).length ? [i] : []));
	const size = (i: number) => partsTokens(messages[i], kindAt(i));

	// 1. Every tool result and attached document to its cap.
	for (const i of cuttable()) capPart(i, resultTokens);
	// 2. Older ones to a stub, oldest first: the latest turn is what the model is working on.
	const last = latestUser();
	for (const i of cuttable().filter((j) => j < last)) {
		if (!over()) break;
		capPart(i, STUB_TOKENS);
	}
	// 3. All of them halved, largest first, down to a floor.
	for (const c of halving(Math.floor(resultTokens / 2), over))
		for (const i of cuttable().sort((a, b) => size(b) - size(a) || a - b)) {
			if (!over()) break;
			capPart(i, c);
		}
	// 4. Images before the latest user message, oldest first: the turn in progress keeps its own until step 11.
	for (let i = 0; i < latestUser(); i++) {
		if (!over()) break;
		replace(i, withoutImages(messages[i]));
	}
	// 5. Earlier assistant replies, oldest first, halving: the turn in progress gives way last (steps 10 and 11).
	for (const c of halving(STUB_TOKENS * 2, over))
		for (let i = 0; i < latestUser(); i++) {
			if (!over()) break;
			if (messages[i].role === "assistant") replace(i, capAssistant(messages[i], c));
		}
	// 6. The person's earlier messages, oldest first.
	for (const c of halving(STUB_TOKENS * 4, over))
		for (let i = 0; i < latestUser(); i++) {
			if (!over()) break;
			if (isPerson(i)) replace(i, capParts(messages[i], "user", c));
		}
	// 7. The latest user message to half of what the conversation may hold: a paste that big can never go whole, and
	// cutting it costs less than the chat's earlier turns.
	if (over() && latestUser() >= 0) {
		const half = Math.max(MIN_PART_TOKENS, Math.floor(budget.conversationTokens / 2));
		const i = latestUser();
		replace(i, capParts(capParts(messages[i], "attachment", half), "user", half));
	}
	// 8. Whole earlier turns, oldest first. A turn runs from one user message to the next, so its tool calls and
	// results go together.
	let droppedEarlier = 0;
	const drop = (from: number, to: number) => {
		total -= perMessage.slice(from, to).reduce((a, b) => a + b, 0);
		messages = [...messages.slice(0, from), ...messages.slice(to)];
		perMessage = [...perMessage.slice(0, from), ...perMessage.slice(to)];
		notes = [...notes.slice(0, from), ...notes.slice(to)];
		changed = true;
		return to - from;
	};
	while (over() && latestUser() > 0) {
		let next = 1;
		while (next < latestUser() && !isPerson(next)) next++;
		droppedEarlier += drop(0, next);
	}
	if (droppedEarlier) {
		const i = latestUser();
		const note = {
			type: "text" as const,
			text: `[Polycarp left out the ${droppedEarlier} earliest messages of this chat to fit the model's context.]`,
		};
		const content = messages[i].content as unknown;
		replace(i, {
			...messages[i],
			content: typeof content === "string" ? [note, { type: "text", text: content }] : [note, ...(content as [])],
		} as Message);
	}
	// 9. The latest user message: its images, then its documents and text.
	if (over() && latestUser() >= 0) replace(latestUser(), withoutImages(messages[latestUser()]));
	for (const c of halving(STUB_TOKENS * 4, over)) {
		const i = latestUser();
		if (i < 0) break;
		replace(i, capParts(capParts(messages[i], "attachment", c), "user", c));
	}
	// 10. The turn in progress: its oldest tool calls, each with its results, keeping the newest.
	for (;;) {
		if (!over()) break;
		const start = latestUser() + 1;
		const calls = messages.flatMap((m, k) => (k >= start && m.role === "assistant" ? [k] : []));
		if (calls.length < 2) break;
		// A call goes with its results and the context notes after them (a navigation's note follows its result).
		let end = calls[0] + 1;
		while (end < messages.length && (messages[end].role === "toolResult" || notes[end])) end++;
		drop(calls[0], end);
	}
	// 11. Last, the newest call itself: its images, its thinking, its text, then its arguments. Its id and result stay, so
	// the pair holds; a provider that wants the thinking back may refuse, which is no worse than a request known not to fit.
	for (let i = latestUser() + 1; i < messages.length && over(); i++) replace(i, withoutImages(messages[i]));
	for (const c of halving(STUB_TOKENS * 2, over))
		for (let i = latestUser() + 1; i < messages.length; i++) {
			if (!over()) break;
			if (messages[i].role === "assistant") replace(i, capAssistant(messages[i], c));
		}
	const fits = !over();
	if (!changed) return { context, estimate: original, original, fixed, resultTokens, trimmed: false, fits };
	return { context: { ...context, messages }, estimate: total, original, fixed, resultTokens, trimmed: true, fits };
}

/**
 * Words providers use when a request is over the window. Each names the context, the prompt or tokens: "image too
 * large" or "file exceeds the maximum size" is about one part, not the window, and is not proof of size.
 */
const SIZE_WORDS =
	/context[ _-]?(length|window|limit|size)|maximum context|too many tokens|(prompt|input|request|context|messages?|conversation) (is |are )?too (long|large)|too (long|large) for (the )?(model|context)|request entity too large|payload too large|reduce the length|exceeds? (the )?(model'?s? )?(available )?(context|tokens?|max(imum)? (number of )?(context|tokens|input))|token limit|maximum (number of )?(input )?tokens|\b413\b/i;
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
export function windowTooSmallMessage(info: { fixed: number; windowSize: number; needed: number }): string {
	return `This model's context window (${fmt(info.windowSize)} tokens) is too small for Polycarp's tools: its instructions and tools alone take about ${fmt(info.fixed)} tokens, and nothing was sent. Pick a model with a window of at least ${fmt(Math.ceil(info.needed / 1024) * 1024)} tokens.`;
}

/** What the person reads when even the latest message and its turn, cut to their least, don't fit. */
export function turnTooLargeMessage(info: { windowSize: number }): string {
	return `This turn is too large for the model's context window (${fmt(info.windowSize)} tokens), even with everything earlier left out and the latest message cut, so nothing was sent. Start a new chat and ask for a smaller part, or pick a model with a larger window.`;
}
