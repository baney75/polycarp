/**
 * The community skill catalog (docs/decisions.md D27): every skill merged into community/skills
 * in baney75/tabkyra, published as one JSON file signed with the release key, and synced to
 * each client about once a day.
 *
 * - Built in CI on main (.github/workflows/community-catalog.yml, `tabkyra skill catalog`),
 *   signed there with minisign in the release environment, and attached to the
 *   `community-catalog` release. No key is ever on a contributor's or user's machine.
 * - A client accepts a catalog only when its signature verifies against the release key
 *   bundled in the CLI (keys/tabkyra-release.pub), its signed trusted comment names the same
 *   serial as the file, and the serial is not older than the last one it accepted (so an old
 *   catalog can't be replayed to bring back a pulled skill). Anything else is refused and the
 *   catalog already on disk stays in use.
 * - The verified file is kept with its signature and verified again each time it is read, so
 *   a file changed on disk is refused too.
 * - A skill missing from a new catalog, or listed under `revoked`, is removed from the client:
 *   it is no longer matched or read, and copies Tabkyra installed into harnesses are deleted.
 * - Opt out with `tabkyra skill sync --off` or Settings > Skills in the side panel.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import RELEASE_KEY from "../../keys/tabkyra-release.pub";
import { parsePublicKey, SignatureError, verifyMinisign } from "./minisign.ts";
import { lintCommunity, parseSites } from "./skill-community.ts";
import { lintText, parseFrontmatter } from "./skill-lint.ts";
import { VERSION } from "./version.ts";

export const CATALOG_FILE = "community-catalog.json";
export const CATALOG_SIG = "community-catalog.json.minisig";
/** The release that holds the current catalog; its tag is not a version, so updates ignore it. */
export const CATALOG_URL = "https://github.com/baney75/tabkyra/releases/download/community-catalog";
const TRUSTED = /^tabkyra community-catalog (\d{1,15})$/;
const MAX_CATALOG_BYTES = 2_000_000;
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class CatalogError extends Error {}

/** The release has no catalog yet: not an error, and checked again a day later. */
class NotPublished extends Error {}

export interface CatalogSkill {
	name: string;
	/** First 12 hex digits of the SHA-256 of `text`, as for every skill version. */
	version: string;
	sha256: string;
	description: string;
	sites: string[];
	text: string;
}

