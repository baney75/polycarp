// One place for everything a run must undo. Each resource registers its undo the moment it exists; cleanup runs the
// registry in reverse, exactly once, from every way out: a normal end, a thrown error, a signal, an uncaught error, or a
// claude -p that could not start. Held by test/weak-model-harness.test.mjs.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** An error whose message is the whole story: printed as one line, without a stack. */
export class ClearError extends Error {}

export class Cleanup {
	#undo = [];
	#run;
	#draining = false;
	#log;

	constructor({ log = console.error } = {}) {
		this.#log = log;
	}

	/** True once cleanup has begun: nothing new should start. */
	get closing() {
		return this.#run !== undefined;
	}

	/**
	 * Registers `fn` as the undo of a resource that now exists. Returns `undo()`, which runs it now (once) and forgets it,
	 * and `release()`, which forgets it without running it. Registered after cleanup began, it still runs.
	 */
	add(name, fn) {
		const entry = { name, fn, ran: false };
		const once = async () => {
			if (entry.ran) return;
			entry.ran = true;
			try {
				await entry.fn();
			} catch (err) {
				this.#log(`cleanup: ${entry.name}: ${err?.message ?? err}`);
			}
		};
		entry.once = once;
		const forget = () => {
			const i = this.#undo.indexOf(entry);
			if (i >= 0) this.#undo.splice(i, 1);
		};
		if (this.#run && !this.#draining) void once();
		else this.#undo.push(entry);
		return {
			undo: () => {
				forget();
				return once();
			},
			release: forget,
		};
	}

	/** Runs every registered undo in reverse order of registration, once; later calls get the same promise. */
	run() {
		this.#run ??= (async () => {
			this.#draining = true;
			while (this.#undo.length) await this.#undo.pop().once();
			this.#draining = false;
		})();
		return this.#run;
	}
}

const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/**
 * Wires every way out to one `leave(code, why)`: it prints why, runs cleanup once, then exits. A second signal while
 * cleanup runs changes nothing. Returns `leave` for the normal end and for errors the caller catches.
 */
export function onExits(cleanup, { proc = process, exit = (code) => proc.exit(code), log = console.error } = {}) {
	let leaving;
	const leave = (code, why) => {
		if (leaving) return leaving;
		if (why) log(why);
		leaving = cleanup.run().then(() => exit(code));
		return leaving;
	};
	const why = (err) => (err instanceof ClearError ? err.message : `error: ${err?.stack ?? err}`);
	for (const [sig, code] of Object.entries(EXIT_CODES)) proc.on(sig, () => leave(code, `stopped by ${sig}: cleaning up`));
	proc.on("uncaughtException", (err) => leave(1, why(err)));
	proc.on("unhandledRejection", (err) => leave(1, why(err)));
	return { leave, fail: (err) => leave(1, why(err)) };
}

/**
 * Starts `claude` in a process group of its own (it and the MCP server it starts), and registers killing the whole
 * group, so no claude outlives the run and keeps calling tools on the owner's sign-in. `closed` resolves on exit and
 * rejects with a ClearError when claude could not start (not on PATH).
 */
export function spawnClaude(args, { cleanup, cwd, env, spawnFn = spawn, kill = process.kill, graceMs = 3000, stepMs = 100 }) {
	const child = spawnFn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
	/** Sends `sig` to the group; false once the group is gone. */
	const signal = (sig) => {
		if (!child.pid) return false;
		try {
			kill(-child.pid, sig);
			return true;
		} catch {
			return false;
		}
	};
	// SIGTERM, then up to graceMs for the whole group (claude and the MCP server it started) to leave, then SIGKILL.
	// The same grace applies after claude exited on its own, so the MCP server left in the group can shut down cleanly.
	const killGroup = async () => {
		if (!signal("SIGTERM")) return;
		for (const end = Date.now() + graceMs; Date.now() < end; ) {
			await new Promise((r) => setTimeout(r, stepMs));
			if (!signal(0)) return;
		}
		signal("SIGKILL");
	};
	const entry = cleanup.add(`claude -p (pid ${child.pid ?? "none"})`, killGroup);
	const closed = new Promise((resolve, reject) => {
		child.once("error", (err) => {
			entry.release();
			reject(err?.code === "ENOENT" ? new ClearError("claude not found on PATH: install Claude Code or put it on PATH, then run again") : err);
		});
		// The group may hold the MCP server claude started: kill what is left of it once claude exits.
		child.once("close", (code) => void entry.undo().then(() => resolve(code)));
	});
	return { child, closed, killGroup: () => entry.undo() };
}

