/**
 * Bridge runtime in the service worker.
 *
 * Connects to the native host with chrome.runtime.connectNative (the browser
 * spawns the host), keeps one BrowserSession per connected harness, routes
 * requests to the handlers, and relays permission prompts. Reconnects on a
 * backoff and on a 30 s alarm, which also keeps the worker alive.
 */

import { cancelQuestion, cancelQuestionsFor, handleBridgeAsk, startAskBridge } from "../ask/bridge-worker.js";
import { openDialog, type PageDialog, stopScreencastsOwnedBy } from "../browser/cdp.js";
import { setCdpMessageHandler } from "../browser/inject.js";
import { BrowserSession, listSessions, pruneSessions, type SessionMeta, sanitizeLabel } from "../browser/session.js";
import { probeUserScripts } from "../browser/userscripts-status.js";
import { COMMUNITY_STATUS_KEY } from "../community/status.js";
import { handleThreads } from "../threads/bridge.js";
import { resyncMirror, startThreadMirror } from "../threads/mirror.js";
import { asBuildInfo, BUILD, type BuildInfo } from "../update/build.js";
import type { UpdateAction } from "../update/logic.js";
import { type Delivered, dialogError, raceDialogs } from "./dialogs.js";
import { BridgeError, classify } from "./errors.js";
import {
	addPendingRequest,
	allowHost,
	DECISION_KEY_PREFIX,
	getPermissionMode,
	hostOf,
	isBridgeEnabled,
	isUrlAllowed,
	type PermissionDecision,
	type PermissionMode,
	removePendingRequest,
	setPermissionMode,
} from "./permissions.js";
import {
	BRIDGE_METHODS,
	ERR,
	type ExtSubscription,
	type ExtToHost,
	type HostClientConnected,
	type HostForwardedRequest,
	type HostSubscription,
	type HostToExt,
	type HostUpdateProgress,
	type HostUpdateStatus,
	MAX_FRAME_FROM_EXTENSION,
	NATIVE_HOST_NAME,
	PROTOCOL_VERSION,
	UPDATE_PROGRESS_KEY,
	UPDATE_STATUS_KEY,
} from "./protocol.js";
import { handleSessionsAdmin } from "./sessions-admin.js";
import { type HandlerContext, handlers } from "./tools.js";

const ALARM_NAME = "tabkyra-bridge-keepalive";
const WORKER_STARTED_AT = Date.now();
const LOG_MAX = 200;
/** Ring buffer of timing lines, readable through bridge.debug. */
const log: string[] = [];
export function trace(line: string): void {
	log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
	if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PERMISSION_TIMEOUT_MS = 120000;

interface ClientState {
	clientId: string;
	name: string;
	sessionKey: string;
	/** Group label: the agent, then the project or session name ("claude · tabkyra"). */
	label?: string;
	meta?: SessionMeta;
	/** For a default (auto) session moved to "-2": the key and name it wanted, for when it frees up. */
	wanted?: { key: string; name: string };
	session?: BrowserSession;
	/** Only one request at a time per client; the CLI serialises anyway. */
	queue: Promise<void>;
	inFlight?: { method: string; since: number };
	/** Stops the running request from sending more input (a dialog opened, or the host went away). */
	abort?: () => void;
	/**
	 * Set when the host this client came through went away. The host answered everything it had
	 * forwarded as interrupted, so nothing still queued for this client may start.
	 */
	closed?: boolean;
	/** When a request last started or ended; the update idle gate reads it. */
	lastActivityAt: number;
	lastError?: string;
}

/** A handler that never settles must not wedge the client's queue forever. */
const HANDLER_TIMEOUT_MS = 90000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new BridgeError(ERR.TIMEOUT, `${label} did not finish within ${ms} ms`)),
			ms,
		);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

let port: chrome.runtime.Port | undefined;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const clients = new Map<string, ClientState>();
const pendingDecisions = new Map<string, (decision: PermissionDecision) => void>();

/** Headroom under the host's frame cap for differences in how Chrome serializes the JSON. */
const FRAME_HEADROOM = 1024 * 1024;

/** UTF-8 size of a message as JSON, or 0 when it is obviously small enough. */
function frameBytes(message: ExtToHost): number {
	const json = JSON.stringify(message);
	// A UTF-16 code unit is at most 3 UTF-8 bytes; skip the encode for everything but huge frames.
	if (json.length * 3 < MAX_FRAME_FROM_EXTENSION - FRAME_HEADROOM) return 0;
	return new TextEncoder().encode(json).length;
}

