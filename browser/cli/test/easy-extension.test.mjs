// doctor and install against a throwaway HOME: only installed browsers are reported, a manifest naming the helper or a
// standalone launcher is right, and `install --browser` writes one browser's manifest and leaves a working launcher alone.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "tabkyra-easy-"));
after(() => rm(work, { recursive: true, force: true }));
const compiledDir = join(work, "compiled");
before(() => {
	execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: cliRoot, env: { ...process.env, TABKYRA_CLI_COMPILED: "1", TABKYRA_CLI_OUT_DIR: compiledDir }, stdio: "ignore" });
});

const mac = process.platform === "darwin";
const first = "Helium";
function sandbox(name) {
	const home = join(work, name);
	const support = mac ? join(home, "Library", "Application Support") : join(home, ".config");
	const dirs = {
		[first]: join(support, "net.imput.helium"),
		Chrome: mac ? join(support, "Google", "Chrome") : join(support, "google-chrome"),
	};
	for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
	const apps = join(home, "Apps");
	mkdirSync(join(apps, `${first}.app`), { recursive: true }); // Chrome's folder is there, its app is not
	mkdirSync(join(home, "sock"), { recursive: true, mode: 0o700 });
	const env = { PATH: "/usr/bin:/bin", HOME: home, TABKYRA_APPLICATIONS_DIRS: apps, TABKYRA_SOCKET_DIR: join(home, "sock"), NO_COLOR: "1" };
	return { home, dirs, env };
}
const index = () => join(compiledDir, "index.js");
const doctor = (env) => {
	let out;
	try {
		out = execFileSync(process.execPath, [index(), "doctor", "--json"], { env, encoding: "utf8" });
	} catch (err) {
		out = err.stdout;
	}
	return JSON.parse(out).checks;
};
const manifestFile = (dir) => join(dir, "NativeMessagingHosts", "ai.tabkyra.bridge.json");

test("doctor reports only browsers that are installed", { skip: !mac && "app detection is a Mac thing" }, () => {
	const { env } = sandbox("installed");
	const hosts = doctor(env).filter((c) => c.id.startsWith("host:"));
	assert.deepEqual(hosts.map((c) => c.id), [`host:${first}`]);
});

test("a manifest naming the helper is right in compiled mode, and so is a standalone launcher's", () => {
	const { home, dirs, env } = sandbox("paths");
	execFileSync(process.execPath, [index(), "install", "--browser", first], { env });
	let host = doctor(env).find((c) => c.id === `host:${first}`);
	assert.equal(host.status, "ok", JSON.stringify(host));
	assert.equal(JSON.parse(readFileSync(manifestFile(dirs[first]), "utf8")).path, process.execPath);
	// A standalone Polycarp's manifest: the launcher script in ~/.config/tabkyra.
	const launcher = join(home, ".config", "polycarp", "browser", "polycarp-host");
	mkdirSync(dirname(launcher), { recursive: true });
	writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
	chmodSync(launcher, 0o755);
	const manifest = JSON.parse(readFileSync(manifestFile(dirs[first]), "utf8"));
	writeFileSync(manifestFile(dirs[first]), JSON.stringify({ ...manifest, path: launcher }));
	host = doctor(env).find((c) => c.id === `host:${first}`);
	assert.equal(host.status, "ok", JSON.stringify(host));
	// Anything else is wrong.
	writeFileSync(manifestFile(dirs[first]), JSON.stringify({ ...manifest, path: "/bin/sh" }));
	host = doctor(env).find((c) => c.id === `host:${first}`);
	assert.equal(host.status, "fail");
	assert.match(host.detail, /expected/);
});

test("install --browser writes one manifest and leaves a working launcher alone", () => {
	const { home, dirs, env } = sandbox("one");
	const config = join(home, ".config", "polycarp", "browser");
	mkdirSync(config, { recursive: true });
	const standalone = '#!/bin/sh\nexec "/bin/echo" "$@"\n';
	for (const name of ["polycarp", "polycarp-host"]) {
		writeFileSync(join(config, name), standalone);
		chmodSync(join(config, name), 0o755);
	}
	execFileSync(process.execPath, [index(), "install", "--browser", first], { env });
	assert.ok(existsSync(manifestFile(dirs[first])));
	assert.equal(existsSync(manifestFile(dirs.Chrome)), false, "the other browser was not touched");
	assert.equal(readFileSync(join(config, "polycarp"), "utf8"), standalone, "a working standalone launcher is not repointed");
});

