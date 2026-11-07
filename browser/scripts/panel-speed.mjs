#!/usr/bin/env node
// Times the side panel opening, in a throwaway Chromium with the built extension loaded.
//   node scripts/panel-speed.mjs [extension folder] [--runs N] [--json]
// Default folder is dist-chrome. Needs the CLI's playwright-core (cd cli && npx playwright-core install chromium).
// Reports what a person sees: first paint, and when the box you type in exists. Cold is the first open in a new
// profile, so nothing is cached. Warm is every open after it, which is what someone feels every day.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = args.indexOf(name);
	return at < 0 ? fallback : args[at + 1];
};
const ext = resolve(
	args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--runs") ?? join(here, "../dist-chrome"),
);
const runs = Number(flag("--runs", 12));
const { chromium } = createRequire(join(here, "../cli/package.json"))("playwright-core");

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

/** One open: paint times from the page's own clock, so the driver's round trips don't count. */
async function open(ctx, id) {
	const page = await ctx.newPage();
	await page.goto(`chrome-extension://${id}/sidepanel.html`, { waitUntil: "commit" });
	const timing = await page.evaluate(
		() =>
			new Promise((done) => {
				const check = () => {
					if (!document.querySelector("textarea")) return requestAnimationFrame(check);
					const paint = performance.getEntriesByName("first-paint")[0]?.startTime ?? null;
					done({ paint, ready: performance.now() });
				};
				check();
			}),
	);
	const marks = await page.evaluate(() =>
		Object.fromEntries(
			performance.getEntriesByType("mark").map((m) => [m.name.replace("panel:", ""), Math.round(m.startTime)]),
		),
	);
	await page.close();
	return { ...timing, marks };
}

const profile = mkdtempSync(join(tmpdir(), "panel-speed-"));
const ctx = await chromium.launchPersistentContext(profile, {
	headless: false,
	viewport: { width: 420, height: 800 },
	colorScheme: "dark",
	args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
	const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
	const id = new URL(sw.url()).host;
	const cold = await open(ctx, id);
	const warm = [];
	for (let i = 0; i < runs; i++) warm.push(await open(ctx, id));
	const result = {
		coldReadyMs: Math.round(cold.ready),
		warmPaintMs: Math.round(median(warm.map((w) => w.paint ?? w.ready))),
		warmReadyMs: Math.round(median(warm.map((w) => w.ready))),
		warmReadyWorstMs: Math.round(Math.max(...warm.map((w) => w.ready))),
		runs,
	};
	console.log(JSON.stringify(result));
	if (args.includes("--marks")) {
		const steps = Object.keys(warm[0].marks);
		console.log(
			"warm, ms from navigation:",
			Object.fromEntries(steps.map((s) => [s, median(warm.map((w) => w.marks[s] ?? 0))])),
		);
	}
} finally {
	await ctx.close();
	rmSync(profile, { recursive: true, force: true });
}
