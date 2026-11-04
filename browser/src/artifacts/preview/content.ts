import JSZip from "jszip";

/** Limits shared by the document previews. A file over a limit shows a message instead of a preview. */
export const PREVIEW_LIMITS = {
	/** Largest decoded file any parsing preview (pptx, odf, rtf, notebook, csv) reads. */
	maxDocumentBytes: 40 * 1024 * 1024,
	/** Largest media file played in the panel. */
	maxMediaBytes: 100 * 1024 * 1024,
	/**
	 * Spreadsheets: SheetJS parses whole sheet parts even though only the first rows are shown,
	 * so a large but honest workbook needs more room than a document.
	 */
	maxSpreadsheetBytes: 100 * 1024 * 1024,
	maxSpreadsheetEntryBytes: 120 * 1024 * 1024,
	maxSpreadsheetTotalBytes: 250 * 1024 * 1024,
	/** Largest single zip entry inflated (XML parts and images). */
	maxZipEntryBytes: 30 * 1024 * 1024,
	/** Total bytes inflated from one archive. */
	maxZipTotalBytes: 120 * 1024 * 1024,
	/** Most entries an archive may list. */
	maxZipEntries: 10_000,
	/** Most slides or pages rendered. */
	maxSlides: 300,
	/** Most table rows rendered for CSV, TSV and spreadsheets. */
	maxTableRows: 5_000,
	/** Most table columns rendered. */
	maxTableColumns: 500,
	/** Most table cells rendered in one table. */
	maxTableCells: 200_000,
	/** Most custom-geometry drawing commands across a deck. */
	maxDeckCommands: 1_000_000,
	/** Most elements drawn across all slides of a deck. */
	maxDeckElements: 50_000,
	/** Most text runs in one document or deck. */
	maxTextRuns: 200_000,
	/** Most characters of text in one document. */
	maxTextChars: 5_000_000,
	/** Most notebook outputs rendered. */
	maxOutputs: 5_000,
	/** Most notebook cells rendered. */
	maxCells: 2_000,
};

export class PreviewLimitError extends Error {}

export interface ZipLimits {
	maxEntryBytes: number;
	maxTotalBytes: number;
}

function stripDataUrl(content: string): string {
	if (content.startsWith("data:")) {
		const comma = content.indexOf(",");
		return comma >= 0 ? content.slice(comma + 1) : "";
	}
	return content;
}