function send(message: ExtToHost): void {
	try {
		const bytes = frameBytes(message);
		if (bytes > MAX_FRAME_FROM_EXTENSION - FRAME_HEADROOM) {
			// The host drops a frame over its cap and restarts; fail just this request instead.
			console.warn(`[Bridge] ${message.type} of ${bytes} bytes is over the bridge limit; not sent`);
			if (message.type !== "response") return;
			message = {
				type: "response",
				clientId: message.clientId,
				id: message.id,
				error: {
					code: ERR.INTERNAL,
					message: `Result too large for the bridge (${Math.round(bytes / 1048576)} MB, limit ${Math.round((MAX_FRAME_FROM_EXTENSION - FRAME_HEADROOM) / 1048576)} MB). Ask for less: a smaller page section, a lower-resolution screenshot or fewer items.`,
				},
			};
		}
		port?.postMessage(message);
	} catch (err) {
		console.warn("[Bridge] post failed:", err);
	}
}

function sessionIdFor(client: HostClientConnected["client"], clientId: string): string {
	const name = client.name.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "harness";
	const key = client.session ? client.session.replace(/[^a-z0-9_-]/gi, "").slice(0, 64) : clientId;
	return `bridge-${name}-${key}`;
}

async function getSession(state: ClientState): Promise<BrowserSession> {
	// Ended by the user, the CLI or the agent itself: the next call starts a fresh session (same
	// name, new group), which also carries the notice saying why.
	if (state.session?.ended) state.session = undefined;
	if (!state.session) {
		state.session = await BrowserSession.open(state.sessionKey, state.label ?? state.name, undefined, state.meta);
	}
	return state.session;
}

/**
 * The session a new client gets. A name the user chose is shared by every client that gives it
 * (an agent and a recorder can drive one session). The CLI's default name (project plus
 * harness) is not: a second agent in the same project at the same time gets "<name>-2".
 */
function sessionFor(client: HostClientConnected["client"], clientId: string): { key: string; name?: string } {
	const key = sessionIdFor(client, clientId);
	if (!client.auto || !client.session) return { key, name: client.session };
	const taken = new Set([...clients.values()].map((c) => c.sessionKey));
	if (!taken.has(key)) return { key, name: client.session };
	for (let n = 2; ; n++) if (!taken.has(`${key}-${n}`)) return { key: `${key}-${n}`, name: `${client.session}-${n}` };
}

async function onClientConnected(msg: HostClientConnected): Promise<void> {
	const name = msg.client.name || "harness";
	const { key, name: sessionName } = sessionFor(msg.client, msg.clientId);
	const project = msg.client.project ? sanitizeLabel(msg.client.project) : undefined;
	// "claude · tabkyra" for the default session, "claude · research" for one the user named;
	// older clients and remote sessions (their session is an id) keep the plain harness name.
	const subject = msg.client.auto
		? project
		: msg.client.named && msg.client.session
			? sanitizeLabel(msg.client.session)
			: undefined;
	const state: ClientState = {
		clientId: msg.clientId,
		name,
		sessionKey: key,
		label: subject && subject !== name ? `${name} · ${subject}` : name,
		meta: { agent: name, ...(project ? { project } : {}), ...(sessionName ? { name: sessionName } : {}) },
		queue: Promise.resolve(),
		lastActivityAt: 0,
		...(msg.client.auto && msg.client.session && sessionName !== msg.client.session
			? { wanted: { key: sessionIdFor(msg.client, msg.clientId), name: msg.client.session } }
			: {}),
	};
	// The client reconnects under the name it got, so a reload can't hand it another agent's tabs.
	if (state.wanted && sessionName) assign(state, key, sessionName);
	clients.set(msg.clientId, state);
	// Sessions open lazily on the first browser call: maintenance clients (status, debug,
	// reload, allow) never touch tabs and must not leave session records behind.
	console.log(`[Bridge] client ${msg.clientId} (${state.name}) connected as ${state.sessionKey}`);
}

/** Point a client at a session and tell it the name to reconnect with. */
function assign(state: ClientState, key: string, name: string): void {
	state.sessionKey = key;
	if (state.meta) state.meta.name = name;
	send({ type: "event", clientId: state.clientId, event: "session_assigned", data: { session: name } });
}

