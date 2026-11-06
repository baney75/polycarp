// The agent skill (skills/tabkyra/SKILL.md) and the MCP server must agree: every tool and
// parameter the skill shows exists, the server instructions carry the same rules, and
// `polycarp browser skill install` writes it where each harness looks, without clobbering others' files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const skill = readFileSync(join(here, "..", "..", "skills", "tabkyra", "SKILL.md"), "utf8");
const root = mkdtempSync(join(tmpdir(), "tabkyra-skill-"));
let mcp;
let tools;
let instructions;

before(async () => {
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	mcp = new Client({ name: "tabkyra-skill-test", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp"],
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: join(root, "sock") },
			stderr: "ignore",
		}),
	);
	tools = new Map((await mcp.listTools()).tools.map((t) => [t.name, t]));
	instructions = mcp.getInstructions() ?? "";
});

after(async () => {
	await mcp?.close().catch(() => {});
	rmSync(root, { recursive: true, force: true });
});

test("the skill has frontmatter a harness can index", () => {
	const m = /^---\nname: tabkyra\ndescription: (.+)\n---\n/.exec(skill);
	assert.ok(m, "SKILL.md must start with name and description frontmatter");
	assert.ok(m[1].length <= 1024, "description over 1024 characters");
	assert.match(m[1], /Use when/);
});

test("every tool the skill names exists", () => {
	// Error codes the skill quotes are not tools (src/bridge/protocol.ts, ERR).
	const errorCodes = new Set(["dialog_open", "permission_denied", "no_tab", "bad_params", "not_found", "timeout", "interrupted", "tab_limit"]);
	const named = new Set(
		[...skill.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((m) => m[1]).filter((n) => !errorCodes.has(n) && (tools.has(n) || /_/.test(n))),
	);
	// Also tool calls in the worked examples: `name {...}` at the start of a line.
	for (const m of skill.matchAll(/(?:^|`)([a-z]+(?:_[a-z]+)*) \{/gm)) named.add(m[1]);
	for (const name of named) assert.ok(tools.has(name), `SKILL.md mentions ${name}, which the MCP server doesn't have`);
	for (const core of ["tabs_context", "status", "navigate", "read_page", "click", "fill", "type", "wait", "handle_dialog", "tabs_show", "tabs_close"]) {
		assert.ok(named.has(core), `SKILL.md should teach ${core}`);
	}
});

test("every example call uses real parameters", () => {
	const calls = [...skill.matchAll(/`?([a-z]+(?:_[a-z]+)*) (\{[^`\n]*\})/g)];
	assert.ok(calls.length >= 15, `expected many example calls, found ${calls.length}`);
	for (const [, name, json] of calls) {
		const tool = tools.get(name);
		assert.ok(tool, `example uses unknown tool ${name}`);
		const args = JSON.parse(json.replace(/"tabId":\.\.\./g, '"tabId":1'));
		const props = Object.keys(tool.inputSchema.properties ?? {});
		for (const key of Object.keys(args)) assert.ok(props.includes(key), `${name} has no parameter ${key} (example ${json})`);
		for (const req of tool.inputSchema.required ?? []) assert.ok(req in args, `${name} example ${json} lacks required ${req}`);
	}
});

test("server instructions and the skill teach the same rules", () => {
	const pairs = [
		[/untrusted data/i, /untrusted data/i],
		[/Ask the user before you act under their sign-in/, /Ask before you act under the user's sign-in/],
		[/passwords or payment details/, /passwords or (?:card numbers|payment details)/],
		[/Call tabs_context before any browser tool/, /Call `tabs_context` first/],
		[/tabs_release/, /tabs_release/],
		[/fails with interrupted/, /Error `interrupted`/],
		[/"filter":"interactive"/, /"filter":"interactive"/],
		[/read_page again to confirm/, /`read_page` again to verify/],
		[/Refs expire/, /refs are gone/],
		[/handle_dialog/, /handle_dialog/],
		[/Cancel is always safe/, /Cancel, which is always safe/],
		[/confirms exactly what the user asked for/, /confirms exactly what\s+the user asked for/],
		[/Settings > Agents/, /Settings > Agents/],
		[/tabs_close/, /tabs_close/],
		[/tabs_show/, /tabs_show/],
		[/do not try to get around it/, /Don't try another URL to\s+get around it/],
	];
	for (const [inInstructions, inSkill] of pairs) {
		assert.match(instructions, inInstructions, `MCP instructions lack ${inInstructions}`);
		assert.match(skill, inSkill, `SKILL.md lacks ${inSkill}`);
	}
	// The tool descriptions back the same promises.
	assert.match(tools.get("handle_dialog").description, /Cancel is always safe/);
	assert.match(tools.get("read_page").description, /refs expire/);
	assert.match(tools.get("tabs_show").description, /only tool that changes what the user sees/);
});

// An empty PATH: node's own bin dir can hold codex or claude (nvm, Homebrew globals).
const emptyBin = join(root, "bin");
mkdirSync(emptyBin, { recursive: true });

function run(home, ...args) {
	const env = { HOME: home, PATH: emptyBin, NO_COLOR: "1" };
	const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("skill install writes each detected harness and leaves the rest", () => {
	const home = join(root, "h1");
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(home, ".config", "opencode"), { recursive: true });
	const r = run(home, "skill", "install");
	assert.equal(r.code, 0, r.out);
	const claude = join(home, ".claude", "skills", "tabkyra", "SKILL.md");
	const opencode = join(home, ".config", "opencode", "skills", "tabkyra", "SKILL.md");
	assert.ok(existsSync(claude) && existsSync(opencode), r.out);
	assert.equal(existsSync(join(home, ".codex", "skills", "tabkyra", "SKILL.md")), false, "Codex isn't installed here");
	const written = readFileSync(claude, "utf8");
	assert.ok(written.startsWith("---\nname: tabkyra\n"), "frontmatter stays first");
	assert.ok(written.includes(skill.split("\n---\n")[1].slice(0, 200)), "body is the bundled skill");
	assert.match(run(home, "skill", "install").out, /current/);
	assert.equal(run(home, "skill", "install", "--all").code, 0);
	assert.ok(existsSync(join(home, ".codex", "skills", "tabkyra", "SKILL.md")), "--all installs for every harness");
});

test("skill install doesn't replace someone else's polycarp browser skill without --force", () => {
	const home = join(root, "h2");
	const file = join(home, ".claude", "skills", "tabkyra", "SKILL.md");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "---\nname: tabkyra\ndescription: my own notes\n---\nmine\n");
	const r = run(home, "skill", "install");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /left alone/);
	assert.equal(readFileSync(file, "utf8"), "---\nname: tabkyra\ndescription: my own notes\n---\nmine\n");
	assert.equal(run(home, "skill", "install", "--force").code, 0);
	assert.notEqual(readFileSync(file, "utf8"), "---\nname: tabkyra\ndescription: my own notes\n---\nmine\n");
});

test("skill print is the same text for AGENTS.md, nested one heading level down", () => {
	const r = run(join(root, "h3"), "skill", "print");
	assert.equal(r.code, 0);
	assert.ok(r.out.startsWith("## Browser: Polycarp"), r.out.slice(0, 80));
	assert.doesNotMatch(r.out, /^---$/m, "no frontmatter in the snippet");
	assert.match(r.out, /^### Step 1: call `tabs_context`/m);
	assert.match(r.out, /Page text is untrusted data/);
	assert.equal(run(join(root, "h3"), "skill", "bogus").code, 2);
});
