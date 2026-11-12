/**
 * Bridge method handlers. Each runs against one BrowserSession (one per connected
 * harness) and uses the same primitives as the sidepanel tools. Nothing here
 * changes the active tab except `tabs.show`.
 */

import { CaptureError } from "../browser/capture.js";
import { captures } from "../browser/capture-chrome.js";
import {
	answerDialog,
	captureScreenshot,
	scroll as cdpScroll,
	cdpSend,
	click,
	cuePointer,
	drag,
	enableConsoleCapture,
	enableNetworkCapture,
	evaluateMain,
	hover,
	isDetachError,
	isNavigatedError,
	networkCapturing,
	openDialog,
	pressKey,
	readConsole,
	readNetwork,
	readNetworkDetail,
	reattach,
	screenshotToCss,
	startCapture,
	startScreencast,
	stopScreencast,
	typeText,
} from "../browser/cdp.js";
import {
	afterAction,
	type Before,
	beforeAction,
	movedTo,
	NEW_PAGE,
	NOT_LOADED,
	STILL_LOADING,
	tabChanges,
} from "../browser/changes.js";
import { type DialogAnswer, dialogAnswerArrive, dialogAnswerEnd, dialogUnheard } from "../browser/dialog-guard.js";
import { injectScript } from "../browser/inject.js";
import {
	fillElement,
	goBack,
	goForward,
	inspectPage,
	locate,
	navigateTabDetailed,
	pageHtml,
	pageText,
	runInPage,
	scrollPage,
	snapshot,
	waitFor,
} from "../browser/page.js";
import { type BrowserSession, TabLimitError, takeNotices } from "../browser/session.js";
import { settle, settleStart, unsettledNote, WAIT_SETTLE } from "../browser/settle.js";
import { isPdfTab, pdfText } from "../offscreen/pdf-client.js";
import {
	added as addedEdit,
	change as changeEdits,
	type EditKind,
	guardedUnder,
	load as loadEdits,
	newId as newEditId,
	normalizeHost,
	removed as removedEdit,
	SiteEditError,
	switched as switchedEdit,
} from "../site-edits/store.js";
import { BUILD } from "../update/build.js";
import { searchTab } from "./document-search.js";
import { BridgeError, classify, detachedError, interruptedError, navigatedError } from "./errors.js";
import { dropTransfersForSession, fileHandlers } from "./files.js";
import { rankMatches } from "./find.js";
import {
	fitSlice,
	newestPage,
	PDF_DEFAULT_CHARS,
	pdfCutNote,
	pdfWindow,
	READ_MAX_CHARS,
	readChars,
	sliceInfo,
} from "./paging.js";
import { getAllowedHosts, getPermissionMode } from "./permissions.js";
import { ERR } from "./protocol.js";

export { BridgeError, detachedError };

type Params = Record<string, unknown>;

export interface HandlerContext {
	session: BrowserSession;
	/** Ask before a navigation to a host that is not allowed yet; throws when denied. */
	checkUrl(url: string): Promise<void>;
	/** Whether the URL is on a host an agent never opens (the OAuth approval address, issue #94). */
	isGuarded(url: string): boolean;
	/** The hosts behind `isGuarded`, as the CLI sent them ("host" or "host:port"). */
	guardedHosts?: readonly string[];
	/**
	 * Ask the person whether these local files may go to the page at `url` (the files tool, D38). True only for a
	 * yes to this one upload: no answer and a no are both false, and the answer is never remembered. `askId` is the
	 * caller's id for the one call that asks; it goes back with the question.
	 */
	askUpload(url: string, files: Array<{ name: string; bytes: number }>, askId: string): Promise<boolean>;
	/** Stable id of the calling client. */
	clientId: string;
	/** handle_dialog's box, fixed when the request reached the worker (dialog-guard.ts `dialogAnswerArrive`). */
	dialogAnswer?: DialogAnswer;
	/** Push an event to the calling client only. */
	emit(event: string, data: Record<string, unknown>): void;
	/**
	 * True once this call has failed on a dialog. The handler may still be running (its CDP
	 * call was waiting on the frozen page); it must send no more input after that.
	 */
	aborted(): boolean;
	/**
	 * Call just before the last input event of an action goes out, with the result to report. If a
	 * dialog opens from here on, the action itself worked, and the call returns this result with a
	 * note about the dialog instead of failing with dialog_open (which made agents repeat it).
	 * `tabId` is the tab the input went to: only a dialog that opens on it counts as this action's
	 * effect (a dialog on another tab of the session keeps failing with dialog_open).
	 * `notRun`, if set, is how many later steps of the call did not run. Call with no result once
	 * the action has finished, so a dialog from a later step is not blamed on this one.
	 */
	delivered(result?: Record<string, unknown>, tabId?: number): void;
	/** Set for a step of `actions`: the batch settles once, after its last step. */
	batch?: boolean;
}

/**
 * Wait for the page to settle after an action that started at `since` (src/browser/settle.ts),
 * then say what changed (src/browser/changes.ts) when `before` was taken. Returns what the result
 * adds: the reason when the page did not settle, and `changes`.
 * `delivered` is the action's result so far: the action is done, so a dialog the page opens while
 * it settles or is looked at is the action's effect, reported with that result, not a dialog_open
 * failure. `watched`: settleStart already turned Network on in this tab.
 */
async function settleAfter(
	ctx: HandlerContext,
	tabId: number,
	since: number,
	delivered: Record<string, unknown>,
	// `wait`: a shorter settle than an action's (drag). `changes`: a report known without a look.
	options: {
		watched?: boolean;
		before?: Before;
		wait?: { capMs: number; quietMs: number };
		changes?: Record<string, unknown>;
	} = {},
): Promise<Record<string, unknown>> {
	if (ctx.batch) {
		// The step is over: a dialog from a later step is not this one's.
		ctx.delivered();
		return {};
	}
	ctx.delivered(delivered, tabId);
	try {
		const settled = await settle(tabId, {
			since,
			stop: ctx.aborted,
			skip: (u) => ctx.isGuarded(u),
			guardedHosts: ctx.guardedHosts,
			watched: options.watched ?? true,
			...options.wait,
		}).catch(() => undefined);
		const out: Record<string, unknown> = settled ? unsettledNote(settled) : {};
		if (options.changes && !openDialog(tabId)) out.changes = options.changes;
		// A box froze the page: there is nothing to look at until it is answered.
		else if (options.before && !openDialog(tabId) && !ctx.aborted()) {
			// A navigation in flight counts: its pendingUrl is where the tab is going (#94).
			const urlOf = async (id: number) => {
				const tab = await chrome.tabs.get(id);
				return tab.pendingUrl || tab.url || "";
			};
			const changes = await afterAction(options.before, ctx.session.tabIds, urlOf, (u) => ctx.isGuarded(u)).catch(
				() => undefined,
			);
			if (changes) out.changes = changes;
		}
		return out;
	} finally {
		ctx.delivered();
	}
}

