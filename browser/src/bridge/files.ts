/**
 * The bridge side of the `files` tool (docs/decisions.md, D38): local files into a page, and a
 * page's files back to the helper. Content moves in pieces, because a frame to the extension is
 * capped near 900 KiB:
 *
 *   upload    begin (who, where, each file's name, size and hash) -> chunk ... -> commit
 *   download  begin (fetch in the page, or print it to PDF) -> chunk ... -> end
 *
 * Everything is decided at `begin`, before a byte of content arrives: the tab is the caller's, its
 * site is already allowed for agents, the element takes these files, and the person said yes when
 * the helper marked a file as needing it. `commit` checks the size and hash of what arrived against
 * what `begin` announced. A transfer belongs to the client and session that began it and is dropped
 * when either goes, on any error, and after five idle minutes.
 */

import { cdpSend } from "../browser/cdp.js";
import {
	commitUpload,
	dropFetched,
	dropUploadStash,
	fetchInPage,
	linkOf,
	probeUploadTarget,
	readFetched,
	stashUploadChunk,
	type UploadMeta,
	type UploadTarget,
} from "../browser/files-page.js";
import { BridgeError } from "./errors.js";
import { acceptsFile, base64Bytes, dispositionName, parseDataUrl, urlFileName } from "./file-util.js";
import { hostOf, isUrlAllowed } from "./permissions.js";
import {
	ERR,
	FILE_CHUNK_FROM_EXTENSION,
	FILE_CHUNK_TO_EXTENSION,
	FILE_DOWNLOAD_MAX_BYTES,
	FILE_UPLOAD_MAX_BYTES,
	FILE_UPLOAD_MAX_FILES,
} from "./protocol.js";
import type { HandlerContext } from "./tools.js";

type Params = Record<string, unknown>;
type Handler = (ctx: HandlerContext, params: Params) => Promise<unknown>;

interface UploadFile extends UploadMeta {
	sha256: string;
	ask: boolean;
}

interface Upload {
	id: string;
	clientId: string;
	sessionId: string;
	tabId: number;
	host: string;
	target: { ref?: string; selector?: string };
	files: UploadFile[];
	total: number;
	received: number;
	chunks: string[];
	touchedAt: number;
}

interface Outgoing {
	id: string;
	clientId: string;
	sessionId: string;
	bytes: number;
	/** Held here (a PDF, a data: URL) or in the page that fetched it. */
	source: { kind: "memory"; b64: string } | { kind: "page"; tabId: number };
	touchedAt: number;
}

const uploads = new Map<string, Upload>();
const outgoing = new Map<string, Outgoing>();

const IDLE_MS = 5 * 60 * 1000;
/** A client moves one file at a time; a few slots cover a retry that overlaps its predecessor. */
const MAX_PER_CLIENT = 4;

function forget(t: Upload | Outgoing): void {
	if ("chunks" in t) {
		uploads.delete(t.id);
		t.chunks.length = 0;
		return;
	}
	outgoing.delete(t.id);
	if (t.source.kind === "page") void dropFetched(t.source.tabId, t.id).catch(() => undefined);
}

function sweep(now = Date.now()): void {
	for (const t of [...uploads.values(), ...outgoing.values()]) if (now - t.touchedAt > IDLE_MS) forget(t);
}

function makeRoom(clientId: string): void {
	const mine = [...uploads.values(), ...outgoing.values()]
		.filter((t) => t.clientId === clientId)
		.sort((a, b) => a.touchedAt - b.touchedAt);
	while (mine.length >= MAX_PER_CLIENT) forget(mine.shift() as Upload | Outgoing);
}

/** A client hung up: what it was moving has nowhere to go. */
export function dropTransfersForClient(clientId: string): void {
	for (const t of [...uploads.values(), ...outgoing.values()]) if (t.clientId === clientId) forget(t);
}

/** A session ended: its transfers end with it. */
export function dropTransfersForSession(sessionId: string): void {
	for (const t of [...uploads.values(), ...outgoing.values()]) if (t.sessionId === sessionId) forget(t);
}

/** For tests and bridge.debug: how many transfers are held. */
export function transferCount(): number {
	return uploads.size + outgoing.size;
}

