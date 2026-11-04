// Records the skill router beat for the hero video: real `tabkyra skill match` runs and the
// router's own speed measurement from `tabkyra skill eval`. Writes
// media/video/public/capture/router.json; every value the hero video shows for the router comes from it.
//
//   (cd cli && npm run build) && node scripts/demo/capture-router.mjs
//
// Runs in a throwaway HOME, so skills edited on this machine can't change the result.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repo, "cli", "dist", "index.js");
const target = join(repo, "media", "video", "public", "capture", "router.json");
if (!existsSync(cli)) throw new Error(`${cli} is missing. Run: cd cli && npm install && npm run build`);

// Each task and the skill it must route to ("none" for no skill).
const TASKS = [
	["Find peer-reviewed studies on spaced repetition and cite them", "academic-research"],
	["Run a background check on my new landlord", "osint"],
	["Don't use the osint skill, just search the news", "none"],
	["/rsi", "rsi"],
];

const home = mkdtempSync(join(tmpdir(), "tabkyra-router-"));
try {
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1" };
	const run = (args) => {
		const started = Date.now();
		const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
		// Only stdout is recorded or parsed; stderr (a Node warning, a notice) is kept apart.
		return { code: r.status, ms: Date.now() - started, out: r.stdout.trimEnd(), err: r.stderr.trim() };
	};
	const matches = TASKS.map(([task, expected]) => {
		const { err, ...r } = run(["skill", "match", task]);
		if (err) throw new Error(`"${task}": skill match wrote to stderr: ${err.slice(0, 400)}`);
		// `shown` is the command as it can be pasted into a shell: bare when it is one safe word,
		// else in double quotes (the tasks hold no $, `, ", \ or !, which double quotes would expand).
		if (/[$`"\\!]/.test(task)) throw new Error(`"${task}" needs other quoting to be shown safely`);
		const shown = `tabkyra skill match ${/^[\w@%+=:,./-]+$/.test(task) ? task : `"${task}"`}`;
		const top = /^·\s*none:/.test(r.out) ? "none" : r.out.split(/\s+/)[0];
		if (r.code !== 0 || top !== expected)
			throw new Error(`"${task}" routed to ${top}, expected ${expected}: ${r.out}`);
		return { task, expected, shown, ...r };
	});
	// One eval run: the stored numbers and the line the video shows both come from it.
	const evalRun = run(["skill", "eval", "--json"]);
	if (evalRun.code !== 0) throw new Error(`skill eval --json exited ${evalRun.code}: ${evalRun.err.slice(0, 400)}`);
	let report;
	try {
		report = JSON.parse(evalRun.out);
	} catch {
		throw new Error(
			`skill eval --json printed no JSON on stdout: ${evalRun.out.slice(0, 200)} ${evalRun.err.slice(0, 200)}`,
		);
	}
	if (!report.ok) throw new Error(`skill eval failed its gates: ${evalRun.out.slice(0, 400)}`);
	const { p50Ms, p95Ms, maxMs, buildMs, matches: timed } = report.speed;
	if (!(p95Ms < 1)) throw new Error(`p95 is ${p95Ms} ms; the video says under a millisecond at p95`);
	const data = {
		recordedAt: new Date().toISOString(),
		matches,
		eval: {
			skills: report.skills,
			cases: report.cases,
			top1: report.top1,
			speed: { p50Ms, p95Ms, maxMs, buildMs, matches: timed },
		},
	};
	const staging = `${target}.new`;
	writeFileSync(staging, `${JSON.stringify(data, null, "\t")}\n`);
	renameSync(staging, target);
	console.log(`wrote ${target}`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
