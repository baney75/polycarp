/**
 * Bridge method handlers. Each runs against one BrowserSession (one per connected
 * harness) and uses the same primitives as the sidepanel tools. Nothing here
 * changes the active tab except `tabs.show`.
 */

import {
	answerDialog,
	captureScreenshot,
	scroll as cdpScroll,
	click,
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
import { BridgeError, classify, detachedError, interruptedError, navigatedError } from "./errors.js";
import { rankMatches } from "./find.js";
import { getAllowedHosts, getPermissionMode } from "./permissions.js";
import { ERR } from "./protocol.js";

export { BridgeError, detachedError };

type Params = Record<string, unknown>;

export interface HandlerContext {
	session: BrowserSession;
	/** Ask before a navigation to a host that is not allowed yet; throws when denied. */
	checkUrl(url: string): Promise<void>;
	/** Stable id of the calling client. */
	clientId: string;
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

export const handlers: Record<string, Handler> = {
	/** For the MCP `status` tool: what this session may open and where its tabs are. */
	status: async (ctx) => {
		const [permissionMode, allowedHosts, tabs] = await Promise.all([
			getPermissionMode(),
			getAllowedHosts(),
			ctx.session.tabs(),
		]);
		return {
			extensionVersion: chrome.runtime.getManifest().version,
			permissionMode,
			allowedHosts,
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
		return { ...(await tabSummary(tab.id!, !ready)), ...(note ? { note } : {}) };
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
		return { ended: true, ...result };
	},

	"tabs.show": async (ctx, params) => {
		const tabId = num(params, "tabId") ?? ctx.session.currentTabId;
		if (tabId === undefined) throw new BridgeError(ERR.NO_TAB, "You have no tab to show yet: navigate opens one.");
		await ctx.session.show(tabId);
		return tabSummary(tabId);
	},

	navigate: async (ctx, params) => {
		const url = requireStr(params, "url");
		const history = url === "back" || url === "forward";
		if (!history) await ctx.checkUrl(url);
		// The first navigate of a session opens its tab (blank, with capture on) and loads the URL into it.
		if (!history && num(params, "tabId") === undefined && !(await ctx.session.currentTab())) {
			const { tab, ready, note } = await openCapturedTab(ctx, url, num(params, "timeoutMs") ?? 20000, false);
			return { ...(await tabSummary(tab.id!, !ready)), ...(note ? { note } : {}) };
		}
		const tabId = await resolveTab(ctx, params, false);
		let timedOut = false;
		if (url === "back") timedOut = !(await goBack(tabId));
		else if (url === "forward") timedOut = !(await goForward(tabId));
		else {
			const waitUntil = str(params, "waitUntil") === "load" ? "load" : "domcontentloaded";
			timedOut = (await navigateTabDetailed(tabId, url, { waitUntil, timeoutMs: num(params, "timeoutMs") ?? 20000 }))
				.timedOut;
		}
		return tabSummary(tabId, timedOut);
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
		const text = await pageText(tabId, str(params, "selector"), num(params, "maxChars"));
		return { ...(await tabSummary(tabId)), text };
	},

	html: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const html = await pageHtml(tabId, str(params, "selector"), num(params, "maxChars"));
		return { ...(await tabSummary(tabId)), html };
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
		const p = await pointFor(ctx, params, tabId);
		const button = str(params, "button");
		await click(tabId, p.x, p.y, {
			button: button === "right" || button === "middle" ? button : "left",
			clickCount: num(params, "clickCount") ?? 1,
			beforeLastEvent: () => ctx.delivered({ clicked: p }, tabId),
		});
		ctx.delivered();
		return { clicked: p };
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
		await drag(tabId, screenshotToCss(tabId, from), screenshotToCss(tabId, to));
		return { dragged: { from, to } };
	},

	type: async (ctx, params) => {
		const text = requireStr(params, "text");
		const tabId = await resolveTab(ctx, params, true);
		const t = target(params);
		/** Set just before the first key event goes out: after that the page may hold some of the text. */
		let keysStarted = false;
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
		return { typed: text.length };
	},

	press: async (ctx, params) => {
		const key = requireStr(params, "key");
		const tabId = await resolveTab(ctx, params, true);
		const repeat = num(params, "repeat") ?? 1;
		for (let i = 0; i < repeat; i++) {
			stopIfAborted(ctx);
			await pressKey(tabId, key);
		}
		return { pressed: key, repeat };
	},

	scroll: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const x = num(params, "x");
		const y = num(params, "y");
		const dx = num(params, "dx") ?? 0;
		const dy = num(params, "dy") ?? 0;
		if (x !== undefined && y !== undefined && !params.ref && !params.selector && !params.to) {
			// Wheel at a point: scrolls the innermost scrollable under the cursor.
			const at = screenshotToCss(tabId, { x, y });
			await cdpScroll(tabId, at.x, at.y, dx, dy);
			return runInPage(tabId, "({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) })");
		}
		const to = str(params, "to");
		return scrollPage(tabId, {
			dx,
			dy,
			ref: str(params, "ref"),
			selector: str(params, "selector"),
			to: to === "top" || to === "bottom" ? to : undefined,
		});
	},

	fill: async (ctx, params) => {
		const value = str(params, "value") ?? "";
		const tabId = await resolveTab(ctx, params, false);
		const t = target(params);
		if (!t.ref && !t.selector)
			throw new BridgeError(ERR.BAD_PARAMS, "fill needs a ref from read_page, or a selector.");
		await fillElement(tabId, t, value);
		return { filled: t };
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
		const requested = num(params, "tabId");
		const open = ctx.session.tabIds.filter((id) => !!openDialog(id));
		if (requested !== undefined && !open.includes(requested))
			throw new BridgeError(ERR.NOT_FOUND, `No dialog is open on tab ${requested}; nothing to answer there.`);
		// Never guess between two boxes: OK on the wrong one could delete or send something.
		if (requested === undefined && open.length > 1) {
			const list = open.map((id) => `tab ${id}: ${JSON.stringify(openDialog(id)?.message)}`).join("; ");
			throw new BridgeError(ERR.BAD_PARAMS, `Dialogs are open on more than one tab (${list}). Pass tabId.`);
		}
		const tabId = requested ?? open[0];
		if (tabId === undefined)
			throw new BridgeError(
				ERR.NOT_FOUND,
				"No dialog is open on your tabs; nothing to answer. Carry on with read_page.",
			);
		if (typeof params.accept !== "boolean")
			throw new BridgeError(ERR.BAD_PARAMS, "accept must be true (OK) or false (Cancel)");
		const dialog = await answerDialog(tabId, params.accept, str(params, "promptText"));
		return { tabId, type: dialog.type, message: dialog.message, accepted: params.accept };
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
		const out: Record<string, unknown> = { steps: done.length };
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
		return { ...(capture ? { capture } : {}), entries: entries.slice(-(num(params, "limit") ?? 100)) };
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
		return { ...(capture ? { capture } : {}), entries: entries.slice(-(num(params, "limit") ?? 100)) };
	},
};
