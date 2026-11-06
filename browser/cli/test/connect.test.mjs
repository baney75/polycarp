// `connect on|off|status|waitlist|run`: the helper that asks Polycarp's connection service for a free tunnel and
// reuses `remote setup` for the rest. Everything here is a stand-in: a fake connection service (which also checks
// every signature the way the real Worker does), a stub cloudflared, and stub launchctl/systemctl on PATH. Each
// scenario has its own HOME and config dir. Nothing reaches Cloudflare, the real service managers or ~/.config/tabkyra.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "polycarp-connect-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const HOST = "pc-aaaaaaaaaaaaaaaaaaaa.example.test";
const TOKEN = "FAKE-TUNNEL-TOKEN-do-not-store";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const PASSCODE = /([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}/;
const serviceTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;

/** The fake connection service. `mode` picks what capacity and claim answer; every signed call is verified like the Worker does. */
async function fakeService() {
	const calls = [];
	const state = { mode: "open", claimed: false, waitlist: new Map(), claimMode: undefined, signatureErrors: [] };
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			const path = req.url ?? "";
			const send = (status, json) => {
				res.statusCode = status;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(json));
			};
			const call = { method: req.method, path, body: body ? JSON.parse(body) : undefined, signed: false };
			calls.push(call);
			if (req.headers["x-polycarp-sig"]) {
				const pub = Buffer.from(String(req.headers["x-polycarp-key"]), "base64url");
				const message = ["polycarp-connect/v1", req.method, path, req.headers["x-polycarp-time"], req.headers["x-polycarp-nonce"], createHash("sha256").update(body).digest("hex")].join("\n");
				const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") }, format: "jwk" });
				call.signed = verify(null, Buffer.from(message), key, Buffer.from(String(req.headers["x-polycarp-sig"]), "base64url"));
				if (!call.signed) state.signatureErrors.push(`${req.method} ${path}`);
			}
			if (state.mode === "down") return send(503, { status: "unavailable" });
			if (path === "/v1/capacity") return send(200, state.mode === "paused" ? { status: "open", remaining: "plenty", paused: true } : { status: state.mode === "at_capacity" ? "at_capacity" : state.mode === "invite_only" ? "invite_only" : "open", remaining: "plenty", paused: false });
			if (path === "/v1/claim" && req.method === "POST") {
				const mode = state.claimMode ?? state.mode;
				if (mode === "at_capacity" || mode === "claim_full") return send(503, { status: "at_capacity" });
				if (mode === "invite_only" && !call.body?.invite) return send(403, { status: "invite_required" });
				if (mode === "invite_only" && call.body.invite !== "PC-GOOD-GOOD-GOOD-GOOD") return send(403, { status: "invite_invalid" });
				if (!call.signed) return send(401, { status: "unauthorized" });
				state.claimed = true;
				return send(200, { status: "ok", hostname: HOST, tunnelToken: TOKEN });
			}
			if (path === "/v1/claim" && req.method === "DELETE") {
				if (!call.signed) return send(401, { status: "unauthorized" });
				const released = state.claimed;
				state.claimed = false;
				return send(200, { status: "ok", released });
			}
			if (path === "/v1/seen") return call.signed ? (state.claimed ? send(200, { status: "ok" }) : send(404, { status: "not_found" })) : send(401, { status: "unauthorized" });
			if (path === "/v1/waitlist") {
				if (req.method === "POST") {
					state.waitlist.set(call.body.email, "tok-123");
					return send(200, { status: "ok", deleteToken: "tok-123" });
				}
				if (req.method === "DELETE" && state.waitlist.get(call.body.email) === call.body.token) {
					state.waitlist.delete(call.body.email);
					return send(200, { status: "ok", deleted: true });
				}
				return send(401, { status: "unauthorized" });
			}
			send(404, { status: "not_found" });
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${server.address().port}`, calls, state, close: () => new Promise((r) => server.close(r)) };
}

/** A local server that answers like `serve` does for the connector URL: the protected-resource metadata. */
async function localServe(resource) {
	const srv = createServer((req, res) => {
		if (req.url !== METADATA_PATH) {
			res.statusCode = 404;
			res.end("no");
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ resource }));
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

let n = 0;
/** One scenario: own HOME and config dir, stub launchctl/systemctl, a stub cloudflared that records the environment it was started with. */
function scenario(service, extra = {}) {
	const dir = join(root, `s${++n}`);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	const log = join(dir, "calls.log");
	const cfdLog = join(dir, "cloudflared.log");
	const marker = join(dir, "loaded");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	const script = (file, body) => {
		writeFileSync(join(bin, file), `#!/bin/sh\n${body}`);
		chmodSync(join(bin, file), 0o755);
	};
	script("launchctl", `echo "launchctl $*" >> ${log}\ncase "$1" in\nbootstrap) /usr/bin/touch ${marker} ;;\nbootout) /bin/rm -f ${marker} ;;\nprint) [ -f ${marker} ] && echo "state = running" && exit 0; exit 1 ;;\nesac\n`);
	script("systemctl", `echo "systemctl $*" >> ${log}\ncase "$2" in\nis-active) exit 0 ;;\nesac\n`);
	const stub = join(dir, "cloudflared-stub");
	writeFileSync(stub, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 2026.10.7"; exit 0; fi\necho "pid=$$ args=$* token=$TUNNEL_TOKEN" >> ${cfdLog}\nexec /bin/sleep 300\n`);
	chmodSync(stub, 0o755);
	const config = join(home, "cfg");
	const baseEnv = {
		HOME: home,
		TABKYRA_CONFIG_DIR: config,
		PATH: `${bin}:${dirname(process.execPath)}`,
		NO_COLOR: "1",
		TABKYRA_SOCKET_DIR: join(dir, "sock"),
		POLYCARP_CONNECT_URL: service.url,
		POLYCARP_CLOUDFLARED_BIN: stub,
		POLYCARP_SUPPORT_DIR: join(dir, "support"),
		POLYCARP_CONNECT_WAIT_MS: "2500",
		...extra,
	};
	mkdirSync(baseEnv.TABKYRA_SOCKET_DIR, { mode: 0o700 });
	// Async on purpose: the fake service lives in this process, and spawnSync would block it from answering.
	const run = (args, more = {}) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...more } });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => resolve({ code, out: `${stdout}${stderr}`, stdout, stderr }));
		});
	return {
		dir,
		home,
		config,
		stub,
		env: baseEnv,
		run,
		json: async (args, more) => {
			const r = await run([...args, "--json"], more);
			return { code: r.code, ...JSON.parse(r.stdout.trim().split("\n").pop()), raw: r };
		},
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		cloudflaredStarts: () => (existsSync(cfdLog) ? readFileSync(cfdLog, "utf8").split("\n").filter(Boolean) : []),
		remoteJson: () => JSON.parse(readFileSync(join(config, "remote.json"), "utf8")),
		state: () => JSON.parse(readFileSync(join(config, "connect", "state.json"), "utf8")),
		files: (dirPath = dir) => readdirSync(dirPath, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name)),
		launcher: () => {
			const path = join(home, ".config", "tabkyra", "tabkyra");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
			chmodSync(path, 0o755);
			return path;
		},
	};
}

