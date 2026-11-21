// The hub tests' teardown removes the temp root only after every process they started has exited. A stop that only
// signals resolves while the process is still shutting down: `link run` revokes its token on SIGTERM, writing into the
// root, and on a loaded CI runner the rmdir found the folder refilled (ENOTEMPTY, hub-hardening's after hook).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { teardown, tempRoot, track } from "./helpers/hub-fixture.mjs";

test("teardown waits for a tracked process that still writes into the root after its stop resolved", async () => {
	const root = tempRoot("polycarp-hubteardown-");
	const dir = join(root, "device", "config");
	// On SIGTERM it keeps writing files for 1.5 s, past rmSync's retries (10 x 100 ms), then exits.
	const code = `
		const { mkdirSync, writeFileSync } = require("node:fs");
		const dir = ${JSON.stringify(dir)};
		mkdirSync(dir, { recursive: true });
		process.on("SIGTERM", () => {
			const end = Date.now() + 1500;
			const t = setInterval(() => {
				mkdirSync(dir, { recursive: true });
				writeFileSync(dir + "/tokens.json." + Date.now(), "{}");
				if (Date.now() > end) { clearInterval(t); process.exit(0); }
			}, 20);
		});
		console.log("ready");
		setInterval(() => {}, 1000);
	`;
	const proc = track(spawn(process.execPath, ["-e", code]));
	await new Promise((resolve) => proc.stdout.once("data", resolve));
	await teardown([() => proc.kill()], root);
	assert.notEqual(proc.exitCode ?? proc.signalCode, null, "the process had exited");
	assert.equal(existsSync(root), false, "the root is gone");
});
