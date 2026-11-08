// The Connect panel's "Set up with Cloudflare": Polycarp's own cloudflared (pinned, hash-checked), the host's strict
// setupTunnel frame, the sign-in address extractor, and the five-step flow with stand-ins. Nothing here talks to
// Cloudflare, runs a real cloudflared, or touches the real config, HOME, Tailscale or remote.json.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = mkdtempSync(join(tmpdir(), "polycarp-cftunnel-"));
after(() => rmSync(root, { recursive: true, force: true }));

const mod = await loadTs(`
export { cloudflaredAsset, downloadCloudflared, downloadedCloudflared, CLOUDFLARED_VERSION } from "@src/cloudflared-download.ts";
export { cloudflaredBinary, extractLoginUrl, cloudflareLoginForPanel } from "@src/cloudflare.ts";
export { parseConnect } from "@src/connect-host.ts";
export { setupTunnel, TunnelError } from "@src/tunnel-setup.ts";
`);
const { cloudflaredAsset, downloadCloudflared, downloadedCloudflared, CLOUDFLARED_VERSION, cloudflaredBinary, extractLoginUrl, cloudflareLoginForPanel, parseConnect, setupTunnel, TunnelError } = mod;

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** Run `fn` with a fresh config dir, an empty PATH and no Homebrew lookup, so only the downloaded copy can be found. */
async function inConfig(name, fn) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const keys = ["TABKYRA_CONFIG_DIR", "PATH", "TABKYRA_APPLICATIONS_DIR", "HOME"];
	const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	process.env.TABKYRA_CONFIG_DIR = join(dir, "config");
	// A PATH with tar and nothing else, so a real cloudflared on this machine cannot be found.
	mkdirSync(join(dir, "nopath"), { recursive: true });
	const tar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
	symlinkSync(tar, join(dir, "nopath", "tar"));
	// GNU tar (Linux CI) runs gzip from PATH for -z; macOS bsdtar has it built in, and the Linux assets are raw binaries, so production never needs this.
	const gzip = spawnSync("sh", ["-c", "command -v gzip"], { encoding: "utf8" }).stdout.trim();
	if (gzip) symlinkSync(gzip, join(dir, "nopath", "gzip"));
	process.env.PATH = join(dir, "nopath");
	process.env.TABKYRA_APPLICATIONS_DIR = join(dir, "apps");
	process.env.HOME = join(dir, "home");
	mkdirSync(process.env.HOME, { recursive: true });
	try {
		return await fn(dir);
	} finally {
		for (const k of keys) {
			if (before[k] === undefined) delete process.env[k];
			else process.env[k] = before[k];
		}
	}
}

/** A server that answers every path with `body`. */
async function serve(body) {
	const server = createServer((_req, res) => res.end(body));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
}

/** A tgz holding one executable named cloudflared. */
function fakeTgz(dir) {
	const src = join(dir, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "cloudflared"), "#!/bin/sh\necho fake cloudflared\n");
	const tgz = join(dir, "fake.tgz");
	const r = spawnSync("tar", ["-czf", tgz, "-C", src, "cloudflared"]);
	assert.equal(r.status, 0);
	return readFileSync(tgz);
}

test("the pinned release has a digest for each supported platform", () => {
	assert.equal(CLOUDFLARED_VERSION, "2026.10.7");
	assert.equal(cloudflaredAsset("darwin", "arm64").sha256, "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd");
	assert.equal(cloudflaredAsset("darwin", "x64").name, "cloudflared-darwin-amd64.tgz");
	assert.equal(cloudflaredAsset("linux", "x64").archive, false);
	assert.equal(cloudflaredAsset("linux", "arm64").sha256, "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775");
	assert.equal(cloudflaredAsset("win32", "x64"), undefined);
});

test("a download with the wrong digest is refused and leaves no cloudflared behind", async () => {
	await inConfig("wrong", async (dir) => {
		const body = fakeTgz(dir);
		const server = await serve(body);
		try {
			const result = await downloadCloudflared({ baseUrl: server.url, asset: { name: "x.tgz", sha256: sha(Buffer.from("something else")), archive: true } });
			assert.equal(result.ok, false);
			assert.match(result.message, /checksum/);
			assert.equal(existsSync(downloadedCloudflared()), false);
			assert.equal(cloudflaredBinary(), undefined);
			// The temp folder is gone too.
			assert.deepEqual(readdirSync(join(dir, "config", "bin")), []);
		} finally {
			server.stop();
		}
	});
});

