/**
 * Minimal zip reader for release archives: stored and deflated entries, no symlinks,
 * no absolute or `..` paths. Anything else is refused rather than guessed at.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Unpacked size cap: a release is a few MB; this stops a zip bomb. */
const MAX_TOTAL = 512 * 1024 * 1024;

export class ZipError extends Error {}

function findEnd(buf: Buffer): number {
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (buf.readUInt32LE(i) === EOCD) return i;
	}
	throw new ZipError("Not a zip file (no end of central directory)");
}

function safeName(name: string): string {
	if (!name || name.includes("\0") || name.includes("\\")) throw new ZipError(`Unsafe path in zip: ${JSON.stringify(name)}`);
	if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new ZipError(`Absolute path in zip: ${name}`);
	const parts = name.split("/");
	if (parts.some((p) => p === "..")) throw new ZipError(`Path escapes the archive: ${name}`);
	return name;
}

/** Extract every entry under `dest`. Returns the file names written. */
export function extractZip(buf: Buffer, dest: string): string[] {
	const end = findEnd(buf);
	const count = buf.readUInt16LE(end + 10);
	let offset = buf.readUInt32LE(end + 16);
	const written: string[] = [];
	let total = 0;
	const root = normalize(dest) + sep;
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(offset) !== CENTRAL) throw new ZipError("Corrupt central directory");
		const flags = buf.readUInt16LE(offset + 8);
		const method = buf.readUInt16LE(offset + 10);
		const crc = buf.readUInt32LE(offset + 16);
		const compressed = buf.readUInt32LE(offset + 20);
		const size = buf.readUInt32LE(offset + 24);
		const nameLen = buf.readUInt16LE(offset + 28);
		const extraLen = buf.readUInt16LE(offset + 30);
		const commentLen = buf.readUInt16LE(offset + 32);
		const madeBy = buf.readUInt16LE(offset + 4) >> 8;
		const externalAttr = buf.readUInt32LE(offset + 38);
		const localOffset = buf.readUInt32LE(offset + 42);
		const name = safeName(buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
		offset += 46 + nameLen + extraLen + commentLen;

		if (flags & 0x1) throw new ZipError(`Encrypted entry: ${name}`);
		// Unix mode lives in the high 16 bits when the archive was made on Unix (3).
		if (madeBy === 3 && ((externalAttr >>> 16) & 0o170000) === 0o120000) throw new ZipError(`Symlink in zip: ${name}`);
		const target = normalize(join(dest, name));
		if (!target.startsWith(root)) throw new ZipError(`Path escapes the archive: ${name}`);
		if (name.endsWith("/")) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		if (buf.readUInt32LE(localOffset) !== LOCAL) throw new ZipError(`Corrupt local header: ${name}`);
		const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
		const raw = buf.subarray(dataStart, dataStart + compressed);
		total += size;
		if (total > MAX_TOTAL) throw new ZipError("Archive unpacks to more than 512 MB");
		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: size + 1 });
		else throw new ZipError(`Unsupported compression ${method}: ${name}`);
		if (data.length !== size || crc32(data) !== crc) throw new ZipError(`Checksum mismatch inside zip: ${name}`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data, { mode: 0o644 });
		written.push(name);
	}
	return written;
}