async function onClientDisconnected(clientId: string): Promise<void> {
	const state = clients.get(clientId);
	clients.delete(clientId);
	// A restarted harness can connect before its old process hangs up and get "<name>-2". If it
	// has no tabs there yet (a first status call opens the session, empty), it gets the one it
	// asked for, with the tabs it left; the empty "-2" record goes.
	if (state) {
		for (const c of clients.values()) {
			if (
				c.wanted?.key !== state.sessionKey ||
				(c.session && !c.session.ended && c.session.tabIds.length > 0) ||
				[...clients.values()].some((o) => o.sessionKey === state.sessionKey)
			)
				continue;
			const empty = c.session;
			c.session = undefined;
			if (empty && !empty.ended && ![...clients.values()].some((o) => o !== c && o.session === empty))
				await empty.end().catch(() => undefined);
			assign(c, c.wanted.key, c.wanted.name);
			c.wanted = undefined;
			break;
		}
	}
	await stopScreencastsOwnedBy(clientId).catch(() => undefined);
	// ask_user: a question from a client that left has nobody to answer to.
	cancelQuestionsFor(clientId);
	// A restarted harness (same session key) can connect before its old socket closes; the
	// session is still in use then, so leave it alone.
	const successors = state ? [...clients.values()].filter((c) => c.sessionKey === state.sessionKey) : [];
	// Hand the session on, so the last of them to leave suspends or drops it.
	for (const c of successors) c.session ??= state?.session;
	if (state?.session && successors.length === 0) {
		// A session that never opened a tab has nothing to re-adopt; drop it instead of piling up.
		if (!(await state.session.closeIfEmpty())) await state.session.suspend();
	}
	for (const [requestId, resolve] of pendingDecisions) {
		if (requestId.startsWith(`${clientId}:`)) {
			resolve("deny");
			pendingDecisions.delete(requestId);
		}
	}
}

async function askPermission(state: ClientState, url: string): Promise<boolean> {
	if (await isUrlAllowed(url)) return true;
	const host = hostOf(url);
	if (!host) return false;
	const requestId = `${state.clientId}:${crypto.randomUUID()}`;
	const decision = new Promise<PermissionDecision>((resolve) => {
		pendingDecisions.set(requestId, resolve);
		setTimeout(() => {
			if (pendingDecisions.delete(requestId)) resolve("deny");
		}, PERMISSION_TIMEOUT_MS);
	});
	await addPendingRequest({
		requestId,
		clientId: state.clientId,
		clientName: state.name,
		host,
		url,
		createdAt: Date.now(),
	});
	send({
		type: "event",
		clientId: state.clientId,
		event: "permission_request",
		data: { requestId, host, url, timeoutMs: PERMISSION_TIMEOUT_MS },
	});
	const result = await decision;
	await removePendingRequest(requestId);
	if (result === "allow_host") await allowHost(host);
	return result !== "deny";
}

function resolveDecision(requestId: string, decision: PermissionDecision): boolean {
	const resolve = pendingDecisions.get(requestId);
	if (!resolve) return false;
	pendingDecisions.delete(requestId);
	resolve(decision);
	return true;
}

/** Methods that still work while a dialog freezes the page. */
const DIALOG_SAFE = new Set([
	"dialog",
	"status",
	"tabs.context",
	"tabs.create",
	"tabs.close",
	"tabs.select",
	"tabs.show",
	"permission.respond",
	// Read buffered messages only; they help explain the dialog.
	"console.read",
	"network.read",
]);

