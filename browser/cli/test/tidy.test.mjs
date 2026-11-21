// A browser profile that can't be removed after a run is logged, not thrown (#563).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tidy } from "../eval/fixture-browser.mjs";

test("tidy logs a directory it can't remove instead of throwing", { skip: process.platform === "win32" || process.getuid?.() === 0 }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "tidy-"));
	const stuck = join(root, "Default");
	mkdirSync(stuck);
	writeFileSync(join(stuck, "Cookies"), "x");
	chmodSync(stuck, 0o500); // its file can't be unlinked, so the remove fails like a busy profile
	t.after(() => {
		chmodSync(stuck, 0o700);
		rmSync(root, { recursive: true, force: true });
	});
	const logged = [];
	t.mock.method(console, "error", (m) => logged.push(String(m)));
	assert.doesNotThrow(() => tidy(root));
	assert.equal(logged.length, 1);
	assert.match(logged[0], /^left .*tidy-/);
	assert.ok(existsSync(stuck));
});

test("tidy removes a directory it can remove", () => {
	const root = mkdtempSync(join(tmpdir(), "tidy-"));
	mkdirSync(join(root, "Default"));
	tidy(root);
	assert.equal(existsSync(root), false);
});
