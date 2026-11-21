// The socket folder was renamed from /tmp/tabkyra-bridge-<user> to /tmp/polycarp-bridge-<user>. A client from before the
// rename (a running `mcp`, a pi extension file written then) looks only in the old folder, so a new host answers there too.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const posix = process.platform !== "win32";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// sol-F1: a client from before the rename looks only in tabkyra-bridge. A new host must answer there too, and clean up both.
test("a new host also listens in the old folder, so an old client reconnects", { skip: !posix && "pipes on Windows", timeout: 30_000 }, async (t) => {
	const home = mkdtempSync(join(tmpdir(), "socket-dirs-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
	for (const k of ["POLYCARP_SOCKET_DIR", "TABKYRA_SOCKET_DIR"]) delete env[k];
	const host = spawn(process.execPath, [cli, "host", "chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/"], { env, stdio: ["pipe", "ignore", "pipe"] });
	t.after(() => host.kill("SIGKILL"));
	const user = userInfo().username;
	const fresh = `/tmp/polycarp-bridge-${user}/${host.pid}.sock`;
	const old = `/tmp/tabkyra-bridge-${user}/${host.pid}.sock`;
	const until = async (ok, what) => {
		for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(ok(), what);
	};
	await until(() => existsSync(fresh) && existsSync(old), "the host listens in both folders");
	await new Promise((resolve, reject) => {
		const sock = connect(old, () => {
			sock.destroy();
			resolve();
		});
		sock.on("error", reject);
	});
	const exited = new Promise((r) => host.once("exit", r));
	host.stdin.end();
	await exited;
	assert.ok(!existsSync(fresh) && !existsSync(old), "both sockets are gone when the host stops");
});
