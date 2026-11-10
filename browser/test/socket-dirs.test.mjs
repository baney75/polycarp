// The socket folder was renamed from /tmp/tabkyra-bridge-<user> to /tmp/polycarp-bridge-<user>. Hosts make the new one;
// clients look in both, so a host an older helper started (the browser keeps it running across an update) is still found.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSockets } from "../cli/src/client.ts";
import { legacySocketPath, socketDir, socketDirs } from "../cli/src/paths.ts";

const posix = process.platform !== "win32";

test("the socket folder is polycarp-bridge, and the old tabkyra-bridge one is searched after it", { skip: !posix && "pipes on Windows" }, () => {
	const saved = { p: process.env.POLYCARP_SOCKET_DIR, t: process.env.TABKYRA_SOCKET_DIR };
	delete process.env.POLYCARP_SOCKET_DIR;
	delete process.env.TABKYRA_SOCKET_DIR;
	try {
		const user = userInfo().username;
		assert.equal(socketDir(), `/tmp/polycarp-bridge-${user}`);
		assert.deepEqual(socketDirs(), [`/tmp/polycarp-bridge-${user}`, `/tmp/tabkyra-bridge-${user}`]);
		process.env.POLYCARP_SOCKET_DIR = "/x/override";
		assert.deepEqual(socketDirs(), ["/x/override"], "an override is the only place");
	} finally {
		for (const [k, v] of [["POLYCARP_SOCKET_DIR", saved.p], ["TABKYRA_SOCKET_DIR", saved.t]]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("clients find a live host in the old folder, newest first across both", { skip: !posix && "pipes on Windows" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "socket-dirs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fresh = join(root, "polycarp-bridge");
	const old = join(root, "tabkyra-bridge");
	for (const dir of [fresh, old]) {
		mkdirSync(dir);
		chmodSync(dir, 0o700);
	}
	// listSockets keeps names whose pid is alive; this process and its parent are.
	const oldSock = join(old, `${process.pid}.sock`);
	writeFileSync(oldSock, "");
	assert.deepEqual(listSockets([fresh, old]), [oldSock], "a host only in the old folder is found");
	const newSock = join(fresh, `${process.ppid}.sock`);
	writeFileSync(newSock, "");
	const past = new Date(Date.now() - 60_000);
	utimesSync(oldSock, past, past);
	assert.deepEqual(listSockets([fresh, old]), [newSock, oldSock]);
	// An old folder anyone could have planted is skipped, not trusted.
	chmodSync(old, 0o755);
	assert.deepEqual(listSockets([fresh, old]), [newSock]);
	chmodSync(fresh, 0o755);
	assert.throws(() => listSockets([fresh, old]), /mode 755/, "the current folder still has to be private");
});

test("a host in both folders is listed once, from the new one", { skip: !posix && "pipes on Windows" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "socket-dirs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fresh = join(root, "polycarp-bridge");
	const old = join(root, "tabkyra-bridge");
	for (const dir of [fresh, old]) {
		mkdirSync(dir);
		chmodSync(dir, 0o700);
		writeFileSync(join(dir, `${process.pid}.sock`), "");
	}
	assert.deepEqual(listSockets([fresh, old]), [join(fresh, `${process.pid}.sock`)]);
});

test("an override turns the old-folder listener off", () => {
	const saved = process.env.POLYCARP_SOCKET_DIR;
	process.env.POLYCARP_SOCKET_DIR = "/x/override";
	try {
		assert.equal(legacySocketPath(process.pid), undefined);
	} finally {
		if (saved === undefined) delete process.env.POLYCARP_SOCKET_DIR;
		else process.env.POLYCARP_SOCKET_DIR = saved;
	}
});

// second-F6: the npm `tabkyra` bin is gone. An agent entry that still runs a bare `tabkyra mcp` is stale, so doctor flags it
// and setup rewrites it, instead of the agent failing with "command not found".
test("an agent entry running the removed bare tabkyra command is stale", async () => {
	const { classify } = await import("../cli/src/harness.ts");
	const saved = process.env.PATH;
	process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
	try {
		assert.equal(classify("tabkyra", ["mcp"]), "stale");
	} finally {
		process.env.PATH = saved;
	}
});
