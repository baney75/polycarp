// Review round 2 of the hub (PR #104): hostile connections, unfinished bodies, slow readers,
// orphan sessions from cancelled initializes, UTF-16 safe chunks, an unreadable devices file,
// held lock files, and mint errors. Real processes; a fake device (a WebSocket client with a real
// credential) or a fake hub (a WebSocket server a real `link run` dials) where the test must
// control exactly what the other side says.
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { connect as tcpConnect } from "node:net";
import { after, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { addDevice, cli, createToken, fakeDevice as makeFake, freePort, INITIALIZE, machine, rawTools, readJson, rmSync, rpc, sleep, startHub, tempRoot } from "./helpers/hub-fixture.mjs";

const root = tempRoot("tabkyra-hubhard-");
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
async function fakeDevice(hub, name, options) {
	const fake = await makeFake(hub, name, options);
	cleanup.push(() => fake.ws.terminate());
	return fake;
}
const rssMb = (pid) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;
async function waitFor(check, what, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await check();
		if (v) return v;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const upgrade = (port, target, extra = "") =>
	`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

/** Send raw bytes, return what comes back before the server closes (or a short wait). */
function rawExchange(port, bytes) {
	return new Promise((resolve) => {
		const socket = tcpConnect(port, "127.0.0.1");
		let out = "";
		socket.on("data", (d) => (out += d));
		socket.on("error", () => undefined);
		socket.on("close", () => resolve(out));
		socket.write(bytes);
		setTimeout(() => {
			socket.destroy();
			resolve(out);
		}, 1500);
	});
}
const alive = async (hub) => {
	assert.equal(hub.proc.exitCode, null, "the hub is still running");
	assert.equal((await fetch(`${hub.url}/`)).status, 200, "and answering");
};

// ---------- sol-F1, sonnet-F1: hostile upgrades ----------

test("a malformed upgrade target gets 400 and the hub keeps running", async () => {
	const hub = await hubFor("bad-target-hub");
	for (const target of ["///", "//", "http://"]) {
		const answer = await rawExchange(hub.port, upgrade(hub.port, target));
		assert.match(answer, /^HTTP\/1\.1 400 /, `${target}: ${answer}`);
	}
	await alive(hub);
});

test("a peer that resets while the hub refuses its upgrade can't take the hub down", async () => {
	const hub = await hubFor("reset-hub");
	for (let i = 0; i < 60; i++) {
		await new Promise((resolve) => {
			const socket = tcpConnect(hub.port, "127.0.0.1");
			socket.on("error", () => undefined);
			socket.on("close", resolve);
			const target = i % 3 === 0 ? "/link" : i % 3 === 1 ? "/nope" : "/link";
			const extra = i % 2 ? "Authorization: Bearer dv-000000000000.wrongwrongwrongwrongwrongwrongwrongwrongwrong\r\n" : "";
			socket.write(upgrade(hub.port, target, extra), () => {
				// RST while the refusal is being written.
				if (i % 5 === 0) setImmediate(() => socket.resetAndDestroy());
				else socket.resetAndDestroy();
			});
		});
	}
	await sleep(300);
	await alive(hub);
});

// ---------- sol-F2: body readers are reserved before the body ----------

test("many slow unfinished initialize bodies hit the caps (429) and memory stays bounded", async () => {
	const hub = await hubFor("readers-hub");
	await deviceFor(hub, "alpha");
	const before = rssMb(hub.proc.pid);
	const url = new URL(`${hub.url}/mcp`);
	const open = [];
	const statuses = [];
	const slow = (secret) => {
		const req = httpRequest({ host: url.hostname, port: url.port, path: "/mcp", method: "POST", agent: false, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}`, "content-length": "3000000" } });
		req.on("response", (res) => {
			statuses.push(res.statusCode);
			res.resume();
		});
		req.on("error", () => undefined);
		req.write(Buffer.alloc(1_000_000, 0x20));
		open.push(req);
	};
	// One caller: its cap of 8 sessions-or-initializes holds before any body is read.
	const one = createToken(hub, "one", "skills.read");
	for (let i = 0; i < 20; i++) slow(one);
	await sleep(800);
	assert.ok(statuses.filter((x) => x === 429).length >= 12, `one caller is held to its cap: ${statuses.join(",")}`);
	// Many callers: the hub-wide cap holds too.
	statuses.length = 0;
	for (let c = 0; c < 12; c++) {
		const secret = createToken(hub, `c${c}`, "skills.read");
		for (let i = 0; i < 8; i++) slow(secret);
	}
	await sleep(1500);
	assert.ok(statuses.filter((x) => x === 429).length >= 96 - 64 - 8, `the hub-wide cap refuses the rest: ${statuses.length} refusals`);
	assert.equal(hub.proc.exitCode, null);
	assert.ok(rssMb(hub.proc.pid) - before < 250, `memory is bounded (${(rssMb(hub.proc.pid) - before).toFixed(0)} MB more)`);
	for (const req of open) req.destroy();
	await sleep(500);
	assert.equal((await rpc(`${hub.url}/mcp`, one, INITIALIZE)).status, 200, "abandoned bodies give their slots back");
});

