/**
 * JavaScript dialogs (alert, confirm, prompt, beforeunload) and a bridge call: a call that finds
 * one open fails with dialog_open; a call that opens one itself, by its last input, worked.
 */

import { type PageDialog, watchDialogs } from "../browser/cdp.js";
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
		const stop = watchDialogs((tabId, dialog) => {
			if (!session.tabIds.includes(tabId)) return;
			stop();
			onAbort();
			const done = delivered();
			if (done && done.tabId === tabId) resolve(dialogOpenedResult(done.result, tabId, dialog));
			else reject(dialogError(tabId, dialog));
		});
		work.then(
			(v) => {
				stop();
				resolve(v);
			},
			(e) => {
				stop();
				reject(e);
			},
		);
	});
}
