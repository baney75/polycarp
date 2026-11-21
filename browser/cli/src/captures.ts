/**
 * Where evidence captures land on this computer. The extension hands over a HAR or a WebM it has
 * already redacted or encoded; this writes it to the config folder and the agent is told the path
 * and size, never the content. The folder is 0700 and each file 0600, created exclusively, so
 * nothing is overwritten and no other user can read a capture.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./files.ts";

export interface IncomingCapture {
	kind: "har" | "webm";
	encoding: "json" | "base64";
	data: unknown;
}

export function capturesDir(): string {
	return join(configDir(), "captures");
}

/** Make the folder if it is missing, and refuse one that is not ours or is a link. */
export function privateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} is not a plain folder`);
	if (process.platform !== "win32") {
		if (st.uid !== process.getuid?.()) throw new Error(`${path} belongs to another user`);
		if ((st.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
	}
}

/** The bytes a capture is written as; throws when the extension sent something that is not that kind of file. */
export function captureBytes(file: IncomingCapture): Buffer {
	if (file.kind === "har") {
		if (file.encoding !== "json" || typeof file.data !== "object" || file.data === null) throw new Error("The HAR did not arrive as JSON.");
		return Buffer.from(JSON.stringify(file.data));
	}
	if (file.kind === "webm") {
		if (file.encoding !== "base64" || typeof file.data !== "string") throw new Error("The video did not arrive as base64.");
		const bytes = Buffer.from(file.data, "base64");
		// An EBML header opens every WebM.
		if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x1a45dfa3) throw new Error("The video is not a WebM file.");
		return bytes;
	}
	throw new Error(`Unknown capture kind ${String((file as { kind?: unknown }).kind)}.`);
}

/** Write a capture and return where it is. */
export function saveCapture(file: IncomingCapture, now: Date = new Date()): { path: string; bytes: number } {
	const bytes = captureBytes(file);
	const dir = capturesDir();
	privateDir(dir);
	const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
	for (let attempt = 0; ; attempt++) {
		const name = `${file.kind === "har" ? "network" : "video"}-${stamp}-${randomBytes(3).toString("hex")}.${file.kind}`;
		const path = join(dir, name);
		try {
			writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
		} catch (err) {
			// A name that is taken is never overwritten; draw another.
			if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < 4) continue;
			throw err;
		}
		if (process.platform !== "win32") chmodSync(path, 0o600);
		return { path, bytes: bytes.length };
	}
}
