// The guard as one rule, checked over a grid: for any window, fixed part, real limit and history, a request is sent
// only when its estimate plus the reply it asks for fits the window, with every tool call paired and the latest user
// message present; otherwise the person reads a plain error. Then the four review round 2 highs, by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

const { budgetFor, estimateContextTokens, estimateFixedTokens, fitContext, minimumWindow } = await import(
	"../src/models/context-budget.ts"
);
const { guardContext, learnedWindow, PROBE_AFTER_TURNS, resetLearnedWindows } = await import(
	"../src/models/context-guard.ts"
);

const PANEL = JSON.parse(readFileSync(new URL("./fixtures/panel-request.json", import.meta.url), "utf8"));

// ---- a provider stand-in ---------------------------------------------------------------------

const BARE = "400 status code (no body)";
const WORDS = "This model's maximum context length is exceeded";

/** A provider that takes a request only when its estimate plus the reply asked for is within `actual` tokens. */
function provider(actual, refusal = WORDS) {
	const sent = [];
	const options = [];
	const inner = async (_model, context, opts) => {
		sent.push(context);
		options.push(opts);
		const s = createAssistantMessageEventStream();
		const size = estimateContextTokens(context) + Number(opts?.maxTokens ?? 0);
		queueMicrotask(() => {
			if (size > actual)
				s.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: refusal, timestamp: 0 } });
			else {
				const message = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 0 };
				s.push({ type: "start", partial: message });
				s.push({ type: "done", reason: "stop", message });
			}
			s.end();
		});
		return s;
	};
	return { inner, sent, options };
}

async function finalOf(stream) {
	let last;
	for await (const e of stream) last = e;
	return last;
}

// ---- histories -------------------------------------------------------------------------------

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const words = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);
const IMAGE = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

/** A random chat: turns of user messages, tool calls with results, and replies, of every awkward kind. */
function randomHistory(r) {
	const messages = [];
	let t = 0;
	let call = 0;
	const pick = (...xs) => xs[Math.floor(r() * xs.length)];
	const turns = 1 + Math.floor(r() * 6);
	for (let turn = 0; turn < turns; turn++) {
		const kind = pick("short", "paste", "cjk", "images", "attachment");
		const content =
			kind === "short"
				? `question ${turn}`
				: kind === "paste"
					? words(200_000 + Math.floor(r() * 500_000))
					: kind === "cjk"
						? "論語學而第一子曰學而時習之".repeat(2000)
						: kind === "images"
							? [{ type: "text", text: "what do these show?" }, ...Array.from({ length: 12 }, () => IMAGE)]
							: [{ type: "text", text: "read this" }, { type: "text", text: `\n\n[Document: book.pdf]\n${words(300_000)}` }];
		messages.push({ role: "user", content, timestamp: ++t });
		const last = turn === turns - 1;
		const groups = Math.floor(r() * (last ? 5 : 3));
		for (let g = 0; g < groups; g++) {
			const id = `call_${++call}`;
			const big = r() < 0.3;
			messages.push({
				role: "assistant",
				content: [
					...(r() < 0.3 ? [{ type: "thinking", thinking: words(20_000) }] : []),
					{ type: "toolCall", id, name: big ? "artifacts" : "navigate", arguments: big ? { command: "create", content: `<html>${words(200_000)}</html>` } : { url: "https://example.com/" } },
				],
				api: "openai-completions",
				provider: "p",
				model: "m",
				usage: {},
				stopReason: "toolUse",
				timestamp: ++t,
			});
			const shape = pick("huge", "blocks", "image", "small");
			const result =
				shape === "huge"
					? [{ type: "text", text: words(700_000) }]
					: shape === "blocks"
						? Array.from({ length: 1000 }, (_, i) => ({ type: "text", text: `block ${i} ${words(330)}` }))
						: shape === "image"
							? [{ type: "text", text: "screenshot" }, IMAGE]
							: [{ type: "text", text: "done" }];
			messages.push({ role: "toolResult", toolCallId: id, toolName: big ? "artifacts" : "navigate", content: result, isError: false, timestamp: ++t });
		}
		if (!last || r() < 0.5) {
			if (r() < 0.6)
				messages.push({ role: "assistant", content: [{ type: "text", text: words(12_000 + Math.floor(r() * 12_000)) }], api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "stop", timestamp: ++t });
		}
	}
	return messages;
}

