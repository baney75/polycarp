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

/** A result whose JSON runs past this many characters is not kept for a lost run: the call then fails instead. */
const KEPT_RESULT_CHARS = 256_000;
/** The message a run sends the extension, in the userScripts world's own messaging: nothing is left in the page. */
const RUN_MESSAGE = "polycarp-run";

/** Each userScripts run of this context, by its mark: whether the extension heard it start, and its kept result. */
const runs = new Map<string, { started: boolean; kept?: string }>();
/** Runs a person stopped: a stopped run that gave no result never goes to the debugger path (second-F4). */
const terminated = new Set<string>();
let listening = false;

/** Answer only this context's own runs: the worker and each panel all hear every user-script message. */
function listenForRuns(): void {
	if (listening || !chrome.runtime.onUserScriptMessage) return;
	listening = true;
	chrome.runtime.onUserScriptMessage.addListener((message, _sender, sendResponse) => {
		const m = message as { type?: string; mark?: string; step?: string; kept?: string };
		const run = m?.type === RUN_MESSAGE && m.mark ? runs.get(m.mark) : undefined;
		if (!run) return;
		if (m.step === "start") run.started = true;
		else if (typeof m.kept === "string") run.kept = m.kept;
		sendResponse(true);
	});
}

/**
 * Run `code` (an expression or IIFE, may return a promise) in the page and return
 * its value, matching userScripts.execute's `results[0].result`.
 *
 * userScripts.execute can come back with no result for a run (a browserjs() that read `undefined` a dozen times in a
 * row, 2026-11-07). The code is then run on the debugger path only when it never started: a run tells the extension
 * it is starting, and waits for the answer, before its code runs, and sends a small result back after. A run the
 * extension heard start is never run again: its kept result is returned, or the call fails. Nothing is written to the
 * page (first-F1, first-F2 of the review of PR 260).
 */
export async function injectScript<T = unknown>(tabId: number, code: string, options: InjectOptions = {}): Promise<T> {
	const api = userScriptsApi();
	if (!api) return cdpInject<T>(tabId, code, options);
	listenForRuns();
	const worldId = options.worldId ?? "tabkyra";
	const mark = crypto.randomUUID();
	const send = (fields: string) =>
		`chrome.runtime.sendMessage({ type: ${JSON.stringify(RUN_MESSAGE)}, mark: ${JSON.stringify(mark)}, ${fields} })`;
	const marked = `(async () => {
	if ((await ${send('step: "start"')}.catch(() => false)) !== true)
		throw new Error("Not run: Polycarp could not record that this script started. Try again.");
	const v = await (${code});
	let size = 0;
	let kept;
	try {
		kept = JSON.stringify([v], (_k, x) => {
			size += typeof x === "string" ? x.length : 16;
			if (size > ${KEPT_RESULT_CHARS}) throw 0;
			return x;
		});
	} catch {}
	if (kept !== undefined) await ${send('step: "done", kept')}.catch(() => undefined);
	return { v };
})()`;
	runs.set(mark, { started: false });
	try {
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
		return await lostResult<T>(tabId, code, options, runs.get(mark));
	} finally {
		runs.delete(mark);
		if (options.executionId) terminated.delete(options.executionId);
	}
}

/** userScripts gave no result: run the code on the debugger path only if it never started and was not stopped. */
async function lostResult<T>(
	tabId: number,
	code: string,
	options: InjectOptions,
	run: { started: boolean; kept?: string } | undefined,
): Promise<T> {
	if (run?.started) {
		if (run.kept !== undefined) return (JSON.parse(run.kept) as [T])[0];
		throw new PageException(
			"The script ran, but its result was lost, so it was not run again: it may have acted on the page. Call read_page to see the page before you act again.",
		);
	}
	if (options.executionId && terminated.has(options.executionId))
		throw new PageException("The script was stopped before it ran. Nothing was done on the page.");
	try {
		return await cdpInject<T>(tabId, code, options);
	} catch (err) {
		// It never ran on either path (second-F5): say so, with the debugger's own words.
		if (err instanceof PageException) throw err;
		throw new PageException(
			`Not run: the page did not answer, and the debugger could not run it (${err instanceof Error ? err.message : String(err)}). Call read_page, then try again.`,
		);
	}
}

/** Cancel a running injection on either path. */
export async function terminateInjection(tabId: number, executionId: string): Promise<boolean> {
	const api = userScriptsApi();
	if (api?.terminate) {
		terminated.add(executionId);
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
