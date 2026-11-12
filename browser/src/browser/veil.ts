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
import { callTab, movedTo, TAB_METHODS } from "./tab-use.js";
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
	type PointerAction,
	pointerCue,
	VEIL_IDLE_MS,
	type VeilEffect,
	type VeilEvent,
	type VeilState,
	veilStep,
	veilViewFor,
} from "./veil-state.js";

/** Methods that hit-test or send pointer input: the pill's button is off while they run. */
const INPUT_METHODS = new Set(["click", "hover", "drag", "type", "scroll", "fill", "actions"]);
/** Never let a slow page hold a tool call up for the veil. */
const EFFECT_TIMEOUT_MS = 1500;
const SESSIONS_KEY = "browser_sessions";
const POLYCARP_CACHE_KEY = "tabkyra.polycarp";

let state: VeilState = EMPTY_VEIL;
let timer: ReturnType<typeof setTimeout> | undefined;
let enabled: boolean | undefined;
/** Settings > Agents, "Show the agent's pointer". Read at start; storage changes keep it current. */
let pointer = true;
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
	const run = prev.then(() => withTimeout(apply(effect))).catch(() => undefined);
	chains.set(effect.tabId, run);
	void run.then(() => {
		if (chains.get(effect.tabId) === run) chains.delete(effect.tabId);
	});
	return run;
}

function withTimeout<T>(p: Promise<T>): Promise<T | undefined> {
	return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), EFFECT_TIMEOUT_MS))]);
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

async function apply(effect: VeilEffect): Promise<void> {
	const { tabId } = effect;
	try {
		if (effect.kind === "show") {
			const tab = await chrome.tabs.get(tabId).catch(() => undefined);
			const url = tab?.url || tab?.pendingUrl || "";
			if (!tab || isRestrictedUrl(url)) return;
			// A tag of its own for each document; stored before it is drawn, so a reader never misses it.
			const tag = (await veilTag(tabId)) ?? newVeilTag();
			await rememberVeilTag(tabId, tag);
			const result = await inject(tabId, {
				op: "show",
				tag,
				css: VEIL_CSS,
				agent: effect.view.agent,
				detail: effect.view.detail,
				color: effect.view.color,
				theme: await theme(),
				interactive: effect.interactive,
				concealed: effect.concealed,
				pointer,
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

/** Send the character to a point (cue), or apply the on/off setting (no cue), in the tab's order. */
function queuePoint(tabId: number, cue: PointerAction | undefined): Promise<void> {
	const prev = chains.get(tabId) ?? Promise.resolve();
	const cmd: VeilCommand = cue ? { op: "point", cue } : { op: "set", pointer };
	const run = prev
		.then(() => withTimeout(inject(tabId, cmd)))
		.then(
			() => undefined,
			() => undefined,
		);
	chains.set(tabId, run);
	void run.then(() => {
		if (chains.get(tabId) === run) chains.delete(tabId);
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

async function veilOn(): Promise<boolean> {
	enabled ??= await isVeilEnabled().catch(() => true);
	return enabled;
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
	const tabId = callTab(session, method, params);
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

/** The call ended. Counts it on the tab it began on, and on the tab it moved the session to (never one it didn't use). */
export function veilEnd(
	session: BrowserSession,
	method: string,
	begunOn: number | undefined,
	currentBefore: number | undefined,
): void {
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
	const current = movedTo(session, currentBefore, begunOn);
	if (owned(current)) void dispatch({ type: "end", tabId: current, sessionId: session.id, view, input: false, at });
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
	void isPointerEnabled()
		.then((on) => {
			pointer = on;
		})
		.catch(() => undefined);
	// Fire and forget, behind the tab's own veil changes: the input it marks never waits for it.
	setPointerCue((tabId, cue) => {
		const page = pointerCue(state, tabId, cue, pointer);
		if (page) void queuePoint(tabId, page);
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
