#!/usr/bin/env node
// Rank OpenRouter's free models on Tabkyra's own work: each model drives a throwaway headless
// Chromium through Tabkyra's MCP tools (navigate, read_page, click, fill, handle_dialog, tabs)
// and is scored by the fixture site's state, never by its own report. The output feeds
// src/models/free-ranking.json through cli/eval/free-ranking.mjs, which merges one or more runs
// (shards can run side by side: each has its own site, browser and bridge).
//
//   OPENROUTER_API_KEY=... node --import tsx cli/eval/free-models.mjs
//       [--only id,id | --retry-limited results.json,...] [--tasks shop,contact,forum,stores] [--reps 1] [--first-rep 1] [--out file]
//
// Free only: every model is checked free against the live list before each request, each
// request carries a zero max_price, and the run stops if OpenRouter reports any cost or the
// key's usage moves. Needs the built extension (npm run build) and CLI (cd cli && npm run build)
// and Playwright's Chromium.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	FREE_MAX_PRICE,
	OPENROUTER_BASE_URL,
	OPENROUTER_MODELS_URL,
	usableFreeModels,
} from "../../src/models/free-mode.ts";
import { cli, launchFixtureBrowser, sleep } from "./fixture-browser.mjs";
import { startFixtureSite } from "./fixture-site.mjs";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : fallback;
};
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
	console.error("OPENROUTER_API_KEY is not set");
	process.exit(2);
}
const REPS = Number(arg("--reps", "1"));
/** Number the reps from here, so a later run adds reps instead of replacing earlier ones. */
const FIRST_REP = Number(arg("--first-rep", "1"));
const OUT = arg("--out", join(tmpdir(), "tabkyra-free-models.json"));
// --retry-limited a.json,b.json reruns only the model/task pairs those runs could not measure.
const RETRY = arg("--retry-limited", "")
	? new Set(
			arg("--retry-limited", "")
				.split(",")
				.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).rows.filter((r) => r.limited).map((r) => `${r.model}@${r.task}`)),
		)
	: undefined;
const ONLY = RETRY
	? new Set([...RETRY].map((p) => p.split("@")[0]))
	: arg("--only", "")
		? new Set(arg("--only", "").split(","))
		: undefined;
const TASK_IDS_DEFAULT = "shop,contact,forum,stores";
const TASK_IDS = arg("--tasks", TASK_IDS_DEFAULT).split(",");
const MAX_STEPS = 20;
const TASK_TIMEOUT_MS = 5 * 60 * 1000;
/** About 20 free requests a minute: keep requests at least this far apart. */
const MIN_GAP_MS = 3200;

const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function keyUsage() {
	const r = await fetch(`${OPENROUTER_BASE_URL}/key`, { headers: auth });
	const j = await r.json();
	return j.data?.usage;
}

const listing = (await (await fetch(OPENROUTER_MODELS_URL)).json()).data;
const freeNow = () => new Set(usableFreeModels(listing).map((m) => m.id));
const candidates = usableFreeModels(listing)
	.map((m) => m.id)
	.filter((id) => !ONLY || ONLY.has(id));
console.log(`${candidates.length} free tool-capable models: ${candidates.join(", ")}`);
const usageBefore = await keyUsage();

// ---- fixture site, browser and MCP ------------------------------------------

const fixture = await startFixtureSite();
const { site, state } = fixture;
const fx = await launchFixtureBrowser();
async function cleanup() {
	fixture.close();
	await fx.close().catch(() => {});
}
process.on("SIGTERM", async () => {
	await cleanup();
	process.exit(143);
});
for (const event of ["uncaughtException", "unhandledRejection"])
	process.on(event, async (err) => {
		console.error(err);
		await cleanup();
		process.exit(1);
	});
await fx.waitConnected();
const siteTabs = async () => (await fx.tabsWithGroups()).filter((t) => t.url.startsWith(site));

async function connectMcp() {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [cli, "mcp"],
		env: { ...fx.env, HOME: fx.home, TABKYRA_SOCKET_DIR: fx.socketDir, TABKYRA_AUTO_ALLOW: "1" },
		stderr: "ignore",
	});
	const client = new Client({ name: "free-models-eval", version: "1" });
	await client.connect(transport);
	return client;
}

