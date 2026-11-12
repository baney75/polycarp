/**
 * The hidden page's side of outside agents' document calls: the same document service the side panel runs, over the
 * same database (src/documents/store.ts), so a document either one brought in is there for the other. A file from the
 * agent's computer arrives in chunks (documents.put) and is stored once whole.
 */
import { download } from "../documents/fetch.js";
import { DocumentError, LIMITS } from "../documents/parse.js";
import {
	DOCUMENTS_MESSAGE,
	type DocumentsReply,
	MCP_MAX_CHARS,
	MCP_READ_CHARS,
	MCP_SEARCH_CHARS,
} from "../documents/protocol.js";
import { DocumentService, type GetSource } from "../documents/service.js";
import { IdbBackend } from "../documents/store.js";
import { documentLibs } from "../lazy/documents.js";

const service = new DocumentService({
	backend: new IdbBackend(),
	libs: documentLibs,
	fetch: (url, signal) => download(url, signal),
});

/** Files on their way in: transfer id to its chunks. Dropped after ten minutes. */
const transfers = new Map<string, { chunks: Uint8Array[]; bytes: number; at: number }>();
const TRANSFER_MS = 10 * 60_000;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
const budget = (v: unknown, fallback: number) =>
	Math.max(1000, Math.min(MCP_MAX_CHARS, Math.floor(Number(v) || fallback)));

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function takeTransfer(id: string): Uint8Array {
	const t = transfers.get(id);
	transfers.delete(id);
	if (!t)
		throw new DocumentError("That file transfer is gone (it expired or the browser restarted). Send the file again.");
	const out = new Uint8Array(t.bytes);
	let at = 0;
	for (const c of t.chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

async function handle(method: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
	const now = Date.now();
	for (const [id, t] of transfers) if (now - t.at > TRANSFER_MS) transfers.delete(id);
	switch (method) {
		case "put": {
			const id = str(p.transfer) ?? "";
			if (!/^[\w-]{6,64}$/.test(id)) throw new DocumentError("A transfer needs an id.");
			const chunk = fromBase64(str(p.data) ?? "");
			const t = transfers.get(id) ?? { chunks: [], bytes: 0, at: now };
			t.bytes += chunk.byteLength;
			t.at = now;
			if (t.bytes > LIMITS.bytes) {
				transfers.delete(id);
				throw new DocumentError("The file is over the 60 MB documents can be.");
			}
			t.chunks.push(chunk);
			transfers.set(id, t);
			return { received: t.bytes };
		}
		case "get": {
			let source: GetSource;
			if (str(p.transfer)) {
				source = {
					bytes: takeTransfer(str(p.transfer) as string),
					name: str(p.name) || "document",
					mime: str(p.mime) ?? "",
					source: "file",
				};
			} else if (typeof p.text === "string") {
				const format = p.format === "markdown" || p.format === "text" ? p.format : "html";
				source = { text: p.text, format, title: str(p.title), url: str(p.url), source: "tab" };
			} else source = { url: str(p.url) ?? "" };
			const { meta, existing, summary } = await service.get(source, {
				refresh: p.refresh === true,
				library: str(p.library),
				title: str(p.docTitle),
			});
			return { doc: meta.id, existing, text: summary };
		}
		case "search":
			return {
				text: await service.searchText(
					str(p.query) ?? "",
					{ docs: strs(p.docs), also: strs(p.also), limit: Math.max(1, Math.min(20, Number(p.limit) || 8)) },
					budget(p.maxChars, MCP_SEARCH_CHARS),
				),
			};
		case "read":
			return {
				text: await service.read(
					str(p.doc) ?? "",
					{ pages: str(p.pages), section: str(p.section), around: str(p.around), offset: Number(p.offset) || 0 },
					budget(p.maxChars, MCP_READ_CHARS),
				),
			};
		case "list":
			return {
				text: await service.listText(),
				docs: (await service.list()).map((m) => ({ id: m.id, title: m.title, library: m.library })),
			};
		case "rename": {
			const m = await service.rename(str(p.doc) ?? "", str(p.title) ?? "");
			return { text: `Renamed ${m.id} to ${JSON.stringify(m.title)}.` };
		}
		case "delete": {
			const m = await service.remove(str(p.doc) ?? "");
			return { text: `Deleted ${m.id} (${JSON.stringify(m.title)}) from the document store.` };
		}
	}
	throw new DocumentError(`Unknown document call ${JSON.stringify(method)}.`);
}

chrome.runtime.onMessage.addListener((msg, sender, reply: (r: DocumentsReply) => void) => {
	if (msg?.type !== DOCUMENTS_MESSAGE || sender.id !== chrome.runtime.id) return false;
	handle(String(msg.method), (msg.params ?? {}) as Record<string, unknown>).then(
		(result) => reply({ ok: true, result }),
		(err) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
	);
	return true;
});
