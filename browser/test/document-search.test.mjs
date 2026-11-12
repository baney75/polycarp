// Searching a document instead of reading it whole: get_page_text {query} on a PDF tab or a long page (bridge), and
// extract_document's attachments of one name and tight windows (PR 143 review round 2: second-S2, sol-F4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= ev();
chrome.webNavigation.onCommitted ??= ev();

const { estimateTextTokens } = await import("../src/models/context-budget.ts");
const { htmlText, parsePdfPages } = await import("../src/tools/document-reader.ts");
const { clearDocumentCache, createExtractDocumentTool } = await import("../src/tools/extract-document.ts");
const { handlers } = await import("../src/bridge/tools.ts");

const ctxFor = (tabId) => {
	const tab = async () => chrome.tabs.get(tabId);
	return { isGuarded: () => false, session: { id: "s", tabIds: [tabId], currentTabId: tabId, currentTab: tab, setCurrent() {}, requireCurrentTab: tab, attachedCurrentTab: tab } };
};
const book = (pages) => Array.from({ length: pages }, (_, i) => `--- Page ${i + 1} of ${pages} ---\n${i === 211 ? "Friendship is a virtue, or implies virtue, and is most necessary for our life." : i === 9 ? "(no text layer on this page)" : `Page ${i + 1}: the mean relative to us.`}\n\n`).join("");

test("parsePdfPages reads the bridge's page stream, and a page with no text layer is empty", () => {
	const doc = parsePdfPages(book(400));
	assert.equal(doc.units.length, 400);
	assert.equal(doc.units[211].n, 212);
	assert.match(doc.units[211].text, /^Friendship is a virtue/);
	assert.equal(doc.units[9].text, "");
});

test("htmlText keeps a page's words, one block to a line, without scripts, styles or tags", () => {
	const text = htmlText('<html><head><title>t</title><style>p{}</style></head><body><h1>Book VIII</h1><script>var x = "<p>"</script><p>On <b>friendship</b> &amp; virtue&nbsp;&#8212; one.</p><p>Two</p></body></html>');
	assert.equal(text, "Book VIII\n\nOn friendship & virtue \u2014 one.\n\nTwo");
});

test("get_page_text {query} on a PDF tab finds the page by number, and reads the file once while it is kept", async () => {
	const tabId = fake.addTab({ url: "https://docs.test/ethics.pdf", status: "complete", title: "Ethics" });
	let reads = 0;
	const { getContexts, sendMessage } = chrome.runtime;
	chrome.runtime.getContexts = async () => [{}];
	chrome.runtime.sendMessage = async (m) => {
		reads++;
		assert.ok(m.maxChars >= 5_000_000, `the whole file is read for a search, not ${m.maxChars} characters`);
		return { ok: true, result: { pages: 400, text: book(400), empty: [10], truncated: false, read: 400 } };
	};
	try {
		for (const query of ["friendship virtue", "necessary for our life"]) {
			const r = await handlers.text(ctxFor(tabId), { query });
			assert.match(r.text, /^1\. Page 212: Friendship is a virtue/m);
			assert.match(r.text, /with pages \(like "212"/);
			assert.ok(r.text.length < 5000, `${r.text.length} characters`);
		}
		assert.equal(reads, 1, "the second search used the kept PDF");
	} finally {
		Object.assign(chrome.runtime, { getContexts, sendMessage });
	}
});

test("get_page_text {query} on a long page names the offset that reads each matching part", async () => {
	const tabId = fake.addTab({ url: "https://long.test/", status: "complete", title: "Long" });
	const page = Array.from({ length: 200 }, (_, i) => (i === 140 ? "The friend is another self, wishing good for the friend's sake." : `Paragraph ${i} on the mean.`).padEnd(900, " x")).join("\n\n");
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method !== "Runtime.evaluate" || !/slice\((\d+), (\d+)\)/.test(params.expression)) return send(target, method, params);
		const [, from, to] = /slice\((\d+), (\d+)\)/.exec(params.expression).map(Number);
		return { result: { value: { ok: true, value: { text: page.slice(from, to), offset: from, total: page.length } } } };
	};
	try {
		const r = await handlers.text(ctxFor(tabId), { query: "another self" });
		const [, part, offset] = /Read part (\d+) in full with get_page_text offset (\d+)/.exec(r.text).map(Number);
		assert.match(r.text, new RegExp(`^1\\. Part ${part}: .*another self`, "m"));
		assert.match(page.slice(offset, offset + 3000), /another self/, "the offset reads the part that matched");
		assert.equal(page.slice(offset - 2, offset), "\n\n", "and starts where the part does");
	} finally {
		chrome.debugger.sendCommand = send;
	}
});

const attached = (fileName, text) => ({ extractedText: text, fileName, mimeType: "text/plain", size: text.length });

test("second-S2: two attachments of one name: the newest is read, copy picks the one before, and the answer says which", async () => {
	clearDocumentCache();
	const files = [attached("report.pdf", "Old draft: revenue fell."), attached("notes.txt", "x"), attached("report.pdf", "Revised: revenue rose.")];
	const tool = createExtractDocumentTool({ budgetChars: () => 20_000, attachments: () => files });
	const read = async (args) => (await tool.execute("c", args)).content[0].text;
	assert.match(await read({ attachment: "report.pdf" }), /copy 1, 1 being the newest[\s\S]*Revised: revenue rose/);
	assert.match(await read({ attachment: "report.pdf", copy: 2 }), /copy 2[\s\S]*Old draft/);
	await assert.rejects(tool.execute("c", { attachment: "report.pdf", copy: 3 }), /copy is 1 to 2/);
	assert.doesNotMatch(await read({ attachment: "notes.txt" }), /copy/);
});

test("sol-F4: a tight window's allowance is kept, not raised, for CJK text, with the note on reading on", async () => {
	clearDocumentCache();
	const text = Array.from({ length: 5 }, (_, i) => `<page number="${i + 1}">${"漢字".repeat(1500)}</page>`).join("\n");
	for (const budgetChars of [300, 768, 900, 1200]) {
		const tool = createExtractDocumentTool({ budgetChars: () => budgetChars, attachments: () => [{ extractedText: text, fileName: "cjk.pdf", mimeType: "application/pdf", size: 1 }] });
		const out = (await tool.execute("c", { attachment: "cjk.pdf", pages: "1-3" })).content[0].text;
		assert.ok(estimateTextTokens(out) <= Math.floor(budgetChars / 3), `${budgetChars}: ${estimateTextTokens(out)} tokens`);
		// A real window's smallest budget (256 tokens) still reads on with the exact offset; less gets the one-line answer.
		assert.match(out, budgetChars >= 768 ? /--- Page 1 of 5 ---[\s\S]*pages "1-3" and offset \d+/ : /no room for this read/);
	}
});