/** A system prompt of about `tokens` tokens of plain text. */
const fixedPrompt = (tokens) => words(tokens * 3);

function lastUser(messages) {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i];
	return undefined;
}

/** Every tool call in the sent request has exactly one result after it, and every result follows its call. */
function pairsIntact(messages) {
	const open = new Set();
	for (const m of messages) {
		if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") open.add(c.id);
		if (m.role === "toolResult") {
			if (!open.has(m.toolCallId)) return false;
			open.delete(m.toolCallId);
		}
	}
	return open.size === 0;
}

const PLAIN_ERRORS =
	/too small for Polycarp's tools|This turn is too large for the model's context window|This chat is too long for the model|The provider refused this request/;

// ---- the property ----------------------------------------------------------------------------

test("the guard either sends a request that fits, paired and with the latest message, or a plain error: over a grid", async () => {
	const windows = [8192, 16_384, 32_000, 65_536, 131_072, 200_000];
	const fixedParts = [2000, 5000, 10_000, 14_400, 20_000];
	let cases = 0;
	let sends = 0;
	let healed = 0;
	for (const [w, claimed] of windows.entries())
		for (const [f, fixedTokens] of fixedParts.entries())
			for (const [a, actualOf] of [(c) => c, (c) => Math.floor(c / 2), (c) => Math.min(c, 32_000)].entries())
				for (const refusal of [WORDS, BARE]) {
					resetLearnedWindows();
					const r = rng(1000 * w + 100 * f + 10 * a + (refusal === BARE ? 1 : 0));
					const actual = actualOf(claimed);
					const model = { id: `m${w}-${f}-${a}`, provider: "grid", contextWindow: claimed, maxTokens: 8192 };
					const messages = randomHistory(r);
					const context = { systemPrompt: fixedPrompt(fixedTokens), tools: [], messages };
					const fixed = estimateFixedTokens(context);
					const { inner, sent, options } = provider(actual, refusal);
					const guarded = guardContext(inner);
					let done = false;
					for (let turn = 0; turn < 8 && !done; turn++) {
						cases++;
						const before = sent.length;
						const last = await finalOf(await guarded(model, context, {}));
						assert.ok(sent.length - before <= 2, "at most one retry");
						for (let k = before; k < sent.length; k++) {
							sends++;
							const size = estimateContextTokens(sent[k]) + options[k].maxTokens;
							assert.ok(size <= claimed, `sent ${size} tokens to a ${claimed} window`);
							assert.ok(estimateFixedTokens(sent[k]) === fixed, "the fixed part goes whole");
							assert.ok(pairsIntact(sent[k].messages), "tool calls paired");
							assert.equal(lastUser(sent[k].messages)?.timestamp, lastUser(messages).timestamp, "the latest user message is sent");
						}
						if (last.type === "done") {
							done = true;
							if (turn > 0) healed++;
							continue;
						}
						assert.equal(last.type, "error");
						const text = last.error.errorMessage;
						// A bare 400 under half the window on a small chat is not blamed on size; it passes through as it was.
						if (text === BARE) {
							assert.equal(refusal, BARE);
							continue;
						}
						assert.match(text, PLAIN_ERRORS, text);
						if (/too small for Polycarp's tools/.test(text)) {
							assert.equal(sent.length, before, "nothing sent");
							assert.ok(claimed < minimumWindow(fixed) + 1, `claimed ${claimed}, needs ${minimumWindow(fixed)}`);
							done = true;
						}
					}
					// When the provider names size and its real window has room, the chat works within a few turns.
					if (refusal === WORDS && actual >= minimumWindow(fixed) + 1024) assert.ok(done, `${model.id}: never answered (actual ${actual}, fixed ${fixed})`);
				}
	assert.ok(cases > 180 && sends > 100 && healed > 0, `cases ${cases}, sends ${sends}, healed ${healed}`);
});

// ---- the round 2 highs -----------------------------------------------------------------------

