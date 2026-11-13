/**
 * The "in use by an agent" veil (service worker): a soft glow in the session's group color around
 * the page of a tab an agent is working in, and a pill at the top that says who. The rules for
 * when it shows are in veil-state.ts; what the page sees of it is in veil-page.ts.
 *
 * The bridge calls `veilBegin` and `veilEnd` around every tool call that acts on a tab. Captures
 * call the cover set on cdp.ts. Pages the extension can't script (chrome://, the Web Store, the
 * PDF viewer) get no veil and no error.
 */

import { checkPolycarpTheme } from "../appearance/polycarp.js";
import { APPEARANCE_KEY, appearanceVariables, parseChoice } from "../appearance/tokens.js";
import { isRestrictedUrl, setCaptureCover, setPointerCue } from "./cdp.js";
import { BrowserSession, isAgentSession, sessionOwningTab } from "./session.js";
import { MOTE, VEIL_CSS, type VeilCommand, type VeilPageResult, type VeilTheme, veilPage } from "./veil-page.js";
import {
	isPointerEnabled,
	isVeilEnabled,
	MODE_MIRROR_KEY,
	newVeilTag,
	POINTER_ENABLED_KEY,
	rememberVeilTag,
	storedVeilTags,
	VEIL_ENABLED_KEY,
	veilTag,
} from "./veil-shared.js";
import {
	EMPTY_VEIL,
	isConcealed,
	type PointerAction,
	pointerCue,
	VEIL_IDLE_MS,
	type VeilEffect,
	type VeilEvent,
	type VeilState,
	veilStep,
	veilViewFor,
} from "./veil-state.js";

/** Bridge methods that act on a tab: the ones that show the veil. */
const TAB_METHODS = new Set([
	"navigate",
	"tabs.create",
	"screenshot",
	"snapshot",
	"text",
	"html",
	"inspect",
	"find",
	"click",
	"hover",
	"drag",
	"type",
	"press",
	"scroll",
	"fill",
	"evaluate",
	"wait",
	"dialog",
	"actions",
	"console.read",
	"network.read",
]);
/** Methods that hit-test or send pointer input: the pill's button is off while they run. */
const INPUT_METHODS = new Set(["click", "hover", "drag", "type", "scroll", "fill", "actions"]);
/** Never let a slow page hold a tool call up for the veil. */
const EFFECT_TIMEOUT_MS = 1500;
const SESSIONS_KEY = "browser_sessions";
const POLYCARP_CACHE_KEY = "tabkyra.polycarp";

let state: VeilState = EMPTY_VEIL;
let timer: ReturnType<typeof setTimeout> | undefined;
let enabled: boolean | undefined;
/** Settings > Agents, "Show the agent's pointer": unknown until read once; storage changes keep it current. */
let pointer: boolean | undefined;
/** The read under way, if any: never a second beside it, and dropped at its deadline so the next show reads afresh (PR 234's review, first-F1). */
let pointerRead: Promise<boolean> | undefined;
/** A show gave up on the read: later shows draw at once without it, cues are dropped, and the read sets the open veils. */
let pointerTimedOut = false;
/** Settles EFFECT_TIMEOUT_MS after the read under way started: one deadline every show waiting on that read shares. */
let pointerGiveUp: Promise<undefined> = Promise.resolve(undefined);
let log: (line: string) => void = () => undefined;
const chains = new Map<number, Promise<unknown>>();

/** Tests shorten the idle time through the worker's global. */
function idleMs(): number {
	const override = (globalThis as { __POLYCARP_VEIL_IDLE_MS?: number }).__POLYCARP_VEIL_IDLE_MS;
	return typeof override === "number" && override > 0 ? override : VEIL_IDLE_MS;
}

function schedule(wakeAt: number | undefined): void {
	if (timer !== undefined) clearTimeout(timer);
	timer = undefined;
	if (wakeAt === undefined) return;
	timer = setTimeout(
		() => void dispatch({ type: "tick", at: Date.now(), idleMs: idleMs() }),
		Math.max(0, wakeAt - Date.now()) + 20,
	);
}

