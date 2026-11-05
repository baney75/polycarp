// Cold start of the browser helper: `--version`, and `mcp` answering tools/list. Numbers live in spec/speed.json under "browser".
//   node scripts/browser-speed.mjs <helper> --write     measure and merge into spec/speed.json (other keys are kept)
//   node scripts/browser-speed.mjs <helper> --check     measure and fail (exit 1) if either is over 25% slower than recorded
// The helper runs with a temporary HOME and socket folder; it never sees the real ones.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOLERANCE = 0.25;
export const speedFile = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "speed.json");

/** The numbers worse than `recorded` by more than the tolerance, as readable lines. */
export function regressions(recorded, measured, tolerance = TOLERANCE) {
	const out = [];
	for (const key of ["versionMs", "toolsListMs"]) {
		if (typeof recorded?.[key] !== "number") continue;
		const limit = recorded[key] * (1 + tolerance);
		if (!(measured[key] <= limit)) out.push(`${key}: ${measured[key]} ms, recorded ${recorded[key]} ms (limit ${limit.toFixed(1)} ms)`);
	}
	return out;
}

function readRecorded() {
	try {
		return JSON.parse(readFileSync(speedFile, "utf8")).browser;
	} catch {
		return undefined;
	}
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export async function measure(helper, runs = 15) {
	const home = mkdtempSync(join(tmpdir(), "polycarp-speed-"));
	const env = { PATH: "/usr/bin:/bin", HOME: home, POLYCARP_CONFIG_DIR: join(home, "pc"), TABKYRA_SOCKET_DIR: join(home, "sock"), NO_COLOR: "1" };
	try {
		spawnSync(helper, ["--version"], { env }); // the first start after a build pays for the disk cache
		const version = [];
		for (let i = 0; i < runs; i++) {
			const t = performance.now();
			const r = spawnSync(helper, ["--version"], { env });
			if (r.status !== 0) throw new Error(`${helper} --version exited ${r.status}`);
			version.push(performance.now() - t);
		}
		const list = [];
		let tools = 0;
		for (let i = 0; i < runs; i++) {
			const t = performance.now();
			tools = await new Promise((resolve, reject) => {
				const p = spawn(helper, ["mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
				let buf = "";
				p.stdout.on("data", (d) => {
					buf += d;
					for (const line of buf.split("\n")) {
						try {
							const m = JSON.parse(line);
							if (m.id === 2) {
								p.kill();
								resolve(m.result.tools.length);
								return;
							}
						} catch {
							/* partial line */
						}
					}
				});
				p.on("error", reject);
				const send = (m) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
				send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "speed", version: "0" } } });
				send({ method: "notifications/initialized" });
				send({ id: 2, method: "tools/list" });
			});
			list.push(performance.now() - t);
		}
		return {
			versionMs: Math.round(median(version) * 10) / 10,
			toolsListMs: Math.round(median(list) * 10) / 10,
			tools,
			binaryMB: Math.round(statSync(helper).size / 1e5) / 10,
			runs,
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [, , helper, mode] = process.argv;
	if (!helper || !["--write", "--check"].includes(mode)) {
		console.error("usage: node scripts/browser-speed.mjs <helper> --write|--check");
		process.exit(2);
	}
	// A busy machine only makes numbers worse, so the best of three rounds is the fair one to record and to check.
	const rounds = [];
	for (let i = 0; i < 3; i++) {
		rounds.push(await measure(helper));
		if (mode === "--check" && regressions(readRecorded(), rounds[i]).length === 0) break;
	}
	const measured = rounds.reduce((a, b) => (b.versionMs + b.toolsListMs < a.versionMs + a.toolsListMs ? b : a));
	const all = (() => {
		try {
			return JSON.parse(readFileSync(speedFile, "utf8"));
		} catch {
			return {};
		}
	})();
	if (mode === "--write") {
		// Merge: only the "browser" key is ours; whatever else is in the file stays as it is.
		// A busy machine only makes numbers worse, so a rerun keeps the faster of the old and new value. To accept a slower helper
		// on purpose, edit the file by hand in the same change.
		const old = all.browser ?? {};
		for (const key of ["versionMs", "toolsListMs"]) if (typeof old[key] === "number") measured[key] = Math.min(old[key], measured[key]);
		all.browser = { ...measured, arch: process.arch, measuredWith: "scripts/browser-speed.mjs", toleranceOverRecorded: TOLERANCE };
		writeFileSync(speedFile, `${JSON.stringify(all, null, 2)}\n`);
		console.log(`recorded ${JSON.stringify(all.browser)}`);
	} else {
		const bad = regressions(all.browser, measured);
		console.log(`measured ${JSON.stringify(measured)}; recorded ${JSON.stringify(all.browser)}`);
		if (bad.length) {
			console.error(`browser helper is slower than recorded by over ${TOLERANCE * 100}%:\n  ${bad.join("\n  ")}`);
			process.exit(1);
		}
		console.log("speed ok");
	}
}