const panel = (messages) => ({ systemPrompt: PANEL.systemPrompt, tools: PANEL.tools, messages });
const turn = (n) => [
	{ role: "user", content: `question ${n}`, timestamp: n * 10 },
	{ role: "assistant", content: [{ type: "text", text: words(12_000) }], api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "stop", timestamp: n * 10 + 1 },
];
const withResult = (text) => [
	{ role: "user", content: "read the book", timestamp: 1 },
	{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "extract_document", arguments: { url: "https://x.test/b.pdf" } }], api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "toolUse", timestamp: 2 },
	{ role: "toolResult", toolCallId: "c1", toolName: "extract_document", content: [{ type: "text", text }], isError: false, timestamp: 3 },
	{ role: "user", content: "continue", timestamp: 4 },
];

test("first-F2: a 16k model with the real panel prompt and tools chats, with a smaller reply", async () => {
	resetLearnedWindows();
	const model = { id: "local16", provider: "ollama", contextWindow: 16_384, maxTokens: 16_384 };
	const context = panel(withResult(words(700_000)));
	const fixed = estimateFixedTokens(context);
	assert.ok(fixed > 13_000, `fixed ${fixed}`);
	const { inner, sent, options } = provider(16_384);
	const last = await finalOf(await guardContext(inner)(model, context, {}));
	assert.equal(last.type, "done", last.error?.errorMessage);
	assert.equal(sent.length, 1);
	assert.ok(options[0].maxTokens >= 1024 && options[0].maxTokens < 4096, `reply ${options[0].maxTokens}`);
	assert.ok(estimateContextTokens(sent[0]) + options[0].maxTokens <= 16_384);
});

test("sol-sol-N1: a 32k model with six long earlier replies fits by cutting them, and nothing over budget is sent", async () => {
	resetLearnedWindows();
	const model = { id: "m32", provider: "p", contextWindow: 32_000, maxTokens: 8192 };
	const messages = [...[1, 2, 3, 4, 5, 6].flatMap(turn), { role: "user", content: "and now?", timestamp: 100 }];
	const context = panel(messages);
	const budget = budgetFor(model, undefined, undefined, estimateFixedTokens(context));
	assert.ok(estimateContextTokens(context) > budget.inputTokens, "the replies alone are over");
	const { inner, sent, options } = provider(32_000);
	const last = await finalOf(await guardContext(inner)(model, context, {}));
	assert.equal(last.type, "done");
	assert.ok(estimateContextTokens(sent[0]) <= budget.inputTokens);
	assert.ok(estimateContextTokens(sent[0]) + options[0].maxTokens <= 32_000);
	assert.equal(sent[0].messages.at(-1).content, "and now?");
});

