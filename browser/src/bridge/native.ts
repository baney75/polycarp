/**
 * Bridge runtime in the service worker.
 *
 * Connects to the native host with chrome.runtime.connectNative (the browser
 * spawns the host), keeps one BrowserSession per connected harness, routes
 * requests to the handlers, and relays permission prompts. Reconnects on a
 * backoff and on a 30 s alarm, which also keeps the worker alive.
 */

import { cancelQuestion, cancelQuestionsFor, handleBridgeAsk, startAskBridge } from "../ask/bridge-worker.js";
import {
	armDialog,
	disarmDialog,
	openDialog,
	type PageDialog,
	stopScreencastsOwnedBy,
	watchDialogs,
} from "../browser/cdp.js";
import {
	type DialogAnswer,
	type DialogCause,
	dialogAnswerArrive,
	dialogAnswerEnd,
	dialogAsk,
	dialogCause,
	dialogSoon,
} from "../browser/dialog-guard.js";
import { setCdpMessageHandler } from "../browser/inject.js";
import { BrowserSession, listSessions, pruneSessions, type SessionMeta, sanitizeLabel } from "../browser/session.js";
import { probeUserScripts } from "../browser/userscripts-status.js";
import { veilBegin, veilEnd, veilSessionGone } from "../browser/veil.js";
import { COMMUNITY_STATUS_KEY } from "../community/status.js";
import { handleThreads } from "../threads/bridge.js";
import { resyncMirror, startThreadMirror } from "../threads/mirror.js";
import { asBuildInfo, BUILD, type BuildInfo } from "../update/build.js";
import type { UpdateAction } from "../update/logic.js";
import { runningFromStore } from "../update/store-install.js";
import {
	type Delivered,
	dialogError,
	dialogPreset,
	isDialogSafe,
	raceDialogs,
	refuseStepPreset,
	type WantedPreset,
} from "./dialogs.js";
import { BridgeError, classify, HANDLER_TIMEOUT_MS, withTimeout } from "./errors.js";
import { dropAllTransfers, dropTransfersForClient } from "./files.js";
import {
	addPendingRequest,
	allowHost,
	DECISION_KEY_PREFIX,
	getPermissionMode,
	hostOf,
	isBridgeEnabled,
	isGuardedUrl,
	isOwnExtensionUrl,
	isUrlAllowed,
	type PermissionDecision,
	type PermissionMode,
	removePendingRequest,
	setPermissionMode,
} from "./permissions.js";
import {
	BRIDGE_METHODS,
	ERR,
	type ExtConnect,
	type ExtSubscription,
	type ExtToHost,
	FILE_ASK_TIMEOUT_MS,
	type HostClientConnected,
	type HostConnect,
	type HostForwardedRequest,
	type HostSubscription,
	type HostToExt,
	type HostUpdateProgress,
	type HostUpdateStatus,
	MAX_FRAME_FROM_EXTENSION,
	NATIVE_HOST_NAMES,
	PROTOCOL_VERSION,
	UPDATE_PROGRESS_KEY,
	UPDATE_STATUS_KEY,
} from "./protocol.js";
import { handleSessionsAdmin } from "./sessions-admin.js";
import { type DeliveredStep, extensionStatus, type HandlerContext, handlers, normalizeStep } from "./tools.js";

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
	/** The client named no session: a one-shot command (`polycarp browser status`), whose key no later client can ask for. */
	unnamed?: boolean;
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