// ---------- sol-F3, first-F2, sonnet-F4: backpressure ----------

test("a client that stops reading is cancelled, the hub's memory stays bounded, and the link resumes", async () => {
	const hub = await hubFor("slow-hub", { env: { TABKYRA_HUB_SLOW_CLIENT_MS: "1000" } });
	let sent = 0;
	let stop = false;
	const fake = await fakeDevice(hub, "firehose", {
		answer: true,
		onReq: (frame, ws) => {
			if (frame.method !== "GET") return;
			ws.send(JSON.stringify({ t: "head", id: frame.id, status: 200, headers: { "content-type": "text/event-stream" } }));
			const data = "x".repeat(200_000);
			(async () => {
				while (!stop && ws.readyState === WebSocket.OPEN && !fake.frames.some((f) => f.t === "cancel" && f.id === frame.id)) {
					if (ws.bufferedAmount < 4_000_000) {
						ws.send(JSON.stringify({ t: "chunk", id: frame.id, data }));
						sent += data.length;
					} else await sleep(5);
				}
			})();
		},
	});
	cleanup.push(() => {
		stop = true;
	});
	const secret = createToken(hub, "caller", "skills.read");
	const init = await rpc(`${hub.url}/mcp`, secret, INITIALIZE);
	const sid = init.headers.get("mcp-session-id");
	const before = rssMb(hub.proc.pid);
	// A client that sends its request and never reads.
	const socket = tcpConnect(hub.port, "127.0.0.1");
	socket.on("error", () => undefined);
	socket.pause();
	socket.write(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${hub.port}\r\nAccept: text/event-stream\r\nAuthorization: Bearer ${secret}\r\nMcp-Session-Id: ${sid}\r\n\r\n`);
	const getId = (await waitFor(() => fake.reqs().find((r) => r.method === "GET"), "the GET to reach the device")).id;
	await waitFor(() => fake.frames.some((f) => f.t === "cancel" && f.id === getId), "the hub to cancel the stalled request", 15_000);
	assert.ok(sent < 120_000_000, `the device wasn't allowed to pour out data without limit (${(sent / 1e6).toFixed(0)} MB sent)`);
	assert.ok(rssMb(hub.proc.pid) - before < 200, `the hub's memory is bounded (${(rssMb(hub.proc.pid) - before).toFixed(0)} MB more)`);
	socket.destroy();
	// The link was paused for the stalled client; it reads again.
	assert.equal((await rpc(`${hub.url}/mcp`, secret, INITIALIZE)).status, 200);
});

// ---------- sonnet-F3, second-S1: no orphan sessions from abandoned initializes ----------

/** A fake hub: a WebSocket server that a real `link run` dials. */
async function fakeHub(name) {
	const m = machine(root, name);
	const port = await freePort();
	const wss = new WebSocketServer({ port, host: "127.0.0.1" });
	cleanup.push(() => wss.close());
	mkdirSync(m.config, { recursive: true });
	writeFileSync(m.file("link.json"), JSON.stringify({ hubUrl: `http://127.0.0.1:${port}`, deviceId: "dv-fakefakefake", secret: "s".repeat(43), name, manage: false, scopes: ["skills.read", "browser.read"] }));
	const frames = [];
	const connected = new Promise((resolve) =>
		wss.on("connection", (ws) => {
			ws.on("message", (data) => frames.push(JSON.parse(data.toString("utf8"))));
			resolve(ws);
		}),
	);
	const proc = spawn(process.execPath, [cli, "link", "run"], { env: m.env });
	cleanup.push(() => proc.kill());
	const ws = await connected;
	const live = () => {
		try {
			return readJson(m.file("link-live.json"));
		} catch {
			return undefined;
		}
	};
	await waitFor(() => frames.some((f) => f.t === "status"), "the device's first status");
	const hubHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-tabkyra-hub-scopes": "skills.read", "x-tabkyra-hub-caller": "tester" };
	return { ws, frames, live, m, hubHeaders, send: (f) => ws.send(JSON.stringify(f)), heads: () => frames.filter((f) => f.t === "head") };
}

test("30 initializes the hub abandons leave no session on the device, and a fresh one still works", async () => {
	const fh = await fakeHub("orphan-device");
	// The hub gives up at staggered moments, from before the request reaches the local server to just before its answer.
	for (let i = 0; i < 30; i++) {
		fh.send({ t: "req", id: `i${i}`, method: "POST", path: "/mcp", headers: fh.hubHeaders, body: JSON.stringify({ ...INITIALIZE, id: i + 1 }) });
		await sleep(i % 10);
		fh.send({ t: "cancel", id: `i${i}` });
	}
	await waitFor(() => fh.live()?.requests === 0, "the device to finish with the requests", 15_000);
	// A head that came back before the cancel reached the device is one the hub would have seen and, late, deleted (that is the hub's half, tested above): do what it does.
	for (const head of fh.heads()) {
		const sid = head.headers["mcp-session-id"];
		if (sid) fh.send({ t: "req", id: `del-${head.id}`, method: "DELETE", path: "/mcp", headers: { ...fh.hubHeaders, "mcp-session-id": sid }, body: "" });
	}
	await waitFor(() => fh.live()?.requests === 0 && fh.live()?.sessions === 0, "the device to hold no sessions", 15_000);
	fh.send({ t: "req", id: "fresh", method: "POST", path: "/mcp", headers: fh.hubHeaders, body: JSON.stringify(INITIALIZE) });
	const head = await waitFor(() => fh.heads().find((h) => h.id === "fresh"), "the fresh initialize's head");
	assert.equal(head.status, 200, "no orphan sessions filled the device's cap");
	assert.ok(head.headers["mcp-session-id"]);
});

test("a head that arrives after the hub gave up on an initialize gets its session closed", async () => {
	const hub = await hubFor("late-head-hub", { env: { TABKYRA_HUB_HEAD_TIMEOUT_MS: "300" } });
	const late = [];
	const fake = await fakeDevice(hub, "slowpoke", {
		onReq: (frame, ws, frames) => {
			if (frame.method !== "POST") return;
			// Answer only after the hub has cancelled (its timeout fired).
			(async () => {
				await waitFor(() => frames.some((f) => f.t === "cancel" && f.id === frame.id), "the cancel");
				ws.send(JSON.stringify({ t: "head", id: frame.id, status: 200, headers: { "content-type": "application/json", "mcp-session-id": "late-session-1" } }));
				ws.send(JSON.stringify({ t: "end", id: frame.id }));
				late.push(frame.id);
			})();
		},
	});
	const res = await rpc(`${hub.url}/mcp`, createToken(hub, "caller", "skills.read"), INITIALIZE);
	assert.equal(res.status, 504);
	const del = await waitFor(() => fake.reqs().find((r) => r.method === "DELETE"), "a DELETE for the orphan");
	assert.equal(del.headers["mcp-session-id"], "late-session-1");
});

// ---------- sonnet-F2: UTF-16 safe chunks ----------

test("splitText never ends a piece between the halves of a surrogate pair", async () => {
	// The function lives in a file with no imports, so the test compiles it as is.
	const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "text-split.ts"), "utf8");
	const { code } = transformSync(source, { loader: "ts", format: "esm" });
	const { splitText } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
	for (const pad of ["", "a"]) {
		const text = `${pad}${"😀".repeat(300_000)}`;
		const pieces = splitText(text, 256_000);
		assert.ok(pieces.length >= 3);
		for (const piece of pieces) {
			assert.ok(piece.length <= 256_000);
			assert.ok(!lone.test(piece), "no piece holds half of a pair");
		}
		assert.equal(pieces.join(""), text, "nothing is lost");
	}
	assert.deepEqual(splitText("", 5), []);
	assert.deepEqual(splitText("ab😀cd", 3).join(""), "ab😀cd");
	assert.ok(splitText("😀😀", 1).every((p) => p.length >= 1), "a size of 1 still makes progress");
});

