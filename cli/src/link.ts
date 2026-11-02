/**
 * `tabkyra link`: put this device behind a hub (D32). `link <hub-url> --code TK-XXXX-XXXX` enrolls
 * the device and installs a service that runs `link run`. `link run` starts the normal MCP server on
 * an ephemeral loopback port (no public URL) and dials the hub over a WebSocket; the hub sends it
 * MCP requests, it answers from its own browser. The device's cap is the scope list on its local
 * link token; the hub can narrow it per caller (remote.ts) and never widen it.
 */

import "./cjs-shim.ts";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";
import { BridgeClient } from "./client.ts";
import { readJsonFile, writeJsonPrivate } from "./files.ts";
import { launcherValid, tabkyraBinary } from "./harness.ts";
import {
	CHUNK_BYTES,
	FORWARD_REQUEST_HEADERS,
	FORWARD_RESPONSE_HEADERS,
	HEARTBEAT_MS,
	type Headers,
	MAX_FRAME_BYTES,
	MAX_INFLIGHT_PER_DEVICE,
	MAX_LINK_SESSIONS,
	parseHubFrame,
	type ReqFrame,
	SILENT_MS,
	type StatusFrame,
} from "./link-protocol.ts";
import { configDir, DEFAULT_GRANT, normalizePublicUrl } from "./oauth.ts";
import { createToken, HUB_CALLER_HEADER, HUB_SCOPES_HEADER, LINK_TOKEN_NAME, pruneLinkTokens, revokeLinkTokens, revokeToken, SCOPES, serve } from "./remote.ts";
import { installService, LINK_SERVICE, removeService, serviceFile, serviceLogHint } from "./service.ts";
import { splitText } from "./text-split.ts";
import { c, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

export interface LinkConfig {
	hubUrl: string;
	deviceId: string;
	secret: string;
	name: string;
	manage: boolean;
	/** The device's cap. Absent means DEFAULT_GRANT. */
	scopes?: string[];
	/** The owner marked this device busy: new sessions avoid it. */
	busy?: boolean;
}

export const linkFile = () => join(configDir(), "link.json");
const liveFile = () => join(configDir(), "link-live.json");
const pidFile = () => join(configDir(), "link.pid");

/**
 * One `link run` per device. The pid file is taken exclusively; a leftover from a crashed run (its pid
 * no longer alive) is replaced. A second run refuses instead of revoking the first one's token.
 */
async function takePidLock(): Promise<void> {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	// A run that just died may take a moment to leave the process table (its supervisor restarts us at once): wait up to 3 s before calling it alive.
	const giveUpAt = Date.now() + 3000;
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			writeFileSync(pidFile(), String(process.pid), { flag: "wx", mode: 0o600 });
			return;
		} catch {
			let other = 0;
			try {
				other = Number(readFileSync(pidFile(), "utf8").trim());
			} catch {
				/* vanished: try again */
			}
			let alive = false;
			if (Number.isInteger(other) && other > 0 && other !== process.pid) {
				try {
					process.kill(other, 0);
					alive = true;
				} catch (err) {
					// EPERM means the process exists but isn't ours to signal.
					alive = (err as NodeJS.ErrnoException).code === "EPERM";
				}
			}
			if (alive) {
				if (Date.now() < giveUpAt) {
					await sleep(100);
					continue;
				}
				throw new Error(`Another tabkyra link run is already running on this device (pid ${other}). Stop it first (tabkyra link off stops the service).`);
			}
			rmSync(pidFile(), { force: true });
		}
	}
	throw new Error(`Couldn't take ${pidFile()}.`);
}

export function loadLinkConfig(): LinkConfig | undefined {
	if (!existsSync(linkFile())) return undefined;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(linkFile(), "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`${linkFile()} isn't valid JSON. Run tabkyra link off to remove it, then link again.`);
	}
	const text = (v: unknown, field: string): string => {
		if (typeof v !== "string" || !v) throw new Error(`${linkFile()}: ${field} is missing.`);
		return v;
	};
	const scopes = Array.isArray(raw.scopes) && raw.scopes.every((x) => typeof x === "string") ? (raw.scopes as string[]) : undefined;
	return {
		hubUrl: text(raw.hubUrl, "hubUrl"),
		deviceId: text(raw.deviceId, "deviceId"),
		secret: text(raw.secret, "secret"),
		name: text(raw.name, "name"),
		manage: raw.manage === true,
		...(scopes ? { scopes } : {}),
		...(raw.busy === true ? { busy: true } : {}),
	};
}

