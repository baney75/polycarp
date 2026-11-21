// The Chrome Web Store copy: what the zip holds, how a copy knows it came from the store, and that
// every permission has a written reason.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepare, problems } from "../scripts/store-package.mjs";
import { isStoreInstall } from "../src/update/store-install.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));

function fakeBuild() {
	const dir = mkdtempSync(join(tmpdir(), "store-"));
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(dir, "sidepanel.html"), `<script src="sidepanel.js"></script>`);
	for (const f of ["sidepanel.js", "sidepanel.js.map", "debug.html", "debug.js", "debug.js.map"]) {
		writeFileSync(join(dir, f), "x");
	}
	mkdirSync(join(dir, "ort"));
	writeFileSync(join(dir, "ort/a.mjs.map"), "x");
	return dir;
}

test("a raw build is refused: this is the check that protects the zip", () => {
	const found = problems(fakeBuild()).join("\n");
	for (const word of ["sidepanel.js.map", "debug.html", "debug.js", "ort/a.mjs.map", "manifest has a key", "LICENSE is missing", "NOTICE is missing"]) {
		assert.ok(found.includes(word), `${word} should be reported in:\n${found}`);
	}
});

test("a prepared build passes, keeps the app, and names its source and credits", () => {
	const dir = fakeBuild();
	prepare(dir, root);
	assert.deepEqual(problems(dir), []);
	assert.equal(readFileSync(join(dir, "sidepanel.js"), "utf8"), "x");
	const notice = readFileSync(join(dir, "NOTICE"), "utf8");
	assert.match(notice, /github\.com\/baney75\/polycarp/);
	assert.match(notice, /Mario Zechner/);
	assert.match(notice, /0xSero/);
});

test("an html page that loads the debug script is refused", () => {
	const dir = fakeBuild();
	prepare(dir, root);
	writeFileSync(join(dir, "sidepanel.html"), `<script src="debug.js"></script>`);
	assert.match(problems(dir).join(), /sidepanel\.html loads the debug page/);
});

test("only a manifest with update_url counts as a store copy", () => {
	assert.equal(isStoreInstall({ update_url: "https://clients2.google.com/service/update2/crx" }), true);
	assert.equal(isStoreInstall({}), false);
	assert.equal(isStoreInstall({ update_url: "" }), false);
	assert.equal(isStoreInstall(manifest), false, "the manifest we ship declares none, so unpacked copies keep their updater");
});

test("the store description fits and states one purpose", () => {
	assert.ok(manifest.description.length <= 132);
	assert.doesNotMatch(manifest.description, /\band a\b/);
});

test("every permission in the manifest has a written reason in store/permissions.md", () => {
	const doc = readFileSync(join(root, "store/permissions.md"), "utf8");
	const asked = [...manifest.permissions, ...(manifest.optional_permissions ?? []), ...manifest.host_permissions];
	for (const p of asked) assert.ok(doc.includes(`\`${p}\``), `${p} has no row in store/permissions.md`);
	assert.doesNotMatch(doc, /NOT NEEDED/, "remove the permission or give its reason");
});
