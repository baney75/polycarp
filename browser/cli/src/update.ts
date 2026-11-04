/**
 * `tabkyra update`: signed releases from GitHub, swapped in place, with one rollback.
 *
 *   ~/.local/share/tabkyra/app/        the installed release (dist-chrome/, cli/dist/index.js, release.json)
 *   ~/.local/share/tabkyra/previous/   the release before it, for `tabkyra update --rollback`
 *
 * A release has three assets: tabkyra-<version>.zip, SHA256SUMS and SHA256SUMS.minisig.
 * The signature over SHA256SUMS is checked against keys/tabkyra-release.pub (bundled into
 * the CLI at build time), its trusted comment must name the version, and the zip must
 * match its checksum. Any mismatch stops the update before a file is touched.
 * docs/updates.md describes the flow and the key handling.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallMode, LastUpdate, UpdatePhase } from "../../src/bridge/protocol.ts";
import type { UpdatePolicy } from "../../src/update/logic.ts";
import RELEASE_KEY from "../../keys/tabkyra-release.pub";
import { parsePublicKey, SignatureError, verifyMinisign } from "./minisign.ts";
import { EXTENSION_FILES, extensionDir, repoRoot } from "./paths.ts";
import { releaseSummary } from "./release-notes.ts";
import { banner, c, confirm, sym } from "./ui.ts";
import { VERSION } from "./version.ts";
import { extractZip } from "./zip.ts";

export const REPO = "baney75/tabkyra";
export type Channel = "stable" | "nightly";
/** `tabkyra update --check` exit code when a newer release exists (as `dnf check-update`). */
export const EXIT_UPDATE_AVAILABLE = 100;
/** How old the cached check may get before the native host checks again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_SUMS_BYTES = 64 * 1024;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

export class UpdateError extends Error {}

// ---- locations -------------------------------------------------------------

export function configDir(): string {
	return join(homedir(), ".config", "tabkyra");
}
export function installRoot(): string {
	return process.env.TABKYRA_HOME || join(homedir(), ".local", "share", "tabkyra");
}
export const appDir = () => join(installRoot(), "app");
export const previousDir = () => join(installRoot(), "previous");
/** A verified release unpacked and waiting for the side panel to activate it (update-run.ts). */
export const stagedDir = () => join(installRoot(), "staged");
const statusFile = () => join(configDir(), "update-status.json");
const settingsFile = () => join(configDir(), "update.json");
const lastUpdateFile = () => join(configDir(), "last-update.json");

/** GitHub's API, or a test server. */
function apiBase(): string {
	return (process.env.TABKYRA_UPDATE_API || "https://api.github.com").replace(/\/$/, "");
}

/** The bundled release key; TABKYRA_UPDATE_PUBKEY (a file) replaces it for tests and forks. */
function releaseKeyText(): string {
	const file = process.env.TABKYRA_UPDATE_PUBKEY;
	return file ? readFileSync(file, "utf8") : RELEASE_KEY;
}

// ---- settings and the cached check -----------------------------------------

export interface UpdateSettings {
	channel: Channel;
	/** The native host checks once a day and the side panel shows "Update available". */
	autoCheck: boolean;
	/**
	 * Settings > Updates: off (no checks), notify (check daily, tell the user; the default) or auto
	 * (the extension also installs when no agent has run for a few minutes). autoCheck is
	 * policy !== "off"; both are saved so older CLIs read the file the same way.
	 */
	policy: UpdatePolicy;
}

function readSavedSettings(): UpdateSettings {
	const settings: UpdateSettings = { channel: "stable", autoCheck: true, policy: "notify" };
	try {
		const raw = JSON.parse(readFileSync(settingsFile(), "utf8")) as Partial<UpdateSettings>;
		if (raw.channel === "stable" || raw.channel === "nightly") settings.channel = raw.channel;
		if (raw.policy === "off" || raw.policy === "notify" || raw.policy === "auto") settings.policy = raw.policy;
		else if (raw.autoCheck === false) settings.policy = "off";
		settings.autoCheck = settings.policy !== "off";
	} catch {
		/* defaults */
	}
	return settings;
}

/** Saved settings; TABKYRA_NO_UPDATE_CHECK turns the daily check off for this process. */
export function readSettings(): UpdateSettings {
	const settings = readSavedSettings();
	if (process.env.TABKYRA_NO_UPDATE_CHECK) {
		settings.autoCheck = false;
		settings.policy = "off";
	}
	return settings;
}