/** Processes a failed test could leave behind (cloudflared stubs sleep for minutes). */
const cleanups = [];
after(() => cleanups.forEach((fn) => fn()));

const allCalls = (svc, path, method) => svc.calls.filter((c) => c.path === path && (!method || c.method === method));

test("on --no-service claims with a signed request, runs remote setup for the new address, and prints the connector URL and passcode once", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc);
		const r = (await s.json(["connect", "on", "--no-service", "--port", "9123"]));
		assert.equal(r.code, 0, r.raw.out);
		assert.equal(r.ok, true);
		assert.equal(r.state, "connecting", "nothing keeps it running with --no-service");
		assert.equal(r.connectorUrl, `https://${HOST}/mcp`);
		assert.match(r.passcode, PASSCODE);
		assert.deepEqual(s.remoteJson(), { publicUrl: `https://${HOST}`, port: 9123, route: "custom" });
		const claims = allCalls(svc, "/v1/claim", "POST");
		assert.equal(claims.length, 1);
		assert.equal(claims[0].signed, true, "the claim is signed with the device key and verifies");
		assert.deepEqual(claims[0].body, { port: 9123 });
		assert.deepEqual(svc.state.signatureErrors, []);
		// The device key is a 600 file in a 700 folder; the state names no secrets.
		const keyPath = join(s.config, "connect", "device.key");
		assert.equal(statSync(keyPath).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(keyPath)).mode & 0o777, 0o700);
		assert.match(readFileSync(keyPath, "utf8"), /BEGIN PRIVATE KEY/);
		assert.equal(s.state().hostname, HOST);
		// A second run keeps the passcode (not shown again) and the same claim.
		const again = (await s.json(["connect", "on", "--no-service"]));
		assert.equal(again.code, 0, again.raw.out);
		assert.equal(again.passcode, undefined, "the passcode is shown once");
		assert.equal(s.remoteJson().port, 9123, "the port is kept");
		// --new-passcode makes a new one.
		assert.match((await s.json(["connect", "on", "--no-service", "--new-passcode"])).passcode, PASSCODE);
		// The tunnel token is never written under the config or home folders.
		for (const file of s.files(s.home)) assert.ok(!readFileSync(file, "utf8").includes(TOKEN), `${file} must not hold the tunnel token`);
	} finally {
		await svc.close();
	}
});

