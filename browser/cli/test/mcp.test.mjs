// The MCP server with no browser anywhere: every tool is listed with a usable
// description, the safety rules are in the instructions, and a tool call fails fast
// with the one not-connected message instead of hanging.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const NOT_CONNECTED =
	"Polycarp isn't connected. Ask the user to open Helium/Chrome with the Polycarp extension loaded, or run `polycarp-browser doctor`.";
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
			// No computer-use helper, even on a Mac with Polycarp installed: computer.test.mjs covers it.
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: join(root, "sock"), POLYCARP_SPACES_BIN: join(root, "no-helper") },
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
	for (const name of ["status", "tabs_context", "navigate", "read_page", "click", "type", "fill", "screenshot", "actions", "capture", "files"]) {
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
	// get_page_text's PDF page range adds ~100: reading pages 30-40 of a long PDF without the first 29.
	// site_edit and site_script add ~1,800: hiding, blocking and ad blocking per site, and scripts the user turns on, which
	// otherwise took a run_js on every visit and couldn't outlast the page.
	// capture adds ~940: network to a HAR, recording and a flight recorder in one tool with an action, not
	// three or eight (docs/decisions.md, D36). The SDK puts `"execution":{"taskSupport":"forbidden"}` on every
	// tool, which is what an absent field already means; dropping it from the list gives back ~1,860, so the
	// budget stays where it was and no description was shortened for the new tool.
	for (const tool of tools) assert.equal(tool.execution, undefined, `${tool.name} still carries the default execution field`);
	const bytes = Buffer.byteLength(JSON.stringify(tools));
	// files adds 1,319 (30,434 to 31,753): uploads, downloads, a page as PDF and the saved files in one tool with an
	// action, not six (docs/decisions.md, D38). Its nine arguments are what cost; the description is three lines. The
	// budget goes up by the 700 that did not fit, and no other tool was shortened for it.
	// wait's until:"settled" adds 131 (D41): the page settling is otherwise a read_page loop. The budget goes up by
	// the 100 that did not fit under it.
	assert.ok(bytes <= 31900, `tools/list is ${bytes} bytes, over the 31,900 budget`);
	// The loop line teaching `changes` (D42) adds 47 bytes; it saves a read_page after most actions.
	assert.ok(Buffer.byteLength(mcp.getInstructions() ?? "") <= 2995, "instructions over 2,995 bytes");
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
	assert.match(instructions, /Call tabs_context before any browser tool: .* If it says Polycarp isn't connected, tell the user and stop browser work/);
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
	// The unknown-site case: the reply points at site-learning, which an agent wouldn't otherwise reach.
	assert.match(none.content[0].text, /skill_read \{"name":"site-learning"\}/);
	const site = await mcp.callTool({ name: "skill_match", arguments: { task: "Find the three newest recipes about lentils on recipes.example.org" } });
	assert.match(site.content[0].text, /site-learning/);
	// "Delete all of them" carries no word the router can weigh ("all" and "every" are stopwords), so
	// the instructions name the bulk-actions skill, and skill_read has it.
	assert.match(instructions, /For one action on many items on a website \(delete all\), skill_read \{"name":"bulk-actions"\}/);
	const bulk = await mcp.callTool({ name: "skill_read", arguments: { name: "bulk-actions" } });
	assert.match(bulk.content[0].text, /^---\nname: bulk-actions\n/);
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
	process.env.TABKYRA_CONFIG_DIR = join(home, ".config", "polycarp", "browser");
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
		const local = join(home, ".config", "polycarp", "browser", "skills-local");
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

test("capture: the file is written here, privately, and the agent is told its path and size, never the content", async () => {
	// A fake native host with the extension behind it: answers `capture` the way the worker does, with the file inside.
	const dir = join(root, "capture-sock");
	const config = join(root, "capture-config");
	mkdirSync(dir, { mode: 0o700 });
	const path = join(dir, `${process.pid}.sock`);
	const frame = (m) => {
		const body = Buffer.from(JSON.stringify(m));
		const head = Buffer.alloc(4);
		head.writeUInt32LE(body.length);
		return Buffer.concat([head, body]);
	};
	const requests = [];
	const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]);
	const answers = {
		network_stop: { id: "c1", kind: "network", entries: 1, notes: ["Secrets are redacted."], file: { kind: "har", encoding: "json", data: { log: { version: "1.2", comment: "HARBODY-MARKER", entries: [] } }, bytes: 70 } },
		record_stop: { id: "c2", kind: "record", durationMs: 4000, file: { kind: "webm", encoding: "base64", data: webm.toString("base64"), bytes: webm.length } },
		flight_save: { id: "c3", kind: "flight", file: { kind: "webm", encoding: "base64", data: Buffer.from("not a webm file, just text ".repeat(5)).toString("base64"), bytes: 135 } },
		status: { captures: [{ id: "c1", kind: "network", state: "running" }] },
	};
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
					socket.write(frame({ type: "response", id: msg.id, result: answers[msg.params.action] }));
				}
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	const client = new Client({ name: "tabkyra-mcp-capture", version: "0.0.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [cli, "mcp"],
				env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: dir, TABKYRA_CONFIG_DIR: config },
				stderr: "ignore",
			}),
		);
		const run = async (args) => {
			const r = await client.callTool({ name: "capture", arguments: args });
			return { ...r, text: r.content.map((c) => c.text).join("\n") };
		};
		const har = await run({ action: "network_stop" });
		assert.notEqual(har.isError, true, har.text);
		const result = JSON.parse(har.text);
		assert.ok(result.path.startsWith(join(config, "captures") + "/") && result.path.endsWith(".har"), result.path);
		assert.equal(result.bytes, readFileSync(result.path).length);
		assert.ok(!har.text.includes("HARBODY-MARKER") && result.file === undefined && result.data === undefined, "the content does not go back to the agent");
		assert.equal(JSON.parse(readFileSync(result.path, "utf8")).log.comment, "HARBODY-MARKER", "but it is in the file");
		assert.deepEqual(result.notes, ["Secrets are redacted."]);
		assert.equal(statSync(result.path).mode & 0o777, 0o600);
		assert.equal(statSync(join(config, "captures")).mode & 0o777, 0o700);

		const video = await run({ action: "record_stop" });
		const v = JSON.parse(video.text);
		assert.ok(v.path.endsWith(".webm") && v.path !== result.path);
		assert.deepEqual(readFileSync(v.path), webm);
		assert.equal(statSync(v.path).mode & 0o777, 0o600);
		assert.equal(v.durationMs, 4000);

		// What the extension sends must be what it says: a "WebM" with no EBML header is refused and nothing is written.
		const before = readdirSync(join(config, "captures")).length;
		const bad = await run({ action: "flight_save" });
		assert.equal(bad.isError, true);
		assert.match(bad.text, /not a WebM/);
		assert.equal(readdirSync(join(config, "captures")).length, before);

		// Calls with no file pass straight through.
		assert.deepEqual(JSON.parse((await run({ action: "status" })).text), answers.status);
		// A stop that was written tells the browser so, with its id, so it can let go of its copy.
		assert.deepEqual(requests.map((r) => r.method), ["capture", "capture", "capture", "capture", "capture", "capture"]);
		assert.deepEqual(requests.map((r) => r.params.action), ["network_stop", "cancel", "record_stop", "cancel", "flight_save", "status"]);
		assert.deepEqual(requests.filter((r) => r.params.action === "cancel").map((r) => r.params.id), ["c1", "c2"]);

		// first-F4: a stop whose file cannot be written is an error that says the capture is still held and how to ask again,
		// and the browser is not told to let go of it. The captures folder is made unusable (a link), then put right.
		const folder = join(config, "captures");
		renameSync(folder, `${folder}.real`);
		symlinkSync(`${folder}.real`, folder);
		const lost = await run({ action: "network_stop" });
		assert.equal(lost.isError, true);
		assert.match(lost.text, /capture was not saved/);
		assert.match(lost.text, /still held in the browser for 5 minutes: call network_stop again with id c1/);
		assert.equal(requests.length, 7, "no release was sent for a file that is not on disk");
		const flight = await run({ action: "flight_save" });
		assert.match(flight.text, /still recording: call flight_save again/);
		assert.ok(!/id c3/.test(flight.text));
		rmSync(folder);
		renameSync(`${folder}.real`, folder);
		const retried = await run({ action: "network_stop", id: "c1" });
		assert.notEqual(retried.isError, true, retried.text);
		assert.ok(JSON.parse(retried.text).path.endsWith(".har"));
		assert.deepEqual(requests.slice(7).map((r) => [r.params.action, r.params.id]), [["flight_save", undefined], ["network_stop", "c1"], ["cancel", "c1"]]);
		// An action the tool does not have never reaches the browser.
		const unknown = await client.callTool({ name: "capture", arguments: { action: "stream" } });
		assert.equal(unknown.isError, true);
		assert.equal(requests.length, 10);
	} finally {
		await client.close().catch(() => {});
		server.close();
	}
});