function writeSettings(settings: UpdateSettings): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	settings.autoCheck = settings.policy !== "off";
	writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
}

/** Settings > Updates and `tabkyra update --auto-check`. */
export function setPolicy(policy: UpdatePolicy): void {
	const saved = readSavedSettings();
	saved.policy = policy;
	writeSettings(saved);
}

// ---- the last update, for "What's new" --------------------------------------------------

export function readLastUpdate(): LastUpdate | undefined {
	try {
		return JSON.parse(readFileSync(lastUpdateFile(), "utf8")) as LastUpdate;
	} catch {
		return undefined;
	}
}

export function writeLastUpdate(record: LastUpdate): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const tmp = `${lastUpdateFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
	renameSync(tmp, lastUpdateFile());
}

export interface UpdateStatus {
	checkedAt: number;
	/** "main" in a checkout. */
	channel: Channel | "main";
	current: string;
	latest?: string;
	available: boolean;
	url?: string;
	error?: string;
	/** Absent in files written before checkout mode: a release check. */
	mode?: InstallMode;
	/** Checkout mode: HEAD and origin/main when the check ran. */
	head?: string;
	origin?: string;
}

export function readStatus(): UpdateStatus | undefined {
	try {
		return JSON.parse(readFileSync(statusFile(), "utf8")) as UpdateStatus;
	} catch {
		return undefined;
	}
}

export function writeStatus(status: UpdateStatus): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const tmp = `${statusFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
	renameSync(tmp, statusFile());
}

// ---- versions --------------------------------------------------------------

interface Version {
	core: [number, number, number];
	pre: string[];
	text: string;
}

export function parseVersion(text: string): Version | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
	if (!m) return undefined;
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [], text: text.trim().replace(/^v/, "") };
}

/** Semver order: a prerelease sorts before its release; numeric identifiers compare as numbers. */
export function compareVersions(a: Version, b: Version): number {
	for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
	if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
	for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
		const x = a.pre[i];
		const y = b.pre[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
		if (nx !== ny) return nx ? -1 : 1;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/** The release installed at `dir` (release.json), else the version of its built extension. */
export function installedVersion(dir = repoRoot()): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as { version: string }).version;
	} catch {
		/* not a release install */
	}
	const extension = dir === repoRoot() ? extensionDir() : join(dir, "dist-chrome");
	try {
		return (JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8")) as { version: string }).version;
	} catch {
		return undefined;
	}
}

/** True when `a` is a strictly newer version than `b`; unparseable versions are never newer. */
export function isNewer(a: string | undefined, b: string | undefined): boolean {
	const x = a ? parseVersion(a) : undefined;
	if (!x) return false;
	const y = b ? parseVersion(b) : undefined;
	return !y || compareVersions(x, y) > 0;
}

// ---- GitHub releases -------------------------------------------------------

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
}

interface GitHubRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	html_url: string;
	body?: string | null;
	assets: ReleaseAsset[];
}

export interface Release {
	version: string;
	url: string;
	/** The GitHub release body (scripts/release/notes.mjs writes it from CHANGELOG.md). */
	notes?: string;
	zip: ReleaseAsset;
	sums: ReleaseAsset;
	signature: ReleaseAsset;
}

/** Only https, except loopback (the test server). */
function checkUrl(url: string): URL {
	const u = new URL(url);
	const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new UpdateError(`Refusing to download over ${u.protocol} from ${u.host}`);
	return u;
}

