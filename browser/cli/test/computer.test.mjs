// Computer use through the connector: off unless a token or grant names it, only the tools its scopes allow and this repo's
// list names, and always through `polycarp-spaces mcp --connector`, which is what makes the app treat the caller as remote.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "polycarp-computer-"));
const bin = join(root, "bin");
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, "node"));
const log = join(root, "helper.log");
const helper = join(bin, "fake-spaces");
writeFileSync(
	helper,
	`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const tool = (name, properties = {}, required = []) => ({ name, description: name + " it", inputSchema: { type: "object", properties, required } });
const tools = [
	tool("windows"),
	tool("snapshot", { app: { type: "string", description: "App name" }, interactive: { type: "boolean" } }),
	tool("click", { ref: { type: "string" } }, ["ref"]),
	tool("open", { app: { type: "string" }, targets: { type: "array", items: { type: "string" } } }, ["app"]),
	tool("lend", { app: { type: "string" } }),
	tool("brand_new_verb"),
];
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
	if (m.method === "initialize") return reply({ serverInfo: { name: process.env.FAKE_SERVER_NAME ?? "polycarp-connector" } });
	if (m.method === "tools/list") return reply({ tools });
	appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.params) + "\\n");
	if (m.params.name === "click") process.exit(3);
	reply({ content: [{ type: "text", text: "did " + m.params.name }], isError: false });
});
`,
);
chmodSync(helper, 0o755);

const base = { HOME: join(root, "home"), PATH: bin, NO_COLOR: "1", TABKYRA_SOCKET_DIR: join(root, "sock"), TABKYRA_CONFIG_DIR: join(root, "config"), TABKYRA_NO_UPDATE_CHECK: "1" };
mkdirSync(base.HOME, { recursive: true });
mkdirSync(base.TABKYRA_SOCKET_DIR, { mode: 0o700 });
const servers = [];

function token(name, scopes) {
	const r = spawnSync(process.execPath, [cli, "token", "create", name, "--scope", scopes], { env: base, encoding: "utf8" });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	return /tkr_[A-Za-z0-9_-]+/.exec(r.stdout + r.stderr)[0];
}

function serve(extra, args = []) {
	const server = spawn(process.execPath, [cli, "serve", "--port", "0", ...args], { env: { ...base, ...extra } });
	servers.push(server);
	return new Promise((resolve, reject) => {
		let out = "";
		server.stdout.on("data", (d) => {
			out += d;
			const m = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(out);
			if (m) resolve(m[0]);
		});
		server.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
		setTimeout(() => reject(new Error(`serve printed no URL: ${out}`)), 15_000);
	});
}

async function connect(url, secret) {
	const client = new Client({ name: "computer-test", version: "0.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
	return client;
}

const computerTools = async (client) => (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("computer_")).sort();
let withHelper;

before(async () => {
	withHelper = await serve({ POLYCARP_SPACES_BIN: helper });
});

after(() => {
	for (const s of servers) s.kill();
	rmSync(root, { recursive: true, force: true });
});

test("a session with no computer scope has no computer tools and starts no helper", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("browser-only", "browser.read"));
	assert.deepEqual(await computerTools(client), []);
	assert.equal(existsSync(log), false);
	await client.close();
});

test("computer.read sees reading tools only, through the helper's connector mode", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("looks", "computer.read"));
	assert.deepEqual(await computerTools(client), ["computer_snapshot", "computer_status", "computer_windows"]);
	const answer = await client.callTool({ name: "computer_snapshot", arguments: { app: "TextEdit", interactive: true } });
	assert.equal(answer.content[0].text, "did snapshot");
	const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(lines[0].argv, ["mcp", "--connector"]);
	assert.deepEqual(lines[1], { name: "snapshot", arguments: { app: "TextEdit", interactive: true } });
	const refused = await client.callTool({ name: "computer_click", arguments: { ref: "@a:e1" } });
	assert.equal(refused.isError, true);
	assert.doesNotMatch(readFileSync(log, "utf8"), /"click"/, "a tool outside the scope never reaches the helper");
	await client.close();
});

