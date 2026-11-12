/**
 * Documents as the agent uses them: get one in (from a web address, a tab, or a file's bytes), find passages across the
 * stored ones, and read pages by number. The side panel runs one of these itself; for outside agents the service
 * worker asks the offscreen page, which runs another over the same database (store.ts). Nothing here goes to the
 * network except the one download a get from a web address asks for.
 */
import { parseRange } from "../tools/document-reader.js";
import { listText, type NamedHit, readText, scannedNote, searchText, summaryText, unitWord } from "./format.js";
import {
	checkLimits,
	DocumentError,
	type Format,
	LIMITS,
	type Libs,
	type Parsed,
	parseBytes,
	parseText,
} from "./parse.js";
import { buildIndex, type DocIndex, search } from "./search.js";
import type { Backend, DocMeta, DocSource, StoredUnit } from "./store.js";

export interface Fetched {
	bytes: Uint8Array;
	mime: string;
	/** The file's name, from the response or the address. */
	name: string;
}

export type GetSource =
	| { url: string }
	| { bytes: Uint8Array; name: string; mime?: string; url?: string; source: Exclude<DocSource, "url"> }
	| { text: string; format: "html" | "markdown" | "text"; title?: string; url?: string; source: "tab" };

export interface GetOptions {
	/** Download again even when this address is stored. */
	refresh?: boolean;
	/** Link to a library source by citekey. */
	library?: string;
	title?: string;
	signal?: AbortSignal;
}

export interface ServiceOptions {
	backend: Backend;
	libs: Libs;
	/** Downloads a web address with the person's sign-in (fetch.ts). */
	fetch?: (url: string, signal?: AbortSignal) => Promise<Fetched>;
	now?: () => number;
}

export interface ReadOptions {
	/** "12", "40-55", "p. 40". */
	pages?: string;
	/** A heading from the outline, or a sheet's name. */
	section?: string;
	/** Words from a passage: reads the page that matches best and the one after it. */
	around?: string;
	offset?: number;
}

/** The address without the viewer's #page, so ...pdf and ...pdf#page=3 are one document. */
export function normalUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = "";
		return u.toString();
	} catch {
		return url.split("#")[0];
	}
}

