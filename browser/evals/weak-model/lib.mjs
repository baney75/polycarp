// The runner's checkable parts, kept apart from run.mjs so test/weak-model-harness.test.mjs can hold each one.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
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

/** A Polycarp session name under 64 characters that keeps the task and trial whole, so trials never share a session. */
export function sessionName(label, taskId, trial) {
	const tag = createHash("sha256").update(label).digest("hex").slice(0, 8);
	return `wm-${tag}-${taskId}-${trial}`
		.replace(/[^a-z0-9_-]/gi, "-")
		.toLowerCase()
		.slice(-64);
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

/** Pids of app copies this run started: the helper's computer_open answers that started a copy (reused false). */
export function ownPids(calls) {
	const pids = new Set();
	for (const c of calls) {
		if (c.tool !== "computer_open" || c.error !== false) continue;
		try {
			const d = JSON.parse(c.result).data;
			if (d?.reused === false && Number.isInteger(d.pid)) pids.add(d.pid);
		} catch {}
	}
	return pids;
}

/**
 * Puts the apps' preferences back: imports each backup, and deletes a domain that did not exist before the run, so
 * prefs an agent copy wrote are not left behind. A domain whose export failed for another reason is left alone.
 */
export function restorePrefs(backup, exec) {
	for (const { domain, file, absent } of backup) {
		try {
			if (file) exec("defaults", ["import", domain, file]);
			else if (absent) exec("defaults", ["delete", domain]);
		} catch (err) {
			if (!absent) console.error(`could not restore ${domain}: ${err.message}; backup kept at ${file}`);
		}
	}
}

/** What a stopped run (Ctrl-C) still undoes on the way out: its own app copies and its fixture folder. */
export function stopCleanup(pids, dir) {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
	rmSync(dir, { recursive: true, force: true });
}