test("computer.act adds acting, and a verb the helper has but this list doesn't name never appears", async () => {
	const client = await connect(withHelper, token("acts", "computer.act"));
	const tools = await computerTools(client);
	assert.deepEqual(tools, ["computer_click", "computer_open", "computer_snapshot", "computer_status", "computer_windows"], "acting needs refs, so it reads too");
	assert.ok(!tools.includes("computer_lend"), "lending is the person's alone");
	assert.ok(!tools.includes("computer_brand_new_verb"));
	const open = (await client.listTools()).tools.find((t) => t.name === "computer_open");
	assert.deepEqual(open.inputSchema.required, ["app"]);
	assert.equal(open.annotations.readOnlyHint, false);
	await client.close();
});

test("the instructions name the limits to a session that has the tools, and not to one that doesn't", async () => {
	const has = await connect(withHelper, token("told", "computer.read"));
	assert.match(has.getInstructions(), /untrusted data/);
	assert.match(has.getInstructions(), /you can't lend/);
	await has.close();
	const hasnt = await connect(withHelper, token("not-told", "browser.read"));
	assert.doesNotMatch(hasnt.getInstructions(), /computer_/);
	await hasnt.close();
});

test("a helper older than the connector flag is never used: its calls wouldn't be capped", async () => {
	rmSync(log, { force: true });
	const old = join(bin, "old-spaces");
	writeFileSync(old, `#!/bin/sh\nFAKE_SERVER_NAME=baneyspaces exec ${JSON.stringify(helper)} "$@"\n`);
	chmodSync(old, 0o755);
	const url = await serve({ POLYCARP_SPACES_BIN: old });
	const client = await connect(url, token("old-helper", "computer.act"));
	assert.deepEqual(await computerTools(client), ["computer_status"]);
	assert.match((await client.callTool({ name: "computer_status", arguments: {} })).content[0].text, /isn't available/);
	await client.close();
});

test("a helper that stops turns into an error on that call and the next, not a hang", async () => {
	const client = await connect(withHelper, token("stops", "computer.act"));
	const answer = await client.callTool({ name: "computer_click", arguments: { ref: "@a:e1" } });
	assert.equal(answer.isError, true);
	assert.match(answer.content[0].text, /stopped/);
	const next = await client.callTool({ name: "computer_windows", arguments: {} });
	assert.equal(next.isError, true);
	assert.match(next.content[0].text, /stopped/);
	await client.close();
});

test("with no helper on this machine the scope grants nothing and the session still works", async () => {
	const url = await serve({ POLYCARP_SPACES_BIN: join(root, "nope") });
	const client = await connect(url, token("nothing", "computer.act,browser.read"));
	assert.deepEqual(await computerTools(client), ["computer_status"], "the session can say why");
	assert.ok((await client.listTools()).tools.some((t) => t.name === "read_page"));
	assert.doesNotMatch(client.getInstructions(), /computer_open/);
	await client.close();
});

async function consent(extra) {
	const url = await serve(extra, ["--public-url", "https://example.test"]);
	const origin = new URL(url).origin;
	const headers = { Host: "example.test", "x-forwarded-proto": "https" };
	const meta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`, { headers })).json();
	return meta.scopes_supported;
}

test("the approval page offers computer use only where the helper is, and never ticks it", async () => {
	assert.ok((await consent({ POLYCARP_SPACES_BIN: helper })).includes("computer.act"));
	assert.ok(!(await consent({ POLYCARP_SPACES_BIN: join(root, "nope") })).includes("computer.act"));
	const page = readFileSync(join(here, "..", "src", "oauth.ts"), "utf8");
	const grant = /export const DEFAULT_GRANT = \[(.*?)\]/.exec(page)[1];
	assert.ok(!grant.includes("computer"), "off until a person ticks it");
});
