// PR 143 review round 1, by finding: each test fails without its fix. The class findings (context notes, start then
// error, provider wording) are also in the grid of context-guard-property.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= ev();
chrome.webNavigation.onCommitted ??= ev();

const { budgetFor, CONTEXT_NOTE_MARK, estimateContextTokens, estimateFixedTokens, estimateTextTokens, fitContext, minimumWindow, sizeEvidence } =
	await import("../src/models/context-budget.ts");
const { guardContext, learnedWindow, PROBE_AFTER_TURNS, resetLearnedWindows } = await import("../src/models/context-guard.ts");
const { encodedHead, encodedLength, fitSlice, pdfWindow, sliceInfo } = await import("../src/bridge/paging.ts");
const { createPageTools } = await import("../src/tools/page-tools.ts");
const { handlers } = await import("../src/bridge/tools.ts");

const PANEL = JSON.parse(readFileSync(new URL("./fixtures/panel-request.json", import.meta.url), "utf8"));
const panel = (messages) => ({ systemPrompt: PANEL.systemPrompt, tools: PANEL.tools, messages });
const words = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);
const WORDS = "This model's maximum context length is exceeded";
const ok = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 0 };
const errorOf = (errorMessage) => ({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage, timestamp: 0 } });
const assistant = (content, t) => ({ role: "assistant", content, api: "openai-completions", provider: "p", model: "m", usage: {}, stopReason: "toolUse", timestamp: t });
const result = (id, toolName, text, t) => ({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError: false, timestamp: t });
const note = (t, extra = "") => ({ role: "user", content: `${CONTEXT_NOTE_MARK}\n✓ Navigation succeeded: X\n✓ URL: https://x.test/\n</browser-context>\n${extra}`, timestamp: t });

/** A provider: `script(size, n)` gives the events for the n-th request (0-based) of `size` tokens, reply included. */
function scripted(script) {
	const sent = [];
	const inner = async (_model, context, opts) => {
		const size = estimateContextTokens(context) + Number(opts?.maxTokens ?? 0);
		sent.push({ context, size });
		const s = createAssistantMessageEventStream();
		const events = script(size, sent.length - 1);
		queueMicrotask(() => {
			for (const e of events) s.push(e);
			s.end();
		});
		return s;
	};
	return { inner, sent };
}
const limited = (actual, startFirst = false) => (size) =>
	size > actual ? [...(startFirst ? [{ type: "start", partial: ok }] : []), errorOf(WORDS)] : [{ type: "start", partial: ok }, { type: "done", reason: "stop", message: ok }];

async function finalOf(stream) {
	let last;
	for await (const e of stream) last = e;
	return last;
}

// ---- first-F1: context notes are not the person ---------------------------------------------------------------

test("first-F1: a navigation note mid-turn is context; the person's question stays and is never cut or dropped", () => {
	// The reviewer's case: a 16k model, the person asks, the model navigates (a note follows the result), then reads.
	const model = { id: "n16", provider: "p", contextWindow: 16_384, maxTokens: 8192 };
	const question = "find the passage on contemplation in https://docs.test/ethics.pdf";
	const messages = [
		{ role: "user", content: "earlier question", timestamp: 1 },
		assistant([{ type: "text", text: words(9000) }], 2),
		{ role: "user", content: question, timestamp: 10 },
		assistant([{ type: "toolCall", id: "n1", name: "navigate", arguments: { url: "https://docs.test/ethics.pdf" } }], 11),
		result("n1", "navigate", "navigated", 12),
		note(13, words(6000)),
		assistant([{ type: "toolCall", id: "e1", name: "extract_document", arguments: { url: "https://docs.test/ethics.pdf" } }], 14),
		result("e1", "extract_document", words(40_000), 15),
	];
	const context = panel(messages);
	const fitted = fitContext(context, budgetFor(model, undefined, undefined, estimateFixedTokens(context)));
	assert.ok(fitted.fits);
	const sent = fitted.context.messages;
	const asked = sent.find((m) => m.timestamp === 10);
	assert.ok(asked, "the person's question is sent");
	assert.equal(asked.content, question, "and not cut");
	// The note gave way like a tool result, and the call it follows keeps its result.
	const kept = sent.find((m) => m.timestamp === 13);
	assert.ok(!kept || estimateTextTokens(kept.content) < 2100, "the note is cut as context");
	assert.ok(sent.some((m) => m.role === "toolResult" && m.toolCallId === "e1"));
});

test("first-F1: the panel's transformer writes the mark the guard reads", async () => {
	const { browserMessageTransformer } = await import("../src/messages/message-transformer.ts");
	const out = await browserMessageTransformer([{ role: "navigation", url: "https://x.test/", title: "X", tabId: 3, skillsOutput: "" }]);
	assert.ok(out[0].content.startsWith(CONTEXT_NOTE_MARK));
});

