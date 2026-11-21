// PR 143 review round 2, by finding: each test fails without its fix.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { streamSimple } from "@mariozechner/pi-ai";

const { budgetFor, CONTEXT_NOTE_MARK, estimateFixedTokens, fitContext, minimumWindow } = await import("../src/models/context-budget.ts");
const { withoutReplyCap } = await import("../src/models/context-guard.ts");

const words = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);
const A = (content, t) => ({ role: "assistant", content, api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "toolUse", timestamp: t });
const R = (id, content, t) => ({ role: "toolResult", toolCallId: id, toolName: "navigate", content, isError: false, timestamp: t });
const earlier = (n) => Array.from({ length: n }, (_, k) => [{ role: "user", content: `question ${k}`, timestamp: k * 10 }, A([{ type: "text", text: words(12_000) }], k * 10 + 1)]).flat();
const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));

test("sol-F1: CJK navigation notes cut to nothing at the smallest budgets never stand for the person", () => {
	const messages = [...earlier(6), { role: "user", content: "what does the page say?", timestamp: 100 }];
	for (let k = 1; k <= 12; k++)
		messages.push(A([{ type: "toolCall", id: `c${k}`, name: "navigate", arguments: { url: "https://x.test/" } }], 100 + 3 * k), R(`c${k}`, [{ type: "text", text: "done" }], 101 + 3 * k), {
			role: "user",
			content: `${CONTEXT_NOTE_MARK}\n✓ Navigation succeeded\n</browser-context>\n${"漢字".repeat(150)}`,
			timestamp: 102 + 3 * k,
		});
	const context = { systemPrompt: words(6000), tools: [], messages };
	const fixed = estimateFixedTokens(context);
	let bare = 0;
	for (let extra = 0; extra < 2000; extra += 25) {
		const sent = fitContext(context, budgetFor({ id: "m", provider: "p", contextWindow: 200_000, maxTokens: 8192 }, minimumWindow(fixed) + extra, undefined, fixed)).context.messages;
		const person = sent.find((m) => m.timestamp === 100);
		assert.ok(person, `window ${minimumWindow(fixed) + extra}: the question was dropped`);
		assert.ok(textOf(person).includes("what does the page say?"));
		bare += sent.filter((m) => m.timestamp > 100 && m.role === "user" && !textOf(m).startsWith(CONTEXT_NOTE_MARK)).length;
		// The line on what was left out goes on the person's message, never on a note.
		for (const m of sent) if (m.timestamp !== 100) assert.ok(!textOf(m).includes("earliest messages of this chat"), `window ${minimumWindow(fixed) + extra}`);
	}
	assert.ok(bare > 0, "some notes were cut to their notice alone");
});

test("second-S1, first-F2: the turn in progress gives way last: its screenshot and its call's arguments stay while earlier replies give way", () => {
	const image = { type: "image", data: "A".repeat(4000), mimeType: "image/png" };
	const html = `<html>${words(20_000)}</html>`;
	const messages = [
		...earlier(6),
		{ role: "user", content: "draw it", timestamp: 100 },
		A([{ type: "toolCall", id: "a", name: "artifacts", arguments: { command: "create", content: html } }], 101),
		R("a", [{ type: "text", text: "created" }], 102),
		A([{ type: "toolCall", id: "s", name: "act", arguments: { action: "screenshot" } }], 103),
		R("s", [{ type: "text", text: "screenshot" }, image], 104),
	];
	const fit = fitContext({ systemPrompt: words(6000), tools: [], messages }, budgetFor({ id: "m", provider: "p", contextWindow: 16_384, maxTokens: 8192 }));
	assert.ok(fit.fits && textOf(fit.context.messages[1]).length < 12_000, "earlier replies gave way");
	assert.ok(fit.context.messages.find((m) => m.timestamp === 104).content.includes(image), "the screenshot is sent");
	assert.equal(fit.context.messages.find((m) => m.timestamp === 101).content[0].arguments.content, html, "the call keeps its arguments");
});

test("first-F1: a custom provider's request goes with no max_tokens, through pi-ai's own payload; others keep it", async () => {
	const real = globalThis.fetch;
	let body;
	globalThis.fetch = async (_url, init) => {
		body = JSON.parse(init.body);
		return new Response("{}", { status: 400 });
	};
	try {
		const model = { id: "qwen", name: "q", api: "openai-completions", provider: "lmstudio", baseUrl: "http://127.0.0.1:9/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8192 };
		const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		for (const [options, cap] of [[{ apiKey: "k", maxTokens: 8192 }, 8192], [withoutReplyCap({ apiKey: "k", maxTokens: 8192 }), undefined]]) {
			body = undefined;
			for await (const _ of streamSimple(model, context, options));
			assert.ok(body, "the request was made");
			assert.equal(body.max_tokens ?? body.max_completion_tokens, cap);
		}
	} finally {
		globalThis.fetch = real;
	}
	// The panel sends custom providers (and only them) through it.
	assert.match(readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8"), /custom\.some\(\(p\) => p\.name === model\.provider\)\)\s+return inner\(model, rest\[0\], withoutReplyCap\(rest\[1\]\)\)/);
});
