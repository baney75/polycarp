// `tabkyra remote setup --json` and `remote status --json`: the structured states Polycarp's app reads, so it never
// scrapes a sentence. tailscale, launchctl and systemctl are stubs in a temp HOME; nothing here touches a real Tailscale,
// a real service manager or ~/.config/tabkyra. Run with --experimental-strip-types (it imports src/remote-state.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
		PATH: `${bin}:${dirname(process.execPath)}`,
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
	for (const state of ["tailscale_missing", "tailscale_signed_out", "funnel_not_allowed", "tailnet_lock", "port_busy", "ready", "on", "no_browser_connected"]) assert.ok(REMOTE_STATES.includes(state), state);
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

test("TABKYRA_TAILSCALE_APP names the Mac app's tailscale when PATH has none; a relative or missing path is ignored", () => {
	const s = scenario("st-app", { tailscaleDir: "app" });
	assert.equal(s.run(["remote", "status", "--json"]).json().state, "tailscale_missing", "off PATH and not named");
	const named = s.run(["remote", "status", "--json"], { TABKYRA_TAILSCALE_APP: join(s.dir, "app", "tailscale") });
	assert.equal(named.json().state, "ready");
	assert.equal(s.run(["remote", "status", "--json"], { TABKYRA_TAILSCALE_APP: "app/tailscale" }).json().state, "tailscale_missing");
	assert.equal(s.run(["remote", "status", "--json"], { TABKYRA_TAILSCALE_APP: join(s.dir, "nope") }).json().state, "tailscale_missing");
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

// ---------- the Tailscale Mac app at its fixed path: a terminal and Polycarp's window behave the same ----------

test("the CLI finds the Tailscale app at its fixed path with nothing named: status, setup and remote off all use it", async () => {
	const s = scenario("app-fixed", { app: true });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		assert.equal(s.run(["remote", "status", "--json"]).json().state, "ready", "found with no PATH entry and no TABKYRA_TAILSCALE_APP");
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
