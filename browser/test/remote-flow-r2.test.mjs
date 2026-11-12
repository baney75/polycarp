// Review round 2 on PR 133 (the leftovers): each finding as a test of the flow's pure parts (remote-copy.ts, remote-flow.ts)
// and, where only the Lit element can hold it, of RemoteFlow.ts's source. The host side is cli/test/remote-r2.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");

const copy = await import("../src/connect/remote-copy.ts");
const flow = await import("../src/connect/remote-flow.ts");
const { STEP_COPY, RESULT_COPY, answerOn } = copy;
const { flowScreen, pollFor, STATE_POLL_MS } = flow;

const status = (over = {}) => ({ route: "none", passcodeSet: false, theme: { preset: "default" }, ...over });
const funnelRoute = status({ route: "remote", remoteKind: "funnel", publicUrl: "https://m.ts.net:8443" });
const URL_ = "https://m.ts.net:8443/mcp";
const NAMES = ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming"];
const ok = NAMES.map((name) => ({ name, status: "ok", detail: "fine" }));
const operator = { state: "problem", code: "tailscale_operator", message: "Tailscale's words: access denied", next: { kind: "run_command", command: "sudo tailscale set --operator=$USER" } };
const plan = { available: true, ok: true, actions: [{ kind: "restart_serve", what: "Restart serve", status: "planned" }] };

test("first-F1: a Cloudflare refusal from setup is drawn as its step, even over the Cloudflare form on a Funnel route", () => {
	const refused = { state: "problem", code: "cloudflare_dns", message: "record exists", next: { kind: "choose_name" } };
	// Nothing set up yet.
	const fresh = flowScreen({ status: status(), chosen: "cloudflare", run: refused });
	assert.equal(fresh.kind, "step");
	assert.equal(fresh.copy.key, "cloudflare_name_refused");
	// "Use Cloudflare instead" on a Funnel route: the refusal comes ahead of the form.
	const switching = flowScreen({ status: funnelRoute, chosen: "cloudflare", run: refused });
	assert.equal(switching.kind, "step");
	assert.equal(switching.copy.key, "cloudflare_name_refused");
	// The form still shows when nothing was refused.
	assert.equal(flowScreen({ status: funnelRoute, chosen: "cloudflare" }).kind, "cloudflare");
	// The element hands a refused tunnel to takeRun, so the table's sentence and action are drawn.
	assert.match(read("src/dialogs/RemoteFlow.ts"), /if \(result\.problem\) \{[^}]*this\.takeRun\(result\.problem\)/s);
});

test("first-F2: the operator step after the Funnel retry gave up says so, copies the command and checks again", () => {
	const gaveUp = flowScreen({ status: funnelRoute, run: operator, funnelGaveUp: true });
	assert.equal(gaveUp.kind, "step");
	assert.equal(gaveUp.copy.key, "tailscale_operator_check");
	assert.equal(gaveUp.copy.action.kind, "open_funnel");
	assert.equal(gaveUp.copy.action.label, "Check again");
	assert.ok(!gaveUp.copy.waits, "nothing is checking any more, so the step doesn't say it waits");
	assert.equal(pollFor(gaveUp, { status: funnelRoute, run: operator, funnelGaveUp: true }), undefined);
	// Before the retry gives up, the operator step waits on the Funnel retry as before.
	const waiting = flowScreen({ status: funnelRoute, run: operator });
	assert.equal(waiting.copy.key, "tailscale_operator");
	assert.equal(pollFor(waiting, { status: funnelRoute, run: operator }).method, "remoteFunnel");
	// Not saved yet: no read can see the operator setting change, so the step never claims to wait.
	const unsaved = { status: status(), chosen: "tailscale", run: operator };
	const s = flowScreen(unsaved);
	assert.equal(s.copy.key, "tailscale_operator_check");
	assert.equal(pollFor(s, unsaved), undefined);
	// The element draws the command for it and Check again runs Turn on when nothing is saved.
	const el = read("src/dialogs/RemoteFlow.ts");
	assert.match(el, /copy\.key === "tailscale_operator_check"/);
	assert.match(el, /case "open_funnel":\s*if \(this\.status\?\.route === "remote"\) void this\.openFunnel\(\);\s*else void this\.turnOn\(\);/);
});

