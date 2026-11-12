// "Use Polycarp from Claude, ChatGPT and Grok", host side: the six remote methods Connect's flow calls. Every Tailscale,
// Cloudflare and `remote fix` step is a stand-in; nothing here runs tailscale, cloudflared, a service or `remote setup`.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { rmSync, tempRoot, writeJson } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = tempRoot("tabkyra-connect-remote-");
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const mod = await loadTs(`
export { ConnectService, parseConnect, failureFor } from "@src/connect-host.ts";
export { remoteAnswer, nextView, remoteSetupTailscale, remoteOpenFunnel, remoteFix, remoteTest, configProblem } from "@src/remote-panel.ts";
`);
const { ConnectService, parseConnect, failureFor, remoteAnswer, nextView, remoteSetupTailscale, remoteOpenFunnel, remoteFix, remoteTest, configProblem } = mod;

async function inConfig(name, fn) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const before = process.env.TABKYRA_CONFIG_DIR;
	process.env.TABKYRA_CONFIG_DIR = dir;
	try {
		return await fn(dir);
	} finally {
		if (before === undefined) delete process.env.TABKYRA_CONFIG_DIR;
		else process.env.TABKYRA_CONFIG_DIR = before;
	}
}

async function ask(service, method, params) {
	const frames = [];
	await service.handle({ type: "connect", id: 7, method, ...(params === undefined ? {} : { params }) }, (f) => frames.push(f));
	const last = frames.at(-1);
	return { result: last?.result, error: last?.error, progress: frames.filter((f) => f.progress).map((f) => f.progress) };
}

const METHODS = ["remoteState", "remoteSetup", "remoteFunnel", "remoteTest", "remoteFixPlan", "remoteFix"];
const OK_CHECKS = ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming"].map((name) => ({ name, status: "ok", detail: "fine" }));
const funnelConfig = () => ({ publicUrl: "https://m.tail1.ts.net:8443", port: 8787, route: "funnel" });
const seam = (open) => ({ load: funnelConfig, plan: () => ({ ok: true, bin: "/stand-in/tailscale", dns: "m.tail1.ts.net" }), open, checks: async () => OK_CHECKS });

test("the remote methods take no parameters: nothing the page holds reaches a command line", () => {
	for (const method of METHODS) {
		assert.equal(parseConnect({ type: "connect", id: 1, method }).ok, true, method);
		const bad = parseConnect({ type: "connect", id: 1, method, params: { command: "rm -rf ~" } });
		assert.equal(bad.ok, false, method);
	}
});

test("an answer never carries the passcode, and a next step is only an https page or one short line", () => {
	const answer = remoteAnswer({ ok: true, state: "on", message: "Connector ready.", passcode: "correct-horse-battery", passcodeSet: true, connectorUrl: "https://m.ts.net:8443/mcp" });
	assert.ok(!JSON.stringify(answer).includes("correct-horse-battery"));
	assert.equal(answer.passcodeSet, true);
	assert.equal(nextView({ kind: "open_page", url: "https://login.tailscale.com/f/funnel?node=x" })?.url, "https://login.tailscale.com/f/funnel?node=x");
	assert.equal(nextView({ kind: "open_page", url: "http://login.tailscale.com/" })?.url, undefined);
	assert.equal(nextView({ kind: "open_page", url: "https://user:pw@login.tailscale.com/" })?.url, undefined);
	assert.equal(nextView({ kind: "run_command", command: "tailscale up\nrm -rf ~" })?.command, undefined);
	assert.equal(nextView({ kind: "made_up" }), undefined);
});