for (const [mode, state, text] of [
	["at_capacity", "at_capacity", /full right now.*waitlist.*invite code/s],
	["invite_only", "invite_only", /invite code/],
	["paused", "paused", /isn't adding new connections/],
]) {
	test(`when the service is ${mode}, on says so in plain words, takes no slot, and sets up nothing`, async () => {
		const svc = await fakeService();
		try {
			svc.state.mode = mode;
			const s = scenario(svc);
			const human = (await s.run(["connect", "on", "--no-service"]));
			assert.equal(human.code, 3, human.out);
			assert.match(human.out, text);
			assert.doesNotMatch(human.out, /tunnel/i, "no tunnels in what a person reads");
			if (mode !== "paused") assert.match(human.out, /connect waitlist/);
			if (mode !== "paused") assert.match(human.out, /--invite/);
			const r = (await s.json(["connect", "on", "--no-service"]));
			assert.equal(r.state, state);
			assert.equal(r.ok, false);
			assert.equal(allCalls(svc, "/v1/claim").length, 0, "no claim was made");
			assert.equal(existsSync(join(s.config, "remote.json")), false);
			assert.equal(existsSync(join(s.config, "connect", "state.json")), false);
		} finally {
			await svc.close();
		}
	});
}

test("an invite code goes to the service even when the door looks shut, and a bad one is reported", async () => {
	const svc = await fakeService();
	try {
		svc.state.mode = "invite_only";
		const s = scenario(svc);
		const bad = (await s.json(["connect", "on", "--no-service", "--invite", "PC-BAD0-BAD0-BAD0-BAD0"]));
		assert.equal(bad.state, "invite_invalid");
		assert.match(bad.message, /isn't valid, or it was already used/);
		assert.equal(existsSync(join(s.config, "remote.json")), false);
		const good = (await s.json(["connect", "on", "--no-service", "--invite", "PC-GOOD-GOOD-GOOD-GOOD"]));
		assert.equal(good.code, 0, good.raw.out);
		assert.equal(allCalls(svc, "/v1/claim", "POST").at(-1).body.invite, "PC-GOOD-GOOD-GOOD-GOOD");
	} finally {
		await svc.close();
	}
});

test("a claim refused after the capacity check (someone took the last slot) is at capacity too, and leaves nothing", async () => {
	const svc = await fakeService();
	try {
		svc.state.claimMode = "claim_full";
		const s = scenario(svc);
		const r = (await s.json(["connect", "on", "--no-service"]));
		assert.equal(r.state, "at_capacity");
		assert.equal(r.code, 3);
		assert.equal(existsSync(join(s.config, "remote.json")), false);
	} finally {
		await svc.close();
	}
});

test("when the connection service can't be reached, on says offline and changes nothing", async () => {
	const svc = await fakeService();
	const url = svc.url;
	await svc.close();
	const s = scenario({ url });
	const r = (await s.json(["connect", "on", "--no-service"]));
	assert.equal(r.state, "offline");
	assert.match(r.message, /Can't reach Polycarp's connection service/);
	assert.equal(existsSync(join(s.config, "remote.json")), false);
	assert.equal((await s.run(["connect", "status"])).code, 0, "status with nothing set up is simply off");
});

test("on refuses, before taking a slot, when remote access is already set up another way", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc);
		mkdirSync(s.config, { recursive: true });
		writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: "https://mine.example.com", port: 8787, route: "custom" }));
		const r = (await s.json(["connect", "on", "--no-service"]));
		assert.equal(r.ok, false);
		assert.match(r.message, /already set up another way/);
		assert.equal(allCalls(svc, "/v1/claim").length, 0);
		assert.deepEqual(s.remoteJson(), { publicUrl: "https://mine.example.com", port: 8787, route: "custom" }, "their setup is untouched");
	} finally {
		await svc.close();
	}
});

