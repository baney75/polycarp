/**
 * Updating a git checkout that the browser loads unpacked (how Tabkyra is developed, and how
 * Donovan runs it): fetch, `git pull --ff-only` on main, `./scripts/setup-siblings.sh`, then
 * build the extension and the CLI next to the live builds and swap them in only when both
 * built. The builds they replace are kept for a one-click rollback.
 *
 *   <checkout>/dist-chrome, <checkout>/cli/dist     the live builds
 *   <checkout>/.tabkyra-update/next/                 a build in progress (removed on failure)
 *   <checkout>/.tabkyra-update/previous/             the builds before the last swap, for rollback
 *   <checkout>/.tabkyra-update/update.lock           one updater at a time
 *
 * Every command is fixed: nothing from the extension or the network reaches an argument.
 * docs/updates.md describes the flow.
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { InstallMode } from "../../src/bridge/protocol.ts";
import { asBuildInfo, type BuildInfo, describeBuild } from "../../src/update/build.ts";
import { EXTENSION_FILES, repoRoot } from "./paths.ts";
import { appDir, isManagedCopy, takeLock, UpdateError } from "./update.ts";

/** Commit subjects shown in "What's new". */
export const MAX_COMMITS = 20;
/** setup-siblings runs npm install in four packages; give it time. */
const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;

export const stateDir = (root: string) => join(root, ".tabkyra-update");
const nextDir = (root: string) => join(stateDir(root), "next");
const previousBuildDir = (root: string) => join(stateDir(root), "previous");

export function readBuildInfo(dir: string): BuildInfo | undefined {
	try {
		return asBuildInfo(JSON.parse(readFileSync(join(dir, "build-info.json"), "utf8")));
	} catch {
		return undefined;
	}
}

/** True for a Tabkyra source checkout (not a release folder, not an npm install). */
export function isCheckout(root: string): boolean {
	if (!existsSync(join(root, ".git")) || !existsSync(join(root, "scripts", "setup-siblings.sh"))) return false;
	try {
		return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }).name === "tabkyra";
	} catch {
		return false;
	}
}

/** How the CLI that runs is installed: a release in ~/.local/share/tabkyra/app, a checkout, or neither. */
export interface ModeInfo {
	mode: InstallMode;
	/** Where updates install: the release folder, the checkout, or the folder this CLI runs from. */
	root: string;
}

export function detectMode(root = repoRoot()): ModeInfo {
	if (isManagedCopy()) return { mode: "release", root: appDir() };
	let real = root;
	try {
		real = realpathSync(root);
	} catch {
		/* keep as is */
	}
	if (isCheckout(real)) return { mode: "checkout", root: real };
	return { mode: "unmanaged", root: real };
}

// ---- running fixed commands -------------------------------------------------------------

interface RunResult {
	code: number;
	stdout: string;
	/** The last lines of stdout and stderr, for an error message. */
	tail: string;
}

/**
 * The environment for git, npm and the build. The browser starts the native host with a bare
 * PATH, so the folder of the Node running this is put first (npm and npx live next to it), then
 * the usual install locations. Variables that redirect a build are dropped and set explicitly.
 */
