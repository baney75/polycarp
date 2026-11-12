// Review round 1 on PR 133: each finding as a test of the flow's pure parts (remote-copy.ts, remote-flow.ts) and, where only
// the Lit element can hold it, of RemoteFlow.ts's source. The e2e file (cli/test/e2e-remote-flow.test.mjs) draws the same
// screens in Chromium.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");

const copy = await import("../src/connect/remote-copy.ts");
const flow = await import("../src/connect/remote-flow.ts");
const { stepCopy, STEP_COPY, RESULT_COPY, answerOn, waitingChecks, realFailures } = copy;
const { flowScreen, pollFor, settleRun, settleRunAfterTest, DNS_POLL_MS, FUNNEL_POLL_MS, FUNNEL_RETRY_FOR_MS } = flow;

const status = (over = {}) => ({ route: "none", passcodeSet: false, theme: { preset: "default" }, ...over });
const funnelRoute = status({ route: "remote", remoteKind: "funnel", publicUrl: "https://m.ts.net:8443" });
const cloudflareRoute = status({ route: "remote", remoteKind: "cloudflare", publicUrl: "https://p.example.com" });
const URL_ = "https://m.ts.net:8443/mcp";
const NAMES = ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming"];
const ok = NAMES.map((name) => ({ name, status: "ok", detail: "fine" }));
const failing = (name, pending) => [
	...ok.slice(0, NAMES.indexOf(name)),
	{ name, status: "fail", detail: "not yet", ...(pending ? { pending: true } : {}) },
];

test("second-N1: code dns maps to the dns copy, not check_failed, and its step checks again by itself", () => {
	assert.equal(stepCopy({ state: "problem", code: "dns", message: "" }).key, "dns");
	// With no address to show yet (nothing saved), the dns step itself polls remoteTest.
	const input = { status: status(), chosen: "tailscale", run: { state: "problem", code: "dns", message: "" } };
	const screen = flowScreen(input);
	assert.equal(screen.kind, "step");
	assert.equal(screen.copy.key, "dns");
	assert.deepEqual(pollFor(screen, input), { method: "remoteTest", everyMs: DNS_POLL_MS });
	// The other check names still read as a failed check.
	for (const code of NAMES.filter((n) => n !== "dns")) assert.equal(stepCopy({ state: "problem", code, message: "" }).key, "check_failed", code);
});

test("pending failures are waiting, not failed: answerOn, waitingChecks and realFailures", () => {
	assert.equal(waitingChecks(failing("dns", true)), true);
	assert.equal(waitingChecks(failing("tls", false)), false);
	assert.equal(waitingChecks(ok), false);
	assert.deepEqual(realFailures(failing("dns", true)), []);
	assert.equal(realFailures(failing("streaming", false)).length, 1);
	// Setup's own "on" with a lagging name, a test that only waits, and an older helper's bare dns code are all on.
	assert.equal(answerOn({ state: "on", message: "", checks: failing("dns", true) }), true);
	assert.equal(answerOn({ state: "problem", code: "dns", message: "", connectorUrl: URL_, checks: failing("dns", true) }), true);
	assert.equal(answerOn({ state: "problem", code: "resource_metadata", message: "", connectorUrl: URL_, checks: failing("resource_metadata", true) }), true);
	assert.equal(answerOn({ state: "problem", code: "dns", message: "", connectorUrl: URL_ }), true);
	// A real fault, or nothing saved to show, is not.
	assert.equal(answerOn({ state: "problem", code: "tls", message: "", connectorUrl: URL_, checks: failing("tls", false) }), false);
	assert.equal(answerOn({ state: "problem", code: "dns", message: "" }), false);
	assert.equal(answerOn({ state: "problem", code: "service", message: "", connectorUrl: URL_ }), false);
});

test("first-F1: a brand-new ts.net name lands on the result as on, waiting for DNS, and checks again until it clears", () => {
	// The Funnel retry opens Funnel; public DNS hasn't caught up. The helper says so with a pending dns check.
	const run = { state: "problem", code: "dns", message: "dns failed: no address yet", route: "funnel", connectorUrl: URL_, checks: failing("dns", true) };
	const input = { status: funnelRoute, remote: { state: "funnel_closed", message: "" }, run, checks: run.checks };
	const screen = flowScreen(input);
	assert.equal(screen.kind, "result");
	assert.equal(screen.connectorUrl, URL_);
	assert.equal(screen.head, "on_waiting");
	assert.equal(screen.waiting, true);
	assert.deepEqual(pollFor(screen, input), { method: "remoteTest", everyMs: DNS_POLL_MS });
	// The waiting head is calm and says it checks by itself; it never offers Repair.
	assert.match(STEP_COPY.on_waiting.title, /still being published/);
	assert.match(STEP_COPY.on_waiting.body, /checks again by itself/);
	assert.equal(STEP_COPY.on_waiting.action, undefined);
	// A later test says on: the screen is the plain result and stops polling.
	const test = { state: "on", message: "", connectorUrl: URL_, checks: ok };
	const kept = settleRunAfterTest(run, test);
	const after = { ...input, run: kept, remote: test, checks: test.checks };
	const done = flowScreen(after);
	assert.equal(done.kind, "result");
	assert.equal(done.head, "on");
	assert.equal(done.waiting, false);
	assert.equal(pollFor(done, after), undefined);
});

