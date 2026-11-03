// The side panel's colors come from the same presets as the approval and hub pages. Every pair of
// text on a background the panel draws reaches WCAG AA (4.5:1) for every preset, in light and dark,
// and for custom accents, computed from the CSS variables the panel actually sets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { contrast, PRESETS } from "../src/appearance/palettes.ts";
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