export function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["TABKYRA_OUT_DIR", "TABKYRA_CLI_OUT_DIR", "TABKYRA_EXTENSION_DIR", "TABKYRA_NO_BUMP"]) delete env[key];
	const path = [dirname(process.execPath), ...(env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
	env.PATH = [...new Set(path.filter(Boolean))].join(delimiter);
	env.GIT_TERMINAL_PROMPT = "0";
	// Read-only git calls run next to the user's own git; don't take the index lock for them.
	env.GIT_OPTIONAL_LOCKS = "0";
	env.NO_COLOR = "1";
	return { ...env, ...extra };
}

function run(command: string, args: readonly string[], cwd: string, timeoutMs: number, env = toolEnv()): Promise<RunResult> {
	return new Promise((resolve) => {
		// Its own process group, so a timeout stops npm and everything it started, not just the shell.
		const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true });
		let stdout = "";
		let tail = "";
		const keep = (chunk: Buffer) => {
			tail = (tail + chunk.toString("utf8")).slice(-4000);
		};
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
			keep(d);
		});
		child.stderr.on("data", keep);
		const killGroup = (signal: NodeJS.Signals) => {
			try {
				if (child.pid) process.kill(-child.pid, signal);
			} catch {
				/* already gone */
			}
		};
		let settled = false;
		const timer = setTimeout(() => {
			tail += `\n(stopped after ${Math.round(timeoutMs / 60000)} minutes)`;
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), 5000).unref();
			// A grandchild holding the pipes open must not keep the update waiting.
			child.once("exit", () => {
				if (!settled) {
					settled = true;
					resolve({ code: 124, stdout, tail });
				}
			});
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			resolve({ code: 127, stdout, tail: `${tail}\n${err.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			resolve({ code: code ?? 1, stdout, tail });
		});
	});
}

const git = (root: string, args: readonly string[]) => run("git", ["-C", root, ...args], root, GIT_TIMEOUT_MS);

/** The last few non-empty lines of a command's output, for the side panel. */
function lastLines(text: string, n = 6): string {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-n)
		.join("\n");
}

async function gitOut(root: string, args: readonly string[]): Promise<string> {
	const r = await git(root, args);
	if (r.code !== 0) throw new UpdateError(`git ${args.join(" ")} failed: ${lastLines(r.tail, 3)}`);
	return r.stdout.trim();
}

// ---- inspecting -------------------------------------------------------------------------

export interface CheckoutInfo {
	root: string;
	head: string;
	/** Empty on a detached HEAD. */
	branch: string;
	/** Tracked files with local changes (`git status --porcelain`, untracked files ignored). */
	dirty: string[];
	/** refs/remotes/origin/main after the fetch, if there is one. */
	origin?: string;
	behind: number;
	ahead: number;
	/** The live extension build. */
	built?: BuildInfo;
	builtCli?: BuildInfo;
	/** Why an update would refuse, in words. */
	blocked?: string;
	fetchError?: string;
}

/** Read the checkout's state; `fetch` first runs `git fetch origin main`. */
export async function inspectCheckout(root: string, options: { fetch: boolean }): Promise<CheckoutInfo> {
	const head = await gitOut(root, ["rev-parse", "HEAD"]);
	const branchRun = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = branchRun.code === 0 ? branchRun.stdout.trim() : "";
	// Not trimmed: each line starts with a two-letter status, which may begin with a space.
	const status = await git(root, ["status", "--porcelain", "--untracked-files=no"]);
	if (status.code !== 0) throw new UpdateError(`git status failed: ${lastLines(status.tail, 3)}`);
	const dirty = status.stdout.split("\n").filter((l) => l.trim());
	let fetchError: string | undefined;
	if (options.fetch) {
		const f = await git(root, ["fetch", "--quiet", "origin", "main"]);
		if (f.code !== 0) fetchError = `git fetch origin main failed: ${lastLines(f.tail, 3)}`;
	}
	const originRun = await git(root, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]);
	const origin = originRun.code === 0 ? originRun.stdout.trim() : undefined;
	let behind = 0;
	let ahead = 0;
	if (origin) {
		behind = Number(await gitOut(root, ["rev-list", "--count", `HEAD..${origin}`]));
		ahead = Number(await gitOut(root, ["rev-list", "--count", `${origin}..HEAD`]));
	}
	const info: CheckoutInfo = {
		root,
		head,
		branch,
		dirty,
		origin,
		behind,
		ahead,
		built: readBuildInfo(join(root, "dist-chrome")),
		builtCli: readBuildInfo(join(root, "cli", "dist")),
		fetchError,
	};
	info.blocked = blockedReason(info);
	return info;
}

/** Why `git pull --ff-only` on main would be wrong or fail here, or undefined. */
export function blockedReason(info: Pick<CheckoutInfo, "root" | "branch" | "dirty" | "origin" | "behind" | "ahead">): string | undefined {
	if (info.branch !== "main") {
		return `The checkout at ${info.root} is on ${info.branch ? `branch ${info.branch}` : "a detached HEAD"}, not main. Switch it to main to update from here.`;
	}
	if (info.dirty.length > 0) return dirtyReason(info);
	if (!info.origin) return `The checkout at ${info.root} has no origin/main to update from.`;
	if (info.behind > 0 && info.ahead > 0) {
		return `main and origin/main have diverged (${info.ahead} local, ${info.behind} new on origin), so the pull would not be a fast-forward. Rebase or reset main yourself.`;
	}
	return undefined;
}

/** Tracked files with local changes, in words. */
function dirtyReason(info: Pick<CheckoutInfo, "root" | "dirty">): string {
	const files = info.dirty.slice(0, 3).map((l) => l.slice(3));
	const more = info.dirty.length > 3 ? ` and ${info.dirty.length - 3} more` : "";
	return `The checkout at ${info.root} has local changes (${files.join(", ")}${more}). Commit or remove them, then update.`;
}

/** The live build is not HEAD's (a failed build after a pull, or a rollback). */
export function needsBuild(info: Pick<CheckoutInfo, "head" | "built" | "builtCli">): boolean {
	return info.built?.commit !== info.head || info.builtCli?.commit !== info.head;
}

// ---- commits for "What's new" -----------------------------------------------------------

export interface CommitList {
	commits: Array<{ sha: string; subject: string }>;
	total: number;
	url?: string;
}

/** The https URL of a GitHub origin, or undefined (another host gets no compare link). */
function githubUrl(remote: string): string | undefined {
	const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
	return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

/**
 * The first-parent commits from `from` to `to`, newest first, capped. A GitHub merge commit
 * ("Merge pull request #24 from ...") is shown by its pull request title, the body's first line.
 */
export async function commitsBetween(root: string, from: string, to: string): Promise<CommitList> {
	const total = Number(await gitOut(root, ["rev-list", "--count", "--first-parent", `${from}..${to}`]));
	const raw = await gitOut(root, ["log", "--first-parent", `--max-count=${MAX_COMMITS}`, "--format=%H%x1f%s%x1f%b%x1e", `${from}..${to}`]);
	const commits = raw
		.split("\x1e")
		.map((r) => r.trim())
		.filter(Boolean)
		.map((r) => {
			const [sha, subject, body] = r.split("\x1f");
			const pr = /^Merge pull request (#\d+) from /.exec(subject);
			const title = body?.split("\n")[0]?.trim();
			return { sha: sha.slice(0, 12), subject: pr && title ? `${title} (${pr[1]})` : subject };
		});
	const remote = await git(root, ["remote", "get-url", "origin"]);
	const base = remote.code === 0 ? githubUrl(remote.stdout) : undefined;
	return { commits, total, url: base ? `${base}/compare/${from.slice(0, 12)}...${to.slice(0, 12)}` : undefined };
}

// ---- build, stage, activate, roll back ---------------------------------------------------

export type Phase = "checking" | "pulling" | "installing" | "building" | "skills";
export type Emit = (phase: Phase, message: string) => void;

/** Run scripts/setup-siblings.sh: pinned pi-mono and mini-lit, the patch, npm install. */
export async function setupSiblings(root: string, emit: Emit): Promise<void> {
	emit("installing", "Running scripts/setup-siblings.sh (pinned sibling repos and npm install)");
	const r = await run("bash", [join(root, "scripts", "setup-siblings.sh")], root, SETUP_TIMEOUT_MS);
	if (r.code !== 0) throw new UpdateError(`scripts/setup-siblings.sh failed. The old build is still in place.\n${lastLines(r.tail)}`);
}

/**
 * setup-siblings.sh runs npm install, which can rewrite a lock file; a checkout with local
 * changes can't update itself next time. Lock files are put back as committed; any other
 * change stops the update with what changed.
 */
async function keepTreeClean(root: string, emit: Emit, options: { locksOnly?: boolean } = {}): Promise<void> {
	const status = await git(root, ["status", "--porcelain", "--untracked-files=no"]);
	const changed = status.stdout.split("\n").filter((l) => l.trim()).map((l) => l.slice(3));
	if (changed.length === 0) return;
	const locks = changed.filter((f) => /(^|\/)package-lock\.json$/.test(f));
	const other = changed.filter((f) => !locks.includes(f));
	if (other.length && !options.locksOnly) throw new UpdateError(`scripts/setup-siblings.sh changed tracked files (${other.slice(0, 3).join(", ")}). The old build is still in place; commit or restore them.`);
	if (locks.length === 0) return;
	await gitOut(root, ["checkout", "--", ...locks]);
	emit("installing", `Restored ${locks.join(", ")} as committed (npm install had rewritten it)`);
}

/** What a staged build in next/ will install; written last, so its presence means next/ is whole. */
export interface Staged {
	head: string;
	from: string;
	to: string;
	commits?: CommitList;
}

const stagedFile = (root: string) => join(nextDir(root), "staged.json");

export function readStaged(root: string): Staged | undefined {
	try {
		return JSON.parse(readFileSync(stagedFile(root), "utf8")) as Staged;
	} catch {
		return undefined;
	}
}

/**
 * Build the extension and the CLI into .tabkyra-update/next. The live builds aren't touched;
 * a failure removes next/ and leaves them as they were.
 */
export async function buildNext(root: string, emit: Emit): Promise<void> {
	const next = nextDir(root);
	rmSync(next, { recursive: true, force: true });
	mkdirSync(next, { recursive: true });
	try {
		emit("building", "Building the extension");
		// TABKYRA_NO_BUMP: the build must not edit the manifest, or the checkout would have local changes.
		const ext = await run("npm", ["run", "build"], root, BUILD_TIMEOUT_MS, toolEnv({ TABKYRA_NO_BUMP: "1", TABKYRA_OUT_DIR: join(next, "dist-chrome") }));
		if (ext.code !== 0) throw new UpdateError(`The extension build failed. The old build is still in place.\n${lastLines(ext.tail)}`);
		const missing = EXTENSION_FILES.filter((f) => !existsSync(join(next, "dist-chrome", f)));
		if (missing.length) throw new UpdateError(`The extension build is missing ${missing.join(", ")}. The old build is still in place.`);
		emit("building", "Building the CLI");
		const cli = await run("npm", ["run", "build"], join(root, "cli"), BUILD_TIMEOUT_MS, toolEnv({ TABKYRA_CLI_OUT_DIR: join(next, "cli-dist") }));
		if (cli.code !== 0) throw new UpdateError(`The CLI build failed. The old build is still in place.\n${lastLines(cli.tail)}`);
		if (!existsSync(join(next, "cli-dist", "index.js"))) throw new UpdateError("The CLI build wrote no index.js. The old build is still in place.");
	} catch (err) {
		rmSync(next, { recursive: true, force: true });
		throw err;
	}
}

/**
 * Copy every file of `from` over `live`, each through a temp file and one rename (atomic), then
 * drop what `from` didn't have. `from` stays intact, so a crash can run it again. Used for
 * cli/dist: the launcher runs cli/dist/index.js, which is never missing at any point.
 */
function overlay(from: string, live: string): void {
	if (!existsSync(join(from, "index.js"))) throw new UpdateError(`${from} has no index.js; not installing it.`);
	mkdirSync(live, { recursive: true });
	const names = new Set(readdirSync(from));
	for (const name of names) {
		const src = join(from, name);
		const dest = join(live, name);
		if (lstatSync(src).isDirectory()) {
			rmSync(dest, { recursive: true, force: true });
			cpSync(src, dest, { recursive: true });
			continue;
		}
		const tmp = join(live, `.${name}.${process.pid}.tmp`);
		copyFileSync(src, tmp);
		renameSync(tmp, dest);
	}
	for (const name of readdirSync(live)) if (!names.has(name)) rmSync(join(live, name), { recursive: true, force: true });
}

/**
 * Activation and rollback write a journal first and keep every source whole until they commit,
 * so recoverBuilds can finish (or undo) either one from any point a crash stops it at:
 *
 *   activate  prepare: copy cli/dist to prev-new/cli-dist          (undo: drop prev-new)
 *             swap:    dist-chrome -> prev-new/, next/dist-chrome -> dist-chrome, overlay next/cli-dist
 *             commit:  prev-new -> previous, drop next
 *   rollback  prepare: copy cli/dist to prev-new/cli-dist          (undo: drop prev-new)
 *             swap:    dist-chrome -> prev-new/, previous/dist-chrome -> dist-chrome, overlay previous/cli-dist
 *             commit:  prev-new -> previous
 */
interface Journal {
	op: "activate" | "rollback";
	step: "prepare" | "swap" | "commit";
}

const journalFile = (root: string) => join(stateDir(root), "journal.json");
const prevNewDir = (root: string) => join(stateDir(root), "prev-new");

function writeJournal(root: string, journal: Journal): void {
	const tmp = `${journalFile(root)}.tmp`;
	writeFileSync(tmp, JSON.stringify(journal));
	renameSync(tmp, journalFile(root));
}

function readJournal(root: string): Journal | undefined {
	try {
		return JSON.parse(readFileSync(journalFile(root), "utf8")) as Journal;
	} catch {
		return undefined;
	}
}

let swapFailInjected = false;

/** The swap step of an activation or rollback; every move checks first, so it can run again. */
function swapStep(root: string, op: Journal["op"]): void {
	const source = op === "activate" ? nextDir(root) : previousBuildDir(root);
	const ext = join(root, "dist-chrome");
	const parked = join(prevNewDir(root), "dist-chrome");
	if (existsSync(join(source, "dist-chrome"))) {
		if (existsSync(ext) && !existsSync(parked)) renameSync(ext, parked);
		if (!existsSync(ext)) renameSync(join(source, "dist-chrome"), ext);
	}
	// Tests stop a swap here once, between the extension and the CLI (cli/test/checkout-update.test.mjs).
	if (process.env.TABKYRA_TEST_SWAP_FAIL === "after-extension" && !swapFailInjected) {
		swapFailInjected = true;
		throw new UpdateError("Stopped mid-swap (TABKYRA_TEST_SWAP_FAIL).");
	}
	overlay(join(source, "cli-dist"), join(root, "cli", "dist"));
}

/**
 * Journaled as its own step, and safe to run again from any point: prev-new replaces previous
 * only while prev-new exists, and dropping next/ and the journal can repeat.
 */
function commitStep(root: string, op: Journal["op"]): void {
	writeJournal(root, { op, step: "commit" });
	if (existsSync(prevNewDir(root))) {
		rmSync(previousBuildDir(root), { recursive: true, force: true });
		renameSync(prevNewDir(root), previousBuildDir(root));
	}
	if (op === "activate") rmSync(nextDir(root), { recursive: true, force: true });
	rmSync(journalFile(root), { force: true });
}

function runJournaled(root: string, op: Journal["op"]): void {
	const source = op === "activate" ? nextDir(root) : previousBuildDir(root);
	for (const need of [join(source, "dist-chrome", "manifest.json"), join(source, "cli-dist", "index.js")]) {
		if (!existsSync(need)) throw new UpdateError(`${need} is missing; nothing was changed.`);
	}
	writeJournal(root, { op, step: "prepare" });
	rmSync(prevNewDir(root), { recursive: true, force: true });
	mkdirSync(prevNewDir(root), { recursive: true });
	cpSync(join(root, "cli", "dist"), join(prevNewDir(root), "cli-dist"), { recursive: true });
	writeJournal(root, { op, step: "swap" });
	swapStep(root, op);
	commitStep(root, op);
}

/** Put the staged build live and keep what it replaces in previous/. Runs under the lock. */
export function swapInBuilds(root: string): void {
	runJournaled(root, "activate");
}

/**
 * Finish or undo what a crash interrupted (see Journal), and drop a next/ without staged.json
 * (a build that never finished). Runs under the lock; the native host also runs it at start.
 */
export function recoverBuilds(root: string): string | undefined {
	const notes: string[] = [];
	const journal = readJournal(root);
	if (journal?.step === "prepare") {
		rmSync(prevNewDir(root), { recursive: true, force: true });
		rmSync(journalFile(root), { force: true });
		notes.push(`An interrupted ${journal.op} was undone before it changed anything.`);
	} else if (journal?.step === "swap") {
		swapStep(root, journal.op);
		commitStep(root, journal.op);
		notes.push(`An interrupted ${journal.op === "activate" ? "install" : "rollback"} was finished.`);
	} else if (journal?.step === "commit") {
		// The sources may already be gone: only the commit is left to finish.
		commitStep(root, journal.op);
		notes.push(`An interrupted ${journal.op === "activate" ? "install" : "rollback"} was finished.`);
	} else rmSync(prevNewDir(root), { recursive: true, force: true });
	if (existsSync(nextDir(root)) && !existsSync(stagedFile(root))) rmSync(nextDir(root), { recursive: true, force: true });
	return notes.length ? notes.join(" ") : undefined;
}

export function canRollBack(root: string): boolean {
	return existsSync(join(previousBuildDir(root), "dist-chrome", "manifest.json")) && existsSync(join(previousBuildDir(root), "cli-dist", "index.js"));
}

export function previousBuild(root: string): BuildInfo | undefined {
	return readBuildInfo(join(previousBuildDir(root), "dist-chrome"));
}

/** Swap the live builds with the kept ones (run it again to undo). Runs under the lock. */
export function swapBuilds(root: string): { from?: BuildInfo; to?: BuildInfo } {
	if (!canRollBack(root)) throw new UpdateError(`No previous build to roll back to (${previousBuildDir(root)} is missing or incomplete).`);
	const from = readBuildInfo(join(root, "dist-chrome"));
	const to = previousBuild(root);
	runJournaled(root, "rollback");
	return { from, to };
}

export function lockCheckout(root: string): () => void {
	mkdirSync(stateDir(root), { recursive: true });
	return takeLock(stateDir(root));
}

/** For the native host at start: repair an interrupted swap unless an updater holds the lock. */
export function recoverCheckoutQuietly(root: string): string | undefined {
	// A checkout the updater never touched has nothing to repair; don't create its folder.
	if (!existsSync(stateDir(root))) return undefined;
	let release: (() => void) | undefined;
	try {
		release = lockCheckout(root);
		return recoverBuilds(root);
	} catch {
		return undefined;
	} finally {
		release?.();
	}
}

// ---- the whole update -------------------------------------------------------------------

export interface CheckoutResult {
	/** False when there was nothing to do. */
	changed: boolean;
	message: string;
	staged?: Staged;
}

/**
 * Fetch, fast-forward main, set up the siblings and build into next/. Nothing live changes:
 * activateCheckout swaps the build in once no agent runs. `pull: false` rebuilds the current
 * HEAD (the version-mismatch fix). Throws UpdateError with the reason; when the pull worked and
 * the build didn't, the live build stays at the old commit and the side panel reports a
 * pending build.
 */
export async function updateCheckout(root: string, emit: Emit, options: { pull: boolean }): Promise<CheckoutResult> {
	const release = lockCheckout(root);
	try {
		const note = recoverBuilds(root);
		if (note) emit("checking", note);
		emit("checking", options.pull ? `Fetching origin/main for ${root}` : `Checking ${root}`);
		const info = await inspectCheckout(root, { fetch: options.pull });
		if (info.fetchError) throw new UpdateError(info.fetchError);
		// Pulling needs main and a fast-forward. Rebuilding HEAD (the mismatch fix) only needs no
		// local changes, so the build matches the commit it says it is from.
		if (options.pull && info.blocked) throw new UpdateError(info.blocked);
		if (!options.pull && info.dirty.length) throw new UpdateError(dirtyReason(info));
		if (options.pull && info.behind > 0) {
			emit("pulling", `Pulling ${info.behind} new commit${info.behind === 1 ? "" : "s"} (git pull --ff-only)`);
			const pull = await git(root, ["pull", "--ff-only", "--quiet", "origin", "main"]);
			if (pull.code !== 0) {
				const notFf = /fast-forward|diverg/i.test(pull.tail);
				throw new UpdateError(`${notFf ? "The pull is not a fast-forward" : "git pull failed"}; nothing was changed.\n${lastLines(pull.tail, 4)}`);
			}
		} else if (options.pull && !needsBuild(info)) {
			rmSync(nextDir(root), { recursive: true, force: true });
			return { changed: false, message: `Up to date (${describeBuild(info.built)})` };
		}
		const head = await gitOut(root, ["rev-parse", "HEAD"]);
		try {
			await setupSiblings(root, emit);
		} finally {
			// Lock files npm install rewrote go back even when setup failed, or the next update is refused.
			await keepTreeClean(root, emit, { locksOnly: true });
		}
		await keepTreeClean(root, emit);
		await buildNext(root, emit);
		// What's new lists everything since the live build, when that build's commit is an ancestor.
		const builtCommit = info.built?.commit;
		const since = builtCommit && builtCommit !== head && (await git(root, ["merge-base", "--is-ancestor", builtCommit, head])).code === 0 ? builtCommit : info.head;
		const staged: Staged = {
			head,
			from: describeBuild(info.built),
			to: describeBuild(readBuildInfo(join(nextDir(root), "dist-chrome"))),
			commits: since !== head ? await commitsBetween(root, since, head) : undefined,
		};
		writeFileSync(stagedFile(root), `${JSON.stringify(staged, null, 2)}\n`);
		return { changed: true, staged, message: `Built ${staged.to}` };
	} finally {
		release();
	}
}

/**
 * Swap a staged build in. Refuses when nothing is staged, or when HEAD moved since the build
 * (the staged build is then removed; Update now builds again). `beforeSwap` runs right before
 * the swap (noting which skills are unedited).
 */
export function activateCheckout(root: string, beforeSwap?: () => void): Staged | undefined {
	const release = lockCheckout(root);
	try {
		recoverBuilds(root);
		const staged = readStaged(root);
		if (!staged) return undefined;
		const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", env: toolEnv() }).stdout.trim();
		if (head !== staged.head) {
			rmSync(nextDir(root), { recursive: true, force: true });
			throw new UpdateError(`The checkout moved to ${head.slice(0, 7)} after the build of ${staged.head.slice(0, 7)}; nothing was installed. Update now builds it again.`);
		}
		beforeSwap?.();
		swapInBuilds(root);
		return staged;
	} finally {
		release();
	}
}

/** Roll the live builds back to the kept ones (the git checkout stays where it is). A staged build is dropped. */
export function rollbackCheckout(root: string): { from?: BuildInfo; to?: BuildInfo } {
	const release = lockCheckout(root);
	try {
		recoverBuilds(root);
		rmSync(nextDir(root), { recursive: true, force: true });
		return swapBuilds(root);
	} finally {
		release();
	}
}
