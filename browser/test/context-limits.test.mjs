// Tool results bounded by the model's window, and requests fitted before they are sent. The report: a 400-page PDF
// read with extract_document({url}) came back as 706,000 characters, the next request was refused with
// "400 status code (no body)", and "continue" resent the same history, so the chat was dead for good.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

const {
	budgetFor,
	capText,
	estimateContextTokens,
	estimateTextTokens,
	fitContext,
	isSizeRefusal,
	resultTokensFor,
	sizeEvidence,
	toolResultBudgetChars,
} = await import("../src/models/context-budget.ts");
const { guardContext, resetLearnedWindows, toolBudgetChars } = await import("../src/models/context-guard.ts");
const { attachedText, ATTACHMENT_INLINE_CHARS, browserMessageTransformer } = await import(
	"../src/messages/message-transformer.ts"
);
const prompts = await import("../src/prompts/prompts.ts");
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
	assert.ok(estimateContextTokens(fitted.context) <= budget.inputTokens, `estimate ${fitted.estimate} over ${budget.inputTokens}`);
	assert.equal(fitted.context.messages.length, context.messages.length);
	assert.ok(pairsIntact(fitted.context.messages));
	for (const i of [0, 3]) assert.equal(fitted.context.messages[i], context.messages[i], "user messages go as they are");
	const cut = fitted.context.messages[2].content[0].text;
	assert.match(cut, /\[Polycarp cut this here to fit the model's context: [\d,]+ of [\d,]+ characters after this point were not sent\./);
	assert.match(cut, /fewer pages \(like "40-42"\) or a query/);
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
	assert.ok(fitted.estimate <= budget.inputTokens);
	assert.ok(pairsIntact(fitted.context.messages));
});

test("capText keeps the head only, so a tool's own read-on note is never kept pointing past what was dropped", () => {
	const text = `${"A".repeat(5000)}${"B".repeat(5000)}\n[For the rest, call again with offset 10000.]`;
	const cut = capText(text, 2000, "Ask for less.");
	assert.ok(cut.length <= 2000);
	assert.ok(cut.startsWith("A"));
	assert.doesNotMatch(cut, /B|offset 10000/);
	assert.match(cut, /\[Polycarp cut this here to fit the model's context: [\d,]+ of 10,04\d characters after this point were not sent\. Ask for less\.\]$/);
	assert.equal(capText("short", 2000), "short");
});

// ---- every block, every path -----------------------------------------------------------------

const toolResult = (content, toolName = "repl") => ({
	role: "toolResult",
	toolCallId: "call_1",
	toolName,
	content,
	isError: false,
	timestamp: 3,
});
const withMessage = (message, extra = []) => ({
	systemPrompt: "You are Polycarp.",
	tools: [],
	messages: [
		{ role: "user", content: "Read it", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "repl", arguments: {} }], timestamp: 2 },
		message,
		...extra,
	],
});

test("sol-F1: one result of 1,000 blocks of 350 characters is held to one budget in all, on an 8k model", () => {
	const blocks = Array.from({ length: 1000 }, (_, i) => ({ type: "text", text: `block ${i} ${"word ".repeat(68)}` }));
	assert.ok(blocks.every((b) => b.text.length <= 350));
	const context = withMessage(toolResult(blocks));
	const budget = budgetFor(SMALL);
	const fitted = fitContext(context, budget);
	const sent = fitted.context.messages[2].content;
	const tokens = sent.reduce((n, p) => n + estimateTextTokens(p.text), 0);
	// The whole result, every block together, within the per-result budget (the note adds a line).
	assert.ok(tokens <= fitted.resultTokens + 100, `result is ${tokens} tokens, budget ${fitted.resultTokens}`);
	assert.ok(estimateContextTokens(fitted.context) <= budget.inputTokens);
	assert.match(sent.at(-1).text, /Polycarp left out \d+ more of the 1000 text parts/);
	assert.equal(sent[0].text, blocks[0].text, "the first blocks go whole");
});