async function fetchBytes(url: string, max: number, timeoutMs = 60000): Promise<Buffer> {
	checkUrl(url);
	const response = await fetch(url, {
		headers: { "User-Agent": `tabkyra-cli/${VERSION}`, Accept: "application/octet-stream" },
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
	});
	if (!response.ok) throw new UpdateError(`${response.status} ${response.statusText} from ${new URL(url).host}`);
	checkUrl(response.url || url);
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > max) throw new UpdateError(`${new URL(url).pathname} is ${declared} bytes, over the ${max} byte limit`);
	const chunks: Buffer[] = [];
	let total = 0;
	if (!response.body) return Buffer.alloc(0);
	for await (const chunk of response.body) {
		total += chunk.length;
		if (total > max) throw new UpdateError(`${new URL(url).pathname} is over the ${max} byte limit`);
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** The newest release on a channel: stable skips prereleases, nightly takes everything. */
export async function latestRelease(channel: Channel): Promise<Release | undefined> {
	const url = `${apiBase()}/repos/${REPO}/releases?per_page=30`;
	checkUrl(url);
	const response = await fetch(url, {
		headers: { "User-Agent": `tabkyra-cli/${VERSION}`, Accept: "application/vnd.github+json" },
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) throw new UpdateError(`GitHub answered ${response.status} ${response.statusText} for the release list`);
	const releases = (await response.json()) as GitHubRelease[];
	let best: { release: GitHubRelease; version: Version } | undefined;
	for (const release of releases) {
		if (release.draft) continue;
		const version = parseVersion(release.tag_name);
		if (!version) continue;
		if (channel === "stable" && (release.prerelease || version.pre.length > 0)) continue;
		if (!best || compareVersions(version, best.version) > 0) best = { release, version };
	}
	if (!best) return undefined;
	const find = (name: string) => best?.release.assets.find((a) => a.name === name);
	const zip = find(`tabkyra-${best.version.text}.zip`);
	const sums = find("SHA256SUMS");
	const signature = find("SHA256SUMS.minisig");
	if (!zip || !sums || !signature) {
		throw new UpdateError(`Release ${best.release.tag_name} is missing its zip, SHA256SUMS or SHA256SUMS.minisig; not installing it`);
	}
	const body = typeof best.release.body === "string" ? best.release.body.trim() : "";
	const notes = body ? releaseSummary(body) : undefined;
	return { version: best.version.text, url: best.release.html_url, notes, zip, sums, signature };
}

// ---- check -----------------------------------------------------------------

export async function checkForUpdate(channel: Channel): Promise<UpdateStatus> {
	const current = installedVersion() ?? "0.0.0";
	const status: UpdateStatus = { checkedAt: Date.now(), channel, current, available: false };
	try {
		const release = await latestRelease(channel);
		if (release) {
			status.latest = release.version;
			status.url = release.url;
			status.available = isNewer(release.version, current);
		}
	} catch (err) {
		status.error = err instanceof Error ? err.message : String(err);
	}
	writeStatus(status);
	return status;
}

// ---- download and verify ---------------------------------------------------

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Download a release and prove it: signature, signed version, checksum. Returns the zip. */
export async function downloadVerified(
	release: Release,
	log: (line: string) => void,
	phase: (phase: UpdatePhase, message: string) => void = () => {},
): Promise<Buffer> {
	let key: ReturnType<typeof parsePublicKey>;
	try {
		key = parsePublicKey(releaseKeyText());
	} catch {
		throw new UpdateError("This build has no release signing key (keys/tabkyra-release.pub), so it can't verify a release. Updates stay off until one is published.");
	}
	phase("downloading", `Downloading the checksums for ${release.version}`);
	const sums = await fetchBytes(release.sums.browser_download_url, MAX_SUMS_BYTES);
	const signature = (await fetchBytes(release.signature.browser_download_url, MAX_SUMS_BYTES)).toString("utf8");
	phase("verifying", "Checking the minisign signature");
	let trusted: string;
	try {
		trusted = verifyMinisign(sums, signature, key);
	} catch (err) {
		throw new UpdateError(`Signature check failed: ${err instanceof SignatureError ? err.message : String(err)}`);
	}
	// The trusted comment is signed: it pins the version, so an old signed release can't pose as a new one.
	if (!new RegExp(`(^|\\s)tabkyra ${release.version.replace(/\./g, "\\.")}(\\s|$)`).test(trusted)) {
		throw new UpdateError(`Signature check failed: it was made for "${trusted}", not tabkyra ${release.version}`);
	}
	log(`${sym.ok} Signature verified ${c.dim(`(${trusted})`)}`);

	const expected = sums
		.toString("utf8")
		.split(/\r?\n/)
		.map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l.trim()))
		.find((m) => m && m[2] === release.zip.name)?.[1];
	if (!expected) throw new UpdateError(`SHA256SUMS has no entry for ${release.zip.name}`);
	phase("downloading", `Downloading ${release.zip.name}`);
	const zip = await fetchBytes(release.zip.browser_download_url, MAX_ZIP_BYTES, 300000);
	phase("verifying", "Checking the archive's checksum");
	const actual = sha256(zip);
	if (actual !== expected) throw new UpdateError(`Checksum mismatch for ${release.zip.name}: expected ${expected}, got ${actual}`);
	log(`${sym.ok} Checksum verified ${c.dim(`(sha256 ${actual.slice(0, 16)}...)`)}`);
	return zip;
}

