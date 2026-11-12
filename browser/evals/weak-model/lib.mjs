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