test("first-F3: the choose screen slows its poll once the routes are read", () => {
	const routes = { tailscale: { installed: true, signedIn: true }, cloudflare: { installed: false, signedIn: false } };
	const unread = flowScreen({ status: status(), remote: { state: "ready", message: "" } });
	assert.equal(pollFor(unread, {}).everyMs, STATE_POLL_MS);
	const read_ = flowScreen({ status: status(), remote: { state: "ready", message: "", routes } });
	assert.equal(read_.kind, "choose");
	assert.equal(pollFor(read_, {}).everyMs, flow.CHOOSE_POLL_MS);
	assert.ok(flow.CHOOSE_POLL_MS >= 15_000);
});

test("first-F4: every result string is read by the panel, or named as the Mac app's own", () => {
	const el = read("src/dialogs/RemoteFlow.ts");
	const unread = Object.keys(RESULT_COPY).filter((k) => !el.includes(`RESULT_COPY.${k}`));
	assert.deepEqual(unread.sort(), [...copy.MAC_ONLY_RESULT].sort());
});

test("second-N1: a Repair that stops on a step the person must take shows that step, its command and the advice", () => {
	const done = {
		available: true,
		ok: false,
		state: "problem",
		code: "tailscale_operator",
		message: "Tailscale refused: access denied",
		next: { kind: "run_command", command: "sudo tailscale set --operator=$USER" },
		advice: [{ name: "linger", detail: "Services stop when you log out.", command: "loginctl enable-linger me" }],
		actions: [],
	};
	const out = flow.repairOutcome(done);
	assert.equal(out.copy.key, "tailscale_operator_check", "nothing polls after a repair, so the step checks again");
	assert.equal(out.command, "sudo tailscale set --operator=$USER");
	assert.equal(out.message, "Tailscale refused: access denied");
	assert.deepEqual(out.advice, done.advice);
	assert.equal(flow.repairOutcome({ ...done, ok: true }), undefined, "a repair that worked has nothing to say");
	assert.equal(flow.repairOutcome({ available: false }), undefined);
	const el = read("src/dialogs/RemoteFlow.ts");
	assert.match(el, /data-repair-outcome/);
	assert.match(el, /repairOutcome\(this\.repaired\)/);
});

test("second-N2: an answer that names `remote fix` is a failure with Repair, never waiting forever", () => {
	const stuck = {
		state: "problem",
		code: "resource_metadata",
		message: "the tunnel never connected",
		connectorUrl: URL_,
		next: { kind: "run_command", command: "polycarp remote fix" },
		checks: [...ok.slice(0, 2), { name: "resource_metadata", status: "fail", detail: "no answer", pending: true }],
	};
	assert.equal(answerOn(stuck), false, "so the host mints no code for it");
	assert.equal(copy.needsRepair(stuck), true);
	const input = { status: funnelRoute, run: stuck, checks: stuck.checks, fix: plan };
	const screen = flowScreen(input);
	assert.equal(screen.kind, "step");
	assert.equal(screen.copy.key, "check_failed");
	assert.equal(screen.copy.action.kind, "repair");
	assert.equal(pollFor(screen, input), undefined, "no endless recheck");
	// A test answer that stays pending past the cap turns into a failed check with Repair, and the 30-second poll stops.
	const pending = { status: funnelRoute, checks: stuck.checks, fix: plan };
	assert.equal(flowScreen(pending).head, "on_waiting");
	const capped = flowScreen({ ...pending, waitingGaveUp: true });
	assert.equal(capped.head, "check_failed");
	assert.equal(capped.waiting, false);
	assert.equal(capped.repair, true);
	assert.equal(pollFor(capped, { ...pending, waitingGaveUp: true }), undefined);
	assert.ok(flow.WAITING_FOR_MS >= 10 * 60_000);
	assert.match(read("src/dialogs/RemoteFlow.ts"), /this\.waitingGaveUp = true/);
});

test("second-N3: a real Repair's answer never replaces the plan, so a later failure asks for a fresh one", () => {
	const el = read("src/dialogs/RemoteFlow.ts");
	const start = el.indexOf("private async repair()");
	const body = el.slice(start, el.indexOf("\n\t}\n", start));
	assert.doesNotMatch(body, /this\.fix = done/);
	assert.match(body, /this\.fix = undefined/);
});

test("second-N4: remote-copy.ts names a Swift file as held equal only when the test reads it", () => {
	const src = read("src/connect/remote-copy.ts");
	const m = src.match(/\(([^()]+\.swift), held equal by test\/remote-copy\.test\.mjs\)/);
	if (m) assert.ok(read("test/remote-copy.test.mjs").includes(m[1].split("/").pop()), `${m[1]} is named but never read`);
	assert.ok(STEP_COPY.tailscale_operator_check);
});