function owned<T extends Upload | Outgoing>(map: Map<string, T>, ctx: HandlerContext, params: Params): T {
	sweep();
	const id = String(params.transferId ?? "");
	const t = map.get(id);
	// Another client's or session's transfer is reported like one that never existed.
	if (!t || t.clientId !== ctx.clientId || t.sessionId !== ctx.session.id)
		throw new BridgeError(ERR.NOT_FOUND, "That transfer is gone (it finished, failed, or sat idle). Start again.");
	t.touchedAt = Date.now();
	return t;
}

const size = (n: number) =>
	n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;

function parseFiles(raw: unknown): UploadFile[] {
	if (!Array.isArray(raw) || raw.length === 0)
		throw new BridgeError(ERR.BAD_PARAMS, "files must list at least one file.");
	if (raw.length > FILE_UPLOAD_MAX_FILES)
		throw new BridgeError(
			ERR.BAD_PARAMS,
			`${raw.length} files given; one upload takes at most ${FILE_UPLOAD_MAX_FILES}.`,
		);
	return raw.map((f) => {
		const o = (f ?? {}) as Params;
		const name = typeof o.name === "string" ? o.name : "";
		const bytes = Number(o.bytes);
		const sha256 = typeof o.sha256 === "string" ? o.sha256.toLowerCase() : "";
		if (!name || name.length > 255 || /[\\/\u0000-\u001f]/.test(name))
			throw new BridgeError(ERR.BAD_PARAMS, "Each file needs a plain name, without a path.");
		if (!Number.isSafeInteger(bytes) || bytes < 0)
			throw new BridgeError(ERR.BAD_PARAMS, `${name}: bytes must be a size.`);
		if (!/^[0-9a-f]{64}$/.test(sha256)) throw new BridgeError(ERR.BAD_PARAMS, `${name}: sha256 is required.`);
		const lastModified = Number(o.lastModified);
		return {
			name,
			bytes,
			sha256,
			mime: typeof o.mime === "string" ? o.mime.slice(0, 120) : "",
			lastModified: Number.isFinite(lastModified) && lastModified > 0 ? lastModified : Date.now(),
			ask: o.ask === true,
		};
	});
}