test("a chunk never ends between the halves of a surrogate pair (through a real device)", async () => {
	const fh = await fakeHub("emoji-device");
	const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
	// An error that echoes a 400,000-unit tool name made of emoji. The prefix before it has an unknown parity, so try both:
	// one of the two puts a pair across the 256,000-unit chunk boundary.
	for (const pad of ["", "a"]) {
		const name = `${pad}${"😀".repeat(200_000)}`;
		const id = `e${pad.length}`;
		const before = fh.frames.length;
		fh.send({ t: "req", id: "init", method: "POST", path: "/mcp", headers: fh.hubHeaders, body: JSON.stringify({ ...INITIALIZE, id: 1 }) });
		const sid = (await waitFor(() => fh.heads().find((h) => h.id === "init"), "initialize")).headers["mcp-session-id"];
		fh.send({ t: "req", id, method: "POST", path: "/mcp", headers: { ...fh.hubHeaders, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } }) });
		await waitFor(() => fh.frames.slice(before).some((f) => f.t === "end" && f.id === id), "the answer", 20_000);
		const chunks = fh.frames.filter((f) => f.t === "chunk" && f.id === id).map((f) => f.data);
		assert.ok(chunks.length >= 2, `the answer spans chunks (${chunks.length})`);
		for (const c of chunks) assert.ok(!lone.test(c), "no chunk holds half of a pair");
		assert.equal(chunks.join("").split("😀").length - 1, 200_000, "every emoji arrives whole");
		fh.frames.length = 0;
		fh.send({ t: "req", id: `d${id}`, method: "DELETE", path: "/mcp", headers: { ...fh.hubHeaders, "mcp-session-id": sid }, body: "" });
		await sleep(200);
	}
});

