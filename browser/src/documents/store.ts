/**
 * Where documents live: an IndexedDB database named "polycarp-documents" in the extension's own origin, so it belongs
 * to one browser profile and never leaves the machine. Chrome keeps it in the profile folder, under
 * "IndexedDB/chrome-extension_<extension id>_0.indexeddb.leveldb". The side panel and the hidden offscreen page (which
 * answers outside agents) open the same database.
 *
 * Three object stores: `docs` (one record per document, without its text), `units` (each page or section's text,
 * keyed [doc, n]) and `index` (each document's search postings). The panel's settings list and clear it.
 */

import type { Format, OutlineEntry, UnitKind } from "./parse.js";
import type { DocIndex } from "./search.js";

export type DocSource = "url" | "tab" | "file" | "attachment";

export interface DocMeta {
	/** Short and stable: the first characters of the content's hash. */
	id: string;
	title: string;
	format: Format;
	kind: UnitKind;
	/** The address it came from, without the viewer's #page. Empty for a file. */
	url: string;
	/** Other addresses that had the same content. */
	urls: string[];
	source: DocSource;
	fileName: string;
	/** SHA-256 of the file's bytes (or the page's text), hex. */
	hash: string;
	bytes: number;
	units: number;
	chars: number;
	outline: OutlineEntry[];
	/** Units with no text: a PDF page that is only an image. */
	empty: number[];
	/** No text layer at all: a scan. */
	scanned: boolean;
	/** A library source's citekey this document belongs to. */
	library?: string;
	added: number;
	updated: number;
}

export interface StoredUnit {
	doc: string;
	/** 1-based. */
	n: number;
	name: string;
	text: string;
	/** Character offset of this unit in the whole document's text. */
	offset: number;
}

export interface Backend {
	all(): Promise<DocMeta[]>;
	meta(id: string): Promise<DocMeta | undefined>;
	/** Writes a document whole: its record, its units and its index, replacing any it had. */
	save(meta: DocMeta, units: StoredUnit[], index: DocIndex): Promise<void>;
	saveMeta(meta: DocMeta): Promise<void>;
	/** Units `first` to `last`, 1-based and inclusive, in order. */
	units(id: string, first: number, last: number): Promise<StoredUnit[]>;
	index(id: string): Promise<DocIndex | undefined>;
	remove(id: string): Promise<void>;
	clear(): Promise<void>;
}

/** For tests and for a browser that refuses IndexedDB: the same contract, kept in memory as copies. */
export class MemoryBackend implements Backend {
	private docs = new Map<string, DocMeta>();
	private texts = new Map<string, StoredUnit[]>();
	private indexes = new Map<string, DocIndex>();
	async all() {
		return [...this.docs.values()].map((m) => structuredClone(m));
	}
	async meta(id: string) {
		const m = this.docs.get(id);
		return m && structuredClone(m);
	}
	async save(meta: DocMeta, units: StoredUnit[], index: DocIndex) {
		this.docs.set(meta.id, structuredClone(meta));
		this.texts.set(meta.id, structuredClone(units));
		this.indexes.set(meta.id, structuredClone(index));
	}
	async saveMeta(meta: DocMeta) {
		if (this.docs.has(meta.id)) this.docs.set(meta.id, structuredClone(meta));
	}
	async units(id: string, first: number, last: number) {
		return structuredClone((this.texts.get(id) ?? []).filter((u) => u.n >= first && u.n <= last));
	}
	async index(id: string) {
		const i = this.indexes.get(id);
		return i && structuredClone(i);
	}
	async remove(id: string) {
		this.docs.delete(id);
		this.texts.delete(id);
		this.indexes.delete(id);
	}
	async clear() {
		this.docs.clear();
		this.texts.clear();
		this.indexes.clear();
	}
}

export const DB_NAME = "polycarp-documents";

const done = <T>(r: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
const finished = (t: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error ?? new Error("The document store refused the write."));
	});

export class IdbBackend implements Backend {
	private db?: Promise<IDBDatabase>;

	private open(): Promise<IDBDatabase> {
		this.db ??= new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				db.createObjectStore("docs", { keyPath: "id" });
				db.createObjectStore("units", { keyPath: ["doc", "n"] });
				db.createObjectStore("index", { keyPath: "doc" });
			};
			req.onsuccess = () => {
				// Another context upgrading later closes this one; open again next time.
				req.result.onversionchange = () => {
					req.result.close();
					this.db = undefined;
				};
				resolve(req.result);
			};
			req.onerror = () => {
				this.db = undefined;
				reject(req.error);
			};
		});
		return this.db;
	}

	async all() {
		const db = await this.open();
		return done(db.transaction("docs").objectStore("docs").getAll() as IDBRequest<DocMeta[]>);
	}
	async meta(id: string) {
		const db = await this.open();
		return done(db.transaction("docs").objectStore("docs").get(id) as IDBRequest<DocMeta | undefined>);
	}
	async save(meta: DocMeta, units: StoredUnit[], index: DocIndex) {
		const db = await this.open();
		const t = db.transaction(["docs", "units", "index"], "readwrite");
		const range = IDBKeyRange.bound([meta.id, 0], [meta.id, Number.MAX_SAFE_INTEGER]);
		t.objectStore("units").delete(range);
		for (const u of units) t.objectStore("units").put(u);
		t.objectStore("index").put({ doc: meta.id, ...index });
		t.objectStore("docs").put(meta);
		await finished(t);
	}
	async saveMeta(meta: DocMeta) {
		const db = await this.open();
		const t = db.transaction("docs", "readwrite");
		t.objectStore("docs").put(meta);
		await finished(t);
	}
	async units(id: string, first: number, last: number) {
		const db = await this.open();
		const range = IDBKeyRange.bound([id, first], [id, last]);
		return done(db.transaction("units").objectStore("units").getAll(range) as IDBRequest<StoredUnit[]>);
	}
	async index(id: string) {
		const db = await this.open();
		const row = await done(
			db.transaction("index").objectStore("index").get(id) as IDBRequest<(DocIndex & { doc: string }) | undefined>,
		);
		return row && { terms: row.terms, lengths: row.lengths };
	}
	async remove(id: string) {
		const db = await this.open();
		const t = db.transaction(["docs", "units", "index"], "readwrite");
		t.objectStore("units").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
		t.objectStore("index").delete(id);
		t.objectStore("docs").delete(id);
		await finished(t);
	}
	async clear() {
		const db = await this.open();
		const t = db.transaction(["docs", "units", "index"], "readwrite");
		for (const s of ["docs", "units", "index"]) t.objectStore(s).clear();
		await finished(t);
	}
}