test("a download with the right digest is unpacked to <config>/bin/cloudflared, mode 0755, and cloudflaredBinary finds it", async () => {
	await inConfig("right", async (dir) => {
		const body = fakeTgz(dir);
		const server = await serve(body);
		try {
			assert.equal(cloudflaredBinary(), undefined);
			const result = await downloadCloudflared({ baseUrl: server.url, asset: { name: "x.tgz", sha256: sha(body), archive: true } });
			assert.deepEqual(result, { ok: true, path: join(dir, "config", "bin", "cloudflared") });
			assert.equal(statSync(result.path).mode & 0o777, 0o755);
			assert.equal(statSync(join(dir, "config", "bin")).mode & 0o777, 0o700);
			assert.match(readFileSync(result.path, "utf8"), /fake cloudflared/);
			assert.equal(cloudflaredBinary(), result.path);
			assert.deepEqual(readdirSync(join(dir, "config", "bin")), ["cloudflared"]);
		} finally {
			server.stop();
		}
	});
});

test("a raw-binary asset (Linux) is checked and installed the same way", async () => {
	await inConfig("raw", async () => {
		const body = Buffer.from("#!/bin/sh\necho raw\n");
		const server = await serve(body);
		try {
			const bad = await downloadCloudflared({ baseUrl: server.url, asset: { name: "cloudflared-linux-amd64", sha256: "0".repeat(64), archive: false } });
			assert.equal(bad.ok, false);
			assert.equal(existsSync(downloadedCloudflared()), false);
			const good = await downloadCloudflared({ baseUrl: server.url, asset: { name: "cloudflared-linux-amd64", sha256: sha(body), archive: false } });
			assert.equal(good.ok, true);
			assert.equal(statSync(good.path).mode & 0o777, 0o755);
		} finally {
			server.stop();
		}
	});
});

test("a cloudflared on PATH wins over the downloaded copy", async () => {
	await inConfig("pathwins", async (dir) => {
		const body = Buffer.from("#!/bin/sh\n");
		const server = await serve(body);
		try {
			await downloadCloudflared({ baseUrl: server.url, asset: { name: "c", sha256: sha(body), archive: false } });
			const own = join(dir, "nopath");
			writeFileSync(join(own, "cloudflared"), "#!/bin/sh\n");
			chmodSync(join(own, "cloudflared"), 0o755);
			assert.equal(cloudflaredBinary(), join(own, "cloudflared"));
		} finally {
			server.stop();
		}
	});
});

test("the host refuses setupTunnel without a host, with a bad host, and with extra keys", () => {
	const frame = (params) => parseConnect({ type: "connect", id: 1, method: "setupTunnel", ...(params === undefined ? {} : { params }) });
	assert.equal(frame(undefined).ok, false);
	assert.equal(frame({}).ok, false);
	for (const host of [5, "", "nodots", "bad host.example.com", "a..b.com", "x".repeat(300), null]) assert.equal(frame({ host }).ok, false, String(host));
	assert.equal(frame({ host: "polycarp.example.com", extra: 1 }).ok, false);
	const good = frame({ host: " https://Polycarp.Example.com/path " });
	assert.equal(good.ok, true);
	assert.deepEqual(good.call, { method: "setupTunnel", host: "polycarp.example.com" });
});

test("the sign-in address extractor accepts only https dash.cloudflare.com", () => {
	const ok = "https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc";
	assert.equal(extractLoginUrl(`Please open the following URL:\n\n${ok}\n\nLeave cloudflared running`), ok);
	for (const bad of [
		"http://dash.cloudflare.com/argotunnel",
		"https://dash.cloudflare.com.evil.example/argotunnel",
		"https://evil.example/https://dash.cloudflare.com/argotunnel",
		"https://user@dash.cloudflare.com/argotunnel",
		"https://dash.cloudflare.com:8443/argotunnel",
		"https://login.cloudflareaccess.org/x",
		"javascript:alert(1)",
		"nothing here",
	]) {
		assert.equal(extractLoginUrl(bad), undefined, bad);
	}
	// A bad address first does not hide a good one later.
	assert.equal(extractLoginUrl(`https://evil.example/x then ${ok}`), ok);
});

