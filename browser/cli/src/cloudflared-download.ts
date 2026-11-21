/**
 * Polycarp's own copy of cloudflared, for the Connect panel's "Set up with Cloudflare" button, so the person installs nothing.
 *
 * One pinned release from Cloudflare's GitHub, checked against a SHA-256 digest written down here before anything is
 * unpacked or made executable. A wrong digest deletes the download and fails. The copy lives at <config>/bin/cloudflared
 * (cloudflared.exe on Windows), where `cloudflaredBinary()` looks last, so a cloudflared the person installed themselves always wins.
 */
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { configDir } from "./files.ts";
import { runAsync } from "./service.ts";

export const CLOUDFLARED_VERSION = "2026.10.7";
const RELEASE_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

/** The biggest download taken. The real files are about 40 MB; this stops a wrong or hostile server from filling the disk. */
export const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;

export interface CloudflaredAsset {
	name: string;
	sha256: string;
	/** A .tgz holding one file named cloudflared, or the binary itself (Linux, and the .exe on Windows). */
	archive: boolean;
}

/**
 * Digests are GitHub's own for the release assets of CLOUDFLARED_VERSION (`gh api repos/cloudflare/cloudflared/releases/tags/<version>`,
 * each asset's `digest`). The release has no windows-arm64 build, so Windows on Arm installs cloudflared itself.
 */
const ASSETS: Record<string, CloudflaredAsset> = {
	"darwin-arm64": { name: "cloudflared-darwin-arm64.tgz", sha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd", archive: true },
	"darwin-x64": { name: "cloudflared-darwin-amd64.tgz", sha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848", archive: true },
	"linux-x64": { name: "cloudflared-linux-amd64", sha256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872", archive: false },
	"linux-arm64": { name: "cloudflared-linux-arm64", sha256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775", archive: false },
	"win32-x64": { name: "cloudflared-windows-amd64.exe", sha256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343", archive: false },
};

/** The release file for this platform, or undefined where there is none (Windows on Arm, other CPUs). */
export function cloudflaredAsset(platform: string = process.platform, arch: string = process.arch): CloudflaredAsset | undefined {
	return ASSETS[`${platform}-${arch}`];
}

export const downloadedCloudflared = (platform: NodeJS.Platform = process.platform): string => join(configDir(), "bin", platform === "win32" ? "cloudflared.exe" : "cloudflared");

/** For tests: where to fetch from and which digest to expect. Production code passes nothing. */
export interface DownloadOptions {
	baseUrl?: string;
	asset?: CloudflaredAsset;
	timeoutMs?: number;
	/** Which platform's file name to install as (cloudflared.exe on win32). */
	platform?: NodeJS.Platform;
}

export type DownloadResult = { ok: true; path: string } | { ok: false; message: string };

/** Streams `url` into `file`, counting bytes and hashing as they arrive. Throws past the size cap. */
async function fetchTo(url: string, file: string, timeoutMs: number): Promise<string> {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new Error("the file is larger than expected");
	const hash = createHash("sha256");
	let size = 0;
	const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
	body.on("data", (chunk: Buffer) => {
		size += chunk.length;
		hash.update(chunk);
		// Destroying the source makes the pipeline fail, which removes the partial file with the temp folder.
		if (size > MAX_DOWNLOAD_BYTES) body.destroy(new Error("the file is larger than expected"));
	});
	await pipeline(body, createWriteStream(file, { mode: 0o600 }));
	return hash.digest("hex");
}

/**
 * Downloads, verifies, and installs cloudflared at <config>/bin/cloudflared. The digest is checked on the downloaded bytes
 * first; only then is anything unpacked, and only then is a file made executable and moved into place (rename, so a reader
 * never sees half a file).
 */
export async function downloadCloudflared(options: DownloadOptions = {}): Promise<DownloadResult> {
	const platform = options.platform ?? process.platform;
	const asset = options.asset ?? cloudflaredAsset(platform);
	if (!asset) return { ok: false, message: `Polycarp has no cloudflared download for ${platform} ${process.arch}. Install cloudflared yourself (developers.cloudflare.com/tunnel/downloads) and try again.` };
	const binDir = join(configDir(), "bin");
	const target = downloadedCloudflared(platform);
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	chmodSync(binDir, 0o700);
	const work = mkdtempSync(join(binDir, ".download-"));
	try {
		const file = join(work, asset.name);
		let digest: string;
		try {
			digest = await fetchTo(`${options.baseUrl ?? RELEASE_URL}/${asset.name}`, file, options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
		} catch (err) {
			return { ok: false, message: `Couldn't download cloudflared: ${err instanceof Error ? err.message : String(err)}. Check this computer's connection and try again.` };
		}
		if (digest !== asset.sha256) {
			return { ok: false, message: `The cloudflared download didn't match its expected checksum, so it was deleted and not used. Try again, or install cloudflared yourself (developers.cloudflare.com/tunnel/downloads).` };
		}
		let binary = file;
		if (asset.archive) {
			// Only the one member, by name: nothing else in the archive is written.
			const dir = join(work, "unpacked");
			mkdirSync(dir, { mode: 0o700 });
			const untar = await runAsync("tar", ["-xzf", file, "-C", dir, "cloudflared"], 60_000);
			binary = join(dir, "cloudflared");
			if (untar.code !== 0 || !existsSync(binary)) return { ok: false, message: `Couldn't unpack the cloudflared download: ${untar.out.slice(-200)}` };
		}
		// A symlink or anything but a plain file is not what was hashed.
		const info = lstatSync(binary);
		if (!info.isFile() || info.size > MAX_DOWNLOAD_BYTES) return { ok: false, message: "The cloudflared download didn't hold a plain program file, so it was not used." };
		chmodSync(binary, 0o755);
		renameSync(binary, target);
		return { ok: true, path: target };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