test("second-N1: a 700,000 character attachment goes to the model as a note and its start, and reads in parts", async () => {
	const text = book(400, DISTRACTORS);
	const inline = attachedText({ fileName: "ethics.pdf", extractedText: text });
	assert.ok(inline.length < 3000, `inline attachment is ${inline.length} characters`);
	assert.match(inline, /^\n\n\[Document: ethics\.pdf\]/, "keeps the mark the guard knows attachments by");
	assert.match(inline, /extract_document \{"attachment": "ethics\.pdf"\}/);
	// A short file still goes whole.
	const short = "A short note.";
	assert.equal(attachedText({ fileName: "n.txt", extractedText: short }), `\n\n[Document: n.txt]\n${short}`);
	assert.ok(ATTACHMENT_INLINE_CHARS <= toolResultBudgetChars({ contextWindow: 32000 }) * 2);
	// The tool reads the attached file by name, within the budget, with no download.
	clearDocumentCache();
	const tool = createExtractDocumentTool({
		budgetChars: () => toolResultBudgetChars(SMALL),
		attachments: () => [{ extractedText: text, fileName: "ethics.pdf", mimeType: "application/pdf", size: 3_200_000 }],
		load: async () => assert.fail("an attachment is not downloaded"),
	});
	const out = resultText(await tool.execute("c1", { attachment: "ethics.pdf", query: "contemplation needs no external things" }));
	assert.ok(out.length <= toolResultBudgetChars(SMALL));
	assert.match(out, /Page 287/);
	const page = resultText(await tool.execute("c2", { attachment: "ethics", pages: "287" }));
	assert.match(page, /needs no external things/);
	await assert.rejects(tool.execute("c3", { attachment: "other.pdf" }), /ethics\.pdf/);
	await assert.rejects(tool.execute("c4", { attachment: "ethics.pdf", url: URL_ }), /one of them/);
});