let port: chrome.runtime.Port | undefined;
let reconnectDelay = RECONNECT_MIN_MS;
/** Which of NATIVE_HOST_NAMES the next connect tries: the current name, then the one a helper from before the rename registered. */
let hostNameIndex = 0;
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
		...(msg.client.session ? {} : { unnamed: true }),
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
	// The files tool: content half moved for a client that left is dropped.
	dropTransfersForClient(clientId);
	// A restarted harness (same session key) can connect before its old socket closes; the
	// session is still in use then, so leave it alone.
	const successors = state ? [...clients.values()].filter((c) => c.sessionKey === state.sessionKey) : [];
	// Hand the session on, so the last of them to leave suspends or drops it.
	for (const c of successors) c.session ??= state?.session;
	if (state?.session && successors.length === 0) {
		// Nobody is working in its tabs any more.
		veilSessionGone(state.session.id);
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
	if (isOwnExtensionUrl(url)) return false;
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

/**
 * The files tool's question (docs/decisions.md, D38): may this agent put these local files into the page at `url`?
 * It reaches the person the way a site question does (the agent's own prompt, and "Waiting for your answer" in
 * Settings > Agents), but differs in three ways: it is asked in every permission mode, only "allow once" is a yes,
 * and nothing is remembered, so the next upload asks again.
 */
async function askUpload(
	state: ClientState,
	url: string,
	files: Array<{ name: string; bytes: number }>,
	askId: string,
): Promise<boolean> {
	const host = hostOf(url);
	if (!host || isOwnExtensionUrl(url)) return false;
	const requestId = `${state.clientId}:${crypto.randomUUID()}`;
	const decision = new Promise<PermissionDecision>((resolve) => {
		pendingDecisions.set(requestId, resolve);
		setTimeout(() => {
			if (pendingDecisions.delete(requestId)) resolve("deny");
		}, FILE_ASK_TIMEOUT_MS);
	});
	await addPendingRequest({
		requestId,
		clientId: state.clientId,
		clientName: state.name,
		host,
		url,
		createdAt: Date.now(),
		upload: { files },
	});
	send({
		type: "event",
		clientId: state.clientId,
		event: "permission_request",
		data: { requestId, host, url, timeoutMs: FILE_ASK_TIMEOUT_MS, kind: "upload", agent: state.name, files, askId },
	});
	const result = await decision;
	await removePendingRequest(requestId);
	return result === "allow_once";
}

function guardedError(url: string): BridgeError {
	return new BridgeError(
		ERR.PERMISSION_DENIED,
		`Not allowed to open ${hostOf(url) || url}: it is this computer's Polycarp approval address, and an agent never opens it. The owner approves a connector there themselves, outside the agent's browser.`,
	);
}

function resolveDecision(requestId: string, decision: PermissionDecision): boolean {
	const resolve = pendingDecisions.get(requestId);
	if (!resolve) return false;
	pendingDecisions.delete(requestId);
	resolve(decision);
	return true;
}

const tabIdParam = (params: Record<string, unknown> | undefined) =>
	params?.tabId === undefined ? undefined : Number(params.tabId);

/** The calls on each tab that could open a box there, across every client: a call with on_dialog runs alone (D48). */
const tabCalls = new Map<number, Set<string>>();
/** Tabs a call with on_dialog holds until it ends: no other call acts on them meanwhile. */
const heldTabs = new Map<number, string>();
/**
 * Tabs a call's input was still out on when its 30 s count ran out: a box there may be that input's, so on_dialog is
 * refused and no box gets a cause until it returns (sol-sol-F2 of round 2 of the review of PR 230).
 */
const stuckTabs = new Map<number, Set<string>>();
/** The longest a call with on_dialog waits for other input on its tab to return. */
const WAIT_CAP_MS = 30_000;
const othersOn = (tab: number, call: string) =>
	[...(tabCalls.get(tab) ?? []), ...(stuckTabs.get(tab) ?? [])].some((c) => c !== call);
/** The actions whose box the guard's notice may name (dialog-guard.ts); a hover, scroll or drag box has no known cause. */
const CAUSE_KINDS = new Set(["click", "press", "type", "fill"]);

/** The answer a single click or press set in advance, checked. `actions` takes none (D48): refused here. */
function wantedPreset(method: string, params: Record<string, unknown>): WantedPreset | undefined {
	if (method !== "actions") return dialogPreset(method, params);
	refuseStepPreset(params, normalizeStep);
	return undefined;
}

/**
 * Every tab a call may send input to (sol-F1, first-F2 of the review of PR 200): the one it names, else the current
 * one, and for `actions` each step's own tabId too. A hold covers them all.
 */
function targetTabs(
	method: string,
	params: Record<string, unknown> | undefined,
	current: number | undefined,
): number[] {
	const named = tabIdParam(params);
	const tabs = new Set<number>();
	const top = named !== undefined && Number.isInteger(named) ? named : current;
	if (top !== undefined) tabs.add(top);
	if (method === "actions" && Array.isArray(params?.steps))
		for (const [i, st] of params.steps.entries()) {
			if (!st || typeof st !== "object") continue;
			let sub: Record<string, unknown>;
			try {
				sub = normalizeStep(st as Record<string, unknown>, i)[1];
			} catch {
				continue;
			}
			const own = tabIdParam(sub);
			if (own !== undefined && Number.isInteger(own)) tabs.add(own);
		}
	return [...tabs];
}

async function runRequest(state: ClientState, req: HostForwardedRequest, answer?: DialogAnswer): Promise<void> {
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
	/** This call, for the answer it may arm (`on_dialog`) and the tab it holds. */
	const call = `${state.clientId}:${req.id}`;
	// The host went away: an answer this call armed is taken back at once, so no box that opens later gets the ended
	// call's OK (F2 of the review of PR 227).
	state.abort = () => {
		aborted = true;
		disarmDialog(call);
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
		// client may resend it once Polycarp is back.
		reply(
			undefined,
			new BridgeError(
				ERR.NOT_SENT,
				"Polycarp is installing an update and reloads in a few seconds. The request did not run; repeat it once the bridge reconnects.",
			),
		);
		return;
	}
	// In flight from here, before the first await, so the update idle gate sees it at once.
	state.inFlight = { method: req.method, since: Date.now() };
	state.lastActivityAt = Date.now();
	/** The tabs this call is counted on in `tabCalls`; it holds them all when it has on_dialog. */
	let onTabs: number[] = [];
	let unwatch: (() => void) | undefined;
	let work: Promise<unknown> | undefined;
	/** The session and the tab the in-use veil counted this call on (src/browser/veil.ts). */
	let veiled: { session: BrowserSession; tabId: number | undefined; currentBefore: number | undefined } | undefined;
	try {
		if (!(await isBridgeEnabled())) {
			throw new BridgeError(ERR.DISABLED, "The Polycarp bridge is disabled in Settings > Agents.");
		}
		if (gone()) return;

		const handler = handlers[req.method];
		if (!handler) throw new BridgeError(ERR.NOT_FOUND, `Unknown method ${req.method}`);
		// `polycarp browser status` has no tabs to report and hangs up after one answer. A session opened
		// for it stored an empty record until it left, and Settings > Agents drew that as one more agent
		// for a moment, which moved everything under the list down a row and back.
		if (req.method === "status" && state.unnamed && !state.session) {
			reply({ ...(await extensionStatus()), tabs: [] });
			return;
		}
		const t0 = performance.now();
		const session = await withTimeout(getSession(state), 15000, "session open");
		const tSession = Math.round(performance.now() - t0);
		// The session can take seconds to open; the host may have gone meanwhile.
		if (gone()) return;
		const ctx: HandlerContext = {
			session,
			clientId: state.clientId,
			dialogAnswer: answer,
			emit: (event, data) => send({ type: "event", clientId: state.clientId, event, data }),
			aborted: () => aborted,
			delivered: (result, tabId) => {
				deliveredResult = result && tabId !== undefined ? { result, tabId } : undefined;
			},
			isGuarded: (url: string) => isGuardedUrl(url, req.guardedHosts),
			guardedHosts: req.guardedHosts ?? [],
			// A frame is the page's own when it is on the page's host; any other host needs the person's allow (D46).
			frameAllowed: async (url, topUrl) =>
				(!!topUrl && hostOf(url) === hostOf(topUrl) && !isOwnExtensionUrl(url)) || (await isUrlAllowed(url)),
			askUpload: (url, files, askId) => askUpload(state, url, files, askId),
			checkUrl: async (url: string) => {
				if (isGuardedUrl(url, req.guardedHosts)) throw guardedError(url);
				if (!(await askPermission(state, url))) {
					const mode = await getPermissionMode();
					throw new BridgeError(
						ERR.PERMISSION_DENIED,
						isOwnExtensionUrl(url)
							? "Not allowed to open Polycarp's own pages."
							: `Not allowed to open ${hostOf(url) || url}. ` +
									(mode === "ask"
										? "The user can allow it in the Polycarp side panel under Settings > Agents, or answer the permission prompt."
										: "Bridge navigation is blocked."),
					);
				}
			},
		};
		const dialogSafe = isDialogSafe(req.method, req.params);
		if (!dialogSafe) {
			const openOn = session.tabIds.find((id) => openDialog(id) !== undefined);
			if (openOn !== undefined) throw dialogError(openOn, openDialog(openOn) as PageDialog);
		}
		// on_dialog is checked, and its tab's owner, before anything runs or is armed (sol-F3, first-F4 of the review of PR 193).
		const want = wantedPreset(req.method, req.params ?? {});
		let waited = 0;
		if (want && !session.tabIds.includes(want.tabId))
			throw new BridgeError(
				ERR.NO_TAB,
				`Tab ${want.tabId} is not one of your tabs: on_dialog answers a box on your own tab only (tabs_context lists yours).`,
			);
		if (!dialogSafe) {
			const tabs = want ? [want.tabId] : targetTabs(req.method, req.params, session.currentTabId);
			// One armed answer per tab across every client of the session (sol-F2, first-F2 of the review of PR 193): while a
			// call with on_dialog runs on a tab, no other call sends input there, and it starts only when none does. Refused
			// as not_sent: it never ran, and the client sends it again a little later.
			for (const tab of tabs) {
				const holder = heldTabs.get(tab);
				if ((holder && holder !== call) || (want && holder))
					throw new BridgeError(
						ERR.NOT_SENT,
						want
							? `Another call is still running on tab ${tab}, so this call with on_dialog was not sent. Send it again once that call has ended.`
							: `A call with on_dialog is still running on tab ${tab}, so this call was not sent. Send it again once that call has ended.`,
					);
			}
			onTabs = tabs;
			for (const tab of tabs) {
				tabCalls.set(tab, (tabCalls.get(tab) ?? new Set()).add(call));
				if (want) heldTabs.set(tab, call);
			}
			// The tab is held at once, so no new input starts there; the call with on_dialog then waits, within its own
			// limit, until every other call's input on it has returned (sol-F2 of the review of PR 230). The wait is capped
			// at WAIT_CAP_MS, so the click itself keeps most of its limit (first-F2 of round 2 of the review of PR 230).
			const start = Date.now();
			while (want && [...(tabCalls.get(want.tabId) ?? [])].some((c) => c !== call)) {
				if (aborted || Date.now() - start > WAIT_CAP_MS)
					throw new BridgeError(
						ERR.NOT_SENT,
						`Other input on tab ${want.tabId} is still running, so this call with on_dialog was not sent. Send it again once it has ended.`,
					);
				await new Promise((r) => setTimeout(r, 50));
			}
			waited = Date.now() - start;
			// A box the other input opened while this call waited froze the page: nothing is sent into it, and the OK is
			// not armed for it (first-F1 of round 2 of the review of PR 230).
			const openOn = session.tabIds.find((id) => openDialog(id) !== undefined);
			if (openOn !== undefined) throw dialogError(openOn, openDialog(openOn) as PageDialog);
			if (want && stuckTabs.get(want.tabId)?.size)
				throw new BridgeError(
					ERR.NOT_SENT,
					`Input an earlier call sent on tab ${want.tabId} has not come back, and a box it opens could take this answer, so this call with on_dialog was not sent. Send it again later, or send it without on_dialog and answer the box with handle_dialog.`,
				);
		}
		/** The tab and step whose last input is on its way: a box that opens there now is that step's (second-S3). */
		let delivering: { tabId: number; step?: DeliveredStep } | undefined;
		/** The box this call's on_dialog answered: a box after it is no reason to do anything again (second-S1). */
		let answeredBox: { type: string; message: string } | undefined;
		/** The input that can open the call's box has returned: nothing arms again (second-S2 of the review of PR 200). */
		let inputEnded = false;
		ctx.delivered = (result, tabId, step) => {
			deliveredResult = result && tabId !== undefined ? { result, tabId } : undefined;
			// A box is blamed on an input only while that input is on its way: one that opens in the settle after a click
			// or press returned has no known cause (sol-F1 of the review of PR 216). A step's input is always on its way.
			delivering = result && tabId !== undefined && (step || !inputEnded) ? { tabId, step } : undefined;
			// Armed just before the call's last input goes out, on its own tab, once: never after that input returned,
			// never for another call's box, and never once the call has failed or ended (sol-F2, first-F1).
			if (delivering && want && !step && want.tabId === tabId && !inputEnded && !answeredBox && !aborted)
				armDialog(tabId, call, want.preset);
			else disarmDialog(call);
		};
		ctx.inputDone = () => {
			inputEnded = true;
			delivering = undefined;
			disarmDialog(call);
		};
		// The tab each input resolves to is checked again then: the current tab may have changed since the check above,
		// by another client of the session (sol-F3, first-F2 of the review of PR 216). A tab the call had not counted is
		// counted now, so a call with on_dialog that starts later sees it.
		ctx.claimTab = (tab) => {
			if (dialogSafe) return;
			// A call that ended (a box, a timeout, the host gone) counts on no tab again: its finally already ran, so a tab
			// counted now would stay held by nothing (F3 of the review of PR 227).
			if (aborted) throw new BridgeError(ERR.INTERRUPTED, "This call has ended, so this input was not sent.");
			if (onTabs.includes(tab)) return;
			const holder = heldTabs.get(tab);
			if (holder && holder !== call)
				throw new BridgeError(
					ERR.NOT_SENT,
					`A call with on_dialog is still running on tab ${tab}, so this input was not sent. Send it again once that call has ended.`,
				);
			onTabs.push(tab);
			tabCalls.set(tab, (tabCalls.get(tab) ?? new Set()).add(call));
		};
		if (!dialogSafe)
			unwatch = watchDialogs((tabId, dialog) => {
				if (!delivering || delivering.tabId !== tabId) return;
				const kind = delivering.step?.kind ?? req.method;
				if (!CAUSE_KINDS.has(kind)) return;
				const own = dialog.presetCall === call;
				// While another call counts on the tab, a timed-out press's release included, no cause is known (sol-F1, PR 230).
				const rivals = othersOn(tabId, call);
				const cause: DialogCause = {
					method: req.method,
					tabId,
					step: { kind, params: delivering.step?.params ?? req.params ?? {} },
					...(delivering.step ? { batch: { index: delivering.step.index, total: delivering.step.total } } : {}),
					...(!own && answeredBox ? { after: answeredBox } : {}),
				};
				if (own || !rivals) dialogCause(dialog.seq, cause);
				if (own) answeredBox = { type: dialog.type, message: dialog.message };
			});
		veiled = {
			session,
			currentBefore: session.currentTabId,
			tabId: await veilBegin(session, req.method, req.params).catch(() => undefined),
		};
		work = handler(ctx, req.params ?? {});
		// An upload's begin may wait for the person's answer, which has its own, longer limit.
		const limit = (req.method === "files.upload.begin" ? FILE_ASK_TIMEOUT_MS + 30000 : HANDLER_TIMEOUT_MS) - waited;
		// A call that can open a box runs out of time inside raceDialogs, which says what its on_dialog answered first
		// (sol-F2, second-S2 of the review of PR 216); the outer limit only backs that up.
		const result = await withTimeout(
			dialogSafe
				? work
				: raceDialogs(
						session,
						work,
						() => {
							aborted = true;
							disarmDialog(call);
						},
						() => deliveredResult,
						{ call, method: req.method, soon: dialogSoon, deadline: { ms: limit, label: req.method } },
					),
			dialogSafe ? limit : limit + 10_000,
			req.method,
		);
		trace(`${state.name} ${req.method} session=${tSession}ms total=${Math.round(performance.now() - t0)}ms`);
		reply(result);
	} catch (err) {
		state.lastError = `${req.method}: ${err instanceof Error ? err.message : String(err)}`;
		console.warn("[Bridge]", state.lastError);
		const { error, stack } = classify(err, req.method);
		// The trace is for whoever debugs Polycarp (polycarp browser debug), not for the agent.
		if (stack) trace(`${req.method} ${error.code}: ${stack.split("\n").slice(0, 6).join(" | ")}`);
		reply(undefined, error);
	} finally {
		// For good (sol-F2, first-F1 of the review of PR 200): a handler still running after a timeout arms nothing and
		// sends no more input.
		aborted = true;
		disarmDialog(call);
		unwatch?.();
		// Counted until the handler's input has returned, not just the call: a press that outlived the call's limit, and its
		// release, can still open a box there (sol-F2 of the review of PR 230). Past 30 s the tab is stuck (`stuckTabs`).
		const tabs = onTabs;
		const release = () => {
			clearTimeout(cap);
			for (const tab of tabs) {
				const calls = tabCalls.get(tab);
				calls?.delete(call);
				if (!calls?.size) tabCalls.delete(tab);
				if (heldTabs.get(tab) === call) heldTabs.delete(tab);
			}
		};
		const settled = () => {
			release();
			for (const tab of tabs)
				if (stuckTabs.get(tab)?.delete(call) && !stuckTabs.get(tab)?.size) stuckTabs.delete(tab);
		};
		const stuck = () => {
			release();
			for (const tab of tabs) stuckTabs.set(tab, (stuckTabs.get(tab) ?? new Set()).add(call));
		};
		const cap = work && tabs.length ? setTimeout(stuck, 30_000) : undefined;
		if (cap === undefined) release();
		else void work?.then(settled, settled);
		if (veiled) veilEnd(veiled.session, req.method, veiled.tabId, veiled.currentBefore);
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
						"Polycarp is installing an update and reloads in a few seconds. Ask again once the bridge reconnects.",
				},
			});
		if (!(await isBridgeEnabled()))
			return respond({
				error: { code: ERR.DISABLED, message: "The Polycarp bridge is disabled in Settings > Agents." },
			});
		// The client may have hung up during the awaits; its question would have nobody to answer to.
		if (clients.get(state.clientId) !== state) return;
		// A box on the session's tab may wait for the person's answer too (dialog-guard.ts).
		const asker = state.sessionKey;
		dialogAsk(asker, true);
		try {
			respond(await handleBridgeAsk(state, req.params ?? {}));
		} finally {
			dialogAsk(asker, false);
		}
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

