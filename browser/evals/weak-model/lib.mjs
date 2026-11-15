// The runner's checkable parts, kept apart from run.mjs so test/weak-model-harness.test.mjs can hold each one.
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Variables that make `claude -p` bill an API key or another provider instead of the owner's sign-in. */
export const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY"];

/** The key variables set (non-empty) in an environment: the runner refuses to start while any is. */
export const keyVarsSet = (env) => KEY_VARS.filter((k) => env[k]);

/** The environment `claude -p` gets: the parent's, with every key variable removed. */
export function childEnv(env) {
	const out = { ...env };
	for (const k of KEY_VARS) delete out[k];
	return out;
}

/**
 * Every task in the task folder: each `*.mjs` file exports arrays of tasks ({ id, kind: "browser"|"computer"|"stub", prompt,
 * ... }). Returns [] when the folder is missing or holds none.
 */
export async function loadTasks(dir) {
	if (!existsSync(dir)) return [];
	const tasks = [];
	for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs")).sort()) {
		const mod = await import(pathToFileURL(join(dir, f)).href);
		for (const v of Object.values(mod)) if (Array.isArray(v)) tasks.push(...v.filter((t) => t && typeof t.id === "string" && typeof t.kind === "string"));
	}
	return tasks;
}

/** The one sanitizer for labels and task ids in names and URL paths: lower case, letters, digits, `_` and `-`. */
export const safeId = (s) => String(s).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();

/** The harness mount for a run: a URL path segment, so the page's POST and the scorer's lookup name the same path. */
export const mountId = (label, taskId, trial) => `${safeId(taskId)}-${safeId(label)}-${trial}`;

/**
 * A Polycarp session name of at most 64 characters: `wm-<task>-<trial>-<hash of label and task>`. A long task id is cut
 * from its start, so the trial and the hash always survive and no two runs share a session.
 */
export function sessionName(label, taskId, trial) {
	const tag = createHash("sha256").update(`${label}\0${taskId}`).digest("hex").slice(0, 8);
	return `wm-${safeId(taskId)}-${trial}-${tag}`.slice(-64);
}

/** A whole number above zero from a --name value, or a ClearError-ready message. */
export function positiveInt(name, value) {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? { n } : { error: `--${name} takes a whole number above 0, not ${JSON.stringify(value)}` };
}

/**
 * The page's last posted state once it has gone quiet: the harness keeps a new object per POST, so the state is final
 * when the same object has stood for `quietMs`, or at `deadlineMs`. A POST up to `quietMs` late (a loaded Mac) still counts.
 */
export async function settledState(read, { quietMs = 1500, deadlineMs = 8000, stepMs = 100 } = {}) {
	const start = Date.now();
	let last = read();
	let since = Date.now();
	while (Date.now() - start < deadlineMs) {
		await new Promise((r) => setTimeout(r, stepMs));
		const now = read();
		if (now !== last) {
			last = now;
			since = Date.now();
		} else if (Date.now() - since >= quietMs) break;
	}
	return last;
}


/** The sign-in's usage and billing limits, as claude -p reports them. */
export const QUOTA = /usage limit|rate limit|quota|billing|upgrade your plan|out of credits|credit balance|limit reached/i;

/**
 * The helper a run's MCP server may start for the computer tools: the connector wrapper for a computer task while
 * computer runs are on, and for everything else a path that doesn't exist, so a browser run never lists them.
 */
/** The helper a run's server is given: the Mac's for a computer run the lead allowed, the stub's for a stub run, else none. */
export const spacesBin = (kind, { allowComputer, wrapper, stub, none }) => (kind === "computer" && allowComputer && wrapper ? wrapper : kind === "stub" && stub ? stub : none);

/**
 * Scores a finished run and says whether it is a result. Undefined when a stop began before or during scoring (the
 * read-back may have failed on a closed helper line), or when the run hit the sign-in's usage limit (`onLimit` is
 * told): such a run measured the stop, not the model, and must not replace a committed run.
 */
export async function keepScored(run, score, { closing, onLimit, quota = QUOTA }) {
	if (closing()) return undefined;
	if (run.apiError && quota.test(run.apiError)) {
		onLimit(run.apiError);
		return undefined;
	}
	const s = await score();
	return closing() ? undefined : s;
}