/** Apply an event and carry out its effects, in order per tab. Resolves once they are done (or timed out). */
function dispatch(event: VeilEvent): Promise<void> {
	const step = veilStep(state, event, idleMs());
	state = step.state;
	schedule(step.wakeAt);
	return Promise.all(step.effects.map((e) => queue(e))).then(() => undefined);
}

function queue(effect: VeilEffect): Promise<void> {
	const prev = chains.get(effect.tabId) ?? Promise.resolve();
	const run = prev
		.then(() => {
			const late = { fired: false };
			return withTimeout(apply(effect, late), late);
		})
		.catch(() => undefined);
	chains.set(effect.tabId, run);
	void run.then(() => {
		if (chains.get(effect.tabId) === run) chains.delete(effect.tabId);
	});
	return run;
}

/** `late.fired` turns true when the time is up, so work still running behind it can tell the chain moved on. */
function withTimeout<T>(p: Promise<T>, late?: { fired: boolean }): Promise<T | undefined> {
	return Promise.race([
		p,
		new Promise<undefined>((r) =>
			setTimeout(() => {
				if (late) late.fired = true;
				r(undefined);
			}, EFFECT_TIMEOUT_MS),
		),
	]);
}

async function inject(tabId: number, cmd: VeilCommand): Promise<VeilPageResult | undefined> {
	const [first] = await chrome.scripting.executeScript({
		target: { tabId, frameIds: [0] },
		world: "ISOLATED",
		injectImmediately: true,
		func: veilPage,
		args: [cmd],
	});
	return first?.result as VeilPageResult | undefined;
}

/**
 * Carry out one effect. A show still waiting on the browser when its time ran out (second-S1 of the review of PR 189) no
 * longer draws what was true when it was queued: the chain has moved on, so it draws the tab's facts as they are now
 * (its view, and concealed for a capture that came after it, say), or nothing if the tab has no veil any more or its
 * document changed (the tag guard, PR 234's review, second-S1). Every wait comes first, then that decision and the inject with nothing awaited between them
 * (PR 204's review, first-F1).
 */
async function apply(effect: VeilEffect, late: { fired: boolean } = { fired: false }): Promise<void> {
	const { tabId } = effect;
	try {
		if (effect.kind === "show") {
			const tab = await chrome.tabs.get(tabId).catch(() => undefined);
			const url = tab?.url || tab?.pendingUrl || "";
			if (!tab || isRestrictedUrl(url)) return;
			// A tag of its own for each document; stored before it is drawn, so a reader never misses it.
			const tag = (await veilTag(tabId)) ?? newVeilTag();
			await rememberVeilTag(tabId, tag);
			const pointerShown = await pointerForShow();
			const pageTheme = await theme();
			// A navigation since this show read its tag gave the tab a new document and a show of its own.
			const tagNow = late.fired ? await veilTag(tabId) : tag;
			// Nothing is awaited from here to the inject.
			let { interactive, concealed, view } = effect;
			if (late.fired) {
				const now = state.tabs[tabId];
				// No veil any more (a hide or a close came while it waited): the tag it stored goes, whatever else
				// happened since. A newer show only owns the tag while the tab still has a veil (PR 219's review,
				// second-S1).
				if (!now) {
					await rememberVeilTag(tabId, undefined);
					return;
				}
				if (tagNow !== tag) return;
				interactive = now.input === 0;
				concealed = isConcealed(state, tabId);
				view = now.view;
			}
			const result = await inject(tabId, {
				op: "show",
				tag,
				css: VEIL_CSS,
				agent: view.agent,
				detail: view.detail,
				color: view.color,
				theme: pageTheme,
				interactive,
				concealed,
				// The setting as it is now: a read that settled while this show waited sent it to the open veils, and
				// this inject must not undo that (PR 219's review, first-F1).
				pointer: pointer ?? pointerShown,
				mote: MOTE,
			});
			if (!result?.tag) await rememberVeilTag(tabId, undefined);
			return;
		}
		if (effect.kind === "hide") {
			await rememberVeilTag(tabId, undefined);
			await inject(tabId, { op: "hide", fade: effect.fade });
			return;
		}
		await inject(
			tabId,
			effect.kind === "interactive" ? { op: "set", interactive: effect.on } : { op: "set", concealed: effect.on },
		);
	} catch {
		// A page the extension can't script (PDF viewer, an error page, a tab mid-close): no veil there.
	}
}

