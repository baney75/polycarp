// Several native hosts at once (two browsers, or a stale host): a request is resent only to the
// browser it started in, and a reconnect doesn't wait on a host whose extension never answers.
// Each fake host's socket is named after a live process (a sleeping child), as real ones are.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "tabkyra-hosts-"));
const dir = join(root, "sock");
mkdirSync(dir, { mode: 0o700 });
const sleepers = [];
/** Every fake host, stopped after each test however it ends. */
const hosts = [];
let BridgeClient;

const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

/**
 * A fake native host: welcomes, answers requests, counts what it got. `helloLateMs`: its
 * extension says hello (and which browser it is) that long after a client connects.
 */
async function host({ browserId, extension = true, dropFirst = [], helloLateMs, refuseFirst = [], slow = {}, welcomeLateMs }) {
	const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
	sleepers.push(sleeper);
	const path = join(dir, `${sleeper.pid}.sock`);
	const got = [];
	let hellos = 0;
	const drop = new Set(dropFirst);
	const refuse = new Set(refuseFirst);
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
				const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
				buf = buf.subarray(4 + buf.readUInt32LE(0));
				if (msg.type === "hello") {
					hellos++;
					if (helloLateMs !== undefined) {
						socket.write(frame({ type: "welcome", clientId: "c", hostVersion: "0", extensionConnected: false }));
						setTimeout(() => !socket.destroyed && socket.write(frame({ type: "extension_status", connected: true, browserId })), helloLateMs);
						continue;
					}
					const welcome = frame({ type: "welcome", clientId: "c", hostVersion: "0", extensionConnected: extension, ...(extension && browserId ? { browserId } : {}) });
					if (welcomeLateMs) setTimeout(() => !socket.destroyed && socket.write(welcome), welcomeLateMs);
					else socket.write(welcome);
					continue;
				}
				got.push(msg.method);
				if (refuse.delete(msg.method)) {
					// An update installing: refused, never run; then the host goes away, as a stopping one does.
					socket.write(frame({ type: "response", id: msg.id, error: { code: "not_sent", message: "the bridge is restarting" } }));
					setTimeout(() => void h.stop(), 100);
					return;
				}
				if (slow[msg.method]) {
					const id = msg.id;
					setTimeout(() => !socket.destroyed && socket.write(frame({ type: "response", id, result: { from: browserId } })), slow[msg.method]);
					continue;
				}
				if (drop.delete(msg.method)) {
					// Cut off, and gone: the socket file and process vanish with it (a reload).
					void h.stop();
					return;
				}
				socket.write(frame({ type: "response", id: msg.id, result: { from: browserId } }));
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	const h = {
		got,
		path,
		hellos: () => hellos,
		/** The host goes away: its socket file and process vanish, as when a browser's extension reloads. */
		async stop() {
			for (const s of sockets) s.destroy();
			if (server.listening) await new Promise((r) => server.close(r));
			sleeper.kill();
		},
	};
	hosts.push(h);
	return h;
}

