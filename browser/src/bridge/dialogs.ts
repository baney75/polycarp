/**
 * JavaScript dialogs (alert, confirm, prompt, beforeunload) and a bridge call: a call that finds
 * one open fails with dialog_open; a call that opens one itself, by its last input, worked.
 */

import {
	type DialogPreset,
	dialogOutcome,
	openDialog,
	type PageDialog,
	watchDialogs,
	watchPresetFailures,
} from "../browser/cdp.js";
import type { BrowserSession } from "../browser/session.js";
import { BridgeError, classify } from "./errors.js";
import { ERR } from "./protocol.js";

function dialogKind(dialog: PageDialog): string {
	const kind = dialog.type === "beforeunload" ? "leave-page" : dialog.type;
	return `${/^[aeiou]/.test(kind) ? "An" : "A"} ${kind} dialog`;
}

export function dialogError(tabId: number, dialog: PageDialog): BridgeError {
	return new BridgeError(
		ERR.DIALOG_OPEN,
		`${dialogKind(dialog)} is open on tab ${tabId}: ${JSON.stringify(dialog.message)}. The page is frozen until it is answered. ` +
			`Call handle_dialog with tabId ${tabId} and accept true (OK) or false (Cancel). Cancel is always safe. ` +
			"OK is fine when the user already asked for exactly this action; otherwise ask them first if OK would act under their sign-in (delete, send, buy, post).",
	);
}

/** The tools that may set the answer for a box they open: a single click or press call, never a step of `actions` (D48). */
export const PRESET_METHODS: ReadonlySet<string> = new Set(["click", "press"]);

/** A call's answer set in advance, and the one tab whose box it may answer. */
export interface WantedPreset {
	preset: DialogPreset;
	tabId: number;
}

const TEXT_NEEDS_OK = 'on_dialog_text needs on_dialog "ok"';

/**
 * `on_dialog` ("ok" or "cancel") and `on_dialog_text` of a click or press, checked; undefined when it set none.
 * The tab must be named: the answer is for a box on that tab only, never on whatever tab is current when it opens.
 */
export function dialogPreset(
	method: string,
	params?: Record<string, unknown>,
	tabId: unknown = params?.tabId,
): WantedPreset | undefined {
	const on = params?.on_dialog;
	const text = params?.on_dialog_text;
	if (text !== undefined && text !== null && on !== "ok") throw new BridgeError(ERR.BAD_PARAMS, TEXT_NEEDS_OK);
	if (on === undefined || on === null) return undefined;
	if (!PRESET_METHODS.has(method))
		throw new BridgeError(ERR.BAD_PARAMS, `on_dialog works on a single click or press call, not on ${method}`);
	if (on !== "ok" && on !== "cancel") throw new BridgeError(ERR.BAD_PARAMS, 'on_dialog must be "ok" or "cancel"');
	if (text !== undefined && text !== null && typeof text !== "string")
		throw new BridgeError(ERR.BAD_PARAMS, "on_dialog_text must be a string");
	const named = tabId === undefined || tabId === null ? Number.NaN : Number(tabId);
	if (!Number.isInteger(named))
		throw new BridgeError(
			ERR.BAD_PARAMS,
			"on_dialog needs tabId: the tab whose box it answers (tabs_context lists yours)",
		);
	return { preset: { accept: on === "ok", ...(typeof text === "string" ? { promptText: text } : {}) }, tabId: named };
}

const has = (o: unknown, k: string) => !!o && typeof o === "object" && (o as Record<string, unknown>)[k] != null;
const setsDialog = (o: unknown) => has(o, "on_dialog") || has(o, "on_dialog_text");

/**
 * An `actions` call never takes on_dialog (D48): not on the call, not beside a step's key, not inside it. Throws
 * bad_params with the single click or press call to send instead. `normalize` reads a raw step as the handler does.
 */
