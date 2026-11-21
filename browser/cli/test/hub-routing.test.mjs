// Per-call device routing behind a hub (`device` on any tool): the call lands on the named device only, through a
// secondary session the hub opens there with the caller's own scopes, and every refusal is a tool result that says
// nothing was sent. Real processes (hub serve, link run) and fake devices (a WebSocket with a real credential) as in
// hub-link.test.mjs; a fake device's frames show exactly what reached it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { addDevice, connect, createToken, fakeDevice, INITIALIZE, rawTools, rpc, sleep, startHub, teardown, tempRoot } from "./helpers/hub-fixture.mjs";

const root = tempRoot("tabkyra-hubrouting-");
const cleanup = [];
after(() => teardown(cleanup, root));

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
async function waitFor(check, what, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await check();
		if (v) return v;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/**
 * A fake device that answers like a real one: initialize makes a session, a notification gets 202, tools/call answers
 * "<device>:<tool>:<arguments>", DELETE ends the session. `hang` names a tool it never answers.
 */
async function answering(hub, name, { hang, ...options } = {}) {
	const sessions = new Set();
	const fake = await fakeDevice(hub, name, {
		...options,
		onReq: (frame, ws) => {
			const send = (f) => ws.send(JSON.stringify(f));
			const reply = (status, headers, body) => {
				send({ t: "head", id: frame.id, status, headers });
				if (body !== undefined) send({ t: "chunk", id: frame.id, data: JSON.stringify(body) });
				send({ t: "end", id: frame.id });
			};
			const sid = frame.headers["mcp-session-id"];
			if (frame.method === "DELETE") {
				sessions.delete(sid);
				return reply(200, {});
			}
			const msg = JSON.parse(frame.body);
			if (msg.method === "initialize") {
				const id = randomUUID();
				sessions.add(id);
				return reply(200, { "content-type": "application/json", "mcp-session-id": id }, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "polycarp", version: "9.9.9" } } });
			}
			if (sid && !sessions.has(sid)) return reply(404, { "content-type": "application/json" }, { jsonrpc: "2.0", error: { code: -32001, message: "Unknown or expired session." }, id: null });
			if (msg.id === undefined) return reply(202, {});
			if (msg.method === "tools/call") {
				if (msg.params.name === hang) return;
				return reply(200, { "content-type": "application/json", "mcp-session-id": sid }, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `${name}:${msg.params.name}:${JSON.stringify(msg.params.arguments)}` }] } });
			}
			return reply(200, { "content-type": "application/json", "mcp-session-id": sid }, { jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
		},
	});
	cleanup.push(() => fake.ws.terminate());
	const bodies = () => fake.reqs().map((f) => ({ method: f.method, sid: f.headers["mcp-session-id"], headers: f.headers, body: f.body ? JSON.parse(f.body) : undefined }));
	return { ...fake, sessions, bodies, inits: () => bodies().filter((b) => b.body?.method === "initialize"), calls: () => bodies().filter((b) => b.body?.method === "tools/call") };
}

/** A raw hub session (initialize and the initialized notification) and a way to call a tool on it. */
async function session(hub, secret) {
	const init = await rpc(`${hub.url}/mcp`, secret, INITIALIZE);
	assert.equal(init.status, 200, init.text);
	const sid = init.headers.get("mcp-session-id");
	await rpc(`${hub.url}/mcp`, secret, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
	let n = 10;
	return {
		sid,
		async call(name, args) {
			const r = await rpc(`${hub.url}/mcp`, secret, { jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });
			return { status: r.status, sessionHeader: r.headers.get("mcp-session-id"), result: r.json?.result, text: r.json?.result?.content?.[0]?.text, raw: r };
		},
		end: () => fetch(`${hub.url}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${secret}`, "mcp-session-id": sid } }),
	};
}

/** A hub with fake devices alpha (the session's device: the others are busy) and beta. */
async function twoFakes(hubName, betaOptions = {}) {
	const hub = await hubFor(hubName);
	const alpha = await answering(hub, "alpha");
	const beta = await answering(hub, "beta", { busy: true, ...betaOptions });
	const secret = createToken(hub, "caller", "skills.read,browser.read,browser.navigate");
	const s = await session(hub, secret);
	assert.equal(alpha.inits().length, 1, "the session opened on alpha");
	assert.equal(beta.reqs().length, 0);
	return { hub, alpha, beta, secret, s };
}