/** Unpack into a fresh staging folder next to app/ and check it is a whole release of `version`. */
export function stage(zip: Buffer, version: string): string {
	const root = installRoot();
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = join(root, `.staging-${randomBytes(6).toString("hex")}`);
	mkdirSync(dir, { mode: 0o700 });
	try {
		extractZip(zip, dir);
		const release = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as { version?: string };
		if (release.version !== version) throw new UpdateError(`The archive says it is ${release.version}, expected ${version}`);
		const missing = [...EXTENSION_FILES.map((f) => join("dist-chrome", f)), join("cli", "dist", "index.js")].filter((f) => !existsSync(join(dir, f)));
		if (missing.length) throw new UpdateError(`The archive is incomplete (missing ${missing.join(", ")})`);
		const manifest = JSON.parse(readFileSync(join(dir, "dist-chrome", "manifest.json"), "utf8")) as { version?: string };
		const core = parseVersion(version)?.core.join(".");
		if (manifest.version !== core) throw new UpdateError(`The extension inside is ${manifest.version}, expected ${core}`);
		return dir;
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
}

// ---- swap, lock, recover ---------------------------------------------------

/** A lock older than this whose owner can't be identified is taken over. */
const LOCK_STALE_MS = 10 * 60 * 1000;
/** A lock older than this is taken over even if its pid is alive (pids are reused). */
const LOCK_MAX_MS = 60 * 60 * 1000;

/**
 * One updater at a time. The lock is a directory (mkdir is atomic) holding the owner's pid.
 * It is taken over only when that pid is dead, or when no pid was written and it is old.
 * Returns the release function. `root` defaults to the release install; a checkout locks its
 * own .tabkyra-update folder.
 */
export function takeLock(root = installRoot()): () => void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const lock = join(root, "update.lock");
	const take = (): boolean => {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, "pid"), String(process.pid));
			return true;
		} catch {
			return false;
		}
	};
	if (!take()) {
		let pid = 0;
		try {
			pid = Number(readFileSync(join(lock, "pid"), "utf8"));
		} catch {
			/* not written yet */
		}
		let held: boolean;
		if (pid > 0) {
			try {
				process.kill(pid, 0);
				// A pid can be reused; no update holds the lock for an hour.
				held = Date.now() - statSync(lock).mtimeMs < LOCK_MAX_MS;
			} catch {
				held = false;
			}
		} else {
			held = Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS;
		}
		if (held) throw new UpdateError(`Another tabkyra update is running${pid > 0 ? ` (pid ${pid})` : ""}. Try again when it finishes.`);
		// Move the dead lock aside first, so two takers can't both delete and recreate it.
		const dead = join(root, `.lock-dead-${randomBytes(6).toString("hex")}`);
		try {
			renameSync(lock, dead);
			rmSync(dead, { recursive: true, force: true });
		} catch {
			/* someone else took it over */
		}
		if (!take()) throw new UpdateError("Another tabkyra update just started. Try again when it finishes.");
	}
	return () => rmSync(lock, { recursive: true, force: true });
}

export function withLock<T>(fn: () => T, root = installRoot()): T {
	const release = takeLock(root);
	try {
		return fn();
	} finally {
		release();
	}
}

/**
 * Repair what a crash mid-swap left, without deleting a release:
 * - app/ missing: the newest of .swap-* (a rollback in flight) or previous/ becomes app/;
 * - previous/ missing: an orphaned .swap-* becomes previous/;
 * - staging folders (never yet installed) are removed.
 * Runs under the lock at the start of every update, rollback and check.
 */
export function recover(): string | undefined {
	const root = installRoot();
	if (!existsSync(root)) return undefined;
	const notes: string[] = [];
	const swaps: string[] = [];
	for (const name of readdirSync(root)) {
		if (name.startsWith(".staging-") || name.startsWith(".lock-dead-")) rmSync(join(root, name), { recursive: true, force: true });
		else if (name.startsWith(".swap-")) swaps.push(join(root, name));
	}
	if (!existsSync(appDir())) {
		const source = swaps.shift() ?? (existsSync(previousDir()) ? previousDir() : undefined);
		if (source) {
			renameSync(source, appDir());
			notes.push(`An interrupted ${source === previousDir() ? "update" : "rollback"} was undone; ${installedVersion(appDir()) ?? "the release"} is back in place.`);
		}
	}
	if (!existsSync(previousDir()) && swaps.length > 0) {
		renameSync(swaps.shift() as string, previousDir());
		notes.push(`Kept ${installedVersion(previousDir()) ?? "the other release"} for rollback after an interrupted swap.`);
	}
	// Anything still left is a third copy; keep it out of the way rather than delete it.
	for (const extra of swaps) notes.push(`An extra copy from an interrupted swap is at ${extra}; delete it if you don't need it.`);
	return notes.length ? notes.join(" ") : undefined;
}

