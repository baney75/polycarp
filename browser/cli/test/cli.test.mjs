// The command line itself: one version, help and completions generated from one command
// table, --json on the read commands, and the documented exit codes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const repo = join(here, "..", "..");
const home = mkdtempSync(join(tmpdir(), "tabkyra-cli-"));
const socketDir = join(home, "sock");
mkdirSync(socketDir, { mode: 0o700 });
after(() => rmSync(home, { recursive: true, force: true }));

function run(...args) {
	// Nothing from the developer's own Polycarp setup (config dir, session, extension dir) leaks in.
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TABKYRA_") && k !== "XDG_CONFIG_HOME"));
	Object.assign(env, { HOME: home, TABKYRA_SOCKET_DIR: socketDir, NO_COLOR: "1" });
	// A command that ignores an unknown flag could start serving; the timeout turns that into a failure.
	const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 20000 });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

const manifestVersion = JSON.parse(readFileSync(join(repo, "static", "manifest.chrome.json"), "utf8")).version;

test("the CLI's version is the extension manifest's", async () => {
	assert.equal(run("--version").out.trim(), manifestVersion);
	assert.equal(run("version").out.trim(), manifestVersion);
	const json = JSON.parse(run("version", "--json").out);
	assert.equal(json.version, manifestVersion);
	assert.match(json.builtAt, /^\d{4}-/);
	// The doctor and the MCP server's initialize reply report the same number.
	assert.equal(JSON.parse(run("doctor", "--json").out).version, manifestVersion);
	const mcp = new Client({ name: "version-test", version: "0.0.0" });
	await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { HOME: home, PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: socketDir }, stderr: "ignore" }));
	try {
		assert.deepEqual(mcp.getServerVersion(), { name: "tabkyra", version: manifestVersion });
	} finally {
		await mcp.close();
	}
});

test("help lists every command the CLI dispatches, grouped, with the exit codes", () => {
	const help = run("--help").out;
	for (const name of ["setup", "status", "mcp", "skill", "serve", "token", "tunnel", "library", "allow", "ask", "allow-all", "doctor", "update", "install", "reload", "debug", "completion", "version"]) {
		assert.match(help, new RegExp(`polycarp browser ${name}\\b`), `help lacks ${name}`);
		// A listed command is one the dispatcher knows: it never says "Unknown command".
		const r = run(name, "--definitely-not-a-flag");
		assert.doesNotMatch(r.err, /Unknown command/, name);
		// ...and an unknown flag is a usage error, never ignored (serve used to start serving).
		assert.equal(r.code, 2, `${name} --definitely-not-a-flag exited ${r.code}: ${r.err}`);
	}
	for (const group of ["Get started", "Agents", "Remote", "Library", "Sites", "Troubleshoot"]) assert.match(help, new RegExp(`\\n${group}\\n`));
	assert.match(help, /Exit codes: 0 success, 1 failed, not connected or nothing found, 2 usage error; update --check 100/);
	// Every subcommand has a help row.
	for (const [command, subs] of Object.entries({
		skill: ["install", "list", "print", "lint", "apply", "revert", "match", "eval", "versions", "rollback", "edit", "refresh"],
		token: ["create", "list", "revoke", "scopes"],
		tunnel: ["tailscale", "cloudflare"],
		library: ["add", "search", "list", "cite", "export", "obsidian", "verify", "remove"],
	}))
		for (const sub of subs) assert.match(help, new RegExp(`polycarp browser ${command} [^\\n]*\\b${sub}\\b`), `help has no row for ${command} ${sub}`);
	const unknown = run("frobnicate");
	assert.equal(unknown.code, 2);
	assert.match(unknown.err, /Unknown command "frobnicate"/);
});

