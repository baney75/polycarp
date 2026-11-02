// Review round 1 of the hub (PR #104): long streams, cancels, frame size, limiter, request slots,
// session cleanup on reconnect, GET stream budget, the link pid lock, routing by cap and scope.
// Real processes as in hub-link.test.mjs; a fake device (a WebSocket client with a real credential)
// where the test must control exactly what the device says.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { addDevice, cli, connect, createToken, DEFAULT_CAP, fakeDevice as makeFake, INITIALIZE, rawTools, readJson, rmSync, rpc, sleep, startHub, tempRoot, writeJson } from "./helpers/hub-fixture.mjs";

const root = tempRoot("tabkyra-hublimits-");
const cleanup = [];
after(() => {
	for (const stop of cleanup) {
		try {
			stop();
		} catch {
			/* already gone */
		}
	}
	rmSync(root, { recursive: true, force: true });
});

async function hubFor(name, options) {
	const hub = await startHub(root, name, options);
	cleanup.push(() => hub.stop());
	return hub;
}
async function deviceFor(hub, name, options) {
	const device = await addDevice(root, hub, name, options);
	cleanup.push(() => device.kill());
	return device;
}

const fakeDevice = async (hub, name, options) => {
	const fake = await makeFake(hub, name, options);
	cleanup.push(() => fake.ws.terminate());
	return fake;
};
const toolsOf = (hub, ...scopes) => {
	const table = hub.json(["token", "scopes", "--json"]);
	return [...new Set(scopes.flatMap((x) => table[x].tools))].sort();
};
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };

async function waitFor(check, what, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await check();
		if (v) return v;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ---------- first-F1, sonnet-F1, sol-F2: the timeout is for the head only; abandoned requests are cancelled ----------

test("a stream outlives the head timeout, and the device's count returns to zero when the client closes", async () => {
	const hub = await hubFor("stream-hub", { env: { TABKYRA_HUB_HEAD_TIMEOUT_MS: "1000" } });
	const dev = await deviceFor(hub, "alpha");
	const secret = createToken(hub, "caller", "skills.read");
	const init = await rpc(`${hub.url}/mcp`, secret, INITIALIZE);
	const sessionId = init.headers.get("mcp-session-id");
	const abort = new AbortController();
	const res = await fetch(`${hub.url}/mcp`, { headers: { accept: "text/event-stream", authorization: `Bearer ${secret}`, "mcp-session-id": sessionId }, signal: abort.signal });
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type"), /text\/event-stream/);
	const reader = res.body.getReader();
	const pending = reader.read().then((r) => (r.done ? "ended" : "data"));
	await dev.waitLive((l) => l.streams === 1, "the device to hold the stream");
	// Three times the head timeout later the stream is still open on both sides.
	assert.equal(await Promise.race([pending, sleep(3000).then(() => "open")]), "open", "the hub did not cut a stream after its head arrived");
	assert.equal(dev.live().streams, 1);
	assert.equal((await rpc(`${hub.url}/mcp`, secret, LIST, { "mcp-session-id": sessionId })).status, 200, "the session still works beside its stream");
	abort.abort();
	await dev.waitLive((l) => l.streams === 0 && l.requests === 0, "the device to drop the cancelled stream");
});
test("when a device never answers, the hub gives up with 504 and cancels the request on the device", async () => {
	const hub = await hubFor("cancel-hub", { env: { TABKYRA_HUB_HEAD_TIMEOUT_MS: "1000" } });
	const fake = await fakeDevice(hub, "mute");
	const secret = createToken(hub, "caller", "skills.read");
	const res = await rpc(`${hub.url}/mcp`, secret, INITIALIZE);
	assert.equal(res.status, 504);
	const [req] = fake.reqs();
	await waitFor(() => fake.frames.some((f) => f.t === "cancel" && f.id === req.id), "a cancel frame for the abandoned request");
});

// ---------- sol-F1, sonnet-F3: frame size ----------

test("a backslash-heavy body is forwarded, and one too big to frame gets 413 without closing the link", async () => {
	const hub = await hubFor("frame-hub");
	const dev = await deviceFor(hub, "alpha");
	const secret = createToken(hub, "caller", "skills.read");
	const opened = await rawTools(`${hub.url}/mcp`, secret);
	const call = (task, id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "skill_match", arguments: { task } } });
	// 1.9M backslashes: a body near 3.8 MB whose frame is about twice that. This used to exceed the 4 MB frame limit and drop the device.
	const heavy = await rpc(`${hub.url}/mcp`, secret, call("\\".repeat(1_900_000), 3), { "mcp-session-id": opened.sessionId });
	assert.notEqual(heavy.status, 413);
	assert.ok(heavy.status < 500, `the device answered (${heavy.status})`);
	assert.equal(hub.devices().alpha.online, true, "the link survived");
	// Raw control characters escape to six bytes each: 3 MB of them cannot fit a frame.
	const huge = await fetch(`${hub.url}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}`, "mcp-session-id": opened.sessionId },
		body: `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"skill_match","arguments":{"task":"${"\u0001".repeat(3_000_000)}"}}}`,
	});
	assert.equal(huge.status, 413);
	assert.equal(hub.devices().alpha.online, true, "a refused request does not close the link");
	assert.equal(dev.live().connected, true);
	const again = await rpc(`${hub.url}/mcp`, secret, LIST, { "mcp-session-id": opened.sessionId });
	assert.equal(again.status, 200, "the session and the link are intact");
});

