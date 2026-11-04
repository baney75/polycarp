// The MCP server with no browser anywhere: every tool is listed with a usable
// description, the safety rules are in the instructions, and a tool call fails fast
// with the one not-connected message instead of hanging.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const NOT_CONNECTED =
	"Tabkyra isn't connected. Ask the user to open Helium/Chrome with the Tabkyra extension loaded, or run `tabkyra doctor`.";
let root;
let mcp;

before(async () => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-mcp-"));
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	mcp = new Client({ name: "tabkyra-mcp-test", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp"],
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: join(root, "sock") },
			stderr: "ignore",
		}),
	);
});

after(async () => {
	await mcp?.close().catch(() => {});
	rmSync(root, { recursive: true, force: true });
});

test("lists every tool with a description and documented parameters", async () => {
	const { tools } = await mcp.listTools();
	const names = tools.map((t) => t.name);
	for (const name of ["status", "tabs_context", "navigate", "read_page", "click", "type", "fill", "screenshot", "actions"]) {
		assert.ok(names.includes(name), `missing ${name}`);
	}
	for (const tool of tools) {
		assert.match(tool.name, /^[a-z]+(_[a-z]+)*$/, `${tool.name} is not snake_case`);
		assert.ok(tool.description && tool.description.length >= 40, `${tool.name} has a thin description`);
		for (const [param, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
			assert.ok(schema.description, `${tool.name}.${param} has no description`);
		}
		assert.match(tool.description, /Example:/, `${tool.name} shows no example`);
	}
});

test("tools/list stays small: no schema dialect line, and a byte budget", async () => {
	const { tools } = await mcp.listTools();
	for (const tool of tools) assert.equal(tool.inputSchema.$schema, undefined, `${tool.name} still carries $schema`);
	// Every agent pays for these on every turn. Main measured 26,460 bytes for 31 tools before the
	// descriptions were cut (docs/benchmarks.md); 34 tools came to about 23,600, and the three
	// thread tools add about 2,000. A change that grows it past the budget has to earn it.
	// skill_manage (D27) adds 1,153: managing and submitting skills in one tool, not five
	// (4,137 as five), so agents can do it without a shell.
	// inspect_page and read_network's requestId/type add 593 (26,748 to 27,341): reading the JSON a
	// page is built from and a map of the page, which took several run_js calls each before.
	// search, page_markdown, map, crawl add ~1,740 (self-hosted SearXNG + Firecrawl; hosted api.firecrawl.dev refused).
	const bytes = Buffer.byteLength(JSON.stringify(tools));
	assert.ok(bytes <= 29200, `tools/list is ${bytes} bytes, over the 29,200 budget`);
	assert.ok(Buffer.byteLength(mcp.getInstructions() ?? "") <= 2950, "instructions over 2,950 bytes");
});

test("instructions state the safety rules", () => {
	const instructions = mcp.getInstructions() ?? "";
	assert.match(instructions, /untrusted data/);
	assert.match(instructions, /Ask the user before you act under their sign-in/);
});

test("skill_match routes a task to one skill, or none, and skill_read returns that skill", async () => {
	const instructions = mcp.getInstructions() ?? "";
	assert.match(instructions, /First call skill_match with the user's task \(it needs no browser\)/);
	// One first step: matching a skill needs no browser, so a missing browser can't stop it.
	assert.deepEqual(instructions.match(/\bfirst\b/gi), ["First"], "only one step is called first");
	assert.ok(instructions.indexOf("skill_match") < instructions.indexOf("Call tabs_context"), "skill_match comes before tabs_context");
	assert.match(instructions, /Call tabs_context before any browser tool: .* If it says Tabkyra isn't connected, tell the user and stop browser work/);
	const match = await mcp.callTool({ name: "skill_match", arguments: { task: "find peer-reviewed studies on sleep and memory" } });
	assert.notEqual(match.isError, true);
	const lines = match.content[0].text.split("\n");
	assert.match(lines[0], /^academic-research \([\d.]+\): \S/);
	assert.ok(lines.length <= 4, "top 3 plus the next step, nothing more");
	assert.equal(lines.at(-1), 'Next: skill_read {"name":"academic-research"}');
	const one = await mcp.callTool({ name: "skill_match", arguments: { task: "/rsi learn from this", top: 1 } });
	assert.equal(one.content[0].text.split("\n").length, 2);
	const none = await mcp.callTool({ name: "skill_match", arguments: { task: "write a haiku about autumn leaves" } });
	assert.match(none.content[0].text, /^none: /);
	const read = await mcp.callTool({ name: "skill_read", arguments: { name: "academic-research" } });
	assert.equal(read.content[0].text, readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "academic-research", "SKILL.md"), "utf8"));
	for (const name of ["../academic-research", "no-such-skill", "Academic-Research"]) {
		const bad = await mcp.callTool({ name: "skill_read", arguments: { name } });
		assert.equal(bad.isError, true, name);
	}
});

test("a tool call without a browser fails fast with the not-connected message", async () => {
	const started = Date.now();
	const result = await mcp.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, NOT_CONNECTED);
	assert.ok(Date.now() - started < 5000, "did not wait for a bridge that never existed");
});