// The files tool (docs/decisions.md, D38). A fake native host stands in for the extension: it keeps what an upload
// sends, and serves a download in the pieces the worker would.
const FRAME_LIMIT = 900 * 1024;
const PIECE_OUT = 480 * 1024;
const PIECE_IN = 3 * 1024 * 1024;
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function filesHost(name, behave = {}) {
	const dir = join(root, `files-${name}-sock`);
	mkdirSync(dir, { mode: 0o700 });
	const path = join(dir, `${process.pid}.sock`);
	const frame = (m) => {
		const body = Buffer.from(JSON.stringify(m));
		const head = Buffer.alloc(4);
		head.writeUInt32LE(body.length);
		return Buffer.concat([head, body]);
	};
	const host = { dir, requests: [], frameBytes: [], uploads: [], serve: undefined, waiting: {} };
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		const reply = (id, result) => socket.write(frame({ type: "response", id, result }));
		const fail = (id, code, message) => socket.write(frame({ type: "response", id, error: { code, message } }));
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				const size = buffered.readUInt32LE(0);
				const msg = JSON.parse(buffered.subarray(4, 4 + size).toString());
				buffered = buffered.subarray(4 + size);
				if (msg.type === "hello") {
					socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: true }));
					host.asked = msg.client?.session;
					// A second agent in the project: the extension gives it a session of its own as it connects.
					if (behave.assign) socket.write(frame({ type: "event", event: "session_assigned", data: { session: `${msg.client.session}-2` } }));
					continue;
				}
				if (msg.type !== "request") continue;
				// The files tool asks for its status once, to learn the session the extension gave it. Counted apart.
				if (msg.method === "status") {
					host.statusCalls = (host.statusCalls ?? 0) + 1;
					reply(msg.id, {});
					continue;
				}
				host.requests.push(msg);
				host.frameBytes.push(size);
				const p = msg.params ?? {};
				const begun = () => {
					host.uploads.push({ files: p.files, chunks: [] });
					reply(msg.id, { transferId: `u${host.uploads.length}`, tabId: 7, host: "upload.test", target: "input" });
				};
				if (msg.method === "files.upload.begin") {
					const asking = p.files.filter((f) => f.ask).map((f) => ({ name: f.name, bytes: f.bytes }));
					if (asking.length && behave.ask) {
						const requestId = `c1:q${msg.id}`;
						host.waiting[requestId] = { id: msg.id, begun };
						socket.write(frame({ type: "event", event: "permission_request", data: { requestId, askId: host.unknownAsk ? "x" : p.askId, host: "upload.test", url: "https://upload.test/form", kind: "upload", agent: "Test Agent", files: asking } }));
					} else begun();
				} else if (msg.method === "permission.respond") {
					reply(msg.id, { accepted: true });
					const w = host.waiting[p.requestId];
					if (p.decision === "allow_once") w.begun();
					else fail(w.id, "permission_denied", "The user did not approve the upload. Nothing was sent.");
				} else if (msg.method === "files.upload.chunk") {
					const up = host.uploads[Number(p.transferId.slice(1)) - 1];
					up.chunks[p.seq] = Buffer.from(p.data, "base64");
					reply(msg.id, { received: up.chunks.reduce((a, c) => a + c.length, 0) });
				} else if (msg.method === "files.upload.commit") {
					const up = host.uploads[Number(p.transferId.slice(1)) - 1];
					reply(msg.id, { host: "upload.test", target: "input", files: up.files.map((f) => ({ name: f.name, bytes: f.bytes })), holds: up.files.map((f) => ({ name: f.name, size: f.bytes })) });
				} else if (msg.method === "files.download.begin" || msg.method === "files.pdf.begin") {
					const file = host.serve;
					reply(msg.id, { transferId: "d1", bytes: file.announce ?? file.body.length, chunks: Math.ceil((file.announce ?? file.body.length) / PIECE_IN), mime: file.mime, name: file.name, url: file.url ?? "https://files.test/get" });
				} else if (msg.method === "files.download.chunk") {
					reply(msg.id, { index: p.index, data: host.serve.body.subarray(p.index * PIECE_IN, (p.index + 1) * PIECE_IN).toString("base64") });
				} else reply(msg.id, {});
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	host.close = () => server.close();
	host.methods = () => host.requests.map((r) => r.method);
	return host;
}

