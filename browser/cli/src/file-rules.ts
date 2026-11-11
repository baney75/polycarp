/**
 * Which local files the `files` tool may put into a web page (docs/decisions.md, D38). Pure: every
 * fact about the disk comes in through `RuleEnv.inspect`, and paths are handled for the platform the
 * env names, so the Windows rules are tested on any machine.
 *
 * The order is the point. A remote caller never names a path. A local path is refused when it, or
 * the file it resolves to, looks like a credential or sits in a private folder, whatever else is
 * true. What is left is either inside a folder the agent already works in (no question) or needs
 * the person's yes for this one upload.
 */

import { posix, win32 } from "node:path";

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What the disk says about a path, after following every link. */
export interface FileFacts {
	realPath: string;
	isFile: boolean;
	/** Hard links to the file; more than one means another name reaches the same bytes. */
	nlink: number;
	bytes: number;
}

export interface RuleEnv {
	platform: string;
	home: string;
	/** A hub or tunnel session, or any scoped one. */
	remote: boolean;
	/** This session's saved files, `<configDir>/files/<session>`. */
	sessionDir: string;
	/** `<configDir>/files`: the one part of the config folder a path may be in. */
	filesRoot: string;
	/** Folders nothing is uploaded from (protectedDirs, plus their real paths). */
	privateDirs: string[];
	/** Folders the agent already works in: the MCP client's roots, or the working directory. */
	roots: string[];
	inspect(path: string): FileFacts | { error: string };
}

export type RefusalCode =
	| "remote"
	| "not_absolute"
	| "unreadable"
	| "not_file"
	| "hard_link"
	| "credential"
	| "private_dir"
	| "too_many"
	| "too_big"
	| "empty";

export type PathVerdict =
	| { ok: true; path: string; name: string; bytes: number; ask: boolean }
	| { ok: false; code: RefusalCode; reason: string };

const lib = (platform: string) => (platform === "win32" ? win32 : posix);

/** Windows and macOS compare names without case; so do these rules. */
const foldsCase = (platform: string) => platform === "win32" || platform === "darwin";

/** `\\?\C:\x` and `\\?\UNC\server\share\x` as the plain paths they name. */
function plainWindowsPath(path: string): string {
	if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
	if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
	return path;
}

/**
 * macOS keeps the user's files on the Data volume and shows them at "/" through firmlinks, which
 * realpath does not fold: /System/Volumes/Data/Users/me is /Users/me, and is compared as that.
 */
const MAC_DATA_VOLUME = /^\/System\/Volumes\/Data(?=\/)/i;

function normalized(path: string, platform: string): string {
	let p = lib(platform).normalize(platform === "win32" ? plainWindowsPath(path) : path);
	if (platform === "darwin") p = p.replace(MAC_DATA_VOLUME, "");
	return foldsCase(platform) ? p.toLowerCase() : p;
}

