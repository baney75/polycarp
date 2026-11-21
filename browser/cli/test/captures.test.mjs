// Where captures land: a private folder, private files, nothing overwritten, and only files that are what they say.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureBytes, capturesDir, saveCapture } from "../src/captures.ts";

const webm = (extra = 100) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(extra, 1)]);
const har = { kind: "har", encoding: "json", data: { log: { version: "1.2", entries: [] } } };

function withConfig(fn) {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-captures-"));
	const before = process.env.TABKYRA_CONFIG_DIR;
	process.env.TABKYRA_CONFIG_DIR = dir;
	try {
		return fn(dir);
	} finally {
		if (before === undefined) delete process.env.TABKYRA_CONFIG_DIR;
		else process.env.TABKYRA_CONFIG_DIR = before;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("captures go in captures/ under the config folder: the folder 0700, each file 0600", () =>
	withConfig((dir) => {
		assert.equal(capturesDir(), join(dir, "captures"));
		const saved = saveCapture(har);
		assert.equal(saved.path.startsWith(join(dir, "captures") + "/network-"), true, saved.path);
		assert.ok(saved.path.endsWith(".har"));
		assert.equal(statSync(saved.path).mode & 0o777, 0o600);
		assert.equal(statSync(join(dir, "captures")).mode & 0o777, 0o700);
		assert.equal(saved.bytes, statSync(saved.path).size);
		assert.deepEqual(JSON.parse(readFileSync(saved.path, "utf8")), har.data);
		const video = saveCapture({ kind: "webm", encoding: "base64", data: webm().toString("base64") });
		assert.ok(video.path.includes("/video-") && video.path.endsWith(".webm"));
		assert.deepEqual(readFileSync(video.path), webm());
	}));

test("a folder made earlier with open permissions is closed to others", () =>
	withConfig((dir) => {
		mkdirSync(join(dir, "captures"), { mode: 0o755 });
		chmodSync(join(dir, "captures"), 0o755);
		saveCapture(har);
		assert.equal(statSync(join(dir, "captures")).mode & 0o777, 0o700);
	}));

test("two captures in the same millisecond are two files, and nothing is overwritten", () =>
	withConfig((dir) => {
		const now = new Date("2026-11-08T12:00:00.000Z");
		const a = saveCapture(har, now);
		const b = saveCapture(har, now);
		assert.notEqual(a.path, b.path);
		assert.equal(readdirSync(join(dir, "captures")).length, 2);
	}));

test("a captures folder that is a link is refused: nothing is written through it", () =>
	withConfig((dir) => {
		const elsewhere = mkdtempSync(join(tmpdir(), "tabkyra-elsewhere-"));
		try {
			symlinkSync(elsewhere, join(dir, "captures"));
			assert.throws(() => saveCapture(har), /not a plain folder/);
			assert.deepEqual(readdirSync(elsewhere), []);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	}));

test("only a file that is what it says is written: a HAR is JSON, a video is a WebM", () =>
	withConfig((dir) => {
		for (const bad of [
			{ kind: "har", encoding: "json", data: "text" },
			{ kind: "har", encoding: "base64", data: {} },
			{ kind: "har", encoding: "json", data: null },
			{ kind: "webm", encoding: "base64", data: Buffer.alloc(200, 9).toString("base64") },
			{ kind: "webm", encoding: "base64", data: webm(10).toString("base64") },
			{ kind: "webm", encoding: "json", data: {} },
			{ kind: "zip", encoding: "base64", data: "AAAA" },
		])
			assert.throws(() => saveCapture(bad), undefined, JSON.stringify(bad).slice(0, 80));
		assert.equal(existsSync(join(dir, "captures")), false, "nothing was created for a refused file");
		assert.equal(captureBytes({ kind: "webm", encoding: "base64", data: webm().toString("base64") }).length, 104);
	}));