test("a call with device=beta lands on beta only, with device stripped, in one secondary session for many calls", async () => {
	const { alpha, beta, s } = await twoFakes("route-hub");
	const alphaBefore = alpha.reqs().length;
	const first = await s.call("skill_match", { task: "x", device: "beta" });
	assert.equal(first.status, 200);
	assert.equal(first.text, 'beta:skill_match:{"task":"x"}', "beta answered, and device was stripped before it");
	assert.equal(first.sessionHeader, s.sid, "the client sees its own hub session id, never beta's");
	for (let i = 0; i < 4; i++) assert.equal((await s.call("skill_match", { task: `y${i}`, device: "beta" })).text, `beta:skill_match:{"task":"y${i}"}`);
	// By id, and in another case, it is the same device.
	assert.match((await s.call("skill_match", { task: "z", device: beta.name.toUpperCase() })).text, /^beta:/);
	assert.equal(alpha.reqs().length, alphaBefore, "alpha received nothing for calls meant for beta");
	assert.equal(beta.inits().length, 1, "every call reused one secondary session");
	assert.equal(beta.calls().length, 6);
	const betaSid = beta.inits().length && [...beta.sessions][0];
	assert.ok(beta.calls().every((c) => c.sid === betaSid && !("device" in c.body.params.arguments)));
	assert.ok(beta.bodies().some((b) => b.body?.method === "notifications/initialized" && b.sid === betaSid), "the secondary session was initialized like a client would");
	// Naming the session's own device, or none, goes to alpha as before.
	assert.equal((await s.call("skill_match", { task: "w" })).text, 'alpha:skill_match:{"task":"w"}');
	assert.equal((await s.call("skill_match", { task: "v", device: "alpha" })).text, 'alpha:skill_match:{"task":"v","device":"alpha"}', "alpha checks a call that names it itself");
	assert.equal(beta.calls().length, 6);
});

test("parallel first calls to one device open one secondary session", async () => {
	const { beta, s } = await twoFakes("parallel-hub");
	const results = await Promise.all([1, 2, 3, 4].map((i) => s.call("skill_match", { task: `p${i}`, device: "beta" })));
	assert.deepEqual(results.map((r) => r.text).sort(), [1, 2, 3, 4].map((i) => `beta:skill_match:{"task":"p${i}"}`));
	assert.equal(beta.inits().length, 1);
});

test("the secondary session carries the caller's own scopes, never the bound device's", async () => {
	// alpha allows more than the caller holds; beta allows less. Neither widens the other.
	const { beta, s } = await twoFakes("scope-hub", { scopes: ["skills.read", "browser.read"] });
	await s.call("skill_match", { task: "x", device: "beta" });
	const init = beta.inits()[0];
	assert.deepEqual(init.headers["x-polycarp-hub-scopes"].split(",").sort(), ["browser.navigate", "browser.read", "skills.read"], "the caller's scopes, for beta to narrow by its own cap");
	assert.equal(init.headers["x-tabkyra-hub-scopes"], init.headers["x-polycarp-hub-scopes"], "and under the old name, for a device from before the rename");
	assert.equal(init.headers["x-polycarp-hub-caller"], "caller");
	assert.equal(init.sid, undefined, "a new session, not alpha's");
});

test("beta's cap applies: a tool it doesn't allow is refused at the hub with the exact words, and nothing is sent", async () => {
	const { beta, s } = await twoFakes("cap-hub", { scopes: ["skills.read", "browser.read"] });
	const r = await s.call("navigate", { url: "https://example.com", device: "beta" });
	assert.equal(r.status, 200, "a tool result, not an HTTP failure");
	assert.equal(r.result.isError, true);
	assert.equal(r.text, "beta doesn't allow browser.navigate (allows: skills.read, browser.read). Only its owner can add it, on beta.");
	assert.equal(beta.reqs().length, 0, "nothing reached beta");
});

test("a tool outside the caller's own scopes is refused on any device", async () => {
	const { beta, s } = await twoFakes("caller-scope-hub", { scopes: ["skills.read", "browser.read", "browser.act"] });
	const r = await s.call("click", { ref: "e1", device: "beta" });
	assert.equal(r.result.isError, true);
	assert.equal(r.text, "This connection doesn't allow browser.act, so click can't run on any device through it.");
	assert.equal(beta.reqs().length, 0);
});

