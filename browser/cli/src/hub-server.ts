/**
 * `tabkyra hub serve`: one connector URL for many devices (D32). The hub answers the same OAuth
 * endpoints and consent page as `serve --public-url`, authenticates /mcp the same way, and then
 * proxies each MCP session to one of the owner's devices, which dial in over a WebSocket (/link)
 * from behind their own NATs. It needs no browser. Single-owner, like every install (D31).
 *
 * What crosses the hop: the caller's scopes and name, in two headers the hub always sets itself
 * (anything a public client sends under x-tabkyra-hub-* is dropped), and the MCP request. The
 * device narrows its own cap by those scopes (remote.ts), so a caller never gets more than both
 * the owner's grant and that device's cap allow. Device credentials and connect codes are stored
 * as SHA-256 only.
 */

import "./cjs-shim.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { CodeLimitError, REQUEST_LOCK_MS } from "./codes.ts";
import { LockTimeoutError } from "./files.ts";
import {
	authenticateDevice,
	type DeviceRecord,
	devicesReadable,
	HubStateError,
	type LiveDevice,
	loadDevices,
	mintConnectCode,
	redeemConnectCode,
	touchDevice,
	writeLive,
} from "./hub-state.ts";
import {
	type DeviceFrame,
	FORWARD_REQUEST_HEADERS,
	FORWARD_RESPONSE_HEADERS,
	type Headers,
	MAX_BODY_BYTES,
	MAX_FRAME_BYTES,
	MAX_INFLIGHT_PER_DEVICE,
	MAX_LINK_SESSIONS,
	parseDeviceFrame,
	PING_MS,
	type ReqFrame,
	SILENT_MS,
	type StatusFrame,
} from "./link-protocol.ts";
import { handleOAuth, readBody, requestSource, sendJson } from "./oauth-http.ts";
import { liveGrantIds, mintApprovalCode, normalizePublicUrl, type OAuthConfig, resourceMetadataUrl, verifyAccessToken } from "./oauth.ts";
import { authenticate, HUB_CALLER_HEADER, HUB_SCOPES_HEADER, loadTokens, SCOPES, safeCallerName } from "./remote.ts";
import { pageCss } from "./theme.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS_PER_CALLER = 8;
/** How long a device may take to start answering. Once the head arrives, a response may stream for as long as it likes. */
const DEFAULT_HEAD_TIMEOUT_MS = 120_000;
/** How long a public client may leave the hub's write to it unfinished before the request is cancelled. */
const DEFAULT_SLOW_CLIENT_MS = 30_000;
/** Most response bytes the hub holds for one request that its client is not reading. */
const MAX_QUEUED_BYTES = 16_000_000;
/** Initialize requests whose bodies are still arriving, hub-wide. Per caller, the session cap bounds them. */
const MAX_INIT_READERS = 64;
const SESSION_ID = /^[\x21-\x7e]{1,128}$/;

export interface HubOptions {
	port: number;
	host?: string;
	publicUrl: string;
	redirectHosts?: string[];
	allowedHosts?: string[];
	/** The wait for a device's response head (default 120 s). Tests shorten it. */
	headTimeoutMs?: number;
	/** How long a client may stall reading a response before the request is cancelled (default 30 s). Tests shorten it. */
	slowClientMs?: number;
	onListen?: (url: string) => void;
}

interface Pending {
	res?: ServerResponse;
	/** A long-lived GET event stream: counted apart from requests. */
	stream: boolean;
	headSent: boolean;
	done: boolean;
	timer: NodeJS.Timeout;
	/** The client isn't keeping up: the link is paused until it drains, or this timer cancels the request. */
	slowTimer?: NodeJS.Timeout;
	onHead?: (status: number, headers: Headers) => void;
	onDone?: () => void;
}

interface Link {
	instance: number;
	device: DeviceRecord;
	ws: WebSocket;
	lastSeen: number;
	connectedAt: number;
	status: Omit<StatusFrame, "t">;
	/** False until the first status frame says what this device allows. Not routable before that. */
	ready: boolean;
	inflight: Map<string, Pending>;
	/** POST and DELETE requests in flight, GET streams in flight, and request slots held while a body is still arriving. */
	calls: number;
	streams: number;
	reserved: number;
	/** Requests whose clients are not reading. While any, the link is not read, so the hub holds no more than a frame of their data. */
	blocked: Set<string>;
	/** initialize requests sent and not yet finished: load the device hasn't reported. */
	initsPending: number;
}

