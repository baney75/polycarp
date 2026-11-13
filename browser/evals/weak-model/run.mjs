// Weak-model eval: a small model does real tasks with Polycarp's MCP tools and nothing else, and each run
// is scored by machine. See README.md. Usage:
//   node evals/weak-model/run.mjs --label r1-haiku [--model claude-haiku-5-5] [--trials 2] [--kind browser|computer|all]
//        [--only id,id] [--concurrency 3] [--turns 30] [--wall 240] [--list]
// Tasks come from every tasks/*.mjs file (WM_TASKS_DIR overrides the folder); --list prints them and starts nothing.
// Needs `npm run build` at browser/ (dist-chrome) and in cli/, and a Playwright Chromium. Never calls an API key:
// the responder is `claude -p` under the signed-in Claude Code account.
//
// Everything the run makes registers its undo in one Cleanup the moment it exists (cleanup.mjs), and every way out
// runs it once, in reverse: the claude children's process groups and the app copies first, prefs and folders last.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupPrefs, Cleanup, onExits, restorePrefsOrKeep, spawnClaude, sweepCopies } from "./cleanup.mjs";
import { HandsClient, treeText } from "./hands.mjs";
import { childEnv, clashingIds, keepScored, keyVarsSet, loadTasks, mountId, positiveInt, safeId, sessionName, settledState, spacesBin } from "./lib.mjs";
import { handedOff } from "./signup-rule.mjs";
import { summarize } from "./summarize.mjs";
import { Transcript } from "./transcript.mjs";

/** Exit 2 with the reason, before anything is written or started. */
const refuse = (why) => {
	console.error(why);
	process.exit(2);
};

// A key variable makes claude -p bill an API key instead of the owner's sign-in: refuse before anything starts.
const keys = keyVarsSet(process.env);
if (keys.length) refuse(`refusing to start: ${keys.join(", ")} set; runs must use the Claude Code sign-in, so unset ${keys.length > 1 ? "them" : "it"}`);

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "cli", "dist", "index.js");

const argv = process.argv.slice(2);
/** An option's value; a bare option (last, or followed by another --option) is refused. */
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const v = argv[i + 1];
	if (v === undefined || v.startsWith("--")) refuse(`--${name} needs a value`);
	return v;
};
const int = (name, fallback) => {
	const r = positiveInt(name, opt(name, fallback));
	if (r.error) refuse(r.error);
	return r.n;
};
const model = opt("model", "claude-haiku-5-5");
const label = opt("label", `run-${model.replace(/^claude-/, "")}`);
// The label names the results folder: no path parts, and the same name the mount and session use.
if (safeId(label) !== label) refuse(`--label takes lower-case letters, digits, _ and -, not ${JSON.stringify(label)}`);
const trials = int("trials", "2");
// Computer runs open real apps on the owner's Mac. They are off until the lead turns them back on with
// WM_ALLOW_COMPUTER=1; until then every run is browser only and its server lists no computer tools.
const allowComputer = process.env.WM_ALLOW_COMPUTER === "1";
const kind = opt("kind", allowComputer ? "all" : "browser");
if (!["browser", "computer", "all"].includes(kind)) refuse(`--kind takes browser, computer or all, not ${JSON.stringify(kind)}`);
const only = opt("only", "")
	.split(",")
	.filter(Boolean);
const concurrency = int("concurrency", "3");
const turns = int("turns", "30");
const wallBrowser = int("wall", "240") * 1000;
const wallComputer = int("wall-computer", "300") * 1000;
const profile = opt("profile", "");

