// Weak-model eval: a small model does real tasks with Polycarp's MCP tools and nothing else, and each run
// is scored by machine. See README.md. Usage:
//   node evals/weak-model/run.mjs --label r1-haiku [--model claude-haiku-5-5] [--trials 2] [--kind browser|computer|all]
//        [--only id,id] [--concurrency 3] [--turns 30] [--wall 240] [--list]
// Tasks come from every tasks/*.mjs file (WM_TASKS_DIR overrides the folder); --list prints them and starts nothing.
// Needs `npm run build` at browser/ (dist-chrome) and in cli/, and a Playwright Chromium. Never calls an API key:
// the responder is `claude -p` under the signed-in Claude Code account.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HandsClient, treeText } from "./hands.mjs";
import { childEnv, keyVarsSet, loadTasks, ownPids, restorePrefs as restoreFrom, sessionName, settledState, stopCleanup } from "./lib.mjs";
import { handedOff } from "./signup-rule.mjs";
import { summarize } from "./summarize.mjs";

// A key variable makes claude -p bill an API key instead of the owner's sign-in: refuse before anything starts.
const keys = keyVarsSet(process.env);
if (keys.length) {
	console.error(`refusing to start: ${keys.join(", ")} set; runs must use the Claude Code sign-in, so unset ${keys.length > 1 ? "them" : "it"}`);
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "cli", "dist", "index.js");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const model = opt("model", "claude-haiku-5-5");
const label = opt("label", `run-${model.replace(/^claude-/, "")}`);
const trials = Number(opt("trials", "2"));
// Computer runs open real apps on the owner's Mac. They are off until the lead turns them back on with
// WM_ALLOW_COMPUTER=1; until then every run is browser only and its server lists no computer tools.
const allowComputer = process.env.WM_ALLOW_COMPUTER === "1";
const kind = opt("kind", allowComputer ? "all" : "browser");
const only = opt("only", "")
	.split(",")
	.filter(Boolean);
const concurrency = Number(opt("concurrency", "3"));
const turns = Number(opt("turns", "30"));
const wallBrowser = Number(opt("wall", "240")) * 1000;
const wallComputer = Number(opt("wall-computer", "300")) * 1000;
const profile = opt("profile", "");

const tasksDir = process.env.WM_TASKS_DIR || join(here, "tasks");
const all = await loadTasks(tasksDir);
if (!all.length) {
	console.error(`no tasks: ${tasksDir} has no task files (each tasks/*.mjs exports an array of { id, kind, prompt, ... })`);
	process.exit(2);
}
const unknown = only.filter((id) => !all.some((t) => t.id === id));
if (unknown.length) {
	console.error(`unknown task: ${unknown.join(", ")}`);
	process.exit(2);
}
const chosen = all.filter((t) => (kind === "all" || t.kind === kind) && (!only.length || only.includes(t.id)));
if (argv.includes("--list")) {
	for (const t of chosen) console.log(`${t.kind}\t${t.id}`);
	process.exit(0);
}
const { startHarness } = await import("../../cli/test/e2e-harness.mjs");
const outDir = join(here, "results", label);
mkdirSync(outDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "wm-eval-"));
const emptyCwd = join(scratch, "cwd");
mkdirSync(emptyCwd);

// The computer tools go through a helper wrapper: connector mode, so the model is held to the agent workspace
// and lent apps whatever access mode this Mac has (Full Access included), and the real HOME the helper needs.
const helper = [join(homedir(), ".local", "bin", "polycarp-spaces"), join(homedir(), "Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces"), "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces"].find(existsSync);
const wrapper = join(scratch, "spaces-connector.sh");
if (helper) writeFileSync(wrapper, `#!/bin/sh\nHOME='${homedir()}' exec '${helper}' mcp --connector\n`, { mode: 0o755 });
const handoff = join(homedir(), "Library", "Application Support", "Polycarp", "hands", "handoff");