interface HubSession {
	deviceId: string;
	linkInstance: number;
	callerId: string;
	lastSeen: number;
	/** The session's one standalone GET stream is open. */
	streamOpen: boolean;
}

interface Caller {
	id: string;
	name: string;
	scopes: string[];
}

/**
 * Counts failures per source over 15 minutes. The global cap bounds guessing of the 40-bit connect
 * codes even when sources are forged (it is the one place it is used: an attacker can lock enrollment
 * for everyone, which is accepted; devices and managers are never refused by it). A device
 * credential has 256 bits, so its limiter has no global cap, only a per-source one on failures.
 * Kept per source, so a check costs the source's own few entries, never the whole history.
 */
class FailureLimiter {
	private readonly bySource = new Map<string, number[]>();
	private readonly all: number[] = [];
	constructor(
		private readonly perSource: number,
		private readonly global = Number.POSITIVE_INFINITY,
	) {}
	private recent(source: string): number[] | undefined {
		const cutoff = Date.now() - 15 * 60_000;
		const mine = this.bySource.get(source);
		if (mine) {
			while (mine.length && mine[0] < cutoff) mine.shift();
			if (!mine.length) this.bySource.delete(source);
		}
		while (this.all.length && this.all[0] < cutoff) this.all.shift();
		return mine?.length ? mine : undefined;
	}
	blocked(source: string): boolean {
		return (this.recent(source)?.length ?? 0) >= this.perSource || this.all.length >= this.global;
	}
	fail(source: string): void {
		const mine = this.recent(source);
		const now = Date.now();
		if (mine) mine.push(now);
		else {
			// Bounded memory under a flood from many sources: forget the oldest source.
			if (this.bySource.size >= 50_000) this.bySource.delete(this.bySource.keys().next().value as string);
			this.bySource.set(source, [now]);
		}
		if (Number.isFinite(this.global)) this.all.push(now);
	}
}

export interface HubHandle {
	url: string;
	port: number;
	close: () => Promise<void>;
}

const bearer = (header: string | undefined) => /^Bearer (\S+)$/.exec(header ?? "")?.[1];

