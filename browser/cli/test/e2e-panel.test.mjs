// The side panel in a real Chromium: what the unit tests can't see. The built extension
// (dist-chrome) is loaded in a throwaway profile with the network blocked, sidepanel.html is
// opened as a tab at the panel's 400 px width, and Settings > Connect and Appearance are checked
// as drawn: no command box clipped, the selected tab chip visible against the page, the color box
// showing the accent in use. A stand-in answers the Connect relay (no native host here).
//
// Needs the extension built into dist-chrome without a version bump:
//   TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=$PWD/dist-chrome npm run build   (repo root)
// and a Playwright Chromium (`npx playwright-core install chromium`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadTs } from "./helpers/bundle-ts.mjs";
import { ethicsPdf, FAR_LINE, FRIENDSHIP_PAGES, makePdf } from "./helpers/pdf.mjs";
import { lastToolResult, seedStubScript, stubModelServer } from "./helpers/stub-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..", "dist-chrome");
const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";
const PANEL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;

const { isSidePanelPort } = await loadTs(`export { isSidePanelPort } from "@src/../../src/connect/gate.ts";`);
const { PRESETS, contrast } = await loadTs(`export { PRESETS, contrast } from "@src/../../src/appearance/palettes.ts";`);

let profile;
let context;

before(async () => {
	assert.ok(existsSync(join(extensionDir, "sidepanel.html")), `build the extension into ${extensionDir} first (see the top of this file)`);
	profile = mkdtempSync(join(tmpdir(), "tabkyra-e2e-panel-"));
	context = await chromium.launchPersistentContext(profile, {
		channel: "chromium",
		headless: true,
		viewport: { width: 400, height: 860 },
		args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--use-mock-keychain", "--password-store=basic", "--remote-debugging-port=0"],
	});
	await context.route(/^https?:\/\//, (r) => r.abort());
	// A stand-in for the native host behind the Connect relay: no route, so Connect shows its setup commands.
	await context.addInitScript(() => {
		if (!globalThis.chrome?.runtime?.connect) return;
		const original = chrome.runtime.connect.bind(chrome.runtime);
		// The unstubbed connect, for the test that drives the real relay from a tab.
		globalThis.__realConnect = original;
		let joined = false;
		chrome.runtime.connect = (info) => {
			if (info?.name !== "tabkyra-connect") return original(info);
			const listeners = [];
			return {
				name: info.name,
				onMessage: { addListener: (l) => listeners.push(l) },
				onDisconnect: { addListener: () => {} },
				disconnect() {},
				postMessage(req) {
					setTimeout(() => {
						const reply = (r) => listeners.forEach((l) => l({ id: req.id, ...r }));
						if (req.method === "status") {
							if (joined) return reply({ result: { route: "link", passcodeSet: false, theme: { preset: "tabkyra" }, link: { hubUrl: "https://hub.example.com", name: "laptop", online: false, busy: false, manage: true } } });
							return reply({ result: { route: "none", passcodeSet: false, theme: { preset: "tabkyra" }, joinScopes: [{ id: "browser.read", what: "See the agent's own tabs and read pages" }, { id: "browser.act", what: "Click and type: can submit forms and act under the user's sign-in" }] } });
						}
						if (req.method === "joinHub") {
							joined = true;
							return reply({ error: { code: "linked_no_service", message: "Linked as laptop, but the background service didn't start; run polycarp browser link status." } });
						}
						if (req.method === "setTheme") return reply({ result: { preset: req.params.preset } });
						reply({ error: { code: "bad_params", message: "not stubbed" } });
					}, 30);
				},
			};
		};
	});
});

after(async () => {
	await context?.close();
	// Best effort, as in e2e-bridge: Chromium helpers may still be writing to the profile.
	try {
		if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (err) {
		console.error(`left ${profile}: ${err.message}`);
	}
});

/**
 * What a person does on the panel's home screen: wait for the composer ("Ask about this page, or type / for skills"),
 * close the one-time welcome sheet if it is up (it shows once per profile, so only the first page sees it), and press
 * Settings in the header.
 */
async function openSettings(page) {
	await page.getByPlaceholder(/Ask about this page/).waitFor({ timeout: 20_000 });
	const welcome = page.locator("welcome-setup-dialog");
	if (await welcome.waitFor({ timeout: 1000 }).then(() => true, () => false)) {
		await welcome.getByRole("button", { name: "Close", exact: true }).click();
		await welcome.waitFor({ state: "detached" });
	}
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.waitForSelector("tabkyra-settings", { state: "attached" });
}

/** The panel at `width`, in `theme`, with Settings open on `tab`. */
async function settings(tab, theme = "light", width = 400) {
	const page = await context.newPage();
	await page.setViewportSize({ width, height: 860 });
	await page.goto(PANEL);
	await page.evaluate((t) => localStorage.setItem("theme", t), theme);
	await page.evaluate(() => chrome.storage.local.remove("tabkyra.appearance"));
	// The welcome sheet shows once per profile; a page that has seen it must not race it on a reload.
	await page.evaluate(() => chrome.storage.local.set({ "tk-welcome-seen": true }));
	await page.reload();
	await openSettings(page);
	await page.getByRole("tab", { name: tab, exact: true }).click();
	await page.waitForTimeout(600);
	return page;
}

// The selected Settings tab used to be a solid chip held to 3:1 against the page. The redesigned tab is the accent at 25%
// over the page (SettingsPage.ts), which measures 1.4:1 to 1.9:1 across the presets. This floor is the lowest measured
// value, so the tint can get no fainter; raising the tint to 3:1 is a design decision, tracked in the PR that added this.
const CHIP_ON_PAGE_FLOOR = 1.3;

const rgb = (css) => {
	const [r, g, b] = css.match(/\d+(\.\d+)?/g).map(Number);
	return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
};

for (const [width, height] of [[400, 860], [760, 850], [400, 1200], [320, 620]]) {
	test(`the welcome sits midway between the header and the composer at ${width} x ${height}`, async () => {
		const page = await context.newPage();
		try {
			await page.setViewportSize({ width, height });
			await page.goto(PANEL);
			await page.evaluate(() => chrome.storage.local.set({ "tk-welcome-seen": true }));
			await page.reload();
			await page.waitForSelector(".welcome-container .tutorial-pill");
			await page.waitForTimeout(1000); // The entrance animation moves the block.
			const m = await page.evaluate(() => {
				const box = document.querySelector(".welcome-container");
				const scroller = box.closest(".overflow-y-auto");
				const top = scroller.getBoundingClientRect().top;
				return {
					above: box.firstElementChild.getBoundingClientRect().top - top,
					below: document.querySelector("message-editor").getBoundingClientRect().top - box.lastElementChild.getBoundingClientRect().bottom,
					natural: box.lastElementChild.getBoundingClientRect().bottom - box.firstElementChild.getBoundingClientRect().top,
					view: scroller.clientHeight,
				};
			});
			assert.ok(m.above >= 0, `the block is cut off at the top: ${JSON.stringify(m)}`);
			if (m.natural + 32 > m.view) return; // Too short a window to center: it scrolls from the top.
			assert.ok(Math.abs(m.above - m.below) <= 32, `off center: ${JSON.stringify(m)}`);
		} finally {
			await page.close();
		}
	});
}

for (const width of [400, 320]) {
	test(`Connect's command boxes show the whole command at ${width} px, and nothing runs past the panel`, async () => {
		const page = await settings("Agents", "light", width);
		try {
			// The terminal commands sit under "Other ways"; open it so the boxes are drawn.
			await page.evaluate(() => document.querySelectorAll("details[data-other-ways]").forEach((d) => (d.open = true)));
			const boxes = await page.evaluate(() =>
				[...document.querySelectorAll("tabkyra-settings code")].map((c) => {
					const r = c.getBoundingClientRect();
					const style = getComputedStyle(c);
					// Where the text ends against where the box's padding begins: text that reaches into the
					// padding touches the border, which reads as cut off.
					const range = document.createRange();
					range.selectNodeContents(c);
					const textRight = Math.max(...[...range.getClientRects()].map((t) => t.right));
					const contentRight = r.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight);
					return { text: c.textContent.trim(), clipped: c.scrollWidth > c.clientWidth + 1 || textRight > contentRight + 0.5, right: r.right, width: window.innerWidth };
				}),
			);
			const commands = boxes.map((b) => b.text);
			assert.ok(commands.includes("polycarp browser remote setup"), JSON.stringify(commands));
			assert.ok(commands.includes("polycarp browser hub setup --public-url https://ADDRESS"), JSON.stringify(commands));
			for (const box of boxes) {
				assert.equal(box.clipped, false, `${box.text} is cut off`);
				assert.ok(box.right <= box.width, `${box.text} runs ${box.right - box.width}px past the panel`);
			}
			// Nothing in Settings makes the page scroll sideways.
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
		} finally {
			await page.close();
		}
	});
}

for (const theme of ["light", "dark"]) {
	test(`the selected Settings tab is a visible tint with readable text in every preset (${theme})`, async () => {
		const page = await settings("Appearance", theme);
		try {
			for (const preset of Object.keys(PRESETS)) {
				await page.locator(`[data-preset=${preset}]`).click();
				await page.waitForTimeout(450);
				// The chip is the accent at 25% over the page, so it is composited over the page color the way the
				// browser paints it (a canvas does the blending) before it is compared with the page.
				const { chip, text, page: bg } = await page.evaluate(() => {
					const selected = document.querySelector('tabkyra-settings [role="tab"][aria-selected="true"]');
					const style = getComputedStyle(selected);
					const pageColor = getComputedStyle(document.querySelector("tabkyra-settings > div")).backgroundColor;
					const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
					const paint = (...layers) => {
						ctx.clearRect(0, 0, 1, 1);
						for (const layer of layers) {
							ctx.fillStyle = layer;
							ctx.fillRect(0, 0, 1, 1);
						}
						const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
						return `rgb(${r}, ${g}, ${b})`;
					};
					return { chip: paint(pageColor, style.backgroundColor), text: paint(pageColor, style.backgroundColor, style.color), page: paint(pageColor) };
				});
				const ratio = contrast(rgb(chip), rgb(bg));
				assert.ok(ratio >= CHIP_ON_PAGE_FLOOR, `${preset} ${theme}: chip ${rgb(chip)} on page ${rgb(bg)} is ${ratio.toFixed(2)}:1`);
				assert.ok(contrast(rgb(text), rgb(chip)) >= 4.5, `${preset} ${theme}: chip text ${rgb(text)} on ${rgb(chip)}`);
			}
		} finally {
			await page.close();
		}
	});
}

test("the Appearance color box and hex box show the accent in use, never black, and the hint is a hint", async () => {
	const page = await settings("Appearance", "light");
	try {
		const colorBox = page.locator("tabkyra-appearance-tab input[type=color]");
		const hexBox = page.locator("#tk-accent-text");
		for (const preset of Object.keys(PRESETS)) {
			await page.locator(`[data-preset=${preset}]`).click();
			await page.waitForTimeout(350);
			const own = PRESETS[preset].light.accent;
			assert.equal(await colorBox.inputValue(), own, `${preset}: the color box`);
			assert.equal(await hexBox.inputValue(), own, `${preset}: the hex box`);
		}
		// A custom accent shows in both; clearing the box returns to the preset's own.
		await hexBox.fill("#d6336c");
		await hexBox.blur();
		await page.waitForTimeout(350);
		assert.equal(await colorBox.inputValue(), "#d6336c");
		await hexBox.fill("");
		await hexBox.blur();
		await page.waitForTimeout(350);
		assert.equal(await hexBox.inputValue(), PRESETS.midnight.light.accent);
		assert.equal(await hexBox.getAttribute("placeholder"), "e.g. #3b82f6");
		// A bad value is refused where it is typed.
		await hexBox.fill("nope");
		await hexBox.blur();
		assert.match(await page.locator("#tk-accent-help").innerText(), /Use a color like #3b82f6/);
	} finally {
		await page.close();
	}
});

for (const width of [400, 320]) {
	test(`every Settings tab name is whole at ${width} px`, async () => {
		const page = await settings("Agents", "light", width);
		try {
			const tabs = await page.evaluate(() =>
				[...document.querySelectorAll('tabkyra-settings [role="tab"]')].map((t) => ({ name: t.textContent.trim(), cut: t.scrollWidth > t.clientWidth + 1 })),
			);
			assert.deepEqual(tabs.map((t) => t.name), ["Providers", "Agents", "Skills", "Sites", "Privacy", "Appearance", "About"]);
			assert.deepEqual(tabs.filter((t) => t.cut), []);
		} finally {
			await page.close();
		}
	});
}

test("Join hub asks for a Confirm that names the host and the scopes; after joining, the outcome stays up although the form is gone", async () => {
	const page = await settings("Agents");
	try {
		await page.getByPlaceholder("https://hub.example.com").fill("https://hub.example.com/mcp");
		await page.getByPlaceholder("TK-XXXX-XXXX").fill("TK-ABCD-EFGH");
		await page.getByRole("button", { name: "Join hub" }).click();
		const confirm = page.locator("[data-join-confirm]");
		await confirm.waitFor();
		const text = await confirm.innerText();
		assert.match(text, /Join hub\.example\.com\?/);
		assert.match(text, /The hub's owner will be able to open sites, read pages, and click and type in this browser as you\./);
		assert.match(text, /See the agent's own tabs and read pages/);
		assert.match(text, /Click and type: can submit forms and act under the user's sign-in/);
		// Cancel sends nothing and brings the button back.
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await page.getByRole("button", { name: "Join hub" }).waitFor();
		await page.getByRole("button", { name: "Join hub" }).click();
		await confirm.getByRole("button", { name: "Confirm" }).click();
		// The route is now "link", so the form is gone; the message is not.
		const message = page.locator("[data-join-message]");
		await message.waitFor({ timeout: 10_000 });
		assert.match(await message.innerText(), /Linked as laptop, but the background service didn't start; run polycarp browser link status\./);
		assert.equal(await page.getByRole("button", { name: "Join hub" }).count(), 0);
		assert.equal(await page.locator("tabkyra-connect-tab").getByText("Get a code to see the connector URL.").count(), 1);
	} finally {
		await page.close();
	}
});

test("with no helper the community switch shows off, a refused change snaps back and says why, and Privacy has no proxy control", async () => {
	const page = await settings("Skills");
	try {
		const toggle = page.getByRole("switch", { name: "Receive community skills" });
		assert.equal(await toggle.isChecked(), false);
		await toggle.click();
		await page.getByText(/native host isn't connected/).waitFor({ timeout: 5000 });
		assert.equal(await toggle.isChecked(), false, "the switch reverted");
		await page.getByRole("tab", { name: "Privacy", exact: true }).click();
		await page.waitForTimeout(300);
		assert.equal(await page.getByText("CORS proxy", { exact: true }).count(), 0);
	} finally {
		await page.close();
	}
});

test("the real Connect relay closes a port from the panel opened as a tab", async () => {
	const page = await context.newPage();
	try {
		await page.goto(PANEL);
		const outcome = await page.evaluate(
			() =>
				new Promise((resolve) => {
					const port = globalThis.__realConnect({ name: "tabkyra-connect" });
					port.onDisconnect.addListener(() => resolve("disconnected"));
					port.onMessage.addListener((m) => resolve(`answered ${JSON.stringify(m)}`));
					setTimeout(() => port.postMessage({ id: 1, method: "approvalCode" }), 100);
					setTimeout(() => resolve("still open"), 4000);
				}),
		);
		assert.equal(outcome, "disconnected");
	} finally {
		await page.close();
	}
});

test("a real side panel (no tab) is served by the real Connect relay, not disconnected", async () => {
	// Chromium opens a genuine side panel even headless: a second sidepanel.html document that chrome.tabs.getCurrent() cannot place in a tab.
	const worker = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`)) ?? (await context.waitForEvent("serviceworker"));
	// Record every port's sender as Chrome built it, next to the relay's own listener.
	await worker.evaluate(() => {
		globalThis.__senders = [];
		chrome.runtime.onConnect.addListener((port) => {
			if (port.name === "tabkyra-connect") globalThis.__senders.push(JSON.parse(JSON.stringify(port.sender ?? null)));
		});
	});
	const page = await context.newPage();
	try {
		await page.goto(PANEL);
		// Let the app finish drawing, or it replaces the page body under the button.
		await page.getByPlaceholder(/Ask about this page/).waitFor({ timeout: 20_000 });
		await page.waitForTimeout(1500);
		await page.evaluate(() => {
			const b = document.createElement("button");
			b.id = "open-real-panel";
			b.style.cssText = "position:fixed;top:0;left:0;width:100px;height:50px;z-index:99999";
			b.addEventListener("click", async () => {
				try {
					const w = await chrome.windows.getCurrent();
					// One panel per window: background.ts enables sidepanel.html globally, so it opens for the window.
					await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
					await chrome.sidePanel.open({ windowId: w.id });
					globalThis.__opened = "ok";
				} catch (e) {
					globalThis.__opened = `error: ${e.message}`;
				}
			});
			document.body.append(b);
		});
		// A real click is the user gesture sidePanel.open needs.
		await page.click("#open-real-panel");
		await page.waitForFunction(() => globalThis.__opened !== undefined);
		assert.equal(await page.evaluate(() => globalThis.__opened), "ok");
		const tabTarget = (await (await context.newCDPSession(page)).send("Target.getTargetInfo")).targetInfo.targetId;
		const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
		let panel;
		for (let i = 0; i < 50 && !panel; i++) {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			panel = list.find((t) => t.type === "page" && t.url === PANEL && t.id !== tabTarget);
			if (!panel) await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(panel, "Chromium did not open a side panel document");
		const ws = new WebSocket(panel.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = reject;
		});
		let seq = 0;
		const evaluate = (expression) =>
			new Promise((resolve) => {
				const id = ++seq;
				ws.addEventListener("message", function onMessage(e) {
					const m = JSON.parse(e.data);
					if (m.id !== id) return;
					ws.removeEventListener("message", onMessage);
					resolve(m.result?.result?.value ?? m.result);
				});
				ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
			});
		try {
			assert.equal(await evaluate("chrome.tabs.getCurrent().then((t) => String(t))"), "undefined", "the panel document is hosted in a tab");
			// The real relay, from the real side panel: no host runs here, so the answer is a no_host error, not a disconnect.
			const outcome = await evaluate(`new Promise((resolve) => {
				const port = chrome.runtime.connect({ name: "tabkyra-connect" });
				port.onDisconnect.addListener(() => resolve("disconnected"));
				port.onMessage.addListener((m) => resolve("answered " + JSON.stringify(m)));
				setTimeout(() => port.postMessage({ id: 1, method: "status" }), 100);
				setTimeout(() => resolve("still open"), 5000);
			})`);
			assert.match(outcome, /^answered /, outcome);
			assert.equal(JSON.parse(outcome.slice("answered ".length)).error.code, "no_host");
		} finally {
			ws.close();
		}
		// What Chrome reported for that port: the shape isSidePanelPort has to accept.
		const senders = await worker.evaluate(() => globalThis.__senders);
		console.log("real side panel port.sender:", JSON.stringify(senders));
		const fromPanel = senders.find((x) => x.tab === undefined);
		assert.ok(fromPanel, `no tab-less sender among ${JSON.stringify(senders)}`);
		assert.equal(fromPanel.url, PANEL);
		assert.equal(isSidePanelPort(fromPanel, `chrome-extension://${EXTENSION_ID}/`), true, JSON.stringify(fromPanel));
		assert.equal(isSidePanelPort({ ...fromPanel, tab: { id: 1 } }, `chrome-extension://${EXTENSION_ID}/`), false);
	} finally {
		await page.close();
	}
});

/** Open the panel on `model` (a stub provider with a key), and send it `message`. */
async function askPanel(page, model, message, { fresh = false } = {}) {
	await page.goto(PANEL);
	await page.getByPlaceholder(/Ask about this page/).waitFor({ timeout: 20_000 });
	await page.evaluate(async (m) => {
		await chrome.storage.local.set({ "tk-welcome-seen": true });
		const db = await new Promise((resolve, reject) => {
			const open = indexedDB.open("tabkyra-storage");
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		await new Promise((resolve, reject) => {
			const tx = db.transaction(["settings", "provider-keys"], "readwrite");
			tx.objectStore("settings").put(m, "lastUsedModel");
			tx.objectStore("provider-keys").put("sk-stub", "stub");
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, model);
	// fresh: a new chat, not the one an earlier test left open.
	if (fresh) await page.goto(`${PANEL}?new=true`);
	else await page.reload();
	const box = page.getByPlaceholder(/Ask about this page/);
	await box.waitFor({ timeout: 20_000 });
	await box.fill(message);
	await box.press("Enter");
}

/** One OpenAI-style streamed reply: either a tool call or text. */
function sse(reply) {
	const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-small", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	if (reply.tool)
		return (
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }) +
			chunk({}, "tool_calls") +
			"data: [DONE]\n\n"
		);
	return chunk({ role: "assistant", content: reply.text }) + chunk({}, "stop") + "data: [DONE]\n\n";
}

// The bug this guards: extract_document handed a whole 400-page PDF (about 706,000 characters) to a model with a small
// window, the provider answered "400 status code (no body)", and the thread stayed dead. Here a stand-in provider refuses
// any request over REFUSE_OVER bytes the same way. The chat must end with the model's answer. The window is 16,384
// tokens: the panel's own instructions and tools take about 11,000 (12,600 as Polycarp counts them), so the reply and
// the book share what is left.
test("a 400-page PDF read on a small-window model ends with an answer, not a 400", async () => {
	const REFUSE_OVER = 150_000;
	const filler = "Virtue is a settled state of character concerned with choice, lying in a mean relative to us.";
	const pdf = makePdf(400, 20, (n, i) => (n === 287 && i === 3 ? "CONTEMPLATION is the highest activity, the life of the mind." : `Page ${n} line ${i}. ${filler}`));
	const sizes = [];
	const maxTokens = [];
	let toolResult = "";
	await context.route("https://docs.stub.test/**", (r) => r.fulfill({ status: 200, contentType: "application/pdf", headers: { "access-control-allow-origin": "*" }, body: pdf }));
	await context.route("https://llm.stub.test/**", async (r) => {
		const body = r.request().postData() ?? "";
		sizes.push(body.length);
		const asked = JSON.parse(body);
		maxTokens.push(asked.max_completion_tokens ?? asked.max_tokens ?? 0);
		if (body.length > REFUSE_OVER) return r.fulfill({ status: 400, headers: { "access-control-allow-origin": "*" }, body: "" });
		const messages = JSON.parse(body).messages;
		const result = messages.find((m) => m.role === "tool");
		if (!result) return r.fulfill({ status: 200, contentType: "text/event-stream", headers: { "access-control-allow-origin": "*" }, body: sse({ tool: "extract_document", args: { url: "https://docs.stub.test/ethics.pdf" } }) });
		toolResult = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
		return r.fulfill({ status: 200, contentType: "text/event-stream", headers: { "access-control-allow-origin": "*" }, body: sse({ text: "STUB-ANSWER: the book has 400 pages." }) });
	});
	const model = {
		id: "stub-small",
		name: "Stub small",
		api: "openai-completions",
		provider: "stub",
		baseUrl: "https://llm.stub.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 2048,
	};
	const page = await context.newPage();
	try {
		await askPanel(page, model, "Read https://docs.stub.test/ethics.pdf and tell me how long it is.");
		const answer = page.getByText("STUB-ANSWER: the book has 400 pages.");
		const refused = page.getByText(/400 status code|too long for the model/);
		await Promise.race([answer.first().waitFor({ timeout: 60_000 }), refused.first().waitFor({ timeout: 60_000 })]);
		assert.equal(await refused.count(), 0, `the chat ended in an error; request sizes ${sizes.join(", ")}`);
		assert.ok(await answer.count(), "the answer is shown");
		assert.ok(sizes.every((s) => s <= REFUSE_OVER), `every request fit: ${sizes.join(", ")}`);
		// The tool read the real PDF, said how long it is, and told the model how to read the rest.
		assert.match(toolResult, /400 pages/);
		assert.match(toolResult, /query/);
		assert.ok(toolResult.length < 60_000, `tool result was ${toolResult.length} characters`);
		// The tool's own answer reached the model whole: the guard did not cut it again.
		assert.doesNotMatch(toolResult, /Polycarp cut this here/);
		// The reply asked for is what the budget kept room for.
		assert.ok(maxTokens.every((n) => n <= 2048), `max tokens asked: ${maxTokens.join(", ")}`);
	} finally {
		await context.unroute("https://docs.stub.test/**");
		await context.unroute("https://llm.stub.test/**");
		await page.close();
	}
});

// The acceptance case for documents: "what does Aristotle say about friendship in Book VIII" on a 32k model, against a
// 400-page Ethics. The stand-in model does what the tool description teaches: search, read the best pages, answer with
// their numbers. The book never enters the context: each tool answer is bounded, and page 300 is never sent.
test("a 32k model finds Book VIII in a 400-page PDF by searching, reads those pages and cites them, without the whole book", async () => {
	const pdf = ethicsPdf();
	const url = "https://docs.stub.test/nicomachean-ethics.pdf";
	const calls = [];
	const results = [];
	const bodies = [];
	const reply = (r, body) => r.fulfill({ status: 200, contentType: "text/event-stream", headers: { "access-control-allow-origin": "*" }, body: sse(body) });
	await context.route("https://docs.stub.test/**", (r) => r.fulfill({ status: 200, contentType: "application/pdf", headers: { "access-control-allow-origin": "*" }, body: pdf }));
	await context.route("https://llm.stub.test/**", async (r) => {
		const body = r.request().postData() ?? "";
		bodies.push(body);
		// This question's tool answers only: the panel may reopen an earlier test's chat, with its own.
		const sent = JSON.parse(body).messages;
		const asked = sent.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes("Book VIII?"));
		const tools = sent.slice(asked + 1).filter((m) => m.role === "tool");
		const last = tools.at(-1);
		if (last) results.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
		if (!tools.length) return reply(r, (calls.push({ url, query: "friendship Book VIII" }), { tool: "extract_document", args: calls.at(-1) }));
		if (tools.length === 1) {
			const top = Number(/1\. Page (\d+):/.exec(results.at(-1))?.[1]);
			return reply(r, (calls.push({ url, pages: `${top}-${top + 1}` }), { tool: "extract_document", args: calls.at(-1) }));
		}
		return reply(r, { text: `BOOK-VIII-ANSWER: friendship is a virtue, and the friend is another self (pages ${calls[1].pages}).` });
	});
	const model = { id: "stub-32k", name: "Stub 32k", api: "openai-completions", provider: "stub", baseUrl: "https://llm.stub.test/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4096 };
	const page = await context.newPage();
	try {
		await askPanel(page, model, `What does Aristotle say about friendship in Book VIII? The book: ${url}`, { fresh: true });
		// Its own marker: the panel may still show an earlier test's answer.
		await page.getByText(/BOOK-VIII-ANSWER/).first().waitFor({ timeout: 60_000 });
		assert.equal(calls.length, 2, "one search, one read");
		const [first, last] = calls[1].pages.split("-").map(Number);
		assert.ok(first >= FRIENDSHIP_PAGES[0] && first <= FRIENDSHIP_PAGES[1], `the search led to page ${first}:\n${results[0]}`);
		assert.match(results[0], /400 pages/);
		assert.match(results[1], new RegExp(`Page ${first} of 400[\\s\\S]*another self[\\s\\S]*Page ${last} of 400`));
		for (const t of results) {
			assert.ok(t.length < 40_000, `a tool answer of ${t.length} characters`);
			assert.doesNotMatch(t, /Polycarp cut this here/, "the tool's answer fit as it was");
		}
		for (const b of bodies) {
			assert.ok(!b.includes(FAR_LINE.slice(0, 15)), "page 300 was never sent");
			assert.ok(b.length < 32_768 * 4, `a request of ${b.length} bytes`);
		}
		assert.ok(await page.getByText(new RegExp(`pages ${first}-${last}`)).count(), "the answer cites the pages");
	} finally {
		await context.unroute("https://docs.stub.test/**");
		await context.unroute("https://llm.stub.test/**");
		await page.close();
	}
});

// The panel's own model on the bridge's ref tools, end to end: a scripted stand-in model opens a page, reads it, clicks
// the button by the ref read_page gave, and reads again. The click goes through the real handlers, CDP input and all.
// Its own Chromium without Playwright attached, as in e2e-bridge: the extension's chrome.debugger can't attach to a tab
// another automation client holds, so the stand-in model and the page are local servers and the panel is driven over
// the DevTools endpoint.
/**
 * A real Chromium with the built extension and a local fixture site, and the panel run by a stub model. Spawned
 * without Playwright: Playwright's own debugger client makes the extension's attach skip.
 */
async function withPanelBrowser(site, fn) {
	await new Promise((r) => site.listen(0, "127.0.0.1", r));
	const FIXTURE = `http://127.0.0.1:${site.address().port}/`;
	const own = mkdtempSync(join(tmpdir(), "tabkyra-e2e-panel-tools-"));
	const browser = spawn(
		chromium.executablePath(),
		[`--user-data-dir=${own}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "--remote-debugging-port=0", "--disable-gpu", `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "about:blank"],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	browser.stderr.on("data", (d) => {
		stderr += d;
	});
	const until = async (check, ms, what) => {
		const end = Date.now() + ms;
		for (;;) {
			const v = await check().catch(() => undefined);
			if (v) return v;
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
			await new Promise((r) => setTimeout(r, 150));
		}
	};
	try {
		const devtools = await until(async () => stderr.match(/DevTools listening on ws:\/\/([^/]+)\//)?.[1], 20_000, "Chromium");
		const targets = async () => (await fetch(`http://${devtools}/json/list`)).json();
		const version = await (await fetch(`http://${devtools}/json/version`)).json();
		const send = (wsUrl, method, params = {}) =>
			new Promise((resolve, reject) => {
				const ws = new WebSocket(wsUrl);
				ws.onerror = () => reject(new Error(`no DevTools socket for ${method}`));
				ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
				ws.onmessage = (e) => {
					const m = JSON.parse(e.data);
					if (m.id !== 1) return;
					ws.close();
					m.error ? reject(new Error(m.error.message)) : resolve(m.result);
				};
			});
		const evaluate = async (targetId, expression) => {
			const t = (await targets()).find((x) => x.id === targetId);
			const r = await send(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			return r.result?.value;
		};
		/** Open the panel on the stub model and send it one message; resolves with the panel's target id. */
		const runPanel = async (stub, message) => {
			const { targetId } = await send(version.webSocketDebuggerUrl, "Target.createTarget", { url: PANEL });
			await until(() => evaluate(targetId, `!!document.querySelector("textarea")?.placeholder?.includes("Ask about this page")`), 20_000, "the composer");
			await evaluate(targetId, seedStubScript(stub.model));
			const panelPage = (await targets()).find((x) => x.id === targetId);
			await send(panelPage.webSocketDebuggerUrl, "Page.navigate", { url: `${PANEL}?teststeps=${encodeURIComponent(JSON.stringify([message]))}` });
			return targetId;
		};
		await fn({ FIXTURE, targets, send, version, evaluate, until, runPanel });
	} finally {
		browser.kill();
		await new Promise((r) => (browser.exitCode === null ? browser.once("exit", r) : r()));
		site.close();
		try {
			rmSync(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch {
			/* Chromium helpers may still hold it */
		}
	}
}

const QUESTION_PAGE = `<!doctype html><title>Fixture</title><main><h1>Question</h1><button onclick="document.querySelector('main').innerHTML='<h1>Answer: 42</h1>'">Show answer</button></main>`;

test("the panel's model reads a page, clicks a ref with act, the page changes, and after a tab switch it reads the new current tab", async () => {
	const site = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url?.startsWith("/second")) return res.end("<!doctype html><title>Second</title><main><h1>Second page</h1></main>");
		res.end(QUESTION_PAGE);
	});
	await withPanelBrowser(site, async ({ FIXTURE, targets, evaluate, until, runPanel }) => {
		let ref;
		let firstTab;
		const stub = await stubModelServer((body, turn) => {
			if (turn === 0) return { toolCalls: [{ name: "navigate", arguments: { url: FIXTURE, newTab: true } }] };
			if (turn === 1) {
				firstTab = Number(/\(tab (\d+)\)/.exec(lastToolResult(body))?.[1]);
				return { toolCalls: [{ name: "read_page", arguments: { filter: "interactive" } }] };
			}
			if (turn === 2) {
				ref = /(e\d+) button "Show answer"/.exec(lastToolResult(body))?.[1];
				if (!ref) return { text: `no ref in: ${lastToolResult(body)}` };
				return { toolCalls: [{ name: "act", arguments: { action: "click", ref } }] };
			}
			if (turn === 3) return { toolCalls: [{ name: "read_page", arguments: {} }] };
			// A second tab becomes current, then the model switches back: the page tools must follow.
			if (turn === 4) return { toolCalls: [{ name: "navigate", arguments: { url: `${FIXTURE}second`, newTab: true } }] };
			if (turn === 5) return { toolCalls: [{ name: "read_page", arguments: {} }] };
			if (turn === 6) return { toolCalls: [{ name: "navigate", arguments: { switchToTab: firstTab } }] };
			if (turn === 7) return { toolCalls: [{ name: "read_page", arguments: {} }] };
			return { text: "The answer is 42." };
		});
		try {
			const targetId = await runPanel(stub, "Show the answer");
			await until(() => evaluate(targetId, `document.body.innerText.includes("The answer is 42.")`), 30_000, "the answer").catch((err) => {
				throw new Error(`${err.message}\nwhat the model saw: ${JSON.stringify(stub.requests.map(lastToolResult))}`);
			});
			assert.equal(stub.requests.length, 9, "the model got a request per turn");
			assert.ok(ref, "read_page gave the button a ref");
			const [read, clicked, readAgain] = [2, 3, 4].map((i) => lastToolResult(stub.requests[i]));
			assert.match(read, /use the ref with act/);
			assert.doesNotMatch(clicked, /^[a-z_]+: /, `the click worked: ${clicked}`);
			// The panel's act reports what the click changed (D43), as MCP's click does.
			assert.match(clicked, /"changes":\{[^]*Answer: 42/, `no change report: ${clicked}`);
			assert.match(readAgain, /Answer: 42/);
			assert.doesNotMatch(readAgain, /Show answer/);
			const [readSecond, readAfterSwitch] = [6, 8].map((i) => lastToolResult(stub.requests[i]));
			assert.ok(Number.isInteger(firstTab), "navigate named the first tab");
			assert.match(readSecond, /Second page/, "read_page follows a new tab");
			assert.match(readAfterSwitch, /Answer: 42/, `read_page follows switchToTab: ${readAfterSwitch}`);
			assert.doesNotMatch(readAfterSwitch, /Second page/);
			// The tab itself changed, not just what the model was told.
			const fixture = (await targets()).find((t) => t.type === "page" && t.url === FIXTURE);
			assert.equal(await evaluate(fixture.id, `document.querySelector("h1").textContent`), "Answer: 42");
			// The panel's step rows name the calls.
			const rows = await evaluate(targetId, "document.body.innerText");
			assert.match(rows, new RegExp(`Click ${ref}`));
			// The panel's tool list is the grouped ref tools; MCP's separate input tools are not in it.
			const tools = stub.requests[0].tools.map((t) => t.function.name);
			for (const name of ["read_page", "find", "get_page_text", "act", "handle_dialog"]) assert.ok(tools.includes(name), name);
			assert.ok(!tools.includes("click"));
		} finally {
			await stub.close();
		}
	});
});

test("act x/y from a screenshot still lands after Chrome stops and restarts the service worker between the calls", async () => {
	const site = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(QUESTION_PAGE);
	});
	await withPanelBrowser(site, async ({ FIXTURE, targets, send, version, evaluate, until, runPanel }) => {
		const worker = async () => (await targets()).find((t) => t.type === "service_worker" && t.url.includes(EXTENSION_ID));
		let restarted = false;
		const stub = await stubModelServer(async (body, turn) => {
			if (turn === 0) return { toolCalls: [{ name: "navigate", arguments: { url: FIXTURE, newTab: true } }] };
			if (turn === 1) return { toolCalls: [{ name: "act", arguments: { action: "screenshot" } }] };
			if (turn === 2) {
				const width = Number(/(\d+)x\d+ screenshot/.exec(lastToolResult(body))?.[1]);
				const page = (await targets()).find((t) => t.type === "page" && t.url === FIXTURE);
				const at = await evaluate(page.id, `(() => { const r = document.querySelector("button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth }; })()`);
				// Stop the worker, as Chrome does after 30 idle seconds, and mark the old one to tell them apart.
				const before = await worker();
				await evaluate(before.id, "globalThis.__beforeRestart = true");
				await send(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId: before.id });
				await until(async () => (await worker())?.id !== before.id || !(await worker()), 10_000, "the worker to stop");
				restarted = true;
				const f = width / at.w;
				return { toolCalls: [{ name: "act", arguments: { action: "click", x: Math.round(at.x * f), y: Math.round(at.y * f) } }] };
			}
			if (turn === 3) return { toolCalls: [{ name: "read_page", arguments: {} }] };
			return { text: "Clicked." };
		});
		try {
			const targetId = await runPanel(stub, "Click Show answer from a screenshot");
			await until(() => evaluate(targetId, `document.body.innerText.includes("Clicked.")`), 40_000, "the run").catch((err) => {
				throw new Error(`${err.message}\nwhat the model saw: ${JSON.stringify(stub.requests.map(lastToolResult))}`);
			});
			assert.ok(restarted, "the worker was stopped between the screenshot and the click");
			const after = await worker();
			assert.ok(after, "a message from the panel started the worker again");
			assert.equal(await evaluate(after.id, "globalThis.__beforeRestart === true"), false, "it is a new worker");
			const clicked = lastToolResult(stub.requests[3]);
			assert.doesNotMatch(clicked, /^[a-z_]+: /, `the click after the restart worked: ${clicked}`);
			assert.match(lastToolResult(stub.requests[4]), /Answer: 42/);
		} finally {
			await stub.close();
		}
	});
});

// Compaction (src/models/compactor.ts) in the real panel: a long chat on a small model goes on until the guard would
// drop its earliest turns; they are summarized instead, the transcript shows the marker, and after a reload the next
// request still starts from the stored notes, with no new summary and the latest question whole.
test("a long chat is summarized when the guard would drop turns, and the notes hold across a reload", async () => {
	const filler = "The committee reviewed the proposal and noted points on cost, schedule and risk to weigh before the next meeting. ".repeat(18);
	const cors = { "access-control-allow-origin": "*" };
	const summaries = [];
	const requests = [];
	const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
	await context.route("https://llm.stub.test/**", async (r) => {
		const body = r.request().postData() ?? "";
		const { messages } = JSON.parse(body);
		if (textOf(messages.find((m) => m.role === "system" || m.role === "developer")).startsWith("You keep the working notes")) {
			summaries.push(body.length);
			const notes = ["Decisions", "Facts found", "Tried and failed", "Open steps", "Done steps", "Files and artifacts"].map((s, i) => `## ${s}\n- ${i === 1 ? `NOTE-FACTS ${summaries.length}` : "none"}`).join("\n");
			return r.fulfill({ status: 200, contentType: "text/event-stream", headers: cors, body: sse({ text: notes }) });
		}
		requests.push(body);
		const q = /(Q\d+|LAST-Q)/.exec(textOf(messages.filter((m) => m.role === "user").at(-1)))?.[1];
		return r.fulfill({ status: 200, contentType: "text/event-stream", headers: cors, body: sse({ text: `ANSWER-${q}. ${filler}` }) });
	});
	const model = { id: "stub-18k", name: "Stub 18k", api: "openai-completions", provider: "stub", baseUrl: "https://llm.stub.test/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 18_000, maxTokens: 1024 };
	const page = await context.newPage();
	try {
		let turn = 1;
		await askPanel(page, model, `Q${turn}: ${filler}`, { fresh: true });
		const box = page.getByPlaceholder(/Ask about this page/);
		for (;;) {
			await page.getByText(`ANSWER-Q${turn}.`).first().waitFor({ timeout: 60_000 });
			if (summaries.length || turn >= 80) break;
			turn++;
			await box.fill(`Q${turn}: ${filler}`);
			await box.press("Enter");
		}
		assert.ok(summaries.length, `the summarizer ran within ${turn} turns`);
		const sent = requests.at(-1);
		assert.match(sent, /which it summarized to fit the model's context/);
		assert.match(sent, new RegExp(`Q${turn}: The committee`), "the latest question is sent whole");
		assert.doesNotMatch(sent, /earliest messages of this chat/, "nothing was dropped");
		await page.locator("[data-compaction]").first().waitFor({ timeout: 10_000 });
		// A reload: the panel reopens this chat from storage, with a new agent and compactor.
		const before = summaries.length;
		await page.reload();
		await box.waitFor({ timeout: 20_000 });
		await page.locator("[data-compaction]").first().waitFor({ timeout: 10_000 });
		// As long as the other questions, so the whole chat still doesn't fit: when it does, it is sent whole instead.
		await box.fill(`LAST-Q: what did we settle? ${filler}`);
		await box.press("Enter");
		await page.getByText("ANSWER-LAST-Q.").first().waitFor({ timeout: 60_000 });
		const after = requests.at(-1);
		assert.match(after, new RegExp(`NOTE-FACTS ${before}`), "the stored notes are sent after the reload");
		assert.match(after, /LAST-Q: what did we settle\?/);
		assert.doesNotMatch(after, /earliest messages of this chat/);
		assert.equal(summaries.length, before, "no new summary was needed");
		assert.equal(await page.getByText(/400 status code|too long for the model|couldn't summarize/).count(), 0);
	} finally {
		await context.unroute("https://llm.stub.test/**");
		await page.close();
	}
});
