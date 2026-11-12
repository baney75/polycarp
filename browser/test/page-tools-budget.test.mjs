// The panel's shared page tools under the context budget: a read asks for no more than one tool result may hold, says
// where it cut and how to read on, and its answer reaches the model whole (context-guard.ts fits to the same budget).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { fitPageCall } = await import("../src/bridge/page-tools.ts");
const { createPageTools } = await import("../src/tools/page-tools.ts");
const { sliceInfo } = await import("../src/bridge/paging.ts");
const { budgetFor, estimateTextTokens } = await import("../src/models/context-budget.ts");

const BUDGET = budgetFor({ contextWindow: 32_000, maxTokens: 8192 }, undefined, undefined, 13_702).toolResultTokens * 3;
const tool = (send, name) => createPageTools(send, () => BUDGET).find((t) => t.name === name);
const textOf = (r) => r.content.map((c) => c.text ?? "").join("");

test("get_page_text on a long page asks for what one result may hold, and its note reads on from there", async () => {
	const page = "Sentence of page text. ".repeat(20_000);
	const asked = [];
	const send = async (method, params) => {
		asked.push(params);
		const from = params.offset ?? 0;
		const part = page.slice(from, from + params.maxChars);
		return { title: "Long", url: "https://long.test/", text: part, ...sliceInfo({ text: part, offset: from, total: page.length }) };
	};
	const first = textOf(await tool(send, "get_page_text").execute("c1", {}));
	assert.ok(asked[0].maxChars <= BUDGET - 500, `asked for ${asked[0].maxChars} of ${BUDGET}`);
	assert.ok(first.length <= BUDGET, `${first.length} of ${BUDGET}`);
	const next = Number(/call again with offset (\d+)/.exec(first)?.[1]);
	assert.equal(next, asked[0].maxChars, "the note names the exact next offset");
	const second = textOf(await tool(send, "get_page_text").execute("c2", { offset: next }));
	assert.equal(asked[1].offset, next, "offset reaches the bridge");
	assert.ok(second.includes("Sentence of page text."));
	// A request for more than fits is held to it; a smaller one is kept.
	assert.equal(fitPageCall("get_page_text", { maxChars: 1_000_000 }, BUDGET).params.maxChars, BUDGET - 600);
	assert.equal(fitPageCall("get_page_text", { maxChars: 800 }, BUDGET).params.maxChars, 800);
});

test("a PDF read on the panel keeps the bridge's cut note with its offset", async () => {
	const send = async () => ({ title: "Book", url: "https://b.test/b.pdf", pdf: { pages: 400, truncated: true, cut: "Cut inside page 12 to fit. For the rest, call again with offset 4400 and the same pages." }, text: "--- Page 1 of 400 ---\nText." });
	const out = textOf(await tool(send, "get_page_text").execute("c", {}));
	assert.match(out, /call again with offset 4400 and the same pages/);
});

test("read_page holds its element list and text to the budget and says when it stopped", async () => {
	let asked;
	const nodes = Array.from({ length: 2000 }, (_, i) => ({ ref: `e${i}`, role: "link", name: `Link number ${i}`, visible: true }));
	const send = async (_m, params) => {
		asked = params;
		return { url: "https://many.test/", title: "Many", viewport: { width: 1, height: 1, scrollY: 0, pageHeight: 1 }, nodes: nodes.slice(0, params.maxNodes), text: "t".repeat(params.maxTextChars) };
	};
	const out = textOf(await tool(send, "read_page").execute("c", {}));
	assert.ok(out.length <= BUDGET, `${out.length} of ${BUDGET}`);
	assert.ok(estimateTextTokens(out) <= BUDGET / 3 + 50);
	assert.match(out, /The element list stopped at \d+: use find/);
	assert.match(out, /The text stopped at \d+ characters: get_page_text reads all of it/);
	assert.equal(asked.maxNodes, fitPageCall("read_page", {}, BUDGET).limits.maxNodes + 1, "asks for one more, to know it cut");
});

test("a short read says nothing about cuts", async () => {
	const send = async () => ({ url: "https://s.test/", title: "S", viewport: { width: 1, height: 1, scrollY: 0, pageHeight: 1 }, nodes: [{ ref: "e1", role: "button", name: "Go", visible: true }], text: "Hi" });
	const out = textOf(await tool(send, "read_page").execute("c", {}));
	assert.doesNotMatch(out, /stopped at/);
});
