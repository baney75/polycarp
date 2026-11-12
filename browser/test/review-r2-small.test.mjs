// Review round 2's mediums and lows outside the guard, each with the case that showed it.
import assert from "node:assert/strict";
import { test } from "node:test";

const { clearDocumentCache, createExtractDocumentTool } = await import("../src/tools/extract-document.ts");
const { parseExtracted, readOverview } = await import("../src/tools/document-reader.ts");
const { pdfWindow, READ_MAX_CHARS, readChars } = await import("../src/bridge/paging.ts");
const { capCrawl, CRAWL_TOTAL_CHARS, OUTPUT_CAP } = await import("../cli/src/output-cap.ts");

const resultText = (r) => r.content.map((c) => c.text).join("");

test("sol-sol-N3: another chat's report.pdf of the same name and size is read as itself, not from the cache", async () => {
	clearDocumentCache();
	const read = async (text) => {
		const tool = createExtractDocumentTool({
			budgetChars: () => 20_000,
			attachments: () => [{ extractedText: text, fileName: "report.pdf", mimeType: "application/pdf", size: 120_000 }],
		});
		return resultText(await tool.execute("c", { attachment: "report.pdf" }));
	};
	assert.match(await read("The first chat's report on harvest yields."), /harvest yields/);
	const second = await read("The second chat's report on river levels.");
	assert.match(second, /river levels/);
	assert.doesNotMatch(second, /harvest/);
});

test("second-N1: maxChars past the cap is held to the most a read returns, so its note stays true under the MCP cap", () => {
	assert.equal(readChars(300_000, 50_000), READ_MAX_CHARS);
	assert.equal(readChars(1234, 50_000), 1234);
	assert.ok(READ_MAX_CHARS * 1.5 < OUTPUT_CAP, "a part with its JSON escapes fits the net under it");
});

test("second-N3: maxChars 0 or negative reads the default, and a window that read nothing names no offset", () => {
	for (const v of [0, -5, Number.NaN, "x", undefined]) assert.equal(readChars(v, 50_000), 50_000, String(v));
	assert.equal(readChars(0), undefined, "no default: the reader's own");
	const empty = pdfWindow({ text: "abc", truncated: true }, 3, 50_000);
	assert.equal(empty.text, "");
	assert.equal(empty.next, undefined, "no loop on the same offset");
	assert.equal(pdfWindow({ text: "abcdef", truncated: true }, 0, 3).next, 3);
});

test("second-N5: a crawl of 60 long pages stays whole JSON under the cap, with every URL", () => {
	const data = Array.from({ length: 60 }, (_, i) => ({ url: `https://site.test/${i}`, markdown: "m".repeat(5000) }));
	const capped = capCrawl({ success: true, data });
	const json = JSON.stringify(capped);
	assert.ok(json.length < OUTPUT_CAP, `${json.length}`);
	const back = JSON.parse(json);
	assert.deepEqual(back.data.map((p) => p.url), data.map((p) => p.url));
	const shown = back.data.reduce((n, p) => n + (p.markdown?.length ?? 0), 0);
	assert.ok(shown <= CRAWL_TOTAL_CHARS + 60 * 60, `${shown}`);
	assert.ok(back.data.at(-1).markdown_left_out === 5000);
	assert.match(back.note, /left out: the crawl's 60,000 characters were used up/);
});

test("second-N6: an XLSX with 3,000 long-named sheets lists 30 and counts the rest, within the budget", () => {
	const sheets = Array.from({ length: 3000 }, (_, i) => `<sheet name="${"Quarterly figures ".repeat(10)}${i}" index="${i + 1}">\na,b\n</sheet>`).join("\n");
	const doc = parseExtracted(`<excel filename="big.xlsx">\n${sheets}\n</excel>`, "xlsx");
	assert.equal(doc.units.length, 3000);
	const out = readOverview(doc, "big.xlsx", 20_000);
	const text = typeof out === "string" ? out : out.text;
	assert.ok(text.length <= 20_000, `${text.length}`);
	assert.match(text, /and 2,970 more \(read one with pages\)/);
});
