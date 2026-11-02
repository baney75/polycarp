/**
 * Socket client: dials the native host's unix socket, checks its ownership, and
 * exposes request/response plus events. One instance per harness process.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { ClientToHost, HostToClient, RpcError } from "../../src/bridge/protocol.ts";
import { ERR, isIdempotent, MAX_FRAME_FROM_EXTENSION } from "../../src/bridge/protocol.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { assertSecurePath, socketDir } from "./paths.ts";
import { VERSION } from "./version.ts";

/** What every tool says when no browser is reachable: the agent can only ask the user. */
export const NOT_CONNECTED =
	"Tabkyra isn't connected. Ask the user to open Helium/Chrome with the Tabkyra extension loaded, or run `tabkyra doctor`.";

export class BridgeRpcError extends Error {
	constructor(readonly rpc: RpcError) {
		super(rpc.message);
	}
}

/** A connection failure before the request was written: it never reached the browser. */
class NotSentError extends Error {
	constructor(readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		const code = (cause as { code?: string } | undefined)?.code;
		if (code) (this as { code?: string }).code = code;
	}
}

/** Sends of one request, counting the first, when it is safe to resend. */
const MAX_ATTEMPTS = 3;
/** How long one call waits, in all, for a dropped bridge to come back (tests shorten it). */
const RECONNECT_BUDGET_MS = Number(process.env.TABKYRA_RECONNECT_BUDGET_MS) || 40000;

/** Bridge methods under the MCP tool names agents know them by. */
const TOOL_NAMES: Record<string, string> = { evaluate: "run_js", dialog: "handle_dialog", snapshot: "read_page", text: "get_page_text", html: "get_page_html", inspect: "inspect_page" };

/** What an agent is told when a side-effecting call was cut off: it may have run. */
export function interruptedMessage(method: string): string {
	const tool = TOOL_NAMES[method] ?? method.replace(".", "_");
	return `The browser connection dropped while ${tool} was running (the Tabkyra extension reloaded or restarted), so it may have run. Check the page with read_page before you repeat it; Tabkyra reconnects on your next call.`;
}

export interface ClientOptions {
	name: string;
	session?: string;
	/** The session is the CLI's project default, not a name the user chose (see session-name.ts). */
	auto?: boolean;
	/** The user chose the session's name (it goes in the group title). */
	named?: boolean;
	/** The project's folder name, for the group title. */
	project?: string;
	/** Fires for permission prompts and other pushed events. */
	onEvent?: (event: string, data: Record<string, unknown>) => void;
	onExtensionStatus?: (connected: boolean) => void;
	requestTimeoutMs?: number;
}

/** Live sockets, newest host first. */
export function listSockets(): string[] {
	const dir = socketDir();
	if (process.platform === "win32") return [dir];
	if (!existsSync(dir)) return [];
	assertSecurePath(dir, "dir");
	return readdirSync(dir)
		.filter((n) => n.endsWith(".sock"))
		.map((n) => join(dir, n))
		.filter((p) => {
			const pid = Number.parseInt(p.slice(p.lastIndexOf("/") + 1), 10);
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		})
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function isConnectionError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as { code?: string } | undefined)?.code;
	return (
		message === "Bridge connection closed" ||
		message === "Not connected" ||
		message === NOT_CONNECTED ||
		code === "ECONNREFUSED" ||
		code === "ENOENT" ||
		code === "EPIPE" ||
		code === "ECONNRESET"
	);
}

/** A welcomed socket, before the client takes it. */
interface Dialed {
	socket: Socket;
	path: string;
	clientId: string;
}

/** Waits between resends of a request a live host refused as not_sent (it never ran). */
const NOT_SENT_BACKOFF_MS = [250, 500, 1000, 2000];