/** The pointer's own order per tab, and the latest cue: never on `chains`, which the cover and veilBegin wait on. */
const points = new Map<number, { run: Promise<void>; latest: number }>();
let pointSeq = 0;

/**
 * Send the character to a point (cue), or apply the on/off setting (no cue): after the veil changes already queued
 * for the tab (a point after its show), but never in front of later ones. A cue a newer cue replaced is not sent.
 */
function queuePoint(tabId: number, cue: PointerAction | undefined): Promise<void> {
	const id = ++pointSeq;
	const cmd: VeilCommand = cue ? { op: "point", cue } : { op: "set", pointer: pointer !== false };
	const mine = points.get(tabId);
	const prev = Promise.all([chains.get(tabId), mine?.run]);
	const run = prev
		.then(() => (cue && points.get(tabId)?.latest !== id ? undefined : withTimeout(inject(tabId, cmd))))
		.then(
			() => undefined,
			() => undefined,
		);
	points.set(tabId, { run, latest: cue ? id : (mine?.latest ?? id) });
	void run.then(() => {
		if (points.get(tabId)?.run === run) points.delete(tabId);
	});
	return run;
}

let themeCache: VeilTheme | undefined;

const THEME_VARS = [
	"--background",
	"--foreground",
	"--card",
	"--muted-foreground",
	"--border",
	"--accent",
	"--ring",
	"--font-sans",
	"--tk-ease",
];

/** The side panel's tokens for light and dark, from the same saved choice and Polycarp theme it paints with. */
async function theme(): Promise<VeilTheme> {
	if (themeCache) return themeCache;
	const stored = await chrome.storage.local
		.get([APPEARANCE_KEY, POLYCARP_CACHE_KEY, MODE_MIRROR_KEY])
		.catch(() => ({}) as Record<string, unknown>);
	const choice = parseChoice(stored[APPEARANCE_KEY]);
	const checked =
		stored[POLYCARP_CACHE_KEY] === undefined ? undefined : checkPolycarpTheme(stored[POLYCARP_CACHE_KEY]);
	const polycarp = checked && "theme" in checked ? checked.theme : undefined;
	const pick = (dark: boolean) => {
		const all = appearanceVariables(choice, dark, polycarp);
		return Object.fromEntries(THEME_VARS.filter((k) => all[k] !== undefined).map((k) => [k, all[k]]));
	};
	const mirrored = stored[MODE_MIRROR_KEY];
	const scheme: VeilTheme["scheme"] =
		polycarp && polycarp.mode !== "auto"
			? polycarp.mode
			: mirrored === "light" || mirrored === "dark"
				? mirrored
				: "auto";
	themeCache = { light: pick(false), dark: pick(true), scheme, reduced: polycarp?.motion.reduced === true };
	return themeCache;
}

/**
 * The pointer setting, read once: a cue that comes before the read waits for it, never for the default. A read that
 * settles after a show gave up on it sends the setting to every open veil (PR 204's second review, first-F1).
 */
function pointerOn(): Promise<boolean> {
	if (pointer !== undefined) return Promise.resolve(pointer);
	if (pointerRead) return pointerRead;
	const read = isPointerEnabled()
		.catch(() => true)
		.then((on) => {
			if (pointerRead === read) pointerRead = undefined;
			if (pointer !== undefined) return pointer;
			pointer = on;
			if (pointerTimedOut) for (const id of Object.keys(state.tabs)) void queuePoint(Number(id), undefined);
			return pointer;
		});
	pointerRead = read;
	pointerGiveUp = new Promise((r) =>
		setTimeout(() => {
			if (pointer === undefined) pointerTimedOut = true;
			// A read that never settles is given up, so the next show or cue starts one fresh read (first-F1).
			if (pointerRead === read) pointerRead = undefined;
			r(undefined);
		}, EFFECT_TIMEOUT_MS),
	);
	return read;
}

