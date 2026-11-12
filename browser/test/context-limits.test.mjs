// Tool results bounded by the model's window, and requests fitted before they are sent. The report: a 400-page PDF
// read with extract_document({url}) came back as 706,000 characters, the next request was refused with
// "400 status code (no body)", and "continue" resent the same history, so the chat was dead for good.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

const { budgetFor, capText, estimateContextTokens, fitContext, isSizeRefusal, toolResultBudgetChars } = await import(
	"../src/models/context-budget.ts"
);
const { guardContext, resetLearnedWindows } = await import("../src/models/context-guard.ts");
const { createExtractDocumentTool, clearDocumentCache } = await import("../src/tools/extract-document.ts");
const { parseExtracted } = await import("../src/tools/document-reader.ts");
const { isPdfPageJump } = await import("../src/browser/page.ts");

const SMALL = { id: "qwen-3.8-27b", provider: "cerebras", contextWindow: 8192, maxTokens: 2048 };

// ---- fixtures --------------------------------------------------------------------------------

/** A book in pi-web-ui's PDF text format: `<page number="N">` per page, about 1,800 characters each. */
function book(pageCount = 400, special = {}) {
	const filler = (n) =>
		`Book ${Math.ceil(n / 40)}, page ${n}. Every art and every inquiry, and similarly every action and pursuit, is thought to aim at some good; and for this reason the good has rightly been declared to be that at which all things aim. `.repeat(9);
	let out = '<pdf filename="ethics.pdf">';
	for (let n = 1; n <= pageCount; n++) out += `\n<page number="${n}">\n${special[n] ?? filler(n)}\n</page>`;
	return `${out}\n</pdf>`;
}

const CONTEMPLATION =
	"But the wise man, even when by himself, can contemplate truth, and the better the wiser he is. The activity of contemplation needs no external things; such things are, if anything, hindrances to contemplation.";
const DISTRACTORS = {
	12: "We call that which is pursued as an end in itself more final. Happiness needs external goods as well, for it is impossible to do noble acts without the proper equipment.",
	150: "Contemplation of the virtues of friends is pleasant. A man needs friends to share his good fortune.",
	287: CONTEMPLATION,
};

function toolWith(text, model = SMALL) {
	clearDocumentCache();
	let loads = 0;
	const tool = createExtractDocumentTool({
		budgetChars: () => toolResultBudgetChars(model),
		load: async () => {
			loads++;
			return { extractedText: text, fileName: "ethics.pdf", mimeType: "application/pdf", size: 3_200_000 };
		},
	});
	return { tool, loads: () => loads };
}

const resultText = (r) => r.content.map((c) => c.text).join("");
const URL_ = "https://archive.org/download/ethics/ethics.pdf";

// ---- extract_document ------------------------------------------------------------------------

test("the report: a 700,000 character book read with only a url fits the budget and says how to get the rest", async () => {
	const text = book(400, DISTRACTORS);
	assert.ok(text.length > 700_000, `fixture is ${text.length} characters`);
	const { tool } = toolWith(text);
	const out = resultText(await tool.execute("c1", { url: URL_ }));
	const budget = toolResultBudgetChars(SMALL);
	assert.ok(out.length <= budget, `answer is ${out.length} characters, budget ${budget}`);
	assert.match(out, /400 pages/);
	assert.match(out, /characters left out/);
	assert.match(out, /pages "\d+-\d+"/);
	assert.match(out, /query/);
	assert.match(out, /--- Page 1 of 400 ---/);
});