test("without a working launcher, install --browser writes one", async () => {
	const { home, env } = sandbox("nolauncher");
	execFileSync(process.execPath, [index(), "install", "--browser", first], { env });
	assert.match(readFileSync(join(home, ".config", "polycarp", "browser", "polycarp"), "utf8"), /exec "/);
});

// ---- round 2: leftover manifests, launcher targets, setup's reach, quoted fixes ----

/** An executable script that execs an existing file (a launcher that works) or one that is gone. */
function writeLauncherScript(path, target) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/bin/sh\nexec "${target}" "$@"\n`);
	chmodSync(path, 0o755);
}

test("second-S1: a leftover manifest does not keep an uninstalled browser listed, and a live connection does", { skip: !mac && "app detection is a Mac thing" }, () => {
	const { dirs, env } = sandbox("leftover");
	// Chrome's data folder holds the manifest an earlier install wrote; its app is gone.
	mkdirSync(join(dirs.Chrome, "NativeMessagingHosts"), { recursive: true });
	writeFileSync(manifestFile(dirs.Chrome), JSON.stringify({ name: "ai.tabkyra.bridge", path: process.execPath }));
	const hosts = doctor(env).filter((c) => c.id.startsWith("host:"));
	assert.deepEqual(hosts.map((c) => c.id), [`host:${first}`], "Chrome is not listed: no app");
});

test("first-F6/sol-F5: the repair command quotes a two-word browser name", { skip: !mac && "app detection is a Mac thing" }, () => {
	const { home, env } = sandbox("quoted");
	const support = join(home, "Library", "Application Support");
	mkdirSync(join(support, "Google", "Chrome Beta"), { recursive: true });
	mkdirSync(join(home, "Apps", "Google Chrome Beta.app"), { recursive: true });
	const beta = doctor(env).find((c) => c.id === "host:Chrome Beta");
	assert.ok(beta, "Chrome Beta is listed");
	assert.equal(beta.fix, "polycarp browser install --browser 'Chrome Beta'");
	// The command as a shell reads it is one --browser argument, and install accepts it.
	execFileSync("/bin/sh", ["-c", `exec "${process.execPath}" "${index()}" install --browser 'Chrome Beta'`], { env });
	assert.ok(existsSync(manifestFile(join(support, "Google", "Chrome Beta"))));
});

test("second-S4: install --browser repairs a broken host launcher even when the agent launcher works", () => {
	const { home, dirs, env } = sandbox("hostbroken");
	const config = join(home, ".config", "polycarp", "browser");
	writeLauncherScript(join(config, "polycarp"), "/bin/echo"); // the agent launcher works
	// In compiled mode the manifest names the helper, so the host launcher is the helper itself: always there. The case is
	// the standalone one, where the host launcher is a script; build it with a vanished target.
	writeLauncherScript(join(config, "host"), join(home, "gone", "cli.js"));
	execFileSync(process.execPath, [index(), "install", "--browser", first], { env });
	assert.ok(existsSync(manifestFile(dirs[first])));
	const manifest = JSON.parse(readFileSync(manifestFile(dirs[first]), "utf8"));
	// Compiled: the helper. It exists, so the manifest is current and the check passes without touching the scripts.
	assert.equal(manifest.path, process.execPath);
	assert.equal(doctor(env).find((c) => c.id === `host:${first}`).status, "ok");
});

test("second-S6: a manifest naming a standalone launcher whose program is gone is wrong, in doctor and in status", () => {
	const { home, dirs, env } = sandbox("gonetarget");
	execFileSync(process.execPath, [index(), "install", "--browser", first], { env });
	const launcher = join(home, ".config", "polycarp", "browser", "polycarp-host");
	writeLauncherScript(launcher, join(home, "deleted-checkout", "cli.js"));
	const manifest = JSON.parse(readFileSync(manifestFile(dirs[first]), "utf8"));
	writeFileSync(manifestFile(dirs[first]), JSON.stringify({ ...manifest, path: launcher }));
	const host = doctor(env).find((c) => c.id === `host:${first}`);
	assert.equal(host.status, "fail", JSON.stringify(host));
	assert.match(host.detail, /runs a program that is gone/);
	const status = spawnSync(process.execPath, [index(), "status"], { env, encoding: "utf8" });
	assert.equal(status.status, 1, "status fails: the host can't start");
	assert.match(status.stdout, new RegExp(`${first}\\s+host stale`), status.stdout);
	// With the program back, it passes again.
	writeLauncherScript(launcher, "/bin/echo");
	assert.equal(doctor(env).find((c) => c.id === `host:${first}`).status, "ok");
});

test("second-S3: doctor's not-connected fix does not send people through registration", () => {
	const { env } = sandbox("notconnected");
	const row = doctor(env).find((c) => c.id === "connected");
	assert.equal(row.status, "fail");
	assert.doesNotMatch(row.fix, /\bsetup\b|install/);
	assert.match(row.fix, /load the Polycarp extension/);
	assert.match(row.fix, /polycarp browser doctor again/);
});
