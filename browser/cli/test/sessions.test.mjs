// Sessions from the CLI's side: which session `tabkyra mcp` picks, how tabs_context reads, and
// `tabkyra sessions` / `tabkyra tabs` without a browser. The live behavior is in e2e-bridge.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-sessions-"));
after(() => rmSync(root, { recursive: true, force: true }));

let chooseSession;
let formatContext;

before(async () => {
	const { build } = await import("esbuild");
	const out = join(root, "bundle.mjs");
	await build({
		stdin: { contents: 'export { chooseSession } from "./src/session-name.ts"; export { formatContext } from "./src/mcp.ts";', resolveDir: join(here, ".."), loader: "ts" },
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: out,
		loader: { ".md": "text", ".pub": "text" },
		logLevel: "silent",
	});
	({ chooseSession, formatContext } = await import(out));
});

function repo(...parts) {
	const dir = join(root, ...parts);
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", dir]);
	return dir;
}

test("a session name the user gives wins: --session, then TABKYRA_SESSION", () => {
	const dir = repo("named");
	assert.deepEqual(chooseSession({ flag: "research", env: { TABKYRA_SESSION: "other" }, cwd: dir }), { name: "research", auto: false, named: true });
	assert.deepEqual(chooseSession({ env: { TABKYRA_SESSION: "other" }, cwd: dir }), { name: "other", auto: false, named: true });
});

test("otherwise the project decides: the same repo resumes, another folder of the same name doesn't", () => {
	const a = repo("a", "shop");
	const b = repo("b", "shop");
	mkdirSync(join(a, "src", "deep"), { recursive: true });
	const top = chooseSession({ env: {}, cwd: a });
	assert.equal(top.auto, true);
	assert.equal(top.project, "shop");
	assert.match(top.name, /^shop-[0-9a-f]{4}$/);
	// A subfolder of the repo is the same project.
	assert.deepEqual(chooseSession({ env: {}, cwd: join(a, "src", "deep") }), top);
	// Harness conversation ids don't split a project into many sessions any more.
	assert.deepEqual(chooseSession({ env: { CLAUDE_SESSION_ID: "x", CODEX_THREAD_ID: "y" }, cwd: a }), top);
	const other = chooseSession({ env: {}, cwd: b });
	assert.equal(other.project, "shop");
	assert.notEqual(other.name, top.name, "two folders named shop shared a session");
	// Not a repository: the folder itself.
	const plain = join(root, "My Notes!");
	mkdirSync(plain);
	assert.match(chooseSession({ env: {}, cwd: plain }).name, /^my-notes-[0-9a-f]{4}$/);
});

test("outside a project (the disk root, the home folder, a home that is a git repo) each process gets its own session", () => {
	const home = repo("dotfiles-home");
	mkdirSync(join(home, "Downloads"), { recursive: true });
	for (const cwd of ["/", home, join(home, "Downloads")]) {
		const a = chooseSession({ env: {}, cwd, home, pid: 101 });
		const b = chooseSession({ env: {}, cwd, home, pid: 202 });
		assert.equal(a.auto, false, cwd);
		assert.equal(a.named, undefined, cwd);
		assert.notEqual(a.name, b.name, `two agents started in ${cwd} would share one session`);
	}
	// A real project under that home is still a project.
	const shop = repo("dotfiles-home", "code", "shop");
	assert.equal(chooseSession({ env: {}, cwd: shop, home }).project, "shop");
});

test("tabs_context is a few short lines: the session, news, then one line per tab", () => {
	const text = formatContext({
		session: { name: "shop-1a2b", group: { title: "Tabkyra · claude · shop", color: "blue", collapsed: true }, currentTabId: 7 },
		notices: ["The user took tab 9 out of your group; it's theirs now and you can't use it."],
		tabs: [
			{ tabId: 7, url: "https://example.com/cart", title: "Cart", current: true },
			{ tabId: 8, url: "https://example.com/", title: "Shop", current: false },
		],
	});
	assert.equal(
		text,
		[
			'Session shop-1a2b | group "Tabkyra · claude · shop" (blue, collapsed by the user) | 2 tabs',
			"News: The user took tab 9 out of your group; it's theirs now and you can't use it.",
			'* 7 "Cart" https://example.com/cart',
			'  8 "Shop" https://example.com/',
		].join("\n"),
	);
	assert.match(formatContext({ session: { name: "x", group: { title: "Tabkyra · claude · x", open: false }, currentTabId: null }, tabs: [] }), /no group open yet.*\nNo tabs yet: navigate opens one/s);
	assert.match(formatContext({ tabs: [{ tabId: 1, url: "u", title: "t", current: false }] }), /No current tab: tabs_select one, or navigate\./);
});

function run(...args) {
	const home = join(root, "home");
	const sock = join(home, "sock");
	mkdirSync(sock, { recursive: true, mode: 0o700 });
	const r = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: home, TABKYRA_SOCKET_DIR: sock, NO_COLOR: "1" }, encoding: "utf8", timeout: 20000 });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

test("tabkyra sessions and tabs: usage errors exit 2, no browser exits 1 with the fix", () => {
	for (const args of [["sessions", "frob"], ["sessions", "show"], ["sessions", "rename", "a"], ["sessions", "end", "a", "--bogus"], ["tabs", "a", "b"], ["mcp", "--session"]]) {
		const r = run(...args);
		assert.equal(r.code, 2, `tabkyra ${args.join(" ")}: ${r.err}`);
	}
	for (const args of [["sessions"], ["sessions", "list", "--json"], ["sessions", "end", "x", "--close"], ["tabs"]]) {
		const r = run(...args);
		assert.equal(r.code, 1, `tabkyra ${args.join(" ")}: ${r.out}${r.err}`);
		assert.match(r.err, /isn't connected/);
	}
});
