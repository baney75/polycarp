// The words a person reads must be the same on every surface. The side panel draws them from src/connect/remote-copy.ts;
// `remote setup` prints its own copy of the assistant steps (cli/src/remote-setup.ts, which can import the module once PR 132
// lands); the Mac app holds Swift literals of all of it (spaces/Sources/BaneySpacesCore/RemoteSharedCopy.swift). This test
// fails if any side changes alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	APPROVAL_STEP,
	ASSISTANT_STEPS,
	CHECK_LABELS,
	copyKey,
	FLOW_STEPS,
	PROBLEM_CODES,
	RESULT_COPY,
	ROUTE_COPY,
	STEP_COPY,
} from "../src/connect/remote-copy.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");

/** The lines the CLI prints, as the panel's data would print them. */
export const cliLines = () => [...ASSISTANT_STEPS.map((a) => `  ${a.name.padEnd(12)}${a.where}`), APPROVAL_STEP];

test("the panel's assistant steps are the lines `remote setup` prints", () => {
	const cli = read("cli/src/remote-setup.ts");
	const start = cli.indexOf("Add it to an assistant (paste the connector URL):\n");
	assert.ok(start >= 0, "remote-setup.ts no longer prints the assistant steps");
	const printed = cli.slice(start).split("\n").slice(1, 1 + cliLines().length);
	assert.deepEqual(printed, cliLines());
});

// The Mac app's literals, read from its source. Each is a Swift string literal on one line, which is JSON-compatible here
// (no escapes are used), so JSON.parse reads it.
const swift = () => read("../spaces/Sources/BaneySpacesCore/RemoteSharedCopy.swift");
const lit = '"(?:[^"\\\\]|\\\\.)*"';
const str = (s) => JSON.parse(s);
/** A Swift `[String: String]` literal by name, as an object. */
function swiftDict(name) {
	const src = swift();
	const start = src.indexOf(`static let ${name}: [String: String] = [`);
	assert.ok(start >= 0, `RemoteSharedCopy.swift has no ${name}`);
	const body = src.slice(start, src.indexOf("\n    ]", start));
	return Object.fromEntries([...body.matchAll(new RegExp(`(${lit}): (${lit}),`, "g"))].map((m) => [str(m[1]), str(m[2])]));
}

test("the Mac app's step words are the panel's, entry by entry", () => {
	const re = new RegExp(`(${lit}): RemoteStepCopy\\(title: (${lit}), body: (${lit}|nil), action: (${lit}|nil), kind: (${lit}|nil), waits: (true|false)\\),`, "g");
	const mac = Object.fromEntries(
		[...swift().matchAll(re)].map((m) => [
			str(m[1]),
			{
				title: str(m[2]),
				...(m[3] === "nil" ? {} : { body: str(m[3]) }),
				...(m[4] === "nil" ? {} : { action: { kind: str(m[5]), label: str(m[4]) } }),
				...(m[6] === "true" ? { waits: true } : {}),
			},
		]),
	);
	assert.deepEqual(mac, JSON.parse(JSON.stringify(STEP_COPY)));
});

test("the Mac app's assistant steps, approval line, result, checks and routes are the panel's", () => {
	const re = new RegExp(`RemoteAssistantStep\\(id: (${lit}), name: (${lit}), where: (${lit})\\)`, "g");
	const steps = [...swift().matchAll(re)].map((m) => ({ id: str(m[1]), name: str(m[2]), where: str(m[3]) }));
	assert.deepEqual(steps, ASSISTANT_STEPS.map((a) => ({ ...a })));
	const approval = swift().match(new RegExp(`static let approvalStep = (${lit})`));
	assert.equal(approval && str(approval[1]), APPROVAL_STEP);
	assert.deepEqual(swiftDict("result"), { ...RESULT_COPY });
	assert.deepEqual(swiftDict("checkLabels"), { ...CHECK_LABELS });
	const routes = {};
	for (const [k, v] of Object.entries(ROUTE_COPY)) {
		if (typeof v === "string") routes[k] = v;
		else for (const [k2, v2] of Object.entries(v)) routes[`${k}.${k2}`] = v2;
	}
	assert.deepEqual(swiftDict("route"), routes);
	const list = (name) => {
		const m = swift().match(new RegExp(`static let ${name}: \\[String\\] = \\[([^\\]]*)\\]`));
		assert.ok(m, name);
		return JSON.parse(`[${m[1]}]`);
	};
	assert.deepEqual(list("problemCodes"), [...PROBLEM_CODES]);
	assert.deepEqual(list("flowSteps"), [...FLOW_STEPS]);
});

test("the Mac app's key function names every state and code copyKey does", () => {
	// The Swift switch, as text: each state and code copyKey names appears there. launcher is the app's own entry.
	const src = swift();
	for (const state of ["tailscale_missing", "tailscale_signed_out", "tailnet_lock", "ready", "funnel_not_allowed", "funnel_closed", "on", "no_browser_connected", "turning_on", "cloudflared_missing", "port_busy", "problem"]) {
		assert.ok(src.includes(`"${state}"`), state);
	}
	for (const code of ["tailscale_port", "cloudflare_name", "not_set_up", "cloudflare_dns", "choose_name", "launcher"]) assert.ok(src.includes(`"${code}"`), code);
	assert.ok(STEP_COPY.launcher_app, "the app's launcher entry lives in the shared table too");
});

test("copyKey picks the entry the shared fixture names, the one the Mac app's XCTest holds its key() to", () => {
	// browser/test/fixtures/remote-copy-keys.json: BrowserRemoteKeyFixtureTests.swift asserts the same rows against the Swift key().
	const { cases } = JSON.parse(read("test/fixtures/remote-copy-keys.json"));
	assert.ok(cases.length >= 40, "the fixture lost its rows");
	for (const { key, macKey: _mac, ...answer } of cases) assert.equal(copyKey(answer), key, JSON.stringify(answer));
});
