/**
 * `tabkyra library`: a local source library in the spirit of Zotero. Every entry is a
 * CSL-JSON record fetched from its DOI's registry (Crossref or DataCite through doi.org),
 * then checked against OpenAlex and Crossref's update notices for retractions. Entries
 * export to BibTeX, RIS and CSL-JSON (Zotero, Word, LaTeX) and to one Obsidian note each.
 *
 * Fetched metadata is untrusted: titles and names are stripped of control characters,
 * escaped for each output format, and never used in a path. Citekeys, which name files,
 * are generated here from [a-z0-9] only.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { VERSION } from "./version.ts";

export interface CslName {
	family?: string;
	given?: string;
	literal?: string;
}

export interface Verification {
	at: string;
	/** Where the record and the checks came from: "doi.org", "openalex", "crossref-updates". */
	sources: string[];
	retracted: boolean;
	/** Corrections, expressions of concern and retractions that point at this DOI. */
	notices: Array<{ type: string; doi: string }>;
	oaUrl?: string;
	citedBy?: number;
	/**
	 * Whether each retraction check ran. "failed" (timeout, rate limit, offline) means the
	 * answer is unknown: `complete` is false, and the source isn't reported as clean.
	 */
	/** "n/a": the DOI isn't Crossref's, so Crossref's notices can't speak for it. */
	checks?: { openalex: "ok" | "not-found" | "failed"; crossref: "ok" | "failed" | "n/a" };
	complete?: boolean;
}

export interface LibraryItem {
	id: string;
	type: string;
	title: string;
	author?: CslName[];
	issued?: { "date-parts"?: number[][] };
	"container-title"?: string;
	publisher?: string;
	volume?: string;
	issue?: string;
	page?: string;
	DOI?: string;
	URL?: string;
	tabkyra: {
		addedAt: string;
		verified: Verification;
		tags: string[];
		note?: string;
		quote?: { text: string; location?: string };
		/** The primary DOI the registry named, when the saved DOI is an alias. Checked on every verify. */
		primaryDoi?: string;
		/** Registration agency from doi.org ("crossref", "datacite", ...). */
		agency?: string;
	};
}

interface Library {
	version: 1;
	items: LibraryItem[];
}

export function libraryFile(): string {
	const dir = process.env.TABKYRA_LIBRARY_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra", "library");
	return join(dir, "library.json");
}

