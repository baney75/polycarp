// Device addressing behind a hub: the roster the hub sends its devices, and the devices tool that answers from it.
// Real processes (hub serve, link run) and fake devices (a WebSocket with a real credential) as in hub-link.test.mjs.
// Run with --experimental-strip-types: it imports src/link-protocol.ts for the frame parsers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { parseDeviceFrame, parseHubFrame } from "../src/link-protocol.ts";
import { oldParseHubFrame } from "./helpers/old-hub-frame-parser.mjs";
import { addDevice, cli, connect, createToken, DEFAULT_CAP, endProcess, fakeDevice, freePort, machine, rawTools, sleep, startHub, teardown, tempRoot } from "./helpers/hub-fixture.mjs";

const root = tempRoot("tabkyra-hubdevices-");
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
async function fakeFor(hub, name, options) {
	const fake = await fakeDevice(hub, name, options);
	cleanup.push(() => fake.ws.terminate());
	return fake;
}
async function waitFor(check, what, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await check();
		if (last) return last;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}
const PLATFORM = { darwin: "macOS", linux: "Linux", win32: "Windows" }[process.platform] ?? process.platform;

const ROSTER = {
	t: "roster",
	devices: [{ id: "dv-0123456789ab", name: "Mac", online: true, lastSeen: null, scopes: ["browser.read"], computer: true, extension: true, platform: "darwin" }],
};

test("the roster frame parses on a new device, and a device from before it drops it and keeps parsing", () => {
	assert.deepEqual(parseHubFrame(JSON.stringify(ROSTER)), ROSTER);
	// A malformed entry fails the whole frame: a device never acts on half a roster.
	assert.equal(parseHubFrame(JSON.stringify({ t: "roster", devices: [{ ...ROSTER.devices[0], name: "bad\nname" }] })), undefined);
	assert.equal(parseHubFrame(JSON.stringify({ t: "roster", devices: [{ ...ROSTER.devices[0], scopes: "browser.read" }] })), undefined);
	// The old parser required an id on every hub frame, and a roster has none.
	assert.equal(oldParseHubFrame(JSON.stringify(ROSTER)), undefined, "an old device drops the roster");
	const req = { t: "req", id: "r1", method: "POST", path: "/mcp", headers: { "content-type": "application/json" }, body: "{}" };
	assert.deepEqual(oldParseHubFrame(JSON.stringify(req)), req, "and still parses the request after it");
	assert.deepEqual(parseHubFrame(JSON.stringify(req)), req);
});

test("status frames from devices before computer and platform still parse, and a malformed new field is left out", () => {
	const old = { t: "status", extensionConnected: true, sessions: 0, busy: false, version: "1.0.0", browser: null, sessionCap: 24, scopes: ["browser.read"] };
	assert.deepEqual(parseDeviceFrame(JSON.stringify(old)), old);
	assert.deepEqual(parseDeviceFrame(JSON.stringify({ ...old, computer: true, platform: "linux" })), { ...old, computer: true, platform: "linux" });
	assert.deepEqual(parseDeviceFrame(JSON.stringify({ ...old, computer: "yes", platform: "Linux; rm" })), old);
});

test("devices lists every device on the hub with its fields; one that goes offline shows online false and a lastSeen", async () => {
	const hub = await hubFor("devices-hub");
	await deviceFor(hub, "alpha");
	// beta reports the new fields; gamma is a device from before them. Both are busy, so the session lands on alpha (real).
	const beta = await fakeFor(hub, "beta", { busy: true, extensionConnected: false, scopes: ["browser.read", "computer.read"] });
	beta.ws.send(JSON.stringify({ t: "status", extensionConnected: true, sessions: 0, busy: true, version: "9.9.9", browser: null, sessionCap: 24, scopes: ["browser.read", "computer.read"], computer: true, platform: "linux" }));
	const gamma = await fakeFor(hub, "gamma", { busy: true, extensionConnected: false });
	const { client } = await connect(`${hub.url}/mcp`, createToken(hub, "caller", "skills.read"));
	cleanup.push(() => client.close());
	try {
		const tools = (await client.listTools()).tools.map((t) => t.name);
		assert.ok(tools.includes("devices"), "behind a hub every session has the devices tool");
		const description = (await client.listTools()).tools.find((t) => t.name === "devices").description;
		assert.match(description, /before you use device/);
		const list = async () => JSON.parse((await client.callTool({ name: "devices", arguments: {} })).content[0].text);
		const first = await waitFor(async () => {
			const r = await list();
			return r.devices?.length === 3 && r.devices.find((d) => d.name === "beta")?.platform === "Linux" ? r : undefined;
		}, "a roster with all three devices");
		assert.equal(first.thisDevice, "alpha");
		const byName = Object.fromEntries(first.devices.map((d) => [d.name, d]));
		const ids = hub.devices();
		assert.deepEqual(byName.alpha, { name: "alpha", id: ids.alpha.id, thisDevice: true, platform: PLATFORM, online: true, allows: DEFAULT_CAP, browserExtension: false, computerUse: false });
		assert.deepEqual(byName.beta, { name: "beta", id: ids.beta.id, platform: "Linux", online: true, allows: ["browser.read", "computer.read"], browserExtension: true, computerUse: true });
		assert.deepEqual(byName.gamma, { name: "gamma", id: ids.gamma.id, platform: "unknown", online: true, allows: DEFAULT_CAP, browserExtension: false, computerUse: false });
		// The fake devices got the roster too, and nothing in it is a request.
		assert.ok(beta.frames.some((f) => f.t === "roster" && f.devices.length === 3), "every linked device gets the roster");
		assert.equal(beta.reqs().length, 0);

		gamma.ws.terminate();
		const second = await waitFor(async () => {
			const r = await list();
			const g = r.devices.find((d) => d.name === "gamma");
			return g && !g.online ? r : undefined;
		}, "gamma to show offline");
		const g = second.devices.find((d) => d.name === "gamma");
		assert.equal(g.online, false);
		assert.match(g.lastSeen, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
		assert.deepEqual(g.allows, DEFAULT_CAP, "what it allowed when last seen is kept");
		assert.equal(g.browserExtension, false);
	} finally {
		await client.close().catch(() => undefined);
	}
});

test("a serve that isn't behind a hub has no devices tool", async () => {
	const m = machine(root, "plain-serve");
	const secret = createToken(m, "plain", "skills.read");
	const port = await freePort();
	const proc = spawn(process.execPath, [cli, "serve", "--port", String(port)], { env: m.env });
	cleanup.push(() => endProcess(proc));
	await new Promise((resolve, reject) => {
		let out = "";
		proc.stdout.on("data", (d) => {
			out += d;
			if (/MCP over HTTP/.test(out)) resolve();
		});
		proc.on("exit", (c) => reject(new Error(`serve exited ${c}: ${out}`)));
		setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 15_000);
	});
	const plain = await rawTools(`http://127.0.0.1:${port}/mcp`, secret);
	assert.deepEqual(plain.tools, ["skill_match", "skill_read"]);
});
