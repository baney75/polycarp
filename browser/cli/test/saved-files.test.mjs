// Where the files tool keeps a session's files, and how it opens a local file for an upload (D38).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkUploadPath } from "../src/file-rules.ts";
import { filesRoot, isTextMime, MAX_ALL_BYTES, MAX_SAVED_BYTES, MAX_SESSION_BYTES, MAX_SESSION_FILES, mimeFor, privateDirsHere, SavedFiles, sanitizeFileName, sessionFolder, sniffImage, UploadReader } from "../src/saved-files.ts";

function withConfig(fn) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tabkyra-files-")));
	const before = process.env.TABKYRA_CONFIG_DIR;
	process.env.TABKYRA_CONFIG_DIR = join(dir, "config");
	try {
		return fn(dir);
	} finally {
		if (before === undefined) delete process.env.TABKYRA_CONFIG_DIR;
		else process.env.TABKYRA_CONFIG_DIR = before;
		rmSync(dir, { recursive: true, force: true });
	}
}

const save = (files, name, body, mime) => {
	const w = files.create({ name, mime, sourceUrl: "https://example.test/x" });
	w.write(Buffer.from(body));
	return w.finish(Buffer.byteLength(body));
};

test("a server's file name is cleaned: no path, no leading dot, nothing Windows or a shell trips on", () => {
	const cases = [
		["report.pdf", "report.pdf"],
		["../../etc/passwd", "passwd"],
		["..\\..\\Windows\\win.ini", "win.ini"],
		["/abs/olute/a.txt", "a.txt"],
		[".bashrc", "bashrc"],
		["...hidden", "hidden"],
		[".env", "env"],
		["a<b>c:d\"e|f?g*.txt", "a_b_c_d_e_f_g_.txt"],
		["name.txt. . .", "name.txt"],
		["CON", "_CON"],
		["nul.txt", "_nul.txt"],
		["line\nbreak\u0000.txt", "linebreak.txt"],
		["evil‮fdp.exe", "evilfdp.exe"],
		["", "download"],
		["..", "download"],
		["/", "download"],
	];
	for (const [raw, want] of cases) assert.equal(sanitizeFileName(raw), want, JSON.stringify(raw));
	const long = sanitizeFileName(`${"a".repeat(300)}.pdf`);
	assert.ok(long.length <= 120 && long.endsWith(".pdf"), long);
	for (const [raw] of cases) assert.doesNotMatch(sanitizeFileName(raw), /[\\/]|^\./);
});

test("a session's folder name is safe whatever the session is called", () => {
	assert.equal(sessionFolder("remote-ab12-cd34"), "remote-ab12-cd34");
	for (const name of ["../../x", "a/b", "..", ".", "", "a b", "x".repeat(200)]) {
		const folder = sessionFolder(name);
		assert.match(folder, /^[A-Za-z0-9_-]{1,64}$/, name);
	}
	assert.notEqual(sessionFolder("a/b"), sessionFolder("a_b"), "two sessions never share a folder by cleaning");
});

test("saved files: private folder, private files, never overwritten, listed with hash and source", () =>
	withConfig((dir) => {
		const files = new SavedFiles("s1");
		assert.equal(files.dir, join(dir, "config", "files", "s1"));
		const a = save(files, "report.txt", "first", "text/plain");
		const b = save(files, "report.txt", "second", "text/plain");
		const c = save(files, "../../.ssh/authorized_keys", "third");
		assert.deepEqual([a.name, b.name, c.name], ["report.txt", "report-1.txt", "authorized_keys"]);
		assert.equal(readFileSync(join(files.dir, "report.txt"), "utf8"), "first", "the first file is untouched");
		assert.equal(a.sha256, createHash("sha256").update("first").digest("hex"));
		assert.deepEqual([a.bytes, a.mime, a.sourceUrl], [5, "text/plain", "https://example.test/x"]);
		assert.match(a.id, /^f_[0-9a-f]{10}$/);
		assert.ok(!Number.isNaN(Date.parse(a.savedAt)));
		for (const f of [a, b, c]) assert.equal(statSync(files.pathOf(f)).mode & 0o777, 0o600);
		assert.equal(statSync(files.dir).mode & 0o777, 0o700);
		assert.equal(statSync(filesRoot()).mode & 0o777, 0o700);
		assert.deepEqual(readdirSync(join(dir, "config")), ["files"], "nothing was written outside the files folder");
		assert.deepEqual(files.list().map((f) => f.id), [a.id, b.id, c.id]);
		assert.equal(files.read(b).toString(), "second");
		// Another session sees none of them.
		assert.deepEqual(new SavedFiles("s2").list(), []);
		assert.equal(new SavedFiles("s2").get(a.id), undefined);
		assert.equal(files.remove(a.id).name, "report.txt");
		assert.equal(files.remove(a.id), undefined);
		assert.deepEqual(files.list().map((f) => f.id), [b.id, c.id]);
		assert.deepEqual(readdirSync(files.dir).filter((n) => !n.startsWith(".")).sort(), ["authorized_keys", "report-1.txt"]);
	}));