export function loadLibrary(): Library {
	const file = libraryFile();
	if (!existsSync(file)) return { version: 1, items: [] };
	const data = JSON.parse(readFileSync(file, "utf8")) as Library;
	if (data.version !== 1 || !Array.isArray(data.items)) throw new Error(`${file} is not a Tabkyra library.`);
	// Entries saved before notices were deduplicated can hold the same notice several times.
	for (const item of data.items) {
		const v = item?.tabkyra?.verified;
		if (v && Array.isArray(v.notices)) v.notices = uniqueNotices(v.notices);
	}
	return data;
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Run `fn` holding the library lock, so two processes (a shell and the MCP server, or two
 * agents) can't read the same copy and overwrite each other's additions. The lock is a
 * directory (mkdir is atomic) holding the owner's pid. A lock whose owner has died is taken
 * over by renaming it away first, which only one waiter can do.
 */
function withLock<T>(fn: () => T): T {
	const lock = `${libraryFile()}.lock`;
	mkdirSync(join(lock, ".."), { recursive: true });
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + 10_000;
	for (;;) {
		// Build the lock in a private folder, then rename it into place: rename onto an existing,
		// non-empty lock fails, so a lock is never visible half made.
		const pending = `${lock}.new-${token}`;
		try {
			mkdirSync(pending);
			writeFileSync(join(pending, "pid"), String(process.pid));
			writeFileSync(join(pending, "token"), token);
			renameSync(pending, lock);
			break;
		} catch (err) {
			rmSync(pending, { recursive: true, force: true });
			const code = (err as NodeJS.ErrnoException).code;
			// Windows reports a rename onto an existing folder as EPERM or EACCES.
			const held = code === "EEXIST" || code === "ENOTEMPTY" || ((code === "EPERM" || code === "EACCES") && existsSync(lock));
			if (!held) throw err;
			let owner = Number.NaN;
			try {
				owner = Number(readFileSync(join(lock, "pid"), "utf8"));
			} catch {
				/* the owner hasn't written its pid yet, or the lock just went away */
			}
			const st = lstatSync(lock, { throwIfNoEntry: false });
			// The lock is held for one synchronous read-modify-write, milliseconds; past a minute
			// it is abandoned even if its pid now belongs to another process.
			const old = Boolean(st && Date.now() - st.mtimeMs > 60_000);
			const abandoned = old || (Number.isNaN(owner) ? Boolean(st && Date.now() - st.mtimeMs > 5_000) : !pidAlive(owner));
			if (abandoned) {
				const stolen = `${lock}.stale-${process.pid}-${Date.now()}`;
				try {
					renameSync(lock, stolen);
					let took = Number.NaN;
					try {
						took = Number(readFileSync(join(stolen, "pid"), "utf8"));
					} catch {
						/* no pid */
					}
					// Took a different, live lock than the one judged abandoned: put it back.
					if (!old && !Number.isNaN(took) && took !== owner && pidAlive(took)) renameSync(stolen, lock);
					else rmSync(stolen, { recursive: true, force: true });
				} catch {
					/* another waiter took it first */
				}
				continue;
			}
			if (Date.now() > deadline) throw new Error(`The library is locked by process ${owner} (${lock}).`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		return fn();
	} finally {
		// Remove the lock only if it is still ours.
		try {
			if (readFileSync(join(lock, "token"), "utf8") === token) rmSync(lock, { recursive: true, force: true });
		} catch {
			/* already gone */
		}
	}
}

/** Read, change and write the library as one locked step. */
function updateLibrary<T>(change: (library: Library) => T): T {
	return withLock(() => {
		const library = loadLibrary();
		const result = change(library);
		saveLibrary(library);
		return result;
	});
}

function saveLibrary(library: Library): void {
	const file = libraryFile();
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(library, null, "\t")}\n`);
	renameSync(tmp, file);
}

// --- Identifiers -------------------------------------------------------------------------

/** A DOI from a bare DOI, a doi: prefix, a doi.org URL, or an arXiv id (DataCite DOI). */
export function toDoi(input: string): string | undefined {
	const s = input.trim();
	const arxiv = /^(?:arxiv:|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})|(?:\d{4}\.\d{4,5}))(v\d+)?(?:\.pdf)?$/i.exec(s);
	if (arxiv) return `10.48550/arXiv.${arxiv[1]}`;
	const doi = /(?:^doi:|^https?:\/\/(?:dx\.)?doi\.org\/|^)(10\.\d{4,9}\/\S+)$/i.exec(s);
	if (!doi) return undefined;
	let decoded = doi[1];
	try {
		decoded = decodeURIComponent(doi[1]);
	} catch {
		// A bare "%" is legal in a DOI; keep it as typed.
	}
	// No whitespace or control characters, and no empty, "." or ".." path segments.
	if (/[\s\p{Cc}\p{Cf}]/u.test(decoded) || /(^|\/)\.{1,2}(\/|$)|\/\//.test(decoded)) return undefined;
	return decoded;
}

// --- Fetching ----------------------------------------------------------------------------

const base = {
	doi: () => process.env.TABKYRA_DOI_BASE || "https://doi.org",
	openalex: () => process.env.TABKYRA_OPENALEX_BASE || "https://api.openalex.org",
	crossref: () => process.env.TABKYRA_CROSSREF_BASE || "https://api.crossref.org",
};
const USER_AGENT = `tabkyra/${VERSION} (https://github.com/baney75/tabkyra)`;

async function get(url: string, accept: string): Promise<Response> {
	return fetch(url, { headers: { Accept: accept, "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
}

/** Drop control and format characters (hidden text) and collapse whitespace. */
export function clean(value: unknown, max = 1000): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/[\p{Cc}\p{Cf}\p{Co}\u{FE00}-\u{FE0F}\u{E0000}-\u{E01EF}]/gu, " ")
		// Only tag-shaped text: "n<10 versus n>50" in a title stays as it is.
		.replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]{0,200})?>/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function first(value: unknown): string {
	return clean(Array.isArray(value) ? value[0] : value);
}

function cleanNames(value: unknown): CslName[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const names = value
		.slice(0, 100)
		.filter((n): n is Record<string, unknown> => Boolean(n) && typeof n === "object")
		.map((n: Record<string, unknown>) => ({ family: clean(n.family, 200) || undefined, given: clean(n.given, 200) || undefined, literal: clean(n.literal ?? n.name, 300) || undefined }))
		.filter((n) => n.family || n.literal);
	return names.length ? names : undefined;
}

function cleanIssued(value: unknown): LibraryItem["issued"] {
	const parts = (value as { "date-parts"?: unknown })?.["date-parts"];
	if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
	const [y, m, d] = (parts[0] as unknown[]).slice(0, 3).map(Number);
	if (!Number.isInteger(y) || y < 1000 || y > 9999) return undefined;
	const date = [y];
	if (Number.isInteger(m) && m >= 1 && m <= 12) {
		date.push(m);
		if (Number.isInteger(d) && d >= 1 && d <= 31) date.push(d);
	}
	return { "date-parts": [date] };
}

/** doi.org itself, or a registration agency's metadata service: the only hosts whose answers count. */
function registryHost(url: string): boolean {
	const doiHost = new URL(base.doi()).host;
	let host = doiHost;
	try {
		if (url) host = new URL(url).host;
	} catch {
		return false;
	}
	return host === doiHost || /(^|\.)(crossref\.org|datacite\.org|medra\.org|jalc\.or\.jp|kisti\.re\.kr|doi\.org)$/i.test(host);
}

/** A DOI as a URL path: each segment encoded, so "#" and "?" in a suffix stay part of the DOI. */
function doiPath(doi: string): string {
	return doi.split("/").map(encodeURIComponent).join("/");
}

/** Which agency registered the DOI ("crossref", "datacite", ...), from doi.org; "" if unknown. */
async function registrationAgency(doi: string): Promise<string> {
	try {
		const res = await get(`${base.doi()}/ra/${doiPath(doi)}`, "application/json");
		if (!res.ok) return "";
		const body = (await res.json()) as Array<{ RA?: string }>;
		return Array.isArray(body) ? clean(body[0]?.RA, 50).toLowerCase() : "";
	} catch {
		return "";
	}
}

async function fetchCsl(doi: string): Promise<Record<string, unknown>> {
	const res = await get(`${base.doi()}/${doiPath(doi)}`, "application/vnd.citationstyles.csl+json");
	const doiHost = new URL(base.doi()).host;
	const finalHost = res.url ? new URL(res.url).host : doiHost;
	// Only doi.org itself answering 404 means the DOI isn't registered.
	if (res.status === 404 && finalHost === doiHost) throw new Error(`DOI ${doi} is not registered (doi.org returned 404). It may be mistyped or made up.`);
	if ((res.status === 429 || res.status >= 500) && finalHost === doiHost) {
		throw new Error(`doi.org couldn't answer for ${doi} (HTTP ${res.status}). Nothing was checked; try again later.`);
	}
	const type = clean(res.headers.get("content-type") ?? "", 100);
	const host = clean(finalHost, 255);
	// Metadata counts only from doi.org or a registration agency's metadata service, never
	// from a registrant's own site that a redirect landed on.
	const registry = registryHost(res.url);
	if (!res.ok || !/json/i.test(type) || !registry) {
		throw new Error(`DOI ${doi} is registered, but its agency returned no citation metadata (${res.status} ${type || "no type"} from ${host}). Check it by hand before citing.`);
	}
	return (await res.json()) as Record<string, unknown>;
}

/**
 * Retraction and access checks. A check that fails leaves the answer unknown (complete:
 * false). A retraction already recorded in `previous` is never cleared by a failed check.
 */
async function verify(doi: string, previous?: Verification, agency = ""): Promise<Verification> {
	const v: Verification = { at: new Date().toISOString(), sources: ["doi.org"], retracted: false, notices: [], checks: { openalex: "failed", crossref: "failed" } };
	const checks = v.checks as NonNullable<Verification["checks"]>;
	try {
		const res = await get(`${base.openalex()}/works/doi:${doiPath(doi)}?select=is_retracted,open_access,cited_by_count`, "application/json");
		if (res.status === 404) checks.openalex = "not-found";
		else if (res.ok) {
			const w = (await res.json()) as { is_retracted?: boolean; open_access?: { oa_url?: string }; cited_by_count?: number };
			// An answer without the field is not an answer, and isn't listed as a source.
			if (typeof w.is_retracted === "boolean") {
				checks.openalex = "ok";
				v.sources.push("openalex");
			}
			if (w.is_retracted) v.retracted = true;
			try {
				const oa = new URL(clean(w.open_access?.oa_url, 2000));
				if (oa.protocol === "https:") v.oaUrl = oa.href;
			} catch {
				/* no usable open-access link */
			}
			if (Number.isInteger(w.cited_by_count)) v.citedBy = w.cited_by_count;
		}
	} catch {
		/* left as failed */
	}
	// Unknown agency: Crossref is still asked, but completeness waits for the agency (below).
	if (agency && agency !== "crossref") checks.crossref = "n/a";
	else {
		try {
			const res = await get(`${base.crossref()}/works?filter=updates:${encodeURIComponent(doi)}&select=DOI,update-to&rows=1000`, "application/json");
			if (res.ok) {
				const body = (await res.json()) as { message?: { "total-results"?: unknown; items?: unknown } };
				const total = body.message?.["total-results"];
				const listed = body.message?.items;
				if (typeof total === "number" && Array.isArray(listed) && total <= listed.length) {
					const notices: Verification["notices"] = [];
					let retracted = false;
					for (const item of listed as Array<{ DOI?: unknown; "update-to"?: unknown }>) {
						// Every notice must parse; anything malformed leaves the check failed.
						if (!item || typeof item !== "object" || !Array.isArray(item["update-to"])) throw new Error("malformed notice");
						for (const u of item["update-to"] as Array<{ type?: unknown; DOI?: unknown }>) {
							if (!u || typeof u.DOI !== "string" || typeof u.type !== "string") throw new Error("malformed notice");
							if (u.DOI.toLowerCase() !== doi.toLowerCase()) continue;
							const type = clean(u.type, 50).toLowerCase();
							notices.push({ type, doi: clean(item.DOI, 200) });
							if (/^(retraction|partial[_ ]retraction|withdrawal|removal)$/.test(type)) retracted = true;
						}
					}
					// Crossref also lists updates on the work's own record (updated-by), which is
					// where Retraction Watch data appears; both must be read.
					const own = await get(`${base.crossref()}/works/${doiPath(doi)}`, "application/json");
					if (!own.ok) throw new Error("work record unavailable");
					const record = (await own.json()) as { message?: { "updated-by"?: unknown } };
					const updatedBy = record.message?.["updated-by"] ?? [];
					if (!Array.isArray(updatedBy)) throw new Error("malformed updated-by");
					for (const u of updatedBy as Array<{ type?: unknown; DOI?: unknown }>) {
						if (!u || typeof u.type !== "string") throw new Error("malformed updated-by");
						const type = clean(u.type, 50).toLowerCase();
						notices.push({ type, doi: clean(u.DOI, 200) });
						if (/^(retraction|partial[_ ]retraction|withdrawal|removal)$/.test(type)) retracted = true;
					}
					v.sources.push("crossref-updates");
					v.notices.push(...uniqueNotices(notices));
					if (retracted) v.retracted = true;
					checks.crossref = "ok";
				}
			}
		} catch {
			/* left as failed */
		}
	}
	// OpenAlex not knowing the work leaves the question open, so it isn't complete.
	// Without the registration agency, it isn't known which notices apply.
	v.complete = Boolean(agency) && checks.openalex === "ok" && (checks.crossref === "ok" || checks.crossref === "n/a");
	return previous ? keepRetraction(v, previous) : v;
}

/** Crossref sometimes answers with its own type names; map them to CSL's. */
const CROSSREF_TYPES: Record<string, string> = {
	"journal-article": "article-journal",
	"book-chapter": "chapter",
	"book-section": "chapter",
	"proceedings-article": "paper-conference",
	"posted-content": "article",
	dissertation: "thesis",
	monograph: "book",
	"edited-book": "book",
	"reference-book": "book",
	"report-component": "report",
};

function cslType(type: string): string {
	return Object.hasOwn(CROSSREF_TYPES, type) ? CROSSREF_TYPES[type] : /^[a-z][a-z-]{0,40}$/.test(type) ? type : "article";
}

// --- Citekeys ----------------------------------------------------------------------------

const STOP = new Set(["a", "an", "the", "on", "of", "in", "for", "and", "to", "with", "from", "by", "at", "is", "are", "retracted", "withdrawn"]);

function ascii(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

export function citekey(item: Pick<LibraryItem, "author" | "issued" | "title">, taken: Set<string>): string {
	const who = ascii(item.author?.[0]?.family ?? item.author?.[0]?.literal ?? "anon").slice(0, 20) || "anon";
	const year = item.issued?.["date-parts"]?.[0]?.[0] ?? "nd";
	const word = ascii(item.title.split(/[\s\-\u2010-\u2015/]+/).find((w) => ascii(w).length > 2 && !STOP.has(ascii(w))) ?? "").slice(0, 20);
	const stem = `${who}${year}${word}`;
	if (!taken.has(stem)) return stem;
	for (const suffix of "abcdefghijklmnopqrstuvwxyz") if (!taken.has(`${stem}${suffix}`)) return `${stem}${suffix}`;
	for (let n = 2; ; n++) if (!taken.has(`${stem}${n}`)) return `${stem}${n}`;
}

// --- Commands ----------------------------------------------------------------------------

export interface AddOptions {
	quote?: string;
	location?: string;
	note?: string;
	tags?: string[];
}

export async function addSource(input: string, options: AddOptions = {}): Promise<{ item: LibraryItem; existed: boolean }> {
	const doi = toDoi(input);
	if (!doi) throw new Error(`"${input}" is not a DOI, doi.org link or arXiv id. Find the source's DOI first.`);
	const known = loadLibrary().items.find((i) => i.DOI?.toLowerCase() === doi.toLowerCase());
	// Network first; the library is read and written only after, so a parallel add isn't lost.
	const csl = known ? undefined : await fetchCsl(doi);
	const agency = known?.tabkyra.agency || (await registrationAgency(doi));
	let verified = await verify(doi, known?.tabkyra.verified, agency);
	const record = csl;
	// An alias DOI answers with its primary DOI; notices attach to the primary, so check both.
	const named = toDoi(clean(record?.DOI, 300));
	const primary = known?.tabkyra.primaryDoi ?? (named && named.toLowerCase() !== doi.toLowerCase() ? named : undefined);
	if (primary) verified = mergeVerification(verified, await verify(primary, known?.tabkyra.verified, await registrationAgency(primary)));
	return updateLibrary((library) => {
		const existing = library.items.find((i) => i.DOI?.toLowerCase() === doi.toLowerCase());
		if (existing) {
			// Adding again re-checks retractions, so a source retracted since is caught.
			existing.tabkyra.verified = withTitleCheck(existing.title, keepRetraction(verified, existing.tabkyra.verified));
			if (agency) existing.tabkyra.agency = agency;
			mergeAnnotations(existing, options);
			return { item: existing, existed: true };
		}
		if (!record) throw new Error(`${doi} was removed while it was being added. Add it again.`);
		const title = first(record.title);
		if (!title) throw new Error(`The record for ${doi} has no title.`);
		const draft = {
			type: cslType(clean(record.type, 50)),
			title,
			author: cleanNames(record.author) ?? cleanNames(record.editor),
			issued: cleanIssued(record.issued) ?? cleanIssued(record.published) ?? cleanIssued(record.created),
			"container-title": first(record["container-title"]) || undefined,
			publisher: clean(record.publisher, 300) || undefined,
			volume: clean(record.volume, 50) || undefined,
			issue: clean(record.issue, 50) || undefined,
			page: clean(record.page, 50) || undefined,
			// The requested DOI is the identity: it is what was verified and what the URL points at.
			DOI: doi,
			URL: `https://doi.org/${doiPath(doi)}`,
		};
		const item: LibraryItem = {
			id: citekey(draft, new Set(library.items.map((i) => i.id))),
			...draft,
			tabkyra: {
				addedAt: new Date().toISOString(),
				verified: withTitleCheck(title, verified),
				tags: [],
				...(primary ? { primaryDoi: primary } : {}),
				...(agency ? { agency } : {}),
			},
		};
		mergeAnnotations(item, options);
		library.items.push(item);
		return { item, existed: false };
	});
}

/** A title that announces a retraction ("RETRACTED: ...", "WITHDRAWN: ..."), even when no notice is linked. */
function titleSaysRetracted(title: string): boolean {
	return /^\s*(retracted|withdrawn)( article)?\s*:/i.test(title);
}

function withTitleCheck(title: string, v: Verification): Verification {
	return titleSaysRetracted(title) && !v.retracted ? { ...v, retracted: true, notices: [...v.notices, { type: "title says retracted", doi: "" }] } : v;
}

/**
 * A recorded retraction is cleared only when both sources answered and neither flags it.
 * An OpenAlex 404 ("not-found") isn't enough: the work may have been merged or re-keyed.
 */
function keepRetraction(next: Verification, previous: Verification): Verification {
	const bothAnswered = next.checks?.openalex === "ok" && (next.checks?.crossref === "ok" || next.checks?.crossref === "n/a");
	return previous.retracted && !next.retracted && !bothAnswered ? { ...next, retracted: true, notices: uniqueNotices(previous.notices) } : next;
}

/**
 * Crossref lists most notices twice, once from the notice's own record (`update-to`) and once
 * on the work's record (`updated-by`). Keep one per type and notice DOI. A notice without a
 * DOI can't be told apart from another of the same type, so each one is kept.
 */
function uniqueNotices(notices: Verification["notices"]): Verification["notices"] {
	const seen = new Set<string>();
	return notices.filter((n) => {
		if (!n.doi) return true;
		const key = `${n.type} ${n.doi.toLowerCase()}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Notices from two checks of one work. DOI-less notices repeated within one check are kept, but
 * the same one reported by both checks counts once: keep the larger count per type.
 */
function mergeNotices(a: Verification["notices"], b: Verification["notices"]): Verification["notices"] {
	const count = (list: Verification["notices"]) => {
		const m = new Map<string, number>();
		for (const n of list) if (!n.doi) m.set(n.type, (m.get(n.type) ?? 0) + 1);
		return m;
	};
	const inA = count(a);
	const extra = new Map([...count(b)].map(([type, n]) => [type, n - (inA.get(type) ?? 0)]));
	const fromB = b.filter((n) => {
		if (n.doi) return true;
		const left = extra.get(n.type) ?? 0;
		extra.set(n.type, left - 1);
		return left > 0;
	});
	return uniqueNotices([...a, ...fromB]);
}

/** Combine checks of two DOIs for one work (an alias and its primary). */
function mergeVerification(a: Verification, b: Verification): Verification {
	return {
		...a,
		retracted: a.retracted || b.retracted,
		notices: mergeNotices(a.notices, b.notices),
		sources: [...new Set([...a.sources, ...b.sources])],
		complete: Boolean(a.complete && b.complete),
		checks:
			a.checks && b.checks
				? {
						openalex: a.checks.openalex === "ok" && b.checks.openalex === "ok" ? "ok" : a.checks.openalex === "failed" || b.checks.openalex === "failed" ? "failed" : "not-found",
						crossref: a.checks.crossref === "failed" || b.checks.crossref === "failed" ? "failed" : a.checks.crossref === "ok" || b.checks.crossref === "ok" ? "ok" : "n/a",
					}
				: a.checks,
		oaUrl: a.oaUrl ?? b.oaUrl,
	};
}

function mergeAnnotations(item: LibraryItem, options: AddOptions): void {
	if (options.quote) item.tabkyra.quote = { text: clean(options.quote, 2000), location: clean(options.location, 100) || undefined };
	if (options.note) item.tabkyra.note = clean(options.note, 4000);
	for (const tag of options.tags ?? []) {
		const t = clean(tag, 50);
		if (t && !item.tabkyra.tags.includes(t)) item.tabkyra.tags.push(t);
	}
}

export async function reverify(keys: string[]): Promise<{ items: LibraryItem[]; missing: string[] }> {
	const before = loadLibrary();
	const targets = keys.length ? before.items.filter((i) => keys.includes(i.id)) : before.items;
	const missing = keys.filter((k) => !before.items.some((i) => i.id === k));
	// Keyed by id and DOI: a result applies only to the very item it was computed for.
	const results = new Map<string, Verification>();
	const keyOf = (i: LibraryItem) => `${i.id}\u0000${i.DOI}\u0000${i.tabkyra.addedAt}`;
	const agencies = new Map<string, string>();
	for (const item of targets) {
		if (!item.DOI) continue;
		const agency = item.tabkyra.agency || (await registrationAgency(item.DOI));
		agencies.set(keyOf(item), agency);
		let v = await verify(item.DOI, item.tabkyra.verified, agency);
		if (item.tabkyra.primaryDoi) v = mergeVerification(v, await verify(item.tabkyra.primaryDoi, item.tabkyra.verified, await registrationAgency(item.tabkyra.primaryDoi)));
		results.set(keyOf(item), v);
	}
	// Apply to a fresh, locked copy, so anything added meanwhile is kept.
	const items = updateLibrary((library) => {
		for (const item of library.items) {
			const v = results.get(keyOf(item));
			if (v) item.tabkyra.verified = withTitleCheck(item.title, keepRetraction(v, item.tabkyra.verified));
			const agency = agencies.get(keyOf(item));
			if (agency) item.tabkyra.agency = agency;
		}
		return library.items.filter((i) => results.has(keyOf(i)));
	});
	return { items, missing };
}

export function search(query: string): LibraryItem[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return loadLibrary().items.filter((i) => {
		const hay = [i.id, i.title, i["container-title"], i.DOI, ...(i.author ?? []).map((a) => `${a.given ?? ""} ${a.family ?? a.literal ?? ""}`), ...i.tabkyra.tags, i.tabkyra.note]
			.join(" ")
			.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

export function removeSource(key: string): boolean {
	return updateLibrary((library) => {
		const before = library.items.length;
		library.items = library.items.filter((i) => i.id !== key);
		return library.items.length !== before;
	});
}

const STYLES = new Set(["apa", "modern-language-association", "chicago-author-date", "ieee", "harvard-cite-them-right", "vancouver"]);
const STYLE_ALIASES: Record<string, string> = { mla: "modern-language-association", chicago: "chicago-author-date", harvard: "harvard-cite-them-right" };

/** A formatted reference from doi.org's citation formatter (CSL styles). */
export async function cite(key: string, style = "apa"): Promise<string> {
	const item = loadLibrary().items.find((i) => i.id === key);
	if (!item) throw new Error(`No source with key ${key}. Run tabkyra library search.`);
	const csl = Object.hasOwn(STYLE_ALIASES, style) ? STYLE_ALIASES[style] : style;
	if (!STYLES.has(csl)) throw new Error(`Unknown style ${style}. Use apa, mla, chicago, ieee, harvard or vancouver.`);
	if (!item.DOI) throw new Error(`${key} has no DOI to format.`);
	const res = await get(`${base.doi()}/${doiPath(item.DOI)}`, `text/x-bibliography; style=${csl}; locale=en-US`);
	const type = clean(res.headers.get("content-type") ?? "", 100);
	if (!res.ok || /html/i.test(type) || !/text\/(x-bibliography|plain)/i.test(type) || !registryHost(res.url)) {
		throw new Error(`doi.org returned no formatted reference for ${key} (${res.status} ${type || "no type"}). Format it from the saved record instead.`);
	}
	// The formatter leaves an empty "edited by ," when a record has no editors.
	const text = clean(await res.text(), 3000).replace(/,? edited by ,/g, ",");
	return `${warningPrefix(item)}${text}`;
}

/** The mark every output carries for a source that is retracted or not fully checked. */
function warning(item: LibraryItem): string | undefined {
	const v = item.tabkyra.verified;
	const marks = [
		v.retracted ? "RETRACTED" : "",
		v.notices.some((n) => /concern/.test(n.type)) ? "EXPRESSION OF CONCERN" : "",
		!v.retracted && v.complete === false ? "RETRACTION CHECK INCOMPLETE" : "",
	].filter(Boolean);
	return marks.length ? marks.join("; ") : undefined;
}

function warningPrefix(item: LibraryItem): string {
	const w = warning(item);
	return w ? `[${w}] ` : "";
}

// --- Export ------------------------------------------------------------------------------

const BIBTEX_TYPE: Record<string, string> = {
	"article-journal": "article",
	article: "misc",
	book: "book",
	chapter: "incollection",
	"paper-conference": "inproceedings",
	report: "techreport",
	thesis: "phdthesis",
	"posted-content": "misc",
	dataset: "misc",
};

// Braces become commands, not \{ \}: BibTeX counts every brace when it finds a field's end.
const BIB_SPECIAL: Record<string, string> = {
	"\\": "\\textbackslash{}",
	"~": "\\textasciitilde{}",
	"^": "\\textasciicircum{}",
	"{": "\\textbraceleft{}",
	"}": "\\textbraceright{}",
};

/** One pass, so a replacement is never escaped again. */
function bibEscape(s: string): string {
	return s.replace(/[\\{}&%$#_~^]/g, (c) => (Object.hasOwn(BIB_SPECIAL, c) ? BIB_SPECIAL[c] : `\\${c}`));
}

/** BibTeX authors; a corporate or literal name is braced so it stays one name. */
function bibNames(item: LibraryItem): string {
	return (item.author ?? [])
		.map((a) => {
			// A part holding " and " or a comma would split or reorder names, so it is braced.
			const part = (x: string) => (/\band\b|,/i.test(x) ? `{${bibEscape(x)}}` : bibEscape(x));
			return a.family ? (a.given ? `${part(a.family)}, ${part(a.given)}` : part(a.family)) : `{${bibEscape(a.literal ?? "")}}`;
		})
		.join(" and ");
}

function names(item: LibraryItem, sepBy: string): string {
	return (item.author ?? []).map((a) => (a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : (a.literal ?? ""))).join(sepBy);
}

function year(item: LibraryItem): string {
	return String(item.issued?.["date-parts"]?.[0]?.[0] ?? "");
}

export function toBibtex(items: LibraryItem[]): string {
	return items
		.map((i) => {
			const fields: Array<[string, string | undefined]> = [
				["title", i.title],
				["author", bibNames(i)],
				["year", year(i)],
				[i.type === "article-journal" ? "journal" : "booktitle", i["container-title"]],
				["publisher", i.publisher],
				["volume", i.volume],
				["number", i.issue],
				["pages", i.page?.replace(/-/g, "--")],
				// biblatex reads doi verbatim: write it as is, or not at all.
				["doi", i.DOI && !/[{}\\]/.test(i.DOI) ? i.DOI : undefined],
				["url", i.DOI ? `https://doi.org/${doiPath(i.DOI)}` : i.URL],
				["note", warning(i)],
			];
			const body = fields
				.filter(([, v]) => v)
				.map(([k, v]) => `  ${k} = {${k === "url" ? (v as string).replace(/[{}\\]/g, "") : k === "author" || k === "doi" ? v : bibEscape(v as string)}}`)
				.join(",\n");
			return `@${Object.hasOwn(BIBTEX_TYPE, i.type) ? BIBTEX_TYPE[i.type] : "misc"}{${i.id},\n${body}\n}`;
		})
		.join("\n\n")
		.concat(items.length ? "\n" : "");
}

const RIS_TYPE: Record<string, string> = {
	"article-journal": "JOUR",
	book: "BOOK",
	chapter: "CHAP",
	"paper-conference": "CONF",
	report: "RPRT",
	thesis: "THES",
	dataset: "DATA",
};

export function toRis(items: LibraryItem[]): string {
	return items
		.map((i) => {
			const [sp, ep] = (i.page ?? "").split("-");
			const lines = [
				`TY  - ${Object.hasOwn(RIS_TYPE, i.type) ? RIS_TYPE[i.type] : "GEN"}`,
				`ID  - ${i.id}`,
				...(i.author ?? []).map((a) => `AU  - ${a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : (a.literal ?? "")}`),
				`TI  - ${i.title}`,
				i["container-title"] ? `T2  - ${i["container-title"]}` : "",
				year(i) ? `PY  - ${year(i)}` : "",
				i.volume ? `VL  - ${i.volume}` : "",
				i.issue ? `IS  - ${i.issue}` : "",
				sp ? `SP  - ${sp}` : "",
				ep ? `EP  - ${ep}` : "",
				i.publisher ? `PB  - ${i.publisher}` : "",
				i.DOI ? `DO  - ${i.DOI}` : "",
				i.DOI ? `UR  - https://doi.org/${doiPath(i.DOI)}` : i.URL ? `UR  - ${i.URL}` : "",
				warning(i) ? `N1  - ${warning(i)}` : "",
				"ER  - ",
			];
			// Each value stays on its own tag line.
			return lines
				.filter(Boolean)
				.map((l) => l.replace(/[\r\n]+/g, " "))
				.join("\n");
		})
		.join("\n\n")
		.concat(items.length ? "\n" : "");
}

export function toCslJson(items: LibraryItem[]): string {
	return `${JSON.stringify(
		// A retracted source keeps a visible mark in every format, CSL included.
		items.map((i) => {
			const { tabkyra: _t, ...csl } = i;
			const w = warning(i);
			return { ...csl, ...(i.DOI ? { URL: `https://doi.org/${doiPath(i.DOI)}` } : {}), ...(w ? { note: w } : {}) };
		}),
		null,
		2,
	)}\n`;
}

/** A YAML string Obsidian won't turn into a link: properties treat "[[...]]" as one. */
function yamlText(value: unknown): string {
	const unlink = (v: unknown): unknown => (typeof v === "string" ? v.replace(/\[\[/g, "[ [").replace(/\]\]/g, "] ]") : Array.isArray(v) ? v.map(unlink) : v);
	return JSON.stringify(unlink(value));
}

/** Text safe inside a Markdown line: no wikilink, embed or HTML syntax from fetched metadata. */
function md(s: string): string {
	// Defang URL schemes first (Obsidian autolinks bare URLs), then escape inline markup.
	return s.replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, "$1[:]//").replace(/[\\[\]<>`|*_!%$=~^#&]/g, (c) => `\\${c}`);
}

