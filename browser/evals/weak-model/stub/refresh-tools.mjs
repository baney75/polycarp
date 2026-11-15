// Rewrites hands-tools.json from the real helper's own answer: `polycarp-spaces mcp --connector`, initialize and
// tools/list only. Both are static in the helper (MCP.swift), so this reads no window and opens nothing.
//   node evals/weak-model/stub/refresh-tools.mjs [path to polycarp-spaces]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const helper = process.argv[2] ?? [join(homedir(), ".local", "bin", "polycarp-spaces"), "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces"].find(existsSync);
if (!helper) {
	console.error("no polycarp-spaces found; pass its path");
	process.exit(2);
}
const input = [
	{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
	{ jsonrpc: "2.0", id: 2, method: "tools/list" },
]
	.map((m) => JSON.stringify(m))
	.join("\n");
const out = execFileSync(helper, ["mcp", "--connector"], { input: `${input}\n`, timeout: 10_000, encoding: "utf8" });
const [init, list] = out.trim().split("\n").map((l) => JSON.parse(l));
const file = join(here, "hands-tools.json");
const old = JSON.parse(readFileSync(file, "utf8"));
writeFileSync(file, `${JSON.stringify({ note: old.note, instructions: init.result.instructions, tools: list.result.tools }, null, "\t")}\n`);
console.log(`${list.result.tools.length} tools written to ${file}`);