// ---- tasks ------------------------------------------------------------------

const stores = {
	id: "stores",
	prompt: `Use the browser to open ${site}/store-a and ${site}/store-b, and tell me which store sells the Blue Widget for less and at what price. Close your tabs when you're done. End your reply with one line in this form: ANSWER: Store <letter> $<price>`,
	score: async (answer) => {
		const both = state.visits["/store-a"] > 0 && state.visits["/store-b"] > 0;
		const chosen = [...answer.matchAll(/ANSWER:\s*\**\s*Store\s+([AB])\b[^$\n]*\$(\d+)/gi)].at(-1);
		const right = chosen?.[1].toUpperCase() === "B" && chosen?.[2] === "13";
		const left = (await siteTabs()).length;
		return { success: both && right && left === 0, detail: `answer=${chosen ? `${chosen[1]} $${chosen[2]}` : "none"} tabsLeft=${left}` };
	},
};
const TASKS = [...fixture.SKILL_TASKS, stores].filter((t) => TASK_IDS.includes(t.id));

// ---- the agent loop ---------------------------------------------------------

let lastRequest = 0;
class CostError extends Error {}

async function chat(model, messages, tools) {
	if (!freeNow().has(model)) throw new CostError(`${model} is not free on the live list; refusing to send`);
	for (let attempt = 0; ; attempt++) {
		const wait = lastRequest + MIN_GAP_MS - Date.now();
		if (wait > 0) await sleep(wait);
		lastRequest = Date.now();
		let r;
		try {
			r = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
				method: "POST",
				signal: AbortSignal.timeout(180000),
				headers: { ...auth, "HTTP-Referer": "https://github.com/baney75/tabkyra", "X-Title": "Tabkyra free-model eval" },
				body: JSON.stringify({ model, messages, tools, max_tokens: 4096, provider: { max_price: FREE_MAX_PRICE }, usage: { include: true } }),
			});
		} catch (err) {
			// A hung or dropped connection counts like an overloaded upstream.
			if (attempt >= 3) return { limited: true, error: err.message };
			await sleep(15000 * 2 ** attempt);
			continue;
		}
		const j = await r.json().catch(() => ({}));
		const cost = j.usage?.cost;
		if (typeof cost === "number" && cost > 0) throw new CostError(`${model} reported cost ${cost}`);
		// Rate limits and overloaded upstreams are availability, not ability: retry with backoff,
		// and count the run as limited (a failure) only when they persist.
		const transient =
			r.status === 429 ||
			r.status >= 500 ||
			[429, 502, 503, 504].includes(j.error?.code) ||
			/overload|temporar|rate.?limit|timed? ?out|unavailable|provider returned error/i.test(j.error?.message ?? "");
		if (transient) {
			if (attempt >= 3) return { limited: true, error: `${r.status} ${j.error?.message ?? ""}`.trim() };
			await sleep(15000 * 2 ** attempt);
			continue;
		}
		if (!r.ok || j.error) return { error: `${r.status} ${j.error?.message ?? ""}`.trim() };
		return { message: j.choices?.[0]?.message, answeredBy: j.model, finish: j.choices?.[0]?.finish_reason };
	}
}

function toText(result) {
	return (result.content ?? [])
		.map((c) => (c.type === "text" ? c.text : `[${c.type} omitted: this eval passes text only]`))
		.join("\n");
}

