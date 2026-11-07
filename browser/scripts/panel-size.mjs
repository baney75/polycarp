#!/usr/bin/env node
// What the side panel must load before it can show anything: sidepanel.js and every file it imports statically.
//   TABKYRA_META=1 TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=<dir> node scripts/build.mjs && node scripts/panel-size.mjs <dir> [--by-package]
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? join(here, "../dist-chrome"));
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));

const outputs = Object.entries(meta.outputs).filter(([name]) => name.endsWith(".js"));
const entry = outputs.find(([name]) => name.endsWith("/sidepanel.js"));
if (!entry) throw new Error("meta.json has no sidepanel.js");
const seen = new Map();
const walk = (name) => {
	if (seen.has(name)) return;
	const output = meta.outputs[name];
	seen.set(name, output);
	for (const imported of output.imports) if (imported.kind === "import-statement") walk(imported.path);
};
walk(entry[0]);
const bytes = [...seen.values()].reduce((sum, output) => sum + output.bytes, 0);
const result = { openBytes: bytes, openFiles: seen.size, allBytes: outputs.reduce((sum, [, o]) => sum + o.bytes, 0) };
console.log(JSON.stringify(result));
if (args.includes("--by-package")) {
	const groups = {};
	for (const output of seen.values()) {
		for (const [path, input] of Object.entries(output.inputs)) {
			const name = path.includes("node_modules/")
				? path.replace(/.*node_modules\/((?:@[^/]+\/)?[^/]+).*/, "$1")
				: path
						.replace(/.*pi-mono\/packages\/([^/]+)\/src\/([^/]+).*/, "pi-$1/$2")
						.replace(/^src\/([^/]+).*/, "src/$1");
			groups[name] = (groups[name] ?? 0) + input.bytesInOutput;
		}
	}
	for (const [name, size] of Object.entries(groups)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 40))
		console.log(String(Math.round(size / 1024)).padStart(6), "KB", name);
}
