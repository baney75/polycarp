// Themed pages: every preset's text/background and accent/button-text pairs reach WCAG AA (4.5:1)
// in light and dark, a custom accent gets readable button text, and the consent page follows the theme.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { after, test } from "node:test";
import { machine, tempRoot, rmSync } from "./helpers/hub-fixture.mjs";

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
