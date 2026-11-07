#!/usr/bin/env node
// Times what opening and using the model picker costs, in a throwaway Chromium with four providers keyed.
//   node scripts/panel-picker-speed.mjs [extension folder] [--slow-network]
// --slow-network makes every request take 3 seconds, as a stale provider list on a real connection can. The picker must
// not wait for any of them.
// Also times Settings > Providers. Prints each step's time from the page's own clock and its longest task.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const slow = process.argv.includes("--slow-network");
const ext = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(here, "../dist-chrome"));
const { chromium } = createRequire(join(here, "../cli/package.json"))("playwright-core");
const profile = mkdtempSync(join(tmpdir(), "picker-speed-"));
const ctx = await chromium.launchPersistentContext(profile, {
	headless: false,
	viewport: { width: 420, height: 860 },
	colorScheme: "dark",
	args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route(/^https?:\/\//, async (r) => {
	if (slow) await new Promise((done) => setTimeout(done, 3000));
	await r.abort().catch(() => {});
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
const panel = `chrome-extension://${new URL(sw.url()).host}/sidepanel.html`;

const seed = await ctx.newPage();
await seed.goto(panel);
await seed.waitForSelector("textarea");
await seed.evaluate(
	() =>
		new Promise((done, fail) => {
			const open = indexedDB.open("tabkyra-storage");
			open.onsuccess = () => {
				const tx = open.result.transaction(["provider-keys"], "readwrite");
				for (const provider of ["anthropic", "openrouter", "openai", "google"]) {
					tx.objectStore("provider-keys").put("sk-sample", provider);
				}
				tx.oncomplete = () => done();
				tx.onerror = () => fail(tx.error);
			};
		}),
);
await seed.close();

const page = await ctx.newPage();
await page.goto(panel);
await page.waitForSelector("textarea");
await page.waitForTimeout(1200);
await page.evaluate(() => {
	window.__long = [];
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration));
	}).observe({ type: "longtask" });
	window.__settled = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});
const longest = async () => {
	await page.waitForTimeout(120);
	const seen = await page.evaluate(() => window.__long.splice(0));
	return seen.length ? `longest task ${Math.max(...seen)} ms` : "no long task";
};
const results = {};
const note = async (name, ms) => {
	(results[name] ??= []).push(ms);
	console.log(name.padEnd(24), String(ms).padStart(6), "ms ", await longest());
};

for (let round = 0; round < 3; round++) {
	const open = await page.evaluate(async () => {
		const button = [...document.querySelectorAll("message-editor button")].find((b) =>
			/Claude|Sonnet|Gemini|GPT|provider/i.test(b.innerText),
		);
		const start = performance.now();
		button.click();
		while (!document.querySelector("[data-model-item]")) await new Promise((r) => requestAnimationFrame(r));
		await window.__settled();
		return Math.round(performance.now() - start);
	});
	await note("open the picker", open);
	const size = await page.evaluate(() => ({
		rows: document.querySelectorAll("[data-model-item]").length,
		nodes: document.querySelectorAll("*").length,
	}));
	if (round === 0) console.log("  ", size.rows, "rows drawn,", size.nodes, "nodes on the page");
	const hover = await page.evaluate(async () => {
		const rows = [...document.querySelectorAll("[data-model-item]")].slice(0, 6);
		const start = performance.now();
		for (const row of rows) {
			row.dispatchEvent(new MouseEvent("mouseenter"));
			await new Promise((r) => requestAnimationFrame(r));
		}
		return Math.round((performance.now() - start) / rows.length);
	});
	await note("hover, per row", hover);
	const search = await page.evaluate(async () => {
		const input = document.querySelector('input[placeholder*="Search models"]');
		const start = performance.now();
		for (const text of ["s", "so", "son"]) {
			input.value = text;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			await new Promise((r) => requestAnimationFrame(r));
		}
		await window.__settled();
		return Math.round((performance.now() - start) / 3);
	});
	await note("search, per letter", search);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(350);
}

const settings = await page.evaluate(async () => {
	const button = [...document.querySelectorAll("button")].find((b) =>
		/settings/i.test(b.getAttribute("aria-label") || b.title || b.dataset.tip || ""),
	);
	const start = performance.now();
	button.click();
	while (!document.querySelector('[role="tab"]')) await new Promise((r) => requestAnimationFrame(r));
	await window.__settled();
	return Math.round(performance.now() - start);
});
await note("open Settings", settings);
await page.waitForTimeout(600);
await page.locator('[role="tab"]', { hasText: "Skills" }).first().click();
await page.waitForTimeout(300);
const providers = await page.evaluate(async () => {
	const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => /Providers/.test(t.innerText));
	const start = performance.now();
	tab.click();
	await window.__settled();
	return Math.round(performance.now() - start);
});
await note("Providers tab", providers);
const all = await page.evaluate(async () => {
	const button = [...document.querySelectorAll("button")].find((b) => /Show all providers/.test(b.innerText));
	if (!button) return 0;
	const start = performance.now();
	button.click();
	await window.__settled();
	return Math.round(performance.now() - start);
});
await note("show all providers", all);

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, median(v)]))));
await ctx.close();
rmSync(profile, { recursive: true, force: true });
