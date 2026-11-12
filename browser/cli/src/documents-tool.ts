/**
 * The document tools for outside agents: document_get, document_search, document_read and documents. The store lives
 * in the browser (browser/src/documents/), shared with the side panel; these send the calls over the bridge. A file on
 * this computer is read here, checked by the same rules as an upload (file-rules.ts), and sent in chunks.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FILE_CHUNK_TO_EXTENSION } from "../../src/bridge/protocol.ts";
import type { BridgeClient } from "./client.ts";
import { checkUploadPath, type RuleEnv } from "./file-rules.ts";
import { clientWorkFolders } from "./files-tool.ts";
import { filesRoot, mimeFor, privateDirsHere, realOrSelf, UploadReader } from "./saved-files.ts";

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** The document store's own limit (browser/src/documents/parse.ts LIMITS.bytes). */
export const DOCUMENT_MAX_BYTES = 60 * 1024 * 1024;

export interface DocumentToolOptions {
	/** A hub, tunnel or scoped session: no paths from this computer. */
	remote: boolean;
	/** This session's saved files folder (the files tool), which a path may also be in. */
	sessionDir: () => string;
	/** Why this session's scopes refuse a call with these arguments (ARGUMENT_RULES in mcp.ts). */
	denied?: (tool: string, args: unknown) => string | undefined;
	/** A library source by citekey, or undefined. */
	findCitekey?: (citekey: string) => boolean;
	bridgeError: (err: unknown) => Result & { isError: true };
	/** The net under every answer (output-cap.ts). */
	cap: (text: string) => string;
}

const refuse = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

