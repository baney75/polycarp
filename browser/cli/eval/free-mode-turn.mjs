#!/usr/bin/env node
// One real side panel turn in Free mode, in a throwaway headless Chromium: the key goes into
// that browser's own storage (deleted with it), Free mode is picked from the model selector,
// and the agent does a small task on the fixture shop. Passes when the shop's own state shows
// the work was done and the composer names the free model that answered.
//
//   OPENROUTER_API_KEY=... node cli/eval/free-mode-turn.mjs [--ext dist-dir] [--shot out.png] [--out result.json]
//
// Free only: the key's usage is read before and after, and the run fails if it moved.
import { writeFileSync } from "node:fs";
import { cdp, EXTENSION_ID, launchFixtureBrowser, sleep, until } from "./fixture-browser.mjs";
import { startFixtureSite } from "./fixture-site.mjs";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : fallback;
};
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
	console.error("OPENROUTER_API_KEY is not set");
	process.exit(2);
}
const keyUsage = async () =>
	(await (await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${KEY}` } })).json()).data?.usage;

const usageBefore = await keyUsage();
const fixture = await startFixtureSite();
const fx = await launchFixtureBrowser({ extensionDir: arg("--ext") });
let result = { ok: false };
try {
	const target = await (await fetch(`http://${fx.devtools}/json/new?chrome-extension://${EXTENSION_ID}/sidepanel.html`, { method: "PUT" })).json();
	const ws = target.webSocketDebuggerUrl;
	const evaluate = async (expression) => {
		const r = await cdp(ws, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
		return r.result?.value;
	};
	await until(() => evaluate(`!!document.querySelector("message-editor textarea")`), 30000, "the side panel");
	// The key goes straight into this throwaway profile's storage; it is never printed.
	await evaluate(`new Promise((resolve, reject) => {
		const open = indexedDB.open("tabkyra-storage");
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const tx = open.result.transaction("provider-keys", "readwrite");
			tx.objectStore("provider-keys").put(${JSON.stringify(KEY)}, "openrouter");
			tx.oncomplete = () => resolve(true);
			tx.onerror = () => reject(tx.error);
		};
	})`);
	await cdp(ws, "Page.reload");
	await sleep(1500);
	await until(() => evaluate(`!!document.querySelector("message-editor textarea")`), 30000, "the side panel after reload");
	await sleep(1000);
	// A welcome dialog, if any, goes away first.
	await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
	await sleep(500);
	// The composer's model button: the one whose label span the editor renders (id or app label).
	const modelButton = `[...document.querySelectorAll("message-editor button")].find((b) => b.querySelector("svg") && b.querySelector("span.ml-1"))`;
	await evaluate(`${modelButton}.click(), true`);
	const pinned = await until(
		() => evaluate(`document.querySelector("agent-model-selector [data-model-item]")?.innerText ?? ""`),
		15000,
		"the model selector",
	);
	if (!pinned.includes("Free (best available)")) throw new Error(`the first selector entry is not Free mode: ${pinned}`);
	await evaluate(`document.querySelector("agent-model-selector [data-model-item]").click(), true`);
	await until(async () => (await evaluate(`${modelButton}?.innerText ?? ""`)).trim() === "Free", 10000, "the Free label");

	const prompt = `Open ${fixture.site}/shop and add one Blue Widget to the cart. Then open ${fixture.site}/cart and tell me the cart total.`;
	await evaluate(`(() => {
		const t = document.querySelector("message-editor textarea");
		t.value = ${JSON.stringify(prompt)};
		t.dispatchEvent(new Event("input", { bubbles: true }));
		t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return true;
	})()`);
	const t0 = Date.now();
	// Done when a reply has finished: the label names a model and the panel isn't streaming.
	await until(
		async () => {
			const label = (await evaluate(`${modelButton}?.innerText ?? ""`)).trim();
			const streaming = await evaluate(`!!document.querySelector("agent-interface")?.session?.state?.isStreaming`);
			return label.startsWith("Free ·") && !streaming && Date.now() - t0 > 3000;
		},
		8 * 60 * 1000,
		"the turn to finish",
	);
	await sleep(1500);
	const label = (await evaluate(`${modelButton}?.innerText ?? ""`)).trim();
	const messages = await evaluate(`(document.querySelector("agent-interface")?.session?.state?.messages ?? [])
		.filter((m) => m.role === "assistant")
		.map((m) => ({ model: m.model, responseModel: m.responseModel, stopReason: m.stopReason, error: m.errorMessage, cost: m.usage?.cost?.total ?? 0,
			text: m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 300),
			tools: m.content.filter((c) => c.type === "toolCall").map((c) => c.name) }))`);
	const last = messages.at(-1);
	const shot = arg("--shot");
	if (shot) {
		const { data } = await cdp(ws, "Page.captureScreenshot", { format: "png" });
		writeFileSync(shot, Buffer.from(data, "base64"));
	}
	const cartOk = fixture.state.cart.blue === 1 && Object.keys(fixture.state.cart).length === 1;
	const totalOk = /\$15(\.00)?\b/.test(last?.text ?? "");
	result = { ok: cartOk && totalOk && label.startsWith("Free · "), label, cart: fixture.state.cart, totalOk, seconds: Math.round((Date.now() - t0) / 1000), messages };
} catch (err) {
	result = { ok: false, error: err.message };
} finally {
	const usageAfter = await keyUsage();
	result.usage = { before: usageBefore, after: usageAfter, unchanged: usageBefore === usageAfter };
	if (!result.usage.unchanged) result.ok = false;
	fixture.close();
	await fx.close().catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
const out = arg("--out");
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