export function refuseStepPreset(
	params: Record<string, unknown>,
	normalize: (step: Record<string, unknown>, i: number) => [string, Record<string, unknown>],
): void {
	const steps = Array.isArray(params.steps) ? params.steps : [];
	const i = steps.findIndex(
		(st) => setsDialog(st) || (!!st && typeof st === "object" && Object.values(st).some(setsDialog)),
	);
	if (i < 0 && !setsDialog(params)) return;
	const raw = (i < 0 ? steps.find((st) => st && typeof st === "object") : steps[i]) as
		| Record<string, unknown>
		| undefined;
	let kind = "click";
	let args: Record<string, unknown> = { ref: "<ref>" };
	try {
		if (raw) [kind, args] = normalize(raw, Math.max(i, 0));
	} catch {
		// A step the handler would refuse anyway: the example keeps its placeholder.
	}
	if (!PRESET_METHODS.has(kind)) [kind, args] = ["click", { ref: "<ref>" }];
	const { on_dialog: _on, on_dialog_text: _text, tabId, repeat: _repeat, ...rest } = args;
	const tab = tabId ?? params.tabId ?? "<your tab>";
	const example = JSON.stringify({ tabId: tab, ...rest, on_dialog: "ok" });
	const where = i < 0 ? "on an actions call" : `on step ${i} of actions`;
	throw new BridgeError(
		ERR.BAD_PARAMS,
		`on_dialog is not allowed ${where}: nothing was run. on_dialog works only on a single click or press call. ` +
			`Run the steps before it with actions, then call ${kind} on its own with ${example} ` +
			'("cancel" in place of "ok" to cancel the box).',
	);
}

/** Methods that still work while a dialog freezes the page. */
const DIALOG_SAFE = new Set([
	"dialog",
	"status",
	"tabs.context",
	"tabs.create",
	"tabs.close",
	"tabs.select",
	"tabs.show",
	"permission.respond",
	// Read buffered messages only; they help explain the dialog.
	"console.read",
	"network.read",
	// Saving what a capture holds is how an agent keeps the evidence of a page that broke (a dialog included).
	"capture",
]);

/**
 * Whether a call may run while a dialog is open on one of the session's tabs. The bridge
 * (native.ts) and the side panel's tools (panel-calls.ts) both ask this.
 */
export function isDialogSafe(method: string, params?: Record<string, unknown>): boolean {
	// Reading a body asks the page's network stack, not just a buffer: not while a dialog holds it.
	if (method === "network.read" && params?.requestId !== undefined) return false;
	// A capture's start attaches to the page; saving or stopping reads what it holds, which is what a dialog calls for.
	if (method === "capture" && String(params?.action).endsWith("_start")) return false;
	return DIALOG_SAFE.has(method);
}

/** What a call that worked, and so opened a dialog, returns: its result plus the dialog and what answers it. */
export function dialogOpenedResult(
	delivered: Record<string, unknown>,
	tabId: number,
	dialog: PageDialog,
	/** The person's tab of the site is in front: what to do instead of handle_dialog (dialog-guard.ts dialogSoon). */
	soon?: string,
	/** A box the call's on_dialog answered before this one opened. */
	before?: string,
) {
	const notRun = typeof delivered.notRun === "number" ? delivered.notRun : 0;
	const later = notRun > 0 ? `The ${notRun} later step${notRun === 1 ? "" : "s"} did not run. ` : "";
	// An alert may report a failure (first-F4 of the review of PR 200): only a box that asks is a sign the input worked.
	const worked = dialog.type === "alert" ? "" : "That worked. ";
	const opened = `${before ? `${before} ` : worked}${dialogKind(dialog)} is now open on tab ${tabId}: ${JSON.stringify(dialog.message)}. `;
	return {
		...delivered,
		dialog: { tabId, type: dialog.type, message: dialog.message },
		note: soon
			? `${opened}${later}${soon}`
			: `${opened}${later ? `${later.slice(0, -2)}: send them again once the dialog is answered. ` : ""}` +
				`Do not repeat the step that opened it. The page is frozen until the dialog is answered: call handle_dialog with tabId ${tabId} and accept true (OK) or false (Cancel). Cancel is always safe. ` +
				"OK is fine when the user already asked for exactly this action; otherwise ask them first if OK would act under their sign-in (delete, send, buy, post).",
	};
}