/** A project folder the helper runs in, a folder outside it, and the files the tests name. */
function filesFixture(name) {
	const base = realpathSync(root);
	const proj = join(base, `${name}-proj`);
	const outside = join(base, `${name}-outside`);
	const config = join(base, `${name}-config`);
	for (const d of [proj, outside]) mkdirSync(d);
	return { proj, outside, config };
}

async function filesClient(host, fx, { capabilities, env = {} } = {}) {
	const client = new Client({ name: "tabkyra-mcp-files", version: "0.0.0" }, capabilities ? { capabilities } : undefined);
	const run = async (args) => {
		const r = await client.callTool({ name: "files", arguments: args });
		return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
	};
	const connect = () =>
		client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [cli, "mcp"],
				cwd: fx.proj,
				env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: host.dir, TABKYRA_CONFIG_DIR: fx.config, POLYCARP_SPACES_BIN: join(root, "no-helper"), ...env },
				stderr: "ignore",
			}),
		);
	return { client, run, connect };
}

test("files upload: content goes in pieces under the frame limit and arrives byte for byte; a refused path sends nothing", async () => {
	const fx = filesFixture("up");
	const host = await filesHost("up");
	const { client, run, connect } = await filesClient(host, fx);
	const big = randomBytes(1536 * 1024);
	writeFileSync(join(fx.proj, "big.bin"), big);
	writeFileSync(join(fx.proj, "small.txt"), "hello");
	try {
		await connect();
		const done = await run({ action: "upload", ref: "e1", paths: [join(fx.proj, "big.bin"), join(fx.proj, "small.txt")] });
		assert.notEqual(done.isError, true, done.text);
		const result = JSON.parse(done.text);
		assert.deepEqual(result.uploaded, [{ name: "big.bin", bytes: big.length }, { name: "small.txt", bytes: 5 }]);
		assert.equal(result.host, "upload.test");
		assert.deepEqual(result.holds.map((h) => h.name), ["big.bin", "small.txt"]);
		const pieces = Math.ceil((big.length + 5) / PIECE_OUT);
		assert.ok(pieces >= 4, "the file is larger than one piece");
		assert.deepEqual(host.methods(), ["files.upload.begin", ...Array(pieces).fill("files.upload.chunk"), "files.upload.commit"]);
		assert.ok(Math.max(...host.frameBytes) <= FRAME_LIMIT, `largest frame was ${Math.max(...host.frameBytes)} bytes`);
		assert.ok(Math.max(...host.frameBytes) > 600 * 1024, "and the pieces are not needlessly small");
		const up = host.uploads[0];
		assert.deepEqual(host.requests.filter((r) => r.method === "files.upload.chunk").map((r) => r.params.seq), [...Array(pieces).keys()]);
		const arrived = Buffer.concat(up.chunks);
		assert.equal(sha(arrived), sha(Buffer.concat([big, Buffer.from("hello")])), "the bytes reassemble exactly");
		assert.equal(up.files[0].sha256, sha(big));
		assert.equal(sha(arrived.subarray(0, big.length)), up.files[0].sha256);
		assert.deepEqual(up.files.map((f) => [f.name, f.bytes, f.ask, f.mime]), [["big.bin", big.length, false, "application/octet-stream"], ["small.txt", 5, false, "text/plain"]]);
		assert.ok(!JSON.stringify(host.requests).includes(fx.proj), "no host path is sent to the browser");

		// Refusals are decided here: the bridge hears nothing.
		const sent = host.requests.length;
		mkdirSync(join(fx.outside, "keys"));
		writeFileSync(join(fx.outside, "keys", "id_ed25519"), "PRIVATE");
		writeFileSync(join(fx.proj, ".env"), "TOKEN=1");
		symlinkSync(join(fx.outside, "keys", "id_ed25519"), join(fx.proj, "notes.txt"));
		writeFileSync(join(fx.proj, "one.txt"), "twin");
		linkSync(join(fx.proj, "one.txt"), join(fx.proj, "two.txt"));
		mkdirSync(join(fx.config, "files"), { recursive: true });
		writeFileSync(join(fx.config, "remote.json"), "{}");
		writeFileSync(join(fx.proj, "six-a.bin"), Buffer.alloc(6 * 1024 * 1024));
		writeFileSync(join(fx.proj, "six-b.bin"), Buffer.alloc(6 * 1024 * 1024));
		const refused = [
			[[join(fx.proj, ".env")], /credential/],
			[[join(fx.proj, "notes.txt")], /credential/],
			[[join(fx.proj, "one.txt")], /hard link/],
			[[fx.proj], /not a regular file/],
			[[join(fx.proj, "nope.txt")], /can't be read/],
			[["small.txt"], /not an absolute path/],
			[[join(fx.config, "remote.json")], /never uploads from/],
			[[join(fx.proj, "six-a.bin"), join(fx.proj, "six-b.bin")], /at most/],
			[Array(11).fill(join(fx.proj, "small.txt")), /at most 10/],
			// One bad file refuses the whole call, good files included.
			[[join(fx.proj, "small.txt"), join(fx.proj, ".env")], /credential/],
		];
		for (const [paths, why] of refused) {
			const r = await run({ action: "upload", ref: "e1", paths });
			assert.equal(r.isError, true, paths[0]);
			assert.match(r.text, why);
		}
		assert.equal((await run({ action: "upload", paths: [join(fx.proj, "small.txt")] })).isError, true, "no ref");
		assert.equal((await run({ action: "upload", ref: "e1" })).isError, true, "no files");
		assert.equal(host.requests.length, sent, "nothing reached the bridge for any of them");

		// A file outside the agent's folder is sent marked as needing the person's yes.
		writeFileSync(join(fx.outside, "cv.pdf"), "%PDF-1.4 cv");
		assert.notEqual((await run({ action: "upload", ref: "e1", paths: [join(fx.outside, "cv.pdf")] })).isError, true);
		assert.deepEqual(host.uploads[1].files.map((f) => [f.name, f.ask]), [["cv.pdf", true]]);
	} finally {
		await client.close().catch(() => {});
		host.close();
	}
});

test("files upload: two calls at once each ask about their own file, and a yes to one sends only that one", async () => {
	const fx = filesFixture("pair");
	const host = await filesHost("pair", { ask: true });
	const { client, run, connect } = await filesClient(host, fx, { capabilities: { roots: {}, elicitation: {} } });
	// Same name, same size, different folders: only the path tells them apart.
	const [secret, flyer] = ["private", "public"].map((d) => (mkdirSync(join(fx.proj, d)), join(fx.proj, d, "report.txt")));
	writeFileSync(secret, "SECRET");
	writeFileSync(flyer, "public");
	const questions = [];
	let both;
	const asked = new Promise((r) => (both = r));
	client.setRequestHandler(ElicitRequestSchema, async (req) => {
		if (questions.push(req.params.message) === 2) both();
		// Both calls are waiting on their question before either is answered. The person says yes to the flyer only.
		await asked;
		return { action: "accept", content: { decision: req.params.message.includes(flyer) ? "allow_once" : "deny" } };
	});
	client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(fx.outside).href, name: "work" }] }));
	try {
		await connect();
		const [a, b] = await Promise.all([secret, flyer].map((path) => run({ action: "upload", ref: "e1", paths: [path] })));
		assert.deepEqual([questions.filter((q) => q.includes(secret)).length, questions.filter((q) => q.includes(flyer)).length], [1, 1], questions.join("\n"));
		assert.equal(a.isError, true, a.text);
		assert.notEqual(b.isError, true, b.text);
		assert.deepEqual(host.uploads.map((u) => Buffer.concat(u.chunks).toString()), ["public"], "only the approved file's content moved");
		// A question that carries no call's id (another helper's, or a made-up one) is answered no without being put.
		const before = questions.length;
		host.unknownAsk = true;
		assert.equal((await run({ action: "upload", ref: "e1", paths: [flyer] })).isError, true);
		assert.equal(questions.length, before);
	} finally {
		await client.close().catch(() => {});
		host.close();
	}
});

