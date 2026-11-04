// What the MCP server does when the bridge drops under a call: a fake native host answers
// some requests, drops the connection on others, or refuses them, and counts what arrived.
// A read is resent; a click, fill or keypress cut off in flight is never replayed and the agent
// is told it may have run; a request that was never sent is sent once the bridge is back.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

const SNAP = { url: "https://example.com/", title: "Example", viewport: { width: 800, height: 600, scrollY: 0, pageHeight: 600 }, nodes: [], text: "hello" };

let root;
let server;
/** Sockets the fake host has open right now: a client must never hold more than one. */
const open = new Set();
let mcp;
/** method -> how many times the host received it. */
const seen = {};
/**
 * method -> what to do on each arrival, in order: "drop" closes the socket without a reply,
 * "interrupted" or "not_sent" answers with that RPC error, anything else answers normally.
 */
const plan = {};
/** When set, the host goes away for good right after its next drop. */
let vanishOnDrop = false;
/** ms the host waits before welcoming a client. */
let welcomeDelay = 0;
/** Welcome new clients with the extension not connected yet, and say it is 300 ms later. */
let extensionLate = false;
/** Welcome with the extension not connected and its "connected" status in the same write. */
let statusInWelcomeChunk = false;
/** hello frames received: one per connection a client opens. */
let hellos = 0;

before(async () => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-retry-"));
	const dir = join(root, "sock");
	mkdirSync(dir, { mode: 0o700 });
	mkdirSync(join(root, "home"));
	const path = join(dir, `${process.pid}.sock`);
	server = createServer((socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				const msg = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString());
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				if (msg.type === "hello") {
					hellos++;
					if (statusInWelcomeChunk) {
						socket.write(Buffer.concat([frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: false }), frame({ type: "extension_status", connected: true })]));
						continue;
					}
					const late = extensionLate;
					setTimeout(() => socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: !late })), welcomeDelay);
					if (late) setTimeout(() => !socket.destroyed && socket.write(frame({ type: "extension_status", connected: true })), welcomeDelay + 300);
					continue;
				}
				seen[msg.method] = (seen[msg.method] ?? 0) + 1;
				const step = plan[msg.method]?.shift();
				if (step === "endafter") {
					// Answers, then half-closes the connection (a host on its way out).
					socket.write(frame({ type: "response", id: msg.id, result: { ok: msg.method } }));
					socket.end();
					return;
				}
				if (step === "slowdrop") {
					// Runs a while, then the bridge drops under it.
					setTimeout(() => socket.destroy(), 1500);
					return;
				}
				if (step === "drop") {
					socket.destroy();
					if (vanishOnDrop) {
						server.close();
						for (const s of open) s.destroy();
					}
					return;
				}
				if (step === "interrupted" || step === "not_sent")
					socket.write(frame({ type: "response", id: msg.id, error: { code: step, message: `host says ${step}` } }));
				else socket.write(frame({ type: "response", id: msg.id, result: msg.method === "snapshot" ? SNAP : { ok: msg.method } }));
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	mcp = new Client({ name: "retry-test", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp"],
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: dir, TABKYRA_SESSION: "retry", TABKYRA_RECONNECT_BUDGET_MS: "1000" },
			stderr: "ignore",
		}),
	);
	// One answered call first: only a bridge that once worked is waited for after a drop.
	assert.ok(!(await mcp.callTool({ name: "tabs_context", arguments: {} })).isError);
});

after(async () => {
	await mcp?.close().catch(() => {});
	server?.close();
	rmSync(root, { recursive: true, force: true });
});

const text = (r) => r.content.map((c) => c.text).join("\n");

test("a read cut off by a drop is resent and succeeds", async () => {
	plan.snapshot = ["drop"];
	const r = await mcp.callTool({ name: "read_page", arguments: {} });
	assert.ok(!r.isError, text(r));
	assert.match(text(r), /Page: Example/);
	assert.equal(seen.snapshot, 2);
});

