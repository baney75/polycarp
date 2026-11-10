// doctor reports which browser holds each connection (the host knows its parent process), a never-connected browser is news
// and not a failure, and `install --browser` refuses an unknown name. (The parent-process mapping is in parent-browser.test.mjs.)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
async function fakeHost(pid, browserName, version, { silent = false } = {}) {
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				const msg = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString());
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				if (msg.type === "hello") socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: true, ...(browserName ? { browserName } : {}) }));
				else if (msg.method === "bridge.debug" && !silent) socket.write(frame({ type: "response", id: msg.id, result: { version, userScriptsApi: true, userScripts: { state: "ready" } } }));
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
// Asynchronous: the fake hosts live in this process, which a blocking spawn would starve.
const doctor = () =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, "doctor", "--json"], { env: env(), stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.on("error", reject);
		child.on("close", () => resolve(JSON.parse(out).checks));
	});

test("a browser that was never connected is a warning with its own fix, not a failure", async () => {
	const hosts = (await doctor()).filter((c) => c.id.startsWith("host:"));
	assert.ok(hosts.length >= 1);
	for (const h of hosts) {
		assert.equal(h.status, "warn", JSON.stringify(h));
		assert.match(h.fix, /^polycarp-browser install --browser \w/);
		assert.doesNotMatch(h.fix, /--force/);
	}
});

test("each connection names the browser that holds it", async () => {
	await fakeHost(process.pid, "Chrome", "1.1.10");
	await fakeHost(process.ppid, "Helium", "1.1.9");
	const checks = await doctor();
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
	const checks = await doctor();
	assert.equal(checks.some((c) => c.id.startsWith("connected:")), false);
	assert.equal(checks.find((c) => c.id === "connected").status, "ok");
});

test("install --browser refuses a name it doesn't know, and writes nothing", () => {
	const r = spawnSync(process.execPath, [cli, "install", "--browser", "chrome"], { env: env(), encoding: "utf8" });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /Unknown browser "chrome"\. Use one of: Helium, Chrome/);
	assert.equal(existsSync(join(root, "home", ".config", "polycarp", "browser")), false, "no launcher was written");
});

const reset = async () => {
	for (const s of servers) s.close();
	servers.length = 0;
	await rm(join(root, "sock"), { recursive: true, force: true });
	mkdirSync(join(root, "sock"), { mode: 0o700 });
};

test("second-S5: sockets are asked at once under one deadline, and a silent browser still gets its own line", async () => {
	await reset();
	await fakeHost(process.pid, "Chrome", "1.1.10", { silent: true });
	await fakeHost(process.ppid, "Helium", "1.1.9", { silent: true });
	const started = Date.now();
	const checks = await doctor();
	const took = Date.now() - started;
	// One wait for both (the app stops waiting at 12 s); in sequence these two would need 10 s of bridge.debug timeouts.
	assert.ok(took < 11000, `doctor took ${took} ms`);
	const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
	assert.equal(byId.connected.status, "fail");
	assert.match(byId.connected.label, /not responding/);
	for (const name of ["Chrome", "Helium"]) {
		assert.equal(byId[`connected:${name}`]?.status, "warn", `${name} is live and says so`);
		assert.match(byId[`connected:${name}`].label, new RegExp(`${name}: extension connected but not responding \\(unknown version\\)`));
	}
});

test("second-S5: a later socket that fails still shows its browser as connected, beside one that answers", async () => {
	await reset();
	await fakeHost(process.pid, "Chrome", "1.1.10");
	await fakeHost(process.ppid, "Helium", "1.1.9", { silent: true });
	const byId = Object.fromEntries((await doctor()).map((c) => [c.id, c]));
	assert.equal(byId["connected:Chrome"].status, "ok");
	assert.equal(byId["connected:Helium"].status, "warn");
	assert.equal(byId.connected.status, "ok");
});

test("second-S1: a browser with a leftover data folder and no app is not listed, unless a live connection names it", { skip: process.platform !== "darwin" && "app detection is a Mac thing" }, async () => {
	await reset();
	const support = join(root, "home", "Library", "Application Support");
	mkdirSync(join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"), { recursive: true });
	// A manifest an earlier install wrote proves nothing: the app is gone.
	writeFileSync(join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", "ai.tabkyra.bridge.json"), JSON.stringify({ name: "ai.tabkyra.bridge", path: "/bin/echo" }));
	assert.equal((await doctor()).some((c) => c.id === "host:Brave"), false);
	await fakeHost(process.pid, "Brave", "1.1.10");
	assert.equal((await doctor()).some((c) => c.id === "host:Brave"), true, "a live connection names it");
});

test("first-F6/sol-F5: the repair command for a two-word browser is quoted", { skip: process.platform !== "darwin" && "app detection is a Mac thing" }, async () => {
	await reset();
	const support = join(root, "home", "Library", "Application Support");
	mkdirSync(join(support, "Google", "Chrome Beta"), { recursive: true });
	mkdirSync(join(root, "apps", "Google Chrome Beta.app"), { recursive: true });
	const beta = (await doctor()).find((c) => c.id === "host:Chrome Beta");
	assert.equal(beta.fix, "polycarp-browser install --browser 'Chrome Beta'");
});

// Twice on Donovan's Mac an old npm-linked copy rewrote the launchers. They still ran, so doctor passed, while the
// panel talked to old code that called a valid remote.json unreadable.
test("a launcher that runs another copy of the helper fails doctor, with install --force as the fix", async () => {
	const name = (await doctor()).find((c) => c.id.startsWith("host:")).id.slice("host:".length);
	const r = spawnSync(process.execPath, [cli, "install", "--browser", name], { env: env(), encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	let checks = await doctor();
	assert.equal(checks.find((c) => c.id === `host:${name}`).status, "ok");
	assert.equal(checks.find((c) => c.id === "launcher").status, "ok");

	const other = join(root, "old-checkout", "index.js");
	mkdirSync(dirname(other), { recursive: true });
	writeFileSync(other, "");
	const host = checks.find((c) => c.id === "launcher").detail.replace(/[^/]+$/, "polycarp-host");
	for (const [file, args] of [[checks.find((c) => c.id === "launcher").detail, ""], [host, "host "]]) {
		assert.ok(existsSync(file), file);
		writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${other}" ${args}"$@"\n`);
		chmodSync(file, 0o755);
	}
	checks = await doctor();
	const hostCheck = checks.find((c) => c.id === `host:${name}`);
	assert.equal(hostCheck.status, "fail", JSON.stringify(hostCheck));
	assert.match(hostCheck.detail, /old-checkout\/index\.js, not this helper/);
	const launcher = checks.find((c) => c.id === "launcher");
	assert.equal(launcher.status, "fail", JSON.stringify(launcher));
	assert.match(launcher.fix, /install --force$/);

	// The fix doctor gives for the browser clears both failures.
	const [command, ...args] = hostCheck.fix.split(" ").slice(1);
	assert.equal(spawnSync(process.execPath, [cli, command, ...args.map((a) => a.replace(/^'|'$/g, ""))], { env: env(), encoding: "utf8" }).status, 0);
	checks = await doctor();
	assert.equal(checks.find((c) => c.id === `host:${name}`).status, "ok");
	assert.equal(checks.find((c) => c.id === "launcher").status, "ok");
});
