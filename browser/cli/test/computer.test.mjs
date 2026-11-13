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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
	tool("run_steps", { steps: { type: "array", items: { type: "object" } } }, ["steps"]),
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

const locals = [];

after(async () => {
	// A failed assertion skips a test's own close; a stdio server left open would keep this run alive.
	await Promise.all(locals.map((c) => c.close().catch(() => {})));
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
	assert.deepEqual(tools, ["computer_click", "computer_open", "computer_run_steps", "computer_snapshot", "computer_status", "computer_windows"], "acting needs refs, so it reads too");
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

// The local stdio server (`polycarp browser mcp`) runs as the user, so it runs the helper without --connector and offers
// every tool the helper lists, as the helper describes it. A missing, hung or slow helper never holds up the browser tools.
const localLog = join(root, "local-helper.log");
const localHelper = join(bin, "fake-spaces-local");
const PNG = Buffer.from("fake png bytes").toString("base64");
const REFUSAL = JSON.stringify({ ok: false, error: { code: "outside_agent_workspace", message: "window 7 is not on the agent workspace", suggestion: "Ask the user to lend it.", retry: "never" } });
writeFileSync(
	localHelper,
	`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = (entry) => appendFileSync(${JSON.stringify(localLog)}, JSON.stringify(entry) + "\\n");
log({ argv: process.argv.slice(2) });
const tool = (name, readOnly, properties = {}, required = []) => ({
	name,
	description: "The helper's own words for " + name + ".",
	inputSchema: { type: "object", properties, required, additionalProperties: false },
	annotations: { readOnlyHint: readOnly, openWorldHint: false },
});
const tools = [
	tool("windows", true),
	tool("snapshot", true, { app: { type: "string", description: "App name" }, interactive: { type: "boolean", description: "Refs only" } }),
	tool("click", false, { ref: { type: "string", description: "A ref" } }, ["ref"]),
	tool("shot", false, { window: { type: "integer", description: "Window id" } }, ["window"]),
	tool("open", false, { app: { type: "string", description: "App" }, targets: { type: "array", items: { type: "string" }, description: "Files" } }, ["app"]),
	tool("run_steps", false, { steps: { type: "array", items: { type: "object" }, description: "Steps" } }, ["steps"]),
	tool("lend", false, { app: { type: "string", description: "App" } }),
	tool("brand_new_verb", true),
];
const delay = Number(process.env.FAKE_LIST_DELAY_MS ?? 0);
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
	if (m.method === "initialize") return reply({ serverInfo: { name: "baneyspaces" } });
	if (m.method === "tools/list") {
		if (process.env.FAKE_HANG === "1") return;
		return setTimeout(() => reply({ tools }), delay);
	}
	log(m.params);
	if (m.params.name === "shot") return reply({ content: [{ type: "text", text: '{"ok":true,"data":{"path":"/tmp/x.png"}}' }, { type: "image", data: ${JSON.stringify(PNG)}, mimeType: "image/png" }], isError: false });
	if (m.params.name === "click") return reply({ content: [{ type: "text", text: ${JSON.stringify(REFUSAL)} }], isError: true });
	reply({ content: [{ type: "text", text: "did " + m.params.name }], isError: false });
});
`,
);
chmodSync(localHelper, 0o755);

async function local(extra) {
	const client = new Client({ name: "computer-local-test", version: "0.0.0" });
	locals.push(client);
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...base, ...extra }, stderr: "ignore" }));
	return client;
}

test("the local server lists computer_* tools from the helper's own list, as the helper describes them", async () => {
	rmSync(localLog, { force: true });
	const client = await local({ POLYCARP_SPACES_BIN: localHelper });
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name).filter((n) => n.startsWith("computer_")).sort();
	assert.deepEqual(names, ["computer_brand_new_verb", "computer_click", "computer_open", "computer_run_steps", "computer_shot", "computer_snapshot", "computer_status", "computer_windows"], "every helper tool but lend");
	assert.ok(tools.some((t) => t.name === "read_page"), "browser tools are still there");
	const open = tools.find((t) => t.name === "computer_open");
	assert.equal(open.description, "The helper's own words for open.");
	assert.deepEqual(open.inputSchema.required, ["app"]);
	assert.equal(open.inputSchema.properties.targets.type, "array");
	assert.equal(tools.find((t) => t.name === "computer_windows").annotations.readOnlyHint, true);
	assert.equal(tools.find((t) => t.name === "computer_shot").annotations.readOnlyHint, false, "read-only as the helper marks it");
	assert.match(client.getInstructions(), /computer_\* tools for native Mac apps/);
	assert.match(client.getInstructions(), /never take focus/);
	assert.equal((await client.callTool({ name: "computer_windows", arguments: {} })).content[0].text, "did windows");
	await client.close();
});