test("an unknown device and an offline one are tool errors that send nothing", async () => {
	const { hub, alpha, beta, s } = await twoFakes("miss-hub");
	const before = alpha.reqs().length;
	const unknown = await s.call("skill_match", { task: "x", device: "Chapel9" });
	assert.equal(unknown.status, 200);
	assert.equal(unknown.result.isError, true);
	assert.equal(unknown.text, 'No device called "Chapel9". Devices: alpha, beta.');
	beta.ws.terminate();
	await hub.waitDevices((d) => !d.beta.online, "beta to go offline");
	const offline = await s.call("skill_match", { task: "x", device: "beta" });
	assert.equal(offline.result.isError, true);
	assert.match(offline.text, /^beta is offline \(last seen \d{4}-\d\d-\d\d \d\d:\d\d\)\. Nothing was sent\. Online now: alpha\.$/);
	assert.equal(alpha.reqs().length, before, "neither miss reached alpha");
	assert.equal(beta.reqs().length, 0);
});

test("a device that drops mid-call answers with the may-have-landed words, as a tool result", async () => {
	const { beta, s } = await twoFakes("drop-hub", { hang: "navigate" });
	const pending = s.call("navigate", { url: "https://example.com", device: "beta" });
	await waitFor(() => beta.calls().length === 1, "the call to reach beta");
	beta.ws.terminate();
	const r = await pending;
	assert.equal(r.status, 200);
	assert.equal(r.result.isError, true);
	assert.equal(r.text, "beta went offline while this call ran. The action may have landed: read it back before you repeat it.");
});

test("ending the hub session closes its secondary sessions", async () => {
	const { beta, s } = await twoFakes("close-hub");
	await s.call("skill_match", { task: "x", device: "beta" });
	const betaSid = [...beta.sessions][0];
	assert.ok(betaSid);
	const res = await s.end();
	assert.equal(res.status, 200);
	await waitFor(() => beta.bodies().some((b) => b.method === "DELETE" && b.sid === betaSid), "beta to get a DELETE for the secondary session");
	assert.equal(beta.sessions.size, 0);
});

test("real devices: a call routed to a narrower device gets its cap error, an allowed one runs there, and a misrouted call is refused", async () => {
	const hub = await hubFor("real-hub");
	await deviceFor(hub, "alpha");
	const beta = await deviceFor(hub, "beta", { scope: "browser.read,skills.read" });
	assert.equal(beta.run(["link", "busy", "on"]).code, 0);
	await hub.waitDevices((d) => d.beta.busy, "beta to report busy");
	const secret = createToken(hub, "caller", "skills.read,browser.read,browser.act");
	const { client } = await connect(`${hub.url}/mcp`, secret);
	cleanup.push(() => client.close());
	await hub.waitDevices((d) => d.alpha.sessions === 1, "the session on alpha");
	const { tools } = await client.listTools();
	const click = tools.find((t) => t.name === "click");
	assert.equal(click.inputSchema.properties.device.type, "string", "behind a hub every tool takes device");
	assert.ok(!tools.find((t) => t.name === "devices").inputSchema.properties?.device, "except devices itself");

	const cap = await client.callTool({ name: "click", arguments: { ref: "e1", device: "beta" } });
	assert.equal(cap.isError, true);
	assert.equal(cap.content[0].text, "beta doesn't allow browser.act (allows: browser.read, skills.read). Only its owner can add it, on beta.");
	await sleep(300);
	assert.equal(hub.devices().beta.sessions, 0, "the cap error opened nothing on beta");

	const ran = await client.callTool({ name: "skill_match", arguments: { task: "background check on a roofing contractor", device: "beta" } });
	assert.match(ran.content[0].text, /^osint /, "the call ran on beta");
	await hub.waitDevices((d) => d.beta.sessions === 1 && d.alpha.sessions === 1, "a secondary session on beta");

	// A batch isn't routed: it reaches alpha whole, and alpha refuses the call that names another device.
	const sid = (await rawTools(`${hub.url}/mcp`, secret)).sessionId;
	const batch = await rpc(`${hub.url}/mcp`, secret, [{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "skill_match", arguments: { task: "x", device: "beta" } } }], { "mcp-session-id": sid });
	const answer = Array.isArray(batch.json) ? batch.json[0] : batch.json;
	assert.equal(answer.result.isError, true, batch.text);
	assert.equal(answer.result.content[0].text, "This call names beta, but it reached alpha. Nothing was done. Call devices for the names, then try again.");
	const self = await rpc(`${hub.url}/mcp`, secret, [{ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "skill_match", arguments: { task: "background check on a roofing contractor", device: hub.devices().alpha.id } } }], { "mcp-session-id": sid });
	const selfAnswer = Array.isArray(self.json) ? self.json[0] : self.json;
	assert.match(selfAnswer.result.content[0].text, /^osint /, "a call naming the device it reached runs");
});
