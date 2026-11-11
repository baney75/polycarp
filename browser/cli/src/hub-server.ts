/**
 * `polycarp browser hub serve`: one connector URL for many devices (D32). The hub answers the same OAuth
 * endpoints and consent page as `serve --public-url`, authenticates /mcp the same way, and then
 * proxies each MCP session to one of the owner's devices, which dial in over a WebSocket (/link)
 * from behind their own NATs. It needs no browser. Single-owner, like every install (D31).
 *
 * What crosses the hop: the caller's scopes and name, in two headers the hub always sets itself
 * (anything a public client sends under x-polycarp-hub-* or x-tabkyra-hub-* is dropped), and the MCP request. The
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
	MAX_ROSTER_DEVICES,
	parseDeviceFrame,
	PING_MS,
	type ReqFrame,
	type RosterDevice,
	SILENT_MS,
	type StatusFrame,
} from "./link-protocol.ts";
import { handleOAuth, readBody, requestSource, sendJson } from "./oauth-http.ts";
import { liveGrantIds, mintApprovalCode, normalizePublicUrl, type OAuthConfig, resourceMetadataUrl, verifyAccessToken } from "./oauth.ts";
import { authenticate, hubHeaders, loadTokens, SCOPES, safeCallerName, tokenLive } from "./remote.ts";
import { pageCss } from "./theme.ts";
import { COMMAND_NAME } from "./self.ts";

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
/** A secondary session unused this long is opened again: the device forgets idle sessions after 30 minutes. */
const SECONDARY_FRESH_MS = 25 * 60_000;
/** Largest initialize body kept for opening secondary sessions; a session with a larger one can't route calls. */
const MAX_INIT_REPLAY_BYTES = 64_000;

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
	/** The hub session id the client knows; a device's own session id in the response is replaced with it. */
	alias?: string;
	/** A tools/call routed to another device by its device argument: failures answer as a tool result, not an HTTP error. */
	toolCall?: ToolCall;
}

/** A routed tools/call: its JSON-RPC id, the device's name, and how the device answered so far. */
interface ToolCall {
	id: string | number;
	device: string;
	sse: boolean;
	wrote: boolean;
}

/** A session the hub opened on another device for one hub session's routed calls. */
interface Secondary {
	sid: string;
	linkInstance: number;
	lastUsed: number;
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
	/** The last roster sent on this link, so an unchanged one isn't sent again. */
	rosterSent?: string;
}

