// Expected failures get their own code and no stack trace; `internal` is for real bugs.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { classify, splitStack, BridgeError } = await import("../src/bridge/errors.ts");
const { NoTabError } = await import("../src/browser/session.ts");
const { PageException } = await import("../src/browser/cdp.ts");
const { ClipboardChordError } = await import("../src/browser/key-commands.ts");

const STACK = "\n    at resolveRef (<anonymous>:12:32)\n    at <anonymous>:16:3";

test("splitStack cuts a page-side stack off the message and keeps it apart", () => {
	const { message, stack } = splitStack(`Error: Ref e1 not found: the page changed.${STACK}`);
	assert.equal(message, "Error: Ref e1 not found: the page changed.");
	assert.match(stack, /resolveRef/);
	assert.deepEqual(splitStack("plain"), { message: "plain" });
});

test("classify gives each expected failure its code, with no stack in the message", () => {
	const cases = [
		[`Error: Ref e7 not found: the page changed. Call read_page for fresh refs.${STACK}`, "stale_ref"],
		["Ref e7 now shows something else: the page reused it. Call read_page for fresh refs.", "stale_ref"],
		["Ref e7 isn't shown now (hidden or closed). Call read_page for fresh refs.", "stale_ref"],
		[`Error: Selector not found: #x. read_page or find gives refs.${STACK}`, "not_found"],
		["Tab 5 is not owned by this session", "not_found"],
		["Ref e7 is covered by div \"Cookie settings\". Close or dismiss it, then call read_page.", "not_actionable"],
		["Invalid regular expression: /(/i: Unterminated group", "bad_params"],
		["Navigation to https://x.invalid/ failed: net::ERR_NAME_NOT_RESOLVED", "navigation_failed"],
		["Cannot run scripts on chrome://x: browser-internal pages are protected.", "permission_denied"],
		["Screenshot timed out after 20 s: the browser did not paint this background tab.", "timeout"],
	];
	for (const [text, code] of cases) {
		const { error } = classify(new Error(text), "click");
		assert.equal(error.code, code, text);
		assert.doesNotMatch(error.message, /\n\s+at /);
		assert.doesNotMatch(error.message, /^Error: /);
	}
});

test("a page script's exception is script_error whatever its text says; only Tabkyra's own text maps to other codes", () => {
	const { error, stack } = classify(new PageException(`Error: boom${STACK}`), "evaluate");
	assert.equal(error.code, "script_error");
	assert.equal(error.message, "Error: boom");
	assert.match(stack, /resolveRef/);
	// Page text that looks like one of Tabkyra's messages does not choose the code.
	for (const text of [
		"SyntaxError: Invalid regular expression: /(/: Unterminated group",
		"Error: Selector not found: x",
		"Error: Waited 5 s, timed out after 5 s",
		"Error: Ref e1 is covered by div",
		"Error: Target closed",
		"Error: Detached while handling command.",
	]) {
		const got = classify(new PageException(text), "evaluate").error;
		assert.equal(got.code, "script_error", text);
		assert.equal(got.message, text, "the page's text is kept as it is");
	}
	// An error that is not the page's and that Tabkyra did not word is a bug.
	assert.equal(classify(new Error("something broke"), "evaluate").error.code, "internal");
});

test("typed errors keep their code; a lost debugger is interrupted, never the raw message", () => {
	const own = new BridgeError("dialog_open", "A confirm dialog is open");
	assert.equal(classify(own, "click").error, own);
	assert.equal(classify(new NoTabError(), "click").error.code, "no_tab");
	for (const raw of ["Detached while handling command.", "Debugger is not attached to the tab with id: 4."]) {
		const { error } = classify(new Error(raw), "click");
		assert.equal(error.code, "interrupted");
		assert.match(error.message, /Check the page with read_page before you repeat it/);
		assert.doesNotMatch(error.message, /Detached while handling|not attached to the tab/);
	}
});

test("an error from a navigation under the call is worded as the page navigating, not the debugger detaching", () => {
	const { error } = classify(new Error("Inspected target navigated or closed"), "type");
	assert.equal(error.code, "interrupted");
	assert.match(error.message, /^The page navigated while type was running/);
	assert.match(error.message, /Check the page with read_page before you repeat it/);
	assert.doesNotMatch(error.message, /debugger detached/);
	// Marked as the extension's own answer, so the client does not rewrite it as a dropped connection.
	assert.equal(error.toRpc().source, "extension");
});

test("a clipboard chord is bad_params with the use-fill-or-type text", () => {
	const { error } = classify(new ClipboardChordError("Control+v"), "press");
	assert.equal(error.code, "bad_params");
	assert.match(error.message, /clipboard chords are not supported; use fill or type/);
});

test("page text quoted inside a Tabkyra message does not choose its code", () => {
	// A cover (or any element) named like another failure's message.
	for (const name of ["Item no longer in the page", "Selector not found: x", "Invalid regular expression", "Screenshot timed out after 3 s"]) {
		const { error } = classify(new Error(`Ref e7 is covered by div "${name}", which would take the click. Close or dismiss it, then call read_page.`), "click");
		assert.equal(error.code, "not_actionable", name);
		assert.match(error.message, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.equal(classify(new Error('Error: Ref e7 is covered by div "Ref e1 not found"'), "click").error.code, "not_actionable");
	assert.equal(classify(new Error("That element isn't shown now (hidden or closed). Call read_page for fresh refs."), "click").error.code, "stale_ref");
	assert.equal(classify(new Error("Element is no longer in the page. Call read_page for fresh refs."), "click").error.code, "stale_ref");
});
