/**
 * JavaScript dialogs (alert, confirm, prompt, beforeunload) and a bridge call: a call that finds
 * one open fails with dialog_open; a call that opens one itself, by its last input, worked.
 */

import { type DialogPreset, dialogOutcome, type PageDialog, watchDialogs } from "../browser/cdp.js";
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

/** The tools that may set the answer for a box they open, alone or as one step of `actions` (`on_dialog`, D46). */
export const PRESET_METHODS: ReadonlySet<string> = new Set(["click", "press"]);

/** A call's or a step's answer set in advance, and the one tab whose box it may answer. */
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
		throw new BridgeError(
			ERR.BAD_PARAMS,
			`on_dialog works on click and press, or on one click or press step inside actions, not on ${method}`,
		);
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

/**
 * The one step of an `actions` call that sets on_dialog, checked; undefined when none does. `steps` are the batch's
 * steps as the handler reads them; a step's own tabId, else the batch's, names the tab.
 */
export function stepPreset(
	params: Record<string, unknown>,
	steps: Array<[string, Record<string, unknown>]>,
): (WantedPreset & { index: number }) | undefined {
	if (params.on_dialog != null || params.on_dialog_text != null)
		throw new BridgeError(
			ERR.BAD_PARAMS,
			"on_dialog goes on the one click or press step whose box it answers, not on the whole actions call",
		);
	let found: (WantedPreset & { index: number }) | undefined;
	for (const [i, [kind, sub]] of steps.entries()) {
		const want = dialogPreset(kind, sub, sub.tabId ?? params.tabId);
		if (!want) continue;
		if (found)
			throw new BridgeError(
				ERR.BAD_PARAMS,
				`on_dialog may be set on one step only; steps ${found.index} and ${i} set it`,
			);
		found = { ...want, index: i };
	}
	return found;
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
	const opened = `${before ? `${before} ` : "That worked. "}${dialogKind(dialog)} is now open on tab ${tabId}: ${JSON.stringify(dialog.message)}. `;
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
	options: {
		/** This call's id: only a box that took this call's armed answer is this call's on_dialog box. */
		call?: string;
		/** The note for a box that opened while the person's tab of the site is in front (dialog-guard.ts). */
		soon?: (tabId: number, dialog: PageDialog) => Promise<string | undefined>;
	} = {},
): Promise<T | Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		/** The box the call's `on_dialog` answered as it opened: the call goes on. */
		let answered: { tabId: number; dialog: PageDialog } | undefined;
		/** A box the call did not answer froze it: the call's result is that box's, not the work's. */
		let opened = false;
		const stop = watchDialogs((tabId, dialog) => {
			if (!session.tabIds.includes(tabId)) return;
			if (!answered && dialog.preset && options.call !== undefined && dialog.presetCall === options.call) {
				answered = { tabId, dialog };
				return;
			}
			stop();
			onAbort();
			opened = true;
			const done = delivered();
			if (!done || done.tabId !== tabId) {
				reject(dialogError(tabId, dialog));
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
		work.then(
			async (v) => {
				stop();
				if (opened) return;
				resolve((answered ? await presetResult(v, answered.tabId, answered.dialog) : v) as T);
			},
			(e) => {
				stop();
				reject(e);
			},
		);
	});
}
