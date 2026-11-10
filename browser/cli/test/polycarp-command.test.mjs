// The `polycarp` command of an npm link or checkout: `polycarp browser ...` is this helper, the rest is the app's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const run = (file, args, env = {}) => spawnSync(process.execPath, [join(dist, file), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("package.json links `polycarp` beside `polycarp-browser`", () => {
	const pkg = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));
	assert.equal(pkg.bin.polycarp, "./dist/polycarp.js");
	assert.equal(pkg.bin["polycarp-browser"], "./dist/index.js");
});

test("`polycarp browser <command>` runs the helper's command", () => {
	const direct = run("index.js", ["--help"]);
	const viaApp = run("polycarp.js", ["browser", "--help"]);
	assert.equal(direct.status, 0, direct.stderr);
	assert.equal(viaApp.status, direct.status);
	assert.equal(viaApp.stdout, direct.stdout);
	assert.ok(direct.stdout.length > 100, "help printed something");
});

test("the helper started through `polycarp browser` names its own file as the script to restart", () => {
	// `status --json` and friends spawn `node <argv[1]> ...`; through the shim that must be index.js.
	const src = readFileSync(join(dist, "polycarp.js"), "utf8");
	assert.match(src, /process\.argv\.splice\(1, 2, /);
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", `process.argv = [process.argv[0], ${JSON.stringify(join(dist, "polycarp.js"))}, "browser", "--help"]; const w = process.stdout.write.bind(process.stdout); process.stdout.write = () => true; process.on("exit", () => w(process.argv[1])); await import(${JSON.stringify(join(dist, "polycarp.js"))});`], { encoding: "utf8" });
	assert.equal(r.stdout.trim().endsWith(join("dist", "index.js")), true, r.stdout + r.stderr);
});

test("another `polycarp` command says it needs the app when none is on PATH", () => {
	const r = run("polycarp.js", ["theme", "list"], { PATH: "" });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /`polycarp theme` needs the Polycarp app/);
	assert.match(r.stderr, /polycarp browser <command>/);
});

test("another `polycarp` command goes to the app's own polycarp further along PATH", { skip: process.platform === "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "polycarp-cmd-"));
	try {
		const app = join(dir, "polycarp");
		writeFileSync(app, '#!/bin/sh\necho "app got: $*"\nexit 7\n');
		chmodSync(app, 0o755);
		const r = run("polycarp.js", ["theme", "list"], { PATH: dir });
		assert.equal(r.status, 7);
		assert.equal(r.stdout.trim(), "app got: theme list");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
