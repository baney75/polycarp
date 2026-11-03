/**
 * Native messaging host. The browser spawns this process when the extension
 * connects; it owns the unix socket harness clients dial and relays frames both
 * ways, adding `clientId` on the way in and stripping it on the way out.
 * No browser logic lives here.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { ClientToHost, ExtToHost, HostClientConnected, HostToClient, HostToExt } from "../../src/bridge/protocol.ts";
import { ERR, MAX_FRAME_FROM_EXTENSION, MAX_FRAME_TO_EXTENSION } from "../../src/bridge/protocol.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { guardedHosts } from "./guarded-hosts.ts";
import { socketDir, socketPath } from "./paths.ts";
import { ConnectService } from "./connect-host.ts";
import { SubscriptionService } from "./subscriptions/service.ts";
import { applyMirror } from "./threads-mirror.ts";
import { handleCommunityAction, onCommunityHello, startCommunityTimer } from "./community-host.ts";
import { handleUpdateAction, noteHello, sendStatus, startUpdateTimer } from "./update-host.ts";
import { VERSION } from "./version.ts";

interface Client {
	id: string;
	socket: Socket;
	hello?: ClientToHost & { type: "hello" };
	/** Request ids forwarded to the extension and not answered yet. */
	outstanding: Set<number>;
	/** When this client last sent anything; a stopping host waits for it to go quiet. */
	lastDataAt: number;
}

const clients = new Map<string, Client>();
let extensionReady = false;
/** The browser profile behind this host (from the extension's hello). */
let browserId: string | undefined;
let seq = 0;
/** ChatGPT and Copilot sign-ins; made on the first request, so a host that never sees one opens nothing. */
let subscriptions: SubscriptionService | undefined;
/** Settings > Connect: routes, codes, devices, joining a hub, the page theme. Made on the first frame. */
let connect: ConnectService | undefined;
/** Set once the host has decided to exit; no request is forwarded after that. */
let stopping = false;

/** Write a frame to the extension; false when it was refused as oversized. */
function toExtension(message: HostToExt): boolean {
	// A stopping host says nothing more to the extension: its side may already be gone (a write
	// then fails with EPIPE), and the extension must hear the port close, not more traffic.
	if (stopping) return false;
	const frame = encodeFrame(message);
	if (frame.length > MAX_FRAME_TO_EXTENSION) {
		// Never let one oversized frame kill the native port.
		const failing = message as { clientId?: string; id?: number };
		if (failing.clientId && failing.id !== undefined) {
			toClient(failing.clientId, {
				type: "response",
				id: failing.id,
				error: { code: "bad_params", message: `Request exceeds ${MAX_FRAME_TO_EXTENSION} bytes` },
			});
		}
		return false;
	}
	process.stdout.write(frame);
	return true;
}

function toClient(clientId: string, message: HostToClient): void {
	const client = clients.get(clientId);
	if (!client || client.socket.destroyed || !client.socket.writable) return;
	client.socket.write(encodeFrame(message));
}

/** What the connected extension said it implements (its hello); undefined before that. */
let extensionMethods: string[] | undefined;

/**
 * A client as the extension should see it. An extension from before project sessions ignores
 * `auto` and would put every agent in one project on one session (one group, each other's
 * current tab), so for it a default session is made unique per client, as harness ids made it.
 */
function forExtension(clientId: string, client: HostClientConnected["client"]): HostClientConnected["client"] {
	if (!client.auto || !client.session || !extensionMethods || extensionMethods.includes("sessions.list")) return client;
	return { ...client, session: `${client.session}-${clientId}` };
}

/**
 * The extension gave a client another session (a second agent in one project gets "<name>-2",
 * or the user renamed it): keep that in the hello this host re-announces when the extension's
 * worker restarts, or the client would be put back on its old name, and maybe another's tabs.
 */
function rememberSession(clientId: string, event: string, data: unknown): void {
	const hello = clients.get(clientId)?.hello;
	const session = (data as { session?: unknown } | undefined)?.session;
	if (!hello || typeof session !== "string" || (event !== "session_assigned" && event !== "session_renamed")) return;
	hello.client = { ...hello.client, session, ...(event === "session_renamed" ? { auto: false, named: true } : {}) };
}

