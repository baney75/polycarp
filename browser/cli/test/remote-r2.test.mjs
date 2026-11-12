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
export { remoteStatus, tailscaleReadyAsync } from "@src/remote-setup.ts";
export * as tunnel from "@src/tunnel-setup.ts";
`);
const { ConnectService, remoteFix, remoteState, remoteStatus, tailscaleReadyAsync, tunnel } = mod;

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

// PR 136 review round 1, host side. The panel side is at the end of test/remote-flow-r2.test.mjs.

/** No real tailscale or Tailscale app is found while `fn` runs. */
async function noTailscale(dir, fn) {
	const empty = join(dir, "empty");
	mkdirSync(empty, { recursive: true });
	// TABKYRA_APPLICATIONS_DIR is the name tailscaleAppPath reads, so the real Tailscale app is never found either.
	const saved = { PATH: process.env.PATH, APPLICATIONS_DIR: process.env.TABKYRA_APPLICATIONS_DIR };
	process.env.PATH = empty;
	process.env.TABKYRA_APPLICATIONS_DIR = empty;
	try {
		return await fn();
	} finally {
		process.env.PATH = saved.PATH;
		if (saved.APPLICATIONS_DIR === undefined) delete process.env.TABKYRA_APPLICATIONS_DIR;
		else process.env.TABKYRA_APPLICATIONS_DIR = saved.APPLICATIONS_DIR;
	}
}

test("PR 136 first-F1: a new tunnel still connecting is on and waiting with its connect code, not a refusal", async () => {
	await inConfig("r136-f1", async () => {
		const lagging = { name: "resource_metadata", status: "fail", detail: "502 from the tunnel", pending: true };
		const connecting = {
			ok: false,
			state: "problem",
			code: "resource_metadata",
			message: "The tunnel hasn't connected yet.",
			connectorUrl: "https://polycarp.example.com/mcp",
			next: { kind: "run_command", command: "polycarp remote test" },
			checks: OK_CHECKS.map((c) => (c.name === "resource_metadata" ? lagging : c)),
		};
		const h = tunnelHooks({ setup: async () => (h.calls.push("setup"), connecting), check: async () => (h.calls.push("check"), { ok: false, detail: "502" }) });
		const seen = [];
		const done = await tunnel.setupTunnel("polycarp.example.com", (p) => seen.push(p), h, { checkTotalMs: 30, checkEveryMs: 10 });
		assert.equal(done.problem, undefined, "not drawn as a refusal");
		assert.ok(h.calls.includes("check"), "the check step runs");
		assert.equal(seen.some((p) => p.step === "tunnel" && p.state === "failed"), false, "the tunnel row isn't marked failed");
		assert.equal(done.checks.find((c) => c.name === "resource_metadata").pending, true);

		const service = new ConnectService({ tunnel: tunnelHooks({ setup: async () => connecting, check: async () => ({ ok: false, detail: "502" }) }), tunnelCheckMs: 30 });
		const { result, error } = await ask(service, "setupTunnel", { host: "polycarp.example.com" });
		assert.equal(error, undefined);
		assert.equal(result.problem, undefined);
		assert.match(result.connectCode, /^TK-/, "the press gets its code");

		// Setup that gave up waiting and names remote fix is still a refusal: a problem with Repair and no code.
		const stuck = { ...connecting, next: { kind: "run_command", command: "polycarp remote fix" } };
		const h2 = tunnelHooks({ setup: async () => stuck });
		assert.deepEqual((await tunnel.setupTunnel("polycarp.example.com", () => {}, h2, { checkTotalMs: 30, checkEveryMs: 10 })).problem, stuck);
	});
});

test("PR 136 first-F3: one remoteState poll reads Tailscale once", async () => {
	const answers = {
		"lock status": "Tailnet lock is NOT enabled.",
		"status --json": JSON.stringify({ Self: { DNSName: "m.tail1.ts.net." } }),
		"serve status --json": JSON.stringify({ AllowFunnel: { "m.tail1.ts.net:8443": true } }),
	};
	for (const saved of [undefined, { publicUrl: "https://m.tail1.ts.net:8443", port: 8787, route: "funnel" }]) {
		await inConfig(`r136-f3-${saved ? "funnel" : "none"}`, async (dir) => {
			if (saved) writeFileSync(join(dir, "remote.json"), JSON.stringify(saved));
			const calls = [];
			const run = async (_cmd, args) => (calls.push(args.join(" ")), { code: 0, out: answers[args.join(" ")] ?? "" });
			await noTailscale(dir, () => remoteState({ run, tailscale: () => "/stand-in/tailscale" }));
			for (const read of Object.keys(answers)) assert.equal(calls.filter((c) => c === read).length, 1, `${read} on ${saved ? "a Funnel route" : "nothing saved"}: ${calls.join(", ")}`);
		});
	}
});

test("PR 136 second-S5: a Tailscale read that times out is unreadable, not signed out", async () => {
	const slow = (which) => async (_cmd, args) =>
		args.join(" ") === which ? { code: 1, out: "tailscale timed out after 15 s", timedOut: true } : { code: 0, out: args[0] === "lock" ? "Tailnet lock is NOT enabled." : JSON.stringify({ Self: { DNSName: "m.tail1.ts.net." } }) };
	for (const which of ["status --json", "lock status", "serve status --json"]) {
		const ready = await tailscaleReadyAsync({ run: slow(which), tailscale: () => "/stand-in/tailscale" });
		assert.equal(ready.ok, true, which);
		assert.equal(ready.state.kind, "unreadable", which);
		assert.match(ready.state.why, /didn't answer/, which);
	}
	// Nothing saved: the step says Tailscale didn't answer, never "Sign in to Tailscale".
	await inConfig("r136-s5", async (dir) => {
		const answer = await noTailscale(dir, () => remoteState({ run: slow("status --json"), tailscale: () => "/stand-in/tailscale" }));
		assert.notEqual(answer.state, "tailscale_signed_out");
		assert.equal(answer.state, "problem");
		assert.match(answer.message, /didn't answer/);
	});
	// On a saved Funnel route too: a problem in Tailscale's words, never the sign-in step and never "on".
	await inConfig("r136-s5-funnel", async (dir) => {
		writeFileSync(join(dir, "remote.json"), JSON.stringify({ publicUrl: "https://m.tail1.ts.net:8443", port: 8787, route: "funnel" }));
		const answer = await noTailscale(dir, () => remoteState({ run: slow("serve status --json"), tailscale: () => "/stand-in/tailscale" }));
		assert.equal(answer.state, "problem");
		assert.match(answer.message, /didn't answer/);
	});
	// A plain empty answer still means signed out.
	const out = await tailscaleReadyAsync({ run: async (_c, a) => ({ code: 0, out: a[0] === "lock" ? "" : "{}" }), tailscale: () => "/stand-in/tailscale" });
	assert.equal(out.state, "tailscale_signed_out");
});

// ---------- PR 136 review round 2: first-F1 and second-S1 ----------

/** A stand-in Tailscale whose `which` read hits the probe limit; every other read is a signed-in machine with Funnel open. */
const hung = (which) => async (_cmd, args) => {
	const read = args.join(" ");
	if (read === which) return { code: 1, out: "tailscale timed out after 15 s", timedOut: true };
	if (read === "lock status") return { code: 0, out: "Tailnet lock is NOT enabled." };
	if (read === "status --json") return { code: 0, out: JSON.stringify({ Self: { DNSName: "m.tail1.ts.net." } }) };
	return { code: 0, out: JSON.stringify({ AllowFunnel: { "m.tail1.ts.net:8443": true } }) };
};
const FUNNEL_JSON = JSON.stringify({ publicUrl: "https://m.tail1.ts.net:8443", port: 8787, route: "funnel" });

test("PR 136 r2 first-F1 and second-S1: Tailscale not answering carries tailscale_silent, saved route or not", async () => {
	for (const which of ["lock status", "status --json", "serve status --json"]) {
		for (const saved of [false, true]) {
			await inConfig(`r136r2-silent-${saved ? "funnel" : "none"}-${which.replaceAll(" ", "-")}`, async (dir) => {
				if (saved) writeFileSync(join(dir, "remote.json"), FUNNEL_JSON);
				const answer = await noTailscale(dir, () => remoteState({ run: hung(which), tailscale: () => "/stand-in/tailscale" }));
				assert.equal(answer.state, "problem", which);
				assert.equal(answer.code, "tailscale_silent", `${which}, ${saved ? "saved" : "nothing saved"}`);
				assert.match(answer.message, /didn't answer within 15 seconds/);
			});
		}
	}
});

test("PR 136 r2 first-F1: remote status --json, the Mac app's read, answers a hung Tailscale with tailscale_silent from the 15 s probe", async () => {
	for (const saved of [false, true]) {
		await inConfig(`r136r2-status-${saved ? "funnel" : "none"}`, async (dir) => {
			if (saved) writeFileSync(join(dir, "remote.json"), FUNNEL_JSON);
			const calls = [];
			const run = async (cmd, args) => (calls.push(args.join(" ")), hung("serve status --json")(cmd, args));
			let printed = "";
			const write = process.stdout.write;
			// The report is one string write; the test runner's own frames (Buffers) pass through untouched.
			process.stdout.write = (chunk, ...rest) => (typeof chunk === "string" ? ((printed += chunk), true) : write.call(process.stdout, chunk, ...rest));
			let exit;
			try {
				// No tailscale on PATH: only the probe seam can reach the stand-in, so a sync read would say "not installed".
				exit = await noTailscale(dir, () => remoteStatus({ json: true }, { run, tailscale: () => "/stand-in/tailscale" }));
			} finally {
				process.stdout.write = write;
			}
			const report = JSON.parse(printed);
			assert.equal(report.state, "problem", printed);
			assert.equal(report.code, "tailscale_silent", printed);
			if (saved) assert.equal(report.ok, false, "a saved route that Tailscale can't confirm is not ok");
			assert.equal(exit, report.ok ? 0 : 1);
			// Tailscale is read once, through the probes and their limit.
			assert.equal(calls.filter((c) => c === "serve status --json").length, 1, calls.join(", "));
		});
	}
});