before(async () => {
	const { build } = await import("esbuild");
	const out = join(root, "client.mjs");
	await build({ entryPoints: [join(here, "..", "src", "client.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
	// Read when the client module loads: set first.
	process.env.TABKYRA_SOCKET_DIR = dir;
	process.env.TABKYRA_RECONNECT_BUDGET_MS = "3000";
	({ BridgeClient } = await import(out));
});

afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stop().catch(() => {});
});

after(() => {
	for (const s of sleepers) s.kill();
	rmSync(root, { recursive: true, force: true });
});

test("a read cut off in browser A is resent to A when it comes back, never to browser B", async () => {
	const a = await host({ browserId: "browser-a", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "pin", session: "pin" });
	try {
		assert.deepEqual(await client.call("tabs.context"), { from: "browser-a" });
		// Browser B's host appears; then A's extension reloads under a read.
		const b = await host({ browserId: "browser-b" });
		const reading = client.call("text");
		await new Promise((r) => setTimeout(r, 800));
		const a2 = await host({ browserId: "browser-a" });
		assert.deepEqual(await reading, { from: "browser-a" });
		assert.deepEqual(b.got, [], "the read went to the other browser");
		assert.deepEqual(a2.got, ["text"]);
	} finally {
		client.close();
	}
});

test("a reconnect stuck on a host whose extension never answers moves to the host that comes up", async () => {
	const stale = await host({ extension: false });
	const live = await host({ browserId: "browser-c", dropFirst: ["html"] });
	const client = new BridgeClient({ name: "stale", session: "stale" });
	try {
		assert.deepEqual(await client.call("tabs.context"), { from: "browser-c" });
		// The live host drops a read and goes away; only the stale host is left for a while.
		const reading = client.call("html");
		await new Promise((r) => setTimeout(r, 1500));
		const back = await host({ browserId: "browser-c" });
		const started = Date.now();
		assert.deepEqual(await reading, { from: "browser-c" });
		assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms after the host came back`);
		assert.deepEqual(back.got, ["html"]);
	} finally {
		client.close();
	}
});

test("when the call's browser never comes back, that call fails and the next one takes the browser that is up", async () => {
	await host({ browserId: "browser-a", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "switch", session: "switch" });
	try {
		await client.call("tabs.context");
		await host({ browserId: "browser-c" });
		// The read was in browser A, which is gone for good (the user quit it): not resent to C.
		await assert.rejects(() => client.call("text"), /isn't connected/);
		// A fresh call isn't stuck on A.
		assert.deepEqual(await client.call("tabs.context"), { from: "browser-c" });
	} finally {
		client.close();
	}
});

test("a resend for browser A never goes to a host that hasn't said which browser it is", async () => {
	await host({ browserId: "browser-a", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "idless", session: "idless" });
	try {
		await client.call("tabs.context");
		const idless = await host({});
		const reading = client.call("text");
		await new Promise((r) => setTimeout(r, 800));
		const a2 = await host({ browserId: "browser-a" });
		assert.deepEqual(await reading, { from: "browser-a" });
		assert.deepEqual(idless.got, []);
		assert.deepEqual(a2.got, ["text"]);
	} finally {
		client.close();
	}
});

test("a later call waits its own budget, not the end of an earlier call's", async () => {
	// Budget 3 s. Read 1 is cut off at 0 s; read 2 starts at 2 s with no host; the host is back at 3.5 s.
	const h = await host({ browserId: "browser-d", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "budgets", session: "budgets" });
	try {
		await client.call("tabs.context");
		const first = client.call("text").then(
			() => "ok",
			(e) => e.message,
		);
		await new Promise((r) => setTimeout(r, 2000));
		const second = client.call("html");
		await new Promise((r) => setTimeout(r, 1500));
		await host({ browserId: "browser-d" });
		assert.match(await first, /isn't connected/);
		assert.deepEqual(await second, { from: "browser-d" });
		assert.equal(h.got.includes("html"), false);
	} finally {
		client.close();
	}
});

test("while its own new host waits for the extension's hello, the client neither redials it nor churns the other browser's host", async () => {
	await host({ browserId: "browser-e", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "churn", session: "churn" });
	try {
		await client.call("tabs.context");
		const other = await host({ browserId: "browser-f" });
		const reading = client.call("text");
		await new Promise((r) => setTimeout(r, 300));
		// Browser E's new host is up, but its extension says hello only 1.5 s later.
		const late = await host({ browserId: "browser-e", helloLateMs: 1500 });
		assert.deepEqual(await reading, { from: "browser-e" });
		assert.equal(late.hellos(), 1, `browser E's new host was dialed ${late.hellos()} times`);
		assert.ok(other.hellos() <= 1, `browser F's host was dialed ${other.hellos()} times`);
		assert.deepEqual(other.got, []);
	} finally {
		client.close();
	}
});

test("a call made while only a host without its extension is up waits for a ready host instead of going to it", async () => {
	const stale = await host({ extension: false });
	await host({ browserId: "browser-g", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "notready", session: "notready" });
	try {
		await client.call("tabs.context");
		const reading = client.call("text");
		await new Promise((r) => setTimeout(r, 500));
		// Only the stale host is up now: a click must not be written to it.
		const clicking = client.call("click", { ref: "e1" });
		await new Promise((r) => setTimeout(r, 700));
		const back = await host({ browserId: "browser-g" });
		assert.deepEqual(await clicking, { from: "browser-g" });
		assert.deepEqual(await reading, { from: "browser-g" });
		assert.deepEqual(stale.got, [], "a request went to a host whose extension wasn't there");
		assert.ok(back.got.includes("click"));
	} finally {
		client.close();
	}
});

test("a request refused as not_sent in browser A is resent to A when it comes back, never to browser B", async () => {
	const b = await host({ browserId: "browser-b" });
	await new Promise((r) => setTimeout(r, 20));
	await host({ browserId: "browser-a", refuseFirst: ["click"] });
	const client = new BridgeClient({ name: "refused", session: "refused" });
	try {
		assert.deepEqual(await client.call("tabs.context"), { from: "browser-a" });
		const clicking = client.call("click", { ref: "e1" });
		await new Promise((r) => setTimeout(r, 700));
		const a2 = await host({ browserId: "browser-a" });
		assert.deepEqual(await clicking, { from: "browser-a" });
		assert.deepEqual(b.got, [], "the refused click went to the other browser");
		assert.deepEqual(a2.got, ["click"]);
	} finally {
		client.close();
	}
});

test("a request still running on a socket the client moves away from gets its reply, however long it takes", async () => {
	const b = await host({ browserId: "browser-b", slow: { click: 6500 } });
	const client = new BridgeClient({ name: "retire", session: "retire" });
	try {
		await client.call("tabs.context");
		const clicking = client.call("click", { ref: "e1" });
		await new Promise((r) => setTimeout(r, 200));
		// The client moves to another host (a resend in another browser adopting it) while the click runs.
		const a = await host({ browserId: "browser-a" });
		await client.connect(a.path);
		assert.deepEqual(await clicking, { from: "browser-b" }, "a request running in another browser was cut off");
		assert.deepEqual(b.got, ["tabs.context", "click"]);
	} finally {
		client.close();
	}
});

test("a call made while a reconnect is dialing joins that dial: one hello, no second socket", async () => {
	await host({ browserId: "browser-x", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "onedial", session: "onedial" });
	try {
		await client.call("tabs.context");
		const reading = client.call("text");
		await new Promise((r) => setTimeout(r, 300));
		// The new host takes a while to welcome: the reconnect's dial is open meanwhile.
		const back = await host({ browserId: "browser-x", welcomeLateMs: 800 });
		await new Promise((r) => setTimeout(r, 350));
		const clicking = client.call("click", { ref: "e1" });
		assert.deepEqual(await reading, { from: "browser-x" });
		assert.deepEqual(await clicking, { from: "browser-x" });
		assert.equal(back.hellos(), 1, `the new host was dialed ${back.hellos()} times`);
	} finally {
		client.close();
	}
});

test("after input is cut off in browser A, the agent's next call waits for A instead of going to browser B", async () => {
	const b = await host({ browserId: "browser-b" });
	await new Promise((r) => setTimeout(r, 20));
	await host({ browserId: "browser-a", dropFirst: ["click"] });
	const client = new BridgeClient({ name: "after-cut", session: "after-cut" });
	try {
		assert.deepEqual(await client.call("tabs.context"), { from: "browser-a" });
		await assert.rejects(() => client.call("click", { ref: "e1" }), (err) => err.rpc?.code === "interrupted");
		// As told, the agent checks the page; then repeats the click.
		const reading = client.call("text");
		await new Promise((r) => setTimeout(r, 700));
		const a2 = await host({ browserId: "browser-a" });
		assert.deepEqual(await reading, { from: "browser-a" });
		assert.deepEqual(await client.call("click", { ref: "e1" }), { from: "browser-a" });
		assert.deepEqual(b.got, [], "a call after the cut-off went to the other browser");
		assert.deepEqual(a2.got, ["text", "click"]);
	} finally {
		client.close();
	}
});