test("options are checked per subcommand, and a value option needs its value", () => {
	for (const args of [
		["token", "create", "x", "--scope", "browser.read", "--json"],
		["token", "revoke", "x", "--scope", "a"],
		["token", "list", "--scope", "a"],
		["tunnel", "cloudflare", "--public"],
		["serve", "--port"],
		["serve", "--port="],
		["tunnel", "tailscale", "--port"],
		["--version", "--bogus"],
		["-v", "--bogus"],
		["setup", "--bogus"],
		["update", "--bogus"],
	]) {
		const r = run(...args);
		assert.equal(r.code, 2, `tabkyra ${args.join(" ")} exited ${r.code}: ${r.out}${r.err}`);
		assert.match(r.err, /Unknown option|needs a value|Usage/);
	}
	assert.match(run("serve", "--port").err, /--port needs a value/);
	// A switch with a value is refused, not ignored: --off=1 used to run the tunnel instead.
	for (const args of [["tunnel", "tailscale", "--off=1"], ["status", "--json=1"], ["install", "--force=yes"], ["version", "--json=true"], ["library", "list", "--json=1"], ["library", "search", "x", "--json=false"]]) {
		const r = run(...args);
		assert.equal(r.code, 2, `tabkyra ${args.join(" ")} exited ${r.code}`);
		assert.match(r.err, /takes no value/);
	}
	assert.match(run("pi-extension", "a", "b").err, /Usage: polycarp browser pi-extension \[dir\]/);
	assert.match(run("serve", "--port").err, /needs a value\. Usage: polycarp browser serve \[--port N\] \[--public-url https:\/\/host\] \[--redirect-host a,b\] \[--allow-host a,b\]$/m);
	assert.match(run("token", "create", "x", "--bogus").err, /Usage: polycarp browser token create <name> \[--scope a,b\]$/m);
	assert.match(run("token", "revoke", "--bogus").err, /Usage: polycarp browser token revoke <id\|name\|client id\|grant id>$/m);
	// The value of a value option isn't counted as an extra argument.
	assert.equal(run("token", "list", "--json").code, 0);
});

