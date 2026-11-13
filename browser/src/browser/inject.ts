/**
 * Script injection that works with or without the `userScripts` API.
 *
 * Chromium gates `chrome.userScripts` behind the "Allow User Scripts" toggle even when
 * the optional permission was granted, and Manifest V3 forbids eval in isolated
 * content-script worlds, so arbitrary code strings can only run in two ways:
 *
 * 1. `userScripts.execute` when the toggle is on (isolated world, our own CSP, real
 *    `chrome.runtime.sendMessage` messaging).
 * 2. The debugger's `Runtime.evaluate` in the page's main world otherwise. CSP does not
 *    apply to it. Messaging is provided by a CDP binding: injected code calls a local
 *    `chrome.runtime.sendMessage` shim that posts through the binding, and replies come
 *    back through `Runtime.evaluate`.
 *
 * Both paths run the same code; callers do not need to know which one is in use.
 */

import { cdpSend, ensureAttached, PageException } from "./cdp.js";
import { isUserScriptsGated, userScriptsApi } from "./userscripts-status.js";

export function hasUserScripts(): boolean {
	return userScriptsApi() !== undefined;
}

const configuredWorlds = new Set<string>();

export interface InjectOptions {
	/** userScripts world id; ignored on the debugger path. */
	worldId?: string;
	/** userScripts world CSP; ignored on the debugger path. */
	csp?: string;
	/** Enables cancellation (userScripts.terminate or Runtime.terminateExecution). */
	executionId?: string;
}

/** Handles messages the injected code sends through the shim; set once per context. */
export type CdpMessageHandler = (message: Record<string, unknown>, tabId: number) => Promise<unknown>;
let cdpMessageHandler: CdpMessageHandler | undefined;

export function setCdpMessageHandler(handler: CdpMessageHandler): void {
	cdpMessageHandler = handler;
}

/**
 * Runtime providers per sandbox id, mirroring what the sandbox router holds for the
 * userScripts path. The debugger path has no chrome.runtime listener, so messages are
 * routed here: the first provider that responds wins.
 */
interface SandboxProvider {
	handleMessage?(message: unknown, respond: (response: unknown) => void): Promise<void>;
}
const sandboxProviders = new Map<string, SandboxProvider[]>();

export function registerSandboxProviders(sandboxId: string, providers: SandboxProvider[]): void {
	sandboxProviders.set(sandboxId, providers);
}

export function unregisterSandboxProviders(sandboxId: string): void {
	sandboxProviders.delete(sandboxId);
}

export async function dispatchToSandbox(message: Record<string, unknown>): Promise<unknown> {
	const sandboxId = message.sandboxId;
	if (typeof sandboxId !== "string") return undefined;
	const providers = sandboxProviders.get(sandboxId);
	if (!providers) return undefined;
	let response: unknown;
	let responded = false;
	const respond = (r: unknown) => {
		if (responded) return;
		responded = true;
		response = { ...(r as Record<string, unknown>), sandboxId };
	};
	for (const provider of providers) {
		if (provider.handleMessage) await provider.handleMessage(message, respond);
	}
	return response;
}

const BINDING = "__tabkyraSend";
const bindingReady = new Set<number>();
let bindingListenerInstalled = false;
const runningExecutions = new Map<string, number>();

function installBindingListener(): void {
	if (bindingListenerInstalled) return;
	bindingListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (method !== "Runtime.bindingCalled" || source.tabId === undefined) return;
		const p = params as { name?: string; payload?: string } | undefined;
		if (p?.name !== BINDING || !p.payload) return;
		const tabId = source.tabId;
		let parsed: { id: number; message: Record<string, unknown> };
		try {
			parsed = JSON.parse(p.payload);
		} catch {
			return;
		}
		(async () => {
			let response: unknown;
			let error: string | undefined;
			try {
				response = cdpMessageHandler ? await cdpMessageHandler(parsed.message, tabId) : undefined;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
			const expression = `window.__tabkyraReceive && window.__tabkyraReceive(${parsed.id}, ${JSON.stringify(
				response ?? null,
			)}, ${JSON.stringify(error ?? null)})`;
			await cdpSend(tabId, "Runtime.evaluate", { expression, returnByValue: true }).catch(() => undefined);
		})();
	});
	chrome.tabs.onRemoved.addListener((tabId) => bindingReady.delete(tabId));
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId !== undefined) bindingReady.delete(source.tabId);
	});
}

async function ensureBinding(tabId: number): Promise<void> {
	installBindingListener();
	await ensureAttached(tabId);
	if (bindingReady.has(tabId)) return;
	await cdpSend(tabId, "Runtime.enable");
	await cdpSend(tabId, "Runtime.addBinding", { name: BINDING }).catch(() => undefined);
	bindingReady.add(tabId);
}

/**
 * Page-side shim, installed once per document: a promise registry plus a
 * `chrome.runtime.sendMessage` lookalike that posts through the CDP binding.
 */
const SHIM = `(() => {
	const w = window;
	if (!w.__tabkyraPending) {
		w.__tabkyraPending = new Map();
		w.__tabkyraSeq = 0;
		w.__tabkyraReceive = (id, response, error) => {
			const p = w.__tabkyraPending.get(id);
			if (!p) return;
			w.__tabkyraPending.delete(id);
			if (error) p.reject(new Error(error)); else p.resolve(response);
		};
	}
	if (!w.__tabkyraChrome) {
		w.__tabkyraChrome = {
			runtime: {
				id: "tabkyra",
				sendMessage: (message) => new Promise((resolve, reject) => {
					const id = ++w.__tabkyraSeq;
					w.__tabkyraPending.set(id, { resolve, reject });
					w.${BINDING}(JSON.stringify({ id, message }));
				}),
			},
		};
	}
})();`;

