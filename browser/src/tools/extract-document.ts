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
import { CHARS_PER_TOKEN, estimateTextTokens } from "../models/context-budget.js";
import { EXTRACT_DOCUMENT_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import {
	htmlText,
	type ParsedDocument,
	parseExtracted,
	parseRange,
	readOverview,
	readRange,
	readSearch,
} from "./document-reader.js";

const schema = Type.Object({
	url: Type.Optional(Type.String({ description: "URL of the document (PDF, DOCX, XLSX, PPTX or text)" })),
	attachment: Type.Optional(
		Type.String({ description: "Instead of url: the file name of a document the person attached to the chat" }),
	),
	pages: Type.Optional(
		Type.String({
			description:
				'Pages to read, like "40-55" or "12" (slides for PPTX, sheets for XLSX, parts of about 3,000 characters for DOCX)',
		}),
	),
	query: Type.Optional(
		Type.String({ description: "Words to find: returns the matching pages, best first, with numbers and snippets" }),
	),
	copy: Type.Optional(
		Type.Number({
			description: "With attachment, when several share the name: 1 is the newest (the default), 2 the one before",
		}),
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

/** A hash of a document's text (FNV-1a, 32 bits): with its length, what tells two attachments apart. */
function textHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(36);
}

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
			`Could not download the document (${response.status} ${response.statusText}). The site may block downloads: ask the user to download it and attach it with the paperclip, then read it with attachment.`,
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
				"The site blocks downloads from extensions (CORS). Set a CORS proxy in Settings, or ask the user to download the file and attach it with the paperclip, then read it with attachment.",
			);
		data = await download(corsProxyUrl + encodeURIComponent(url), signal);
	}
	let fileName = url.split("#")[0].split("?")[0].split("/").pop() || "document";
	if (url.startsWith("https://arxiv.org/") && !fileName.includes(".")) fileName = `${fileName}.pdf`;
	// A long web page reads as text in parts, like a text file.
	if (/^\s*(<!doctype html|<html)/i.test(new TextDecoder().decode(data.slice(0, 512)))) {
		const extractedText = htmlText(new TextDecoder().decode(data));
		const name = `${fileName.replace(/\.html?$/i, "") || new URL(url).host}.txt`;
		return { extractedText, fileName: name, mimeType: "text/plain", size: data.byteLength };
	}
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
	/** Documents attached to this chat, with the text pi-web-ui extracted from each. */
	attachments?: () => LoadedDocument[];
}

/**
 * The attached document called `name` (exactly, else the one whose name holds it), newest first: the person who attaches
 * a revised report.pdf means that one. `copy` picks an older one of the same name. Or a message saying what is attached.
 */
function findAttachment(files: LoadedDocument[], name: string, copy: number): { file: LoadedDocument; same: number } {
	const want = name.trim().toLowerCase();
	const newest = [...files].reverse();
	let named = newest.filter((f) => f.fileName.toLowerCase() === want);
	if (!named.length) named = newest.filter((f) => f.fileName.toLowerCase().includes(want));
	const file = named[copy - 1];
	if (file) return { file, same: named.length };
	if (named.length)
		throw new Error(
			`${named.length} attached documents are called ${JSON.stringify(name)}: copy is 1 to ${named.length}.`,
		);
	throw new Error(
		files.length
			? `No attached document is called ${JSON.stringify(name)}. Attached: ${files.map((f) => JSON.stringify(f.fileName)).join(", ")}.`
			: "No document is attached to this chat.",
	);
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
			const attachment = String(args.attachment ?? "").trim();
			if (!url === !attachment) throw new Error("Give url or attachment, one of them.");
			let key: string;
			let attached: LoadedDocument | undefined;
			let same = 1;
			const copy = Math.max(1, Math.floor(Number(args.copy) || 1));
			if (attachment) {
				({ file: attached, same } = findAttachment(options.attachments?.() ?? [], attachment, copy));
				// By content, not name and size: another chat's report.pdf of the same size is another document.
				key = `attachment:${attached.extractedText.length}:${textHash(attached.extractedText)}:${attached.fileName}`;
			} else {
				try {
					new URL(url);
				} catch {
					throw new Error(`Not a URL: ${url}`);
				}
				// The viewer's #page=N is not part of the file.
				key = url.split("#")[0];
			}
			let entry = cache.get(key);
			if (entry) {
				cache.delete(key);
			} else {
				const loaded =
					attached ?? (await (options.load ?? ((u, s) => loadFromWeb(u, tool.corsProxyUrl, s)))(key, signal));
				entry = {
					doc: parseExtracted(loaded.extractedText, formatOf(loaded.mimeType, loaded.fileName)),
					fileName: loaded.fileName,
					size: loaded.size,
				};
				while (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
			}
			cache.set(key, entry);
			const { doc, fileName } = entry;
			// The budget as given, never raised: a tight window's 768 characters are 256 tokens, not 333.
			const chars = Math.max(200, Math.floor(options.budgetChars()));
			let range: { first: number; last: number } | undefined;
			if (!args.query?.trim() && args.pages?.trim()) {
				range = parseRange(args.pages, doc.units.length);
				if (!range)
					throw new Error(
						`pages takes one number or a range, like "12" or "40-55", not ${JSON.stringify(args.pages)}.`,
					);
			}
			const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
			const read = (budget: number): string => {
				if (args.query?.trim()) return readSearch(doc, fileName, args.query, budget, attached ? "" : key).text;
				if (range) return readRange(doc, fileName, range, offset, budget).text;
				if (offset) return readRange(doc, fileName, { first: 1, last: doc.units.length }, offset, budget).text;
				return readOverview(doc, fileName, budget).text;
			};
			// The guard measures a result in tokens by script (context-budget.ts), and a page of CJK text or code holds
			// more of them than its length suggests. An answer over that would be cut again and lose its own note on how
			// to read on, so it is read again, smaller, until the guard's own estimate fits.
			const allowed = Math.floor(chars / CHARS_PER_TOKEN);
			let budget = chars;
			let text = read(budget);
			for (let i = 0; i < 10; i++) {
				const tokens = estimateTextTokens(text);
				if (tokens <= allowed || budget <= 200) break;
				budget = Math.max(200, Math.floor((budget * allowed * 0.9) / tokens));
				text = read(budget);
			}
			// Too little room for even the shortest read: say so in a line, which the guard won't cut again.
			if (estimateTextTokens(text) > allowed)
				text = `${fileName}: ${doc.units.length} ${doc.kind}s. The model's context has no room for this read: ask for one ${doc.kind} at a time, or use query.`;
			if (same > 1)
				text = `[${same} attached documents are called ${JSON.stringify(fileName)}: this is copy ${copy}, 1 being the newest.]\n${text}`;
			return {
				content: [{ type: "text", text }],
				details: { extractedText: text, format: doc.format, fileName, size: entry.size, pages: doc.units.length },
			};
		},
	};
	return tool;
}