serviceTest("on installs both services (serve and the connection), waits for the address to answer, and puts no token in a service file", async () => {
	const svc = await fakeService();
	const serve = await localServe(`https://${HOST}`.concat("/mcp"));
	try {
		const s = scenario(svc, { POLYCARP_CONNECT_PUBLIC_BASE: `http://127.0.0.1:${serve.port}` });
		const launcher = s.launcher();
		const r = JSON.parse((await s.run(["connect", "on", "--json", "--port", String(serve.port)])).stdout.trim().split("\n").pop());
		assert.equal(r.ok, true, JSON.stringify(r));
		assert.equal(r.state, "on");
		assert.match(r.passcode, PASSCODE);
		const calls = s.calls().filter((x) => /^(launchctl|systemctl)/.test(x));
		if (process.platform === "darwin") {
			const uid = process.getuid();
			assert.ok(calls.includes(`launchctl bootstrap gui/${uid} ${join(s.home, "Library", "LaunchAgents", "com.tabkyra.serve.plist")}`), calls.join("\n"));
			const plistPath = join(s.home, "Library", "LaunchAgents", "com.polycarp.connect.plist");
			assert.ok(calls.includes(`launchctl bootstrap gui/${uid} ${plistPath}`), calls.join("\n"));
			const plist = readFileSync(plistPath, "utf8");
			assert.ok(plist.includes(`<string>${launcher}</string>\n\t\t<string>connect</string>\n\t\t<string>run</string>`), plist);
			assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
			assert.ok(!plist.includes(TOKEN));
		} else {
			assert.ok(calls.includes("systemctl --user enable polycarp-connect.service"), calls.join("\n"));
			const unit = readFileSync(join(s.home, ".config", "systemd", "user", "polycarp-connect.service"), "utf8");
			assert.ok(unit.split("\n").includes(`ExecStart=${launcher} connect run`), unit);
			assert.ok(!unit.includes(TOKEN));
		}
		const st = (await s.json(["connect", "status"]));
		assert.equal(st.state, "on", JSON.stringify(st));
		assert.deepEqual(st.checks.map((c) => `${c.name}:${c.status}`), ["connection:ok", "remote.json:ok", "passcode:ok", "polycarp serve:ok", "from the internet:ok", "connection service:ok"]);
		assert.equal(allCalls(svc, "/v1/seen").at(-1).signed, true, "status sends a signed heartbeat");
		for (const file of s.files(s.home)) assert.ok(!readFileSync(file, "utf8").includes(TOKEN), `${file} must not hold the tunnel token`);
		// off: services stop, remote.json goes, the slot is freed.
		const off = (await s.json(["connect", "off"]));
		assert.equal(off.code, 0, off.raw.out);
		assert.equal(off.state, "off");
		assert.equal(existsSync(join(s.config, "remote.json")), false);
		assert.equal(existsSync(join(s.config, "connect", "state.json")), false);
		assert.equal(svc.state.claimed, false, "the slot was freed");
		assert.equal(allCalls(svc, "/v1/claim", "DELETE").at(-1).signed, true);
		assert.ok(!existsSync(join(s.home, "Library", "LaunchAgents", "com.polycarp.connect.plist")) || process.platform !== "darwin");
		assert.doesNotMatch(off.raw.out, /front door/, "off doesn't warn about a front door it already stopped");
	} finally {
		await serve.close();
		await svc.close();
	}
});