/**
 * The setting for a show to draw with. The wait on a read is bounded by one deadline from when that read started, shared
 * by every show waiting on it; past it the show draws no character (the safe side). Each later show draws at once, so a
 * read that never settles holds up no show after the first (PR 204's second review, second-S1), and no show starts a
 * second read beside it (PR 219's review, first-F2).
 */
async function pointerForShow(): Promise<boolean> {
	if (pointer !== undefined) return pointer;
	const read = pointerOn();
	if (pointerTimedOut) return false;
	return (await Promise.race([read, pointerGiveUp])) ?? pointer ?? false;
}

async function veilOn(): Promise<boolean> {
	enabled ??= await isVeilEnabled().catch(() => true);
	return enabled;
}

/** The tab a call acts on: the one it names, if the session owns it, else the session's current tab. */
function targetTab(session: BrowserSession, params: Record<string, unknown> | undefined): number | undefined {
	const named = Number(params?.tabId);
	if (params?.tabId !== undefined && Number.isInteger(named) && session.tabIds.includes(named)) return named;
	return session.currentTabId;
}

/**
 * A tool call is about to run. Returns the tab it was counted on, to give to `veilEnd`. Waits for
 * the veil's own change (at most EFFECT_TIMEOUT_MS) so an input call never meets the pill's button.
 */
export async function veilBegin(
	session: BrowserSession,
	method: string,
	params: Record<string, unknown> | undefined,
): Promise<number | undefined> {
	if (!TAB_METHODS.has(method) || !isAgentSession(session.id) || !(await veilOn())) return undefined;
	const tabId = targetTab(session, params);
	if (tabId === undefined) return undefined;
	await dispatch({
		type: "begin",
		tabId,
		sessionId: session.id,
		view: veilViewFor(session.record),
		input: INPUT_METHODS.has(method),
		at: Date.now(),
	});
	return tabId;
}

/** The call ended. Counts it on the tab it began on, and on the session's current tab if it moved there. */
export function veilEnd(session: BrowserSession, method: string, begunOn: number | undefined): void {
	if (!TAB_METHODS.has(method) || !isAgentSession(session.id) || enabled === false) return;
	const input = INPUT_METHODS.has(method);
	const at = Date.now();
	const owned = (id: number | undefined): id is number =>
		id !== undefined && !session.ended && session.tabIds.includes(id);
	const view = veilViewFor(session.record);
	if (begunOn !== undefined) {
		// A tab the session no longer has (the user took it mid-call) gets no veil back.
		if (owned(begunOn)) void dispatch({ type: "end", tabId: begunOn, sessionId: session.id, view, input, at });
		else if (input) void dispatch({ type: "drop", tabId: begunOn });
	}
	const current = session.currentTabId;
	if (current !== begunOn && owned(current))
		void dispatch({ type: "end", tabId: current, sessionId: session.id, view, input: false, at });
}

/** The session's client left or the session ended: its veils go now. */
export function veilSessionGone(sessionId: string): void {
	void dispatch({ type: "dropSession", sessionId });
}

/** The user clicked "Take over": the same as dragging the tab out of the agent's group. */
async function takeOver(tabId: number): Promise<void> {
	await dispatch({ type: "drop", tabId });
	const owner = await sessionOwningTab(tabId);
	if (!owner || !isAgentSession(owner.id)) return;
	const session = await BrowserSession.existing(owner.id);
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	log(`veil: tab=${tabId} taken over from ${owner.id}`);
	await session?.userTook(tabId, tab);
	await chrome.tabs.ungroup(tabId).catch(() => undefined);
}