test("Turn on runs the Tailscale setup with no passcode, and an 'on' answer comes back with a fresh connect code", async () => {
	let seen;
	const answer = await remoteSetupTailscale(async (options) => {
		seen = options;
		options.report({ ok: true, state: "on", message: "Connector ready.", passcode: "never-shown", connectorUrl: "https://m.ts.net:8443/mcp" });
	});
	assert.equal(seen.tailscale, true);
	assert.equal(seen.passcode, false);
	assert.equal(answer.state, "on");
	assert.ok(!JSON.stringify(answer).includes("never-shown"));
	await inConfig("setup-on", async (dir) => {
		writeJson(join(dir, "remote.json"), funnelConfig());
		const service = new ConnectService({ remote: { setup: async () => answer } });
		const { result, error } = await ask(service, "remoteSetup");
		assert.equal(error, undefined);
		assert.equal(result.state, "on");
		assert.match(result.connectCode, /^[A-Z0-9-]{6,}$/);
		assert.ok(result.connectCodeExpiresAt > Date.now());
		// Nothing secret is written by the host for the panel: no file named for the code or the panel.
		assert.ok(!readdirSync(dir).some((f) => /panel|connect-code/i.test(f)), readdirSync(dir).join(","));
	});
});

test("a refusal comes back as the helper's state, with no code; a long setup keeps the panel's wait alive", async () => {
	await inConfig("setup-refused", async () => {
		const service = new ConnectService({ keepAliveMs: 5, remote: { setup: () => new Promise((r) => setTimeout(() => r({ state: "funnel_not_allowed", message: "Funnel isn't enabled.", next: { kind: "open_page", url: "https://login.tailscale.com/f/funnel" } }), 40)) } });
		const { result, progress } = await ask(service, "remoteSetup");
		assert.equal(result.state, "funnel_not_allowed");
		assert.equal(result.connectCode, undefined);
		assert.ok(progress.length >= 2, `keep-alive frames: ${progress.length}`);
		assert.deepEqual(progress[0], { step: "remoteSetup" });
	});
});

test("opening Funnel again: not allowed names Tailscale's page, allowed turns on and checks from outside", async () => {
	await inConfig("funnel", async () => {
		const refused = await remoteOpenFunnel(seam(async () => ({ kind: "not_allowed", url: "https://login.tailscale.com/f/funnel?node=abc" })));
		assert.equal(refused.state, "funnel_not_allowed");
		assert.deepEqual(refused.next, { kind: "open_page", url: "https://login.tailscale.com/f/funnel?node=abc" });
		const on = await remoteOpenFunnel(seam(async () => ({ kind: "opened" })));
		assert.equal(on.state, "on");
		assert.equal(on.connectorUrl, "https://m.tail1.ts.net:8443/mcp");
		assert.equal(on.checks.length, 6);
		const failed = await remoteOpenFunnel(seam(async () => ({ kind: "failed", message: "serve config conflict" })));
		assert.equal(failed.state, "problem");
		assert.equal(failed.code, "funnel");
		const none = await remoteOpenFunnel({ ...seam(async () => ({ kind: "opened" })), load: () => undefined });
		assert.equal(none.code, "not_set_up");
	});
});

test("the outside checks: a failed one names its check; nothing set up says so", async () => {
	const bad = await remoteTest(async () => OK_CHECKS.map((c) => (c.name === "tls" ? { ...c, status: "fail", detail: "certificate expired" } : c)), funnelConfig);
	assert.equal(bad.state, "problem");
	assert.equal(bad.code, "tls");
	assert.equal((await remoteTest(async () => OK_CHECKS, funnelConfig)).state, "on");
	assert.equal((await remoteTest(async () => OK_CHECKS, () => undefined)).code, "not_set_up");
});

