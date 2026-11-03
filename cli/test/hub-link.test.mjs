// The hub and the device link (D32), with real processes: `tabkyra hub serve`, `tabkyra link run`
// (each with its own serve, config dir and bridge socket dir) and, for the plain-serve checks,
// `tabkyra serve`. The tools used (tools/list, skill_match) need no browser. Time-dependent
// behavior (a code expiring after 10 minutes) is tested by moving the stored expiry into the past,
// because the tests run the built CLI as processes and can't swap its clock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { addDevice, cli, connect, createToken, freePort, hostRequest, INITIALIZE, machine, rawTools, readJson, rmSync, rpc, sleep, startHub, tempRoot, writeJson } from "./helpers/hub-fixture.mjs";

const root = tempRoot("tabkyra-hublink-");
const cleanup = [];
after(() => {
	for (const stop of cleanup) {
		try {
			stop();
		} catch {
			/* already gone */
		}
	}
	// A hub that was just stopped can still be writing its files for a moment; retry instead of failing on ENOTEMPTY.
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A hub that is stopped when the file's tests end. */
async function hubFor(name) {
	const hub = await startHub(root, name);
	cleanup.push(() => hub.stop());
	return hub;
}
async function deviceFor(hub, name, options) {
	const device = await addDevice(root, hub, name, options);
	cleanup.push(() => device.kill());
	return device;
}

const scopeTools = machine(root, "scope-table").json(["token", "scopes", "--json"]);
const toolsOf = (...scopes) => [...new Set(scopes.flatMap((s) => scopeTools[s].tools))].sort();

// ---------- 1. Routing ----------

test("routing: a new session goes to the not-busy, least-busy device, and prefer breaks ties", async () => {
	const hub = await hubFor("route-hub");
	const a = await deviceFor(hub, "alpha");
	await deviceFor(hub, "beta");
	const secret = createToken(hub, "caller", "skills.read");
	const open = [];
	const session = async () => {
		const c = await connect(`${hub.url}/mcp`, secret);
		open.push(c.client);
		return c.client;
	};
	try {
		// alpha is marked busy: new sessions avoid it.
		assert.equal(a.run(["link", "busy", "on"]).code, 0);
		await hub.waitDevices((d) => d.alpha.busy, "alpha to report busy");
		const first = await session();
		assert.deepEqual((await first.listTools()).tools.map((t) => t.name).sort(), ["skill_match", "skill_read"]);
		const match = await first.callTool({ name: "skill_match", arguments: { task: "background check on a roofing contractor" } });
		assert.match(match.content[0].text, /^osint /, "a tool call crosses the hub and the device link");
		await hub.waitDevices((d) => d.beta.sessions === 1 && d.alpha.sessions === 0, "the first session on beta");

		// Not busy any more: fewest sessions wins.
		assert.equal(a.run(["link", "busy", "off"]).code, 0);
		await hub.waitDevices((d) => !d.alpha.busy, "alpha to report not busy");
		await session();
		await hub.waitDevices((d) => d.alpha.sessions === 1 && d.beta.sessions === 1, "one session each");

		// A tie: prefer decides, both ways.
		assert.equal(hub.run(["hub", "prefer", "beta,alpha"]).code, 0);
		await session();
		await hub.waitDevices((d) => d.beta.sessions === 2 && d.alpha.sessions === 1, "the tie going to beta");
		await session(); // alpha has fewer now
		await hub.waitDevices((d) => d.alpha.sessions === 2 && d.beta.sessions === 2, "balanced again");
		assert.equal(hub.run(["hub", "prefer", "alpha,beta"]).code, 0);
		await session();
		await hub.waitDevices((d) => d.alpha.sessions === 3 && d.beta.sessions === 2, "the tie going to alpha");
		assert.equal(hub.run(["hub", "prefer", "ghost"]).code, 1, "prefer names only enrolled devices");
	} finally {
		await Promise.allSettled(open.map((c) => c.close()));
	}
});

test("with nothing online the hub answers 503 naming each device and when it was last seen", async () => {
	const hub = await hubFor("offline-hub");
	const empty = await rpc(`${hub.url}/mcp`, createToken(hub, "caller", "skills.read"), INITIALIZE);
	assert.equal(empty.status, 503);
	assert.match(empty.json.error.message, /No device is linked/);
	const d = await deviceFor(hub, "gamma");
	d.kill();
	await hub.waitDevices((x) => !x.gamma.online, "gamma to go offline");
	const down = await rpc(`${hub.url}/mcp`, createToken(hub, "caller2", "skills.read"), INITIALIZE);
	assert.equal(down.status, 503);
	assert.match(down.json.error.message, /No device is online\. gamma: offline, last seen \d{4}-\d\d-\d\dT/);
});

// ---------- 2. Failover ----------

test("failover: when a device's link dies its sessions answer 404 and a new session lands on another device", async () => {
	const hub = await hubFor("failover-hub");
	const a = await deviceFor(hub, "alpha");
	await deviceFor(hub, "beta");
	assert.equal(hub.run(["hub", "prefer", "alpha,beta"]).code, 0);
	const secret = createToken(hub, "caller", "skills.read");
	const first = await connect(`${hub.url}/mcp`, secret);
	try {
		await hub.waitDevices((d) => d.alpha.sessions === 1, "the session on alpha");
		const sessionId = first.transport.sessionId;
		const live = await rpc(`${hub.url}/mcp`, secret, { jsonrpc: "2.0", id: 5, method: "tools/list" }, { "mcp-session-id": sessionId });
		assert.equal(live.status, 200);
		a.kill("SIGKILL");
		await hub.waitDevices((d) => !d.alpha.online, "alpha to drop");
		const gone = await rpc(`${hub.url}/mcp`, secret, { jsonrpc: "2.0", id: 6, method: "tools/list" }, { "mcp-session-id": sessionId });
		assert.equal(gone.status, 404, "the client is told to start over");
		assert.match(gone.json.error.message, /Unknown or expired session/);
		const second = await connect(`${hub.url}/mcp`, secret);
		try {
			assert.deepEqual((await second.client.listTools()).tools.map((t) => t.name).sort(), ["skill_match", "skill_read"]);
			await hub.waitDevices((d) => d.beta.sessions === 1, "the new session on beta");
		} finally {
			await second.client.close();
		}
	} finally {
		await first.client.close().catch(() => undefined);
	}
});

test("a session belongs to the caller that opened it", async () => {
	const hub = await hubFor("owner-hub");
	await deviceFor(hub, "alpha");
	const one = createToken(hub, "one", "skills.read");
	const two = createToken(hub, "two", "skills.read");
	const opened = await rawTools(`${hub.url}/mcp`, one);
	assert.equal(opened.status, 200);
	const stolen = await rpc(`${hub.url}/mcp`, two, { jsonrpc: "2.0", id: 9, method: "tools/list" }, { "mcp-session-id": opened.sessionId });
	assert.equal(stolen.status, 403);
	const noToken = await rpc(`${hub.url}/mcp`, undefined, INITIALIZE);
	assert.equal(noToken.status, 401);
	assert.match(noToken.headers.get("www-authenticate"), /resource_metadata=/);
});

// ---------- 3. Scopes across the hop ----------

test("scope intersection: the caller gets only what both their grant and the device's cap allow", async () => {
	// A device capped at the default grant (no browser.script, no threads.read).
	const hub = await hubFor("scope-hub");
	await deviceFor(hub, "plain");
	const url = `${hub.url}/mcp`;
	const reader = await rawTools(url, createToken(hub, "reader", "browser.read,skills.read"));
	assert.deepEqual(reader.tools, toolsOf("browser.read", "skills.read"), "a caller's read scope through the default cap sees only read tools");
	assert.ok(!reader.tools.includes("click") && !reader.tools.includes("navigate"));
	const scripter = await rawTools(url, createToken(hub, "scripter", "browser.read,browser.script"));
	assert.deepEqual(scripter.tools, toolsOf("browser.read"), "browser.script is not in the device's cap, so run_js is not offered");
	assert.ok(!scripter.tools.includes("run_js"));

	// Headers a public client sends under x-tabkyra-hub-* are dropped at the hub.
	const spoof = await rawTools(url, createToken(hub, "spoofer", "browser.read"), {
		"x-tabkyra-hub-scopes": "browser.read,browser.act,browser.script,threads.read",
		"x-tabkyra-hub-caller": "someone-else",
	});
	assert.deepEqual(spoof.tools, toolsOf("browser.read"), "spoofed hub headers on the public /mcp change nothing");

	// A device whose cap includes browser.script offers run_js only to a caller who holds it.
	const hub2 = await hubFor("scope-hub2");
	await deviceFor(hub2, "capable", { scope: "browser.read,browser.script,skills.read" });
	const both = await rawTools(`${hub2.url}/mcp`, createToken(hub2, "both", "browser.read,browser.script"));
	assert.deepEqual(both.tools, toolsOf("browser.read", "browser.script"));
	const readOnly = await rawTools(`${hub2.url}/mcp`, createToken(hub2, "ro", "browser.read"));
	assert.deepEqual(readOnly.tools, toolsOf("browser.read"), "the device's wider cap never widens a narrower caller");
});

test("a plain serve token ignores x-tabkyra-hub-* headers, and a link token works nowhere but link run", async () => {
	const m = machine(root, "plain-serve");
	const secret = createToken(m, "narrow", "browser.read");
	// A link-kind record with a known secret, as if copied from a device.
	const linkSecret = `tkr_${randomBytes(32).toString("base64url")}`;
	const file = m.file("tokens.json");
	const tokens = readJson(file);
	tokens.tokens.push({ id: "deadbeef", name: "link", scopes: ["browser.read", "browser.script"], sha256: createHash("sha256").update(linkSecret).digest("hex"), createdAt: new Date().toISOString(), kind: "link" });
	writeJson(file, tokens);

	const port = await freePort();
	const publicPort = await freePort();
	const procs = [
		spawn(process.execPath, [cli, "serve", "--port", String(port)], { env: m.env }),
		spawn(process.execPath, [cli, "serve", "--port", String(publicPort), "--public-url", `http://127.0.0.1:${publicPort}`], { env: m.env }),
	];
	cleanup.push(() => procs.forEach((p) => p.kill()));
	for (const p of procs) {
		await new Promise((resolve, reject) => {
			let out = "";
			p.stdout.on("data", (d) => {
				out += d;
				if (/MCP over HTTP/.test(out)) resolve();
			});
			p.on("exit", (c) => reject(new Error(`serve exited ${c}: ${out}`)));
			setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 15_000);
		});
	}
	const forged = { "x-tabkyra-hub-scopes": "browser.script,browser.act,threads.read", "x-tabkyra-hub-caller": "evil" };
	const plain = await rawTools(`http://127.0.0.1:${port}/mcp`, secret, forged);
	assert.deepEqual(plain.tools, toolsOf("browser.read"), "headers on an ordinary token are ignored");
	for (const base of [`http://127.0.0.1:${port}`, `http://127.0.0.1:${publicPort}`]) {
		const refused = await rpc(`${base}/mcp`, linkSecret, INITIALIZE, forged);
		assert.equal(refused.status, 401, `a link token is refused by ${base}`);
	}
});

// ---------- 4. Codes ----------

async function enroll(hub, body, extraHeaders = {}) {
	const res = await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
	return { status: res.status, body: await res.json() };
}

test("a connect code works once, expires after 10 minutes, and is stored only as a hash", async () => {
	const hub = await hubFor("code-hub");
	const { code, expiresAt } = hub.json(["hub", "code", "--name", "d1", "--json"]);
	assert.match(code, /^TK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
	const stored = readFileSync(hub.file("hub-codes.json"), "utf8");
	assert.ok(!stored.includes(code) && !stored.includes(code.slice(3)), "the code itself is never stored");
	assert.ok(stored.includes(createHash("sha256").update(code).digest("hex")), "its SHA-256 is");
	assert.equal(statSync(hub.file("hub-codes.json")).mode & 0o777, 0o600);
	const record = readJson(hub.file("hub-codes.json")).codes[0];
	assert.equal(record.expiresAt - record.createdAt, 10 * 60_000);
	assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 10 * 60_000);

	const lower = code.toLowerCase().replace(/-/g, " ");
	const ok = await enroll(hub, { code: lower, name: "ignored", version: "1.0.0" });
	assert.equal(ok.status, 200, "case and separators don't matter");
	assert.equal(ok.body.name, "d1", "a code minted with a name names the device");
	assert.equal(ok.body.manage, false);
	const again = await enroll(hub, { code });
	assert.equal(again.status, 401, "single use");

	// Stored credentials are hashes, and the file is private.
	const devices = readFileSync(hub.file("hub-devices.json"), "utf8");
	assert.ok(!devices.includes(ok.body.secret), "the device secret is never stored");
	assert.ok(devices.includes(createHash("sha256").update(ok.body.secret).digest("hex")));
	assert.equal(statSync(hub.file("hub-devices.json")).mode & 0o777, 0o600);

	// Ten minutes later (the stored expiry moved into the past).
	const late = hub.json(["hub", "code", "--name", "d2", "--json"]).code;
	const file = hub.file("hub-codes.json");
	const data = readJson(file);
	for (const c of data.codes) c.expiresAt = Date.now() - 1;
	writeJson(file, data);
	assert.equal((await enroll(hub, { code: late })).status, 401, "expired");

	// A taken name fails without spending the code.
	const clash = hub.json(["hub", "code", "--name", "d1", "--json"]).code;
	assert.equal((await enroll(hub, { code: clash })).status, 409);
	assert.equal(readJson(file).codes.length, 1, "the code survives a name clash");
});

test("wrong connect codes are rate limited (429), even for the right code afterwards", async () => {
	const hub = await hubFor("limit-hub");
	const good = hub.json(["hub", "code", "--json"]).code;
	for (let i = 0; i < 5; i++) assert.equal((await enroll(hub, { code: "TK-0000-000A" })).status, 401);
	assert.equal((await enroll(hub, { code: "TK-0000-000A" })).status, 429);
	assert.equal((await enroll(hub, { code: good })).status, 429, "the lockout holds the right code too");
	// A forged source header spreads the flood out but the global cap still holds.
	let last = 0;
	for (let i = 0; i < 40; i++) last = (await enroll(hub, { code: `TK-0000-${String(i).padStart(4, "0")}` }, { "x-forwarded-for": `10.0.0.${i}` })).status;
	assert.equal(last, 429, "forged sources can't walk around the global cap");
});

test("/link/code is for manager devices only", async () => {
	const hub = await hubFor("manage-hub");
	const plain = await deviceFor(hub, "plain");
	const boss = await deviceFor(hub, "boss", { manage: true });
	const credential = (d) => {
		const link = readJson(d.file("link.json"));
		return `${link.deviceId}.${link.secret}`;
	};
	const ask = (cred, kind) =>
		fetch(`${hub.url}/link/code`, { method: "POST", headers: { "content-type": "application/json", ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify({ kind }) });
	assert.equal((await ask(undefined, "connect")).status, 401);
	assert.equal((await ask("dv-000000000000.wrong", "connect")).status, 401);
	assert.equal((await ask(credential(plain), "connect")).status, 403, "a device that isn't a manager can't mint codes");
	assert.equal((await ask(credential(plain), "approval")).status, 403);
	const res = await ask(credential(boss), "connect");
	assert.equal(res.status, 200);
	const minted = await res.json();
	assert.equal((await enroll(hub, { code: minted.code, name: "third" })).status, 200, "a code from a manager enrolls a device");
	assert.equal(plain.run(["link", "code"]).code, 1, "link code says so locally too");
	assert.match(plain.run(["link", "code"]).out, /isn't a manager/);
	const viaCli = boss.json(["link", "code", "--json"]);
	assert.match(viaCli.code, /^TK-/);
	const approval = boss.json(["link", "approval-code", "--json"]);
	assert.match(approval.code, /^TK-/);
	assert.equal(approval.url, `${hub.url}/mcp`);
});

async function consentFor(hub) {
	const reg = await fetch(`${hub.url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://localhost:4567/cb"] }) });
	const { client_id } = await reg.json();
	const verifier = randomBytes(32).toString("base64url");
	const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:4567/cb", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${hub.url}/mcp` });
	const html = await (await fetch(`${hub.url}/authorize?${q}`)).text();
	const signed = /name="request" value="([^"]+)"/.exec(html)[1];
	return {
		html,
		approve: (typed) =>
			fetch(`${hub.url}/authorize`, {
				method: "POST",
				redirect: "manual",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams([["request", signed], ["passcode", typed], ["scope", "browser.read"], ["decision", "allow"]]),
			}),
	};
}

