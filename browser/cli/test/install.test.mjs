// Runs the built CLI against a throwaway HOME: install writes the native host manifest
// into every browser directory present, and the manifest's origin matches the id the
// extension key in static/manifest.chrome.json produces.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = mkdtempSync(join(tmpdir(), "tabkyra-home-"));
after(() => rmSync(home, { recursive: true, force: true }));

const base =
	process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
const browsers = {
	Helium: join(base, "net.imput.helium"),
	Chrome: process.platform === "darwin" ? join(base, "Google", "Chrome") : join(base, "google-chrome"),
};
const absent = process.platform === "darwin" ? join(base, "Microsoft Edge") : join(base, "microsoft-edge");

// A private, empty socket directory: `status` must never reach the user's running browser.
const socketDir = join(home, "sock");
mkdirSync(socketDir, { mode: 0o700 });

function run(...args) {
	const env = { ...process.env, HOME: home, TABKYRA_SOCKET_DIR: socketDir };
	delete env.XDG_CONFIG_HOME;
	try {
		return execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
	} catch (err) {
		// `status` exits 1 when no bridge socket is up; its stdout is what we check.
		return err.stdout;
	}
}

function extensionIdFromKey() {
	const manifest = JSON.parse(readFileSync(join(repo, "static", "manifest.chrome.json"), "utf8"));
	const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
	return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

test("install registers the host for Helium and Chrome, skips absent browsers", () => {
	for (const dir of Object.values(browsers)) mkdirSync(dir, { recursive: true });
	run("install");
	const id = extensionIdFromKey();
	for (const dir of Object.values(browsers)) {
		const file = join(dir, "NativeMessagingHosts", "ai.tabkyra.bridge.json");
		const host = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(host.name, "ai.tabkyra.bridge");
		assert.deepEqual(host.allowed_origins, [`chrome-extension://${id}/`]);
		assert.equal(host.path, join(home, ".config", "tabkyra", "host"));
	}
	assert.equal(existsSync(absent), false);
});

test("status reports each browser's host state", () => {
	const report = JSON.parse(run("status", "--json"));
	assert.equal(report.connected, false);
	const state = Object.fromEntries(report.hosts.map((h) => [h.browser, h.state]));
	assert.equal(state.Helium, "current");
	assert.equal(state.Chrome, "current");
	assert.match(run("status"), /Helium\s+host registered/);
});