test("first-F1: a stale run is dropped once a later test says on, so the step never sticks", () => {
	const stale = { state: "problem", code: "tls", message: "tls failed", connectorUrl: URL_, checks: failing("tls", false) };
	const before = flowScreen({ status: funnelRoute, run: stale, checks: stale.checks });
	assert.equal(before.kind, "step");
	assert.equal(before.copy.key, "check_failed");
	const test = { state: "on", message: "", connectorUrl: URL_, checks: ok };
	assert.equal(settleRunAfterTest(stale, test), undefined);
	assert.equal(settleRunAfterTest({ state: "problem", code: "dns", message: "" }, test), undefined);
	// A test that still fails keeps the run; a refusal that isn't about a check is not the test's to clear.
	assert.equal(settleRunAfterTest(stale, { ...stale }), stale);
	const refused = { state: "funnel_not_allowed", message: "" };
	assert.equal(settleRunAfterTest(refused, test), refused);
	// The element runs it on every remoteTest answer.
	assert.match(read("src/dialogs/RemoteFlow.ts"), /settleRunAfterTest\(this\.run, answer\)/);
});

test("setup's 'tunnel not connected by the deadline' names remote fix: a failed check with Repair, not waiting (round 2, second-N2)", () => {
	const stuck = { state: "problem", code: "resource_metadata", message: "", connectorUrl: URL_, next: { kind: "run_command", command: "polycarp remote fix" }, checks: failing("resource_metadata", true) };
	const input = { status: funnelRoute, run: stuck, checks: stuck.checks, fix: { available: true, actions: [{ kind: "restart_serve", what: "Restart", status: "planned" }] } };
	const screen = flowScreen(input);
	assert.equal(screen.kind, "step");
	assert.equal(screen.copy.key, "check_failed");
	assert.equal(screen.copy.action.kind, "repair");
	assert.equal(pollFor(screen, input), undefined);
});

test("second-N3: a check that fails after the tunnel was made is on with a lagging check, not a failed setup", () => {
	// What the host answers for a Cloudflare setup whose last check timed out: the result, its code, a pending check.
	const run = { state: "on", message: "", connectorUrl: "https://p.example.com/mcp", checks: [...ok.slice(0, 2), { name: "resource_metadata", status: "fail", detail: "no answer", pending: true }], connectCode: "TK-7QF3-K2MD" };
	const screen = flowScreen({ status: cloudflareRoute, run, checks: run.checks });
	assert.equal(screen.kind, "result");
	assert.equal(screen.head, "on_waiting");
	// The element turns a lagging tunnel into a run, never a red Failed row and a vanished form.
	const el = read("src/dialogs/RemoteFlow.ts");
	assert.match(el, /this\.takeRun\(\{ state: "on", message: "", \.\.\.result \}\)/);
	assert.match(el, /p\?\.state === "waiting" && id === "signin" \? " for you to sign in" : ""/);
});

test("first-F2: a newer run beats funnel_closed (the operator step and Tailscale's own words show)", () => {
	const closed = { state: "funnel_closed", message: "" };
	const operator = { state: "problem", code: "tailscale_operator", message: "Tailscale's words: access denied", next: { kind: "run_command", command: "sudo tailscale set --operator=$USER" } };
	const input = { status: funnelRoute, remote: closed, run: operator };
	const screen = flowScreen(input);
	assert.equal(screen.copy.key, "tailscale_operator");
	assert.deepEqual(pollFor(screen, input), { method: "remoteFunnel", everyMs: FUNNEL_POLL_MS });
	assert.equal(flowScreen({ ...input, run: { state: "problem", code: "funnel", message: "tailscale funnel failed" } }).copy.key, "funnel");
	// With no run, funnel_closed still comes ahead of the result.
	assert.equal(flowScreen({ status: funnelRoute, remote: closed }).copy.key, "funnel_closed");
	// A refusal about Tailscale itself still wins over an older run.
	assert.equal(flowScreen({ status: funnelRoute, remote: { state: "tailscale_signed_out", message: "" }, run: operator }).copy.key, "tailscale_signed_out");
});