/** Drop veils on tabs their session no longer owns (released, taken, ended, pruned), from any context. */
function followTable(table: Record<string, { id: string; tabIds: number[] }> | undefined): void {
	for (const [id, t] of Object.entries(state.tabs)) {
		const tabId = Number(id);
		const owner = Object.values(table ?? {}).find((s) => s.tabIds.includes(tabId));
		if (!owner || owner.id !== t.sessionId) void dispatch({ type: "drop", tabId });
	}
}

/** Wire the listeners and the capture cover. Call once per worker start. */
export function startVeil(logger?: (line: string) => void): void {
	if (logger) log = logger;
	setCaptureCover({
		conceal: (tabId, reason, on) => dispatch({ type: "conceal", tabId, reason, on }),
	});
	void pointerOn();
	// Fire and forget, behind the tab's own veil changes: the input it marks never waits for it.
	// A cue before the setting is known waits on the one read, up to its shared deadline; past it the character is
	// off (the shows drew none), so the cue is dropped rather than left waiting on a read that may never settle (PR
	// 219's review, first-F2).
	setPointerCue((tabId, cue) => {
		const send = (on: boolean | undefined) => {
			const page = on === undefined ? undefined : pointerCue(state, tabId, cue, on);
			if (page) void queuePoint(tabId, page);
		};
		if (pointer !== undefined) return send(pointer);
		if (pointerTimedOut) return void pointerOn();
		void Promise.race([pointerOn(), pointerGiveUp]).then((on) => send(on ?? pointer));
	});
	// A worker that restarted lost its state: veils it left in pages go.
	void storedVeilTags().then(async (tags) => {
		for (const [tabId] of tags) {
			if (state.tabs[tabId]) continue;
			await rememberVeilTag(tabId, undefined);
			await withTimeout(inject(tabId, { op: "hide", fade: false })).catch(() => undefined);
		}
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		void dispatch({ type: "drop", tabId });
		void rememberVeilTag(tabId, undefined);
	});
	const navigated = (details: { tabId: number; frameId: number }) => {
		if (details.frameId !== 0 || !state.tabs[details.tabId]) return;
		// The new document gets a new tag (veil-shared.ts), recorded before it is drawn.
		void rememberVeilTag(details.tabId, newVeilTag()).then(() =>
			dispatch({ type: "navigated", tabId: details.tabId }),
		);
	};
	chrome.webNavigation.onCommitted.addListener(navigated);
	// Drawn at commit when the document allows it; this catches a commit that was too early.
	chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
		if (details.frameId === 0 && state.tabs[details.tabId])
			void dispatch({ type: "navigated", tabId: details.tabId });
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (VEIL_ENABLED_KEY in changes) {
			enabled = changes[VEIL_ENABLED_KEY].newValue !== false;
			if (!enabled) void dispatch({ type: "dropAll" });
		}
		if (POINTER_ENABLED_KEY in changes) {
			pointer = changes[POINTER_ENABLED_KEY].newValue !== false;
			for (const id of Object.keys(state.tabs)) void queuePoint(Number(id), undefined);
		}
		if (APPEARANCE_KEY in changes || POLYCARP_CACHE_KEY in changes || MODE_MIRROR_KEY in changes)
			themeCache = undefined;
		if (SESSIONS_KEY in changes)
			followTable(changes[SESSIONS_KEY].newValue as Record<string, { id: string; tabIds: number[] }> | undefined);
	});
	chrome.runtime.onMessage.addListener((message, sender) => {
		const m = message as { type?: unknown; action?: unknown } | undefined;
		if (m?.type !== "polycarp-veil" || m.action !== "take-over") return;
		// Only the veil's own content script, in a page's top frame, on a tab that has a veil.
		const tabId = sender.tab?.id;
		if (sender.id !== chrome.runtime.id || tabId === undefined || sender.frameId !== 0) return;
		if (sender.url?.startsWith("chrome-extension://") || !state.tabs[tabId]) return;
		void takeOver(tabId).catch(() => undefined);
	});
}

/** @internal For tests and `polycarp browser debug`: the tabs a veil shows on now. */
export function veilTabs(): number[] {
	return Object.keys(state.tabs).map(Number);
}
