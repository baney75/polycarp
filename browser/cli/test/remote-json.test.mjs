// `tabkyra remote setup --json` and `remote status --json`: the structured states Polycarp's app reads, so it never
// scrapes a sentence. tailscale, launchctl and systemctl are stubs in a temp HOME; nothing here touches a real Tailscale,
// a real service manager or ~/.config/tabkyra. Run with --experimental-strip-types (it imports src/remote-state.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { completeFunnelAdminUrl, funnelAdminUrl, REMOTE_STATES, stateFromStatus } from "../src/remote-state.ts";
import { ENABLE_URL, writeTailscaleStub } from "./helpers/tailscale-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-remote-json-"));
const DNS = "mac.example.ts.net";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const PASSCODE = /^([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}$/;
const FUNNEL_URL = `https://${DNS}:8443`;

/**
 * A scenario with its own HOME and config dir and stub tailscale, launchctl and systemctl. tailscale: false leaves it off PATH.
 * funnel: how `tailscale funnel --bg` behaves (helpers/tailscale-stub.mjs); funnelFails is shorthand for "fail" printing that text.
 * app: the stub lives where the Tailscale Mac app keeps it (under TABKYRA_APPLICATIONS_DIR), not on PATH.
 */
function scenario(name, { lock = "Tailnet lock is NOT enabled.", status = `{"Self":{"DNSName":"${DNS}."}}`, serveStatus = "{}", funnelFails = "", funnel = funnelFails ? "fail" : "enabled", tailscale = true, tailscaleDir = "bin", app = false, funnelOffFails = false } = {}) {
	const dir = join(root, name);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	const log = join(dir, "calls.log");
	mkdirSync(bin, { recursive: true });
	// node alone on PATH, as a symlink: never node's own directory, where a real tailscale can sit (Homebrew, /usr/bin on Linux).
	symlinkSync(process.execPath, join(bin, "node"));
	mkdirSync(join(dir, tailscaleDir), { recursive: true });
	mkdirSync(home, { recursive: true });
	const sock = join(dir, "sock");
	mkdirSync(sock, { recursive: true, mode: 0o700 });
	const script = (path, body) => {
		writeFileSync(path, `#!/bin/sh\n${body}`);
		chmodSync(path, 0o755);
	};
	const apps = join(dir, "apps");
	mkdirSync(apps, { recursive: true });
	const stubFile = app ? join(apps, "Tailscale.app", "Contents", "MacOS", "Tailscale") : join(dir, tailscaleDir, "tailscale");
	const stub = tailscale ? writeTailscaleStub(stubFile, { dir, log, dns: DNS, lock, status, serveStatus, funnel, funnelText: funnelFails, funnelOffFails }) : undefined;
	script(join(bin, "launchctl"), `echo "launchctl $*" >> ${log}\ncase "$1" in\nprint) exit 1 ;;\nesac\n`);
	script(join(bin, "systemctl"), `echo "systemctl $*" >> ${log}\n`);
	// The test's own env, never the caller's: HOME, config and sockets all live in the temp dir.
	const env = {
		HOME: home,
		TABKYRA_CONFIG_DIR: join(home, "cfg"),
		TABKYRA_SOCKET_DIR: sock,
		NO_COLOR: "1",
		PATH: bin,
		// An empty temp dir, so a real /Applications/Tailscale.app is never found or run.
		TABKYRA_APPLICATIONS_DIR: apps,
	};
	const run = (args, extra = {}) => {
		const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
		return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
	};
	const runAsync = (args, extra = {}) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra } });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
		});
	return {
		env,
		dir,
		home,
		script: (name, body) => script(join(bin, name), body),
		/** The launcher `polycarp browser install` writes: an executable script that runs an existing file. */
		launcher: () => {
			const path = join(home, "cfg", "polycarp");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
			chmodSync(path, 0o755);
			return path;
		},
		stub,
		run,
		runAsync,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		remoteJsonExists: () => existsSync(join(env.TABKYRA_CONFIG_DIR, "remote.json")),
	};
}

async function localServer(resource) {
	const srv = createHttpServer((req, res) => {
		if (req.url !== METADATA_PATH) {
			res.statusCode = 404;
			res.end("not here");
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ resource }));
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	return { port: srv.address().port, close: () => new Promise((resolve) => srv.close(resolve)) };
}

const freePort = () =>
	new Promise((resolve) => {
		const srv = createNetServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});

const noFunnelChange = (s) => assert.deepEqual(s.calls().filter((x) => x.startsWith("tailscale funnel")), [], s.calls().join("\n"));

// ---------- the pure parts ----------

test("funnelAdminUrl takes the page Tailscale prints and drops sentence punctuation", () => {
	assert.equal(funnelAdminUrl("Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/funnel?node=n123abc\n"), "https://login.tailscale.com/f/funnel?node=n123abc");
	assert.equal(funnelAdminUrl("Enable it at https://login.tailscale.com/admin/dns."), "https://login.tailscale.com/admin/dns");
	assert.equal(funnelAdminUrl("Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https."), undefined, "a docs link is a different failure, not the enablement page");
	assert.equal(funnelAdminUrl("see https://login.tailscale.com/f/funnel?node=n1)"), "https://login.tailscale.com/f/funnel?node=n1");
	assert.equal(completeFunnelAdminUrl("To enable, visit:\n https://login.tailscale.com/f/fun"), undefined, "a chunk that stops mid-address isn't the address");
	assert.equal(completeFunnelAdminUrl("To enable, visit:\n https://login.tailscale.com/f/funnel?node=n1\n"), "https://login.tailscale.com/f/funnel?node=n1");
	assert.equal(funnelAdminUrl("failed: listener closed"), undefined);
	assert.equal(funnelAdminUrl("go to https://evil.example/login.tailscale.com/x"), undefined, "only Tailscale's own hosts count");
});

