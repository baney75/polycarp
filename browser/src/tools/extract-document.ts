/**
 * extract_document, bounded: it never answers with more than the budget the current model's window allows
 * (context-budget.ts). With `pages` it reads a range, with `query` it finds the pages that match, and with neither
 * it gives the page count and the first pages with a note on how to get the rest. pi-web-ui's tool returned the
 * whole document as one string, which on a 400-page book was 706,000 characters and broke the chat for good.
 *
 * The file goes through the document store (src/documents/): downloaded and parsed once, kept on this computer, and
 * searchable later with document_search. Reading in parts is document-reader.ts.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { DocumentError } from "../documents/errors.js";
import type { DocumentService } from "../documents/service.js";
import { EXTRACT_DOCUMENT_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import {
	type ParsedDocument,
	parseExtracted,
	parseRange,
	readOverview,
	readRange,
	readSearch,
	type UnitKind,
} from "./document-reader.js";

const schema = Type.Object({
	url: Type.String({ description: "URL of the document (PDF, DOCX, XLSX, PPTX or text)" }),
	pages: Type.Optional(
		Type.String({
			description:
				'Pages to read, like "40-55" or "12" (slides for PPTX, sheets for XLSX, parts of about 3,000 characters for DOCX)',
		}),
	),
	query: Type.Optional(
		Type.String({ description: "Words to find: returns the matching pages, best first, with numbers and snippets" }),
	),
	offset: Type.Optional(
		Type.Number({ description: "Skip this many characters of the pages asked for (the cut note gives it)" }),
	),
});

export type ExtractDocumentParams = Static<typeof schema>;

/** The shape pi-web-ui's renderer for extract_document reads. */
export interface ExtractDocumentDetails {
	extractedText: string;
	format: string;
	fileName: string;
	size: number;
	pages?: number;
}

export interface LoadedDocument {
	extractedText: string;
	fileName: string;
	mimeType: string;
	size: number;
}

interface Cached {
	doc: ParsedDocument;
	fileName: string;
	size: number;
}

/** Documents kept parsed, newest last. */
const CACHE_ENTRIES = 6;
const cache = new Map<string, Cached>();

/** Drop the parsed documents (tests). */
export function clearDocumentCache(): void {
	cache.clear();
}

function formatOf(mimeType: string, fileName: string): string {
	if (mimeType.includes("pdf")) return "pdf";
	if (mimeType.includes("wordprocessingml")) return "docx";
	if (mimeType.includes("spreadsheetml") || mimeType.includes("ms-excel")) return "xlsx";
	if (mimeType.includes("presentationml")) return "pptx";
	const ext = fileName.toLowerCase().split(".").pop() ?? "";
	return ["pdf", "docx", "xlsx", "pptx"].includes(ext) ? ext : "text";
}

/** A stored document as document-reader reads it. */
async function fromStore(store: DocumentService, url: string, signal?: AbortSignal): Promise<Cached> {
	const { meta } = await store.get({ url }, { signal });
	const units = await store.units(meta.id);
	const kind: UnitKind = meta.kind === "section" ? "part" : meta.kind;
	return {
		doc: {
			format: meta.format,
			kind,
			units: units.map((u) => ({ n: u.n, name: u.name, text: u.text })),
			totalChars: units.reduce((n, u) => n + u.text.length, 0),
		},
		fileName: meta.fileName,
		size: meta.bytes,
	};
}

export interface ExtractDocumentOptions {
	/** Characters the answer may hold, from the current model's window. */
	budgetChars: () => number;
	/** The document store: the file is downloaded, parsed and kept there (src/documents/). */
	store?: () => DocumentService | Promise<DocumentService>;
	/** Replaces the store with already extracted text (tests). */
	load?: (url: string, signal?: AbortSignal) => Promise<LoadedDocument>;
}

export type ExtractDocumentTool = AgentTool<typeof schema, ExtractDocumentDetails>;

export function createExtractDocumentTool(options: ExtractDocumentOptions): ExtractDocumentTool {
	const tool: ExtractDocumentTool = {
		label: "Extract Document",
		name: "extract_document",
		description: EXTRACT_DOCUMENT_TOOL_DESCRIPTION,
		parameters: schema,
		execute: async (_toolCallId, args, signal) => {
			if (signal?.aborted) throw new Error("Aborted");
			const url = String(args.url ?? "").trim();
			try {
				new URL(url);
			} catch {
				throw new Error(`Not a URL: ${url}`);
			}
			// The viewer's #page=N is not part of the file.
			const key = url.split("#")[0];
			let entry = cache.get(key);
			if (entry) {
				cache.delete(key);
			} else {
				if (options.load) {
					const loaded = await options.load(key, signal);
					entry = {
						doc: parseExtracted(loaded.extractedText, formatOf(loaded.mimeType, loaded.fileName)),
						fileName: loaded.fileName,
						size: loaded.size,
					};
				} else if (options.store) {
					try {
						entry = await fromStore(await options.store(), key, signal);
					} catch (err) {
						if (err instanceof DocumentError) throw new Error(err.message);
						throw err;
					}
				} else throw new Error("extract_document has no document store.");
				while (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
			}
			cache.set(key, entry);
			const { doc, fileName } = entry;
			const budget = Math.max(1000, Math.floor(options.budgetChars()));
			let text: string;
			if (args.query?.trim()) {
				text = readSearch(doc, fileName, args.query, budget, key).text;
			} else if (args.pages?.trim()) {
				const range = parseRange(args.pages, doc.units.length);
				if (!range)
					throw new Error(
						`pages takes one number or a range, like "12" or "40-55", not ${JSON.stringify(args.pages)}.`,
					);
				text = readRange(doc, fileName, range, Math.max(0, Math.floor(Number(args.offset) || 0)), budget).text;
			} else if (args.offset) {
				text = readRange(
					doc,
					fileName,
					{ first: 1, last: doc.units.length },
					Math.max(0, Math.floor(Number(args.offset))),
					budget,
				).text;
			} else {
				text = readOverview(doc, fileName, budget).text;
			}
			return {
				content: [{ type: "text", text }],
				details: { extractedText: text, format: doc.format, fileName, size: entry.size, pages: doc.units.length },
			};
		},
	};
	return tool;
}
