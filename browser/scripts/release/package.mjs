#!/usr/bin/env node
// Package a built checkout as a release: tabkyra-<version>.zip and SHA256SUMS.
//   node scripts/release/package.mjs --version 1.2.0 --out release/
// Needs `npm run build` (dist-chrome) and `cd cli && npm run build` first. The release
// workflow signs SHA256SUMS afterwards; docs/updates.md describes the whole flow.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name) {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : undefined;
}

const version = (arg("--version") ?? "").replace(/^v/, "");
const out = arg("--out");
const root = arg("--root") ?? repo;
const m = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(version);
if (!m || !out) {
	console.error("Usage: package.mjs --version <x.y.z[-pre]> --out <dir> [--root <checkout>]");
	process.exit(2);
}

const dist = join(root, "dist-chrome");
const cli = join(root, "cli", "dist", "index.js");
for (const need of [join(dist, "manifest.json"), join(dist, "sidepanel.js"), cli]) {
	if (!existsSync(need)) {
		console.error(`Missing ${relative(root, need)}: build the extension and the CLI first.`);
		process.exit(1);
	}
}
const manifestVersion = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")).version;
if (manifestVersion !== m[1]) {
	console.error(`dist-chrome is ${manifestVersion}, but the release is ${version} (expected manifest ${m[1]}).`);
	process.exit(1);
}

function* walk(dir) {
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}

const files = [];
for (const path of walk(dist)) {
	if (path.endsWith(".map")) continue;
	files.push({ name: `dist-chrome/${relative(dist, path).split("\\").join("/")}`, data: readFileSync(path) });
}
files.push({ name: "cli/dist/index.js", data: readFileSync(cli) });
// What the CLI was built from; the native host compares it with the extension's (docs/updates.md).
const cliInfo = join(root, "cli", "dist", "build-info.json");
if (existsSync(cliInfo)) files.push({ name: "cli/dist/build-info.json", data: readFileSync(cliInfo) });
files.push({ name: "cli/package.json", data: readFileSync(join(root, "cli", "package.json")) });
let commit = "unknown";
try {
	commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
	/* not a checkout */
}
files.push({ name: "release.json", data: Buffer.from(`${JSON.stringify({ version, commit }, null, 2)}\n`) });

mkdirSync(out, { recursive: true });
const zipName = `tabkyra-${version}.zip`;
const zip = createZip(files);
writeFileSync(join(out, zipName), zip);
const sum = createHash("sha256").update(zip).digest("hex");
writeFileSync(join(out, "SHA256SUMS"), `${sum}  ${zipName}\n`);
console.log(`${zipName}  ${files.length} files  ${zip.length} bytes  sha256 ${sum}`);