// ---------- first-F3: an unreadable devices file is never overwritten ----------

test("an unreadable hub-devices.json is never overwritten, links stay up, and auth fails closed", async () => {
	const hub = await hubFor("corrupt-hub");
	const dev = await deviceFor(hub, "alpha");
	const file = hub.file("hub-devices.json");
	const good = readFileSync(file, "utf8");
	const code = hub.json(["hub", "code", "--name", "newcomer", "--json"]).code;
	writeFileSync(file, "{ this is not json");
	const enroll = await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
	assert.equal(enroll.status, 500);
	assert.match((await enroll.json()).error_description, /unreadable/);
	assert.equal(hub.run(["hub", "prefer", "alpha"]).code, 1);
	assert.equal(hub.run(["hub", "remove", "alpha"]).code, 1);
	assert.equal(readFileSync(file, "utf8"), "{ this is not json", "nothing overwrote it");
	const link = readJson(dev.file("link.json"));
	const status = await new Promise((resolve) => {
		const ws = new WebSocket(`${hub.url.replace("http", "ws")}/link`, { headers: { authorization: `Bearer ${link.deviceId}.${link.secret}` } });
		ws.on("open", () => (resolve(101), ws.terminate()));
		ws.on("unexpected-response", (_r, res) => (resolve(res.statusCode), ws.terminate()));
		ws.on("error", () => undefined);
	});
	assert.equal(status, 401, "an unreadable file authorizes nobody");
	await sleep(2500);
	assert.equal(dev.live().connected, true, "the live link was not swept away");
	writeFileSync(file, good);
	assert.equal((await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).status, 200, "once readable, the same code still enrolls");
});