/**
 * The prefs backup's undo: restores each domain, and when one fails, copies every backup to `keepDir`, prints where,
 * and returns false so scratch (which holds the backups) is kept too.
 */
export function restorePrefsOrKeep(backup, { exec, keepDir, log = console.error }) {
	const failed = [];
	for (const { domain, file, absent } of backup) {
		try {
			if (file) exec("defaults", ["import", domain, file]);
			else if (absent) exec("defaults", ["delete", domain]);
		} catch (err) {
			if (file || !absent) failed.push(`${domain}: ${err?.message ?? err}`);
		}
	}
	if (!failed.length) return true;
	try {
		mkdirSync(keepDir, { recursive: true });
		for (const { file } of backup) if (file) cpSync(file, join(keepDir, basename(file)));
		log(`could not restore ${failed.join("; ")}. The backups are kept at ${keepDir}; import one with: defaults import <domain> <file>`);
	} catch (err) {
		const at = backup.find((b) => b.file)?.file;
		log(`could not restore ${failed.join("; ")}, and could not copy the backups to ${keepDir} (${err?.message ?? err}); they stay at ${at ? dirname(at) : "scratch"}, which is kept`);
	}
	return false;
}


/**
 * Backs up each app's preferences into `dir` before a computer run. A domain that doesn't exist yet is recorded as
 * absent (restore deletes it); a domain that exists but can't be exported stops the run, since it couldn't be restored.
 */
export function backupPrefs(domains, { exec, dir }) {
	const saved = [];
	for (const domain of domains) {
		const file = join(dir, `${domain}.plist`);
		try {
			exec("defaults", ["export", domain, file]);
			saved.push({ domain, file });
			continue;
		} catch {}
		let absent = false;
		try {
			exec("defaults", ["read", domain]);
		} catch (err) {
			absent = /does not exist/i.test(String(err?.stderr ?? err?.message));
		}
		if (!absent) throw new ClearError(`refusing to start computer tasks: could not back up ${domain} (it exists, but defaults export failed), so the run couldn't restore it`);
		saved.push({ domain, file: undefined, absent: true });
	}
	return saved;
}

/**
 * New agent-workspace windows of the task's app that no answer of this run reported. The helper knows which session
 * opened a window but doesn't say, so nothing here proves such a window is this run's: it may be another agent
 * session's or another job's, so it is never closed, only reported. With an open still pending (no answer yet, or
 * window_identified false), the windows are read again until `waitMs` has passed, since such a window attaches late.
 */
export async function leftOpen({ app, before, known, pending, list, waitMs = 5000, stepMs = 500, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
	const end = now() + (pending ? waitMs : 0);
	for (;;) {
		const found = (await list()).filter((w) => w.app === app && w.scope === "agent_workspace" && !before.has(w.pid) && !known.has(w.pid)).map((w) => ({ app: w.app, pid: w.pid, window: w.id }));
		if (found.length || now() >= end) return found;
		await sleep(stepMs);
	}
}

/**
 * The end of a computer run, in this order on every way it ended: score it, close the copies it reported, then look
 * for windows it left. Scoring first means a late window the model worked in still counts.
 */
export async function afterComputerRun({ score, undo, left }) {
	let s;
	try {
		s = await score();
	} finally {
		await undo();
	}
	return { score: s, left: await left() };
}
