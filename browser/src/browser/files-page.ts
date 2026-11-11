/**
 * The page side of the `files` tool (src/bridge/files.ts): putting files on an input or dropping
 * them on an element, and fetching a URL the way the page itself could. Each function builds a
 * small script and runs it with runInPage; the functions named page* are stringified into that
 * script, so they must stay self-contained.
 */

import { acceptsFile } from "../bridge/file-util.js";
import { elementCode, runInPage } from "./page.js";

type Target = { ref?: string; selector?: string };

/**
 * A world of its own for fetching: the snapshot world's policy allows no network at all. A fetch
 * from it is the page's fetch (its origin, its cookies, its CORS rules), never the extension's.
 */
const FETCH_WORLD_ID = "polycarp-files";
const FETCH_CSP = "script-src 'unsafe-eval' 'unsafe-inline'; connect-src * data: blob:; default-src 'none';";

/** The file input an element stands for: itself, or the input its label names. Stringified. */
function pageFileInput(el: Element): HTMLInputElement | null {
	const W = (el.ownerDocument.defaultView || window) as typeof window;
	const isFile = (n: unknown): n is HTMLInputElement => n instanceof W.HTMLInputElement && n.type === "file";
	if (isFile(el)) return el;
	if (el instanceof W.HTMLLabelElement && isFile(el.control)) return el.control;
	return null;
}

export interface UploadTarget {
	kind: "input" | "drop";
	tag: string;
	multiple?: boolean;
	accept?: string;
	disabled?: boolean;
	/** The document the element was found in: its origin, and the mark this document carries (Bound). */
	origin: string;
	doc: string;
}

const STASH = "__polycarpUploads";
const DOC = "__polycarpDoc";

/**
 * The one document an upload was approved for: the page's origin, and a mark left in that document
 * when the upload began. A navigation or reload makes a new document, which has no mark, so a
 * script that carries a Bound can tell, at the moment it runs, that it is still in the same page.
 */
export interface Bound {
	origin: string;
	doc: string;
}

/** Where a script found itself when it was not in the document it was meant for. */
export interface Moved {
	moved: true;
	/** The host the tab is on now. */
	host: string;
	/** True when the origin is the approved one and only the document changed (a reload). */
	sameOrigin: boolean;
}

/**
 * Page-side statements that return a Moved, and drop what this upload stashed, unless the script
 * is running in the bound document. They come first in a script, before it touches file content.
 */
function boundCode(bound: Bound, id: string): string {
	return `const __origin = (() => { try { return String(location.origin); } catch (e) { return ""; } })();
		if (__origin !== ${JSON.stringify(bound.origin)} || globalThis.${DOC} !== ${JSON.stringify(bound.doc)}) {
			if (globalThis.${STASH}) delete globalThis.${STASH}[${JSON.stringify(id)}];
			return { moved: true, host: (() => { try { return String(location.hostname); } catch (e) { return ""; } })(), sameOrigin: __origin === ${JSON.stringify(bound.origin)} };
		}`;
}

/**
 * What the element at a ref is for an upload, before any content moves. Leaves `mark` in the
 * document if it has none yet, and reports the mark the document carries.
 */
export function probeUploadTarget(tabId: number, target: Target, mark: string): Promise<UploadTarget> {
	return runInPage(
		tabId,
		`(() => {
			${elementCode(target)}
			const doc = (globalThis.${DOC} = globalThis.${DOC} || ${JSON.stringify(mark)});
			const origin = String(location.origin);
			const input = (${pageFileInput.toString()})(el);
			if (!input) return { kind: "drop", tag: el.tagName.toLowerCase(), origin, doc };
			return { kind: "input", tag: "input", multiple: input.multiple, accept: input.accept || "", disabled: input.disabled, origin, doc };
		})()`,
	);
}

/**
 * Hand the bound document one piece of an upload; it keeps the pieces until commitUpload. Returns
 * how many it holds, or Moved (and keeps nothing) when the tab is no longer on that document.
 */
