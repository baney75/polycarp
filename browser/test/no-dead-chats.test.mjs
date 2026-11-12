// "No dead chats", end to end: compaction, then the guard, on the real panel's fixed part. For windows of 16k to 200k
// and chats that grow to 500 turns with tool results up to 2 MB, every request fits, the person's latest message is
// sent whole, and whatever is left out is named: a drop note, a gap line, or a cut hint in the notes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { call, person, result, say } from "./fixtures/browsing-chat.mjs";

const { createCompactor } = await import("../src/models/compactor.ts");
const { budgetFor, estimateFixedTokens, fitContext } = await import("../src/models/context-budget.ts");
const { browserMessageTransformer } = await import("../src/messages/message-transformer.ts");

const PANEL = JSON.parse(readFileSync(new URL("./fixtures/panel-request.json", import.meta.url), "utf8"));
const REQUEST = { systemPrompt: PANEL.systemPrompt, tools: PANEL.tools };
const FIXED = estimateFixedTokens({ ...REQUEST, messages: [] });
const CHECKS = new Set([1, 2, 5, 13, 30, 70, 150, 300, 500]);
const textIn = (m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("\n\n"));

/** A small deterministic generator, so a failure replays. */
function rng(seed) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Turn t: the person asks (sometimes at length, sometimes with a rule on a later line), 0 to 4 tools run, a reply. */
function turn(t, r) {
	const words = 4 + Math.floor(r() ** 3 * 600);
	const ask = `ASK-${t}: ${"compare the fares and cite each page ".repeat(Math.ceil(words / 7))}${r() < 0.1 ? `\nRULE-${t}: never pay without asking me.` : ""}`;
	const out = [person(ask)];
	for (let k = Math.max(t === 3 || t === 120 ? 1 : 0, Math.floor(r() * 5)); k > 0; k--) {
		const c = call("get_page_text", { url: `https://example.org/t${t}-${k}` });
		const size = k === 1 && (t === 3 || t === 120) ? 2_000_000 : Math.floor(r() ** 2 * 60_000) + 20;
		out.push(c.message, result(c.callId, "get_page_text", `Page ${t}-${k}\n${"Row of fares, taxes and dates. ".repeat(size / 31)}`.slice(0, size)));
	}
	out.push(say(`REPLY-${t}: ${"the fares are listed above. ".repeat(1 + Math.floor(r() * 30))}`));
	return out;
}

/** Each person message is in the request, or the request names its leaving out. */
function assertNamed(sent, stored, where) {
	const all = sent.map(textIn).join("\n");
	const asks = stored.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content);
	const latest = asks.at(-1);
	const last = sent.filter((m) => m.role === "user").at(-1);
	assert.ok(textIn(last).endsWith(latest), `${where}: the latest message is whole`);
	const dropNote = /Polycarp left out the \d+ (earliest messages|messages after its notes)/.test(textIn(last));
	const notes = sent[0].role === "user" && sent[0] !== last ? textIn(sent[0]) : "";
	const total = Number(notes.match(/Message \d+ of (\d+):/)?.[1] ?? 0);
	const gap = notes.match(/Messages? 2 (?:to (\d+) )?of \d+ (?:is|are) not shown here to fit/);
	const cutHint = /The person's earlier messages were cut here to fit; ask the person/.test(notes);
	asks.slice(0, -1).forEach((ask, i) => {
		const tag = ask.slice(0, ask.indexOf(":"));
		if (all.includes(`${tag}:`)) return;
		const n = i + 1;
		const inNotes = n <= total;
		const named = inNotes ? (gap && n >= 2 && n <= Number(gap[1] ?? 2)) || cutHint : dropNote;
		assert.ok(named, `${where}: ${tag} is neither sent nor named as left out`);
	});
}

for (const k of [16, 32, 64, 200])
	for (const failing of [false, true])
	test(`no dead chats on a ${k}k window${failing ? " when every summary fails" : ""}: every request up to 500 turns fits, keeps the latest whole and names what it leaves out`, async () => {
		const model = { id: `stub-${k}k`, provider: "stub", contextWindow: k * 1024, maxTokens: 8192 };
		const budget = budgetFor(model, undefined, undefined, FIXED);
		assert.ok(!budget.tooSmall, `${k}k: the panel's fixed part (${FIXED}) leaves room`);
		const r = rng(k);
		const stored = [];
		let dropped = 0;
		const c = createCompactor({
			model: () => model,
			request: () => REQUEST,
			toLlm: browserMessageTransformer,
			summarize: async (req) => {
				if (failing) throw new Error("the model is down");
				return `## The person's standing instructions\n${[...req.text.matchAll(/RULE-\d+: never pay without asking me\./g)].map((m) => `- ${m[0]}`).join("\n") || "- none"}\n\n## Decisions\n- none\n\n## Facts found\n- Page fares (https://example.org)\n\n## Done steps\n- Read pages`;
			},
			onCompacted: (rec) => stored.push(rec),
			onFailure: (why) => failing || assert.fail(why),
			now: () => 1,
		});
		for (let t = 1; t <= 500; t++) {
			const next = turn(t, r);
			stored.push(next[0]);
			const check = async (where) => {
				const got = fitContext({ ...REQUEST, messages: await browserMessageTransformer(await c.transform([...stored])) }, budget);
				assert.ok(got.fits, `${where}: ${got.reason}`);
				assertNamed(got.context.messages, stored, where);
				return got.dropped;
			};
			// At a check, the request as the turn starts and again after its tool steps, before the reply.
			if (CHECKS.has(t)) dropped += await check(`${k}k turn ${t}`);
			stored.push(...next.slice(1, -1));
			if (CHECKS.has(t) && next.length > 2) dropped += await check(`${k}k turn ${t}, after its tools`);
			stored.push(next.at(-1));
		}
		if (failing && k < 200) assert.ok(dropped > 0, "the guard's own drops were checked too");
	});