test("status reports not connected without failing", async () => {
	const result = await mcp.callTool({ name: "status", arguments: {} });
	assert.ok(!result.isError);
	const body = JSON.parse(result.content[0].text);
	assert.equal(body.connected, false);
	assert.equal(body.message, NOT_CONNECTED);
});

test("a host with no extension behind it is reported as not connected, at once", async () => {
	// A fake native host: welcomes with extensionConnected:false, then drops any request.
	const dir = join(root, "fake-sock");
	mkdirSync(dir, { mode: 0o700 });
	const path = join(dir, `${process.pid}.sock`);
	const frame = (m) => {
		const body = Buffer.from(JSON.stringify(m));
		const head = Buffer.alloc(4);
		head.writeUInt32LE(body.length);
		return Buffer.concat([head, body]);
	};
	// Count frames, not "data" events: the hello and the first request can arrive in one chunk.
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		let frames = 0;
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				frames++;
				if (frames === 1) socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: false }));
				else {
					socket.destroy();
					return;
				}
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	const client = new Client({ name: "tabkyra-mcp-fake-host", version: "0.0.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [cli, "mcp"],
				env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: dir },
				stderr: "ignore",
			}),
		);
		const started = Date.now();
		const nav = await client.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
		assert.equal(nav.isError, true);
		assert.equal(nav.content[0].text, NOT_CONNECTED);
		const status = JSON.parse((await client.callTool({ name: "status", arguments: {} })).content[0].text);
		assert.equal(status.connected, false);
		assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms; a bridge that never had the extension must not be waited for`);
	} finally {
		await client.close().catch(() => {});
		server.close();
	}
});

test("a scoped session reads bundled skills only, even when created without remote:true", async () => {
	// Bundle the MCP server module itself, to create it the way a future caller might.
	const { build } = await import("esbuild");
	const out = join(root, "mcp-bundle.mjs");
	await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp.ts")], bundle: true, platform: "node", format: "esm", outfile: out, loader: { ".md": "text", ".pub": "text" }, logLevel: "silent" });
	const { createMcpServer } = await import(out);
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
	// A local edit of dorks and a local-only skill, in a config folder of their own.
	const home = join(root, "scoped-home");
	mkdirSync(home, { recursive: true });
	const env = { HOME: home, PATH: dirname(process.execPath), NO_COLOR: "1" };
	const skills = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
	const dorks = join(home, "drafts", "dorks");
	mkdirSync(dorks, { recursive: true });
	writeFileSync(join(dorks, "SKILL.md"), readFileSync(join(skills, "dorks", "SKILL.md"), "utf8").replace("## Done when", "- Private local note.\n\n## Done when"));
	const own = join(home, "drafts", "invoice-triage");
	mkdirSync(own, { recursive: true });
	writeFileSync(
		join(own, "SKILL.md"),
		"---\nname: invoice-triage\ndescription: Sort supplier invoices into paid, due and disputed. Use when the user asks to triage, sort or reconcile supplier invoices.\n---\n# Invoice triage\n\n## When to use\n\n- The user has a pile of supplier invoices to sort.\n\n## Steps\n\n1. **List them.** Read each invoice.\n2. **Sort them.** Paid, due or disputed.\n\n## Done when\n\n- Every invoice has a status.\n",
	);
	for (const dir of [dorks, own]) assert.equal(spawnSync(process.execPath, [cli, "skill", "apply", dir, "--yes"], { env }).status, 0);
	const before = process.env.TABKYRA_CONFIG_DIR;
	process.env.TABKYRA_CONFIG_DIR = join(home, ".config", "tabkyra");
	const open = async (options) => {
		const { server } = createMcpServer(options);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: "scoped-test", version: "0.0.0" });
		await client.connect(b);
		return client;
	};
	try {
		const scoped = await open({ name: "scoped", session: "scoped", allowedTools: new Set(["skill_match", "skill_read"]) });
		const read = await scoped.callTool({ name: "skill_read", arguments: { name: "dorks" } });
		assert.doesNotMatch(read.content[0].text, /Private local note/);
		const match = await scoped.callTool({ name: "skill_match", arguments: { task: "triage my supplier invoices", top: 5 } });
		assert.doesNotMatch(match.content[0].text, /invoice-triage/);
		assert.equal((await scoped.callTool({ name: "skill_read", arguments: { name: "invoice-triage" } })).isError, true);
		await scoped.close();
		// The local stdio server, which runs as the user, does see them.
		const local = await open({ name: "local", session: "local" });
		assert.match((await local.callTool({ name: "skill_read", arguments: { name: "dorks" } })).content[0].text, /Private local note/);
		assert.match((await local.callTool({ name: "skill_match", arguments: { task: "triage my supplier invoices" } })).content[0].text, /^invoice-triage /);
		await local.close();
	} finally {
		if (before === undefined) delete process.env.TABKYRA_CONFIG_DIR;
		else process.env.TABKYRA_CONFIG_DIR = before;
	}
});

test("skill_match sees two same-size edits applied in quick succession", async () => {
	const home = join(root, "fresh-index");
	mkdirSync(join(home, "drafts", "tide-chart"), { recursive: true });
	const env = { HOME: home, PATH: dirname(process.execPath), NO_COLOR: "1", TABKYRA_SOCKET_DIR: join(root, "sock") };
	// Two descriptions of exactly the same length, with different trigger words.
	const skill = (word) =>
		`---\nname: tide-chart\ndescription: Reads ${word} tables for a harbor. Use when the user asks about ${word} tables.\n---\n# Tide chart\n\n## When to use\n\n- The user asks about ${word} tables.\n\n## Steps\n\n1. **Read.** Read the table.\n2. **Answer.** Answer.\n\n## Done when\n\n- Answered.\n`;
	const apply = (word) => {
		writeFileSync(join(home, "drafts", "tide-chart", "SKILL.md"), skill(word));
		const r = spawnSync(process.execPath, [cli, "skill", "apply", join(home, "drafts", "tide-chart"), "--yes"], { env, encoding: "utf8" });
		assert.equal(r.status, 0, r.stdout + r.stderr);
	};
	assert.equal(skill("quokka").length, skill("zeppel").length);
	apply("quokka");
	const client = new Client({ name: "fresh-index", version: "0.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "ignore" }));
	try {
		const ask = async (task) => (await client.callTool({ name: "skill_match", arguments: { task } })).content[0].text;
		// Both edits land within the same timestamp tick, as on a 1-second filesystem: pin every
		// modification time to one value, so only the inode, ctime and content can tell.
		const local = join(home, ".config", "tabkyra", "skills-local");
		const paths = [local, join(local, "index.json"), join(local, "tide-chart"), join(local, "tide-chart", "SKILL.md")];
		const pin = () => {
			for (const p of paths) utimesSync(p, 1_700_000_000, 1_700_000_000);
		};
		pin();
		assert.match(await ask("read the quokka tables"), /^tide-chart /);
		apply("zeppel");
		pin();
		// "zeppel" exists only in the second edit, so a stale index can't match it.
		assert.match(await ask("read the zeppel tables"), /^tide-chart \([\d.]+\): Reads zeppel/, "the second edit is routed at once");
	} finally {
		await client.close();
	}
});