/** Decoded size of a base64 string, without decoding it. */
export function base64DecodedSize(content: string): number {
	const data = normalizeBase64(content);
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Strip a data-URL prefix and whitespace and map URL-safe characters, copying only when needed. */
function normalizeBase64(content: string): string {
	let data = stripDataUrl(content);
	if (/\s/.test(data)) data = data.replace(/\s+/g, "");
	if (/[-_]/.test(data)) data = data.replace(/-/g, "+").replace(/_/g, "/");
	return data;
}

/** Decode artifact content stored as base64 or a base64 data URL. Throws on anything else. */
export function decodeBase64Content(content: string, maxBytes = PREVIEW_LIMITS.maxDocumentBytes): Uint8Array {
	const data = normalizeBase64(content);
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	if (Math.floor((data.length * 3) / 4) - padding > maxBytes) {
		throw new PreviewLimitError(`File is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
	}
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Content is not base64");
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Decoded bytes of artifact content, decoded once per content value and shared by the preview
 * and the download button. Undefined when the content is not base64.
 */
export class DecodedContent {
	private last?: { content: string; bytes?: Uint8Array };

	bytes(content: string): Uint8Array | undefined {
		if (this.last?.content !== content) {
			let bytes: Uint8Array | undefined;
			try {
				bytes = decodeBase64Content(content, Number.POSITIVE_INFINITY);
			} catch {
				bytes = undefined;
			}
			this.last = { content, bytes };
		}
		return this.last.bytes;
	}
}

/**
 * Content of a text format (csv, rtf, ipynb). Agents usually store these as text, but a REPL
 * may store them as base64; `looksRight` decides which reading is the file. Content that is
 * nothing but base64 (or a data URL) is decoded first, if it decodes to valid UTF-8 text that
 * looks right, so wrapped base64 with newlines isn't mistaken for text.
 */
export function readTextContent(content: string, looksRight: (text: string) => boolean): string {
	if (content.startsWith("data:") || (content.length >= 8 && /^[A-Za-z0-9+/=_\-\s]+$/.test(content))) {
		try {
			// Decode in full: the preview checks its own size limit, and download is not limited.
			const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
				decodeBase64Content(content, Number.POSITIVE_INFINITY),
			);
			if (looksRight(decoded) && !/[\u0000-\u0008\u000e-\u001f]/.test(decoded.slice(0, 4096))) return decoded;
		} catch {
			// Not base64 text; read it as written.
		}
	}
	if (looksRight(content)) return content;
	try {
		const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
			decodeBase64Content(content, Number.POSITIVE_INFINITY),
		);
		if (looksRight(decoded)) return decoded;
	} catch {
		// Not base64; fall through to the raw text.
	}
	return content;
}

interface StreamHelper {
	on(event: "data", cb: (chunk: Uint8Array) => void): StreamHelper;
	on(event: "end", cb: () => void): StreamHelper;
	on(event: "error", cb: (e: Error) => void): StreamHelper;
	resume(): StreamHelper;
	pause(): StreamHelper;
}

interface StreamableZipObject {
	internalStream(type: "uint8array"): StreamHelper;
}

function isStreamable(file: unknown): file is StreamableZipObject {
	return typeof (file as { internalStream?: unknown }).internalStream === "function";
}

/**
 * Reads entries from an untrusted archive. Every entry is inflated through a stream that stops
 * at the per-entry limit, and the archive as a whole has a byte budget, so a zip bomb fails
 * fast instead of freezing the panel.
 */
export class SafeZip {
	private used = 0;

	private constructor(
		private readonly zip: JSZip,
		private readonly limits: ZipLimits,
	) {}

	static async open(
		bytes: Uint8Array,
		limits: ZipLimits = {
			maxEntryBytes: PREVIEW_LIMITS.maxZipEntryBytes,
			maxTotalBytes: PREVIEW_LIMITS.maxZipTotalBytes,
		},
	): Promise<SafeZip> {
		// Count entries before JSZip builds an object for each one, so an archive of a million
		// empty entries fails at once.
		if (countZipEntries(bytes, PREVIEW_LIMITS.maxZipEntries) > PREVIEW_LIMITS.maxZipEntries) {
			throw new PreviewLimitError("Archive has too many entries to preview");
		}
		const zip = await JSZip.loadAsync(bytes);
		if (Object.keys(zip.files).length > PREVIEW_LIMITS.maxZipEntries) {
			throw new PreviewLimitError("Archive has too many entries to preview");
		}
		return new SafeZip(zip, limits);
	}

	has(path: string): boolean {
		const file = this.zip.file(path);
		return !!file && !file.dir;
	}

	list(): string[] {
		return Object.keys(this.zip.files).filter((p) => !this.zip.files[p].dir);
	}

	async bytes(path: string): Promise<Uint8Array | undefined> {
		const file = this.zip.file(path);
		if (!file || file.dir) return undefined;
		const remaining = this.limits.maxTotalBytes - this.used;
		const cap = Math.min(this.limits.maxEntryBytes, remaining);
		// Fail fast on the size the archive declares; the capped stream below still guards
		// against an archive that understates it.
		const declared = declaredSize(file);
		if (declared !== undefined && declared > cap)
			throw new PreviewLimitError("A part of this file is too large to preview");
		const data = await readCapped(file, cap);
		this.used += data.length;
		return data;
	}

	async text(path: string): Promise<string | undefined> {
		const data = await this.bytes(path);
		return data ? new TextDecoder("utf-8").decode(data) : undefined;
	}
}

/** Uncompressed size from the zip directory. JSZip keeps it on a private field. */
function declaredSize(file: JSZip.JSZipObject): number | undefined {
	const size = (file as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
	return typeof size === "number" && size >= 0 ? size : undefined;
}

function readCapped(file: JSZip.JSZipObject, cap: number): Promise<Uint8Array> {
	if (!isStreamable(file)) {
		return file.async("uint8array").then((data) => {
			if (data.length > cap) throw new PreviewLimitError("A part of this file is too large to preview");
			return data;
		});
	}
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let total = 0;
		let done = false;
		const stream = file.internalStream("uint8array");
		stream
			.on("data", (chunk) => {
				if (done) return;
				total += chunk.length;
				if (total > cap) {
					done = true;
					stream.pause();
					reject(new PreviewLimitError("A part of this file is too large to preview"));
					return;
				}
				chunks.push(chunk);
			})
			.on("error", (e) => {
				if (done) return;
				done = true;
				reject(e);
			})
			.on("end", () => {
				if (done) return;
				done = true;
				const out = new Uint8Array(total);
				let offset = 0;
				for (const c of chunks) {
					out.set(c, offset);
					offset += c.length;
				}
				resolve(out);
			})
			.resume();
	});
}

/**
 * Central-directory records in an archive, counted the way JSZip reads them (one after another
 * while the signature matches, whatever the end record claims) but without building anything.
 * Stops counting past `limit`. Zero when there is no end record; JSZip reports that itself.
 */
export function countZipEntries(bytes: Uint8Array, limit: number): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const stop = Math.max(0, bytes.length - 22 - 0xffff);
	for (let i = bytes.length - 22; i >= stop; i--) {
		if (view.getUint32(i, true) !== 0x06054b50) continue;
		let offset = view.getUint32(i + 16, true);
		if (offset === 0xffffffff && i >= 20 && view.getUint32(i - 20, true) === 0x07064b50) {
			const at = Number(view.getBigUint64(i - 12, true));
			if (at + 56 <= bytes.length && view.getUint32(at, true) === 0x06064b50)
				offset = Number(view.getBigUint64(at + 48, true));
		}
		// Like JSZip, allow for bytes prepended to the archive: the directory then sits that much later.
		const extra = i - (offset + view.getUint32(i + 12, true));
		if (extra > 0 && !(offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x02014b50)) offset += extra;
		let count = 0;
		while (offset + 46 <= bytes.length && view.getUint32(offset, true) === 0x02014b50 && count <= limit) {
			offset +=
				46 +
				view.getUint16(offset + 28, true) +
				view.getUint16(offset + 30, true) +
				view.getUint16(offset + 32, true);
			count++;
		}
		return count;
	}
	return 0;
}

/** Resolve a relationship target against the folder of the part that names it. */
export function resolvePartPath(baseDir: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = baseDir ? baseDir.split("/") : [];
	for (const seg of target.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== "." && seg !== "") parts.push(seg);
	}
	return parts.join("/");
}

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	jfif: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
};

/** MIME type for an embedded image the browser can decode, or undefined (EMF, WMF, TIFF, ...). */
export function browserImageMime(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_MIME[ext];
}
