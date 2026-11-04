// `tabkyra update` end to end against a fake GitHub release server on 127.0.0.1, with a
// throwaway signing key: install, update, refuse tampered or mis-signed releases, roll back,
// recover an interrupted swap, and the native host's "update available" message.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePublicKey, verifyMinisign } from "../src/minisign.ts";
import { fitNotes, MORE_LINE, releaseSummary } from "../src/release-notes.ts";
import { createZip } from "../../scripts/release/zip.mjs";
import { signMinisign, throwawayKey } from "./helpers/minisign-sign.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const packageScript = join(here, "..", "..", "scripts", "release", "package.mjs");
const tmp = mkdtempSync(join(tmpdir(), "tabkyra-update-"));
const home = join(tmp, "home");
const tabkyraHome = join(home, ".local", "share", "tabkyra");
const keyFile = join(tmp, "release.pub");
const key = throwawayKey();
const otherKey = throwawayKey();
writeFileSync(keyFile, key.publicText);

// A browser profile dir, so `install` has somewhere to register the native host.
const chromeDir =
	process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
mkdirSync(chromeDir, { recursive: true });
const socketDir = join(tmp, "sock");
mkdirSync(socketDir, { mode: 0o700 });

/** tag -> { prerelease, assets: { name: Buffer } } */
const releases = new Map();
let server;
let base;

function fakeCheckout(version) {
	const root = join(tmp, `src-${version}`);
	const dist = join(root, "dist-chrome");
	mkdirSync(join(root, "cli", "dist"), { recursive: true });
	mkdirSync(dist, { recursive: true });
	const core = version.replace(/-.*/, "");
	writeFileSync(join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Tabkyra", version: core }));
	for (const f of ["background.js", "sidepanel.js", "sidepanel.html", "app.css"]) writeFileSync(join(dist, f), `/* ${f} ${version} */`);
	copyFileSync(cli, join(root, "cli", "dist", "index.js"));
	copyFileSync(join(here, "..", "package.json"), join(root, "cli", "package.json"));
	return root;
}

/** Build a release with the real packaging script, then sign it (or not, or wrongly). */
function publish(version, { prerelease = false, signer = key, comment = `tabkyra ${version}`, tamper = false, notes } = {}) {
	const root = fakeCheckout(version);
	const out = join(tmp, `out-${version}`);
	const r = spawnSync(process.execPath, [packageScript, "--version", version, "--out", out, "--root", root], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const zipName = `tabkyra-${version}.zip`;
	let zip = readFileSync(join(out, zipName));
	const sums = readFileSync(join(out, "SHA256SUMS"));
	if (tamper) {
		zip = Buffer.from(zip);
		zip[100] ^= 0xff;
	}
	releases.set(`v${version}`, {
		prerelease,
		body: notes,
		assets: { [zipName]: zip, SHA256SUMS: sums, "SHA256SUMS.minisig": Buffer.from(signMinisign(sums, signer, comment)) },
	});
}

/** A release whose archive tries to write outside the install folder. */
function publishEscaping(version) {
	const zip = createZip([
		{ name: "release.json", data: Buffer.from(JSON.stringify({ version })) },
		{ name: "../../escaped.txt", data: Buffer.from("owned") },
	]);
	const zipName = `tabkyra-${version}.zip`;
	const sums = Buffer.from(`${createHash("sha256").update(zip).digest("hex")}  ${zipName}\n`);
	releases.set(`v${version}`, {
		prerelease: false,
		assets: { [zipName]: zip, SHA256SUMS: sums, "SHA256SUMS.minisig": Buffer.from(signMinisign(sums, key, `tabkyra ${version}`)) },
	});
}

function env(extra = {}) {
	const e = {
		...process.env,
		HOME: home,
		TABKYRA_HOME: tabkyraHome,
		TABKYRA_UPDATE_API: base,
		TABKYRA_UPDATE_PUBKEY: keyFile,
		TABKYRA_SOCKET_DIR: socketDir,
		// An update refreshes installed skills; keep it away from the real harness folders.
		CLAUDE_CONFIG_DIR: join(home, ".claude"),
		CODEX_HOME: join(home, ".codex"),
		NO_COLOR: "1",
		...extra,
	};
	delete e.XDG_CONFIG_HOME;
	delete e.TABKYRA_CONFIG_DIR;
	delete e.FORCE_COLOR;
	return e;
}

/** Async on purpose: the fake server lives in this process, so a sync spawn would starve it. */
function run(script, ...args) {
	return runWith({}, script, ...args);
}

function runWith(extraEnv, script, ...args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, ...args], { env: env(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("close", (code) => resolve({ code, out }));
	});
}

const appCli = () => join(tabkyraHome, "app", "cli", "dist", "index.js");
const appVersion = (dir = "app") => JSON.parse(readFileSync(join(tabkyraHome, dir, "release.json"), "utf8")).version;

before(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/repos/baney75/tabkyra/releases") {
			const list = [...releases.entries()].map(([tag, r]) => ({
				tag_name: tag,
				draft: false,
				prerelease: r.prerelease,
				html_url: `${base}/releases/${tag}`,
				body: r.body,
				assets: Object.entries(r.assets).map(([name, data]) => ({ name, size: data.length, browser_download_url: `${base}/dl/${tag}/${name}` })),
			}));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(list));
			return;
		}
		const m = /^\/dl\/([^/]+)\/(.+)$/.exec(url.pathname);
		const data = m && releases.get(m[1])?.assets[m[2]];
		if (!data) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-length": data.length });
		res.end(data);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
	server?.close();
	rmSync(tmp, { recursive: true, force: true });
});

