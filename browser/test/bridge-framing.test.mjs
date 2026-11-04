// Native-messaging framing between the extension, the host and the CLI. One bad frame must not
// make a stream deaf: the parser keeps the good frames around it, and the host restarts (exits,
// so Chrome and the extension reconnect) instead of ignoring the extension from then on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameParser } from "../cli/src/framing.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// The hosts here keep community skill state in a folder of their own and never fetch a catalog
// (the host syncs on every hello, D27).
process.env.TABKYRA_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tabkyra-host-config-"));
process.env.TABKYRA_COMMUNITY_URL = join(process.env.TABKYRA_CONFIG_DIR, "no-catalog");

// The CLI's bundler inlines the release key (a .pub text import) and the bundled SKILL.md files; do the same for the source run.
const PUB_LOADER = `import { readFileSync } from "node:fs";
export async function load(url, context, next) {
	if (!url.endsWith(".pub") && !url.endsWith(".md")) return next(url, context);
	return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(readFileSync(new URL(url), "utf8")) };
}`;
const HOST_ENTRY = `import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(PUB_LOADER)}`)});
const { runNativeHost } = await import("./cli/src/host.ts");
runNativeHost();`;

function header(length) {
	const h = Buffer.alloc(4);
	h.writeUInt32LE(length, 0);
	return h;
}

/** Push and collect, whichever way the parser reports a bad frame. */
function push(parser, chunk) {
	try {
		const r = parser.push(chunk);
		return Array.isArray(r) ? { messages: r } : r;
	} catch (err) {
		return { messages: [], error: err, threw: true };
	}
}

test("after an oversized frame, later frames still parse", () => {
	const p = new FrameParser(1024);
	const first = push(p, Buffer.concat([header(5000), Buffer.alloc(3000)]));
	assert.ok(first.error, "oversized frame is reported");
	const second = push(p, Buffer.concat([Buffer.alloc(2000), encodeFrame({ type: "pong" })]));
	assert.deepEqual(second.messages, [{ type: "pong" }]);
	assert.equal(second.error, undefined);
});

test("a malformed frame keeps the good frames before and after it in the same chunk", () => {
	const p = new FrameParser(1024);
	const bad = Buffer.from("{nope");
	const r = push(
		p,
		Buffer.concat([encodeFrame({ type: "response", id: 1 }), header(bad.length), bad, encodeFrame({ type: "pong" })]),
	);
	assert.ok(r.error, "bad frame is reported");
	assert.deepEqual(r.messages, [{ type: "response", id: 1 }, { type: "pong" }]);
});

test("frames split across chunks are reassembled", () => {
	const p = new FrameParser(1024);
	const frame = encodeFrame({ type: "event", data: "x".repeat(100) });
	assert.deepEqual(push(p, frame.subarray(0, 3)).messages, []);
	assert.deepEqual(push(p, frame.subarray(3, 50)).messages, []);
	assert.deepEqual(push(p, frame.subarray(50)).messages, [{ type: "event", data: "x".repeat(100) }]);
});

test("the native host exits on a bad frame from the extension instead of going deaf", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY],
		{ cwd: repo, env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") }, stdio: ["pipe", "pipe", "pipe"] },
	);
	const exited = new Promise((r) => host.once("exit", (c) => r(c)));
	const within = (ms) => Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), ms))]);
	try {
		// Up and listening first, so an exit below is the bad frame's doing.
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(existsSync(sock), "host started and opened its socket");
		assert.equal(await within(200), "still running");
		host.stdin.write(header(61 * 1024 * 1024));
		const code = await within(5000);
		assert.notEqual(code, "still running", "host kept running after the bad frame");
		assert.notEqual(code, 0, "host exits with an error code");
	} finally {
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("on a bad extension frame the host answers waiting requests with a non-retried error, then exits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exited = new Promise((r) => host.once("exit", (c) => r(c)));
	const toExt = new FrameParser(64 * 1024 * 1024);
	const forwarded = [];
	host.stdout.on("data", (chunk) => forwarded.push(...toExt.push(chunk).messages));
	try {
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		const client = connect({ path: sock, allowHalfOpen: true });
		const late = client;
		const fromHost = new FrameParser(64 * 1024 * 1024);
		const received = [];
		client.on("data", (chunk) => received.push(...fromHost.push(chunk).messages));
		client.on("error", () => undefined);
		client.write(encodeFrame({ type: "hello", client: { name: "t", session: "s" } }));
		client.write(encodeFrame({ type: "request", id: 1, method: "tabs.create", params: {} }));
		client.write(encodeFrame({ type: "request", id: 2, method: "click", params: {} }));
		const wait = async (fn, what) => {
			for (let i = 0; i < 100; i++) {
				const v = fn();
				if (v) return v;
				await new Promise((r) => setTimeout(r, 20));
			}
			throw new Error(`timed out waiting for ${what}`);
		};
		const reqs = await wait(() => {
			const r = forwarded.filter((m) => m.type === "request");
			return r.length === 2 ? r : undefined;
		}, "both requests forwarded");
		const clientId = reqs[0].clientId;
		// One good reply, then a frame the host can't read: the reply to request 2 is lost.
		host.stdin.write(Buffer.concat([encodeFrame({ type: "response", clientId, id: 1, result: { tabId: 7 } }), header(61 * 1024 * 1024)]));
		await wait(() => received.some((m) => m.id === 2), "the lost request's answer");
		const responses = received.filter((m) => m.type === "response");
		assert.deepEqual(
			responses.find((m) => m.id === 1),
			{ type: "response", id: 1, result: { tabId: 7 } },
			"the good reply reached the client",
		);
		const lost = responses.find((m) => m.id === 2);
		assert.ok(lost?.error, `request 2 got an RPC error, not just a closed socket: ${JSON.stringify(responses)}`);
		assert.match(lost.error.message, /may have run/);
		assert.equal(lost.error.code, "interrupted");
		// A request that reaches the host after that is never forwarded (it could only be lost).
		late.write(encodeFrame({ type: "request", id: 3, method: "click", params: {} }));
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(forwarded.filter((m) => m.type === "request" && m.id === 3).length, 0, "request 3 was forwarded");
		assert.notEqual(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5000))]), "still running");
	} finally {
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("when the extension goes away, the host answers every waiting request as interrupted before it exits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exited = new Promise((r) => host.once("exit", (c) => r(c)));
	const toExt = new FrameParser(64 * 1024 * 1024);
	const forwarded = [];
	host.stdout.on("data", (chunk) => forwarded.push(...toExt.push(chunk).messages));
	try {
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		const client = connect({ path: sock, allowHalfOpen: true });
		const fromHost = new FrameParser(64 * 1024 * 1024);
		const received = [];
		client.on("data", (chunk) => received.push(...fromHost.push(chunk).messages));
		client.on("error", () => undefined);
		client.write(encodeFrame({ type: "hello", client: { name: "t", session: "s" } }));
		client.write(encodeFrame({ type: "request", id: 1, method: "click", params: {} }));
		for (let i = 0; i < 100 && !forwarded.some((m) => m.type === "request"); i++) await new Promise((r) => setTimeout(r, 20));
		// The extension reloads: Chrome closes the port, so the host's stdin ends.
		host.stdin.end();
		for (let i = 0; i < 100 && !received.some((m) => m.id === 1); i++) await new Promise((r) => setTimeout(r, 5));
		// The host now knows it is stopping (it answered the click). A request sent right then is
		// still answered, as not_sent, however long the client had been idle before.
		client.write(encodeFrame({ type: "request", id: 2, method: "click", params: {} }));
		const answer = received.find((m) => m.type === "response" && m.id === 1);
		assert.ok(answer?.error, `the click got an answer, not just a closed socket: ${JSON.stringify(received)}`);
		assert.equal(answer.error.code, "interrupted");
		assert.match(answer.error.message, /may have run: check the page \(read_page\) before repeating it/);
		// The request that arrived while the host was stopping is answered not_sent, never dropped.
		for (let i = 0; i < 50 && !received.some((m) => m.id === 2); i++) await new Promise((r) => setTimeout(r, 10));
		const late = received.find((m) => m.type === "response" && m.id === 2);
		assert.equal(late?.error?.code, "not_sent", `the late request got no not_sent answer: ${JSON.stringify(received)}`);
		assert.equal(forwarded.filter((m) => m.type === "request" && m.id === 2).length, 0, "a late request was forwarded");
		assert.notEqual(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5000))]), "still running");
	} finally {
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a host stopped by a signal drops the extension's side at once, answers its clients, and survives a closed pipe", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exited = new Promise((r) => host.once("exit", (c) => r(c)));
	const toExt = new FrameParser(64 * 1024 * 1024);
	const forwarded = [];
	let extensionSideEnded = 0;
	host.stdout.on("data", (chunk) => forwarded.push(...toExt.push(chunk).messages));
	host.stdout.on("end", () => {
		extensionSideEnded = Date.now();
	});
	try {
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		const open = () => {
			const c = connect({ path: sock, allowHalfOpen: true });
			const parser = new FrameParser(64 * 1024 * 1024);
			const got = [];
			c.on("data", (chunk) => got.push(...parser.push(chunk).messages));
			c.on("error", () => undefined);
			c.write(encodeFrame({ type: "hello", client: { name: "t", session: "s" } }));
			return { c, got };
		};
		const one = open();
		const two = open();
		one.c.write(encodeFrame({ type: "request", id: 1, method: "click", params: {} }));
		for (let i = 0; i < 100 && !forwarded.some((m) => m.type === "request"); i++) await new Promise((r) => setTimeout(r, 20));
		const signalled = Date.now();
		host.kill("SIGTERM");
		for (let i = 0; i < 100 && !one.got.some((m) => m.id === 1); i++) await new Promise((r) => setTimeout(r, 5));
		assert.equal(one.got.find((m) => m.id === 1)?.error?.code, "interrupted");
		// The extension's side closes right away, before the host lingers for its clients.
		for (let i = 0; i < 100 && !extensionSideEnded; i++) await new Promise((r) => setTimeout(r, 5));
		assert.ok(extensionSideEnded && extensionSideEnded - signalled < 200, "the extension's side stayed open while the host lingered");
		// The pipe is gone; a client leaving (which used to write to it) must not crash the host.
		host.stdout.destroy();
		two.c.destroy();
		await new Promise((r) => setTimeout(r, 30));
		one.c.write(encodeFrame({ type: "request", id: 2, method: "press", params: {} }));
		for (let i = 0; i < 100 && !one.got.some((m) => m.id === 2); i++) await new Promise((r) => setTimeout(r, 5));
		assert.equal(one.got.find((m) => m.id === 2)?.error?.code, "not_sent");
		assert.equal(forwarded.filter((m) => m.type === "request" && m.id === 2).length, 0);
		assert.notEqual(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5000))]), "still running");
	} finally {
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a host that is stopping doesn't welcome a new client as ready", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	host.stdout.on("data", () => undefined);
	const sockets = [];
	const open = (sock) => {
		const s = connect({ path: sock });
		sockets.push(s);
		s.on("error", () => undefined);
		const parser = new FrameParser(64 * 1024 * 1024);
		const welcome = new Promise((resolve) => {
			s.on("data", (chunk) => {
				const w = parser.push(chunk).messages.find((m) => m.type === "welcome");
				if (w) resolve(w);
			});
			s.on("close", () => resolve(undefined));
		});
		return { hello: () => s.write(encodeFrame({ type: "hello", client: { name: "t", session: "s" } })), welcome };
	};
	try {
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		host.stdin.write(encodeFrame({ type: "hello", version: "1", protocol: 1, methods: [], browserId: "b1" }));
		const first = open(sock);
		first.hello();
		assert.equal((await first.welcome).extensionConnected, true);
		// A connection accepted just before the extension goes away says hello just after.
		const late = open(sock);
		await new Promise((r) => setTimeout(r, 100));
		host.stdin.end();
		await new Promise((r) => setTimeout(r, 50));
		late.hello();
		const w = await late.welcome;
		assert.ok(w, "the lingering host closed the connection without a welcome");
		assert.equal(w.extensionConnected, false, "a stopping host welcomed a client as ready");
		assert.equal(w.browserId, undefined);
	} finally {
		for (const s of sockets) s.destroy();
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session the extension assigned or renamed is the one the host re-announces after a worker restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const toExt = new FrameParser(64 * 1024 * 1024);
	const forwarded = [];
	host.stdout.on("data", (chunk) => forwarded.push(...toExt.push(chunk).messages));
	const wait = async (fn, what) => {
		for (let i = 0; i < 150; i++) {
			const v = fn();
			if (v) return v;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error(`timed out waiting for ${what}`);
	};
	const sockets = [];
	try {
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		const hello = (client) => {
			const s = connect({ path: sock });
			s.on("error", () => undefined);
			sockets.push(s);
			s.write(encodeFrame({ type: "hello", client }));
		};
		hello({ name: "claude", session: "shop-1a2b", auto: true, project: "shop" });
		hello({ name: "claude", session: "shop-1a2b", auto: true, project: "shop" });
		hello({ name: "claude", session: "notes", auto: true, project: "notes" });
		const ids = await wait(() => {
			const c = forwarded.filter((m) => m.type === "client_connected");
			return c.length === 3 ? c.map((m) => m.clientId) : undefined;
		}, "three clients announced");
		// The second agent in the project is moved to "-2"; the user renames the third.
		host.stdin.write(encodeFrame({ type: "event", clientId: ids[1], event: "session_assigned", data: { session: "shop-1a2b-2" } }));
		host.stdin.write(encodeFrame({ type: "event", clientId: ids[2], event: "session_renamed", data: { session: "trip" } }));
		await new Promise((r) => setTimeout(r, 200));
		forwarded.length = 0;
		// The extension's worker restarts and says hello: every live client is announced again.
		host.stdin.write(encodeFrame({ type: "hello", extensionVersion: "0.0.0" }));
		const again = await wait(() => {
			const c = forwarded.filter((m) => m.type === "client_connected");
			return c.length === 3 ? c : undefined;
		}, "clients re-announced");
		const by = Object.fromEntries(again.map((m) => [m.clientId, m.client]));
		assert.equal(by[ids[0]].session, "shop-1a2b");
		assert.equal(by[ids[1]].session, "shop-1a2b-2", "the second agent would be put back on the first one's session");
		assert.equal(by[ids[1]].auto, true);
		assert.equal(by[ids[2]].session, "trip");
		assert.equal(by[ids[2]].auto, false, "a renamed session is the user's choice, not a default");
	} finally {
		for (const s of sockets) s.destroy();
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an extension from before project sessions gets a separate session per agent, a current one the shared default", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const toExt = new FrameParser(64 * 1024 * 1024);
	const forwarded = [];
	host.stdout.on("data", (chunk) => forwarded.push(...toExt.push(chunk).messages));
	const announced = async (n) => {
		for (let i = 0; i < 150; i++) {
			const c = forwarded.filter((m) => m.type === "client_connected");
			if (c.length >= n) return c.slice(0, n);
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error("clients not announced");
	};
	const sockets = [];
	try {
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		for (const client of [{ name: "claude", session: "shop-1a2b", auto: true }, { name: "claude", session: "shop-1a2b", auto: true }, { name: "claude", session: "mine" }]) {
			const s = connect({ path: sock });
			s.on("error", () => undefined);
			sockets.push(s);
			s.write(encodeFrame({ type: "hello", client }));
		}
		await announced(3);
		forwarded.length = 0;
		host.stdin.write(encodeFrame({ type: "hello", version: "1.1.0", protocol: 1, methods: ["status", "tabs.context", "navigate"] }));
		const old = (await announced(3)).map((m) => m.client.session);
		assert.equal(new Set(old.slice(0, 2)).size, 2, `two agents in one project would share a session on an old extension: ${old}`);
		assert.ok(old[0].startsWith("shop-1a2b-"));
		assert.equal(old[2], "mine", "a name the user chose is passed as is");
		forwarded.length = 0;
		host.stdin.write(encodeFrame({ type: "hello", version: "1.2.0", protocol: 1, methods: ["status", "tabs.context", "navigate", "sessions.list"] }));
		assert.deepEqual((await announced(3)).map((m) => m.client.session), ["shop-1a2b", "shop-1a2b", "mine"]);
	} finally {
		for (const s of sockets) s.destroy();
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});