/** app/ -> previous/, staged -> app/. Each step is one rename; a failed second step is undone. */
export function swapIn(staged: string): void {
	const app = appDir();
	const prev = previousDir();
	if (existsSync(app)) {
		rmSync(prev, { recursive: true, force: true });
		renameSync(app, prev);
	}
	try {
		renameSync(staged, app);
	} catch (err) {
		if (existsSync(prev) && !existsSync(app)) renameSync(prev, app);
		throw err;
	}
}

/** Re-register the native host and the launcher from the release now in app/. */
export function reinstallHost(log: (line: string) => void): boolean {
	const cli = join(appDir(), "cli", "dist", "index.js");
	try {
		const out = execFileSync(process.execPath, [cli, "install"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 60000 });
		const wrote = out.split("\n").filter((l) => l.includes("Wrote")).length;
		log(`${sym.ok} Native host ${wrote > 0 ? "re-registered" : "already current"} ${c.dim(`(${cli})`)}`);
		return true;
	} catch (err) {
		const e = err as { stdout?: string; message: string };
		log(`${sym.warn} The release is installed, but registering the native host failed: ${(e.stdout || e.message).trim()}`);
		log(`  ${sym.arrow} Run ${c.bold(`node ${cli} install`)}`);
		return false;
	}
}

export function isManagedCopy(): boolean {
	try {
		return realpathSync(repoRoot()) === realpathSync(appDir());
	} catch {
		return false;
	}
}

function reloadHint(log: (line: string) => void): void {
	log("");
	log(`${sym.arrow} Reload Tabkyra so the browser runs the new files: ${c.bold("tabkyra reload")}, or the reload button on chrome://extensions.`);
	if (!isManagedCopy()) {
		log(`  ${c.dim("First release install: in chrome://extensions remove the old Tabkyra, then Load unpacked:")}`);
		log(`  ${join(appDir(), "dist-chrome")}`);
	}
}

// ---- commands --------------------------------------------------------------

export interface UpdateOptions {
	check: boolean;
	rollback: boolean;
	json: boolean;
	yes: boolean;
	channel?: Channel;
	autoCheck?: boolean;
}