async function sha256(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Without a text layer: no page has more than a few characters. */
export function isScanned(parsed: Parsed): boolean {
	if (parsed.format !== "pdf" || !parsed.units.length) return false;
	return parsed.units.every((u) => u.text.replace(/\s+/g, "").length < 20);
}

const TIMEOUT_MS = 180_000;

export class DocumentService {
	private cache = new Map<string, { added: number; index: DocIndex }>();
	private now: () => number;

	constructor(private options: ServiceOptions) {
		this.now = options.now ?? Date.now;
	}

	async list(): Promise<DocMeta[]> {
		return (await this.options.backend.all()).sort((a, b) => b.updated - a.updated);
	}

	async meta(id: string): Promise<DocMeta> {
		const m = await this.options.backend.meta(String(id ?? "").trim());
		if (!m)
			throw new DocumentError(
				`No stored document has the id ${JSON.stringify(id)}. documents {"action": "list"} shows the ids.`,
			);
		return m;
	}

	async rename(id: string, title: string): Promise<DocMeta> {
		const m = await this.meta(id);
		const t = String(title ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 200);
		if (!t) throw new DocumentError("A new title is needed.");
		const next = { ...m, title: t, updated: this.now() };
		await this.options.backend.saveMeta(next);
		return next;
	}

	async remove(id: string): Promise<DocMeta> {
		const m = await this.meta(id);
		await this.options.backend.remove(m.id);
		this.cache.delete(m.id);
		return m;
	}

	async clear(): Promise<number> {
		const n = (await this.options.backend.all()).length;
		await this.options.backend.clear();
		this.cache.clear();
		return n;
	}

	/** Brings a document in, or finds it already stored (same address, or same content from anywhere). */
	async get(
		source: GetSource,
		options: GetOptions = {},
	): Promise<{ meta: DocMeta; existing: boolean; summary: string }> {
		const done = (meta: DocMeta, existing: boolean) => ({ meta, existing, summary: summaryText(meta, existing) });
		const url = "url" in source && source.url ? normalUrl(source.url) : "";
		const all = await this.options.backend.all();
		if (url && !options.refresh && "url" in source && !("bytes" in source) && !("text" in source)) {
			const known = all.find((m) => m.url === url || m.urls.includes(url));
			if (known) return done(await this.touch(known, options, url), true);
		}
		const work = this.load(source, url, options.signal);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new DocumentError(
							"Reading the document took over 3 minutes, so it was stopped. A smaller file, or a range of its pages saved on its own, will go faster.",
						),
					),
				TIMEOUT_MS,
			);
		});
		let loaded: Awaited<typeof work>;
		try {
			loaded = await Promise.race([work, timeout]);
		} finally {
			clearTimeout(timer);
		}
		const { hash, bytes, fileName, origin } = loaded;
		const same = all.find((m) => m.hash === hash);
		if (same) return done(await this.touch(same, options, url), true);
		const parsed = await loaded.parse();
		let id = hash.slice(0, 8);
		if (all.some((m) => m.id === id)) id = hash.slice(0, 16);
		const units: StoredUnit[] = [];
		let offset = 0;
		parsed.units.forEach((u, i) => {
			units.push({ doc: id, n: i + 1, name: u.name, text: u.text, offset });
			offset += u.text.length + 2;
		});
		const now = this.now();
		const meta: DocMeta = {
			id,
			title: (options.title?.trim() || parsed.title || fileName).slice(0, 200),
			format: parsed.format,
			kind: parsed.kind,
			url,
			urls: [],
			source: origin,
			fileName,
			hash,
			bytes,
			units: units.length,
			chars: units.reduce((n, u) => n + u.text.length, 0),
			outline: parsed.outline,
			empty: units.filter((u) => !u.text.trim()).map((u) => u.n),
			scanned: isScanned(parsed),
			...(options.library?.trim() ? { library: options.library.trim() } : {}),
			added: now,
			updated: now,
		};
		const index = buildIndex(units.map((u) => u.text));
		if (options.signal?.aborted) throw new DocumentError("Stopped.");
		if (url && options.refresh) {
			for (const old of all.filter((m) => m.url === url)) await this.options.backend.remove(old.id);
		}
		await this.options.backend.save(meta, units, index);
		this.cache.set(id, { added: meta.added, index });
		return done(meta, false);
	}

	private async touch(m: DocMeta, options: GetOptions, url: string): Promise<DocMeta> {
		const next = { ...m, urls: [...m.urls] };
		if (url && url !== m.url && !next.urls.includes(url)) next.urls.push(url);
		if (!next.url && url) next.url = url;
		if (options.library?.trim()) next.library = options.library.trim();
		if (options.title?.trim()) next.title = options.title.trim().slice(0, 200);
		if (JSON.stringify(next) === JSON.stringify(m)) return m;
		next.updated = this.now();
		await this.options.backend.saveMeta(next);
		return next;
	}

	private async load(source: GetSource, url: string, signal?: AbortSignal) {
		const libs = this.options.libs;
		if ("text" in source) {
			const data = new TextEncoder().encode(source.text);
			if (data.byteLength > LIMITS.bytes)
				throw new DocumentError("The page's text is over the 60 MB documents can be.");
			const name = source.title?.trim() || (url ? new URL(url).hostname : "page");
			return {
				hash: await sha256(data),
				bytes: data.byteLength,
				fileName: name,
				origin: source.source as DocSource,
				parse: async () => {
					const p = parseText(source.text, source.format);
					if (source.title?.trim()) p.title = source.title.trim();
					if (!p.title) p.title = name;
					return checkLimits(p);
				},
			};
		}
		let bytes: Uint8Array;
		let name: string;
		let mime: string;
		let origin: DocSource;
		if ("bytes" in source) {
			({ bytes, name } = source);
			mime = source.mime ?? "";
			origin = source.source;
		} else {
			if (!/^(https?|file):/i.test(url))
				throw new DocumentError(`Not a web address: ${JSON.stringify(source.url)}.`);
			if (!this.options.fetch) throw new DocumentError("Downloading isn't available here.");
			({ bytes, name, mime } = await this.options.fetch(url, signal));
			origin = "url";
		}
		if (bytes.byteLength > LIMITS.bytes)
			throw new DocumentError(
				`The file is ${(bytes.byteLength / 1048576).toFixed(1)} MB, over the 60 MB documents can be.`,
			);
		return {
			hash: await sha256(bytes),
			bytes: bytes.byteLength,
			fileName: name,
			origin,
			parse: () => parseBytes(bytes, name, mime, libs),
		};
	}

	private async indexOf(m: DocMeta): Promise<DocIndex> {
		const hit = this.cache.get(m.id);
		if (hit && hit.added === m.added) return hit.index;
		const index = (await this.options.backend.index(m.id)) ?? { terms: {}, lengths: [] };
		this.cache.set(m.id, { added: m.added, index });
		while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value as string);
		return index;
	}

	/** Ranked passages over the given documents, or all of them. */
	async search(
		query: string,
		options: { docs?: readonly string[]; also?: readonly string[]; limit?: number } = {},
	): Promise<{ hits: NamedHit[]; searched: DocMeta[] }> {
		const all = await this.list();
		let searched = all;
		if (options.docs?.length) {
			const want = new Set(options.docs.map((d) => String(d).trim()));
			searched = all.filter((m) => want.has(m.id));
			const missing = [...want].filter((id) => !searched.some((m) => m.id === id));
			if (missing.length)
				throw new DocumentError(
					`No stored document has the id ${missing.map((m) => JSON.stringify(m)).join(", ")}. documents {"action": "list"} shows the ids.`,
				);
		}
		const texts = new Map<string, StoredUnit>();
		const docs = await Promise.all(
			searched
				.filter((m) => !m.scanned)
				.map(async (m) => ({
					id: m.id,
					index: await this.indexOf(m),
					text: async (n: number) => {
						const key = `${m.id}:${n}`;
						let u = texts.get(key);
						if (!u) {
							u = (await this.options.backend.units(m.id, n + 1, n + 1))[0];
							if (u) texts.set(key, u);
						}
						return u?.text ?? "";
					},
				})),
		);
		const raw = await search(docs, String(query ?? ""), { limit: options.limit, also: options.also });
		const byId = new Map(searched.map((m) => [m.id, m]));
		const hits = raw.map((h) => {
			const meta = byId.get(h.doc) as DocMeta;
			return { ...h, unit: h.unit + 1, meta, name: texts.get(`${h.doc}:${h.unit}`)?.name ?? "" };
		});
		return { hits, searched };
	}

	async searchText(
		query: string,
		options: { docs?: readonly string[]; also?: readonly string[]; limit?: number },
		budget: number,
	): Promise<string> {
		if (!String(query ?? "").trim()) throw new DocumentError("query needs a few words from the passage.");
		const { hits, searched } = await this.search(query, options);
		return searchText(query, hits, searched, budget);
	}

	/** The text of a range, a section or the page around a passage, inside the budget. */
	async read(id: string, options: ReadOptions, budget: number): Promise<string> {
		const m = await this.meta(id);
		const word = unitWord(m).toLowerCase();
		let first: number;
		let last: number;
		let lead = "";
		if (options.around?.trim()) {
			const { hits } = await this.search(options.around, { docs: [m.id], limit: 1 });
			if (!hits.length)
				throw new DocumentError(
					`No ${word} of ${m.id} matches ${JSON.stringify(options.around)}. Try other words, or read by pages.`,
				);
			first = hits[0].unit;
			last = Math.min(m.units, first + 1);
			lead = `Best match for ${JSON.stringify(options.around)}: ${word} ${first}.\n`;
		} else if (options.section?.trim()) {
			const range = this.sectionRange(m, options.section);
			if (!range) {
				const some = m.outline
					.slice(0, 12)
					.map((e) => JSON.stringify(e.title))
					.join(", ");
				throw new DocumentError(
					`No section of ${m.id} is called ${JSON.stringify(options.section)}.${some ? ` Its outline starts: ${some}.` : " It has no outline: read by pages."}`,
				);
			}
			({ first, last } = range);
		} else if (options.pages?.trim()) {
			const range = parseRange(options.pages, m.units);
			if (!range)
				throw new DocumentError(
					`pages takes one number or a range, like "12" or "40-55", not ${JSON.stringify(options.pages)}.`,
				);
			if (range.first > m.units)
				throw new DocumentError(`There is no ${word} ${range.first}: ${m.id} has ${m.units}.`);
			({ first, last } = range);
		} else {
			first = 1;
			last = m.units;
		}
		const units = await this.options.backend.units(m.id, first, last);
		const spec = first === last ? `${first}` : `${first}-${last}`;
		const scan = m.scanned ? `${scannedNote(m)}\n` : "";
		return readText(m, units, spec, Math.max(0, Math.floor(Number(options.offset) || 0)), budget, scan + lead).text;
	}

	private sectionRange(m: DocMeta, name: string): { first: number; last: number } | undefined {
		const want = name.toLowerCase().replace(/\s+/g, " ").trim();
		const entries = m.outline;
		let i = entries.findIndex((e) => e.title.toLowerCase() === want);
		if (i < 0) i = entries.findIndex((e) => e.title.toLowerCase().includes(want));
		if (i >= 0) {
			const e = entries[i];
			const next = entries.slice(i + 1).find((x) => x.level <= e.level && x.unit > e.unit);
			return { first: e.unit, last: Math.max(e.unit, (next?.unit ?? m.units + 1) - 1) };
		}
		return undefined;
	}

	/** Every unit of a document, in order (extract_document reads them as one). */
	async units(id: string): Promise<StoredUnit[]> {
		const m = await this.meta(id);
		return this.options.backend.units(m.id, 1, m.units);
	}

	async listText(): Promise<string> {
		return listText(await this.list());
	}

	async usage(): Promise<{ count: number; bytes: number; chars: number }> {
		const all = await this.list();
		return {
			count: all.length,
			bytes: all.reduce((n, m) => n + m.bytes, 0),
			chars: all.reduce((n, m) => n + m.chars, 0),
		};
	}
}

export type { DocMeta, Format };