const needsBrowser = chosen.some((t) => t.kind === "browser");
const needsComputer = chosen.some((t) => t.kind === "computer");
if (needsComputer && !allowComputer) {
	console.error("computer tasks are switched off (they open apps on the owner's Mac); set WM_ALLOW_COMPUTER=1 only when the lead says so");
	process.exit(2);
}
if (needsComputer && (!helper || process.platform !== "darwin")) {
	console.error("computer tasks need polycarp-spaces on a Mac; run with --kind browser");
	process.exit(2);
}

const h = needsBrowser ? await startHarness() : undefined;
// A stopped run still tears down its Chromium and restores app preferences.
for (const sig of ["SIGINT", "SIGTERM"])
	process.on(sig, () => {
		stopAll = true;
		hands?.close();
		if (needsComputer) {
			stopCleanup(started, join(handoff, `weak-model-${process.pid}`));
			restorePrefs();
		}
		void (h?.stop() ?? Promise.resolve()).finally(() => process.exit(130));
	});
const serverEnv = h
	? { HOME: h.home, XDG_CONFIG_HOME: join(h.home, ".config"), TABKYRA_SOCKET_DIR: h.socketDir, TABKYRA_AUTO_ALLOW: "1" }
	: { HOME: join(scratch, "home"), TABKYRA_SOCKET_DIR: mkdtempSync("/tmp/wmsk-"), TABKYRA_AUTO_ALLOW: "1" };
if (!h) mkdirSync(serverEnv.HOME, { recursive: true });

const prefsBackup = needsComputer ? backupPrefs() : [];
const hands = needsComputer ? new HandsClient(helper) : undefined;
let stopAll = false;
/** App copies this run's opens started, by pid: the only ones it ever closes. */
const started = new Set();

function backupPrefs() {
	const saved = [];
	for (const domain of ["com.apple.calculator", "com.apple.TextEdit", "com.apple.Preview"]) {
		const file = join(scratch, `${domain}.plist`);
		try {
			execFileSync("defaults", ["export", domain, file], { stdio: "ignore" });
			saved.push({ domain, file });
		} catch {
			// Only a domain that did not exist is deleted on restore; any other export failure leaves it alone.
			let absent = false;
			try {
				execFileSync("defaults", ["read", domain], { stdio: "pipe" });
			} catch (err) {
				absent = /does not exist/i.test(String(err.stderr));
			}
			saved.push({ domain, file: undefined, absent });
		}
	}
	return saved;
}

function restorePrefs() {
	restoreFrom(prefsBackup, (cmd, args) => execFileSync(cmd, args, { stdio: "ignore" }));
}

