/**
 * The files the `files` tool keeps for a session (docs/decisions.md, D38): downloads, PDFs of pages,
 * and the place an upload by id reads from. They live in `<configDir>/files/<session>/` under the
 * rules captures follow: the folders 0700, each file 0600 and created exclusively, so nothing is
 * overwritten and no other user can read one. A name a server sent is cleaned first; it never
 * carries a path, a leading dot or a character a shell or Windows treats specially.
 *
 * This file also opens local files for an upload (UploadReader): the file is resolved and opened
 * once, the rules judge that open file, and the same handle is read, so what was checked is what
 * is sent.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { privateDir } from "./captures.ts";
import { type FileFacts, MAX_UPLOAD_BYTES, protectedDirs } from "./file-rules.ts";
import { configDir, legacyConfigDir, newConfigDir, readJsonFile, withFileLock, writeJsonPrivate } from "./files.ts";

/** The most one saved file may hold. The extension refuses a larger download before any byte moves. */
export const MAX_SAVED_BYTES = 50 * 1024 * 1024;
/** What one session may keep, so a caller can't fill the disk. */
export const MAX_SESSION_BYTES = 500 * 1024 * 1024;
export const MAX_SESSION_FILES = 200;
/** What every session together may keep: a caller that opens session after session still can't fill the disk. */
export const MAX_ALL_BYTES = 2 * 1024 * 1024 * 1024;
/** `read`: how much text goes back, and the most an image or other file may be. */
export const READ_TEXT_CAP = 200 * 1024;
export const READ_BLOB_CAP = 8 * 1024 * 1024;

export interface SavedFile {
	id: string;
	/** The file's name inside the session folder. */
	name: string;
	bytes: number;
	mime: string;
	sha256: string;
	/** Where it came from: the URL fetched, or the page a PDF was made of. */
	sourceUrl: string;
	savedAt: string;
}

export const byteSize = (n: number): string =>
	n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;

export function filesRoot(): string {
	return join(configDir(), "files");
}