test("stateFromStatus: preflight when nothing is set up; problem, no_browser_connected or on once it is", () => {
	const ok = { name: "local serve", status: "ok", detail: "" };
	const warn = { name: "OAuth clients", status: "warn", detail: "none yet" };
	const missing = { name: "remote.json", status: "fail", detail: "/x/remote.json not found. Run tabkyra remote setup." };
	assert.deepEqual(stateFromStatus({ configured: false, checks: [missing], preflight: { state: "tailscale_missing", message: "m" } }), { state: "tailscale_missing", message: "m" });
	assert.equal(stateFromStatus({ configured: false, checks: [missing] }).state, "ready");
	const broken = { name: "remote.json", status: "fail", detail: "/x/remote.json isn't valid JSON." };
	assert.equal(stateFromStatus({ configured: false, checks: [broken], preflight: { state: "ready", message: "" } }).state, "problem", "a damaged file isn't ready");
	assert.equal(stateFromStatus({ configured: true, checks: [ok, { name: "public DNS", status: "fail", detail: "tailnet address" }], extensionConnected: true }).state, "problem");
	assert.equal(stateFromStatus({ configured: true, checks: [ok, warn], extensionConnected: false }).state, "no_browser_connected");
	assert.equal(stateFromStatus({ configured: true, checks: [ok, warn], extensionConnected: true }).state, "on");
	assert.equal(stateFromStatus({ configured: true, checks: [ok, warn] }).state, "on", "nobody asked about the browser");
	const gone = { state: "tailscale_signed_out", message: "t" };
	assert.deepEqual(stateFromStatus({ configured: true, checks: [ok, { name: "local serve", status: "fail", detail: "x" }], tailscale: gone }), gone, "Tailscale going away comes ahead of a problem");
	assert.equal(stateFromStatus({ configured: true, checks: [ok], extensionConnected: true, tailscale: gone }).state, "tailscale_signed_out", "and ahead of on");
	// Public DNS lagging a fresh Funnel is "dns", and only when nothing else is wrong.
	const dns = { name: "public DNS", status: "fail", detail: "no A record" };
	const fetchFail = { name: "public fetch", status: "fail", detail: "didn't answer" };
	assert.equal(stateFromStatus({ configured: true, checks: [ok, dns, fetchFail], extensionConnected: true }).code, "dns");
	assert.equal(stateFromStatus({ configured: true, checks: [ok, dns], extensionConnected: true }).code, "dns");
	assert.equal(stateFromStatus({ configured: true, checks: [{ name: "local serve", status: "fail", detail: "x" }, dns], extensionConnected: true }).code, undefined, "a dead serve is not a DNS wait");
	assert.equal(stateFromStatus({ configured: true, checks: [fetchFail], extensionConnected: true }).code, undefined);
	const closed = { state: "funnel_closed", message: "c" };
	assert.deepEqual(stateFromStatus({ configured: true, checks: [ok], extensionConnected: true, tailscale: closed }), closed);
	for (const state of ["cloudflared_missing", "funnel_closed", "tailscale_missing", "tailscale_signed_out", "funnel_not_allowed", "tailnet_lock", "port_busy", "ready", "on", "no_browser_connected"]) assert.ok(REMOTE_STATES.includes(state), state);
});

// ---------- remote status --json, nothing set up ----------

test("remote status --json: no Tailscale on PATH is tailscale_missing, and the connector URL is null", () => {
	const s = scenario("st-missing", { tailscale: false });
	const r = s.run(["remote", "status", "--json"]);
	const report = r.json();
	assert.equal(report.state, "tailscale_missing");
	assert.equal(report.connectorUrl, null);
	assert.equal(report.passcodeSet, false);
	assert.equal(r.stderr, "");
});

test("remote status --json: Tailscale that isn't signed in is tailscale_signed_out", () => {
	const s = scenario("st-signed-out", { status: "{}" });
	assert.equal(s.run(["remote", "status", "--json"]).json().state, "tailscale_signed_out");
});

test("remote status --json: Tailnet Lock is tailnet_lock", () => {
	const s = scenario("st-lock", { lock: "Tailnet lock is ENABLED." });
	assert.equal(s.run(["remote", "status", "--json"]).json().state, "tailnet_lock");
});

test("remote status --json: a TCP forward on 8443 is port_busy", () => {
	const s = scenario("st-busy", { serveStatus: JSON.stringify({ TCP: { 8443: { TCPForward: "127.0.0.1:22" } } }) });
	const report = s.run(["remote", "status", "--json"]).json();
	assert.equal(report.state, "port_busy");
	assert.equal(report.code, "tailscale_port", "a Tailscale setting, not a program here");
});

test("remote status --json: a clear machine is ready, and status changes nothing", () => {
	const s = scenario("st-ready");
	const report = s.run(["remote", "status", "--json"]).json();
	assert.equal(report.state, "ready");
	assert.equal(report.ok, false, "the old ok field still says there's no remote.json");
	assert.ok(report.checks.some((x) => x.name === "remote.json"), "the old checks are still there");
	noFunnelChange(s);
	assert.ok(!s.remoteJsonExists());
	assert.deepEqual(s.calls().filter((x) => /^(systemctl|launchctl)/.test(x)), []);
});

test("a tailscale that is neither on PATH nor in the Mac app's fixed place is never found or run", () => {
	const s = scenario("st-elsewhere", { tailscaleDir: "elsewhere" });
	assert.equal(s.run(["remote", "status", "--json"]).json().state, "tailscale_missing", "off PATH");
	assert.equal(s.run(["remote", "status", "--json"], { TABKYRA_TAILSCALE_APP: join(s.dir, "elsewhere", "tailscale") }).json().state, "tailscale_missing", "and naming it does nothing");
	assert.deepEqual(s.calls(), [], "it was never run");
});

// ---------- remote setup --json ----------

test("remote setup --json: success prints one JSON object with the connector URL and the passcode once", async () => {
	const s = scenario("su-ok");
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const first = await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)]);
		assert.equal(first.code, 0, first.stdout + first.stderr);
		assert.equal(first.stderr, "");
		const report = first.json();
		assert.equal(report.ok, true);
		assert.equal(report.state, "on");
		assert.equal(report.connectorUrl, `${FUNNEL_URL}/mcp`);
		assert.match(report.passcode, PASSCODE);
		assert.equal(report.passcodeSet, true);
		assert.ok(s.calls().includes(`tailscale funnel --bg --yes --https=8443 http://127.0.0.1:${local.port}`), s.calls().join("\n"));
		const again = (await s.runAsync(["remote", "setup", "--json", "--no-service"])).json();
		assert.equal(again.state, "on");
		assert.equal("passcode" in again, false, "a passcode that already exists is never printed again");
		assert.equal(again.passcodeSet, true);
	} finally {
		await local.close();
	}
});

