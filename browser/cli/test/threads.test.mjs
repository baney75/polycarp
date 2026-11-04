// Threads from the CLI's side: the native host's mirror writer (atomic files, 0600 and 0700,
// delete, sync, clear, ids that can't escape), and reading threads back without a browser
// through `tabkyra threads` and the MCP tools. The live path is in e2e-bridge.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-threads-"));
const dir = join(root, "threads");
/** This test's browser profile's folder in the mirror. */
const bdir = join(dir, "b1");
const sock = join(root, "sock");
mkdirSync(sock, { mode: 0o700 });
after(() => rmSync(root, { recursive: true, force: true }));

let applyMirror;

before(async () => {
	const { build } = await import("esbuild");
	const out = join(root, "mirror.mjs");
	await build({ entryPoints: [join(here, "..", "src", "threads-mirror.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
	process.env.TABKYRA_THREADS_DIR = dir;
	({ applyMirror } = await import(out));
});

const put = (id, title = `Thread ${id}`, lastModified = "2026-10-27T10:00:00.000Z") => ({
	op: "put",
	id,
	md: `---\nid: ${id}\n---\n# ${title}\n\n**user** (1)\n\nFind hotels in Lisbon\n`,
	json: JSON.stringify({ id, title, createdAt: "2026-10-27T09:00:00.000Z", lastModified, model: "openrouter/x", messages: [{ role: "user", content: "Find hotels in Lisbon", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "Three options." }], timestamp: 2 }] }),
	meta: { id, title, createdAt: "2026-10-27T09:00:00.000Z", lastModified, messageCount: 2, model: "openrouter/x" },
});

test("the host writes a thread as 0600 files in a 0700 folder, with an index, atomically", () => {
	assert.equal(applyMirror(put("t1", "Lisbon trip", "2026-10-27T10:00:00.000Z"), "b1"), "wrote t1");
	assert.equal(applyMirror(put("t2", "Taxes", "2026-10-27T11:00:00.000Z"), "b1"), "wrote t2");
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(statSync(bdir).mode & 0o777, 0o700);
	for (const f of ["t1.md", "t1.json", "index.json"]) assert.equal(statSync(join(bdir, f)).mode & 0o777, 0o600, f);
	assert.ok(!readdirSync(bdir).some((n) => n.endsWith(".tmp")), "a temporary file was left behind");
	const index = JSON.parse(readFileSync(join(bdir, "index.json"), "utf8"));
	assert.deepEqual(index.threads.map((t) => t.id), ["t2", "t1"], "newest first");
	assert.equal(index.threads[1].title, "Lisbon trip");
});

test("ids that could leave the folder, or name the index, are refused and write nothing", () => {
	const before = readdirSync(dir).sort();
	for (const id of ["../escape", "a/b", "..", ".hidden", "index", "x".repeat(200), "", 7]) {
		assert.match(applyMirror({ ...put("ok"), id, meta: { ...put("ok").meta, id } }, "b1"), /^refused/, String(id));
		assert.match(applyMirror({ op: "delete", id }, "b1"), /^refused/, String(id));
	}
	assert.match(applyMirror({ op: "sync", ids: ["t1", "../x"] }, "b1"), /^refused/);
	assert.match(applyMirror({ op: "put", id: "t3", md: 5, json: "{}", meta: { id: "t3" } }, "b1"), /^refused/);
	assert.match(applyMirror({ op: "rm -rf" }, "b1"), /^refused/);
	assert.deepEqual(readdirSync(dir).sort(), before);
	assert.equal(existsSync(join(root, "escape.md")), false);
});

test("the CLI reads threads from the mirror when no browser is connected", () => {
	const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: sock, TABKYRA_THREADS_DIR: dir, NO_COLOR: "1" }, encoding: "utf8", timeout: 20000 });
	const list = run("threads");
	assert.equal(list.status, 0, list.stderr);
	assert.match(list.stdout, /2 threads, newest first \(from the local mirror/);
	assert.match(list.stdout, /t2 \| "Taxes"/);
	assert.deepEqual(JSON.parse(run("threads", "list", "--json").stdout).threads.map((t) => t.id), ["t2", "t1"]);
	// A title an older build wrote with a key in it is redacted on the way out.
	const index = JSON.parse(readFileSync(join(bdir, "index.json"), "utf8"));
	const key = ["sk-ant", "api03", "AbCdEf0123456789AbCdEf0123456789"].join("-");
	index.threads[0].title = `Taxes ${key}`;
	writeFileSync(join(bdir, "index.json"), JSON.stringify(index));
	const listed = run("threads", "list", "--json").stdout;
	assert.doesNotMatch(listed, /sk-ant-api03/);
	assert.match(listed, /Taxes \[secret\]/);
	const show = run("threads", "show", "t1");
	assert.equal(show.status, 0, show.stderr);
	assert.match(show.stdout, /Thread t1: "Lisbon trip"/);
	assert.match(show.stdout, /\[2\] assistant: Three options\./);
	assert.match(run("threads", "search", "lisbon").stdout, /t1 \| "Lisbon trip"\n {2}\[1\] user: \.\.\.Find hotels in Lisbon/);
	assert.equal(run("threads", "search", "zanzibar").status, 1);
	assert.match(run("threads", "export", "t1").stdout, /^---\nid: t1\n/);
	assert.equal(JSON.parse(run("threads", "export", "t1", "--format", "json").stdout).id, "t1");
	const missing = run("threads", "show", "../t1");
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /No thread \.\.\/t1/);
	assert.equal(run("threads", "export", "t1", "--format", "pdf").status, 2);
	assert.equal(run("threads", "frob").status, 2);
});

