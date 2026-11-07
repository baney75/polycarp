import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { claudeAllows, setClaudeAllows, CLAUDE_RULE } = await loadTs(
	`export { claudeAllows, setClaudeAllows, CLAUDE_RULE } from "@src/always-allow.ts";`,
);

const home = () => {
	const dir = mkdtempSync(join(tmpdir(), "always-allow-"));
	mkdirSync(join(dir, ".claude"));
	return dir;
};

test("the rule covers every Polycarp tool and nothing else", () => {
	assert.equal(CLAUDE_RULE, "mcp__polycarp");
});

test("on and off change only the one rule", () => {
	const dir = home();
	const file = join(dir, ".claude", "settings.json");
	writeFileSync(file, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"], deny: ["Read(x)"] } }));
	assert.equal(claudeAllows(dir), false);
	assert.equal(setClaudeAllows(true, dir), undefined);
	assert.equal(claudeAllows(dir), true);
	const on = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(on.permissions, { allow: ["Bash(ls)", "mcp__polycarp"], deny: ["Read(x)"] });
	assert.equal(on.model, "opus");
	setClaudeAllows(true, dir);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions.allow, ["Bash(ls)", "mcp__polycarp"], "not added twice");
	setClaudeAllows(false, dir);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions.allow, ["Bash(ls)"]);
});

test("no settings file yet is fine", () => {
	const dir = home();
	assert.equal(setClaudeAllows(true, dir), undefined);
	assert.equal(claudeAllows(dir), true);
});

test("a file it can't read is left alone", () => {
	const dir = home();
	const file = join(dir, ".claude", "settings.json");
	writeFileSync(file, "{ not json");
	assert.match(setClaudeAllows(true, dir), /left alone/);
	assert.equal(readFileSync(file, "utf8"), "{ not json");
	assert.equal(claudeAllows(dir), false);
});
