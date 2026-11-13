#!/usr/bin/env node
// Times Settings in the side panel, in a throwaway headless Chromium with the built extension loaded.
//   node scripts/settings-speed.mjs [extension folder] [--runs N] [--json] [--check] [--update]
// Default folder is dist-chrome. Needs the CLI's playwright-core; set CHROMIUM=/usr/bin/chromium to use the system one
// instead of Playwright's download. The network is blocked and no native host is installed, as on a first run.
//
// Every time comes from the page's own clock (performance.now), so the driver's round trips don't count:
//   open        the Settings button is clicked -> the first section's search box is on screen
//   open.settled                               -> the last change to the page before it stays still for 500 ms
//   tab:<name>  a tab is clicked -> its panel shows controls; tab:<name>.settled as above
//   save:<what> a control is changed -> the new value is in storage and the control shows it
//   shift:open  layout shift (the browser's own score) between the click and open.settled; 0 means nothing jumped
// The profile holds three saved provider keys, so the Providers section has real rows to sort.
// Medians over --runs opens (default 7) after one warm-up. --check exits 1 when a median is more than 25% over
// scripts/settings-speed.floor.json, which --update rewrites. Gate on a quiet machine only: load swings these.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const runs = Number(flag("--runs", 7));
const floorPath = join(here, "settings-speed.floor.json");
const { chromium } = createRequire(join(here, "../cli/package.json"))("playwright-core");

const TABS = ["Providers", "Agents", "Skills", "Sites", "Privacy", "Appearance", "About"];
const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";
const PANEL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;
/** Over the floor by more than this fails --check. */
const SLACK = 1.25;
/** A floor this small is noise; it gates at this many ms instead. */
const MIN_GATE_MS = 40;

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Installed in the page before each measurement. `measure(start, ready)` runs `start` (a click), then waits for
 * `ready()` to be true on an animation frame, then for the Settings page to stop changing for 500 ms.
 */
const PAGE_HELPERS = () => {
	const frame = () => new Promise((r) => requestAnimationFrame(r));
	const visible = (el) => {
		if (!el) return false;
		const r = el.getBoundingClientRect();
		// A control that is laid out but invisible (a tab held back until its data is in) is not on screen yet.
		return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
	};
	const activePanel = () => document.querySelector('tabkyra-settings [role="tabpanel"]:not([hidden])');
	globalThis.__bench = {
		visible,
		activePanel,
		async measure(start, ready, { quiet = 500, cap = 8000 } = {}) {
			let shift = 0;
			const shifts = new PerformanceObserver((list) => {
				for (const e of list.getEntries()) if (!e.hadRecentInput) shift += e.value;
			});
			shifts.observe({ type: "layout-shift" });
			let last = performance.now();
			const changes = new MutationObserver(() => {
				last = performance.now();
			});
			changes.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
			const t0 = performance.now();
			last = t0;
			await start();
			while (!(await ready())) {
				if (performance.now() - t0 > cap) throw new Error("not ready within the cap");
				await frame();
			}
			const shown = performance.now() - t0;
			while (performance.now() - last < quiet && performance.now() - t0 < cap) await frame();
			changes.disconnect();
			shifts.disconnect();
			return { shown, settled: Math.max(shown, last - t0), shift };
		},
	};
};

async function newPanel(ctx) {
	const page = await ctx.newPage();
	await page.goto(PANEL);
	await page.getByPlaceholder(/Ask about this page/).waitFor({ timeout: 30_000 });
	await page.evaluate(PAGE_HELPERS);
	return page;
}

/** Three saved keys (made-up values), the welcome sheet seen, default appearance and switches. */
async function seed(ctx) {
	const page = await ctx.newPage();
	await page.goto(PANEL);
	await page.getByPlaceholder(/Ask about this page/).waitFor({ timeout: 30_000 });
	await page.evaluate(async () => {
		await chrome.storage.local.set({ "tk-welcome-seen": true });
		await chrome.storage.local.remove(["tabkyra.appearance", "veil_enabled"]);
		const db = await new Promise((ok, fail) => {
			const req = indexedDB.open("tabkyra-storage");
			req.onsuccess = () => ok(req.result);
			req.onerror = () => fail(req.error);
		});
		await new Promise((ok, fail) => {
			const tx = db.transaction(["provider-keys", "settings"], "readwrite");
			for (const p of ["anthropic", "openai", "openrouter"]) tx.objectStore("provider-keys").put(`bench-${p}`, p);
			tx.objectStore("settings").put(false, "privacy.privateMode");
			tx.oncomplete = ok;
			tx.onerror = () => fail(tx.error);
		});
		db.close();
	});
	await page.close();
}