/** A session's folder name: the session id when it is already a safe name, otherwise a cleaned one with a hash of the original. */
export function sessionFolder(session: string): string {
	const safe = session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session";
	if (safe === session) return safe;
	return `${safe.slice(0, 55)}-${createHash("sha256").update(session).digest("hex").slice(0, 8)}`;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A file name safe to create from one a web server or a page chose. Only the last path part is
 * kept; control and direction-override characters, leading dots and the characters Windows refuses
 * go; a device name gets an underscore; a long name keeps its extension.
 */
export function sanitizeFileName(raw: string, fallback = "download"): string {
	let name = String(raw ?? "")
		.normalize("NFC")
		// Control characters, and the marks that reorder text so "exe.fdp" reads as "pdf.exe".
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
		.split(/[\\/]/)
		.pop() as string;
	name = name
		.replace(/[<>:"|?*]/g, "_")
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	if (!name) name = fallback;
	if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
	if (name.length > 120) {
		const ext = extname(name).slice(0, 16);
		name = `${name.slice(0, 120 - ext.length)}${ext}`;
	}
	return name;
}

const MIME_BY_EXT: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".html": "text/html",
	".htm": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".json": "application/json",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".wav": "audio/wav",
};

/** A media type without its parameters, lower case; "" when it is not one. */
export function cleanMime(raw: unknown): string {
	const m = String(raw ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(m) ? m : "";
}

export function mimeFor(name: string, declared?: unknown): string {
	const clean = cleanMime(declared);
	if (clean && clean !== "application/octet-stream") return clean;
	return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** The extension a name gets when it has none and the type is known. */
function extFor(mime: string): string {
	return Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0] ?? "";
}

export function isTextMime(mime: string): boolean {
	return (
		mime.startsWith("text/") ||
		/^application\/(json|xml|yaml|javascript|x-ndjson|x-www-form-urlencoded)$/.test(mime) ||
		/\+(json|xml)$/.test(mime)
	);
}

/** The image type the bytes really are (png, jpeg, gif, webp), or undefined: a server's word is not enough. */
export function sniffImage(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return undefined;
}

interface Index {
	files: SavedFile[];
}

const INDEX = ".index.json";

/** A file being written: bytes are appended as they arrive, and it joins the list only when `finish` is called. */
export interface FileWriter {
	write(chunk: Buffer): void;
	/** Close, record and return the entry; `expectBytes` is the size the sender announced. */
	finish(expectBytes?: number): SavedFile;
	/** Close and delete what was written. */
	abort(): void;
}

/** One session's saved files. */
export class SavedFiles {
	readonly dir: string;
	readonly session: string;
	/** Files being written now: counted against the caps from the moment they start, not when they finish. */
	private readonly pending = { files: 0, bytes: 0 };

	constructor(session: string) {
		this.session = session;
		this.dir = join(filesRoot(), sessionFolder(session));
	}

	private ensureDir(): void {
		privateDir(filesRoot());
		privateDir(this.dir);
	}

	private index(): Index {
		let raw: Index;
		try {
			raw = readJsonFile<Index>(join(this.dir, INDEX), { files: [] });
		} catch {
			// A damaged list hides the files; it never makes one of them look like another.
			return { files: [] };
		}
		return { files: Array.isArray(raw?.files) ? raw.files.filter((f) => this.valid(f)) : [] };
	}

	/** An entry names a plain file directly inside this folder that is still there. */
	private valid(f: SavedFile): boolean {
		if (!f || typeof f.id !== "string" || typeof f.name !== "string") return false;
		if (f.name !== basename(f.name) || f.name.startsWith(".") || /[\\/]/.test(f.name)) return false;
		try {
			const st = lstatSync(join(this.dir, f.name));
			return st.isFile() && st.nlink === 1;
		} catch {
			return false;
		}
	}

	list(): SavedFile[] {
		return this.index().files;
	}

	get(id: string): SavedFile | undefined {
		return this.list().find((f) => f.id === id);
	}

	pathOf(file: SavedFile): string {
		return join(this.dir, file.name);
	}

	/** The bytes of one saved file, read through a handle that does not follow a link. */
	read(file: SavedFile): Buffer {
		const fd = openSync(this.pathOf(file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const st = fstatSync(fd);
			if (!st.isFile() || st.nlink !== 1) throw new Error(`${file.name} is no longer a plain file.`);
			return readFileSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	remove(id: string): SavedFile | undefined {
		return withFileLock(join(this.dir, INDEX), () => {
			const index = this.index();
			const file = index.files.find((f) => f.id === id);
			if (!file) return undefined;
			rmSync(this.pathOf(file), { force: true });
			writeJsonPrivate(join(this.dir, INDEX), { files: index.files.filter((f) => f.id !== id) });
			return file;
		});
	}

	/** Why this session can't keep `bytes` more, or undefined. Counts the files still being written. */
	full(bytes: number): string | undefined {
		if (bytes > MAX_SAVED_BYTES) return `The file is ${bytes} bytes; the most one saved file may be is ${MAX_SAVED_BYTES} (50 MB).`;
		const files = this.list();
		if (files.length + this.pending.files >= MAX_SESSION_FILES) return `This session already keeps ${files.length} files. Remove some first (action "remove").`;
		const held = files.reduce((a, f) => a + f.bytes, 0) + this.pending.bytes;
		if (held + bytes > MAX_SESSION_BYTES) return `This session's saved files would pass ${MAX_SESSION_BYTES} bytes. Remove some first (action "remove").`;
		if (savedBytesElsewhere(this.dir) + held + bytes > MAX_ALL_BYTES) return `Polycarp's saved files would pass ${byteSize(MAX_ALL_BYTES)} across all sessions. End sessions that are done (session_end removes their files), or remove files.`;
		return undefined;
	}

	/** Remove every file this session saved, and its folder. */
	clear(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}

	/** The same files under the session's new name. A folder already there is left alone, and so is this one. */
	renamedTo(session: string): SavedFiles {
		const next = new SavedFiles(session);
		try {
			if (next.dir !== this.dir && existsSync(this.dir) && !existsSync(next.dir)) renameSync(this.dir, next.dir);
		} catch {
			// The files stay under the old name; the new folder starts empty.
		}
		return next;
	}

	/**
	 * Start a new file under a cleaned name; a name that is taken gets a number, never the other file's place.
	 * `bytes`, the size announced, is held against the caps until the file is finished or dropped, so two
	 * downloads at once can't both take the last of the room.
	 */
	create(meta: { name: string; mime?: unknown; sourceUrl: string; bytes?: number }): FileWriter {
		this.ensureDir();
		const reserved = { files: 1, bytes: meta.bytes ?? 0 };
		this.pending.files += reserved.files;
		this.pending.bytes += reserved.bytes;
		const release = () => {
			this.pending.files -= reserved.files;
			this.pending.bytes -= reserved.bytes;
			reserved.files = reserved.bytes = 0;
		};
		try {
			return this.open(meta, release);
		} catch (err) {
			release();
			throw err;
		}
	}

	private open(meta: { name: string; mime?: unknown; sourceUrl: string }, release: () => void): FileWriter {
		const mime0 = cleanMime(meta.mime);
		let wanted = sanitizeFileName(meta.name);
		if (!extname(wanted) && mime0) wanted += extFor(mime0);
		const ext = extname(wanted);
		const stem = wanted.slice(0, wanted.length - ext.length);
		let fd = -1;
		let name = wanted;
		for (let attempt = 0; fd < 0; attempt++) {
			name = attempt === 0 ? wanted : `${stem}-${attempt < 50 ? attempt : randomBytes(4).toString("hex")}${ext}`;
			try {
				fd = openSync(join(this.dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 60) throw err;
			}
		}
		const path = join(this.dir, name);
		if (process.platform !== "win32") chmodSync(path, 0o600);
		const hash = createHash("sha256");
		let bytes = 0;
		let open = true;
		const close = () => {
			if (open) closeSync(fd);
			open = false;
			release();
		};
		const abort = () => {
			close();
			rmSync(path, { force: true });
		};
		return {
			write: (chunk) => {
				bytes += chunk.length;
				if (bytes > MAX_SAVED_BYTES) {
					abort();
					throw new Error(`The file passed ${MAX_SAVED_BYTES} bytes (50 MB) and was not saved.`);
				}
				hash.update(chunk);
				writeSync(fd, chunk);
			},
			finish: (expectBytes) => {
				close();
				if (expectBytes !== undefined && expectBytes !== bytes) {
					rmSync(path, { force: true });
					throw new Error(`The file arrived as ${bytes} bytes, not the ${expectBytes} announced, and was not saved.`);
				}
				const entry: SavedFile = {
					id: `f_${randomBytes(5).toString("hex")}`,
					name,
					bytes,
					mime: mimeFor(name, meta.mime),
					sha256: hash.digest("hex"),
					sourceUrl: meta.sourceUrl,
					savedAt: new Date().toISOString(),
				};
				try {
					withFileLock(join(this.dir, INDEX), () => writeJsonPrivate(join(this.dir, INDEX), { files: [...this.index().files, entry] }));
				} catch (err) {
					rmSync(path, { force: true });
					throw err;
				}
				return entry;
			},
			abort,
		};
	}
}

/** The bytes every other session's folder lists. A folder that can't be read counts as empty. */
function savedBytesElsewhere(dir: string): number {
	let total = 0;
	let names: string[] = [];
	try {
		names = readdirSync(filesRoot());
	} catch {
		return 0;
	}
	for (const name of names) {
		const other = join(filesRoot(), name);
		if (other === dir) continue;
		try {
			const index = readJsonFile<Index>(join(other, INDEX), { files: [] });
			for (const f of Array.isArray(index?.files) ? index.files : []) total += Number(f?.bytes) > 0 ? Number(f.bytes) : 0;
		} catch {
			/* not a session folder */
		}
	}
	return total;
}

/** The helper's own folders and every browser profile, with their real paths: nothing is uploaded from them. */
export function privateDirsHere(): string[] {
	const dirs = protectedDirs({
		platform: process.platform,
		home: homedir(),
		configDirs: [configDir(), newConfigDir(), legacyConfigDir()],
		appData: process.env.APPDATA,
		localAppData: process.env.LOCALAPPDATA,
		xdgConfig: process.env.XDG_CONFIG_HOME,
	});
	return [...new Set(dirs.flatMap((d) => [d, realOrSelf(d)]))];
}

/** A path with its links followed, or the path itself when it does not exist. */
export function realOrSelf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * Opens local files for one upload. `inspect` resolves the path, opens the resolved file without
 * following a link, and reports what that open file is; `read` returns the bytes of the same
 * handle. A file swapped between the check and the read is therefore never the one sent.
 */
export class UploadReader {
	private readonly open = new Map<string, { fd: number; bytes: number }>();

	inspect = (path: string): FileFacts | { error: string } => {
		let fd = -1;
		try {
			const realPath = realpathSync.native(path);
			fd = openSync(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
			const st = fstatSync(fd);
			// The name still leads to the file that was opened.
			const named = statSync(realPath);
			if (named.ino !== st.ino || named.dev !== st.dev || realpathSync.native(realPath) !== realPath) throw new Error("it changed while it was being checked");
			const facts: FileFacts = { realPath, isFile: st.isFile(), nlink: st.nlink, bytes: st.size };
			const before = this.open.get(realPath);
			if (before) closeSync(before.fd);
			this.open.set(realPath, { fd, bytes: st.size });
			fd = -1;
			return facts;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			return { error: code === "ENOENT" ? "no such file" : code === "EACCES" || code === "EPERM" ? "permission denied" : code === "ELOOP" ? "it is a link" : err instanceof Error ? err.message : String(err) };
		} finally {
			if (fd >= 0) closeSync(fd);
		}
	};

	/** The bytes of a file `inspect` approved, by its real path. */
	read(realPath: string): Buffer {
		const held = this.open.get(realPath);
		if (!held) throw new Error(`${basename(realPath)} was not checked.`);
		if (held.bytes > MAX_UPLOAD_BYTES) throw new Error(`${basename(realPath)} is too large to upload.`);
		// Read from the start each time: the same file can be named twice in one upload, and it has one handle.
		const bytes = Buffer.alloc(held.bytes + 1);
		let got = 0;
		for (let n = 1; n > 0 && got < bytes.length; got += n) n = readSync(held.fd, bytes, got, bytes.length - got, got);
		if (got !== held.bytes) throw new Error(`${basename(realPath)} changed while it was being read.`);
		return bytes.subarray(0, held.bytes);
	}

	close(): void {
		for (const { fd } of this.open.values()) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
		this.open.clear();
	}
}