test("minisign verification matches upstream test vectors", async () => {
	// From jedisct1/rust-minisign-verify: a prehashed signature over "test".
	const pk = parsePublicKey("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
	const prehashed = [
		"untrusted comment: signature from minisign secret key",
		"RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
		"trusted comment: timestamp:1556193335\tfile:test",
		"y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
	].join("\n");
	assert.equal(verifyMinisign(Buffer.from("test"), prehashed, pk), "timestamp:1556193335\tfile:test");
	assert.throws(() => verifyMinisign(Buffer.from("Test"), prehashed, pk), /does not match/);
	assert.throws(() => verifyMinisign(Buffer.from("test"), prehashed.replace("file:test", "file:tesT"), pk), /altered/);
	// The legacy (non-prehashed) vector verifies in minisign, but releases never use it.
	const legacy = [
		"untrusted comment: signature from minisign secret key",
		"RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=",
		"trusted comment: timestamp:1555779966\tfile:test",
		"QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==",
	].join("\n");
	assert.throws(() => verifyMinisign(Buffer.from("test"), legacy, pk), /legacy/);
	// The test signer produces what the verifier accepts.
	const sig = signMinisign(Buffer.from("x"), key, "tabkyra 1.0.0");
	assert.equal(verifyMinisign(Buffer.from("x"), sig, parsePublicKey(key.publicText)), "tabkyra 1.0.0");
	assert.throws(() => verifyMinisign(Buffer.from("x"), sig, parsePublicKey(otherKey.publicText)), /made with key/);
});

test("no release yet: --check says so and exits 0", async () => {
	const r = await run(cli, "update", "--check");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /No stable release is published yet/);
});

test("--check exits 100 with JSON when a newer release exists", async () => {
	publish("9.1.1");
	const r = await run(cli, "update", "--check", "--json");
	assert.equal(r.code, 100, r.out);
	const status = JSON.parse(r.out);
	assert.equal(status.latest, "9.1.1");
	assert.equal(status.available, true);
	assert.equal(status.channel, "stable");
	assert.ok(existsSync(join(home, ".config", "tabkyra", "update-status.json")), "the check is cached for the native host");
});

test("from a checkout, update asks first and does nothing without a yes", async () => {
	const r = await run(cli, "update");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Install release 9\.1\.1/);
	assert.equal(existsSync(join(tabkyraHome, "app")), false);
});