/** Closes the app copies this run's own computer_open calls started; never one the owner or another session opened. */
async function killOwnCopies(pids) {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r) => setTimeout(r, 1500));
	for (const pid of pids) {
		try {
			process.kill(pid, 0);
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

function mcpConfig(session) {
	const config = {
		mcpServers: {
			polycarp: {
				command: process.execPath,
				args: [cli, "mcp", "--session", session, ...(profile ? ["--profile", profile] : [])],
				env: { ...serverEnv, PATH: process.env.PATH ?? "", TABKYRA_CLIENT_NAME: "weak-model", POLYCARP_SPACES_BIN: allowComputer && helper ? wrapper : join(scratch, "no-computer-helper") },
			},
		},
	};
	const file = join(scratch, `${session}.mcp.json`);
	writeFileSync(file, JSON.stringify(config));
	return file;
}

const QUOTA = /usage limit|rate limit|quota|billing|upgrade your plan|out of credits|credit balance|limit reached/i;

/** One claude -p run; returns the compact transcript. */
function runClaude(prompt, session, wallMs) {
	return new Promise((resolve) => {
		const args = [
			"-p",
			prompt,
			"--model",
			model,
			"--output-format",
			"stream-json",
			"--verbose",
			"--mcp-config",
			mcpConfig(session),
			"--strict-mcp-config",
			"--setting-sources",
			"project",
			"--tools",
			"",
			"--allowedTools",
			"mcp__polycarp",
			"--max-turns",
			String(turns),
			"--no-session-persistence",
		];
		const child = spawn("claude", args, { cwd: emptyCwd, env: childEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
		const events = [];
		let buf = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				try {
					events.push(JSON.parse(line));
				} catch {}
			}
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const start = Date.now();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 3000);
		}, wallMs);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(compact(events, { timedOut, ms: Date.now() - start, stderr: stderr.slice(-2000) }));
		});
	});
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}... [${s.length - n} more chars]` : s);

function compact(events, extra) {
	const calls = [];
	const byId = new Map();
	let final = "";
	let result;
	let mcpStatus;
	let toolCount;
	for (const e of events) {
		if (e.type === "system" && e.subtype === "init") {
			mcpStatus = e.mcp_servers?.find((s) => s.name === "polycarp")?.status;
			toolCount = e.tools?.filter((t) => t.startsWith("mcp__polycarp__")).length;
		}
		if (e.type === "assistant")
			for (const c of e.message?.content ?? []) {
				if (c.type === "tool_use") {
					const call = { tool: c.name.replace(/^mcp__polycarp__/, ""), args: c.input };
					byId.set(c.id, call);
					calls.push(call);
				}
				if (c.type === "text") final = c.text;
			}
		if (e.type === "user")
			for (const c of e.message?.content ?? []) {
				if (c.type !== "tool_result") continue;
				const call = byId.get(c.tool_use_id);
				if (!call) continue;
				const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
				call.error = c.is_error === true;
				call.chars = text.length;
				call.result = clip(text, 1200);
			}
		if (e.type === "result") result = e;
	}
	return {
		calls,
		final: result?.result ?? final,
		stop: extra.timedOut ? "timeout" : (result?.subtype ?? "no_result"),
		turns: result?.num_turns,
		ms: extra.ms,
		mcpStatus,
		toolCount,
		apiError: result?.is_error ? clip(String(result.result ?? ""), 400) : undefined,
		stderr: extra.timedOut || !result ? extra.stderr : undefined,
	};
}

async function scoreBrowser(task, mountId, run) {
	const why = [];
	let pass = true;
	if (task.state) {
		// The page's last posted state, read with the task's own expression; the page itself may be closed by now.
		const posted = await settledState(() => h.posted(mountId));
		let ok = false;
		try {
			ok = posted !== undefined && new Function("window", `return (${task.state});`)({ __state: posted }) === true;
		} catch (err) {
			why.push(`state: ${err.message.slice(0, 120)}`);
		}
		if (!ok) {
			pass = false;
			why.push(posted === undefined ? "page never reported state" : `page state not reached: ${JSON.stringify(posted).slice(0, 160)}`);
		}
	}
	if (task.handoff && !handedOff(run.calls)) {
		pass = false;
		why.push("no handoff to the user (tabs_show or ask_user)");
	}
	if (task.answer && !(task.answer.test(run.final) && (!task.answerAlso || task.answerAlso.test(run.final)))) {
		pass = false;
		why.push("answer missing or wrong");
	}
	return { pass, why };
}

async function scoreComputer(task, dir, run, before) {
	const why = [];
	let pass = true;
	if (task.windows || task.windowsTree) {
		let ok = false;
		try {
			const listed = await hands.call("windows", {});
			const wins = (listed.data?.windows ?? []).filter((w) => w.app === task.app && w.scope === "agent_workspace" && !before.has(w.pid));
			for (const w of wins) {
				const snap = await hands.call("snapshot", { window: w.id, depth: 40 });
				const tree = snap.data?.tree;
				if (task.windows ? task.windows(treeText(tree)) : task.windowsTree(tree)) ok = true;
			}
			if (!wins.length) why.push(`no ${task.app} window of this run on the agent workspace`);
		} catch (err) {
			why.push(`read back: ${err.message.slice(0, 160)}`);
		}
		if (!ok) {
			pass = false;
			why.push("window state not reached");
		}
	}
	if (task.file) {
		const body = existsSync(join(dir, task.file.name)) ? readFileSync(join(dir, task.file.name), "utf8") : "";
		if (!task.file.test(body)) {
			pass = false;
			why.push(`file not saved as asked (${JSON.stringify(body.slice(0, 80))})`);
		}
	}
	if (task.answer && !task.answer.test(run.final)) {
		pass = false;
		why.push("answer missing or wrong");
	}
	return { pass, why };
}

async function runOne(task, trial) {
	const session = sessionName(label, task.id, trial);
	let run;
	let score;
	if (task.kind === "browser") {
		const mountId = `${task.id}-${label}-${trial}`;
		const entry = `${h.mount(mountId, task.pages)}${(task.entry ?? "/").slice(1)}`;
		run = await runClaude(task.prompt(entry), session, wallBrowser);
		score = await scoreBrowser(task, mountId, run);
	} else {
		const dir = join(handoff, `weak-model-${process.pid}`, `${task.id}-${trial}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		for (const [name, body] of Object.entries(task.files ?? {})) writeFileSync(join(dir, name), body);
		const before = new Set((await hands.call("windows", {})).data?.windows?.map((w) => w.pid) ?? []);
		run = await runClaude(task.prompt(dir), session, wallComputer);
		const mine = ownPids(run.calls);
		for (const pid of mine) started.add(pid);
		score = await scoreComputer(task, dir, run, before);
		await killOwnCopies(mine);
		for (const pid of mine) started.delete(pid);
		rmSync(dir, { recursive: true, force: true });
	}
	if (run.apiError && QUOTA.test(run.apiError)) {
		stopAll = true;
		console.error(`STOP: the sign-in reported a limit: ${run.apiError}`);
	}
	if (run.mcpStatus && run.mcpStatus !== "connected") score.why.push(`mcp server ${run.mcpStatus}`);
	const record = { task: task.id, kind: task.kind, trial, model, pass: score.pass, why: score.why, ...(task.handoff ? { rule: "signup-v2" } : {}), ...run };
	writeFileSync(join(outDir, `${task.id}-t${trial}.json`), `${JSON.stringify(record, null, 1)}\n`);
	process.stderr.write(`${score.pass ? "pass" : "FAIL"} ${task.id} t${trial} ${Math.round(run.ms / 1000)}s ${run.calls.length} calls ${run.stop}${score.pass ? "" : ` (${score.why.join("; ")})`}\n`);
	return record;
}