// ---- the guard: what counts as proof --------------------------------------------------------------------------

test("sol-F1: a learned window the fixed part has outgrown is dropped, and the model's own window is tried", async () => {
	resetLearnedWindows();
	const model = { id: "grew", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const small = { systemPrompt: words(3000), tools: [], messages: [{ role: "user", content: words(150_000), timestamp: 1 }] };
	const { inner, sent } = scripted(limited(20_000));
	const guarded = guardContext(inner);
	await finalOf(await guarded(model, small, {}));
	const learned = learnedWindow(model);
	assert.ok(learned && learned < 20_000, `learned ${learned}`);
	// The instructions grow past what the learned window can hold; the provider still takes 40,000.
	const grown = { systemPrompt: words(3 * (learned + 500)), tools: [], messages: [{ role: "user", content: "hi", timestamp: 2 }] };
	assert.ok(minimumWindow(estimateFixedTokens(grown)) > learned);
	const before = sent.length;
	const { inner: roomy } = scripted(limited(140_000));
	const last = await finalOf(await guardContext(async (m, c, o) => (sent.push(0), roomy(m, c, o)))(model, grown, {}));
	assert.equal(last.type, "done", last.error?.errorMessage);
	assert.ok(sent.length > before, "the request was sent, not refused here");
	assert.equal(learnedWindow(model), undefined);
});

test("second-S1: a size refusal after start still gets its retry; a reply that fails mid-stream is not a success", async () => {
	resetLearnedWindows();
	const model = { id: "s1", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const big = panel([{ role: "user", content: words(300_000), timestamp: 1 }]);
	const { inner, sent } = scripted(limited(80_000, true));
	const last = await finalOf(await guardContext(inner)(model, big, {}));
	assert.equal(sent.length, 2, "retried");
	assert.equal(last.type, "done", last.error?.errorMessage);
	assert.ok(learnedWindow(model), "the words were proof, so the size is learned");

	// A probe that starts and then fails is not a success: the learned window stays.
	resetLearnedWindows();
	const m2 = { id: "s1b", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	let phase = "learn";
	const flaky = scripted((size) => {
		if (phase === "learn") return limited(80_000)(size);
		return size > 80_000 ? [{ type: "start", partial: ok }, { type: "text_start", contentIndex: 0, partial: ok }, errorOf("overloaded")] : limited(80_000)(size);
	});
	const g = guardContext(flaky.inner);
	await finalOf(await g(m2, big, {}));
	const learned = learnedWindow(m2);
	assert.ok(learned);
	phase = "flaky";
	for (let i = 0; i <= PROBE_AFTER_TURNS; i++) await finalOf(await g(m2, big, {}));
	assert.equal(learnedWindow(m2), learned, "a probe that failed mid-stream did not clear what was learned");
});

test("second-S2: a refused probe falls back to the learned window and is answered; nothing learned rises", async () => {
	resetLearnedWindows();
	const model = { id: "s2", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const context = panel([{ role: "user", content: words(400_000), timestamp: 1 }]);
	const { inner, sent } = scripted(limited(30_000));
	const guarded = guardContext(inner);
	await finalOf(await guarded(model, context, {}));
	const learned = learnedWindow(model);
	assert.ok(learned && learned <= 30_000, `learned ${learned}`);
	for (let i = 0; i < PROBE_AFTER_TURNS; i++) assert.equal((await finalOf(await guarded(model, context, {}))).type, "done");
	const before = sent.length;
	const probe = await finalOf(await guarded(model, context, {}));
	assert.equal(sent.length - before, 2, "the probe and its fallback");
	assert.ok(sent.at(-2).size > learned, "the probe went past the learned window");
	assert.ok(sent.at(-1).size <= learned, "the fallback is the learned window");
	assert.equal(probe.type, "done", probe.error?.errorMessage);
	assert.equal(learnedWindow(model), learned, "kept as it was");
});

test("first-F4: an image or file limit is not a context refusal; the providers' context wordings still are", () => {
	for (const m of ["image too large", "Image exceeds maximum allowed size of 5 MB", "File too large (max 20 MB)", "400 Image dimensions exceed max allowed size: 8000 pixels"])
		assert.equal(sizeEvidence(m, 10, 32_768), undefined, m);
	for (const m of [
		"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
		"prompt is too long: 210000 tokens > 200000 maximum",
		"The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).",
		"Please reduce the length of the messages or completion.",
		"the request exceeds the available context size, try increasing it",
		"input length exceeds context length",
		"Request too large for gpt-4o on tokens per min",
		"413 Request Entity Too Large",
	])
		assert.equal(sizeEvidence(m, 10, 32_768), "words", m);
});

test("first-F5: a refused retry names the size that was actually sent", async () => {
	resetLearnedWindows();
	const model = { id: "f5", provider: "p", contextWindow: 131_072, maxTokens: 8192 };
	const { inner, sent } = scripted(() => [errorOf(WORDS)]);
	const last = await finalOf(await guardContext(inner)(model, panel([{ role: "user", content: words(400_000), timestamp: 1 }]), {}));
	assert.equal(sent.length, 2);
	const n = Number(/about ([\d,]+) tokens/.exec(last.error.errorMessage)?.[1].replaceAll(",", ""));
	assert.equal(n, estimateContextTokens(sent[1].context), last.error.errorMessage);
});

test("second-S3: no provider is told to leave out the reply the guard reserved", () => {
	const source = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /omitMaxTokens\s*:\s*true/);
});

// ---- one unit: what is sent, in the unit of its limit ---------------------------------------------------------

test("encodedHead: measures as JSON writes it, and never splits a surrogate pair", () => {
	assert.equal(encodedHead('"'.repeat(100), 100).length, 50);
	assert.equal(encodedHead("\n".repeat(100), 100).length, 50);
	assert.equal(encodedHead("\u0001".repeat(100), 60).length, 10);
	assert.equal(encodedHead("😀".repeat(10), 5), "😀😀");
	for (const s of ['a"b\\c\nd\u0002e😀f\ud800g'.repeat(200)])
		for (const max of [1, 7, 100, 999]) assert.ok(encodedLength(encodedHead(s, max)) <= max);
});

test("first-F3: get_page_text and get_page_html on a page of quotes return no more than maxChars as JSON, and the note reads on exactly", async () => {
	const tabId = fake.addTab({ url: "https://quotes.test/", status: "complete", title: "Quotes" });
	const page = '"'.repeat(120_000);
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method !== "Runtime.evaluate" || !/slice\((\d+), (\d+)\)/.test(params.expression)) return send(target, method, params);
		const [, from, to] = /slice\((\d+), (\d+)\)/.exec(params.expression).map(Number);
		return { result: { value: { ok: true, value: { text: page.slice(from, to), offset: from, total: page.length } } } };
	};
	const tab = async () => chrome.tabs.get(tabId);
	const ctx = { isGuarded: () => false, session: { id: "s", tabIds: [tabId], currentTabId: tabId, currentTab: tab, setCurrent() {}, requireCurrentTab: tab, attachedCurrentTab: tab } };
	try {
		for (const [method, field] of [["text", "text"], ["html", "html"]]) {
			const r = await handlers[method](ctx, {});
			assert.ok(JSON.stringify(r).length < 100_000 / 2 + 1000, `${method}: ${JSON.stringify(r).length}`);
			assert.equal(r[field].length, 25_000);
			assert.match(r.note, /call again with offset 25000\b/);
		}
	} finally {
		chrome.debugger.sendCommand = send;
	}
	// The PDF window too.
	const pdf = pdfWindow({ text: '"'.repeat(1000), truncated: false }, 0, 100);
	assert.equal(pdf.text.length, 50);
	assert.equal(pdf.next, 50);
	assert.equal(fitSlice({ text: "plain", offset: 0, total: 5 }, 10).text, "plain");
});

const BUDGET = budgetFor({ contextWindow: 32_000, maxTokens: 8192 }, undefined, undefined, 13_702).toolResultTokens * 3;
const tool = (send, name) => createPageTools(send, () => BUDGET).find((t) => t.name === name);
const textOf = (r) => r.content.map((c) => c.text ?? "").join("");

test("first-F2, sol-F3: get_page_text of CJK text fits the guard's tokens, and its note names where it really stopped", async () => {
	const page = "論語學而第一子曰學而時習之不亦說乎".repeat(5000);
	const asked = [];
	const send = async (_m, params) => {
		asked.push(params);
		const from = params.offset ?? 0;
		const part = page.slice(from, from + params.maxChars);
		return { title: "CJK", url: "https://cjk.test/", text: part, ...sliceInfo({ text: part, offset: from, total: page.length }) };
	};
	const out = textOf(await tool(send, "get_page_text").execute("c", {}));
	assert.ok(estimateTextTokens(out) <= BUDGET / 3, `${estimateTextTokens(out)} tokens of ${BUDGET / 3}`);
	assert.ok(asked.length >= 2, "asked again for fewer characters");
	const next = Number(/call again with offset (\d+)/.exec(out)?.[1]);
	assert.equal(next, asked.at(-1).maxChars, "the offset is where the text sent stops");
	assert.ok(out.includes(page.slice(next - 20, next)));
});

test("sol-F3: read_page with long element names is measured, not assumed at 70 characters an element", async () => {
	const nodes = Array.from({ length: 2000 }, (_, i) => ({ ref: `e${i}`, role: "link", name: `${"Very long link name ".repeat(12)}${i}`, visible: true }));
	let calls = 0;
	const send = async (_m, params) => {
		calls++;
		return { url: "https://long.test/", title: "Long", viewport: { width: 1, height: 1, scrollY: 0, pageHeight: 1 }, nodes: nodes.slice(0, params.maxNodes), text: "t".repeat(params.maxTextChars) };
	};
	const out = textOf(await tool(send, "read_page").execute("c", {}));
	assert.ok(estimateTextTokens(out) <= BUDGET / 3, `${estimateTextTokens(out)} tokens of ${BUDGET / 3}`);
	assert.equal(calls, 1, "fitted from the same answer");
	assert.match(out, /The element list stopped at \d+/);
});

// ---- one unit on the MCP side: the JSON an agent gets ---------------------------------------------------------

const { capCrawl, capJson, OUTPUT_CAP, sliceText, utf8Window } = await import("../cli/src/output-cap.ts");

test("sol-F4: a crawl of backslashes and newlines stays whole, valid JSON under the cap", () => {
	const data = Array.from({ length: 40 }, (_, i) => ({ url: `https://c.test/${i}`, markdown: "\\\n".repeat(5000) }));
	const out = JSON.stringify(capCrawl({ success: true, data }));
	assert.ok(out.length <= 70_000, `${out.length}`);
	const back = JSON.parse(out);
	assert.equal(back.data.length, 40, "every URL kept");
	assert.ok(back.data.some((p) => p.markdown_left_out), "the rest is left out, not cut in the middle");
});

test("first-F3, sol-F4: the net cuts a value's longest fields, so what an agent gets is still JSON", () => {
	const value = { url: "https://q.test/", html: '"'.repeat(80_000), note: "Cut at character 80,000 of 90,000." };
	const out = capJson(value);
	assert.ok(out.length <= OUTPUT_CAP);
	const back = JSON.parse(out);
	assert.equal(back.note, value.note, "short fields stay");
	assert.match(back.html, /\[cut: [\d,]+ more characters, to fit the result\]$/);
	const many = capJson(Array.from({ length: 50_000 }, (_, i) => `item ${i}`));
	assert.ok(many.length <= OUTPUT_CAP && Array.isArray(JSON.parse(many)));
});

test("first-F3: page_markdown's part is measured as JSON carries it", () => {
	const md = '"'.repeat(100_000);
	const part = sliceText(md, 0, 40_000, "call page_markdown again with offset", true);
	assert.ok(JSON.stringify({ markdown: part }).length < 40_400);
	assert.match(part, /again with offset 20000\.\]$/);
	assert.equal(sliceText("x".repeat(100), 0, 40, "again", false).startsWith("x".repeat(40)), true);
});