/** A drag's settle: short, so a drop that lands a frame or a transition later is seen (D41). */
const DRAG_SETTLE = { capMs: 600, quietMs: 200 };

/** The main frame's loader: a new one is a new document. Undefined when the debugger can't say. */
async function mainLoader(tabId: number): Promise<string | undefined> {
	const tree = await cdpSend<{ frameTree?: { frame?: { loaderId?: string } } }>(tabId, "Page.getFrameTree").catch(
		() => undefined,
	);
	return tree?.frameTree?.frame?.loaderId;
}

/**
 * When an action starts, for its settle wait: Network on in its tab. A batch step skips it, since the
 * batch turned Network on once before its first step and settles once after its last.
 */
function actionStart(ctx: HandlerContext, tabId: number): Promise<number> {
	return ctx.batch ? Promise.resolve(Date.now()) : settleStart(tabId);
}

/**
 * Look at the page before an action, for its change report (src/browser/changes.ts). A tab on, or
 * on its way to, a guarded host (#94) gets no look: the action's own check refuses it.
 */
async function changesBefore(ctx: HandlerContext, tabId: number, params?: Params): Promise<Before | undefined> {
	if (ctx.batch) return undefined;
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	if (!tab || ctx.isGuarded(tab.pendingUrl || tab.url || "")) return undefined;
	return beforeAction(tabId, ctx.session.tabIds, params ? str(params, "ref") : undefined, ctx.guardedHosts ?? []);
}

function stopIfAborted(ctx: HandlerContext): void {
	if (ctx.aborted())
		throw new BridgeError(
			ERR.DIALOG_OPEN,
			"Stopped: a dialog opened during this call. Answer it with handle_dialog, then read_page to see what ran.",
		);
}

type Handler = (ctx: HandlerContext, params: Params) => Promise<unknown>;

function num(params: Params, key: string): number | undefined {
	const v = params[key];
	if (v === undefined || v === null) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new BridgeError(ERR.BAD_PARAMS, `${key} must be a number`);
	return n;
}

function str(params: Params, key: string): string | undefined {
	const v = params[key];
	if (v === undefined || v === null) return undefined;
	return String(v);
}

function requireStr(params: Params, key: string): string {
	const v = str(params, key);
	if (!v) throw new BridgeError(ERR.BAD_PARAMS, `${key} is required`);
	return v;
}

async function resolveTab(ctx: HandlerContext, params: Params, attach: boolean): Promise<number> {
	const tabId = num(params, "tabId");
	if (tabId !== undefined) {
		if (!ctx.session.tabIds.includes(tabId)) {
			throw new BridgeError(ERR.NOT_FOUND, `Tab ${tabId} is not one of your tabs. tabs_context lists them.`);
		}
		await ctx.session.setCurrent(tabId);
	}
	const tab = attach ? await ctx.session.attachedCurrentTab() : await ctx.session.requireCurrentTab();
	if (tab.id === undefined) throw new BridgeError(ERR.NO_TAB, "You have no tab yet: navigate opens one.");
	// Backstop for a landing the commit watcher has not caught: no tool reads or acts on the approval page.
	await refuseGuardedLanding(ctx, tab.id, { url: tab.url ?? "" });
	return tab.id;
}

/** A new tab for the agent, refused with what to do once the session holds the most it may. */
async function createCapped(session: BrowserSession, url?: string): Promise<chrome.tabs.Tab> {
	try {
		return await session.createTab(url, { capped: true });
	} catch (err) {
		if (err instanceof TabLimitError) throw new BridgeError(ERR.TAB_LIMIT, err.message);
		throw err;
	}
}

/**
 * A new tab for the agent with console and network capture already on. The tab opens on
 * about:blank and the URL loads after capture starts, so the first page's requests and logs are
 * kept (a tab opened straight on the URL had loaded before anything listened). `ready` is false
 * when the wait for the page gave up. `note` says so when capture could not start: the first load
 * is then missed, and the first read_console/read_network starts capture as before.
 *
 * A page that fails to load (DNS, refused) is `tolerant` for tabs_create, which has always opened
 * the tab and reported it; navigate rethrows, so the agent gets navigation_failed (the tab stays
 * in the session either way).
 */
async function openCapturedTab(
	ctx: HandlerContext,
	url: string | undefined,
	timeoutMs: number,
	tolerant: boolean,
): Promise<{ tab: chrome.tabs.Tab; ready: boolean; note?: string }> {
	const tab = await createCapped(ctx.session, "about:blank");
	const tabId = tab.id as number;
	watchGuardedCommits(ctx, tabId);
	const failed = await startCapture(tabId);
	const note = failed
		? `Console and network capture could not start on this tab (${failed}), so its first load was not captured; read_console or read_network starts capture from the next call.`
		: undefined;
	if (failed) console.warn("[Bridge] capture did not start on a new tab:", failed);
	if (!url) return { tab, ready: true, note };
	try {
		return { tab, ready: !(await navigateTabDetailed(tabId, url, { timeoutMs })).timedOut, note };
	} catch (err) {
		if (tolerant && err instanceof Error && err.message.startsWith("Navigation to ")) {
			// Opened, as tabs_create always did, but say the page is not there.
			const notLoaded = `The page did not load: ${err.message}`;
			return { tab, ready: true, note: note ? `${notLoaded} ${note}` : notLoaded };
		}
		throw err;
	}
}

