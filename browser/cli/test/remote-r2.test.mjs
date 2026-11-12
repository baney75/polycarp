// Review round 2 on PR 133 (the leftovers), host side. Every Tailscale, Cloudflare and `remote fix` step is a stand-in:
// nothing here runs tailscale, cloudflared, a service or `remote setup`. The panel side is test/remote-flow-r2.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { rmSync, tempRoot } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = tempRoot("tabkyra-remote-r2-");
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const mod = await loadTs(`
export { ConnectService } from "@src/connect-host.ts";
export { remoteFix, remoteState } from "@src/remote-panel.ts";
export * as tunnel from "@src/tunnel-setup.ts";
`);
const { ConnectService, remoteFix, remoteState, tunnel } = mod;

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

const NAMES = ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming"];
const OK_CHECKS = NAMES.map((name) => ({ name, status: "ok", detail: "fine" }));
const refused = { ok: false, state: "problem", code: "cloudflare_dns", message: "A record for polycarp.example.com already exists.", next: { kind: "choose_name" } };

function tunnelHooks(over = {}) {
	const calls = [];
	return {
		calls,
		cloudflared: async () => ({ ok: true, path: "/stand-in/cloudflared", downloaded: false }),
		signedIn: () => true,
		login: async () => ({ ok: true }),
		setup: async () => (calls.push("setup"), { ok: true, state: "on", message: "", checks: OK_CHECKS }),
		check: async () => (calls.push("check"), { ok: true, detail: "ok" }),
		...over,
	};
}

test("first-F1: setup's refusal comes back as its state, code and next, and the host makes no code for it", async () => {
	await inConfig("f1", async () => {
		// The real hook returns the report whatever it says; only no report at all is an error.
		const got = await tunnel.setupReport({ cloudflare: "polycarp.example.com" }, async (o) => (o.report(refused), 3));
		assert.deepEqual(got, refused);
		await assert.rejects(tunnel.setupReport({}, async () => 1), /didn't finish/);

		const h = tunnelHooks({ setup: async () => (h.calls.push("setup"), refused) });
		const seen = [];
		const done = await tunnel.setupTunnel("polycarp.example.com", (p) => seen.push(p), h, { checkTotalMs: 50, checkEveryMs: 10 });
		assert.deepEqual(done.problem, refused);
		assert.equal(h.calls.includes("check"), false, "nothing is checked for a tunnel that wasn't made");
		assert.equal(seen.find((p) => p.state === "failed")?.step, "tunnel");
		assert.equal(seen.some((p) => p.step === "tunnel" && p.state === "done"), false);

		const service = new ConnectService({ tunnel: tunnelHooks({ setup: async () => refused }), tunnelCheckMs: 30 });
		const { result, error } = await ask(service, "setupTunnel", { host: "polycarp.example.com" });
		assert.equal(error, undefined);
		assert.equal(result.problem.state, "problem");
		assert.equal(result.problem.code, "cloudflare_dns");
		assert.equal(result.problem.next.kind, "choose_name");
		assert.equal(result.connectCode, undefined);
	});
});

test("first-F5: a lagging metadata check takes the report's own place in the list", async () => {
	await inConfig("f5", async () => {
		const h = tunnelHooks({ check: async () => ({ ok: false, detail: "no answer" }) });
		const done = await tunnel.setupTunnel("polycarp.example.com", () => {}, h, { checkTotalMs: 30, checkEveryMs: 10 });
		assert.deepEqual(
			done.checks.map((c) => c.name),
			NAMES,
		);
		assert.equal(done.checks[2].pending, true);
		assert.equal(done.checks[2].status, "fail");
	});
});

test("first-F3: remoteState reads Tailscale without blocking the native host", async () => {
	await inConfig("f3", async (dir) => {
		writeFileSync(join(dir, "remote.json"), JSON.stringify({ publicUrl: "https://m.tail1.ts.net:8443", port: 8787, route: "funnel" }));
		// So no real tailscale is ever found here, with or without the fix.
		const empty = join(dir, "empty");
		mkdirSync(empty, { recursive: true });
		const saved = { PATH: process.env.PATH, APPLICATIONS_DIR: process.env.APPLICATIONS_DIR };
		process.env.PATH = empty;
		process.env.APPLICATIONS_DIR = empty;
		const calls = [];
		const answers = {
			"lock status": "Tailnet lock is NOT enabled.",
			"status --json": JSON.stringify({ Self: { DNSName: "m.tail1.ts.net." } }),
			"serve status --json": JSON.stringify({ AllowFunnel: { "m.tail1.ts.net:8443": true } }),
		};
		const run = (_cmd, args) =>
			new Promise((resolve) => {
				calls.push(args.join(" "));
				setTimeout(() => resolve({ code: 0, out: answers[args.join(" ")] ?? "" }), 60);
			});
		let ticks = 0;
		const timer = setInterval(() => ticks++, 5);
		try {
			const answer = await remoteState({ run, tailscale: () => "/stand-in/tailscale" });
			assert.equal(answer.state, "on");
			assert.deepEqual(answer.routes.tailscale, { installed: true, signedIn: true });
		} finally {
			clearInterval(timer);
			process.env.PATH = saved.PATH;
			if (saved.APPLICATIONS_DIR === undefined) delete process.env.APPLICATIONS_DIR;
			else process.env.APPLICATIONS_DIR = saved.APPLICATIONS_DIR;
		}
		assert.ok(calls.includes("lock status") && calls.includes("serve status --json"), calls.join(", "));
		assert.ok(ticks >= 10, `timers ran ${ticks} times while Tailscale was asked`);
	});
	// No probe in the panel's module runs Tailscale synchronously.
	const src = readFileSync(join(here, "../src/remote-panel.ts"), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
	assert.doesNotMatch(src, /\b(remoteRoutes|tailscaleReady|planFunnel)\b(?!Async)/);
});

test("second-N1: Repair keeps what the person must do next and the advice, each command on one short line", async () => {
	const out = JSON.stringify({
		ok: false,
		state: "problem",
		code: "tailscale_operator",
		message: "Tailscale refused: access denied",
		next: { kind: "run_command", command: "sudo tailscale set --operator=$USER" },
		advice: [
			{ name: "linger", detail: "Services stop when you log out.", command: "loginctl enable-linger me" },
			{ name: "odd", detail: "two lines", command: "a\nb" },
			"junk",
		],
		actions: [],
	});
	const done = await remoteFix(false, async () => ({ code: 3, out }));
	assert.equal(done.ok, false);
	assert.deepEqual(done.next, { kind: "run_command", command: "sudo tailscale set --operator=$USER" });
	assert.deepEqual(done.advice, [
		{ name: "linger", detail: "Services stop when you log out.", command: "loginctl enable-linger me" },
		{ name: "odd", detail: "two lines" },
	]);
});

test("second-N2: a Turn on that ends with `remote fix` gets no connect code", async () => {
	await inConfig("n2", async () => {
		const stuck = {
			state: "problem",
			code: "resource_metadata",
			message: "the tunnel never connected",
			connectorUrl: "https://m.tail1.ts.net:8443/mcp",
			next: { kind: "run_command", command: "polycarp remote fix" },
			checks: [{ name: "resource_metadata", status: "fail", detail: "no answer", pending: true }],
		};
		const service = new ConnectService({ remote: { setup: async () => stuck } });
		const { result, error } = await ask(service, "remoteSetup");
		assert.equal(error, undefined);
		assert.equal(result.code, "resource_metadata");
		assert.equal(result.connectCode, undefined);
	});
});