test("status is honest: not running, wrong address and a service that forgot us are all reported", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc);
		assert.equal((await s.json(["connect", "on", "--no-service"])).code, 0);
		const st = (await s.json(["connect", "status"]));
		assert.equal(st.ok, false);
		assert.equal(st.state, "problem");
		const byName = Object.fromEntries(st.checks.map((c) => [c.name, c]));
		assert.equal(byName["connection"].status, "fail", "no service installed");
		assert.equal(byName["polycarp serve"].status, "fail");
		assert.equal(byName["from the internet"].status, "fail");
		assert.equal(byName["connection service"].status, "ok");
		svc.state.claimed = false;
		const forgot = (await s.json(["connect", "status"]));
		assert.equal(forgot.checks.find((c) => c.name === "connection service").status, "fail");
		assert.match(forgot.checks.find((c) => c.name === "connection service").detail, /no longer has this connection/);
		writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: "https://other.example.com", port: 8787, route: "custom" }));
		assert.match((await s.json(["connect", "status"])).checks.find((c) => c.name === "remote.json").detail, /points at https:\/\/other\.example\.com/);
		svc.state.mode = "down";
		const down = (await s.json(["connect", "status"]));
		assert.equal(down.checks.find((c) => c.name === "connection service").status, "warn");
	} finally {
		await svc.close();
	}
});

test("off when the connection service is unreachable turns Connect off here and says the slot isn't freed yet, then finishes next time", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc);
		assert.equal((await s.json(["connect", "on", "--no-service"])).code, 0);
		svc.state.mode = "down";
		const off = (await s.json(["connect", "off"]));
		assert.equal(off.code, 1);
		assert.equal(off.ok, false);
		assert.match(off.message, /off on this computer, but your connection isn't freed yet/);
		assert.equal(existsSync(join(s.config, "remote.json")), false, "remote access is off");
		assert.equal(s.state().releasePending, true);
		assert.equal((await s.json(["connect", "status"])).ok, false);
		svc.state.mode = "open";
		const again = (await s.json(["connect", "off"]));
		assert.equal(again.code, 0, again.raw.out);
		assert.equal(svc.state.claimed, false);
		assert.equal(existsSync(join(s.config, "connect", "state.json")), false);
		assert.match((await s.json(["connect", "off"])).message, /already off/i);
	} finally {
		await svc.close();
	}
});

test("off leaves remote access alone when it isn't the one Connect made", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc);
		assert.equal((await s.json(["connect", "on", "--no-service"])).code, 0);
		writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: "https://mine.example.com", port: 8787, route: "custom" }));
		const off = (await s.json(["connect", "off"]));
		assert.equal(off.code, 0, off.raw.out);
		assert.match(off.message, /left alone/);
		assert.equal(s.remoteJson().publicUrl, "https://mine.example.com");
	} finally {
		await svc.close();
	}
});

test("waitlist joins with just an email, gives a delete token, and --token removes the email", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc);
		const join1 = (await s.json(["connect", "waitlist", "me@example.com"]));
		assert.equal(join1.code, 0, join1.raw.out);
		assert.equal(join1.deleteToken, "tok-123");
		assert.match(join1.message, /on the waitlist/);
		assert.ok(svc.state.waitlist.has("me@example.com"));
		assert.equal(allCalls(svc, "/v1/waitlist")[0].signed, false, "the waitlist call carries no device identity");
		const wrong = (await s.json(["connect", "waitlist", "me@example.com", "--token", "nope"]));
		assert.equal(wrong.code, 1);
		assert.equal((await s.json(["connect", "waitlist", "me@example.com", "--token", "tok-123"])).code, 0);
		assert.equal(svc.state.waitlist.size, 0);
		assert.equal((await s.run(["connect", "waitlist"])).code, 2);
	} finally {
		await svc.close();
	}
});

test("usage errors: unknown subcommand, bad flags and a bad port", async () => {
	const s = scenario({ url: "http://127.0.0.1:1" });
	assert.equal((await s.run(["connect"])).code, 2);
	assert.equal((await s.run(["connect", "sideways"])).code, 2);
	assert.equal((await s.run(["connect", "on", "--bogus"])).code, 2);
	assert.equal((await s.run(["connect", "on", "--port", "80"])).code, 2);
	assert.match((await s.run(["connect", "--help"])).out, /connect/);
});