test("update --yes installs the signed release and registers the host from it", async () => {
	const r = await run(cli, "update", "--yes");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /Signature verified/);
	assert.match(r.out, /Checksum verified/);
	assert.match(r.out, /Reload Tabkyra/);
	assert.equal(appVersion(), "9.1.1");
	const launcher = readFileSync(join(home, ".config", "tabkyra", "host"), "utf8");
	assert.ok(launcher.includes(appCli()), `launcher points at the release: ${launcher}`);
	const hostManifest = JSON.parse(readFileSync(join(chromeDir, "NativeMessagingHosts", "ai.tabkyra.bridge.json"), "utf8"));
	assert.equal(hostManifest.path, join(home, ".config", "tabkyra", "host"));
});

test("the installed CLI updates itself and keeps the last version", async () => {
	publish("9.1.2");
	const r = await run(appCli(), "update");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /Updating 9\.1\.1 → 9\.1\.2/);
	assert.equal(appVersion(), "9.1.2");
	assert.equal(appVersion("previous"), "9.1.1");
	const again = await run(appCli(), "update", "--check");
	assert.equal(again.code, 0, again.out);
	assert.match(again.out, /Up to date/);
});

test("a tampered zip is refused and nothing changes", async () => {
	publish("9.1.3", { tamper: true });
	const r = await run(appCli(), "update");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Checksum mismatch/);
	assert.equal(appVersion(), "9.1.2");
	releases.delete("v9.1.3");
});

test("a release signed by another key is refused", async () => {
	publish("9.1.4", { signer: otherKey });
	const r = await run(appCli(), "update");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Signature check failed: .*made with key/);
	assert.equal(appVersion(), "9.1.2");
	releases.delete("v9.1.4");
});

test("a signature made for another version is refused", async () => {
	publish("9.1.5", { comment: "tabkyra 9.1.1" });
	const r = await run(appCli(), "update");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /made for "tabkyra 9\.1\.1", not tabkyra 9\.1\.5/);
	assert.equal(appVersion(), "9.1.2");
	releases.delete("v9.1.5");
});

test("an archive that writes outside the install folder is refused", async () => {
	publishEscaping("9.1.6");
	const r = await run(appCli(), "update");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /escapes the archive/);
	assert.equal(existsSync(join(tabkyraHome, "escaped.txt")), false);
	assert.equal(existsSync(join(home, ".local", "escaped.txt")), false);
	assert.equal(appVersion(), "9.1.2");
	releases.delete("v9.1.6");
});

test("no signing key in the build: updates refuse", async () => {
	publish("9.1.7");
	const blank = join(tmp, "blank.pub");
	writeFileSync(blank, "untrusted comment: no key yet\n");
	const r = await runWith({ TABKYRA_UPDATE_PUBKEY: blank }, appCli(), "update");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /no release signing key/);
	assert.equal(appVersion(), "9.1.2");
	releases.delete("v9.1.7");
});

test("rollback swaps back, and again", async () => {
	const r = await run(appCli(), "update", "--rollback");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /Rolled back 9\.1\.2 → 9\.1\.1/);
	assert.equal(appVersion(), "9.1.1");
	assert.equal(appVersion("previous"), "9.1.2");
	const back = await run(appCli(), "update", "--rollback");
	assert.equal(back.code, 0, back.out);
	assert.equal(appVersion(), "9.1.2");
});