/** How long a call waits, once its action is done, to learn how its on_dialog box ended. */
const OUTCOME_WAIT_MS = 2000;

/**
 * How the box the call's on_dialog took ended, as the page got it (sol-F1 of the review of PR 193): the answer that
 * landed, not the one asked for. Undefined when no answer is known.
 */
async function landed(dialog: PageDialog): Promise<boolean | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const out = await Promise.race([
		dialogOutcome(dialog.seq),
		new Promise<undefined>((r) => {
			timer = setTimeout(() => r(undefined), OUTCOME_WAIT_MS);
		}),
	]);
	clearTimeout(timer);
	return out;
}

/** The words for how the call's on_dialog box ended, and the `answered` the result reports. */
function presetSaid(tabId: number, dialog: PageDialog, accept: boolean | undefined) {
	const box = `${dialogKind(dialog)} opened on tab ${tabId} (${JSON.stringify(dialog.message)})`;
	const asked = dialog.preset?.accept ? "OK" : "Cancel";
	if (accept === undefined)
		return {
			answered: "unknown" as const,
			said: `${box}; on_dialog asked for ${asked}, but how it was answered is not known. Read the page (read_page) to see what happened before you act again.`,
		};
	const got = accept ? "OK" : "Cancel";
	if (accept === dialog.preset?.accept)
		return {
			answered: accept ? ("ok" as const) : ("cancel" as const),
			said: `${box} and was answered ${got} at once, as on_dialog asked.`,
		};
	return {
		answered: accept ? ("ok" as const) : ("cancel" as const),
		said: `${box}. on_dialog's ${asked} did not reach the page: it was answered ${got}, and the page saw ${got}.`,
	};
}

/** What a call returns when its `on_dialog` box closed: the answer that landed. */
async function presetResult(result: unknown, tabId: number, dialog: PageDialog): Promise<unknown> {
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	const { answered, said } = presetSaid(tabId, dialog, await landed(dialog));
	const r = result as Record<string, unknown>;
	return {
		...r,
		dialog: { tabId, type: dialog.type, message: dialog.message, answered },
		note: typeof r.note === "string" ? `${r.note} ${said}` : said,
	};
}

/**
 * The error a call returns when it fails after its on_dialog box was answered (second-S1 of the review of PR 200): the
 * same code, with the answer that landed, so the agent does not do the action again.
 */
async function afterPreset(err: unknown, method: string, tabId: number, dialog: PageDialog): Promise<BridgeError> {
	const { said } = presetSaid(tabId, dialog, await landed(dialog));
	const { error } = classify(err, method);
	return new BridgeError(
		error.code,
		`${error.message} Before that, ${said.charAt(0).toLowerCase()}${said.slice(1)} Do not repeat the action: read_page first.`,
		error.source,
	);
}

/** The error a call returns when its on_dialog answer did not reach the box (first-F3 of the review of PR 200). */
function presetFailedError(tabId: number, dialog: PageDialog, cancelled: boolean): BridgeError {
	const box = `${dialogKind(dialog)} opened on tab ${tabId} (${JSON.stringify(dialog.message)})`;
	const asked = dialog.preset?.accept ? "OK" : "Cancel";
	if (cancelled)
		return new BridgeError(
			ERR.INTERRUPTED,
			`${box}, but on_dialog's ${asked} did not reach it, so Polycarp answered Cancel and the page saw Cancel. ` +
				"Read the page (read_page) to see what happened before you do it again.",
			"extension",
		);
	if (openDialog(tabId)?.seq === dialog.seq) {
		const open = dialogError(tabId, dialog);
		return new BridgeError(
			ERR.DIALOG_OPEN,
			`on_dialog's ${asked} did not reach the box, and it is still open. ${open.message}`,
		);
	}
	return new BridgeError(
		ERR.INTERRUPTED,
		`${box}, but on_dialog's ${asked} did not reach it, and it closed without an answer Polycarp saw. ` +
			"Read the page (read_page) to see what happened before you act again.",
		"extension",
	);
}

