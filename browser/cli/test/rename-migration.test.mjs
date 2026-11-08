// The rename from "tabkyra" to "polycarp" on disk: the one-time migration of the config, data and cache folders, the services,
// the POLYCARP_* variables that win over TABKYRA_*, and the launcher check before a service is installed. Everything runs the
// built CLI against a throwaway HOME with stub launchctl and systemctl first on PATH. Nothing here touches the real
// ~/.config/tabkyra, ~/.config/polycarp or a real service. Run with --experimental-strip-types (it imports src/env.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { envVar } from "../src/env.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-rename-"));
after(() => rmSync(root, { recursive: true, force: true }));
const serviceTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
const macTest = process.platform === "darwin" ? test : test.skip;

/** A machine: its own HOME, an empty socket folder, stub service managers, and none of the config overrides. */
function box(name, { launchctl = "" } = {}) {
	const dir = join(root, name);
	const home = join(dir, "home");
	const bin = join(dir, "bin");
	const log = join(dir, "calls.log");
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(dir, "sock"), { recursive: true, mode: 0o700 });
	symlinkSync(process.execPath, join(bin, "node"));
	const script = (file, body) => {
		writeFileSync(join(bin, file), `#!/bin/sh\n${body}`);
		chmodSync(join(bin, file), 0o755);
	};
	// launchctl print says "not loaded" (exit 1). Before it answers, `bootstrap` copies the launcher, so a test sees it as the service manager did.
	script("launchctl", `echo "launchctl $*" >> ${log}\ncase "$1" in\nprint) exit 1 ;;\nbootstrap) cp "${join(home, ".config", "polycarp", "browser", "polycarp")}" "${join(dir, "launcher-at-bootstrap")}" 2>/dev/null\n${launchctl || ":"} ;;\nesac\n`);
	script("systemctl", `echo "systemctl $*" >> ${log}\ncase "$2" in\nenable) cp "${join(home, ".config", "polycarp", "browser", "polycarp")}" "${join(dir, "launcher-at-bootstrap")}" 2>/dev/null ;;\nesac\n`);
	const env = { HOME: home, PATH: `${bin}:/bin:/usr/bin`, TABKYRA_SOCKET_DIR: join(dir, "sock"), NO_COLOR: "1", TABKYRA_NO_UPDATE_CHECK: "1" };
	return {
		dir,
		home,
		env,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		run: (args, extra = {}) => {
			const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000, input: "" });
			return { code: r.status, out: `${r.stdout}${r.stderr}` };
		},
		config: join(home, ".config", "polycarp", "browser"),
		oldConfig: join(home, ".config", "tabkyra"),
	};
}

const isLink = (path) => lstatSync(path).isSymbolicLink();
const write = (path, text, mode) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, mode ? { mode } : undefined);
};

/** A pre-rename machine: the old config folder with a launcher pair, secrets, a cache and a data folder. */
function oldMachine(name, options) {
	const m = box(name, options);
	write(join(m.oldConfig, "tabkyra"), '#!/bin/sh\nexec "/bin/echo" "$@"\n', 0o755);
	write(join(m.oldConfig, "host"), '#!/bin/sh\nexec "/bin/echo" host "$@"\n', 0o755);
	write(join(m.oldConfig, "remote.json"), '{"publicUrl":"https://old.example.com","port":8787}\n', 0o600);
	write(join(m.oldConfig, "oauth.json"), '{"secret":"keep-me"}\n', 0o600);
	write(join(m.home, ".cache", "tabkyra", "node-compile-cache", "x"), "cache");
	write(join(m.home, ".local", "share", "tabkyra", "threads", "t.json"), "{}");
	// The app's own folder is already there and must stay untouched.
	write(join(m.home, ".config", "polycarp", "config.toml"), "app = true\n");
	return m;
}

const migrate = (m) => m.run(["status", "--json"]);

function tree(path, out = []) {
	for (const name of readdirSync(path).sort()) {
		const p = join(path, name);
		out.push(isLink(p) ? `${p} -> ${readlinkSync(p)}` : p);
		if (!isLink(p) && lstatSync(p).isDirectory()) tree(p, out);
	}
	return out;
}