test("files upload: a path outside the client's roots asks the person each time, and only a yes to that upload counts", async () => {
	const fx = filesFixture("ask");
	const host = await filesHost("ask", { ask: true });
	// Even with the switch that answers site questions on its own.
	const { client, run, connect } = await filesClient(host, fx, { capabilities: { roots: {}, elicitation: {} }, env: { TABKYRA_AUTO_ALLOW: "1" } });
	const questions = [];
	let answer = { action: "accept", content: { decision: "allow_once" } };
	client.setRequestHandler(ElicitRequestSchema, async (req) => {
		questions.push(req.params);
		return answer;
	});
	// The client names its own root, so the helper's working directory is not one.
	client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(fx.outside).href, name: "work" }] }));
	writeFileSync(join(fx.outside, "in-root.txt"), "in root");
	writeFileSync(join(fx.proj, "cv.pdf"), Buffer.alloc(2048, 1));
	try {
		await connect();
		const free = await run({ action: "upload", ref: "e1", paths: [join(fx.outside, "in-root.txt")] });
		assert.notEqual(free.isError, true, free.text);
		assert.equal(questions.length, 0, "a file inside a root asks nothing");
		assert.equal(host.uploads[0].files[0].ask, false);

		const yes = await run({ action: "upload", ref: "e1", paths: [join(fx.proj, "cv.pdf")] });
		assert.notEqual(yes.isError, true, yes.text);
		assert.equal(questions.length, 1);
		// The question names the agent, the file, its size and where it is going.
		for (const part of [/Test Agent/, /cv\.pdf/, /2 KB/, /upload\.test/]) assert.match(questions[0].message, part);
		// And where the file is, so a cv.pdf from another folder can't pass for this one. The browser is still sent the name alone.
		assert.ok(questions[0].message.includes(join(fx.proj, "cv.pdf")), questions[0].message);
		assert.ok(!JSON.stringify(host.requests).includes(fx.proj), "no host path is sent to the browser");
		assert.deepEqual(questions[0].requestedSchema.properties.decision.enum, ["allow_once", "deny"], "there is no answer that remembers");
		assert.equal(sha(Buffer.concat(host.uploads[1].chunks)), sha(Buffer.alloc(2048, 1)));

		// A yes is not remembered: the same file asks again, and a no sends no content.
		const chunks = () => host.methods().filter((m) => m === "files.upload.chunk").length;
		const before = chunks();
		for (const no of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { decision: "deny" } }, { action: "accept", content: { decision: "allow_host" } }]) {
			answer = no;
			const r = await run({ action: "upload", ref: "e1", paths: [join(fx.proj, "cv.pdf")] });
			assert.equal(r.isError, true, JSON.stringify(no));
			assert.match(r.text, /did not approve/);
		}
		assert.equal(questions.length, 5);
		assert.equal(chunks(), before, "no content moved after a no");
		assert.deepEqual(host.requests.filter((r) => r.method === "permission.respond").map((r) => r.params.decision), ["allow_once", "deny", "deny", "deny", "deny"]);
	} finally {
		await client.close().catch(() => {});
		host.close();
	}
});

