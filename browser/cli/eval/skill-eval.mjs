#!/usr/bin/env node
// Scripted browser tasks on a local fixture site, run through `claude -p` with a small model so
// tool ergonomics show. Scores come from the fixture server's state and the browser's own tabs
// and groups, not from the model's report. Per run: success, tool calls, wall time, tool errors.
//
// Suites:
//   skill     shop, contact, forum: what skills/tabkyra/SKILL.md changes. Arms "baseline" (server
//             instructions only) and "skill" (the skill appended to the system prompt).
//   sessions  multitab (two tabs at once), resume (a second harness process continues the first
//             one's tab after an extension reload), parallel (two agents at once, no cross-talk),
//             handover (give a tab back to the user), reload (the extension reloads mid-task).
//             Arm "baseline" by default: the MCP server alone.
//
//   node cli/eval/skill-eval.mjs [--suite skill|sessions|all] [--arms baseline,skill] [--only id,id]
//                                [--reps 2] [--model haiku] [--out results.json]
//
// Needs the built extension (npm run build) and CLI (cd cli && npm run build), Playwright's
// Chromium, and a signed-in `claude` CLI (subscription; API-key variables are dropped). It uses
// a temp HOME for the browser and bridge, a headless Chromium (cli/eval/fixture-browser.mjs),
// and --strict-mcp-config, so the model can reach only this throwaway browser.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, HARNESS_SESSION_VARS, launchFixtureBrowser, repo, sleep } from "./fixture-browser.mjs";
import { startFixtureSite } from "./fixture-site.mjs";