/** Connect frames go to the relay (src/connect/relay.ts); "disconnected" when the host goes. */
let connectHandler: ((message: HostConnect | "disconnected") => void) | undefined;

export function onConnectMessage(handler: (message: HostConnect | "disconnected") => void): void {
	connectHandler = handler;
}

/** Send a Connect request to the host; false when no host is connected. */
export function sendConnect(message: ExtConnect): boolean {
	if (!port) return false;
	send(message);
	return true;
}

function onHostMessage(message: HostToExt): void {
	switch (message.type) {
		case "connect":
			connectHandler?.(message);
			return;
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
				// `polycarp browser allow <host>`: a local user process granting a host, same trust as the side panel.
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
				// `polycarp browser allow-all` / `tabkyra ask`: a local user process flipping the site-permission mode,
				// same trust as the Settings > Agents toggle.
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
				// `polycarp browser sessions`: a local user process, the side panel's trust; no session of its own.
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
								.filter((g) => g.title?.startsWith("Polycarp") || g.title?.startsWith("Tabkyra")) // product-name allowlist: legacy tab group title
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
						// Answer even when a probe fails, so `polycarp browser doctor` and `debug` don't wait out a timeout.
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
							"Polycarp is installing an update and reloads in a few seconds. Repeat the request once the bridge reconnects.",
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
				if (runningFromStore()) {
					send({
						type: "response",
						clientId: message.clientId,
						id: message.id,
						error: {
							code: ERR.NOT_FOUND,
							message: "A copy from the Chrome Web Store is updated by the browser.",
						},
					});
					return;
				}
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
			// A handle_dialog holds its box's Cancel from here, queued behind other calls included (dialog-guard.ts).
			const answer =
				message.method === "dialog"
					? dialogAnswerArrive(current.sessionKey, current.session?.tabIds, tabIdParam(message.params))
					: undefined;
			current.queue = current.queue
				.then(() => runRequest(current, message, answer))
				.catch(() => undefined)
				.then(() => {
					if (answer) dialogAnswerEnd(answer);
				});
			return;
		}
	}
}