async function runRequest(state: ClientState, req: HostForwardedRequest): Promise<void> {
	const reply = (result?: unknown, error?: BridgeError) =>
		send({
			type: "response",
			clientId: req.clientId,
			id: req.id,
			...(error ? { error: error.toRpc() } : { result }),
		});

	// Aborted from the moment it is taken off the queue: the host can go away during any await
	// below, and once it has, the agent was told this may have run and may repeat it.
	let aborted = false;
	state.abort = () => {
		aborted = true;
	};
	/** Set by a handler just before the input that completes its action goes out (HandlerContext.delivered). */
	let deliveredResult: Delivered | undefined;
	/** Gone: send nothing, start nothing (nobody can receive the answer, and the agent may retry). */
	const gone = () => aborted || state.closed === true;
	if (gone()) return;
	// At worker start, until the update worker knows whether an install was in flight.
	await gateReady;
	if (gone()) return;
	if (installGate()) {
		// Refused before it counts as activity: a request started now would run on files being
		// replaced, and the reload right after the install would cut it off. It never ran, so the
		// client may resend it once Tabkyra is back.
		reply(
			undefined,
			new BridgeError(
				ERR.NOT_SENT,
				"Tabkyra is installing an update and reloads in a few seconds. The request did not run; repeat it once the bridge reconnects.",
			),
		);
		return;
	}
	// In flight from here, before the first await, so the update idle gate sees it at once.
	state.inFlight = { method: req.method, since: Date.now() };
	state.lastActivityAt = Date.now();
	try {
		if (!(await isBridgeEnabled())) {
			throw new BridgeError(ERR.DISABLED, "The tabkyra bridge is disabled in Settings > Bridge.");
		}
		if (gone()) return;

		const handler = handlers[req.method];
		if (!handler) throw new BridgeError(ERR.NOT_FOUND, `Unknown method ${req.method}`);
		const t0 = performance.now();
		const session = await withTimeout(getSession(state), 15000, "session open");
		const tSession = Math.round(performance.now() - t0);
		// The session can take seconds to open; the host may have gone meanwhile.
		if (gone()) return;
		const ctx: HandlerContext = {
			session,
			clientId: state.clientId,
			emit: (event, data) => send({ type: "event", clientId: state.clientId, event, data }),
			aborted: () => aborted,
			delivered: (result, tabId) => {
				deliveredResult = result && tabId !== undefined ? { result, tabId } : undefined;
			},
			checkUrl: async (url: string) => {
				if (!(await askPermission(state, url))) {
					const mode = await getPermissionMode();
					throw new BridgeError(
						ERR.PERMISSION_DENIED,
						`Not allowed to open ${hostOf(url) || url}. ` +
							(mode === "ask"
								? "The user can allow it in the tabkyra side panel under Settings > Bridge, or answer the permission prompt."
								: "Bridge navigation is blocked."),
					);
				}
			},
		};
		// Reading a body asks the page's network stack, not just a buffer: not while a dialog holds it.
		const dialogSafe =
			DIALOG_SAFE.has(req.method) && !(req.method === "network.read" && req.params?.requestId !== undefined);
		if (!dialogSafe) {
			const openOn = session.tabIds.find((id) => openDialog(id) !== undefined);
			if (openOn !== undefined) throw dialogError(openOn, openDialog(openOn) as PageDialog);
		}
		const work = handler(ctx, req.params ?? {});
		const result = await withTimeout(
			dialogSafe
				? work
				: raceDialogs(
						session,
						work,
						() => {
							aborted = true;
						},
						() => deliveredResult,
					),
			HANDLER_TIMEOUT_MS,
			req.method,
		);
		trace(`${state.name} ${req.method} session=${tSession}ms total=${Math.round(performance.now() - t0)}ms`);
		reply(result);
	} catch (err) {
		state.lastError = `${req.method}: ${err instanceof Error ? err.message : String(err)}`;
		console.warn("[Bridge]", state.lastError);
		const { error, stack } = classify(err, req.method);
		// The trace is for whoever debugs Tabkyra (tabkyra debug), not for the agent.
		if (stack) trace(`${req.method} ${error.code}: ${stack.split("\n").slice(0, 6).join(" | ")}`);
		reply(undefined, error);
	} finally {
		state.abort = undefined;
		state.inFlight = undefined;
		state.lastActivityAt = Date.now();
	}
}

/** ask_user and ask_user.cancel (src/ask/bridge-worker.ts). A client cancels only its own questions. */
async function runAsk(state: ClientState, req: HostForwardedRequest): Promise<void> {
	const respond = (r: { result?: unknown; error?: { code: string; message: string } }) =>
		send({ type: "response", clientId: req.clientId, id: req.id, ...r });
	try {
		// Withdrawing a question is always safe: no gate, no enabled check.
		if (req.method === "ask_user.cancel")
			return respond({ result: { cancelled: cancelQuestion(state.clientId, req.params?.askId) } });
		await gateReady;
		if (installGate())
			return respond({
				error: {
					code: ERR.INTERNAL,
					message:
						"Tabkyra is installing an update and reloads in a few seconds. Ask again once the bridge reconnects.",
				},
			});
		if (!(await isBridgeEnabled()))
			return respond({
				error: { code: ERR.DISABLED, message: "The tabkyra bridge is disabled in Settings > Bridge." },
			});
		// The client may have hung up during the awaits; its question would have nobody to answer to.
		if (clients.get(state.clientId) !== state) return;
		respond(await handleBridgeAsk(state, req.params ?? {}));
	} catch (err) {
		respond({ error: { code: ERR.INTERNAL, message: err instanceof Error ? err.message : String(err) } });
	}
}

/** Subscription sign-in frames go to the relay (src/subscriptions/relay.ts); "disconnected" when the host goes. */
let subscriptionHandler: ((message: HostSubscription | "disconnected") => void) | undefined;

export function onSubscriptionMessage(handler: (message: HostSubscription | "disconnected") => void): void {
	subscriptionHandler = handler;
}