test("the first start moves ~/.config/tabkyra to ~/.config/polycarp/browser, leaves symlinks, and keeps the app's folder", () => {
	const m = oldMachine("move");
	migrate(m);
	assert.equal(readFileSync(join(m.config, "remote.json"), "utf8"), '{"publicUrl":"https://old.example.com","port":8787}\n');
	assert.equal(readFileSync(join(m.config, "oauth.json"), "utf8"), '{"secret":"keep-me"}\n', "secrets move as they are");
	assert.ok(isLink(m.oldConfig), "the old path is a symlink");
	assert.equal(realpathSync(m.oldConfig), realpathSync(m.config));
	// Launchers are renamed, and the old names still resolve.
	assert.equal(lstatSync(join(m.config, "polycarp")).isFile(), true);
	assert.equal(lstatSync(join(m.config, "polycarp-host")).isFile(), true);
	assert.ok(isLink(join(m.config, "tabkyra")) && isLink(join(m.config, "host")));
	assert.match(readFileSync(join(m.oldConfig, "tabkyra"), "utf8"), /bin\/echo/, "~/.config/tabkyra/tabkyra still runs the old launcher");
	// The data folder moves the same way; the cache moves with no symlink.
	assert.equal(readFileSync(join(m.home, ".local", "share", "polycarp", "browser", "threads", "t.json"), "utf8"), "{}");
	assert.ok(isLink(join(m.home, ".local", "share", "tabkyra")));
	assert.equal(readFileSync(join(m.home, ".cache", "polycarp", "node-compile-cache", "x"), "utf8"), "cache");
	assert.equal(existsSync(join(m.home, ".cache", "tabkyra")), false);
	assert.equal(readFileSync(join(m.home, ".config", "polycarp", "config.toml"), "utf8"), "app = true\n");
});

test("the migration runs twice without changing anything", () => {
	const m = oldMachine("twice");
	migrate(m);
	const before = [...tree(join(m.home, ".config")), ...tree(join(m.home, ".cache")), ...tree(join(m.home, ".local"))];
	const content = readFileSync(join(m.config, "oauth.json"), "utf8");
	migrate(m);
	assert.deepEqual([...tree(join(m.home, ".config")), ...tree(join(m.home, ".cache")), ...tree(join(m.home, ".local"))], before);
	assert.equal(readFileSync(join(m.config, "oauth.json"), "utf8"), content);
});

test("when the new folder exists too, nothing is moved or merged, and doctor reports the old one", () => {
	const m = oldMachine("both");
	write(join(m.config, "marker"), "new");
	migrate(m);
	assert.equal(lstatSync(m.oldConfig).isDirectory() && !isLink(m.oldConfig), true, "the old folder is still a real folder");
	assert.equal(readFileSync(join(m.config, "marker"), "utf8"), "new");
	assert.equal(existsSync(join(m.config, "oauth.json")), false, "nothing was merged in");
	assert.equal(existsSync(join(m.oldConfig, "oauth.json")), true);
	const doctor = JSON.parse(m.run(["doctor", "--json"]).out);
	const check = doctor.checks.find((c) => c.id === "legacy-folders");
	assert.ok(check, "doctor has a legacy-folders check");
	assert.match(check.detail, /\.config\/tabkyra/);
});

test("a folder chosen with TABKYRA_CONFIG_DIR is left where it is", () => {
	const m = oldMachine("chosen");
	const chosen = join(m.dir, "mine");
	write(join(chosen, "remote.json"), "{}");
	m.run(["status", "--json"], { TABKYRA_CONFIG_DIR: chosen });
	assert.ok(existsSync(join(chosen, "remote.json")));
	assert.equal(isLink(m.oldConfig), false, "the default location is not moved when a folder is chosen");
});

test("POLYCARP_BROWSER_CONFIG_DIR wins over TABKYRA_CONFIG_DIR, which still works alone", () => {
	const m = box("envwins");
	const a = join(m.dir, "a");
	const b = join(m.dir, "b");
	const setup = ["hub", "setup", "--public-url", "https://hub.example.com", "--port", "9431", "--no-service", "--no-passcode", "--json"];
	m.run(setup, { POLYCARP_BROWSER_CONFIG_DIR: a, TABKYRA_CONFIG_DIR: b });
	assert.ok(existsSync(join(a, "hub.json")), "POLYCARP_BROWSER_CONFIG_DIR was used");
	assert.equal(existsSync(join(b, "hub.json")), false, "TABKYRA_CONFIG_DIR was not");
	m.run(setup, { TABKYRA_CONFIG_DIR: b });
	assert.ok(existsSync(join(b, "hub.json")), "the old name still works alone");
});