export function registerDocumentTools(server: McpServer, client: BridgeClient, o: DocumentToolOptions): void {
	const say = (value: unknown): Result => {
		const t = value && typeof value === "object" && "text" in value ? String((value as { text: unknown }).text) : JSON.stringify(value);
		return { content: [{ type: "text", text: o.cap(t) }] };
	};
	async function call(method: string, params: Record<string, unknown>): Promise<Result> {
		try {
			return say(await client.call(method, params));
		} catch (err) {
			return o.bridgeError(err);
		}
	}

	/** A local file into the store: checked, read, sent in chunks, then stored whole. */
	async function fromPath(path: string, extra: Record<string, unknown>): Promise<Result> {
		if (o.remote) return refuse("A remote session can't read a path on this computer. Give a url, or tab: true for the PDF or page in your tab.");
		const reader = new UploadReader();
		try {
			const env: RuleEnv = {
				platform: process.platform,
				home: realOrSelf(homedir()),
				remote: false,
				sessionDir: realOrSelf(o.sessionDir()),
				filesRoot: realOrSelf(filesRoot()),
				privateDirs: privateDirsHere(),
				roots: [...(await clientWorkFolders(server)), realOrSelf(join(homedir(), "Downloads"))],
				inspect: reader.inspect,
			};
			const verdict = checkUploadPath(path, env, DOCUMENT_MAX_BYTES);
			if (!verdict.ok) return refuse(`Not read: ${verdict.reason}`);
			// The person isn't asked here: a path outside the project and Downloads is refused instead.
			if (verdict.ask)
				return refuse(
					`Not read: ${verdict.name} is outside your project folders and Downloads. Move it into one of them, or have the person attach it in the side panel.`,
				);
			const bytes = readFileSync(verdict.path);
			if (bytes.length !== verdict.bytes) return refuse(`Not read: ${verdict.name} changed while it was being read.`);
			const transfer = randomUUID();
			for (let at = 0; at < bytes.length || at === 0; at += FILE_CHUNK_TO_EXTENSION) {
				await client.call("documents.put", { transfer, data: bytes.subarray(at, at + FILE_CHUNK_TO_EXTENSION).toString("base64") });
				if (!bytes.length) break;
			}
			return say(await client.call("documents.get", { transfer, name: verdict.name, mime: mimeFor(verdict.name), ...extra }));
		} catch (err) {
			return o.bridgeError(err);
		} finally {
			reader.close();
		}
	}

	server.registerTool(
		"document_get",
		{
			title: "Bring a document into the store",
			description:
				"Store a long PDF or document in the browser to search and read by page: a url (PDF, DOCX, XLSX, PPTX, EPUB, HTML, text; the user's sign-in), your tab, or a path. Answers with an id, pages and outline, no text. Then document_search. " +
				'Example: {"url":"https://example.org/a.pdf"}',
			inputSchema: {
				url: z.string().optional().describe("File address"),
				tab: z.boolean().optional().describe("Your current tab"),
				path: z.string().optional().describe("Absolute path in your project or Downloads"),
				library: z.string().optional().describe("Library citekey to link"),
				refresh: z.boolean().optional().describe("Download again"),
			},
		},
		async (args) => {
			const no = o.denied?.("document_get", args);
			if (no) return refuse(no);
			const picked = [args.url, args.tab ? true : undefined, args.path].filter((v) => v !== undefined && v !== "").length;
			if (picked !== 1) return refuse("Give one of url, tab or path.");
			const library = args.library?.trim();
			if (library && o.findCitekey && !o.findCitekey(library))
				return refuse(`No library source has the citekey ${JSON.stringify(library)}. Find it with library_search, or add it with library_add first.`);
			const extra = { library, refresh: args.refresh };
			if (args.path) return fromPath(args.path, extra);
			if (args.url) return call("documents.get", { url: args.url, ...extra });
			return call("documents.get", { tab: true, ...extra });
		},
	);

	server.registerTool(
		"document_search",
		{
			title: "Search stored documents",
			description:
				"BM25 search of stored documents, offline: best pages first, with id, page and snippet. It matches words, not meaning: put rewordings in the book's own words in also. document_read a page before you quote it. " +
				'Example: {"query":"when the treaty was signed","also":["the treaty was concluded"]}',
			inputSchema: {
				query: z.string().describe("What to find"),
				docs: z.array(z.string()).optional().describe("Document ids (default all)"),
				also: z.array(z.string()).optional().describe("Rewordings of the query"),
				limit: z.number().int().optional().describe("Matches, 1 to 20"),
				maxChars: z.number().int().optional().describe("Longest answer (default 8000)"),
			},
		},
		(args) => call("documents.search", args),
	);

	server.registerTool(
		"document_read",
		{
			title: "Read a stored document",
			description:
				"Read a stored document by pages, outline heading or words from a passage, cut to fit, with page numbers and the url#page=N that opens it there. " +
				'Example: {"doc":"3f9a2c1b","pages":"212-213"}',
			inputSchema: {
				doc: z.string().describe("Document id"),
				pages: z.string().optional().describe('"12" or "40-55"'),
				section: z.string().optional().describe("Outline heading or sheet name"),
				around: z.string().optional().describe("Words from the passage"),
				offset: z.number().int().optional().describe("Characters to skip (the cut note gives it)"),
				maxChars: z.number().int().optional().describe("Longest answer (default 20000)"),
			},
		},
		(args) => call("documents.read", args),
	);

	server.registerTool(
		"documents",
		{
			title: "Manage stored documents",
			description:
				"List, rename or delete stored documents. " +
				'Example: {"action":"list"}',
			inputSchema: {
				action: z.enum(["list", "rename", "delete"]).describe("What to do"),
				doc: z.string().optional().describe("Document id"),
				title: z.string().optional().describe("New title"),
			},
		},
		async (args) => {
			const no = o.denied?.("documents", args);
			if (no) return refuse(no);
			if (args.action === "list") return call("documents.list", {});
			if (!args.doc) return refuse(`${args.action} needs the document's id in doc.`);
			if (args.action === "rename") return call("documents.rename", { doc: args.doc, title: args.title ?? "" });
			return call("documents.delete", { doc: args.doc });
		},
	);
}
