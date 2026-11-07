/**
 * Makes the browser follow the site edits (site-edits/store.ts). Runs in the service worker:
 * - hide: a stylesheet put into each matching page as it commits, and into open tabs when an edit changes;
 * - block: dynamic network rules, ids SITE_RULE_BASE and up (the custom-provider CORS rules use 2000-2999);
 * - script: user scripts registered for the site, only when the person turned them on and user scripts are allowed;
 * - ad blocking: the "ads" ruleset on or off.
 */

import { userScriptsApi } from "../browser/userscripts-status.js";
import { blockRules, hideCss, load, onHost, type SiteEditsState, STORAGE_KEY } from "./store.js";

export const SITE_RULE_BASE = 50_000;
const SITE_RULE_MAX = 50_999;
const SCRIPT_PREFIX = "site-edit-";
const AD_RULESET = "ads";

/**
 * What each tab's frames got last, so a change can take the old sheet back out. Kept in session storage too: the service
 * worker stops when idle, and a new one must still know what it put into pages that stayed open.
 */
const applied = new Map<string, string>();
const APPLIED_KEY = "tk-site-edits-applied";
let restored: Promise<void> | undefined;

function restoreApplied(): Promise<void> {
	restored ??= (async () => {
		try {
			const data = await chrome.storage?.session?.get(APPLIED_KEY);
			for (const [k, v] of Object.entries((data?.[APPLIED_KEY] as Record<string, string>) ?? {})) {
				if (!applied.has(k)) applied.set(k, v);
			}
		} catch {
			/* nothing saved, or no session storage here */
		}
	})();
	return restored;
}

function persistApplied(): void {
	void chrome.storage?.session?.set({ [APPLIED_KEY]: Object.fromEntries(applied) })?.catch(() => undefined);
}

async function injectCss(
	tabId: number,
	frameId: number,
	url: string | undefined,
	state: SiteEditsState,
): Promise<void> {
	await restoreApplied();
	const key = `${tabId}:${frameId}`;
	const css = hideCss(state, url);
	const old = applied.get(key);
	if (old === css) return;
	try {
		if (old) await chrome.scripting.removeCSS({ target: { tabId, frameIds: [frameId] }, css: old, origin: "USER" });
		if (css) await chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: "USER" });
		if (css) applied.set(key, css);
		else applied.delete(key);
	} catch {
		// A page the extension may not touch (the Web Store, a browser page) or a tab that closed.
		applied.delete(key);
	}
	persistApplied();
}

async function syncBlocks(state: SiteEditsState): Promise<void> {
	const dnr = chrome.declarativeNetRequest;
	if (!dnr?.updateDynamicRules) return;
	const existing = await dnr.getDynamicRules();
	const removeRuleIds = existing.map((r) => r.id).filter((id) => id >= SITE_RULE_BASE && id <= SITE_RULE_MAX);
	const addRules = blockRules(state, SITE_RULE_BASE).slice(0, SITE_RULE_MAX - SITE_RULE_BASE + 1);
	await dnr.updateDynamicRules({ removeRuleIds, addRules: addRules as chrome.declarativeNetRequest.Rule[] });
}

async function syncAdBlock(state: SiteEditsState): Promise<void> {
	const dnr = chrome.declarativeNetRequest;
	if (!dnr?.updateEnabledRulesets) return;
	const enabled = await dnr.getEnabledRulesets();
	if (state.adBlock && !enabled.includes(AD_RULESET))
		await dnr.updateEnabledRulesets({ enableRulesetIds: [AD_RULESET] });
	if (!state.adBlock && enabled.includes(AD_RULESET))
		await dnr.updateEnabledRulesets({ disableRulesetIds: [AD_RULESET] });
}

/** Scripts that are on, registered once each; everything else of ours unregistered. Without user scripts, nothing runs. */
async function syncScripts(state: SiteEditsState): Promise<void> {
	const api = userScriptsApi() as unknown as
		| {
				getScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string }>>;
				register(scripts: unknown[]): Promise<void>;
				unregister(filter?: { ids?: string[] }): Promise<void>;
		  }
		| undefined;
	if (!api?.getScripts || !api.register || !api.unregister) return;
	const wanted = state.edits.filter((e) => e.on && e.kind === "script");
	const ours = (await api.getScripts()).map((s) => s.id).filter((id) => id.startsWith(SCRIPT_PREFIX));
	if (ours.length) await api.unregister({ ids: ours });
	if (!wanted.length) return;
	await api.register(
		wanted.map((e) => ({
			id: `${SCRIPT_PREFIX}${e.id}`,
			matches: [`*://${e.host}/*`, `*://*.${e.host}/*`],
			js: [{ code: e.value }],
			runAt: "document_idle",
			world: "USER_SCRIPT",
		})),
	);
}

async function syncOpenTabs(state: SiteEditsState): Promise<void> {
	const tabs = await chrome.tabs.query({});
	await Promise.all(
		tabs
			.filter((t) => t.id !== undefined)
			.map(async (t) => {
				const frames = (await chrome.webNavigation.getAllFrames({ tabId: t.id as number }).catch(() => null)) ?? [];
				await Promise.all(frames.map((f) => injectCss(t.id as number, f.frameId, f.url, state)));
			}),
	);
}

let running: Promise<void> | undefined;
let again = false;

/**
 * Everything at once: at start-up and after every change. One run at a time, and a change during a run starts one more, from
 * storage as it is then: two runs side by side could register a script the person had just turned off. Each part fails on its own.
 */
export function syncSiteEdits(): Promise<void> {
	if (running) {
		again = true;
		return running;
	}
	running = (async () => {
		do {
			again = false;
			const state = await load();
			await Promise.allSettled([syncBlocks(state), syncAdBlock(state), syncScripts(state), syncOpenTabs(state)]);
		} while (again);
	})().finally(() => {
		running = undefined;
	});
	return running;
}

let started = false;

export function startSiteEdits(): void {
	if (started) return;
	started = true;
	chrome.webNavigation?.onCommitted?.addListener((d) => {
		void Promise.all([load(), restoreApplied()]).then(([state]) => {
			if (
				state.edits.some((e) => e.kind === "hide" && e.on && onHost(d.url, e.host)) ||
				applied.has(`${d.tabId}:${d.frameId}`)
			) {
				// A new document starts with no sheet of ours.
				applied.delete(`${d.tabId}:${d.frameId}`);
				return injectCss(d.tabId, d.frameId, d.url, state);
			}
		});
	});
	chrome.tabs?.onRemoved?.addListener((tabId) => {
		for (const key of [...applied.keys()]) if (key.startsWith(`${tabId}:`)) applied.delete(key);
		persistApplied();
	});
	chrome.storage?.onChanged?.addListener((changes, area) => {
		if (area === "local" && changes[STORAGE_KEY]) void syncSiteEdits();
	});
	// User scripts allowed later: register what is waiting.
	chrome.permissions?.onAdded?.addListener(() => void syncSiteEdits());
	void syncSiteEdits().catch(() => undefined);
}
