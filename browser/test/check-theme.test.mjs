// scripts/check-theme.mjs fails on a color written into the panel instead of a token, and the tree passes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWLIST, check, findColors } from "../scripts/check-theme.mjs";

test("it finds hex colors and color functions, and skips custom property definitions", () => {
	const css = [
		"  --tk-brass: #e3a93b;",
		"  color: #fff;",
		"  background: rgba(0, 0, 0, 0.5);",
		"  border: 1px solid hsl(10 20% 30%);",
		"  fill: oklch(0.2 0 0);",
		"  color: var(--foreground);",
		"  background: color-mix(in srgb, var(--tk-brass) 15%, transparent);",
		'  x: "#main";',
		"  --x: rgb(1 2 3);",
		"  a: #12345678;",
	].join("\n");
	assert.deepEqual(
		findColors(css).map((f) => f.text),
		["#fff", "rgba(", "hsl(", "oklch(", "#12345678"],
	);
});

test("every allowlist entry says why, and the tree has no color outside tokens and the allowlist", () => {
	for (const [file, entry] of Object.entries(ALLOWLIST)) assert.ok(entry.why.length > 20, `${file} needs a reason`);
	assert.deepEqual(check(), []);
});

test("no test file prints leftover debug output", async () => {
	const { readdirSync, readFileSync } = await import("node:fs");
	const dir = new URL("./", import.meta.url);
	for (const name of readdirSync(dir).filter((n) => n.endsWith(".test.mjs") && n !== "check-theme.test.mjs")) {
		assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /console\.log\(\s*["']DBG/, name);
	}
});

test("it finds named colors in color properties, in the panel and in the consent and hub pages' CSS, and skips tokens, var() and comments", async () => {
	const { findPageColors, namedColors } = await import("../scripts/check-theme.mjs");
	assert.deepEqual(namedColors("  color: white;"), ["white"]);
	assert.deepEqual(namedColors("border: 1px solid red;"), ["red"]);
	assert.deepEqual(namedColors("background: var(--white); color: inherit; fill: currentColor"), []);
	assert.deepEqual(findColors("x { color: white }").map((f) => f.text), ["white"]);
	assert.deepEqual(findColors("/* the text color: gray here */").map((f) => f.text), []);
	const page = "const PAGE_CSS = `:root{--shadow:#0002}main{box-shadow:0 1px 3px #0002;color:white}`;\nconst x = `<style>p{background:#fff}</style><b style=\"color:black\">`;";
	assert.deepEqual(findPageColors(page).map((f) => f.text).sort(), ["#0002", "#fff", "black", "white"]);
	assert.deepEqual(findPageColors("const PAGE_CSS = `:root{--shadow:#0002}a{box-shadow:var(--shadow)}`;"), []);
});
