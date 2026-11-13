// The weak-model runner's own logic (evals/weak-model/README.md). CI never calls a model: these hold the parts that
// decide which account a run bills, which session and app copies it owns, and how its runs are scored and kept.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HandsClient } from "../evals/weak-model/hands.mjs";
import { afterComputerRun, backupPrefs, Cleanup, ClearError, leftOpen, onExits, restorePrefsOrKeep, spawnClaude } from "../evals/weak-model/cleanup.mjs";
import { checkClasses, checkRound, childEnv, KEY_VARS, keepScored, keyVarsSet, mountId, safeId, sessionName, settledState, spacesBin } from "../evals/weak-model/lib.mjs";
import { Transcript } from "../evals/weak-model/transcript.mjs";
import { handedOff, rescoreSignup } from "../evals/weak-model/signup-rule.mjs";
import { loadRuns, summarize } from "../evals/weak-model/summarize.mjs";

const run = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "weak-model", "run.mjs");
const cleanEnv = (extra = {}) => ({ ...childEnv(process.env), ...extra });
const list = (env) => spawnSync(process.execPath, [run, "--list"], { env: cleanEnv(env), encoding: "utf8", timeout: 30_000 });

test("run.mjs --list starts at this commit: its own tasks folder, an empty one with a clear message, a fixture one", () => {
	const own = list();
	assert.doesNotMatch(own.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, own.stderr);
	assert.ok(own.status === 0 || (own.status === 2 && /no tasks/.test(own.stderr)), `exit ${own.status}: ${own.stderr}`);

	const empty = list({ WM_TASKS_DIR: mkdtempSync(join(tmpdir(), "wm-none-")) });
	assert.equal(empty.status, 2);
	assert.match(empty.stderr, /no tasks: .* has no task files/);

	const dir = mkdtempSync(join(tmpdir(), "wm-tasks-"));
	writeFileSync(join(dir, "demo.mjs"), `export const demo = [{ id: "demo", kind: "browser", prompt: (u) => u }];\nexport const helper = () => 1;\n`);
	const one = list({ WM_TASKS_DIR: dir });
	assert.equal(one.status, 0, one.stderr);
	assert.equal(one.stdout, "browser\tdemo\n");
});

test("a key variable in the parent stops the run before anything starts, and never reaches claude -p", () => {
	const dir = mkdtempSync(join(tmpdir(), "wm-tasks-"));
	writeFileSync(join(dir, "demo.mjs"), `export const demo = [{ id: "demo", kind: "browser", prompt: (u) => u }];\n`);
	const r = list({ WM_TASKS_DIR: dir, ANTHROPIC_API_KEY: "dummy-not-a-key" });
	assert.equal(r.status, 2);
	assert.match(r.stderr, /refusing to start: ANTHROPIC_API_KEY set/);
	assert.equal(r.stdout, "", "nothing listed or started");

	const parent = Object.fromEntries(KEY_VARS.map((k) => [k, "x"]));
	assert.deepEqual(keyVarsSet({ ...parent, HOME: "/h" }), KEY_VARS);
	assert.deepEqual(keyVarsSet({ ANTHROPIC_API_KEY: "" }), [], "an empty variable is not a key");
	const env = childEnv({ ...parent, HOME: "/h", PATH: "/bin" });
	assert.deepEqual(env, { HOME: "/h", PATH: "/bin" });
	for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) assert.ok(KEY_VARS.includes(k), k);
});

test("the scorer waits for a POST that lands after claude exits, past the old fixed 600 ms", async () => {
	const early = { step: 1 };
	const late = { step: 2, done: true };
	const t0 = Date.now();
	// The last POST lands 1.2 s after claude exited: the old fixed 600 ms sleep scored the earlier state.
	const got = await settledState(() => (Date.now() - t0 < 1200 ? early : late));
	assert.equal(got, late);
	const quiet = Date.now();
	assert.equal(await settledState(() => early, { quietMs: 200, deadlineMs: 5000, stepMs: 50 }), early);
	assert.ok(Date.now() - quiet < 1000, "a quiet page settles at the quiet window, not the deadline");
});

