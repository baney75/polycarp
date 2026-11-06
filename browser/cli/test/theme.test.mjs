// Themed pages: every preset's text/background and accent/button-text pairs reach WCAG AA (4.5:1)
// in light and dark, a custom accent gets readable button text, and the consent page follows the theme.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { after, test } from "node:test";
import { machine, tempRoot, rmSync } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { pageCss } = await loadTs('export { pageCss } from "@src/theme.ts";');

const root = tempRoot("tabkyra-theme-");
after(() => rmSync(root, { recursive: true, force: true }));

const channel = (v) => {
	const x = v / 255;
	return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
function luminance(hex) {
	const n = Number.parseInt(hex.slice(1), 16);
	return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** The pairs a page draws: body text on the page and the card, muted text, the error color, button text on the accent. */
const PAIRS = [
	["text", "bg"],
	["text", "panel"],
	["muted", "panel"],
	["muted", "bg"],
	["danger", "panel"],
	["accentText", "accent"],
];

test("every preset reaches WCAG AA (4.5:1) for text and for button text, in light and dark", () => {
	const m = machine(root, "presets");
	const { presets, palettes } = m.json(["theme", "list", "--json"]);
	assert.deepEqual(presets, ["tabkyra", "slate", "forest", "rose", "midnight"]);
	for (const name of presets) {
		for (const mode of ["light", "dark"]) {
			const palette = palettes[name][mode];
			for (const [fg, bg] of PAIRS) {
				const ratio = contrast(palette[fg], palette[bg]);
				assert.ok(ratio >= 4.5, `${name} ${mode}: ${fg} ${palette[fg]} on ${bg} ${palette[bg]} is ${ratio.toFixed(2)}:1, below 4.5:1`);
			}
		}
	}
});

test("a custom accent gets button text that reaches 4.5:1 in both modes, for any color", () => {
	const m = machine(root, "accent");
	// Dark, light, saturated and mid-range colors: mid-range is where neither black nor white is obvious.
	for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#777777", "#808080", "#3b82f6", "#e3a93b", "#767676", "#ff6600", "#6a0dad"]) {
		const out = m.json(["theme", "accent", hex, "--json"]);
		assert.equal(out.accent, hex);
		for (const mode of ["light", "dark"]) {
			const { accent, accentText } = out.resolved[mode];
			assert.equal(accent, hex);
			const ratio = contrast(accentText, accent);
			assert.ok(ratio >= 4.5, `${hex} ${mode}: button text ${accentText} is ${ratio.toFixed(2)}:1`);
		}
	}
	assert.equal(m.run(["theme", "accent", "blue"]).code, 2, "an accent must be #rrggbb");
	assert.equal(m.run(["theme", "accent", "#12345"]).code, 2);
});

test("theme set, list and reset keep theme.json private and valid", () => {
	const m = machine(root, "set");
	assert.equal(m.json(["theme", "list", "--json"]).preset, "tabkyra");
	assert.equal(m.run(["theme", "set", "nope"]).code, 2);
	assert.equal(m.json(["theme", "set", "forest", "--json"]).preset, "forest");
	assert.deepEqual(JSON.parse(JSON.stringify(m.json(["theme", "list", "--json"]).preset)), "forest");
	m.json(["theme", "accent", "#112233", "--json"]);
	const saved = JSON.parse(readTheme(m));
	assert.deepEqual(saved, { preset: "forest", accent: "#112233" });
	assert.equal(m.json(["theme", "reset", "--json"]).preset, "tabkyra");
});

function readTheme(m) {
	const mode = statSync(m.file("theme.json")).mode & 0o777;
	assert.equal(mode, 0o600, "theme.json is private");
	return readFileSync(m.file("theme.json"), "utf8");
}

/** The variables of one pinned mode, read from the CSS a page gets. */
function pageVars(choice, mode) {
	const css = pageCss({ ...choice, mode });
	const block = /^:root\{color-scheme:[a-z]+;([^}]*)\}/.exec(css)?.[1] ?? "";
	return { css, vars: Object.fromEntries(block.split(";").map((d) => d.split(":"))) };
}

