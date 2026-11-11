/**
 * The `files` MCP tool (docs/decisions.md, D38): put local files into a page, and bring a page's
 * files back. This side reads and writes the disk; the browser never sees a host path. Which paths
 * may be read is decided by file-rules.ts before anything is sent to the bridge, and content moves
 * in pieces under the bridge's frame limit, announced by size and SHA-256 and checked on both ends.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FILE_ASK_TIMEOUT_MS, FILE_CHUNK_FROM_EXTENSION, FILE_CHUNK_TO_EXTENSION } from "../../src/bridge/protocol.ts";
import { type BridgeClient, BridgeRpcError } from "./client.ts";
import { checkUploadCaps, checkUploadPath, MAX_UPLOAD_FILES, type RuleEnv } from "./file-rules.ts";
import {
	byteSize,
	filesRoot,
	isTextMime,
	MAX_SAVED_BYTES,
	mimeFor,
	READ_BLOB_CAP,
	READ_TEXT_CAP,
	privateDirsHere,
	realOrSelf,
	type SavedFile,
	SavedFiles,
	sniffImage,
	UploadReader,
} from "./saved-files.ts";

type Block =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };
type Result = { content: Block[]; isError?: boolean };

export interface FilesToolOptions {
	/** The session the client asked for. Its saved files are kept under the name it really has (see `auto`). */
	session: string;
	/** A default project session: the extension may give the client another name, so the name is confirmed first. */
	auto?: boolean;
	/** Why this session's scopes refuse a call with these arguments, or undefined (ARGUMENT_RULES in mcp.ts). */
	denied?: (args: unknown) => string | undefined;
	/** Told where the files of an upload that asks the person are, in order, and undefined when the asking is over. */
	asking?: (paths: string[] | undefined) => void;
	/** A hub, tunnel or scoped session: no paths in, no paths out. */
	remote: boolean;
	/** Shared argument shapes from mcp.ts, so the tool reads like the others. */
	shapes: { tabId: z.ZodTypeAny; ref: z.ZodTypeAny; selector: z.ZodTypeAny };
	/** A bridge failure as the model should read it (mcp.ts errorResult). */
	bridgeError: (err: unknown) => { content: Array<{ type: "text"; text: string }>; isError: true };
}

export const FILES_DESCRIPTION =
	"Move files between this computer and a page. upload: local files (absolute paths, or ids of saved files) onto a file input or drop area; a path outside your project asks the user, credential files are refused. download: save a url, or a link or image by ref. save_pdf: the page as PDF. list, read, remove: this session's saved files. " +
	'Example: {"action":"upload","ref":"e12","paths":["/home/me/app/report.pdf"]}';

const say = (value: unknown): Result => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const refuse = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

interface Incoming {
	transferId: string;
	bytes: number;
	chunks: number;
	mime?: string;
	name?: string;
	url?: string;
}

/** What mcp.ts and remote.ts do to a session's saved files from outside the tool. */
export interface FilesTool {
	/** The session ended: its saved files go. */
	clear(): void;
	/** The session has a new name: its folder follows. */
	renamed(session: string): void;
}

/** An error from this computer's disk as a remote caller may read it: what failed, never where. */
function withoutPaths(err: unknown): string {
	const code = (err as NodeJS.ErrnoException)?.code;
	return `The file could not be kept on the computer${typeof code === "string" ? ` (${code})` : ""}. Nothing was saved.`;
}