test("first-F3: after ten minutes the Funnel retry stops, the waiting line clears and a button checks again", () => {
	assert.equal(FUNNEL_RETRY_FOR_MS, 10 * 60_000);
	const refused = { state: "funnel_not_allowed", message: "", next: { kind: "open_page", url: "https://login.tailscale.com/f/funnel?node=x" } };
	const input = { status: funnelRoute, remote: { state: "funnel_closed", message: "" }, run: refused, funnelGaveUp: true };
	const screen = flowScreen(input);
	assert.equal(screen.copy.key, "funnel_gave_up");
	assert.equal(screen.copy.action.kind, "open_funnel");
	assert.ok(!screen.copy.waits, "no 'Waiting for you' line once it stopped");
	assert.equal(pollFor(screen, input), undefined);
	assert.equal(screen.copy.title, STEP_COPY.funnel_not_allowed.title);
	// The element marks the window's end as state (so it re-renders) and every retry press resets it.
	const el = read("src/dialogs/RemoteFlow.ts");
	assert.match(el, /@state\(\) private funnelGaveUp = false;/);
	assert.match(el, /private async openFunnel\(\): Promise<void> \{\s*this\.funnelSince = undefined;\s*this\.funnelGaveUp = false;/);
});

test("first-F4: Repair shows only when remote fix exists and has actions, on a step and on the result", () => {
	const run = { state: "problem", code: "tls", message: "", checks: failing("tls", false) };
	const none = flowScreen({ status: status(), chosen: "tailscale", run });
	assert.equal(none.copy.key, "check_failed");
	// No Repair without remote fix; Check again keeps a way forward (PR 136 r2 first-F2).
	const checkAgain = { kind: "check_again", label: RESULT_COPY.checkAgain };
	assert.deepEqual(none.copy.action, checkAgain, "no Repair without remote fix");
	for (const fix of [{ available: false }, { available: true, actions: [] }]) assert.deepEqual(flowScreen({ status: status(), chosen: "tailscale", run, fix }).copy.action, checkAgain);
	const fix = { available: true, actions: [{ kind: "restart_serve", what: "Restart serve", status: "planned" }] };
	assert.equal(flowScreen({ status: status(), chosen: "tailscale", run, fix }).copy.action.kind, "repair");
	// The result: a real failure plus a plan with actions.
	const result = (f, checks) => flowScreen({ status: funnelRoute, checks, ...(f ? { fix: f } : {}) });
	assert.equal(result(fix, failing("tls", false)).repair, true);
	assert.equal(result(undefined, failing("tls", false)).repair, false);
	assert.equal(result({ available: true, actions: [] }, failing("tls", false)).repair, false);
	assert.equal(result(fix, ok).repair, false);
	// A check_failed run asks for the plan.
	assert.match(read("src/dialogs/RemoteFlow.ts"), /copyKey\(rest\) === "check_failed"/);
});

test("second-N4: Choose another way only before anything is set up; a Funnel route offers Cloudflare instead", () => {
	const lock = { state: "tailnet_lock", message: "" };
	const set = flowScreen({ status: funnelRoute, run: { state: "funnel_not_allowed", message: "" } });
	assert.equal(set.kind, "step");
	assert.equal(set.chooseAgain, false);
	assert.equal(set.useCloudflare, true);
	// Tailnet Lock's own button already is Use Cloudflare.
	assert.equal(flowScreen({ status: funnelRoute, remote: lock }).useCloudflare, false);
	const fresh = flowScreen({ status: status(), chosen: "tailscale", remote: { state: "ready", message: "" } });
	assert.equal(fresh.chooseAgain, true);
	assert.equal(fresh.useCloudflare, false);
	const el = read("src/dialogs/RemoteFlow.ts");
	assert.match(el, /screen\.chooseAgain \?/);
	assert.match(el, /screen\.useCloudflare \?/);
});

test("second-N5: 'No passcode was made here' shows only when no passcode is set", () => {
	assert.equal(flowScreen({ status: funnelRoute }).noPasscode, true);
	assert.equal(flowScreen({ status: { ...funnelRoute, passcodeSet: true } }).noPasscode, false);
	assert.match(read("src/dialogs/RemoteFlow.ts"), /screen\.noPasscode \?/);
});

test("second-N2: a result with no code says to press New code; nothing but a press makes one", () => {
	assert.match(RESULT_COPY.codeNone, /New code/);
	const el = read("src/dialogs/RemoteFlow.ts");
	assert.match(el, /RESULT_COPY\.codeNone/);
	// The only way the panel asks the helper for a code is the gesture-gated approvalCode, from a button.
	const calls = el.match(/connectApprovalCode\(\)/g) ?? [];
	assert.equal(calls.length, 1);
});

test("heading nit: titles wrap at 320 px, and the Tailnet Lock title is short", () => {
	assert.ok(STEP_COPY.tailnet_lock.title.length <= 36, STEP_COPY.tailnet_lock.title);
	const el = read("src/dialogs/RemoteFlow.ts");
	assert.match(el, /id="remote-step-title" class="text-sm font-medium text-foreground \[overflow-wrap:anywhere\]"/);
	assert.match(el, /data-result-title class="text-sm font-medium text-foreground \[overflow-wrap:anywhere\]"/);
	assert.match(el, /id="remote-flow-title" class="text-sm font-semibold text-foreground \[overflow-wrap:anywhere\]"/);
});

test("settleRun still keeps a Funnel refusal through a status poll", () => {
	const refused = { state: "funnel_not_allowed", message: "" };
	assert.equal(settleRun(refused, { state: "funnel_closed", message: "" }, funnelRoute), refused);
});