async function runTask(model, client, tools, instructions, task) {
	const t0 = Date.now();
	const messages = [
		{ role: "system", content: `You are a browser agent. Use the tools to do the user's task, then answer.\n\n${instructions}` },
		{ role: "user", content: task.prompt },
	];
	const calls = [];
	let errors = 0;
	let answer = "";
	let failure;
	let answeredBy;
	for (let step = 0; step < MAX_STEPS && Date.now() - t0 < TASK_TIMEOUT_MS; step++) {
		const res = await chat(model, messages, tools);
		if (res.limited) {
			failure = `rate-limited: ${res.error}`;
			break;
		}
		if (res.error) {
			failure = res.error;
			break;
		}
		answeredBy = res.answeredBy;
		const msg = res.message ?? { role: "assistant", content: "" };
		messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
		if (!msg.tool_calls?.length) {
			answer = msg.content ?? "";
			break;
		}
		for (const call of msg.tool_calls) {
			const name = call.function?.name;
			calls.push(name);
			let args = {};
			try {
				args = JSON.parse(call.function?.arguments || "{}");
			} catch {
				errors++;
				messages.push({ role: "tool", tool_call_id: call.id, content: "Error: arguments were not valid JSON" });
				continue;
			}
			let text;
			try {
				const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
				if (result.isError) errors++;
				text = toText(result);
			} catch (err) {
				errors++;
				text = `Error: ${err.message}`;
			}
			messages.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, 20000) });
		}
	}
	await sleep(2000);
	const score = failure ? { success: false, detail: failure } : await task.score(answer);
	return { ...score, calls, errors, seconds: Math.round((Date.now() - t0) / 1000), answer: answer.slice(0, 300), answeredBy, limited: Boolean(failure?.startsWith("rate-limited")), failure };
}

async function closeSiteTabs() {
	for (const t of await fx.targets()) if (t.type === "page" && t.url.startsWith(site)) await fetch(`http://${fx.devtools}/json/close/${t.id}`).catch(() => {});
}

// ---- run --------------------------------------------------------------------

const rows = [];
try {
	for (const model of candidates) {
		for (let rep = FIRST_REP; rep < FIRST_REP + REPS; rep++) {
			for (const task of TASKS) {
				if (RETRY && !RETRY.has(`${model}@${task.id}`)) continue;
				fixture.reset();
				await closeSiteTabs();
				await fx.waitConnected();
				const client = await connectMcp();
				const instructions = client.getInstructions() ?? "";
				const tools = (await client.listTools()).tools.map((t) => ({
					type: "function",
					function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
				}));
				const row = { model, task: task.id, rep, ...(await runTask(model, client, tools, instructions, task)) };
				await client.close().catch(() => {});
				rows.push(row);
				console.log(`${model.padEnd(48)} ${task.id.padEnd(8)} rep${rep} success=${row.success} calls=${row.calls.length} errors=${row.errors} ${row.seconds}s ${row.detail ?? ""}`);
				writeFileSync(OUT, `${JSON.stringify({ date: new Date().toISOString(), rows }, null, 2)}\n`);
			}
		}
	}
} catch (err) {
	if (!(err instanceof CostError)) throw err;
	console.error(`STOPPED: ${err.message}`);
	await cleanup();
	process.exit(3);
}

const usageAfter = await keyUsage();
if (usageAfter !== usageBefore) {
	console.error(`STOPPED: key usage moved from ${usageBefore} to ${usageAfter}`);
	await cleanup();
	process.exit(3);
}

// ---- summary ------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const summary = candidates.map((id) => {
	const own = rows.filter((r) => r.model === id);
	const passed = own.filter((r) => r.success).length;
	return {
		id,
		score: own.length ? Number((passed / own.length).toFixed(3)) : 0,
		passed,
		runs: own.length,
		meanToolCalls: Number(mean(own.map((r) => r.calls.length)).toFixed(1)),
		meanSeconds: Number(mean(own.map((r) => r.seconds)).toFixed(1)),
		rateLimited: own.filter((r) => r.limited).length,
	};
});
// Best first: score, then fewer tool calls, then faster. The router is kept but always ranks last at run time.
summary.sort((a, b) => b.score - a.score || a.meanToolCalls - b.meanToolCalls || a.meanSeconds - b.meanSeconds);
console.log("\n| Model | Passed | Score | Mean tool calls | Mean seconds | Rate-limited runs |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const s of summary) console.log(`| ${s.id} | ${s.passed}/${s.runs} | ${s.score} | ${s.meanToolCalls} | ${s.meanSeconds} | ${s.rateLimited} |`);
writeFileSync(OUT, `${JSON.stringify({ date: new Date().toISOString(), tasks: TASKS.map((t) => t.id), reps: REPS, usageBefore, usageAfter, summary, rows }, null, 2)}\n`);
console.log(`\nRaw results: ${OUT}  (key usage ${usageBefore} -> ${usageAfter})`);

await cleanup();
process.exit(0);