test("second-S5: a Latin-1 file read in windows ends each one where it stopped, and none skips a byte", () => {
	// "é©" is E9 A9, which a UTF-8 decoder reads as one broken character; "Ã©" is C3 A9, valid UTF-8 for é.
	const latin = Buffer.from("café © naïve ½ résumé é© Ã© ".repeat(400), "latin1");
	const whole = new TextDecoder().decode(latin);
	let read = "";
	for (let offset = 0, n = 0; offset < latin.length && n < 10_000; n++) {
		const w = utf8Window(latin, offset, 1_000_000, 777);
		assert.equal(w.from, offset, "a byte at offset is never skipped");
		read += w.text;
		offset = w.end;
	}
	assert.equal(read, whole);
	// Every window size, so a cut lands at every byte: each window ends where its characters really end.
	const short = latin.subarray(0, 120);
	const shortText = new TextDecoder().decode(short);
	for (let max = 1; max <= 12; max++) {
		let again = "";
		for (let offset = 0; offset < short.length; ) {
			const part = utf8Window(short, offset, 1_000_000, max);
			if (part.end < short.length) assert.equal(part.text.length, max, `a full window holds ${max} characters`);
			again += part.text;
			offset = part.end;
		}
		assert.equal(again, shortText, `windows of ${max}`);
	}
	// Valid UTF-8 still never splits a character, and an offset inside one moves to its end.
	const utf = Buffer.from("é😀a".repeat(100), "utf8");
	const inside = utf8Window(utf, 1, 1000, 1000);
	assert.equal(inside.from, 2);
	const w = utf8Window(utf, 0, 1000, 3);
	assert.equal(w.text, "é😀");
	assert.equal(w.end, 6);
});
