/**
 * chrome.debugger helpers: one attachment per tab, kept for as long as the tab is
 * owned, with focus emulation so hidden tabs keep running requestAnimationFrame and
 * IntersectionObserver. Screenshots come from the compositor surface, which works
 * on tabs that are not visible; nothing here activates a tab.
 */

import { ConsoleBuffer, type ConsoleEntry, MAX_ENTRIES } from "./console-buffer.js";
import { ClipboardChordError, editingCommands, isClipboardChord, isMacBrowser } from "./key-commands.js";
import { bodyShape, maskJsonResponse, maskUrl } from "./mask-body.js";

const PROTOCOL_VERSION = "1.3";

/** Tabs where the user cancelled the debugger (closed the infobar). Cleared on navigation. */
const bannedTabs = new Set<number>();
const attachedTabs = new Set<number>();
let listenersInstalled = false;

export function isRestrictedUrl(url: string): boolean {
	return (
		url.startsWith("chrome://") ||
		url.startsWith("chrome-extension://") ||
		url.startsWith("brave://") ||
		url.startsWith("edge://") ||
		url.startsWith("arc://") ||
		url.startsWith("vivaldi://") ||
		url.startsWith("opera://") ||
		url.startsWith("about:") ||
		url.startsWith("devtools://") ||
		url.startsWith("https://chrome.google.com/webstore") ||
		url.startsWith("https://chromewebstore.google.com")
	);
}

// ---- JavaScript dialogs ---------------------------------------------------------
//
// alert(), confirm(), prompt() and beforeunload boxes freeze the page: every script and
// input call into it waits until someone answers. The bridge tracks open dialogs so a
// call that runs into one fails at once with the dialog's text, and `dialog` answers it.

export interface PageDialog {
	type: string;
	message: string;
	defaultPrompt?: string;
	url?: string;
}

const openDialogs = new Map<number, PageDialog>();
const dialogWatchers = new Set<(tabId: number, dialog: PageDialog) => void>();

/** The dialog open on a tab, if any. */
export function openDialog(tabId: number): PageDialog | undefined {
	return openDialogs.get(tabId);
}

/** Called whenever a dialog opens on any attached tab. Returns an unsubscribe function. */
export function watchDialogs(fn: (tabId: number, dialog: PageDialog) => void): () => void {
	dialogWatchers.add(fn);
	return () => dialogWatchers.delete(fn);
}

/** Answer the open dialog: OK (accept) or Cancel, with text for a prompt(). */
export async function answerDialog(tabId: number, accept: boolean, promptText?: string): Promise<PageDialog> {
	const dialog = openDialogs.get(tabId);
	if (!dialog) throw new Error("No dialog is open on this tab");
	await send(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) });
	openDialogs.delete(tabId);
	return dialog;
}

function installListeners(): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	chrome.tabs.onActivated.addListener(({ tabId }) => void releaseAgentViewport(tabId));
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		if (tabId === undefined) return;
		if (method === "Page.javascriptDialogOpening") {
			const p = (params ?? {}) as { type?: string; message?: string; defaultPrompt?: string; url?: string };
			const dialog: PageDialog = {
				type: p.type ?? "alert",
				message: p.message ?? "",
				defaultPrompt: p.defaultPrompt,
				url: p.url,
			};
			openDialogs.set(tabId, dialog);
			for (const fn of dialogWatchers) fn(tabId, dialog);
		} else if (method === "Page.javascriptDialogClosed") {
			openDialogs.delete(tabId);
		}
	});
	chrome.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId === undefined) return;
		noteCaptureStopped(source.tabId, describeDetach(reason));
		openDialogs.delete(source.tabId);
		attachedTabs.delete(source.tabId);
		viewportTabs.delete(source.tabId);
		if (reason === "canceled_by_user") bannedTabs.add(source.tabId);
	});
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (details.frameId === 0) bannedTabs.delete(details.tabId);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		openDialogs.delete(tabId);
		attachedTabs.delete(tabId);
		viewportTabs.delete(tabId);
		bannedTabs.delete(tabId);
	});
}

/**
 * The debugger was not attached when the command went out, so the command did not run. Chromium
 * says this after a detach nobody was told about (no onDetach), and every later call on the tab
 * keeps failing the same way until the worker restarts.
 */
export function isNotAttachedError(err: unknown): boolean {
	return /not attached to the tab|Debugger is not attached/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * The debugger detached, or the page's target was replaced, while a command was in flight: the
 * command may or may not have run.
 */
export function isDetachedInFlightError(err: unknown): boolean {
	return /Detached while handling command|Inspected target navigated or closed|Target closed|Session with given id not found/i.test(
		err instanceof Error ? err.message : String(err),
	);
}

/** The page navigated (or its target was replaced) under a command: the debugger itself may still be attached. */
export function isNavigatedError(err: unknown): boolean {
	return /Inspected target navigated or closed/i.test(err instanceof Error ? err.message : String(err));
}

/** Either kind of detach. */
export function isDetachError(err: unknown): boolean {
	return isNotAttachedError(err) || isDetachedInFlightError(err);
}

/** Forget what we believed about the tab's attachment, so the next ensureAttached sets it up again. */
function forgetAttachment(tabId: number): void {
	attachedTabs.delete(tabId);
	viewportTabs.delete(tabId);
	// Attaching again starts a new debugging session: its console and network domains are off.
	noteCaptureStopped(tabId, "the debugger had detached without notice and was attached again");
}

async function debuggerAttachedNow(tabId: number): Promise<boolean> {
	try {
		return (await chrome.debugger.getTargets()).some((t) => t.tabId === tabId && t.attached);
	} catch {
		return true;
	}
}

async function sendRaw<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
	return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

/**
 * Send a command. A command refused because the debugger is no longer attached never ran, so it
 * is safe to attach again and send it once more; a detach while the command was in flight is
 * thrown for the caller to judge (it may have run).
 */
async function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
	try {
		return await sendRaw<T>(tabId, method, params);
	} catch (err) {
		if (!isNotAttachedError(err)) throw err;
		forgetAttachment(tabId);
		await ensureAttached(tabId);
		return sendRaw<T>(tabId, method, params);
	}
}