test("files download, save_pdf, list, read, remove: private files with an id, and read is capped", async () => {
	const fx = filesFixture("down");
	const host = await filesHost("down");
	const { client, run, connect } = await filesClient(host, fx);
	try {
		await connect();
		const body = randomBytes(3 * 1024 * 1024 + 4096);
		host.serve = { body, name: "../../.evil<name>.bin", mime: "application/octet-stream", url: "https://files.test/get?id=1" };
		const got = await run({ action: "download", url: "https://files.test/get?id=1" });
		assert.notEqual(got.isError, true, got.text);
		const file = JSON.parse(got.text);
		const folder = dirname(file.path);
		assert.equal(dirname(folder), join(fx.config, "files"), "saved under files/<session>");
		assert.deepEqual([file.name, file.bytes, file.sha256, file.mime, file.sourceUrl], ["evil_name_.bin", body.length, sha(body), "application/octet-stream", "https://files.test/get?id=1"]);
		assert.match(file.id, /^f_[0-9a-f]{10}$/);
		assert.equal(sha(readFileSync(file.path)), sha(body));
		assert.equal(statSync(file.path).mode & 0o777, 0o600);
		assert.equal(statSync(folder).mode & 0o777, 0o700);
		assert.equal(statSync(join(fx.config, "files")).mode & 0o777, 0o700);
		assert.deepEqual(host.methods(), ["files.download.begin", "files.download.chunk", "files.download.chunk", "files.download.end"]);
		assert.deepEqual(host.requests.filter((r) => r.method === "files.download.chunk").map((r) => r.params.index), [0, 1]);
		assert.ok(!got.text.includes(body.subarray(0, 12).toString("base64")), "the content does not go back to the agent");

		// The same name again never replaces the first file.
		host.serve = { body: Buffer.from("second"), name: "evil_name_.bin", mime: "application/octet-stream" };
		const second = JSON.parse((await run({ action: "download", url: "https://files.test/again" })).text);
		assert.equal(second.name, "evil_name_-1.bin");
		assert.equal(sha(readFileSync(file.path)), sha(body));

		// What arrives must be what was announced, or nothing is kept.
		const kept = () => readdirSync(folder).filter((n) => !n.startsWith(".")).sort();
		const before = kept();
		host.serve = { body: Buffer.alloc(90), announce: 100, name: "short.bin", mime: "application/octet-stream" };
		const short = await run({ action: "download", url: "https://files.test/short" });
		assert.equal(short.isError, true);
		assert.match(short.text, /Not saved/);
		host.serve = { body: Buffer.alloc(10), announce: 60 * 1024 * 1024, name: "huge.bin", mime: "application/octet-stream" };
		const huge = await run({ action: "download", url: "https://files.test/huge" });
		assert.equal(huge.isError, true);
		assert.match(huge.text, /62914560 bytes/);
		host.serve = { body: Buffer.from("<html>not a pdf</html>"), name: "Page.pdf", mime: "application/pdf" };
		const fake = await run({ action: "save_pdf" });
		assert.equal(fake.isError, true);
		assert.match(fake.text, /did not return a PDF/);
		assert.deepEqual(kept(), before, "none of the three left a file");
		assert.equal((await run({ action: "download" })).isError, true, "download needs a url or a ref");

		host.serve = { body: Buffer.from("%PDF-1.7\nbody"), name: "My page.pdf", mime: "application/pdf", url: "https://files.test/page" };
		const pdf = JSON.parse((await run({ action: "save_pdf" })).text);
		assert.deepEqual([pdf.name, pdf.mime, pdf.sourceUrl], ["My page.pdf", "application/pdf", "https://files.test/page"]);
		assert.equal(readFileSync(pdf.path, "latin1").slice(0, 4), "%PDF");

		// read: text is text and is cut at 200 KB; an image is an image only by its bytes; anything else is a blob; over 8 MB is an error with the size.
		const save = async (served) => {
			host.serve = served;
			const r = await run({ action: "download", url: "https://files.test/x" });
			assert.notEqual(r.isError, true, r.text);
			return JSON.parse(r.text);
		};
		const longText = await save({ body: Buffer.from("line of text\n".repeat(30000)), name: "long.txt", mime: "text/plain; charset=utf-8" });
		const read = await run({ action: "read", id: longText.id });
		assert.equal(read.content.length, 1);
		assert.match(read.text, /\[Cut: the first 200 KB of 381 KB \(long\.txt\)/);
		assert.ok(Buffer.byteLength(read.text) <= 200 * 1024 + 300, `read returned ${Buffer.byteLength(read.text)} bytes`);
		const less = await run({ action: "read", id: longText.id, max_bytes: 1000 });
		assert.ok(Buffer.byteLength(less.text) <= 1300 && /\[Cut: the first 1000 bytes/.test(less.text), less.text.slice(-200));
		const whole = await run({ action: "read", id: (await save({ body: Buffer.from('{"a":1}'), name: "data.json", mime: "application/json" })).id });
		assert.equal(whole.text, '{"a":1}');

		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
		const image = await run({ action: "read", id: (await save({ body: png, name: "shot.png", mime: "image/png" })).id });
		assert.deepEqual(image.content.map((c) => c.type), ["text", "image"]);
		assert.deepEqual([image.content[1].mimeType, image.content[1].data], ["image/png", png.toString("base64")]);
		const notImage = await run({ action: "read", id: (await save({ body: Buffer.from("GARBAGE, not a png at all"), name: "shot2.png", mime: "image/png" })).id });
		assert.deepEqual(notImage.content.map((c) => c.type), ["text", "resource"], "a file that only claims to be an image is not shown as one");
		const blob = await run({ action: "read", id: pdf.id });
		assert.deepEqual(blob.content.map((c) => c.type), ["text", "resource"]);
		assert.deepEqual([blob.content[1].resource.mimeType, Buffer.from(blob.content[1].resource.blob, "base64").toString()], ["application/pdf", "%PDF-1.7\nbody"]);

		const nine = await save({ body: Buffer.alloc(9 * 1024 * 1024, 5), name: "nine.bin", mime: "application/octet-stream" });
		const over = await run({ action: "read", id: nine.id });
		assert.equal(over.isError, true);
		assert.match(over.text, /nine\.bin is 9437184 bytes \(9\.0 MB\); read returns at most 8\.0 MB/);
		assert.ok(over.text.includes(nine.path), "a local caller is told where the file is");
		const small = await run({ action: "read", id: pdf.id, max_bytes: 4 });
		assert.equal(small.isError, true);
		assert.match(small.text, /is 13 bytes/);
		assert.equal((await run({ action: "read", id: "f_0000000000" })).isError, true);

		// list and remove, and a saved file goes back up by its id without a question.
		const listed = JSON.parse((await run({ action: "list" })).text).files;
		assert.ok(listed.length >= 8 && listed.every((f) => f.id && f.path && f.sha256 && f.savedAt && f.mime && typeof f.bytes === "number" && "sourceUrl" in f));
		const sent = host.requests.length;
		const up = await run({ action: "upload", ref: "e1", ids: [pdf.id] });
		assert.notEqual(up.isError, true, up.text);
		assert.deepEqual(host.uploads[0].files.map((f) => [f.name, f.ask, f.mime]), [["My page.pdf", false, "application/pdf"]]);
		assert.equal(Buffer.concat(host.uploads[0].chunks).toString(), "%PDF-1.7\nbody");
		assert.equal((await run({ action: "upload", ref: "e1", ids: ["f_0000000000"] })).isError, true);
		assert.equal(host.requests.length, sent + 3, "an unknown id sends nothing");
		assert.deepEqual(JSON.parse((await run({ action: "remove", id: pdf.id })).text), { removed: pdf.id, name: "My page.pdf" });
		assert.equal((await run({ action: "remove", id: pdf.id })).isError, true);
		assert.ok(!kept().includes("My page.pdf"));
	} finally {
		await client.close().catch(() => {});
		host.close();
	}
});

test("files: a second agent in one project keeps its files apart from the first, from its first call on", async () => {
	const fx = filesFixture("two");
	const host = await filesHost("two", { assign: true });
	const { client, run, connect } = await filesClient(host, fx);
	try {
		await connect();
		// Its very first call is one that never needed the browser: it asks which session it has before it looks at a folder.
		assert.deepEqual(JSON.parse((await run({ action: "list" })).text), { files: [] });
		assert.equal(host.statusCalls, 1);
		const asked = host.asked;
		assert.ok(asked, "the helper asked for a session by name");
		// The first agent's saved file, in the folder of the name both asked for.
		const first = join(fx.config, "files", asked);
		mkdirSync(first, { recursive: true, mode: 0o700 });
		writeFileSync(join(first, "theirs.txt"), "the first agent's", { mode: 0o600 });
		writeFileSync(join(first, ".index.json"), JSON.stringify({ files: [{ id: "f_aaaaaaaaaa", name: "theirs.txt", bytes: 17, mime: "text/plain", sha256: "", sourceUrl: "", savedAt: "" }] }), { mode: 0o600 });
		for (const args of [{ action: "list" }, { action: "read", id: "f_aaaaaaaaaa" }, { action: "remove", id: "f_aaaaaaaaaa" }, { action: "upload", ref: "e1", ids: ["f_aaaaaaaaaa"] }]) {
			const r = await run(args);
			assert.ok(!r.text.includes("theirs") && !r.text.includes("the first agent's"), `${args.action}: ${r.text}`);
			if (args.action !== "list") assert.equal(r.isError, true, args.action);
		}
		assert.equal(readFileSync(join(first, "theirs.txt"), "utf8"), "the first agent's");
		// What it saves goes under the name it was given, and ending its session removes that folder alone.
		host.serve = { body: Buffer.from("mine"), name: "mine.txt", mime: "text/plain" };
		const mine = JSON.parse((await run({ action: "download", url: "https://files.test/mine" })).text);
		assert.equal(mine.path, join(fx.config, "files", `${asked}-2`, "mine.txt"));
		assert.equal(host.statusCalls, 1, "asked once");
		assert.notEqual((await client.callTool({ name: "session_end", arguments: {} })).isError, true);
		assert.equal(existsSync(join(fx.config, "files", `${asked}-2`)), false);
		assert.equal(existsSync(join(first, "theirs.txt")), true);
	} finally {
		await client.close().catch(() => {});
		host.close();
	}
});

test("files for a remote session: its own scope, never a path in, never a path out, only its own files", async () => {
	const { build } = await import("esbuild");
	const here = dirname(fileURLToPath(import.meta.url));
	const bundle = async (entry) => {
		const out = join(root, `files-${entry}.mjs`);
		await build({ entryPoints: [join(here, "..", "src", `${entry}.ts`)], bundle: true, platform: "node", format: "esm", outfile: out, loader: { ".md": "text", ".pub": "text" }, logLevel: "silent" });
		return import(out);
	};
	// The scope: its own, holding only this tool, and not ticked for a new connector.
	const { SCOPES, toolsFor } = await bundle("remote");
	const { DEFAULT_GRANT } = await bundle("oauth");
	assert.deepEqual(SCOPES["browser.files"].tools, ["files"]);
	assert.equal(DEFAULT_GRANT.includes("browser.files"), false);
	assert.equal(toolsFor(DEFAULT_GRANT).has("files"), false);
	assert.equal(toolsFor(Object.keys(SCOPES).filter((s) => s !== "browser.files")).has("files"), false, "no other scope carries it");
	assert.equal(toolsFor(["browser.files"]).has("files"), true);
	// The owner is told what ticking it grants: fetched with their sign-in, and what the stronger scopes add.
	for (const part of [/your sign-in/, /browser\.navigate/, /browser\.script/, /Never a file path/, /removed when the session ends/]) assert.match(SCOPES["browser.files"].what, part);

	const { createMcpServer } = await bundle("mcp");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
	const fx = filesFixture("remote");
	const host = await filesHost("remote");
	const saved = { TABKYRA_CONFIG_DIR: process.env.TABKYRA_CONFIG_DIR, TABKYRA_SOCKET_DIR: process.env.TABKYRA_SOCKET_DIR };
	process.env.TABKYRA_CONFIG_DIR = fx.config;
	process.env.TABKYRA_SOCKET_DIR = host.dir;
	const clients = [];
	const open = async (options) => {
		const { server, client: bridge } = createMcpServer(options);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: "remote-files-test", version: "0.0.0" });
		await client.connect(b);
		// The bridge socket lives in this process here: closed with the client, or the run never ends.
		clients.push({ close: async () => (await client.close(), bridge.close()) });
		const run = async (args) => {
			const r = await client.callTool({ name: "files", arguments: args });
			return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
		};
		return { client, run };
	};
	try {
		const without = await open({ name: "r0", session: "remote-t0-aaaa", remote: true, allowedTools: toolsFor(DEFAULT_GRANT) });
		assert.equal((await without.client.listTools()).tools.some((t) => t.name === "files"), false, "without the scope the tool is not listed");
		assert.equal((await without.client.callTool({ name: "files", arguments: { action: "list" } })).isError, true);

		const one = await open({ name: "r1", session: "remote-t1-bbbb", remote: true, allowedTools: toolsFor([...DEFAULT_GRANT, "browser.files"]) });
		assert.equal((await one.client.listTools()).tools.some((t) => t.name === "files"), true);
		// A path is refused before the bridge hears of it, whatever the path.
		writeFileSync(join(fx.proj, "report.txt"), "report");
		for (const path of [join(fx.proj, "report.txt"), join(fx.config, "files", "remote-t1-bbbb", "x.bin")]) {
			const r = await one.run({ action: "upload", ref: "e1", paths: [path] });
			assert.equal(r.isError, true);
			assert.match(r.text, /remote session can't upload from a path/);
		}
		assert.deepEqual(host.requests, []);

		const body = Buffer.alloc(9 * 1024 * 1024, 9);
		host.serve = { body, name: "nine.bin", mime: "application/octet-stream" };
		// The default grant has no browser.script: an address the agent names is refused before the bridge hears of it,
		// whatever the address, and with any other argument beside it.
		for (const args of [{ url: "https://files.test/nine" }, { url: "/api/me" }, { url: "/api/me", ref: "e9" }, { url: "blob:https://files.test/1" }]) {
			const named = await one.run({ action: "download", ...args });
			assert.equal(named.isError, true);
			assert.match(named.text, /^permission_denied: .*browser\.script/);
		}
		assert.deepEqual(host.requests, []);
		// A link on the page is what the scope is for.
		const got = await one.run({ action: "download", ref: "e9" });
		assert.notEqual(got.isError, true, got.text);
		assert.equal(host.requests[0].params.url, undefined);
		const file = JSON.parse(got.text);
		assert.deepEqual(Object.keys(file).sort(), ["bytes", "id", "mime", "name", "savedAt", "sha256", "sourceUrl"], "no path among them");
		const onDisk = join(fx.config, "files", "remote-t1-bbbb", "nine.bin");
		assert.equal(sha(readFileSync(onDisk)), sha(body));
		assert.equal(statSync(onDisk).mode & 0o777, 0o600);
		const outputs = [got.text, (await one.run({ action: "list" })).text, (await one.run({ action: "read", id: file.id })).text, (await one.run({ action: "remove", id: "f_0000000000" })).text];
		assert.match(outputs[2], /is 9437184 bytes/);
		for (const text of outputs) assert.ok(!text.includes(fx.config) && !text.includes(root) && !/"path"/.test(text), text.slice(0, 200));
		// Its own saved file goes back up by id.
		host.serve = { body: Buffer.from("small"), name: "small.txt", mime: "text/plain" };
		const small = JSON.parse((await one.run({ action: "download", ref: "e9" })).text);
		assert.notEqual((await one.run({ action: "upload", ref: "e1", ids: [small.id] })).isError, true);
		assert.equal(Buffer.concat(host.uploads[0].chunks).toString(), "small");

		// Another remote session sees none of it and can't upload it.
		const two = await open({ name: "r2", session: "remote-t2-cccc", remote: true, allowedTools: toolsFor(["browser.files"]) });
		assert.deepEqual(JSON.parse((await two.run({ action: "list" })).text), { files: [] });
		const sent = host.requests.length;
		for (const args of [{ action: "upload", ref: "e1", ids: [small.id] }, { action: "read", id: small.id }, { action: "remove", id: small.id }]) assert.equal((await two.run(args)).isError, true, args.action);
		assert.equal(host.requests.length, sent);
		// Without browser.navigate that session can't download at all (a link's file is what opening the link fetches),
		// by ref, by selector or by address; its other actions still run.
		for (const args of [{ ref: "e9" }, { selector: "a" }, { url: "https://files.test/small" }]) {
			const r = await two.run({ action: "download", ...args });
			assert.equal(r.isError, true);
			assert.match(r.text, /^permission_denied: .*browser\.(navigate|script)/);
		}
		assert.equal(host.requests.length, sent);
		host.serve = { body: Buffer.from("%PDF-1.7 page"), name: "Page.pdf", mime: "application/pdf" };
		assert.notEqual((await two.run({ action: "save_pdf" })).isError, true);
		// With browser.script and browser.navigate an address may be named.
		const full = await open({ name: "r3", session: "remote-t3-dddd", remote: true, allowedTools: toolsFor([...DEFAULT_GRANT, "browser.files", "browser.script"]) });
		host.serve = { body: Buffer.from("named"), name: "named.txt", mime: "text/plain" };
		assert.notEqual((await full.run({ action: "download", url: "https://files.test/named" })).isError, true);
		// The session's files go when it ends, and only its own.
		assert.equal(existsSync(join(fx.config, "files", "remote-t3-dddd", "named.txt")), true);
		assert.notEqual((await full.client.callTool({ name: "session_end", arguments: {} })).isError, true);
		assert.equal(existsSync(join(fx.config, "files", "remote-t3-dddd")), false, "session_end removes the session's saved files");
		assert.equal(existsSync(join(fx.config, "files", "remote-t1-bbbb", "small.txt")), true);
		const before = host.requests.length;
		// A scoped session that is not marked remote is treated the same way.
		const scoped = await open({ name: "s", session: "scoped-files", allowedTools: new Set(["files"]) });
		assert.equal((await scoped.run({ action: "upload", ref: "e1", paths: [join(fx.proj, "report.txt")] })).isError, true);
		assert.equal(host.requests.length, before);
		// A disk error reaches a remote caller without the folder it happened in.
		rmSync(join(fx.config, "files", "remote-t1-bbbb"), { recursive: true });
		symlinkSync(fx.proj, join(fx.config, "files", "remote-t1-bbbb"));
		host.serve = { body: Buffer.from("x"), name: "x.txt", mime: "text/plain" };
		const broken = await one.run({ action: "download", ref: "e9" });
		assert.equal(broken.isError, true);
		assert.ok(!broken.text.includes(fx.config) && !broken.text.includes(root) && !/[\\/]files[\\/]/.test(broken.text), broken.text);
		assert.match(broken.text, /could not be kept on the computer/);
	} finally {
		for (const c of clients) await c.close().catch(() => {});
		host.close();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});