function onExtensionMessage(message: ExtToHost): void {
	switch (message.type) {
		case "hello":
			extensionReady = true;
			browserId = typeof message.browserId === "string" ? message.browserId.slice(0, 64) : undefined;
			extensionMethods = Array.isArray(message.methods) ? message.methods : undefined;
			noteHello(message, toExtension);
			void sendStatus(toExtension);
			onCommunityHello(toExtension);
			for (const id of clients.keys()) toClient(id, { type: "extension_status", connected: true, ...(browserId ? { browserId } : {}) });
			// The extension restarted; re-announce every live client so it recreates sessions.
			for (const client of clients.values()) {
				if (client.hello) toExtension({ type: "client_connected", clientId: client.id, client: forExtension(client.id, client.hello.client) });
			}
			return;
		case "response":
			clients.get(message.clientId)?.outstanding.delete(message.id);
			toClient(message.clientId, { type: "response", id: message.id, result: message.result, error: message.error });
			return;
		case "event":
			if (message.clientId) rememberSession(message.clientId, message.event, message.data);
			if (message.clientId) toClient(message.clientId, { type: "event", event: message.event, data: message.data });
			else for (const id of clients.keys()) toClient(id, { type: "event", event: message.event, data: message.data });
			return;
		case "pong":
			return;
		case "threads_mirror":
			// The local thread mirror; every field is checked in applyMirror.
			try {
				const what = applyMirror(message as unknown as Record<string, unknown>, browserId);
				if (what.startsWith("refused")) process.stderr.write(`[tabkyra-host] thread mirror ${what}\n`);
			} catch (err) {
				process.stderr.write(`[tabkyra-host] thread mirror failed: ${err instanceof Error ? err.message : String(err)}\n`);
			}
			return;
		case "update_action":
			// Parsed again strictly inside: only {type, action} with a known action runs anything.
			handleUpdateAction(message, toExtension);
			return;
		case "community_action":
			// Parsed again strictly inside: only {type, action} with on, off or sync.
			handleCommunityAction(message, toExtension);
			return;
		case "subscription":
			if (typeof message.id !== "number" || typeof message.method !== "string") return;
			subscriptions ??= new SubscriptionService();
			void subscriptions.handle(message, toExtension);
			return;
		case "connect":
			// Parsed strictly inside: a frame that isn't exactly a known call gets an error and runs nothing.
			connect ??= new ConnectService();
			void connect.handle(message, toExtension);
			return;
	}
}

function onClientMessage(client: Client, message: ClientToHost): void {
	if (message.type === "hello") {
		client.hello = message;
		// A stopping host can't run anything: it doesn't present itself as ready to a new client.
		const ready = extensionReady && !stopping;
		toClient(client.id, { type: "welcome", clientId: client.id, hostVersion: VERSION, extensionConnected: ready, ...(ready && browserId ? { browserId } : {}) });
		toExtension({ type: "client_connected", clientId: client.id, client: forExtension(client.id, message.client) });
		return;
	}
	if (message.type === "request") {
		if (!client.hello) {
			toClient(client.id, { type: "response", id: message.id, error: { code: "bad_params", message: "Send hello first" } });
			return;
		}
		if (stopping) {
			// Never forward now: the reply could not come back, and the client would retry it.
			toClient(client.id, { type: "response", id: message.id, error: restartError("the browser bridge is restarting", false) });
			return;
		}
		const guarded = guardedHosts();
		if (toExtension({ type: "request", clientId: client.id, id: message.id, method: message.method, params: message.params, ...(guarded.length ? { guardedHosts: guarded } : {}) }))
			client.outstanding.add(message.id);
	}
}

/**
 * Answer every request the extension has not answered with an RPC error, so no client waits on
 * a reply that can't come and none replays it blindly: `interrupted` says it may have run (a
 * client repeats only reads on its own). Used when the host restarts after a bad frame and when
 * the extension goes away (reload, worker restart). Chrome then spawns a fresh host and later
 * calls dial the new socket.
 */
function failOutstanding(reason: string): void {
	for (const client of clients.values()) {
		for (const id of client.outstanding) {
			toClient(client.id, { type: "response", id, error: restartError(reason, true) });
		}
		client.outstanding.clear();
	}
}

/** An RPC error naming whether the request may have run. */
function restartError(what: string, mayHaveRun: boolean): { code: string; message: string } {
	const next = mayHaveRun
		? "It may have run: check the page (read_page) before repeating it."
		: "It was not sent; repeat it in a few seconds.";
	return { code: mayHaveRun ? ERR.INTERRUPTED : ERR.NOT_SENT, message: `${what[0].toUpperCase()}${what.slice(1)}. ${next}` };
}

function sweepStaleSockets(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".sock")) continue;
		const pid = Number.parseInt(name, 10);
		if (!Number.isInteger(pid)) continue;
		try {
			process.kill(pid, 0);
		} catch {
			rmSync(join(dir, name), { force: true });
		}
	}
}