test("a click cut off by a drop is not replayed, and the agent is told it may have run", async () => {
	plan.click = ["drop"];
	const r = await mcp.callTool({ name: "click", arguments: { ref: "e1" } });
	assert.equal(r.isError, true);
	assert.match(text(r), /^interrupted: The browser connection dropped while click was running .* may have run\. Check the page with read_page before you repeat it; Tabkyra reconnects on your next call\./);
	assert.equal(seen.click, 1, "the click reached the browser twice");
	// The bridge is back: the next call works without the agent doing anything special.
	assert.ok(!(await mcp.callTool({ name: "tabs_context", arguments: {} })).isError);
});

test("an interrupted answer from the host is final for input, resent for a read", async () => {
	plan.fill = ["interrupted"];
	const fill = await mcp.callTool({ name: "fill", arguments: { ref: "e1", value: "x" } });
	assert.equal(fill.isError, true);
	assert.match(text(fill), /may have run/);
	assert.equal(seen.fill, 1);
	plan.text = ["interrupted"];
	const read = await mcp.callTool({ name: "get_page_text", arguments: {} });
	assert.ok(!read.isError, text(read));
	assert.equal(seen.text, 2);
});

test("a request the host refused as not sent is sent once the bridge is back", async () => {
	plan.press = ["not_sent"];
	const r = await mcp.callTool({ name: "press", arguments: { key: "Enter" } });
	assert.ok(!r.isError, text(r));
	assert.equal(seen.press, 2);
});

test("navigating to a URL is a read for this purpose; back is not", async () => {
	plan.navigate = ["drop", "drop"];
	const go = await mcp.callTool({ name: "navigate", arguments: { url: "https://example.com/" } });
	assert.ok(!go.isError, text(go));
	assert.equal(seen.navigate, 3, "two drops, then the third send is answered");
	plan.navigate = ["drop"];
	const back = await mcp.callTool({ name: "navigate", arguments: { url: "back" } });
	assert.equal(back.isError, true);
	assert.match(text(back), /may have run/);
	assert.equal(seen.navigate, 4);
});

test("a read that keeps getting cut off is reported after three sends, not chased forever", async () => {
	plan.html = ["drop", "drop", "drop", "drop"];
	const r = await mcp.callTool({ name: "get_page_html", arguments: {} });
	assert.equal(r.isError, true);
	assert.match(text(r), /dropped 3 times in a row during get_page_html/);
	assert.equal(seen.html, 3);
	plan.html = [];
});

test("reads cut off together share one reconnect, and the client never holds two sockets", async () => {
	seen.snapshot = 0;
	seen.text = 0;
	plan.snapshot = ["drop"];
	const [a, b] = await Promise.all([mcp.callTool({ name: "read_page", arguments: {} }), mcp.callTool({ name: "get_page_text", arguments: {} })]);
	assert.ok(!a.isError && !b.isError, `${text(a)} | ${text(b)}`);
	// The dropped snapshot went twice; the text read, cut off with it or sent after, at most twice.
	assert.equal(seen.snapshot, 2);
	assert.ok(seen.text <= 2, `get_page_text went ${seen.text} times`);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(open.size, 1, `the client holds ${open.size} sockets to the host`);
});

test("a read that ran longer than the reconnect budget before the drop still gets the whole budget to reconnect", async () => {
	// The budget here is 1 s; the read runs 1.5 s before the bridge drops under it.
	plan.html = ["slowdrop"];
	seen.html = 0;
	const r = await mcp.callTool({ name: "get_page_html", arguments: {} });
	assert.ok(!r.isError, text(r));
	assert.equal(seen.html, 2);
});