export function stashUploadChunk(tabId: number, id: string, b64: string, bound: Bound): Promise<number | Moved> {
	return runInPage(
		tabId,
		`(() => { ${boundCode(bound, id)} const s = (globalThis.${STASH} = globalThis.${STASH} || {}); (s[${JSON.stringify(id)}] = s[${JSON.stringify(id)}] || []).push("${b64}"); return s[${JSON.stringify(id)}].length; })()`,
	);
}

/** Drop an upload's pieces. `gone` leaves a mark in their place, so a commitUpload already on its way sets nothing. */
export function dropUploadStash(tabId: number, id: string, gone = false): Promise<unknown> {
	const at = `s[${JSON.stringify(id)}]`;
	return runInPage(
		tabId,
		`(() => { const s = (globalThis.${STASH} = globalThis.${STASH} || {}); ${gone ? `${at} = null` : `delete ${at}`}; return true; })()`,
	);
}

export interface UploadMeta {
	name: string;
	bytes: number;
	mime: string;
	lastModified: number;
}

export type UploadOutcome =
	| Moved
	| { refused: string }
	| {
			mode: "input" | "drop";
			/** Drop only: whether the page's own handler took the dragover or the drop. */
			handled?: boolean;
			holds: Array<{ name: string; bytes: number; type: string }>;
	  };

/**
 * Build the File objects from the stashed pieces and give them to the element: `input.files`
 * through a DataTransfer, then input and change; or dragenter, dragover and drop when the element
 * is not a file input. The stash is emptied whatever happens. The check that this is still the
 * bound document runs here, in the same script that sets the files, so no navigation fits between.
 */
export function commitUpload(
	tabId: number,
	target: Target,
	id: string,
	files: UploadMeta[],
	bound: Bound,
): Promise<UploadOutcome> {
	const total = files.reduce((a, f) => a + f.bytes, 0);
	return runInPage(
		tabId,
		`(() => {
			${boundCode(bound, id)}
			const store = globalThis.${STASH} || {};
			const held = store[${JSON.stringify(id)}];
			delete store[${JSON.stringify(id)}];
			if (held === null) return { refused: "The connection to the agent closed during the upload. Nothing was set." };
			const parts = held || [];
			${elementCode(target)}
			const metas = ${JSON.stringify(files)};
			const W = el.ownerDocument.defaultView || window;
			const all = new Blob(parts.map((b64) => {
				const bin = atob(b64);
				const out = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
				return out;
			}));
			if (all.size !== ${total}) return { refused: "The page held " + all.size + " of ${total} bytes (it reloaded during the upload). Nothing was set; read_page and try again." };
			let at = 0;
			const built = metas.map((m) => {
				const f = new W.File([all.slice(at, at + m.bytes)], m.name, { type: m.mime, lastModified: m.lastModified });
				at += m.bytes;
				return f;
			});
			const dt = new W.DataTransfer();
			for (const f of built) dt.items.add(f);
			const describe = (list) => Array.from(list).map((f) => ({ name: f.name, bytes: f.size, type: f.type }));
			const input = (${pageFileInput.toString()})(el);
			if (input) {
				if (input.disabled) return { refused: "That file input is disabled." };
				if (!input.multiple && built.length > 1) return { refused: "That file input takes one file; " + built.length + " were given." };
				const accepts = ${acceptsFile.toString()};
				const bad = built.find((f) => !accepts(input.accept || "", f.name, f.type));
				if (bad) return { refused: "That file input accepts " + input.accept + "; " + bad.name + " does not match." };
				input.files = dt.files;
				input.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
				input.dispatchEvent(new W.Event("change", { bubbles: true }));
				return { mode: "input", holds: describe(input.files) };
			}
			const r = el.getBoundingClientRect();
			const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
			el.dispatchEvent(new W.DragEvent("dragenter", init));
			const over = new W.DragEvent("dragover", init);
			el.dispatchEvent(over);
			const drop = new W.DragEvent("drop", init);
			el.dispatchEvent(drop);
			return { mode: "drop", handled: over.defaultPrevented || drop.defaultPrevented, holds: describe(built) };
		})()`,
	);
}