test("Repair is feature-detected: a helper without `remote fix` answers available: false, and the host passes fixed arguments only", async () => {
	const calls = [];
	const without = await remoteFix(true, async (args) => (calls.push(args), { code: 2, out: "Usage: polycarp remote setup | status | off | test" }));
	assert.deepEqual(without, { available: false });
	assert.deepEqual(calls[0], ["remote", "fix", "--json", "--dry-run"]);
	const plan = await remoteFix(true, async () => ({ code: 0, out: JSON.stringify({ ok: true, state: "on", code: "fix_pending", message: "Would restart the service.", actions: [{ kind: "service", what: "Restart the background service", status: "planned" }] }) }));
	assert.equal(plan.available, true);
	assert.equal(plan.actions.length, 1);
	await remoteFix(false, async (args) => (calls.push(args), { code: 0, out: JSON.stringify({ ok: true, state: "on", message: "Fixed.", actions: [] }) }));
	assert.deepEqual(calls.at(-1), ["remote", "fix", "--json", "--yes"]);
	assert.deepEqual(await remoteFix(true, async () => ({ code: 0, out: "not json" })), { available: false });
});

test("every method's failure has its own sentence naming a command, never one generic line", () => {
	const seen = new Set();
	for (const method of ["status", "approvalCode", "deviceCode", "setBusy", "joinHub", "setupTunnel", ...METHODS.filter((m) => m !== "remoteFixPlan")]) {
		const text = failureFor(method, Object.assign(new Error("x"), { code: "EACCES" }));
		assert.match(text, /\(EACCES\)/, method);
		assert.ok(!seen.has(text), `${method} repeats another method's sentence`);
		seen.add(text);
	}
	assert.doesNotMatch(readFileSync(new URL("../src/connect-host.ts", import.meta.url), "utf8"), /GENERIC_FAILURE/);
});

// ---------- Review round 1 ----------

const pendingDns = [{ name: "dns", status: "fail", detail: "m.tail1.ts.net has no public address yet", pending: true }];