test("run starts cloudflared with the token in its environment only, sends signed heartbeats, and stops it on SIGTERM", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc, { POLYCARP_CONNECT_HEARTBEAT_MS: "300" });
		assert.equal((await s.json(["connect", "on", "--no-service"])).code, 0);
		const claimsBefore = allCalls(svc, "/v1/claim", "POST").length;
		const child = spawn(process.execPath, [cli, "connect", "run"], { env: s.env });
		cleanups.push(() => {
			child.kill("SIGKILL");
			for (const line of s.cloudflaredStarts()) {
				try {
					process.kill(Number(/pid=(\d+)/.exec(line)?.[1]), "SIGKILL");
				} catch {
					/* gone */
				}
			}
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const until = async (fn, ms = 8000) => {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				if (fn()) return;
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.fail(`timed out waiting; output so far: ${out}`);
		};
		await until(() => s.cloudflaredStarts().length === 1);
		const start = s.cloudflaredStarts()[0];
		assert.match(start, /args=tunnel --no-autoupdate run /, start);
		assert.ok(start.endsWith(`token=${TOKEN}`), "the token arrives in the environment");
		assert.ok(!start.split(" args=")[1].split(" token=")[0].includes(TOKEN), "and never on the command line");
		assert.equal(allCalls(svc, "/v1/claim", "POST").length, claimsBefore + 1);
		await until(() => allCalls(svc, "/v1/seen").length >= 2);
		assert.ok(allCalls(svc, "/v1/seen").every((c) => c.signed));
		assert.ok(!out.includes(TOKEN), "the token is never logged");
		const pid = Number(/pid=(\d+)/.exec(start)[1]);
		child.kill("SIGTERM");
		const code = await new Promise((resolve) => child.on("close", resolve));
		assert.equal(code, 0);
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0), "cloudflared was stopped with the supervisor");
	} finally {
		await svc.close();
	}
});

test("run keeps trying while the service says no, and doesn't start cloudflared without a token", async () => {
	const svc = await fakeService();
	try {
		const s = scenario(svc);
		assert.equal((await s.json(["connect", "on", "--no-service"])).code, 0);
		svc.state.claimMode = "claim_full";
		const child = spawn(process.execPath, [cli, "connect", "run"], { env: s.env });
		await new Promise((r) => setTimeout(r, 1200));
		child.kill("SIGTERM");
		await new Promise((resolve) => child.on("close", resolve));
		assert.equal(s.cloudflaredStarts().length, 0);
	} finally {
		await svc.close();
	}
});

// ---------- cloudflared on demand ----------

const cf = await loadTs('export * from "@src/connect-cloudflared.ts";');

function stubArchive(dir, versionText = "cloudflared version 2026.10.7 (built test)") {
	const src = join(dir, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "cloudflared"), `#!/bin/sh\ntouch "${join(dir, "ran")}"\nif [ "$1" = "--version" ]; then echo "${versionText}"; fi\n`);
	chmodSync(join(src, "cloudflared"), 0o755);
	const tgz = join(dir, "cloudflared.tgz");
	assert.equal(spawnSync("tar", ["-czf", tgz, "-C", src, "cloudflared"]).status, 0);
	const bytes = readFileSync(tgz);
	return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function withSupport(name, fn) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const saved = { ...process.env };
	process.env.POLYCARP_SUPPORT_DIR = join(dir, "support");
	delete process.env.POLYCARP_CLOUDFLARED_BIN;
	return Promise.resolve(fn(dir)).finally(() => {
		for (const k of ["POLYCARP_SUPPORT_DIR", "POLYCARP_CLOUDFLARED_BIN"]) {
			if (Object.hasOwn(saved, k)) process.env[k] = saved[k];
			else delete process.env[k];
		}
	});
}

const keyNow = () => cf.platformKey();

test("the pinned cloudflared release is complete: a version, https links on the right release, and a SHA-256 for each Mac", () => {
	const m = cf.PINNED_CLOUDFLARED;
	assert.match(m.version, /^\d{4}\.\d+\.\d+$/);
	assert.deepEqual(Object.keys(m.assets).sort(), ["darwin-amd64", "darwin-arm64"]);
	for (const [key, asset] of Object.entries(m.assets)) {
		assert.match(asset.sha256, /^[0-9a-f]{64}$/, key);
		assert.equal(asset.url, `https://github.com/cloudflare/cloudflared/releases/download/${m.version}/cloudflared-${key}.tgz`);
	}
	assert.notEqual(m.assets["darwin-amd64"].sha256, m.assets["darwin-arm64"].sha256);
});

