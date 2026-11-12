/**
 * extract_document, bounded: it never answers with more than the budget the current model's window allows
 * (context-budget.ts). With `pages` it reads a range, with `query` it finds the pages that match, and with neither
 * it gives the page count and the first pages with a note on how to get the rest. pi-web-ui's tool returned the
 * whole document as one string, which on a 400-page book was 706,000 characters and broke the chat for good.
 *
 * Parsing stays pi-web-ui's (loadAttachment: PDF, DOCX, XLSX, PPTX, text); reading in parts is document-reader.ts.
 * A document is downloaded and parsed once per URL while the panel is open.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { isCorsError, loadAttachment } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { EXTRACT_DOCUMENT_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import {
	type ParsedDocument,
	parseExtracted,
	parseRange,
	readOverview,
	readRange,
	readSearch,
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

const MAX_SIZE = 50 * 1024 * 1024;
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

async function download(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
	const response = await fetch(url, { signal });
	if (!response.ok)
		throw new Error(
			`Could not download the document (${response.status} ${response.statusText}). The site may block downloads: ask the user to download it and attach it with the paperclip.`,
		);
	const length = Number(response.headers.get("content-length") ?? 0);
	if (length > MAX_SIZE)
		throw new Error(`The document is ${(length / 1048576).toFixed(1)} MB, over the 50 MB this reads.`);
	const data = await response.arrayBuffer();
	if (data.byteLength > MAX_SIZE) throw new Error("The document is over the 50 MB this reads.");
	return data;
}

/** pi-web-ui's fetch: direct first, then the CORS proxy when one is set. */
async function loadFromWeb(
	url: string,
	corsProxyUrl: string | undefined,
	signal?: AbortSignal,
): Promise<LoadedDocument> {
	let data: ArrayBuffer;
	try {
		data = await download(url, signal);
	} catch (err) {
		if (!isCorsError(err)) throw err;
		if (!corsProxyUrl)
			throw new Error(
				"The site blocks downloads from extensions (CORS). Set a CORS proxy in Settings, or ask the user to download the file and attach it with the paperclip.",
			);
		data = await download(corsProxyUrl + encodeURIComponent(url), signal);
	}
	let fileName = url.split("#")[0].split("?")[0].split("/").pop() || "document";
	if (url.startsWith("https://arxiv.org/") && !fileName.includes(".")) fileName = `${fileName}.pdf`;
	const attachment = await loadAttachment(data, fileName);
	if (!attachment.extractedText)
		throw new Error("This format can't be read as text. Supported: PDF, DOCX, XLSX, PPTX and text files.");
	return {
		extractedText: attachment.extractedText,
		fileName: attachment.fileName,
		mimeType: attachment.mimeType,
		size: attachment.size,
	};
}

export interface ExtractDocumentOptions {
	/** Characters the answer may hold, from the current model's window. */
	budgetChars: () => number;
	/** Replaces the web fetch and parse (tests). */
	load?: (url: string, signal?: AbortSignal) => Promise<LoadedDocument>;
}

export type ExtractDocumentTool = AgentTool<typeof schema, ExtractDocumentDetails> & { corsProxyUrl?: string };

export function createExtractDocumentTool(options: ExtractDocumentOptions): ExtractDocumentTool {
	const tool: ExtractDocumentTool = {
		label: "Extract Document",
		name: "extract_document",
		description: EXTRACT_DOCUMENT_TOOL_DESCRIPTION,
		parameters: schema,
		corsProxyUrl: undefined,
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
				const loaded = await (options.load ?? ((u, s) => loadFromWeb(u, tool.corsProxyUrl, s)))(key, signal);
				entry = {
					doc: parseExtracted(loaded.extractedText, formatOf(loaded.mimeType, loaded.fileName)),
					fileName: loaded.fileName,
					size: loaded.size,
				};
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
