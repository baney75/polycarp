// PR 145 review round 1, by finding: each test fails without its fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= ev();
chrome.webNavigation.onCommitted ??= ev();

const { estimateTextTokens } = await import("../src/models/context-budget.ts");
const { htmlText } = await import("../src/tools/document-reader.ts");
const { clearDocumentCache, createExtractDocumentTool } = await import("../src/tools/extract-document.ts");
const { handlers } = await import("../src/bridge/tools.ts");

const ctxFor = (tabId) => {
	const tab = async () => chrome.tabs.get(tabId);
	return { isGuarded: () => false, session: { id: "s", tabIds: [tabId], currentTabId: tabId, currentTab: tab, setCurrent() {}, requireCurrentTab: tab, attachedCurrentTab: tab } };
};

/** A tab whose page text (for any selector) is `page`, read the way the bridge reads it, by slices. */
async function onPage(page, fn) {
	const tabId = fake.addTab({ url: `https://long.test/${Math.random()}`, status: "complete", title: "Long" });
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method !== "Runtime.evaluate" || !/slice\((\d+), (\d+)\)/.test(params.expression)) return send(target, method, params);
		const [, from, to] = /slice\((\d+), (\d+)\)/.exec(params.expression).map(Number);
		return { result: { value: { ok: true, value: { text: page.slice(from, to), offset: from, total: page.length } } } };
	};
	try {
		return await fn(tabId);
	} finally {
		chrome.debugger.sendCommand = send;
	}
}

// Table rows that all open with the same 60+ characters; a few name a friend.
const ROW = "Row of the ledger, the same opening words on every row in it, then: ";
const ledger = Array.from({ length: 120 }, (_, i) => `${ROW}${[30, 75, 110].includes(i) ? `entry ${i}, the friend is another self` : `entry ${i}, the mean`}.`.padEnd(700, " x")).join("\n\n");

test("second-G1, first-F3: every hit on a long page names the offset that reads it, though parts open alike", async () => {
	await onPage(ledger, async (tabId) => {
		const r = await handlers.text(ctxFor(tabId), { query: "friend another self" });
		const hits = [...r.text.matchAll(/^\d+\. Part (\d+) \(offset (\d+)\): /gm)].map((m) => Number(m[2]));
		assert.equal(hits.length, 3, r.text);
		assert.equal(new Set(hits).size, 3, "each hit has its own offset");
		for (const offset of hits) assert.match(ledger.slice(offset, offset + 3800), /the friend is another self/, `offset ${offset} reads its hit`);
	});
});

test("first-F1: with a selector, the read-on hint names the selector its offsets are in", async () => {
	await onPage(ledger, async (tabId) => {
		const r = await handlers.text(ctxFor(tabId), { query: "friend another self", selector: "article" });
		assert.match(r.text, /get_page_text \{"selector":"article","offset":N\}/);
	});
});

test("first-F2: search results fit a tight window by the guard's measure and keep the note on reading on", async () => {
	const cjk = Array.from({ length: 60 }, (_, i) => `${"漢字".repeat(300)} friend ${i} another self ${"仮名".repeat(300)}`).join("\n\n");
	await onPage(cjk, async (tabId) => {
		const r = await handlers.text(ctxFor(tabId), { query: "friend another self", maxChars: 900 });
		assert.ok(estimateTextTokens(r.text) <= 300, `${estimateTextTokens(r.text)} tokens`);
		assert.match(r.text, /^1\. Part \d+ \(offset \d+\)/m);
		assert.match(r.text, /N being the offset on its line/);
		assert.match(r.text, /more matches cut to fit/);
	});
});

test("second-G5: a long page with no hits says to read on by offset, not with pages", async () => {
	await onPage(ledger, async (tabId) => {
		const r = await handlers.text(ctxFor(tabId), { query: "zeppelin" });
		assert.match(r.text, /No part has these words[\s\S]*read on through the text with get_page_text \{"offset":N\}/);
		assert.doesNotMatch(r.text, /with pages/);
	});
});