test("query finds the page that holds the passage, ranked first, with its number and a snippet", async () => {
	const { tool, loads } = toolWith(book(400, DISTRACTORS));
	const out = resultText(
		await tool.execute("c1", { url: `${URL_}#page=3`, query: "contemplation doesn't require external things" }),
	);
	const first = /^1\. Page (\d+): (.*)$/m.exec(out);
	assert.ok(first, out);
	assert.equal(first[1], "287");
	assert.match(first[2], /needs no external things/);
	assert.match(out, /#page=287/, "says how to open the viewer at the page");
	assert.ok(out.length <= toolResultBudgetChars(SMALL));
	// A second call on the same document (the viewer's #page is not part of it) is not downloaded again.
	await tool.execute("c2", { url: URL_, pages: "287" });
	assert.equal(loads(), 1);
});

test("pages returns exactly that range", async () => {
	const { tool } = toolWith(book(400), { ...SMALL, contextWindow: 200_000 });
	const out = resultText(await tool.execute("c1", { url: URL_, pages: "40-55" }));
	const shown = [...out.matchAll(/--- Page (\d+) of 400 ---/g)].map((m) => Number(m[1]));
	assert.deepEqual(
		shown,
		Array.from({ length: 16 }, (_, i) => 40 + i),
	);
	assert.doesNotMatch(out, /Cut here/);
});

test("a range over the budget is cut with the exact next call, and offset continues it", async () => {
	const { tool } = toolWith(book(400));
	const first = resultText(await tool.execute("c1", { url: URL_, pages: "40-55" }));
	assert.ok(first.length <= toolResultBudgetChars(SMALL));
	const next = /pages "40-55" and offset (\d+)/.exec(first);
	assert.ok(next, first.slice(-400));
	const second = resultText(await tool.execute("c2", { url: URL_, pages: "40-55", offset: Number(next[1]) }));
	assert.match(second, /from character/);
	assert.ok(second.length <= toolResultBudgetChars(SMALL));
});

test("a bad range is refused with the form it takes", async () => {
	const { tool } = toolWith(book(10));
	await assert.rejects(tool.execute("c1", { url: URL_, pages: "the middle" }), /like "12" or "40-55"/);
});

test("DOCX reads in parts, XLSX by sheet and PPTX by slide, with the same budget", () => {
	const docx = parseExtracted(`<docx filename="a.docx">\n<page number="1">\n${"Paragraph of text. ".repeat(2000)}\n</page>\n</docx>`, "docx");
	assert.equal(docx.kind, "part");
	assert.ok(docx.units.length >= 10);
	assert.ok(docx.units.every((u) => u.text.length <= 4000));
	const xlsx = parseExtracted('<excel filename="b.xlsx">\n<sheet name="Q1 &amp; Q2" index="1">\na,b\n1,2\n</sheet>\n<sheet name="Notes" index="2">\nx\n</sheet>\n</excel>', "xlsx");
	assert.equal(xlsx.kind, "sheet");
	assert.deepEqual(xlsx.units.map((u) => u.name), ["Q1 & Q2", "Notes"]);
	const pptx = parseExtracted('<pptx filename="c.pptx">\n<slide number="1">\nTitle\n</slide>\n<slide number="3">\nEnd\n</slide>\n</pptx>', "pptx");
	assert.equal(pptx.kind, "slide");
	assert.deepEqual(pptx.units.map((u) => u.n), [1, 3]);
});

// ---- the guard -------------------------------------------------------------------------------

function history(resultText) {
	return {
		systemPrompt: "You are Polycarp.",
		tools: [{ name: "extract_document", description: "Read a document", parameters: { type: "object" } }],
		messages: [
			{ role: "user", content: "Go to the page where he says contemplation doesn't require external things", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "extract_document", arguments: { url: URL_ } }],
				api: "openai-completions",
				provider: "cerebras",
				model: "qwen-3.8-27b",
				usage: {},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "extract_document",
				content: [{ type: "text", text: resultText }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "continue", timestamp: 4 },
		],
	};
}

function pairsIntact(messages) {
	const calls = messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id) : []));
	const results = messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
	return JSON.stringify(calls) === JSON.stringify(results);
}