function decode(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
	return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tab's page, when it is one an agent may put files into: an allowed site, never a guarded one. */
async function destination(ctx: HandlerContext, tabId: number): Promise<{ url: string; host: string }> {
	const url = (await chrome.tabs.get(tabId)).url ?? "";
	const host = hostOf(url);
	if (!/^https?:/i.test(url) || !host)
		throw new BridgeError(ERR.BAD_PARAMS, "Files go into a web page (http or https); this tab is not on one.");
	if (ctx.isGuarded(url))
		throw new BridgeError(
			ERR.PERMISSION_DENIED,
			`${host} is a site agents never open, so nothing is uploaded there.`,
		);
	// No question here: a site the person has not allowed for agents does not get files either.
	if (!(await isUrlAllowed(url)))
		throw new BridgeError(
			ERR.PERMISSION_DENIED,
			`${host} is not allowed for agents yet, so nothing is uploaded there. The user can allow it in the Polycarp side panel under Settings > Agents.`,
		);
	return { url, host };
}

function checkTarget(probe: UploadTarget, files: UploadFile[]): void {
	if (probe.kind !== "input") return;
	if (probe.disabled) throw new BridgeError(ERR.NOT_ACTIONABLE, "That file input is disabled.");
	if (!probe.multiple && files.length > 1)
		throw new BridgeError(
			ERR.BAD_PARAMS,
			`That file input takes one file; ${files.length} were given. Upload one, or find the input that takes several.`,
		);
	const bad = files.find((f) => !acceptsFile(probe.accept ?? "", f.name, f.mime));
	if (bad)
		throw new BridgeError(
			ERR.BAD_PARAMS,
			`That file input accepts ${probe.accept}; ${bad.name}${bad.mime ? ` (${bad.mime})` : ""} does not match.`,
		);
}

function memoryTransfer(ctx: HandlerContext, b64: string, bytes: number): Outgoing {
	makeRoom(ctx.clientId);
	const t: Outgoing = {
		id: crypto.randomUUID(),
		clientId: ctx.clientId,
		sessionId: ctx.session.id,
		bytes,
		source: { kind: "memory", b64 },
		touchedAt: Date.now(),
	};
	outgoing.set(t.id, t);
	return t;
}

const tooLarge = (what: string, bytes: number, known = true) =>
	new BridgeError(
		ERR.BAD_PARAMS,
		`${what} is ${known ? size(bytes) : `more than ${size(FILE_DOWNLOAD_MAX_BYTES)}`}; the most one saved file may be is ${size(FILE_DOWNLOAD_MAX_BYTES)}. Nothing was saved.`,
	);

const announce = (t: Outgoing, extra: Record<string, unknown>) => ({
	transferId: t.id,
	bytes: t.bytes,
	chunks: Math.ceil(t.bytes / FILE_CHUNK_FROM_EXTENSION),
	...extra,
});

type ResolveTab = (ctx: HandlerContext, params: Params, attach: boolean) => Promise<number>;

/** The handlers, given tools.ts's way of resolving the caller's tab (own tabs only, never the approval page). */
export function fileHandlers(resolveTab: ResolveTab): Record<string, Handler> {
	return {
		"files.upload.begin": async (ctx, params) => {
			sweep();
			const files = parseFiles(params.files);
			const total = files.reduce((a, f) => a + f.bytes, 0);
			if (total > FILE_UPLOAD_MAX_BYTES)
				throw new BridgeError(
					ERR.BAD_PARAMS,
					`The files are ${size(total)} in all; one upload takes at most ${size(FILE_UPLOAD_MAX_BYTES)}.`,
				);
			const target = {
				ref: typeof params.ref === "string" ? params.ref : undefined,
				selector: typeof params.selector === "string" ? params.selector : undefined,
			};
			if (!target.ref && !target.selector)
				throw new BridgeError(
					ERR.BAD_PARAMS,
					"upload needs the ref of a file input or drop area (read_page gives refs).",
				);
			const tabId = await resolveTab(ctx, params, false);
			const { url, host } = await destination(ctx, tabId);
			const probe = await probeUploadTarget(tabId, target);
			checkTarget(probe, files);
			const asking = files.filter((f) => f.ask).map((f) => ({ name: f.name, bytes: f.bytes }));
			if (asking.length && !(await ctx.askUpload(url, asking)))
				throw new BridgeError(
					ERR.PERMISSION_DENIED,
					`The user did not approve uploading ${asking.map((f) => f.name).join(", ")} to ${host}. Nothing was sent. Do not try another way; ask the user.`,
				);
			makeRoom(ctx.clientId);
			const up: Upload = {
				id: crypto.randomUUID(),
				clientId: ctx.clientId,
				sessionId: ctx.session.id,
				tabId,
				host,
				target,
				files,
				total,
				received: 0,
				chunks: [],
				touchedAt: Date.now(),
			};
			uploads.set(up.id, up);
			return { transferId: up.id, tabId, host, target: probe.kind, chunkBytes: FILE_CHUNK_TO_EXTENSION };
		},

		"files.upload.chunk": async (ctx, params) => {
			const up = owned(uploads, ctx, params);
			const data = typeof params.data === "string" ? params.data : "";
			const bytes = base64Bytes(data);
			const fail = (message: string) => {
				forget(up);
				return new BridgeError(ERR.BAD_PARAMS, `${message} The upload was dropped.`);
			};
			if (Number(params.seq) !== up.chunks.length) throw fail(`Piece ${String(params.seq)} arrived out of order.`);
			if (bytes <= 0 || bytes > FILE_CHUNK_TO_EXTENSION) throw fail("A piece was empty, too large or not base64.");
			if (up.received + bytes > up.total) throw fail(`More bytes arrived than the ${up.total} announced.`);
			up.chunks.push(data);
			up.received += bytes;
			return { received: up.received };
		},

		"files.upload.commit": async (ctx, params) => {
			const up = owned(uploads, ctx, params);
			// Whatever happens next, this transfer is over.
			uploads.delete(up.id);
			if (up.received !== up.total)
				throw new BridgeError(ERR.BAD_PARAMS, `${up.received} of ${up.total} bytes arrived. Nothing was set.`);
			const parts = up.chunks.map(decode);
			const all = new Uint8Array(up.total);
			let at = 0;
			for (const p of parts) {
				all.set(p, at);
				at += p.length;
			}
			at = 0;
			for (const f of up.files) {
				if ((await sha256Hex(all.subarray(at, at + f.bytes))) !== f.sha256)
					throw new BridgeError(
						ERR.BAD_PARAMS,
						`${f.name} did not arrive intact (its hash differs). Nothing was set.`,
					);
				at += f.bytes;
			}
			if (!ctx.session.tabIds.includes(up.tabId))
				throw new BridgeError(ERR.NOT_FOUND, "The tab is no longer one of yours. Nothing was set.");
			// The yes, and the site check, were for the site the tab was on at begin.
			const now = await destination(ctx, up.tabId);
			if (now.host !== up.host)
				throw new BridgeError(
					ERR.PERMISSION_DENIED,
					`The tab moved from ${up.host} to ${now.host} during the upload. Nothing was set.`,
				);
			let outcome: Awaited<ReturnType<typeof commitUpload>>;
			try {
				for (const chunk of up.chunks) await stashUploadChunk(up.tabId, up.id, chunk);
				outcome = await commitUpload(up.tabId, up.target, up.id, up.files);
			} catch (err) {
				await dropUploadStash(up.tabId, up.id).catch(() => undefined);
				throw err;
			} finally {
				up.chunks.length = 0;
			}
			if ("refused" in outcome) throw new BridgeError(ERR.BAD_PARAMS, outcome.refused);
			return {
				host: up.host,
				target: outcome.mode,
				files: up.files.map((f) => ({ name: f.name, bytes: f.bytes })),
				holds: outcome.holds,
				...(outcome.mode === "drop" && !outcome.handled
					? {
							note: "The page's handlers did not take the drop. Check the page with read_page; the element may not be a drop area.",
						}
					: {}),
			};
		},

		"files.upload.abort": async (ctx, params) => {
			const id = String(params.transferId ?? "");
			const up = uploads.get(id);
			if (up && up.clientId === ctx.clientId && up.sessionId === ctx.session.id) forget(up);
			return { aborted: Boolean(up) };
		},

		"files.download.begin": async (ctx, params) => {
			sweep();
			const target = {
				ref: typeof params.ref === "string" ? params.ref : undefined,
				selector: typeof params.selector === "string" ? params.selector : undefined,
			};
			let url = typeof params.url === "string" ? params.url.trim() : "";
			if (!url && !target.ref && !target.selector)
				throw new BridgeError(
					ERR.BAD_PARAMS,
					"download needs a url, or the ref of a link, image or media element.",
				);
			const tabId = await resolveTab(ctx, params, false);
			const pageUrl = (await chrome.tabs.get(tabId)).url ?? "";
			let suggested = "";
			if (!url) {
				const link = await linkOf(tabId, target);
				if (!link.url)
					throw new BridgeError(ERR.BAD_PARAMS, "That element has no href, src or currentSrc to download.");
				url = link.url;
				suggested = link.download;
			}
			let parsed: URL;
			try {
				parsed = new URL(url, pageUrl);
			} catch {
				throw new BridgeError(ERR.BAD_PARAMS, `${url.slice(0, 120)} is not a URL.`);
			}
			if (parsed.protocol === "data:") {
				const data = parseDataUrl(parsed.href);
				if (!data) throw new BridgeError(ERR.BAD_PARAMS, "That data: URL could not be read.");
				const bytes = base64Bytes(data.b64);
				if (bytes > FILE_DOWNLOAD_MAX_BYTES) throw tooLarge("That file", bytes);
				const t = memoryTransfer(ctx, data.b64, bytes);
				return announce(t, { mime: data.mime, name: suggested, url: `data:${data.mime} (${bytes} bytes)` });
			}
			if (parsed.protocol === "blob:") {
				// A blob: URL names the origin that made it; only the page's own are its to read.
				let origin = "";
				try {
					origin = new URL(pageUrl).origin;
				} catch {
					/* no origin: refused below */
				}
				if (!origin || parsed.origin !== origin)
					throw new BridgeError(
						ERR.PERMISSION_DENIED,
						"That blob: URL belongs to another page; open that page and download it there.",
					);
			} else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
				// The same check a navigation gets: a guarded host is refused, a new one needs the person's yes.
				await ctx.checkUrl(parsed.href);
			} else {
				throw new BridgeError(ERR.BAD_PARAMS, "Only http, https, blob and data URLs can be downloaded.");
			}
			makeRoom(ctx.clientId);
			const id = crypto.randomUUID();
			const got = await fetchInPage(tabId, id, parsed.href, FILE_DOWNLOAD_MAX_BYTES);
			if (!got.ok) {
				if (got.error === "too_large") throw tooLarge("That file", got.bytes, got.known);
				if (got.error === "http")
					throw new BridgeError(
						ERR.BAD_PARAMS,
						`The server answered ${got.status} for that URL. Nothing was saved.`,
					);
				throw new BridgeError(
					ERR.BAD_PARAMS,
					`The page could not fetch that URL (${got.message.slice(0, 160)}). A file on another site can only be read when that site allows this page to (CORS): open a page on the file's own site with navigate and download it from there.`,
				);
			}
			// A redirect is followed by the page's own rules, but never to an address agents may not read.
			if (ctx.isGuarded(got.finalUrl)) {
				await dropFetched(tabId, id).catch(() => undefined);
				throw new BridgeError(
					ERR.PERMISSION_DENIED,
					"That URL led to an address agents never open. Nothing was saved.",
				);
			}
			const t: Outgoing = {
				id,
				clientId: ctx.clientId,
				sessionId: ctx.session.id,
				bytes: got.bytes,
				source: { kind: "page", tabId },
				touchedAt: Date.now(),
			};
			outgoing.set(id, t);
			return announce(t, {
				mime: got.mime,
				name: suggested || dispositionName(got.disposition) || urlFileName(got.finalUrl) || "",
				url: parsed.protocol === "blob:" ? `blob from ${pageUrl}` : got.finalUrl,
			});
		},

		"files.download.chunk": async (ctx, params) => {
			const t = owned(outgoing, ctx, params);
			const index = Number(params.index);
			const start = index * FILE_CHUNK_FROM_EXTENSION;
			if (!Number.isSafeInteger(index) || index < 0 || start >= Math.max(t.bytes, 1))
				throw new BridgeError(ERR.BAD_PARAMS, "No such piece.");
			if (t.source.kind === "memory") {
				// 3 bytes are 4 base64 characters, and a piece is a multiple of 3 bytes.
				const per = (FILE_CHUNK_FROM_EXTENSION / 3) * 4;
				return { index, data: t.source.b64.slice(index * per, (index + 1) * per) };
			}
			const data = await readFetched(
				t.source.tabId,
				t.id,
				start,
				Math.min(t.bytes, start + FILE_CHUNK_FROM_EXTENSION),
			);
			if (data === null) {
				forget(t);
				throw new BridgeError(ERR.NOT_FOUND, "The page reloaded before the file was read. Download it again.");
			}
			return { index, data };
		},

		"files.download.end": async (ctx, params) => {
			const id = String(params.transferId ?? "");
			const t = outgoing.get(id);
			if (t && t.clientId === ctx.clientId && t.sessionId === ctx.session.id) forget(t);
			return { ended: Boolean(t) };
		},

		"files.pdf.begin": async (ctx, params) => {
			sweep();
			const tabId = await resolveTab(ctx, params, true);
			const tab = await chrome.tabs.get(tabId);
			const { data } = await cdpSend<{ data: string }>(tabId, "Page.printToPDF", {
				printBackground: true,
				preferCSSPageSize: true,
				transferMode: "ReturnAsBase64",
			});
			const bytes = base64Bytes(data);
			if (bytes < 0) throw new BridgeError(ERR.INTERNAL, "The browser returned a PDF that could not be read.");
			if (bytes > FILE_DOWNLOAD_MAX_BYTES) throw tooLarge("The PDF of this page", bytes);
			const t = memoryTransfer(ctx, data, bytes);
			return announce(t, {
				mime: "application/pdf",
				name: `${(tab.title ?? "").trim() || "page"}.pdf`,
				url: tab.url ?? "",
			});
		},
	};
}