test("first-F1: the retry ceiling is never below the fixed part, and what is learned keeps the model usable", async () => {
	resetLearnedWindows();
	// Claims 131k; refuses anything over 28,000 with words.
	const model = { id: "claims", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const context = panel(withResult(words(700_000)));
	const fixed = estimateFixedTokens(context);
	const { inner, sent } = provider(28_000);
	const guarded = guardContext(inner);
	await finalOf(await guarded(model, context, {}));
	assert.ok(sent.length >= 1);
	for (const s of sent) assert.equal(estimateFixedTokens(s), fixed, "every request carries the whole fixed part");
	assert.ok(learnedWindow(model) >= minimumWindow(fixed), `learned ${learnedWindow(model)}, needs ${minimumWindow(fixed)}`);
	// The next turns send and are answered: the model is not locked out by what was learned.
	let answered = false;
	for (let i = 0; i < 4 && !answered; i++) answered = (await finalOf(await guarded(model, context, {}))).type === "done";
	assert.ok(answered, `learned ${learnedWindow(model)}`);
});

test("sol-sol-N2: claims 131k, takes 32k: an explicit refusal is learned as a window that still carries the fixed part", async () => {
	resetLearnedWindows();
	const model = { id: "n2", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const context = panel(withResult(words(700_000)));
	const fixed = estimateFixedTokens(context);
	const { inner, sent } = provider(32_000);
	const guarded = guardContext(inner);
	const first = await finalOf(await guarded(model, context, {}));
	const learned = learnedWindow(model);
	assert.ok(learned >= minimumWindow(fixed), `learned ${learned}`);
	// The next turn is not refused locally: it is sent, within the learned window, and answered.
	const before = sent.length;
	const next = await finalOf(await guarded(model, context, {}));
	assert.ok(sent.length > before, "the next turn is sent");
	assert.ok(first.type === "done" || next.type === "done");
	assert.equal(next.type, "done", next.error?.errorMessage);
});

test("a learned window is cleared when a later turn works at a larger size", async () => {
	resetLearnedWindows();
	const model = { id: "probe", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const context = panel(withResult(words(700_000)));
	let limit = 32_000;
	const sent = [];
	const inner = async (m, c, o) => {
		sent.push(estimateContextTokens(c) + o.maxTokens);
		return provider(limit).inner(m, c, o);
	};
	const guarded = guardContext(inner);
	await finalOf(await guarded(model, context, {}));
	assert.ok(learnedWindow(model));
	// The provider is fixed; after enough good turns the guard tries the full window, which works, and forgets.
	limit = 131_072;
	for (let i = 0; i <= PROBE_AFTER_TURNS + 1; i++) await finalOf(await guarded(model, context, {}));
	assert.equal(learnedWindow(model), undefined);
	assert.ok(sent.at(-1) > 32_000, `last request ${sent.at(-1)}`);
});

// ---- mediums and lows in the guard -----------------------------------------------------------

test("first-F3: a 200 KB artifact in an earlier tool call's arguments gives way; the call keeps its id and result", () => {
	const model = { id: "a", provider: "p", contextWindow: 32_000, maxTokens: 8192 };
	const messages = [
		{ role: "user", content: "make a page", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "art", name: "artifacts", arguments: { command: "create", content: `<html>${words(200_000)}</html>` } }], api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "toolUse", timestamp: 2 },
		{ role: "toolResult", toolCallId: "art", toolName: "artifacts", content: [{ type: "text", text: "created" }], isError: false, timestamp: 3 },
		{ role: "user", content: "thanks, now change the title", timestamp: 4 },
	];
	const context = panel(messages);
	const budget = budgetFor(model, undefined, undefined, estimateFixedTokens(context));
	const fitted = fitContext(context, budget);
	assert.ok(fitted.fits && fitted.estimate <= budget.inputTokens);
	const call = fitted.context.messages.find((m) => m.role === "assistant").content[0];
	assert.equal(call.id, "art");
	assert.match(call.arguments.left_out, /Polycarp left out these arguments \([\d,]+ characters\)/);
	assert.ok(pairsIntact(fitted.context.messages));
	assert.equal(messages[1].content[0].arguments.command, "create", "stored history untouched");
});

test("second-N2: twelve images in one user message, with no document, give way so the request fits", () => {
	const model = { id: "i", provider: "p", contextWindow: 32_000, maxTokens: 8192 };
	const messages = [
		{ role: "user", content: [{ type: "text", text: "compare these" }, ...Array.from({ length: 12 }, () => IMAGE)], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "They differ in color." }], api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "stop", timestamp: 2 },
		{ role: "user", content: "which is brightest?", timestamp: 3 },
	];
	const context = panel(messages);
	const budget = budgetFor(model, undefined, undefined, estimateFixedTokens(context));
	assert.ok(estimateContextTokens(context) > budget.inputTokens);
	const fitted = fitContext(context, budget);
	assert.ok(fitted.fits && fitted.estimate <= budget.inputTokens);
	assert.equal(fitted.context.messages.at(-1).content, "which is brightest?");
	assert.equal(messages[0].content.filter((p) => p.type === "image").length, 12, "stored history untouched");
});

test("second-N2: twelve images in the latest user message give way last, after everything else, so the request fits", () => {
	const model = { id: "i", provider: "p", contextWindow: 32_000, maxTokens: 8192 };
	const messages = [{ role: "user", content: [{ type: "text", text: "compare these" }, ...Array.from({ length: 12 }, () => IMAGE)], timestamp: 1 }];
	const context = panel(messages);
	const budget = budgetFor(model, undefined, undefined, estimateFixedTokens(context));
	assert.ok(estimateContextTokens(context) > budget.inputTokens);
	const fitted = fitContext(context, budget);
	assert.ok(fitted.fits && fitted.estimate <= budget.inputTokens);
	assert.equal(fitted.context.messages[0].content[0].text, "compare these");
});

