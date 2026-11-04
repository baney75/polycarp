// Helpers the demo captures share: JS expressions that find side panel elements, and the few
// CDP calls that drive the side panel page over a raw DevTools WebSocket. A full CDP client
// (Playwright's connectOverCDP) would auto-attach to the agent's tabs and knock the
// extension's own chrome.debugger sessions off them, so only the one panel target is attached.
import { writeFileSync } from "node:fs";

/** A JS expression for the first visible button whose text is `label`. */
export function findButton(label) {
	return `[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)} && b.offsetParent)`;
}

/** A JS expression for the innermost visible element whose whole text is `label`. */
export function findText(label) {
	return `[...document.querySelectorAll("body *")].find((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(label)} && e.offsetParent)`;
}

/** A JS expression for the innermost visible element whose text contains `text`. */
export function findTextIn(text) {
	return `[...document.querySelectorAll("body *")].filter((e) => e.textContent.includes(${JSON.stringify(text)}) && e.offsetParent).at(-1)`;
}

/** A JS expression for the nearest ancestor of `element` (or itself) with a painted background. */
export function surface(element) {
	return `(() => { let e = ${element}; while (e && getComputedStyle(e).backgroundColor === "rgba(0, 0, 0, 0)") e = e.parentElement; return e; })()`;
}

const KEY_CODES = { Escape: 27, Enter: 13, Tab: 9 };

/** The few CDP calls the side panel needs, on one attached target and nothing else. */
export async function connectCdp(wsUrl) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	let next = 0;
	const waiting = new Map();
	const listeners = [];
	// A closed socket (Chromium crashed or exited) fails every call still waiting on it.
	let closed = false;
	ws.onclose = () => {
		closed = true;
		for (const { reject } of waiting.values()) reject(new Error("the DevTools connection closed"));
		waiting.clear();
	};
	ws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && waiting.has(msg.id)) {
			const { resolve, reject } = waiting.get(msg.id);
			waiting.delete(msg.id);
			if (msg.error) reject(new Error(`${msg.error.message}`));
			else resolve(msg.result);
		} else if (msg.method) for (const l of listeners) l(msg);
	};
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			if (closed) return reject(new Error("the DevTools connection closed"));
			const id = ++next;
			waiting.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	return {
		close: () => ws.close(),
		async page(url, { width, height }) {
			const { targetId } = await send("Target.createTarget", { url: "about:blank" });
			const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
			const errors = [];
			listeners.push((msg) => {
				if (msg.sessionId === sessionId && msg.method === "Runtime.exceptionThrown") {
					errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
				}
			});
			const s = (method, params) => send(method, params, sessionId);
			await s("Runtime.enable");
			await s("Page.enable");
			await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
			await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
			await s("Page.navigate", { url });
			const evaluate = async (expression) => {
				const r = await s("Runtime.evaluate", {
					expression,
					awaitPromise: true,
					returnByValue: true,
					userGesture: true,
				});
				if (r.exceptionDetails)
					throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
				return r.result.value;
			};
			const mouse = (type, x, y) => s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
			return {
				eval: evaluate,
				errors: () => errors,
				async shot(path) {
					const { data } = await s("Page.captureScreenshot", { format: "png" });
					writeFileSync(path, Buffer.from(data, "base64"));
				},
				/**
				 * Presses a key. Escape sends the same keyDown/keyUp pair capture-video.mjs always sent.
				 * Enter is a rawKeyDown, a char and a keyUp, so a keydown handler that sends the message
				 * sees it. Any other key throws rather than sending something else.
				 */
				async key(key) {
					const code = KEY_CODES[key];
					if (code === undefined) throw new Error(`panel.key: no key code for "${key}"; add it to KEY_CODES`);
					if (key === "Enter") {
						await s("Input.dispatchKeyEvent", {
							type: "rawKeyDown",
							key,
							code: key,
							windowsVirtualKeyCode: code,
						});
						await s("Input.dispatchKeyEvent", { type: "char", key, text: "\r", windowsVirtualKeyCode: code });
					} else {
						await s("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code });
					}
					await s("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
				},
				/** Types into the focused element the way an IME commit does (one input event). */
				async type(text) {
					await s("Input.insertText", { text });
				},
				/** Reloads the page and waits for its load event. */
				async reload() {
					const loaded = new Promise((resolve) => {
						listeners.push((msg) => {
							if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") resolve();
						});
					});
					await s("Page.reload", {});
					await loaded;
				},
				/** The element's box in the panel's CSS pixels. */
				async box(element) {
					const box = await evaluate(
						`(() => { const r = ${element}.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
					);
					if (!box || !(box.width > 0 && box.height > 0)) throw new Error(`no visible box for ${element}`);
					return box;
				},
				// A real mouse click at the element's center, so the page sees a user gesture.
				async click(element) {
					const box = await evaluate(
						`(() => { const e = ${element}; e.scrollIntoView({ block: "nearest", inline: "center" }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
					);
					const x = box.x + box.width / 2;
					const y = box.y + box.height / 2;
					await mouse("mouseMoved", x, y);
					await mouse("mousePressed", x, y);
					await mouse("mouseReleased", x, y);
					return box;
				},
			};
		},
	};
}
