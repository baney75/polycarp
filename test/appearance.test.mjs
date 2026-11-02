// The side panel's colors come from the same presets as the approval and hub pages. Every pair of
// text on a background the panel draws reaches WCAG AA (4.5:1) for every preset, in light and dark,
// and for custom accents, computed from the CSS variables the panel actually sets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, PRESETS } from "../src/appearance/palettes.ts";
import { appearanceVariables, parseChoice, TEXT_PAIRS } from "../src/appearance/tokens.ts";

const check = (choice, label) => {
	for (const dark of [false, true]) {
		const vars = appearanceVariables(choice, dark);
		for (const [fg, bg] of TEXT_PAIRS) {
			assert.ok(vars[fg] && vars[bg], `${label}: ${fg} or ${bg} is not set`);
			const ratio = contrast(vars[fg], vars[bg]);
			assert.ok(ratio >= 4.5, `${label} ${dark ? "dark" : "light"}: ${fg} ${vars[fg]} on ${bg} ${vars[bg]} is ${ratio.toFixed(2)}:1, below 4.5:1`);
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