test("the local server runs the helper without --connector", async () => {
	rmSync(localLog, { force: true });
	const client = await local({ POLYCARP_SPACES_BIN: localHelper });
	await client.listTools();
	const first = JSON.parse(readFileSync(localLog, "utf8").trim().split("\n")[0]);
	assert.deepEqual(first.argv, ["mcp"]);
	await client.close();
});

test("a remote session still runs the helper with --connector", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("still-capped", "computer.read"));
	await client.callTool({ name: "computer_windows", arguments: {} });
	assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]).argv, ["mcp", "--connector"]);
	await client.close();
});

test("with no helper the local server keeps its browser tools, and computer_status says how to get computer use", async () => {
	const client = await local({ POLYCARP_SPACES_BIN: join(root, "nope") });
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((t) => t.name).filter((n) => n.startsWith("computer_")), ["computer_status"]);
	assert.ok(tools.some((t) => t.name === "read_page"));
	assert.doesNotMatch(client.getInstructions(), /computer_open/);
	assert.match((await client.callTool({ name: "computer_status", arguments: {} })).content[0].text, /install Polycarp/);
	await client.close();
});

test("a hung helper doesn't hold tools/list past its budget, and computer_status says it's starting", async () => {
	const client = await local({ POLYCARP_SPACES_BIN: localHelper, FAKE_HANG: "1" });
	const started = Date.now();
	const { tools } = await client.listTools();
	const took = Date.now() - started;
	assert.ok(took < 3500, `tools/list took ${took} ms`);
	assert.deepEqual(tools.map((t) => t.name).filter((n) => n.startsWith("computer_")), ["computer_status"]);
	assert.ok(tools.some((t) => t.name === "read_page"));
	assert.match((await client.callTool({ name: "computer_status", arguments: {} })).content[0].text, /still starting/);
	await client.close();
});

test("a slow helper's tools arrive on a later list", async () => {
	const client = await local({ POLYCARP_SPACES_BIN: localHelper, FAKE_LIST_DELAY_MS: "2600" });
	const computer = async () => (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("computer_"));
	assert.deepEqual(await computer(), ["computer_status"], "past the budget, browser tools only");
	await new Promise((done) => setTimeout(done, 1500));
	assert.ok((await computer()).includes("computer_windows"));
	await client.close();
});

test("the helper's answers pass through unchanged: a shot's image and a structured error", async () => {
	const client = await local({ POLYCARP_SPACES_BIN: localHelper });
	await client.listTools();
	const shot = await client.callTool({ name: "computer_shot", arguments: { window: 7 } });
	assert.equal(shot.isError, false);
	assert.deepEqual(shot.content[1], { type: "image", data: PNG, mimeType: "image/png" });
	const refused = await client.callTool({ name: "computer_click", arguments: { ref: "@a:e1" } });
	assert.equal(refused.isError, true);
	assert.deepEqual(refused.content, [{ type: "text", text: REFUSAL }]);
	await client.close();
});

// 251 r1 first-F1: a list of objects is a list of objects, through the connector and the local server alike.
const STEPS = [{ tool: "click", args: { ref: "5" } }, { tool: "type", args: { ref: "7", text: "hi" } }];

test("a connector session's computer_run_steps takes its steps as objects and hands them to the helper unchanged", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("steps", "computer.act"));
	const listed = (await client.listTools()).tools.find((t) => t.name === "computer_run_steps");
	assert.equal(listed.inputSchema.properties.steps.items.type, "object");
	const answer = await client.callTool({ name: "computer_run_steps", arguments: { steps: STEPS } });
	assert.equal(answer.isError, false, JSON.stringify(answer.content));
	assert.equal(answer.content[0].text, "did run_steps");
	const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(calls.at(-1), { name: "run_steps", arguments: { steps: STEPS } });
	await client.close();
});

test("the local server's computer_run_steps takes its steps as objects and hands them to the helper unchanged", async () => {
	rmSync(localLog, { force: true });
	const client = await local({ POLYCARP_SPACES_BIN: localHelper });
	await client.listTools();
	const answer = await client.callTool({ name: "computer_run_steps", arguments: { steps: STEPS } });
	assert.equal(answer.isError, false, JSON.stringify(answer.content));
	const calls = readFileSync(localLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(calls.at(-1), { name: "run_steps", arguments: { steps: STEPS } });
	const strings = await client.callTool({ name: "computer_open", arguments: { app: "TextEdit", targets: ["a.txt"] } });
	assert.equal(strings.isError, false, "a list of strings still is one");
	await client.close();
});