export interface Catalog {
	schema: 1;
	/** Grows with every published catalog; a client never goes back to a lower one. */
	serial: number;
	generated: string;
	/** The commit the catalog was built from. */
	source: string;
	skills: CatalogSkill[];
	revoked: Array<{ skill: string; reason: string }>;
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Lint problems that keep a community skill out of a catalog or off a client. */
export function communityProblems(name: string, text: string, bundled: ReadonlySet<string>): string[] {
	const findings = [...lintText(`${name}/SKILL.md`, text, { dirName: name }), ...lintCommunity(`${name}/SKILL.md`, text, { bundled, name })].filter((f) => f.severity === "error");
	return findings.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.message}`);
}

/** Skill folders under community/skills in a checkout, as text. Never follows a link. */
export function readCommunityFolder(root: string): Array<{ name: string; text: string }> {
	const dir = join(root, "community", "skills");
	if (!existsSync(dir)) return [];
	const out: Array<{ name: string; text: string }> = [];
	for (const name of readdirSync(dir).sort()) {
		const file = join(dir, name, "SKILL.md");
		if (!NAME.test(name) || !existsSync(file)) continue;
		if (lstatSync(join(dir, name)).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new CatalogError(`community/skills/${name} is a symbolic link.`);
		out.push({ name, text: readFileSync(file, "utf8") });
	}
	return out;
}

/** community/cases/*.jsonl in a checkout, joined: each community skill's router cases. */
export function readCommunityCases(root: string): string {
	const dir = join(root, "community", "cases");
	if (!existsSync(dir)) return "";
	return readdirSync(dir)
		.filter((f) => /^[a-z0-9]+(-[a-z0-9]+)*\.jsonl$/.test(f))
		.sort()
		.map((f) => readFileSync(join(dir, f), "utf8").trimEnd())
		.filter(Boolean)
		.join("\n");
}

export function readRevoked(root: string): Array<{ skill: string; reason: string }> {
	const file = join(root, "community", "revoked.json");
	if (!existsSync(file)) return [];
	const data = JSON.parse(readFileSync(file, "utf8")) as { revoked?: unknown };
	if (!Array.isArray(data.revoked)) throw new CatalogError('community/revoked.json needs {"revoked": [{"skill": "<name>", "reason": "..."}]}.');
	return data.revoked.map((r, i) => {
		const e = r as { skill?: unknown; reason?: unknown };
		if (typeof e.skill !== "string" || !NAME.test(e.skill) || typeof e.reason !== "string" || !e.reason.trim()) {
			throw new CatalogError(`community/revoked.json entry ${i + 1} needs a skill name and a reason.`);
		}
		return { skill: e.skill, reason: e.reason.trim() };
	});
}

/** Built-in skill names in a checkout (skills/<name>/SKILL.md). */
export function bundledNamesIn(root: string): Set<string> {
	const dir = join(root, "skills");
	if (!existsSync(dir)) return new Set();
	return new Set(readdirSync(dir).filter((n) => NAME.test(n) && existsSync(join(dir, n, "SKILL.md"))));
}

/**
 * Build the catalog from a checkout. Every skill must pass the lint and the community rules;
 * one that doesn't stops the build, so nothing unreviewed by the rules is published.
 */
export function buildCatalog(root: string, options: { serial: number; source: string; generated?: string }): { catalog: Catalog; text: string } {
	if (!Number.isSafeInteger(options.serial) || options.serial < 1) throw new CatalogError("The serial must be a positive whole number.");
	const bundled = bundledNamesIn(root);
	const revoked = readRevoked(root);
	const problems: string[] = revoked.filter((r) => bundled.has(r.skill)).map((r) => `community/revoked.json names ${r.skill}, a built-in skill; the community catalog can only pull community skills.`);
	const skills: CatalogSkill[] = [];
	for (const { name, text } of readCommunityFolder(root)) {
		problems.push(...communityProblems(name, text, bundled));
		if (revoked.some((r) => r.skill === name)) problems.push(`${name} is listed in community/revoked.json but its folder is still there.`);
		const hash = sha256(text);
		skills.push({ name, version: hash.slice(0, 12), sha256: hash, description: parseFrontmatter(text)?.description ?? "", sites: parseSites(text)?.sites ?? [], text });
	}
	if (problems.length) throw new CatalogError(`Not building the catalog:\n${problems.join("\n")}`);
	const catalog: Catalog = { schema: 1, serial: options.serial, generated: options.generated ?? new Date().toISOString(), source: options.source, skills, revoked };
	return { catalog, text: `${JSON.stringify(catalog, null, "\t")}\n` };
}

export function trustedComment(serial: number): string {
	return `tabkyra community-catalog ${serial}`;
}

/** The key catalogs are checked with: the release key, or TABKYRA_UPDATE_PUBKEY (a file) for tests and forks, as for updates. */
function releaseKeyText(): string {
	const file = process.env.TABKYRA_UPDATE_PUBKEY;
	return file ? readFileSync(file, "utf8") : RELEASE_KEY;
}

/**
 * Verify a catalog file against its signature and parse it. Throws CatalogError on any
 * problem: no key, a bad or missing signature, a trusted comment that names another serial,
 * or a file that doesn't hold what its own fields say.
 */
export function verifyCatalog(data: Buffer, signature: string, keyText = releaseKeyText()): Catalog {
	if (!/^RW/m.test(keyText)) throw new CatalogError("This build has no release signing key (keys/tabkyra-release.pub), so it can't verify the community catalog.");
	let trusted: string;
	try {
		trusted = verifyMinisign(data, signature, parsePublicKey(keyText));
	} catch (err) {
		if (err instanceof SignatureError) throw new CatalogError(`Refused the community catalog: ${err.message}.`);
		throw err;
	}
	const m = TRUSTED.exec(trusted);
	if (!m) throw new CatalogError(`Refused the community catalog: its signed comment is "${trusted.slice(0, 80)}", not a catalog's.`);
	let catalog: Catalog;
	try {
		catalog = JSON.parse(data.toString("utf8")) as Catalog;
	} catch {
		throw new CatalogError("Refused the community catalog: it is not JSON.");
	}
	if (catalog.schema !== 1) throw new CatalogError(`Refused the community catalog: schema ${String(catalog.schema)} is not one this version reads. Update Tabkyra.`);
	if (catalog.serial !== Number(m[1])) throw new CatalogError("Refused the community catalog: the file's serial doesn't match its signature.");
	if (!Array.isArray(catalog.skills) || !Array.isArray(catalog.revoked)) throw new CatalogError("Refused the community catalog: it has no skills or revoked list.");
	const names = new Set<string>();
	for (const s of catalog.skills) {
		if (typeof s?.name !== "string" || !NAME.test(s.name) || s.name === "none" || names.has(s.name)) throw new CatalogError("Refused the community catalog: a skill has a bad or repeated name.");
		names.add(s.name);
		if (typeof s.text !== "string" || sha256(s.text) !== s.sha256 || s.version !== s.sha256.slice(0, 12)) throw new CatalogError(`Refused the community catalog: ${s.name}'s text doesn't match its hash.`);
		// Derived again from the text: the fields a client acts on never come from elsewhere.
		s.sites = parseSites(s.text)?.sites ?? [];
		s.description = parseFrontmatter(s.text)?.description ?? "";
	}
	return catalog;
}

