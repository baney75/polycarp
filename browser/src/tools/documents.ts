/**
 * The side panel's document tools: document_get brings a document into the store (from a web address, the agent's tab
 * or a file the person attached), document_search finds passages across stored documents, document_read reads pages by
 * number, and documents lists, renames and deletes them. Every answer fits the model's budget (context-budget.ts).
 * The store and its search are src/documents/; nothing here leaves the machine but the one download a web address asks
 * for.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getCurrentBrowserSession } from "../browser/current.js";
import { DocumentError } from "../documents/errors.js";
import type { DocumentService, GetSource } from "../documents/service.js";
import { tabSource } from "../documents/tab.js";
import {
	DOCUMENT_GET_TOOL_DESCRIPTION,
	DOCUMENT_READ_TOOL_DESCRIPTION,
	DOCUMENT_SEARCH_TOOL_DESCRIPTION,
	DOCUMENTS_TOOL_DESCRIPTION,
} from "../prompts/prompts.js";

const getSchema = Type.Object({
	url: Type.Optional(
		Type.String({ description: "Web address of the file (PDF, DOCX, XLSX, PPTX, EPUB, HTML, text)" }),
	),
	tab: Type.Optional(Type.Boolean({ description: "true: the page or PDF open in your current tab" })),
	attachment: Type.Optional(Type.String({ description: "File name of a file the person attached to the chat" })),
	title: Type.Optional(Type.String({ description: "A title to store it under, when the file's own is poor" })),
	library: Type.Optional(Type.String({ description: "Citekey of the library source this document belongs to" })),
	refresh: Type.Optional(Type.Boolean({ description: "Download again even if this address is stored" })),
});

const searchSchema = Type.Object({
	query: Type.String({ description: "What to find, in a few words" }),
	docs: Type.Optional(
		Type.Array(Type.String(), { description: "Document ids to search; all stored ones if left out" }),
	),
	also: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Two or three other wordings of the query in the words the author would use (older or technical terms, the opposite phrasing for a negation)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "How many matches, 1 to 20 (default 8)" })),
});

const readSchema = Type.Object({
	doc: Type.String({ description: "Document id from document_get or document_search" }),
	pages: Type.Optional(Type.String({ description: 'Pages (slides, sheets, sections) to read: "12" or "40-55"' })),
	section: Type.Optional(Type.String({ description: "A heading from the outline, or a sheet's name" })),
	around: Type.Optional(Type.String({ description: "Words from a passage: reads the page that matches best" })),
	offset: Type.Optional(
		Type.Number({ description: "Skip this many characters of the range (the cut note gives it)" }),
	),
});

const manageSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("rename"), Type.Literal("delete")], {
		description: "list, rename or delete",
	}),
	doc: Type.Optional(Type.String({ description: "Document id, for rename and delete" })),
	title: Type.Optional(Type.String({ description: "New title, for rename" })),
});

export interface DocumentToolDetails {
	doc?: string;
	title?: string;
	pages?: number;
}

export interface AttachmentFile {
	fileName: string;
	mimeType: string;
	/** Base64 of the file. */
	content: string;
}

export interface DocumentToolOptions {
	/** The store, loaded on first use (src/lazy/documents.ts). */
	service: () => DocumentService | Promise<DocumentService>;
	/** Characters an answer may hold, from the current model's window. */
	budgetChars: () => number;
	/** Files attached to this chat. */
	attachments: () => AttachmentFile[];
	/** The agent's tab as a source (tests replace it). */
	tab?: () => Promise<GetSource>;
}

const text = (t: string, details: DocumentToolDetails = {}) => ({
	content: [{ type: "text" as const, text: t }],
	details,
});

function base64Bytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** A DocumentError is the model's to read and act on; anything else is a bug and keeps its stack. */
async function friendly<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (err) {
		if (err instanceof DocumentError) throw new Error(err.message);
		throw err;
	}
}

async function currentTabSource(): Promise<GetSource> {
	const tab = await getCurrentBrowserSession().currentTab();
	if (!tab?.id)
		throw new DocumentError("You have no tab open. Open the document with navigate first, or pass its url.");
	return tabSource(tab.id);
}

