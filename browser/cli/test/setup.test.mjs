// `tabkyra setup` and `tabkyra doctor` against a throwaway HOME, an empty socket
// directory, a fake extension build and a PATH holding only a node link plus fake
// harness CLIs. Nothing here can reach a real browser, bridge or harness config.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const sourceVersion = JSON.parse(readFileSync(join(here, "..", "..", "static", "manifest.chrome.json"), "utf8")).version;
let root;
let home;
let bin;
let socketDir;
let extensionDir;
let harnessLog;

const helium = () =>
	process.platform === "darwin"
		? join(home, "Library", "Application Support", "net.imput.helium")
		: join(home, ".config", "net.imput.helium");
const launcher = () => join(home, ".config", "tabkyra", "tabkyra");

/**
 * A fake `claude` or `codex`. `mcp get` answers with an entry running `configured` (with
 * `args`, at `scope`) or exits 1 when there is none. Every call is logged.
 */
function fakeHarness(name, configured, { args = "mcp", scope = "User config (available in all your projects)" } = {}) {
	const file = join(bin, name);
	const get = configured
		? `if [ "$2" = "get" ]; then printf '  Scope: %s\\n  Command: %s\\n  Args: %s\\n  command: %s\\n  args: %s\\n' "${scope}" "${configured}" "${args}" "${configured}" "${args}"; exit 0; fi`
		: `if [ "$2" = "get" ]; then exit 1; fi`;
	writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${harnessLog}"\n${get}\nexit 0\n`);
	chmodSync(file, 0o755);
}

/** A loadable-looking build: the files `tabkyra` checks for, with a chosen version. */
function fakeBuild(version) {
	mkdirSync(extensionDir, { recursive: true });
	for (const f of ["background.js", "sidepanel.js", "sidepanel.html", "app.css"]) writeFileSync(join(extensionDir, f), "");
	writeFileSync(join(extensionDir, "manifest.json"), JSON.stringify({ name: "Tabkyra", version }));
}

function run(args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		env: {
			HOME: home,
			PATH: bin,
			TABKYRA_SOCKET_DIR: socketDir,
			TABKYRA_EXTENSION_DIR: extensionDir,
			TERM: "xterm-256color",
			...extraEnv,
		},
		input: "",
		timeout: 20000,
	});
	return { code: result.status, out: result.stdout + result.stderr };
}

before(() => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-setup-"));
	home = join(root, "home");
	bin = join(root, "bin");
	socketDir = join(root, "sock");
	extensionDir = join(root, "dist-chrome");
	harnessLog = join(root, "harness.log");
	mkdirSync(home);
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "node"));
	mkdirSync(socketDir, { mode: 0o700 });
	mkdirSync(helium(), { recursive: true });
	writeFileSync(harnessLog, "");
	fakeBuild(sourceVersion);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("doctor fails with one fix per problem on a fresh machine", () => {
	const { code, out } = run(["doctor", "--json"]);
	assert.equal(code, 1);
	const report = JSON.parse(out);
	assert.equal(report.ok, false);
	const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
	assert.equal(byId.node.status, "ok");
	assert.equal(byId.build.status, "ok");
	assert.equal(byId["host:Helium"].status, "fail");
	assert.equal(byId["host:Helium"].fix, "tabkyra install --force");
	assert.equal(byId.connected.status, "fail");
	for (const check of report.checks) if (check.status === "fail") assert.ok(check.fix, `${check.id} has no fix`);
});

test("doctor flags a build from another version of the checkout", () => {
	fakeBuild("0.0.1");
	try {
		const build = JSON.parse(run(["doctor", "--json"]).out).checks.find((c) => c.id === "build");
		assert.equal(build.status, "fail");
		assert.match(build.label, /does not match this checkout/);
		assert.equal(build.fix, "tabkyra setup");
	} finally {
		fakeBuild(sourceVersion);
	}
});

test("setup --yes registers the host, wires harnesses to the launcher, then shows the load step", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude");
	fakeHarness("codex");
	const { code, out } = run(["setup", "--yes", "--no-wait"]);
	// Not connected (no browser), so setup reports "almost there" and exits 1.
	assert.equal(code, 1, out);
	assert.match(out, /Helium\s+registered/);
	assert.match(out, /Load unpacked/);
	assert.ok(out.includes(extensionDir), "prints the exact extension folder");
	assert.match(out, /Allow user scripts/);
	assert.ok(out.indexOf("Connect your coding agents") < out.indexOf("Load unpacked"), "agents are wired before the wait");

	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(calls.includes(`claude mcp add --scope user tabkyra -- ${launcher()} mcp`), calls);
	assert.ok(calls.includes(`codex mcp add tabkyra -- ${launcher()} mcp`), calls);
	// The launcher pins node by absolute path, so GUI-started harnesses need no PATH.
	assert.match(readFileSync(launcher(), "utf8"), new RegExp(`exec "/[^"]+node" "${cli.replaceAll("/", "\\/")}" "\\$@"`));

	const doctor = JSON.parse(run(["doctor", "--json"]).out);
	assert.equal(doctor.checks.find((c) => c.id === "host:Helium").status, "ok");
});

