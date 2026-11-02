// A hub and devices as real processes: `tabkyra hub serve` and `tabkyra link run`, each with its
// own config dir, socket dir and HOME. Nothing here touches ~/.config/tabkyra: every process gets
// TABKYRA_CONFIG_DIR inside a temp directory.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
export const cli = join(here, "..", "..", "dist", "index.js");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function freePort() {
	return await new Promise((resolve) => {
		const s = createNetServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

/** An isolated machine: its own HOME, config dir and bridge socket dir. */
export function machine(root, name) {
	const home = join(root, name, "home");
	const config = join(root, name, "config");
	const sock = join(root, name, "sock");
	mkdirSync(home, { recursive: true });
	mkdirSync(sock, { recursive: true, mode: 0o700 });
	const env = { HOME: home, TABKYRA_CONFIG_DIR: config, TABKYRA_SOCKET_DIR: sock, PATH: dirname(process.execPath), NO_COLOR: "1" };
	return {
		name,
		env,
		config,
		/** Run the CLI and wait for it. */
		run(args) {
			const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
			return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
		},
		json(args) {
			const r = this.run(args);
			if (r.code !== 0) throw new Error(`tabkyra ${args.join(" ")} exited ${r.code}: ${r.out}`);
			return JSON.parse(r.stdout);
		},
		file: (f) => join(config, f),
	};
}

export function tempRoot(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Start `tabkyra hub serve` on a free loopback port with a public URL on the same address. */
export async function startHub(root, name = "hub", { port: wantedPort, env: extraEnv = {} } = {}) {
	const m = machine(root, name);
	const port = wantedPort ?? (await freePort());
	const url = `http://127.0.0.1:${port}`;
	const proc = spawn(process.execPath, [cli, "hub", "serve", "--port", String(port), "--public-url", url], { env: { ...m.env, ...extraEnv } });
	let out = "";
	await new Promise((resolve, reject) => {
		proc.stdout.on("data", (d) => {
			out += d;
			if (/Hub at /.test(out)) resolve();
		});
		proc.stderr.on("data", (d) => {
			out += d;
		});
		proc.on("exit", (code) => reject(new Error(`hub exited ${code}: ${out}`)));
		setTimeout(() => reject(new Error(`hub didn't start: ${out}`)), 15_000);
	});
	return {
		...m,
		port,
		url,
		proc,
		stop() {
			proc.kill();
		},
		/** The snapshot `hub devices --json` shows: devices by name. */
		devices() {
			return Object.fromEntries(m.json(["hub", "devices", "--json"]).devices.map((d) => [d.name, d]));
		},
		async waitDevices(predicate, what, timeoutMs = 20_000) {
			const deadline = Date.now() + timeoutMs;
			let last;
			while (Date.now() < deadline) {
				last = this.devices();
				if (predicate(last)) return last;
				await sleep(150);
			}
			throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
		},
	};
}

/** Enroll a device with a connect code and start its `link run`. Resolves once the hub sees it online. */
export async function addDevice(root, hub, name, { manage = false, scope, wait = true, beforeRun } = {}) {
	const m = machine(root, `device-${hub.name}-${name}`);
	const code = hub.json(["hub", "code", "--name", name, ...(manage ? ["--manage"] : []), "--json"]).code;
	const linked = m.run(["link", hub.url, "--code", code, "--no-service", "--json", ...(scope ? ["--scope", scope] : [])]);
	if (linked.code !== 0) throw new Error(`link failed: ${linked.out}`);
	beforeRun?.(m);
	const proc = spawn(process.execPath, [cli, "link", "run"], { env: m.env });
	let out = "";
	proc.stdout.on("data", (d) => (out += d));
	proc.stderr.on("data", (d) => (out += d));
	const device = {
		...m,
		proc,
		code,
		logs: () => out,
		kill: (signal = "SIGKILL") => proc.kill(signal),
		/** What link run last wrote about itself: connected, sessions, requests and streams in flight. */
		live: () => {
			try {
				return JSON.parse(readFileSync(m.file("link-live.json"), "utf8"));
			} catch {
				return undefined;
			}
		},
		async waitLive(predicate, what, timeoutMs = 15_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const live = this.live();
				if (live && predicate(live)) return live;
				await sleep(100);
			}
			throw new Error(`timed out waiting for ${what}: ${JSON.stringify(this.live())}`);
		},
	};
	if (wait) await hub.waitDevices((d) => d[name]?.online, `${name} to come online`);
	return device;
}

/** An MCP client through a URL with a bearer token. */
export async function connect(url, secret, extraHeaders = {}) {
	const client = new Client({ name: "hub-test", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}`, ...extraHeaders } } });
	await client.connect(transport);
	return { client, transport };
}

export function createToken(m, name, scopes) {
	const r = m.run(["token", "create", name, "--scope", scopes]);
	if (r.code !== 0) throw new Error(r.out);
	return /tkr_[A-Za-z0-9_-]+/.exec(r.out)[0];
}

/** A raw JSON-RPC POST, with any headers (the SDK client won't send a forged one). */
export async function rpc(url, secret, body, headers = {}) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
	let json;
	try {
		json = JSON.parse(data);
	} catch {
		json = undefined;
	}
	return { status: res.status, headers: res.headers, json, text };
}

export const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } } };

/** Initialize a raw session and list its tools. */
export async function rawTools(url, secret, headers = {}) {
	const init = await rpc(url, secret, INITIALIZE, headers);
	if (init.status !== 200) throw new Error(`initialize answered ${init.status}: ${init.text}`);
	const sessionId = init.headers.get("mcp-session-id");
	const list = await rpc(url, secret, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...headers, "mcp-session-id": sessionId });
	return { sessionId, status: list.status, tools: (list.json?.result?.tools ?? []).map((t) => t.name).sort() };
}

/** A GET with a chosen Host header (fetch won't send one). */
export function hostRequest(target, host, { method = "GET", path } = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(target);
		const req = httpRequest({ host: u.hostname, port: u.port, path: path ?? u.pathname, method, headers: { host } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode));
		});
		req.on("error", reject);
		req.end();
	});
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`);
export { rmSync };

export const DEFAULT_CAP = ["browser.read", "browser.navigate", "browser.act", "library.read", "library.write", "skills.read", "user.ask"];

/** A device that is only a WebSocket client with a real credential: it says what the test tells it to. */
export async function fakeDevice(hub, name, { scopes = DEFAULT_CAP, sessionCap = 24, busy = false, extensionConnected = true, answer = false, onReq } = {}) {
	const code = hub.json(["hub", "code", "--name", name, "--json"]).code;
	const enrolled = await (await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, version: "9.9.9" }) })).json();
	const ws = new WebSocket(`${hub.url.replace("http", "ws")}/link`, { headers: { authorization: `Bearer ${enrolled.deviceId}.${enrolled.secret}` } });
	const frames = [];
	let closed;
	ws.on("message", (data) => {
		const frame = JSON.parse(data.toString("utf8"));
		frames.push(frame);
		if (onReq && frame.t === "req") onReq(frame, ws, frames);
		// Answer like a device: an initialize gets a session id.
		if (answer && frame.t === "req" && frame.method === "POST") {
			ws.send(JSON.stringify({ t: "head", id: frame.id, status: 200, headers: { "content-type": "application/json", "mcp-session-id": randomUUID() } }));
			ws.send(JSON.stringify({ t: "chunk", id: frame.id, data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) }));
			ws.send(JSON.stringify({ t: "end", id: frame.id }));
		}
	});
	ws.on("close", (code) => {
		closed = code;
	});
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	ws.send(JSON.stringify({ t: "status", extensionConnected, sessions: 0, busy, version: "9.9.9", browser: null, sessionCap, scopes }));
	await hub.waitDevices((d) => d[name]?.online, `${name} to be ready`);
	return { ws, frames, name, closedCode: () => closed, reqs: () => frames.filter((f) => f.t === "req") };
}

