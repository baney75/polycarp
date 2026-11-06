// `polycarp browser doctor`'s user-scripts row against a fake native host that answers bridge.debug
// with each status the extension can report. The row must name the real cause and its fix:
// a missing permission is not "the toggle is off", and an old extension still gets a row.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
let server;
/** bridge.debug answers, in order; the last one repeats. */
let answers = [];
let debugCalls = 0;

before(async () => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-doctor-us-"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "bin"));
	symlinkSync(process.execPath, join(root, "bin", "node"));
	server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				const msg = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString());
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				if (msg.type === "hello") {
					socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: true }));
					continue;
				}
				if (msg.method === "bridge.debug") {
					const result = answers[Math.min(debugCalls, answers.length - 1)];
					debugCalls++;
					// "fail" answers with an RPC error, as a worker that is still restarting might.
					if (result === "fail") socket.write(frame({ type: "response", id: msg.id, error: { code: "internal", message: "bridge.debug: worker restarting" } }));
					else socket.write(frame({ type: "response", id: msg.id, result }));
				}
			}
		});
	});
	const path = join(root, "sock", `${process.pid}.sock`);
	await new Promise((resolve) => server.listen(path, resolve));
	// The client refuses a socket other users could reach.
	chmodSync(path, 0o600);
});
after(() => {
	server.close();
	rmSync(root, { recursive: true, force: true });
});

/** The doctor's user-scripts row (undefined when it printed none) for these bridge.debug answers. */
async function userScriptsRow(...debugAnswers) {
	answers = debugAnswers;
	debugCalls = 0;
	const child = spawn(process.execPath, [cli, "doctor", "--json"], {
		env: {
			HOME: join(root, "home"),
			PATH: join(root, "bin"),
			TABKYRA_SOCKET_DIR: join(root, "sock"),
			TABKYRA_EXTENSION_DIR: join(root, "no-build"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout.on("data", (d) => {
		out += d;
	});
	await new Promise((resolve) => child.on("close", resolve));
	const checks = JSON.parse(out).checks;
	assert.ok(
		checks.some((c) => c.id === "connected" && c.status === "ok"),
		`doctor did not reach the fake host: ${out}`,
	);
	return checks.find((c) => c.id === "user-scripts");
}

const status = (state, extra = {}) => ({
	version: "9.9.9",
	workerUptimeS: 60,
	userScriptsApi: state === "ready",
	userScripts: { state, permissionGranted: state !== "not_granted", apiPresent: state === "ready", callWorks: state === "ready", ...extra },
});

test("ready: no row", async () => {
	assert.equal(await userScriptsRow(status("ready")), undefined);
});

test("not_granted: says the permission is missing and how to grant it, not 'turn on the toggle'", async () => {
	const row = await userScriptsRow(status("not_granted", { permissionGranted: false }));
	assert.equal(row.status, "warn");
	assert.match(row.label, /permission is not granted/);
	assert.doesNotMatch(row.label, /is off/);
	assert.match(row.fix, /Settings > Agents > Page scripts.*Allow/);
});

test("toggle_off: points at the Details-page toggle and shows the browser's text", async () => {
	const row = await userScriptsRow(status("toggle_off", { apiPresent: true, error: "blocked by toggle" }));
	assert.match(row.label, /"Allow user scripts" is off/);
	assert.match(row.fix, /Details/);
	assert.match(row.detail, /blocked by toggle/);
});

test("granted but hidden: names both causes and the restart, not just the toggle", async () => {
	const row = await userScriptsRow(status("toggle_off", { apiPresent: false }));
	assert.match(row.label, /granted but the browser hides/);
	assert.match(row.detail, /hasn't restarted/);
	assert.match(row.fix, /polycarp browser reload/);
});

test("probe_error: shows the error text", async () => {
	const row = await userScriptsRow(status("probe_error", { error: "worker shutting down" }));
	assert.match(row.label, /Couldn't tell/);
	assert.match(row.detail, /worker shutting down/);
});

test("a worker that just started is asked again once before warning", async () => {
	const young = { ...status("not_granted", { permissionGranted: false }), workerUptimeS: 1 };
	assert.equal(await userScriptsRow(young, status("ready")), undefined);
	assert.equal(debugCalls, 2);
	// Still not granted on the second ask: warn, and don't keep asking.
	assert.match((await userScriptsRow(young, young)).label, /not granted/);
	assert.equal(debugCalls, 2);
});

test("a retry that fails keeps the first answer instead of failing the connection", async () => {
	const young = { ...status("not_granted", { permissionGranted: false }), workerUptimeS: 1 };
	const row = await userScriptsRow(young, "fail");
	assert.match(row.label, /not granted/);
	assert.equal(debugCalls, 2);
});

test("a state this CLI doesn't know falls back to the boolean", async () => {
	const row = await userScriptsRow({ ...status("ready"), userScriptsApi: false, userScripts: { state: "something_new" } });
	assert.equal(row.label, "User scripts are unavailable");
	assert.equal(await userScriptsRow({ ...status("ready"), userScripts: { state: "something_new" } }), undefined);
});

test("a settled worker is asked once", async () => {
	await userScriptsRow(status("not_granted", { permissionGranted: false }));
	assert.equal(debugCalls, 1);
});

test("an extension without the structured status still gets a row from the old boolean", async () => {
	const row = await userScriptsRow({ version: "1.1.9", userScriptsApi: false });
	assert.equal(row.status, "warn");
	assert.match(row.detail, /permission is not granted or "Allow user scripts" is off/);
	assert.equal(await userScriptsRow({ version: "1.1.9", userScriptsApi: true }), undefined);
});
