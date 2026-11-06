/**
 * `cloudflared` on demand for `polycarp browser connect`. It is not bundled: the first time a person turns
 * Connect on, the pinned release is downloaded from GitHub into Polycarp's support folder, its SHA-256 is
 * checked against the one pinned below before anything is extracted, and only then is it run.
 *
 * To update: change `version` and both digests together (GitHub shows each release asset's sha256, and
 * `shasum -a 256` on the downloaded file must agree), then run the tests.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { run } from "./service.ts";

export interface CloudflaredAsset {
	url: string;
	/** Lowercase hex SHA-256 of the downloaded archive. */
	sha256: string;
}

export interface CloudflaredManifest {
	version: string;
	/** Keyed by `${process.platform}-${arch}`, where arch is arm64 or amd64. */
	assets: Record<string, CloudflaredAsset>;
}

const base = "https://github.com/cloudflare/cloudflared/releases/download/2026.10.7";

/** macOS first. Linux and Windows aren't pinned yet, so they get a clear message rather than an unchecked download. */
export const PINNED_CLOUDFLARED: CloudflaredManifest = {
	version: "2026.10.7",
	assets: {
		"darwin-arm64": { url: `${base}/cloudflared-darwin-arm64.tgz`, sha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd" },
		"darwin-amd64": { url: `${base}/cloudflared-darwin-amd64.tgz`, sha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848" },
	},
};

const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;

/** Polycarp's support folder. POLYCARP_SUPPORT_DIR overrides it when absolute (tests). */
export function supportDir(): string {
	const explicit = process.env.POLYCARP_SUPPORT_DIR;
	if (explicit && isAbsolute(explicit)) return explicit;
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Polycarp");
	const xdg = process.env.XDG_DATA_HOME;
	return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "polycarp");
}

export const platformKey = (): string => `${process.platform}-${process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch}`;

export const cloudflaredFile = (manifest: CloudflaredManifest = PINNED_CLOUDFLARED): string => join(supportDir(), "bin", `cloudflared-${manifest.version}`);

export type CloudflaredResult = { ok: true; path: string; downloaded: boolean } | { ok: false; message: string };

const isExecutableFile = (path: string): boolean => {
	try {
		const st = statSync(path);
		return st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0);
	} catch {
		return false;
	}
};

export interface EnsureOptions {
	manifest?: CloudflaredManifest;
	fetchFn?: typeof fetch;
	/** Called with a plain sentence before a slow step, so a person isn't left staring. */
	say?: (line: string) => void;
}

/**
 * The path of a cloudflared that is safe to run. POLYCARP_CLOUDFLARED_BIN (an absolute path to an executable) wins:
 * a test hook that is also how someone with their own cloudflared opts out of the download. Never set it for a
 * binary you didn't get yourself.
 */
export async function ensureCloudflared(options: EnsureOptions = {}): Promise<CloudflaredResult> {
	const manifest = options.manifest ?? PINNED_CLOUDFLARED;
	const override = process.env.POLYCARP_CLOUDFLARED_BIN;
	if (override) {
		if (!isAbsolute(override) || !isExecutableFile(override)) return { ok: false, message: `POLYCARP_CLOUDFLARED_BIN must be the absolute path of an executable file (got ${override}).` };
		return { ok: true, path: override, downloaded: false };
	}
	const final = cloudflaredFile(manifest);
	if (isExecutableFile(final)) return { ok: true, path: final, downloaded: false };

	const key = platformKey();
	const asset = manifest.assets[key];
	if (!asset) {
		return { ok: false, message: `Polycarp can't set up Connect on this kind of computer yet (${key}). It works on a Mac for now.` };
	}
	if (new URL(asset.url).protocol !== "https:") return { ok: false, message: "The pinned download isn't an https address, so it was refused." };
	options.say?.("Getting the helper that makes the connection (one time, about 20 MB)…");
	const fetchFn = options.fetchFn ?? fetch;
	let archive: Buffer;
	try {
		const res = await fetchFn(asset.url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
		if (!res.ok) return { ok: false, message: `The download answered ${res.status}. Check your internet connection and try again.` };
		const declared = Number(res.headers.get("content-length") ?? 0);
		if (declared > MAX_ARCHIVE_BYTES) return { ok: false, message: "The download is bigger than expected, so it was refused." };
		archive = Buffer.from(await res.arrayBuffer());
	} catch (err) {
		return { ok: false, message: `Couldn't download the helper: ${err instanceof Error ? err.message : String(err)}. Check your internet connection and try again.` };
	}
	if (archive.length > MAX_ARCHIVE_BYTES) return { ok: false, message: "The download is bigger than expected, so it was refused." };
	const digest = createHash("sha256").update(archive).digest("hex");
	if (digest !== asset.sha256) {
		return { ok: false, message: "The downloaded helper doesn't match the checksum Polycarp expects, so it was thrown away and nothing was run. Try again later, and tell us if it keeps happening." };
	}
	const binDir = join(supportDir(), "bin");
	mkdirSync(binDir, { recursive: true, mode: 0o755 });
	const work = mkdtempSync(join(binDir, ".dl-"));
	try {
		const tgz = join(work, "cloudflared.tgz");
		writeFileSync(tgz, archive, { mode: 0o600 });
		const extractDir = join(work, "out");
		mkdirSync(extractDir);
		// Only the one member we expect, so nothing else in the archive is written anywhere.
		const tar = run(process.platform === "darwin" ? "/usr/bin/tar" : "tar", ["-xzf", tgz, "-C", extractDir, "cloudflared"]);
		const extracted = join(extractDir, "cloudflared");
		if (tar.code !== 0 || !existsSync(extracted) || !lstatSync(extracted).isFile()) return { ok: false, message: "The downloaded helper couldn't be unpacked, so nothing was installed." };
		chmodSync(extracted, 0o755);
		const version = run(extracted, ["--version"]);
		if (version.code !== 0 || !version.out.includes(manifest.version)) {
			return { ok: false, message: `The downloaded helper didn't start as version ${manifest.version} (${version.out.slice(0, 120) || "no output"}), so it was not installed. Is this the right kind of Mac?` };
		}
		renameSync(extracted, final);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	// Older pinned versions are no longer needed.
	for (const name of readdirSync(binDir)) if (name.startsWith("cloudflared-") && name !== `cloudflared-${manifest.version}`) rmSync(join(binDir, name), { force: true });
	return { ok: true, path: final, downloaded: true };
}