test("cloudflareLoginForPanel sends the address it reads, waits for the certificate, and never reads it", async () => {
	await inConfig("login", async (dir) => {
		const fake = join(dir, "fake-cloudflared");
		const cert = join(process.env.HOME, ".cloudflared", "cert.pem");
		// Node, not sh: cloudflareLoginForPanel gives the child an empty PATH.
		writeFileSync(
			fake,
			`#!${process.execPath}\nconst fs = require("node:fs");\nconsole.error("Please open: https://dash.cloudflare.com/argotunnel?aud=1");\nsetTimeout(() => { fs.mkdirSync(${JSON.stringify(join(process.env.HOME, ".cloudflared"))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(cert)}, "not-a-real-cert"); }, 800);\nsetTimeout(() => process.exit(0), 900);\n`,
		);
		chmodSync(fake, 0o755);
		const seen = [];
		const result = await cloudflareLoginForPanel(fake, (u) => seen.push(u), 20_000, 100);
		assert.deepEqual(result, { ok: true });
		assert.deepEqual(seen, ["https://dash.cloudflare.com/argotunnel?aud=1"]);
	});
});

test("cloudflareLoginForPanel lets cloudflared finish writing the certificate before it stops it", async () => {
	await inConfig("loginsettle", async (dir) => {
		const fake = join(dir, "fake-cloudflared");
		const home = join(process.env.HOME, ".cloudflared");
		const cert = join(home, "cert.pem");
		// Like cloudflared: the file appears, the write finishes a moment later, then it exits.
		writeFileSync(
			fake,
			`#!${process.execPath}\nconst fs = require("node:fs");\nconsole.error("Please open: https://dash.cloudflare.com/argotunnel?aud=1");\nsetTimeout(() => { fs.mkdirSync(${JSON.stringify(home)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(cert)}, "part"); }, 300);\nsetTimeout(() => { fs.appendFileSync(${JSON.stringify(cert)}, "-whole"); process.exit(0); }, 1500);\n`,
		);
		chmodSync(fake, 0o755);
		const result = await cloudflareLoginForPanel(fake, () => {}, 20_000, 100);
		assert.deepEqual(result, { ok: true });
		// The test reads its own fake file; the code under test never does.
		assert.equal(readFileSync(cert, "utf8"), "part-whole");
	});
});

test("cloudflareLoginForPanel gives up when no certificate appears", async () => {
	await inConfig("loginfail", async (dir) => {
		const fake = join(dir, "fake-cloudflared");
		writeFileSync(fake, `#!${process.execPath}\nconsole.log("nothing");\n`);
		chmodSync(fake, 0o755);
		const result = await cloudflareLoginForPanel(fake, () => {}, 5_000, 50);
		assert.equal(result.ok, false);
	});
});

/** Hooks that record calls; each can be changed per test. */
function hooks(over = {}) {
	const calls = [];
	return {
		calls,
		cloudflared: async () => (calls.push("cloudflared"), { ok: true, path: "/fake/cloudflared", downloaded: false }),
		signedIn: () => false,
		login: async (_bin, onUrl) => (calls.push("login"), onUrl("https://dash.cloudflare.com/argotunnel?aud=1"), { ok: true }),
		setup: async (options) => void calls.push(`setup ${options.cloudflare} service=${options.service} passcode=${options.passcode} replaceFunnel=${options.replaceFunnel}`),
		check: async () => (calls.push("check"), { ok: true, detail: "ok" }),
		...over,
	};
}

test("setupTunnel runs the five steps in order and reports the sign-in address", async () => {
	await inConfig("flow", async () => {
		const h = hooks();
		const seen = [];
		const done = await setupTunnel("polycarp.example.com", (p) => seen.push(p), h, { checkTotalMs: 100, checkEveryMs: 10 });
		assert.deepEqual(done, { publicUrl: "https://polycarp.example.com" });
		assert.deepEqual(h.calls, ["cloudflared", "login", "setup polycarp.example.com service=true passcode=false replaceFunnel=false", "check"]);
		assert.deepEqual(seen.filter((p) => p.state === "done").map((p) => p.step), ["cloudflared", "signin", "route", "tunnel", "check"]);
		assert.ok(seen.some((p) => p.step === "signin" && p.state === "waiting" && p.url === "https://dash.cloudflare.com/argotunnel?aud=1"));
	});
});

