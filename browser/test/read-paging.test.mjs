// The bridge's read tools answer with a bounded part, say when they cut, and give the call that reads on.
import assert from "node:assert/strict";
import { test } from "node:test";

const { ENTRY_CHARS, newestPage, pdfCutNote, sliceInfo } = await import("../src/bridge/paging.ts");

test("get_page_text and get_page_html say where they cut and the offset that reads on", () => {
	const cut = sliceInfo({ text: "a".repeat(50_000), offset: 0, total: 120_000 }, "get_page_text");
	assert.equal(cut.truncated, true);
	assert.equal(cut.totalChars, 120_000);
	assert.match(cut.note, /Cut at character 50,000 of 120,000\. For the rest, call get_page_text with offset 50000/);
	const rest = sliceInfo({ text: "a".repeat(20_000), offset: 100_000, total: 120_000 }, "get_page_html");
	assert.equal(rest.truncated, undefined);
	assert.equal(rest.offset, 100_000);
	assert.equal(rest.note, undefined);
	assert.deepEqual(sliceInfo({ text: "short", offset: 0, total: 5 }, "get_page_text"), { totalChars: 5 });
});

test("a PDF read cut at its cap names the page it stopped in and the range that reads on", () => {
	const text = "--- Page 3 of 90 ---\nabc\n\n--- Page 4 of 90 ---\nde";
	assert.match(pdfCutNote(text, 3, 90), /Cut inside page 4 to fit\. For the rest, call get_page_text with pages "4-90"/);
});

test("console and network: the newest 100, older ones by offset, long entries cut", () => {
	const entries = Array.from({ length: 250 }, (_, i) => ({ level: "log", text: i === 249 ? "z".repeat(10_000) : `m${i}` }));
	const first = newestPage(entries, {}, "read_console", "text");
	assert.equal(first.entries.length, 100);
	assert.equal(first.total, 250);
	assert.equal(first.entries[0].text, "m150");
	assert.ok(first.entries.at(-1).text.length < ENTRY_CHARS + 60);
	assert.match(first.note, /150 older entries are not shown: call read_console with offset 100 for them\./);
	assert.match(first.note, /1 long message was cut to 2,000 characters/);
	const older = newestPage(entries, { offset: 100 }, "read_console", "text");
	assert.equal(older.entries[0].text, "m50");
	assert.equal(older.entries.at(-1).text, "m149");
	const oldest = newestPage(entries, { offset: 200 }, "read_console", "text");
	assert.equal(oldest.entries.length, 50);
	assert.equal(oldest.note, undefined);
});