/** Send a subscription request to the host; false when no host is connected. */
export function sendSubscription(message: ExtSubscription): boolean {
	if (!port) return false;
	send(message);
	return true;
}

function onHostMessage(message: HostToExt): void {
	switch (message.type) {
		case "subscription":
			subscriptionHandler?.(message);
			return;
		case "ping":
			send({ type: "pong" });
			return;
		case "client_connected":
			void onClientConnected(message);
			return;
		case "client_disconnected":
			void onClientDisconnected(message.clientId);
			return;
		case "update_status":
			// The side panel and Settings > Updates read this; the update worker acts on it (auto updates).
			void chrome.storage.local.set({ [UPDATE_STATUS_KEY]: message });
			updateHandlers.status?.(message);
			return;
		case "community_status":
			void chrome.storage.local.set({ [COMMUNITY_STATUS_KEY]: message });
			return;
		case "update_progress":
			// A replay is for the worker to match against what it waits for, not news for the panel.
			if (!message.replay) void chrome.storage.local.set({ [UPDATE_PROGRESS_KEY]: message });
			updateHandlers.progress?.(message);
			return;
		case "request": {
			if (message.method === "permission.respond") {
				// Answers must bypass the per-client queue: the request waiting for them is at its head.
				const p = message.params ?? {};
				const decision = String(p.decision) as PermissionDecision;
				const ok = ["allow_once", "allow_host", "deny"].includes(decision);
				send({
					type: "response",
					clientId: message.clientId,
					id: message.id,
					...(ok
						? { result: { accepted: resolveDecision(String(p.requestId), decision) } }
						: { error: { code: ERR.BAD_PARAMS, message: "decision must be allow_once, allow_host, or deny" } }),
				});
				return;
			}
			if (message.method === "permission.allow") {
				// `tabkyra allow <host>`: a local user process granting a host, same trust as the side panel.
				const host = String(message.params?.host ?? "").toLowerCase();
				if (!host) {
					send({
						type: "response",
						clientId: message.clientId,
						id: message.id,
						error: { code: ERR.BAD_PARAMS, message: "host is required" },
					});
					return;
				}
				allowHost(host).then(() =>
					send({ type: "response", clientId: message.clientId, id: message.id, result: { allowed: host } }),
				);
				return;
			}
			if (message.method === "permission.setMode") {
				// `tabkyra allow-all` / `tabkyra ask`: a local user process flipping the site-permission mode,
				// same trust as the Settings > Bridge toggle.
				const mode = String(message.params?.mode ?? "");
				if (mode !== "ask" && mode !== "allow_all") {
					send({
						type: "response",
						clientId: message.clientId,
						id: message.id,
						error: { code: ERR.BAD_PARAMS, message: "mode must be ask or allow_all" },
					});
					return;
				}
				setPermissionMode(mode as PermissionMode).then(() =>
					send({ type: "response", clientId: message.clientId, id: message.id, result: { mode } }),
				);
				return;
			}
			if (message.method.startsWith("threads.")) {
				// Past side panel chats, read-only and without a browser session (src/threads).
				handleThreads(message.method, message.params ?? {}).then(
					(result) => send({ type: "response", clientId: message.clientId, id: message.id, result }),
					(err) =>
						send({
							type: "response",
							clientId: message.clientId,
							id: message.id,
							error:
								err instanceof BridgeError
									? err.toRpc()
									: { code: ERR.INTERNAL, message: err instanceof Error ? err.message : String(err) },
						}),
				);
				return;
			}
			if (message.method.startsWith("sessions.")) {
				// `tabkyra sessions`: a local user process, the side panel's trust; no session of its own.
				handleSessionsAdmin(message.method, message.params ?? {}, adminHost).then(
					(result) => send({ type: "response", clientId: message.clientId, id: message.id, result }),
					(err) =>
						send({
							type: "response",
							clientId: message.clientId,
							id: message.id,
							error:
								err instanceof BridgeError
									? err.toRpc()
									: { code: ERR.INTERNAL, message: err instanceof Error ? err.message : String(err) },
						}),
				);
				return;
			}
			if (message.method === "bridge.debug") {
				Promise.all([
					listSessions(),
					chrome.permissions.getAll(),
					chrome.storage.session.get(["sidepanel_last_error", "sidepanel_open_windows", "sidepanel_trace"]),
					chrome.tabGroups
						.query({})
						.then((groups) =>
							groups
								.filter((g) => g.title?.startsWith("Tabkyra"))
								.map((g) => ({ id: g.id, title: g.title, windowId: g.windowId })),
						)
						.catch(() => []),
					chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }).then((wins) =>
						wins.map((w) => {
							const active = w.tabs?.find((t) => t.active);
							return { windowId: w.id, focused: w.focused, activeTabId: active?.id, activeUrl: active?.url };
						}),
					),
					chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async ([tab]) => {
						if (!tab?.id) return null;
						const options = await chrome.sidePanel.getOptions({ tabId: tab.id }).catch(() => null);
						return { tabId: tab.id, url: tab.url, groupId: tab.groupId, options };
					}),
					probeUserScripts(),
				])
					.then(([sessions, perms, panelState, groups, windows, activeTab, userScripts]) =>
						send({
							type: "response",
							clientId: message.clientId,
							id: message.id,
							result: {
								version: chrome.runtime.getManifest().version,
								// Old CLIs read only this boolean; newer ones read `userScripts` for the cause.
								userScriptsApi: userScripts.state === "ready",
								userScripts,
								sidePanel: { ...panelState, activeTab, groups },
								windows,
								grantedPermissions: perms.permissions ?? [],
								workerUptimeS: Math.round((Date.now() - WORKER_STARTED_AT) / 1000),
								log: [...log],
								clients: [...clients.values()].map((c) => ({
									clientId: c.clientId,
									name: c.name,
									sessionKey: c.sessionKey,
									hasSession: !!c.session,
									inFlight: c.inFlight,
									lastError: c.lastError,
								})),
								sessions: sessions.map((s) => ({
									id: s.id,
									label: s.label,
									tabs: s.tabIds.length,
									windowId: s.windowId,
									groupId: s.groupId,
								})),
							},
						}),
					)
					.catch((err) =>
						// Answer even when a probe fails, so `tabkyra doctor` and `debug` don't wait out a timeout.
						send({
							type: "response",
							clientId: message.clientId,
							id: message.id,
							error: {
								code: ERR.INTERNAL,
								message: `bridge.debug: ${err instanceof Error ? err.message : String(err)}`,
							},
						}),
					);
				return;
			}
			if (message.method === "bridge.bench") {
				// Diagnostics: how long do the Chrome APIs the session model relies on take right now?
				(async () => {
					const timings: Record<string, number> = {};
					const time = async (label: string, fn: () => Promise<unknown>) => {
						const t = performance.now();
						try {
							await fn();
						} catch (err) {
							timings[`${label}_error`] = -1;
							console.warn("[Bridge bench]", label, err);
						}
						timings[label] = Math.round(performance.now() - t);
					};
					await time("storage.local.get(sessions)", () => chrome.storage.local.get("browser_sessions"));
					await time("storage.local.get", () => chrome.storage.local.get("bridge_enabled"));
					await time("windows.getLastFocused", () => chrome.windows.getLastFocused({ windowTypes: ["normal"] }));
					await time("windows.getAll", () => chrome.windows.getAll());
					await time("tabs.query(all)", async () => {
						timings.tabCount = (await chrome.tabs.query({})).length;
					});
					await time("tabGroups.query(all)", async () => {
						timings.groupCount = (await chrome.tabGroups.query({})).length;
					});
					await time("debugger.getTargets", async () => {
						timings.targetCount = (await chrome.debugger.getTargets()).length;
					});
					send({ type: "response", clientId: message.clientId, id: message.id, result: timings });
				})();
				return;
			}
			if ((message.method === "bridge.activate" || message.method === "bridge.reload") && installGate()) {
				send({
					type: "response",
					clientId: message.clientId,
					id: message.id,
					error: {
						code: ERR.INTERNAL,
						message:
							"Tabkyra is installing an update and reloads in a few seconds. Repeat the request once the bridge reconnects.",
					},
				});
				return;
			}
			if (message.method === "bridge.activate") {
				// Development aid: put a given tab back in front (e.g. after a test popup stole focus).
				const tabId = Number(message.params?.tabId);
				chrome.tabs
					.update(tabId, { active: true })
					.then(
						() => ({ result: { activated: tabId } }),
						(err: Error) => ({ error: { code: ERR.NOT_FOUND, message: err.message } }),
					)
					.then((r) => send({ type: "response", clientId: message.clientId, id: message.id, ...r }));
				return;
			}
			if (message.method === "bridge.reload") {
				// Development aid: reload the extension so a rebuilt bundle is picked up without the extensions page.
				send({ type: "response", clientId: message.clientId, id: message.id, result: { reloading: true } });
				setTimeout(() => chrome.runtime.reload(), 200);
				return;
			}
			let state = clients.get(message.clientId);
			if (!state) {
				// Host restarted mid-flight or we missed the connect; treat as a fresh client.
				state = {
					clientId: message.clientId,
					name: "harness",
					sessionKey: `bridge-harness-${message.clientId}`,
					queue: Promise.resolve(),
					lastActivityAt: 0,
				};
				clients.set(message.clientId, state);
			}
			if (message.method === "ask_user" || message.method === "ask_user.cancel") {
				// ask_user (src/ask/bridge-worker.ts) waits minutes for the user, so it runs beside the
				// client's queue: its browser calls go on meanwhile. It isn't activity for the update idle
				// gate; a reload ends the question, and the agent hears there was no answer.
				void runAsk(state, message);
				return;
			}
			const current = state;
			current.queue = current.queue.then(() => runRequest(current, message)).catch(() => undefined);
			return;
		}
	}
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		connect();
	}, delay);
}