test("second-N2: no method but a pressed one mints a code: the Funnel retry answers on with no code, and a code counts no slot", async () => {
	await inConfig("n2", async (dir) => {
		writeJson(join(dir, "remote.json"), funnelConfig());
		const service = new ConnectService({ remote: { funnel: seam(async () => ({ kind: "opened" })), test: async () => remoteAnswer({ state: "on", message: "", checks: OK_CHECKS }), state: async () => remoteAnswer({ state: "on", message: "" }), runSelf: async () => ({ code: 0, out: JSON.stringify({ ok: true, state: "on", message: "", actions: [] }) }) } });
		for (let i = 0; i < 12; i++) {
			const { result, error } = await ask(service, "remoteFunnel");
			assert.equal(error, undefined);
			assert.equal(result.state, "on");
			assert.equal(result.connectCode, undefined, "the retry minted a code");
			assert.equal(result.connectCodeProblem, undefined);
		}
		for (const method of ["remoteState", "remoteTest", "remoteFixPlan", "remoteFix"]) {
			const { result } = await ask(service, method);
			assert.equal(result.connectCode, undefined, method);
		}
		// Twelve retries used none of the ten-in-ten-minutes slots: a pressed New code still works.
		const { result, error } = await ask(service, "approvalCode");
		assert.equal(error, undefined);
		assert.match(result.code, /^TK-/);
	});
	// The invariant in the source: resultCode() is called only from methods that need a gesture.
	const host = readFileSync(new URL("../src/connect-host.ts", import.meta.url), "utf8");
	const { GESTURE_METHODS } = await loadTs(`export { GESTURE_METHODS } from "@src/../../src/connect/types.ts";`);
	const callers = [...host.matchAll(/private async (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/g)].filter((m) => m[2].includes("this.resultCode()")).map((m) => m[1]);
	assert.deepEqual(callers.sort(), ["remoteSetup", "setupTunnel"]);
	for (const m of callers) assert.ok(GESTURE_METHODS.includes(m), `${m} mints a code without a gesture`);
});

test("first-F1: Turn on with a brand-new name is on (DNS pending) and, being a press, brings a code", async () => {
	await inConfig("f1-setup", async (dir) => {
		writeJson(join(dir, "remote.json"), funnelConfig());
		const lagging = remoteAnswer({ state: "problem", code: "dns", message: "dns failed", connectorUrl: "https://m.tail1.ts.net:8443/mcp", checks: pendingDns });
		const service = new ConnectService({ remote: { setup: async () => lagging } });
		const { result } = await ask(service, "remoteSetup");
		assert.match(result.connectCode, /^TK-/);
		assert.equal(result.checks[0].pending, true);
		// A real fault after setup gets no code: it isn't on.
		const fault = remoteAnswer({ state: "problem", code: "tls", message: "tls failed", connectorUrl: "https://m.tail1.ts.net:8443/mcp", checks: [{ name: "dns", status: "ok", detail: "ok" }, { name: "tls", status: "fail", detail: "expired" }] });
		const bad = await ask(new ConnectService({ remote: { setup: async () => fault } }), "remoteSetup");
		assert.equal(bad.result.connectCode, undefined);
	});
});

test("pending reaches the panel: a lagging name opens Funnel as on with a pending check; a real fault is a problem", async () => {
	const lag = await remoteOpenFunnel({ ...seam(async () => ({ kind: "opened" })), checks: async () => pendingDns });
	assert.equal(lag.state, "on");
	assert.deepEqual(lag.checks, pendingDns);
	const fault = await remoteOpenFunnel({ ...seam(async () => ({ kind: "opened" })), checks: async () => OK_CHECKS.map((c) => (c.name === "tls" ? { ...c, status: "fail", detail: "expired" } : c)) });
	assert.equal(fault.state, "problem");
	assert.equal(fault.code, "tls");
	assert.equal(remoteAnswer({ state: "on", message: "", checks: [{ name: "dns", status: "fail", detail: "x", pending: "yes" }] }).checks[0].pending, undefined, "only a boolean true passes");
});

test("first-F5: the panel's Funnel and state answers carry no passcodeSet, so a bad oauth.json can't stop them", async () => {
	await inConfig("f5", async (dir) => {
		writeJson(join(dir, "oauth.json"), "not an object");
		const on = await remoteOpenFunnel(seam(async () => ({ kind: "opened" })));
		assert.equal(on.state, "on");
		assert.equal(on.passcodeSet, undefined);
	});
	assert.doesNotMatch(readFileSync(new URL("../src/remote-panel.ts", import.meta.url), "utf8"), /passcodeSet\(\)/);
});

test("first-F6: a malformed remote.json is a fixed sentence, never the parser's words or the file's start", () => {
	const answer = configProblem(new SyntaxError('Unexpected token \'s\', "secret-tok"... is not valid JSON'));
	assert.equal(answer.state, "problem");
	assert.equal(answer.code, "config");
	assert.doesNotMatch(answer.message, /secret|Unexpected|JSON/);
	assert.match(answer.message, /remote\.json couldn't be read\. Run \S+ remote status/);
});

test("second-N3: Cloudflare's last check timing out after the tunnel was made is on, with a pending check and a code", async () => {
	await inConfig("n3", async () => {
		const tunnel = {
			cloudflared: async () => ({ ok: true, path: "/stand-in/cloudflared", downloaded: false }),
			signedIn: () => true,
			login: async () => ({ ok: true }),
			setup: async () => ({ ok: true, state: "on", message: "", checks: [{ name: "dns", status: "ok", detail: "ok" }] }),
			check: async () => ({ ok: false, detail: "no answer" }),
		};
		const service = new ConnectService({ tunnel, tunnelCheckMs: 30 });
		const { result, error, progress } = await ask(service, "setupTunnel", { host: "polycarp.example.com" });
		assert.equal(error, undefined);
		assert.equal(result.connectorUrl, "https://polycarp.example.com/mcp");
		assert.match(result.connectCode, /^TK-/);
		const lag = result.checks.find((c) => c.status === "fail");
		assert.equal(lag.name, "resource_metadata");
		assert.equal(lag.pending, true);
		assert.ok(progress.some((p) => p.step === "check" && p.state === "waiting"), JSON.stringify(progress));
		assert.ok(!progress.some((p) => p.state === "failed"));
	});
});