// ---------- first-F2, sonnet-F2: a valid credential is never refused by other people's failures ----------

test("a valid device and manager still get in after forged sources push the failure count past any cap", async () => {
	const hub = await hubFor("limiter-hub");
	const boss = await deviceFor(hub, "boss", { manage: true });
	const link = readJson(boss.file("link.json"));
	const credential = `${link.deviceId}.${link.secret}`;
	for (let i = 0; i < 400; i++) {
		const r = await fetch(`${hub.url}/link/code`, { method: "POST", headers: { "x-forwarded-for": `10.1.${i >> 8}.${i & 255}`, authorization: "Bearer dv-000000000000.nope", "content-type": "application/json" }, body: "{}" });
		assert.equal(r.status, 401, "each forged source gets its own allowance");
	}
	// One source past its own allowance is throttled...
	let last = 0;
	for (let i = 0; i < 40; i++) last = (await fetch(`${hub.url}/link/code`, { method: "POST", headers: { "x-forwarded-for": "10.9.9.9", authorization: "Bearer dv-000000000000.nope" }, body: "{}" })).status;
	assert.equal(last, 429);
	// ...but a valid credential from that same source, or any, goes through.
	const ok = await fetch(`${hub.url}/link/code`, { method: "POST", headers: { "x-forwarded-for": "10.9.9.9", authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "connect" }) });
	assert.equal(ok.status, 200);
	// The device's link reconnecting is an upgrade with the credential.
	const status = await new Promise((resolve) => {
		const ws = new WebSocket(`${hub.url.replace("http", "ws")}/link`, { headers: { authorization: `Bearer ${credential}`, "x-forwarded-for": "10.9.9.9" } });
		ws.on("open", () => {
			resolve(101);
			ws.terminate();
		});
		ws.on("unexpected-response", (_r, res) => {
			resolve(res.statusCode);
			ws.terminate();
		});
		ws.on("error", () => undefined);
	});
	assert.equal(status, 101, "a valid credential is never refused by the failure limiter");
});

// ---------- sol-F3: request slots are reserved before the body ----------

