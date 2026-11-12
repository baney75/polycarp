/**
 * The side panel's page tools (read_page, find, act, ...) run here, in the service worker, on the bridge's own
 * handlers (src/bridge/tools.ts) and the panel's browser session. One implementation for both surfaces: the stale-ref
 * refusal, hit-tested clicks, shadow roots, frames and dialog handling are the ones outside agents get through MCP.
 * The panel sends each call as a message (src/tools/page-tools.ts), so it never loads the handlers' capture, PDF and
 * site-edit code (test/panel-size.test.mjs holds the panel's budget), and the screenshot scale that act x/y reads is
 * the one act screenshot recorded, both in this context.
 *
 * What the panel's model may reach is what it reached before: only tabs in its own session (the handlers refuse any
 * other tab), never a Polycarp page, and no tool here opens a site (navigate stays the panel's own tool). Whether to
 * act under the user's sign-in stays a system prompt rule, as for the REPL. A dialog freezes the page the same way it
 * does for the bridge, with the same messages. Only the side panel page may send these calls.
 */

import { openDialog, type PageDialog } from "../browser/cdp.js";
import { BrowserSession } from "../browser/session.js";
import { type Delivered, dialogError, isDialogSafe, raceDialogs } from "./dialogs.js";
import { BridgeError, classify } from "./errors.js";
import {
	PAGE_TOOL_METHODS,
	PANEL_ABORT,
	PANEL_CALL,
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
	try {
		const work = handler(ctx, params);
		return await (safe ? work : raceDialogs(session, work, onAbort, () => delivered));
	} finally {
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

/** Answer the side panel's page tool calls. `handlers` is injectable for tests. */
export function startPanelPageTools(
	handlers: Record<string, Handler> = bridgeHandlers as Record<string, Handler>,
): void {
	const running = new Map<string, AbortController>();
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: PanelCallReply) => void) => {
		const m = message as Partial<PanelCallMessage> | Partial<PanelAbortMessage> | null;
		if (m?.type !== PANEL_CALL && m?.type !== PANEL_ABORT) return undefined;
		if (!fromSidePanel(sender) || typeof m.callId !== "string") {
			if (m.type === PANEL_CALL) sendResponse({ ok: false, message: "permission_denied: Refused" });
			return undefined;
		}
		if (m.type === PANEL_ABORT) {
			running.get(m.callId)?.abort();
			return undefined;
		}
		const { callId, sessionId, method, params } = m as Partial<PanelCallMessage>;
		const name = typeof method === "string" ? method : "";
		const ac = new AbortController();
		running.set(callId as string, ac);
		void (async () => {
			try {
				const session = typeof sessionId === "string" ? await BrowserSession.existing(sessionId) : undefined;
				if (!session)
					throw new BridgeError(ERR.NO_TAB, "Your browser session has ended. navigate to start a new one.");
				const result = await runPanelCall(
					{ session, handlers },
					name,
					params && typeof params === "object" ? params : {},
					ac.signal,
				);
				sendResponse({ ok: true, result });
			} catch (err) {
				sendResponse({ ok: false, message: panelError(err, name).message });
			} finally {
				running.delete(callId as string);
			}
		})();
		return true;
	});
}
