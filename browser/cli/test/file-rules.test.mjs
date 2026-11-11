// Which local files the files tool may upload (docs/decisions.md, D38). The rules are pure, so every
// platform's cases run on any machine: the disk is a table of facts.
import assert from "node:assert/strict";
import test from "node:test";
import { checkUploadCaps, checkUploadPath, credentialLike, isInside, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, protectedDirs, usableRoot } from "../src/file-rules.ts";

/** An env whose disk is `disk`: a path maps to its facts, or to an error; an unlisted path is a small plain file. */
function env(platform, over = {}, disk = {}) {
	const win = platform === "win32";
	const home = win ? "C:\\Users\\Me" : platform === "darwin" ? "/Users/me" : "/home/me";
	const config = win ? "C:\\Users\\Me\\AppData\\Roaming\\polycarp\\browser" : `${home}/.config/polycarp/browser`;
	const sep = win ? "\\" : "/";
	const asked = [];
	return {
		platform,
		home,
		remote: false,
		filesRoot: `${config}${sep}files`,
		sessionDir: `${config}${sep}files${sep}s1`,
		privateDirs: protectedDirs({ platform, home, configDirs: [config] }),
		roots: [`${home}${sep}proj`],
		inspect: (path) => {
			asked.push(path);
			const f = disk[path];
			if (f && "error" in f) return f;
			return { realPath: path, isFile: true, nlink: 1, bytes: 100, ...f };
		},
		asked,
		...over,
	};
}

const verdict = (path, e) => {
	const v = checkUploadPath(path, e);
	return v.ok ? (v.ask ? "ask" : "free") : v.code;
};

test("a file in the agent's folders needs no question; any other path asks", () => {
	const e = env("linux");
	const cases = [
		["/home/me/proj/report.pdf", "free"],
		["/home/me/proj/deep/er/data.csv", "free"],
		["/home/me/.config/polycarp/browser/files/s1/saved.pdf", "free"],
		// Another session's saved file is not this session's.
		["/home/me/.config/polycarp/browser/files/s2/saved.pdf", "ask"],
		["/home/me/Documents/cv.pdf", "ask"],
		["/tmp/notes.txt", "ask"],
		// A sibling whose name starts like the root is not inside it.
		["/home/me/proj-old/report.pdf", "ask"],
		["/home/me/proj/../Documents/cv.pdf", "ask"],
	];
	for (const [path, want] of cases) assert.equal(verdict(path, e), want, path);
});

test("a root that would cover everything is no root", () => {
	for (const roots of [["/home/me"], ["/"], ["/home"], [""], ["proj"]]) {
		assert.equal(verdict("/home/me/Documents/cv.pdf", env("linux", { roots })), "ask", JSON.stringify(roots));
	}
	assert.equal(usableRoot("/home/me/proj", { platform: "linux", home: "/home/me" }), true);
	assert.equal(usableRoot("C:\\", { platform: "win32", home: "C:\\Users\\Me" }), false);
	assert.equal(usableRoot("c:\\users\\me", { platform: "win32", home: "C:\\Users\\Me" }), false);
	assert.equal(usableRoot("D:\\work", { platform: "win32", home: "C:\\Users\\Me" }), true);
	assert.equal(verdict("C:\\Users\\Me\\Documents\\cv.pdf", env("win32", { roots: ["C:\\"] })), "ask");
});

test("credential-like names are refused in any folder, even the agent's own", () => {
	const names = [
		".env",
		".env.local",
		".env.production",
		"prod.env",
		"server.pem",
		"server.key",
		"cert.p12",
		"cert.pfx",
		"passwords.kdbx",
		"id_rsa",
		"id_rsa.pub",
		"id_ed25519",
		"id_ed25519.pub",
		"id_ecdsa",
		"id_ecdsa_sk",
		"login.keychain",
		"login.keychain-db",
		".netrc",
		".npmrc",
		".pypirc",
		"known_hosts",
		"authorized_keys",
		"credentials",
		"tokens.json",
		"oauth.json",
		"oauth_client_secret.json",
	];
	for (const name of names) {
		const e = env("linux");
		assert.equal(verdict(`/home/me/proj/${name}`, e), "credential", name);
		assert.deepEqual(e.asked, [], `${name} is refused by its name, before the disk is touched`);
	}
	// The same names as a folder on the way to the file.
	for (const dir of [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".env", "credentials"]) {
		assert.equal(verdict(`/home/me/proj/${dir}/config.txt`, env("linux")), "credential", dir);
		assert.equal(verdict(`/home/me/${dir}/config.txt`, env("linux")), "credential", dir);
	}
	// Names that only look close are files like any other.
	for (const name of ["environment.txt", "keynote.txt", "monkey.jpg", "credentials.md", "oauth-notes.txt", "pem.txt", "my_id_rsa_notes.txt"]) {
		assert.equal(verdict(`/home/me/proj/${name}`, env("linux")), "free", name);
	}
});