test("remote setup --json: Funnel not allowed gives the admin URL Tailscale printed, and the passcode this run made", async () => {
	const url = "https://login.tailscale.com/f/funnel?node=n123abc";
	const s = scenario("su-funnel", { funnelFails: `Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n  ${url}\n` });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const first = await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)]);
		assert.equal(first.code, 1);
		assert.equal(first.stderr, "");
		const report = first.json();
		assert.equal(report.ok, false);
		assert.equal(report.state, "funnel_not_allowed");
		assert.equal(report.adminUrl, url);
		assert.match(report.passcode, PASSCODE, "the run that made the passcode hands it over even though it failed");
		const retry = (await s.runAsync(["remote", "setup", "--json", "--no-service"])).json();
		assert.equal(retry.state, "funnel_not_allowed");
		assert.equal("passcode" in retry, false, "the retry doesn't have it; the app kept the first one");
		assert.equal(retry.passcodeSet, true);
	} finally {
		await local.close();
	}
});

test("remote setup --json: a Funnel failure with no page to open is a problem with Tailscale's words", async () => {
	const s = scenario("su-funnel-other", { funnelFails: "listener already exists" });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const report = (await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)])).json();
		assert.equal(report.state, "problem");
		assert.match(report.message, /listener already exists/);
		assert.equal(report.code, "funnel");
		assert.equal("adminUrl" in report, false);
	} finally {
		await local.close();
	}
});

test("remote setup --json: every refusal is a state, changes nothing and prints only JSON", async () => {
	const cases = [
		["su-missing", { tailscale: false }, "tailscale_missing"],
		["su-signed-out", { status: "{}" }, "tailscale_signed_out"],
		["su-lock", { lock: "Tailnet lock is ENABLED." }, "tailnet_lock"],
		["su-busy", { serveStatus: JSON.stringify({ TCP: { 8443: { TCPForward: "127.0.0.1:22" } } }) }, "port_busy"],
	];
	for (const [name, options, state] of cases) {
		const s = scenario(name, options);
		const r = s.run(["remote", "setup", "--json"]);
		assert.equal(r.code, 1, name);
		assert.equal(r.stderr, "", name);
		const report = r.json();
		assert.equal(report.state, state, name);
		assert.equal(report.ok, false, name);
		assert.equal("passcode" in report, false, `${name}: nothing was made`);
		assert.ok(!s.remoteJsonExists(), `${name}: remote.json not written`);
		noFunnelChange(s);
	}
	// Something else already on the local port is port_busy too.
	const s = scenario("su-local-busy");
	const other = await localServer("https://elsewhere.example/mcp");
	try {
		const report = (await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(other.port)])).json();
		assert.equal(report.state, "port_busy");
		assert.equal(report.code, "local_port", "a program here, not a Tailscale setting");
		assert.ok(!s.remoteJsonExists());
		noFunnelChange(s);
	} finally {
		await other.close();
	}
});

test("remote setup --json with a service and no working launcher is a problem, not a hang", () => {
	const s = scenario("su-launcher");
	const r = s.run(["remote", "setup", "--json"]);
	assert.equal(r.code, 1);
	assert.equal(r.json().state, "problem");
	assert.match(r.json().message, /tabkyra install/);
	assert.equal(r.json().code, "launcher", "the app reads the code, not the sentence");
});

// ---------- status once it's set up ----------

test("remote status --json: a set-up install is a problem until it's reachable, then no_browser_connected; the passcode is never in it", async () => {
	const s = scenario("st-on");
	const port = await freePort();
	const publicUrl = `http://localhost:${port}`;
	// Nothing listens yet, so setup is not "on": it says so, keeps remote.json and still hands over the passcode it made.
	const setup = s.run(["remote", "setup", "--public-url", publicUrl, "--port", String(port), "--no-service", "--json"]);
	assert.equal(setup.code, 1, setup.stdout);
	assert.equal(setup.json().state, "problem");
	assert.equal(setup.json().code, "serve");
	assert.ok(s.remoteJsonExists(), "remote.json is kept");
	const made = setup.json().passcode;
	assert.match(made, PASSCODE);
	let answer = "100.64.1.2";
	const doh = createHttpServer((req, res) => {
		res.setHeader("content-type", "application/dns-json");
		res.end(JSON.stringify({ Status: 0, Answer: [{ name: "localhost", type: 1, TTL: 60, data: answer }] }));
	});
	await new Promise((resolve) => doh.listen(0, "127.0.0.1", resolve));
	const extra = { TABKYRA_DOH_URL: `http://127.0.0.1:${doh.address().port}/dns-query` };
	try {
		const down = await s.runAsync(["remote", "status", "--json"], extra);
		assert.equal(down.json().state, "problem", "serve isn't running");
		assert.match(down.json().message, /local serve/);
		const serve = spawn(process.execPath, [cli, "serve", "--port", String(port)], { env: s.env });
		await new Promise((resolve, reject) => {
			let out = "";
			serve.stdout.on("data", (d) => {
				out += d;
				if (/OAuth on/.test(out)) resolve();
			});
			serve.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
			setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 15_000);
		});
		try {
			assert.equal((await s.runAsync(["remote", "status", "--json"], extra)).json().state, "problem", "a name that only resolves inside the tailnet isn't on");
			answer = "203.0.113.9";
			const up = await s.runAsync(["remote", "status", "--json"], extra);
			const report = up.json();
			assert.equal(report.ok, true);
			assert.equal(report.state, "no_browser_connected", "no extension is attached in this temp socket dir");
			assert.equal(report.extensionConnected, false);
			assert.equal(report.connectorUrl, `${publicUrl}/mcp`);
			assert.equal(report.passcodeSet, true);
			assert.ok(!up.stdout.includes(made), "status never prints the passcode");
		} finally {
			serve.kill();
		}
	} finally {
		doh.close();
	}
});

