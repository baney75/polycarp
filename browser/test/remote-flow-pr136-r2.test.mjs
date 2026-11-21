// Review round 2 on PR 136, the medium leftovers, panel side: Tailscale not answering in time (first-F1, second-S1) and a
// failed check whose Repair has nothing planned (first-F2). The host side is cli/test/remote-r2.test.mjs; the Mac app's is
// BrowserRemotePR136R2Tests.swift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");

const { STEP_COPY, RESULT_COPY, stepCopy } = await import("../src/connect/remote-copy.ts");
const { flowScreen, pollFor, checkAgainMethod, STATE_POLL_MS } = await import("../src/connect/remote-flow.ts");

const status = (over = {}) => ({ route: "none", passcodeSet: false, theme: { preset: "default" }, ...over });
const funnelRoute = status({ route: "remote", remoteKind: "funnel", publicUrl: "https://m.ts.net:8443" });
const URL_ = "https://m.ts.net:8443/mcp";
const silent = {
	state: "problem",
	code: "tailscale_silent",
	message: "Tailscale didn't answer within 15 seconds, so nothing was changed. Check that Tailscale is running, then try again.",
};

test("PR 136 r2: tailscale_silent has its own step that checks again by itself", () => {
	const entry = stepCopy(silent);
	assert.equal(entry.key, "tailscale_silent");
	assert.equal(entry.title, "Tailscale didn't answer, checking again");
	assert.equal(entry.waits, true);
	assert.deepEqual(entry.action, { kind: "check_again", label: "Check again" });
	assert.equal(STEP_COPY.tailscale_silent.waits, true);
});

test("PR 136 r2 first-F1: on a saved Funnel route, Tailscale not answering is that step, polling, never 'on'", () => {
	const input = { status: funnelRoute, remote: { ...silent, route: "funnel", connectorUrl: URL_ } };
	const screen = flowScreen(input);
	assert.equal(screen.kind, "step");
	assert.equal(screen.copy.key, "tailscale_silent");
	assert.deepEqual(pollFor(screen, input), { method: "remoteState", everyMs: STATE_POLL_MS });
	// An older refusal from a run doesn't hide it either.
	const run = { state: "problem", code: "funnel", message: "tailscale funnel failed" };
	assert.equal(flowScreen({ ...input, run }).copy.key, "tailscale_silent");
	// Once Tailscale answers again, the next poll moves the screen on by itself.
	const back = flowScreen({ status: funnelRoute, remote: { state: "on", message: "", route: "funnel", connectorUrl: URL_ } });
	assert.equal(back.kind, "result");
	assert.equal(back.head, "on");
});

test("PR 136 r2 second-S1: nothing saved, the 'Ready to turn on' poll that times out keeps polling and never runs setup", () => {
	const input = { status: status(), chosen: "tailscale", remote: silent };
	const screen = flowScreen(input);
	assert.equal(screen.kind, "step");
	assert.equal(screen.copy.key, "tailscale_silent");
	assert.notEqual(screen.copy.key, "unknown");
	assert.deepEqual(pollFor(screen, input), { method: "remoteState", everyMs: STATE_POLL_MS });
	// Its button reads the state again; it is not Try again, which would run `remote setup`.
	assert.equal(screen.copy.action.kind, "check_again");
	assert.equal(checkAgainMethod(silent), "remoteState");
	// The next good poll is the ready step again.
	assert.equal(flowScreen({ ...input, remote: { state: "ready", message: "Ready to turn on." } }).copy.key, "ready");
});

test("PR 136 r2 first-F2: a check_failed step whose Repair has nothing planned keeps Check again, which tests from outside", () => {
	const stuck = {
		state: "problem",
		code: "resource_metadata",
		message: "the tunnel never connected",
		connectorUrl: URL_,
		next: { kind: "run_command", command: "polycarp remote fix" },
		checks: [{ name: "resource_metadata", status: "fail", detail: "no answer", pending: true }],
	};
	for (const fix of [undefined, { available: false }, { available: true, actions: [] }]) {
		const input = { status: funnelRoute, run: stuck, checks: stuck.checks, ...(fix ? { fix } : {}) };
		const screen = flowScreen(input);
		assert.equal(screen.copy.key, "check_failed");
		assert.deepEqual(screen.copy.action, { kind: "check_again", label: RESULT_COPY.checkAgain }, JSON.stringify(fix));
	}
	assert.equal(checkAgainMethod(stuck), "remoteTest");
	// With a plan, Repair is still the button.
	const plan = { available: true, actions: [{ kind: "restart_serve", what: "Restart", status: "planned" }] };
	assert.equal(flowScreen({ status: funnelRoute, run: stuck, checks: stuck.checks, fix: plan }).copy.action.kind, "repair");
	// The element's Check again asks what checkAgainMethod names, so this one runs remoteTest.
	assert.match(read("src/dialogs/RemoteFlow.ts"), /case "check_again":\s*void this\.checkAgain\(checkAgainMethod\(answer\)\);/);
});

// #138: two panel leftovers from this review, read off the component (it needs a DOM to run).
const method = (src, name) => {
	const start = src.indexOf(`private async ${name}(`);
	assert.ok(start >= 0, name);
	const next = src.indexOf("\n\tprivate ", start + 1);
	return src.slice(start, next < 0 ? undefined : next);
};

test("#138: a Cloudflare setup that saved its route and then stopped tells Connect at once, as Turn on does", () => {
	const tunnel = method(read("src/dialogs/RemoteFlow.ts"), "setupTunnel");
	const fin = tunnel.slice(tunnel.lastIndexOf("} finally {"));
	assert.match(fin, /this\.dispatchEvent\(new CustomEvent\("remote-changed"/, "every way out of setupTunnel, a refusal included, reloads the saved route");
});

test("#138: a plan asked for before Repair ran can't decide afterwards whether Repair shows", () => {
	const flow = read("src/dialogs/RemoteFlow.ts");
	const plan = method(flow, "planFix");
	assert.match(plan, /const asked = this\.planAsked;/);
	assert.match(plan, /if \(asked === this\.planAsked\) this\.fix = fix;/);
	assert.match(plan, /if \(asked === this\.planAsked\) this\.planning = false;/);
	const repair = method(flow, "repair");
	const bump = repair.indexOf("this.planAsked++");
	assert.ok(bump > repair.indexOf("await connectRemoteFix()"), "the plans in flight are dropped once the run answers");
	assert.ok(bump < repair.indexOf("void this.planFix()"), "so the fresh plan after it can start");
	assert.match(repair.slice(bump), /^this\.planAsked\+\+;\s*this\.planning = false;/);
});