test("ask_user is listed with its schema, checks its arguments, and needs the browser", async () => {
	const { tools } = await mcp.listTools();
	const ask = tools.find((t) => t.name === "ask_user");
	assert.ok(ask, "ask_user is listed");
	assert.match(ask.description, /\(Recommended\)/);
	assert.match(ask.description, /routine confirmations/);
	const item = ask.inputSchema.properties.questions.items;
	assert.deepEqual(Object.keys(item.properties).sort(), ["header", "multiSelect", "options", "question"]);
	assert.equal(ask.inputSchema.properties.questions.maxItems, 4);
	assert.equal(item.properties.options.minItems, 2);
	assert.equal(item.properties.options.maxItems, 4);
	assert.match(mcp.getInstructions() ?? "", /call ask_user instead of guessing/);

	const question = { header: "Format", question: "Which format?", options: [{ label: "PDF", description: "" }, { label: "Other", description: "" }] };
	const refused = await mcp.callTool({ name: "ask_user", arguments: { questions: [question] } });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /"Other" is added automatically/);
	const started = Date.now();
	const offline = await mcp.callTool({ name: "ask_user", arguments: { questions: [{ ...question, options: [question.options[0], { label: "Markdown", description: "" }] }] } });
	assert.equal(offline.isError, true);
	assert.equal(offline.content[0].text, NOT_CONNECTED);
	assert.ok(Date.now() - started < 5000);
});