test("calls made while the client is still connecting share that one connection", async () => {
	// A fresh MCP server whose host welcomes slowly, before its extension has said hello: three
	// calls at once use one socket, which is kept, not dropped and redialed under them.
	welcomeDelay = 400;
	extensionLate = true;
	const before = hellos;
	const fresh = new Client({ name: "retry-fresh", version: "0.0.0" });
	await fresh.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp"],
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: join(root, "sock"), TABKYRA_SESSION: "retry2" },
			stderr: "ignore",
		}),
	);
	try {
		const results = await Promise.all([0, 1, 2].map(() => fresh.callTool({ name: "get_page_text", arguments: {} })));
		for (const r of results) assert.ok(!r.isError, text(r));
		// Past the late welcome and the extension's status: no redial happened under the calls.
		await new Promise((r) => setTimeout(r, 1000));
		assert.equal(hellos - before, 1, `${hellos - before} connections for one client`);
	} finally {
		welcomeDelay = 0;
		extensionLate = false;
		await fresh.close();
	}
});

test("an extension status that arrives with the welcome is kept, so a resent read doesn't wait out the budget", async () => {
	// After a reload the new host welcomes before the extension's hello and says "connected" in
	// the same data chunk. The read must go through, not fail after the (1 s) budget.
	plan.text = ["drop"];
	statusInWelcomeChunk = true;
	try {
		const r = await mcp.callTool({ name: "get_page_text", arguments: {} });
		assert.ok(!r.isError, text(r));
	} finally {
		statusInWelcomeChunk = false;
	}
});

test("a live host's not_sent refusals are waited out and resent, not counted as drops", async () => {
	// An update installing: the extension refuses twice, then takes the request (this client's
	// budget is 1 s: 250 + 500 ms of backoff fit; a third refusal would be reported as not_sent).
	plan.fill = ["not_sent", "not_sent"];
	seen.fill = 0;
	const started = Date.now();
	const r = await mcp.callTool({ name: "fill", arguments: { ref: "e1", value: "x" } });
	assert.ok(!r.isError, text(r));
	assert.equal(seen.fill, 3);
	assert.ok(Date.now() - started >= 250 + 500 - 50, `resent after ${Date.now() - started} ms; no backoff`);
});

test("two requests refused together are both resent; neither is called cut off", async () => {
	plan.text = ["not_sent"];
	plan.click = ["not_sent"];
	const [read, click] = await Promise.all([mcp.callTool({ name: "get_page_text", arguments: {} }), mcp.callTool({ name: "click", arguments: { ref: "e2" } })]);
	assert.ok(!read.isError, text(read));
	assert.ok(!click.isError, `a click that never ran was reported: ${text(click)}`);
});

test("a socket the host has half-closed takes no request: it is treated as never sent", async () => {
	const { build } = await import("esbuild");
	const out = join(root, "client.mjs");
	await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
	const { BridgeClient } = await import(out);
	const before = process.env.TABKYRA_SOCKET_DIR;
	// No host at all: a request that is never sent fails as "not connected".
	process.env.TABKYRA_SOCKET_DIR = join(root, "no-host");
	mkdirSync(process.env.TABKYRA_SOCKET_DIR, { recursive: true, mode: 0o700 });
	const client = new BridgeClient({ name: "halfclose" });
	// The host ended this socket: Node keeps it open but no longer writable until it closes.
	const writes = [];
	client.socket = { destroyed: false, writable: false, write: (b) => writes.push(b), destroy() {}, once() {}, on() {} };
	try {
		await assert.rejects(() => client.call("press", { key: "Tab" }), /isn't connected/);
		assert.equal(writes.length, 0, "a request was written to a half-closed socket (it would then be reported 'may have run')");
	} finally {
		if (before === undefined) delete process.env.TABKYRA_SOCKET_DIR;
		else process.env.TABKYRA_SOCKET_DIR = before;
	}
});

test("input cut off while no host comes back fails at once, without waiting out the reconnect budget", async () => {
	// The press reaches the host, which drops it and never comes back.
	plan.press = ["drop"];
	vanishOnDrop = true;
	const started = Date.now();
	const r = await mcp.callTool({ name: "press", arguments: { key: "Enter" } });
	assert.equal(r.isError, true);
	assert.match(text(r), /^interrupted: /);
	assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