/** Drop the attachment state and attach again (for a caller that saw a detach error). */
export async function reattach(tabId: number): Promise<void> {
	// The error may be a navigation under a command, with the debugger still attached and capture
	// running: only a debugger that is really gone ends capture.
	if (await debuggerAttachedNow(tabId)) {
		attachedTabs.delete(tabId);
		viewportTabs.delete(tabId);
	} else forgetAttachment(tabId);
	await ensureAttached(tabId);
}

/** Attach if needed. Idempotent; tolerates attachments made before a service worker restart. */
export async function ensureAttached(tabId: number): Promise<void> {
	installListeners();
	if (bannedTabs.has(tabId)) {
		throw new Error("The debugger was closed by the user on this tab. Navigate the tab to a new page to continue.");
	}
	if (!attachedTabs.has(tabId)) {
		const targets = await chrome.debugger.getTargets();
		const already = targets.some((t) => t.tabId === tabId && t.attached);
		if (!already) {
			try {
				await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!message.includes("already attached")) throw new Error(`Cannot attach to tab ${tabId}: ${message}`);
			}
		}
		attachedTabs.add(tabId);
		// Page events report alert/confirm/prompt dialogs (see openDialog above).
		await sendRaw(tabId, "Page.enable").catch(() => undefined);
		// Hidden tabs freeze rAF; focus emulation unfreezes it and makes the page report
		// itself visible, so lazy loading and infinite scroll keep working off-screen.
		await sendRaw(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
	}
	await ensureAgentViewport(tabId);
}

// ---- Agent viewport ------------------------------------------------------------
//
// Background agent tabs render at a fixed 1280x800 CSS viewport, whatever the size of
// the window they live in. Screenshots are then 1:1 with page coordinates, so what a
// model reads off a screenshot, from getBoundingClientRect(), or from a click result
// are the same numbers, and layouts do not change between machines and windows. The
// override is dropped as soon as the user looks at the tab (it would letterbox the page)
// and comes back the next time an agent acts on it while it is hidden.

export const AGENT_VIEWPORT = { width: 1280, height: 800 };
const viewportTabs = new Set<number>();

async function ensureAgentViewport(tabId: number): Promise<void> {
	if (viewportTabs.has(tabId)) return;
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	if (!tab || tab.active) return;
	try {
		await sendRaw(tabId, "Emulation.setDeviceMetricsOverride", {
			width: AGENT_VIEWPORT.width,
			height: AGENT_VIEWPORT.height,
			deviceScaleFactor: 0,
			mobile: false,
		});
		viewportTabs.add(tabId);
	} catch {
		/* not attachable right now; the next call retries */
	}
}

/** Give the tab its real size back (the user is about to see it, or the agent let go). */
export async function releaseAgentViewport(tabId: number): Promise<void> {
	if (!viewportTabs.delete(tabId)) return;
	await sendRaw(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => undefined);
}

/** Detach the debugger. A tab that is being screencast keeps it unless `force`:
 *  another client of the same session hanging up must not end a live view. */
export async function detachTab(tabId: number, force = false): Promise<void> {
	if (!force && screencasts.has(tabId)) return;
	if (force) await stopScreencast(tabId).catch(() => undefined);
	attachedTabs.delete(tabId);
	viewportTabs.delete(tabId);
	noteCaptureStopped(tabId, "Tabkyra released the debugger (the client disconnected or the session ended)");
	try {
		await chrome.debugger.detach({ tabId });
	} catch {
		/* not attached or tab gone */
	}
}

export async function cdpSend<T = unknown>(
	tabId: number,
	method: string,
	params?: Record<string, unknown>,
): Promise<T> {
	await ensureAttached(tabId);
	return send<T>(tabId, method, params);
}

export interface ScreenshotOptions {
	/**
	 * Resize so the width is at most this many pixels. Without it the image is at CSS-pixel
	 * scale (capped at 1280 wide), so image coordinates are click coordinates.
	 */
	maxWidth?: number;
	fullPage?: boolean;
	/** Clip to this rectangle (CSS pixels, page coordinates). */
	clip?: { x: number; y: number; width: number; height: number };
	format?: "png" | "jpeg";
	quality?: number;
	/** Give up after this long; a hidden tab under load can take minutes to paint. */
	timeoutMs?: number;
}

const SCREENSHOT_TIMEOUT_MS = 20000;

/**
 * CSS pixels per screenshot pixel of each tab's last viewport screenshot. Agents read
 * coordinates off screenshots, so point-taking tools convert through this instead of
 * asking the model to do the arithmetic.
 */