export function createDocumentTools(options: DocumentToolOptions): AgentTool<any, DocumentToolDetails>[] {
	const budget = () => Math.max(1000, Math.floor(options.budgetChars()));

	const get: AgentTool<typeof getSchema, DocumentToolDetails> = {
		label: "Get Document",
		name: "document_get",
		description: DOCUMENT_GET_TOOL_DESCRIPTION,
		parameters: getSchema,
		execute: (_id, args: Static<typeof getSchema>, signal) =>
			friendly(async () => {
				const picked = [args.url?.trim(), args.tab, args.attachment?.trim()].filter(Boolean).length;
				if (picked !== 1) throw new DocumentError("Give one of url, tab or attachment.");
				let source: GetSource;
				if (args.url?.trim()) {
					source = { url: args.url.trim() };
				} else if (args.tab) {
					source = await (options.tab ?? currentTabSource)();
				} else {
					const want = String(args.attachment).trim().toLowerCase();
					const files = options.attachments();
					const file =
						files.find((f) => f.fileName.toLowerCase() === want) ??
						files.find((f) => f.fileName.toLowerCase().includes(want));
					if (!file)
						throw new DocumentError(
							files.length
								? `No attached file is called ${JSON.stringify(args.attachment)}. Attached: ${files.map((f) => JSON.stringify(f.fileName)).join(", ")}.`
								: "No file is attached to this chat. Ask the person to attach it with the paperclip.",
						);
					source = {
						bytes: base64Bytes(file.content),
						name: file.fileName,
						mime: file.mimeType,
						source: "attachment",
					};
				}
				const { meta, summary } = await (await options.service()).get(source, {
					refresh: args.refresh,
					library: args.library,
					title: args.title,
					signal,
				});
				return text(summary, { doc: meta.id, title: meta.title, pages: meta.units });
			}),
	};

	const searchTool: AgentTool<typeof searchSchema, DocumentToolDetails> = {
		label: "Search Documents",
		name: "document_search",
		description: DOCUMENT_SEARCH_TOOL_DESCRIPTION,
		parameters: searchSchema,
		execute: (_id, args: Static<typeof searchSchema>) =>
			friendly(async () =>
				text(
					await (await options.service()).searchText(
						args.query,
						{ docs: args.docs, also: args.also, limit: Math.max(1, Math.min(20, Number(args.limit) || 8)) },
						budget(),
					),
				),
			),
	};

	const read: AgentTool<typeof readSchema, DocumentToolDetails> = {
		label: "Read Document",
		name: "document_read",
		description: DOCUMENT_READ_TOOL_DESCRIPTION,
		parameters: readSchema,
		execute: (_id, args: Static<typeof readSchema>) =>
			friendly(async () => text(await (await options.service()).read(args.doc, args, budget()), { doc: args.doc })),
	};

	const manage: AgentTool<typeof manageSchema, DocumentToolDetails> = {
		label: "Documents",
		name: "documents",
		description: DOCUMENTS_TOOL_DESCRIPTION,
		parameters: manageSchema,
		execute: (_id, args: Static<typeof manageSchema>) =>
			friendly(async () => {
				const svc = await options.service();
				if (args.action === "list") return text(await svc.listText());
				if (!args.doc?.trim()) throw new DocumentError(`${args.action} needs the document's id in doc.`);
				if (args.action === "rename") {
					const m = await svc.rename(args.doc, args.title ?? "");
					return text(`Renamed ${m.id} to ${JSON.stringify(m.title)}.`, { doc: m.id, title: m.title });
				}
				if (args.action === "delete") {
					const m = await svc.remove(args.doc);
					return text(`Deleted ${m.id} (${JSON.stringify(m.title)}) from the document store.`, { doc: m.id });
				}
				throw new DocumentError(`action is list, rename or delete, not ${JSON.stringify(args.action)}.`);
			}),
	};

	return [get, searchTool, read, manage];
}