export function registerFiles(server: McpServer, client: BridgeClient, o: FilesToolOptions): FilesTool {
	let saved = new SavedFiles(o.session);
	/** True once `saved` is the folder of the session this client really has. */
	let confirmed = false;

	/**
	 * Point `saved` at this client's own session. Two agents in one project ask for the same default session and the
	 * extension gives the second "<name>-2" when it connects, so the name is only known after the extension has
	 * answered once; a client that has heard nothing yet asks for its status first.
	 */
	async function ownFolder(): Promise<void> {
		if (o.auto && !client.answered) await client.call("status", {}, 5000).catch(() => undefined);
		const name = client.session ?? o.session;
		if (name !== saved.session) saved = new SavedFiles(name);
		confirmed = true;
	}

	/** What the caller is told about a saved file. Only a local caller learns where it is on disk. */
	const describe = (f: SavedFile) => ({ ...f, ...(o.remote ? {} : { path: saved.pathOf(f) }) });

	/** The folders the agent already works in: the client's roots, or the working directory when it has none to give. */
	async function workFolders(): Promise<string[]> {
		if (server.server.getClientCapabilities()?.roots) {
			try {
				const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
				return roots.flatMap((r) => {
					try {
						return r.uri.startsWith("file:") ? [realOrSelf(fileURLToPath(r.uri))] : [];
					} catch {
						return [];
					}
				});
			} catch {
				// A client that says it has roots and then can't list them has none: every path asks.
				return [];
			}
		}
		return [realOrSelf(process.cwd())];
	}

	async function upload(args: { tabId?: number; ref?: string; selector?: string; paths?: string[]; ids?: string[] }): Promise<Result> {
		const paths = args.paths ?? [];
		const ids = args.ids ?? [];
		// Decided before anything else, and before the bridge hears of the call.
		if (o.remote && paths.length)
			return refuse("A remote session can't upload from a path on this computer. Use ids of files this session saved (download or save_pdf).");
		if (!args.ref && !args.selector) return refuse("upload needs the ref of a file input or drop area (read_page gives refs).");
		if (paths.length + ids.length === 0) return refuse("Give at least one file: paths or ids.");
		if (paths.length + ids.length > MAX_UPLOAD_FILES) return refuse(`${paths.length + ids.length} files given; one upload takes at most ${MAX_UPLOAD_FILES}.`);

		const reader = new UploadReader();
		try {
			const picked: Array<{ name: string; bytes: number; ask: boolean; path?: string; read: () => Buffer }> = [];
			if (paths.length) {
				const env: RuleEnv = {
					platform: process.platform,
					home: realOrSelf(homedir()),
					remote: o.remote,
					sessionDir: realOrSelf(saved.dir),
					filesRoot: realOrSelf(filesRoot()),
					privateDirs: privateDirsHere(),
					roots: await workFolders(),
					inspect: reader.inspect,
				};
				for (const path of paths) {
					const verdict = checkUploadPath(path, env);
					if (!verdict.ok) return refuse(`Not uploaded: ${verdict.reason}`);
					const real = verdict.path;
					picked.push({ name: verdict.name, bytes: verdict.bytes, ask: verdict.ask, path: real, read: () => reader.read(real) });
				}
			}
			for (const id of ids) {
				const file = saved.get(id);
				if (!file) return refuse(`No saved file has the id ${id}. Call files with action "list".`);
				picked.push({ name: file.name, bytes: file.bytes, ask: false, read: () => saved.read(file) });
			}
			const caps = checkUploadCaps(picked.map((p) => p.bytes));
			if (!caps.ok) return refuse(`Not uploaded: ${caps.reason}`);

			const buffers = picked.map((p) => p.read());
			const files = picked.map((p, i) => ({
				name: p.name,
				bytes: buffers[i].length,
				mime: mimeFor(p.name),
				sha256: createHash("sha256").update(buffers[i]).digest("hex"),
				lastModified: Date.now(),
				ask: p.ask,
			}));
			// The sizes the rules judged are the sizes that are sent.
			if (files.some((f, i) => f.bytes !== picked[i].bytes)) return refuse("Not uploaded: a file changed while it was being read.");

			let transferId = "";
			try {
				// The question names each file by its full path here; the browser is sent names only.
				o.asking?.(picked.filter((p) => p.ask).map((p) => p.path ?? p.name));
				const begun = await client.call<{ transferId: string }>(
					"files.upload.begin",
					{ tabId: args.tabId, ref: args.ref, selector: args.selector, files },
					FILE_ASK_TIMEOUT_MS + 45000,
				);
				transferId = begun.transferId;
				const all = Buffer.concat(buffers);
				for (let at = 0, seq = 0; at < all.length; at += FILE_CHUNK_TO_EXTENSION, seq++)
					await client.call("files.upload.chunk", { transferId, seq, data: all.subarray(at, at + FILE_CHUNK_TO_EXTENSION).toString("base64") });
				const done = await client.call<Record<string, unknown>>("files.upload.commit", { transferId });
				return say({ uploaded: done.files, host: done.host, target: done.target, holds: done.holds, ...(done.note ? { note: done.note } : {}) });
			} catch (err) {
				if (transferId) await client.call("files.upload.abort", { transferId }).catch(() => undefined);
				return o.bridgeError(err);
			} finally {
				o.asking?.(undefined);
			}
		} finally {
			reader.close();
		}
	}

	/** Pull an announced transfer into a new saved file, piece by piece, checking each against what was announced. */
	async function receive(info: Incoming, fallbackName: string, check?: (first: Buffer) => string | undefined): Promise<Result> {
		const end = () => client.call("files.download.end", { transferId: info.transferId }).catch(() => undefined);
		const bytes = Number(info.bytes);
		const pieces = Math.ceil(bytes / FILE_CHUNK_FROM_EXTENSION);
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SAVED_BYTES || Number(info.chunks) !== pieces) {
			await end();
			return refuse(`Not saved: the browser announced a file of ${String(info.bytes)} bytes, and one saved file may be at most ${byteSize(MAX_SAVED_BYTES)}.`);
		}
		const full = saved.full(bytes);
		if (full) {
			await end();
			return refuse(`Not saved: ${full}`);
		}
		const writer = saved.create({ name: info.name || fallbackName, mime: info.mime, sourceUrl: String(info.url ?? "").slice(0, 2000), bytes });
		try {
			for (let index = 0; index < pieces; index++) {
				const { data } = await client.call<{ data: string }>("files.download.chunk", { transferId: info.transferId, index });
				const piece = Buffer.from(String(data), "base64");
				const expected = Math.min(FILE_CHUNK_FROM_EXTENSION, bytes - index * FILE_CHUNK_FROM_EXTENSION);
				if (piece.length !== expected) throw new Error(`piece ${index} arrived as ${piece.length} bytes, not ${expected}`);
				if (index === 0) {
					const wrong = check?.(piece);
					if (wrong) throw new Error(wrong);
				}
				writer.write(piece);
			}
			return say(describe(writer.finish(bytes)));
		} catch (err) {
			writer.abort();
			// A disk error names a path on this computer; a bridge error (it has a code of its own) does not.
			if (o.remote && !(err instanceof BridgeRpcError) && typeof (err as NodeJS.ErrnoException)?.code === "string") return refuse(withoutPaths(err));
			const shaped = o.bridgeError(err);
			return refuse(`Not saved: ${shaped.content[0]?.text ?? String(err)}`);
		} finally {
			await end();
		}
	}

	function read(args: { id?: string; max_bytes?: number }): Result {
		const file = args.id ? saved.get(args.id) : undefined;
		if (!file) return refuse(`No saved file has the id ${String(args.id)}. Call files with action "list".`);
		const where = o.remote ? "" : ` It is at ${saved.pathOf(file)}.`;
		const limit = args.max_bytes && args.max_bytes > 0 ? args.max_bytes : undefined;
		if (isTextMime(file.mime)) {
			const cap = Math.min(limit ?? READ_TEXT_CAP, READ_TEXT_CAP);
			const all = saved.read(file);
			const cut = all.length > cap;
			// A cut may land inside a character; the broken tail is dropped.
			const body = (cut ? all.subarray(0, cap) : all).toString("utf8").replace(/\ufffd+$/, "");
			return say(cut ? `${body}\n\n[Cut: the first ${byteSize(cap)} of ${byteSize(all.length)} (${file.name}).${where}]` : body);
		}
		const cap = Math.min(limit ?? READ_BLOB_CAP, READ_BLOB_CAP);
		if (file.bytes > cap)
			return refuse(`${file.name} is ${file.bytes} bytes (${byteSize(file.bytes)}); read returns at most ${byteSize(cap)} of a file that is not text.${where}`);
		const bytes = saved.read(file);
		const note = `${file.name}, ${byteSize(bytes.length)}, ${file.mime}`;
		// An image block only for bytes that really are that image, whatever the server called them.
		const image = sniffImage(bytes);
		if (image) return { content: [{ type: "text", text: note }, { type: "image", data: bytes.toString("base64"), mimeType: image }] };
		return {
			content: [
				{ type: "text", text: note },
				{ type: "resource", resource: { uri: `polycarp-file:///${file.id}/${encodeURIComponent(file.name)}`, mimeType: file.mime, blob: bytes.toString("base64") } },
			],
		};
	}

	server.registerTool(
		"files",
		{
			title: "Files",
			description: FILES_DESCRIPTION,
			inputSchema: {
				action: z.enum(["upload", "download", "save_pdf", "list", "read", "remove"]).describe("What to do"),
				tabId: o.shapes.tabId,
				ref: o.shapes.ref,
				selector: o.shapes.selector,
				paths: z.array(z.string()).optional().describe("upload: absolute local paths"),
				ids: z.array(z.string()).optional().describe("upload: saved file ids"),
				url: z.string().optional().describe("download: file URL"),
				id: z.string().optional().describe("read, remove: saved file id"),
				max_bytes: z.number().int().positive().optional().describe("read: byte limit"),
			},
		},
		async (raw): Promise<Result> => {
			const args = raw as { action: string; tabId?: number; ref?: string; selector?: string; paths?: string[]; ids?: string[]; url?: string; id?: string; max_bytes?: number };
			const denied = o.denied?.(args);
			if (denied) return refuse(denied);
			// Decided before the bridge hears of the call, whatever the path.
			if (args.action === "upload" && o.remote && args.paths?.length)
				return refuse("A remote session can't upload from a path on this computer. Use ids of files this session saved (download or save_pdf).");
			try {
				await ownFolder();
				if (args.action === "upload") return await upload(args);
				if (args.action === "download") {
					if (!args.url && !args.ref && !args.selector) return refuse("download needs a url, or the ref of a link, image or media element.");
					let info: Incoming;
					try {
						info = await client.call<Incoming>("files.download.begin", { tabId: args.tabId, url: args.url, ref: args.ref, selector: args.selector }, 120000);
					} catch (err) {
						return o.bridgeError(err);
					}
					return await receive(info, "download");
				}
				if (args.action === "save_pdf") {
					let info: Incoming;
					try {
						info = await client.call<Incoming>("files.pdf.begin", { tabId: args.tabId }, 120000);
					} catch (err) {
						return o.bridgeError(err);
					}
					return await receive(info, "page.pdf", (first) => (first.subarray(0, 4).toString("latin1") === "%PDF" ? undefined : "the browser did not return a PDF"));
				}
				if (args.action === "list") return say({ files: saved.list().map(describe) });
				if (args.action === "read") return read(args);
				if (args.action === "remove") {
					const gone = args.id ? saved.remove(args.id) : undefined;
					return gone ? say({ removed: gone.id, name: gone.name }) : refuse(`No saved file has the id ${String(args.id)}.`);
				}
				return refuse("action must be upload, download, save_pdf, list, read or remove.");
			} catch (err) {
				// "never told a path" holds for errors too: privateDir and the file system name the folder they failed on.
				return refuse(o.remote ? withoutPaths(err) : err instanceof Error ? err.message : String(err));
			}
		},
	);
	return {
		// Before the session is confirmed nothing was saved by this client, and the folder may be another agent's.
		clear: () => {
			if (confirmed) saved.clear();
		},
		renamed: (session) => {
			if (confirmed) saved = saved.renamedTo(session);
		},
	};
}
