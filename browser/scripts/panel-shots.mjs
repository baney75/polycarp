#!/usr/bin/env node
// Every screen of the side panel with realistic data, in a throwaway Chromium, at the panel's real size.
//   node scripts/panel-shots.mjs <out folder> [extension folder] [--light]
// Used for design rounds and store screenshots. Network is blocked, so nothing leaves and nothing varies.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const light = process.argv.includes("--light");
const out = resolve(args[0]);
const ext = resolve(args[1] ?? join(here, "../dist-chrome"));
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(join(here, "../cli/package.json"))("playwright-core");
const profile = mkdtempSync(join(tmpdir(), "panel-shots-"));
const ctx = await chromium.launchPersistentContext(profile, {
	headless: false,
	viewport: { width: 420, height: 860 },
	deviceScaleFactor: 2,
	colorScheme: light ? "light" : "dark",
	args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route(/^https?:\/\//, (r) => r.abort());
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
const panel = `chrome-extension://${new URL(sw.url()).host}/sidepanel.html`;
const shot = async (page, name) => {
	await page.waitForTimeout(350);
	await page.screenshot({ path: join(out, `${name}.png`) });
	console.log(name);
};

const first = await ctx.newPage();
await first.goto(panel);
await first.waitForSelector("textarea");
await first.waitForTimeout(800);
await shot(first, "panel-first-run");
await first.keyboard.press("Escape");
await first.waitForTimeout(500);
await shot(first, "panel-settings-providers");
for (const tab of ["Agents", "Skills", "Privacy", "Appearance", "About"]) {
	await first.locator('[role="tab"]', { hasText: tab }).first().click();
	await shot(first, `panel-settings-${tab.toLowerCase()}`);
}

const model = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8000,
};
const usage = {
	input: 2140,
	output: 318,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2458,
	cost: { input: 0.0064, output: 0.0048, cacheRead: 0, cacheWrite: 0, total: 0.0112 },
};
const assistant = (content) => ({
	role: "assistant",
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage,
	stopReason: "stop",
	timestamp: 1,
});
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const tool = (id, name, text) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});
const messages = [
	user("Find the three cheapest direct flights from Chicago to Denver next Friday and put them in a table."),
	assistant([
		{ type: "text", text: "I'll check the fares page." },
		{ type: "toolCall", id: "t1", name: "navigate", arguments: { url: "https://www.example-flights.com/ord-den" } },
	]),
	tool("t1", "navigate", "Navigated to Example Flights: ORD to DEN"),
	assistant([
		{
			type: "toolCall",
			id: "t2",
			name: "repl",
			arguments: {
				title: "Read the fares",
				code: "const rows = await browserjs(() => [...document.querySelectorAll('.fare')].map(r => r.innerText));\nreturn rows.slice(0, 3);",
			},
		},
	]),
	tool("t2", "repl", '["United 7:05 $118","Southwest 11:40 $124","Frontier 16:20 $131"]'),
	assistant([
		{
			type: "text",
			text: "Here are the three cheapest direct flights on **Friday, November 13**:\n\n| Airline | Departs | Fare |\n| --- | --- | --- |\n| United | 7:05 AM | $118 |\n| Southwest | 11:40 AM | $124 |\n| Frontier | 4:20 PM | $131 |\n\nUnited is cheapest, but Southwest includes two checked bags, so it comes out ahead if you're checking one.\n\n```python\ntotal = 124 + 0  # bags included\n```",
		},
	]),
];
await first.evaluate(
	({ messages, model }) =>
		new Promise((done, fail) => {
			const open = indexedDB.open("tabkyra-storage");
			open.onsuccess = () => {
				const db = open.result;
				const now = new Date().toISOString();
				const tx = db.transaction(["sessions", "sessions-metadata", "provider-keys"], "readwrite");
				const meta = (id, title, preview) => ({
					id,
					title,
					createdAt: now,
					lastModified: now,
					messageCount: messages.length,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
					},
					thinkingLevel: "off",
					preview,
				});
				tx.objectStore("sessions").put({
					id: "flights",
					title: "Cheapest flights to Denver",
					model,
					thinkingLevel: "off",
					messages,
					createdAt: now,
					lastModified: now,
				});
				tx.objectStore("sessions-metadata").put(
					meta("flights", "Cheapest flights to Denver", "Find the three cheapest direct flights"),
				);
				for (const [id, title] of [
					["a", "Summarize the Q3 report"],
					["b", "Compare standing desks"],
					["c", "Fill out the visa form"],
				])
					tx.objectStore("sessions-metadata").put(meta(id, title, title));
				tx.objectStore("provider-keys").put("sk-ant-sample", "anthropic");
				tx.oncomplete = () => done();
				tx.onerror = () => fail(tx.error);
			};
			open.onerror = () => fail(open.error);
		}),
	{ messages, model },
);
await first.close();

const empty = await ctx.newPage();
await empty.goto(panel);
await empty.waitForSelector("textarea");
await empty.waitForTimeout(800);
await shot(empty, "panel-empty");
await empty.locator("textarea").first().fill("Summarize this page in three bullets");
await shot(empty, "panel-typing");
await empty.locator("textarea").first().fill("");
await empty.locator("textarea").first().fill("/");
await shot(empty, "panel-slash-menu");
await empty.locator("textarea").first().fill("");
await empty.keyboard.press("Escape");
const picker = empty.getByRole("button", { name: /sonnet|claude|model/i }).first();
if (await picker.count()) {
	await picker.click().catch(() => {});
	await shot(empty, "panel-model-picker");
	await empty.keyboard.press("Escape");
}
await empty.close();

const chat = await ctx.newPage();
await chat.goto(`${panel}?session=flights`);
await chat.waitForSelector("textarea");
await chat.waitForTimeout(1000);
await shot(chat, "panel-chat");
await chat.setViewportSize({ width: 420, height: 1180 });
await shot(chat, "panel-chat-tall");
await chat.setViewportSize({ width: 420, height: 860 });
const history = chat.locator('[data-tip*="istory" i], [aria-label*="istory" i], [title*="istory" i]').first();
if (await history.count()) {
	await history.click().catch(() => {});
	await shot(chat, "panel-history");
	await chat.keyboard.press("Escape");
}
const more = chat.locator('[data-tip*="More" i], [aria-label*="More" i], [title*="More" i]').first();
if (await more.count()) {
	await more.click().catch(() => {});
	await shot(chat, "panel-more-menu");
}
await ctx.close();
rmSync(profile, { recursive: true, force: true });