const skillText = readFileSync(join(repo, "skills", "tabkyra", "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : fallback;
};
const SUITE = arg("--suite", "skill");
const REPS = Number(arg("--reps", "3"));
const MODEL = arg("--model", "haiku");
const OUT = arg("--out", join(tmpdir(), "tabkyra-skill-eval.json"));
const RUN_TIMEOUT_MS = 6 * 60 * 1000;
// The skill tasks exist to compare both arms, so any suite that includes them runs both.
const ARMS = arg("--arms", SUITE === "skill" || SUITE === "all" ? "baseline,skill" : "baseline").split(",");
const ONLY = arg("--only", "") ? new Set(arg("--only", "").split(",")) : undefined;

const { site, state, reset, setOnCartAdd, SKILL_TASKS, close: closeSite } = await startFixtureSite();

// ---- browser and bridge ----------------------------------------------------

// Registered before the browser starts: it, the fixture server and the temp folders go away
// however the run ends, an early failure included.
let fx;
const workdirs = [];
async function cleanup() {
	closeSite();
	await fx?.close().catch(() => {});
	for (const dir of workdirs) rmSync(dir, { recursive: true, force: true });
}
for (const event of ["uncaughtException", "unhandledRejection"])
	process.on(event, async (err) => {
		console.error(err);
		await cleanup();
		process.exit(1);
	});

fx = await launchFixtureBrowser();
await fx.waitConnected().catch(() => {
	throw new Error("the extension never connected to the bridge");
});
const siteTabs = async () => (await fx.tabsWithGroups()).filter((t) => t.url.startsWith(site));

// The MCP server the model gets: only this bridge, never the user's. No session is set, so
// the server's own default applies, as it would in a user's harness.
const mcpConfig = join(fx.home, "mcp.json");
writeFileSync(
	mcpConfig,
	JSON.stringify({ mcpServers: { tabkyra: { command: process.execPath, args: [cli, "mcp"], env: { HOME: fx.home, TABKYRA_SOCKET_DIR: fx.socketDir, TABKYRA_AUTO_ALLOW: "1" } } } }),
);
// A project folder (a git repo) the agent works in, like a real harness session. Each row gets a
// fresh one, so a session one row leaves behind is never resumed by the next.
let workdir;
function newWorkdir() {
	workdir = mkdtempSync(join(tmpdir(), "tk-eval-cwd-"));
	workdirs.push(workdir);
	execFileSync("git", ["init", "-q", workdir]);
}

function runClaude(prompt, withSkill) {
	const args = [
		"-p",
		prompt,
		"--model",
		MODEL,
		"--output-format",
		"stream-json",
		"--verbose",
		"--strict-mcp-config",
		"--mcp-config",
		mcpConfig,
		"--tools",
		"",
		"--allowedTools",
		"mcp__tabkyra",
		"--disable-slash-commands",
		"--no-session-persistence",
		"--setting-sources",
		"project",
	];
	if (withSkill) args.push("--append-system-prompt", skillText);
	return new Promise((resolve) => {
		const t0 = Date.now();
		// Subscription sign-in only: drop every variable that would route to a paid API or another provider.
		const env = { ...process.env };
		for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[k];
		// The eval may itself run inside a harness; its session variables must not leak into the model's.
		for (const k of HARNESS_SESSION_VARS) delete env[k];
		// Nobody answers ask_user in a headless run: cap each tool call at 30 s (Claude Code's own
		// MCP timeout) so a question costs half a minute, not ask_user's five. Rows count the asks.
		env.MCP_TOOL_TIMEOUT = "30000";
		const child = spawn("claude", args, { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err = (err + d).slice(-4000);
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			const events = out
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return undefined;
					}
				})
				.filter(Boolean);
			const calls = [];
			const errors = [];
			let toolText = "";
			for (const e of events) {
				if (e.type === "assistant") {
					for (const c of e.message?.content ?? []) if (c.type === "tool_use") calls.push({ name: c.name.replace(/^mcp__tabkyra__/, ""), input: c.input });
				} else if (e.type === "user") {
					for (const c of e.message?.content ?? []) {
						if (c.type !== "tool_result") continue;
						const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n");
						toolText += `${text}\n`;
						if (c.is_error) errors.push(text.slice(0, 200));
					}
				}
			}
			const result = events.find((e) => e.type === "result");
			// A run that failed or was killed keeps its last stream events and stderr, so a stall can
			// be told apart: model API, the claude CLI, or a tool call that never returned.
			const tail = code === 0 ? undefined : { events: events.slice(-6).map((e) => JSON.stringify(e).slice(0, 400)), stderr: err.slice(-1500) };
			resolve({ code, ms: Date.now() - t0, calls, errors, toolText, answer: result?.result ?? "", usage: result?.usage, cost: result?.total_cost_usd, tail });
		});
	});
}

/** Fold several runs (phases or parallel agents) into one row's counts. */
function combine(runs) {
	return {
		code: runs.map((r) => r.code).find((c) => c !== 0) ?? 0,
		ms: Math.max(...runs.map((r) => r.ms)),
		calls: runs.flatMap((r) => r.calls),
		errors: runs.flatMap((r) => r.errors),
		answer: runs.map((r) => r.answer).join("\n---\n"),
		tail: runs.find((r) => r.tail)?.tail,
	};
}

