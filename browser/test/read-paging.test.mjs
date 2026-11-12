// The bridge's read tools answer with a bounded part, say when they cut, and give the call that reads on.
import assert from "node:assert/strict";
import { test } from "node:test";

const { ENTRY_CHARS, newestPage, pdfCutNote, pdfWindow, sliceInfo } = await import("../src/bridge/paging.ts");
const { pdfPages } = await import("../src/offscreen/pdf-pages.ts");

// The same notes serve the MCP tools and the pi extension's browser_* tools, so none may name a tool.
const TOOL_NAMES = /get_page_text|get_page_html|read_console|read_network|browser_\w+/;

test("get_page_text and get_page_html say where they cut and the offset that reads on", () => {
	const cut = sliceInfo({ text: "a".repeat(50_000), offset: 0, total: 120_000 });
	assert.equal(cut.truncated, true);
	assert.equal(cut.totalChars, 120_000);
	assert.match(cut.note, /Cut at character 50,000 of 120,000\. For the rest, call again with offset 50000/);
	assert.doesNotMatch(cut.note, TOOL_NAMES);
	const rest = sliceInfo({ text: "a".repeat(20_000), offset: 100_000, total: 120_000 });
	assert.equal(rest.truncated, undefined);
	assert.equal(rest.offset, 100_000);
	assert.equal(rest.note, undefined);
	assert.deepEqual(sliceInfo({ text: "short", offset: 0, total: 5 }), { totalChars: 5 });
});

test("a PDF read cut at its cap names the page it stopped in and the exact offset that reads on", () => {
	const text = "--- Page 3 of 90 ---\nabc\n\n--- Page 4 of 90 ---\nde";
	const note = pdfCutNote(text, 3, 48);
	assert.match(note, /Cut inside page 4 to fit\. For the rest, call again with offset 48 and the same pages\./);
	assert.doesNotMatch(note, TOOL_NAMES);
});

// A fake pdf.js with these page texts, so the real page reader runs in Node.
function fakePdfjs(pages) {
	return {
		getDocument: () => ({
			promise: Promise.resolve({
				numPages: pages.length,
				getPage: async (n) => ({ getTextContent: async () => ({ items: [{ str: pages[n - 1] }] }) }),
				destroy: async () => {},
			}),
		}),
	};
}

test("a PDF read with offset returns the exact continuation: the parts join to the whole", async () => {
	const pdfjs = fakePdfjs(Array.from({ length: 12 }, (_, i) => `page ${i + 1} ${"word ".repeat(40 + i)}`));
	const whole = (await pdfPages(pdfjs, new Uint8Array(), 1_000_000)).text;
	const max = 333;
	let offset = 0;
	let joined = "";
	for (let i = 0; i < 100; i++) {
		const part = pdfWindow(await pdfPages(pdfjs, new Uint8Array(), offset + max), offset, max);
		assert.ok(part.text.length <= max);
		joined += part.text;
		if (part.next === undefined) break;
		assert.equal(part.truncated, true);
		offset = part.next;
	}
	assert.equal(joined, whole);
	// Without the offset every read returns the same first part, so a reader paging on would never get past it.
	const second = pdfWindow(await pdfPages(pdfjs, new Uint8Array(), 2 * max), max, max);
	assert.ok(second.text.length > max - 5);
	assert.equal(second.text, whole.slice(max, max + second.text.length));
});

test("console and network: the newest 100, older ones by offset, long entries cut", () => {
	const entries = Array.from({ length: 250 }, (_, i) => ({ level: "log", text: i === 249 ? "z".repeat(10_000) : `m${i}` }));
	const first = newestPage(entries, {}, "text");
	assert.equal(first.entries.length, 100);
	assert.equal(first.total, 250);
	assert.equal(first.entries[0].text, "m150");
	assert.ok(first.entries.at(-1).text.length < ENTRY_CHARS + 60);
	assert.match(first.note, /150 older entries are not shown: call again with offset 100 for them\./);
	assert.match(first.note, /1 long message was cut to 2,000 characters/);
	assert.doesNotMatch(first.note, TOOL_NAMES);
	const older = newestPage(entries, { offset: 100 }, "text");
	assert.equal(older.entries[0].text, "m50");
	assert.equal(older.entries.at(-1).text, "m149");
	const oldest = newestPage(entries, { offset: 200 }, "text");
	assert.equal(oldest.entries.length, 50);
	assert.equal(oldest.note, undefined);
});

test("after clear, the older entries are gone, and the note says so instead of offering an offset", () => {
	const entries = Array.from({ length: 250 }, (_, i) => ({ level: "log", text: `m${i}` }));
	const page = newestPage(entries, { clear: true }, "text");
	assert.equal(page.entries.length, 100);
	assert.match(page.note, /150 older entries are not shown, and clear removed them: they can't be read again\./);
	assert.doesNotMatch(page.note, /offset/);
});

const { fitSnapshot, utf8Window } = await import("../cli/src/output-cap.ts");

test("read_page notes a cut only when there was one, and points at get_page_text without an offset", () => {
	const nodes = (n) => Array.from({ length: n }, (_, i) => ({ ref: `e${i}` }));
	// Exactly full is not cut: the caller asked for one more, and none came.
	const full = fitSnapshot({ nodes: nodes(300), text: "t".repeat(3000) }, 300, 3000);
	assert.equal(full.note, "");
	assert.equal(full.snap.nodes.length, 300);
	const over = fitSnapshot({ nodes: nodes(301), text: "t".repeat(3001) }, 300, 3000);
	assert.equal(over.snap.nodes.length, 300);
	assert.equal(over.snap.text.length, 3000);
	assert.match(over.note, /element list stopped at 300/);
	assert.match(over.note, /get_page_text reads all of it, in parts, from the top/);
	assert.doesNotMatch(over.note, /offset/);
});

test("a UTF-8 window never splits a character and its end is the exact offset that reads on", () => {
	const text = "aé日🙂".repeat(50);
	const bytes = new TextEncoder().encode(text);
	for (const max of [1, 2, 3, 5, 7, 64]) {
		let at = 0;
		let joined = "";
		while (at < bytes.length) {
			const w = utf8Window(bytes, at, max, 1_000_000);
			assert.doesNotMatch(w.text, /�/);
			assert.equal(w.from, at);
			assert.ok(w.end > at, "always moves on");
			joined += w.text;
			at = w.end;
		}
		assert.equal(joined, text, `max ${max}`);
	}
	// An offset inside a character starts at the next whole one.
	assert.equal(utf8Window(bytes, 2, 100, 100).from, 3);
	// The character cap holds, never splits a surrogate pair, and moves end to match.
	const capped = utf8Window(bytes, 0, 10_000, 4);
	assert.equal(capped.text, "aé日");
	assert.equal(capped.end, 6);
});