const screenshotScale = new Map<number, number>();

export function screenshotToCss(tabId: number, p: { x: number; y: number }): { x: number; y: number } {
	const f = screenshotScale.get(tabId) ?? 1;
	return { x: p.x * f, y: p.y * f };
}
/** Chrome caps a single capture surface; taller full-page shots are cut here. */
const MAX_CAPTURE_HEIGHT = 16384;

interface LayoutMetrics {
	cssContentSize: { width: number; height: number };
	cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
}

/**
 * Screenshot of a tab, active or not. Returns base64 without the data URL prefix.
 *
 * The capture is scaled inside the renderer (clip.scale) instead of grabbing the full
 * device-pixel surface and shrinking it here: a 2x retina PNG of a large viewport is
 * several MB and dominated the time on a loaded machine. JPEG is the default for the
 * same reason. The call is bounded so a tab that never paints fails fast with a message
 * the model can act on instead of wedging the tool for a minute.
 */
export async function captureScreenshot(
	tabId: number,
	options: ScreenshotOptions = {},
): Promise<{
	data: string;
	mimeType: string;
	width: number;
	height: number;
	/** Size of the captured area in CSS pixels (the units click/drag/hover take). */
	cssWidth: number;
	cssHeight: number;
}> {
	await ensureAttached(tabId);
	const format = options.format ?? "jpeg";
	let css = { width: 0, height: 0 };
	const timeoutMs = options.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
	const capture = async () => {
		const metrics = await send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
		const vv = metrics.cssVisualViewport;
		let rect: { x: number; y: number; width: number; height: number };
		if (options.clip) rect = options.clip;
		else if (options.fullPage)
			rect = {
				x: 0,
				y: 0,
				width: metrics.cssContentSize.width,
				height: Math.min(metrics.cssContentSize.height, MAX_CAPTURE_HEIGHT),
			};
		else rect = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
		css = { width: rect.width, height: rect.height };
		// clip.scale is relative to CSS pixels: the image is rect.width * scale wide on any DPR.
		const maxWidth = options.maxWidth ?? Math.min(rect.width, 1280);
		const scale = rect.width > maxWidth ? maxWidth / rect.width : 1;
		const params: Record<string, unknown> = {
			format,
			fromSurface: true,
			optimizeForSpeed: true,
			captureBeyondViewport: options.fullPage === true || options.clip !== undefined,
			clip: { ...rect, scale },
		};
		if (format === "jpeg") params.quality = options.quality ?? 75;
		return (await send<{ data: string }>(tabId, "Page.captureScreenshot", params)).data;
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`Screenshot timed out after ${Math.round(timeoutMs / 1000)} s: the browser did not paint this background tab. ` +
							"Read the page with read_page / get_page_text instead, or retry.",
					),
				),
			timeoutMs,
		);
	});
	try {
		const data = await Promise.race([capture(), timeout]);
		const mimeType = format === "png" ? "image/png" : "image/jpeg";
		const img = await resizeImage(data, mimeType, options.maxWidth ?? Math.min(css.width, 1280));
		if (!options.clip && !options.fullPage && img.width > 0) screenshotScale.set(tabId, css.width / img.width);
		return { ...img, cssWidth: Math.round(css.width), cssHeight: Math.round(css.height) };
	} finally {
		clearTimeout(timer);
	}
}

async function resizeImage(
	base64: string,
	mimeType: string,
	maxWidth?: number,
): Promise<{ data: string; mimeType: string; width: number; height: number }> {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
	const scale = maxWidth && bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
	if (scale === 1) return { data: base64, mimeType, width: bitmap.width, height: bitmap.height };
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to get canvas context");
	ctx.drawImage(bitmap, 0, 0, width, height);
	const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.85 });
	const buffer = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < buffer.length; i += 0x8000) {
		binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
	}
	return { data: btoa(binary), mimeType, width, height };
}

/**
 * An exception the page's own script threw (run_js code, not Tabkyra's). The bridge reports it as
 * script_error whatever its text says: a page cannot pick the error code by what it throws.
 */
export class PageException extends Error {}

/** Evaluate in the page's MAIN world and return the value (JSON-serialisable). */
export async function evaluateMain<T = unknown>(tabId: number, expression: string): Promise<T> {
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
}

export type MouseButton = "left" | "right" | "middle";

export async function click(
	tabId: number,
	x: number,
	y: number,
	options: {
		button?: MouseButton;
		clickCount?: number;
		modifiers?: number;
		/** Called just before the click's last mouse event is sent. */
		beforeLastEvent?: () => void;
	} = {},
): Promise<void> {
	const button = options.button ?? "left";
	const clickCount = options.clickCount ?? 1;
	const modifiers = options.modifiers ?? 0;
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
	for (let i = 1; i <= clickCount; i++) {
		await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
		if (i === clickCount) options.beforeLastEvent?.();
		await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
	}
}

export async function hover(tabId: number, x: number, y: number): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

export async function drag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
	await send(tabId, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: from.x,
		y: from.y,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});
	// Pointer-driven apps (canvas editors) read `buttons` on move to know the button is held.
	const steps = 12;
	for (let i = 1; i <= steps; i++) {
		const x = from.x + ((to.x - from.x) * i) / steps;
		const y = from.y + ((to.y - from.y) * i) / steps;
		await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
	}
	await send(tabId, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: to.x,
		y: to.y,
		button: "left",
		clickCount: 1,
	});
}

