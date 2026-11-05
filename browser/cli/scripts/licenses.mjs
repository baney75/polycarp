// Writes the licence texts of everything compiled into the helper: the production packages in package-lock.json (read from
// node_modules, so run `npm ci` first) and the Bun runtime the executable is made from (the file passed as --bun, from Bun's
// repository). Output is one text file for the app's licenses folder.
//   node scripts/licenses.mjs --out <file> [--bun <Bun LICENSE.md>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const out = arg("--out");
if (!out) {
	console.error("usage: node scripts/licenses.mjs --out <file> [--bun <file>]");
	process.exit(2);
}
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const parts = [
	"Polycarp's browser helper (polycarp-browser) is Tabkyra (AGPL-3.0, browser/LICENSE in the source) compiled with the packages and the runtime below.",
	"",
];
const rows = Object.entries(lock.packages).filter(([path, info]) => path.startsWith("node_modules/") && !info.dev && !info.optional && !info.peer);
rows.sort(([a], [b]) => a.localeCompare(b));
let count = 0;
for (const [path, info] of rows) {
	const dir = join(root, path);
	if (!existsSync(dir)) continue;
	const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\..*)?$/i.test(f));
	const name = path.replace(/^.*node_modules\//, "");
	parts.push("=".repeat(72), `${name} ${info.version} (${info.license ?? "license not declared in the lock"})`, "=".repeat(72));
	parts.push(file ? readFileSync(join(dir, file), "utf8").trim() : `(no licence file shipped with ${name}; declared ${info.license ?? "unknown"})`, "");
	count++;
}
const bun = arg("--bun");
if (bun) {
	parts.push("=".repeat(72), "Bun runtime (embedded in the executable)", "=".repeat(72), readFileSync(bun, "utf8").trim(), "");
}
writeFileSync(out, `${parts.join("\n")}\n`);
console.log(`licenses: ${count} packages${bun ? " and the Bun runtime" : ""} -> ${out}`);