// ---------- opening Funnel: what Tailscale's own CLI does (see helpers/tailscale-stub.mjs for the source lines) ----------

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const stubPid = (s) => Number(readFileSync(s.stub.pidFile, "utf8").trim());
async function settled(check, ms = 3000) {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (check()) return true;
	return check();
}

test("remote setup --json: Funnel not enabled and Tailscale waiting for it returns the page at once and stops the waiting process", async () => {
	const s = scenario("fn-wait", { funnel: "wait" });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const started = Date.now();
		const r = await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)]);
		assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms; the stub waits 300 s`);
		const report = r.json();
		assert.equal(r.code, 1);
		assert.equal(report.state, "funnel_not_allowed");
		assert.equal(report.adminUrl, ENABLE_URL);
		assert.ok(await settled(() => !alive(stubPid(s))), "the waiting tailscale process was stopped");
		assert.ok(s.remoteJsonExists(), "remote.json is kept for the retry");
	} finally {
		await local.close();
	}
});

test("remote setup --json: Funnel not enabled and Tailscale exiting 0 with the page is still funnel_not_allowed, never on", async () => {
	const s = scenario("fn-exit0url", { funnel: "exit0url" });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)]);
		assert.equal(r.code, 1);
		assert.equal(r.json().state, "funnel_not_allowed");
		assert.equal(r.json().adminUrl, ENABLE_URL);
	} finally {
		await local.close();
	}
});

test("remote setup: a docs link in Tailscale's failure is a problem with Tailscale's own words, not funnel_not_allowed (JSON and text)", async () => {
	const text = "Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https.";
	const s = scenario("fn-docs", { funnelFails: text });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const report = (await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)])).json();
		assert.equal(report.state, "problem");
		assert.equal(report.code, "funnel");
		assert.match(report.message, /HTTPS must be enabled\. See https:\/\/tailscale\.com\/s\/https/);
		assert.equal("adminUrl" in report, false);
	} finally {
		await local.close();
	}
	const plain = scenario("fn-docs-text", { funnelFails: text });
	const local2 = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await plain.runAsync(["remote", "setup", "--no-service", "--port", String(local2.port)]);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /tailscale funnel failed: Funnel not available; HTTPS must be enabled/);
		assert.doesNotMatch(r.stderr, /isn't enabled for this tailnet or node yet/);
	} finally {
		await local2.close();
	}
});

test("remote setup --json: a funnel call that never ends and never prints a page is bounded, stopped and reported", async () => {
	const s = scenario("fn-hang", { funnel: "hang" });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const started = Date.now();
		const r = await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)], { TABKYRA_FUNNEL_WAIT_MS: "1500" });
		assert.ok(Date.now() - started < 15_000);
		const report = r.json();
		assert.equal(report.state, "problem");
		assert.equal(report.code, "funnel");
		assert.match(report.message, /tailscale funnel didn't finish in 2 seconds/);
		assert.ok(await settled(() => !alive(stubPid(s))), "the stuck tailscale process was stopped");
	} finally {
		await local.close();
	}
});

test("remote setup --json: Tailscale exiting 0 without Funnel really on is a problem, not on", async () => {
	const s = scenario("fn-silent0", { funnel: "silent0" });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const report = (await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)])).json();
		assert.equal(report.state, "problem");
		assert.equal(report.code, "funnel");
		assert.match(report.message, /Funnel isn't on for mac\.example\.ts\.net:8443/);
		assert.equal(report.ok, false);
	} finally {
		await local.close();
	}
});

test("remote setup --json: with nothing listening it is a problem (code serve), Funnel is never opened and the passcode still comes back", async () => {
	const s = scenario("fn-nolisten");
	const port = await freePort();
	const r = s.run(["remote", "setup", "--json", "--no-service", "--port", String(port)]);
	assert.equal(r.code, 1);
	const report = r.json();
	assert.equal(report.ok, false);
	assert.equal(report.state, "problem");
	assert.equal(report.code, "serve");
	assert.match(report.passcode, PASSCODE);
	assert.ok(s.remoteJsonExists(), "remote.json is kept");
	noFunnelChange(s);
	// The same on your own front door: nothing to reach is not on.
	const custom = scenario("fn-nolisten-custom");
	const c = custom.run(["remote", "setup", "--json", "--no-service", "--public-url", "https://tabkyra.example.com", "--port", String(port)]);
	assert.equal(c.code, 1);
	assert.equal(c.json().state, "problem");
	assert.equal(c.json().code, "serve");
});

// ---------- status once remote.json exists: Tailscale going away comes first ----------

test("remote status --json: with remote.json on the Funnel route, Tailscale missing, signed out or under Tailnet Lock is named ahead of problem", () => {
	const cases = [
		["so-missing", { tailscale: false }, "tailscale_missing"],
		["so-signed-out", { status: "{}" }, "tailscale_signed_out"],
		["so-lock", { lock: "Tailnet lock is ENABLED." }, "tailnet_lock"],
	];
	for (const [name, options, state] of cases) {
		const s = scenario(name, options);
		mkdirSync(s.env.TABKYRA_CONFIG_DIR, { recursive: true });
		writeFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), JSON.stringify({ publicUrl: FUNNEL_URL, port: 9, route: "funnel" }));
		const report = s.run(["remote", "status", "--json"]).json();
		assert.equal(report.state, state, name);
		assert.equal(report.ok, false, name);
		assert.equal(report.connectorUrl, `${FUNNEL_URL}/mcp`, `${name}: it is still set up`);
		assert.ok(
			report.checks.some((x) => x.name === "tailscale" && x.status === "fail"),
			name,
		);
		assert.ok(!report.checks.some((x) => x.name === "public fetch"), `${name}: no internet checks while Tailscale is the problem`);
		noFunnelChange(s);
	}
});

// ---------- status: Funnel closed, without any report left over from setup ----------

test("remote status --json: a Funnel remote.json with Funnel closed is funnel_closed, so a refusal survives a relaunch", () => {
	const s = scenario("so-closed");
	mkdirSync(s.env.TABKYRA_CONFIG_DIR, { recursive: true });
	writeFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), JSON.stringify({ publicUrl: FUNNEL_URL, port: 9, route: "funnel" }));
	const r = s.run(["remote", "status", "--json"]);
	const report = r.json();
	assert.equal(report.state, "funnel_closed");
	assert.equal(report.ok, false);
	assert.equal(report.connectorUrl, `${FUNNEL_URL}/mcp`, "it is still set up");
	assert.match(report.message, /Funnel isn't open for mac\.example\.ts\.net:8443/);
	assert.ok(report.checks.some((x) => x.name === "tailscale" && x.status === "fail"));
	assert.ok(!report.checks.some((x) => x.name === "public fetch"), "no internet checks while Funnel is closed");
	assert.equal(report.extensionConnected, null, "and the bridge isn't asked either");
	noFunnelChange(s);
	// Text mode says it too.
	assert.match(s.run(["remote", "status"]).stdout, /Funnel isn't open for mac\.example\.ts\.net:8443/);
	// With Funnel open for that address it is no longer funnel_closed (nothing listens on port 9, so it is a problem instead).
	const open = scenario("so-open");
	mkdirSync(open.env.TABKYRA_CONFIG_DIR, { recursive: true });
	writeFileSync(join(open.env.TABKYRA_CONFIG_DIR, "remote.json"), JSON.stringify({ publicUrl: FUNNEL_URL, port: 9, route: "funnel" }));
	writeFileSync(open.stub.stateFile, "on\n");
	assert.equal(open.run(["remote", "status", "--json"]).json().state, "problem");
});

// ---------- a failure after the passcode was made is still a report ----------

test("remote setup --json: a write that throws after the passcode was made is a problem report that carries the passcode", { skip: process.platform !== "darwin" && "needs chflags" }, async () => {
	const s = scenario("su-unwritable");
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	const file = join(s.env.TABKYRA_CONFIG_DIR, "remote.json");
	mkdirSync(s.env.TABKYRA_CONFIG_DIR, { recursive: true });
	writeFileSync(file, JSON.stringify({ publicUrl: FUNNEL_URL, port: local.port, route: "funnel" }));
	// Immutable: remote.json reads fine (so planning passes and the passcode is made), and replacing it fails.
	assert.equal(spawnSync("chflags", ["uchg", file]).status, 0);
	try {
		const r = await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)]);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		const report = r.json();
		assert.equal(report.ok, false);
		assert.equal(report.state, "problem");
		assert.equal(report.code, "config");
		assert.match(report.passcode, PASSCODE, "the passcode that was made is in the report");
		assert.equal(report.passcodeSet, true);
		noFunnelChange(s);
	} finally {
		spawnSync("chflags", ["nouchg", file]);
		await local.close();
	}
});

const serviceTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
/** The directory the user service file goes in, made impossible to write by putting a file where the folder should be. */
const blockServiceDir = (s) => {
	const blocker = process.platform === "darwin" ? join(s.home, "Library") : join(s.home, ".config", "systemd");
	mkdirSync(dirname(blocker), { recursive: true });
	writeFileSync(blocker, "not a folder");
};

serviceTest("remote setup --json: a service file that can't be written is a problem report (code service) with the passcode, not silence", async () => {
	const s = scenario("su-svc-unwritable");
	s.launcher();
	blockServiceDir(s);
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await s.runAsync(["remote", "setup", "--json", "--port", String(local.port)]);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.equal(r.stderr, "");
		const report = r.json();
		assert.equal(report.state, "problem");
		assert.equal(report.code, "service");
		assert.match(report.passcode, PASSCODE);
		noFunnelChange(s);
	} finally {
		await local.close();
	}
});

// ---------- the path the app always takes: a service, with a launcher ----------

serviceTest("remote setup --json with a service: success is one JSON object and the passcode", async () => {
	const s = scenario("su-svc-ok");
	s.launcher();
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await s.runAsync(["remote", "setup", "--json", "--port", String(local.port)]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.equal(r.stderr, "");
		const report = r.json(); // JSON.parse throws on anything but a single object on stdout
		assert.equal(report.state, "on");
		assert.equal(report.connectorUrl, `${FUNNEL_URL}/mcp`);
		assert.match(report.passcode, PASSCODE);
		assert.ok(s.calls().some((x) => /^(launchctl|systemctl)/.test(x)), "the stub service manager was used");
		assert.ok(s.calls().includes(`tailscale funnel --bg --yes --https=8443 http://127.0.0.1:${local.port}`));
	} finally {
		await local.close();
	}
});

