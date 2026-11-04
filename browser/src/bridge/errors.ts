/**
 * Errors a bridge call returns. An expected failure (a stale ref, a missing tab, a script that
 * threw) gets its own code and a message with no stack trace; `internal` is for real bugs. The
 * stack goes to the debug log (`tabkyra debug`), not to the agent.
 */

import { isDetachError, isNavigatedError, PageException } from "../browser/cdp.js";
import { ClipboardChordError } from "../browser/key-commands.js";
import { NoTabError } from "../browser/session.js";
import { ERR, type RpcError } from "./protocol.js";

export class BridgeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		/** See RpcError.source. */
		readonly source?: "extension",
	) {
		super(message);
	}
	toRpc(): RpcError {
		return { code: this.code, message: this.message, ...(this.source ? { source: this.source } : {}) };
	}
}

/**
 * The debugger detached from the tab while a call was running. Like a dropped connection, the
 * call may have run: the agent checks the page before repeating it. Never the raw CDP message.
 */
export function detachedError(method: string, what: string): BridgeError {
	return new BridgeError(
		ERR.INTERRUPTED,
		`The browser's debugger detached from the tab while ${method} was running, so it may have run (${what}). Check the page with read_page before you repeat it; Tabkyra attaches again on your next call.`,
		"extension",
	);
}

/** Interrupted by a navigation under the call (the debugger may be fine): the call may have run. */
export function navigatedError(method: string, what: string): BridgeError {
	return new BridgeError(
		ERR.INTERRUPTED,
		`The page navigated while ${method} was running, so it may have run (${what}). Check the page with read_page before you repeat it.`,
		"extension",
	);
}

/** The interrupted error for a detach or navigation error, worded for what happened. */
export function interruptedError(err: unknown, method: string, what: string): BridgeError {
	return isNavigatedError(err) ? navigatedError(method, what) : detachedError(method, what);
}

/** A message with the stack trace a page-side Error carries cut off; the trace is returned apart. */
export function splitStack(text: string): { message: string; stack?: string } {
	const at = text.search(/\n\s+at\s/);
	if (at < 0) return { message: text.trim() };
	return { message: text.slice(0, at).trim(), stack: text.slice(at + 1) };
}

/**
 * [pattern, code] for failures whose text Tabkyra itself wrote (src/browser/page.ts, session.ts,
 * cdp.ts). Each pattern is anchored to the start of that text: several messages quote the page
 * after their first words (`Ref e7 is covered by div "<its name>"`), and a page must not pick the
 * code by how it names an element.
 */
const START = "^(?:Error: )?";
const WHO = "(?:Ref \\S+|That element)";
const KNOWN: Array<[RegExp, string]> = [
	[new RegExp(`${START}${WHO} (?:not found|now shows something else|isn't shown now)`), ERR.STALE_REF],
	[new RegExp(`${START}Element is no longer in the page`), ERR.STALE_REF],
	[
		new RegExp(`${START}(?:Selector not found|No option matches|No captured request|No dialog is open)`),
		ERR.NOT_FOUND,
	],
	[new RegExp(`${START}(?:Tab \\d+ is not owned by this session|No tab with id)`), ERR.NOT_FOUND],
	[new RegExp(`${START}${WHO} is (?:covered by|outside the visible page)`), ERR.NOT_ACTIONABLE],
	[new RegExp(`${START}Element is not a form control`), ERR.NOT_ACTIONABLE],
	[
		new RegExp(
			`${START}(?:Cannot run scripts on .*browser-internal pages are protected|Cannot control .*protected|The debugger was closed by the user on this tab)`,
		),
		ERR.PERMISSION_DENIED,
	],
	[new RegExp(`${START}Invalid regular expression`), ERR.BAD_PARAMS],
	[/^Navigation to .* failed:/, ERR.NAV_FAILED],
	[new RegExp(`${START}(?:Screenshot timed out after|.* did not finish within)`), ERR.TIMEOUT],
];

/**
 * The BridgeError for whatever a handler threw. A PageException (run_js code that threw) is
 * script_error; text Tabkyra wrote maps through KNOWN; anything else is `internal`.
 * The returned message never has a stack; `stack` is for the debug log.
 */
export function classify(err: unknown, method: string): { error: BridgeError; stack?: string } {
	if (err instanceof BridgeError) return { error: err };
	if (err instanceof ClipboardChordError) return { error: new BridgeError(ERR.BAD_PARAMS, err.message) };
	if (err instanceof NoTabError) return { error: new BridgeError(ERR.NO_TAB, err.message) };
	// The page's own exception: its text is the page's, so it never picks the code (not even "Target closed").
	if (err instanceof PageException) {
		const { message, stack } = splitStack(errText(err));
		return { error: new BridgeError(ERR.SCRIPT_ERROR, message), stack };
	}
	if (isDetachError(err))
		return { error: interruptedError(err, method, "the call lost the tab"), stack: errText(err) };
	const { message, stack } = splitStack(errText(err));
	const known = KNOWN.find(([re]) => re.test(message));
	const code = known ? known[1] : ERR.INTERNAL;
	// A page-side Error stringifies as "Error: text"; for a failure Tabkyra worded itself, the text is the message.
	return {
		error: new BridgeError(code, known ? message.replace(/^Error: /, "") : message),
		stack: stack ?? (code === ERR.INTERNAL && err instanceof Error ? err.stack : undefined),
	};
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
