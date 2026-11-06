// The extension's logo is Polycarp's: the source files in brand/browser, nothing of the old helm, and PNGs for each size.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { POLYCARP_ICON, POLYCARP_ICON_16 } from "../src/components/polycarp-svg.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the logo in the code is the one in brand/browser", () => {
	assert.equal(POLYCARP_ICON, readFileSync(join(root, "../brand/browser/icon.svg"), "utf8").trim());
	assert.equal(POLYCARP_ICON_16, readFileSync(join(root, "../brand/browser/icon-16.svg"), "utf8").trim());
});

test("the old helm is gone from the extension", () => {
	// git grep exits 1 when it finds nothing, which is the pass.
	const found = spawnSync("git", ["grep", "-il", "helmMark\\|helm-svg\\|HELM_ICON", "--", "src", "static", "scripts/check-theme.mjs"], { cwd: root, encoding: "utf8" });
	assert.equal(found.stdout.trim(), "");
});

test("the default colors are Polycarp's", () => {
	const css = readFileSync(join(root, "src/app.css"), "utf8");
	assert.match(css, /--tk-brass: #59693f;/);
	assert.doesNotMatch(css, /#e3a93b|#0f1b24/i, "the old brass and navy");
});

test("each manifest icon is a real PNG of its size", () => {
	const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
	for (const [size, file] of Object.entries(manifest.icons)) {
		const png = readFileSync(join(root, "static", file));
		assert.equal(png.readUInt32BE(16), Number(size), file);
	}
});