export async function scroll(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

/** Thrown when a call that hit a dialog would otherwise keep sending input after it closes. */
export class InputAbortedError extends Error {}

/**
 * Type text as key events (works in inputs, contenteditable, and for shortcuts).
 * `aborted` is checked before every key, so a call that failed on a dialog stops typing.
 */
export async function typeText(
	tabId: number,
	text: string,
	aborted: () => boolean = () => false,
	/** Called once, just before the first key event is sent: from then on the page may have the text. */
	beforeFirstKey: () => void = () => undefined,
): Promise<void> {
	await ensureAttached(tabId);
	let started = false;
	for (const char of text) {
		if (aborted()) throw new InputAbortedError("Stopped typing: a dialog interrupted this call");
		if (!started) {
			started = true;
			beforeFirstKey();
		}
		if (char === "\n") {
			await pressKey(tabId, "Enter");
			continue;
		}
		await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char });
		await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: char, key: char });
	}
}

interface KeyInfo {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
}

const KEY_MAP: Record<string, KeyInfo> = {
	Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", keyCode: 9 },
	Escape: { key: "Escape", code: "Escape", keyCode: 27 },
	Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	Delete: { key: "Delete", code: "Delete", keyCode: 46 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	Home: { key: "Home", code: "Home", keyCode: 36 },
	End: { key: "End", code: "End", keyCode: 35 },
	PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
	PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
	Space: { key: " ", code: "Space", keyCode: 32, text: " " },
	Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
	Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
	Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
	Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
	F1: { key: "F1", code: "F1", keyCode: 112 },
	F2: { key: "F2", code: "F2", keyCode: 113 },
	F3: { key: "F3", code: "F3", keyCode: 114 },
	F4: { key: "F4", code: "F4", keyCode: 115 },
	F5: { key: "F5", code: "F5", keyCode: 116 },
	F6: { key: "F6", code: "F6", keyCode: 117 },
	F7: { key: "F7", code: "F7", keyCode: 118 },
	F8: { key: "F8", code: "F8", keyCode: 119 },
	F9: { key: "F9", code: "F9", keyCode: 120 },
	F10: { key: "F10", code: "F10", keyCode: 121 },
	F11: { key: "F11", code: "F11", keyCode: 122 },
	F12: { key: "F12", code: "F12", keyCode: 123 },
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function keyInfo(name: string): KeyInfo {
	if (KEY_MAP[name]) return KEY_MAP[name];
	if (name.length === 1) {
		const upper = name.toUpperCase();
		const isLetter = /[A-Z]/.test(upper);
		const isDigit = /[0-9]/.test(name);
		return {
			key: name,
			code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "",
			keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
			text: name,
		};
	}
	return { key: name, code: name, keyCode: 0 };
}

/**
 * Press a key or chord such as "Enter", "Control+a", "Meta+Shift+p". Modifier names:
 * Control, Alt, Shift, Meta (also Cmd, Ctrl, Option as aliases).
 */
export async function pressKey(tabId: number, chord: string): Promise<void> {
	await ensureAttached(tabId);
	const parts = chord.split("+").map((p) => p.trim());
	// Modifier names in any case: "ctrl+V" must be the clipboard chord it is (refused below).
	const alias: Record<string, string> = {
		cmd: "Meta",
		command: "Meta",
		meta: "Meta",
		win: "Meta",
		ctrl: "Control",
		control: "Control",
		option: "Alt",
		alt: "Alt",
		shift: "Shift",
	};
	const mods = parts.slice(0, -1).map((m) => alias[m.toLowerCase()] ?? m);
	const main = parts[parts.length - 1];
	let modifiers = 0;
	// Before any key event, any platform: Blink runs Control+v and the like from a plain key event.
	if (isClipboardChord(mods, parts[parts.length - 1])) throw new ClipboardChordError(chord);
	for (const m of mods) modifiers |= MODIFIER_BITS[m] ?? 0;
	for (const m of mods) {
		const info = keyInfo(m);
		await send(tabId, "Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			...info,
			windowsVirtualKeyCode: info.keyCode,
			nativeVirtualKeyCode: info.keyCode,
			modifiers,
		});
	}
	const info = keyInfo(main);
	// Select-all, undo, redo and the word and line moves run only when the event names them.
	const commands = editingCommands(mods, main, isMacBrowser());
	const base = {
		key: info.key,
		code: info.code,
		windowsVirtualKeyCode: info.keyCode,
		nativeVirtualKeyCode: info.keyCode,
		modifiers,
	};
	await send(tabId, "Input.dispatchKeyEvent", {
		type: info.text && modifiers === 0 ? "keyDown" : "rawKeyDown",
		...base,
		...(info.text && modifiers === 0 ? { text: info.text } : {}),
		...(commands.length ? { commands } : {}),
	});
	await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
	for (const m of mods.reverse()) {
		const minfo = keyInfo(m);
		await send(tabId, "Input.dispatchKeyEvent", {
			type: "keyUp",
			...minfo,
			windowsVirtualKeyCode: minfo.keyCode,
			nativeVirtualKeyCode: minfo.keyCode,
		});
	}
}

// ---------------------------------------------------------------------------
// Console and network capture (per tab ring buffers, on demand)
// ---------------------------------------------------------------------------

export type { ConsoleEntry };

export interface NetworkEntry {
	requestId: string;
	method: string;
	url: string;
	status?: number;
	mimeType?: string;
	/** Document, XHR, Fetch, Script, Image, ... (CDP's resource type). */
	type?: string;
	/** The request's Content-Type, for masking its body by structure. */
	requestType?: string;
	/** The document that made the request: whose own scripts could read the response. */
	documentURL?: string;
	/** The response finished loading (a streaming or long-poll response may never). */
	finished?: boolean;
	timestamp: number;
	failed?: string;
}

const consoleBuffers = new Map<number, ConsoleBuffer>();
const networkBuffers = new Map<number, Map<string, NetworkEntry>>();
let captureListenerInstalled = false;

function installCaptureListener(): void {
	if (captureListenerInstalled) return;
	captureListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		if (tabId === undefined) return;
		const p = (params ?? {}) as Record<string, unknown>;
		if (method === "Inspector.detached") {
			noteCaptureStopped(tabId, `the page's inspector detached (${String(p.reason ?? "unknown reason")})`);
		} else if (method === "Inspector.targetCrashed") {
			noteCaptureStopped(tabId, "the page crashed");
		} else if (method === "Runtime.consoleAPICalled") {
			const buf = consoleBuffers.get(tabId);
			if (!buf) return;
			const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? [];
			const text = args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
			buf.add({
				level: String(p.type ?? "log"),
				text,
				timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
				contextId: typeof p.executionContextId === "number" ? p.executionContextId : undefined,
			});
		} else if (method === "Runtime.exceptionThrown") {
			const buf = consoleBuffers.get(tabId);
			if (!buf) return;
			const details = p.exceptionDetails as
				| { text?: string; exception?: { description?: string }; executionContextId?: number }
				| undefined;
			buf.add({
				level: "error",
				text: details?.exception?.description ?? details?.text ?? "Uncaught exception",
				timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
				contextId: details?.executionContextId,
			});
		} else if (method === "Network.requestWillBeSent") {
			const buf = networkBuffers.get(tabId);
			if (!buf) return;
			const request = p.request as { method: string; url: string };
			buf.set(String(p.requestId), {
				requestId: String(p.requestId),
				method: request.method,
				url: request.url,
				type: typeof p.type === "string" ? p.type : undefined,
				requestType: headerValue((p.request as { headers?: Record<string, string> }).headers, "content-type"),
				documentURL: typeof p.documentURL === "string" ? p.documentURL : undefined,
				timestamp: Date.now(),
			});
			if (buf.size > MAX_ENTRIES) buf.delete(buf.keys().next().value as string);
		} else if (method === "Network.responseReceived") {
			const entry = networkBuffers.get(tabId)?.get(String(p.requestId));
			if (!entry) return;
			const response = p.response as { status: number; mimeType: string; headers?: Record<string, string> };
			entry.status = response.status;
			entry.mimeType = response.mimeType;
		} else if (method === "Network.loadingFinished") {
			const entry = networkBuffers.get(tabId)?.get(String(p.requestId));
			if (entry) entry.finished = true;
		} else if (method === "Network.loadingFailed") {
			const entry = networkBuffers.get(tabId)?.get(String(p.requestId));
			if (entry) entry.failed = String(p.errorText ?? "failed");
		}
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		consoleBuffers.delete(tabId);
		networkBuffers.delete(tabId);
		pendingGaps.delete(tabId);
		void forgetCaptureMarker(tabId);
	});
}