test("a file that arrives short, long or too large is not kept", () =>
	withConfig(() => {
		const files = new SavedFiles("s1");
		const w = files.create({ name: "a.bin", sourceUrl: "" });
		w.write(Buffer.alloc(10));
		assert.throws(() => w.finish(11), /not the 11 announced/);
		assert.deepEqual(files.list(), []);
		assert.deepEqual(readdirSync(files.dir).filter((n) => !n.startsWith(".")), []);
		const big = files.create({ name: "b.bin", sourceUrl: "" });
		big.write(Buffer.alloc(MAX_SAVED_BYTES));
		assert.throws(() => big.write(Buffer.alloc(1)), /50 MB/);
		assert.deepEqual(readdirSync(files.dir).filter((n) => !n.startsWith(".")), []);
		assert.match(files.full(MAX_SAVED_BYTES + 1), /50 MB/);
		assert.equal(files.full(1024), undefined);
	}));

test("the list never names a file outside the folder, and a swapped file is not read", () =>
	withConfig((dir) => {
		const files = new SavedFiles("s1");
		const a = save(files, "a.txt", "aaa");
		const b = save(files, "b.txt", "bbb");
		const index = join(files.dir, ".index.json");
		const outside = join(dir, "secret.txt");
		writeFileSync(outside, "secret");
		const entries = JSON.parse(readFileSync(index, "utf8")).files;
		writeFileSync(index, JSON.stringify({ files: [...entries, { ...a, id: "f_evil000001", name: "../../secret.txt" }, { ...a, id: "f_evil000002", name: ".index.json" }, { ...a, id: "f_evil000003", name: "missing.txt" }] }));
		assert.deepEqual(files.list().map((f) => f.id), [a.id, b.id]);
		// The file is replaced by a link to another: neither listed nor read.
		rmSync(files.pathOf(b));
		symlinkSync(outside, files.pathOf(b));
		assert.deepEqual(files.list().map((f) => f.id), [a.id]);
		assert.throws(() => files.read(b));
		// A second name for a saved file takes it out of the list too.
		linkSync(files.pathOf(a), join(dir, "twin.txt"));
		assert.deepEqual(files.list(), []);
	}));

test("an upload reads the file the rules judged, through the link, and reports what it is", () =>
	withConfig((dir) => {
		const proj = join(dir, "proj");
		mkdirSync(proj);
		mkdirSync(join(dir, "keys"));
		writeFileSync(join(proj, "report.txt"), "report body");
		writeFileSync(join(dir, "keys", "id_ed25519"), "PRIVATE KEY");
		symlinkSync(join(dir, "keys", "id_ed25519"), join(proj, "notes.txt"));
		writeFileSync(join(proj, "one.txt"), "twin");
		linkSync(join(proj, "one.txt"), join(proj, "two.txt"));
		const reader = new UploadReader();
		const env = { platform: process.platform, home: join(dir, "home"), remote: false, sessionDir: join(dir, "config", "files", "s1"), filesRoot: join(dir, "config", "files"), privateDirs: privateDirsHere(), roots: [proj], inspect: reader.inspect };
		try {
			const ok = checkUploadPath(join(proj, "report.txt"), env);
			assert.deepEqual([ok.ok, ok.ask, ok.bytes], [true, false, 11]);
			assert.equal(reader.read(ok.path).toString(), "report body");
			// The check and the read are one open file: renaming another file over the name changes nothing that was approved.
			const again = checkUploadPath(join(proj, "report.txt"), env);
			renameSync(join(dir, "keys", "id_ed25519"), join(proj, "report.txt"));
			assert.equal(reader.read(again.path).toString(), "report body");
			const link = checkUploadPath(join(proj, "notes.txt"), env);
			assert.deepEqual([link.ok, link.code], [false, "unreadable"], "its target is gone now");
			writeFileSync(join(dir, "keys", "id_ed25519"), "PRIVATE KEY");
			assert.deepEqual([checkUploadPath(join(proj, "notes.txt"), env).code], ["credential"]);
			assert.equal(checkUploadPath(join(proj, "one.txt"), env).code, "hard_link");
			assert.equal(checkUploadPath(proj, env).code, "not_file");
			assert.equal(checkUploadPath(join(proj, "nope.txt"), env).code, "unreadable");
			assert.throws(() => reader.read(join(proj, "never-checked.txt")), /was not checked/);
			// The helper's own config folder is private; its files folder is not.
			mkdirSync(join(dir, "config"), { recursive: true });
			writeFileSync(join(dir, "config", "remote.json"), "{}");
			assert.equal(checkUploadPath(join(dir, "config", "remote.json"), env).code, "private_dir");
		} finally {
			reader.close();
		}
	}));