/** The hub origin from what a person pasted: https (or http on loopback), a trailing /mcp is dropped. */
export function normalizeHubUrl(raw: string): string {
	return normalizePublicUrl(raw.replace(/\/mcp\/?$/, ""));
}

const capOf = (config: LinkConfig) => (config.scopes?.length ? config.scopes : DEFAULT_GRANT);

async function hubPost(config: { hubUrl: string }, path: string, body: unknown, credential?: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${config.hubUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	let parsed: Record<string, unknown> = {};
	try {
		parsed = (await res.json()) as Record<string, unknown>;
	} catch {
		/* not JSON */
	}
	return { status: res.status, body: parsed };
}

const describe = (body: Record<string, unknown>, status: number) => (typeof body.error_description === "string" ? body.error_description : `the hub answered ${status}`);

// ---------- link <hub-url> ----------

export interface EnrollOptions {
	hubUrl: string;
	code: string;
	name?: string;
	scopes?: string[];
	service: boolean;
	json: boolean;
}

export async function linkEnroll(options: EnrollOptions): Promise<number> {
	const say = (line: string) => {
		if (!options.json) console.log(line);
	};
	const fail = (message: string): number => {
		if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
		else console.error(`${sym.fail} ${message}`);
		return 1;
	};
	let existing: LinkConfig | undefined;
	try {
		existing = loadLinkConfig();
	} catch (err) {
		return fail(`${err instanceof Error ? err.message : String(err)} Nothing was changed.`);
	}
	if (existing) return fail(`This device is already linked to ${existing.hubUrl} as ${existing.name}. Run tabkyra link off first. Nothing was changed.`);
	const scopes = options.scopes?.length ? [...new Set(options.scopes)] : [...DEFAULT_GRANT];
	for (const s of scopes) if (!Object.hasOwn(SCOPES, s)) return fail(`Unknown scope ${s}. Scopes: ${Object.keys(SCOPES).join(", ")}.`);
	if (options.service && !launcherValid()) return fail(`${tabkyraBinary()} isn't a working launcher, so the service would have nothing to start. Run tabkyra install first, then link again (or pass --no-service). Nothing was changed.`);
	let result: Awaited<ReturnType<typeof hubPost>>;
	try {
		result = await hubPost(options, "/link/enroll", { code: options.code, name: options.name ?? hostname().split(".")[0], version: VERSION });
	} catch (err) {
		return fail(`Couldn't reach ${options.hubUrl}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const { deviceId, secret, manage, name } = result.body;
	if (result.status !== 200 || typeof deviceId !== "string" || typeof secret !== "string" || typeof name !== "string") return fail(`The hub refused: ${describe(result.body, result.status)}`);
	const config: LinkConfig = { hubUrl: options.hubUrl, deviceId, secret, name, manage: manage === true, scopes };
	writeJsonPrivate(linkFile(), config);
	say(`${sym.ok} Linked as ${c.bold(name)} (${deviceId})${config.manage ? ", a manager device" : ""}. Wrote ${c.dim(linkFile())}`);
	say(`${sym.dot} This device allows: ${scopes.join(", ")}`);
	let serviceMessage = "no service (run: tabkyra link run)";
	let serviceOk = true;
	if (options.service) {
		const service = await installService(LINK_SERVICE);
		serviceOk = service.ok;
		serviceMessage = service.message;
		say(`${service.ok ? sym.ok : sym.fail} ${service.message}`);
		if (!service.ok) say(`${sym.dot} link.json is kept. Fix the cause and run tabkyra link ${options.hubUrl} again after tabkyra link off, or start it yourself: tabkyra link run`);
	} else {
		say(`${sym.dot} No service installed. Start it yourself: ${c.bold("tabkyra link run")}`);
	}
	if (options.json) console.log(JSON.stringify({ ok: serviceOk, name, deviceId, manage: config.manage, scopes, service: serviceMessage }, null, 2));
	return serviceOk ? 0 : 1;
}

// ---------- link run ----------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The reconnect wait: 1 s doubling to 30 s, with up to a quarter of jitter either way. */
export function backoffMs(attempt: number): number {
	const base = Math.min(30_000, 1000 * 2 ** attempt);
	return Math.round(base * (0.75 + randomInt(0, 501) / 1000));
}

async function extensionConnected(): Promise<boolean> {
	const client = new BridgeClient({ name: "link-probe" });
	try {
		await client.connect(undefined, 2000);
		return client.extensionConnected;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

interface LiveState {
	pid: number;
	updatedAt: number;
	connected: boolean;
	lastConnectedAt: string | null;
	lastError: string | null;
	sessions: number;
	/** Requests (POST, DELETE) and GET streams being answered right now. */
	requests: number;
	streams: number;
	extensionConnected: boolean;
	busy: boolean;
}

/** Run until stopped: serve on loopback, dial the hub, answer its requests. */
export async function linkRun(): Promise<void> {
	const config = loadLinkConfig();
	if (!config) throw new Error(`${linkFile()} not found. Run tabkyra link <hub-url> --code <code> first.`);
	const wsUrl = `${config.hubUrl.replace(/^http/, "ws")}/link`;
	const cap = capOf(config);
	await takePidLock();
	// With the pid lock held no other run is alive: clear the old link tokens, then mint a fresh one, held in memory only.
	pruneLinkTokens();
	const { token, record: linkToken } = createToken(LINK_TOKEN_NAME, cap, "link");
	let sendStatus = () => {};
	const local = await serve({ port: 0, host: "127.0.0.1", acceptLinkTokens: true, onSessionsChange: () => sendStatus() });
	const localPort = Number(new URL(local.url).port);
	const live: LiveState = { pid: process.pid, updatedAt: Date.now(), connected: false, lastConnectedAt: null, lastError: null, sessions: 0, requests: 0, streams: 0, extensionConnected: false, busy: false };
	const writeLive = () => {
		live.updatedAt = Date.now();
		try {
			writeJsonPrivate(liveFile(), live);
		} catch {
			/* informational */
		}
	};
	let stopping = false;
	let ws: WebSocket | undefined;
	/** `initialize`: a POST that opens a session. `cancelled`: the hub gave up on it before its head came back. */
	interface Active {
		req: ReturnType<typeof httpRequest>;
		stream: boolean;
		initialize: boolean;
		headSeen: boolean;
		cancelled: boolean;
	}
	let active = new Map<string, Active>();
	const log = (line: string) => process.stderr.write(`[tabkyra link] ${line}\n`);

	const readBusy = (): boolean => {
		try {
			return loadLinkConfig()?.busy === true;
		} catch {
			return live.busy;
		}
	};

	const sendFrame = (socket: WebSocket, frame: unknown) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
	};

	/** Count what is being answered, apart for GET streams (one per session, held for the session's life) and requests. */
	const counts = () => {
		const streams = [...active.values()].filter((x) => x.stream).length;
		live.streams = streams;
		live.requests = active.size - streams;
		writeLive();
	};
	const forget = (id: string) => {
		if (active.delete(id)) counts();
	};

	/** DELETE a session on the local server with this run's own link token. */
	function closeLocalSession(sessionId: string): void {
		const req = httpRequest({ host: "127.0.0.1", port: localPort, path: "/mcp", method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId } }, (res) => res.resume());
		req.on("error", () => undefined);
		req.end();
	}

	function answer(socket: WebSocket, frame: ReqFrame): void {
		const id = frame.id;
		const stream = frame.method === "GET";
		const streams = [...active.values()].filter((x) => x.stream).length;
		const full = stream ? streams >= MAX_LINK_SESSIONS : active.size - streams >= MAX_INFLIGHT_PER_DEVICE;
		if (full || active.has(id)) return sendFrame(socket, { t: "error", id, message: "This device is handling too many requests." });
		// Only these headers reach the local server, whatever the hub sent; the bearer is this process's own link token.
		const headers: Record<string, string> = {};
		for (const name of [...FORWARD_REQUEST_HEADERS, HUB_SCOPES_HEADER, HUB_CALLER_HEADER]) if (frame.headers[name] !== undefined) headers[name] = frame.headers[name];
		headers.authorization = `Bearer ${token}`;
		const body = Buffer.from(frame.body, "utf8");
		if (body.length) headers["content-length"] = String(body.length);
		const entry: Active = { req: undefined as unknown as Active["req"], stream, initialize: frame.method === "POST" && frame.headers["mcp-session-id"] === undefined, headSeen: false, cancelled: false };
		const req = httpRequest({ host: "127.0.0.1", port: localPort, path: "/mcp", method: frame.method, headers }, (res) => {
			entry.headSeen = true;
			if (entry.cancelled) {
				// The hub gave up on this initialize before we answered, so it will never route the session the local server just made: close it.
				const orphan = res.headers["mcp-session-id"];
				if (typeof orphan === "string") closeLocalSession(orphan);
				res.resume();
				forget(id);
				return;
			}
			const out: Headers = {};
			for (const name of FORWARD_RESPONSE_HEADERS) {
				const v = res.headers[name];
				if (typeof v === "string") out[name] = v;
			}
			sendFrame(socket, { t: "head", id, status: res.statusCode ?? 502, headers: out });
			const decoder = new StringDecoder("utf8");
			const push = (text: string) => {
				for (const piece of splitText(text, CHUNK_BYTES)) sendFrame(socket, { t: "chunk", id, data: piece });
			};
			res.on("data", (chunk: Buffer) => {
				const text = decoder.write(chunk);
				if (text) push(text);
				// A slow hub link: stop reading the local answer until the socket drains.
				if (socket.bufferedAmount > 8_000_000) {
					res.pause();
					const wait = setInterval(() => {
						if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount < 1_000_000) {
							clearInterval(wait);
							res.resume();
						}
					}, 25);
				}
			});
			res.on("end", () => {
				const rest = decoder.end();
				if (rest) push(rest);
				sendFrame(socket, { t: "end", id });
				forget(id);
			});
			res.on("error", () => {
				sendFrame(socket, { t: "error", id, message: "The local server's answer was cut off." });
				forget(id);
			});
		});
		req.on("error", (err) => {
			if (!active.has(id)) return;
			sendFrame(socket, { t: "error", id, message: err.message.slice(0, 200) });
			forget(id);
		});
		entry.req = req;
		active.set(id, entry);
		counts();
		req.end(body);
	}

	/** One connection to the hub. Resolves when it ends, saying why. */
	function connectOnce(): Promise<{ replaced: boolean; stayedMs: number }> {
		return new Promise((resolve) => {
			const startedAt = Date.now();
			const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${config?.deviceId}.${config?.secret}` }, maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 15_000 });
			ws = socket;
			let lastHeard = Date.now();
			let heartbeat: NodeJS.Timeout | undefined;
			let probe: NodeJS.Timeout | undefined;
			let watch: NodeJS.Timeout | undefined;
			let replaced = false;
			let last = "";
			const status = async (force = false) => {
				if (socket.readyState !== WebSocket.OPEN) return;
				const frame: StatusFrame = { t: "status", extensionConnected: live.extensionConnected, sessions: local.sessionCount(), busy: live.busy, version: VERSION, browser: null, sessionCap: MAX_LINK_SESSIONS, scopes: cap };
				const key = JSON.stringify(frame);
				if (!force && key === last) return;
				last = key;
				live.sessions = frame.sessions;
				sendFrame(socket, frame);
				writeLive();
			};
			const refresh = async () => {
				live.extensionConnected = await extensionConnected();
				live.busy = readBusy();
				void status();
			};
			const cleanup = () => {
				clearInterval(heartbeat);
				clearInterval(probe);
				clearInterval(watch);
				for (const { req } of active.values()) req.destroy();
				active = new Map();
				// The hub forgot every session this connection carried, so nothing can reach them: close them,
				// or they sit on the device's session cap and keep their tab groups until the idle sweep.
				local.closeSessions();
				live.connected = false;
				live.requests = 0;
				live.streams = 0;
				writeLive();
			};
			socket.on("open", () => {
				live.connected = true;
				live.lastConnectedAt = new Date().toISOString();
				live.lastError = null;
				log(`linked to ${config?.hubUrl} as ${config?.name}`);
				sendStatus = () => void status();
				// Sessions from an earlier connection are gone from the hub's side; start clean.
				local.closeSessions();
				// Say what this device allows at once; the hub routes to it only after this frame.
				live.busy = readBusy();
				void status(true);
				void refresh().then(() => status(true));
				// A full heartbeat every 15 s, and a check for changes (the extension, the busy switch) every 5 s.
				heartbeat = setInterval(() => void status(true), HEARTBEAT_MS);
				probe = setInterval(() => void refresh(), 5000);
				// The hub pings every 20 s; a hub silent for a minute is gone.
				watch = setInterval(() => {
					if (Date.now() - lastHeard > SILENT_MS) socket.terminate();
				}, 10_000);
			});
			socket.on("ping", () => {
				lastHeard = Date.now();
			});
			socket.on("message", (data, isBinary) => {
				lastHeard = Date.now();
				if (isBinary) return;
				const frame = parseHubFrame(data.toString("utf8"));
				if (!frame) return;
				if (frame.t === "cancel") {
					const entry = active.get(frame.id);
					if (!entry) return;
					// An initialize still waiting for its head can't just be dropped: the local server goes on to make the session. Let it answer, then close what it made.
					if (entry.initialize && !entry.headSeen) {
						entry.cancelled = true;
						return;
					}
					entry.req.destroy();
					forget(frame.id);
					return;
				}
				answer(socket, frame);
			});
			socket.on("unexpected-response", (_req, res) => {
				live.lastError = `the hub answered ${res.statusCode}${res.statusCode === 401 ? " (this device's credential was refused; it may have been removed: tabkyra link off)" : ""}`;
				log(live.lastError);
				res.resume();
				socket.terminate();
			});
			socket.on("error", (err) => {
				live.lastError = err.message;
			});
			socket.on("close", (code) => {
				replaced = code === 4000;
				cleanup();
				resolve({ replaced, stayedMs: Date.now() - startedAt });
			});
		});
	}

	const stop = async () => {
		if (stopping) return;
		stopping = true;
		ws?.close(1000, "stopping");
		// Only this run's own token: a later run, or a lingering one, keeps its own.
		revokeToken(linkToken.id);
		rmSync(liveFile(), { force: true });
		rmSync(pidFile(), { force: true });
		await local.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
	writeLive();
	log(`serving locally on 127.0.0.1:${localPort}; cap ${cap.join(", ")}`);
	let attempt = 0;
	while (!stopping) {
		const { replaced, stayedMs } = await connectOnce();
		if (stopping) break;
		// A link that held for a while starts the backoff over.
		if (stayedMs > 30_000) attempt = 0;
		const wait = replaced ? 60_000 : backoffMs(attempt);
		attempt++;
		if (replaced) log("another link for this device replaced this one; waiting a minute before reconnecting");
		await sleep(wait);
	}
}