serviceTest("remote setup --json with a service: a service manager that fails is code service, with the passcode, and Funnel is not opened", async () => {
	const s = scenario("su-svc-fail");
	s.launcher();
	s.script("launchctl", `echo "launchctl $*" >> ${join(s.dir, "calls.log")}\ncase "$1" in\nbootstrap) echo 'boom' >&2; exit 1 ;;\nprint) exit 1 ;;\nesac\n`);
	s.script("systemctl", `echo "systemctl $*" >> ${join(s.dir, "calls.log")}\ncase "$2" in\nrestart) echo 'boom' >&2; exit 1 ;;\nesac\n`);
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await s.runAsync(["remote", "setup", "--json", "--port", String(local.port)]);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		const report = r.json();
		assert.equal(report.state, "problem");
		assert.equal(report.code, "service");
		assert.match(report.passcode, PASSCODE);
		assert.ok(s.remoteJsonExists(), "remote.json is kept");
		noFunnelChange(s);
	} finally {
		await local.close();
	}
});

serviceTest("remote setup --json with a service: serve that never answers is code serve, with the passcode, and Funnel is not opened", async () => {
	const s = scenario("su-svc-silent");
	s.launcher();
	const port = await freePort();
	const r = await s.runAsync(["remote", "setup", "--json", "--port", String(port)], { TABKYRA_SERVE_WAIT_MS: "1500" });
	assert.equal(r.code, 1, r.stdout + r.stderr);
	const report = r.json();
	assert.equal(report.state, "problem");
	assert.equal(report.code, "serve");
	assert.match(report.passcode, PASSCODE);
	noFunnelChange(s);
});