/** One pass: open Settings, visit every tab, change the theme and two switches, close. */
async function pass(ctx) {
	const page = await newPanel(ctx);
	const out = {};
	const open = await page.evaluate(() =>
		__bench.measure(
			() => document.querySelector('button[aria-label="Settings"], button[title="Settings"]').click(),
			() => __bench.visible(__bench.activePanel()?.querySelector('input[type="search"]')),
		),
	);
	out.open = open.shown;
	out["open.settled"] = open.settled;
	out["shift:open"] = open.shift;
	// Providers first is open itself; every other tab is a switch, then back to Providers.
	for (const name of [...TABS.slice(1), "Providers"]) {
		const r = await page.evaluate(
			(tab) =>
				__bench.measure(
					() =>
						[...document.querySelectorAll('tabkyra-settings [role="tab"]')]
							.find((b) => b.textContent.trim() === tab)
							.click(),
					() => {
						const panel = __bench.activePanel();
						return Boolean(
							panel && [...panel.querySelectorAll("button, input, select, a")].some(__bench.visible),
						);
					},
				),
			name,
		);
		out[`tab:${name}`] = r.shown;
		out[`tab:${name}.settled`] = r.settled;
	}
	// The theme: a preset other than the current one, saved and painted.
	await page.evaluate(() =>
		[...document.querySelectorAll('tabkyra-settings [role="tab"]')]
			.find((b) => b.textContent.trim() === "Appearance")
			.click(),
	);
	await page.waitForSelector('tabkyra-settings button[data-preset="forest"]', { state: "visible" });
	const theme = await page.evaluate(async () => {
		const target =
			document.querySelector('button[data-preset="forest"]').getAttribute("aria-pressed") === "true"
				? "slate"
				: "forest";
		// Storage reports the write as an event, so the wait reads nothing per frame.
		let saved = false;
		chrome.storage.onChanged.addListener((changes) => {
			if (changes["tabkyra.appearance"]?.newValue?.preset === target) saved = true;
		});
		return __bench.measure(
			() => document.querySelector(`button[data-preset="${target}"]`).click(),
			() =>
				saved && document.querySelector(`button[data-preset="${target}"]`)?.getAttribute("aria-pressed") === "true",
		);
	});
	out["save:theme"] = theme.shown;
	out["save:theme.settled"] = theme.settled;
	// A switch in Agents (chrome.storage), and one in Privacy (the IndexedDB settings store).
	const switches = [
		["Agents", "Show when an agent is using a tab", "veil"],
		["Privacy", "Only use models that don't keep my prompts", "private"],
	];
	for (const [tab, label, key] of switches) {
		await page.evaluate(
			(t) =>
				[...document.querySelectorAll('tabkyra-settings [role="tab"]')]
					.find((b) => b.textContent.trim() === t)
					.click(),
			tab,
		);
		const r = await page.evaluate(
			async ({ label, key }) => {
				const find = () =>
					[...__bench.activePanel().querySelectorAll("label")]
						.find((l) => l.textContent.includes(label))
						?.querySelector('input[role="switch"]');
				while (!find()) await new Promise((r) => requestAnimationFrame(r));
				const want = !find().checked;
				let veilSaved;
				chrome.storage.onChanged.addListener((changes) => {
					if ("veil_enabled" in changes) veilSaved = changes.veil_enabled.newValue !== false;
				});
				const stored = async () => {
					if (key === "veil") return veilSaved;
					const db = await new Promise((ok) => {
						const req = indexedDB.open("tabkyra-storage");
						req.onsuccess = () => ok(req.result);
					});
					const value = await new Promise((ok) => {
						const req = db.transaction("settings").objectStore("settings").get("privacy.privateMode");
						req.onsuccess = () => ok(req.result === true);
					});
					db.close();
					return value;
				};
				return __bench.measure(
					() => find().click(),
					// The switch first, so the store is read only once the panel shows the change.
					async () => find()?.checked === want && (await stored()) === want,
				);
			},
			{ label, key },
		);
		out[`save:${key}`] = r.shown;
		out[`save:${key}.settled`] = r.settled;
	}
	await page.close();
	return out;
}

const profile = mkdtempSync(join(tmpdir(), "settings-speed-"));
const ctx = await chromium.launchPersistentContext(profile, {
	headless: false,
	executablePath: process.env.CHROMIUM || undefined,
	viewport: { width: 400, height: 860 },
	args: [
		"--headless=new",
		`--disable-extensions-except=${ext}`,
		`--load-extension=${ext}`,
		"--use-mock-keychain",
		"--password-store=basic",
	],
});
let failed = false;
try {
	await ctx.route(/^https?:\/\//, (r) => r.abort());
	await seed(ctx);
	await pass(ctx); // warm-up: the first open in a profile compiles and caches everything
	const all = [];
	for (let i = 0; i < runs; i++) all.push(await pass(ctx));
	const medians = Object.fromEntries(Object.keys(all[0]).map((k) => [k, median(all.map((r) => r[k]))]));
	const rounded = Object.fromEntries(
		Object.entries(medians).map(([k, v]) => [k, k.startsWith("shift:") ? Number(v.toFixed(4)) : Math.round(v)]),
	);
	if (args.includes("--json")) console.log(JSON.stringify({ runs, medians: rounded }, null, 2));
	else {
		console.log(`Settings, median of ${runs} (ms; shift is the layout-shift score)`);
		for (const [k, v] of Object.entries(rounded)) console.log(`  ${k.padEnd(28)} ${v}`);
	}
	if (args.includes("--update")) writeFileSync(floorPath, `${JSON.stringify(rounded, null, "\t")}\n`);
	if (args.includes("--check")) {
		const floor = JSON.parse(readFileSync(floorPath, "utf8"));
		for (const [k, base] of Object.entries(floor)) {
			const now = rounded[k];
			const limit = k.startsWith("shift:") ? base + 0.01 : Math.max(base, MIN_GATE_MS) * SLACK;
			if (now === undefined || now > limit) {
				console.error(`${k}: ${now} is over the floor ${base} (limit ${Math.round(limit * 1000) / 1000})`);
				failed = true;
			}
		}
		if (!failed) console.log("Within the floor.");
	}
} finally {
	await ctx.close();
	rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