interface HubSession {
	deviceId: string;
	linkInstance: number;
	callerId: string;
	lastSeen: number;
	/** The session's one standalone GET stream is open. */
	streamOpen: boolean;
	/** The initialize body, replayed to open a secondary session on another device; undefined when too large to keep. */
	initBody?: string;
	/** Sessions on other devices for calls that name them, by device id, and the ones being opened. Closed with this session. */
	secondary: Map<string, Secondary>;
	opening: Map<string, Promise<Secondary | string>>;
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
	if (!LOOPBACK_HOSTS.has(host)) throw new Error(`${COMMAND_NAME} hub serve binds to loopback only (got ${host}). Put an HTTPS front door in front of it.`);
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
			const session = super.get(key);
			const had = super.delete(key);
			if (had) snapshotSoon();
			// However a session ends (DELETE, idle, revoked, its device gone), its sessions on other devices end with it.
			if (session) closeSecondaries(session);
			return had;
		}
	})();
	const callerInits = new Map<string, number>();
	// What each device last reported and when its link last dropped, for the roster after it goes offline. This run only.
	const lastStatus = new Map<string, Omit<StatusFrame, "t">>();
	const offlineAt = new Map<string, string>();
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
			process.stderr.write(`[${COMMAND_NAME} hub] ${err instanceof Error ? err.message : String(err)}\n`);
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
		if (!(p.toolCall && !message.startsWith("The client") && toolFailure(link, p, message))) {
			if (p.res && !p.headSent) deny(p.res, status, message);
			else p.res?.destroy();
		}
		sendTo(link, { t: "cancel", id });
		finish(link, id);
	}

	/** A routed call that broke after it was sent: say so as a tool result. False when the response can't take one any more. */
	function toolFailure(link: Link, p: Pending, message: string): boolean {
		const call = p.toolCall;
		const res = p.res;
		if (!call || !res || res.writableEnded || res.destroyed) return false;
		const gone = links.get(link.device.id) !== link || link.ws.readyState !== WebSocket.OPEN;
		const words = `${gone ? `${call.device} went offline while this call ran.` : `${call.device} didn't finish this call (${message.replace(/\.$/, "")}).`} The action may have landed: read it back before you repeat it.`;
		if (!res.headersSent) {
			toolError(res, call.id, words, p.alias);
			return true;
		}
		// An event stream with nothing on it yet can still carry the answer.
		if (call.sse && !call.wrote) {
			res.end(`event: message\ndata: ${toolErrorBody(call.id, words)}\n\n`);
			return true;
		}
		return false;
	}

	function toolErrorBody(id: string | number, words: string): string {
		return JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: words }], isError: true } });
	}

	/** A tool result with isError, as a JSON response: what an agent sees for a call that couldn't be routed. */
	function toolError(res: ServerResponse, id: string | number, words: string, alias?: string): void {
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...(alias ? { "mcp-session-id": alias } : {}) });
		res.end(toolErrorBody(id, words));
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
	function forward(
		link: Link,
		request: { method: ReqFrame["method"]; headers: Headers; body: string; res?: ServerResponse; stream?: boolean; onHead?: Pending["onHead"]; onDone?: () => void; alias?: string; toolCall?: { id: string | number; device: string } },
	): void {
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
		const p: Pending = {
			res: request.res,
			stream,
			headSent: false,
			done: false,
			timer,
			onHead: request.onHead,
			onDone: request.onDone,
			alias: request.alias,
			toolCall: request.toolCall ? { ...request.toolCall, sse: false, wrote: false } : undefined,
		};
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
			const { t: _t, ...status } = frame;
			link.status = status;
			link.ready = true;
			lastStatus.set(link.device.id, status);
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
			// A routed call's secondary session is gone on its device (it restarted the session, or forgot it): a tool result,
			// so the client keeps its hub session. onHead dropped the secondary; the next call opens a new one.
			if (p.toolCall && status === 404 && p.res) {
				toolError(p.res, p.toolCall.id, `${p.toolCall.device} had closed this session there. Nothing was done. Call it again to start a new one.`, p.alias);
				sendTo(link, { t: "cancel", id: frame.id });
				finish(link, frame.id);
				return;
			}
			if (p.toolCall) p.toolCall.sse = frame.headers["content-type"]?.startsWith("text/event-stream") === true;
			if (p.res) {
				const out: Record<string, string> = {};
				for (const k of FORWARD_RESPONSE_HEADERS) if (frame.headers[k]) out[k] = frame.headers[k];
				if (p.alias && out["mcp-session-id"]) out["mcp-session-id"] = p.alias;
				if (status === 502 && frame.status === 401) {
					deny(p.res, 502, `This device refused the hub's link token. Run ${COMMAND_NAME} link off and link again on it.`);
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
			if (p.toolCall) p.toolCall.wrote = true;
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
		forward(link, { method: "DELETE", headers: { "mcp-session-id": id, ...hubHeaders("", "hub") }, body: "" });
	}

	function dropLink(link: Link, reason: string): void {
		if (links.get(link.device.id) === link) links.delete(link.device.id);
		for (const id of [...link.inflight.keys()]) failPending(link, id, 502, reason);
		for (const [sid, s] of sessions) if (s.deviceId === link.device.id && s.linkInstance === link.instance) sessions.delete(sid);
		const now = new Date().toISOString();
		// A link replaced by a newer one isn't offline.
		if (!links.has(link.device.id)) offlineAt.set(link.device.id, now);
		touchDevice(link.device.id, { lastSeen: now });
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
		offlineAt.delete(device.id);
		// The roster at once, so the device knows its peers before its first session; it shows this one offline until its status arrives.
		sendRoster(link, roster());
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
	/** Why a named device can't take a call: no device by that name or id, or it isn't online and reporting. */
	type Miss = { miss: "unknown" } | { miss: "offline"; device: DeviceRecord };

	/** The enrolled device a name or id means: the id, then the exact name, then a name that matches in any case when only one does. */
	function resolveDevice(target: string): DeviceRecord | undefined {
		const devices = loadDevices().devices;
		const exact = devices.find((d) => d.id === target) ?? devices.find((d) => d.name === target);
		if (exact) return exact;
		const loose = devices.filter((d) => d.name.toLowerCase() === target.toLowerCase());
		return loose.length === 1 ? loose[0] : undefined;
	}

	const routable = (l: Link | undefined): l is Link => Boolean(l && l.ws.readyState === WebSocket.OPEN && l.ready);

	/**
	 * The device for a new session. Candidates are online devices that have reported (so their cap is
	 * known), allow at least one of the caller's scopes, and have room (requests, and sessions under
	 * their own cap). Of those, ones with the extension connected win, then full scope coverage, not
	 * busy, fewest sessions, `prefer` order, most recently seen.
	 */
	function pickLink(who: Caller): Pick;
	/** With a target (a device name or id): that device's link, with no ranking, or why it can't be used. */
	function pickLink(who: Caller, target: string): { link: Link } | Miss;
	function pickLink(who: Caller, target?: string): Pick | Miss {
		if (target !== undefined) {
			const device = resolveDevice(target);
			if (!device) return { miss: "unknown" };
			const link = links.get(device.id);
			return routable(link) ? { link } : { miss: "offline", device };
		}
		const online = [...links.values()].filter((l) => l.ws.readyState === WebSocket.OPEN && l.ready);
		if (!online.length) return { status: 503, message: offlineMessage() };
		const wanted = who.scopes.filter((x) => Object.hasOwn(SCOPES, x));
		const covers = (l: Link) => wanted.filter((x) => l.status.scopes.includes(x)).length;
		const fits = online.filter((l) => covers(l) > 0);
		if (!fits.length) {
			const caps = online.map((l) => `${l.device.name}: ${l.status.scopes.join(", ") || "nothing"}`).join("; ");
			return { status: 403, message: `None of the permissions you granted are allowed on any online device (${caps}).` };
		}
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

	/** Sessions on a device: what it reports, or what the hub routes there when that is more, plus initializes in flight. */
	function load(l: Link): number {
		const known = [...sessions.values()].filter((x) => x.deviceId === l.device.id).length;
		return Math.max(l.status.sessions, known) + l.initsPending;
	}

	function offlineMessage(): string {
		const devices = loadDevices().devices;
		if (!devices.length) return `No device is linked to this hub. Run ${COMMAND_NAME} hub code, then ${COMMAND_NAME} link on a device.`;
		const lines = devices.map((d) => `${d.name}: ${links.has(d.id) ? "online" : d.lastSeen ? `offline, last seen ${d.lastSeen}` : "never connected"}`);
		return `No device is online. ${lines.join("; ")}.`;
	}

	function requestHeaders(req: IncomingMessage, who: Caller): Headers {
		const out: Headers = {};
		// Built from a short list, so nothing a public client sends under a hub header name (or anything else) can pass.
		for (const name of FORWARD_REQUEST_HEADERS) {
			const v = req.headers[name];
			if (typeof v === "string" && v && !/[\r\n\0]/.test(v)) out[name] = v;
		}
		// Under the old names too: a device from before the rename reads only those (remote.ts, LEGACY_HUB_SCOPES_HEADER).
		Object.assign(out, hubHeaders(who.scopes.filter((s) => Object.hasOwn(SCOPES, s)).join(","), safeCallerName(who.name) || "caller"));
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
			// A tools/call whose device argument names another device goes there; one naming this device, or none, is forwarded as before.
			const call = method === "POST" ? deviceCall(body) : undefined;
			if (call) {
				const target = pickLink(who, call.device);
				if (!("link" in target) || target.link !== link) return routeCall(session, sessionId, who, req, res, call, target);
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
					sessions.set(id, {
						deviceId: link.device.id,
						linkInstance: link.instance,
						callerId: who.id,
						lastSeen: Date.now(),
						streamOpen: false,
						initBody: Buffer.byteLength(body) <= MAX_INIT_REPLAY_BYTES ? body : undefined,
						secondary: new Map(),
						opening: new Map(),
					});
				}
			},
			onDone: () => {
				link.initsPending = Math.max(0, link.initsPending - 1);
				releaseInit();
			},
		});
	}

	// ---------- Per-call device routing ----------

	interface DeviceCall {
		id: string | number;
		name: string;
		device: string;
		message: Record<string, unknown>;
	}

	const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

	/** A single tools/call request whose arguments name a device. A batch is never routed: it reaches the bound device whole, which refuses a call naming another. */
	function deviceCall(body: string): DeviceCall | undefined {
		if (!body.includes('"device"')) return undefined;
		let msg: unknown;
		try {
			msg = JSON.parse(body);
		} catch {
			return undefined;
		}
		if (!isObject(msg) || msg.method !== "tools/call" || !isObject(msg.params) || !isObject(msg.params.arguments)) return undefined;
		const { id } = msg;
		const device = msg.params.arguments.device;
		if ((typeof id !== "string" && typeof id !== "number") || typeof device !== "string") return undefined;
		return { id, name: typeof msg.params.name === "string" ? msg.params.name : "", device, message: msg };
	}

	/** The scope that grants a tool, or undefined for one no scope lists (devices). */
	function scopeOfTool(tool: string): string | undefined {
		return Object.entries(SCOPES).find(([, v]) => v.tools.includes(tool))?.[0];
	}

	/** "2026-11-10 14:02" in the hub's local time. */
	function shortTime(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		const two = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
	}

	function onlineNames(): string {
		return (
			loadDevices()
				.devices.filter((d) => routable(links.get(d.id)))
				.map((d) => d.name)
				.join(", ") || "none"
		);
	}

	function offlineDevice(device: DeviceRecord): string {
		const seen = offlineAt.get(device.id) ?? device.lastSeen;
		return `${device.name} is offline (${seen ? `last seen ${shortTime(seen)}` : "never connected"}). Nothing was sent. Online now: ${onlineNames()}.`;
	}

	function unknownDevice(given: string): string {
		const names = loadDevices().devices.map((d) => d.name);
		return `No device called ${JSON.stringify(given.slice(0, 80))}. Devices: ${names.join(", ") || "none"}.`;
	}

	/**
	 * Send one tools/call to the device its device argument names, in this hub session's secondary session there. The
	 * target's own cap still applies twice: here, from what it reported, and on the device, which narrows the caller's
	 * scopes by its link token when the secondary session opens. The secondary session is opened with the caller's
	 * own scopes, never the bound device's, so nothing allowed on one device reaches another.
	 */
	async function routeCall(session: HubSession, sessionId: string, who: Caller, req: IncomingMessage, res: ServerResponse, call: DeviceCall, picked: { link: Link } | Miss): Promise<void> {
		if ("miss" in picked) return toolError(res, call.id, picked.miss === "unknown" ? unknownDevice(call.device) : offlineDevice(picked.device));
		const target = picked.link;
		const name = target.device.name;
		const scope = scopeOfTool(call.name);
		if (scope && !target.status.scopes.includes(scope)) {
			return toolError(res, call.id, `${name} doesn't allow ${scope} (allows: ${target.status.scopes.join(", ") || "nothing"}). Only its owner can add it, on ${name}.`);
		}
		if (scope && !who.scopes.includes(scope)) return toolError(res, call.id, `This connection doesn't allow ${scope}, so ${call.name} can't run on any device through it.`);
		if (scope?.startsWith("computer.") && target.status.computer === false) return toolError(res, call.id, `${name} has no computer use: Polycarp's Mac app isn't on it. Nothing was sent.`);
		if (target.calls + target.reserved >= MAX_INFLIGHT_PER_DEVICE) return toolError(res, call.id, `${name} is handling too many requests. Nothing was sent. Try again in a moment.`);
		// A request slot on the target while its session opens.
		target.reserved++;
		let secondary: Secondary | string;
		try {
			secondary = await secondaryFor(session, sessionId, target, who, req);
		} finally {
			target.reserved--;
		}
		if (typeof secondary === "string") return toolError(res, call.id, secondary);
		if (res.destroyed || res.writableEnded) return;
		if (links.get(target.device.id) !== target || target.ws.readyState !== WebSocket.OPEN) return toolError(res, call.id, offlineDevice(target.device));
		secondary.lastUsed = Date.now();
		const params = call.message.params as Record<string, unknown>;
		const { device: _device, ...args } = params.arguments as Record<string, unknown>;
		const opened = secondary;
		forward(target, {
			method: "POST",
			headers: { ...requestHeaders(req, who), "mcp-session-id": opened.sid },
			body: JSON.stringify({ ...call.message, params: { ...params, arguments: args } }),
			res,
			alias: sessionId,
			toolCall: { id: call.id, device: name },
			onHead: (status) => {
				if (status === 404 && session.secondary.get(target.device.id) === opened) session.secondary.delete(target.device.id);
			},
		});
	}

	/** This hub session's open secondary session on `target`, or a new one; parallel first calls share one opening. A string says why there is none. */
	function secondaryFor(session: HubSession, sessionId: string, target: Link, who: Caller, req: IncomingMessage): Promise<Secondary | string> {
		const id = target.device.id;
		const known = session.secondary.get(id);
		if (known && known.linkInstance === target.instance && Date.now() - known.lastUsed < SECONDARY_FRESH_MS) return Promise.resolve(known);
		if (known) {
			session.secondary.delete(id);
			closeSecondary(id, known);
		}
		const opening = session.opening.get(id);
		if (opening) return opening;
		const started = openSecondary(session, sessionId, target, who, req).finally(() => session.opening.delete(id));
		session.opening.set(id, started);
		return started;
	}

	/** One request to a device with no client attached: resolves with the head's status (0 when none came) and headers. */
	function ask(link: Link, request: { method: ReqFrame["method"]; headers: Headers; body: string }): Promise<{ status: number; headers: Headers }> {
		return new Promise((resolve) => {
			let status = 0;
			let headers: Headers = {};
			forward(link, {
				...request,
				onHead: (s, h) => {
					status = s;
					headers = h;
				},
				onDone: () => resolve({ status, headers }),
			});
		});
	}

	async function openSecondary(session: HubSession, sessionId: string, target: Link, who: Caller, req: IncomingMessage): Promise<Secondary | string> {
		const name = target.device.name;
		if (!session.initBody) return `This session's initialize request was too large to open a session on ${name}. Nothing was sent. Start a new session to use device.`;
		if (load(target) >= target.status.sessionCap) return `${name} is at its session limit. Nothing was sent. Close a session there or try again later.`;
		// The caller's own scopes and name, as for any new session: never anything from the bound device's session.
		const headers = requestHeaders(req, who);
		delete headers["mcp-session-id"];
		delete headers["mcp-protocol-version"];
		delete headers["last-event-id"];
		headers["content-type"] = "application/json";
		headers.accept = "application/json, text/event-stream";
		target.initsPending++;
		let init: { status: number; headers: Headers };
		try {
			init = await ask(target, { method: "POST", headers, body: session.initBody });
		} finally {
			target.initsPending = Math.max(0, target.initsPending - 1);
		}
		const sid = init.headers["mcp-session-id"];
		if (init.status === 403) return `${name} allows none of this connection's permissions. Nothing was sent.`;
		if (init.status < 200 || init.status >= 300 || !sid || !SESSION_ID.test(sid)) {
			return init.status ? `${name} couldn't start a session for this call (it answered ${init.status}). Nothing was sent.` : `${name} went offline before the call could start. Nothing was sent.`;
		}
		const secondary: Secondary = { sid, linkInstance: target.instance, lastUsed: Date.now() };
		// The hub session ended, or the device's link changed, while this opened: nothing would close it later, so close it now.
		if (sessions.get(sessionId) !== session || links.get(target.device.id) !== target) {
			closeSecondary(target.device.id, secondary);
			return `This session ended while ${name} was starting a session. Nothing was sent.`;
		}
		session.secondary.set(target.device.id, secondary);
		// As a client would, before its first call.
		const version = req.headers["mcp-protocol-version"];
		await ask(target, {
			method: "POST",
			headers: { ...headers, "mcp-session-id": sid, ...(typeof version === "string" && !/[\r\n\0]/.test(version) ? { "mcp-protocol-version": version } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});
		return secondary;
	}

	function closeSecondary(deviceId: string, secondary: Secondary): void {
		const link = links.get(deviceId);
		if (link && link.instance === secondary.linkInstance && link.ws.readyState === WebSocket.OPEN) forward(link, { method: "DELETE", headers: { "mcp-session-id": secondary.sid, ...hubHeaders("", "hub") }, body: "" });
	}

	function closeSecondaries(session: HubSession): void {
		for (const [deviceId, secondary] of session.secondary) closeSecondary(deviceId, secondary);
		session.secondary.clear();
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
				return sendJson(res, 401, { error: "invalid_code", error_description: `That connect code is wrong, expired or already used. Run ${COMMAND_NAME} hub code for a new one.` });
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
		if (!device.manage) return sendJson(res, 403, { error: "forbidden", error_description: `This device is not a manager. Link it with a code from ${COMMAND_NAME} hub code --manage.` });
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
		const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polycarp hub</title><style>${pageCss()}</style></head><body><main><h1>Polycarp hub</h1><p class="muted">This address connects an assistant to the owner's own browsers. Add <code>${options.publicUrl.replace(/[&<>"']/g, "")}/mcp</code> as a custom connector in claude.ai, ChatGPT or grok.com, then approve it with the owner's passcode or a connect code.</p></main></body></html>`;
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
	/** Every enrolled device as its peers see it. What a device allows comes from its own last report; nothing here can change it. */
	function roster(): RosterDevice[] {
		let devices: DeviceRecord[] = [];
		try {
			devices = loadDevices().devices;
		} catch {
			return [];
		}
		return devices.slice(0, MAX_ROSTER_DEVICES).map((d) => {
			const l = links.get(d.id);
			const online = routable(l);
			const status = online ? l.status : lastStatus.get(d.id);
			return {
				id: d.id,
				name: d.name,
				online,
				lastSeen: online ? null : (offlineAt.get(d.id) ?? d.lastSeen ?? null),
				scopes: status?.scopes ?? [],
				computer: status?.computer === true,
				extension: online ? l.status.extensionConnected : false,
				platform: status?.platform ?? null,
			};
		});
	}

	function sendRoster(link: Link, devices: RosterDevice[]): void {
		const text = JSON.stringify({ t: "roster", devices });
		if (link.rosterSent === text || link.ws.readyState !== WebSocket.OPEN) return;
		link.rosterSent = text;
		sendText(link, text);
	}

	/** The roster to every linked device whose copy is out of date. */
	function pushRoster(): void {
		if (!links.size) return;
		const devices = roster();
		for (const link of links.values()) sendRoster(link, devices);
	}

	let snapshotTimer: NodeJS.Timeout | undefined;
	const writeSnapshot = () => {
		snapshotTimer = undefined;
		try {
			writeLive({ pid: process.pid, updatedAt: Date.now(), devices: live() });
		} catch {
			/* informational */
		}
		pushRoster();
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
	// A device removed with `polycarp browser hub remove` (another process) loses its link within a second.
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
				liveIds = new Set([...loadTokens().filter((t) => tokenLive(t)).map((t) => t.id), ...liveGrantIds()]);
			} catch {
				/* unreadable: treat every caller as revoked */
			}
			for (const [sid, s] of sessions) {
				if (Date.now() - s.lastSeen <= SESSION_IDLE_MS && liveIds.has(s.callerId)) continue;
				sessions.delete(sid);
				const link = links.get(s.deviceId);
				if (link && link.instance === s.linkInstance) forward(link, { method: "DELETE", headers: { "mcp-session-id": sid, ...hubHeaders("", "hub") }, body: "" });
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