function connect(): void {
	if (port) return;
	let next: chrome.runtime.Port;
	try {
		next = chrome.runtime.connectNative(NATIVE_HOST_NAME);
	} catch (err) {
		console.debug("[Bridge] connectNative failed:", err);
		scheduleReconnect();
		return;
	}
	port = next;
	next.onMessage.addListener((message: HostToExt) => {
		// Reset the backoff only once a host actually talks, so a host that exits at once
		// (crash loop) is retried ever more slowly instead of every second.
		reconnectDelay = RECONNECT_MIN_MS;
		onHostMessage(message);
	});
	next.onDisconnect.addListener(() => {
		const reason = chrome.runtime.lastError?.message ?? "closed";
		// "Specified native messaging host not found" means the CLI installer has not run yet.
		console.debug("[Bridge] native host disconnected:", reason);
		if (port === next) port = undefined;
		subscriptionHandler?.("disconnected");
		// The host answered these "interrupted: it may have run" and the agent may repeat them
		// after checking the page: the running handlers must send no more input.
		for (const state of clients.values()) {
			state.closed = true;
			state.abort?.();
		}
		for (const state of clients.values()) void state.session?.suspend();
		clients.clear();
		cancelQuestionsFor(undefined);
		void stopScreencastsOwnedBy(undefined).catch(() => undefined);
		scheduleReconnect();
	});
	trace("native port connected");
	// The hello says which build runs and which build the extension folder holds now, so the host
	// can tell whether the browser loads Tabkyra from the folder it updates (docs/updates.md).
	helloSent = false;
	void Promise.all([readDiskBuild(), getBrowserId()]).then(([diskBuild, browserId]) => {
		if (port !== next) return;
		helloSent = true;
		// A new host has an empty view of the threads: send them all (and which ones are gone).
		setTimeout(() => void resyncMirror().catch(() => undefined), 1000);
		send({
			type: "hello",
			version: chrome.runtime.getManifest().version,
			protocol: PROTOCOL_VERSION,
			methods: [...BRIDGE_METHODS],
			build: BUILD,
			diskBuild,
			browserId,
		});
	});
}