/** Install the debugger listeners at worker start: an event that wakes a stopped worker is dropped without them. */
export function installCdpListeners(): void {
	installListeners();
	installCaptureListener();
}

// ---- When capture stops --------------------------------------------------------------
//
// Console and network capture lives in the debugging session of the tab: it ends when the
// debugger detaches (the user closed the infobar, DevTools took over, the page's target was
// replaced or crashed, Tabkyra released it), and it is lost when the worker restarts. None of
// that is an error for the next call, and the buffers still hold what came before, so a read
// would look live. Each ending is recorded here; the next read says so, attaches again and
// starts capturing again.

type CaptureKind = "console" | "network";

interface CaptureGap {
	/** When it stopped, in ms; 0 when only "after capture began" is known (a worker restart). */
	at: number;
	reason: string;
}

/** Endings not yet reported, by tab. They apply to both kinds; each kind reports them once. */
const pendingGaps = new Map<number, { console: CaptureGap[]; network: CaptureGap[] }>();

/** What a read says when capture had stopped: the gaps, when capture resumed and what that means. */
export interface CaptureReport {
	stopped: Array<{ at: string | null; reason: string }>;
	resumedAt: string;
	note: string;
}

function describeDetach(reason: string): string {
	switch (reason) {
		case "canceled_by_user":
			return "the debugger was cancelled (its infobar was closed or Cancel was pressed)";
		case "target_closed":
			return "the page's target was closed or replaced (the tab crashed, was discarded or moved to a new process)";
		case "replaced_with_devtools":
			return "DevTools was opened on the tab and took the debugger over";
		default:
			return `the browser detached the debugger (${reason})`;
	}
}

