/**
 * The side panel's page tools (read_page, find, act, ...) run here, in the service worker, on the bridge's own
 * handlers (src/bridge/tools.ts) and the panel's browser session. One implementation for both surfaces: the stale-ref
 * refusal, hit-tested clicks, shadow roots, frames and dialog handling are the ones outside agents get through MCP.
 * The panel sends each call as a message (src/tools/page-tools.ts), so it never loads the handlers' capture, PDF and
 * site-edit code (test/panel-size.test.mjs holds the panel's budget).
 *
 * The session's tabs and current tab have one source of truth, the stored session table: the worker reads it under
 * the table lock for each call, its handlers write it the same way, and the panel reads it back after each reply. The
 * screenshot scale act x/y maps by and the open dialogs live here; cdp.ts keeps them in storage.session so they
 * outlive a worker restart, and the panel pings while its model works so the worker isn't stopped mid-turn.
 *
 * What the panel's model may reach is what it reached before: only tabs in its own session (the handlers refuse any
 * other tab), never a Polycarp page, and no tool here opens a site (navigate stays the panel's own tool). Whether to
 * act under the user's sign-in stays a system prompt rule, as for the REPL. A dialog freezes the page the same way it
 * does for the bridge, with the same messages. Only the side panel page may send these calls.
 */

import { cdpMemoryReady, hasScreenshotScale, openDialog, type PageDialog } from "../browser/cdp.js";
import { dialogUseBegin, dialogUseEnd } from "../browser/dialog-guard.js";
import { BrowserSession } from "../browser/session.js";
import { type Delivered, dialogError, isDialogSafe, raceDialogs } from "./dialogs.js";
import { BridgeError, classify, HANDLER_TIMEOUT_MS, withTimeout } from "./errors.js";
import {
	PAGE_TOOL_METHODS,
	PANEL_ABORT,
	PANEL_CALL,
	PANEL_KEEPALIVE,
	PageToolArgsError,
	type PanelAbortMessage,
	type PanelCallMessage,
	type PanelCallReply,
} from "./page-tools.js";
import { isOwnExtensionUrl } from "./permissions.js";
import { ERR } from "./protocol.js";
import { handlers as bridgeHandlers, type HandlerContext } from "./tools.js";

type Handler = (ctx: HandlerContext, params: Record<string, unknown>) => Promise<unknown>;