const GENERATED = "tabkyra-generated";

function noteStatus(i: LibraryItem): string {
	return warning(i)?.toLowerCase() ?? "verified";
}

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * One Obsidian note per source, named by citekey, inside `<vault>/<folder>`. The folder is
 * walked one segment at a time and a symbolic link anywhere stops it, before anything is
 * created. A note is replaced only if Tabkyra wrote it and nobody edited it since.
 */
export function writeObsidian(vault: string, folder = "Sources"): { written: string[]; kept: string[]; stale: string[] } {
	// The vault itself may be a link (iCloud, Dropbox); folders inside it may not.
	if (!existsSync(vault) || !statSync(vault).isDirectory()) throw new Error(`${vault} is not a folder.`);
	const root = realpathSync(vault);
	let dir = root;
	for (const segment of folder.split(/[/\\]+/).filter(Boolean)) {
		if (segment === "." || segment === "..") throw new Error(`${folder} is outside the vault.`);
		dir = join(dir, segment);
		const st = lstatSync(dir, { throwIfNoEntry: false });
		if (st?.isSymbolicLink()) throw new Error(`${folder} leads outside the vault through a symbolic link.`);
		if (st && !st.isDirectory()) throw new Error(`${dir} is not a folder.`);
		if (!st) mkdirSync(dir);
	}
	const written: string[] = [];
	const kept: string[] = [];
	/** Kept notes whose source is now retracted or not fully checked: the note shows no warning. */
	const stale: string[] = [];
	for (const i of loadLibrary().items) {
		if (!/^[a-z0-9]+$/.test(i.id)) continue;
		const file = join(dir, `${i.id}.md`);
		// lstat, not exists: a dangling link reports as missing to existsSync.
		const st = lstatSync(file, { throwIfNoEntry: false });
		if (st && !st.isFile()) {
			kept.push(file);
			if (warning(i)) stale.push(`${warning(i)}: ${file}`);
			continue;
		}
		if (st) {
			const old = readFileSync(file, "utf8");
			const m = new RegExp(`^${GENERATED}: ([0-9a-f]{16})$`, "m").exec(old);
			if (!m || m[1] !== sha(old.replace(m[0], `${GENERATED}: `))) {
				kept.push(file);
				const shown = /^status: "(.*)"$/m.exec(old)?.[1];
				if (warning(i) && shown !== noteStatus(i)) stale.push(`${warning(i)}: ${file}`);
				continue;
			}
		}
		const v = i.tabkyra.verified;
		const status = noteStatus(i);
		const front = [
			"---",
			`title: ${yamlText(i.title)}`,
			`authors: ${yamlText((i.author ?? []).map((a) => [a.given, a.family ?? a.literal].filter(Boolean).join(" ")))}`,
			`year: ${JSON.stringify(year(i))}`,
			`citekey: ${i.id}`,
			i.DOI ? `doi: ${yamlText(i.DOI)}` : "",
			`verified: ${JSON.stringify(v.at.slice(0, 10))}`,
			`status: ${JSON.stringify(status)}`,
			`retracted: ${v.retracted}`,
			`tags: ${yamlText(["source", ...i.tabkyra.tags.map((t) => t.replace(/[^\w/-]/g, "-"))])}`,
			`${GENERATED}: `,
			"---",
		].filter(Boolean);
		let oa = "";
		try {
			// Percent-encode what Obsidian would read as markup, and any "%" that isn't an escape.
			if (v.oaUrl) oa = new URL(v.oaUrl).href.replace(/%(?![0-9A-Fa-f]{2})/g, "%25").replace(/[[\]<>|`]/g, (c) => encodeURIComponent(c));
		} catch {
			/* skipped */
		}
		const body = [
			`# ${md(i.title)}`,
			"",
			`${md(names(i, "; "))} (${year(i)}). ${i["container-title"] ? `*${md(i["container-title"])}*` : ""}`,
			i.DOI ? `DOI: <https://doi.org/${doiPath(i.DOI)}>` : "",
			v.retracted ? "\n> [!warning] Retracted\n> A retraction notice points at this DOI. Don't cite it as support." : "",
			!v.retracted && v.complete === false ? "\n> [!caution] Retraction check incomplete\n> Run tabkyra library verify before citing." : "",
			oa ? `Open access copy: <${oa}>` : "",
			i.tabkyra.quote ? `\n## Supporting quote\n\n> ${md(i.tabkyra.quote.text)}${i.tabkyra.quote.location ? `\n> (${md(i.tabkyra.quote.location)})` : ""}` : "",
			i.tabkyra.note ? `\n## Notes\n\n${md(i.tabkyra.note)}` : "",
		].filter((l) => l !== "");
		const draft = `${front.join("\n")}\n\n${body.join("\n\n")}\n`;
		// Set the hash on the marker line itself; fetched text elsewhere can't move it.
		const lines = draft.split("\n");
		lines[lines.indexOf(`${GENERATED}: `)] = `${GENERATED}: ${sha(draft)}`;
		const text = lines.join("\n");
		// Temp file + rename never writes through a link planted at the note's path.
		const tmp = join(dir, `.${i.id}.${process.pid}.tmp`);
		writeFileSync(tmp, text, { flag: "wx" });
		renameSync(tmp, file);
		written.push(file);
	}
	return { written, kept, stale };
}

// --- CLI ---------------------------------------------------------------------------------

function line(i: LibraryItem): string {
	const who = i.author?.[0]?.family ?? i.author?.[0]?.literal ?? "?";
	const w = warning(i);
	return `${i.id.padEnd(28)} ${who} ${year(i)}. ${i.title.slice(0, 90)}${w ? ` [${w}]` : ""}`;
}

export const LIBRARY_USAGE =
	"Usage: tabkyra library add <doi|arxiv id> [--quote TEXT] [--location TEXT] [--note TEXT] [--tag TAG] | list [--json] | search <words> [--json] | " +
	"verify [key...] | cite <key> [--style apa|mla|chicago|ieee|harvard|vancouver] | export --format bibtex|ris|csl [--out FILE] | " +
	"obsidian <vault> [--folder Sources] | remove <key>";

/**
 * Splits options from positionals: `--name value` or `--name=value`, and repeated `--tag`
 * collects. Only option names are checked against `allowed`; a value may start with "--".
 */
function parse(args: string[], allowed: string[]): { positional: string[]; opts: Record<string, string>; tags: string[] } {
	const positional: string[] = [];
	const opts: Record<string, string> = {};
	const tags: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--")) {
			positional.push(a);
			continue;
		}
		const eq = a.indexOf("=");
		const name = eq > 0 ? a.slice(0, eq) : a;
		if (!allowed.includes(name)) throw new Error(`This command doesn't take ${name}. ${LIBRARY_USAGE}`);
		if (name === "--json") {
			// A switch: "--json=false" must be refused, not read as on.
			if (eq > 0) throw new Error(`--json takes no value. ${LIBRARY_USAGE}`);
			opts.json = "1";
			continue;
		}
		const value = eq > 0 ? a.slice(eq + 1) : args[++i];
		if (value === undefined) throw new Error(`${name} needs a value. ${LIBRARY_USAGE}`);
		if (name === "--tag") tags.push(value);
		else opts[name.slice(2)] = value;
	}
	return { positional, opts, tags };
}