const tasksDir = process.env.WM_TASKS_DIR || join(here, "tasks");
const all = await loadTasks(tasksDir);
if (!all.length) refuse(`no tasks: ${tasksDir} has no task files (each tasks/*.mjs exports an array of { id, kind, prompt, ... })`);
const clash = clashingIds(all.map((t) => t.id));
if (clash) refuse(`task ids ${clash[0]} and ${clash[1]} share the page path ${clash[2]}: rename one`);
const unknown = only.filter((id) => !all.some((t) => t.id === id));
if (unknown.length) refuse(`unknown task: ${unknown.join(", ")}`);
const chosen = all.filter((t) => (kind === "all" || t.kind === kind) && (!only.length || only.includes(t.id)));
if (!chosen.length) {
	const off = !allowComputer && opt("kind") === undefined && only.length ? " (computer tasks are off without WM_ALLOW_COMPUTER=1, so --kind is browser)" : "";
	refuse(`no task matches --kind ${kind}${only.length ? ` and --only ${only.join(",")}` : ""}${off}`);
}
if (argv.includes("--list")) {
	for (const t of chosen) console.log(`${t.kind}\t${t.id}`);
	process.exit(0);
}

const needsBrowser = chosen.some((t) => t.kind === "browser");
const needsComputer = chosen.some((t) => t.kind === "computer");
if (needsComputer && !allowComputer) refuse("computer tasks are switched off (they open apps on the owner's Mac); set WM_ALLOW_COMPUTER=1 only when the lead says so");
// The computer tools go through a helper wrapper: connector mode, so the model is held to the agent workspace
// and lent apps whatever access mode this Mac has (Full Access included), and the real HOME the helper needs.
const helper = [join(homedir(), ".local", "bin", "polycarp-spaces"), join(homedir(), "Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces"), "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces"].find(existsSync);
if (needsComputer && (!helper || process.platform !== "darwin")) refuse("computer tasks need polycarp-spaces on a Mac; run with --kind browser");

const cleanup = new Cleanup();
const { leave, fail } = onExits(cleanup);
/** Set by a quota limit; a stop by signal shows as cleanup.closing. Either way no new run starts. */
let stopAll = false;
const stopping = () => stopAll || cleanup.closing;

// Scratch holds the MCP configs, the helper wrapper and the prefs backups: removed last, and kept when a restore failed.
const scratch = mkdtempSync(join(tmpdir(), "wm-eval-"));
let keepScratch = false;
cleanup.add(`scratch ${scratch}`, () => {
	if (keepScratch) console.error(`scratch kept at ${scratch}`);
	else rmSync(scratch, { recursive: true, force: true });
});
const emptyCwd = join(scratch, "cwd");
mkdirSync(emptyCwd);
const wrapper = join(scratch, "spaces-connector.sh");
if (helper) writeFileSync(wrapper, `#!/bin/sh\nHOME='${homedir()}' exec '${helper}' mcp --connector\n`, { mode: 0o755 });
const handoff = join(homedir(), "Library", "Application Support", "Polycarp", "hands", "handoff");
const outDir = join(here, "results", label);

let h;
let serverEnv;
let hands;
const records = [];
const jobs = [];
for (const task of chosen) for (let t = 1; t <= trials; t++) jobs.push({ task, t });

/** Closes one app copy this run's own computer_open started; never one the owner or another session opened. */
async function killCopy(pid) {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	await new Promise((r) => setTimeout(r, 1500));
	try {
		process.kill(pid, 0);
		process.kill(pid, "SIGKILL");
	} catch {}
}

function mcpConfig(session, kind) {
	const config = {
		mcpServers: {
			polycarp: {
				command: process.execPath,
				args: [cli, "mcp", "--session", session, ...(profile ? ["--profile", profile] : [])],
				env: { ...serverEnv, PATH: process.env.PATH ?? "", TABKYRA_CLIENT_NAME: "weak-model", POLYCARP_SPACES_BIN: spacesBin(kind, { allowComputer, wrapper: helper && wrapper, none: join(scratch, "no-computer-helper") }) },
			},
		},
	};
	const file = join(scratch, `${session}.mcp.json`);
	writeFileSync(file, JSON.stringify(config));
	return file;
}

/**
 * One claude -p run; returns the compact transcript and the undo of each app copy it started. A copy registers its
 * undo as its computer_open answer streams in, so a stop mid-run still closes it.
 */
