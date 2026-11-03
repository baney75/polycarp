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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadTs } from "./helpers/bundle-ts.mjs";

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
							return reply({ error: { code: "linked_no_service", message: "Linked as laptop, but the background service didn't start; run tabkyra link status." } });
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
	if (profile) rmSync(profile, { recursive: true, force: true });
});

/** The panel at `width`, in `theme`, with Settings open on `tab`. */
async function settings(tab, theme = "light", width = 400) {
	const page = await context.newPage();
	await page.setViewportSize({ width, height: 860 });
	await page.goto(PANEL);
	await page.evaluate((t) => localStorage.setItem("theme", t), theme);
	await page.evaluate(() => chrome.storage.local.remove("tabkyra.appearance"));
	await page.reload();
	await page.getByRole("button", { name: "Set up provider" }).click({ timeout: 20_000 });
	await page.waitForSelector("tabkyra-settings", { state: "attached" });
	await page.getByRole("tab", { name: tab, exact: true }).click();
	await page.waitForTimeout(600);
	return page;
}

const rgb = (css) => {
	const [r, g, b] = css.match(/\d+(\.\d+)?/g).map(Number);
	return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
};

for (const width of [400, 320]) {
	test(`Connect's command boxes show the whole command at ${width} px, and nothing runs past the panel`, async () => {
		const page = await settings("Connect", "light", width);
		try {
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
			assert.ok(commands.includes("tabkyra remote setup"), JSON.stringify(commands));
			assert.ok(commands.includes("tabkyra hub setup --public-url https://ADDRESS"), JSON.stringify(commands));
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
	test(`the selected Settings tab stands out from the page at 3:1 in every preset (${theme})`, async () => {
		const page = await settings("Appearance", theme);
		try {
			for (const preset of Object.keys(PRESETS)) {
				await page.locator(`[data-preset=${preset}]`).click();
				await page.waitForTimeout(450);
				const { chip, text, page: bg } = await page.evaluate(() => {
					const selected = document.querySelector('tabkyra-settings [role="tab"][aria-selected="true"]');
					const style = getComputedStyle(selected);
					return { chip: style.backgroundColor, text: style.color, page: getComputedStyle(document.querySelector("tabkyra-settings > div")).backgroundColor };
				});
				const ratio = contrast(rgb(chip), rgb(bg));
				assert.ok(ratio >= 3, `${preset} ${theme}: chip ${rgb(chip)} on page ${rgb(bg)} is ${ratio.toFixed(2)}:1`);
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
		const page = await settings("Connect", "light", width);
		try {
			const tabs = await page.evaluate(() =>
				[...document.querySelectorAll('tabkyra-settings [role="tab"]')].map((t) => ({ name: t.textContent.trim(), cut: t.scrollWidth > t.clientWidth + 1 })),
			);
			assert.deepEqual(tabs.map((t) => t.name), ["Providers", "Agents", "Connect", "Skills", "Privacy", "Appearance", "Costs", "About"]);
			assert.deepEqual(tabs.filter((t) => t.cut), []);
		} finally {
			await page.close();
		}
	});
}

test("Join hub asks for a Confirm that names the host and the scopes; after joining, the outcome stays up although the form is gone", async () => {
	const page = await settings("Connect");
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
		assert.match(await message.innerText(), /Linked as laptop, but the background service didn't start; run tabkyra link status\./);
		assert.equal(await page.getByRole("button", { name: "Join hub" }).count(), 0);
		assert.equal(await page.locator("tabkyra-connect-tab").getByText("Get a code to see the connector URL.").count(), 1);
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
		await page.getByRole("button", { name: "Set up provider" }).waitFor({ timeout: 20_000 });
		await page.waitForTimeout(1500);
		await page.evaluate(() => {
			const b = document.createElement("button");
			b.id = "open-real-panel";
			b.style.cssText = "position:fixed;top:0;left:0;width:100px;height:50px;z-index:99999";
			b.addEventListener("click", async () => {
				try {
					const w = await chrome.windows.getCurrent();
					const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
					await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
					await chrome.sidePanel.open({ tabId: tab.id });
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