test("envVar reads POLYCARP_ first, then TABKYRA_, and an empty value counts as unset", () => {
	assert.equal(envVar("X", { POLYCARP_X: "new", TABKYRA_X: "old" }), "new");
	assert.equal(envVar("X", { TABKYRA_X: "old" }), "old");
	assert.equal(envVar("X", { POLYCARP_X: "", TABKYRA_X: "old" }), "old");
	assert.equal(envVar("X", {}), undefined);
});

const legacyService = (m) =>
	process.platform === "darwin"
		? { file: join(m.home, "Library", "LaunchAgents", "com.tabkyra.serve.plist"), text: "<plist>old</plist>\n", fresh: join(m.home, "Library", "LaunchAgents", "com.polycarp.serve.plist") }
		: { file: join(m.home, ".config", "systemd", "user", "tabkyra-serve.service"), text: "[Service]\nExecStart=/old serve\n", fresh: join(m.home, ".config", "systemd", "user", "polycarp-serve.service") };

serviceTest("install reinstalls an old tabkyra service under the polycarp name and stops and deletes the old one", () => {
	const m = oldMachine("services");
	const old = legacyService(m);
	write(old.file, old.text);
	write(join(m.home, "Library", "Logs", "tabkyra-serve.log"), "history\n");
	m.run(["install"]);
	assert.equal(existsSync(old.file), false, "the old service file is deleted");
	const fresh = readFileSync(old.fresh, "utf8");
	const launcher = join(m.config, "polycarp");
	assert.ok(fresh.includes(launcher), `the new service runs the new launcher:\n${fresh}`);
	const calls = m.calls();
	const uid = process.getuid();
	if (process.platform === "darwin") {
		const stopOld = calls.indexOf(`launchctl bootout gui/${uid}/com.tabkyra.serve`);
		const startNew = calls.indexOf(`launchctl bootstrap gui/${uid} ${old.fresh}`);
		assert.ok(stopOld >= 0 && startNew > stopOld, `old service booted out before the new one starts:\n${calls.join("\n")}`);
		assert.equal(readFileSync(join(m.home, "Library", "Logs", "polycarp-serve.log"), "utf8"), "history\n", "the log was renamed");
		assert.equal(existsSync(join(m.home, "Library", "Logs", "tabkyra-serve.log")), false);
	} else {
		assert.ok(calls.includes("systemctl --user disable --now tabkyra-serve.service"), calls.join("\n"));
		assert.ok(calls.includes("systemctl --user enable polycarp-serve.service"), calls.join("\n"));
	}
	const again = m.run(["install"]);
	assert.equal(existsSync(old.file), false, again.out);
});

macTest("a bootstrap that fails with launchctl error 5 is retried until it works", () => {
	const m = box("retry", { launchctl: `n=$(cat "$0.count" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > "$0.count"\nif [ $n -le 2 ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi` });
	const old = legacyService(m);
	write(old.file, old.text);
	const r = m.run(["install"]);
	assert.doesNotMatch(r.out, /bootstrap failed/i, r.out);
	const bootstraps = m.calls().filter((c) => c.startsWith("launchctl bootstrap"));
	assert.equal(bootstraps.length, 3, `two refusals, then success:\n${m.calls().join("\n")}`);
	assert.equal(existsSync(old.file), false, "the old file goes only after the new service started");
});

macTest("an old service is brought back when the new one cannot be installed", () => {
	const m = box("restore", { launchctl: 'if [ "$2" != "$(id -u)" ]; then :; fi\ncase "$3" in *com.polycarp.serve.plist) echo boom >&2; exit 1 ;; esac' });
	const old = legacyService(m);
	write(old.file, old.text);
	m.run(["install"]);
	assert.equal(existsSync(old.file), true, "the old service file stays when the new one fails");
	assert.ok(m.calls().filter((c) => c.endsWith(old.file)).length >= 1, `the old service was bootstrapped again:\n${m.calls().join("\n")}`);
});

serviceTest("a launcher that points at another program is rewritten before the service is installed", () => {
	const m = box("stale");
	const launcher = join(m.config, "polycarp");
	write(launcher, '#!/bin/sh\nexec "/bin/echo" "$@"\n', 0o755);
	const old = legacyService(m);
	write(old.file, old.text);
	m.run(["install"]);
	const seen = readFileSync(join(m.dir, "launcher-at-bootstrap"), "utf8");
	assert.ok(seen.includes(cli), `the service manager saw a launcher running this CLI:\n${seen}`);
	assert.doesNotMatch(seen, /bin\/echo/);
});