test("second-N1: an attachment already inline in a stored user message is cut like a tool result; the typed words stay", () => {
	const typed = { type: "text", text: "Find where he says contemplation needs nothing external" };
	const message = { role: "user", content: [typed, { type: "text", text: `\n\n[Document: ethics.pdf]\n${book(400)}` }], timestamp: 4 };
	const context = withMessage(toolResult([{ type: "text", text: "ok" }]), [message]);
	const fitted = fitContext(context, budgetFor(SMALL));
	const sent = fitted.context.messages[3].content;
	assert.equal(sent[0], typed, "the person's words go whole");
	assert.ok(estimateTextTokens(sent[1].text) <= fitted.resultTokens + 100);
	assert.match(sent[1].text, /extract_document \{"attachment"/);
	assert.ok(estimateContextTokens(fitted.context) <= budgetFor(SMALL).inputTokens);
});

test("second-N1: a 700,000 character paste is cut last, but cut: the request still fits", () => {
	const paste = { role: "user", content: book(400), timestamp: 4 };
	const fitted = fitContext(withMessage(toolResult([{ type: "text", text: "ok" }]), [paste]), budgetFor(SMALL));
	assert.ok(estimateContextTokens(fitted.context) <= budgetFor(SMALL).inputTokens, `estimate ${fitted.estimate}`);
	assert.match(fitted.context.messages[3].content, /Ask the person for the part that matters/);
	assert.equal(fitted.context.messages[0].content, "Read it", "a short message is not cut");
});

test("second-N1: every path into a message, through the real transformer, is bounded: attachment, paste, navigation", async () => {
	const big = book(400);
	const stored = [
		{ role: "user-with-attachments", content: "Read the attached book", attachments: [{ id: "a1", type: "document", fileName: "ethics.pdf", mimeType: "application/pdf", size: 3_200_000, content: "", extractedText: big }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Done." }], api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "stop", timestamp: 2 },
		{ role: "navigation", url: "https://example.com/", title: "Example", tabId: 1, skillsOutput: big, timestamp: 3 },
		{ role: "user", content: big, timestamp: 4 },
	];
	const messages = await browserMessageTransformer(stored);
	const context = { systemPrompt: "You are Polycarp.", tools: [], messages };
	assert.ok(estimateContextTokens(context) > 600_000 / 3, "the paths carry the whole book before fitting");
	const budget = budgetFor(SMALL);
	const fitted = fitContext(context, budget);
	assert.ok(estimateContextTokens(fitted.context) <= budget.inputTokens, `estimate ${fitted.estimate} over ${budget.inputTokens}`);
	assert.equal(fitted.context.messages.length, messages.length);
});

test("first-F3: Chinese text and dense code count more tokens a character than English", () => {
	assert.equal(estimateTextTokens("日本語".repeat(1000)), 3000);
	assert.equal(estimateTextTokens("abc".repeat(1000)), 1000);
	assert.ok(estimateTextTokens("{a:[1,2]};".repeat(100)) >= 1000 / 3 * 1.3, "code counts more than chars/3");
	// A CJK result is held to the same tokens, so it keeps about a third of the characters an English one would.
	const fitted = fitContext(withMessage(toolResult([{ type: "text", text: "道".repeat(30_000) }])), budgetFor(SMALL));
	const kept = fitted.context.messages[2].content[0].text;
	assert.ok(estimateTextTokens(kept) <= fitted.resultTokens, `${estimateTextTokens(kept)} tokens`);
	assert.ok(kept.length < fitted.resultTokens * 1.2);
});

/** The panel's fixed text: its system prompt and the descriptions of its own tools (the panel sends more). */
function panelContext(messages) {
	const tools = Object.entries(prompts)
		.filter(([k, v]) => k !== "SYSTEM_PROMPT" && typeof v === "string")
		.map(([name, description]) => ({ name, description, parameters: { type: "object" } }));
	return { systemPrompt: prompts.SYSTEM_PROMPT, tools, messages };
}

test("second-N2: on an 8k model the real system prompt and tools leave no room, so nothing is sent and the error says why", async () => {
	resetLearnedWindows();
	const { inner, sent } = stub(() => ({ text: "never" }));
	const last = await finalOf(await guardContext(inner)(SMALL, panelContext([{ role: "user", content: "hi", timestamp: 1 }]), {}));
	assert.equal(sent.length, 0, "no request the provider must refuse");
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /context window \(8,192 tokens\) is too small for Polycarp: its instructions and tools alone take about [\d,]+ tokens/);
});

test("second-N2: on a 16k model the result budget comes from what the system prompt and tools leave", async () => {
	resetLearnedWindows();
	const MID = { id: "mid", provider: "local", contextWindow: 16_384, maxTokens: 16_384 };
	const context = panelContext(history(book(400)).messages);
	const budget = budgetFor(MID);
	const fitted = fitContext(context, budget);
	assert.ok(fitted.fixed > 6000, `fixed ${fitted.fixed}`);
	assert.ok(fitted.resultTokens < budget.toolResultTokens, "less than the window's share: the rest is taken");
	assert.equal(fitted.resultTokens, resultTokensFor(budget, fitted.fixed));
	assert.ok(fitted.estimate <= budget.inputTokens);
	const { inner, sent, options } = stub(() => ({ text: "ok" }));
	await finalOf(await guardContext(inner)(MID, context, {}));
	assert.equal(sent.length, 1);
	// A tool sizing its answer after this request gets the guard's own budget, so its answer is never cut again.
	assert.equal(toolBudgetChars(MID), fitted.resultTokens * 3);
	assert.ok(toolBudgetChars(MID) < toolResultBudgetChars(MID));
	// second-N3: the reply asked for is the one the budget kept room for, not the model's 16,384.
	assert.equal(options[0].maxTokens, budget.replyTokens);
	assert.ok(estimateContextTokens(sent[0]) + options[0].maxTokens <= MID.contextWindow);
});

test("second-N3: a stream that asks for more reply than the window allows is lowered to what was kept", async () => {
	resetLearnedWindows();
	const BIG_REPLY = { id: "r", provider: "local", contextWindow: 32_768, maxTokens: 32_768 };
	const { inner, options } = stub(() => ({ text: "ok" }));
	await finalOf(await guardContext(inner)(BIG_REPLY, history("short"), { maxTokens: 30_000 }));
	assert.equal(options[0].maxTokens, budgetFor(BIG_REPLY, undefined, 30_000).replyTokens);
	assert.ok(options[0].maxTokens <= 32_768 / 4);
	// A request for less than the reserve is left as it was.
	const small = stub(() => ({ text: "ok" }));
	const asked = { maxTokens: 2000 };
	await finalOf(await guardContext(small.inner)(BIG_REPLY, history("short"), asked));
	assert.equal(small.options[0], asked);
});

test("second-N4: extract_document's answer, sized by the guard's budget, reaches the model whole with its note", async () => {
	resetLearnedWindows();
	for (const text of [book(400), book(60, Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i + 1, "論語學而第一子曰學而時習之不亦說乎".repeat(60)])))]) {
		const { tool } = toolWith(text);
		const out = resultText(await tool.execute("c1", { url: URL_, pages: "10-30" }));
		assert.match(out, /offset \d+/, "names the call that reads on");
		const context = history(out);
		const fitted = fitContext(context, budgetFor(SMALL));
		assert.equal(fitted.context.messages[2].content[0].text, out, "not cut again");
	}
});