/** An action whose last input is on its way: what it returns, and the tab the input went to. */
export interface Delivered {
	result: Record<string, unknown>;
	tabId: number;
}

/**
 * Run a handler, but fail at once if a dialog opens on one of the session's tabs. The
 * handler can't be cancelled mid-CDP-call, so `onAbort` flips the flag it checks before
 * sending more input. When the handler had already sent the input that completes its action
 * (`delivered`), a dialog that opened on the tab that input went to is that action's effect and
 * the call succeeds with a note; a dialog on any other tab is not, and still fails.
 * Once the call's on_dialog answered its box, any failure says so (second-S1); an answer that did not reach the box
 * fails the call at once (first-F3).
 */
export function raceDialogs<T>(
	session: Pick<BrowserSession, "tabIds">,
	work: Promise<T>,
	onAbort: () => void,
	delivered: () => Delivered | undefined,
	options: {
		/** This call's id: only a box that took this call's armed answer is this call's on_dialog box. */
		call?: string;
		/** The tool called, for the words of an error after its on_dialog answer landed. */
		method?: string;
		/** The note for a box that opened while the person's tab of the site is in front (dialog-guard.ts). */
		soon?: (tabId: number, dialog: PageDialog) => Promise<string | undefined>;
	} = {},
): Promise<T | Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		/** The box the call's `on_dialog` answered as it opened: the call goes on. */
		let answered: { tabId: number; dialog: PageDialog } | undefined;
		/** A box the call did not answer froze it, or its answer failed: the call's result is that, not the work's. */
		let opened = false;
		const fail = (err: unknown) => {
			const first = answered;
			if (!first) return reject(err);
			void afterPreset(err, options.method ?? "call", first.tabId, first.dialog).then(reject);
		};
		const stopFails = watchPresetFailures((tabId, dialog, cancelled) => {
			if (opened || dialog.presetCall === undefined || dialog.presetCall !== options.call) return;
			stop();
			opened = true;
			onAbort();
			reject(presetFailedError(tabId, dialog, cancelled));
		});
		const stopWatch = watchDialogs((tabId, dialog) => {
			if (opened || !session.tabIds.includes(tabId)) return;
			if (!answered && dialog.preset && options.call !== undefined && dialog.presetCall === options.call) {
				answered = { tabId, dialog };
				return;
			}
			stop();
			onAbort();
			opened = true;
			const done = delivered();
			if (!done || done.tabId !== tabId) {
				fail(dialogError(tabId, dialog));
				return;
			}
			const first = answered;
			void (async () => {
				const soon = await options.soon?.(tabId, dialog).catch(() => undefined);
				const before = first ? presetSaid(first.tabId, first.dialog, await landed(first.dialog)) : undefined;
				const out = dialogOpenedResult(done.result, tabId, dialog, soon, before?.said);
				resolve(
					first && before
						? {
								...out,
								answered: {
									tabId: first.tabId,
									type: first.dialog.type,
									message: first.dialog.message,
									answered: before.answered,
								},
							}
						: out,
				);
			})();
		});
		const stop = () => {
			stopWatch();
			stopFails();
		};
		work.then(
			async (v) => {
				if (opened) return;
				// The armed answer's failure is told on the CDP reply: wait for how the box ended before the result.
				const out = answered ? await presetResult(v, answered.tabId, answered.dialog) : v;
				stop();
				if (!opened) resolve(out as T);
			},
			(e) => {
				stop();
				if (!opened) fail(e);
			},
		);
	});
}
