// The side panel asks the helper for the Polycarp theme when it opens and every 5 s while it is visible,
// applies a new or changed theme with no reload, pins light or dark without saving it, goes quiet while
// hidden, and keeps today's look when the helper is missing or answers nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/polycarp/${name}.json`, import.meta.url), "utf8"));
const payload = (file) => ({ schema: 1, name: file.name, title: file.title, mode: file.mode, surfaces: { browser: file.surfaces.browser } });

// The connect client keeps its port for the life of the module, so one port answers for whichever test is running.
let live;
const port = {
	postMessage(m) {
		live.asked.push(m);
		if (live.helper.down) return;
		queueMicrotask(() => port.listener({ id: m.id, result: live.helper.reply }));
	},
	onMessage: { addListener: (f) => (port.listener = f) },
	onDisconnect: { addListener() {} },
};

/** A page with just enough DOM for the appearance code, and a helper whose status reply the test sets. */
function setup(t) {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const classes = new Set();
	const props = new Map();
	const attrs = new Set();
	const handlers = {};
	const store = new Map();
	const local = new Map([["tabkyra.appearance", { preset: "slate" }]]);
	const asked = [];
	const helper = { reply: { route: "none", passcodeSet: false, theme: { preset: "tabkyra" } }, down: false };
	const root = {
		classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
		style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
		toggleAttribute: (name, on) => (on ? attrs.add(name) : attrs.delete(name)),
	};
	const doc = { visibilityState: "visible", documentElement: root, addEventListener: (type, f) => (handlers[type] = f) };
	const win = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
	const prior = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage, chrome: globalThis.chrome, MutationObserver: globalThis.MutationObserver };
	Object.assign(globalThis, {
		document: doc,
		window: win,
		MutationObserver: class {
			observe() {}
		},
		localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
		chrome: {
			storage: {
				local: {
					get: async (keys) => Object.fromEntries([keys].flat().filter((k) => local.has(k)).map((k) => [k, local.get(k)])),
					set: async (items) => Object.entries(items).forEach(([k, v]) => local.set(k, v)),
					remove: async (keys) => [keys].flat().forEach((k) => local.delete(k)),
				},
			},
			runtime: {
				connect: () => port,
			},
		},
	});
	t.after(() => {
		for (const [k, v] of Object.entries(prior)) {
			if (v === undefined) delete globalThis[k];
			else globalThis[k] = v;
		}
	});
	const page = { local, classes, props, attrs, handlers, store, asked, helper, doc };
	live = page;
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	};
	return { ...page, flush };
}

test("a theme from the helper applies at once, again on a change, and goes away when the file does, with no reload", async (t) => {
	const page = setup(t);
	const apply = await import("../src/appearance/apply.ts?live");
	await apply.startAppearance();
	await page.flush();
	assert.equal(page.props.get("--background"), "#f1f5f9", "no theme: the saved slate preset");
	assert.equal(page.props.has("--tk-motion-fast"), false);
	assert.equal(apply.currentPolycarp(), undefined);

	page.helper.reply = { ...page.helper.reply, polycarp: payload(fixture("still-water")) };
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.equal(apply.currentPolycarp()?.name, "still-water");
	assert.equal(page.props.get("--background"), "#f1f5f5");
	assert.equal(page.props.get("--radius"), "10px");
	assert.equal(page.props.get("--tk-motion-normal"), "200ms");

	page.helper.reply = { ...page.helper.reply, polycarp: payload(fixture("blocks")) };
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.equal(apply.currentPolycarp()?.name, "blocks");
	assert.equal(page.props.get("--radius"), "0px");

	delete page.helper.reply.polycarp;
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.equal(apply.currentPolycarp(), undefined);
	assert.equal(page.props.get("--background"), "#f1f5f9", "the saved preset is back");
	assert.equal(page.props.has("--radius"), false);
	assert.equal(page.props.has("--tk-font-size"), false);
});

test("the panel asks when it opens, every 5 s while visible, and not at all while hidden", async (t) => {
	const page = setup(t);
	const apply = await import("../src/appearance/apply.ts?poll");
	await apply.startAppearance();
	await page.flush();
	const count = () => page.asked.filter((m) => m.method === "status").length;
	const opened = count();
	assert.ok(opened >= 1, "asked on open");
	t.mock.timers.tick(5000);
	await page.flush();
	assert.equal(count(), opened + 1);
	t.mock.timers.tick(5000);
	await page.flush();
	t.mock.timers.tick(5000);
	await page.flush();
	assert.equal(count(), opened + 3);

	page.doc.visibilityState = "hidden";
	page.handlers.visibilitychange();
	t.mock.timers.tick(60_000);
	await page.flush();
	assert.equal(count(), opened + 3, "nothing while hidden");

	page.doc.visibilityState = "visible";
	page.handlers.visibilitychange();
	await page.flush();
	assert.equal(count(), opened + 4, "asks again at once when shown");
});