test("more than 32 POSTs waiting on their bodies are refused at once, and the slots come back", async () => {
	const hub = await hubFor("slots-hub");
	await deviceFor(hub, "alpha");
	const secret = createToken(hub, "caller", "skills.read");
	const opened = await rawTools(`${hub.url}/mcp`, secret);
	const url = new URL(`${hub.url}/mcp`);
	const reqs = [];
	const statuses = [];
	for (let i = 0; i < 40; i++) {
		const req = httpRequest({ host: url.hostname, port: url.port, path: "/mcp", method: "POST", agent: false, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}`, "mcp-session-id": opened.sessionId, "content-length": "500" } });
		req.on("response", (res) => {
			statuses.push(res.statusCode);
			res.resume();
		});
		req.on("error", () => undefined);
		req.flushHeaders();
		reqs.push(req);
		await sleep(10);
	}
	await sleep(500);
	assert.ok(statuses.filter((x) => x === 429).length >= 8, `the slots held while bodies were pending refused the extras: ${statuses.join(",")}`);
	for (const req of reqs) req.destroy();
	await sleep(500);
	const after = await rpc(`${hub.url}/mcp`, secret, LIST, { "mcp-session-id": opened.sessionId });
	assert.equal(after.status, 200, "abandoned bodies give their slots back");
});

// ---------- sol-F4, second-F4: a reconnect closes the sessions of the old connection ----------

test("after the link's WebSocket dies and reconnects the device holds no stale sessions, and 24 new sessions fit", async () => {
	const first = await hubFor("reconnect-hub");
	const dev = await deviceFor(first, "alpha");
	const tokens = ["t1", "t2", "t3"].map((n) => createToken(first, n, "skills.read"));
	const fill = async (hub) => {
		for (const secret of tokens) for (let i = 0; i < 8; i++) assert.equal((await rpc(`${hub.url}/mcp`, secret, INITIALIZE)).status, 200);
	};
	await fill(first);
	await first.waitDevices((d) => d.alpha.sessions === 24, "24 sessions on the device");
	assert.equal((await rpc(`${first.url}/mcp`, tokens[0], INITIALIZE)).status, 429, "full: the device is at its session cap (the hub skips it)");
	// Only the WebSocket dies: the hub process goes, the device's link run stays.
	first.proc.kill("SIGKILL");
	await sleep(300);
	const second = await hubFor("reconnect-hub", { port: first.port });
	await second.waitDevices((d) => d.alpha.online, "the device to reconnect");
	await dev.waitLive((l) => l.connected && l.sessions === 0, "the device to have closed the old sessions");
	assert.equal(second.devices().alpha.sessions, 0);
	await fill(second);
	await second.waitDevices((d) => d.alpha.sessions === 24, "24 new sessions after the reconnect");
});

// ---------- second-F6: GET streams have their own budget ----------

test("24 clients holding their GET streams can each still make a tool call, and a second stream on a session is refused", async () => {
	const hub = await hubFor("streams-hub");
	const dev = await deviceFor(hub, "alpha");
	const tokens = ["a", "b", "c"].map((n) => createToken(hub, n, "skills.read"));
	const clients = [];
	try {
		for (const secret of tokens) for (let i = 0; i < 8; i++) clients.push(await connect(`${hub.url}/mcp`, secret));
		await dev.waitLive((l) => l.streams >= 20, "the clients' GET streams to be open on the device");
		const results = await Promise.all(clients.map((c) => c.client.callTool({ name: "skill_match", arguments: { task: "background check on a roofing contractor" } })));
		for (const r of results) assert.notEqual(r.isError, true, JSON.stringify(r));
		// One stream per session: a second GET on a session that has one is a conflict.
		const sid = clients[0].transport.sessionId;
		const dupe = await fetch(`${hub.url}/mcp`, { headers: { accept: "text/event-stream", authorization: `Bearer ${tokens[0]}`, "mcp-session-id": sid } });
		assert.equal(dupe.status, 409);
		await dupe.body?.cancel();
	} finally {
		await Promise.allSettled(clients.map((c) => c.client.close()));
	}
});

// ---------- second-F5, second-F8: the link pid lock and the link token ----------

test("a second link run refuses, leaves the first one working, and a stale pid file doesn't block a restart", async () => {
	const hub = await hubFor("pid-hub");
	const dev = await deviceFor(hub, "alpha");
	const secret = createToken(hub, "caller", "skills.read");
	const second = spawn(process.execPath, [cli, "link", "run"], { env: dev.env });
	let out = "";
	second.stdout.on("data", (d) => (out += d));
	second.stderr.on("data", (d) => (out += d));
	const code = await new Promise((resolve) => second.on("exit", resolve));
	assert.equal(code, 1);
	assert.match(out, /Another tabkyra link run is already running on this device \(pid \d+\)/);
	assert.equal((await rawTools(`${hub.url}/mcp`, secret)).status, 200, "the first run still answers through the hub");
	// A crash leaves link.pid behind; its pid is dead, so the next run takes over.
	const exited = new Promise((resolve) => dev.proc.once("exit", resolve));
	dev.kill("SIGKILL");
	await exited;
	await hub.waitDevices((d) => !d.alpha.online, "the killed run to drop");
	const again = spawn(process.execPath, [cli, "link", "run"], { env: dev.env });
	cleanup.push(() => again.kill());
	await hub.waitDevices((d) => d.alpha.online, "the restarted run to link");
	assert.equal((await rawTools(`${hub.url}/mcp`, secret)).status, 200);
});

test("an ordinary token named link doesn't block link run, old link records are pruned, and the name is reserved", async () => {
	const hub = await hubFor("name-hub");
	const dev = await deviceFor(hub, "alpha", {
		beforeRun: (m) => {
			createToken(m, "link", "browser.read");
			const file = m.file("tokens.json");
			const data = readJson(file);
			for (let i = 0; i < 3; i++) data.tokens.push({ id: `0000000${i}`, name: "link:run", scopes: ["browser.read"], sha256: "00".repeat(32), createdAt: new Date().toISOString(), revokedAt: new Date().toISOString(), kind: "link" });
			writeJson(file, data);
		},
	});
	const tokens = readJson(dev.file("tokens.json")).tokens;
	assert.equal(tokens.filter((t) => t.kind === "link").length, 1, "revoked link records from earlier runs are gone");
	assert.ok(tokens.some((t) => t.name === "link" && !t.revokedAt && !t.kind), "the owner's own token named link is untouched");
	assert.equal(dev.run(["token", "create", "link:run", "--scope", "browser.read"]).code, 2, "ordinary tokens can't take the link token's name");
	assert.equal(dev.live().connected, true);
});

// ---------- first-F3, second-F9: routing knows each device's session cap and scope cap ----------

test("a device at its own session cap is skipped for a new session", async () => {
	const hub = await hubFor("cap-hub");
	const small = await fakeDevice(hub, "small", { sessionCap: 1, answer: true });
	const roomy = await fakeDevice(hub, "roomy", { sessionCap: 3, busy: true, answer: true });
	const secret = createToken(hub, "caller", "skills.read");
	assert.equal((await rpc(`${hub.url}/mcp`, secret, INITIALIZE)).status, 200);
	assert.equal(small.reqs().length, 1, "the not-busy device takes the first");
	assert.equal((await rpc(`${hub.url}/mcp`, secret, INITIALIZE)).status, 200);
	assert.equal(small.reqs().length, 1, "at its cap of 1, it is skipped, though it is not busy and the other is");
	assert.equal(roomy.reqs().length, 1);
	assert.equal((await rpc(`${hub.url}/mcp`, secret, INITIALIZE)).status, 200);
	assert.equal(roomy.reqs().length, 2);
	assert.equal((await rpc(`${hub.url}/mcp`, secret, INITIALIZE)).status, 200);
	assert.equal(roomy.reqs().length, 3);
	const full = await rpc(`${hub.url}/mcp`, secret, INITIALIZE);
	assert.equal(full.status, 429, "every device at its limit: an accurate answer, not a forward");
	assert.match(full.json.error.message, /at its limit/);
});

test("routing prefers a device that grants all the caller's scopes and skips ones that grant none", async () => {
	const hub = await hubFor("scopes-hub");
	await deviceFor(hub, "plain");
	await deviceFor(hub, "capable", { scope: "browser.read,browser.script,skills.read" });
	assert.equal(hub.run(["hub", "prefer", "plain,capable"]).code, 0);
	const url = `${hub.url}/mcp`;
	// A caller whose only grant is browser.script: the plain device would answer 403; the capable one serves.
	const script = await rawTools(url, createToken(hub, "script", "browser.script"));
	assert.equal(script.status, 200);
	assert.deepEqual(script.tools, toolsOf(hub, "browser.script"));
	// Read and script: the plain device is preferred and less loaded, but only the capable one grants run_js.
	const both = await rawTools(url, createToken(hub, "both", "browser.read,browser.script"));
	assert.deepEqual(both.tools, toolsOf(hub, "browser.read", "browser.script"));
	assert.ok(both.tools.includes("run_js"));
	// Nobody grants threads.read: a clear 403 naming what the devices allow, not a 503.
	const nobody = await rpc(url, createToken(hub, "nobody", "threads.read"), INITIALIZE);
	assert.equal(nobody.status, 403);
	assert.match(nobody.json.error.message, /plain: .*capable: /);
});

// ---------- second-F7: a held lock doesn't take the hub down ----------

test("a held hub-devices.json lock while a device connects doesn't crash the hub", async () => {
	const hub = await hubFor("lock-hub");
	const dev = await deviceFor(hub, "alpha", { beforeRun: () => writeFileSync(hub.file("hub-devices.json.lock"), "held") });
	assert.equal(hub.proc.exitCode, null, "the hub is still running");
	assert.equal(hub.devices().alpha.online, true);
	rmSync(hub.file("hub-devices.json.lock"), { force: true });
	const secret = createToken(hub, "caller", "skills.read");
	assert.equal((await rawTools(`${hub.url}/mcp`, secret)).status, 200);
	assert.equal(dev.live().connected, true);
});
