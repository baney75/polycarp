// A settings switch whose save is refused goes back and says why (issue 386). On main the write was awaited with no
// catch: the box stayed flipped, the state kept the old value, and no error showed, so Private mode could read on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { saveSwitch } = await import("../src/dialogs/switch-save.ts");

test("a refused save says why, redraws the switch, and answers false", async () => {
	const said = [];
	let redraws = 0;
	const ok = await saveSwitch(() => Promise.reject(new Error("QUOTA_BYTES quota exceeded")), () => redraws++, "Private mode", (m) => said.push(m));
	assert.equal(ok, false);
	assert.equal(redraws, 1);
	assert.deepEqual(said, ["Couldn't save Private mode: QUOTA_BYTES quota exceeded. It is back to what was saved."]);
});

test("a save that lands answers true and says nothing", async () => {
	const said = [];
	assert.equal(await saveSwitch(() => Promise.resolve(), () => assert.fail("no redraw"), "x", (m) => said.push(m)), true);
	assert.deepEqual(said, []);
});

const src = (f) => readFileSync(new URL(`../src/dialogs/${f}`, import.meta.url), "utf8");

test("every Privacy switch saves through it and is drawn with live()", () => {
	const p = src("PrivacyTab.ts");
	for (const k of ["privateMode", "mirror", "shareOlder", "bugReports"]) assert.match(p, new RegExp(`\\.checked=\\$\\{live\\(this\\.${k}\\)\\}`), k);
	assert.match(p, /if \(await this\.save\(\(\) => getTabkyraStorage\(\)\.settings\.set\(PRIVATE_MODE_KEY, on\), "Private mode"\)\)\s*this\.privateMode = on;/);
	assert.equal(p.match(/await this\.save\(/g)?.length, 4, "share older, mirror, private mode, bug reports");
	assert.doesNotMatch(p, /\n\t\tawait (chrome\.storage\.local\.set|getTabkyraStorage\(\)\.settings\.set\(PRIVATE)/, "no bare write left");
});

test("the Agents tab's switches save through it and are drawn with live()", () => {
	const b = src("BridgeTab.ts");
	const row = b.slice(b.indexOf("private switchRow("), b.indexOf("render(): TemplateResult"));
	assert.match(row, /\.checked=\$\{live\(checked\)\}/);
	assert.match(row, /await saveSwitch\(\s*\(\) => set\(on\),/);
});