/** The session as session_info and tabs_context show it. */
async function sessionSummary(session: BrowserSession) {
	const r = session.record;
	const group = r.groupId === undefined ? undefined : await chrome.tabGroups.get(r.groupId).catch(() => undefined);
	return {
		name: r.name ?? r.id.replace(/^bridge-/, ""),
		...(r.agent ? { agent: r.agent } : {}),
		...(r.project ? { project: r.project } : {}),
		group: group
			? { title: group.title ?? session.groupName, color: group.color, collapsed: group.collapsed }
			: { title: session.groupName, color: r.color, open: false },
		currentTabId: r.currentTabId ?? null,
		...(r.createdAt ? { createdAt: new Date(r.createdAt).toISOString() } : {}),
		...(r.lastUsedAt ? { lastUsedAt: new Date(r.lastUsedAt).toISOString() } : {}),
	};
}

/** `stillLoading`: the wait gave up before DOMContentLoaded (the page may be incomplete). */
async function tabSummary(tabId: number, stillLoading = false) {
	const tab = await chrome.tabs.get(tabId);
	return {
		tabId,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		...(stillLoading ? { loading: true } : {}),
	};
}

/**
 * A redirect or a history step can land the agent's tab on a host it may not open. Move the tab off
 * it and refuse, so the approval page is never left in front of the agent (issue #94).
 */
async function refuseGuardedLanding<T extends { url: string }>(
	ctx: HandlerContext,
	tabId: number,
	summary: T,
): Promise<T> {
	if (!ctx.isGuarded(summary.url)) return summary;
	await chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => undefined);
	throw new BridgeError(ERR.PERMISSION_DENIED, GUARDED_LANDING);
}

const GUARDED_LANDING =
	"That page led to this computer's Polycarp approval address, which an agent never opens. The tab was reset to a blank page.";

/** How long after a navigation starts a late redirect is still caught. */
const GUARD_WATCH_MS = 120000;

/**
 * A redirect can finish after navigate gave up waiting (its timeout, 20s by default), when the
 * landing check has already read the old URL. Watch the tab's main-frame commits for a while after
 * every agent navigation and blank the tab if one lands on a guarded host (issue #94).
 */
function watchGuardedCommits(ctx: HandlerContext, tabId: number): void {
	const onCommitted = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
		if (d.tabId === tabId && d.frameId === 0 && ctx.isGuarded(d.url))
			void chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => undefined);
	};
	chrome.webNavigation.onCommitted.addListener(onCommitted);
	setTimeout(() => chrome.webNavigation.onCommitted.removeListener(onCommitted), GUARD_WATCH_MS);
}

function target(params: Params): { ref?: string; selector?: string } {
	return { ref: str(params, "ref"), selector: str(params, "selector") };
}

async function pointFor(_ctx: HandlerContext, params: Params, tabId: number): Promise<{ x: number; y: number }> {
	const x = num(params, "x");
	const y = num(params, "y");
	if (x !== undefined && y !== undefined) return screenshotToCss(tabId, { x, y });
	const t = target(params);
	if (!t.ref && !t.selector)
		throw new BridgeError(
			ERR.BAD_PARAMS,
			"Give a ref from read_page (best), a selector, or x and y from your latest screenshot.",
		);
	const rect = await locate(tabId, t);
	return { x: rect.x, y: rect.y };
}

/** One `actions` step as [handler, params]; accepts the spellings models reach for. */
function normalizeStep(step: Params, i: number): [string, Params] {
	const obj = (v: unknown): Params => (v && typeof v === "object" ? (v as Params) : {});
	if ("press" in step) return ["press", typeof step.press === "string" ? { key: step.press } : obj(step.press)];
	if ("key" in step) return ["press", { key: String(step.key), ...(step.repeat ? { repeat: step.repeat } : {}) }];
	if ("type" in step) return ["type", typeof step.type === "string" ? { text: step.type } : obj(step.type)];
	if ("text" in step) return ["type", { text: String(step.text) }];
	if ("click" in step) return ["click", obj(step.click)];
	if ("doubleClick" in step || "dblclick" in step)
		return ["click", { ...obj(step.doubleClick ?? step.dblclick), clickCount: 2 }];
	if ("drag" in step) return ["drag", obj(step.drag)];
	if ("hover" in step || "move" in step) return ["hover", obj(step.hover ?? step.move)];
	if ("scroll" in step) return ["scroll", obj(step.scroll)];
	for (const k of ["wait", "sleep", "pause"])
		if (k in step) return ["wait", typeof step[k] === "number" ? { ms: step[k] } : obj(step[k])];
	if ("screenshot" in step) return ["screenshot", {}];
	throw new BridgeError(
		ERR.BAD_PARAMS,
		`step ${i}: expected one of press, click, doubleClick, drag, type, hover, scroll, wait, screenshot`,
	);
}

/** Site edits for agents. Everything an agent adds says it was an agent; a script it adds stays off for the person. */
const editHandlers: Record<string, Handler> = {
	"edits.list": async (_ctx, params) => {
		const state = await loadEdits();
		const host = str(params, "host");
		const only = host ? normalizeHost(host) : undefined;
		return {
			adBlock: state.adBlock,
			edits: state.edits.filter((e) => !only || e.host === only || only.endsWith(`.${e.host}`)),
		};
	},
	"edits.add": async (ctx, params) => {
		const kind = requireStr(params, "kind") as EditKind;
		const who = ctx.session.groupName || ctx.clientId;
		let host: string;
		try {
			host = normalizeHost(requireStr(params, "host"));
		} catch (err) {
			if (err instanceof SiteEditError) throw new BridgeError(ERR.BAD_PARAMS, err.message);
			throw err;
		}
		// Changing a site takes the same permission as opening it: an agent can't edit what it may not visit. An edit also
		// reaches the site's subdomains, so a site with a guarded one under it is refused too.
		const site = `https://${host}/`;
		const under = guardedUnder(host, ctx.guardedHosts ?? []);
		if (ctx.isGuarded(site) || under)
			throw new BridgeError(
				ERR.BAD_PARAMS,
				under && !ctx.isGuarded(site)
					? `An edit on ${host} would reach ${under}, which agents never open.`
					: `${host} is a site agents never open, so they can't edit it.`,
			);
		await ctx.checkUrl(site);
		try {
			const edit = await changeEdits((state) => {
				const next = addedEdit(
					state,
					{
						host: requireStr(params, "host"),
						kind,
						value: requireStr(params, "value"),
						note: str(params, "note"),
						actor: "agent",
						who,
					},
					newEditId(),
					Date.now(),
				);
				return { state: next.state, result: next.edit };
			});
			return {
				edit,
				note:
					edit.kind === "script" && !edit.on
						? "Saved, and off until the person turns it on in Settings > Sites: a script runs with their sign-in on every visit. Tell them it's waiting."
						: "On now, for every visit. The person can undo it in Settings > Sites.",
			};
		} catch (err) {
			if (err instanceof SiteEditError) throw new BridgeError(ERR.BAD_PARAMS, err.message);
			throw err;
		}
	},
	"edits.off": async (_ctx, params) => {
		try {
			await changeEdits((state) => ({
				state: switchedEdit(state, requireStr(params, "id"), false, "agent"),
				result: undefined,
			}));
		} catch (err) {
			if (err instanceof SiteEditError) throw new BridgeError(ERR.BAD_PARAMS, err.message);
			throw err;
		}
		return { off: requireStr(params, "id") };
	},
	"edits.remove": async (_ctx, params) => {
		try {
			await changeEdits((state) => ({ state: removedEdit(state, requireStr(params, "id")), result: undefined }));
		} catch (err) {
			if (err instanceof SiteEditError) throw new BridgeError(ERR.BAD_PARAMS, err.message);
			throw err;
		}
		return { removed: requireStr(params, "id") };
	},
	"edits.adblock": async (_ctx, params) => {
		const on = params.on === true;
		await changeEdits((state) => ({ state: { ...state, adBlock: on }, result: undefined }));
		return { adBlock: on };
	},
};