test("second-G2: a PDF text cut short is searched for what it holds, says so, says how to search the rest, and isn't kept", async () => {
	const tabId = fake.addTab({ url: "https://docs.test/code.pdf", status: "complete", title: "Code" });
	const asked = [];
	const { getContexts, sendMessage } = chrome.runtime;
	chrome.runtime.getContexts = async () => [{}];
	chrome.runtime.sendMessage = async (m) => {
		asked.push(m);
		const first = m.first ?? 1;
		const last = m.first ? (m.last ?? 400) : 30;
		const text = Array.from({ length: last - first + 1 }, (_, i) => `--- Page ${first + i} of 400 ---\n${first + i === 300 ? "The friend is another self." : "The mean."}\n\n`).join("");
		return { ok: true, result: { pages: 400, text, empty: [], truncated: !m.first, read: last - first + 1 } };
	};
	try {
		const cut = await handlers.text(ctxFor(tabId), { query: "another self" });
		assert.match(cut.text, /Searched pages 1-30 of 400: the text stopped there\. Search the rest with get_page_text \{"pages":"30-400","query":"another self"\}/);
		await handlers.text(ctxFor(tabId), { query: "another self" });
		assert.equal(asked.length, 2, "the cut text was not kept as the whole file");
		const rest = await handlers.text(ctxFor(tabId), { query: "another self", firstPage: 30, lastPage: 400 });
		assert.deepEqual([asked[2].first, asked[2].last], [30, 400]);
		assert.match(rest.text, /^1\. Page 300: The friend is another self/m);
		assert.doesNotMatch(rest.text, /stopped there/);
	} finally {
		Object.assign(chrome.runtime, { getContexts, sendMessage });
	}
});

const attached = (fileName, text) => ({ extractedText: text, fileName, mimeType: "text/plain", size: text.length });
const book = Array.from({ length: 20 }, (_, i) => `<page number="${i + 1}">${`Page ${i + 1} on friendship and the mean. `.repeat(40)}</page>`).join("\n");

test("second-G3: extract_document keeps to the guard's allowance below its own 200-character floor", async () => {
	for (const budgetChars of [60, 120, 199]) {
		clearDocumentCache();
		const tool = createExtractDocumentTool({ budgetChars: () => budgetChars, attachments: () => [{ ...attached("a-rather-long-file-name-for-the-ethics.pdf", book), mimeType: "application/pdf" }] });
		for (const args of [{ pages: "2" }, {}, { query: "friendship" }]) {
			const out = (await tool.execute("c", { attachment: "a-rather-long-file-name-for-the-ethics.pdf", ...args })).content[0].text;
			assert.ok(estimateTextTokens(out) <= Math.floor(budgetChars / 3), `${budgetChars} ${JSON.stringify(args)}: ${estimateTextTokens(out)} tokens`);
		}
	}
});

test("first-F7: the copy line counts toward the allowance, and the no-room line doesn't say to use query after a query", async () => {
	clearDocumentCache();
	const files = [attached("report.pdf", book), attached("report.pdf", book)];
	const tool = createExtractDocumentTool({ budgetChars: () => 400, attachments: () => files });
	const out = (await tool.execute("c", { attachment: "report.pdf", pages: "1" })).content[0].text;
	assert.match(out, /^\[2 attached documents are called "report\.pdf"/);
	assert.ok(estimateTextTokens(out) <= 133, `${estimateTextTokens(out)} tokens`);
	const tight = createExtractDocumentTool({ budgetChars: () => 240, attachments: () => [attached("r.pdf", book)] });
	const none = (await tight.execute("c", { attachment: "r.pdf", query: "friendship mean" })).content[0].text;
	assert.match(none, /no room for this read: search with fewer words/);
	assert.doesNotMatch(none, /use query/);
});

test("second-G4: part of a name that fits two different documents is refused with their names, not read as copies", async () => {
	clearDocumentCache();
	const tool = createExtractDocumentTool({ budgetChars: () => 20_000, attachments: () => [attached("q3-report.pdf", "a"), attached("report-notes.docx", "b")] });
	await assert.rejects(tool.execute("c", { attachment: "report" }), /"report" fits 2 attached documents: "report-notes\.docx", "q3-report\.pdf"\. Give the whole name\./);
});

test("first-F5: an out-of-range numeric entity stays as written, and hex entities are decoded", () => {
	assert.equal(htmlText("<p>a &#99999999; b &#x2014; c &#X41;</p>"), "a &#99999999; b \u2014 c A");
});
