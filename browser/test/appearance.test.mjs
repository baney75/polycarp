// The side panel's colors come from the same presets as the approval and hub pages. Every pair of
// text on a background the panel draws reaches WCAG AA (4.5:1) for every preset, in light and dark,
// and for custom accents, computed from the CSS variables the panel actually sets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { contrast, mix, PRESETS } from "../src/appearance/palettes.ts";
import { checkPolycarpTheme, isEasing, isFontStack, parsePolycarpTheme, polycarpPayload } from "../src/appearance/polycarp.ts";
import { appearanceVariables, effectiveAccent, parseChoice, SHAPE_PAIRS, TEXT_PAIRS } from "../src/appearance/tokens.ts";

const check = (choice, label) => {
	for (const dark of [false, true]) {
		const vars = appearanceVariables(choice, dark);
		for (const [fg, bg] of TEXT_PAIRS) {
			assert.ok(vars[fg] && vars[bg], `${label}: ${fg} or ${bg} is not set`);
			const ratio = contrast(vars[fg], vars[bg]);
			assert.ok(ratio >= 4.5, `${label} ${dark ? "dark" : "light"}: ${fg} ${vars[fg]} on ${bg} ${vars[bg]} is ${ratio.toFixed(2)}:1, below 4.5:1`);
		}
		// Shapes that must stand apart from the page: the selected Settings chip, the focus ring.
		for (const [shape, bg] of SHAPE_PAIRS) {
			const ratio = contrast(vars[shape], vars[bg]);
			assert.ok(ratio >= 3, `${label} ${dark ? "dark" : "light"}: ${shape} ${vars[shape]} on ${bg} ${vars[bg]} is ${ratio.toFixed(2)}:1, below 3:1`);
		}
	}
};

test("every preset reaches 4.5:1 for body text and for text on the accent, in light and dark", () => {
	assert.deepEqual(Object.keys(PRESETS), ["tabkyra", "slate", "forest", "rose", "midnight"]);
	for (const preset of Object.keys(PRESETS)) check({ preset }, preset);
});

test("a custom accent keeps every pair readable, for light, dark and mid colors", () => {
	for (const accent of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#777777", "#808080", "#767676", "#3b82f6", "#e3a93b", "#ff6600", "#6a0dad", "#ffff00"]) {
		for (const preset of Object.keys(PRESETS)) check({ preset, accent }, `${preset} + ${accent}`);
	}
});

test("the focus ring stays visible (3:1) against the page, for every preset, in light and dark", () => {
	for (const preset of Object.keys(PRESETS)) {
		for (const dark of [false, true]) {
			const vars = appearanceVariables({ preset }, dark);
			const ratio = contrast(vars["--ring"], vars["--background"]);
			assert.ok(ratio >= 3, `${preset} ${dark ? "dark" : "light"}: ring ${vars["--ring"]} on ${vars["--background"]} is ${ratio.toFixed(2)}:1`);
		}
	}
});

test("the selected Settings chip is filled in the body text color, with the page color as its text", () => {
	for (const preset of Object.keys(PRESETS)) {
		for (const dark of [false, true]) {
			const vars = appearanceVariables({ preset, accent: "#e3a93b" }, dark);
			const palette = PRESETS[preset][dark ? "dark" : "light"];
			assert.equal(vars["--tk-selected"], palette.text);
			assert.equal(vars["--tk-on-selected"], palette.bg);
			// The accent can't make the chip fade into the page: a pale accent leaves it unchanged.
			assert.ok(contrast(vars["--tk-selected"], vars["--background"]) >= 4.5);
		}
	}
});

// The color box and the swatches once showed black (#000000) until a custom accent was set, because
// the default was a literal, not the accent in use. The accent in use is the custom one, else the preset's.
test("the accent in use is the custom one, else the preset's own in this mode, never a placeholder black", () => {
	for (const preset of Object.keys(PRESETS)) {
		for (const dark of [false, true]) {
			const own = PRESETS[preset][dark ? "dark" : "light"].accent;
			assert.equal(effectiveAccent({ preset }, dark), own);
			assert.notEqual(effectiveAccent({ preset }, dark), "#000000");
			assert.equal(effectiveAccent({ preset, accent: "#d6336c" }, dark), "#d6336c");
		}
	}
	assert.equal(effectiveAccent({ preset: "forest" }, false), "#1f6a3a");
	assert.equal(effectiveAccent({ preset: "midnight" }, true), "#9aa2ff");
});