test("the scorer's helper line sends notifications/initialized before its first call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wm-hands-"));
	const helper = join(dir, "fake-helper");
	// A spec-strict helper: tools/call before notifications/initialized is an error.
	writeFileSync(
		helper,
		`#!${process.execPath}
let ready = false;
require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
	const m = JSON.parse(l);
	const say = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }) + "\\n");
	if (m.method === "initialize") say({ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
	else if (m.method === "notifications/initialized") ready = true;
	else if (m.method === "tools/call") say(ready ? { result: { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { windows: [] } }) }] } } : { error: { code: -32002, message: "not initialized" } });
});
`,
	);
	chmodSync(helper, 0o755);
	const hands = new HandsClient(helper);
	try {
		assert.deepEqual(await hands.call("windows", {}), { ok: true, data: { windows: [] } });
	} finally {
		hands.close();
	}
});

const round = () => {
	const root = mkdtempSync(join(tmpdir(), "wm-results-"));
	mkdirSync(join(root, "r9"));
	return root;
};
const rec = (task, trial, pass, extra = {}) => ({ task, trial, kind: "browser", model: "m", pass, why: [], calls: [], ...extra });

test("a partial rerun replaces only its own runs in the committed round", () => {
	const root = round();
	writeFileSync(join(root, "r9", "runs.jsonl"), `${[rec("a", 1, true), rec("a", 2, false), rec("b", 1, true)].map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(join(root, "r9", "a-t2.json"), JSON.stringify(rec("a", 2, true, { fresh: true })));
	const runs = loadRuns("r9", root);
	assert.deepEqual(
		runs.map((r) => [r.task, r.trial, r.pass]),
		[
			["a", 1, true],
			["a", 2, true],
			["b", 1, true],
		],
	);
	assert.equal(runs[1].fresh, true);
	const s = summarize("r9", { root });
	assert.equal(s.total, 3);
	assert.equal(readFileSync(join(root, "r9", "runs.jsonl"), "utf8").trim().split("\n").length, 3);
});

test("a handoff counts only when its call returned without error", () => {
	assert.equal(handedOff([{ tool: "tabs_show", args: {} }]), false, "in flight at timeout: no result recorded");
	assert.equal(handedOff([{ tool: "tabs_show", error: true }]), false);
	assert.equal(handedOff([{ tool: "tabs_show", error: false }]), true);
	assert.equal(handedOff([{ tool: "more_tools", error: false, args: { name: "ask_user", arguments: {} } }]), true);
});

test("the rescore does not read 'unchecked' or 'none' as accepting the terms", () => {
	const page = { tool: "read_page", error: false, result: 'e1 checkbox "I accept the terms"' };
	for (const value of ["unchecked", "none"]) assert.ok(rescoreSignup({ calls: [page, { tool: "fill", error: false, args: { ref: "e1", value } }] }).includes("terms not accepted"), value);
	assert.ok(!rescoreSignup({ calls: [page, { tool: "fill", error: false, args: { ref: "e1", value: "checked" } }] }).includes("terms not accepted"));
});

// ---------- one cleanup registry, run once from every way out ----------

/** A registry of three named undos that record the order they ran in. */
function registry() {
	const ran = [];
	const logged = [];
	const cleanup = new Cleanup({ log: (l) => logged.push(l) });
	for (const name of ["scratch", "chromium", "claude"]) cleanup.add(name, () => ran.push(name));
	return { cleanup, ran, logged };
}

test("cleanup runs every undo in reverse, once, and still runs one added after it began", async () => {
	const { cleanup, ran } = registry();
	const gone = cleanup.add("closed early", () => ran.push("closed early"));
	await gone.undo();
	await Promise.all([cleanup.run(), cleanup.run()]);
	assert.deepEqual(ran, ["closed early", "claude", "chromium", "scratch"]);
	cleanup.add("late pid", () => ran.push("late pid"));
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(ran.slice(-1), ["late pid"], "an app copy seen during cleanup is still closed");
	await cleanup.run();
	assert.equal(ran.length, 5, "a second run undoes nothing again");
});

for (const [event, code, arg] of [
	["SIGINT", 130],
	["SIGTERM", 143],
	["SIGHUP", 129],
	["uncaughtException", 1, new Error("boom")],
	["unhandledRejection", 1, new Error("lost")],
]) {
	test(`${event}: cleanup runs once in reverse, then the run exits ${code}`, async () => {
		const { cleanup, ran } = registry();
		const proc = new EventEmitter();
		const exits = [];
		const lines = [];
		onExits(cleanup, { proc, exit: (c) => exits.push([c, [...ran]]), log: (l) => lines.push(l) });
		proc.emit(event, arg);
		proc.emit(event, arg);
		await cleanup.run();
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(exits, [[code, ["claude", "chromium", "scratch"]]], "exit comes after the whole cleanup, once");
		assert.equal(lines.length, 1, lines.join("\n"));
	});
}

test("a normal end and a thrown error leave through the same once-only cleanup", async () => {
	for (const [how, code] of [
		["end", 0],
		["throw", 1],
	]) {
		const { cleanup, ran } = registry();
		const exits = [];
		const { leave, fail } = onExits(cleanup, { proc: new EventEmitter(), exit: (c) => exits.push(c), log: () => {} });
		await (how === "end" ? leave(0) : fail(new Error("x")));
		await leave(0);
		assert.deepEqual(ran, ["claude", "chromium", "scratch"], how);
		assert.deepEqual(exits, [code], how);
	}
});

/** A stand-in for spawn: a child with a pid, streams and a recorded kill. */
function fakeSpawn() {
	const made = [];
	const spawnFn = (cmd, args, opts) => {
		const child = new EventEmitter();
		child.pid = 4242;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		made.push({ cmd, opts, child });
		return child;
	};
	return { made, spawnFn };
}

test("claude -p runs in its own process group, and cleanup kills the whole group", async () => {
	const { made, spawnFn } = fakeSpawn();
	const kills = [];
	const cleanup = new Cleanup({ log: () => {} });
	const { closed } = spawnClaude(["-p", "x"], { cleanup, cwd: "/", env: {}, spawnFn, kill: (pid, sig) => sig !== 0 && kills.push([pid, sig]), graceMs: 10 });
	assert.equal(made[0].opts.detached, true, "a group of its own");
	await cleanup.run();
	assert.deepEqual(kills, [
		[-4242, "SIGTERM"],
		[-4242, "SIGKILL"],
	]);
	made[0].child.emit("close", 0);
	assert.equal(await closed, 0);
	assert.equal(kills.length, 2, "killed once");
});

test("claude not on PATH: one clear line, cleanup, then a non-zero exit", async () => {
	const { made, spawnFn } = fakeSpawn();
	const { cleanup, ran } = registry();
	const order = [];
	const { fail } = onExits(cleanup, { proc: new EventEmitter(), exit: (c) => order.push(`exit ${c}`), log: (l) => order.push(l) });
	const { closed } = spawnClaude(["-p", "x"], { cleanup, cwd: "/", env: {}, spawnFn, kill: () => {}, graceMs: 10 });
	made[0].child.pid = undefined;
	made[0].child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
	await closed.then(
		() => assert.fail("closed should reject"),
		async (err) => {
			assert.ok(err instanceof ClearError);
			await fail(err);
		},
	);
	assert.deepEqual(order, ["claude not found on PATH: install Claude Code or put it on PATH, then run again", "exit 1"]);
	assert.deepEqual(ran, ["claude", "chromium", "scratch"]);
});

// ---------- the copies a run started, known as their answers stream in ----------

const toolUse = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__polycarp__${name}`, input }] } });
const toolResult = (id, text, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });
const opened = (data) => JSON.stringify({ ok: true, data });

