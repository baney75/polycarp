// The skill-judge-change label approves one version of the judge; a push that changes it
// voids the approval (.github/scripts/judge-label.mjs). The decision is a pure function of the
// push's changed files, tested here; the API calls around it aren't.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPARE_FILE_LIMIT, hasPush, pushChangesJudge } from "../../.github/scripts/judge-label.mjs";

test("a push that changes, renames or deletes a judge file voids the approval", () => {
	assert.equal(pushChangesJudge({ files: [{ filename: "cli/src/skill-eval.ts", status: "modified" }] }), true);
	assert.equal(pushChangesJudge({ files: [{ filename: "cli/src/skill-router.ts", status: "removed" }] }), true);
	assert.equal(pushChangesJudge({ files: [{ filename: "cli/src/router.ts", previous_filename: "cli/src/skill-router.ts", status: "renamed" }] }), true);
	assert.equal(pushChangesJudge({ files: ["README.md", "cli/src/skill-eval.ts"] }), true);
});

test("a push elsewhere keeps the approval", () => {
	assert.equal(pushChangesJudge({ files: [{ filename: "skills/osint/SKILL.md" }, { filename: "skills-eval/router-cases.jsonl" }] }), false);
	assert.equal(pushChangesJudge({ files: [] }), false);
	assert.equal(pushChangesJudge({ files: [{ filename: "cli/src/skill-eval.ts.bak" }, { filename: "docs/cli/src/skill-eval.ts" }] }), false);
});

test("it fails closed: a failed or possibly cut-short comparison voids the approval", () => {
	assert.equal(pushChangesJudge({ failed: true }), true);
	const many = Array.from({ length: COMPARE_FILE_LIMIT }, (_, i) => ({ filename: `skills/s${i}/SKILL.md` }));
	assert.equal(pushChangesJudge({ files: many }), true);
});

test("only a synchronize push with two real SHAs is compared", () => {
	const a = "a".repeat(40);
	const b = "b".repeat(40);
	assert.equal(hasPush(a, b), true);
	assert.equal(hasPush("0".repeat(40), b), false);
	assert.equal(hasPush(undefined, b), false);
	assert.equal(hasPush(a, "main"), false);
});
