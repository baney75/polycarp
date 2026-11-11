// The pure parts of the files tool (docs/decisions.md, D38): what a file input accepts, the name a
// server suggests, and reading a data: URL.
import assert from "node:assert/strict";
import test from "node:test";
import { acceptsFile, base64Bytes, dispositionName, parseDataUrl, urlFileName } from "../src/bridge/file-util.ts";
import { BRIDGE_METHODS, FILE_CHUNK_FROM_EXTENSION, FILE_CHUNK_TO_EXTENSION, IDEMPOTENT_METHODS, MAX_FRAME_FROM_EXTENSION, MAX_FRAME_TO_EXTENSION } from "../src/bridge/protocol.ts";

test("accept: extensions, exact types and type families, without case; an empty accept takes anything", () => {
	const cases = [
		["", "a.exe", "application/x-msdownload", true],
		[".pdf", "report.PDF", "", true],
		[".pdf", "report.pdf.exe", "application/pdf", false],
		[".pdf, .docx", "cv.docx", "", true],
		["image/*", "a.bin", "image/png", true],
		["image/*", "a.png", "", false],
		["image/*", "a.txt", "imagex/png", false],
		["IMAGE/PNG", "a", "image/png; q=1", true],
		["image/png", "a.png", "image/jpeg", false],
		[".bin,text/plain", "notes.txt", "text/plain", true],
		[".bin,text/plain", "photo.png", "image/png", false],
		[" , ", "anything", "", true],
	];
	for (const [accept, name, mime, want] of cases) assert.equal(acceptsFile(accept, name, mime), want, `${accept} | ${name} | ${mime}`);
	// It runs inside the page as source text, so it can't lean on anything outside itself.
	assert.equal(new Function(`return (${acceptsFile.toString()})(".pdf", "a.pdf", "")`)(), true);
});

test("the name a server suggests: filename* wins, quotes and escapes are read, a path stays for the helper to clean", () => {
	const cases = [
		['attachment; filename="report.pdf"', "report.pdf"],
		["attachment; filename=report.pdf", "report.pdf"],
		["attachment; filename=\"a \\\"b\\\".txt\"", 'a "b".txt'],
		["attachment; filename=\"plain.txt\"; filename*=UTF-8''na%C3%AFve%20file.txt", "naïve file.txt"],
		["attachment; filename*=UTF-8''%E0%A4%A", undefined],
		['attachment; filename="../../.bashrc"', "../../.bashrc"],
		["inline", undefined],
		["", undefined],
		[null, undefined],
	];
	for (const [header, want] of cases) assert.equal(dispositionName(header), want, String(header));
	assert.equal(urlFileName("https://example.com/a/b/My%20File.pdf?x=1#y"), "My File.pdf");
	assert.equal(urlFileName("https://example.com/a/"), undefined);
	assert.equal(urlFileName("not a url"), undefined);
});

test("base64 sizes and data: URLs", () => {
	assert.equal(base64Bytes(""), 0);
	assert.equal(base64Bytes(btoa("a")), 1);
	assert.equal(base64Bytes(btoa("ab")), 2);
	assert.equal(base64Bytes(btoa("abc")), 3);
	for (const bad of ["abc", "ab=c", "a b=", "@@@@", "====="]) assert.equal(base64Bytes(bad), -1, bad);
	assert.deepEqual(parseDataUrl(`data:text/plain;base64,${btoa("hello")}`), { mime: "text/plain", b64: btoa("hello") });
	assert.deepEqual(parseDataUrl("data:,hi%20there"), { mime: "text/plain", b64: btoa("hi there") });
	assert.deepEqual(parseDataUrl(`data:IMAGE/PNG;name=x;base64,${btoa("ab").replace(/=+$/, "")}`), { mime: "image/png", b64: btoa("ab") });
	assert.equal(atob(parseDataUrl("data:text/plain;charset=utf-8,na%C3%AFve").b64), "naÃ¯ve");
	for (const bad of ["data:text/plain;base64,@@@", "data:text/plain", "http://x/", "data:,%E0%A4%A"]) assert.equal(parseDataUrl(bad), undefined, bad);
});

test("the protocol: every files method is known, none is replayed, and a piece fits its frame as base64", () => {
	const files = BRIDGE_METHODS.filter((m) => m.startsWith("files."));
	assert.deepEqual([...files].sort(), ["files.download.begin", "files.download.chunk", "files.download.end", "files.pdf.begin", "files.upload.abort", "files.upload.begin", "files.upload.chunk", "files.upload.commit"]);
	for (const m of files) assert.equal(IDEMPOTENT_METHODS.has ? IDEMPOTENT_METHODS.has(m) : IDEMPOTENT_METHODS.includes(m), false, `${m} must not be replayed after a drop`);
	const asBase64 = (n) => Math.ceil(n / 3) * 4;
	assert.ok(asBase64(FILE_CHUNK_TO_EXTENSION) + 1024 <= MAX_FRAME_TO_EXTENSION, "an upload piece and its envelope fit a frame to the extension");
	assert.ok(FILE_CHUNK_FROM_EXTENSION <= 4 * 1024 * 1024 && asBase64(FILE_CHUNK_FROM_EXTENSION) + 1024 <= MAX_FRAME_FROM_EXTENSION);
	assert.equal(FILE_CHUNK_FROM_EXTENSION % 3, 0, "so pieces of a base64 string cut on whole bytes");
});
