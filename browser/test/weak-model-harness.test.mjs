// The weak-model runner's own logic (evals/weak-model/README.md). CI never calls a model: these hold the parts that
// decide which account a run bills, which session and app copies it owns, and how its runs are scored and kept.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HandsClient } from "../evals/weak-model/hands.mjs";
import { childEnv, KEY_VARS, keyVarsSet, ownPids, restorePrefs, sessionName, settledState, stopCleanup } from "../evals/weak-model/lib.mjs";
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

test("a long label keeps each trial in its own session", () => {
	const label = "s-sonnet-5-5-read-page-budget-after-fix-round-3-with-a-much-longer-tail";
	const a = sessionName(label, "signup-validation", 1);
	const b = sessionName(label, "signup-validation", 2);
	assert.notEqual(a, b);
	assert.ok(a.length <= 64 && b.length <= 64);
	assert.match(a, /-signup-validation-1$/);
	assert.notEqual(sessionName("r1-haiku", "wizard", 1), sessionName("r2-haiku", "wizard", 1), "labels stay apart");
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

test("the runner owns only the app copies its own computer_open calls started", () => {
	const open = (data, error = false) => ({ tool: "computer_open", error, result: JSON.stringify({ ok: true, data }) });
	const calls = [
		open({ app: "TextEdit", pid: 101, reused: false }),
		open({ app: "TextEdit", pid: 202, reused: true }),
		open({ app: "Calculator", window_identified: false }),
		open({ app: "Preview", pid: 303, reused: false }, true),
		{ tool: "computer_open", args: { app: "Preview" } },
		{ tool: "computer_windows", error: false, result: JSON.stringify({ data: { windows: [{ pid: 404 }] } }) },
	];
	assert.deepEqual([...ownPids(calls)], [101]);
});

test("a stopped run removes its fixture folder and closes only its own copies", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wm-handoff-"));
	mkdirSync(join(dir, "wizard-1"));
	writeFileSync(join(dir, "wizard-1", "notes.txt"), "x");
	const mine = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
	const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
	const exited = new Promise((r) => mine.on("exit", (_c, sig) => r(sig)));
	try {
		stopCleanup(new Set([mine.pid]), dir);
		assert.equal(await exited, "SIGTERM");
		assert.equal(existsSync(dir), false);
		assert.equal(other.exitCode, null, "a copy the run did not start keeps running");
	} finally {
		mine.kill("SIGKILL");
		other.kill("SIGKILL");
	}
});

test("prefs restore imports a backup, deletes a domain that did not exist, and leaves an unknown one alone", () => {
	const ran = [];
	restorePrefs(
		[
			{ domain: "com.apple.calculator", file: "/b/calc.plist" },
			{ domain: "com.apple.TextEdit", file: undefined, absent: true },
			{ domain: "com.apple.Preview", file: undefined, absent: false },
		],
		(cmd, args) => ran.push([cmd, ...args].join(" ")),
	);
	assert.deepEqual(ran, ["defaults import com.apple.calculator /b/calc.plist", "defaults delete com.apple.TextEdit"]);
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

test("a finished rerun clears an old stopped mark; a bare rebuild keeps it", () => {
	const root = round();
	writeFileSync(join(root, "r9", "a-t1.json"), JSON.stringify(rec("a", 1, true)));
	writeFileSync(join(root, "r9", "summary.json"), JSON.stringify({ stopped: true }));
	assert.equal(summarize("r9", { root }).stopped, true, "bare rebuild keeps the old mark");
	assert.equal(summarize("r9", { root, stopped: false }).stopped, undefined);
	assert.equal(JSON.parse(readFileSync(join(root, "r9", "summary.json"), "utf8")).stopped, undefined);
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