/** The URL an element points at (href, currentSrc or src, absolute) and its download name, if any. */
export function linkOf(tabId: number, target: Target): Promise<{ url: string; download: string }> {
	return runInPage(
		tabId,
		`(() => {
			${elementCode(target)}
			const pick = (n) => (n && (n.href || n.currentSrc || n.src || (n.data && n.tagName === "OBJECT" ? n.data : ""))) || "";
			let url = pick(el);
			let from = el;
			if (!url) { from = el.closest("a[href], area[href]"); url = pick(from); }
			if (typeof url !== "string") url = String(url && url.baseVal || "");
			return { url, download: (from && from.getAttribute && from.getAttribute("download")) || "" };
		})()`,
	);
}

const FETCHED = "__polycarpFetched";

export type FetchOutcome =
	| { ok: true; bytes: number; mime: string; finalUrl: string; disposition: string }
	| { ok: false; error: "moved"; host: string }
	| { ok: false; error: "http"; status: number }
	| { ok: false; error: "too_large"; bytes: number; known: boolean }
	| { ok: false; error: "fetch"; message: string };

/**
 * Fetch a URL from inside the page and keep the body there as a Blob; readFetched hands it back
 * in pieces. The same rules as the page: its cookies on its own origin, its CORS rules elsewhere.
 * Stops reading as soon as the body passes `cap`. `origin` is the page the request was judged for:
 * a tab that has moved to another origin since fetches nothing, because its cookies are not the
 * ones the caller was allowed to use.
 */
export function fetchInPage(
	tabId: number,
	id: string,
	url: string,
	cap: number,
	origin: string,
): Promise<FetchOutcome> {
	return runInPage(
		tabId,
		`(async () => {
			if (String(location.origin) !== ${JSON.stringify(origin)}) return { ok: false, error: "moved", host: String(location.hostname) };
			let res;
			try { res = await fetch(${JSON.stringify(url)}, { credentials: "same-origin", redirect: "follow" }); }
			catch (e) { return { ok: false, error: "fetch", message: String(e && e.message || e) }; }
			if (!res.ok) return { ok: false, error: "http", status: res.status };
			const declared = Number(res.headers.get("content-length"));
			if (declared > ${cap}) { try { await res.body.cancel(); } catch (e) {} return { ok: false, error: "too_large", bytes: declared, known: true }; }
			const parts = [];
			let bytes = 0;
			try {
				const reader = res.body.getReader();
				for (;;) {
					const step = await reader.read();
					if (step.done) break;
					bytes += step.value.length;
					if (bytes > ${cap}) { try { await reader.cancel(); } catch (e) {} return { ok: false, error: "too_large", bytes, known: false }; }
					parts.push(step.value);
				}
			} catch (e) { return { ok: false, error: "fetch", message: String(e && e.message || e) }; }
			const store = (globalThis.${FETCHED} = globalThis.${FETCHED} || {});
			store[${JSON.stringify(id)}] = new Blob(parts);
			return { ok: true, bytes, mime: res.headers.get("content-type") || "", finalUrl: res.url || ${JSON.stringify(url)}, disposition: res.headers.get("content-disposition") || "" };
		})()`,
		FETCH_WORLD_ID,
		FETCH_CSP,
	);
}

/** One piece of a fetched body as base64, or null when the page no longer holds it (it reloaded). */
export function readFetched(tabId: number, id: string, start: number, end: number): Promise<string | null> {
	return runInPage(
		tabId,
		`(async () => {
			const blob = (globalThis.${FETCHED} || {})[${JSON.stringify(id)}];
			if (!blob) return null;
			const bytes = new Uint8Array(await blob.slice(${start}, ${end}).arrayBuffer());
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			return btoa(bin);
		})()`,
		FETCH_WORLD_ID,
		FETCH_CSP,
	);
}

export function dropFetched(tabId: number, id: string): Promise<unknown> {
	return runInPage(
		tabId,
		`(() => { if (globalThis.${FETCHED}) delete globalThis.${FETCHED}[${JSON.stringify(id)}]; return true; })()`,
		FETCH_WORLD_ID,
		FETCH_CSP,
	);
}