test("second-N4: on the tightest budget the answer still fits whole, its note included", async () => {
	// What a 16k model has left after the panel's own prompt and tools: the 500-token floor, 1,500 characters.
	clearDocumentCache();
	const tool = createExtractDocumentTool({
		budgetChars: () => 1500,
		load: async () => ({ extractedText: book(400), fileName: "ethics.pdf", mimeType: "application/pdf", size: 3_200_000 }),
	});
	const overview = resultText(await tool.execute("c1", { url: URL_ }));
	assert.ok(estimateTextTokens(overview) <= 500, `${estimateTextTokens(overview)} tokens`);
	assert.match(overview, /To find a passage, call it with query/);
	const range = resultText(await tool.execute("c2", { url: URL_, pages: "10-30" }));
	assert.ok(estimateTextTokens(range) <= 500, `${estimateTextTokens(range)} tokens`);
	assert.match(range, /pages "10-30" and offset \d+/);
});

test("first-F6 hint: a cut extract_document result says the page it stopped inside", () => {
	const pages = Array.from({ length: 50 }, (_, i) => `--- Page ${i + 1} of 50 ---\n${"text of the page ".repeat(100)}`).join("\n\n");
	const fitted = fitContext(history(pages), budgetFor(SMALL));
	const cut = fitted.context.messages[2].content[0].text;
	const seen = [...cut.matchAll(/--- Page (\d+) of 50 ---/g)].map((m) => m[1]).at(-1);
	assert.match(cut, new RegExp(`It stopped inside page ${seen}: call extract_document with pages starting at ${seen}`));
});

// ---- size refusals ---------------------------------------------------------------------------

test("a size refusal is recognized; a bare 400 only near the window; another 400 never", () => {
	assert.equal(sizeEvidence("400 status code (no body)", 30000, 32768), "likely");
	assert.equal(sizeEvidence("400 status code (no body)", 20000, 32768), "maybe");
	assert.equal(sizeEvidence("400 status code (no body)", 2000, 32768, 900_000), "maybe");
	assert.equal(sizeEvidence("prompt is too long", 10, 32768), "words");
	assert.ok(isSizeRefusal("This model's maximum context length is 32768 tokens", 1000, 32768));
	assert.ok(isSizeRefusal("413 status code (no body)", 1000, 32768));
	assert.ok(isSizeRefusal("400 status code (no body)", 30000, 32768));
	assert.ok(!isSizeRefusal("400 status code (no body)", 2000, 32768));
	assert.ok(!isSizeRefusal("400 Invalid schema for function 'navigate'", 30000, 32768));
});

function stub(behavior) {
	const sent = [];
	const options = [];
	const inner = async (model, context, opts) => {
		sent.push(context);
		options.push(opts);
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
	return { inner, sent, options };
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
	// first-F2: one bare 400 is not proof: the next turn tries the listed window again ...
	await finalOf(await guarded(CLAIMS, history(book(400)), {}));
	assert.equal(sent.length, 4, "refused and retried again");
	// ... and after the second, the size that worked is kept: the turn after starts there.
	await finalOf(await guarded(CLAIMS, history(book(400)), {}));
	assert.equal(sent.length, 5);
});

test("first-F2: a refusal that names size is learned the first time", async () => {
	resetLearnedWindows();
	const CLAIMS = { id: "w", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const { inner, sent } = stub((context) =>
		JSON.stringify(context).length > 20_000 ? { error: "This model's maximum context length is 6000 tokens" } : { text: "ok" },
	);
	const guarded = guardContext(inner);
	await finalOf(await guarded(CLAIMS, history(book(400)), {}));
	assert.equal(sent.length, 2);
	await finalOf(await guarded(CLAIMS, history(book(400)), {}));
	assert.equal(sent.length, 3);
});

test("first-F2: a bare 400 that survives the retry on a request well under the window is not blamed on length", async () => {
	resetLearnedWindows();
	const { inner, sent } = stub(() => ({ error: "400 status code (no body)" }));
	const last = await finalOf(await guardContext(inner)(SMALL, history(book(400)), {}));
	assert.equal(last.type, "error");
	assert.equal(sent.length, 2, "one retry, cut harder, since the uncut chat was over the window");
	assert.match(last.error.errorMessage, /^The provider refused this request \(400 status code \(no body\)\)/);
	assert.match(last.error.errorMessage, /It may not be the chat's length/);
	assert.doesNotMatch(last.error.errorMessage, /too long/);
});

test("a refusal that names size and survives the retry reads as a plain sentence about length", async () => {
	resetLearnedWindows();
	const { inner, sent } = stub(() => ({ error: "prompt is too long: 9000 tokens > 8192 maximum" }));
	const last = await finalOf(await guardContext(inner)(SMALL, history(book(400)), {}));
	assert.equal(sent.length, 2);
	assert.match(last.error.errorMessage, /^This chat is too long for the model \(cerebras said: prompt is too long/);
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