const SESSION_TASKS = [
	{
		id: "multitab",
		run: (arm) =>
			runClaude(
				`Use the browser to open ${site}/store-a and ${site}/store-b in two tabs at the same time, and tell me which store sells the Blue Widget for less and at what price. Close your tabs when you're done. End your reply with one line in this form: ANSWER: Store <letter> $<price>`,
				arm,
			),
		score: async (run) => {
			const both = state.visits["/store-a"] > 0 && state.visits["/store-b"] > 0;
			// The store the model chose, from its ANSWER line, not any mention of the right one.
			const chosen = [...run.answer.matchAll(/ANSWER:\s*\**\s*Store\s+([AB])\b[^$\n]*\$(\d+)/gi)].at(-1);
			const right = chosen?.[1].toUpperCase() === "B" && chosen?.[2] === "13";
			const left = (await siteTabs()).length;
			return { success: both && right && left === 0, detail: `answer=${chosen ? `${chosen[1]} $${chosen[2]}` : "none"} visited a=${state.visits["/store-a"] ?? 0} b=${state.visits["/store-b"] ?? 0} tabsLeft=${left}` };
		},
	},
	{
		id: "resume",
		// Two harness processes in the same project, an extension reload between them: the second
		// must find the first one's tab, where the unsaved draft lives.
		run: async (arm) => {
			const first = await runClaude(
				`Use the browser to open ${site}/notes and type the line "first line" into the notes box. Don't click Save. Leave the tab open; I'll ask you to continue later.`,
				arm,
			);
			await fx.reloadExtension();
			const second = await runClaude(
				`Continue the browser task from before: in the notes tab you already have open (${site}/notes), add a new line "second line" below the text that is already in the box, keeping that text, then click Save.`,
				arm,
			);
			return combine([first, second]);
		},
		score: async () => {
			const saved = (state.notes.at(-1) ?? "").replace(/\r/g, "").trim();
			return { success: /^first line\s*\n\s*second line$/.test(saved), detail: `saved=${JSON.stringify(saved)} opens=${state.visits["/notes"] ?? 0}` };
		},
	},
	{
		id: "parallel",
		// Two agents at once in one project; each must see only its own tabs.
		run: async (arm) => {
			const [shop, contact] = await Promise.all([
				runClaude(`Use the browser to open ${site}/shop, add exactly two Blue Widgets to the cart, then tell me the cart total.`, arm),
				runClaude(
					`Use the browser to send the contact form at ${site}/contact with name "Ada Lovelace", email "ada@example.com" and message "Hello from the eval". I want it sent.`,
					arm,
				),
			]);
			const run = combine([shop, contact]);
			// Only this fixture's own pages count: a skill's worked example can name /contact too.
			const host = site.replace(/^https?:\/\//, "").replaceAll(".", "\\.");
			const leak = shop.toolText.match(new RegExp(`.{0,120}${host}/contact.{0,60}`)) ?? contact.toolText.match(new RegExp(`.{0,120}${host}/(shop|cart)\\b.{0,60}`));
			run.crossTalk = Boolean(leak);
			run.crossTalkEvidence = leak?.[0];
			run.shopAnswer = shop.answer;
			return run;
		},
		score: async (run) => {
			const cart = state.cart.blue === 2 && Object.keys(state.cart).length === 1 && /(^|[^\d])\$30(\.00)?\b/.test(run.shopAnswer);
			const s = state.submissions;
			const sent = s.length === 1 && s[0].name === "Ada Lovelace" && s[0].message === "Hello from the eval";
			return {
				success: cart && sent && !run.crossTalk,
				detail: `cart=${JSON.stringify(state.cart)} submissions=${s.length} crossTalk=${run.crossTalk}`,
				...(run.crossTalkEvidence ? { crossTalkEvidence: run.crossTalkEvidence } : {}),
			};
		},
	},
	{
		id: "handover",
		run: (arm) =>
			runClaude(
				`Use the browser to open ${site}/shop and add one Red Widget to the cart. Then open the cart page and hand that cart tab over to me, so it is mine and I can check out myself. Close any other tabs you opened.`,
				arm,
			),
		score: async () => {
			const tabs = await siteTabs();
			const cart = tabs.filter((t) => t.url.includes("/cart"));
			const owned = new Set((await fx.storedSessions()).flatMap((s) => s.tabIds));
			const handed = cart.length === 1 && cart[0].group === null && !owned.has(cart[0].id);
			return {
				success: state.cart.red === 1 && handed && tabs.length === 1,
				detail: `cart=${JSON.stringify(state.cart)} cartTabs=${cart.length} group=${cart[0]?.group ?? "-"} owned=${cart[0] ? owned.has(cart[0].id) : "-"} tabsLeft=${tabs.length}`,
			};
		},
	},
	{
		id: "reload",
		// The extension reloads right after the first item lands in the cart.
		run: (arm) => {
			let fired = false;
			setOnCartAdd(() => {
				if (fired) return;
				fired = true;
				void fx.reloadExtension({ wait: false }).catch(() => {});
			});
			return runClaude(`Use the browser to open ${site}/shop, add exactly two Blue Widgets to the cart, then tell me the cart total.`, arm);
		},
		score: async (run) => {
			const exact = state.cart.blue === 2 && Object.keys(state.cart).length === 1;
			return { success: exact && /(^|[^\d])\$30(\.00)?\b/.test(run.answer), detail: `cart=${JSON.stringify(state.cart)}` };
		},
	},
];

const TASKS = [
	...(SUITE === "skill" || SUITE === "all" ? SKILL_TASKS.map((t) => ({ ...t, run: (arm) => runClaude(t.prompt, arm), score: async (run) => t.score(run.answer) })) : []),
	...(SUITE === "sessions" || SUITE === "all" ? SESSION_TASKS : []),
].filter((t) => !ONLY || ONLY.has(t.id));

async function closeSiteTabs() {
	for (const t of await fx.targets()) if (t.type === "page" && t.url.startsWith(site)) await fetch(`http://${fx.devtools}/json/close/${t.id}`).catch(() => {});
}

const results = [];
for (let rep = 1; rep <= REPS; rep++) {
	for (const task of TASKS) {
		for (const arm of ARMS) {
			reset();
			newWorkdir();
			await closeSiteTabs();
			await fx.waitConnected();
			const run = await task.run(arm === "skill");
			// Let any delayed page work settle before scoring.
			await sleep(2000);
			const score = await task.score(run);
			const leftOpen = (await siteTabs()).length;
			const row = {
				task: task.id,
				arm,
				rep,
				...score,
				toolCalls: run.calls.length,
				errors: run.errors.length,
				errorTexts: run.errors.slice(0, 5),
				statusFirst: run.calls[0]?.name === "status",
				interactiveRead: run.calls.some((c) => c.name === "read_page" && c.input?.filter === "interactive"),
				dialogHandled: run.calls.some((c) => c.name === "handle_dialog"),
				askedUser: run.calls.filter((c) => c.name === "ask_user").length,
				tabsLeftOpen: leftOpen,
				seconds: Math.round(run.ms / 1000),
				exit: run.code,
				answer: run.answer.slice(0, 400),
				...(run.tail ? { tail: run.tail } : {}),
				calls: run.calls.map((c) => c.name),
			};
			results.push(row);
			console.log(
				`${row.task.padEnd(9)} ${row.arm.padEnd(8)} rep${rep} success=${row.success} calls=${row.toolCalls} errors=${row.errors} tabsLeft=${row.tabsLeftOpen} ${row.seconds}s ${score.detail}`,
			);
		}
	}
}

writeFileSync(OUT, `${JSON.stringify({ model: MODEL, suite: SUITE, reps: REPS, reloadsSent: fx.reloads(), results }, null, 2)}\n`);

const agg = (rows, f) => rows.filter(f).length;
const mean = (rows, k) => (rows.reduce((t, r) => t + r[k], 0) / rows.length).toFixed(1);
console.log("\n| Task | Arm | Success | Mean tool calls | Mean errors | Mean seconds | status first | tabs left open |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const task of [...TASKS.map((t) => t.id), "all"]) {
	for (const arm of ARMS) {
		const rows = results.filter((r) => r.arm === arm && (task === "all" || r.task === task));
		const n = rows.length;
		if (!n) continue;
		console.log(
			`| ${task} | ${arm} | ${agg(rows, (r) => r.success)}/${n} | ${mean(rows, "toolCalls")} | ${mean(rows, "errors")} | ${mean(rows, "seconds")} | ${agg(rows, (r) => r.statusFirst)}/${n} | ${rows.reduce((t, r) => t + r.tabsLeftOpen, 0)} |`,
		);
	}
}
console.log(`\nRaw results: ${OUT}`);

await cleanup();
process.exit(0);