test("the pages' focus ring and control edges reach 3:1 on the page and the card: every preset, both modes, custom accents including #000000 and #ffffff", () => {
	for (const preset of ["tabkyra", "slate", "forest", "rose", "midnight"]) {
		for (const accent of [undefined, "#e3a93b", "#000000", "#ffffff", "#777777", "#3b82f6"]) {
			for (const mode of ["light", "dark"]) {
				const { css, vars } = pageVars({ preset, ...(accent ? { accent } : {}) }, mode);
				for (const shape of ["--ring", "--edge"]) {
					for (const surface of ["--bg", "--panel"]) {
						const ratio = contrast(vars[shape], vars[surface]);
						assert.ok(ratio >= 3, `${preset} ${accent ?? "preset"} ${mode}: ${shape} ${vars[shape]} on ${surface} ${vars[surface]} is ${ratio.toFixed(2)}:1`);
					}
				}
				assert.match(css, /focus-visible[^}]*outline:3px solid var\(--ring\)/);
				assert.match(css, /input\.secret\{[^}]*border:1px solid var\(--edge\)/);
				assert.match(css, /button\{[^}]*border:1px solid var\(--edge\)/);
			}
		}
	}
});

// ---------- the Polycarp theme ----------

const poly = await loadTs('export { polycarpState, loadPolycarpTheme, loadPolycarpPayload, polycarpThemeFile, polycarpConfigDir, themeCss, pageCss as pageCssDefault, runTheme, saveTheme } from "@src/theme.ts";');
const fixtureDir = new URL("../../test/fixtures/polycarp/", import.meta.url);
const BUILT_INS = ["polycarp", "still-water", "evening", "parchment", "blocks", "calm"];
const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, fixtureDir), "utf8"));