test("a history holding a 700,000 character tool result is shrunk to fit before the request, pairs intact", () => {
	const big = book(400);
	const context = history(big);
	const budget = budgetFor(SMALL);
	assert.ok(estimateContextTokens(context) > budget.inputTokens);
	const fitted = fitContext(context, budget);
	assert.ok(fitted.trimmed);
	assert.ok(!fitted.over, `estimate ${fitted.estimate} over ${budget.inputTokens}`);
	assert.ok(estimateContextTokens(fitted.context) <= budget.inputTokens);
	assert.equal(fitted.context.messages.length, context.messages.length);
	assert.ok(pairsIntact(fitted.context.messages));
	for (const i of [0, 3]) assert.equal(fitted.context.messages[i], context.messages[i], "user messages go as they are");
	const cut = fitted.context.messages[2].content[0].text;
	assert.match(cut, /Polycarp left out [\d,]+ of [\d,]+ characters/);
	assert.match(cut, /pages \(like "40-55"\) or query/);
	// Stored history is untouched.
	assert.equal(context.messages[2].content[0].text, big);
});

test("a history that already fits is sent unchanged, byte for byte", () => {
	const context = history("Page 287: the activity of contemplation needs no external things.");
	const before = JSON.stringify(context);
	const fitted = fitContext(context, budgetFor(SMALL));
	assert.equal(fitted.context, context);
	assert.equal(fitted.trimmed, false);
	assert.equal(JSON.stringify(fitted.context), before);
});

test("older tool results give way before the latest one", () => {
	const context = history("x".repeat(20_000));
	for (const id of ["call_2", "call_3", "call_4"])
		context.messages.push(
			{ role: "assistant", content: [{ type: "toolCall", id, name: "navigate", arguments: {} }], timestamp: 5 },
			{ role: "toolResult", toolCallId: id, toolName: "navigate", content: [{ type: "text", text: "y".repeat(20_000) }], isError: false, timestamp: 6 },
		);
	const budget = budgetFor(SMALL);
	const fitted = fitContext(context, budget);
	const lengths = fitted.context.messages.filter((m) => m.role === "toolResult").map((m) => m.content[0].text.length);
	// Oldest first: lengths never grow from the latest back to the oldest, and the oldest gave way.
	assert.ok(lengths.every((n, i) => i === 0 || lengths[i - 1] <= n), `lengths ${lengths}`);
	assert.ok(lengths[0] < lengths.at(-1), `lengths ${lengths}`);
	assert.ok(!fitted.over);
	assert.ok(pairsIntact(fitted.context.messages));
});

test("capText keeps the head and the tail and says what was dropped", () => {
	const text = `${"A".repeat(5000)}${"B".repeat(5000)}`;
	const cut = capText(text, 2000, "Ask for less.");
	assert.ok(cut.length <= 2000);
	assert.ok(cut.startsWith("A"));
	assert.ok(cut.endsWith("B"));
	assert.match(cut, /left out [\d,]+ of 10,000 characters here to fit the model's context\. Ask for less\./);
	assert.equal(capText("short", 2000), "short");
});

// ---- size refusals ---------------------------------------------------------------------------

test("a size refusal is recognized; a bare 400 only near the window; another 400 never", () => {
	assert.ok(isSizeRefusal("This model's maximum context length is 32768 tokens", 1000, 32768));
	assert.ok(isSizeRefusal("413 status code (no body)", 1000, 32768));
	assert.ok(isSizeRefusal("400 status code (no body)", 30000, 32768));
	assert.ok(!isSizeRefusal("400 status code (no body)", 2000, 32768));
	assert.ok(!isSizeRefusal("400 Invalid schema for function 'navigate'", 30000, 32768));
});

function stub(behavior) {
	const sent = [];
	const inner = async (model, context) => {
		sent.push(context);
		const s = createAssistantMessageEventStream();
		const reply = behavior(context, sent.length);
		queueMicrotask(() => {
			if (reply.error) {
				s.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: reply.error, timestamp: 0 } });
			} else {
				const message = { role: "assistant", content: [{ type: "text", text: reply.text }], stopReason: "stop", timestamp: 0 };
				s.push({ type: "start", partial: message });
				s.push({ type: "done", reason: "stop", message });
			}
			s.end();
		});
		return s;
	};
	return { inner, sent };
}

async function finalOf(stream) {
	const events = [];
	for await (const e of stream) events.push(e);
	return events.at(-1);
}