// ---------- link status / off / busy ----------

export interface LinkCheck {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

export async function linkStatus(json: boolean): Promise<number> {
	const checks: LinkCheck[] = [];
	let config: LinkConfig | undefined;
	try {
		config = loadLinkConfig();
	} catch (err) {
		checks.push({ name: "link.json", status: "fail", detail: err instanceof Error ? err.message : String(err) });
	}
	if (config) {
		checks.push({ name: "link.json", status: "ok", detail: `${config.name} (${config.deviceId}) on ${config.hubUrl}${config.manage ? ", manager" : ""}, allows ${capOf(config).join(",")}${config.busy ? ", marked busy" : ""}` });
		const file = serviceFile(LINK_SERVICE);
		checks.push({ name: "service", status: file && existsSync(file) ? "ok" : "warn", detail: file && existsSync(file) ? `${file}; log: ${serviceLogHint(LINK_SERVICE)}` : "no service installed; start it with tabkyra link run" });
		let state: LiveState | undefined;
		try {
			state = readJsonFile<LiveState | undefined>(liveFile(), undefined);
		} catch {
			state = undefined;
		}
		const fresh = state && Date.now() - state.updatedAt < 45_000;
		checks.push({
			name: "link",
			status: fresh && state?.connected ? "ok" : "fail",
			detail: fresh && state ? (state.connected ? `connected since ${state.lastConnectedAt}; ${state.sessions} session(s); extension ${state.extensionConnected ? "connected" : "not connected"}` : `not connected${state.lastError ? `: ${state.lastError}` : ""}`) : "tabkyra link run isn't running on this device",
		});
		try {
			const res = await fetch(`${config.hubUrl}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(8000) });
			checks.push({ name: "hub", status: res.ok ? "ok" : "fail", detail: `${config.hubUrl} answered ${res.status}` });
		} catch (err) {
			checks.push({ name: "hub", status: "fail", detail: `${config.hubUrl} didn't answer: ${err instanceof Error ? err.message : String(err)}` });
		}
	} else if (!checks.length) {
		checks.push({ name: "link.json", status: "fail", detail: `${linkFile()} not found. Run tabkyra link <hub-url> --code <code>.` });
	}
	const ok = checks.every((x) => x.status !== "fail");
	if (json) {
		console.log(JSON.stringify({ ok, hubUrl: config?.hubUrl ?? null, name: config?.name ?? null, checks }, null, 2));
		return ok ? 0 : 1;
	}
	for (const check of checks) console.log(`${check.status === "ok" ? sym.ok : check.status === "warn" ? sym.warn : sym.fail} ${check.name.padEnd(9)} ${c.dim(check.detail)}`);
	return ok ? 0 : 1;
}

export async function linkOff(): Promise<number> {
	let config: LinkConfig | undefined;
	try {
		config = loadLinkConfig();
	} catch (err) {
		console.log(`${sym.warn} ${err instanceof Error ? err.message : String(err)}`);
	}
	const service = removeService(LINK_SERVICE);
	if (!service.ok) {
		console.error(`${sym.fail} ${service.failure}`);
		return 1;
	}
	for (const note of service.notes) console.log(`${sym.ok} ${note}`);
	const n = revokeLinkTokens();
	if (n) console.log(`${sym.ok} Revoked the local link token.`);
	rmSync(pidFile(), { force: true });
	rmSync(linkFile(), { force: true });
	rmSync(liveFile(), { force: true });
	console.log(config ? `${sym.ok} Removed ${c.dim(linkFile())}. The hub still lists ${config.name} until you run: tabkyra hub remove ${config.name}` : `${sym.dot} No link.json; nothing else to remove.`);
	return 0;
}

export function linkBusy(value: string | undefined): number {
	if (value !== "on" && value !== "off") {
		console.error("Usage: tabkyra link busy on|off");
		return 2;
	}
	const config = loadLinkConfig();
	if (!config) {
		console.error(`${sym.fail} This device isn't linked. Run tabkyra link <hub-url> --code <code>.`);
		return 1;
	}
	const { busy: _old, ...rest } = config;
	writeJsonPrivate(linkFile(), value === "on" ? { ...rest, busy: true } : rest);
	console.log(value === "on" ? `${sym.ok} Marked busy: the hub sends new sessions to your other devices first.` : `${sym.ok} Not busy: the hub may send new sessions here.`);
	return 0;
}

// ---------- link code / approval-code ----------

export async function linkMintCode(kind: "connect" | "approval", options: { manage: boolean; json: boolean }): Promise<number> {
	const config = loadLinkConfig();
	const fail = (message: string): number => {
		if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
		else console.error(`${sym.fail} ${message}`);
		return 1;
	};
	if (!config) return fail("This device isn't linked. Run tabkyra link <hub-url> --code <code>.");
	if (!config.manage) return fail("This device isn't a manager, so it can't ask the hub for codes. Link it with a code from tabkyra hub code --manage, or run the command on the hub.");
	let result: Awaited<ReturnType<typeof hubPost>>;
	try {
		result = await hubPost(config, "/link/code", { kind, manage: options.manage }, `${config.deviceId}.${config.secret}`);
	} catch (err) {
		return fail(`Couldn't reach ${config.hubUrl}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const { code, expiresAt, url } = result.body;
	if (result.status !== 200 || typeof code !== "string" || typeof expiresAt !== "number") return fail(`The hub refused: ${describe(result.body, result.status)}`);
	if (options.json) {
		console.log(JSON.stringify({ ok: true, kind, code, expiresAt, ...(typeof url === "string" ? { url } : {}) }, null, 2));
		return 0;
	}
	printCode(kind, code, expiresAt, typeof url === "string" ? url : undefined, config.hubUrl);
	return 0;
}

/** The code, once, with what to do next. Shared with the hub's own commands. */
export function printCode(kind: "connect" | "approval", code: string, expiresAt: number, url: string | undefined, hubUrl?: string): void {
	const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
	console.log(`${sym.ok} ${kind === "approval" ? "Connect code for an assistant" : "Connect code for a device"}:\n\n  ${code}\n`);
	if (kind === "approval") {
		console.log(`Paste ${c.bold(url ?? "<hub URL>/mcp")} into claude.ai, ChatGPT or grok.com as a custom connector. When the approval page asks for a passcode, enter this code instead.`);
	} else {
		console.log(`On the other device: ${c.bold(`tabkyra link ${hubUrl ?? "<hub URL>"} --code ${code}`)}`);
	}
	console.log(c.dim(`Shown once. Works one time, for ${minutes} minutes.`));
}