test("the newest tool call's own thinking gives way when nothing else is left, with its id and result kept", () => {
	const model = { id: "t", provider: "p", contextWindow: 16_384, maxTokens: 8192 };
	const messages = [
		{ role: "user", content: "go", timestamp: 1 },
		{ role: "assistant", content: [{ type: "thinking", thinking: words(20_000) }, { type: "toolCall", id: "n1", name: "navigate", arguments: { url: "https://example.com/" } }], api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "toolUse", timestamp: 2 },
		{ role: "toolResult", toolCallId: "n1", toolName: "navigate", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
	];
	const context = { systemPrompt: fixedPrompt(5000), tools: [], messages };
	const budget = budgetFor(model, 8192, undefined, estimateFixedTokens(context));
	const fitted = fitContext(context, budget);
	assert.ok(fitted.fits && fitted.estimate <= budget.inputTokens, `${fitted.estimate} of ${budget.inputTokens}`);
	assert.ok(pairsIntact(fitted.context.messages));
	assert.equal(fitted.context.messages[1].content.find((p) => p.type === "toolCall").id, "n1");
});

test("first-F4: two cured refusals with a good turn between them are not two strikes", async () => {
	resetLearnedWindows();
	const model = { id: "f4", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const big = panel(withResult(words(700_000)));
	const small = panel([{ role: "user", content: "hi", timestamp: 1 }]);
	// Refuses big requests with a bare 400 (a transient fault, or size: once can't tell).
	const { inner, sent } = provider(36_000, BARE);
	const guarded = guardContext(inner);
	assert.equal((await finalOf(await guarded(model, big, {}))).type, "done", "the retry cured it");
	assert.equal(sent.length, 2);
	assert.equal(learnedWindow(model), undefined, "one refusal is not proof");
	assert.equal((await finalOf(await guarded(model, small, {}))).type, "done");
	await finalOf(await guarded(model, big, {}));
	assert.equal(learnedWindow(model), undefined, "not in a row, so still not proof");
	// Two in a row are.
	await finalOf(await guarded(model, big, {}));
	assert.ok(learnedWindow(model));
});

const parallel = (n) => [
	{ role: "user", content: "open them all", timestamp: 1 },
	{ role: "assistant", content: Array.from({ length: n }, (_, k) => ({ type: "toolCall", id: `p${k}`, name: "navigate", arguments: { url: `https://example.com/${k}` } })), api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "toolUse", timestamp: 2 },
	...Array.from({ length: n }, (_, k) => ({ role: "toolResult", toolCallId: `p${k}`, toolName: "navigate", content: [{ type: "text", text: words(3000) }], isError: false, timestamp: 3 + k })),
];

test("first-F1: on a 16k model that takes 15,600, the retry is cut from the conversation, not the fixed part, and is answered", async () => {
	resetLearnedWindows();
	const model = { id: "f1small", provider: "p", contextWindow: 16_384, maxTokens: 8192 };
	const context = panel([...[1, 2, 3].flatMap(turn), { role: "user", content: "and now?", timestamp: 100 }]);
	const fixed = estimateFixedTokens(context);
	const { inner, sent } = provider(15_600);
	const last = await finalOf(await guardContext(inner)(model, context, {}));
	assert.equal(last.type, "done", last.error?.errorMessage);
	assert.equal(sent.length, 2, "one retry");
	assert.equal(estimateFixedTokens(sent[1]), fixed);
});

test("a turn that can't fit even cut to its least is not sent: the person reads why", async () => {
	resetLearnedWindows();
	const model = { id: "wide", provider: "p", contextWindow: 16_384, maxTokens: 8192 };
	const { inner, sent } = provider(16_384);
	const last = await finalOf(await guardContext(inner)(model, panel(parallel(70)), {}));
	assert.equal(sent.length, 0);
	assert.match(last.error.errorMessage, /This turn is too large for the model's context window/);
});

test("a size refusal that leaves no smaller request is learned, so the next turn is not sent to be refused again", async () => {
	resetLearnedWindows();
	const model = { id: "noretry", provider: "p", contextWindow: 32_000, maxTokens: 8192 };
	const context = panel(parallel(70));
	const { inner, sent } = provider(16_384);
	const guarded = guardContext(inner);
	const first = await finalOf(await guarded(model, context, {}));
	assert.equal(sent.length, 1, "no retry that can't be smaller");
	assert.match(first.error.errorMessage, /This chat is too long for the model/);
	assert.ok(learnedWindow(model) < 32_000);
	const next = await finalOf(await guarded(model, context, {}));
	assert.equal(sent.length, 1, "the next turn is refused here, not by the provider");
	assert.match(next.error.errorMessage, /This turn is too large/);
});