/** Options each subcommand reads; any other option is a usage error, not silently ignored. */
export const LIBRARY_OPTIONS: Record<string, string[]> = {
	add: ["--quote", "--location", "--note", "--tag"],
	list: ["--json"],
	search: ["--json"],
	verify: [],
	cite: ["--style"],
	export: ["--format", "--out"],
	obsidian: ["--folder"],
	remove: [],
};

/** A flat summary of a saved source, with the field names the tools and skills document. */
export function summary(item: LibraryItem): Record<string, unknown> {
	const v = item.tabkyra.verified;
	return {
		citekey: item.id,
		title: item.title,
		year: item.issued?.["date-parts"]?.[0]?.[0],
		doi: item.DOI,
		retracted: v.retracted,
		complete: v.complete !== false,
		checks: v.checks,
		notices: uniqueNotices(v.notices),
		citedBy: v.citedBy,
		oaUrl: v.oaUrl,
		quote: item.tabkyra.quote,
	};
}

export async function runLibrary(args: string[]): Promise<number> {
	const [sub, ...rest] = args;
	const allowed = sub && Object.hasOwn(LIBRARY_OPTIONS, sub) ? LIBRARY_OPTIONS[sub] : undefined;
	if (!allowed) throw new Error(LIBRARY_USAGE);
	const { positional, opts, tags } = parse(rest, allowed);
	switch (sub) {
		case "add": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			const { item, existed } = await addSource(positional[0], { quote: opts.quote, location: opts.location, note: opts.note, tags });
			const v = item.tabkyra.verified;
			console.log(`${existed ? "Updated" : "Added"} ${line(item)}`);
			console.log(`  verified by ${v.sources.join(", ")}${v.citedBy !== undefined ? `; cited by ${v.citedBy}` : ""}`);
			for (const n of uniqueNotices(v.notices)) console.log(`  notice: ${n.type} ${n.doi}`);
			if (v.retracted) {
				console.log("  RETRACTED: don't cite this as support.");
				return 3;
			}
			if (v.complete === false) {
				console.log("  Retraction check incomplete (OpenAlex or Crossref didn't answer). Run tabkyra library verify before citing.");
				return 4;
			}
			return 0;
		}
		case "list": {
			const items = loadLibrary().items;
			if (opts.json) console.log(JSON.stringify(items, null, 2));
			else for (const i of items) console.log(line(i));
			return 0;
		}
		case "search": {
			const hits = search(positional.join(" "));
			if (opts.json) console.log(JSON.stringify(hits, null, 2));
			else for (const i of hits) console.log(line(i));
			return hits.length ? 0 : 1;
		}
		case "verify": {
			const { items, missing } = await reverify(positional);
			for (const i of items) {
				console.log(`${line(i)}  (${i.tabkyra.verified.sources.join(", ")}${i.tabkyra.verified.complete === false ? "; check incomplete" : ""})`);
			}
			for (const k of missing) console.log(`No source with key ${k}.`);
			if (items.some((i) => i.tabkyra.verified.retracted)) return 3;
			if (missing.length) return 1;
			return items.some((i) => i.tabkyra.verified.complete === false) ? 4 : 0;
		}
		case "cite": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			console.log(await cite(positional[0], opts.style));
			return 0;
		}
		case "export": {
			const items = loadLibrary().items;
			const format = opts.format ?? "bibtex";
			const out = format === "bibtex" ? toBibtex(items) : format === "ris" ? toRis(items) : format === "csl" ? toCslJson(items) : undefined;
			if (out === undefined) throw new Error(`Unknown format ${format}. Use bibtex, ris or csl.`);
			if (opts.out) {
				writeFileSync(opts.out, out);
				console.log(`Wrote ${items.length} sources to ${opts.out}`);
			} else process.stdout.write(out);
			return 0;
		}
		case "obsidian": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			const { written, kept, stale } = writeObsidian(positional[0], opts.folder);
			console.log(`Wrote ${written.length} notes to ${join(positional[0], opts.folder ?? "Sources")}`);
			for (const k of kept) console.log(`  kept ${k}: you edited it, or Tabkyra didn't write it`);
			// A kept note can't show a new warning, so say it here, loudly.
			for (const x of stale) console.log(`  NOT UPDATED, ${x}. Add the warning to that note yourself.`);
			return stale.length ? 3 : 0;
		}
		case "remove": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			if (!removeSource(positional[0])) {
				console.log(`No source with key ${positional[0]}.`);
				return 1;
			}
			console.log(`Removed ${positional[0]}.`);
			return 0;
		}
		default:
			throw new Error(LIBRARY_USAGE);
	}
}