test("nightly channel sees prereleases; stable does not", async () => {
	publish("9.2.0-nightly.20261025", { prerelease: true });
	const stable = await run(appCli(), "update", "--check");
	assert.equal(stable.code, 0, stable.out);
	const nightly = await run(appCli(), "update", "--check", "--channel", "nightly");
	assert.equal(nightly.code, 100, nightly.out);
	assert.match(nightly.out, /9\.2\.0-nightly\.20261025/);
	// A read-only check doesn't change the saved channel; an update does.
	const settings = join(home, ".config", "tabkyra", "update.json");
	assert.equal(existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")).channel : "stable", "stable");
	const r = await run(appCli(), "update", "--channel", "nightly");
	assert.equal(r.code, 0, r.out);
	assert.equal(appVersion(), "9.2.0-nightly.20261025");
	assert.equal(JSON.parse(readFileSync(settings, "utf8")).channel, "nightly");
	await run(appCli(), "update", "--channel", "stable");
	assert.equal(JSON.parse(readFileSync(settings, "utf8")).channel, "stable");
	releases.delete("v9.2.0-nightly.20261025");
});

test("an update interrupted between the two renames is undone", async () => {
	// The crash window: app/ was moved to previous/ and the new release never landed.
	rmSync(join(tabkyraHome, "previous"), { recursive: true, force: true });
	renameSync(join(tabkyraHome, "app"), join(tabkyraHome, "previous"));
	publish("9.3.0");
	const r = await run(cli, "update", "--yes");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /interrupted update was undone/);
	assert.equal(appVersion(), "9.3.0");
	assert.equal(appVersion("previous"), "9.2.0-nightly.20261025");
});

test("rollback right after an interrupted update repairs first and deletes nothing", async () => {
	// Crash window again: app/ moved to previous/, new release never landed.
	renameSync(join(tabkyraHome, "app"), join(tabkyraHome, "previous-crash"));
	rmSync(join(tabkyraHome, "previous"), { recursive: true, force: true });
	renameSync(join(tabkyraHome, "previous-crash"), join(tabkyraHome, "previous"));
	const r = await run(cli, "update", "--rollback", "--yes");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /interrupted update was undone/);
	assert.match(r.out, /No previous release/);
	assert.equal(appVersion(), "9.3.0", "the release is back in app/");
});

test("a rollback interrupted after its second rename keeps both releases", async () => {
	// Install 9.3.1 so there is a previous release, then fake the crash: app/ is the old
	// release, previous/ is gone, and the newer one sits in .swap-*.
	publish("9.3.1");
	assert.equal((await run(appCli(), "update")).code, 0);
	renameSync(join(tabkyraHome, "app"), join(tabkyraHome, ".swap-crash"));
	renameSync(join(tabkyraHome, "previous"), join(tabkyraHome, "app"));
	const r = await run(appCli(), "update", "--check");
	assert.match(r.out, /Kept 9\.3\.1 for rollback/);
	assert.equal(appVersion(), "9.3.0");
	assert.equal(appVersion("previous"), "9.3.1");
	assert.equal(existsSync(join(tabkyraHome, ".swap-crash")), false);
	assert.equal((await run(appCli(), "update", "--rollback")).code, 0);
	assert.equal(appVersion(), "9.3.1");
});

test("rollback from a checkout asks first and changes nothing without a yes", async () => {
	const launcher = readFileSync(join(home, ".config", "tabkyra", "host"), "utf8");
	const r = await run(cli, "update", "--rollback");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Roll back the release install/);
	assert.equal(appVersion(), "9.3.1");
	assert.equal(readFileSync(join(home, ".config", "tabkyra", "host"), "utf8"), launcher);
});

test("a held lock stops a second updater; a dead one is taken over", async () => {
	const lock = join(tabkyraHome, "update.lock");
	mkdirSync(lock);
	// No pid written yet and fresh: another updater is between mkdir and writing its pid.
	let r = await run(appCli(), "update", "--check");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Another tabkyra update is running/);
	// A pid that no longer exists: taken over.
	writeFileSync(join(lock, "pid"), "999999");
	r = await run(appCli(), "update", "--check");
	assert.equal(r.code, 0, r.out);
	assert.equal(existsSync(lock), false);
});

test("usage errors exit 2", async () => {
	assert.equal((await run(cli, "update", "--channel", "beta")).code, 2);
	assert.equal((await run(cli, "update", "--rollback", "--check")).code, 2);
	assert.equal((await run(cli, "update", "--bogus")).code, 2);
});