test("a started copy is recorded the moment its answer arrives: long answers and more_tools included", () => {
	const seen = [];
	const t = new Transcript({ onStarted: (pid) => seen.push(pid) });
	t.push(toolUse("a", "computer_open", { app: "TextEdit" }));
	t.push(toolResult("a", opened({ app: "TextEdit", pid: 101, reused: false, windows: "x".repeat(5000) })));
	assert.deepEqual(seen, [101], "before claude exits, from a 5,000-character answer");
	assert.match(t.calls[0].result, /more chars\]$/, "the record is still clipped");
	t.push(toolUse("b", "more_tools", { name: "computer_open", arguments: { app: "Preview" } }));
	t.push(toolResult("b", opened({ app: "Preview", pid: 202, reused: false })));
	t.push(toolUse("c", "computer_open", { app: "Calculator" }));
	t.push(toolResult("c", opened({ app: "Calculator", pid: 303, reused: true })));
	t.push(toolUse("d", "computer_open", { app: "Calculator" }));
	t.push(toolResult("d", opened({ app: "Calculator", pid: 404, reused: false }), true));
	t.push(toolUse("e", "computer_windows", {}));
	t.push(toolResult("e", opened({ windows: [{ pid: 505 }] })));
	assert.deepEqual(seen, [101, 202], "never a reused copy, an error or a window read");
});