export class BridgeClient {
	private socket?: Socket;
	/** The socket file the client's socket was dialed at. */
	private socketPath?: string;
	private seq = 0;
	/** Requests waiting for a reply, each with the socket it went out on. */
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; socket: Socket }>();
	/** Shared reconnect attempts, one per browser wanted ("" for any): concurrent callers join. */
	private reconnecting = new Map<string, Promise<void>>();
	/** One connect at a time: a call that finds no socket waits on a dial already under way. */
	private connecting?: Promise<void>;
	/**
	 * What each socket's host last said about its extension and browser, from the welcome on: a
	 * status can arrive before the client adopts the socket, and must not be lost.
	 */
	private socketExtension = new WeakMap<Socket, boolean>();
	private socketBrowser = new WeakMap<Socket, string>();
	/** The browser behind each socket file, as last seen: a rescan skips other browsers' hosts. */
	private pathBrowser = new Map<string, string>();
	/**
	 * The browser the client last worked in. A call whose socket was already gone resends there;
	 * it is forgotten when a call's budget runs out, so a later call takes whatever browser is up.
	 */
	private lastBrowser?: string;
	clientId?: string;
	extensionConnected = false;
	/** Set once the extension has been connected; only a bridge that once worked is worth waiting for. */
	private everConnected = false;

	constructor(private readonly options: ClientOptions) {}

	/** A socket the client can write to now. A half-closed one (the host ended it) doesn't count. */
	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed && this.socket.writable;
	}

	/**
	 * Whether a socket's host reached an extension, in browser `want` when given. A resend names
	 * the browser it started in, and only that exact browser will do (not a host without an id).
	 */
	private ready(socket: Socket, want?: string): boolean {
		if (!this.socketExtension.get(socket)) return false;
		return want === undefined || this.socketBrowser.get(socket) === want;
	}

	/**
	 * Dial the host and wait for its welcome; gives up after `timeoutMs` (a wedged host). The
	 * socket becomes the client's only once it is welcomed and chosen, so no call writes to a
	 * socket that is about to be dropped. Concurrent connects share one attempt.
	 */
	connect(path?: string, timeoutMs = 5000): Promise<void> {
		return this.connectShared({ path, timeoutMs });
	}

	/**
	 * The one dial in progress, whoever started it (a call, a reconnect for some browser): a
	 * client never dials twice at once, so it never holds two sockets to one host. A caller
	 * that wanted something else checks the result and tries again.
	 */
	private connectShared(o: { path?: string; timeoutMs?: number; want?: string; rescan?: boolean }): Promise<void> {
		if (this.connecting) return this.connecting;
		this.connecting = this.connectNow(o).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	/**
	 * Find a host and adopt it: the newest whose extension is connected (in browser `want` when
	 * given). Without one, the first host whose extension hasn't said hello yet is kept, unless
	 * `rescan` is set: then the client keeps its current socket and redials nothing it knows.
	 */
	private async connectNow(o: { path?: string; timeoutMs?: number; want?: string; rescan?: boolean }): Promise<void> {
		const timeoutMs = o.timeoutMs ?? 5000;
		if (o.path) return this.adopt(await this.dial(o.path, timeoutMs));
		// Several hosts can be alive (two browsers, a stale one): use the newest ready one, the same
		// socket `tabkyra doctor` and `setup` report on.
		const sockets = listSockets().filter((p) => {
			if (o.rescan && p === this.socketPath) return false;
			// A host known to serve another browser isn't dialed for a resend in this one.
			const known = this.pathBrowser.get(p);
			return !(o.want !== undefined && known !== undefined && known !== o.want);
		});
		if (sockets.length === 0) {
			if (o.rescan) return;
			throw new Error(NOT_CONNECTED);
		}
		let fallback: Dialed | undefined;
		let lastError: unknown;
		for (const target of sockets) {
			try {
				const dialed = await this.dial(target, timeoutMs);
				if (this.ready(dialed.socket, o.want)) {
					fallback?.socket.destroy();
					return this.adopt(dialed);
				}
				const browser = this.socketBrowser.get(dialed.socket);
				const others = o.want !== undefined && browser !== undefined && browser !== o.want;
				// Another browser's host is never a fallback; one whose extension hasn't said which
				// browser it is yet may be the one wanted.
				if (fallback || others || o.rescan) dialed.socket.destroy();
				else fallback = dialed;
			} catch (err) {
				lastError = err;
			}
		}
		if (o.rescan) return;
		if (fallback) return this.adopt(fallback);
		throw lastError instanceof Error ? lastError : new Error(String(lastError ?? NOT_CONNECTED));
	}

	/** Make a welcomed socket the client's one socket, retiring the one before it. */
	private adopt(dialed: Dialed): void {
		if (this.socket && this.socket !== dialed.socket) this.retire(this.socket);
		this.socket = dialed.socket;
		this.socketPath = dialed.path;
		this.clientId = dialed.clientId;
		this.extensionConnected = this.ready(dialed.socket);
		if (this.extensionConnected) {
			this.everConnected = true;
			this.lastBrowser = this.socketBrowser.get(dialed.socket) ?? this.lastBrowser;
		}
	}

	/**
	 * Stop using a socket without cutting off what is still waiting on it: a request running in
	 * another browser (a long wait, input) gets its reply. The socket is destroyed once nothing
	 * waits on it; each request's own timeout bounds that.
	 */
	private retire(socket: Socket): void {
		if (this.socket === socket) this.socket = undefined;
		this.retiring.add(socket);
		this.dropIfIdle(socket);
	}

	/** Sockets no longer used for new requests, kept open for the replies still owed on them. */
	private retiring = new WeakSet<Socket>();

	private dropIfIdle(socket: Socket): void {
		if (!this.retiring.has(socket) || socket === this.socket) return;
		if (![...this.pending.values()].some((p) => p.socket === socket)) socket.destroy();
	}

	private async dial(target: string, timeoutMs: number): Promise<Dialed> {
		if (process.platform !== "win32") assertSecurePath(target, "socket");
		return new Promise<Dialed>((resolve, reject) => {
			const socket = connect(target);
			const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
			let welcomed = false;
			const timer = setTimeout(() => {
				if (welcomed) return;
				reject(new Error(`The bridge at ${target} did not answer within ${timeoutMs} ms`));
				socket.destroy();
			}, timeoutMs);
			socket.once("error", (err) => {
				clearTimeout(timer);
				if (!welcomed) reject(err);
			});
			socket.on("data", (chunk) => {
				const { messages, error } = parser.push(chunk);
				for (const m of messages) {
					const msg = m as HostToClient;
					if (msg.type === "welcome") {
						welcomed = true;
						clearTimeout(timer);
						this.socketExtension.set(socket, msg.extensionConnected);
						this.noteBrowser(socket, target, msg.browserId);
						resolve({ socket, path: target, clientId: msg.clientId });
					} else this.onMessage(msg, socket, target);
				}
				// The good frames are delivered first; a bad one still ends this connection.
				if (error) socket.destroy(error);
			});
			socket.on("close", () => {
				clearTimeout(timer);
				// Closed before the welcome: the promise would otherwise never settle.
				if (!welcomed) reject(new Error("Bridge connection closed"));
				// Only what went out on this socket was cut off; requests on a newer one are fine.
				for (const [id, p] of this.pending) {
					if (p.socket !== socket) continue;
					clearTimeout(p.timer);
					this.pending.delete(id);
					p.reject(new Error("Bridge connection closed"));
				}
				if (this.socket === socket) this.socket = undefined;
			});
			const hello: ClientToHost = {
				type: "hello",
				client: {
					name: this.options.name,
					session: this.options.session,
					...(this.options.auto ? { auto: true } : {}),
					...(this.options.named ? { named: true } : {}),
					...(this.options.project ? { project: this.options.project } : {}),
					version: VERSION,
				},
			};
			socket.write(encodeFrame(hello));
		});
	}

	private noteBrowser(socket: Socket, path: string, browserId: string | undefined): void {
		if (!browserId) return;
		this.socketBrowser.set(socket, browserId);
		this.pathBrowser.set(path, browserId);
	}

	private onMessage(msg: HostToClient, from: Socket, path: string): void {
		if (msg.type === "response") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new BridgeRpcError(msg.error));
			else p.resolve(msg.result);
			this.dropIfIdle(p.socket);
		} else if (msg.type === "event") {
			// The session's name changed: reconnect with the new one. A rename makes it a chosen name;
			// an assignment ("<name>-2" for a second agent in one project) keeps it a default.
			if ((msg.event === "session_renamed" || msg.event === "session_assigned") && typeof msg.data.session === "string") {
				this.options.session = msg.data.session;
				if (msg.event === "session_renamed") {
					this.options.auto = false;
					this.options.named = true;
				}
			}
			this.options.onEvent?.(msg.event, msg.data);
		} else if (msg.type === "extension_status") {
			this.socketExtension.set(from, msg.connected);
			this.noteBrowser(from, path, msg.browserId);
			// Only the client's own host speaks for the extension; another socket's status waits
			// in socketExtension until (and unless) that socket is adopted.
			if (from !== this.socket) return;
			this.extensionConnected = this.ready(from);
			if (this.extensionConnected) {
				this.everConnected = true;
				this.lastBrowser = this.socketBrowser.get(from) ?? this.lastBrowser;
			}
			this.options.onExtensionStatus?.(msg.connected);
		}
	}

	/**
	 * Call, surviving a dropped bridge (extension reload, service worker restart, host respawn).
	 * The session key is stable, so a resent request lands on the same tabs, in the browser the
	 * call started in. A request that never ran is sent again: one that never left (no writable,
	 * ready socket) once the bridge is back, one a live host refused as `not_sent` after a short
	 * backoff. A request cut off in flight may have run: a read (isIdempotent) is resent, anything
	 * else fails with `interrupted` at once and is never replayed. Other RPC errors aren't retried.
	 */
	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs?: number,
		options: { retry?: boolean } = {},
	): Promise<T> {
		// One budget for the call's waits, however many times the bridge drops or refuses. It starts
		// at the first trouble: the time the request itself ran (a long wait) isn't charged to it.
		let deadline: number | undefined;
		/**
		 * The browser this call is held to: its resends go there and nowhere else. A call made while
		 * the client's browser is away (just cut off, reloading) waits for that browser too, so an
		 * agent checking the page after `interrupted` never reads, or clicks in, another browser.
		 */
		let want: string | undefined = this.connected ? undefined : this.lastBrowser;
		let drops = 0;
		let refusals = 0;
		for (;;) {
			const sent: { socket?: Socket } = {};
			try {
				return await this.callOnce<T>(method, params, timeoutMs, sent, want);
			} catch (err) {
				const refused = err instanceof BridgeRpcError && err.rpc.code === ERR.NOT_SENT;
				const unsent = err instanceof NotSentError;
				// The extension's own interrupted (debugger detached, page navigated) is an answer, not a dropped bridge.
				if (err instanceof BridgeRpcError && err.rpc.code === ERR.INTERRUPTED && err.rpc.source === "extension") throw err;
				const interrupted = err instanceof BridgeRpcError && err.rpc.code === ERR.INTERRUPTED;
				if (err instanceof BridgeRpcError && !refused && !interrupted) throw err;
				if (!refused && !unsent && !interrupted && !isConnectionError(err)) throw err;
				const resend = refused || unsent || isIdempotent(method, params);
				// Input cut off in flight is never replayed: say so now, without waiting for the bridge
				// (the next call reconnects on its own).
				if (!resend) throw new BridgeRpcError({ code: ERR.INTERRUPTED, message: interruptedMessage(method) });
				// Status checks report trouble as it is instead of waiting.
				if (options.retry === false) throw refused ? err : new Error(NOT_CONNECTED);
				deadline ??= Date.now() + RECONNECT_BUDGET_MS;
				want ??= (sent.socket && this.socketBrowser.get(sent.socket)) || this.lastBrowser;
				if (refused) {
					// The host is up and said the request didn't run (an update is installing, or the
					// host is stopping): wait a little and send it again, on whatever socket is live then.
					const wait = NOT_SENT_BACKOFF_MS[Math.min(refusals++, NOT_SENT_BACKOFF_MS.length - 1)];
					if (Date.now() + wait > deadline) throw err;
					await new Promise((r) => setTimeout(r, wait));
					continue;
				}
				// Nothing was ever reachable: say so now instead of polling.
				if (!this.everConnected) throw new Error(NOT_CONNECTED);
				if (!unsent) {
					// Cut off in flight (a read): a bridge that keeps dropping is reported, not chased.
					drops++;
					if (drops >= MAX_ATTEMPTS)
						throw new BridgeRpcError({
							code: ERR.INTERRUPTED,
							message: `The browser connection dropped ${drops} times in a row during ${TOOL_NAMES[method] ?? method.replace(".", "_")}. Run \`tabkyra doctor\` or ask the user to check the browser, then try again.`,
						});
					// Stop using the socket this request went out on (unless another call already moved on).
					if (sent.socket && this.socket === sent.socket) this.retire(sent.socket);
				}
				if (!(await this.reconnect(want, deadline))) {
					// The drop outlasted the budget: report it. A later call starts afresh (any browser).
					this.everConnected = false;
					this.lastBrowser = undefined;
					throw new Error(NOT_CONNECTED);
				}
			}
		}
	}

	/**
	 * Wait until the client has a ready socket (in browser `want` when given), or `deadline`.
	 * Callers wanting the same browser share each attempt; each keeps trying until its own
	 * deadline, so an earlier caller's budget never cuts a later one short.
	 */
	private async reconnect(want: string | undefined, deadline: number): Promise<boolean> {
		const key = want ?? "";
		while (Date.now() < deadline) {
			if (this.connected && this.socket && this.ready(this.socket, want)) return true;
			let attempt = this.reconnecting.get(key);
			if (!attempt) {
				attempt = this.reconnectOnce(want, Math.min(2000, deadline - Date.now())).finally(() => this.reconnecting.delete(key));
				this.reconnecting.set(key, attempt);
			}
			await attempt.catch(() => undefined);
		}
		return Boolean(this.connected && this.socket && this.ready(this.socket, want));
	}

	/** One stretch of trying to reach a ready host (in browser `want`), at most `budgetMs`. */
	private async reconnectOnce(want: string | undefined, budgetMs: number): Promise<void> {
		const deadline = Date.now() + Math.max(0, budgetMs);
		while (Date.now() < deadline) {
			try {
				if (!this.connected) await this.connectShared({ want });
				else if (!this.socket || !this.ready(this.socket, want)) {
					// On a host that isn't ready (a stale one, or another browser's): look at the others,
					// without redialing this one or hosts known to serve another browser.
					await this.connectShared({ want, rescan: true });
				}
				if (this.connected && this.socket && this.ready(this.socket, want)) return;
			} catch {
				/* no host yet */
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error("Bridge unavailable");
	}

	private async callOnce<T>(
		method: string,
		params: Record<string, unknown>,
		timeoutMs?: number,
		sent: { socket?: Socket } = {},
		want?: string,
	): Promise<T> {
		if (!this.connected) {
			try {
				await this.connectShared({ want });
			} catch (err) {
				throw isConnectionError(err) ? new NotSentError(err) : err;
			}
		}
		const socket = this.socket;
		// A resend goes to the browser its call started in, never to whichever host is newest.
		if (want !== undefined && socket && !this.ready(socket, want)) throw new NotSentError(new Error("Not connected"));
		// A half-closed socket (the host ended it) can't take a request: it was never sent. Nor
		// can a host whose extension isn't there once one has been: it couldn't run it.
		if (!socket || socket.destroyed || !socket.writable) throw new NotSentError(new Error("Not connected"));
		if (this.everConnected && !this.extensionConnected) throw new NotSentError(new Error("Not connected"));
		sent.socket = socket;
		const id = ++this.seq;
		const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeout} ms`));
				this.dropIfIdle(socket);
			}, timeout);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, socket });
			const req: ClientToHost = { type: "request", id, method, params };
			socket.write(encodeFrame(req));
		});
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
	}
}
