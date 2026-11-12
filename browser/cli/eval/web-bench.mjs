#!/usr/bin/env node
// Browser agent benchmark: real tasks on live websites, a fresh agent per task driving Polycarp's MCP tools, and a
// separate grader that sees only the task and the transcript. Tasks come from the public Online-Mind2Web set, as
// published with per-task results in https://github.com/at-inc/aside-benchmarks, so a run compares task by task.
//
//   node cli/eval/web-bench.mjs --tasks <aside-benchmarks>/mind2web/results --extension <built extension dir> --out <dir>
//     [--sample 30] [--seed 1] [--only <id,id>] [--model sonnet] [--grader opus] [--concurrency 3] [--timeout 900]
//     [--stack panel]
//
// --stack panel gives the agent the side panel's tools instead of the MCP set (`polycarp mcp --profile panel`:
// navigate, read_page, find, get_page_text, act, handle_dialog, with the panel's descriptions and result text).
//
// Each task gets its own throwaway browser, home and profile (fixture-browser.mjs), so nothing touches a real browser or
// sign-in. Agents use the signed-in claude CLI only: ANTHROPIC_API_KEY is removed, and a usage or billing message stops
// the run with exit 75. Results stay under --out and are a measurement: exit 0 even when tasks fail.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : fallback;
};

const ORDINARY_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/** Every task in an aside-benchmarks results folder, or a JSON list of {task_id, task, website, level}. */
export function loadTasks(source) {
	if (source.endsWith(".json")) return JSON.parse(readFileSync(source, "utf8"));
	return readdirSync(source)
		.filter((name) => existsSync(join(source, name, "result.json")))
		.map((name) => {
			const r = JSON.parse(readFileSync(join(source, name, "result.json"), "utf8"));
			return { task_id: r.task_id, task: r.task, website: r.website, level: r.level, reference: r.graderVerdict, referenceMs: r.durationMs };
		})
		.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/** The same tasks for the same seed, in the set's own mix of difficulty. */
export function stratifiedSample(tasks, size, seed) {
	if (size >= tasks.length) return tasks;
	let state = seed >>> 0 || 1;
	const random = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 2 ** 32;
	};
	const levels = [...new Set(tasks.map((t) => t.level))].sort();
	const picked = [];
	for (const level of levels) {
		const pool = tasks.filter((t) => t.level === level);
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		picked.push(...pool.slice(0, Math.max(1, Math.round((pool.length / tasks.length) * size))));
	}
	return picked.slice(0, size);
}

export function agentPrompt(task) {
	return `Use the browser tools to do this task on the live website. Start at ${task.website}\n\nTask: ${task.task}\n\nDo the whole task, including filters, forms and sorting it asks for. Stop before a final purchase, payment or account creation. End with a short answer stating what you found or did, with the specific details from the page.`;
}

export function graderPrompt(task, answer, transcript) {
	return `You grade whether a browser agent completed a task on a live website. Judge only from the evidence below. Pass only if the transcript shows the agent reached the requested state or found what was asked, with every stated constraint applied. A confident answer with no supporting evidence in the transcript fails. Call it impossible only if the transcript shows the site can no longer offer what was asked. A bot wall or sign-in the agent could not pass is a fail.

Task: ${task.task}
Website: ${task.website}

Final answer:
${answer || "(none)"}

Transcript, oldest first, each tool call with the start of what it returned:
${transcript}

Reply with only JSON: {"verdict":"pass"|"fail"|"impossible","blocked":true|false,"reason":"one sentence"}. blocked is true when a bot wall, captcha or forced sign-in stopped the agent.`;
}

/** The transcript the grader reads: the last steps, since they show the end state, within a size limit. */
export function transcriptOf(steps, maxChars = 60000) {
	const lines = [];
	let used = 0;
	for (const step of [...steps].reverse()) {
		const line = `${step.tool} ${JSON.stringify(step.input).slice(0, 300)}\n-> ${(step.output ?? "").slice(0, 2500)}`;
		if (used + line.length > maxChars) break;
		used += line.length;
		lines.unshift(line);
	}
	if (lines.length < steps.length) lines.unshift(`(${steps.length - lines.length} earlier steps left out)`);
	return lines.join("\n\n");
}

export function parseVerdict(text) {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		const v = JSON.parse(m[0]);
		return ["pass", "fail", "impossible"].includes(v.verdict) ? v : null;
	} catch {
		return null;
	}
}

