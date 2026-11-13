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
 *
 * Two things can change between `begin` and the moment the files are set, and both are checked at
 * that moment, not before it. The tab can navigate: an upload is bound to the document it was
 * approved for (files-page.ts, Bound), and the script that stashes or sets content refuses in any
 * other document. The caller can go: a transfer whose client or bridge connection is gone is
 * cancelled, its pieces are cleared here and in the page, and nothing more is sent to the page.
 */

import { cdpSend } from "../browser/cdp.js";
import {
	type Bound,
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
import { splitFrameRef } from "../browser/frames.js";
import { maskUrl } from "../browser/mask-body.js";
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
	/** The document the site check, the element check and the person's yes were for. */
	bound: Bound;
	target: { ref?: string; selector?: string };
	files: UploadFile[];
	total: number;
	received: number;
	chunks: string[];
	touchedAt: number;
	/** Set when the transfer was dropped; a commit under way stops before its next step in the page. */
	cancelled?: boolean;
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
/** Uploads whose commit is running: no longer in `uploads`, but still their client's to cancel. */
const committing = new Set<Upload>();

const IDLE_MS = 5 * 60 * 1000;
/** A client moves one file at a time; a few slots cover a retry that overlaps its predecessor. */
const MAX_PER_CLIENT = 4;

function forget(t: Upload | Outgoing): void {
	if ("chunks" in t) {
		uploads.delete(t.id);
		t.chunks.length = 0;
		t.cancelled = true;
		// A commit under way may already have handed the page some pieces.
		if (committing.has(t)) void dropUploadStash(t.tabId, t.id, true).catch(() => undefined);
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

const everyTransfer = () => [...uploads.values(), ...committing, ...outgoing.values()];

/** A client hung up: what it was moving has nowhere to go, and a commit of its upload stops. */
export function dropTransfersForClient(clientId: string): void {
	for (const t of everyTransfer()) if (t.clientId === clientId) forget(t);
}

/** A session ended: its transfers end with it. */
export function dropTransfersForSession(sessionId: string): void {
	for (const t of everyTransfer()) if (t.sessionId === sessionId) forget(t);
}

/** The bridge connection went: no client can be answered, so nothing any of them was moving is kept. */
export function dropAllTransfers(): void {
	for (const t of everyTransfer()) forget(t);
}

/** For tests and bridge.debug: how many transfers are held. */
export function transferCount(): number {
	return uploads.size + committing.size + outgoing.size;
}

const pageOrigin = (url: string): string => {
	try {
		return new URL(url).origin;
	} catch {
		return "null";
	}
};

/** Uploads and downloads run in the top page; a ref inside a cross-origin frame gets a clear no. */
function refuseFrameRef(ref: string | undefined): void {
	if (ref && splitFrameRef(ref))
		throw new BridgeError(
			ERR.BAD_PARAMS,
			`Ref ${ref} is inside a cross-origin frame, which upload and download can't reach. navigate to the frame's URL and use its refs there.`,
		);
}

/** The refusal for a script that found the tab on another document than the one the upload was for. */
function movedError(up: Upload, now: { host: string; sameOrigin: boolean }): BridgeError {
	return now.sameOrigin
		? new BridgeError(
				ERR.BAD_PARAMS,
				`The page on ${up.host} reloaded or changed during the upload. Nothing was set; read_page and upload again.`,
			)
		: new BridgeError(
				ERR.PERMISSION_DENIED,
				`The tab moved from ${up.host} to ${now.host || "another page"} during the upload. Nothing was set.`,
			);
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

/**
 * A commit handler whose upload is in `committing` for as long as it runs: its awaits included, so a client that
 * leaves during any of them still finds the transfer and stops it. It is out of `uploads`, so it can't be committed twice.
 */
function whileCommitting(run: (ctx: HandlerContext, up: Upload) => Promise<unknown>): Handler {
	return async (ctx, params) => {
		const up = owned(uploads, ctx, params);
		uploads.delete(up.id);
		committing.add(up);
		try {
			return await run(ctx, up);
		} finally {
			committing.delete(up);
			// forget() left a mark in the page for a script already on its way; no script is now.
			if (up.cancelled) await dropUploadStash(up.tabId, up.id).catch(() => undefined);
		}
	};
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
			refuseFrameRef(target.ref);
			const tabId = await resolveTab(ctx, params, false);
			const { url, host } = await destination(ctx, tabId);
			const probe = await probeUploadTarget(tabId, target, crypto.randomUUID());
			// The element was found in the document whose address was just checked, or nowhere.
			if (probe.origin !== pageOrigin(url))
				throw new BridgeError(ERR.PERMISSION_DENIED, `The tab left ${host} as the upload began. Nothing was sent.`);
			const bound: Bound = { origin: probe.origin, doc: probe.doc };
			checkTarget(probe, files);
			const asking = files.filter((f) => f.ask).map((f) => ({ name: f.name, bytes: f.bytes }));
			// The caller's own id for this one call goes back with the question, so its answer is for these files only.
			if (asking.length && !(await ctx.askUpload(url, asking, String(params.askId ?? "").slice(0, 64))))
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
				bound,
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

		"files.upload.commit": whileCommitting(async (ctx, up) => {
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
				stopIfGone();
				at += f.bytes;
			}
			if (!ctx.session.tabIds.includes(up.tabId))
				throw new BridgeError(ERR.NOT_FOUND, "The tab is no longer one of yours. Nothing was set.");
			// The yes, and the site check, were for the site the tab was on at begin. This reads the tab's address,
			// which can change the moment after; the scripts below check the document itself as they run.
			const now = await destination(ctx, up.tabId);
			stopIfGone();
			if (pageOrigin(now.url) !== up.bound.origin) throw movedError(up, { host: now.host, sameOrigin: false });
			/** The caller is gone (its client, its session or the bridge connection): nothing more goes to the page. */
			function stopIfGone(): void {
				if (up.cancelled || ctx.aborted())
					throw new BridgeError(
						ERR.INTERRUPTED,
						"The connection to the agent closed during the upload. Nothing was set.",
					);
			}
			let outcome: Awaited<ReturnType<typeof commitUpload>> | undefined;
			try {
				for (const chunk of [...up.chunks]) {
					stopIfGone();
					const held = await stashUploadChunk(up.tabId, up.id, chunk, up.bound);
					if (typeof held !== "number") throw movedError(up, held);
				}
				stopIfGone();
				outcome = await commitUpload(up.tabId, up.target, up.id, up.files, up.bound);
			} finally {
				up.chunks.length = 0;
				// commitUpload empties the stash itself; anything else leaves pieces to clear.
				if (!outcome) await dropUploadStash(up.tabId, up.id).catch(() => undefined);
			}
			if ("moved" in outcome) throw movedError(up, outcome);
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
		}),

		"files.upload.abort": async (ctx, params) => {
			const id = String(params.transferId ?? "");
			const up = uploads.get(id) ?? [...committing].find((u) => u.id === id);
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
			refuseFrameRef(target.ref);
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
			// The address was resolved and judged against the page the tab was on; the fetch runs only there.
			const got = await fetchInPage(tabId, id, parsed.href, FILE_DOWNLOAD_MAX_BYTES, pageOrigin(pageUrl));
			if (ctx.aborted()) {
				if (got.ok) await dropFetched(tabId, id).catch(() => undefined);
				throw new BridgeError(ERR.INTERRUPTED, "The connection to the agent closed. Nothing was saved.");
			}
			if (!got.ok) {
				if (got.error === "moved")
					throw new BridgeError(
						ERR.BAD_PARAMS,
						`The tab moved to ${got.host || "another page"} before the download began. Nothing was fetched; read_page and try again.`,
					);
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
			// A redirect to another site is a site the agent is now reading: it gets the check a navigation gets.
			if (/^https?:/i.test(got.finalUrl) && hostOf(got.finalUrl) !== parsed.hostname.toLowerCase()) {
				try {
					await ctx.checkUrl(got.finalUrl);
				} catch (err) {
					await dropFetched(tabId, id).catch(() => undefined);
					throw err;
				}
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
				// A signed link's token is a credential the agent never held; it is masked like any URL shown.
				url: parsed.protocol === "blob:" ? `blob from ${maskUrl(pageUrl)}` : maskUrl(got.finalUrl),
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
			// The PDF is filed under the page it is of: a tab that changed sites while printing has no one page.
			const after = (await chrome.tabs.get(tabId)).url ?? "";
			if (pageOrigin(after) !== pageOrigin(tab.url ?? ""))
				throw new BridgeError(
					ERR.BAD_PARAMS,
					`The tab moved to ${hostOf(after) || "another page"} while the PDF was made. Nothing was saved; try again.`,
				);
			const bytes = base64Bytes(data);
			if (bytes < 0) throw new BridgeError(ERR.INTERNAL, "The browser returned a PDF that could not be read.");
			if (bytes > FILE_DOWNLOAD_MAX_BYTES) throw tooLarge("The PDF of this page", bytes);
			const t = memoryTransfer(ctx, data, bytes);
			return announce(t, {
				mime: "application/pdf",
				name: `${(tab.title ?? "").trim() || "page"}.pdf`,
				url: maskUrl(tab.url ?? ""),
			});
		},
	};
}