const records = [];
try {
	if (h) await h.connected();
	const jobs = [];
	for (const task of chosen) for (let t = 1; t <= trials; t++) jobs.push({ task, t });
	const browserJobs = jobs.filter((j) => j.task.kind === "browser");
	const computerJobs = jobs.filter((j) => j.task.kind === "computer");
	// Browser runs share one headless Chromium, each in its own session and tab group.
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, browserJobs.length) }, async () => {
			while (next < browserJobs.length && !stopAll) {
				const j = browserJobs[next++];
				records.push(await runOne(j.task, j.t));
			}
		}),
	);
	// Computer runs one at a time: they share the agent workspace.
	for (const j of computerJobs) {
		if (stopAll) break;
		records.push(await runOne(j.task, j.t));
	}
} finally {
	hands?.close();
	if (needsComputer) restorePrefs();
	await h?.stop();
	rmSync(join(handoff, `weak-model-${process.pid}`), { recursive: true, force: true });
}

const summary = summarize(label, { model, trials, profile: profile || "full", date: new Date().toISOString(), stopped: stopAll });
console.log(`${label}: this run ${records.filter((r) => r.pass).length}/${records.length}, folder ${summary.passed}/${summary.total}${stopAll ? " (stopped early)" : ""}`);
rmSync(scratch, { recursive: true, force: true });