/** The part of `status` that is about the extension, not a session. */
export async function extensionStatus() {
	const [permissionMode, allowedHosts] = await Promise.all([getPermissionMode(), getAllowedHosts()]);
	return {
		extensionVersion: chrome.runtime.getManifest().version,
		// What this extension was built from, for `polycarp version`.
		...(BUILD
			? { build: { commit: BUILD.commit, commitDate: BUILD.commitDate ?? "", dirty: BUILD.dirty === true } }
			: {}),
		permissionMode,
		allowedHosts,
	};
}

export const handlers: Record<string, Handler> = {
	...editHandlers,
	...fileHandlers(resolveTab),
	/** For the MCP `status` tool: what this session may open and where its tabs are. */
	status: async (ctx) => {
		const [extension, tabs] = await Promise.all([extensionStatus(), ctx.session.tabs()]);
		return {
			...extension,
			tabGroup: ctx.session.groupName,
			tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, current: t.current })),
		};
	},

	"tabs.context": async (ctx) => {
		const tabs = await ctx.session.tabs();
		const notices = await takeNotices(ctx.session.id);
		return {
			session: await sessionSummary(ctx.session),
			...(notices.length ? { notices } : {}),
			tabs: tabs.map((t) => ({
				tabId: t.id,
				url: t.url,
				title: t.title,
				current: t.current,
				...(t.inGroup ? {} : { inGroup: false }),
			})),
		};
	},

	"tabs.create": async (ctx, params) => {
		const url = str(params, "url");
		if (url) await ctx.checkUrl(url);
		const { tab, ready, note } = await openCapturedTab(ctx, url, 20000, true);
		return refuseGuardedLanding(ctx, tab.id!, { ...(await tabSummary(tab.id!, !ready)), ...(note ? { note } : {}) });
	},

	"tabs.close": async (ctx, params) => {
		const tabId = num(params, "tabId");
		if (tabId === undefined)
			throw new BridgeError(ERR.BAD_PARAMS, "tabId is required (tabs_context lists your tabs)");
		await ctx.session.closeTab(tabId);
		return { closed: tabId };
	},

	"tabs.select": async (ctx, params) => {
		const tabId = num(params, "tabId");
		if (tabId === undefined)
			throw new BridgeError(ERR.BAD_PARAMS, "tabId is required (tabs_context lists your tabs)");
		const tab = await ctx.session.setCurrent(tabId);
		return tabSummary(tab.id!);
	},

	/** Hand one of the session's tabs to the user: out of the group, still open, no longer the agent's. */
	"tabs.release": async (ctx, params) => {
		const tabId = num(params, "tabId");
		if (tabId === undefined)
			throw new BridgeError(ERR.BAD_PARAMS, "tabId is required (tabs_context lists your tabs)");
		if (!ctx.session.tabIds.includes(tabId))
			throw new BridgeError(ERR.NOT_FOUND, `Tab ${tabId} is not one of your tabs. tabs_context lists them.`);
		const summary = await tabSummary(tabId);
		const wasCurrent = ctx.session.currentTabId === tabId;
		await ctx.session.release(tabId, { clearCurrent: true });
		captures.tabClosed(tabId, "the tab was given to the user");
		return {
			released: tabId,
			url: summary.url,
			title: summary.title,
			note: `The tab is the user's now, outside your group; you can't use it any more.${wasCurrent ? " It was your current tab: tabs_select another or navigate." : ""}`,
		};
	},

	/** Who this session is, its group and tabs; with `label`, names the group from the agent's side. */
	"session.info": async (ctx, params) => {
		const label = str(params, "label");
		if (label !== undefined) await ctx.session.setAgentLabel(label);
		const tabs = await ctx.session.tabs();
		const notices = await takeNotices(ctx.session.id);
		return {
			...(await sessionSummary(ctx.session)),
			tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, current: t.current })),
			...(notices.length ? { notices } : {}),
		};
	},

	/** End the session: hand its tabs to the user (or close them) and forget it. */
	"session.end": async (ctx, params) => {
		const result = await ctx.session.end({ close: params.close === true });
		await captures.sessionGone(ctx.session.id);
		dropTransfersForSession(ctx.session.id);
		return { ended: true, ...result };
	},

	"tabs.show": async (ctx, params) => {
		const tabId = num(params, "tabId") ?? ctx.session.currentTabId;
		if (tabId === undefined) throw new BridgeError(ERR.NO_TAB, "You have no tab to show yet: navigate opens one.");
		// The tab is shown so the user can sign in: what they type and see stays out of any capture.
		captures.tabClosed(tabId, "the tab was shown to the user");
		await ctx.session.show(tabId);
		return tabSummary(tabId);
	},

	navigate: async (ctx, params) => {
		const url = requireStr(params, "url");
		const history = url === "back" || url === "forward";
		if (!history) await ctx.checkUrl(url);
		// The first navigate of a session opens its tab (blank, with capture on) and loads the URL into it.
		if (!history && num(params, "tabId") === undefined && !(await ctx.session.currentTab())) {
			const since = await settleStart();
			const { tab, ready, note } = await openCapturedTab(ctx, url, num(params, "timeoutMs") ?? 20000, false);
			const tabId = tab.id as number;
			// The approval page is blanked before anything is run in it.
			const landed = await refuseGuardedLanding(ctx, tabId, await tabSummary(tabId, !ready));
			if (!ready) return { ...landed, ...(note ? { note } : {}), changes: { page: STILL_LOADING } };
			// The tab is new: settleStart had none to turn Network on in, so the wait does.
			const settled = await settleAfter(ctx, tabId, since, landed, { watched: false, changes: { page: NEW_PAGE } });
			return refuseGuardedLanding(ctx, tabId, {
				...(await tabSummary(tabId)),
				...settled,
				...(note ? { note } : {}),
			});
		}
		const tabId = await resolveTab(ctx, params, false);
		let timedOut = false;
		// A full load is a new document: the report says so without two looks. Only back, forward
		// and a jump within the page (a new hash) can keep the document, so only they are compared.
		const from = (await chrome.tabs.get(tabId).catch(() => undefined))?.url ?? "";
		const samePage = history || (url.includes("#") && url.split("#")[0] === from.split("#")[0]);
		const before = samePage ? await changesBefore(ctx, tabId) : undefined;
		// A URL that loads no document (a 204, a download) leaves the page as it was: the main frame's
		// loader says which. The tabs a load opened or closed are reported either way.
		const loader = samePage ? undefined : await mainLoader(tabId);
		const tabs = [...ctx.session.tabIds];
		const since = await actionStart(ctx, tabId);
		watchGuardedCommits(ctx, tabId);
		if (url === "back") timedOut = !(await goBack(tabId));
		else if (url === "forward") timedOut = !(await goForward(tabId));
		else {
			const waitUntil = str(params, "waitUntil") === "load" ? "load" : "domcontentloaded";
			timedOut = (await navigateTabDetailed(tabId, url, { waitUntil, timeoutMs: num(params, "timeoutMs") ?? 20000 }))
				.timedOut;
		}
		// Content a script draws after the load (a fetch, a skeleton) is there before the agent reads.
		// The approval page is blanked before anything is run in it.
		const landed = await refuseGuardedLanding(ctx, tabId, await tabSummary(tabId, timedOut));
		if (timedOut) return { ...landed, changes: { page: STILL_LOADING } };
		const kept = loader !== undefined && (await mainLoader(tabId)) === loader;
		const urlOf = async (id: number) => (await chrome.tabs.get(id).catch(() => undefined))?.url ?? "";
		const settled = await settleAfter(
			ctx,
			tabId,
			since,
			landed,
			samePage
				? { before }
				: {
						changes: {
							...(await tabChanges(tabs, ctx.session.tabIds, urlOf)),
							page: kept ? NOT_LOADED : NEW_PAGE,
						},
					},
		);
		return refuseGuardedLanding(ctx, tabId, { ...(await tabSummary(tabId)), ...settled });
	},

	screenshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;
		const shot = await captureScreenshot(tabId, {
			maxWidth: num(params, "maxWidth"),
			fullPage: params.fullPage === true,
			clip,
			format: str(params, "format") === "png" ? "png" : "jpeg",
			quality: num(params, "quality"),
		});
		return shot;
	},

	"screencast.start": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		await startScreencast(
			tabId,
			ctx.clientId,
			{
				format: str(params, "format") === "png" ? "png" : "jpeg",
				quality: num(params, "quality"),
				maxWidth: num(params, "maxWidth"),
				maxHeight: num(params, "maxHeight"),
				maxFps: num(params, "maxFps"),
				initScript: str(params, "initScript"),
			},
			(frame) => ctx.emit("screencast_frame", { tabId, data: frame.data, metadata: frame.metadata }),
			(reason) => ctx.emit("screencast_stopped", { tabId, reason }),
		);
		return { tabId, streaming: true };
	},

	"screencast.stop": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		return { tabId, stopped: await stopScreencast(tabId) };
	},

	snapshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const filter = str(params, "filter") === "interactive" ? "interactive" : "all";
		return snapshot(tabId, {
			filter,
			maxNodes: num(params, "maxNodes"),
			maxTextChars: num(params, "maxTextChars"),
		});
	},

	text: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const query = str(params, "query");
		if (query)
			return {
				...(await tabSummary(tabId)),
				text: await searchTab(tabId, str(params, "selector"), query, readChars(params.maxChars) ?? READ_MAX_CHARS, {
					first: num(params, "firstPage"),
					last: num(params, "lastPage"),
				}),
			};
		// The PDF viewer has no page text to read: its text comes from the file, page by page.
		if (!str(params, "selector") && (await isPdfTab(tabId))) {
			const tab = await chrome.tabs.get(tabId);
			const offset = Math.max(0, Math.floor(num(params, "offset") ?? 0));
			const max = readChars(params.maxChars, PDF_DEFAULT_CHARS) ?? PDF_DEFAULT_CHARS;
			// The page stream is the same on every read, so offset + max characters of it, from offset, is the exact
			// continuation of the read before.
			const pdf = await pdfText(tab.url ?? "", offset + max, num(params, "firstPage"), num(params, "lastPage"));
			const part = pdfWindow(pdf, offset, max);
			const first = num(params, "firstPage") ?? 1;
			const note = !pdf.read
				? `There is no such page: this PDF has ${pdf.pages}.`
				: pdf.empty.length === pdf.read
					? "This PDF has no text layer (a scan or images of pages). Read it with screenshot, and say the text could not be checked."
					: pdf.empty.length
						? `Pages ${pdf.empty.join(", ")} have no text layer (images); read those with screenshot.`
						: undefined;
			const cut = part.next !== undefined ? pdfCutNote(pdf.text, first, part.next) : undefined;
			return {
				...(await tabSummary(tabId)),
				pdf: {
					pages: pdf.pages,
					truncated: part.truncated,
					...(offset ? { offset } : {}),
					...(note ? { note } : {}),
					...(cut ? { cut } : {}),
				},
				text: part.text,
			};
		}
		const max = readChars(params.maxChars) ?? READ_MAX_CHARS;
		// Measured as JSON carries it, so the note's offset holds after a page of quotes or newlines is escaped.
		const slice = fitSlice(await pageText(tabId, str(params, "selector"), max, num(params, "offset")), max);
		return { ...(await tabSummary(tabId)), text: slice.text, ...sliceInfo(slice) };
	},

	html: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const max = readChars(params.maxChars) ?? READ_MAX_CHARS;
		const slice = fitSlice(await pageHtml(tabId, str(params, "selector"), max, num(params, "offset")), max);
		return { ...(await tabSummary(tabId)), html: slice.text, ...sliceInfo(slice) };
	},

	inspect: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const page = await inspectPage(tabId);
		// React marks DOM nodes with "__react…" properties only the page's own world can see: a
		// fixed, read-only check there, not code from the agent.
		try {
			const react = await evaluateMain(
				tabId,
				"Array.from(document.querySelectorAll('body *')).slice(0, 400).some((el) => Object.keys(el).some((k) => k.startsWith('__react')))",
			);
			const frameworks = page.frameworks as string[];
			if (react === true && !frameworks.includes("React")) frameworks.push("React");
		} catch {
			/* the page's world isn't reachable; markup checks stand */
		}
		// The site's own data calls, if this tab has been capturing network (read_network turns it on).
		const seen = new Map<string, number>();
		// Only this page's calls: the buffer outlives navigations.
		const here = String(page.url ?? "").split("#")[0];
		for (const e of readNetwork(tabId)) {
			if (e.type !== "XHR" && e.type !== "Fetch") continue;
			if (e.documentURL && e.documentURL.split("#")[0] !== here) continue;
			let path = e.url;
			try {
				const u = new URL(e.url);
				path = `${u.origin}${u.pathname}`;
			} catch {
				/* keep the URL */
			}
			const key = `${e.method} ${path}${e.status ? ` ${e.status}` : ""}`;
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}
		const api = [...seen].slice(-30).map(([k, n]) => (n > 1 ? `${k} x${n}` : k));
		return { ...page, api, capturing: networkCapturing(tabId) };
	},

	find: async (ctx, params) => {
		const query = requireStr(params, "query").toLowerCase();
		const tabId = await resolveTab(ctx, params, false);
		const snap = await snapshot(tabId, { filter: "all", maxNodes: 600, maxTextChars: 0 });
		return { matches: rankMatches(snap.nodes, query, num(params, "limit") ?? 20) };
	},

	click: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		// The look first: the point is found right before the input goes out, so a layout that
		// moved during the look can't misplace the click.
		const before = await changesBefore(ctx, tabId, params);
		const p = await pointFor(ctx, params, tabId);
		const button = str(params, "button");
		const since = await actionStart(ctx, tabId);
		await click(tabId, p.x, p.y, {
			button: button === "right" || button === "middle" ? button : "left",
			clickCount: num(params, "clickCount") ?? 1,
			beforeLastEvent: () => ctx.delivered({ clicked: p }, tabId),
		});
		// A dialog the click's page opens while it settles is still the click's doing.
		const settled = await settleAfter(ctx, tabId, since, { clicked: p }, { before });
		return { clicked: p, ...settled };
	},

	hover: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const p = await pointFor(ctx, params, tabId);
		await hover(tabId, p.x, p.y);
		return { hovered: p };
	},

	drag: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const from = params.from as { x: number; y: number } | undefined;
		const to = params.to as { x: number; y: number } | undefined;
		if (!from || !to)
			throw new BridgeError(
				ERR.BAD_PARAMS,
				'from and to are required, e.g. {"from":{"x":200,"y":200},"to":{"x":360,"y":300}}',
			);
		const before = await changesBefore(ctx, tabId);
		// A short wait, Network left as it is: a drop that animates or reorders a frame later (dnd-kit,
		// an optimistic update) is in the report, at most DRAG_SETTLE.capMs added (D41).
		const since = Date.now();
		await drag(tabId, screenshotToCss(tabId, from), screenshotToCss(tabId, to));
		return {
			dragged: { from, to },
			...(await settleAfter(ctx, tabId, since, { dragged: { from, to } }, { before, wait: DRAG_SETTLE })),
		};
	},

	type: async (ctx, params) => {
		const text = requireStr(params, "text");
		const tabId = await resolveTab(ctx, params, true);
		const t = target(params);
		/** Set just before the first key event goes out: after that the page may hold some of the text. */
		let keysStarted = false;
		const before = await changesBefore(ctx, tabId, params);
		const since = await actionStart(ctx, tabId);
		const attempt = async () => {
			if (t.ref || t.selector) {
				const rect = await locate(tabId, t);
				await click(tabId, rect.x, rect.y);
			}
			stopIfAborted(ctx);
			await typeText(tabId, text, ctx.aborted, () => {
				keysStarted = true;
			});
			stopIfAborted(ctx);
			if (params.submit === true) await pressKey(tabId, "Enter");
		};
		try {
			await attempt();
		} catch (err) {
			if (!isDetachError(err)) throw err;
			// A navigation under the focusing click is often the click's own doing (a field in a link):
			// typing again would act on the new page. Only a debugger that really detached is retried.
			if (isNavigatedError(err))
				throw navigatedError("type", keysStarted ? "some of the text may be in the field" : "no key was typed");
			// Detached before any key went out: nothing was typed, so attach again and go once more.
			// Once a key was sent the text may be partly there, and typing again would double it.
			if (keysStarted) throw interruptedError(err, "type", "some of the text may be in the field");
			try {
				await reattach(tabId);
				// The new debugging session has Network off: on again before the keys go out.
				await settleStart(tabId);
				await attempt();
			} catch (again) {
				if (isDetachError(again))
					throw interruptedError(
						again,
						"type",
						keysStarted ? "some of the text may be in the field" : "no key was typed",
					);
				throw again;
			}
		}
		return { typed: text.length, ...(await settleAfter(ctx, tabId, since, { typed: text.length }, { before })) };
	},

	press: async (ctx, params) => {
		const key = requireStr(params, "key");
		const tabId = await resolveTab(ctx, params, true);
		const repeat = num(params, "repeat") ?? 1;
		const before = await changesBefore(ctx, tabId);
		const since = await actionStart(ctx, tabId);
		for (let i = 0; i < repeat; i++) {
			stopIfAborted(ctx);
			await pressKey(tabId, key);
		}
		return { pressed: key, repeat, ...(await settleAfter(ctx, tabId, since, { pressed: key, repeat }, { before })) };
	},

	scroll: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const x = num(params, "x");
		const y = num(params, "y");
		const dx = num(params, "dx") ?? 0;
		const dy = num(params, "dy") ?? 0;
		const before = await changesBefore(ctx, tabId);
		// New rows in recycled elements are not renames: what went and what appeared is listed instead.
		if (before) before.pairRenames = false;
		const since = await actionStart(ctx, tabId);
		let scrolled: unknown;
		if (x !== undefined && y !== undefined && !params.ref && !params.selector && !params.to) {
			// Wheel at a point: scrolls the innermost scrollable under the cursor.
			const at = screenshotToCss(tabId, { x, y });
			await cdpScroll(tabId, at.x, at.y, dx, dy);
			scrolled = await runInPage(
				tabId,
				"({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) })",
			);
		} else {
			const to = str(params, "to");
			cuePointer(tabId, "scroll-page");
			scrolled = await scrollPage(tabId, {
				dx,
				dy,
				ref: str(params, "ref"),
				selector: str(params, "selector"),
				to: to === "top" || to === "bottom" ? to : undefined,
			});
		}
		// An infinite list loads its next rows after the scroll: they are in the report.
		const result = scrolled as Record<string, unknown>;
		return { ...result, ...(await settleAfter(ctx, tabId, since, result, { before })) };
	},

	fill: async (ctx, params) => {
		const value = str(params, "value") ?? "";
		const tabId = await resolveTab(ctx, params, false);
		const t = target(params);
		if (!t.ref && !t.selector)
			throw new BridgeError(ERR.BAD_PARAMS, "fill needs a ref from read_page, or a selector.");
		const before = await changesBefore(ctx, tabId, params);
		const since = await actionStart(ctx, tabId);
		await fillElement(tabId, t, value);
		// fill focuses its field: the pointer goes there once it holds the value.
		cuePointer(tabId, "fill");
		return { filled: t, ...(await settleAfter(ctx, tabId, since, { filled: t }, { before })) };
	},

	evaluate: async (ctx, params) => {
		const code = requireStr(params, "code");
		const world = str(params, "world") === "main" ? "main" : "user";
		if (world === "main") {
			const tabId = await resolveTab(ctx, params, true);
			return { value: await evaluateMain(tabId, code) };
		}
		const tabId = await resolveTab(ctx, params, true);
		return { value: await injectScript(tabId, code) };
	},

	wait: async (ctx, params) => {
		if (str(params, "until") === "settled") {
			const tabId = await resolveTab(ctx, params, false);
			const r = await settle(tabId, {
				...WAIT_SETTLE,
				capMs: num(params, "timeoutMs") ?? WAIT_SETTLE.capMs,
				since: 0,
				stop: ctx.aborted,
				skip: (u) => ctx.isGuarded(u),
				guardedHosts: ctx.guardedHosts,
			});
			if (r.stopped) {
				// Not the page still changing: the call was stopped, a box opened or the tab left for the approval page.
				stopIfAborted(ctx);
				// The tab may still show the old URL while it goes to the approval page: where it is
				// going decides, and so does the page's own check.
				const tab = await chrome.tabs.get(tabId).catch(() => undefined);
				if (r.guarded || ctx.isGuarded(tab?.pendingUrl || tab?.url || "")) {
					await chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => undefined);
					throw new BridgeError(ERR.PERMISSION_DENIED, GUARDED_LANDING);
				}
				const summary = await refuseGuardedLanding(ctx, tabId, await tabSummary(tabId));
				return { ...summary, settled: false, stopped: true, note: "The wait stopped before the page went quiet." };
			}
			return {
				...(await tabSummary(tabId)),
				...(r.settled
					? { settled: true, ms: r.ms }
					: {
							settled: false,
							waitingOn: r.waitingOn ?? "dom",
							note: "The page was still changing when the wait ran out (it may never go quiet: live updates, polling). read_page shows it now.",
						}),
			};
		}
		const ms = num(params, "ms");
		if (ms !== undefined && !params.selector && !params.text && !params.urlIncludes) {
			await new Promise((r) => setTimeout(r, Math.min(ms, 30000)));
			return { waited: ms };
		}
		const tabId = await resolveTab(ctx, params, false);
		const ok = await waitFor(
			tabId,
			{ selector: str(params, "selector"), text: str(params, "text"), urlIncludes: str(params, "urlIncludes") },
			num(params, "timeoutMs") ?? 10000,
		);
		if (!ok)
			throw new BridgeError(
				ERR.TIMEOUT,
				`Waited ${num(params, "timeoutMs") ?? 10000} ms and the condition wasn't met. read_page shows the page now; wait again with a longer timeoutMs or for something else.`,
			);
		return { ...(await tabSummary(tabId)), matched: true };
	},

	/** Answer an alert, confirm or prompt box: accept presses OK, otherwise Cancel. */
	dialog: async (ctx, params) => {
		if (typeof params.accept !== "boolean")
			throw new BridgeError(ERR.BAD_PARAMS, "accept must be true (OK) or false (Cancel)");
		const own = ctx.dialogAnswer === undefined;
		const answer = ctx.dialogAnswer ?? dialogAnswerArrive(ctx.session.id, ctx.session.tabIds, num(params, "tabId"));
		try {
			const open = ctx.session.tabIds.filter((id) => openDialog(id) !== undefined);
			const list = open.map((id) => `tab ${id}: ${JSON.stringify(openDialog(id)?.message)}`).join("; ");
			const next = list
				? ` Open now: ${list}. To answer one, call handle_dialog with its tabId.`
				: " Carry on with read_page.";
			// A box the guard cancelled that the agent hasn't heard of: told here, once, in the notice's own words.
			const unheard = await dialogUnheard(answer.requested !== undefined ? [answer.requested] : ctx.session.tabIds);
			if (unheard) throw new BridgeError(ERR.NOT_FOUND, `${unheard}${next}`);
			const target = answer.target;
			if (!target) {
				if (answer.requested === undefined && open.length > 1)
					throw new BridgeError(ERR.BAD_PARAMS, `Dialogs are open on more than one tab (${list}). Pass tabId.`);
				const where = answer.requested === undefined ? "on your tabs" : `on tab ${answer.requested}`;
				throw new BridgeError(ERR.NOT_FOUND, `No dialog is open ${where}; nothing to answer.${next}`);
			}
			// The box this call was for, by identity: never one that opened after it on the same tab.
			if (openDialog(target.tabId)?.seq !== target.seq)
				throw new BridgeError(ERR.NOT_FOUND, `The dialog this call was for on tab ${target.tabId} is gone.${next}`);
			const dialog = await answerDialog(target.tabId, params.accept, str(params, "promptText"), target.seq);
			return { tabId: target.tabId, type: dialog.type, message: dialog.message, accepted: params.accept };
		} finally {
			if (own) dialogAnswerEnd(answer);
		}
	},

	/**
	 * Several input steps in one call (press / click / drag / type / hover / scroll / wait),
	 * optionally ending with a screenshot. Canvas work (draw, label, connect) is otherwise one
	 * model turn per keystroke. Stops at the first failing step and says which.
	 */
	actions: async (ctx, params) => {
		const steps = params.steps;
		if (!Array.isArray(steps) || steps.length === 0)
			throw new BridgeError(ERR.BAD_PARAMS, "steps must be a non-empty array");
		if (steps.length > 40) throw new BridgeError(ERR.BAD_PARAMS, "at most 40 steps per call");
		// Apps react to input a frame later (a text editor opens after Enter, a tool arms after
		// its shortcut); without a short settle the next keystroke lands before it and is lost.
		const settleMs = Math.max(0, Math.min(1000, num(params, "settleMs") ?? 80));
		let wantShot = params.screenshot === true;
		const done: unknown[] = [];
		// Network on for the batch's tab before its first step: a drag or a scroll step turns it on itself.
		// The batch's tab is the one it names, else the current one.
		const named = num(params, "tabId");
		const first = named !== undefined ? { id: named } : await ctx.session.currentTab().catch(() => undefined);
		const firstId = first?.id !== undefined && ctx.session.tabIds.includes(first.id) ? first.id : undefined;
		const before = firstId !== undefined ? await changesBefore(ctx, firstId) : undefined;
		// A batch moved only if a step changed the current tab: a wait step on a named tab moves nowhere.
		const wasCurrent = named === undefined ? first?.id : (await ctx.session.currentTab().catch(() => undefined))?.id;
		const batchStart = await settleStart(firstId);
		for (let i = 0; i < steps.length; i++) {
			const [kind, sub] = normalizeStep(steps[i] as Params, i);
			if (kind === "screenshot") {
				wantShot = true;
				continue;
			}
			const withTab = params.tabId !== undefined && sub.tabId === undefined ? { ...sub, tabId: params.tabId } : sub;
			stopIfAborted(ctx);
			// A step that opens a dialog worked, but the steps after it did not run: say so.
			const stepCtx: HandlerContext = {
				...ctx,
				batch: true,
				delivered: (result, tabId) =>
					ctx.delivered(
						result ? { ...result, steps: done.length + 1, notRun: steps.length - i - 1 } : undefined,
						tabId,
					),
			};
			try {
				done.push(await handlers[kind](stepCtx, withTab));
			} catch (err) {
				// Keep the step's own code (stale_ref, interrupted, ...): the agent acts on it.
				const { error } = classify(err, kind);
				const code = error.code === ERR.INTERNAL ? ERR.BAD_PARAMS : error.code;
				// `source` stays: the client passes the extension's own interrupted on, not as a dropped bridge.
				throw new BridgeError(
					code,
					`step ${i} (${kind}) failed after ${i} steps succeeded: ${error.message}`,
					error.source,
				);
			}
			if (settleMs > 0 && i < steps.length - 1) await new Promise((r) => setTimeout(r, settleMs));
		}
		stopIfAborted(ctx);
		// Steps keep their short settleMs pause; the page settles once, after the last one.
		const out: Record<string, unknown> = { steps: done.length };
		const now = await ctx.session.currentTab().catch(() => undefined);
		const stayed = firstId !== undefined && (now?.id === firstId || now?.id === wasCurrent);
		const last = stayed ? { id: firstId } : now;
		if (last?.id !== undefined && ctx.session.tabIds.includes(last.id))
			// One report for the whole batch: per step it would cost a page look per keystroke.
			Object.assign(
				out,
				await settleAfter(
					ctx,
					last.id,
					batchStart,
					{ steps: done.length, notRun: 0 },
					// A step moved to another tab: Network was never turned on there.
					// The report compares the tab it looked at first; on another tab it says where the batch went.
					last.id === firstId ? { before } : { watched: false, changes: { page: movedTo(last.id) } },
				),
			);
		if (wantShot) out.screenshot = await handlers.screenshot(ctx, { tabId: params.tabId });
		return out;
	},

	"console.read": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const capture = await enableConsoleCapture(tabId);
		let entries = readConsole(tabId, params.clear === true);
		if (params.onlyErrors === true) entries = entries.filter((e) => e.level === "error");
		const pattern = str(params, "pattern");
		if (pattern) {
			const re = new RegExp(pattern, "i");
			entries = entries.filter((e) => re.test(e.text));
		}
		return { ...(capture ? { capture } : {}), ...newestPage(entries, params, "text") };
	},

	/**
	 * Evidence from the session's own tabs: a HAR, a recording, a flight recorder (src/browser/capture.ts has the rules).
	 * The result carries the file for the helper to write; the agent is told its path and size, never the content.
	 */
	capture: async (ctx, params) => {
		const action = str(params, "action");
		// A start resolves the tab like every other tool (own tabs only, never the approval page); the rest need none.
		const tabId = action?.endsWith("_start") ? await resolveTab(ctx, params, true) : undefined;
		try {
			return await captures.run(
				{ id: ctx.session.id, tabIds: ctx.session.tabIds },
				{ action, id: str(params, "id"), tabId },
			);
		} catch (err) {
			if (err instanceof CaptureError) throw new BridgeError(err.code, err.message);
			throw err;
		}
	},

	"network.read": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const capture = await enableNetworkCapture(tabId);
		const requestId = str(params, "requestId");
		if (requestId) return { ...(capture ? { capture } : {}), request: await readNetworkDetail(tabId, requestId) };
		let entries = readNetwork(tabId, params.clear === true);
		const pattern = str(params, "urlPattern");
		if (pattern) {
			const re = new RegExp(pattern, "i");
			entries = entries.filter((e) => re.test(e.url));
		}
		const type = str(params, "type");
		if (type) entries = entries.filter((e) => e.type?.toLowerCase() === type.toLowerCase());
		return { ...(capture ? { capture } : {}), ...newestPage(entries, params, "url") };
	},
};