test("an approval code approves a connector once and counts toward the passcode lockout", async () => {
	const hub = await hubFor("approval-hub");
	const { html, approve } = await consentFor(hub);
	assert.match(html, /Passcode or connect code/);
	assert.match(html, /autocomplete="one-time-code"/);
	const minted = hub.json(["token", "approval-code", "--json"]);
	assert.match(minted.code, /^TK-/);
	assert.equal(minted.url, undefined, "no hub.json here, so no URL");
	const stored = readFileSync(hub.file("oauth-codes.json"), "utf8");
	assert.ok(!stored.includes(minted.code) && stored.includes(createHash("sha256").update(minted.code).digest("hex")));
	assert.equal(statSync(hub.file("oauth-codes.json")).mode & 0o777, 0o600);

	const ok = await approve(minted.code.toLowerCase());
	assert.equal(ok.status, 302);
	assert.match(ok.headers.get("location"), /^http:\/\/localhost:4567\/cb\?code=tka_/);
	assert.equal((await approve(minted.code)).status, 401, "used once");
	// Failure 1 was the reuse; four wrong ones make five.
	for (let i = 0; i < 4; i++) assert.equal((await approve("TK-1111-2222")).status, 401);
	const fresh = hub.json(["token", "approval-code", "--json"]);
	assert.equal((await approve(fresh.code)).status, 429, "a valid code is refused during the lockout, like the passcode");
	// The passcode path shares the counter: a wrong passcode is a failure too.
	assert.equal((await approve("not-a-code")).status, 429);
});