/** Record that capture on this tab ended just now, for each kind that was on. */
function noteCaptureStopped(tabId: number, reason: string): void {
	const gap: CaptureGap = { at: Date.now(), reason };
	const kinds: CaptureKind[] = [];
	if (consoleBuffers.has(tabId)) kinds.push("console");
	if (networkBuffers.has(tabId)) kinds.push("network");
	if (kinds.length === 0) return;
	const pending = pendingGaps.get(tabId) ?? { console: [], network: [] };
	for (const kind of kinds) {
		// One ending can announce itself twice (our own detach, then the browser's event): one gap.
		const list = pending[kind];
		if (list.length === 0 || gap.at - list[list.length - 1].at > 2000) list.push(gap);
	}
	pendingGaps.set(tabId, pending);
}

/** One session-storage key per tab and kind: concurrent starts on different tabs cannot overwrite each other. */
const markerKey = (tabId: number, kind: CaptureKind) => `capture_tab:${tabId}:${kind}`;

async function readCaptureMarker(tabId: number, kind: CaptureKind): Promise<number | undefined> {
	try {
		const key = markerKey(tabId, kind);
		const since = (await chrome.storage.session.get(key))[key];
		return typeof since === "number" ? since : undefined;
	} catch {
		return undefined;
	}
}

/** Survives a worker restart (the in-memory buffers do not), so a restart is not mistaken for a first call. */
async function writeCaptureMarker(tabId: number, kind: CaptureKind, since: number): Promise<void> {
	try {
		await chrome.storage.session.set({ [markerKey(tabId, kind)]: since });
	} catch {
		/* session storage unavailable: a restart goes unnoticed */
	}
}

async function forgetCaptureMarker(tabId: number): Promise<void> {
	try {
		await chrome.storage.session.remove([markerKey(tabId, "console"), markerKey(tabId, "network")]);
	} catch {
		/* nothing to forget */
	}
}

/**
 * Make sure console or network capture is running on the tab, and say what was lost if it had
 * stopped. The first call starts capture and returns nothing. Later, it returns a report when
 * capture ended since the last read of this kind (a detach, a crash, a worker restart); it has
 * attached again and turned capture back on by then, so what follows is live.
 */
export async function ensureCapture(tabId: number, kind: CaptureKind): Promise<CaptureReport | undefined> {
	installCdpListeners();
	const buffers = kind === "console" ? consoleBuffers : networkBuffers;
	const gaps: CaptureGap[] = [];
	const known = buffers.has(tabId);
	if (!known) {
		const since = await readCaptureMarker(tabId, kind);
		if (since !== undefined)
			gaps.push({
				at: 0,
				reason: `the extension's background worker restarted after capture began at ${new Date(since).toISOString()}; what the page logged since is missing`,
			});
		if (kind === "console") consoleBuffers.set(tabId, new ConsoleBuffer());
		else networkBuffers.set(tabId, new Map());
	} else {
		// A detach nobody announced: the debugger is gone but no event said so. It ended both kinds of
		// capture on the tab, so record it for both (the other kind's next read reports it too, even
		// though this read attaches again), and drop what we believed about the attachment so
		// ensureAttached below really attaches.
		if (
			(pendingGaps.get(tabId)?.[kind].length ?? 0) === 0 &&
			!(attachedTabs.has(tabId) && (await debuggerAttachedNow(tabId)))
		) {
			noteCaptureStopped(tabId, "the debugger was no longer attached and nothing said when it detached");
			attachedTabs.delete(tabId);
			viewportTabs.delete(tabId);
		}
		gaps.push(...(pendingGaps.get(tabId)?.[kind] ?? []));
	}
	const pendingForTab = pendingGaps.get(tabId);
	if (pendingForTab) pendingForTab[kind] = [];
	if (known && gaps.length === 0) return undefined;
	// Attach again if needed (this throws, saying why, when the user cancelled the debugger),
	// then turn the domain on in the fresh debugging session.
	try {
		await ensureAttached(tabId);
		await sendRaw(tabId, "Inspector.enable").catch(() => undefined);
		if (kind === "network") await send(tabId, "Network.enable");
		else {
			// Runtime.enable replays the page's console history. What is stamped before now is history;
			// after a gap (a detach, a worker restart) the entries it adds are marked replayed.
			consoleBuffers.get(tabId)?.startReplay(Date.now(), known || gaps.length > 0);
			// A debugging session can outlive what we knew (a worker restart, a navigation under a call):
			// Runtime still on there would not replay. Off and on makes the browser send its history.
			if (gaps.length > 0) await sendRaw(tabId, "Runtime.disable").catch(() => undefined);
			await send(tabId, "Runtime.enable");
		}
	} catch (err) {
		// Not capturing: keep what was reported, so the next read tries again and says it.
		if (!known) buffers.delete(tabId);
		else if (gaps.length) {
			const pending = pendingGaps.get(tabId) ?? { console: [], network: [] };
			pending[kind].unshift(...gaps);
			pendingGaps.set(tabId, pending);
		}
		throw err;
	}
	const resumed = Date.now();
	await writeCaptureMarker(tabId, kind, resumed);
	if (gaps.length === 0) return undefined;
	return {
		stopped: gaps.map((g) => ({ at: g.at ? new Date(g.at).toISOString() : null, reason: g.reason })),
		resumedAt: new Date(resumed).toISOString(),
		note: `${kind === "console" ? "Console" : "Network"} capture had stopped; it is on again from resumedAt. ${kind === "console" ? "The browser replays the page's console history when capture resumes, so messages logged meanwhile on the same page are there (marked replayed; the timestamp is when the page logged it); those from a page you have since left, or from before a crash, are missing." : "Requests made while it was off are missing."} Entries older than the gap are from before it stopped.`,
	};
}

