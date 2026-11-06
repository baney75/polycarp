// doctor reports which browser holds each connection (the host knows its parent process), a never-connected browser is news
// and not a failure, `install --browser` refuses an unknown name, and the parent process maps to a browser name.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

let root;
const servers = [];
/** A fake host: welcomes as the given browser (or none) and answers bridge.debug with a version. */
async function fakeHost(pid, browserName, version) {
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				const msg = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString());
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				if (msg.type === "hello") socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: true, ...(browserName ? { browserName } : {}) }));
				else if (msg.method === "bridge.debug") socket.write(frame({ type: "response", id: msg.id, result: { version, userScriptsApi: true, userScripts: { state: "ready" } } }));
			}
		});
	});
	const path = join(root, "sock", `${pid}.sock`);
	await new Promise((resolve) => server.listen(path, resolve));
	chmodSync(path, 0o600);
	servers.push(server);
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-doctor-browsers-"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "apps", "Helium.app"), { recursive: true });
	mkdirSync(join(root, "apps", "Google Chrome.app"), { recursive: true });
	symlinkSync(process.execPath, join(root, "bin", "node"));
	const support = process.platform === "darwin" ? join(root, "home", "Library", "Application Support") : join(root, "home", ".config");
	mkdirSync(join(support, "net.imput.helium"), { recursive: true });
	mkdirSync(process.platform === "darwin" ? join(support, "Google", "Chrome") : join(support, "google-chrome"), { recursive: true });
});
after(async () => {
	for (const s of servers) s.close();
	await rm(root, { recursive: true, force: true });
});

const env = () => ({ HOME: join(root, "home"), PATH: join(root, "bin"), TABKYRA_SOCKET_DIR: join(root, "sock"), TABKYRA_APPLICATIONS_DIRS: join(root, "apps"), TABKYRA_EXTENSION_DIR: join(root, "no-build") });
const doctor = () => {
	const r = spawnSync(process.execPath, [cli, "doctor", "--json"], { env: env(), encoding: "utf8" });
	return JSON.parse(r.stdout).checks;
};

test("a browser that was never connected is a warning with its own fix, not a failure", () => {
	const hosts = doctor().filter((c) => c.id.startsWith("host:"));
	assert.ok(hosts.length >= 1);
	for (const h of hosts) {
		assert.equal(h.status, "warn", JSON.stringify(h));
		assert.match(h.fix, /^(tabkyra|polycarp browser) install --browser \w/);
		assert.doesNotMatch(h.fix, /--force/);
	}
});

test("each connection names the browser that holds it", async () => {
	await fakeHost(process.pid, "Chrome", "1.1.10");
	await fakeHost(process.pid + 1, "Helium", "1.1.9");
	const checks = doctor();
	const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
	assert.match(byId["connected:Chrome"].label, /Chrome: extension connected \(1\.1\.10\)/);
	assert.match(byId["connected:Helium"].label, /Helium: extension connected \(1\.1\.9\)/);
	assert.equal(byId.connected.status, "ok", "the overall line stays for an older host that gives no browser");
});

test("a host that names no browser still gives the overall Connected line only", async () => {
	for (const s of servers) s.close();
	servers.length = 0;
	await rm(join(root, "sock"), { recursive: true, force: true });
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	await fakeHost(process.pid, undefined, "1.1.10");
	const checks = doctor();
	assert.equal(checks.some((c) => c.id.startsWith("connected:")), false);
	assert.equal(checks.find((c) => c.id === "connected").status, "ok");
});

test("install --browser refuses a name it doesn't know, and writes nothing", () => {
	const r = spawnSync(process.execPath, [cli, "install", "--browser", "chrome"], { env: env(), encoding: "utf8" });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /Unknown browser "chrome"\. Use one of: Helium, Chrome/);
	assert.equal(existsSync(join(root, "home", ".config", "tabkyra")), false, "no launcher was written");
});

test("the parent process maps to the browser's name", async () => {
	const { browserFromExecutable } = await import("../src/parent-browser.ts").catch(() => ({ browserFromExecutable: undefined }));
	if (!browserFromExecutable) return; // the compiled bundle has no loose source; the mapping is covered where tsx runs
	assert.equal(browserFromExecutable("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "Chrome");
	assert.equal(browserFromExecutable("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"), "Brave");
	assert.equal(browserFromExecutable("/usr/bin/microsoft-edge-stable"), "Edge");
	assert.equal(browserFromExecutable("/bin/zsh"), undefined);
});