async function runClaude(prompt, session, kind, wallMs) {
	const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--mcp-config", mcpConfig(session, kind), "--strict-mcp-config", "--setting-sources", "project", "--tools", "", "--allowedTools", "mcp__polycarp", "--max-turns", String(turns), "--no-session-persistence"];
	const copies = [];
	const transcript = new Transcript({ onStarted: (pid) => copies.push(cleanup.add(`app copy ${pid}`, () => killCopy(pid))) });
	const { child, closed, killGroup } = spawnClaude(args, { cleanup, cwd: emptyCwd, env: childEnv(process.env) });
	let buf = "";
	let stderr = "";
	child.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			transcript.push(e);
		}
	});
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	const start = Date.now();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void killGroup();
	}, wallMs);
	try {
		await closed;
	} finally {
		clearTimeout(timer);
	}
	return { run: transcript.done({ timedOut, ms: Date.now() - start, stderr: stderr.slice(-2000) }), copies, pids: () => new Set(transcript.calls.map((c) => c.startedPid).filter(Boolean)) };
}

async function scoreBrowser(task, mount, run) {
	const why = [];
	let pass = true;
	if (task.state) {
		// The page's last posted state, read with the task's own expression; the page itself may be closed by now.
		const posted = await settledState(() => h.posted(mount));
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


/** A usage limit stops the round: no new run starts, and the run that hit it is no result. */
const onLimit = (err) => {
	stopAll = true;
	console.error(`STOP: the sign-in reported a limit: ${err}`);
};
const keep = (run, score) => keepScored(run, score, { closing: () => cleanup.closing, onLimit });

/**
 * One task trial, or undefined when it is no result: a stop (signal or usage limit) before or during scoring. Such a
 * run writes no record, so it never replaces a committed one.
 */
async function runOne(task, trial) {
	const session = sessionName(label, task.id, trial);
	let run;
	let score;
	if (task.kind === "browser") {
		const mount = mountId(label, task.id, trial);
		const entry = `${h.mount(mount, task.pages)}${(task.entry ?? "/").slice(1)}`;
		const result = await runClaude(task.prompt(entry), session, "browser", wallBrowser);
		run = result.run;
		try {
			score = await keep(run, () => scoreBrowser(task, mount, run));
		} finally {
			// A browser run has no computer tools, so it starts no copies; close any all the same, before the next run.
			await Promise.all(result.copies.map((c) => c.undo()));
		}
	} else {
		const dir = join(handoff, `weak-model-${process.pid}`, `${task.id}-${trial}`);
		const folder = cleanup.add(`fixture folder ${dir}`, () => rmSync(dir, { recursive: true, force: true }));
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		for (const [name, body] of Object.entries(task.files ?? {})) writeFileSync(join(dir, name), body);
		const before = new Set((await hands.call("windows", {})).data?.windows?.map((w) => w.pid) ?? []);
		let pids = () => new Set();
		const sweep = sweepCopies(cleanup, { app: task.app, before, known: () => pids(), list: async () => (await hands.call("windows", {})).data?.windows ?? [], kill: killCopy });
		const result = await runClaude(task.prompt(dir), session, "computer", wallComputer);
		pids = result.pids;
		run = result.run;
		// A run that ended on its own reported every copy it started; one cut off at the wall cap may have a launch in
		// flight, so it sweeps now. On a signal the sweep stays registered and cleanup runs it, before the helper line closes.
		if (cleanup.closing) return undefined;
		if (run.stop === "timeout") await sweep.undo();
		else sweep.release();
		try {
			score = await keep(run, () => scoreComputer(task, dir, run, before));
		} finally {
			await Promise.all(result.copies.map((c) => c.undo()));
			await folder.undo();
		}
	}
	if (!score) return undefined;
	if (run.mcpStatus && run.mcpStatus !== "connected") score.why.push(`mcp server ${run.mcpStatus}`);
	const record = { task: task.id, kind: task.kind, trial, model, pass: score.pass, why: score.why, ...(task.handoff ? { rule: "signup-v2" } : {}), ...run };
	writeFileSync(join(outDir, `${task.id}-t${trial}.json`), `${JSON.stringify(record, null, 1)}\n`);
	process.stderr.write(`${score.pass ? "pass" : "FAIL"} ${task.id} t${trial} ${Math.round(run.ms / 1000)}s ${run.calls.length} calls ${run.stop}${score.pass ? "" : ` (${score.why.join("; ")})`}\n`);
	return record;
}

async function main() {
	mkdirSync(outDir, { recursive: true });
	if (needsBrowser) {
		const { startHarness } = await import("../../cli/test/e2e-harness.mjs");
		h = await startHarness();
		cleanup.add("headless Chromium", () => h.stop());
		serverEnv = { HOME: h.home, XDG_CONFIG_HOME: join(h.home, ".config"), TABKYRA_SOCKET_DIR: h.socketDir, TABKYRA_AUTO_ALLOW: "1" };
	} else {
		const socketDir = mkdtempSync("/tmp/wmsk-");
		cleanup.add(`socket dir ${socketDir}`, () => rmSync(socketDir, { recursive: true, force: true }));
		serverEnv = { HOME: join(scratch, "home"), TABKYRA_SOCKET_DIR: socketDir, TABKYRA_AUTO_ALLOW: "1" };
		mkdirSync(serverEnv.HOME, { recursive: true });
	}
	if (needsComputer) {
		const runHandoff = join(handoff, `weak-model-${process.pid}`);
		cleanup.add(`handoff folder ${runHandoff}`, () => rmSync(runHandoff, { recursive: true, force: true }));
		const backup = backupPrefs(["com.apple.calculator", "com.apple.TextEdit", "com.apple.Preview"], { exec: (cmd, a) => execFileSync(cmd, a, { stdio: "pipe" }), dir: scratch });
		const keepDir = join(homedir(), ".local", "state", "polycarp-weak-model", `prefs-${new Date().toISOString().replace(/[:.]/g, "-")}`);
		cleanup.add("app preferences", () => {
			// Scratch holds the backups: it is kept unless every restore is known to have worked.
			keepScratch = true;
			if (restorePrefsOrKeep(backup, { exec: (cmd, a) => execFileSync(cmd, a, { stdio: "ignore" }), keepDir })) keepScratch = false;
		});
		hands = new HandsClient(helper);
		cleanup.add("helper line", () => hands.close());
	}
	if (h) await h.connected();
	const browserJobs = jobs.filter((j) => j.task.kind === "browser");
	const computerJobs = jobs.filter((j) => j.task.kind === "computer");
	// Browser runs share one headless Chromium, each in its own session and tab group.
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, browserJobs.length) }, async () => {
			while (next < browserJobs.length && !stopping()) {
				const j = browserJobs[next++];
				const r = await runOne(j.task, j.t);
				if (r) records.push(r);
			}
		}),
	);
	// Computer runs one at a time: they share the agent workspace.
	for (const j of computerJobs) {
		if (stopping()) break;
		const r = await runOne(j.task, j.t);
		if (r) records.push(r);
	}
	// Stopped by a signal: cleanup is running and the exit code is already set; the round is left as it was.
	if (cleanup.closing) return 130;
	// A rerun of some tasks (--only) or one that stopped early never marks its kinds complete; a browser half that made
	// every job clears only the browser stop mark, never one the computer half left.
	const complete = !stopAll && !only.length && records.length === jobs.length;
	const kinds = [...new Set(chosen.map((t) => t.kind))];
	const summary = summarize(label, { profile: profile || "full", date: new Date().toISOString(), stopped: stopAll, complete, kinds });
	console.log(`${label}: this run ${records.filter((r) => r.pass).length}/${records.length}, folder ${summary.passed}/${summary.total}${stopAll ? " (stopped early)" : ""}`);
	return 0;
}

main().then((code) => leave(code), fail);