const BROWSER_ID_KEY = "tabkyra.browserId";

/** This profile's lasting random id (see ExtHello.browserId). */
async function getBrowserId(): Promise<string | undefined> {
	try {
		const stored = (await chrome.storage.local.get(BROWSER_ID_KEY))[BROWSER_ID_KEY];
		if (typeof stored === "string" && stored) return stored;
		const id = crypto.randomUUID();
		await chrome.storage.local.set({ [BROWSER_ID_KEY]: id });
		return id;
	} catch {
		return undefined;
	}
}

/** The extension folder's build-info.json as it is on disk now (an unpacked extension reads from disk). */
export async function readDiskBuild(): Promise<BuildInfo | undefined> {
	try {
		const response = await fetch(chrome.runtime.getURL("build-info.json"), { cache: "no-store" });
		return response.ok ? asBuildInfo(await response.json()) : undefined;
	} catch {
		return undefined;
	}
}

// ---- updates --------------------------------------------------------------------------------

const updateHandlers: {
	status?: (status: HostUpdateStatus) => void;
	progress?: (progress: HostUpdateProgress) => void;
} = {};

/** The update worker (src/update/worker.ts) listens here. */
export function onUpdateMessages(handlers: typeof updateHandlers): void {
	updateHandlers.status = handlers.status;
	updateHandlers.progress = handlers.progress;
}

let installGate: () => boolean = () => false;

/** The update worker holds this while it swaps an update in and reloads (src/update/gate.ts). */
export function setInstallGate(held: () => boolean): void {
	installGate = held;
}

let gateReady: Promise<unknown> = Promise.resolve();