test("completions parse in each shell and complete commands, subcommands and flags", (t) => {
	const zsh = run("completion", "zsh");
	assert.equal(zsh.code, 0);
	assert.match(zsh.out, /^#compdef tabkyra/);
	assert.match(zsh.out, /'completion:/);
	const bash = run("completion", "bash").out;
	const fish = run("completion", "fish").out;
	assert.match(fish, /complete -c tabkyra -n __fish_use_subcommand -f -a status/);
	assert.match(fish, /__fish_seen_subcommand_from skill; and not __fish_seen_subcommand_from [a-z ]+' -f -a lint/);
	const file = join(home, "tk.bash");
	execFileSync("sh", ["-c", 'cat > "$1"', "sh", file], { input: bash });
	const complete = (words) =>
		execFileSync("bash", ["-c", `source "${file}"; COMP_WORDS=(${words}); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); _tabkyra; echo "\${COMPREPLY[@]}"`], { encoding: "utf8" }).trim();
	assert.equal(complete("tabkyra sta"), "status");
	assert.equal(complete("tabkyra skill li").split(" ").sort().join(" "), "lint list");
	assert.equal(complete("tabkyra doctor --j"), "--json");
	// Only the chosen subcommand's flags: create takes no --json, cloudflare no --public.
	assert.equal(complete("tabkyra token create x --j"), "");
	assert.equal(complete("tabkyra token list --j"), "--json");
	assert.equal(complete("tabkyra tunnel cloudflare --p"), "--port");
	// Path arguments fall back to file names: nothing from the script, and -o default set.
	assert.equal(complete("tabkyra skill apply sk"), "");
	assert.equal(complete("tabkyra skill eval --cases ev"), "");
	assert.match(execFileSync("bash", ["-c", `source "${file}"; complete -p tabkyra`], { encoding: "utf8" }), /-o bashdefault -o default -F _tabkyra tabkyra/);
	// fish: files only where paths go.
	assert.match(fish, /__fish_seen_subcommand_from skill; and __fish_seen_subcommand_from list' -f/);
	assert.doesNotMatch(fish, /__fish_seen_subcommand_from skill; and __fish_seen_subcommand_from lint' -f/);
	assert.match(fish, /-l cases -r -F/);
	// bash: no file names where nothing takes a path; a value flag completes its values, not flags.
	const withCompopt = (words) =>
		execFileSync("bash", ["-c", `compopt() { echo "compopt $*"; }; source "${file}"; COMP_WORDS=(${words} ""); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); _tabkyra; echo "R:\${COMPREPLY[*]}"`], { encoding: "utf8" }).trim();
	assert.match(withCompopt("tabkyra mcp"), /compopt \+o default/);
	assert.match(withCompopt("tabkyra token revoke"), /compopt \+o default/);
	assert.doesNotMatch(withCompopt("tabkyra skill apply"), /compopt/);
	// ...and an empty word there gets file names (nothing from the script), not just "--yes".
	assert.match(withCompopt("tabkyra skill apply"), /R:$/);
	assert.match(withCompopt("tabkyra library obsidian"), /R:$/);
	assert.match(withCompopt("tabkyra update --channel"), /R:stable nightly$/);
	assert.match(withCompopt("tabkyra tunnel tailscale --port"), /R:$/);
	if (spawnSync("zsh", ["--version"]).status === 0) assert.equal(spawnSync("zsh", ["-n"], { input: zsh.out }).status, 0, "zsh script has a syntax error");
	else t.diagnostic("zsh is not installed here: the zsh script's syntax was not checked");
	// Loaded from a zshrc that never ran compinit, it must not fail with "command not found: compdef".
	if (spawnSync("zsh", ["--version"]).status === 0) {
		const plain = spawnSync("zsh", ["-f", "-c", `eval "$(cat)"; whence -w _tabkyra; whence -w compinit compdef`], { input: zsh.out, encoding: "utf8", env: { ...process.env, HOME: home } });
		assert.equal(plain.status === 0 || plain.status === 1, true, plain.stderr);
		assert.doesNotMatch(plain.stderr, /compdef|insecure/);
		assert.match(plain.stdout, /_tabkyra: function/);
		// It never runs compinit itself: that is the zshrc's job, and a second run can prompt.
		assert.match(plain.stdout, /compdef: none/);
		// With compinit already run, it registers at once.
		const ready = spawnSync("zsh", ["-f", "-c", `autoload -Uz compinit && compinit -u; eval "$(cat)"; echo \${_comps[tabkyra]}`], { input: zsh.out, encoding: "utf8", env: { ...process.env, HOME: home } });
		assert.equal(ready.stdout.trim(), "_tabkyra", ready.stderr);
	}
	// Hidden aliases stay out.
	assert.doesNotMatch(bash, /\byolo\b/);
	const bad = run("completion", "powershell");
	assert.equal(bad.code, 2);
	assert.match(bad.err, /polycarp browser completion zsh\|bash\|fish/);
});

test("read commands print JSON with --json, and exit 1 when not connected", () => {
	const status = run("status", "--json");
	assert.equal(status.code, 1);
	assert.equal(JSON.parse(status.out).connected, false);
	assert.deepEqual(JSON.parse(run("token", "list", "--json").out), []);
	const scopes = JSON.parse(run("token", "scopes", "--json").out);
	for (const scope of ["browser.read", "library.read", "skills.read"]) {
		assert.equal(typeof scopes[scope]?.what, "string", scope);
		assert.ok(Array.isArray(scopes[scope].tools) && scopes[scope].tools.length > 0, scope);
	}
	assert.deepEqual(JSON.parse(run("library", "list", "--json").out), []);
	const search = run("library", "search", "nothing", "--json");
	assert.deepEqual(JSON.parse(search.out), []);
	assert.equal(search.code, 1, "no match exits 1");
	assert.ok(Array.isArray(JSON.parse(run("skill", "list", "--json").out)));
});

test("the launcher harnesses run turns on Node's compile cache without overriding the user's", () => {
	run("install");
	const launcher = join(home, ".config", "tabkyra", "tabkyra");
	const text = readFileSync(launcher, "utf8");
	assert.match(text, /: "\$\{NODE_COMPILE_CACHE:=.*node-compile-cache\}"\nexport NODE_COMPILE_CACHE\nexec /);
	assert.ok(statSync(launcher).mode & 0o100);
	const out = execFileSync(launcher, ["--version"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
	assert.equal(out.trim(), manifestVersion);
	// What the launcher's prefix leaves in the environment: the user's value if set, else ours.
	const prefix = text.split("\n").slice(1, 3).join("\n");
	const effective = (extra) => execFileSync("sh", ["-c", `${prefix}\nprintf %s "$NODE_COMPILE_CACHE"`], { env: { PATH: process.env.PATH, HOME: home, ...extra }, encoding: "utf8" });
	assert.equal(effective({ NODE_COMPILE_CACHE: "/tmp/mine" }), "/tmp/mine");
	assert.match(effective({}), /\.cache\/tabkyra\/node-compile-cache$/);
	// The native host the browser starts keeps its environment as it was.
	assert.doesNotMatch(readFileSync(join(home, ".config", "tabkyra", "host"), "utf8"), /NODE_COMPILE_CACHE/);
});

test("help rows and the parsers agree on every flag, including setup's and update's own parsers", async () => {
	const { build } = await import("esbuild");
	const out = join(home, "tables.mjs");
	await build({
		stdin: {
			contents:
				'export { COMMANDS, argsProblem, helpRows } from "./src/commands.ts"; export { LIBRARY_OPTIONS } from "./src/library.ts"; export { parseSetupArgs, parseUpdateArgs } from "./src/parse-args.ts";',
			resolveDir: join(here, ".."),
			loader: "ts",
		},
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: out,
		loader: { ".md": "text", ".pub": "text" },
		logLevel: "silent",
	});
	const { COMMANDS, LIBRARY_OPTIONS, argsProblem, helpRows, parseSetupArgs, parseUpdateArgs } = await import(out);
	// setup and update parse their own options: every flag their help row shows is one they take.
	const sample = { "--timeout": "5", "--channel": "stable", "--auto-check": "on" };
	for (const [name, parse, extra] of [["setup", parseSetupArgs, []], ["update", parseUpdateArgs, ["--check"]]]) {
		for (const flag of COMMANDS.find((c) => c.name === name).flags) {
			const args = [...extra.filter((e) => e !== flag), flag, ...(sample[flag] ? [sample[flag]] : [])];
			const r = parse(name === "update" && flag === "--rollback" ? ["--rollback"] : args);
			assert.equal(typeof r, "object", `${name} ${flag}: ${r}`);
		}
		assert.match(parse(["--bogus"]), /Unknown option/);
	}
	// Every flag a help row shows is one the parser accepts for that row's subcommand.
	for (const spec of COMMANDS.filter((c) => !c.hidden && !c.selfParsed)) {
		for (const [usage] of helpRows(spec)) {
			const words = usage.split(" ");
			const sub = spec.subcommands ? [words[1]] : [];
			for (const [, flag, hint] of usage.matchAll(/\[(--[a-z-]+)( [^\]]+)?\]/g)) {
				const problem = argsProblem(spec.name, [...sub, flag, ...(hint ? ["v"] : [])]);
				assert.ok(!problem || !/Unknown option|takes no value|needs a value/.test(problem), `help row "tabkyra ${usage}" shows ${flag}, which the parser refuses: ${problem}`);
			}
		}
	}
	const library = COMMANDS.find((c) => c.name === "library");
	assert.deepEqual(
		Object.fromEntries(library.subcommands.map((s) => [s.name, [...(s.flags ?? [])].sort()])),
		Object.fromEntries(Object.entries(LIBRARY_OPTIONS).map(([k, v]) => [k, [...v].sort()])),
	);
});

test("token list and token list --json agree on when a token was last used", () => {
	const dir = join(home, ".config", "tabkyra");
	mkdirSync(dir, { recursive: true });
	const record = { id: "t1", name: "phone", scopes: ["browser.read"], sha256: "0".repeat(64), createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: "2026-10-20T00:00:00.000Z" };
	writeFileSync(join(dir, "tokens.json"), JSON.stringify({ tokens: [record] }));
	const [json] = JSON.parse(run("token", "list", "--json").out);
	assert.equal(json.lastUsed, "2026-10-20T00:00:00.000Z");
	assert.equal(json.sha256, undefined, "token list --json must not print the token hash");
	assert.match(run("token", "list").out, /phone .* last used 2026-10-20T00:00:00\.000Z/);
	rmSync(join(dir, "tokens.json"));
});