/** What the CLI itself reports as failing. An agent's own answer can say "billing address" and mean nothing by it. */
export function errorTextOf(event) {
	return event.is_error ? `${event.subtype ?? ""} ${event.result ?? ""}` : "";
}

export function isQuotaStop(text) {
	return /usage limit|rate.?limit|429|out of (extra )?usage|credit balance|billing|upgrade your plan|hit your (\w+ )?limit|weekly limit|session limit|quota/i.test(text);
}

function claudeEnv() {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	// Signed-in use only: nothing here may route through a paid API or gateway.
	for (const key of ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[key];
	return env;
}

function run(args, input, timeoutMs, onLine) {
	return new Promise((resolve) => {
		const child = spawn("claude", args, { env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
		let out = "";
		let err = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
		}, timeoutMs);
		child.stdout.on("data", (d) => {
			out += d;
			if (onLine) {
				const lines = out.split("\n");
				out = lines.pop();
				for (const line of lines) onLine(line);
			}
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (onLine && out) onLine(out);
			resolve({ code, out, err, timedOut });
		});
		child.stdin.end(input);
	});
}

async function runAgent(task, fixtureEnv, cli, model, timeoutMs, stack = "mcp") {
	const mcp = {
		mcpServers: {
			tabkyra: {
				command: process.execPath,
				args: [cli, "mcp", ...(stack === "panel" ? ["--profile", "panel"] : [])],
				env: { HOME: fixtureEnv.HOME, TABKYRA_SOCKET_DIR: fixtureEnv.TABKYRA_SOCKET_DIR, TABKYRA_AUTO_ALLOW: "1", PATH: fixtureEnv.PATH },
			},
		},
	};
	const steps = [];
	const byId = new Map();
	let answer = "";
	let usage = null;
	let raw = "";
	const started = Date.now();
	const result = await run(
		["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--tools", "", "--allowedTools", "mcp__tabkyra__*", "--permission-mode", "bypassPermissions"],
		agentPrompt(task),
		timeoutMs,
		(line) => {
			if (!line.trim()) return;
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				return;
			}
			for (const part of e.message?.content ?? []) {
				if (part.type === "tool_use") {
					const step = { tool: part.name.replace("mcp__tabkyra__", ""), input: part.input, output: "" };
					steps.push(step);
					byId.set(part.id, step);
				} else if (part.type === "tool_result" && byId.has(part.tool_use_id)) {
					const c = part.content;
					byId.get(part.tool_use_id).output = typeof c === "string" ? c : (c ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
					byId.get(part.tool_use_id).isError = part.is_error === true;
				} else if (part.type === "text" && e.type === "assistant") {
					answer = part.text;
				}
			}
			if (e.type === "result") {
				answer = e.result ?? answer;
				usage = { turns: e.num_turns, inputTokens: e.usage?.input_tokens, outputTokens: e.usage?.output_tokens };
				raw = errorTextOf(e);
			}
		},
	);
	return { steps, answer, usage, ms: Date.now() - started, timedOut: result.timedOut, stderr: result.err.slice(-1000), raw };
}

async function grade(task, answer, steps, model) {
	const result = await run(
		["-p", "--model", model, "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"],
		graderPrompt(task, answer, transcriptOf(steps)),
		300000,
	);
	const verdict = parseVerdict(result.out);
	// A real verdict can mention billing; only a call that gave none can be a usage stop.
	if (!verdict && isQuotaStop(result.out + result.err)) return { quota: true };
	return verdict ?? { verdict: "fail", blocked: false, reason: `the grader gave no verdict: ${result.out.slice(0, 200)}`, graderFailed: true };
}

export function summarize(results) {
	const counted = results.filter((r) => r.verdict !== "impossible");
	const passed = results.filter((r) => r.verdict === "pass").length;
	const byLevel = {};
	for (const r of results) {
		byLevel[r.level] ??= { pass: 0, total: 0 };
		byLevel[r.level].total++;
		if (r.verdict === "pass") byLevel[r.level].pass++;
	}
	const median = (values) => {
		const s = [...values].sort((a, b) => a - b);
		return s.length ? s[Math.floor(s.length / 2)] : 0;
	};
	const withReference = results.filter((r) => r.reference);
	return {
		tasks: results.length,
		passed,
		failed: results.filter((r) => r.verdict === "fail").length,
		impossible: results.length - counted.length,
		blocked: results.filter((r) => r.blocked).length,
		passRate: results.length ? +((passed / results.length) * 100).toFixed(1) : 0,
		passRateExclImpossible: counted.length ? +((passed / counted.length) * 100).toFixed(1) : 0,
		byLevel,
		medianSeconds: Math.round(median(results.map((r) => r.ms)) / 1000),
		medianToolCalls: median(results.map((r) => r.toolCalls)),
		referenceOnSameTasks: withReference.length
			? { passed: withReference.filter((r) => r.reference === "pass").length, total: withReference.length, medianSeconds: Math.round(median(withReference.map((r) => r.referenceMs)) / 1000) }
			: null,
	};
}

async function main() {
	const { cli, launchFixtureBrowser } = await import("./fixture-browser.mjs");
	const out = arg("--out");
	const extensionDir = arg("--extension");
	if (!out || !extensionDir || !arg("--tasks")) throw new Error("usage: web-bench.mjs --tasks <dir|file> --extension <dir> --out <dir>");
	mkdirSync(out, { recursive: true });
	const model = arg("--model", "sonnet");
	const stack = arg("--stack", "mcp");
	if (stack !== "mcp" && stack !== "panel") throw new Error(`--stack is mcp or panel, not ${stack}`);
	const graderModel = arg("--grader", "opus");
	const timeoutMs = Number(arg("--timeout", "900")) * 1000;
	const only = arg("--only")?.split(",");
	let tasks = loadTasks(arg("--tasks"));
	tasks = only ? tasks.filter((t) => only.includes(t.task_id)) : stratifiedSample(tasks, Number(arg("--sample", "30")), Number(arg("--seed", "1")));
	const results = [];
	const resultsFile = join(out, "results.json");
	let quotaStop = false;
	const queue = [...tasks];
	const worker = async () => {
		for (let task = queue.shift(); task && !quotaStop; task = queue.shift()) {
			const dir = join(out, task.task_id);
			mkdirSync(dir, { recursive: true });
			let fixture;
			let record;
			try {
				// A headless browser names itself in its user agent and sites block it; a person's browser doesn't. This measures the
				// agent, so the test browser reads as an ordinary one.
				fixture = await launchFixtureBrowser({ extensionDir, extraArgs: [`--user-agent=${arg("--user-agent", ORDINARY_UA)}`, "--disable-blink-features=AutomationControlled", "--window-size=1440,900"] });
				await fixture.waitConnected();
				const agent = await runAgent(task, fixture.env, cli, model, timeoutMs, stack);
				if (isQuotaStop(`${agent.raw} ${agent.stderr}`)) {
					quotaStop = true;
					break;
				}
				const verdict = await grade(task, agent.answer, agent.steps, graderModel);
				if (verdict.quota) {
					quotaStop = true;
					break;
				}
				writeFileSync(join(dir, "steps.json"), JSON.stringify(agent.steps, null, 1));
				record = {
					task_id: task.task_id,
					level: task.level,
					task: task.task,
					website: task.website,
					reference: task.reference,
					referenceMs: task.referenceMs,
					verdict: verdict.verdict,
					blocked: verdict.blocked === true,
					reason: verdict.reason,
					answer: agent.answer,
					ms: agent.ms,
					timedOut: agent.timedOut,
					toolCalls: agent.steps.length,
					toolErrors: agent.steps.filter((s) => s.isError).length,
					tools: agent.steps.reduce((acc, s) => ((acc[s.tool] = (acc[s.tool] ?? 0) + 1), acc), {}),
					usage: agent.usage,
				};
			} catch (error) {
				record = { task_id: task.task_id, level: task.level, task: task.task, website: task.website, reference: task.reference, referenceMs: task.referenceMs, verdict: "fail", blocked: false, reason: `the harness failed: ${error.message}`, harnessError: true, ms: 0, toolCalls: 0, toolErrors: 0 };
			} finally {
				await fixture?.close?.().catch?.(() => undefined);
			}
			if (record) {
				results.push(record);
				writeFileSync(resultsFile, JSON.stringify({ model, graderModel, stack, results, summary: summarize(results) }, null, 1));
				console.log(`${results.length}/${tasks.length} ${record.verdict}${record.blocked ? " (blocked)" : ""} ${record.level} ${Math.round(record.ms / 1000)}s ${record.toolCalls} calls: ${record.task.slice(0, 70)}`);
			}
		}
	};
	await Promise.all(Array.from({ length: Number(arg("--concurrency", "3")) }, worker));
	console.log(JSON.stringify(summarize(results), null, 1));
	if (quotaStop) {
		console.error("Stopped: a usage or billing message appeared. Nothing switches to paid billing.");
		process.exit(75);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