test("the dead thread heals: 'continue' after a 700,000 character result is fitted to the window and answered", async () => {
	resetLearnedWindows();
	const { inner, sent } = stub((context) =>
		estimateContextTokens(context) > SMALL.contextWindow ? { error: "400 status code (no body)" } : { text: "Page 287." },
	);
	const last = await finalOf(await guardContext(inner)(SMALL, history(book(400)), {}));
	assert.equal(last.type, "done");
	assert.equal(sent.length, 1, "fitted before the first request");
	assert.ok(pairsIntact(sent[0].messages));
});

test("when the provider takes less than the window its model list claims, a bare 400 is retried once, cut harder", async () => {
	resetLearnedWindows();
	// Listed at 131,072 tokens; the provider refuses anything over 20,000 bytes with a bare 400.
	const CLAIMS = { id: "qwen-3.8-27b", provider: "cerebras", contextWindow: 131_072, maxTokens: 8192 };
	const LIMIT = 20_000;
	const { inner, sent } = stub((context) =>
		JSON.stringify(context).length > LIMIT ? { error: "400 status code (no body)" } : { text: "Page 287." },
	);
	const guarded = guardContext(inner);
	const last = await finalOf(await guarded(CLAIMS, history(book(400)), {}));
	assert.equal(last.type, "done", JSON.stringify(last).slice(0, 300));
	assert.equal(sent.length, 2, "one refusal, one retry");
	assert.ok(JSON.stringify(sent[1]).length <= LIMIT);
	assert.ok(pairsIntact(sent[1].messages));
	// The next turn starts at the size that worked.
	await finalOf(await guarded(CLAIMS, history(book(400)), {}));
	assert.equal(sent.length, 3);
});

test("a refusal that survives the retry reads as a plain sentence, not '400 status code (no body)'", async () => {
	resetLearnedWindows();
	const { inner, sent } = stub(() => ({ error: "400 status code (no body)" }));
	const last = await finalOf(await guardContext(inner)(SMALL, history(book(400)), {}));
	assert.equal(last.type, "error");
	assert.equal(sent.length, 2);
	assert.match(last.error.errorMessage, /^This chat is too long for the model\. Polycarp cut older tool results/);
	assert.match(last.error.errorMessage, /tried again/);
});

test("an unrelated 400 keeps its own message and is not retried", async () => {
	resetLearnedWindows();
	const message = "400 Invalid schema for function 'navigate': 'url' is not of type 'string'";
	const { inner, sent } = stub(() => ({ error: message }));
	const last = await finalOf(await guardContext(inner)(SMALL, history(book(400)), {}));
	assert.equal(last.error.errorMessage, message);
	assert.equal(sent.length, 1);
	// And a bare 400 on a small request is not blamed on size.
	const small = stub(() => ({ error: "400 status code (no body)" }));
	const tiny = await finalOf(await guardContext(small.inner)(SMALL, history("short"), {}));
	assert.equal(tiny.error.errorMessage, "400 status code (no body)");
	assert.equal(small.sent.length, 1);
});

test("a request that fits is passed to the provider as the same object", async () => {
	resetLearnedWindows();
	const { inner, sent } = stub(() => ({ text: "ok" }));
	const context = history("short");
	await finalOf(await guardContext(inner)(SMALL, context, {}));
	assert.equal(sent[0], context);
});

// ---- going to the page -----------------------------------------------------------------------

test("a #page change on the PDF a tab shows reloads; anything else navigates as usual", () => {
	const pdf = "https://archive.org/download/ethics/ethics.pdf";
	assert.ok(isPdfPageJump(pdf, `${pdf}#page=287`));
	assert.ok(isPdfPageJump(`${pdf}#page=3`, `${pdf}#page=287`));
	assert.ok(!isPdfPageJump(`${pdf}#page=287`, `${pdf}#page=287`));
	assert.ok(!isPdfPageJump(pdf, "https://archive.org/other.pdf#page=2"));
	assert.ok(!isPdfPageJump("https://example.com/app", "https://example.com/app#section"));
	assert.ok(!isPdfPageJump(undefined, `${pdf}#page=2`));
});
