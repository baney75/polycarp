// The single-executable build (scripts/compile.mjs) run against a throwaway HOME. The first group builds the compiled-mode
// bundle and runs it under Node, so the compiled code paths are tested wherever Node is; the second compiles the real
// executable and is skipped when Bun is missing. Nothing here touches the real HOME, sockets or browsers.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "tabkyra-compiled-"));
after(() => rmSync(work, { recursive: true, force: true }));

const bundleDir = join(work, "bundle");
before(() => {
	execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: cliRoot, env: { ...process.env, TABKYRA_CLI_COMPILED: "1", TABKYRA_CLI_OUT_DIR: bundleDir }, stdio: "ignore" });
});

function sandbox(name) {
	const home = join(work, name);
	mkdirSync(join(home, "sock"), { recursive: true, mode: 0o700 });
	const env = { PATH: "/usr/bin:/bin", HOME: home, POLYCARP_CONFIG_DIR: join(home, "polycarp"), TABKYRA_SOCKET_DIR: join(home, "sock"), NO_COLOR: "1" };
	return { home, env };
}

test("the compiled-mode bundle knows it is compiled", () => {
	const text = readFileSync(join(bundleDir, "index.js"), "utf8");
	assert.doesNotMatch(text, /__POLYCARP_COMPILED__/);
	assert.equal(existsSync(join(bundleDir, "router-worker.js")), false);
});

test("compiled-mode install points the browser at the helper itself and the agent launcher at the helper", () => {
	const { home, env } = sandbox("install");
	const chrome = process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
	mkdirSync(chrome, { recursive: true });
	const out = execFileSync(process.execPath, [join(bundleDir, "index.js"), "install"], { env, encoding: "utf8" });
	assert.match(out, /Wrote/);
	const manifest = JSON.parse(readFileSync(join(chrome, "NativeMessagingHosts", "ai.tabkyra.bridge.json"), "utf8"));
	assert.equal(manifest.path, process.execPath, "the manifest names the helper, not a script");
	assert.deepEqual(manifest.allowed_origins, ["chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/"]);
	for (const name of ["polycarp", "polycarp-host"]) {
		const text = readFileSync(join(home, ".config", "polycarp", "browser", name), "utf8");
		assert.equal(text.includes("node-compile-cache"), false);
		assert.match(text, new RegExp(`^#!/bin/sh\\nexec "${process.execPath.replaceAll("/", "\\/")}" ${name === "polycarp-host" ? "host " : ""}"\\$@"\\n$`));
		assert.ok(statSync(join(home, ".config", "polycarp", "browser", name)).mode & 0o100, `${name} is executable`);
	}
	// A second run changes nothing: the manifest is current.
	assert.match(execFileSync(process.execPath, [join(bundleDir, "index.js"), "install"], { env, encoding: "utf8" }), /Current/);
});

test("compiled-mode update says Polycarp does it and changes nothing", () => {
	const { env } = sandbox("update");
	const out = execFileSync(process.execPath, [join(bundleDir, "index.js"), "update"], { env, encoding: "utf8" });
	assert.match(out, /part of Polycarp/);
});

// ---- the real executable ----

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const haveBun = bun.status === 0;
const exe = join(work, "polycarp-browser");

test("the real executable builds, reports a version and lists the same tools", { skip: !haveBun && "bun is not installed" }, async () => {
	execFileSync(process.execPath, ["scripts/compile.mjs", "--arch", process.arch === "arm64" ? "arm64" : "x64", "--out", exe], { cwd: cliRoot, stdio: "ignore" });
	const { env } = sandbox("exe");
	const version = execFileSync(exe, ["--version"], { env, encoding: "utf8" }).trim();
	const manifest = JSON.parse(readFileSync(join(cliRoot, "..", "static", "manifest.chrome.json"), "utf8"));
	assert.equal(version, manifest.version);
	const tools = await new Promise((resolve, reject) => {
		const child = spawn(exe, ["mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (const line of buf.split("\n")) {
				try {
					const m = JSON.parse(line);
					if (m.id === 2) {
						child.kill();
						resolve(m.result.tools.map((t) => t.name));
					}
				} catch {
					/* partial line */
				}
			}
		});
		child.on("error", reject);
		const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
		send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
		send({ method: "notifications/initialized" });
		send({ id: 2, method: "tools/list" });
	});
	for (const name of ["tabs_context", "navigate", "read_page", "skill_match", "library_add"]) assert.ok(tools.includes(name), `${name} is listed`);
});

test("the real executable treats a chrome-extension argument as the native host", { skip: !haveBun && "bun is not installed" }, () => {
	const { env } = sandbox("host");
	// Native messaging: 4-byte length, then JSON. End of input ends the host without a browser attached.
	const r = spawnSync(exe, ["chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/"], { env, input: Buffer.alloc(0), timeout: 15000 });
	assert.notEqual(r.signal, "SIGTERM", "the host ended on its own when input closed");
	assert.doesNotMatch(String(r.stderr), /Unknown command|Usage/);
});

test("the real executable reads the Polycarp theme from POLYCARP_CONFIG_DIR, and ignores a missing or relative one", { skip: !haveBun && "bun is not installed" }, () => {
	const { home, env } = sandbox("theme");
	const run = (extra) => JSON.parse(execFileSync(exe, ["theme", "--json"], { env: { ...env, ...extra }, encoding: "utf8" }));
	assert.equal(run({}).polycarp, undefined, "no theme file, no Polycarp theme");
	const dir = join(home, "polycarp", "current");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "theme.json"), readFileSync(new URL("../../test/fixtures/polycarp/still-water.json", import.meta.url)));
	const seen = run({});
	assert.equal(seen.polycarp?.name, "still-water");
	// The same file through the config dir the app and `polycarp theme` use; a relative value is skipped.
	assert.equal(run({ POLYCARP_CONFIG_DIR: "relative/path" }).polycarp, undefined);
});

test("the real executable keeps using the existing ~/.config/polycarp/browser data in place", { skip: !haveBun && "bun is not installed" }, () => {
	const { home, env } = sandbox("config");
	const dir = join(home, ".config", "polycarp", "browser");
	mkdirSync(join(dir, "library"), { recursive: true });
	const saved = JSON.stringify({ preset: "forest" });
	writeFileSync(join(dir, "theme.json"), saved);
	writeFileSync(join(dir, "library", "keep.txt"), "kept");
	const out = JSON.parse(execFileSync(exe, ["theme", "--json"], { env, encoding: "utf8" }));
	assert.equal(out.preset, "forest", "the saved choice was read from where it already was");
	assert.equal(readFileSync(join(dir, "theme.json"), "utf8"), saved);
	assert.equal(readFileSync(join(dir, "library", "keep.txt"), "utf8"), "kept");
	assert.equal(existsSync(join(home, ".config", "polycarp-browser")), false, "no second config folder was made");
});