/** Run `fn` with the Polycarp and Polycarp config folders pointed at fresh temp folders; `file` is the theme.json text, or null for none. */
async function withPolycarp(file, fn) {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const dir = tempRoot("tabkyra-polycarp-");
	const saved = { p: process.env.POLYCARP_CONFIG_DIR, t: process.env.TABKYRA_CONFIG_DIR };
	process.env.POLYCARP_CONFIG_DIR = `${dir}/polycarp`;
	process.env.TABKYRA_CONFIG_DIR = `${dir}/tabkyra`;
	if (file !== null) {
		mkdirSync(`${dir}/polycarp/current`, { recursive: true });
		writeFileSync(`${dir}/polycarp/current/theme.json`, typeof file === "string" ? file : JSON.stringify(file));
	}
	try {
		return await fn(dir);
	} finally {
		for (const [k, v] of [["POLYCARP_CONFIG_DIR", saved.p], ["TABKYRA_CONFIG_DIR", saved.t]]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

function say(fn) {
	const lines = [];
	const log = console.log;
	console.log = (...a) => lines.push(a.join(" "));
	try {
		fn();
	} finally {
		console.log = log;
	}
	return lines.join("\n");
}

test("all six built-in Polycarp themes load and map their roles to the palette", async () => {
	for (const name of BUILT_INS) {
		const file = fixture(name);
		await withPolycarp(file, () => {
			const t = poly.loadPolycarpTheme();
			assert.ok(t, name);
			assert.equal(t.name, name);
			for (const mode of ["light", "dark"]) {
				const c = file.surfaces.browser[mode];
				assert.deepEqual(t.palettes[mode], { bg: c.background, panel: c.surface, text: c.foreground, muted: c.muted, border: c.border, accent: c.accent, accentText: c.on_accent, danger: c.urgent });
			}
		});
	}
});

test("the config folder is POLYCARP_CONFIG_DIR when absolute, else XDG_CONFIG_HOME/polycarp when absolute, else ~/.config/polycarp", () => {
	const keep = { p: process.env.POLYCARP_CONFIG_DIR, x: process.env.XDG_CONFIG_HOME };
	try {
		process.env.POLYCARP_CONFIG_DIR = "/abs/poly";
		assert.equal(poly.polycarpConfigDir(), "/abs/poly");
		process.env.POLYCARP_CONFIG_DIR = "relative/poly";
		process.env.XDG_CONFIG_HOME = "/abs/xdg";
		assert.equal(poly.polycarpConfigDir(), "/abs/xdg/polycarp");
		process.env.XDG_CONFIG_HOME = "rel-xdg";
		assert.match(poly.polycarpConfigDir(), /[\\/]\.config[\\/]polycarp$|Polycarp$/);
		assert.match(poly.polycarpThemeFile(), /current[\\/]theme\.json$/);
	} finally {
		for (const [k, v] of [["POLYCARP_CONFIG_DIR", keep.p], ["XDG_CONFIG_HOME", keep.x]]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("a missing or invalid Polycarp file means no theme, never a crash", async () => {
	const good = fixture("still-water");
	const edit = (fn) => {
		const copy = structuredClone(good);
		fn(copy);
		return copy;
	};
	const bad = {
		"no file": null,
		"not json": "{nope",
		"empty file": "",
		"an array": "[]",
		"wrong schema": edit((f) => { f.schema = 2; }),
		"no browser section": edit((f) => { delete f.surfaces.browser; }),
		"bad color": edit((f) => { f.surfaces.browser.light.accent = "teal"; }),
		"short color": edit((f) => { f.surfaces.browser.dark.border = "#fff"; }),
		"missing color": edit((f) => { delete f.surfaces.browser.dark.urgent; }),
		"radius too big": edit((f) => { f.surfaces.browser.shape.radius = 65; }),
		"radius fraction": edit((f) => { f.surfaces.browser.shape.radius = 4.5; }),
		"size too small": edit((f) => { f.surfaces.browser.type.size = 9; }),
		"duration too long": edit((f) => { f.surfaces.browser.motion.slow = 1001; }),
		"duration as text": edit((f) => { f.surfaces.browser.motion.fast = "120"; }),
		"reduced as text": edit((f) => { f.surfaces.browser.motion.reduced = "true"; }),
		"bad mode": edit((f) => { f.mode = "sepia"; }),
		"bad name": edit((f) => { f.name = "Still Water"; }),
		"font with url": edit((f) => { f.surfaces.browser.type.ui = "url(https://evil.example/x)"; }),
		"font with brace": edit((f) => { f.surfaces.browser.type.display = "Georgia}body{display:none"; }),
		"font with semicolon": edit((f) => { f.surfaces.browser.type.mono = "monospace; color:red"; }),
		"font with tag in quotes": edit((f) => { f.surfaces.browser.type.ui = '"</style>", serif'; }),
		"font with comment": edit((f) => { f.surfaces.browser.type.ui = '"a/*b", serif'; }),
		"font unclosed quote": edit((f) => { f.surfaces.browser.type.ui = '"Georgia, serif'; }),
		"font empty": edit((f) => { f.surfaces.browser.type.ui = ""; }),
		"easing script": edit((f) => { f.surfaces.browser.motion.easing = "ease; x"; }),
		"easing out of range": edit((f) => { f.surfaces.browser.motion.easing = "cubic-bezier(2, 0, 0, 1)"; }),
	};
	for (const [label, file] of Object.entries(bad)) {
		await withPolycarp(file, () => {
			assert.equal(poly.loadPolycarpTheme(), undefined, label);
			assert.equal(poly.loadPolycarpPayload(), undefined, label);
			assert.doesNotMatch(poly.pageCssDefault(), /evil|undefined/, label);
		});
	}
	await withPolycarp(good, () => assert.ok(poly.loadPolycarpTheme(), "the unedited file is valid"));
});

test("a directory or an oversized file at the theme path means no theme", async () => {
	await withPolycarp("x".repeat(300_000), () => assert.equal(poly.loadPolycarpTheme(), undefined));
	await withPolycarp(null, async (dir) => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(`${dir}/polycarp/current/theme.json`, { recursive: true });
		assert.equal(poly.loadPolycarpTheme(), undefined);
	});
});

test("a Polycarp theme takes priority over the saved choice on every page, and no file leaves the saved choice alone", async () => {
	const file = fixture("evening");
	await withPolycarp(null, () => {
		poly.saveTheme("forest", undefined, "dark");
		const before = poly.pageCssDefault();
		assert.match(before, /--accent:#7fd39a/);
		assert.doesNotMatch(before, new RegExp(file.surfaces.browser.dark.accent));
	});
	await withPolycarp(file, () => {
		poly.saveTheme("forest");
		const css = poly.pageCssDefault();
		const { light, dark } = file.surfaces.browser;
		assert.ok(css.includes(`--bg:${light.background}`) && css.includes(`--accent:${dark.accent}`), "both palettes of the Polycarp theme");
		assert.doesNotMatch(css, /#7fd39a/, "the saved forest preset is not used");
		assert.match(css, /@media \(prefers-color-scheme:dark\)/, "auto with no saved mode follows the system");
		assert.match(css, /body\{font-family:[^}]*font-size:16px\}main\{border-radius:10px\}/);
		// An explicit choice still draws that choice (the tests and the panel's own preview rely on it).
		assert.match(poly.themeCss({ preset: "forest" }), /#7fd39a/);
	});
});

test("a theme whose mode is light or dark pins the pages", async () => {
	for (const mode of ["light", "dark"]) {
		const file = fixture("calm");
		file.mode = mode;
		await withPolycarp(file, () => {
			const css = poly.themeCss();
			assert.match(css, new RegExp(`^:root\\{color-scheme:${mode};`));
			assert.doesNotMatch(css, /prefers-color-scheme/);
			assert.ok(css.includes(`--bg:${file.surfaces.browser[mode].background}`));
		});
	}
});

test("polycarp browser theme list and set say when a Polycarp theme is in force", async () => {
	await withPolycarp(fixture("parchment"), () => {
		const list = say(() => assert.equal(poly.runTheme(["list"], false), 0));
		assert.match(list, /Polycarp theme is in force: parchment/);
		assert.match(list, /polycarp theme set/);
		const set = say(() => assert.equal(poly.runTheme(["set", "rose"], false), 0));
		assert.match(set, /Theme is rose/);
		assert.match(set, /Polycarp theme parchment is in force and takes priority/);
		const json = JSON.parse(say(() => poly.runTheme(["list"], true)));
		assert.deepEqual(json.polycarp, { name: "parchment", title: "Parchment", mode: "auto" });
		assert.equal(json.preset, "rose", "the saved choice is kept");
	});
	await withPolycarp(null, () => {
		const list = say(() => poly.runTheme(["list"], false));
		assert.doesNotMatch(list, /Polycarp/);
		assert.doesNotMatch(say(() => poly.runTheme(["set", "rose"], false)), /Polycarp/);
	});
});

test("a hand-edited file with white text on white backgrounds is no theme: not loaded, not sent to the panel", async () => {
	const file = structuredClone(fixture("calm"));
	for (const mode of ["light", "dark"]) {
		for (const role of Object.keys(file.surfaces.browser[mode])) file.surfaces.browser[mode][role] = "#ffffff";
	}
	await withPolycarp(file, () => {
		assert.equal(poly.loadPolycarpTheme(), undefined);
		assert.equal(poly.loadPolycarpPayload(), undefined);
		assert.doesNotMatch(poly.themeCss(), /--text:#ffffff/);
	});
});

test("a Polycarp theme's base size is set on the root element of the pages, and no theme leaves the root alone", async () => {
	const file = structuredClone(fixture("calm"));
	file.surfaces.browser.type.size = 24;
	await withPolycarp(file, () => assert.match(poly.pageCssDefault(), /html\{font-size:24px\}/));
	await withPolycarp(null, () => assert.doesNotMatch(poly.pageCssDefault(), /html\{font-size/));
});

test("with mode auto the pages follow a saved `polycarp browser theme` mode, else the system setting, the way the panel does", async () => {
	const file = structuredClone(fixture("calm"));
	file.mode = "auto";
	await withPolycarp(file, () => {
		assert.match(poly.themeCss(), /prefers-color-scheme:dark/, "no saved mode: the media query");
		for (const mode of ["light", "dark"]) {
			poly.saveTheme(undefined, undefined, mode);
			const css = poly.themeCss();
			assert.match(css, new RegExp(`^:root\\{color-scheme:${mode};`));
			assert.doesNotMatch(css, /prefers-color-scheme/);
			assert.ok(css.includes(`--bg:${file.surfaces.browser[mode].background}`));
		}
		poly.saveTheme(undefined, undefined, "system");
		assert.match(poly.themeCss(), /prefers-color-scheme:dark/);
	});
});

test("a file that is there but refused is told apart from no file, with the reason, in the reader and in polycarp browser theme list (text and --json)", async () => {
	await withPolycarp(null, () => {
		assert.deepEqual(poly.polycarpState(), { state: "absent" });
		assert.doesNotMatch(say(() => poly.runTheme(["list"], false)), /refused/);
	});
	const white = structuredClone(fixture("calm"));
	for (const mode of ["light", "dark"]) for (const role of Object.keys(white.surfaces.browser[mode])) white.surfaces.browser[mode][role] = "#ffffff";
	const wrongSchema = { ...fixture("calm"), schema: 2 };
	const cases = [["{nope", /not valid JSON/], [white, /calm would be unreadable: light foreground on background is 1\.00:1/], [wrongSchema, /not a valid theme\.json for Polycarp/]];
	for (const [file, reason] of cases) {
		await withPolycarp(file, () => {
			const state = poly.polycarpState();
			assert.equal(state.state, "refused");
			assert.match(state.reason, reason);
			const text = say(() => poly.runTheme(["list"], false));
			assert.match(text, /The Polycarp theme was refused, so the saved choice below is used: /);
			assert.match(text, /\* tabkyra/, "the saved preset is still listed");
			const json = JSON.parse(say(() => poly.runTheme(["list"], true)));
			assert.match(json.polycarpRefused, reason);
			assert.equal("polycarp" in json, false);
		});
	}
});
