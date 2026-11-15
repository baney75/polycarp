// browserjs() wrapper as the production build ships it (scripts/build.mjs minifies syntax). Minified, the old wrapper
// lost its providers marker and became `USER_CODE()`, so `() => x` came back as an uncalled function (browserjs() read
// undefined: the 2026-11-07 and 2026-11-15 chats) and `() => { ... }` was a SyntaxError. The test builds the module the
// same way and runs the code it makes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
globalThis.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(root, "scripts/build.mjs"), "utf8");
assert.match(config, /minifySyntax: !isWatch/, "the production build still minifies syntax; keep this test's options in step");

const out = mkdtempSync(join(root, "test/.min-"));
await build({
	absWorkingDir: root,
	entryPoints: ["src/tools/repl/userscripts-helpers.ts"],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: ["chrome120"],
	minifySyntax: true,
	minifyWhitespace: true,
	packages: "external",
	outfile: join(out, "helpers.mjs"),
	logLevel: "silent",
});
const { buildWrapperCode } = await import(pathToFileURL(join(out, "helpers.mjs")).href);
rmSync(out, { recursive: true, force: true });

const probe = {
	getData: () => ({ probeData: 5 }),
	getRuntime: () => () => {
		window.probeRuntime = "ran";
	},
	getDescription: () => "",
};
const run = (code, args) => (0, eval)(buildWrapperCode(code, "", false, [probe], `min-${Math.random()}`, args));

test("minified, browserjs() code returns its value in every function shape", async () => {
	for (const [code, want] of [
		["() => 'hello'", "hello"],
		["async () => 'world'", "world"],
		["() => { return 42; }", 42],
		["async () => { return 7; }", 7],
		["function () { return 1; }", 1],
	]) {
		const r = await run(code);
		assert.deepEqual(r, { success: true, lastValue: want }, code);
	}
	assert.deepEqual(await run("(a, b) => a + b", [2, 3]), { success: true, lastValue: 5 }, "with arguments");
});

test("minified, the providers still reach the page, and $ patterns in code stay as written", async () => {
	assert.deepEqual(await run("() => [window.probeData, window.probeRuntime]"), { success: true, lastValue: [5, "ran"] });
	assert.deepEqual(await run("() => \"$& $' $1\""), { success: true, lastValue: "$& $' $1" });
	const failed = await run("() => { throw new Error('boom'); }");
	assert.equal(failed.success, false);
	assert.equal(failed.error, "boom");
});