test("an expired approval code is refused", async () => {
	const hub = await hubFor("approval-expiry-hub");
	const { approve } = await consentFor(hub);
	const minted = hub.json(["token", "approval-code", "--json"]);
	const file = hub.file("oauth-codes.json");
	const data = readJson(file);
	for (const c of data.codes) c.expiresAt = Date.now() - 1;
	writeJson(file, data);
	assert.equal((await approve(minted.code)).status, 401);
});

// ---------- 5. Revoke and the Host allowlist ----------

function wsStatus(url, headers) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url, { headers });
		ws.on("unexpected-response", (_req, res) => {
			res.resume();
			resolve(res.statusCode);
			ws.terminate();
		});
		ws.on("open", () => {
			resolve(101);
			ws.terminate();
		});
		ws.on("error", () => undefined);
	});
}

test("removing a device closes its live link, and its credential is refused afterwards (401)", async () => {
	const hub = await hubFor("revoke-hub");
	const d = await deviceFor(hub, "doomed");
	const link = readJson(d.file("link.json"));
	const credential = `${link.deviceId}.${link.secret}`;
	const wsUrl = `${hub.url.replace("http", "ws")}/link`;
	assert.equal(hub.run(["hub", "remove", "doomed"]).code, 0);
	assert.equal(hub.run(["hub", "remove", "doomed"]).code, 1, "removing twice says there is no such device");
	await sleep(1500);
	assert.equal(await wsStatus(wsUrl, { authorization: `Bearer ${credential}` }), 401, "the credential is revoked");
	const deadline = Date.now() + 15_000;
	while (!/401/.test(d.logs()) && Date.now() < deadline) await sleep(200);
	assert.match(d.logs(), /answered 401/, "the device's own reconnect is refused too");
	const live = hub.json(["hub", "devices", "--json"]);
	assert.deepEqual(live.devices, []);
	assert.equal(await wsStatus(wsUrl, {}), 401, "no credential at all");
});