test("Polycarp's own folders, browser profiles and key stores are refused; the saved-files folder is the exception", () => {
	const linux = [
		"/home/me/.config/polycarp/browser/remote.json",
		"/home/me/.config/polycarp/browser/captures/network-1.har",
		"/home/me/.config/tabkyra/settings.json",
		"/home/me/.config/google-chrome/Default/History",
		"/home/me/.config/chromium/Default/Bookmarks",
		"/home/me/.config/net.imput.helium/Default/History",
		"/home/me/.config/BraveSoftware/Brave-Browser/Default/History",
		"/home/me/.mozilla/firefox/abc.default/places.sqlite",
		"/home/me/.local/share/keyrings/login.keyring",
		"/home/me/.password-store/site.gpg",
	];
	for (const path of linux) assert.equal(verdict(path, env("linux")), "private_dir", path);
	const mac = [
		"/Users/me/Library/Application Support/Google/Chrome/Default/History",
		"/Users/me/Library/Application Support/net.imput.helium/Default/History",
		"/Users/me/Library/Application Support/Firefox/Profiles/x/places.sqlite",
		"/Users/me/Library/Safari/History.db",
		"/Users/me/Library/Application Support/Polycarp/state.json",
		// macOS folds case: the same folder spelled another way.
		"/Users/me/library/application support/google/chrome/Default/History",
		"/USERS/ME/.CONFIG/POLYCARP/browser/remote.json",
	];
	for (const path of mac) assert.equal(verdict(path, env("darwin")), "private_dir", path);
	assert.equal(verdict("/Users/me/Library/Keychains/login.keychain-db", env("darwin")), "credential");
	// Linux does not fold case, so a differently spelled folder is a different folder (and asks).
	assert.equal(verdict("/home/me/.CONFIG/Google-Chrome/Default/History", env("linux")), "ask");
});

test("the file a path leads to is the one judged: links to refused files are refused", () => {
	const disk = {
		"/home/me/proj/notes.txt": { realPath: "/home/me/.ssh/id_ed25519" },
		"/home/me/proj/history.txt": { realPath: "/home/me/.config/google-chrome/Default/History" },
		"/home/me/proj/settings.txt": { realPath: "/home/me/.config/polycarp/browser/remote.json" },
		"/home/me/proj/cv.pdf": { realPath: "/home/me/Documents/cv.pdf" },
		"/home/me/Documents/link.pdf": { realPath: "/home/me/proj/report.pdf" },
		"/home/me/proj/twin.txt": { nlink: 2 },
		"/home/me/proj/folder": { isFile: false },
		"/home/me/proj/gone.txt": { error: "no such file" },
		"/home/me/proj/locked.txt": { error: "permission denied" },
		"/home/me/proj/huge.bin": { bytes: MAX_UPLOAD_BYTES + 1 },
		"/home/me/proj/edge.bin": { bytes: MAX_UPLOAD_BYTES },
	};
	const cases = [
		["/home/me/proj/notes.txt", "credential"],
		["/home/me/proj/history.txt", "private_dir"],
		["/home/me/proj/settings.txt", "private_dir"],
		// A link out of the agent's folder is judged where it lands: allowed, but it asks.
		["/home/me/proj/cv.pdf", "ask"],
		["/home/me/Documents/link.pdf", "free"],
		["/home/me/proj/twin.txt", "hard_link"],
		["/home/me/proj/folder", "not_file"],
		["/home/me/proj/gone.txt", "unreadable"],
		["/home/me/proj/locked.txt", "unreadable"],
		["/home/me/proj/huge.bin", "too_big"],
		["/home/me/proj/edge.bin", "free"],
		["proj/report.pdf", "not_absolute"],
		["./report.pdf", "not_absolute"],
		["", "not_absolute"],
	];
	for (const [path, want] of cases) assert.equal(verdict(path, env("linux", {}, disk)), want, path);
	// What comes back is the resolved file: that is what gets read and named.
	const v = checkUploadPath("/home/me/proj/cv.pdf", env("linux", {}, disk));
	assert.deepEqual([v.path, v.name, v.bytes], ["/home/me/Documents/cv.pdf", "cv.pdf", 100]);
});

test("a remote caller may not name a path at all", () => {
	for (const path of ["/home/me/proj/report.pdf", "/home/me/.config/polycarp/browser/files/s1/saved.pdf", "/tmp/x"]) {
		const e = env("linux", { remote: true });
		assert.equal(verdict(path, e), "remote", path);
		assert.deepEqual(e.asked, [], "and the disk is never looked at for it");
	}
});

