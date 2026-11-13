// The weak-model eval's stub computer through the real server: `polycarp mcp` with POLYCARP_SPACES_BIN set to a stub
// run's wrapper lists the computer_* tools a stub run's model sees, and its calls reach the stub (evals/weak-model/stub).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const stubBin = join(here, "..", "..", "evals", "weak-model", "stub", "hands.mjs");
const root = mkdtempSync(join(tmpdir(), "polycarp-wm-stub-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("through `polycarp mcp`, a stub run's model sees the computer tools and its calls reach the stub", async () => {
	const cli = join(here, "..", "dist", "index.js");
	const dir = join(root, "cli-run");
	mkdirSync(dir, { recursive: true });
	const state = join(root, "cli-run.world.json");
	const bin = join(root, "cli-run.hands.sh");
	writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${stubBin}' --state '${state}' --handoff '${dir}' "$@"\n`);
	chmodSync(bin, 0o755);
	const home = join(root, "cli-home");
	mkdirSync(home, { recursive: true });
	const sock = mkdtempSync("/tmp/wmst-");
	const client = new Client({ name: "stub-test", version: "0" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", "--session", "stub-test"],
			env: { PATH: process.env.PATH, HOME: home, TABKYRA_SOCKET_DIR: sock, TABKYRA_NO_UPDATE_CHECK: "1", POLYCARP_SPACES_BIN: bin },
		}),
	);
	try {
		let names = [];
		for (let i = 0; i < 40 && !names.includes("computer_open"); i++) {
			names = (await client.listTools()).tools.map((t) => t.name);
			if (!names.includes("computer_open")) await new Promise((r) => setTimeout(r, 100));
		}
		for (const n of ["computer_open", "computer_windows", "computer_snapshot", "computer_click", "computer_toggle", "computer_select"]) assert.ok(names.includes(n), `${n} listed`);
		const opened = await client.callTool({ name: "computer_open", arguments: { app: "Thermo" } });
		assert.match(opened.content[0].text, /"window":61001/);
		const rows = await client.callTool({ name: "computer_snapshot", arguments: { window: 61001 } });
		assert.match(rows.content[0].text, /switch "Eco mode" =0/);
		assert.equal(JSON.parse(readFileSync(state, "utf8")).windows[0].app, "Thermo");
	} finally {
		await client.close();
		rmSync(sock, { recursive: true, force: true });
	}
});