// ---------- second-S2, second-S3: locks and mint errors ----------

test("a held lock file answers 503 fast, a wrong code needs no lock, and the hub's loop isn't frozen", async () => {
	const hub = await hubFor("lock-hub");
	const code = hub.json(["hub", "code", "--json"]).code;
	writeFileSync(hub.file("hub-codes.json.lock"), "held");
	const started = Date.now();
	const wrong = await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TK-0000-000A" }) });
	assert.equal(wrong.status, 401, "a wrong code is refused from a read-only look");
	const held = await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
	assert.equal(held.status, 503);
	for (let i = 0; i < 5; i++) await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
	assert.ok(Date.now() - started < 4000, `held locks cost ${Date.now() - started} ms, not 10 s each`);
	rmSync(hub.file("hub-codes.json.lock"), { force: true });
	assert.equal((await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).status, 200, "the code wasn't spent by the 503s");
});

test("only the 'already waiting' limit is a 429; a lock is 503; a disk fault is 500 and the hub lives", async () => {
	const hub = await hubFor("mint-hub");
	const boss = await deviceFor(hub, "boss", { manage: true });
	const link = readJson(boss.file("link.json"));
	const ask = (kind) => fetch(`${hub.url}/link/code`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${link.deviceId}.${link.secret}` }, body: JSON.stringify({ kind }) });
	for (let i = 0; i < 20; i++) assert.equal((await ask("approval")).status, 200);
	const full = await ask("approval");
	assert.equal(full.status, 429);
	assert.match((await full.json()).error_description, /already waiting/);
	writeFileSync(hub.file("hub-codes.json.lock"), "held");
	assert.equal((await ask("connect")).status, 503);
	rmSync(hub.file("hub-codes.json.lock"), { force: true });
	// A directory where oauth-codes.json should be: reading finds nothing, writing fails. That's a fault, not a limit.
	rmSync(hub.file("oauth-codes.json"), { force: true });
	mkdirSync(hub.file("oauth-codes.json"));
	writeFileSync(hub.file("oauth-codes.json/keep"), "x");
	const fault = await ask("approval");
	assert.equal(fault.status, 500);
	await alive(hub);
});

// ---------- first-F4: the limiter stays cheap under a flood ----------

test("thousands of forged-source failures don't slow later requests", async () => {
	const hub = await hubFor("flood-hub");
	for (let i = 0; i < 3000; i += 100) {
		await Promise.all(
			Array.from({ length: 100 }, (_, j) => fetch(`${hub.url}/link/code`, { method: "POST", headers: { "x-forwarded-for": `172.16.${(i + j) >> 8}.${(i + j) & 255}`, authorization: "Bearer dv-000000000000.nope" }, body: "{}" })),
		);
	}
	const started = Date.now();
	for (let i = 0; i < 100; i++) await fetch(`${hub.url}/link/code`, { method: "POST", headers: { "x-forwarded-for": `172.17.0.${i}`, authorization: "Bearer dv-000000000000.nope" }, body: "{}" });
	assert.ok(Date.now() - started < 3000, `100 more failures took ${Date.now() - started} ms`);
	await alive(hub);
});