/** Start buffering console output for a tab (no-op if already on). */
export async function enableConsoleCapture(tabId: number): Promise<CaptureReport | undefined> {
	return ensureCapture(tabId, "console");
}

export function readConsole(tabId: number, clear = false): ConsoleEntry[] {
	return consoleBuffers.get(tabId)?.read(clear, Date.now()) ?? [];
}

export async function enableNetworkCapture(tabId: number): Promise<CaptureReport | undefined> {
	return ensureCapture(tabId, "network");
}

/**
 * Capture for a tab Tabkyra just opened, started before its first page loads. Returns why it
 * could not start (both kinds are tried), or undefined.
 */
export async function startCapture(tabId: number): Promise<string | undefined> {
	const failures: string[] = [];
	for (const kind of ["console", "network"] as const) {
		try {
			await ensureCapture(tabId, kind);
		} catch (err) {
			failures.push(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return failures.length ? failures.join("; ") : undefined;
}

/** One captured request in full: its entry, the request body's shape and a JSON response, capped. */
export interface NetworkDetail extends NetworkEntry {
	/** Keys and value types of what was sent, never the values (mask-body.ts). */
	requestShape?: string;
	/** The complete response, masked, when it fits; otherwise responseShape. */
	responseBody?: string;
	/** Keys and value types of a JSON response too long to show whole. */
	responseShape?: string;
	/** Why there is no body: still loading, evicted, binary, ... */
	bodyNote?: string;
}

const MAX_RESPONSE_BODY = 20000;
const MAX_REQUEST_SHAPE = 4000;
/** Largest response read and masked; a bigger one isn't shown (a cut body isn't complete JSON). */
const BODY_CEILING = 2_000_000;
const JSON_TYPE = /^application\/(?:json|[\w.+-]*\+json)\b/i;

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v);
	return undefined;
}

function originOf(url: string | undefined): string | undefined {
	try {
		return url ? new URL(url).origin : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The page could read this response itself: the request went to the same origin as the tab's
 * page, from a document of that origin. A cross-origin response is out: even with
 * Access-Control-Allow-Origin a credentialed no-cors fetch stays opaque to the page, and the
 * capture can't tell the modes apart. Cross-origin API data is still one run_js fetch away,
 * where the browser enforces CORS itself.
 */
export function pageCouldRead(entry: Pick<NetworkEntry, "url" | "documentURL">, pageUrl: string | undefined): boolean {
	const page = originOf(pageUrl);
	if (!page) return false;
	return originOf(entry.url) === page && (entry.documentURL === undefined || originOf(entry.documentURL) === page);
}

function decodeBody(body: string, base64: boolean): string {
	if (!base64) return body;
	const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/**
 * One request in detail: what was sent, as its shape only, and the response when it is complete
 * JSON the page itself could read, credentials masked in place (src/browser/mask-body.ts).
 */
export async function readNetworkDetail(tabId: number, requestId: string): Promise<NetworkDetail> {
	const entry = networkBuffers.get(tabId)?.get(requestId);
	if (!entry)
		throw new Error(
			`No captured request ${requestId}. Call read_network for the current list (capture starts on the first call).`,
		);
	const detail: NetworkDetail = { ...entry, ...maskedUrls(entry) };
	const pageUrl = (await chrome.tabs.get(tabId)).url;
	if (!pageCouldRead(entry, pageUrl)) {
		detail.bodyNote =
			"Another origin's response: its body isn't shown. Fetch it with run_js (CORS applies, as for the page) or navigate to its URL.";
		return detail;
	}
	try {
		const post = await cdpSend<{ postData: string }>(tabId, "Network.getRequestPostData", { requestId });
		detail.requestShape = cap(bodyShape(post.postData.slice(0, BODY_CEILING), entry.requestType), MAX_REQUEST_SHAPE);
	} catch {
		/* no request body */
	}
	if (entry.failed) detail.bodyNote = `The request failed: ${entry.failed}`;
	else if (entry.status === undefined) detail.bodyNote = "No response yet; wait and call again.";
	else if (!entry.finished) detail.bodyNote = "Still loading (a streaming or large response); wait and call again.";
	else if (!entry.mimeType || !JSON_TYPE.test(entry.mimeType))
		detail.bodyNote = `Only JSON responses are shown; this one is ${entry.mimeType || "untyped"}. Read the page with get_page_text or get_page_html, or fetch it with run_js.`;
	else {
		try {
			const body = await cdpSend<{ body: string; base64Encoded: boolean }>(tabId, "Network.getResponseBody", {
				requestId,
			});
			const text = decodeBody(body.body, body.base64Encoded);
			const masked = text.length <= BODY_CEILING ? maskJsonResponse(text) : undefined;
			if (masked === undefined)
				detail.bodyNote =
					text.length > BODY_CEILING
						? `The response is ${Math.round(text.length / 1e6)} MB, over the 2 MB this reads; fetch it with run_js.`
						: "The response isn't complete JSON, so it isn't shown; fetch it with run_js.";
			else if (masked.length <= MAX_RESPONSE_BODY) detail.responseBody = masked;
			else {
				// A cut-off fragment isn't the complete JSON promised: the shape, and where the rest is.
				detail.responseShape = cap(bodyShape(masked, "application/json"), MAX_REQUEST_SHAPE);
				detail.bodyNote = `The JSON response is ${masked.length} characters, more than the ${MAX_RESPONSE_BODY} shown; its shape is below. Fetch the values you need with run_js.`;
			}
		} catch {
			detail.bodyNote =
				"The browser no longer has this response body (it keeps recent ones only). Reload and read again.";
		}
	}
	return detail;
}

/** Query strings and fragments can carry tokens (?token=..., #token=...): masked for every reader. */
function maskedUrls(entry: NetworkEntry): Pick<NetworkEntry, "url" | "documentURL"> {
	return { url: maskUrl(entry.url), documentURL: entry.documentURL && maskUrl(entry.documentURL) };
}

function cap(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… (cut at ${max} characters)` : text;
}

/** Whether read_network has turned capture on for this tab. */
export function networkCapturing(tabId: number): boolean {
	// Stopped and not yet reported is not capturing: what is buffered is from before.
	return networkBuffers.has(tabId) && (pendingGaps.get(tabId)?.network.length ?? 0) === 0;
}

export function readNetwork(tabId: number, clear = false): NetworkEntry[] {
	const buf = networkBuffers.get(tabId);
	if (!buf) return [];
	const out = [...buf.values()].map((e) => ({ ...e, ...maskedUrls(e) }));
	if (clear) buf.clear();
	return out;
}

// ---- Screencast --------------------------------------------------------------

export interface ScreencastOptions {
	format?: "jpeg" | "png";
	quality?: number;
	/** Device pixels; the frame is scaled down to fit inside both. */
	maxWidth?: number;
	maxHeight?: number;
	/** Upper bound on frames delivered per second; the ack is held back to meet it. */
	maxFps?: number;
	/** Main-world script run in every new document for as long as the cast lasts. */
	initScript?: string;
}

export interface ScreencastFrame {
	data: string;
	metadata: Record<string, unknown>;
}

interface Screencast {
	owner: string;
	sink: (frame: ScreencastFrame) => void;
	/** Told when the cast ends without being asked to (debugger detached, tab closed). */
	ended?: (reason: string) => void;
	minGapMs: number;
	lastAckAt: number;
	scriptId?: string;
}

/** Live casts by tab. A cast belongs to the client that started it; one per tab. */
const screencasts = new Map<number, Screencast>();
let screencastListenerInstalled = false;

function installScreencastListener(): void {
	if (screencastListenerInstalled) return;
	screencastListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (method !== "Page.screencastFrame" || source.tabId === undefined) return;
		const tabId = source.tabId;
		const cast = screencasts.get(tabId);
		const p = params as { data: string; metadata: Record<string, unknown>; sessionId: number };
		if (cast) cast.sink({ data: p.data, metadata: p.metadata });
		// Chrome sends the next frame only after this ack, so holding it is the frame-rate cap.
		const wait = cast ? Math.max(0, cast.lastAckAt + cast.minGapMs - Date.now()) : 0;
		setTimeout(() => {
			if (cast) cast.lastAckAt = Date.now();
			sendRaw(tabId, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
		}, wait);
	});
	chrome.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId === undefined) return;
		const cast = screencasts.get(source.tabId);
		screencasts.delete(source.tabId);
		cast?.ended?.(`debugger detached: ${reason}`);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		const cast = screencasts.get(tabId);
		screencasts.delete(tabId);
		cast?.ended?.("tab closed");
	});
}

/** Stream compositor frames of a tab, visible or not, to `sink` until stopped. */
export async function startScreencast(
	tabId: number,
	owner: string,
	options: ScreencastOptions,
	sink: (frame: ScreencastFrame) => void,
	ended?: (reason: string) => void,
): Promise<void> {
	installScreencastListener();
	await ensureAttached(tabId);
	if (screencasts.has(tabId)) await stopScreencast(tabId);
	const cast: Screencast = {
		owner,
		sink,
		ended,
		minGapMs: 1000 / Math.max(1, Math.min(60, options.maxFps ?? 30)),
		lastAckAt: 0,
	};
	screencasts.set(tabId, cast);
	await send(tabId, "Page.enable");
	if (options.initScript) {
		const { identifier } = await send<{ identifier: string }>(tabId, "Page.addScriptToEvaluateOnNewDocument", {
			source: options.initScript,
		});
		cast.scriptId = identifier;
		await send(tabId, "Runtime.evaluate", { expression: options.initScript }).catch(() => undefined);
	}
	const format = options.format ?? "jpeg";
	await send(tabId, "Page.startScreencast", {
		format,
		...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
		...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
		...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
		everyNthFrame: 1,
	});
}

export async function stopScreencast(tabId: number): Promise<boolean> {
	const cast = screencasts.get(tabId);
	if (!cast) return false;
	screencasts.delete(tabId);
	await sendRaw(tabId, "Page.stopScreencast").catch(() => undefined);
	if (cast.scriptId)
		await sendRaw(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: cast.scriptId }).catch(
			() => undefined,
		);
	return true;
}

/** Stop every cast a client started; its frames would have nowhere to go. */
export async function stopScreencastsOwnedBy(owner: string | undefined): Promise<void> {
	for (const [tabId, cast] of [...screencasts]) {
		if (owner === undefined || cast.owner === owner) await stopScreencast(tabId);
	}
}
