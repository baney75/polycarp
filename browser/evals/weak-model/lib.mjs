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
 * Every task in the task folder: each `*.mjs` file exports arrays of tasks ({ id, kind: "browser"|"computer", prompt,
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
export const spacesBin = (kind, { allowComputer, wrapper, none }) => (kind === "computer" && allowComputer && wrapper ? wrapper : none);

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
