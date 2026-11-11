// The assistant steps a person follows must read the same on every surface. The side panel draws them from
// src/connect/remote-copy.ts; `remote setup` prints its own copy (cli/src/remote-setup.ts, which can import the module once
// PR 132 lands). This test fails if either side changes alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APPROVAL_STEP, ASSISTANT_STEPS } from "../src/connect/remote-copy.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");

/** The lines the CLI prints, as the panel's data would print them. */
export const cliLines = () => [...ASSISTANT_STEPS.map((a) => `  ${a.name.padEnd(12)}${a.where}`), APPROVAL_STEP];

test("the panel's assistant steps are the lines `remote setup` prints", () => {
	const cli = read("cli/src/remote-setup.ts");
	const start = cli.indexOf("Add it to an assistant (paste the connector URL):\n");
	assert.ok(start >= 0, "remote-setup.ts no longer prints the assistant steps");
	const printed = cli.slice(start).split("\n").slice(1, 1 + cliLines().length);
	assert.deepEqual(printed, cliLines());
});
