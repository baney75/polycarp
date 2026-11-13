/**
 * JavaScript dialogs (alert, confirm, prompt, beforeunload) and a bridge call: a call that finds
 * one open fails with dialog_open; a call that opens one itself, by its last input, worked.
 */

import { type DialogPreset, type PageDialog, watchDialogs } from "../browser/cdp.js";
import type { BrowserSession } from "../browser/session.js";
import { BridgeError } from "./errors.js";
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

/** The actions that may set the answer for a box they open (`on_dialog`, D46). */
export const PRESET_METHODS: ReadonlySet<string> = new Set(["click", "press", "type", "fill", "actions"]);

/** An action's `on_dialog` ("ok" or "cancel") and `on_dialog_text`, checked; undefined when it set none. */
export function dialogPreset(method: string, params?: Record<string, unknown>): DialogPreset | undefined {
	const on = params?.on_dialog;
	const text = params?.on_dialog_text;
	if (on === undefined || on === null) {
		if (text !== undefined && text !== null)
			throw new BridgeError(ERR.BAD_PARAMS, 'on_dialog_text needs on_dialog "ok"');
		return undefined;
	}
	if (!PRESET_METHODS.has(method))
		throw new BridgeError(ERR.BAD_PARAMS, `on_dialog works with ${[...PRESET_METHODS].join(", ")}, not ${method}`);
	if (on !== "ok" && on !== "cancel") throw new BridgeError(ERR.BAD_PARAMS, 'on_dialog must be "ok" or "cancel"');
	if (text !== undefined && text !== null && typeof text !== "string")
		throw new BridgeError(ERR.BAD_PARAMS, "on_dialog_text must be a string");
	return { accept: on === "ok", ...(typeof text === "string" && on === "ok" ? { promptText: text } : {}) };
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
export function dialogOpenedResult(delivered: Record<string, unknown>, tabId: number, dialog: PageDialog) {
	const notRun = typeof delivered.notRun === "number" ? delivered.notRun : 0;
	return {
		...delivered,
		dialog: { tabId, type: dialog.type, message: dialog.message },
		note:
			`That worked. ${dialogKind(dialog)} is now open on tab ${tabId}: ${JSON.stringify(dialog.message)}. ` +
			`${notRun > 0 ? `The ${notRun} later step${notRun === 1 ? "" : "s"} did not run: send them again once the dialog is answered. ` : ""}` +
			`Do not repeat the step that opened it. The page is frozen until the dialog is answered: call handle_dialog with tabId ${tabId} and accept true (OK) or false (Cancel). Cancel is always safe. ` +
			"OK is fine when the user already asked for exactly this action; otherwise ask them first if OK would act under their sign-in (delete, send, buy, post).",
	};
}

/** What a call returns when its `on_dialog` answered the box its action opened. */
function presetResult(result: unknown, tabId: number, dialog: PageDialog): unknown {
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	const answered = dialog.preset?.accept ? "ok" : "cancel";
	const said = `${dialogKind(dialog)} opened on tab ${tabId} (${JSON.stringify(dialog.message)}) and was answered ${answered === "ok" ? "OK" : "Cancel"} at once, as on_dialog asked.`;
	const r = result as Record<string, unknown>;
	return {
		...r,
		dialog: { tabId, type: dialog.type, message: dialog.message, answered },
		note: typeof r.note === "string" ? `${r.note} ${said}` : said,
	};
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
 */
export function raceDialogs<T>(
	session: Pick<BrowserSession, "tabIds">,
	work: Promise<T>,
	onAbort: () => void,
	delivered: () => Delivered | undefined,
): Promise<T | ReturnType<typeof dialogOpenedResult>> {
	return new Promise((resolve, reject) => {
		/** The box the call's `on_dialog` answered as it opened: the call goes on. */
		let answered: { tabId: number; dialog: PageDialog } | undefined;
		const stop = watchDialogs((tabId, dialog) => {
			if (!session.tabIds.includes(tabId)) return;
			if (dialog.preset && !answered) {
				answered = { tabId, dialog };
				return;
			}
			stop();
			onAbort();
			const done = delivered();
			if (done && done.tabId === tabId) resolve(dialogOpenedResult(done.result, tabId, dialog));
			else reject(dialogError(tabId, dialog));
		});
		work.then(
			(v) => {
				stop();
				resolve((answered ? presetResult(v, answered.tabId, answered.dialog) : v) as T);
			},
			(e) => {
				stop();
				reject(e);
			},
		);
	});
}