test("one live link per device: a new link replaces the old", async () => {
	const hub = await hubFor("replace-hub");
	const d = await deviceFor(hub, "solo");
	const link = readJson(d.file("link.json"));
	const wsUrl = `${hub.url.replace("http", "ws")}/link`;
	assert.equal(await wsStatus(wsUrl, { authorization: `Bearer ${link.deviceId}.${link.secret}` }), 101);
	const deadline = Date.now() + 10_000;
	while (!/replaced/.test(d.logs()) && Date.now() < deadline) await sleep(100);
	assert.match(d.logs(), /another link for this device replaced this one/);
});

test("a foreign Host header gets 421 on every hub route", async () => {
	const hub = await hubFor("host-hub");
	const evil = "evil.example";
	assert.equal(await hostRequest(`${hub.url}/mcp`, evil), 421);
	assert.equal(await hostRequest(`${hub.url}/.well-known/oauth-protected-resource/mcp`, evil), 421);
	assert.equal(await hostRequest(`${hub.url}/link/enroll`, evil, { method: "POST" }), 421);
	assert.equal(await hostRequest(`${hub.url}/`, evil), 421);
	assert.equal(await wsStatus(`${hub.url.replace("http", "ws")}/link`, { host: evil }), 421);
	assert.equal(await hostRequest(`${hub.url}/`, `127.0.0.1:${hub.port}`), 200);
});

