// The rename from "tabkyra" to "polycarp" on disk: the one-time migration of the config, data and cache folders, the services,
// the POLYCARP_* variables that win over TABKYRA_*, and the launcher check before a service is installed. Everything runs the
// built CLI against a throwaway HOME with stub launchctl and systemctl first on PATH. Nothing here touches the real
// ~/.config/tabkyra, ~/.config/polycarp or a real service. Run with --experimental-strip-types (it imports src/env.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
function box(name, { launchctl = "", systemctl = "" } = {}) {
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
	script("systemctl", `echo "systemctl $*" >> ${log}\ncase "$2" in\nenable) cp "${join(home, ".config", "polycarp", "browser", "polycarp")}" "${join(dir, "launcher-at-bootstrap")}" 2>/dev/null ;;\nesac\n${systemctl}\n`);
	const env = { HOME: home, PATH: `${bin}:/bin:/usr/bin`, TABKYRA_SOCKET_DIR: join(dir, "sock"), NO_COLOR: "1", TABKYRA_NO_UPDATE_CHECK: "1" };
	return {
		dir,
		home,
		env,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		run: (args, extra = {}) => {
			const merged = Object.fromEntries(Object.entries({ ...env, ...extra }).filter(([, v]) => v !== undefined));
			const r = spawnSync(process.execPath, [cli, ...args], { env: merged, encoding: "utf8", timeout: 30_000, input: "" });
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
	assert.equal(existsSync(old.fresh), false, "the new service file is removed when its install fails");
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

macTest("an error 5 that outlasts the retry window also removes the new service and restores the old one", () => {
	const m = box("retry-out", { launchctl: 'echo "Bootstrap failed: 5: Input/output error" >&2; exit 5' });
	const old = legacyService(m);
	write(old.file, old.text);
	const r = m.run(["install"]);
	assert.equal(existsSync(old.fresh), false, r.out);
	assert.equal(existsSync(old.file), true);
	assert.ok(m.calls().filter((c) => c.endsWith(old.file)).length >= 1, "the old service was bootstrapped again");
});

serviceTest("an exception while writing the new service file still restores the old service", () => {
	const m = box("throws");
	const old = legacyService(m);
	write(old.file, old.text);
	// A folder where the new file should go makes the write throw after the old service has stopped.
	mkdirSync(old.fresh, { recursive: true });
	m.run(["install"]);
	const calls = m.calls();
	const restored = process.platform === "darwin" ? calls.filter((c) => c.endsWith(old.file) && c.startsWith("launchctl bootstrap")) : calls.filter((c) => c === "systemctl --user enable --now tabkyra-serve.service");
	assert.equal(restored.length, 1, `the old service was started again:\n${calls.join("\n")}`);
	assert.equal(existsSync(old.file), true);
});

test("on Linux a failed restart disables and removes the new unit before the old one is enabled again", { skip: process.platform !== "linux" }, () => {
	const m = box("restart", { systemctl: 'case "$2" in restart) echo boom >&2; exit 1 ;; esac' });
	const old = legacyService(m);
	write(old.file, old.text);
	m.run(["install"]);
	const calls = m.calls();
	const off = calls.indexOf("systemctl --user disable --now polycarp-serve.service");
	const on = calls.indexOf("systemctl --user enable --now tabkyra-serve.service");
	assert.ok(off >= 0 && on > off, calls.join("\n"));
	assert.equal(existsSync(old.fresh), false);
});

/** An old service definition that saved its folders, the way the previous release wrote them. */
function oldServiceWith(m, config, socket) {
	const old = legacyService(m);
	const text =
		process.platform === "darwin"
			? `<plist><dict><key>EnvironmentVariables</key><dict><key>TABKYRA_CONFIG_DIR</key><string>${config}</string>${socket ? `<key>TABKYRA_SOCKET_DIR</key><string>${socket}</string>` : ""}</dict></dict></plist>\n`
			: `[Service]\nExecStart=/old serve\nEnvironment=TABKYRA_CONFIG_DIR=${config}\n${socket ? `Environment=TABKYRA_SOCKET_DIR=${socket}\n` : ""}`;
	write(old.file, text);
	return old;
}

serviceTest("the new service keeps the folders the old service had saved, not the shell's defaults", () => {
	const m = box("keepenv");
	const config = join(m.dir, "custom-config");
	const socket = join(m.dir, "custom-sock");
	mkdirSync(config, { recursive: true });
	const old = oldServiceWith(m, config, socket);
	m.run(["install"], { TABKYRA_SOCKET_DIR: undefined });
	const fresh = readFileSync(old.fresh, "utf8");
	assert.ok(fresh.includes(config), `config folder kept:\n${fresh}`);
	assert.ok(fresh.includes(socket), `socket folder kept:\n${fresh}`);
	assert.ok(new RegExp(`POLYCARP_BROWSER_CONFIG_DIR(</key>\\s*<string>|=)${config}`).test(fresh), "the saved config folder is the variable's value, not the shell's default");
});

serviceTest("an old service that used the default ~/.config/tabkyra gets the migrated folder, or keeps the old one when it could not move", () => {
	const moved = oldMachine("env-moved");
	const oldA = oldServiceWith(moved, moved.oldConfig);
	moved.run(["install"]);
	assert.ok(readFileSync(oldA.fresh, "utf8").includes(moved.config), "the service uses the migrated folder");
	// The polycarp folder exists too, so nothing moved and the old folder still holds the state.
	const stuck = oldMachine("env-stuck");
	write(join(stuck.config, "marker"), "new");
	const oldB = oldServiceWith(stuck, stuck.oldConfig);
	stuck.run(["install"]);
	const fresh = readFileSync(oldB.fresh, "utf8");
	assert.ok(fresh.includes(stuck.oldConfig) && !fresh.includes(`${stuck.config}<`) && !fresh.includes(`CONFIG_DIR=${stuck.config}`), `the service keeps the folder with the grants:\n${fresh}`);
});

test("when a link cannot be made the move is undone and ordinary commands still work", () => {
	const m = oldMachine("nolink");
	const r = m.run(["status", "--json"], { POLYCARP_TEST_NO_LINK: "1" });
	assert.notEqual(r.code, null);
	assert.equal(lstatSync(m.oldConfig).isDirectory() && !isLink(m.oldConfig), true, "the old folder is back where it was");
	assert.equal(readFileSync(join(m.oldConfig, "oauth.json"), "utf8"), '{"secret":"keep-me"}\n');
	assert.equal(existsSync(m.config), false);
	assert.equal(lstatSync(join(m.oldConfig, "tabkyra")).isFile(), true, "the launchers were not renamed either");
	const check = JSON.parse(m.run(["doctor", "--json"], { POLYCARP_TEST_NO_LINK: "1" }).out).checks.find((c) => c.id === "legacy-folders");
	assert.ok(check, "doctor reports the old folder");
});

test("two helpers migrating at the same moment leave a real launcher and a link to it, never a loop", async () => {
	const m = box("race");
	const chosen = join(m.dir, "mine");
	write(join(chosen, "tabkyra"), '#!/bin/sh\nexec "/bin/echo" "$@"\n', 0o755);
	write(join(chosen, "host"), '#!/bin/sh\nexec "/bin/echo" host "$@"\n', 0o755);
	// Each waits half a second between its check and its rename, so the second one starts its check before the first one renames.
	const env = { ...m.env, TABKYRA_CONFIG_DIR: chosen, POLYCARP_TEST_MIGRATE_PAUSE_MS: "500" };
	const start = () => new Promise((resolve) => spawn(process.execPath, [cli, "status", "--json"], { env }).on("close", resolve));
	const first = start();
	await new Promise((resolve) => setTimeout(resolve, 150));
	await Promise.all([first, start()]);
	for (const [real, old] of [["polycarp", "tabkyra"], ["polycarp-host", "host"]]) {
		assert.equal(lstatSync(join(chosen, real)).isFile(), true, `${real} is a real file`);
		assert.equal(isLink(join(chosen, old)), true, `${old} is a link`);
		assert.equal(readlinkSync(join(chosen, old)), real);
		assert.match(readFileSync(join(chosen, old), "utf8"), /bin\/echo/, `${old} still reads through to the launcher`);
	}
});

test("when a move is undone the old folder stays the one in use, so settings and credentials are still found", () => {
	const m = oldMachine("stranded");
	write(join(m.oldConfig, "theme.json"), JSON.stringify({ preset: "forest" }));
	const env = { POLYCARP_TEST_NO_LINK: "1" };
	assert.equal(JSON.parse(m.run(["theme", "list", "--json"], env).out).preset, "forest", "the saved choice is found in the old folder");
	m.run(["theme", "set", "slate", "--json"], env);
	assert.equal(existsSync(m.config), false, "no new folder was created beside the old one");
	assert.equal(JSON.parse(readFileSync(join(m.oldConfig, "theme.json"), "utf8")).preset, "slate");
	m.run(["status", "--json"]);
	assert.equal(JSON.parse(readFileSync(join(m.config, "theme.json"), "utf8")).preset, "slate");
	assert.equal(JSON.parse(m.run(["theme", "list", "--json"]).out).preset, "slate");
});

test("with XDG_CONFIG_HOME set elsewhere, what the old release kept in ~/.config/tabkyra moves too", () => {
	const m = box("xdg");
	const xdgConfig = join(m.dir, "xdg-config");
	const xdgData = join(m.dir, "xdg-data");
	write(join(xdgConfig, "tabkyra", "remote.json"), '{"port":8787}');
	// Home-folder only, whatever XDG said: credentials, update settings, launchers.
	write(join(m.home, ".config", "tabkyra", "subscriptions", "openai", "token.json"), "secret");
	write(join(m.home, ".config", "tabkyra", "update.json"), '{"policy":"auto"}');
	write(join(m.home, ".config", "tabkyra", "tabkyra"), '#!/bin/sh\nexec "/bin/echo" "$@"\n', 0o755);
	write(join(xdgData, "tabkyra", "threads", "t.json"), "{}");
	write(join(m.home, ".local", "share", "tabkyra", "copilot-sdk", "package.json"), "{}");
	m.run(["status", "--json"], { XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData });
	const config = join(xdgConfig, "polycarp", "browser");
	assert.equal(readFileSync(join(config, "remote.json"), "utf8"), '{"port":8787}');
	assert.equal(readFileSync(join(config, "subscriptions", "openai", "token.json"), "utf8"), "secret", "sign-ins move with the rest");
	assert.equal(readFileSync(join(config, "update.json"), "utf8"), '{"policy":"auto"}');
	assert.equal(lstatSync(join(config, "polycarp")).isFile(), true, "the home launcher became the polycarp launcher");
	assert.match(readFileSync(join(m.home, ".config", "tabkyra", "tabkyra"), "utf8"), /bin\/echo/, "the old home path still reaches it");
	const data = join(xdgData, "polycarp", "browser");
	assert.equal(readFileSync(join(data, "threads", "t.json"), "utf8"), "{}");
	assert.equal(readFileSync(join(data, "copilot-sdk", "package.json"), "utf8"), "{}", "the Copilot SDK moves too");
});