test("types: text is told from binary, and an image is one only by its bytes", () => {
	assert.equal(mimeFor("a.pdf"), "application/pdf");
	assert.equal(mimeFor("a.bin", "Text/CSV; charset=utf-8"), "text/csv");
	assert.equal(mimeFor("a.png", "application/octet-stream"), "image/png");
	assert.equal(mimeFor("a.unknown", "not a type"), "application/octet-stream");
	for (const m of ["text/plain", "text/html", "application/json", "image/svg+xml", "application/ld+json"]) assert.equal(isTextMime(m), true, m);
	for (const m of ["image/png", "application/pdf", "application/octet-stream"]) assert.equal(isTextMime(m), false, m);
	assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), "image/png");
	assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(sniffImage(Buffer.from("GIF89a....")), "image/gif");
	assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), undefined);
	assert.equal(sniffImage(Buffer.from("%PDF-1.7")), undefined);
});

test("room is held from the moment a file starts, so two downloads at once can't both take the last of it", () =>
	withConfig(() => {
		const files = new SavedFiles("quota");
		const big = 40 * 1024 * 1024;
		// 450 MB already kept, as far as the list says.
		save(files, "seed.bin", "x");
		const index = join(files.dir, ".index.json");
		const listed = JSON.parse(readFileSync(index, "utf8"));
		listed.files[0].bytes = MAX_SESSION_BYTES - 50 * 1024 * 1024;
		writeFileSync(index, JSON.stringify(listed));
		assert.equal(files.full(big), undefined);
		const first = files.create({ name: "a.bin", sourceUrl: "", bytes: big });
		// The second of two overlapping downloads is judged with the first still arriving.
		assert.match(files.full(big), /would pass/);
		assert.equal(files.full(5 * 1024 * 1024), undefined, "what still fits is allowed");
		// A download that fails gives its room back; one that finishes is counted by the list instead.
		first.abort();
		assert.equal(files.full(big), undefined);
		const again = files.create({ name: "a.bin", sourceUrl: "", bytes: 3 });
		again.write(Buffer.from("abc"));
		again.finish(3);
		assert.equal(files.full(big), undefined);
		// The count of files is held the same way.
		const counted = new SavedFiles("count");
		for (let i = 0; i < MAX_SESSION_FILES - 1; i++) save(counted, `n${i}.txt`, "n");
		assert.equal(counted.full(1), undefined);
		const open = counted.create({ name: "open.txt", sourceUrl: "", bytes: 1 });
		assert.match(counted.full(1), /already keeps/);
		open.abort();
		assert.equal(counted.full(1), undefined);
	}));

test("every session together has a cap, and a session's files go with it", () =>
	withConfig(() => {
		// Sessions opened one after another each keep a little under their own cap.
		const each = 450 * 1024 * 1024;
		const sessions = ["s1", "s2", "s3", "s4"].map((name) => {
			const files = new SavedFiles(name);
			save(files, "kept.bin", "x");
			const index = join(files.dir, ".index.json");
			const listed = JSON.parse(readFileSync(index, "utf8"));
			listed.files[0].bytes = each;
			writeFileSync(index, JSON.stringify(listed));
			return files;
		});
		assert.ok(4 * each < MAX_ALL_BYTES && 5 * each > MAX_ALL_BYTES);
		const fifth = new SavedFiles("s5");
		assert.equal(fifth.full(40 * 1024 * 1024), undefined);
		save(fifth, "kept.bin", "x");
		const index = join(fifth.dir, ".index.json");
		const listed = JSON.parse(readFileSync(index, "utf8"));
		listed.files[0].bytes = MAX_ALL_BYTES - 4 * each - 1024;
		writeFileSync(index, JSON.stringify(listed));
		assert.match(new SavedFiles("s6").full(4096), /across all sessions/);
		assert.match(fifth.full(4096), /across all sessions/);
		// A session that ends takes its files with it, and the room comes back.
		sessions[0].clear();
		assert.equal(existsSync(sessions[0].dir), false);
		assert.equal(existsSync(sessions[1].dir), true, "only its own folder goes");
		assert.equal(new SavedFiles("s6").full(4096), undefined);
		sessions[0].clear();
		// A renamed session keeps its files, and never takes over a folder that is already there.
		const moved = sessions[1].renamedTo("research");
		assert.deepEqual(moved.list().map((f) => f.name), ["kept.bin"]);
		assert.equal(existsSync(sessions[1].dir), false);
		const blocked = sessions[2].renamedTo("research");
		assert.equal(existsSync(sessions[2].dir), true);
		assert.deepEqual(blocked.list().map((f) => f.name), ["kept.bin"]);
	}));

test("the same file named twice in one upload is read whole both times", () =>
	withConfig((dir) => {
		const path = join(dir, "twice.txt");
		writeFileSync(path, "the same bytes");
		symlinkSync(path, join(dir, "alias.txt"));
		const reader = new UploadReader();
		try {
			const a = reader.inspect(path);
			const b = reader.inspect(join(dir, "alias.txt"));
			assert.equal(a.realPath, b.realPath);
			assert.equal(reader.read(a.realPath).toString(), "the same bytes");
			assert.equal(reader.read(b.realPath).toString(), "the same bytes");
		} finally {
			reader.close();
		}
	}));