async function cdpInject<T>(tabId: number, code: string, options: InjectOptions): Promise<T> {
	await ensureBinding(tabId);
	// `chrome` inside the injected code resolves to the shim; the page's own window.chrome is untouched.
	const expression = `${SHIM}\n(async () => { const chrome = window.__tabkyraChrome; return await (${code}); })()`;
	if (options.executionId) runningExecutions.set(options.executionId, tabId);
	try {
		const result = await cdpSend<{
			result: { value?: T; description?: string };
			exceptionDetails?: { exception?: { description?: string }; text?: string };
		}>(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) {
			throw new PageException(
				result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
			);
		}
		return result.result.value as T;
	} finally {
		if (options.executionId) runningExecutions.delete(options.executionId);
	}
}

/** A stored result over this many characters is not kept in the page: a lost one then fails instead (see below). */
const KEPT_RESULT_CHARS = 256_000;
/** How long a run's mark stays on the page: the check after a lost result comes at once. */
const MARK_MS = 60_000;

/**
 * Run `code` (an expression or IIFE, may return a promise) in the page and return
 * its value, matching userScripts.execute's `results[0].result`.
 *
 * userScripts.execute can come back with no result for a run (a browserjs() that read `undefined` a dozen times in a
 * row, 2026-11-07). The code is then run on the debugger path only when it never ran: each run first marks the page's
 * DOM, the one thing both worlds share, with an attribute named for the call, and keeps its result there. A mark, or a
 * new document, means the code ran, so it is never run twice: its kept result is returned, or the call fails.
 */
export async function injectScript<T = unknown>(tabId: number, code: string, options: InjectOptions = {}): Promise<T> {
	const api = userScriptsApi();
	if (!api) return cdpInject<T>(tabId, code, options);
	const worldId = options.worldId ?? "tabkyra";
	const mark = `data-polycarp-run-${crypto.randomUUID()}`;
	const marked = `(async () => {
	const m = document.documentElement;
	m?.setAttribute(${JSON.stringify(mark)}, "");
	setTimeout(() => m?.removeAttribute(${JSON.stringify(mark)}), ${MARK_MS});
	const v = await (${code});
	try {
		const kept = JSON.stringify([v]);
		if (kept.length <= ${KEPT_RESULT_CHARS}) m?.setAttribute(${JSON.stringify(mark)}, kept);
	} catch {}
	return { v };
})()`;
	const before = await documentOf(tabId);
	let results: Awaited<ReturnType<typeof api.execute>>;
	try {
		if (!configuredWorlds.has(worldId)) {
			try {
				await api.configureWorld({ worldId, messaging: true, csp: options.csp });
			} catch (err) {
				if (isUserScriptsGated(err)) throw err;
				/* already configured */
			}
			configuredWorlds.add(worldId);
		}
		results = await api.execute({
			js: [{ code: marked }],
			target: { tabId, allFrames: false },
			world: "USER_SCRIPT",
			worldId,
			injectImmediately: true,
			...(options.executionId && api.terminate ? { executionId: options.executionId } : {}),
		});
	} catch (err) {
		// Present but refused (permission or toggle): the code never ran, so the debugger path runs it.
		if (isUserScriptsGated(err)) return cdpInject<T>(tabId, code, options);
		throw err;
	}
	const first = results[0];
	if (first?.error) throw new PageException(String((first.error as { message?: string }).message ?? first.error));
	const envelope = first?.result as { v: T } | undefined;
	// Any result object is the run's own envelope (a `v` of undefined may arrive with the key gone).
	if (envelope && typeof envelope === "object") return envelope.v;
	return lostResult<T>(tabId, code, options, mark, before);
}

/** The id of the document in the tab's top frame, or undefined when the browser won't say. */
async function documentOf(tabId: number): Promise<string | undefined> {
	try {
		return (await chrome.webNavigation.getFrame({ tabId, frameId: 0 }))?.documentId;
	} catch {
		return undefined;
	}
}

/** userScripts gave no result: run the code on the debugger path only if the page shows it never ran. */
async function lostResult<T>(
	tabId: number,
	code: string,
	options: InjectOptions,
	mark: string,
	before: string | undefined,
): Promise<T> {
	const lost = new PageException(
		"The script ran, but its result was lost, so it was not run again: it may have acted on the page. Call read_page to see the page before you act again.",
	);
	const now = await documentOf(tabId);
	// A new document (the code navigated, or the page did) holds no mark of a run that happened: never run it again.
	if (!before || before !== now) throw lost;
	const name = JSON.stringify(mark);
	const seen = await cdpInject<string | null | undefined>(
		tabId,
		`(() => { const m = document.documentElement; if (!m) return undefined; const v = m.getAttribute(${name}); m.removeAttribute(${name}); return v; })()`,
		{},
	);
	if (seen === null) return cdpInject<T>(tabId, code, options);
	if (!seen) throw lost;
	return (JSON.parse(seen) as [T])[0];
}

/** Cancel a running injection on either path. */
export async function terminateInjection(tabId: number, executionId: string): Promise<boolean> {
	const api = userScriptsApi();
	if (api?.terminate) {
		await api.terminate(tabId, executionId);
		return true;
	}
	if (runningExecutions.has(executionId)) {
		await cdpSend(tabId, "Runtime.terminateExecution").catch(() => undefined);
		return true;
	}
	return false;
}

export function supportsTermination(): boolean {
	return true;
}