/** `now` tries again at once and leaves the backoff as it is (the fallback to the old host name). */
function scheduleReconnect(now = false): void {
	if (reconnectTimer) return;
	const delay = now ? 0 : reconnectDelay;
	if (!now) reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		connect();
	}, delay);
}

function connect(): void {
	if (port) return;
	let next: chrome.runtime.Port;
	try {
		next = chrome.runtime.connectNative(NATIVE_HOST_NAMES[hostNameIndex]);
	} catch (err) {
		console.debug("[Bridge] connectNative failed:", err);
		scheduleReconnect();
		return;
	}
	port = next;
	let talked = false;
	next.onMessage.addListener((message: HostToExt) => {
		// Reset the backoff only once a host actually talks, so a host that exits at once
		// (crash loop) is retried ever more slowly instead of every second.
		reconnectDelay = RECONNECT_MIN_MS;
		talked = true;
		onHostMessage(message);
	});
	next.onDisconnect.addListener(() => {
		const reason = chrome.runtime.lastError?.message ?? "closed";
		// "Specified native messaging host not found" means the CLI installer has not run yet.
		console.debug("[Bridge] native host disconnected:", reason);
		if (port === next) port = undefined;
		// No host registered under this name (or not for this extension): try the next name, the old one straight away. A host
		// that starts and dies keeps its name, so a crash loop still backs off.
		const unregistered = !talked && /not found|forbidden/i.test(reason);
		if (unregistered) hostNameIndex = (hostNameIndex + 1) % NATIVE_HOST_NAMES.length;
		subscriptionHandler?.("disconnected");
		connectHandler?.("disconnected");
		// The host answered these "interrupted: it may have run" and the agent may repeat them
		// after checking the page: the running handlers must send no more input.
		for (const state of clients.values()) {
			state.closed = true;
			state.abort?.();
		}
		// The files tool: an upload being committed for any of them stops, and its pieces are cleared.
		dropAllTransfers();
		for (const state of clients.values()) {
			if (state.session) veilSessionGone(state.session.id);
			void state.session?.suspend();
		}
		clients.clear();
		cancelQuestionsFor(undefined);
		void stopScreencastsOwnedBy(undefined).catch(() => undefined);
		scheduleReconnect(unregistered && hostNameIndex > 0);
	});
	trace("native port connected");
	// The hello says which build runs and which build the extension folder holds now, so the host
	// can tell whether the browser loads Polycarp from the folder it updates (docs/updates.md).
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