/** Task ids that share a safeId share a page path and would score each other's state: the first such pair. */
export function clashingIds(ids) {
	const seen = new Map();
	for (const id of ids) {
		const k = safeId(id);
		if (seen.has(k)) return [seen.get(k), id, k];
		seen.set(k, id);
	}
	return undefined;
}


/**
 * A guarded round's per-task floors, counted from its transcripts: each task's pass and run count in summary.json must be
 * what runs.jsonl holds, and the pass count must reach the floor. Returns what is wrong, empty when nothing is.
 */
export function checkGuard(label, floors, summary, runs) {
	const wrong = [];
	for (const [id, want] of Object.entries(floors)) {
		const said = summary.tasks?.[id];
		const of = runs.filter((r) => r.task === id);
		const pass = of.filter((r) => r.pass === true).length;
		if (!said) wrong.push(`${label} has no ${id} runs in summary.json`);
		else if (said.pass !== pass || said.of !== of.length) wrong.push(`${label} ${id}: summary.json says ${said.pass}/${said.of}, runs.jsonl holds ${pass}/${of.length}`);
		if (pass < want) wrong.push(`${label} ${id}: ${pass}/${of.length} in runs.jsonl, baseline ${want}`);
	}
	return wrong;
}

/**
 * Why a committed round no longer matches its baseline entry, or nothing. Like is compared with like: the runs must be
 * the round's model, list the round's tool count for their kind, and cover exactly the round's task set; then the
 * total is fixed, and the score may only rise. A rerun with another model, another tool list or more tasks belongs
 * under a new label.
 */
export function checkRound(label, want, s, runs) {
	const p = [];
	const tasks = new Set(runs.map((r) => r.task));
	const extra = [...tasks].filter((t) => !want.tasks.includes(t));
	const short = want.tasks.filter((t) => !tasks.has(t));
	if (extra.length || short.length) p.push(`${label}: task set differs: ${[extra.length && `${extra.join(", ")} not in the round`, short.length && `${short.join(", ")} short`].filter(Boolean).join("; ")}`);
	for (const r of runs) {
		if (r.model !== want.model) p.push(`${label}: ${r.task} t${r.trial} ran ${r.model}, the round is ${want.model}`);
		if (r.toolCount !== want.tools[r.kind]) p.push(`${label}: ${r.task} t${r.trial} listed ${r.toolCount} tools, the round's ${r.kind} runs listed ${want.tools[r.kind]}`);
	}
	if (want.profile && s.profile !== want.profile) p.push(`${label}: profile ${s.profile}, the round is ${want.profile}`);
	if (s.total !== want.total) p.push(`${label}: ${s.total} runs, baseline has ${want.total}`);
	if (s.passed < want.passed) p.push(`${label}: ${s.passed}/${s.total} passed, baseline ${want.passed}`);
	if (runs.length !== s.total) p.push(`${label}: runs.jsonl has ${runs.length} runs`);
	if (runs.filter((r) => r.pass).length !== s.passed) p.push(`${label}: summary.json disagrees with its runs`);
	return p;
}

/**
 * Why a round's classes.json disagrees with its runs, or nothing. Each friction entry's `match` names the calls it
 * counts in passing runs ({ tools, kind?, tasks?, error = true, text? }); each listed failure must be a failed run.
 */
export function checkClasses(classes, runs) {
	const p = [];
	for (const e of classes.friction_in_passing_runs ?? []) {
		if (!e.match) {
			p.push(`${e.class}: no match, so its count can't be checked`);
			continue;
		}
		const m = e.match;
		const n = runs
			.filter((r) => r.pass && (!m.kind || r.kind === m.kind) && (!m.tasks || m.tasks.includes(r.task)))
			.flatMap((r) => r.calls)
			.filter((c) => m.tools.includes(c.tool) && (m.error === false ? true : c.error === true) && (!m.text || (c.result ?? "").includes(m.text))).length;
		if (n !== e.count) p.push(`${e.class} says ${e.count}, runs.jsonl has ${n} (${e.detail ?? m.tools.join(",")})`);
	}
	for (const f of classes.failures ?? []) {
		const [task, t] = f.run.split(" t");
		const r = runs.find((x) => x.task === task && x.trial === Number(t));
		if (!r) p.push(`${f.run} is listed as a failure but has no run`);
		else if (r.pass) p.push(`${f.run} is listed as a failure but passed`);
	}
	return p;
}
