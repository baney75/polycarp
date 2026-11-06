// doctor and install against a throwaway HOME: only installed browsers are reported, a manifest naming the helper or a
// standalone launcher is right, and `install --browser` writes one browser's manifest and leaves a working launcher alone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
	// A standalone Tabkyra's manifest: the launcher script in ~/.config/tabkyra.
	const launcher = join(home, ".config", "tabkyra", "host");
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
	const config = join(home, ".config", "tabkyra");
	mkdirSync(config, { recursive: true });
	const standalone = '#!/bin/sh\nexec "/bin/echo" "$@"\n';
	for (const name of ["tabkyra", "host"]) {
		writeFileSync(join(config, name), standalone);
		chmodSync(join(config, name), 0o755);
	}
	execFileSync(process.execPath, [index(), "install", "--browser", first], { env });
	assert.ok(existsSync(manifestFile(dirs[first])));
	assert.equal(existsSync(manifestFile(dirs.Chrome)), false, "the other browser was not touched");
	assert.equal(readFileSync(join(config, "tabkyra"), "utf8"), standalone, "a working standalone launcher is not repointed");
});

test("without a working launcher, install --browser writes one", async () => {
	const { home, env } = sandbox("nolauncher");
	execFileSync(process.execPath, [index(), "install", "--browser", first], { env });
	assert.match(readFileSync(join(home, ".config", "tabkyra", "tabkyra"), "utf8"), /exec "/);
});