// ---------- cancelling setup stops the funnel call it started ----------

test("remote setup: a SIGTERM while `tailscale funnel` runs stops that process too, so it can't open Funnel later", async () => {
	const s = scenario("su-sigterm", { funnel: "hang" });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const child = spawn(process.execPath, [cli, "remote", "setup", "--json", "--no-service", "--port", String(local.port)], { env: s.env });
		const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
		const started = Date.now();
		while (!existsSync(s.stub.pidFile)) {
			assert.ok(Date.now() - started < 15_000, "the funnel call started");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const funnelPid = Number(readFileSync(s.stub.pidFile, "utf8").trim());
		child.kill("SIGTERM");
		const end = await closed;
		assert.ok(end.code === 143 || end.signal === "SIGTERM", JSON.stringify(end));
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.throws(() => process.kill(funnelPid, 0), "the tailscale funnel process is gone");
	} finally {
		await local.close();
	}
});

// ---------- the Tailscale Mac app at its fixed path: a terminal and Polycarp's window behave the same ----------

test("the CLI finds the Tailscale app at its fixed path with nothing named: status, setup and remote off all use it", async () => {
	const s = scenario("app-fixed", { app: true });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		assert.equal(s.run(["remote", "status", "--json"]).json().state, "ready", "found with no PATH entry");
		const on = await s.runAsync(["remote", "setup", "--json", "--no-service", "--port", String(local.port)]);
		assert.equal(on.code, 0, on.stdout + on.stderr);
		assert.equal(on.json().state, "on");
		assert.ok(s.calls().includes(`tailscale funnel --bg --yes --https=8443 http://127.0.0.1:${local.port}`));
		const off = await s.runAsync(["remote", "off"]);
		assert.equal(off.code, 0, off.stdout + off.stderr);
		assert.ok(s.calls().includes("tailscale funnel --https=8443 off"), s.calls().join("\n"));
		assert.match(off.stdout, /Tailscale Funnel on port 8443 is off/);
		assert.ok(!s.remoteJsonExists(), "remote.json removed once Funnel is off");
	} finally {
		await local.close();
	}
});

test("remote off with no Tailscale to be found fails, says where it looked, and keeps remote.json", () => {
	const s = scenario("off-nobin", { tailscale: false });
	mkdirSync(s.env.TABKYRA_CONFIG_DIR, { recursive: true });
	writeFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), JSON.stringify({ publicUrl: FUNNEL_URL, port: 9, route: "funnel" }));
	const r = s.run(["remote", "off"]);
	assert.equal(r.code, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /Couldn't turn Funnel off: Tailscale wasn't found \(not on PATH, and not at .*Tailscale\.app\/Contents\/MacOS\/Tailscale\)/);
	assert.ok(s.remoteJsonExists(), "remote.json is kept: Funnel may still be on");
	assert.deepEqual(
		s.calls().filter((x) => /^(systemctl|launchctl)/.test(x)),
		[],
		"the service is left alone too",
	);
});

test("token passcode --json prints only the new passcode", () => {
	const s = scenario("pc");
	const r = s.run(["token", "passcode", "--json"]);
	assert.equal(r.code, 0);
	assert.match(r.json().passcode, PASSCODE);
	assert.equal(r.json().ok, true);
});

// ---------- the Cloudflare route: the person's own account, a named tunnel, no accounts made for them ----------

const CF_HOST = "polycarp.example.com";
const CF_ID = "c0ffee00-1234-4abc-8def-0123456789ab";

/** A stub cloudflared. `route`: what `tunnel route dns` does: "ok", "taken", or a name it adds instead (a sign-in for another domain). */
function cloudflared(s, { route = "ok", listed = false } = {}) {
	const log = join(s.dir, "calls.log");
	const home = s.home;
	const routeBody =
		route === "taken"
			? `echo "An A, AAAA, or CNAME record with that host already exists" >&2; exit 1`
			: route === "already"
				? `echo "$5.other.example is already configured to route to your tunnel"`
				: `echo "Added CNAME ${route === "ok" ? "$5" : route} which will route to this tunnel"`;
	s.script(
		"cloudflared",
		`echo "cloudflared $*" >> ${log}
case "$2" in
login) /bin/mkdir -p ${home}/.cloudflared; : > ${home}/.cloudflared/cert.pem ;;
list) if [ -e ${home}/.cloudflared/listed ]; then echo '[{"id":"${CF_ID}"}]'; else echo '[]'; fi ;;
create) : > ${home}/.cloudflared/${CF_ID}.json; : > ${home}/.cloudflared/listed; echo "Created tunnel $3 with id ${CF_ID}" ;;
route) ${routeBody} ;;
esac
`,
	);
	mkdirSync(join(home, ".cloudflared"), { recursive: true });
	if (listed) writeFileSync(join(home, ".cloudflared", "listed"), "");
}

const signedIn = (s) => writeFileSync(join(s.home, ".cloudflared", "cert.pem"), "");
const cfCalls = (s) => s.calls().filter((x) => x.startsWith("cloudflared "));
const cfService = (s) => (process.platform === "darwin" ? join(s.home, "Library", "LaunchAgents", "com.polycarp.cloudflared.plist") : join(s.home, ".config", "systemd", "user", "polycarp-cloudflared.service"));

async function cloudflareSetup(s, extra = []) {
	s.launcher();
	const local = await localServer(`https://${CF_HOST}/mcp`);
	try {
		const r = await s.runAsync(["remote", "setup", "--json", "--cloudflare", CF_HOST, "--port", String(local.port), ...extra]);
		return { ...r, port: local.port };
	} finally {
		await local.close();
	}
}

test("remote status --json says which routes are ready, for an app that offers the choice", () => {
	const s = scenario("routes", { tailscale: false });
	const none = s.run(["remote", "status", "--json"]).json();
	assert.deepEqual(none.routes, { tailscale: { installed: false, signedIn: false }, cloudflare: { installed: false, signedIn: false } });
	cloudflared(s);
	assert.deepEqual(s.run(["remote", "status", "--json"]).json().routes.cloudflare, { installed: true, signedIn: false });
	signedIn(s);
	assert.deepEqual(s.run(["remote", "status", "--json"]).json().routes.cloudflare, { installed: true, signedIn: true });
	assert.deepEqual(cfCalls(s), [], "reading status runs nothing of Cloudflare's");
});

