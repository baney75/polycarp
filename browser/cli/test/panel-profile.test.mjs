// `polycarp mcp --profile panel`: the side panel's page tools over MCP, for the benchmarks. The tool list and the
// results are the panel's own (src/bridge/page-tools.ts); calls go to the bridge handlers by the panel's routes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadTs } from "./helpers/bundle-ts.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const { callPanelTool, panelProfileTools, PANEL_PROFILE_INSTRUCTIONS } = await loadTs(
	`export { callPanelTool, panelProfileTools, PANEL_PROFILE_INSTRUCTIONS } from "@src/panel-profile.ts";`,
);

/** A bridge client that records calls and answers from `results`, or throws an rpc error. */
function fakeClient(results = {}) {
	const calls = [];
	return {
		calls,
		async call(method, params) {
			calls.push({ method, params });
			const r = results[method];
			if (r instanceof Error) throw r;
			return r ?? {};
		},
	};
}

test("the profile lists navigate and the panel's page tools, with the panel's schemas", () => {
	const tools = panelProfileTools();
	assert.deepEqual(
		tools.map((t) => t.name),
		["navigate", "read_page", "find", "get_page_text", "act", "handle_dialog"],
	);
	const act = tools.find((t) => t.name === "act");
	assert.equal(act.inputSchema.type, "object");
	// A plain string enum, which every provider takes (Google rejects anyOf).
	assert.deepEqual(act.inputSchema.properties.action, { type: "string", enum: ["click", "type", "fill", "press", "hover", "scroll", "drag", "wait", "screenshot", "steps"] });
	assert.doesNotMatch(JSON.stringify(tools), /anyOf/);
	assert.match(PANEL_PROFILE_INSTRUCTIONS, /untrusted data/);
	assert.match(PANEL_PROFILE_INSTRUCTIONS, /Refs expire when the page changes/);
	assert.doesNotMatch(PANEL_PROFILE_INSTRUCTIONS, /repl/);
});

test("an act call goes to the bridge handler and comes back as the panel prints it", async () => {
	const client = fakeClient({ scroll: { scrollY: 900 } });
	const out = await callPanelTool(client, "act", { action: "scroll", edge: "bottom", tabId: 3 });
	assert.deepEqual(client.calls, [{ method: "scroll", params: { to: "bottom" } }]);
	assert.equal(out.isError, undefined);
	assert.equal(out.content[0].text, '{"scrollY":900}');
});

test("read_page prints refs to act on, and errors keep their code", async () => {
	const client = fakeClient({
		snapshot: {
			url: "https://a.test/",
			title: "A",
			viewport: { width: 1, height: 1, scrollY: 0, pageHeight: 1 },
			nodes: [{ ref: "e1", role: "link", name: "Home", visible: true }],
			text: "",
		},
	});
	const read = await callPanelTool(client, "read_page", {});
	assert.equal(client.calls[0].params.maxTextChars, 3000);
	assert.match(read.content[0].text, /use the ref with act/);
	const bad = await callPanelTool(client, "act", { action: "run_js" });
	assert.equal(bad.isError, true);
	assert.match(bad.content[0].text, /^bad_params: act needs action/);
	const unknown = await callPanelTool(client, "tabs_create", {});
	assert.equal(unknown.isError, true);
	assert.equal(client.calls.length, 1, "no bridge call for a refused tool");
});

test("polycarp mcp --profile panel serves that list over stdio", async () => {
	const home = mkdtempSync(join(tmpdir(), "polycarp-panel-profile-"));
	const client = new Client({ name: "panel-profile-test", version: "0.0.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [cli, "mcp", "--profile", "panel"],
				env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", TABKYRA_SOCKET_DIR: join(home, "sock") },
				stderr: "ignore",
			}),
		);
		const { tools } = await client.listTools();
		assert.deepEqual(
			tools.map((t) => t.name),
			["navigate", "read_page", "find", "get_page_text", "act", "handle_dialog"],
		);
		assert.match(client.getInstructions() ?? "", /act/);
	} finally {
		await client.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a --profile other than panel is a usage error, not the full server", () => {
	const home = mkdtempSync(join(tmpdir(), "polycarp-panel-profile-"));
	try {
		for (const args of [["--profile", "pannel"], ["--profile=full"], ["--profile"]]) {
			const run = spawnSync(process.execPath, [cli, "mcp", ...args], {
				env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", TABKYRA_SOCKET_DIR: join(home, "sock") },
				input: "",
				encoding: "utf8",
				timeout: 15000,
			});
			assert.notEqual(run.status, 0, `${args.join(" ")} exits with an error`);
			assert.match(`${run.stdout}${run.stderr}`, /--profile (takes panel|needs a value)/, args.join(" "));
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