// ---------- hub setup, link and the services ----------

const serviceTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;

function stubbed(name) {
	const m = machine(root, name);
	const bin = join(root, name, "bin");
	const log = join(root, name, "calls.log");
	mkdirSync(bin, { recursive: true });
	for (const tool of ["launchctl", "systemctl"]) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${log}\n${tool === "launchctl" ? 'case "$1" in\nprint) exit 1 ;;\nesac\n' : ""}`);
		chmodSync(join(bin, tool), 0o755);
	}
	const launcher = join(m.env.HOME, ".config", "tabkyra", "tabkyra");
	mkdirSync(dirname(launcher), { recursive: true });
	writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
	chmodSync(launcher, 0o755);
	m.env.PATH = `${bin}:${dirname(process.execPath)}`;
	return { ...m, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []), launcher };
}

const serviceFile = (m, label, unit) => (process.platform === "darwin" ? join(m.env.HOME, "Library", "LaunchAgents", `${label}.plist`) : join(m.env.HOME, ".config", "systemd", "user", unit));

test("hub setup writes a private hub.json, shows the passcode once and refuses next to a remote route", () => {
	const m = machine(root, "setup-plain");
	const first = m.json(["hub", "setup", "--public-url", "https://tabkyra.example.com", "--port", "9411", "--no-service", "--json"]);
	assert.equal(first.connectorUrl, "https://tabkyra.example.com/mcp");
	assert.match(first.passcode, /^([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}$/);
	assert.deepEqual(readJson(m.file("hub.json")), { publicUrl: "https://tabkyra.example.com", port: 9411 });
	assert.equal(statSync(m.file("hub.json")).mode & 0o777, 0o600);
	assert.ok(!readFileSync(m.file("oauth.json"), "utf8").includes(first.passcode), "the passcode is stored hashed");
	const second = m.json(["hub", "setup", "--public-url", "https://tabkyra.example.com", "--no-service", "--json"]);
	assert.equal(second.passcode, undefined, "an existing passcode isn't replaced or shown again");
	assert.equal(second.port, 9411, "the saved port is kept");
	assert.equal(m.run(["hub", "setup", "--no-service"]).code, 2, "--public-url is required");
	assert.equal(m.run(["hub", "setup", "--public-url", "https://x.example/path", "--no-service"]).code, 2);
	// An install has one public route.
	assert.equal(m.run(["remote", "setup", "--public-url", "https://other.example.com", "--no-service"]).code, 1);
	assert.match(m.run(["remote", "setup", "--public-url", "https://other.example.com", "--no-service"]).out, /set up as a hub/);
	const off = m.run(["hub", "off"]);
	assert.equal(off.code, 0, off.out);
	assert.equal(existsSync(m.file("hub.json")), false);
	assert.ok(existsSync(m.file("oauth.json")), "off keeps oauth state");
});

test("hub setup refuses while remote.json exists, and changes nothing", () => {
	const m = machine(root, "setup-remote");
	mkdirSync(m.config, { recursive: true });
	writeJson(m.file("remote.json"), { publicUrl: "https://a.example.com", port: 8787, route: "custom" });
	const r = m.run(["hub", "setup", "--public-url", "https://hub.example.com", "--no-service"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /already has a public route/);
	assert.equal(existsSync(m.file("hub.json")), false);
	assert.equal(existsSync(m.file("oauth.json")), false);
});

serviceTest("hub setup installs com.tabkyra.hub / tabkyra-hub.service running hub serve; link installs and removes its own", async () => {
	const m = stubbed("setup-service");
	const port = await freePort();
	const publicUrl = "https://hub.example.com";
	// Stand in for the hub that the service would start.
	const fake = createHttpServer((req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ resource: `${publicUrl}/mcp` }));
	});
	await new Promise((resolve) => fake.listen(port, "127.0.0.1", resolve));
	cleanup.push(() => fake.close());
	const run = (args) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [cli, ...args], { env: m.env });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (out += d));
			child.on("close", (code) => resolve({ code, out }));
		});
	const done = await run(["hub", "setup", "--public-url", publicUrl, "--port", String(port)]);
	assert.equal(done.code, 0, done.out);
	const unit = readFileSync(serviceFile(m, "com.tabkyra.hub", "tabkyra-hub.service"), "utf8");
	if (process.platform === "linux") {
		assert.ok(unit.split("\n").includes(`ExecStart=${m.launcher} hub serve`), unit);
		assert.deepEqual(m.calls(), ["systemctl --user daemon-reload", "systemctl --user enable tabkyra-hub.service", "systemctl --user restart tabkyra-hub.service"]);
	} else {
		assert.ok(unit.includes(`<string>${m.launcher}</string>\n\t\t<string>hub</string>\n\t\t<string>serve</string>`), unit);
		assert.ok(unit.includes("<string>com.tabkyra.hub</string>"));
	}
	const off = await run(["hub", "off"]);
	assert.equal(off.code, 0, off.out);
	assert.equal(existsSync(serviceFile(m, "com.tabkyra.hub", "tabkyra-hub.service")), false);
	assert.equal(existsSync(m.file("hub.json")), false);

	// link: a hub that really answers /link/enroll.
	const hub = await hubFor("link-service-hub");
	const code = hub.json(["hub", "code", "--json"]).code;
	const l = await run(["link", hub.url, "--code", code, "--name", "laptop", "--scope", "browser.read,skills.read"]);
	assert.equal(l.code, 0, l.out);
	const linkUnit = readFileSync(serviceFile(m, "com.tabkyra.link", "tabkyra-link.service"), "utf8");
	assert.ok(process.platform === "linux" ? linkUnit.split("\n").includes(`ExecStart=${m.launcher} link run`) : linkUnit.includes("<string>link</string>\n\t\t<string>run</string>"), linkUnit);
	const link = readJson(m.file("link.json"));
	assert.deepEqual([link.hubUrl, link.name, link.manage, link.scopes], [hub.url, "laptop", false, ["browser.read", "skills.read"]]);
	assert.equal(statSync(m.file("link.json")).mode & 0o777, 0o600);
	assert.equal((await run(["link", hub.url, "--code", code])).code, 1, "linking twice is refused");
	const off2 = await run(["link", "off"]);
	assert.equal(off2.code, 0, off2.out);
	assert.equal(existsSync(m.file("link.json")), false);
	assert.equal(existsSync(serviceFile(m, "com.tabkyra.link", "tabkyra-link.service")), false);
});

test("link refuses a hub URL that isn't https (except loopback), a bad scope and a missing code", async () => {
	const m = machine(root, "link-args");
	assert.equal(m.run(["link", "http://hub.example.com", "--code", "TK-AAAA-BBBB", "--no-service"]).code, 2);
	assert.equal(m.run(["link", "https://hub.example.com", "--no-service"]).code, 2, "--code is required");
	assert.equal(m.run(["link", "https://hub.example.com", "--code", "TK-AAAA-BBBB", "--scope", "browser.*", "--no-service"]).code, 1, "no wildcard scope");
	assert.equal(existsSync(m.file("link.json")), false);
	assert.equal(m.run(["link", "busy", "on"]).code, 1, "busy needs a link");
});

test("the link token is minted by link run with the device's cap, kind link, hashed, and revoked on exit", async () => {
	const hub = await hubFor("token-hub");
	const d = await deviceFor(hub, "tok", { scope: "browser.read,skills.read" });
	const tokens = readJson(d.file("tokens.json")).tokens.filter((t) => t.kind === "link");
	assert.equal(tokens.length, 1);
	assert.deepEqual(tokens[0].scopes, ["browser.read", "skills.read"]);
	assert.match(tokens[0].sha256, /^[0-9a-f]{64}$/);
	assert.ok(!readFileSync(d.file("link.json"), "utf8").includes("tkr_"), "the link token's secret isn't on disk");
	d.kill("SIGTERM");
	await sleep(1500);
	assert.ok(readJson(d.file("tokens.json")).tokens.filter((t) => t.kind === "link").every((t) => t.revokedAt), "revoked when link run stops");
});
