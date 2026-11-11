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
export { remoteAnswer, nextView, remoteSetupTailscale, remoteOpenFunnel, remoteFix, remoteTest } from "@src/remote-panel.ts";
export { setPasscode } from "@src/oauth.ts";
`);
const { ConnectService, parseConnect, failureFor, remoteAnswer, nextView, remoteSetupTailscale, remoteOpenFunnel, remoteFix, remoteTest, setPasscode } = mod;

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
		// Through the service, an opened Funnel brings a connect code.
		const service = new ConnectService({ remote: { funnel: seam(async () => ({ kind: "opened" })) } });
		writeJson(join(process.env.TABKYRA_CONFIG_DIR, "remote.json"), funnelConfig());
		const { result } = await ask(service, "remoteFunnel");
		assert.equal(result.state, "on");
		assert.ok(result.connectCode);
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

test("the passcode is never made by a panel setup, so a passcode set before stays and none is created", async () => {
	await inConfig("no-passcode", async (dir) => {
		writeJson(join(dir, "remote.json"), funnelConfig());
		const service = new ConnectService({ remote: { setup: async () => ({ state: "on", message: "", connectorUrl: "https://m.tail1.ts.net:8443/mcp" }) } });
		await ask(service, "remoteSetup");
		assert.equal((await ask(service, "status")).result.passcodeSet, false);
		setPasscode();
		const { result } = await ask(service, "remoteSetup");
		assert.equal(result.passcode, undefined);
	});
});