test("an entry pointing at a missing command is stale, and setup replaces it", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude", "/somewhere/gone/tabkyra");
	fakeHarness("codex", launcher());
	const checks = JSON.parse(run(["doctor", "--json"]).out).checks;
	const claude = checks.find((c) => c.id === "mcp:claude");
	assert.equal(claude.status, "fail");
	assert.match(claude.label, /missing command/);
	assert.match(claude.fix, /^claude mcp remove --scope user tabkyra && claude mcp add/);
	assert.equal(checks.find((c) => c.id === "mcp:codex").status, "ok", "the launcher with args mcp is this CLI");

	run(["setup", "--yes", "--no-wait"]);
	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(calls.includes("claude mcp remove --scope user tabkyra"), calls);
	assert.ok(!calls.includes("codex mcp add"), "a current entry is left alone");
});

test("an entry running some other command is flagged but never replaced under --yes", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude", "/bin/sh");
	fakeHarness("codex", launcher(), { args: "mcp --debug" });
	const checks = JSON.parse(run(["doctor", "--json"]).out).checks;
	assert.equal(checks.find((c) => c.id === "mcp:claude").status, "warn");
	assert.equal(checks.find((c) => c.id === "mcp:codex").status, "warn", "the launcher with other args is a customization, not breakage");

	const { out } = run(["setup", "--yes", "--no-wait"]);
	assert.match(out, /left alone/);
	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(!calls.includes("claude mcp remove") && !calls.includes("claude mcp add"), calls);
	assert.ok(!calls.includes("codex mcp remove") && !calls.includes("codex mcp add"), calls);
});

test("a Claude Code entry outside user scope is reported, and setup adds nothing over it", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude", launcher(), { scope: "Local config (private to you in this project)" });
	const check = JSON.parse(run(["doctor", "--json"]).out).checks.find((c) => c.id === "mcp:claude");
	assert.equal(check.status, "warn");
	assert.match(check.detail, /Local config/);
	run(["setup", "--yes", "--no-wait"]);
	assert.ok(!readFileSync(harnessLog, "utf8").includes("claude mcp add"));
});

test("setup without --yes and without a terminal never edits a harness config", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude");
	run(["setup", "--no-wait"]);
	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(calls.includes("claude mcp get tabkyra"), calls);
	assert.ok(!calls.includes("mcp add"), calls);
});

test("setup and doctor reject unknown flags and bad timeouts", () => {
	assert.equal(run(["doctor", "--jsno"]).code, 2);
	assert.equal(run(["setup", "--yse"]).code, 2);
	assert.equal(run(["setup", "--timeout=abc"]).code, 2);
	assert.equal(run(["setup", "--timeout", "0"]).code, 2);
});

test("allow and status validate their input before touching the bridge", () => {
	assert.equal(run(["allow", "not a host!"]).code, 2);
	assert.equal(run(["allow"]).code, 2);
	assert.equal(run(["status", "--jsno"]).code, 2);
	assert.equal(run(["allow", "com"]).code, 2, "a bare TLD is not a site");
	assert.equal(run(["allow", "localhost"]).code, 1, "localhost is a host; it fails only for lack of a browser");
	assert.equal(run(["status", "--help"]).code, 0);
	for (const args of [["ask", "github.com"], ["allow-all", "--force"], ["yolo", "x"], ["reload", "now"], ["install", "--yes"], ["allow", "a.com", "b.com"]]) {
		assert.equal(run(args).code, 2, `tabkyra ${args.join(" ")} should be a usage error`);
	}
	// A URL is reduced to its host; with no browser the command then fails with the next step.
	const { code, out } = run(["allow", "https://GitHub.com/baney75"]);
	assert.equal(code, 1);
	assert.match(out, /isn't connected/);
});

test("color only when asked for, and NO_COLOR wins", () => {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
	const ansi = /\x1b\[/;
	assert.doesNotMatch(run(["doctor"]).out, ansi, "a pipe gets no color");
	assert.match(run(["doctor"], { FORCE_COLOR: "1" }).out, ansi);
	assert.doesNotMatch(run(["doctor"], { FORCE_COLOR: "1", NO_COLOR: "1" }).out, ansi);
});