test("remote setup --cloudflare without cloudflared is its own state and changes nothing", async () => {
	const s = scenario("cf-missing", { tailscale: false });
	const r = await cloudflareSetup(s);
	assert.equal(r.code, 1);
	assert.equal(r.json().state, "cloudflared_missing");
	assert.equal(s.remoteJsonExists(), false);
});

test("remote setup --cloudflare before signing in says to sign in and changes nothing", async () => {
	const s = scenario("cf-signed-out", { tailscale: false });
	cloudflared(s);
	const report = (await cloudflareSetup(s)).json();
	assert.equal(report.code, "cloudflare_login");
	assert.equal(s.remoteJsonExists(), false);
	assert.deepEqual(cfCalls(s), []);
});

test("remote cloudflare login runs cloudflared's own sign-in, once", () => {
	const s = scenario("cf-login", { tailscale: false });
	cloudflared(s);
	assert.equal(s.run(["remote", "cloudflare", "login", "--json"]).json().state, "ready");
	assert.deepEqual(cfCalls(s), ["cloudflared tunnel login"]);
	assert.equal(s.run(["remote", "cloudflare", "login", "--json"]).json().state, "ready");
	assert.equal(cfCalls(s).length, 1, "already signed in: not asked again");
});

test("remote setup --cloudflare makes the tunnel and its record, runs both services, and reuses the tunnel next time", async () => {
	const s = scenario("cf-on", { tailscale: false });
	cloudflared(s);
	signedIn(s);
	const first = await cloudflareSetup(s);
	const report = first.json();
	assert.equal(report.state, "on", first.stdout);
	assert.equal(report.connectorUrl, `https://${CF_HOST}/mcp`);
	assert.match(report.passcode, PASSCODE);
	const calls = cfCalls(s);
	assert.ok(calls.some((x) => /^cloudflared tunnel create polycarp-.*-[0-9a-f]{4}$/.test(x)), calls.join("\n"));
	assert.match(readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "cloudflare-tunnel-name"), "utf8"), /^polycarp-/);
	assert.ok(calls.includes(`cloudflared tunnel route dns ${CF_ID} ${CF_HOST}`), calls.join("\n"));
	assert.ok(!calls.some((x) => x.includes("--overwrite-dns")), "a name in use is never taken over");
	const config = readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "cloudflared.yml"), "utf8");
	assert.match(config, new RegExp(`hostname: ${CF_HOST}\\n    service: http://127\\.0\\.0\\.1:${first.port}\\n`));
	assert.match(config, /- service: http_status:404/);
	assert.equal(JSON.parse(readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8")).route, "cloudflare");
	assert.ok(existsSync(cfService(s)));

	await cloudflareSetup(s);
	assert.equal(cfCalls(s).filter((x) => x.includes("tunnel create")).length, 1, "the tunnel is made once");

	const off = s.run(["remote", "off"]);
	assert.equal(off.code, 0, off.stderr);
	assert.match(off.stdout, /stay in your Cloudflare account/);
	assert.equal(existsSync(cfService(s)), false);
	assert.equal(existsSync(join(s.env.TABKYRA_CONFIG_DIR, "cloudflared.yml")), false);
	assert.ok(!cfCalls(s).some((x) => x.includes("delete")), "nothing on the account is deleted");
});

test("a name already in use is refused in Cloudflare's words, and no tunnel starts", async () => {
	const s = scenario("cf-taken", { tailscale: false });
	cloudflared(s, { route: "taken" });
	signedIn(s);
	const report = (await cloudflareSetup(s)).json();
	assert.equal(report.code, "cloudflare_dns");
	assert.match(report.message, /already exists/);
	assert.equal(existsSync(cfService(s)), false);
	assert.equal(s.remoteJsonExists(), false, "a refused name saves nothing, so the window can ask for another");
	assert.equal(s.run(["remote", "status", "--json"]).json().connectorUrl, null);
});

test("a sign-in for another domain is caught, not left as a wrong record that looks fine", async () => {
	const s = scenario("cf-zone", { tailscale: false });
	cloudflared(s, { route: `${CF_HOST}.other.example.` });
	signedIn(s);
	const report = (await cloudflareSetup(s)).json();
	assert.equal(report.code, "cloudflare_zone");
	assert.match(report.message, /different domain/);
	assert.equal(existsSync(cfService(s)), false);
	assert.equal(s.remoteJsonExists(), false);
});

test("a tunnel of that name whose key isn't here says how to clear it", async () => {
	const s = scenario("cf-key", { tailscale: false });
	cloudflared(s, { listed: true });
	signedIn(s);
	const report = (await cloudflareSetup(s)).json();
	assert.equal(report.code, "cloudflare_tunnel");
	assert.match(report.message, /cloudflared tunnel delete/);
});

test("a name that can't be a hostname is refused before anything runs", () => {
	const s = scenario("cf-bad", { tailscale: false });
	cloudflared(s);
	signedIn(s);
	for (const bad of ["nodots", "has space.example.com", "bad-.example.com"]) {
		const report = s.run(["remote", "setup", "--json", "--cloudflare", bad]).json();
		assert.equal(report.code, "cloudflare_dns", bad);
	}
	assert.deepEqual(cfCalls(s), []);
});

test("cloudflared removed after setup is its own state, ahead of the other checks", async () => {
	const s = scenario("cf-gone", { tailscale: false });
	cloudflared(s);
	signedIn(s);
	await cloudflareSetup(s);
	rmSync(join(s.dir, "bin", "cloudflared"));
	assert.equal(s.run(["remote", "status", "--json"]).json().state, "cloudflared_missing");
});

test("a retry after a wrong-domain try, when cloudflared says the record is already there, is still caught", async () => {
	const s = scenario("cf-zone-retry", { tailscale: false });
	cloudflared(s, { route: "already" });
	signedIn(s);
	const report = (await cloudflareSetup(s)).json();
	assert.equal(report.code, "cloudflare_zone", JSON.stringify(report));
});