test("the native host tells the extension an update is available", async () => {
	writeFileSync(
		join(home, ".config", "tabkyra", "update-status.json"),
		JSON.stringify({ checkedAt: Date.now(), channel: "stable", current: appVersion(), latest: "9.4.0", available: true }),
	);
	// The host reads the installed version of the copy it runs from: the release in app/.
	const host = spawn(process.execPath, [appCli(), "host", "chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/"], { env: env() });
	const hello = Buffer.from(JSON.stringify({ type: "hello", version: "9.3.0", protocol: 1, methods: [] }));
	const frame = Buffer.alloc(4 + hello.length);
	frame.writeUInt32LE(hello.length, 0);
	hello.copy(frame, 4);
	host.stdin.write(frame);
	const message = await new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		const timer = setTimeout(() => reject(new Error("no update_status from the host")), 10000);
		host.stdout.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
				const len = buf.readUInt32LE(0);
				const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
				buf = buf.subarray(4 + len);
				if (msg.type === "update_status") {
					clearTimeout(timer);
					resolve(msg);
				}
			}
		});
	});
	host.kill();
	assert.equal(message.available, true);
	assert.equal(message.latest, "9.4.0");
	assert.equal(message.current, appVersion());
});

/** `tabkyra update --host ...` as the native host runs it: one JSON event per line. */
async function runHostUpdate(...args) {
	const r = await run(appCli(), "update", "--host", ...args);
	const events = r.out
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l));
	return { ...r, events, last: events.at(-1) };
}

test("release mode from the side panel: the same signed install, streamed as steps, with the notes", async () => {
	const from = appVersion();
	publish("9.5.0", { notes: "Faster tab groups.\n\n- Fixed the side panel on narrow windows." });
	const r = await runHostUpdate();
	assert.equal(r.code, 0, r.out);
	const phases = r.events.map((e) => e.phase);
	for (const p of ["checking", "downloading", "verifying", "installing", "done"]) assert.ok(phases.includes(p), `${p} in ${phases}`);
	assert.equal(r.last.staged, true, "verified and unpacked, waiting to be activated");
	assert.equal(appVersion(), from, "nothing live changes before activation");
	const a = await runHostUpdate("--activate");
	assert.equal(a.code, 0, a.out);
	assert.ok(a.events.some((e) => e.phase === "skills"));
	assert.equal(a.last.reload, true);
	assert.equal(appVersion(), "9.5.0");
	const record = JSON.parse(readFileSync(join(home, ".config", "tabkyra", "last-update.json"), "utf8"));
	assert.equal(record.kind, "update");
	assert.equal(record.mode, "release");
	assert.equal(record.from, from);
	assert.equal(record.to, "9.5.0");
	assert.match(record.notes, /Faster tab groups/);
	assert.equal(record.url, `${base}/releases/v9.5.0`);

	// The release checks are the terminal's: a tampered archive is refused and nothing changes.
	publish("9.6.0", { tamper: true });
	const bad = await runHostUpdate();
	assert.equal(bad.code, 1);
	assert.equal(bad.last.phase, "failed");
	assert.match(bad.last.message, /Checksum mismatch/);
	assert.equal(appVersion(), "9.5.0");
	const none = await runHostUpdate("--activate");
	assert.match(none.last.message, /Nothing was waiting/);
	assert.equal(appVersion(), "9.5.0");
	releases.delete("v9.6.0");

	const back = await runHostUpdate("--rollback");
	assert.equal(back.last.phase, "done", back.out);
	assert.equal(appVersion(), from);
	const again = await runHostUpdate("--rollback");
	assert.equal(again.last.phase, "done");
	assert.equal(appVersion(), "9.5.0");

	const usage = await run(appCli(), "update", "--host", "--channel", "nightly");
	assert.equal(usage.code, 2, "the host's command lines are fixed; nothing else is accepted");
});