/** Whether `child` is `parent` or inside it. */
export function isInside(child: string, parent: string, platform: string): boolean {
	if (!parent) return false;
	const l = lib(platform);
	const rel = l.relative(normalized(parent, platform), normalized(child, platform));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${l.sep}`) && !l.isAbsolute(rel));
}

/**
 * The parts of a path as the rules compare them: lower case, and without the trailing dots and
 * spaces Windows drops when it opens a file ("id_rsa." is id_rsa there).
 */
function parts(path: string, platform: string): string[] {
	const p = platform === "win32" ? plainWindowsPath(path) : path;
	return p
		.split(platform === "win32" ? /[\\/]+/ : /\/+/)
		.map((s) => s.toLowerCase().replace(/[. ]+$/, ""))
		.filter((s) => s !== "");
}

/** File and folder names that hold secrets, whatever folder they are in. */
const NAME_RULES: Array<[RegExp, string]> = [
	[/^\.env(\..*)?$/, ".env file"],
	[/\.env$/, ".env file"],
	[/\.(pem|key|p12|pfx|kdbx|ppk)$/, "key or password store"],
	[/^id_(rsa|ed25519|ecdsa|dsa)/, "SSH key"],
	[/\.keychain/, "keychain"],
	[/^(\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials)$/, "sign-in file"],
	[/^(known_hosts|authorized_keys)$/, "SSH file"],
	[/^(credentials|tokens\.json)$/, "credentials file"],
	[/^oauth.*\.json$/, "OAuth file"],
	// A browser profile kept somewhere unusual still has these names.
	[/^(cookies|login data|web data|local state|key[34]\.db|logins\.json|cookies\.sqlite)(-journal|-wal|-shm)?$/, "browser profile file"],
];

/** Folders that hold secrets, anywhere in a path. */
const DIR_RULES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);

/** Why a path looks like a credential, or undefined. Looks at every part, not just the file name. */
export function credentialLike(path: string, platform: string): string | undefined {
	for (const part of parts(path, platform)) {
		if (DIR_RULES.has(part)) return `${part} folder`;
		for (const [rule, what] of NAME_RULES) if (rule.test(part)) return what;
	}
	return undefined;
}

export interface ProtectedDirsInput {
	platform: string;
	home: string;
	/** The helper's own config folders (the one in use and the old one). */
	configDirs: string[];
	/** Windows %APPDATA% and %LOCALAPPDATA%. */
	appData?: string;
	localAppData?: string;
	/** XDG_CONFIG_HOME, when set. */
	xdgConfig?: string;
}

/**
 * Folders nothing is uploaded from: Polycarp's own (they hold tokens and settings), browser
 * profiles (cookies, saved passwords) and the system's key stores. The caller adds each one's real
 * path, so a link to one of them is covered too.
 */
export function protectedDirs(o: ProtectedDirsInput): string[] {
	const l = lib(o.platform);
	const home = o.home;
	const out = [...o.configDirs];
	const under = (base: string | undefined, names: string[]) => {
		if (base) for (const n of names) out.push(l.join(base, ...n.split("/")));
	};
	if (o.platform === "win32") {
		const roaming = o.appData ?? l.join(home, "AppData", "Roaming");
		const local = o.localAppData ?? l.join(home, "AppData", "Local");
		for (const base of [roaming, local, l.join(home, ".config")]) under(base, ["polycarp", "tabkyra"]);
		under(local, ["Google/Chrome", "Chromium", "BraveSoftware", "Microsoft/Edge", "Vivaldi", "Yandex", "Thorium", "imput/Helium", "Microsoft/Credentials", "Microsoft/Vault"]);
		under(roaming, ["Mozilla", "Opera Software", "zen", "Microsoft/Credentials", "Microsoft/Protect", "Microsoft/Crypto"]);
		return out;
	}
	const config = o.xdgConfig || l.join(home, ".config");
	under(config, ["polycarp", "tabkyra"]);
	under(home, [".config/polycarp", ".config/tabkyra", ".local/share/polycarp", ".local/share/tabkyra", ".cache/polycarp"]);
	if (o.platform === "darwin") {
		under(l.join(home, "Library", "Application Support"), [
			"Polycarp",
			"tabkyra",
			"Google",
			"Chromium",
			"BraveSoftware",
			"Microsoft Edge",
			"Vivaldi",
			"Arc",
			"net.imput.helium",
			"Firefox",
			"zen",
			"com.operasoftware.Opera",
			"Yandex",
			"Thorium",
		]);
		under(l.join(home, "Library"), ["Safari", "Cookies", "Keychains", "Containers/com.apple.Safari"]);
		return out;
	}
	under(config, ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "BraveSoftware", "microsoft-edge", "vivaldi", "opera", "net.imput.helium", "thorium", "yandex-browser"]);
	under(home, [".mozilla", ".zen", "snap/chromium", "snap/firefox", ".pki", ".local/share/keyrings", ".password-store"]);
	return out;
}

/** A root that would cover everything is no root: the home folder, anything above it, or a drive. */
export function usableRoot(root: string, env: Pick<RuleEnv, "platform" | "home">): boolean {
	const l = lib(env.platform);
	if (!root || !l.isAbsolute(root)) return false;
	const r = normalized(root, env.platform);
	if (l.parse(r).root === r) return false;
	return !isInside(env.home, root, env.platform);
}

const refuse = (code: RefusalCode, reason: string): PathVerdict => ({ ok: false, code, reason });

/** Whether one local path may be uploaded, and whether the person has to say yes first. */
export function checkUploadPath(given: string, env: RuleEnv): PathVerdict {
	if (env.remote) return refuse("remote", "A remote session can't upload from a path. Use ids of files this session saved (download or save_pdf).");
	const l = lib(env.platform);
	if (typeof given !== "string" || !l.isAbsolute(given)) return refuse("not_absolute", `${String(given)} is not an absolute path.`);
	if (env.platform === "win32") {
		const plain = plainWindowsPath(given);
		// A device path, or a stream hidden behind a file name ("report.txt:secret").
		if (/^\\\\[.?]\\/.test(plain) || plain.replace(/^[a-z]:/i, "").includes(":"))
			return refuse("not_file", `${given} is not a plain file path.`);
	}
	const name = l.basename(given);
	const lexical = credentialLike(given, env.platform);
	if (lexical) return refuse("credential", `${name} looks like a credential (${lexical}). Polycarp never uploads those.`);
	const facts = env.inspect(given);
	if ("error" in facts) return refuse("unreadable", `${name} can't be read: ${facts.error}`);
	const real = facts.realPath;
	const resolved = credentialLike(real, env.platform);
	if (resolved) return refuse("credential", `${name} leads to a credential (${resolved}). Polycarp never uploads those.`);
	const inFiles = isInside(real, env.filesRoot, env.platform);
	if (!inFiles && [given, real].some((p) => env.privateDirs.some((d) => isInside(p, d, env.platform))))
		return refuse("private_dir", `${name} is in a folder Polycarp never uploads from (its own settings, a browser profile or a key store).`);
	if (!facts.isFile) return refuse("not_file", `${name} is not a regular file.`);
	if (facts.nlink > 1) return refuse("hard_link", `${name} has more than one hard link, so another name reaches the same file. Copy it first.`);
	if (facts.bytes > MAX_UPLOAD_BYTES) return refuse("too_big", `${name} is ${facts.bytes} bytes; one upload takes at most ${MAX_UPLOAD_BYTES} bytes in all.`);
	const known = isInside(real, env.sessionDir, env.platform) || env.roots.some((r) => usableRoot(r, env) && isInside(real, r, env.platform));
	return { ok: true, path: real, name: l.basename(real), bytes: facts.bytes, ask: !known };
}

/** The caps on one upload call: how many files, and how many bytes in all. */
export function checkUploadCaps(sizes: number[]): { ok: true } | { ok: false; code: RefusalCode; reason: string } {
	if (sizes.length === 0) return { ok: false, code: "empty", reason: "Give at least one file: paths or ids." };
	if (sizes.length > MAX_UPLOAD_FILES) return { ok: false, code: "too_many", reason: `${sizes.length} files given; one upload takes at most ${MAX_UPLOAD_FILES}.` };
	const total = sizes.reduce((a, b) => a + b, 0);
	if (total > MAX_UPLOAD_BYTES) return { ok: false, code: "too_big", reason: `The files are ${total} bytes in all; one upload takes at most ${MAX_UPLOAD_BYTES}.` };
	return { ok: true };
}