test("ensureCloudflared downloads once, checks the SHA-256 before unpacking, and installs it into the support folder", async () =>
	withSupport("dl-ok", async (dir) => {
		const { bytes, sha256 } = stubArchive(dir);
		const manifest = { version: "2026.10.7", assets: { [keyNow()]: { url: "https://example.test/cloudflared.tgz", sha256 } } };
		let fetched = 0;
		const fetchFn = async (url) => {
			fetched++;
			assert.equal(url, "https://example.test/cloudflared.tgz");
			return new Response(bytes, { status: 200 });
		};
		const said = [];
		const first = await cf.ensureCloudflared({ manifest, fetchFn, say: (l) => said.push(l) });
		assert.equal(first.ok, true, JSON.stringify(first));
		assert.equal(first.downloaded, true);
		assert.equal(first.path, join(process.env.POLYCARP_SUPPORT_DIR, "bin", "cloudflared-2026.10.7"));
		assert.equal(statSync(first.path).mode & 0o777, 0o755);
		assert.equal(said.length, 1);
		assert.equal(readdirSync(join(process.env.POLYCARP_SUPPORT_DIR, "bin")).join(), "cloudflared-2026.10.7", "no temp files are left");
		const second = await cf.ensureCloudflared({ manifest, fetchFn });
		assert.equal(second.ok && second.downloaded, false);
		assert.equal(fetched, 1, "the second call downloads nothing");
	}));

test("ensureCloudflared refuses a download whose SHA-256 differs, and never runs it", async () =>
	withSupport("dl-bad-hash", async (dir) => {
		const { bytes } = stubArchive(dir);
		const manifest = { version: "2026.10.7", assets: { [keyNow()]: { url: "https://example.test/cloudflared.tgz", sha256: "0".repeat(64) } } };
		const r = await cf.ensureCloudflared({ manifest, fetchFn: async () => new Response(bytes, { status: 200 }) });
		assert.equal(r.ok, false);
		assert.match(r.message, /doesn't match the checksum/);
		assert.equal(existsSync(join(dir, "ran")), false, "the unchecked file was never executed");
		assert.equal(existsSync(join(process.env.POLYCARP_SUPPORT_DIR, "bin", "cloudflared-2026.10.7")), false);
	}));

test("ensureCloudflared refuses a binary that isn't the pinned version, an http link, a failed download and an unsupported computer", async () =>
	withSupport("dl-other", async (dir) => {
		const { bytes, sha256 } = stubArchive(dir, "cloudflared version 1999.1.1");
		const key = keyNow();
		const wrongVersion = await cf.ensureCloudflared({ manifest: { version: "2026.10.7", assets: { [key]: { url: "https://example.test/x.tgz", sha256 } } }, fetchFn: async () => new Response(bytes) });
		assert.equal(wrongVersion.ok, false);
		assert.match(wrongVersion.message, /didn't start as version 2026\.10\.7/);
		assert.equal(existsSync(join(process.env.POLYCARP_SUPPORT_DIR, "bin", "cloudflared-2026.10.7")), false);
		const http = await cf.ensureCloudflared({ manifest: { version: "2026.10.7", assets: { [key]: { url: "http://example.test/x.tgz", sha256 } } }, fetchFn: async () => assert.fail("no fetch for an http link") });
		assert.match(http.message, /isn't an https address/);
		const failed = await cf.ensureCloudflared({ manifest: { version: "2026.10.7", assets: { [key]: { url: "https://example.test/x.tgz", sha256 } } }, fetchFn: async () => new Response("no", { status: 404 }) });
		assert.match(failed.message, /answered 404/);
		const offline = await cf.ensureCloudflared({ manifest: { version: "2026.10.7", assets: { [key]: { url: "https://example.test/x.tgz", sha256 } } }, fetchFn: async () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) });
		assert.match(offline.message, /Couldn't download the helper/);
		const unsupported = await cf.ensureCloudflared({ manifest: { version: "2026.10.7", assets: {} }, fetchFn: async () => assert.fail("no fetch") });
		assert.match(unsupported.message, /can't set up Connect on this kind of computer yet/);
	}));

test("POLYCARP_CLOUDFLARED_BIN must be an absolute executable", async () =>
	withSupport("dl-override", async (dir) => {
		process.env.POLYCARP_CLOUDFLARED_BIN = "relative/cloudflared";
		assert.equal((await cf.ensureCloudflared({})).ok, false);
		const bin = join(dir, "mine");
		writeFileSync(bin, "#!/bin/sh\n");
		chmodSync(bin, 0o755);
		process.env.POLYCARP_CLOUDFLARED_BIN = bin;
		assert.deepEqual(await cf.ensureCloudflared({}), { ok: true, path: bin, downloaded: false });
	}));