/**
 * Close the extension's side at once when the host stops on its own (a bad frame, a signal):
 * the extension sees its port disconnect and stops the requests this host just answered
 * "interrupted", instead of running them while the host lingers for its clients.
 */
function dropExtension(): void {
	try {
		process.stdout.end();
		process.stdin.destroy();
	} catch {
		/* already closed */
	}
}

export function runNativeHost(): void {
	// A closed pipe to the browser must not crash the host while it answers its clients.
	process.stdout.on("error", () => undefined);
	const dir = socketDir();
	if (process.platform !== "win32") {
		if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
		chmodSync(dir, 0o700);
		const st = statSync(dir);
		if (st.uid !== process.getuid?.()) {
			process.stderr.write(`[tabkyra-host] ${dir} is owned by another user; refusing to start\n`);
			process.exit(1);
		}
		sweepStaleSockets(dir);
	}
	const path = socketPath(process.pid);
	rmSync(path, { force: true });

	const server = createServer((socket) => {
		const id = `c${++seq}-${process.pid}`;
		const client: Client = { id, socket, outstanding: new Set(), lastDataAt: Date.now() };
		clients.set(id, client);
		const parser = new FrameParser(MAX_FRAME_TO_EXTENSION);
		socket.on("data", (chunk) => {
			client.lastDataAt = Date.now();
			const { messages, error } = parser.push(chunk);
			for (const m of messages) onClientMessage(client, m as ClientToHost);
			if (error) {
				process.stderr.write(`[tabkyra-host] bad frame from ${id}: ${String(error)}\n`);
				socket.destroy();
			}
		});
		const drop = () => {
			if (!clients.delete(id)) return;
			toExtension({ type: "client_disconnected", clientId: id });
		};
		socket.on("close", drop);
		socket.on("error", drop);
	});
	server.listen(path, () => {
		if (process.platform !== "win32") chmodSync(path, 0o600);
	});

	// stdin: frames from the extension
	const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
	process.stdin.on("data", (chunk: Buffer) => {
		if (stopping) return;
		const { messages, error } = parser.push(chunk);
		for (const m of messages) onExtensionMessage(m as ExtToHost);
		if (error) {
			process.stderr.write(`[tabkyra-host] bad frame from extension, restarting: ${String(error)}\n`);
			stopping = true;
			failOutstanding(`the browser's reply was lost (${error.message}); the bridge is restarting`);
			dropExtension();
			shutdown(1);
		}
	});

	let exiting = false;
	/** A stopping host closes a client only after it has sent nothing for this long (at most MAX_LINGER_MS). */
	const LINGER_MS = 250;
	const MAX_LINGER_MS = 2000;
	const shutdown = (code = 0) => {
		if (exiting) return;
		exiting = true;
		stopping = true;
		// No new clients. The connected ones keep their sockets until they go quiet, and anything
		// they send meanwhile is answered not_sent (onClientMessage), which they resend to the next host.
		server.close();
		rmSync(path, { force: true });
		const started = Date.now();
		const ended = new Set<Client>();
		const exitWhenClosed = () => {
			const open = [...clients.values()].filter((c) => !c.socket.destroyed);
			if (open.length === 0) process.exit(code);
			const exit = setTimeout(() => process.exit(code), 500);
			let left = open.length;
			for (const c of open)
				c.socket.once("close", () => {
					if (--left === 0) {
						clearTimeout(exit);
						process.exit(code);
					}
				});
		};
		const sweep = () => {
			const now = Date.now();
			for (const client of clients.values()) {
				if (ended.has(client)) continue;
				// end() flushes what is queued (the answers above) before closing; destroy() would drop it.
				// Quiet for LINGER_MS since the stop at the earliest: an idle client gets the full grace too.
				if (now - Math.max(client.lastDataAt, started) >= LINGER_MS || now - started >= MAX_LINGER_MS) {
					ended.add(client);
					client.socket.end();
				}
			}
			if ([...clients.values()].every((c) => ended.has(c))) exitWhenClosed();
			else setTimeout(sweep, 25);
		};
		sweep();
	};
	// The extension went away (reloaded, updated, worker restarted): what it had not answered
	// never will be.
	process.stdin.on("end", () => {
		stopping = true;
		failOutstanding("the browser connection dropped while this ran (the Tabkyra extension reloaded or restarted)");
		shutdown();
	});
	const killed = () => {
		stopping = true;
		failOutstanding("the browser bridge was stopped while this ran");
		dropExtension();
		shutdown();
	};
	process.on("SIGINT", killed);
	process.on("SIGTERM", killed);

	const ping = setInterval(() => toExtension({ type: "ping" }), 20000);
	ping.unref();
	startUpdateTimer(toExtension);
	startCommunityTimer(toExtension);
}