test("setupTunnel skips the sign-in when already signed in, and asks setup to replace Funnel when the route is Funnel", async () => {
	await inConfig("funnel", async (dir) => {
		mkdirSync(process.env.TABKYRA_CONFIG_DIR, { recursive: true });
		writeFileSync(join(process.env.TABKYRA_CONFIG_DIR, "remote.json"), JSON.stringify({ publicUrl: "https://mac.tail.ts.net:8443", port: 8787, route: "funnel" }));
		const h = hooks({ signedIn: () => true });
		await setupTunnel("polycarp.example.com", () => {}, h, { checkTotalMs: 100, checkEveryMs: 10 });
		// Funnel is closed inside setup, after the tunnel is made; the flow itself never touches it.
		assert.deepEqual(h.calls, ["cloudflared", "setup polycarp.example.com service=true passcode=false replaceFunnel=true", "check"]);
	});
});

test("setupTunnel runs setup again for the same Cloudflare name, refuses another name before setup, and refuses a custom route first", async () => {
	await inConfig("same", async () => {
		mkdirSync(process.env.TABKYRA_CONFIG_DIR, { recursive: true });
		const file = join(process.env.TABKYRA_CONFIG_DIR, "remote.json");
		writeFileSync(file, JSON.stringify({ publicUrl: "https://polycarp.example.com", port: 8787, route: "cloudflare" }));
		const h = hooks({ signedIn: () => true });
		await setupTunnel("polycarp.example.com", () => {}, h, { checkTotalMs: 100, checkEveryMs: 10 });
		// A rerun resumes a half-finished setup, so setup runs again.
		assert.deepEqual(h.calls, ["cloudflared", "setup polycarp.example.com service=true passcode=false replaceFunnel=false", "check"]);
		const other = hooks({ signedIn: () => true });
		const seen = [];
		await assert.rejects(setupTunnel("other.example.com", (p) => seen.push(p), other), /already has a Cloudflare tunnel on https:\/\/polycarp\.example\.com/);
		assert.equal(other.calls.some((c) => c.startsWith("setup")), false, "refused in the route step, before setup");
		assert.equal(seen.find((p) => p.state === "failed").step, "route");
		writeFileSync(file, JSON.stringify({ publicUrl: "https://front.example.com", port: 8787, route: "custom" }));
		const none = hooks();
		await assert.rejects(setupTunnel("polycarp.example.com", () => {}, none), TunnelError);
		assert.deepEqual(none.calls, [], "nothing is downloaded or opened before the refusal");
	});
});

test("a failing step reports failed with its text and stops the steps after it", async () => {
	await inConfig("fail", async () => {
		const h = hooks({
			signedIn: () => true,
			setup: async () => {
				throw new Error("Cloudflare wouldn't give this tunnel polycarp.example.com.");
			},
		});
		const seen = [];
		await assert.rejects(setupTunnel("polycarp.example.com", (p) => seen.push(p), h), /wouldn't give this tunnel/);
		const failed = seen.find((p) => p.state === "failed");
		assert.equal(failed.step, "tunnel");
		assert.match(failed.detail, /wouldn't give/);
		assert.equal(h.calls.includes("check"), false);
	});
});

test("the check retries while DNS settles, then fails with a reason", async () => {
	await inConfig("retry", async () => {
		let n = 0;
		const h = hooks({ signedIn: () => true, check: async () => (++n < 3 ? { ok: false, detail: "no answer" } : { ok: true, detail: "ok" }) });
		await setupTunnel("polycarp.example.com", () => {}, h, { checkTotalMs: 5_000, checkEveryMs: 5 });
		assert.equal(n, 3);
		const never = hooks({ signedIn: () => true, check: async () => ({ ok: false, detail: "no answer" }) });
		await assert.rejects(setupTunnel("polycarp.example.com", () => {}, never, { checkTotalMs: 50, checkEveryMs: 10 }), /isn't answering yet/);
	});
});