export async function runUpdate(options: UpdateOptions): Promise<number> {
	const log = (line: string) => {
		if (!options.json) console.log(line);
	};
	// A read-only --check never changes settings; --channel is remembered when updating.
	if (!options.check && (options.channel || options.autoCheck !== undefined)) {
		const saved = readSavedSettings();
		if (options.channel) saved.channel = options.channel;
		// --auto-check on keeps "install automatically" if that was the setting.
		if (options.autoCheck !== undefined) saved.policy = options.autoCheck ? (saved.policy === "off" ? "notify" : saved.policy) : "off";
		writeSettings(saved);
	}
	const channel = options.channel ?? readSettings().channel;
	log(banner(options.rollback ? "rollback" : `update ${c.dim(`(${channel})`)}`));

	if (options.rollback) return rollback(log, options.yes);

	// Repair an interrupted swap before anything reads the install.
	if (existsSync(installRoot())) {
		const note = withLock(recover);
		if (note) log(`${sym.warn} ${note}`);
	}

	if (options.autoCheck !== undefined && !options.check) {
		log(`${sym.ok} Daily update check ${options.autoCheck ? "on" : "off"}.`);
		return 0;
	}

	const status = await checkForUpdate(channel);
	if (options.check) {
		if (options.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
		if (status.error) {
			log(`${sym.fail} ${status.error}`);
			return 1;
		}
		if (!status.latest) log(`${sym.ok} No ${channel} release is published yet. ${c.dim(`(installed ${status.current})`)}`);
		else if (status.available) log(`${sym.warn} Update available: ${c.bold(status.latest)} ${c.dim(`(installed ${status.current})`)} ${sym.arrow} ${c.bold("tabkyra update")}`);
		else log(`${sym.ok} Up to date ${c.dim(`(${status.current}, latest ${channel} ${status.latest})`)}`);
		return status.error ? 1 : status.available ? EXIT_UPDATE_AVAILABLE : 0;
	}

	if (status.error) throw new UpdateError(status.error);
	if (!status.latest) {
		log(`${sym.ok} No ${channel} release is published yet.`);
		return 0;
	}
	const managed = isManagedCopy();
	if (managed && !status.available) {
		log(`${sym.ok} Up to date ${c.dim(`(${status.current})`)}`);
		return 0;
	}
	if (!managed) {
		// A source checkout (or npm link) is not replaced; the release goes to its own folder.
		const target = appDir();
		const installed = existsSync(join(target, "release.json")) ? installedVersion(target) : undefined;
		if (installed && !isNewer(status.latest, installed)) {
			log(`${sym.ok} The release install at ${target} is up to date ${c.dim(`(${installed})`)}`);
			return 0;
		}
		log(`${sym.dot} This tabkyra runs from ${repoRoot()}, not from a release install.`);
		log(`  ${c.dim("A git checkout updates with git pull and a rebuild. The signed release installs to")} ${target}`);
		log(`  ${c.dim("and the native host and agent launcher will point at it.")}`);
		const ok = await confirm(`Install release ${status.latest} to ${target}?`, { assumeYes: options.yes, defaultYes: false });
		if (!ok) return 1;
	} else {
		log(`${sym.dot} Updating ${c.bold(status.current)} ${sym.arrow} ${c.bold(status.latest)}`);
	}

	const release = await latestRelease(channel);
	if (!release || release.version !== status.latest) throw new UpdateError("The release list changed during the update; run it again");
	const zip = await downloadVerified(release, log);
	withLock(() => {
		recover();
		// A release the side panel staged earlier is older than or equal to this one; drop it.
		rmSync(stagedDir(), { recursive: true, force: true });
		const staged = stage(zip, release.version);
		swapIn(staged);
	});
	log(`${sym.ok} Installed ${c.bold(release.version)} in ${appDir()}`);
	if (existsSync(previousDir())) log(`${sym.ok} Kept ${installedVersion(previousDir()) ?? "the previous release"} for ${c.bold("tabkyra update --rollback")}`);
	reinstallHost(log);
	writeStatus({ ...status, current: release.version, available: false, checkedAt: Date.now() });
	reloadHint(log);
	return 0;
}

async function rollback(log: (line: string) => void, yes: boolean): Promise<number> {
	if (!isManagedCopy()) {
		// Rolling back re-registers the native host and launcher from the release folder.
		log(`${sym.dot} This tabkyra runs from ${repoRoot()}, not from the release install in ${appDir()}.`);
		log(`  ${c.dim("Rolling that install back also points the native host and agent launcher at it.")}`);
		const ok = await confirm(`Roll back the release install in ${appDir()}?`, { assumeYes: yes, defaultYes: false });
		if (!ok) return 1;
	}
	const { from, to } = swapBack(log);
	log(`${sym.ok} Rolled back ${c.bold(from ?? "?")} ${sym.arrow} ${c.bold(to ?? "?")}`);
	log(`${sym.ok} Kept ${from ?? "the newer release"} as the previous release ${c.dim("(roll back again to return to it)")}`);
	reinstallHost(log);
	reloadHint(log);
	return 0;
}

/** app/ <-> previous/ under the lock, and the cached check updated to match. */
export function swapBack(log: (line: string) => void): { from?: string; to?: string } {
	let from: string | undefined;
	let to: string | undefined;
	withLock(() => {
		const note = recover();
		if (note) log(`${sym.warn} ${note}`);
		const app = appDir();
		const prev = previousDir();
		if (!existsSync(app)) throw new UpdateError(`No release is installed in ${app}`);
		if (!existsSync(prev)) throw new UpdateError(`No previous release to roll back to (${prev} is missing)`);
		from = installedVersion(app);
		to = installedVersion(prev);
		const hold = join(installRoot(), `.swap-${randomBytes(6).toString("hex")}`);
		// A staged newer release would undo the rollback when activated; drop it.
		rmSync(stagedDir(), { recursive: true, force: true });
		// Three renames; recover() repairs any point a crash can stop at (see above).
		renameSync(app, hold);
		renameSync(prev, app);
		renameSync(hold, prev);
	});
	const status = readStatus();
	if (status) writeStatus({ ...status, current: to ?? status.current, available: isNewer(status.latest, to) });
	return { from, to };
}