/** Resolves once the update worker has restored a gate an earlier worker held. */
export function setGateReady(ready: Promise<unknown>): void {
	gateReady = ready;
}

/** Set once the hello went out on the current port; the host refuses actions before it. */
let helloSent = false;

/** Ask the native host for an update action; false when no host is connected or hasn't had the hello. */
export function sendUpdateAction(action: UpdateAction): boolean {
	if (!port || !helloSent) return false;
	send({ type: "update_action", action });
	return true;
}

/** Ask the native host to turn community skills on or off, or sync now; false when no host is ready. */
export function sendCommunityAction(action: "on" | "off" | "sync"): boolean {
	if (!port || !helloSent) return false;
	send({ type: "community_action", action });
	return true;
}

/** Whether a host is connected right now. */
export function hostConnected(): boolean {
	return port !== undefined;
}

/** Each harness: is a request running, and when did it last do something. */
export function bridgeActivity(): Array<{ name: string; inFlight: boolean; lastActivityAt: number }> {
	return [...clients.values()].map((c) => ({
		name: c.name,
		inFlight: c.inFlight !== undefined,
		lastActivityAt: c.lastActivityAt,
	}));
}

/**
 * Bridge sessions that own no tabs carry nothing worth keeping; a reload of the extension
 * can leave such records behind (their clients were disconnected by the reload itself).
 */
async function dropEmptyBridgeSessions(): Promise<void> {
	for (const s of await listSessions()) {
		if (s.id.startsWith("bridge-") && s.tabIds.length === 0) {
			// A client may have opened a tab in it meanwhile; then it stays.
			await BrowserSession.dropIfEmpty(s.id);
		}
	}
}

/** Session keys of the harnesses connected right now. */
function liveSessionKeys(): Set<string> {
	return new Set([...clients.values()].map((c) => c.sessionKey));
}

async function prune(reason: string): Promise<void> {
	const result = await pruneSessions(liveSessionKeys());
	if (result.dropped || result.closedTabs)
		trace(`prune(${reason}) dropped=${result.dropped} closedBlankTabs=${result.closedTabs}`);
}

let alarmTicks = 0;

/** Wire the bridge into the service worker. Safe to call on every worker start. */
export function startBridge(): void {
	dropEmptyBridgeSessions().catch(() => undefined);
	// Clients are re-announced when the host sees our hello; give that a moment before
	// deciding which bridge sessions are abandoned.
	setTimeout(() => void prune("startup").catch(() => undefined), 20000);
	// Injected code has no runtime providers in the worker; echo so callers can probe the shim.
	setCdpMessageHandler(async (message) => ({ echo: message }));
	startAskBridge();
	chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === ALARM_NAME) {
			if (!port) trace("alarm: port closed, reconnecting");
			connect();
			// Every 5 minutes: forget dead tabs, close blank tabs of abandoned sessions.
			if (++alarmTicks % 10 === 0) void prune("periodic").catch(() => undefined);
		}
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && "bridge_enabled" in changes) connect();
		if (area !== "session") return;
		for (const key of Object.keys(changes)) {
			if (!key.startsWith(DECISION_KEY_PREFIX)) continue;
			const decision = changes[key].newValue as PermissionDecision | undefined;
			if (!decision) continue;
			resolveDecision(key.slice(DECISION_KEY_PREFIX.length), decision);
			chrome.storage.session.remove(key).catch(() => undefined);
		}
	});
	chrome.action.onClicked.addListener(() => connect());
	startThreadMirror((message) => {
		if (!port || !helloSent) return false;
		send(message);
		return true;
	});
	connect();
}

/** What the sessions admin module may see and do with the live clients. */
const adminHost = {
	liveSessionKeys(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const c of clients.values()) counts.set(c.sessionKey, (counts.get(c.sessionKey) ?? 0) + 1);
		return counts;
	},
	/** A renamed session keeps its clients: they drive it under the new name, and reconnect with it. */
	renameLive(oldId: string, newId: string, newName: string): void {
		for (const c of clients.values()) {
			if (c.sessionKey !== oldId) continue;
			c.sessionKey = newId;
			if (c.meta) c.meta.name = newName;
			c.label = `${c.name} · ${newName}`;
			send({ type: "event", clientId: c.clientId, event: "session_renamed", data: { session: newName } });
		}
	},
};

/** For the sidepanel: which harnesses are connected right now. */
export function connectedClients(): Array<{ clientId: string; name: string; sessionKey: string }> {
	return [...clients.values()].map((c) => ({ clientId: c.clientId, name: c.name, sessionKey: c.sessionKey }));
}