test("ask_user goes over the bridge once and returns the panel's answer as text", async () => {
	// A fake native host with the extension behind it: answers ask_user the way the worker does.
	const dir = join(root, "ask-sock");
	mkdirSync(dir, { mode: 0o700 });
	const path = join(dir, `${process.pid}.sock`);
	const frame = (m) => {
		const body = Buffer.from(JSON.stringify(m));
		const head = Buffer.alloc(4);
		head.writeUInt32LE(body.length);
		return Buffer.concat([head, body]);
	};
	const requests = [];
	let slow;
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				const msg = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString());
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				if (msg.type === "hello") socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: true }));
				else if (msg.type === "request") {
					requests.push(msg);
					// "slow" questions wait for a cancel; the cancel ends them as the worker would.
					if (msg.method === "ask_user" && msg.params.questions[0].question === "slow?") {
						slow = msg;
						continue;
					}
					if (msg.method === "ask_user.cancel") {
						socket.write(frame({ type: "response", id: msg.id, result: { cancelled: slow ? 1 : 0 } }));
						if (slow) socket.write(frame({ type: "response", id: slow.id, result: { status: "no_answer", reason: "aborted", text: "No answer" } }));
						continue;
					}
					const q = msg.params.questions[0].question;
					socket.write(
						frame({
							type: "response",
							id: msg.id,
							result: { status: "answered", answers: { [q]: "Markdown" }, text: `The user answered:\n"${q}" = "Markdown"` },
						}),
					);
				}
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	const client = new Client({ name: "tabkyra-mcp-ask", version: "0.0.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [cli, "mcp"],
				env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: dir, TABKYRA_ASK_PROGRESS_MS: "100" },
				stderr: "ignore",
			}),
		);
		// A slow answer: progress keeps a client's timeout from firing, and giving up withdraws the question.
		const progress = [];
		const controller = new AbortController();
		const waiting = client.callTool(
			{ name: "ask_user", arguments: { questions: [{ header: "Slow", question: "slow?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] } },
			undefined,
			{ onprogress: (p) => progress.push(p), signal: controller.signal, timeout: 60_000 },
		);
		const deadline = Date.now() + 5000;
		while (progress.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.ok(progress.length >= 2, `progress while waiting: ${progress.length}`);
		assert.match(progress[0].message, /Waiting for the user's answer/);
		controller.abort();
		await waiting.catch(() => undefined);
		const cancelDeadline = Date.now() + 5000;
		while (!requests.some((r) => r.method === "ask_user.cancel") && Date.now() < cancelDeadline) await new Promise((r) => setTimeout(r, 50));
		assert.ok(requests.some((r) => r.method === "ask_user.cancel"), "an abandoned call withdraws its question");
		const cancel = requests.find((r) => r.method === "ask_user.cancel");
		assert.ok(slow.params.askId && cancel.params.askId === slow.params.askId, "the cancel names that call");

		const result = await client.callTool({
			name: "ask_user",
			arguments: { questions: [{ header: " Format ", question: "Which format?", options: [{ label: "PDF", description: "x" }, { label: "Markdown", description: "y" }] }] },
		});
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.equal(result.content[0].text, 'The user answered:\n"Which format?" = "Markdown"');
		const asks = requests.filter((r) => r.method === "ask_user" && r.params.questions[0].question !== "slow?");
		assert.equal(asks.length, 1, "asked once");
		assert.equal(asks[0].params.questions[0].header, "Format", "sent the checked, trimmed questions");
	} finally {
		await client.close().catch(() => {});
		server.close();
	}
});