// --- The client's copy ---------------------------------------------------------------------

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

export function communityDir(): string {
	return join(configDir(), "community");
}

export interface CommunityState {
	/** Receive community skills (default on); off stops syncing and hides them. */
	enabled: boolean;
	/** The serial of the catalog in use; a lower one is refused. */
	serial?: number;
	lastCheck?: string;
	lastResult?: string;
	lastError?: string;
	/** Skills the user removed (`skill remove`): kept off until `skill enable`. */
	disabled: string[];
	/** Skills a catalog pulled, with why, newest last. */
	removed: Array<{ name: string; reason: string; at: string }>;
}

function stateFile(): string {
	return join(communityDir(), "state.json");
}

export function readState(): CommunityState {
	const empty: CommunityState = { enabled: true, disabled: [], removed: [] };
	try {
		const data = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<CommunityState>;
		return {
			enabled: data.enabled !== false,
			serial: Number.isSafeInteger(data.serial) ? data.serial : undefined,
			lastCheck: typeof data.lastCheck === "string" ? data.lastCheck : undefined,
			lastResult: typeof data.lastResult === "string" ? data.lastResult : undefined,
			lastError: typeof data.lastError === "string" ? data.lastError : undefined,
			disabled: Array.isArray(data.disabled) ? data.disabled.filter((n): n is string => typeof n === "string" && NAME.test(n)) : [],
			removed: Array.isArray(data.removed) ? data.removed.filter((r) => r && typeof r.name === "string" && NAME.test(r.name)).slice(-200) : [],
		};
	} catch {
		return empty;
	}
}

function atomicWrite(file: string, data: string | Buffer): void {
	const dir = communityDir();
	if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new CatalogError(`${dir} is a symbolic link; Tabkyra won't write through it.`);
	mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
	renameSync(tmp, file);
}

export function writeState(state: CommunityState): void {
	atomicWrite(stateFile(), `${JSON.stringify(state, null, "\t")}\n`);
}

export function setEnabled(on: boolean): CommunityState {
	const state = { ...readState(), enabled: on };
	writeState(state);
	return state;
}

export function setDisabled(name: string, off: boolean): void {
	const state = readState();
	const disabled = new Set(state.disabled);
	if (off) disabled.add(name);
	else disabled.delete(name);
	writeState({ ...state, disabled: [...disabled].sort() });
}

let cached: { key: string; catalog?: Catalog; problem?: string } | undefined;

/** A key that changes whenever the catalog or the state on disk changes; the router uses it too. */
export function communityKey(): string {
	const stat = (p: string) => {
		try {
			const s = statSync(p);
			return `${s.ino}:${s.mtimeMs}:${s.size}`;
		} catch {
			return "-";
		}
	};
	const dir = communityDir();
	return `${stat(join(dir, CATALOG_FILE))}|${stat(join(dir, CATALOG_SIG))}|${stat(stateFile())}`;
}

/** The catalog on disk, verified again on every change. */
export function loadCatalog(): { catalog?: Catalog; problem?: string } {
	const key = communityKey();
	if (cached?.key === key) return cached;
	const dir = communityDir();
	const file = join(dir, CATALOG_FILE);
	let result: { catalog?: Catalog; problem?: string } = {};
	if (existsSync(file)) {
		try {
			const catalog = verifyCatalog(readFileSync(file), readFileSync(join(dir, CATALOG_SIG), "utf8"));
			const serial = readState().serial;
			result = serial !== undefined && catalog.serial < serial ? { problem: "the community catalog on disk is older than the last one accepted" } : { catalog };
		} catch (err) {
			result = { problem: err instanceof Error ? err.message : String(err) };
		}
	}
	cached = { key, ...result };
	return result;
}

