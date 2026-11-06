// Compiles the CLI into one executable with no Node needed on the machine: the esbuild bundle (build.mjs, in
// compiled mode) goes through `bun build --compile --bytecode`. Bun beat Node's single-executable applications
// on cold start, size and cross-building (spaces/spec/browser-binary.md has the measurements).
//   node scripts/compile.mjs --arch arm64|x64 --out <file> [--work <dir>]
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const arch = arg("--arch", process.arch === "arm64" ? "arm64" : "x64");
const out = arg("--out");
if (!["arm64", "x64"].includes(arch) || !out) {
	console.error("usage: node scripts/compile.mjs --arch arm64|x64 --out <file>");
	process.exit(2);
}
const work = arg("--work") ?? mkdtempSync(join(tmpdir(), "tabkyra-compile-"));
const run = (cmd, args, env = {}) => {
	const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
	if (r.status !== 0) {
		console.error(`compile: ${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
		process.exit(1);
	}
};
run(process.execPath, ["scripts/build.mjs"], { TABKYRA_CLI_COMPILED: "1", TABKYRA_CLI_OUT_DIR: work });
// This machine's system: the Mac app's build, and a real executable to run wherever the tests run.
const os = process.platform === "win32" ? "windows" : process.platform;
run("bun", ["build", "--compile", "--bytecode", `--target=bun-${os}-${arch === "x64" ? "x64-baseline" : arch}`, join(work, "index.js"), "--outfile", out]);
// The x86_64 build is the baseline one: it runs on every Intel Mac and under Rosetta (which has no AVX).
chmodSync(out, 0o755);
if (!arg("--work")) rmSync(work, { recursive: true, force: true });