test("a failed prefs restore keeps the backups in a named folder and keeps scratch", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "wm-scratch-"));
	const file = join(scratch, "com.apple.TextEdit.plist");
	writeFileSync(file, "plist");
	const keepDir = join(mkdtempSync(join(tmpdir(), "wm-keep-")), "prefs-1");
	const lines = [];
	const cleanup = new Cleanup({ log: () => {} });
	let keep = false;
	cleanup.add("scratch", () => {
		if (!keep) rmSync(scratch, { recursive: true, force: true });
	});
	cleanup.add("app preferences", () => {
		keep = !restorePrefsOrKeep([{ domain: "com.apple.TextEdit", file }], {
			exec: () => {
				throw new Error("rejected");
			},
			keepDir,
			log: (l) => lines.push(l),
		});
	});
	await cleanup.run();
	assert.deepEqual(readdirSync(keepDir), ["com.apple.TextEdit.plist"]);
	assert.ok(existsSync(file), "scratch is kept when a restore failed");
	assert.match(lines.join("\n"), new RegExp(`kept at ${keepDir}`));
	const ran = [];
	assert.equal(restorePrefsOrKeep([{ domain: "a", file: "/b/a.plist" }, { domain: "c", absent: true }, { domain: "d", absent: false }], { exec: (c, a) => ran.push([c, ...a].join(" ")), keepDir: "/never" }), true);
	assert.deepEqual(ran, ["defaults import a /b/a.plist", "defaults delete c"]);
});

// ---------- honest summaries ----------