/** What a panel call needs: the panel's session and the bridge handlers (injected so tests can stand in). */
export interface PanelRunDeps {
	session: Pick<
		BrowserSession,
		| "tabIds"
		| "currentTab"
		| "setCurrent"
		| "requireCurrentTab"
		| "attachedCurrentTab"
		| "currentTabId"
		| "groupName"
		| "id"
	>;
	handlers: Record<string, Handler>;
	/** The dialog open on a tab, if any (cdp.ts openDialog). */
	openDialog?: (tabId: number) => PageDialog | undefined;
	/** Whether a screenshot of the tab set the scale x/y map by (cdp.ts hasScreenshotScale). */
	hasScreenshotScale?: (tabId: number) => boolean;
	/** How long a handler may run (HANDLER_TIMEOUT_MS; tests shorten it). */
	timeoutMs?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A screen point the handler maps through the last screenshot's scale: x/y, or drag's from/to. */
function hasPoint(p: Record<string, unknown>): boolean {
	return (typeof p.x === "number" && typeof p.y === "number") || isObject(p.from) || isObject(p.to);
}

/** Whether a call gives act a point in screenshot pixels, at the top level or in any step. */
function takesPoint(params: Record<string, unknown>): boolean {
	if (hasPoint(params)) return true;
	const steps = Array.isArray(params.steps) ? params.steps : [];
	return steps.some((step) => isObject(step) && Object.values(step).some((v) => isObject(v) && hasPoint(v)));
}

/** The bridge says MCP tool names; the panel lists its tabs with navigate. */
function panelWording(message: string): string {
	return message
		.replace(/tabs_context lists (?:them|your tabs)/g, "navigate {listTabs:true} lists them")
		.replace(/tabs_select another or navigate/g, "navigate {switchToTab} to another");
}

/**
 * Run one bridge handler for the panel. Fails closed: only the page tools' handlers, only the session's own tabs,
 * never a Polycarp page, no site opened, no file sent.
 */
export async function runPanelCall(
	deps: PanelRunDeps,
	method: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const handler = deps.handlers[method];
	if (!PAGE_TOOL_METHODS.has(method) || !handler)
		throw new BridgeError(ERR.NOT_FOUND, `${method} is not a side panel page tool`);
	const { session } = deps;
	// After a worker restart, the scales and dialogs an earlier worker saw come back first.
	await cdpMemoryReady();
	const dialogOf = deps.openDialog ?? openDialog;
	const safe = isDialogSafe(method, params);
	if (!safe) {
		const openOn = session.tabIds.find((id) => dialogOf(id) !== undefined);
		if (openOn !== undefined) throw dialogError(openOn, dialogOf(openOn) as PageDialog);
		// Polycarp's own pages run with the extension's rights; no tool acts on one (as for bridge clients).
		const tab = await session.currentTab();
		if (tab && isOwnExtensionUrl(tab.url ?? tab.pendingUrl ?? ""))
			throw new BridgeError(
				ERR.PERMISSION_DENIED,
				"Your current tab shows a Polycarp page, which the page tools never act on. navigate to the site first.",
			);
	}
	// x/y are pixels of an act screenshot of this tab. With no scale recorded the point would be guessed, and a
	// guessed click can land on the wrong control under the user's sign-in.
	const scaled = deps.hasScreenshotScale ?? hasScreenshotScale;
	if (takesPoint(params) && (session.currentTabId === undefined || !scaled(session.currentTabId)))
		throw new BridgeError(
			ERR.BAD_PARAMS,
			"x/y are pixels of an act screenshot of this tab, and there is none yet. Act by ref, or take act screenshot first.",
		);
	let aborted = signal?.aborted === true;
	const onAbort = () => {
		aborted = true;
	};
	signal?.addEventListener("abort", onAbort);
	let delivered: Delivered | undefined;
	const ctx: HandlerContext = {
		session: session as BrowserSession,
		clientId: "sidepanel",
		emit: () => {},
		aborted: () => aborted,
		delivered: (result, tabId) => {
			delivered = result && tabId !== undefined ? { result, tabId } : undefined;
		},
		// The OAuth approval address is the native host's to name, per bridge request; the panel opens sites with its
		// own navigate, which these tools never call.
		isGuarded: () => false,
		guardedHosts: [],
		checkUrl: async () => {
			throw new BridgeError(ERR.PERMISSION_DENIED, "The page tools don't open sites: use navigate.");
		},
		askUpload: async () => false,
	};
	const used = dialogUseBegin(session, method, params);
	try {
		const work = handler(ctx, params);
		const raced = safe ? work : raceDialogs(session, work, onAbort, () => delivered);
		return await withTimeout(raced, deps.timeoutMs ?? HANDLER_TIMEOUT_MS, method);
	} finally {
		dialogUseEnd(used);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** The error the panel's model reads: the bridge's code and message, in the panel's words. */
export function panelError(err: unknown, method: string): Error {
	if (err instanceof PageToolArgsError) return new Error(`bad_params: ${err.message}`);
	const { error } = classify(err, method);
	return new Error(`${error.code}: ${panelWording(error.message)}`);
}

/**
 * Only the side panel page itself (in the panel, or opened as a tab), never a content script (its url is the web
 * page's), another Polycarp page or another extension.
 */
function fromSidePanel(sender: chrome.runtime.MessageSender): boolean {
	return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL("sidepanel.html")) === true;
}

/** A call in flight: its abort, and its one reply. */
interface Running {
	abort: AbortController;
	reply: (reply: PanelCallReply) => void;
}

/** Answer the side panel's page tool calls. `handlers` is injectable for tests. */
export function startPanelPageTools(
	handlers: Record<string, Handler> = bridgeHandlers as Record<string, Handler>,
): void {
	const running = new Map<string, Running>();
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: PanelCallReply) => void) => {
		const m = message as Partial<PanelCallMessage> | Partial<PanelAbortMessage> | { type?: unknown } | null;
		const type = m?.type;
		if (type !== PANEL_CALL && type !== PANEL_ABORT && type !== PANEL_KEEPALIVE) return undefined;
		const callId = (m as { callId?: unknown }).callId;
		if (!fromSidePanel(sender) || (type !== PANEL_KEEPALIVE && typeof callId !== "string")) {
			if (type === PANEL_CALL) sendResponse({ ok: false, message: "permission_denied: Refused" });
			return undefined;
		}
		// A message is an event, and an event restarts the worker's idle timer: nothing else to do.
		if (type === PANEL_KEEPALIVE) return undefined;
		if (type === PANEL_ABORT) {
			// Stop the handler between steps, and answer the panel now, whatever the handler does next.
			const call = running.get(callId as string);
			call?.abort.abort();
			call?.reply({
				ok: false,
				message:
					"interrupted: You stopped the chat while this call ran; it may have run. read_page before you repeat it.",
			});
			return undefined;
		}
		const { sessionId, method, params } = m as Partial<PanelCallMessage>;
		const name = typeof method === "string" ? method : "";
		let answered = false;
		const call: Running = {
			abort: new AbortController(),
			reply: (reply) => {
				if (answered) return;
				answered = true;
				running.delete(callId as string);
				sendResponse(reply);
			},
		};
		running.set(callId as string, call);
		void (async () => {
			try {
				const session = typeof sessionId === "string" ? await BrowserSession.existing(sessionId) : undefined;
				if (!session)
					throw new BridgeError(ERR.NO_TAB, "Your browser session has ended. navigate to start a new one.");
				const result = await runPanelCall(
					{ session, handlers },
					name,
					isObject(params) ? params : {},
					call.abort.signal,
				);
				call.reply({ ok: true, result });
			} catch (err) {
				call.reply({ ok: false, message: panelError(err, name).message });
			}
		})();
		return true;
	});
}