export interface ActiveSkill extends CatalogSkill {
	serial: number;
}

/**
 * The community skills in use: from a verified catalog, when community skills are on, not a
 * built-in name, not removed by the user, and clean under the lint and community rules here.
 */
let active: { key: string; skills: Map<string, ActiveSkill> } | undefined;

export function activeCommunity(bundled: ReadonlySet<string>): Map<string, ActiveSkill> {
	const key = `${communityKey()}#${[...bundled].join(",")}`;
	if (active?.key === key) return new Map(active.skills);
	const state = readState();
	const out = new Map<string, ActiveSkill>();
	const { catalog } = state.enabled ? loadCatalog() : {};
	for (const s of catalog?.skills ?? []) {
		if (bundled.has(s.name) || state.disabled.includes(s.name)) continue;
		if (communityProblems(s.name, s.text, bundled).length) continue;
		out.set(s.name, { ...s, serial: catalog?.serial ?? 0 });
	}
	active = { key, skills: out };
	return new Map(out);
}

/** Why a community skill is gone: pulled by the catalog, or removed by the user. */
export function removalReason(name: string): string | undefined {
	const state = readState();
	if (state.disabled.includes(name)) return `you removed the community skill ${name} (tabkyra skill enable ${name} brings it back)`;
	const pulled = [...state.removed].reverse().find((r) => r.name === name);
	if (pulled && !loadCatalog().catalog?.skills.some((s) => s.name === name)) return `the community catalog pulled ${name}: ${pulled.reason}`;
	return undefined;
}

// --- Sync ----------------------------------------------------------------------------------

/** Where catalogs come from: TABKYRA_COMMUNITY_URL (an https URL, or a folder for tests and dry runs), else the release. */
function source(): string {
	return process.env.TABKYRA_COMMUNITY_URL || CATALOG_URL;
}

function checkUrl(url: string): void {
	const u = new URL(url);
	const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new CatalogError(`Refusing to fetch the community catalog over ${u.protocol}`);
}

async function fetchFile(base: string, name: string): Promise<Buffer> {
	if (!/^[a-z]+:\/\//i.test(base)) {
		const file = join(resolve(base), name);
		if (!existsSync(file)) throw new CatalogError(`No ${name} in ${base}.`);
		return readFileSync(file);
	}
	const url = `${base.replace(/\/$/, "")}/${name}`;
	checkUrl(url);
	const response = await fetch(url, { headers: { "User-Agent": `tabkyra-cli/${VERSION}` }, signal: AbortSignal.timeout(30000), redirect: "follow" });
	if (response.status === 404) throw new NotPublished();
	if (!response.ok) throw new CatalogError(`${response.status} ${response.statusText} for ${name}`);
	checkUrl(response.url || url);
	const body = Buffer.from(await response.arrayBuffer());
	if (body.length > MAX_CATALOG_BYTES) throw new CatalogError(`${name} is over ${MAX_CATALOG_BYTES} bytes.`);
	return body;
}

export interface SyncResult {
	state: "off" | "current" | "updated" | "refused" | "failed" | "skipped";
	message: string;
	serial?: number;
	added: string[];
	updated: string[];
	removed: Array<{ name: string; reason: string }>;
}

/**
 * Fetch, verify and keep the newest catalog. A refused or failed fetch leaves the catalog in
 * use as it was. `due` skips the fetch when the last good check is under a day old; a failed
 * or refused one doesn't count, so the next timer tick (hourly in the native host) tries again.
 */
