import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { claudeAllows, setClaudeAllows, moveClaudeRules, CLAUDE_RULE } = await loadTs(
	`export { claudeAllows, setClaudeAllows, moveClaudeRules, CLAUDE_RULE } from "@src/always-allow.ts";`,
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

test("a move takes the old name's rules with it, a deny above all, and reports what it can't move", () => {
	const dir = home();
	const file = join(dir, ".claude", "settings.json");
	writeFileSync(
		file,
		JSON.stringify({
			permissions: { allow: ["mcp__tabkyra", "Bash(ls)"], deny: ["mcp__tabkyra__run_js"] },
			hooks: { PreToolUse: [{ matcher: "mcp__tabkyra__navigate" }] },
		}),
	);
	assert.deepEqual(moveClaudeRules(dir), { rewritten: 2, elsewhere: true });
	const after = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(after.permissions, { allow: ["mcp__polycarp", "Bash(ls)"], deny: ["mcp__polycarp__run_js"] });
	assert.equal(after.hooks.PreToolUse[0].matcher, "mcp__tabkyra__navigate", "a hook is reported, not rewritten");
});

test("the file keeps its permissions and stays where a symlink points", () => {
	const dir = home();
	const real = join(dir, "dotfiles.json");
	writeFileSync(real, "{}", { mode: 0o600 });
	symlinkSync(real, join(dir, ".claude", "settings.json"));
	assert.equal(setClaudeAllows(true, dir), undefined);
	assert.ok(lstatSync(join(dir, ".claude", "settings.json")).isSymbolicLink(), "still a link");
	assert.equal(statSync(real).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).permissions.allow, ["mcp__polycarp"]);
});

test("off also removes the wildcard form of the rule", () => {
	const dir = home();
	writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__polycarp__*", "Bash(ls)"] } }));
	setClaudeAllows(false, dir);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).permissions.allow, ["Bash(ls)"]);
});