test("a theme that fixes light or dark pins the panel without saving it; auto leaves the person's setting", async (t) => {
	const page = setup(t);
	const apply = await import("../src/appearance/apply.ts?pin");
	await apply.startAppearance();
	await page.flush();
	const file = fixture("calm");
	file.mode = "dark";
	page.helper.reply = { ...page.helper.reply, polycarp: payload(file) };
	t.mock.timers.tick(5000);
	await page.flush();
	assert.equal(page.classes.has("dark"), true);
	assert.equal(page.props.get("--background"), file.surfaces.browser.dark.background);
	assert.equal(page.store.has("theme"), false, "the person's own light/dark setting is not written");

	// Back to auto: the person's setting (system, light here) decides again.
	file.mode = "auto";
	page.helper.reply = { ...page.helper.reply, polycarp: payload(file) };
	t.mock.timers.tick(5000);
	await page.flush();
	assert.equal(page.classes.has("dark"), false);
	assert.equal(page.props.get("--background"), file.surfaces.browser.light.background);
});

test("reduced motion sets the panel's reduced-motion flag; an invalid theme from the helper is no theme", async (t) => {
	const page = setup(t);
	const apply = await import("../src/appearance/apply.ts?reduced");
	await apply.startAppearance();
	await page.flush();
	page.helper.reply = { ...page.helper.reply, polycarp: payload(fixture("calm")) };
	t.mock.timers.tick(5000);
	await page.flush();
	assert.equal(page.attrs.has("data-tk-reduced-motion"), true);
	assert.equal(page.props.get("--tk-motion-fast"), "0ms");

	const broken = payload(fixture("calm"));
	broken.surfaces.browser.type.ui = "url(https://evil.example)";
	page.helper.reply = { ...page.helper.reply, polycarp: broken };
	t.mock.timers.tick(5000);
	await page.flush();
	assert.equal(apply.currentPolycarp(), undefined);
	assert.equal(page.attrs.has("data-tk-reduced-motion"), false);
});

test("with no helper, or one that never answers, the panel keeps today's look and does not pile up requests", async (t) => {
	const page = setup(t);
	page.helper.down = true;
	const apply = await import("../src/appearance/apply.ts?down");
	await apply.startAppearance();
	await page.flush();
	t.mock.timers.tick(5000);
	t.mock.timers.tick(5000);
	await page.flush();
	assert.equal(apply.currentPolycarp(), undefined);
	assert.equal(page.props.get("--background"), "#f1f5f9");
	assert.equal(page.asked.filter((m) => m.method === "status").length, 1, "one question at a time while the first is unanswered");
});

test("the last valid theme is cached, applied before the first paint and replaced or cleared when the helper answers", async (t) => {
	const page = setup(t);
	page.helper.down = true;
	page.local.set("tabkyra.polycarp", payload(fixture("blocks")));
	const apply = await import("../src/appearance/apply.ts?cache");
	await apply.startAppearance();
	assert.equal(apply.currentPolycarp()?.name, "blocks", "applied from the cache before the helper answered");
	assert.equal(page.props.get("--radius"), "0px");

	t.mock.timers.tick(60_000); // the unanswered first question times out
	await page.flush();
	page.helper.down = false;
	page.helper.reply = { ...page.helper.reply, polycarp: payload(fixture("still-water")) };
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.equal(apply.currentPolycarp()?.name, "still-water");
	assert.equal(page.local.get("tabkyra.polycarp").name, "still-water", "replaced");

	delete page.helper.reply.polycarp;
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.equal(page.local.has("tabkyra.polycarp"), false, "cleared when the host has no theme");
});

test("a cached payload that no longer parses is ignored: the first paint is today's", async (t) => {
	const page = setup(t);
	page.helper.down = true;
	const bad = payload(fixture("blocks"));
	for (const mode of ["light", "dark"]) for (const role of Object.keys(bad.surfaces.browser[mode])) bad.surfaces.browser[mode][role] = "#ffffff";
	page.local.set("tabkyra.polycarp", bad);
	const apply = await import("../src/appearance/apply.ts?badcache");
	await apply.startAppearance();
	assert.equal(apply.currentPolycarp(), undefined);
	assert.equal(page.props.get("--background"), "#f1f5f9");
});

test("a refused theme keeps the saved preset and the reason is held for the Appearance tab, from the helper or from the panel's own check", async (t) => {
	const page = setup(t);
	const apply = await import("../src/appearance/apply.ts?refused");
	await apply.startAppearance();
	await page.flush();
	assert.equal(apply.currentPolycarpRefusal(), undefined);

	page.helper.reply = { ...page.helper.reply, polycarpRefused: "theme.json is not valid JSON" };
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.equal(apply.currentPolycarpRefusal(), "theme.json is not valid JSON");
	assert.equal(apply.currentPolycarp(), undefined);
	assert.equal(page.props.get("--background"), "#f1f5f9", "the saved slate preset stays");

	const bad = payload(fixture("blocks"));
	for (const mode of ["light", "dark"]) for (const role of Object.keys(bad.surfaces.browser[mode])) bad.surfaces.browser[mode][role] = "#ffffff";
	page.helper.reply = { ...page.helper.reply, polycarp: bad };
	delete page.helper.reply.polycarpRefused;
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.match(apply.currentPolycarpRefusal(), /unreadable/);
	assert.equal(page.props.get("--background"), "#f1f5f9");

	page.helper.reply = { ...page.helper.reply, polycarp: payload(fixture("blocks")) };
	t.mock.timers.tick(apply.POLYCARP_POLL_MS);
	await page.flush();
	assert.equal(apply.currentPolycarpRefusal(), undefined, "a good theme clears it");
});