test("only a run that made every job clears stopped; model and trials come from the runs", () => {
	const root = round();
	writeFileSync(join(root, "r9", "runs.jsonl"), `${[rec("a", 1, true), rec("a", 2, true), rec("b", 1, true), rec("b", 2, false)].map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(join(root, "r9", "summary.json"), JSON.stringify({ stopped: true, model: "m", trials: 2 }));
	writeFileSync(join(root, "r9", "a-t1.json"), JSON.stringify(rec("a", 1, true, { model: "m" })));
	const partial = summarize("r9", { root, stopped: false, complete: false });
	assert.equal(partial.stopped, true, "a --only rerun keeps the mark");
	assert.equal(partial.trials, 2, "a --trials 1 rerun doesn't rewrite the round's trials");
	assert.equal(partial.model, "m");
	assert.equal(summarize("r9", { root }).stopped, true, "a bare rebuild keeps it");
	assert.equal(summarize("r9", { root, stopped: false, complete: true }).stopped, undefined);
	assert.equal(summarize("r9", { root, stopped: true, complete: false }).stopped, true);
	writeFileSync(join(root, "r9", "b-t2.json"), JSON.stringify(rec("b", 2, true, { model: "s" })));
	assert.equal(summarize("r9", { root }).model, "m,s", "a mixed round names both models");
});

test("bad numbers, an unknown --kind or an empty selection exit 2 with the reason and write nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "wm-tasks-"));
	writeFileSync(join(dir, "demo.mjs"), `export const demo = [{ id: "demo", kind: "browser", prompt: (u) => u }, { id: "calc", kind: "computer", prompt: (u) => u }];\n`);
	const label = `wm-test-${process.pid}`;
	// A claude that refuses, first on PATH: should a check ever slip past, no real claude -p starts on the sign-in.
	const bin = mkdtempSync(join(tmpdir(), "wm-bin-"));
	writeFileSync(join(bin, "claude"), "#!/bin/sh\necho 'test claude: a bad option got past the checks' >&2\nexit 3\n");
	chmodSync(join(bin, "claude"), 0o755);
	const escaped = join(dirname(run), "..", `wm-escape-${process.pid}`);
	for (const [args, why] of [
		[["--label", `../../wm-escape-${process.pid}`], /--label takes lower-case letters, digits, _ and -/],
		[["--label", "R2 haiku"], /--label takes/],
		[["--only"], /--only needs a value/],
		[["--only", "--trials", "1"], /--only needs a value/],
		[["--model"], /--model needs a value/],
		[["--trials", "two"], /--trials takes a whole number above 0, not "two"/],
		[["--concurrency", "x"], /--concurrency takes/],
		[["--turns", "0"], /--turns takes/],
		[["--wall", "1.5"], /--wall takes/],
		[["--kind", "brwser"], /--kind takes browser, computer or all, not "brwser"/],
		[["--only", "calc"], /no task matches --kind browser and --only calc \(computer tasks are off/],
	]) {
		const r = spawnSync(process.execPath, [run, ...(args.includes("--label") ? [] : ["--label", label]), ...args], { env: cleanEnv({ WM_TASKS_DIR: dir, WM_ALLOW_COMPUTER: "", PATH: `${bin}:${process.env.PATH}` }), encoding: "utf8", timeout: 30_000 });
		assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
		assert.match(r.stderr, why);
		assert.equal(r.stdout, "");
	}
	assert.equal(existsSync(join(dirname(run), "results", label)), false, "no results folder");
	assert.equal(existsSync(escaped), false, "nothing written outside results/");
});

test("two task ids that name the same page path stop the run before it starts", () => {
	const dir = mkdtempSync(join(tmpdir(), "wm-tasks-"));
	writeFileSync(join(dir, "demo.mjs"), `export const demo = [{ id: "Wizard", kind: "browser", prompt: (u) => u }, { id: "wizard", kind: "browser", prompt: (u) => u }];\n`);
	const r = spawnSync(process.execPath, [run, "--list"], { env: cleanEnv({ WM_TASKS_DIR: dir }), encoding: "utf8", timeout: 30_000 });
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stderr, /Wizard and wizard share the page path wizard/);
});

test("one sanitizer names the mount and the session; the session keeps its trial and hash", () => {
	assert.equal(safeId("r2 Haiku/1"), "r2-haiku-1");
	assert.equal(mountId("r2 haiku", "wizard", 1), "wizard-r2-haiku-1", "no %20 between the page's POST and the scorer's lookup");
	const long = "a-task-id-of-sixty-characters-that-goes-on-and-on-and-on-xyz";
	const a = sessionName("r1-haiku", long, 1);
	const b = sessionName("r2-haiku", long, 1);
	const c = sessionName("r1-haiku", long, 2);
	assert.ok([a, b, c].every((s) => s.length <= 64 && /^[a-z0-9_-]+$/.test(s)), [a, b, c].join(" "));
	assert.notEqual(a, b, "labels stay apart however long the task id");
	assert.notEqual(a, c, "trials stay apart");
	assert.match(a, /-1-[0-9a-f]{8}$/);
	assert.notEqual(sessionName("x", "wizard", 1), sessionName("x", "pagination", 1));
});

// ---------- round 2 of #186 ----------

test("a browser run's server never gets the computer tools, even with computer runs on", () => {
	const o = { allowComputer: true, wrapper: "/s/spaces-connector.sh", none: "/s/no-computer-helper" };
	assert.equal(spacesBin("browser", o), o.none);
	assert.equal(spacesBin("computer", o), o.wrapper);
	assert.equal(spacesBin("computer", { ...o, allowComputer: false }), o.none);
	assert.equal(spacesBin("computer", { ...o, wrapper: undefined }), o.none);
});

test("a stop during scoring or a usage limit keeps no record; another API error is still a result", async () => {
	let closing = false;
	const limits = [];
	const opts = { closing: () => closing, onLimit: (e) => limits.push(e) };
	assert.deepEqual(await keepScored({}, async () => ({ pass: true }), opts), { pass: true });
	const cutOff = await keepScored(
		{},
		async () => {
			closing = true;
			return { pass: false, why: ["read back: helper line closed"] };
		},
		opts,
	);
	assert.equal(cutOff, undefined, "a signal while scoring");
	closing = false;
	let scored = false;
	const limited = await keepScored(
		{ apiError: "Claude AI usage limit reached" },
		async () => {
			scored = true;
			return { pass: false };
		},
		opts,
	);
	assert.equal(limited, undefined, "a usage limit measured the quota, not the model");
	assert.equal(scored, false);
	assert.deepEqual(limits, ["Claude AI usage limit reached"]);
	assert.deepEqual(await keepScored({ apiError: "Overloaded" }, async () => ({ pass: false }), opts), { pass: false });
});

test("a stopped half keeps the round stopped until that half finishes", () => {
	const root = round();
	writeFileSync(join(root, "r9", "runs.jsonl"), `${JSON.stringify(rec("a", 1, true))}\n`);
	assert.equal(summarize("r9", { root, kinds: ["computer"], stopped: true, complete: false }).stopped, true);
	const browser = summarize("r9", { root, kinds: ["browser"], stopped: false, complete: true });
	assert.equal(browser.stopped, true, "a finished browser half doesn't clear the computer half's stop");
	assert.deepEqual(browser.stoppedKinds, ["computer"]);
	const both = summarize("r9", { root, kinds: ["computer"], stopped: false, complete: true });
	assert.equal(both.stopped, undefined);
	assert.equal(both.stoppedKinds, undefined);
	writeFileSync(join(root, "r9", "summary.json"), JSON.stringify({ stopped: true }));
	assert.equal(summarize("r9", { root, kinds: ["browser"], stopped: false, complete: true }).stopped, true, "an old mark with no kinds counts for both");
});

test("when the backups can't be copied out either, the restore still reports failure", () => {
	const scratch = mkdtempSync(join(tmpdir(), "wm-scratch-"));
	const file = join(scratch, "com.apple.TextEdit.plist");
	writeFileSync(file, "plist");
	const blocker = join(scratch, "not-a-folder");
	writeFileSync(blocker, "x");
	const lines = [];
	let kept;
	assert.doesNotThrow(() => {
		kept = restorePrefsOrKeep([{ domain: "com.apple.TextEdit", file }], {
			exec: () => {
				throw new Error("rejected");
			},
			keepDir: join(blocker, "prefs-1"),
			log: (l) => lines.push(l),
		});
	});
	assert.equal(kept, false, "so the caller keeps scratch");
	assert.match(lines.join("\n"), new RegExp(`could not copy the backups to .*; they stay at ${scratch}`));
});

test("a backup that fails for a domain that exists stops the computer run before it starts", () => {
	const dir = mkdtempSync(join(tmpdir(), "wm-prefs-"));
	const exec = (cmd, [verb, domain]) => {
		if (verb === "export") throw new Error("export failed");
		if (domain === "com.gone") throw Object.assign(new Error("read"), { stderr: "Domain com.gone does not exist" });
	};
	assert.deepEqual(backupPrefs(["com.gone"], { exec, dir }), [{ domain: "com.gone", file: undefined, absent: true }]);
	assert.throws(() => backupPrefs(["com.here"], { exec, dir }), (err) => err instanceof ClearError && /could not back up com\.here/.test(err.message));
});

test("after claude exits, its group gets the grace period before SIGKILL", async () => {
	const { made, spawnFn } = fakeSpawn();
	const sent = [];
	let alive = 2;
	const kill = (pid, sig) => {
		sent.push(sig);
		if (sig === 0 && alive-- <= 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
	};
	const { closed } = spawnClaude(["-p", "x"], { cleanup: new Cleanup({ log: () => {} }), cwd: "/", env: {}, spawnFn, kill, graceMs: 2000 });
	made[0].child.emit("close", 0);
	assert.equal(await closed, 0);
	assert.deepEqual(sent, ["SIGTERM", 0, 0, 0], "probed until the group left within the grace period: no SIGKILL");
	const late = fakeSpawn();
	const lateSent = [];
	const { closed: lateClosed } = spawnClaude(["-p", "x"], { cleanup: new Cleanup({ log: () => {} }), cwd: "/", env: {}, spawnFn: late.spawnFn, kill: (pid, sig) => lateSent.push(sig), graceMs: 60, stepMs: 10 });
	late.made[0].child.emit("close", 0);
	assert.equal(await lateClosed, 0);
	assert.equal(lateSent[0], "SIGTERM");
	assert.ok(lateSent.filter((x) => x === 0).length >= 2, `probed through the grace period: ${lateSent.join(" ")}`);
	assert.equal(lateSent.at(-1), "SIGKILL", "a group that outlives the grace period is killed");
});

// ---------- round 1 of #169 ----------

const appWindows = [
	{ app: "TextEdit", scope: "agent_workspace", pid: 10, id: 1 },
	{ app: "TextEdit", scope: "agent_workspace", pid: 20, id: 2 },
	{ app: "TextEdit", scope: "agent_workspace", pid: 30, id: 3 },
	{ app: "TextEdit", scope: "lent", pid: 40, id: 4 },
	{ app: "Preview", scope: "agent_workspace", pid: 50, id: 5 },
];

test("the window check never closes a copy it can't prove is this run's: it records it as left open", async () => {
	const closed = [];
	const left = await leftOpen({ app: "TextEdit", before: new Set([10]), known: new Set([30]), pending: false, list: async () => appWindows, kill: async (pid) => closed.push(pid), sleep: async () => {} });
	assert.deepEqual(closed, [], "pid 20 may be another agent session's or a concurrent job's copy: the helper doesn't say whose it is");
	assert.deepEqual(left, [{ app: "TextEdit", pid: 20, window: 2 }], "not one there before, a reported one (its own undo closes it), a lent window or another app");
});

test("an open cut off before its window was identified: windows are read again over a bounded wait", async () => {
	let t = 0;
	const clock = { now: () => t, sleep: async (ms) => void (t += ms) };
	let reads = 0;
	const late = async () => (++reads < 3 ? [] : appWindows);
	const found = await leftOpen({ app: "TextEdit", before: new Set([10, 30]), known: new Set(), pending: true, list: late, waitMs: 5000, stepMs: 500, ...clock });
	assert.deepEqual(found, [{ app: "TextEdit", pid: 20, window: 2 }], "the window that attached on the third read");
	reads = 0;
	t = 0;
	assert.deepEqual(await leftOpen({ app: "TextEdit", before: new Set(), known: new Set(), pending: true, list: async () => (reads++, []), waitMs: 5000, stepMs: 500, ...clock }), []);
	assert.ok(reads <= 11 && t <= 5000, `bounded: ${reads} reads over ${t} ms`);
	reads = 0;
	await leftOpen({ app: "TextEdit", before: new Set(), known: new Set(), pending: false, list: async () => (reads++, []), ...clock });
	assert.equal(reads, 1, "no open pending: one read");
});

test("after a computer run: score first, then close its own copies, then check for leftovers, on every way it ended", async () => {
	for (const timedOut of [true, false]) {
		const order = [];
		const r = await afterComputerRun({
			timedOut,
			score: async () => (order.push("score"), { pass: true }),
			undo: async () => void order.push("undo"),
			left: async () => (order.push("left"), []),
		});
		assert.deepEqual(order, ["score", "undo", "left"], `timedOut ${timedOut}`);
		assert.deepEqual(r, { score: { pass: true }, left: [] });
	}
});

test("a reported copy is known the moment its answer arrives, and a record's call carries its pid", () => {
	const t = new Transcript();
	t.push(toolUse("a", "computer_open", { app: "TextEdit" }));
	assert.equal(t.pendingOpens(), 1, "an open with no answer yet is pending");
	t.push(toolResult("a", opened({ app: "TextEdit", pid: 101, reused: false })));
	assert.ok(t.started.has(101), "from the answer itself, not re-read from a call field");
	assert.equal(t.done({ ms: 1 }).calls[0].startedPid, 101, "live records carry startedPid; round 1's predate transcript.mjs");
	t.push(toolUse("b", "computer_open", { app: "Calculator" }));
	t.push(toolResult("b", opened({ app: "Calculator", window_identified: false })));
	assert.equal(t.pendingOpens(), 1, "window_identified false: its window may still attach");
});

const roundWant = { passed: 3, total: 4, model: "claude-haiku-5-5", profile: "full", tools: { browser: 48 }, tasks: ["a", "b"] };
const roundRuns = () => [rec("a", 1, true, { toolCount: 48 }), rec("a", 2, true, { toolCount: 48 }), rec("b", 1, true, { toolCount: 48 }), rec("b", 2, false, { toolCount: 48 })].map((r) => ({ ...r, model: "claude-haiku-5-5" }));
const roundSum = (runs) => ({ total: runs.length, passed: runs.filter((r) => r.pass).length, profile: "full" });

test("the ratchet compares like with like: same model, tool list and task set", () => {
	assert.deepEqual(checkRound("r9", roundWant, roundSum(roundRuns()), roundRuns()), []);
	const sonnet = roundRuns();
	sonnet[3] = { ...sonnet[3], model: "claude-sonnet-5-5", pass: true };
	assert.match(checkRound("r9", roundWant, roundSum(sonnet), sonnet).join("\n"), /b t2 ran claude-sonnet-5-5, the round is claude-haiku-5-5/, "a rerun with another model never raises the score");
	const tools = roundRuns().map((r) => ({ ...r, toolCount: 67 }));
	assert.match(checkRound("r9", roundWant, roundSum(tools), tools).join("\n"), /listed 67 tools, the round's browser runs listed 48/);
	const more = roundRuns().map((r) => (r.task === "b" ? { ...r, task: "contact-form" } : r));
	assert.match(checkRound("r9", roundWant, roundSum(more), more).join("\n"), /task set differs: contact-form not in the round; b short/);
});

test("a classification's counts are the transcripts' own", () => {
	const runs = [rec("calc", 1, true, { kind: "computer", calls: [{ tool: "wait", error: true }, { tool: "wait", error: false }] }), rec("toggle", 1, false, { kind: "computer", calls: [{ tool: "wait", error: true }, { tool: "wait", error: true }] })];
	const entry = (count) => ({ friction_in_passing_runs: [{ class: "wrong_tool", count, match: { tools: ["wait"], kind: "computer" } }], failures: [{ run: "toggle t1", class: "tool_bug" }] });
	assert.deepEqual(checkClasses(entry(1), runs), []);
	assert.match(checkClasses(entry(3), runs).join("\n"), /wrong_tool says 3, runs.jsonl has 1/, "a failed run's errors are not friction in passing runs");
	assert.match(checkClasses({ ...entry(1), failures: [{ run: "calc t1", class: "tool_bug" }] }, runs).join("\n"), /calc t1 is listed as a failure but passed/);
});

test("a default label from a model id with a dot is made safe; report.mjs with no label prints its usage", () => {
	const dir = mkdtempSync(join(tmpdir(), "wm-tasks-"));
	writeFileSync(join(dir, "demo.mjs"), `export const demo = [{ id: "demo", kind: "browser", prompt: (u) => u }];\n`);
	const r = spawnSync(process.execPath, [run, "--model", "claude-sonnet-5.5", "--list"], { env: cleanEnv({ WM_TASKS_DIR: dir }), encoding: "utf8", timeout: 30_000 });
	assert.equal(r.status, 0, r.stderr);
	const rep = spawnSync(process.execPath, [join(dirname(run), "report.mjs")], { encoding: "utf8", timeout: 30_000 });
	assert.equal(rep.status, 2, rep.stderr);
	assert.match(rep.stderr, /usage: node evals\/weak-model\/report.mjs <label> \[--task id\]/);
});
