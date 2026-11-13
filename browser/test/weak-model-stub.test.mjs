// The weak-model eval's stub computer (evals/weak-model/stub): its tool list is the real helper's, it answers with the
// real rows, refs and error codes, and every stub task is scored by machine both ways: a scripted solution passes and an
// untouched world fails. No real app, window or model is involved.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spacesBin } from "../evals/weak-model/lib.mjs";
import { stubTasks } from "../evals/weak-model/tasks/stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = join(here, "..", "evals", "weak-model");
const stubBin = join(evalDir, "stub", "hands.mjs");
const root = mkdtempSync(join(tmpdir(), "polycarp-wm-stub-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** One stub helper over stdio, with a world file and a handoff folder of its own. */
function startStub(name, files = {}) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
	const state = join(root, `${name}.world.json`);
	const child = spawn(process.execPath, [stubBin, "--state", state, "--handoff", dir, "mcp", "--connector"], { stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map();
	createInterface({ input: child.stdout }).on("line", (l) => {
		const m = JSON.parse(l);
		waiting.get(m.id)?.(m);
		waiting.delete(m.id);
	});
	let id = 0;
	const rpc = (method, params) =>
		new Promise((resolve) => {
			const n = ++id;
			waiting.set(n, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
		});
	const call = async (tool, args = {}) => {
		const m = await rpc("tools/call", { name: tool, arguments: args });
		const parts = m.result.content.map((c) => c.text);
		const text = parts.join("\n");
		return { text, parts, isError: m.result.isError, json: parts[0].startsWith("{") ? JSON.parse(parts[0]) : undefined };
	};
	/** Row number of the first row whose line matches. */
	const row = (text, re) => {
		const l = text.split("\n").find((x) => re.test(x));
		assert.ok(l, `no row matches ${re} in:\n${text}`);
		return /\[(\d+)\]/.exec(l)[1];
	};
	const world = () => JSON.parse(readFileSync(state, "utf8"));
	const file = (f) => readFileSync(join(dir, f), "utf8");
	return { rpc, call, row, world, file, dir, stop: () => child.kill() };
}

const task = (id) => stubTasks.find((t) => t.id === id);
const scored = (s, id, final = "") => task(id).check(s.world(), { final, file: s.file, dir: s.dir });

test("the stub lists the real helper's verbs and arguments (spaces Tools.swift), and names itself the connector", async () => {
	const swift = readFileSync(join(here, "..", "..", "spaces", "Sources", "BaneySpacesCore", "Hands", "Tools.swift"), "utf8");
	const base = swift.slice(swift.indexOf("static let base"));
	const want = new Map();
	for (const m of base.matchAll(/HandsTool\(verb: "([a-z-]+)", summary: (?:[^\n]*?), params: \[([\s\S]*?)\], acts: (true|false)\)/g)) {
		// refParam is a static of HandsTools: in a list it is the ref argument.
		const params = [...(m[2].includes("refParam") ? ["ref"] : []), ...[...m[2].matchAll(/HandsParam\("([a-z0-9_]+)"/g)].map((p) => p[1])];
		want.set(m[1].replace(/-/g, "_"), { params: new Set(params), acts: m[3] === "true" });
	}
	assert.ok(want.size >= 20, `read ${want.size} verbs from Tools.swift`);
	const s = startStub("list");
	try {
		const init = await s.rpc("initialize", { protocolVersion: "2025-06-18" });
		assert.equal(init.result.serverInfo.name, "polycarp-connector");
		const { tools } = (await s.rpc("tools/list", {})).result;
		assert.deepEqual(tools.map((t) => t.name).sort(), [...want.keys()].sort());
		for (const t of tools) {
			const w = want.get(t.name);
			const got = new Set(Object.keys(t.inputSchema.properties).filter((p) => p !== "wait"));
			assert.deepEqual([...got].sort(), [...w.params].filter((p) => p !== "wait").sort(), `${t.name} arguments`);
			assert.equal(t.annotations.readOnlyHint, !w.acts, `${t.name} readOnlyHint`);
		}
	} finally {
		s.stop();
	}
});

test("a browser ref, a file outside the handoff folder and a bare row after a since read are refused, with the real codes", async () => {
	const s = startStub("refusals", { "a.txt": "one\n" });
	try {
		await s.call("open", { app: "Tally" });
		let r = await s.call("click", { ref: "e3" });
		assert.equal(r.json.error.code, "bad_arguments");
		assert.match(r.json.error.message, /browser ref/);
		r = await s.call("open", { app: "Jotter", targets: ["/etc/hosts"] });
		assert.equal(r.json.error.code, "bad_arguments");
		assert.match(r.json.error.message, /outside the agent handoff folder/);
		r = await s.call("open", { app: "Safari" });
		assert.equal(r.json.error.code, "needs_sandbox");
		const full = await s.call("snapshot", { app: "Tally" });
		await s.call("click", { ref: s.row(full.text, /button "7"/) });
		await s.call("snapshot", { app: "Tally", since: "latest" });
		r = await s.call("click", { ref: "8" });
		assert.equal(r.json.error.code, "stale_bare_row");
		assert.deepEqual(r.json.error.next_call, { tool: "snapshot", arguments: { window: 61001 } });
		assert.equal(s.world().windows[0].state.display, "7", "nothing was pressed");
		r = await s.call("snapshot", { app: "Tally", bogus: true });
		assert.equal(r.json.error.code, "bad_arguments");
		assert.match(r.json.error.suggestion, /^usage: polycarp-spaces agent snapshot/);
	} finally {
		s.stop();
	}
});

test("a ref to a row the window no longer shows is stale_ref, never another row", async () => {
	const s = startStub("stale");
	try {
		await s.call("open", { app: "Roster" });
		const full = await s.call("snapshot", { app: "Roster" });
		const ada = `@${/snapshot (\S+)/.exec(full.text)[1]}:e${s.row(full.text, /\] row/)}`;
		await s.call("set_value", { ref: s.row(full.text, /searchfield/), value: "Priya" });
		const r = await s.call("click", { ref: ada });
		assert.equal(r.json.error.code, "stale_ref");
		assert.equal(s.world().windows[0].state.selected, null);
	} finally {
		s.stop();
	}
});

test("Command-W closes a window like File > Close: a saved document closes, an edited one asks first with a sheet", async () => {
	const s = startStub("cmd-w", { "a.txt": "one\n", "b.txt": "two\n" });
	try {
		const a = (await s.call("open", { app: "Jotter", targets: ["a.txt"] })).json.data.window;
		let t = (await s.call("snapshot", { window: a })).text;
		const area = s.row(t, /textarea/);
		await s.call("set_value", { ref: area, value: "one\nmore\n" });
		await s.call("press", { ref: area, key: "cmd+s" });
		const shut = await s.call("press", { ref: area, key: "cmd+w" });
		assert.ok(!shut.isError, shut.text);
		assert.equal(s.world().windows.find((w) => w.id === a).open, false, "the saved document closed");
		const b = (await s.call("open", { app: "Jotter", targets: ["b.txt"] })).json.data.window;
		t = (await s.call("snapshot", { window: b })).text;
		await s.call("set_value", { ref: s.row(t, /textarea/), value: "two\nthree\n" });
		const ask = await s.call("press", { ref: s.row(t, /textarea/), key: "cmd+w" });
		assert.deepEqual(ask.json.data.opened, [{ window: b, kind: "sheet", waiting: true }], ask.text);
		assert.equal(s.world().windows.find((w) => w.id === b).open, true, "the edited document waits on its sheet");
	} finally {
		s.stop();
	}
});

test("run_steps runs several actions in one call and reads once; a bad step runs nothing; a sheet stops the run", async () => {
	const s = startStub("steps", { "c.txt": "draft\n" });
	try {
		await s.call("open", { app: "Thermo" });
		const t = (await s.call("snapshot", { app: "Thermo" })).text;
		const before = JSON.stringify(s.world());
		const refused = await s.call("run_steps", { steps: [{ tool: "toggle", args: { ref: s.row(t, /switch "Eco mode"/) } }, { tool: "open", args: { app: "Jotter" } }] });
		assert.equal(refused.json.error.code, "bad_arguments", refused.text);
		assert.match(refused.json.error.message, /step 2: open can't be a step/);
		assert.equal(JSON.stringify(s.world()), before, "nothing ran");
		const run = await s.call("run_steps", {
			steps: [
				{ tool: "computer_set_value", args: { ref: s.row(t, /textfield/), value: "21" } },
				{ tool: "toggle", ref: s.row(t, /switch "Eco mode"/) },
				{ tool: "click", args: { ref: s.row(t, /button "Apply"/) } },
			],
		});
		assert.equal(run.isError, false, run.text);
		assert.deepEqual([run.json.data.done, run.json.data.of, run.json.data.complete], [3, 3, true]);
		// As the helper since #275: the closing read's rows go out as their own part, read as lines, not a JSON string.
		assert.equal(run.parts.length, 2, run.text);
		assert.deepEqual([run.json.data.read.format, run.json.data.read.text_below, run.json.data.read.text], ["rows", true, undefined]);
		assert.match(run.parts[1], /since/, "one read of what changed ends it");
		const applied = s.world().windows.find((w) => w.app === "Thermo").state.applied;
		assert.deepEqual([Number(applied.target), applied.eco], [21, true]);

		const j = (await s.call("open", { app: "Jotter", targets: ["c.txt"] })).json.data.window;
		const jt = (await s.call("snapshot", { window: j })).text;
		const area = s.row(jt, /textarea/);
		const sheet = await s.call("run_steps", { steps: [{ tool: "set_value", args: { ref: area, value: "draft\nfinal\n" } }, { tool: "press", args: { ref: area, key: "cmd+w" } }, { tool: "press", args: { ref: area, key: "cmd+s" } }] });
		assert.equal(sheet.json.data.stopped, "opened", sheet.text);
		assert.deepEqual([sheet.json.data.done, sheet.json.data.of, sheet.json.data.complete], [2, 3, false]);
		assert.match(sheet.json.data.note, /step 2 raised a dialog or sheet; the 1 after it did not run/);
		assert.match(sheet.parts[1], /button "Don't Save"/, "the read shows the sheet");
		assert.equal(s.world().windows.find((w) => w.id === j).state.saves, 0, "the step after the sheet did not run");
	} finally {
		s.stop();
	}
});

test("a right click is refused before anything is sent, as on a parked agent window; item needs button right", async () => {
	const s = startStub("right", {});
	try {
		await s.call("open", { app: "Roster" });
		const t = (await s.call("snapshot", { app: "Roster" })).text;
		const ref = s.row(t, /\] row/);
		const before = JSON.stringify(s.world());
		const right = await s.call("click", { ref, button: "right", item: "Rename" });
		assert.equal(right.json.error.code, "outside_agent_workspace", right.text);
		assert.equal(right.json.error.next_call, null);
		assert.equal(JSON.stringify(s.world()), before, "nothing was sent");
		const stray = await s.call("click", { ref, item: "Rename" });
		assert.match(stray.json.error.message, /item goes with button: right/);
	} finally {
		s.stop();
	}
});

test("System Settings: a click on a sidebar name selects its row (ClickFallback), the title follows the pane, and Displays is not Display", async () => {
	const s = startStub("settings", {});
	try {
		const win = (await s.call("open", { app: "System Settings" })).json.data.window;
		let t = (await s.call("snapshot", { window: win })).text;
		assert.match(t, /window \d+ "General" \(System Settings\)/);
		const click = await s.call("click", { ref: s.row(t, /statictext "Displays"/) });
		assert.equal(click.json.data.landed, "selection_write", click.text);
		t = (await s.call("snapshot", { window: win })).text;
		assert.match(t, /"Displays" \(System Settings\)/);
		assert.match(t, /statictext "Built-in Display"/);
		const found = await s.call("find", { window: win, text: "Display" });
		assert.ok(found.json.data.count >= 2, "a find for Display also hits Displays and Built-in Display");
		assert.deepEqual(s.world().windows[0].state.changes, [], "navigating changes nothing");
	} finally {
		s.stop();
	}
});

test("click by text (TextTarget): the exact label wins, two are refused with refs, and run_steps does two panes in one call", async () => {
	const s = startStub("by-text", {});
	try {
		const win = (await s.call("open", { app: "System Settings" })).json.data.window;
		const before = JSON.stringify(s.world().windows[0].state.changes);
		const none = await s.call("click", { window: win, text: "Bluetooth settings" });
		assert.equal(none.json.error.code, "action_failed", none.text);
		assert.match(none.json.error.message, /Nothing was sent/);
		const run = await s.call("run_steps", { steps: [{ tool: "click", args: { window: win, text: "Accessibility" } }, { tool: "click", args: { window: win, text: "Display" } }] });
		assert.equal(run.json.data.complete, true, run.text);
		const st = s.world().windows[0].state;
		assert.deepEqual([st.pane, st.sub, st.title], ["Accessibility", "Display", "Display"], "Display, never Displays");
		assert.equal(JSON.stringify(st.changes), before, "nothing changed");
		await s.call("click", { window: win, text: "Back" });
		const two = await s.call("click", { window: win, text: "Keyboard" });
		assert.equal(two.json.error.code, "ambiguous_target", two.text);
		assert.equal(two.json.error.next_call, null);
		assert.match(two.json.error.message, /2 elements in window \d+ show "Keyboard": @\w+:e\d+ statictext "Keyboard", @\w+:e\d+ button "Keyboard"/);
		const one = await s.call("click", { window: win, text: "Keyboard", role: "button" });
		assert.deepEqual([one.json.data.matched.role, s.world().windows[0].state.sub], ["button", "Keyboard"], one.text);
		const both = await s.call("click", { ref: "3", window: win, text: "x" });
		assert.match(both.json.error.message, /not both/);
		const t = (await s.call("snapshot", { window: win })).text;
		const withWindow = await s.call("click", { ref: s.row(t, /button "Back"/), window: win });
		assert.ok(!withWindow.isError, `a window beside a ref is harmless: ${withWindow.text}`);
	} finally {
		s.stop();
	}
});

test("a long document's read is cut at 400 rows and says how to get the rest; a query finds the line", async () => {
	const s = startStub("leaflet", task("stub-leaflet-find").files);
	try {
		await s.call("open", { app: "Leaflet", targets: ["report.pdf"] });
		const full = await s.call("snapshot", { app: "Leaflet" });
		assert.match(full.text, /truncated: 400 of \d+ rows shown/);
		assert.doesNotMatch(full.text, /HFL-AUD/);
		const q = await s.call("snapshot", { app: "Leaflet", query: "audit" });
		assert.match(q.text, /HFL-AUD-58Z3Q/);
	} finally {
		s.stop();
	}
});

// A scripted solution for each task, through the same tools a model calls. Each must pass its task's check, and the
// untouched world (the app opened, nothing done) must fail it.
const solutions = {
	async "stub-tally-multiply"(s) {
		await s.call("open", { app: "Tally" });
		const t = (await s.call("snapshot", { app: "Tally" })).text;
		for (const k of ["1", "2", "3", "4", "Multiply", "5", "6", "Equals"]) await s.call("click", { ref: s.row(t, new RegExp(`button "${k}"`)) });
		return "1234 times 56 is 69,104.";
	},
	async "stub-tally-sequence"(s) {
		await s.call("open", { app: "Tally" });
		const t = (await s.call("snapshot", { app: "Tally" })).text;
		const w = s.world().windows[0].id;
		const r = s.row(t, /statictext/);
		const press = await s.call("press", { ref: r, key: "( 4 5 + 1 7 ) * 3 Return" });
		assert.equal(press.isError, false, press.text);
		assert.equal(s.world().windows.find((x) => x.id === w).state.display, "186");
	},
	async "stub-jotter-append"(s) {
		await s.call("open", { app: "Jotter", targets: [join(s.dir, "shopping.txt")] });
		const t = (await s.call("snapshot", { app: "Jotter" })).text;
		const area = s.row(t, /textarea/);
		await s.call("press", { ref: area, key: "cmd+down" });
		await s.call("type", { ref: area, text: "eggs" });
	},
	async "stub-jotter-save"(s) {
		const { json } = await s.call("open", { app: "Jotter", targets: ["todo.txt"] });
		const t = (await s.call("snapshot", { window: json.data.window })).text;
		await s.call("set_value", { ref: s.row(t, /textarea/), value: "renew passport\nwater plants\ncall the bank\n" });
		await s.call("menu", { window: json.data.window, path: "File > Save" });
	},
	async "stub-jotter-close"(s) {
		const { json } = await s.call("open", { app: "Jotter", targets: ["memo.txt"] });
		const t = (await s.call("snapshot", { window: json.data.window })).text;
		await s.call("set_value", { ref: s.row(t, /textarea/), value: "Budget request for the spring term.\nSubmitted by the grounds crew.\nApproved\n" });
		const closing = await s.call("close", { window: json.data.window });
		assert.equal(closing.json.data.closed, false, "unsaved changes ask first");
		const sheet = (await s.call("snapshot", { window: json.data.window })).text;
		await s.call("click", { ref: s.row(sheet, /button "Save" \(sheet\)/) });
	},
	async "stub-leaflet-find"(s) {
		await s.call("open", { app: "Leaflet", targets: ["report.pdf"] });
		const r = await s.call("find", { app: "Leaflet", text: "audit reference" });
		return `It's ${/HFL-AUD-\w+/.exec(r.text)[0]}.`;
	},
	async "stub-thermo-settings"(s) {
		await s.call("open", { app: "Thermo" });
		let t = (await s.call("snapshot", { app: "Thermo" })).text;
		await s.call("click", { ref: s.row(t, /popupbutton "Mode"/) });
		t = (await s.call("snapshot", { app: "Thermo" })).text;
		await s.call("click", { ref: s.row(t, /menuitem "Cool"/) });
		t = (await s.call("snapshot", { app: "Thermo" })).text;
		await s.call("set_value", { ref: s.row(t, /textfield/), value: "21" });
		await s.call("toggle", { ref: s.row(t, /switch "Eco mode"/) });
		t = (await s.call("snapshot", { app: "Thermo" })).text;
		await s.call("click", { ref: s.row(t, /button "Apply"/) });
	},
	async "stub-roster-lookup"(s) {
		await s.call("open", { app: "Roster" });
		const t = (await s.call("snapshot", { app: "Roster" })).text;
		const lines = t.split("\n");
		const i = lines.findIndex((l) => /statictext "Priya Shah"/.test(l));
		const rowLine = lines.slice(0, i).reverse().find((l) => /\] row/.test(l));
		await s.call("click", { ref: /\[(\d+)\]/.exec(rowLine)[1] });
		const after = (await s.call("snapshot", { app: "Roster", query: "phone" })).text;
		return `Priya Shah's number is ${/=(?:")?(555-\d+)/.exec(after)[1]}.`;
	},
	async "stub-settings-appearance"(s) {
		await s.call("open", { app: "System Settings" });
		const t = (await s.call("snapshot", { app: "System Settings" })).text;
		await s.call("click", { ref: s.row(t, /statictext "Appearance"/) });
	},
	async "stub-settings-two-panes"(s) {
		await s.call("open", { app: "System Settings" });
		let t = (await s.call("snapshot", { app: "System Settings" })).text;
		await s.call("click", { ref: s.row(t, /statictext "Accessibility"/) });
		t = (await s.call("snapshot", { app: "System Settings" })).text;
		await s.call("click", { ref: s.row(t, /button "Display"$/) });
	},
};

test("every stub task has a scripted solution", () => {
	assert.deepEqual(Object.keys(solutions).sort(), stubTasks.map((t) => t.id).sort());
});

for (const t of stubTasks) {
	test(`${t.id}: an untouched world fails and the scripted solution passes`, async () => {
		const idle = startStub(`${t.id}-idle`, t.files);
		try {
			const app = /\b(Tally|Jotter|Leaflet|Thermo|Roster|System Settings)\b/.exec(t.prompt(idle.dir))[1];
			const target = Object.keys(t.files ?? {})[0];
			await idle.call("open", { app, ...(target ? { targets: [target] } : {}) });
			assert.equal(scored(idle, t.id, "I couldn't do it.").pass, false, "an untouched world must fail");
		} finally {
			idle.stop();
		}
		const s = startStub(t.id, t.files);
		try {
			const final = (await solutions[t.id](s)) ?? "Done.";
			const v = scored(s, t.id, final);
			assert.equal(v.pass, true, v.why.join("; "));
		} finally {
			s.stop();
		}
	});
}

test("a stub run's server gets the stub, never the Mac's helper", () => {
	const o = { allowComputer: true, wrapper: "/mac/wrapper", stub: "/scratch/run.hands.sh", none: "/none" };
	assert.equal(spacesBin("stub", o), o.stub);
	assert.equal(spacesBin("stub", { ...o, stub: undefined }), o.none);
	assert.equal(spacesBin("computer", o), o.wrapper);
	assert.equal(spacesBin("browser", o), o.none);
});

test("--kind stub lists the stub tasks, and --kind all leaves out computer tasks unless they are allowed", () => {
	const run = (args, env = {}) => spawnSync(process.execPath, [join(evalDir, "run.mjs"), "--list", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
	const stub = run(["--kind", "stub"]);
	assert.equal(stub.status, 0, stub.stderr);
	assert.deepEqual(
		stub.stdout.trim().split("\n").map((l) => l.split("\t")[1]).sort(),
		stubTasks.map((t) => t.id).sort(),
	);
	const all = run(["--kind", "all"]);
	assert.equal(all.status, 0, all.stderr);
	const kinds = new Set(all.stdout.trim().split("\n").map((l) => l.split("\t")[0]));
	assert.deepEqual([...kinds].sort(), ["browser", "stub"]);
});