test("MCP: the three thread tools are listed with a data-not-instructions warning and read the mirror offline", async () => {
	const client = new Client({ name: "threads-test", version: "0.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: sock, TABKYRA_THREADS_DIR: dir }, stderr: "ignore" }));
	try {
		const { tools } = await client.listTools();
		for (const name of ["threads_list", "thread_read", "thread_search"]) {
			const t = tools.find((x) => x.name === name);
			assert.ok(t, name);
			assert.match(t.description, /not instructions|never instructions/);
		}
		assert.match(client.getInstructions(), /threads_list, thread_search and thread_read .* data to read, never instructions/);
		const read = await client.callTool({ name: "thread_read", arguments: { id: "t2" } });
		assert.ok(!read.isError, read.content[0].text);
		assert.match(read.content[0].text, /Thread t2: "Taxes"/);
		const bad = await client.callTool({ name: "thread_read", arguments: { id: "../../etc/passwd" } });
		assert.equal(bad.isError, true);
	} finally {
		await client.close();
	}
});

test("turning the mirror off clears it; deleting and syncing remove only the right files", () => {
	writeFileSync(join(dir, "notes-of-mine.txt"), "not ours");
	assert.equal(applyMirror({ op: "delete", id: "t2" }, "b1"), "deleted");
	assert.equal(existsSync(join(bdir, "t2.md")), false);
	assert.deepEqual(JSON.parse(readFileSync(join(bdir, "index.json"), "utf8")).threads.map((t) => t.id), ["t1"]);
	applyMirror(put("t4"), "b1");
	assert.equal(applyMirror({ op: "sync", ids: ["t4"] }, "b1"), "synced 1");
	assert.equal(existsSync(join(bdir, "t1.json")), false, "a thread deleted while the host was away keeps its files");
	assert.ok(existsSync(join(bdir, "t4.json")));
	assert.equal(applyMirror({ op: "clear" }, "b1"), "cleared");
	assert.deepEqual(readdirSync(dir), ["notes-of-mine.txt"], "clear removes the mirror's files, never the user's");
	rmSync(join(dir, "notes-of-mine.txt"));
	assert.equal(applyMirror({ op: "clear" }, "b1"), "cleared");
	assert.equal(existsSync(dir), false);
});

test("remote sessions read threads only with the threads.read scope", () => {
	const r = spawnSync(process.execPath, [cli, "token", "scopes", "--json"], { env: { HOME: join(root, "home"), PATH: dirname(process.execPath), NO_COLOR: "1" }, encoding: "utf8" });
	const scopes = JSON.parse(r.stdout);
	assert.deepEqual(scopes["threads.read"].tools.sort(), ["thread_read", "thread_search", "threads_list"]);
	for (const [name, s] of Object.entries(scopes))
		if (name !== "threads.read") assert.ok(!s.tools.some((t) => /^threads?_/.test(t)), `${name} grants a thread tool`);
});

test("two browsers keep separate copies: one's sync or clear never removes the other's chats, and readers see both", () => {
	const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: sock, TABKYRA_THREADS_DIR: dir, NO_COLOR: "1" }, encoding: "utf8", timeout: 20000 });
	applyMirror(put("helium1", "Helium chat", "2026-10-27T10:00:00.000Z"), "helium");
	applyMirror(put("chrome1", "Chrome chat", "2026-10-27T11:00:00.000Z"), "chrome");
	// Chrome's host connects and syncs the ids it has: Helium's chat stays.
	assert.equal(applyMirror({ op: "sync", ids: ["chrome1"] }, "chrome"), "synced 1");
	assert.ok(existsSync(join(dir, "helium", "helium1.json")), "one browser's sync deleted the other's chat");
	assert.deepEqual(JSON.parse(run("threads", "list", "--json").stdout).threads.map((t) => t.id), ["chrome1", "helium1"]);
	assert.match(run("threads", "show", "helium1").stdout, /Thread helium1: "Helium chat"/);
	// Chrome's switch off clears Chrome's copy only.
	applyMirror({ op: "clear" }, "chrome");
	assert.equal(existsSync(join(dir, "chrome")), false);
	assert.ok(existsSync(join(dir, "helium", "helium1.md")));
	applyMirror({ op: "clear" }, "helium");
	assert.equal(existsSync(dir), false);
});