export async function syncCatalog(options: { due?: boolean } = {}): Promise<SyncResult> {
	const state = readState();
	const empty = { added: [], updated: [], removed: [] };
	if (!state.enabled) return { state: "off", message: "Community skills are off (tabkyra skill sync --on turns them on).", ...empty };
	if (options.due && state.lastCheck && Date.now() - Date.parse(state.lastCheck) < SYNC_INTERVAL_MS) {
		return { state: "skipped", message: `Checked ${state.lastCheck}; the next check is a day after that.`, serial: state.serial, ...empty };
	}
	const at = new Date().toISOString();
	const base = source();
	let data: Buffer;
	let signature: string;
	try {
		[data, signature] = await Promise.all([fetchFile(base, CATALOG_FILE), fetchFile(base, CATALOG_SIG).then((b) => b.toString("utf8"))]);
	} catch (err) {
		if (err instanceof NotPublished) {
			const message = "No community catalog is published yet.";
			writeState({ ...readState(), lastCheck: at, lastResult: message, lastError: undefined });
			return { state: "current", message, serial: state.serial, ...empty };
		}
		const message = `Couldn't fetch the community catalog: ${err instanceof Error ? err.message : String(err)}`;
		writeState({ ...readState(), lastError: message });
		return { state: "failed", message, serial: state.serial, ...empty };
	}
	let next: Catalog;
	try {
		next = verifyCatalog(data, signature);
		if (state.serial !== undefined && next.serial < state.serial) {
			throw new CatalogError(`Refused the community catalog: serial ${next.serial} is older than ${state.serial}, the one in use. An old catalog could bring back a pulled skill.`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		writeState({ ...readState(), lastError: message });
		return { state: "refused", message, serial: state.serial, ...empty };
	}
	return withSyncLock(() => commitCatalog(next, data, signature, at, empty));
}

/**
 * Keep an accepted catalog. Runs under the sync lock and compares against the state as it is
 * now, not as it was before the download: another process may have accepted a newer catalog
 * meanwhile, and this one must not roll it back.
 */
function commitCatalog(next: Catalog, data: Buffer, signature: string, at: string, empty: { added: string[]; updated: string[]; removed: Array<{ name: string; reason: string }> }): SyncResult {
	const state = readState();
	if (state.serial !== undefined && next.serial < state.serial) {
		const message = `Refused the community catalog: serial ${next.serial} is older than ${state.serial}, the one in use. An old catalog could bring back a pulled skill.`;
		writeState({ ...state, lastError: message });
		return { state: "refused", message, serial: state.serial, ...empty };
	}
	cached = undefined;
	const before = loadCatalog().catalog;
	const old = new Map((before?.skills ?? []).map((s) => [s.name, s]));
	const fresh = new Map(next.skills.map((s) => [s.name, s]));
	const added = [...fresh.keys()].filter((n) => !old.has(n));
	const updated = [...fresh.values()].filter((s) => old.has(s.name) && old.get(s.name)?.sha256 !== s.sha256).map((s) => s.name);
	const revokedReason = new Map(next.revoked.map((r) => [r.skill, r.reason]));
	const removed = [...old.keys()].filter((n) => !fresh.has(n)).map((name) => ({ name, reason: revokedReason.get(name) ?? "it is no longer in the community catalog" }));
	// Revoked names never seen here are recorded too, so a local copy of one is never used.
	for (const [name, reason] of revokedReason) if (!old.has(name) && !fresh.has(name) && !state.removed.some((r) => r.name === name)) removed.push({ name, reason });
	atomicWrite(join(communityDir(), CATALOG_SIG), signature);
	atomicWrite(join(communityDir(), CATALOG_FILE), data);
	const current = readState();
	const message = next.serial === state.serial ? "The community catalog is current." : `Community catalog ${next.serial}: ${next.skills.length} skills.`;
	writeState({
		...current,
		serial: next.serial,
		lastCheck: at,
		lastResult: message,
		lastError: undefined,
		removed: [...current.removed.filter((r) => !fresh.has(r.name)), ...removed.map((r) => ({ ...r, at }))].slice(-200),
	});
	cached = undefined;
	return { state: next.serial === state.serial && added.length + updated.length + removed.length === 0 ? "current" : "updated", message, serial: next.serial, added, updated, removed };
}

/** Lock files older than this belong to a process that died mid-commit. */
const STALE_LOCK_MS = 60_000;

/** One commit at a time across processes (the native host, MCP servers, the CLI). */
function withSyncLock<T>(fn: () => T): T {
	const dir = communityDir();
	if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new CatalogError(`${dir} is a symbolic link; Tabkyra won't write through it.`);
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, "sync.lock");
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
			} catch {
				/* gone meanwhile */
			}
			if (Date.now() > deadline) throw new CatalogError("Another Tabkyra process is saving the community catalog; try again in a moment.");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { force: true });
	}
}