test("remote off stops a Cloudflare tunnel even with remote.json gone", async () => {
	const s = scenario("cf-off-damaged", { tailscale: false });
	cloudflared(s);
	signedIn(s);
	await cloudflareSetup(s);
	rmSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"));
	assert.equal(s.run(["remote", "off"]).code, 0);
	assert.equal(existsSync(cfService(s)), false);
});

test("remote setup again on the Cloudflare route keeps its name", async () => {
	const s = scenario("cf-again", { tailscale: false });
	cloudflared(s);
	signedIn(s);
	await cloudflareSetup(s);
	s.launcher();
	const local = await localServer(`https://${CF_HOST}/mcp`);
	try {
		const raw = JSON.parse(readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8"));
		const again = await s.runAsync(["remote", "setup", "--json", "--port", String(local.port)]);
		assert.equal(again.json().connectorUrl, `${raw.publicUrl}/mcp`, again.stdout);
	} finally {
		await local.close();
	}
});


// ---------- replacing Funnel with Cloudflare ----------

/** A scenario whose Tailscale shows Polycarp's Funnel on `port`, with a signed-in cloudflared stub. The caller runs the Funnel setup. */
async function funnelRouteScenario(name, cf) {
	// The stub's serve status must name the serve's port, so the port is chosen first.
	const port = await freePort();
	const serveStatus = JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });
	const s = scenario(name, { serveStatus });
	s.launcher();
	cloudflared(s, cf);
	signedIn(s);
	return { s, port };
}

/** A stand-in serve on `port`: it says the Funnel address until remote.json names the Cloudflare route, then the Cloudflare one. */
async function withServe(s, port, fn) {
	const srv = createHttpServer((req, res) => {
		if (req.url !== METADATA_PATH) {
			res.statusCode = 404;
			res.end("not here");
			return;
		}
		let route = "";
		try {
			route = JSON.parse(readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8")).route;
		} catch {
			/* no file yet */
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ resource: route === "cloudflare" ? `https://${CF_HOST}/mcp` : `${FUNNEL_URL}/mcp` }));
	});
	await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
	try {
		return await fn();
	} finally {
		await new Promise((resolve) => srv.close(resolve));
	}
}

const funnelOffCalls = (s) => s.calls().filter((x) => /^tailscale funnel --https=8443 off/.test(x));
const remoteRoute = (s) => JSON.parse(readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8")).route;

test("remote setup --cloudflare --replace-funnel moves a running Funnel route to Cloudflare, closing Funnel only after the tunnel is made", async () => {
	const { s, port } = await funnelRouteScenario("rf-ok");
	await withServe(s, port, async () => {
		const first = await s.runAsync(["remote", "setup", "--json", "--port", String(port)]);
		assert.equal(first.json().state, "on", first.stdout);
		assert.equal(remoteRoute(s), "funnel");
		assert.deepEqual(funnelOffCalls(s), []);
		const r = await s.runAsync(["remote", "setup", "--json", "--no-passcode", "--cloudflare", CF_HOST, "--replace-funnel", "--port", String(port)]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.equal(r.json().state, "on");
		assert.equal(r.json().connectorUrl, `https://${CF_HOST}/mcp`);
		assert.equal(remoteRoute(s), "cloudflare");
		assert.equal(funnelOffCalls(s).length, 1, s.calls().join("\n"));
		assert.ok(existsSync(cfService(s)));
		// The order that keeps a working route: the DNS record exists before Funnel closes.
		const calls = s.calls();
		const dns = calls.findIndex((x) => x.startsWith("cloudflared tunnel route dns"));
		const off = calls.findIndex((x) => /^tailscale funnel --https=8443 off/.test(x));
		assert.ok(dns >= 0 && off > dns, calls.join("\n"));
	});
});

test("a Cloudflare name that is taken leaves the Funnel route on: remote.json unchanged, Funnel never closed", async () => {
	const { s, port } = await funnelRouteScenario("rf-taken", { route: "taken" });
	await withServe(s, port, async () => {
		const first = await s.runAsync(["remote", "setup", "--json", "--port", String(port)]);
		assert.equal(first.json().state, "on", first.stdout);
		const before = readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8");
		const r = await s.runAsync(["remote", "setup", "--json", "--no-passcode", "--cloudflare", CF_HOST, "--replace-funnel", "--port", String(port)]);
		assert.equal(r.code, 1, r.stdout);
		assert.equal(r.json().code, "cloudflare_dns");
		assert.equal(readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8"), before);
		assert.equal(remoteRoute(s), "funnel");
		assert.deepEqual(funnelOffCalls(s), [], s.calls().join("\n"));
		assert.equal(existsSync(cfService(s)), false);
	});
});

test("--cloudflare over a Funnel route without --replace-funnel is still refused and changes nothing", async () => {
	const { s, port } = await funnelRouteScenario("rf-refused");
	await withServe(s, port, async () => {
		const first = await s.runAsync(["remote", "setup", "--json", "--port", String(port)]);
		assert.equal(first.json().state, "on", first.stdout);
		const before = readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8");
		const callsBefore = s.calls().length;
		const r = await s.runAsync(["remote", "setup", "--json", "--no-passcode", "--cloudflare", CF_HOST, "--port", String(port)]);
		assert.equal(r.code, 1);
		assert.match(r.json().message, /Funnel from an earlier setup is on/);
		assert.equal(readFileSync(join(s.env.TABKYRA_CONFIG_DIR, "remote.json"), "utf8"), before);
		assert.deepEqual(funnelOffCalls(s), []);
		assert.equal(cfCalls(s).length, 0);
		assert.equal(s.calls().length >= callsBefore, true);
	});
});

test("--replace-funnel without --cloudflare is refused with a clear message", () => {
	const s = scenario("rf-usage", { tailscale: false });
	const r = s.run(["remote", "setup", "--replace-funnel"]);
	assert.equal(r.code, 2);
	assert.match(r.stderr, /--replace-funnel .* needs --cloudflare/);
	assert.equal(s.remoteJsonExists(), false);
});
