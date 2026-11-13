// `mcp --profile small`: the core tools listed, every other tool behind more_tools, and the default list unchanged.
// No browser: more_tools is proved on skill_match, which needs none.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
let root;
const clients = [];

async function connect(args, extraEnv = {}) {
	const c = new Client({ name: "small-profile-test", version: "0" });
	await c.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", ...args],
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: join(root, "sock"), POLYCARP_SPACES_BIN: join(root, "no-helper"), ...extraEnv },
			stderr: "ignore",
		}),
	);
	clients.push(c);
	return c;
}
const tokens = (tools) => Math.round(JSON.stringify(tools).length / 4);
const textOf = (r) => r.content.map((c) => c.text).join("\n");

before(() => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-small-"));
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
});
after(async () => {
	for (const c of clients) await c.close().catch(() => {});
	rmSync(root, { recursive: true, force: true });
});

test("the small profile lists the core loop and more_tools, in a fraction of the full list's tokens", async () => {
	const full = (await (await connect([])).listTools()).tools;
	const small = (await (await connect(["--profile", "small"])).listTools()).tools;
	const names = small.map((t) => t.name).sort();
	assert.deepEqual(names, ["click", "computer_status", "fill", "find", "get_page_text", "handle_dialog", "more_tools", "navigate", "press", "read_page", "screenshot", "scroll", "tabs_close", "tabs_context", "tabs_show", "type", "wait"]);
	// The ratchet: browser half of the small profile (no computer helper here) under 3,000 tokens; with the eight computer
	// tools a Mac adds it measured 4,123 (evals/weak-model/README.md), under the 5,000 budget.
	assert.ok(tokens(small) < 3000, `small profile is ${tokens(small)} tokens`);
	// The default is the full list, unchanged for existing clients.
	assert.ok(full.length >= 45, `full list has ${full.length}`);
	for (const n of ["run_js", "skill_match", "tabs_create", "library_add", "files", "actions"]) assert.ok(full.some((t) => t.name === n), n);
});

test("POLYCARP_PROFILE=small picks it too, and a mistyped profile fails", async () => {
	const viaEnv = (await (await connect([], { POLYCARP_PROFILE: "small" })).listTools()).tools;
	assert.ok(viaEnv.some((t) => t.name === "more_tools"));
	assert.ok(!viaEnv.some((t) => t.name === "run_js"));
	await assert.rejects(connect(["--profile", "smal"]));
});

test("the instructions name more_tools and drop sentences about tools it hides", async () => {
	const c = await connect(["--profile", "small"]);
	const instructions = c.getInstructions();
	assert.match(instructions, /more_tools \{\} lists them/);
	assert.match(instructions, /Call tabs_context before any browser tool/);
	assert.doesNotMatch(instructions, /skill_match|library_add|tabs_create|run_js on/);
	assert.match(instructions, /Do not enter passwords or payment details, even ones the user gave you/);
	// The handoff stays in the small list, so a run that left the password empty can give the tab to the user.
	assert.match(instructions, /call tabs_show and ask the user to finish/);
});

test("more_tools lists the hidden tools, shows one, runs one, and says what was wrong with bad arguments", async () => {
	const c = await connect(["--profile", "small"]);
	const list = textOf(await c.callTool({ name: "more_tools", arguments: {} }));
	assert.match(list, /^run_js: /m);
	assert.match(list, /^skill_match: /m);
	assert.doesNotMatch(list, /^read_page: /m);

	const shown = textOf(await c.callTool({ name: "more_tools", arguments: { name: "skill_match" } }));
	assert.match(shown, /Arguments: task \(required\)/);

	const ran = await c.callTool({ name: "more_tools", arguments: { name: "skill_match", arguments: { task: "fill in the signup form on example.com" } } });
	assert.ok(!ran.isError, textOf(ran));
	assert.match(textOf(ran), /skill/i);

	const bad = await c.callTool({ name: "more_tools", arguments: { name: "skill_match", arguments: { tsk: "x" } } });
	assert.equal(bad.isError, true);
	assert.match(textOf(bad), /task/);

	const core = await c.callTool({ name: "more_tools", arguments: { name: "read_page" } });
	assert.match(textOf(core), /already in your tool list/);
	const typo = await c.callTool({ name: "more_tools", arguments: { name: "runjs" } });
	assert.equal(typo.isError, true);
	assert.match(textOf(typo), /more_tools \{\} lists them all/);
});