test("the Appearance tab binds the color box and the hex box to the accent in use, with a hint rather than a value as placeholder", () => {
	const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dialogs", "AppearanceTab.ts"), "utf8");
	assert.match(text, /effectiveAccent\(choice, this\.isDark\(\)\)/);
	assert.match(text, /type="color"[\s\S]{0,200}\.value=\$\{hex\}/);
	assert.match(text, /\.value=\$\{shown\}/);
	assert.doesNotMatch(text, /\?\? "#000000"/);
	assert.match(text, /placeholder="e\.g\. #3b82f6"/);
});

test("the variables cover mini-lit's tokens, are all #rrggbb, and the accent shows up as the primary color", () => {
	for (const dark of [false, true]) {
		const vars = appearanceVariables({ preset: "forest" }, dark);
		for (const name of ["--background", "--foreground", "--card", "--popover", "--primary", "--primary-foreground", "--secondary", "--muted", "--muted-foreground", "--accent", "--destructive", "--border", "--input", "--ring"]) {
			assert.match(vars[name], /^#[0-9a-f]{6}$/, name);
		}
		assert.equal(vars["--primary"], PRESETS.forest[dark ? "dark" : "light"].accent);
	}
	assert.equal(appearanceVariables({ preset: "slate", accent: "#abcdef" }, false)["--primary"], "#abcdef");
});

test("a saved choice that isn't one falls back to the default", () => {
	assert.deepEqual(parseChoice(undefined), { preset: "tabkyra" });
	assert.deepEqual(parseChoice({ preset: "<script>", accent: "red" }), { preset: "tabkyra" });
	assert.deepEqual(parseChoice({ preset: "rose", accent: "#ABCDEF" }), { preset: "rose", accent: "#abcdef" });
	// An unknown but well-formed name resolves to the default palette.
	assert.equal(appearanceVariables(parseChoice({ preset: "nope" }), false)["--background"], PRESETS.tabkyra.light.bg);
});

test("control edges (text boxes, the off switch's track) reach 3:1 against the page and the card, in every preset and mode", () => {
	assert.ok(SHAPE_PAIRS.some(([a, b]) => a === "--input" && b === "--background"));
	assert.ok(SHAPE_PAIRS.some(([a, b]) => a === "--input" && b === "--card"));
	for (const preset of Object.keys(PRESETS)) {
		for (const accent of [undefined, "#e3a93b", "#000000", "#ffffff"]) {
			for (const dark of [false, true]) {
				const vars = appearanceVariables({ preset, ...(accent ? { accent } : {}) }, dark);
				for (const surface of ["--background", "--card"]) {
					const ratio = contrast(vars["--input"], vars[surface]);
					assert.ok(ratio >= 3, `${preset} ${dark ? "dark" : "light"}: --input ${vars["--input"]} on ${surface} ${vars[surface]} is ${ratio.toFixed(2)}:1`);
				}
				// --border stays the soft divider; only controls got the stronger edge.
				assert.equal(vars["--border"], PRESETS[preset][dark ? "dark" : "light"].border);
			}
		}
	}
});

test("error text (--destructive) is checked as text on the page and the card, and the off switch track is the control edge", () => {
	assert.ok(TEXT_PAIRS.some(([a, b]) => a === "--destructive" && b === "--background"));
	assert.ok(TEXT_PAIRS.some(([a, b]) => a === "--destructive" && b === "--card"));
	const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app.css"), "utf8");
	assert.doesNotMatch(css, /--tk-control-off:\s*color-mix/);
	assert.equal((css.match(/--tk-control-off:\s*var\(--input\)/g) ?? []).length, 2, "light and dark both draw the track from --input");
});

test("the color box paints on input and saves and tells the helper only on change", () => {
	const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dialogs", "AppearanceTab.ts"), "utf8");
	const box = /type="color"[\s\S]*?\/>/.exec(text)?.[0] ?? "";
	const onInput = /@input=\$\{[\s\S]*?\n\t{7}\}\}/.exec(box)?.[0] ?? "";
	assert.match(onInput, /previewAppearance\(/);
	assert.doesNotMatch(onInput, /this\.choose\(|setAppearance\(|connectSetTheme\(/);
	assert.match(box, /@change=\$\{[\s\S]*?this\.choose\(/);
});

test("the on switch and the accent-colored controls follow the preset: --tk-control-on reaches 3:1 on the page and the card for every preset, mode and accent", () => {
	assert.ok(SHAPE_PAIRS.some(([a, b]) => a === "--tk-control-on" && b === "--background"));
	assert.ok(SHAPE_PAIRS.some(([a, b]) => a === "--tk-control-on" && b === "--card"));
	for (const preset of Object.keys(PRESETS)) {
		for (const accent of [undefined, "#000000", "#ffffff", "#1b1b1b"]) {
			for (const dark of [false, true]) {
				const vars = appearanceVariables({ preset, ...(accent ? { accent } : {}) }, dark);
				assert.equal(vars["--tk-brass-deep"], vars["--tk-control-on"]);
				assert.equal(vars["accent-color"], vars["--tk-control-on"]);
			}
		}
	}
});

// The Ask card's primary button and checked marks draw on --tk-brass; their text once stayed a fixed ink
// whatever the accent was. Read the rules from app.css and resolve them against the panel's variables.
test("rendered consumers of --tk-brass (Ask primary button, its hover, checked marks) reach 4.5:1 for every preset, mode and custom accent, mid-gray included", () => {
	const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app.css"), "utf8");
	const decl = (selector, prop) => {
		const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.:()[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
		assert.ok(rule, `no rule for ${selector}`);
		const value = new RegExp(`${prop}:\\s*([^;]+);`).exec(rule[1]);
		assert.ok(value, `${selector} sets no ${prop}`);
		return value[1].trim();
	};
	const resolve = (value, vars) => {
		const v = /^var\((--[\w-]+)\)$/.exec(value);
		if (v) return vars[v[1]] ?? assert.fail(`${v[1]} is not set by appearance`);
		const m = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*(\d+)%,\s*var\((--[\w-]+)\)\)$/.exec(value);
		if (m) return mix(resolve(`var(${m[1]})`, vars), resolve(`var(${m[3]})`, vars), 1 - Number(m[2]) / 100);
		assert.fail(`cannot resolve ${value}`);
	};
	const consumers = [
		[".tk-ask-btn-primary", "color", ".tk-ask-btn-primary", "background"],
		[".tk-ask-btn-primary", "color", ".tk-ask-btn-primary:hover:not(:disabled)", "background"],
		[".tk-ask-mark", "color", ".tk-ask-mark[aria-checked=\"true\"]", "background"],
	];
	assert.equal(consumers.length, 3);
	for (const preset of Object.keys(PRESETS)) {
		for (const accent of [undefined, "#000000", "#ffffff", "#6b6b6b", "#777777", "#808080", "#8a8a8a", "#959595"]) {
			for (const dark of [false, true]) {
				const vars = appearanceVariables({ preset, ...(accent ? { accent } : {}) }, dark);
				for (const [fgSel, fgProp, bgSel, bgProp] of consumers) {
					const fg = resolve(decl(fgSel, fgProp), vars);
					const bg = resolve(decl(bgSel, bgProp), vars);
					const ratio = contrast(fg, bg);
					assert.ok(ratio >= 4.5, `${preset}${accent ? ` + ${accent}` : ""} ${dark ? "dark" : "light"}: ${bgSel} text ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
				}
			}
		}
	}
	assert.doesNotMatch(css, /\.tk-ask-btn-primary\s*\{[^}]*var\(--tk-ink\)/);
});

test("a mode change sends only the mode, and a first load takes the helper's saved theme", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
	const tab = readFileSync(join(root, "dialogs", "AppearanceTab.ts"), "utf8");
	assert.match(tab, /connectSetTheme\(\{ mode: value \}\)/);
	assert.doesNotMatch(tab, /accent \?\? null/, "accent:null is sent only when the person cleared the accent");
	const apply = readFileSync(join(root, "appearance", "apply.ts"), "utf8");
	assert.match(apply, /connectStatus\(\)/);
	assert.match(apply, /if \(!saved\) void seedFromHelper\(\)/);
});

test("picking a preset when the panel's choice has no accent sends accent: null, so theme.json matches", () => {
	const tab = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dialogs", "AppearanceTab.ts"), "utf8");
	assert.match(tab, /this\.choose\(name, choice\.accent, !choice\.accent\)/);
	assert.match(tab, /clearedAccent \? \{ accent: null \}/);
});

// ---------- Polycarp themes ----------

const BUILT_INS = ["polycarp", "still-water", "evening", "parchment", "blocks", "calm"];
const fixtureFile = (name) => JSON.parse(readFileSync(new URL(`./fixtures/polycarp/${name}.json`, import.meta.url), "utf8"));

test("with no Polycarp theme, appearanceVariables is byte for byte what origin/main produced, for every preset, accent and mode", () => {
	const snapshot = JSON.parse(readFileSync(new URL("./fixtures/appearance-main.snapshot.json", import.meta.url), "utf8"));
	let seen = 0;
	for (const preset of Object.keys(PRESETS)) {
		for (const accent of [undefined, "#3b82f6"]) {
			for (const dark of [false, true]) {
				const key = `${preset}|${accent ?? "none"}|${dark ? "dark" : "light"}`;
				const choice = { preset, ...(accent ? { accent } : {}) };
				assert.equal(JSON.stringify(appearanceVariables(choice, dark)), JSON.stringify(snapshot[key]), key);
				assert.equal(JSON.stringify(appearanceVariables(choice, dark, undefined)), JSON.stringify(snapshot[key]), `${key} (undefined theme)`);
				seen++;
			}
		}
	}
	assert.equal(seen, Object.keys(snapshot).length, "the snapshot covers exactly these");
});

test("all six built-in Polycarp themes parse, and their roles map to the panel's palette and tokens", () => {
	for (const name of BUILT_INS) {
		const file = fixtureFile(name);
		const theme = parsePolycarpTheme(file);
		assert.ok(theme, name);
		assert.equal(theme.name, name);
		assert.equal(theme.mode, file.mode);
		for (const dark of [false, true]) {
			const c = file.surfaces.browser[dark ? "dark" : "light"];
			const vars = appearanceVariables({ preset: "slate" }, dark, theme);
			assert.equal(vars["--background"], c.background, `${name} bg`);
			assert.equal(vars["--card"], c.surface);
			assert.equal(vars["--popover"], c.surface);
			assert.equal(vars["--foreground"], c.foreground);
			assert.equal(vars["--muted-foreground"], c.muted);
			assert.equal(vars["--border"], c.border);
			assert.equal(vars["--primary"], c.accent);
			assert.equal(vars["--primary-foreground"], c.on_accent);
			assert.equal(vars["--tk-on-brass"], c.on_accent);
			assert.equal(vars["--destructive"], c.urgent);
			assert.equal(effectiveAccent({ preset: "slate" }, dark, theme), c.accent);
			// The saved preset and accent do not matter while a theme is in force.
			assert.deepEqual(appearanceVariables({ preset: "rose", accent: "#123456" }, dark, theme), vars);
		}
		const { shape, type, motion } = file.surfaces.browser;
		const vars = appearanceVariables({ preset: "tabkyra" }, false, theme);
		assert.equal(vars["--radius"], `${shape.radius}px`);
		assert.equal(vars["--tk-radius-sm"], `${shape.radius_small}px`);
		assert.equal(vars["--tk-radius-lg"], `${shape.radius_large}px`);
		assert.equal(vars["--font-sans"], type.ui);
		assert.equal(vars["--font-serif"], type.display);
		assert.equal(vars["--font-mono"], type.mono);
		assert.equal(vars["--tk-font-size"], `${type.size}px`);
		const zero = (n) => `${motion.reduced ? 0 : n}ms`;
		assert.equal(vars["--tk-motion-fast"], zero(motion.fast));
		assert.equal(vars["--tk-motion-normal"], zero(motion.normal));
		assert.equal(vars["--tk-motion-slow"], zero(motion.slow));
		assert.equal(vars["--tk-ease"], motion.easing);
	}
});

test("reduced motion makes every exported duration 0", () => {
	const file = fixtureFile("still-water");
	file.surfaces.browser.motion.reduced = true;
	const vars = appearanceVariables({ preset: "tabkyra" }, false, parsePolycarpTheme(file));
	assert.deepEqual([vars["--tk-motion-fast"], vars["--tk-motion-normal"], vars["--tk-motion-slow"]], ["0ms", "0ms", "0ms"]);
});

test("every text pair the panel draws reaches WCAG AA, and every shape 3:1, for all six Polycarp themes in light and dark", () => {
	for (const name of BUILT_INS) {
		const theme = parsePolycarpTheme(fixtureFile(name));
		for (const dark of [false, true]) {
			const vars = appearanceVariables({ preset: "tabkyra" }, dark, theme);
			const label = `${name} ${dark ? "dark" : "light"}`;
			for (const [fg, bg] of TEXT_PAIRS) {
				const ratio = contrast(vars[fg], vars[bg]);
				assert.ok(ratio >= 4.5, `${label}: ${fg} ${vars[fg]} on ${bg} ${vars[bg]} is ${ratio.toFixed(2)}:1, below 4.5:1`);
			}
			for (const [shape, bg] of SHAPE_PAIRS) {
				const ratio = contrast(vars[shape], vars[bg]);
				assert.ok(ratio >= 3, `${label}: ${shape} ${vars[shape]} on ${bg} ${vars[bg]} is ${ratio.toFixed(2)}:1, below 3:1`);
			}
		}
	}
});

test("the panel refuses a Polycarp theme that is not exactly right", () => {
	const good = fixtureFile("evening");
	const edit = (fn) => {
		const copy = structuredClone(good);
		fn(copy);
		return copy;
	};
	assert.ok(parsePolycarpTheme(good));
	for (const [label, bad] of Object.entries({
		null: null,
		string: "x",
		array: [],
		"schema 2": edit((f) => { f.schema = 2; }),
		"no browser": edit((f) => { delete f.surfaces.browser; }),
		"bad color": edit((f) => { f.surfaces.browser.light.muted = "grey"; }),
		"radius -1": edit((f) => { f.surfaces.browser.shape.radius = -1; }),
		"size 25": edit((f) => { f.surfaces.browser.type.size = 25; }),
		"NaN-ish duration": edit((f) => { f.surfaces.browser.motion.fast = null; }),
		"font url": edit((f) => { f.surfaces.browser.type.mono = "url(x)"; }),
		"font braces": edit((f) => { f.surfaces.browser.type.ui = "a{b}"; }),
		"easing text": edit((f) => { f.surfaces.browser.motion.easing = "ease-in; x"; }),
		"title with newline": edit((f) => { f.title = "a\nb"; }),
	})) {
		assert.equal(parsePolycarpTheme(bad), undefined, label);
	}
	// The stacks the built-in themes use, and Unicode family names, are fine.
	assert.equal(isFontStack('Newsreader, "Iowan Old Style", Georgia, serif'), true);
	assert.equal(isFontStack("Noto Sans JP, Hiragino-Sans, my_font"), true);
	assert.equal(isFontStack("a,,b"), false);
	assert.equal(isFontStack("a, 'b\\c'"), false);
	assert.equal(isEasing("cubic-bezier(0.2, 0, 0, 1)"), true);
	assert.equal(isEasing("cubic-bezier(0.2, 0, 1.5, 1)"), false);
	assert.equal(isEasing("cubic-bezier(0.2, 0, 0)"), false);
});

test("the payload the helper sends carries only Tabkyra's section, and the panel parses it back to the same theme", () => {
	const file = fixtureFile("blocks");
	const payload = polycarpPayload(file);
	assert.deepEqual(Object.keys(payload.surfaces), ["browser"]);
	assert.deepEqual(parsePolycarpTheme(payload), parsePolycarpTheme(file));
	assert.equal(polycarpPayload({ ...file, schema: 3 }), undefined);
});

test("the Appearance tab says which Polycarp theme is in use, how to change it, and keeps every control", () => {
	const tab = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dialogs", "AppearanceTab.ts"), "utf8");
	assert.match(tab, /Polycarp theme in use: \$\{polycarp\.title\}/);
	assert.match(tab, /data-polycarp-theme=\$\{polycarp\.name\}/);
	assert.match(tab, /polycarp theme set &lt;name&gt;/);
	assert.match(tab, /onPolycarp\(\(\) => this\.requestUpdate\(\)\)/, "the tab redraws when the theme changes");
	// Dimmed, not removed: the presets, the accent box and the mode radios are all still drawn.
	assert.match(tab, /class="space-y-2 \$\{overridden\}" role="group" aria-label="Color preset"/);
	assert.match(tab, /id="tk-accent-text"/);
	assert.match(tab, /name="tk-mode"/);
	assert.match(tab, /modeOverridden/);
});

test("a palette that fails contrast is refused, with the pair named: white text on white backgrounds", () => {
const whiteOnWhite = (file) => {
	const copy = structuredClone(file);
	for (const mode of ["light", "dark"]) {
		for (const role of Object.keys(copy.surfaces.browser[mode])) copy.surfaces.browser[mode][role] = "#ffffff";
	}
	return copy;
};
	for (const name of BUILT_INS) {
		assert.equal(parsePolycarpTheme(whiteOnWhite(fixtureFile(name))), undefined, name);
		assert.equal(polycarpPayload(whiteOnWhite(fixtureFile(name))), undefined, name);
	}
	const result = checkPolycarpTheme(whiteOnWhite(fixtureFile("calm")));
	assert.match(result.reason, /light foreground on background is 1\.00:1, needs 4\.5:1/);
	// One weak pair in one mode is enough: muted text on the page in dark mode.
	const dim = fixtureFile("calm");
	dim.surfaces.browser.dark.muted = dim.surfaces.browser.dark.background;
	assert.match(checkPolycarpTheme(dim).reason, /dark muted on background/);
});

test("--tk-radius-sm and --tk-radius-lg are read: Tailwind's rounded-sm and rounded-xl and the panel's own small corners use them, and the defaults stay mini-lit's", () => {
	const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
	assert.match(css, /--radius-sm:\s*var\(--tk-radius-sm\)/);
	assert.match(css, /--radius-xl:\s*var\(--tk-radius-lg\)/);
	assert.match(css, /--tk-radius-sm:\s*calc\(var\(--radius\) - 4px\)/);
	assert.match(css, /--tk-radius-lg:\s*calc\(var\(--radius\) \+ 4px\)/);
	assert.equal([...css.matchAll(/border-radius:\s*calc\(var\(--radius\) - 4px\)/g)].length, 0, "small corners go through --tk-radius-sm");
	assert.ok([...css.matchAll(/border-radius:\s*var\(--tk-radius-sm\)/g)].length >= 3);
	const vars = appearanceVariables({ preset: "tabkyra" }, false, parsePolycarpTheme(fixtureFile("blocks")));
	const theme = fixtureFile("blocks").surfaces.browser.shape;
	assert.equal(vars["--tk-radius-sm"], `${theme.radius_small}px`);
	assert.equal(vars["--tk-radius-lg"], `${theme.radius_large}px`);
});

test("the base size from a Polycarp theme goes on the root element, so rem text scales; with no theme the root is untouched", () => {
	const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
	assert.match(css, /\nhtml \{\s*font-size: var\(--tk-font-size, 100%\);/);
	assert.match(css, /\nbody \{\s*font-size: var\(--tk-font-size, 16px\);/);
	assert.equal("--tk-font-size" in appearanceVariables({ preset: "tabkyra" }, false), false);
});