test("Windows paths: case, separators, long-path prefixes, streams and devices", () => {
	const cases = [
		["C:\\Users\\Me\\proj\\report.pdf", "free"],
		["c:\\users\\me\\PROJ\\Report.PDF", "free"],
		["C:/Users/Me/proj/report.pdf", "free"],
		["\\\\?\\C:\\Users\\Me\\proj\\report.pdf", "free"],
		["C:\\Users\\Me\\Documents\\cv.pdf", "ask"],
		["D:\\share\\cv.pdf", "ask"],
		["\\\\server\\share\\cv.pdf", "ask"],
		["C:\\Users\\Me\\proj\\ID_RSA", "credential"],
		["C:\\Users\\Me\\proj\\.ENV", "credential"],
		["C:\\Users\\Me\\proj\\Server.PEM", "credential"],
		// Windows drops trailing dots and spaces when it opens a file.
		["C:\\Users\\Me\\proj\\id_rsa.", "credential"],
		["C:\\Users\\Me\\proj\\.env ", "credential"],
		["C:\\Users\\Me\\.SSH\\config", "credential"],
		["C:/Users/Me/.aws/config", "credential"],
		["C:\\Users\\Me\\AppData\\Roaming\\polycarp\\browser\\remote.json", "private_dir"],
		["C:\\Users\\Me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History", "private_dir"],
		["c:\\users\\me\\appdata\\local\\microsoft\\edge\\User Data\\Default\\History", "private_dir"],
		["C:\\Users\\Me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\places.sqlite", "private_dir"],
		["\\\\?\\C:\\Users\\Me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\places.sqlite", "private_dir"],
		["C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5\\key", "private_dir"],
		["C:\\Users\\Me\\AppData\\Roaming\\polycarp\\browser\\files\\s1\\saved.pdf", "free"],
		// A stream hidden behind a file name, and a device.
		["C:\\Users\\Me\\proj\\report.pdf:secret", "not_file"],
		["\\\\.\\PhysicalDrive0", "not_file"],
		["\\\\?\\GLOBALROOT\\Device\\x", "not_file"],
		["proj\\report.pdf", "not_absolute"],
		["\\report.pdf", "ask"],
	];
	for (const [path, want] of cases) assert.equal(verdict(path, env("win32")), want, path);
	// %APPDATA% moved somewhere else is still protected.
	const moved = env("win32", { privateDirs: protectedDirs({ platform: "win32", home: "C:\\Users\\Me", configDirs: [], appData: "E:\\Roam", localAppData: "E:\\Local" }) });
	assert.equal(verdict("E:\\Roam\\Mozilla\\Firefox\\x.sqlite", moved), "private_dir");
	assert.equal(verdict("e:\\local\\google\\chrome\\User Data\\History", moved), "private_dir");
});

test("the caps: at most 10 files and 10 MB in one call", () => {
	assert.equal(checkUploadCaps([1, 2, 3]).ok, true);
	assert.equal(checkUploadCaps(Array(MAX_UPLOAD_FILES).fill(1)).ok, true);
	assert.equal(checkUploadCaps(Array(MAX_UPLOAD_FILES + 1).fill(1)).code, "too_many");
	assert.equal(checkUploadCaps([MAX_UPLOAD_BYTES]).ok, true);
	assert.equal(checkUploadCaps([MAX_UPLOAD_BYTES, 1]).code, "too_big");
	assert.equal(checkUploadCaps([6 * 1024 * 1024, 6 * 1024 * 1024]).code, "too_big");
	assert.equal(checkUploadCaps([]).code, "empty");
	assert.match(checkUploadCaps([MAX_UPLOAD_BYTES, 1]).reason, new RegExp(String(MAX_UPLOAD_BYTES + 1)));
});

test("isInside and credentialLike on their own", () => {
	assert.equal(isInside("/a/b/c", "/a/b", "linux"), true);
	assert.equal(isInside("/a/b", "/a/b", "linux"), true);
	assert.equal(isInside("/a/bc", "/a/b", "linux"), false);
	assert.equal(isInside("/a", "/a/b", "linux"), false);
	assert.equal(isInside("/A/B/c", "/a/b", "linux"), false);
	assert.equal(isInside("/A/B/c", "/a/b", "darwin"), true);
	assert.equal(isInside("D:\\a", "C:\\a", "win32"), false);
	assert.equal(isInside("C:\\A\\b", "c:\\a", "win32"), true);
	assert.equal(isInside("/a/b", "", "linux"), false);
	assert.equal(credentialLike("/srv/app/readme.md", "linux"), undefined);
	assert.ok(credentialLike("/srv/app/.ENV", "linux"));
});