test("long release notes keep every section: bullets are shortened before anything is cut", () => {
	const long = (n) => `- Entry ${n}. ${"Detail that only the full notes need. ".repeat(20)}`;
	const body = ["### Added", ...Array.from({ length: 30 }, (_, i) => long(i)), "", "### Fixed", "- The tabs fit. More detail."].join("\n");
	assert.ok(body.length > 8000);
	const notes = fitNotes(body);
	assert.ok(notes.length <= 8003, `${notes.length}`);
	assert.match(notes, /### Fixed\n- The tabs fit\./, "the last section survives");
	assert.match(notes, /- Entry 29\./, "every entry keeps its first sentence");
	assert.equal(fitNotes("Short notes."), "Short notes.");
});

test("notes too long even with short bullets drop the longest sections' last bullets, never a section", () => {
	const body = ["### Added", ...Array.from({ length: 120 }, (_, i) => `- Entry ${i}. ${"More words here. ".repeat(10)}`), "### Fixed", "- The last fix."].join("\n");
	const notes = fitNotes(body);
	assert.ok(notes.length <= 8000, `${notes.length}`);
	assert.match(notes, /### Fixed\n- The last fix\./);
	assert.match(notes, /- Entry 0\./);
	const code = fitNotes(`### Added\n- Adds \`${"x".repeat(500)} y\` and more.\n${"- filler. ".repeat(900)}`);
	for (const line of code.split("\n")) assert.equal((line.match(/`/g) ?? []).length % 2, 0, line.slice(0, 80));
});

test("the CLI's local imports name .ts files, so source runs resolve them", () => {
	const localJs = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.{1,2}\/[^"']+\.js["']/;
	for (const form of ['import { a } from "./a.js";', "import { a } from '../a.js';", 'import "./polyfill.js";', 'await import("./lazy.js")'])
		assert.match(form, localJs, form);
	assert.doesNotMatch('import { Button } from "@mariozechner/mini-lit/dist/Button.js";', localJs);
	const src = join(here, "..", "src");
	for (const file of readdirSync(src, { recursive: true }).filter((f) => String(f).endsWith(".ts"))) {
		const text = readFileSync(join(src, String(file)), "utf8");
		assert.doesNotMatch(text, localJs, String(file));
	}
});

test("fitNotes keeps a bullet that opens with a long code span, counts what it drops, and stays fast on huge notes", () => {
	const span = `- \`tabkyra skill eval ${"--flag value ".repeat(15)}\` then more words.`;
	const fitted = fitNotes(`### Added\n${span}\n${"- filler entry with words. ".repeat(1).trim()}\n`.repeat(1) + "- x ".repeat(4000), 600);
	for (const line of fitted.split("\n").filter((l) => l.startsWith("-"))) assert.match(line, /^- \S/, line.slice(0, 60));
	assert.equal(((fitted.split("\n")[1] ?? "").match(/`/g) ?? []).length % 2, 0);
	const huge = ["### Added", ...Array.from({ length: 3000 }, (_, i) => `- Entry ${i}. ${"word ".repeat(40)}`), "### Fixed", "- Last fix."].join("\n");
	const t0 = performance.now();
	const out = fitNotes(huge);
	assert.ok(performance.now() - t0 < 1000, "linear enough for a 3,000-entry body");
	assert.ok(out.length <= 8000);
	assert.match(out, /### Fixed\n- Last fix\./);
	assert.ok(Number(out.match(MORE_LINE)?.[1]) > 2000, "says how many entries it dropped");
	assert.equal(fitNotes("### Fixed\r\n- One.\r\n"), "### Fixed\n- One.\n");
});

test("release bodies open with a summary of every section that fits what an installed host keeps", () => {
	const body = execFileSync(process.execPath, [join(here, "..", "..", "scripts", "release", "notes.mjs"), "1.1.9"], { encoding: "utf8" });
	const summary = body.split("\n<details>")[0];
	assert.ok(summary.length <= 8000, `summary is ${summary.length} characters`);
	assert.match(body, /<details>\n<summary>Full release notes<\/summary>/);
	assert.match(body, /Updates from the side panel \(docs\/updates\.md\)\. "Update available" has an \*\*Update now\*\* button/, "the full notes are all there");
	assert.equal(releaseSummary(body), fitNotes(summary.trim()));
});

test("fitNotes never returns more than max, even when it has to cut", () => {
	const many = Array.from({ length: 200 }, (_, i) => `### Section ${i}\n- Entry ${i} ${"word ".repeat(30)}`).join("\n");
	assert.ok(fitNotes(many, 2000).length <= 2000);
});