export async function startHub(options: HubOptions): Promise<HubHandle> {
	const host = options.host ?? "127.0.0.1";
	if (!LOOPBACK_HOSTS.has(host)) throw new Error(`tabkyra hub serve binds to loopback only (got ${host}). Put an HTTPS front door in front of it.`);
	const oauth: OAuthConfig = { publicUrl: options.publicUrl, redirectHosts: options.redirectHosts ?? [], scopes: SCOPES };
	const links = new Map<string, Link>();
	// The live snapshot (hub devices) shows each device's sessions, so a change to this map refreshes it.
	const sessions = new (class extends Map<string, HubSession> {
		override set(key: string, value: HubSession): this {
			super.set(key, value);
			snapshotSoon();
			return this;
		}
		override delete(key: string): boolean {
			const had = super.delete(key);
			if (had) snapshotSoon();
			return had;
		}
	})();
	const callerInits = new Map<string, number>();
	const enrollLimit = new FailureLimiter(5, 20);
	const authLimit = new FailureLimiter(30);
	const headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
	const slowClientMs = options.slowClientMs ?? DEFAULT_SLOW_CLIENT_MS;
	let initReaders = 0;
	let counter = 0;
	let instances = 0;
	const challenge = `Bearer realm="tabkyra", resource_metadata="${resourceMetadataUrl(oauth)}"`;

	const deny = (res: ServerResponse, status: number, message: string): void => {
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": challenge } : {}) });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
	};

	const http: Server = createServer((req, res) => {
		handle(req, res).catch((err) => {
			process.stderr.write(`[tabkyra hub] ${err instanceof Error ? err.message : String(err)}\n`);
			if (!res.headersSent) deny(res, 500, "Internal error.");
			else res.end();
		});
	});
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

	const port = () => {
		const address = http.address();
		return typeof address === "object" && address ? address.port : options.port;
	};
	const hostAllowed = (req: IncomingMessage) => {
		const given = String(req.headers.host ?? "").toLowerCase();
		const allowed = new Set([new URL(options.publicUrl).host, `127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`, ...(options.allowedHosts ?? []).map((h) => h.toLowerCase())]);
		return allowed.has(given);
	};

	/** A static token, or a live OAuth access token. A link-kind token is never a caller here. */
	function caller(header: string | undefined): Caller | undefined {
		const record = authenticate(header);
		if (record) return record.kind === "link" ? undefined : { id: record.id, name: record.name, scopes: record.scopes };
		const given = bearer(header);
		return given ? verifyAccessToken(oauth, given) : undefined;
	}

	// ---------- Links ----------

	function finish(link: Link, id: string): void {
		const p = link.inflight.get(id);
		if (!p || p.done) return;
		p.done = true;
		clearTimeout(p.timer);
		unblock(link, id, p);
		link.inflight.delete(id);
		if (p.stream) link.streams--;
		else link.calls--;
		p.onDone?.();
	}

	/** The hub gives up on a request that hasn't ended: answer the public client if it can still be answered, and tell the device to stop. */
	function failPending(link: Link, id: string, status: number, message: string): void {
		const p = link.inflight.get(id);
		if (!p || p.done) return;
		if (p.res && !p.headSent) deny(p.res, status, message);
		else p.res?.destroy();
		sendTo(link, { t: "cancel", id });
		finish(link, id);
	}

	/** The client of request `id` isn't reading: stop reading the link until it drains, and cancel the request if it stays that way. */
	function block(link: Link, id: string, p: Pending): void {
		if (p.slowTimer || p.done) return;
		link.blocked.add(id);
		link.ws.pause();
		p.slowTimer = setTimeout(() => failPending(link, id, 504, "The client isn't reading the response."), slowClientMs);
		p.slowTimer.unref();
		p.res?.once("drain", () => unblock(link, id, p));
	}

	function unblock(link: Link, id: string, p: Pending): void {
		if (!p.slowTimer) return;
		clearTimeout(p.slowTimer);
		p.slowTimer = undefined;
		link.blocked.delete(id);
		if (!link.blocked.size && link.ws.readyState === WebSocket.OPEN) link.ws.resume();
	}

	function sendText(link: Link, text: string, onError?: () => void): void {
		if (link.ws.readyState !== WebSocket.OPEN) return onError?.();
		link.ws.send(text, (err) => {
			if (err) onError?.();
		});
	}

	function sendTo(link: Link, frame: unknown, onError?: () => void): void {
		sendText(link, JSON.stringify(frame), onError);
	}

	/** Send one request over a link and stream the answer back to `res`. */
	function forward(link: Link, request: { method: ReqFrame["method"]; headers: Headers; body: string; res?: ServerResponse; stream?: boolean; onHead?: Pending["onHead"]; onDone?: () => void }): void {
		const id = `r${++counter}`;
		const frame: ReqFrame = { t: "req", id, method: request.method, path: "/mcp", headers: request.headers, body: request.body };
		const text = JSON.stringify(frame);
		// Escaping can grow a body past the frame limit. Refuse this request; the link and its other requests are untouched.
		if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
			if (request.res) deny(request.res, 413, "This request is too large to forward to a device.");
			request.onDone?.();
			return;
		}
		const timer = setTimeout(() => failPending(link, id, 504, "The device didn't answer in time."), headTimeoutMs);
		timer.unref();
		const stream = request.stream === true;
		const p: Pending = { res: request.res, stream, headSent: false, done: false, timer, onHead: request.onHead, onDone: request.onDone };
		link.inflight.set(id, p);
		if (stream) link.streams++;
		else link.calls++;
		request.res?.on("close", () => {
			// The public client went away before the answer ended: tell the device to stop.
			if (p.done) return;
			sendTo(link, { t: "cancel", id });
			finish(link, id);
		});
		sendText(link, text, () => failPending(link, id, 502, "The device link dropped."));
	}

	function onDeviceFrame(link: Link, frame: DeviceFrame): void {
		if (frame.t === "status") {
			const versionChanged = link.status.version !== frame.version;
			link.status = { extensionConnected: frame.extensionConnected, sessions: frame.sessions, busy: frame.busy, version: frame.version, browser: frame.browser, sessionCap: frame.sessionCap, scopes: frame.scopes };
			link.ready = true;
			// touchDevice never throws and waits only briefly for its lock.
			if (versionChanged) touchDevice(link.device.id, { version: frame.version });
			snapshotSoon();
			return;
		}
		const p = link.inflight.get(frame.id);
		if (!p || p.done) {
			// The hub gave up on this request (client gone, timeout) but the device answered: if that created a session, nothing maps it, so close it.
			if (frame.t === "head") discardLateHead(link, frame.status, frame.headers);
			return;
		}
		if (frame.t === "head") {
			if (p.headSent) return;
			p.headSent = true;
			// The timer only waits for the head; a response may stream for hours after it.
			clearTimeout(p.timer);
			// A device that rejects the hub's own credential is a setup fault, not the caller's 401.
			const status = frame.status === 401 ? 502 : frame.status;
			p.onHead?.(status, frame.headers);
			if (p.res) {
				const out: Record<string, string> = {};
				for (const k of FORWARD_RESPONSE_HEADERS) if (frame.headers[k]) out[k] = frame.headers[k];
				if (status === 502 && frame.status === 401) {
					deny(p.res, 502, "This device refused the hub's link token. Run tabkyra link off and link again on it.");
					finish(link, frame.id);
					return;
				}
				if (out["content-type"]?.startsWith("text/event-stream")) {
					out["x-accel-buffering"] = "no";
					out["cache-control"] ??= "no-cache";
				}
				p.res.writeHead(status, out);
				p.res.flushHeaders();
			}
			return;
		}
		if (frame.t === "chunk") {
			if (!p.headSent || !p.res) return;
			const ok = p.res.write(frame.data);
			// Past the bound, or stalled: stop holding the client's data for it.
			if (p.res.writableLength > MAX_QUEUED_BYTES) failPending(link, frame.id, 502, "The client isn't reading the response.");
			else if (!ok) block(link, frame.id, p);
			return;
		}
		if (frame.t === "end") {
			if (!p.headSent) failPending(link, frame.id, 502, "The device answered with nothing.");
			else {
				p.res?.end();
				finish(link, frame.id);
			}
			return;
		}
		if (frame.t === "error") failPending(link, frame.id, 502, `The device reported an error: ${frame.message}`);
	}

	/** A head for a request the hub no longer tracks. If it carries a session id the hub doesn't route, tell the device to close that session. */
	function discardLateHead(link: Link, status: number, headers: Headers): void {
		const id = headers["mcp-session-id"];
		if (status < 200 || status >= 300 || !id || !SESSION_ID.test(id) || sessions.has(id)) return;
		forward(link, { method: "DELETE", headers: { "mcp-session-id": id, [HUB_SCOPES_HEADER]: "", [HUB_CALLER_HEADER]: "hub" }, body: "" });
	}

	function dropLink(link: Link, reason: string): void {
		if (links.get(link.device.id) === link) links.delete(link.device.id);
		for (const id of [...link.inflight.keys()]) failPending(link, id, 502, reason);
		for (const [sid, s] of sessions) if (s.deviceId === link.device.id && s.linkInstance === link.instance) sessions.delete(sid);
		touchDevice(link.device.id, { lastSeen: new Date().toISOString() });
		snapshotSoon();
	}

	function onLink(ws: WebSocket, device: DeviceRecord): void {
		const previous = links.get(device.id);
		const link: Link = {
			instance: ++instances,
			device,
			ws,
			lastSeen: Date.now(),
			connectedAt: Date.now(),
			status: { extensionConnected: false, sessions: 0, busy: false, version: "", browser: null, sessionCap: MAX_LINK_SESSIONS, scopes: [] },
			ready: false,
			inflight: new Map(),
			calls: 0,
			streams: 0,
			reserved: 0,
			blocked: new Set(),
			initsPending: 0,
		};
		// One live link per device: a new one replaces the old.
		if (previous) {
			links.delete(device.id);
			previous.ws.close(4000, "replaced");
			dropLink(previous, "The device reconnected.");
		}
		links.set(device.id, link);
		// Informational: touchDevice never throws, and a held lock costs a moment, not the hub.
		touchDevice(device.id, { lastSeen: new Date().toISOString() });
		ws.on("message", (data: RawData, isBinary: boolean) => {
			if (isBinary) return ws.close(1003, "text frames only");
			link.lastSeen = Date.now();
			const frame = parseDeviceFrame(data.toString("utf8"));
			if (frame) onDeviceFrame(link, frame);
		});
		ws.on("pong", () => {
			link.lastSeen = Date.now();
		});
		ws.on("close", () => dropLink(link, "The device went offline."));
		ws.on("error", () => ws.terminate());
		snapshotSoon();
	}

	// ---------- Routing ----------

	type Pick = { link: Link } | { status: number; message: string };

	/**
	 * The device for a new session. Candidates are online devices that have reported (so their cap is
	 * known), allow at least one of the caller's scopes, and have room (requests, and sessions under
	 * their own cap). Of those, ones with the extension connected win, then full scope coverage, not
	 * busy, fewest sessions, `prefer` order, most recently seen.
	 */
	function pickLink(who: Caller): Pick {
		const online = [...links.values()].filter((l) => l.ws.readyState === WebSocket.OPEN && l.ready);
		if (!online.length) return { status: 503, message: offlineMessage() };
		const wanted = who.scopes.filter((x) => Object.hasOwn(SCOPES, x));
		const covers = (l: Link) => wanted.filter((x) => l.status.scopes.includes(x)).length;
		const fits = online.filter((l) => covers(l) > 0);
		if (!fits.length) {
			const caps = online.map((l) => `${l.device.name}: ${l.status.scopes.join(", ") || "nothing"}`).join("; ");
			return { status: 403, message: `None of the permissions you granted are allowed on any online device (${caps}).` };
		}
		const known = (l: Link) => [...sessions.values()].filter((x) => x.deviceId === l.device.id).length;
		const load = (l: Link) => Math.max(l.status.sessions, known(l)) + l.initsPending;
		const roomy = fits.filter((l) => l.calls + l.reserved < MAX_INFLIGHT_PER_DEVICE && load(l) < l.status.sessionCap);
		if (!roomy.length) return { status: 429, message: "Every device that can serve you is at its limit. Close a session or try again in a moment." };
		const prefer = loadDevices().prefer;
		const withExtension = roomy.filter((l) => l.status.extensionConnected);
		const pool = withExtension.length ? withExtension : roomy;
		const rank = (l: Link) => {
			const i = prefer.indexOf(l.device.name);
			return i < 0 ? Number.MAX_SAFE_INTEGER : i;
		};
		const partial = (l: Link) => Number(covers(l) < wanted.length);
		const best = [...pool].sort((a, b) => partial(a) - partial(b) || Number(a.status.busy) - Number(b.status.busy) || load(a) - load(b) || rank(a) - rank(b) || b.lastSeen - a.lastSeen)[0];
		return { link: best };
	}

	function offlineMessage(): string {
		const devices = loadDevices().devices;
		if (!devices.length) return "No device is linked to this hub. Run tabkyra hub code, then tabkyra link on a device.";
		const lines = devices.map((d) => `${d.name}: ${links.has(d.id) ? "online" : d.lastSeen ? `offline, last seen ${d.lastSeen}` : "never connected"}`);
		return `No device is online. ${lines.join("; ")}.`;
	}

	function requestHeaders(req: IncomingMessage, who: Caller): Headers {
		const out: Headers = {};
		// Built from a short list, so nothing a public client sends under x-tabkyra-hub-* (or anything else) can pass.
		for (const name of FORWARD_REQUEST_HEADERS) {
			const v = req.headers[name];
			if (typeof v === "string" && v && !/[\r\n\0]/.test(v)) out[name] = v;
		}
		out[HUB_SCOPES_HEADER] = who.scopes.filter((s) => Object.hasOwn(SCOPES, s)).join(",");
		out[HUB_CALLER_HEADER] = safeCallerName(who.name) || "caller";
		return out;
	}

	async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const who = caller(req.headers.authorization);
		if (!who) return deny(res, 401, "Connect with OAuth or a valid, unrevoked bearer token.");
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "POST" && method !== "DELETE") return deny(res, 405, "Method not allowed.");
		const sessionId = req.headers["mcp-session-id"];
		if (typeof sessionId === "string") {
			const session = sessions.get(sessionId);
			if (!session) return deny(res, 404, "Unknown or expired session. Start a new one with an initialize request.");
			// A session belongs to the caller that opened it; another can't ride on it.
			if (session.callerId !== who.id) return deny(res, 403, "This session belongs to another token.");
			const link = links.get(session.deviceId);
			if (!link || link.instance !== session.linkInstance) {
				sessions.delete(sessionId);
				return deny(res, 404, "Unknown or expired session. Start a new one with an initialize request.");
			}
			// A GET is the session's one long-lived event stream and has its own budget. A POST or DELETE takes
			// a request slot now, before its body arrives, so slow bodies can't pile past the device's limit.
			const stream = method === "GET";
			if (stream) {
				if (session.streamOpen) return deny(res, 409, "This session already has an open event stream.");
				if (link.streams >= MAX_LINK_SESSIONS) return deny(res, 429, "This device has too many open event streams.");
				session.streamOpen = true;
			} else {
				if (link.calls + link.reserved >= MAX_INFLIGHT_PER_DEVICE) return deny(res, 429, "This device is handling too many requests. Try again in a moment.");
				link.reserved++;
			}
			let reserved = !stream;
			const release = () => {
				if (reserved) {
					reserved = false;
					link.reserved--;
				}
				if (stream) session.streamOpen = false;
			};
			session.lastSeen = Date.now();
			let body = "";
			try {
				body = method === "POST" ? await readBody(req, MAX_BODY_BYTES) : "";
			} catch {
				release();
				return deny(res, 413, "Request body too large.");
			}
			// The link may have gone while the body arrived.
			if (links.get(session.deviceId) !== link || link.ws.readyState !== WebSocket.OPEN) {
				release();
				return deny(res, 404, "Unknown or expired session. Start a new one with an initialize request.");
			}
			if (reserved) {
				reserved = false;
				link.reserved--;
			}
			return forward(link, {
				method,
				headers: requestHeaders(req, who),
				body,
				res,
				stream,
				onHead: (status) => {
					if (method === "DELETE" && (status < 300 || status === 404)) sessions.delete(sessionId);
					if (status === 404) sessions.delete(sessionId);
				},
				onDone: stream ? () => release() : undefined,
			});
		}
		if (method !== "POST") return deny(res, 400, "Start a session with an initialize POST.");
		// Reserve before reading the body: a caller's open sessions plus initializes still arriving are capped, and so are
		// all of them together, so slow unfinished bodies can't pile up in memory.
		const open = [...sessions.values()].filter((s) => s.callerId === who.id).length + (callerInits.get(who.id) ?? 0);
		if (open >= MAX_SESSIONS_PER_CALLER) return deny(res, 429, `This token already has ${MAX_SESSIONS_PER_CALLER} open sessions. Close one first.`);
		if (initReaders >= MAX_INIT_READERS) return deny(res, 429, "The hub is busy starting sessions. Try again in a moment.");
		callerInits.set(who.id, (callerInits.get(who.id) ?? 0) + 1);
		initReaders++;
		let held = true;
		const releaseInit = () => {
			if (!held) return;
			held = false;
			initReaders--;
			callerInits.set(who.id, Math.max(0, (callerInits.get(who.id) ?? 1) - 1));
		};
		let body: string;
		let parsed: unknown;
		try {
			body = await readBody(req, MAX_BODY_BYTES);
			parsed = JSON.parse(body);
		} catch {
			releaseInit();
			return deny(res, 400, "The request body isn't valid JSON.");
		}
		// Only an initialize request creates a session.
		if (!isInitializeRequest(parsed)) {
			releaseInit();
			return deny(res, 400, "Start a session with an initialize request.");
		}
		const picked = pickLink(who);
		if (!("link" in picked)) {
			releaseInit();
			return deny(res, picked.status, picked.message);
		}
		const link = picked.link;
		link.initsPending++;
		forward(link, {
			method: "POST",
			headers: requestHeaders(req, who),
			body,
			res,
			onHead: (status, headers) => {
				const id = headers["mcp-session-id"];
				// A device can't take over a session id the hub already routes.
				if (status >= 200 && status < 300 && id && SESSION_ID.test(id) && !sessions.has(id)) {
					sessions.set(id, { deviceId: link.device.id, linkInstance: link.instance, callerId: who.id, lastSeen: Date.now(), streamOpen: false });
				}
			},
			onDone: () => {
				link.initsPending = Math.max(0, link.initsPending - 1);
				releaseInit();
			},
		});
	}

	// ---------- Enrollment and codes ----------

	async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
		try {
			const value = JSON.parse(await readBody(req, 8_000)) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {
			/* fall through */
		}
		sendJson(res, 400, { error: "invalid_request", error_description: "The body must be a small JSON object." });
		return undefined;
	}

	async function handleEnroll(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
		const source = requestSource(req);
		// The code carries 40 bits; the caps bound guessing even when the source header is forged.
		if (enrollLimit.blocked(source)) return sendJson(res, 429, { error: "temporarily_unavailable", error_description: "Too many wrong connect codes. Wait 15 minutes." });
		const body = await readJsonBody(req, res);
		if (!body) return;
		const code = typeof body.code === "string" ? body.code : "";
		const name = typeof body.name === "string" ? body.name.trim() : "";
		try {
			const made = redeemConnectCode(code, name || "device");
			if (!made) {
				enrollLimit.fail(source);
				return sendJson(res, 401, { error: "invalid_code", error_description: "That connect code is wrong, expired or already used. Run tabkyra hub code for a new one." });
			}
			if (typeof body.version === "string") touchDevice(made.record.id, { version: body.version.slice(0, 40) });
			return sendJson(res, 200, { deviceId: made.record.id, secret: made.credential.slice(made.record.id.length + 1), manage: made.record.manage, name: made.record.name });
		} catch (err) {
			if (err instanceof HubStateError) return sendJson(res, err.status, { error: "invalid_request", error_description: err.message });
			throw err;
		}
	}

	async function handleCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
		// A valid credential is never refused by anyone else's failures: check it first, throttle only failures.
		const source = requestSource(req);
		const device = authenticateDevice(bearer(req.headers.authorization));
		if (!device) {
			if (authLimit.blocked(source)) return sendJson(res, 429, { error: "temporarily_unavailable", error_description: "Too many failed attempts from this address. Wait 15 minutes." });
			authLimit.fail(source);
			return sendJson(res, 401, { error: "invalid_token", error_description: "This device's credential is not valid." });
		}
		// Only a manager device mints codes.
		if (!device.manage) return sendJson(res, 403, { error: "forbidden", error_description: "This device is not a manager. Link it with a code from tabkyra hub code --manage." });
		const body = await readJsonBody(req, res);
		if (!body) return;
		try {
			if (body.kind === "approval") {
				const { code, expiresAt } = mintApprovalCode(REQUEST_LOCK_MS);
				return sendJson(res, 200, { kind: "approval", code, expiresAt, url: `${options.publicUrl}/mcp` });
			}
			if (body.kind === "connect") {
				const { code, expiresAt } = mintConnectCode({ name: typeof body.name === "string" && body.name ? body.name : undefined, manage: body.manage === true }, Date.now(), REQUEST_LOCK_MS);
				return sendJson(res, 200, { kind: "connect", code, expiresAt, hubUrl: hubOrigin(options.publicUrl) });
			}
		} catch (err) {
			if (err instanceof HubStateError) return sendJson(res, err.status, { error: "invalid_request", error_description: err.message });
			// Only the "codes already waiting" limit is a limit. A held lock is busy; anything else is a fault, logged and answered 500 by the caller.
			if (err instanceof CodeLimitError) return sendJson(res, 429, { error: "temporarily_unavailable", error_description: err.message });
			if (err instanceof LockTimeoutError) return sendJson(res, 503, { error: "temporarily_unavailable", error_description: "The hub is busy. Try again in a moment." });
			throw err;
		}
		sendJson(res, 400, { error: "invalid_request", error_description: "kind is connect or approval." });
	}

	function homePage(res: ServerResponse): void {
		const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabkyra hub</title><style>${pageCss()}</style></head><body><main><h1>Tabkyra hub</h1><p class="muted">This address connects an assistant to the owner's own browsers. Add <code>${options.publicUrl.replace(/[&<>"']/g, "")}/mcp</code> as a custom connector in claude.ai, ChatGPT or grok.com, then approve it with the owner's passcode or a connect code.</p></main></body></html>`;
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-frame-options": "DENY",
			"referrer-policy": "no-referrer",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
		});
		res.end(html);
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		// Only the public name and loopback are ours; anything else is a misdirected or rebound request.
		if (!hostAllowed(req)) return deny(res, 421, "Misdirected request.");
		if (await handleOAuth(oauth, req, res, path)) return;
		if (path === "/" && req.method === "GET") return homePage(res);
		if (path === "/link/enroll") return handleEnroll(req, res);
		if (path === "/link/code") return handleCode(req, res);
		if (path === "/mcp") return handleMcp(req, res);
		deny(res, 404, "Not found. The MCP endpoint is /mcp.");
	}

	http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		// Node hands over the raw socket with no error listener. A peer that resets while we answer would otherwise be an uncaught exception.
		socket.on("error", () => socket.destroy());
		const refuse = (line: string) => {
			socket.end(`HTTP/1.1 ${line}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
		};
		try {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (!hostAllowed(req)) return refuse("421 Misdirected Request");
			if (path !== "/link") return refuse("404 Not Found");
			// A valid credential is never refused by anyone else's failures: check it first, throttle only failures.
			const source = requestSource(req);
			const device = authenticateDevice(bearer(req.headers.authorization));
			if (!device) {
				if (authLimit.blocked(source)) return refuse("429 Too Many Requests");
				authLimit.fail(source);
				return refuse("401 Unauthorized");
			}
			wss.handleUpgrade(req, socket, head, (ws) => onLink(ws, device));
		} catch {
			// A request target that doesn't parse, or any other fault before the link exists, is that one connection's problem.
			refuse("400 Bad Request");
		}
	});

	// ---------- Timers ----------

	const live = (): LiveDevice[] =>
		loadDevices().devices.map((d) => {
			const l = links.get(d.id);
			return {
				id: d.id,
				name: d.name,
				online: Boolean(l?.ready),
				extensionConnected: l?.status.extensionConnected ?? false,
				sessions: l ? Math.max(l.status.sessions, [...sessions.values()].filter((s) => s.deviceId === d.id).length) : 0,
				busy: l?.status.busy ?? false,
				lastSeen: l ? new Date(l.lastSeen).toISOString() : (d.lastSeen ?? null),
				version: l?.status.version || d.version || null,
				browser: l?.status.browser ?? null,
			};
		});
	let snapshotTimer: NodeJS.Timeout | undefined;
	const writeSnapshot = () => {
		snapshotTimer = undefined;
		try {
			writeLive({ pid: process.pid, updatedAt: Date.now(), devices: live() });
		} catch {
			/* informational */
		}
	};
	function snapshotSoon(): void {
		snapshotTimer ??= setTimeout(writeSnapshot, 200);
	}

	const timers: NodeJS.Timeout[] = [];
	// Ping every link; drop one silent for a minute.
	timers.push(
		setInterval(() => {
			for (const link of links.values()) {
				// A link held back for a slow client isn't silent; the slow-client timer bounds that.
				if (Date.now() - link.lastSeen > SILENT_MS && !link.blocked.size) link.ws.terminate();
				else if (link.ws.readyState === WebSocket.OPEN) link.ws.ping();
			}
		}, PING_MS),
	);
	// A device removed with `tabkyra hub remove` (another process) loses its link within a second.
	timers.push(
		setInterval(() => {
			// A file that can't be read is not a revocation: keep the links until it can.
			if (!devicesReadable()) return;
			const known = new Map(loadDevices().devices.map((d) => [d.id, d.sha256]));
			for (const link of [...links.values()]) {
				if (known.get(link.device.id) === link.device.sha256) continue;
				// Gone from the list at once; the socket closes now, or is cut a second later if the device doesn't answer.
				dropLink(link, "The device was removed.");
				link.ws.close(4001, "removed");
				setTimeout(() => link.ws.terminate(), 1000).unref();
			}
		}, 1000),
	);
	// Forget idle sessions and those whose caller was revoked.
	timers.push(
		setInterval(() => {
			let liveIds = new Set<string>();
			try {
				liveIds = new Set([...loadTokens().filter((t) => !t.revokedAt).map((t) => t.id), ...liveGrantIds()]);
			} catch {
				/* unreadable: treat every caller as revoked */
			}
			for (const [sid, s] of sessions) {
				if (Date.now() - s.lastSeen <= SESSION_IDLE_MS && liveIds.has(s.callerId)) continue;
				sessions.delete(sid);
				const link = links.get(s.deviceId);
				if (link && link.instance === s.linkInstance) forward(link, { method: "DELETE", headers: { "mcp-session-id": sid, [HUB_SCOPES_HEADER]: "", [HUB_CALLER_HEADER]: "hub" }, body: "" });
			}
		}, 60_000),
	);
	timers.push(setInterval(writeSnapshot, 5000));
	for (const t of timers) t.unref();

	await new Promise<void>((resolve, reject) => {
		http.once("error", reject);
		http.listen(options.port, host, resolve);
	});
	writeSnapshot();
	const url = `http://${host.includes(":") ? `[${host}]` : host}:${port()}`;
	options.onListen?.(url);
	return {
		url,
		port: port(),
		close: () =>
			new Promise<void>((resolve) => {
				for (const t of timers) clearInterval(t);
				if (snapshotTimer) clearTimeout(snapshotTimer);
				for (const link of links.values()) link.ws.terminate();
				wss.close();
				http.closeAllConnections();
				http.close(() => resolve());
			}),
	};
}

/** The hub's public origin in the canonical form a manager accepts (no trailing slash, default port, capitals or /mcp); as configured when it will not normalize. */
function hubOrigin(publicUrl: string): string {
	try {
		return normalizePublicUrl(publicUrl.replace(/\/mcp\/?$/, ""));
	} catch {
		return publicUrl;
	}
}
