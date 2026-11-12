// Tokens sent per model request in a long browsing chat, with and without compaction (src/models/compactor.ts).
// It replays test/fixtures/browsing-chat.mjs request by request, so it needs no browser and no network: the
// summarizer is a stand-in that keeps every budget figure it is shown (from a page or from the assistant's answer), the
// way a model following the notes prompt would.
// Estimates use the panel's own counter (about 3 characters per token, 1600 per image).
//
// usage: node --import tsx scripts/bench/compaction.mjs [--turns 40] [--lines 60] [--window 32000] [--fixed 13000]
// Not part of CI. --fixed is the system prompt and tool schemas; the panel's measure about 13,000.
import { parseArgs } from "node:util";
import { conversation, estimateAgentMessages, SECTIONS } from "../../src/models/compaction.ts";
import { createCompactor } from "../../src/models/compactor.ts";
import { browsingChat } from "../../test/fixtures/browsing-chat.mjs";

const { values } = parseArgs({
	options: {
		turns: { type: "string", default: "40" },
		lines: { type: "string", default: "60" },
		window: { type: "string", default: "32000" },
		fixed: { type: "string", default: "13000" },
	},
});
const turns = Number(values.turns);
const fixed = Number(values.fixed);
const model = { id: "bench", provider: "bench", contextWindow: Number(values.window), maxTokens: 4096 };

const FIGURE = /budget line (\d+) is (\d+) thousand dollars/g;
/** The figures a text holds, in the words the pages use. */
const figures = (text) => [...text.matchAll(FIGURE)].map((m) => `budget line ${m[1]} is ${m[2]} thousand dollars`);

/** The stand-in summarizer: the previous notes' figures plus every figure in the new part of the chat. */
async function summarize({ text }) {
	const facts = [...new Set(figures(text))];
	return SECTIONS.map((s) => {
		if (s === "Goal and standing instructions")
			return `## ${s}\n- Find the 2026 budget figures for the river project; cite the page URL; never sign in.`;
		if (s === "Facts found") return `## ${s}\n${facts.map((f) => `- ${f}`).join("\n") || "- none"}`;
		return `## ${s}\n- none`;
	}).join("\n");
}

const chat = browsingChat(turns, Number(values.lines));
const stored = [];
let calls = 0;
const compactor = createCompactor({
	model: () => model,
	fixedTokens: () => fixed,
	summarize: async (req) => {
		calls++;
		return summarize(req);
	},
	onCompacted: (record) => stored.push(record),
	onFailure: (message) => console.error(message),
});

const rows = [];
for (const m of chat) {
	// The model is asked for every assistant message: that request carries everything stored so far.
	if (m.role === "assistant") {
		const callsBefore = calls;
		const without = fixed + estimateAgentMessages(conversation(stored));
		const sent = await compactor.transform([...stored]);
		const withC = fixed + estimateAgentMessages(sent);
		rows.push({ request: rows.length + 1, without, with: withC, summarized: calls - callsBefore });
	}
	stored.push(m);
}

const plan = compactor.meter(stored);
const pad = (v, n) => String(v).padStart(n);
console.log(
	`window ${model.contextWindow.toLocaleString("en-US")}, fixed ${fixed.toLocaleString("en-US")}, threshold ${plan.threshold.toLocaleString("en-US")}, ${turns} turns, ${rows.length} requests`,
);
console.log(`${pad("request", 7)} ${pad("without", 9)} ${pad("with", 9)}  summarizer calls`);
for (const r of rows) {
	const over = r.without > model.contextWindow ? " (over the window: the guard cuts it)" : "";
	console.log(`${pad(r.request, 7)} ${pad(r.without, 9)} ${pad(r.with, 9)}  ${r.summarized || ""}${over}`);
}
const total = (k) => rows.reduce((n, r) => n + r[k], 0);
// What the model would still see on one more request: the notes plus the turns kept verbatim.
const last = JSON.stringify(await compactor.transform([...stored]));
const kept = new Set([...last.matchAll(FIGURE)].map((m) => m[1]));
console.log(
	`total tokens sent: without ${total("without").toLocaleString("en-US")}, with ${total("with").toLocaleString("en-US")}; largest request without ${Math.max(...rows.map((r) => r.without)).toLocaleString("en-US")}, with ${Math.max(...rows.map((r) => r.with)).toLocaleString("en-US")}`,
);
if (!calls && rows.some((r) => r.without > plan.threshold))
	console.log(
		"compaction never ran: the fixed part leaves too little room in this window, so the guard trims instead.",
	);
console.log(
	`summarizer calls ${calls}; budget figures the model still sees on the next request ${kept.size} of ${turns}`,
);
