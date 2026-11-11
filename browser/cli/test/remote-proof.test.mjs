// `remote test`: the outside proof. A fake public HTTPS server (its own throwaway certificate, trusted only by the child through
// NODE_EXTRA_CA_CERTS) stands in for the internet side, and a fake DNS-over-HTTPS server says where the public name points.
// Nothing here touches a real Tailscale, cloudflared, service manager or ~/.config/tabkyra.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
// Lets the fake public server on 127.0.0.1 count as public. Only these tests load it; the CLI never reads an environment variable for it.
const HOOKS = join(here, "helpers", "remote-test-hooks.mjs");
const root = mkdtempSync(join(tmpdir(), "tabkyra-remote-proof-"));
const HOST = "polycarp.example.com";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

// One certificate for HOST, made now, trusted by the CLI under test and nothing else.
const certDir = join(root, "cert");
mkdirSync(certDir);
const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`, "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { encoding: "utf8" });
assert.equal(made.status, 0, made.stderr);
const CERT = readFileSync(join(certDir, "cert.pem"));
const KEY = readFileSync(join(certDir, "key.pem"));

/**
 * The public side. stream: "now" answers an authenticated initialize as SSE at once; "held" holds the first bytes 10 seconds, the
 * way a buffering proxy does. Records the Host and SNI of every request and the bearer tokens it saw.
 */
async function fakePublic({ stream = "now", onAuthed, authMeta = "full" } = {}) {
	const seen = { hosts: [], sni: [], tokens: [], authed: 0 };
	let publicUrl = "";
	const timers = new Set();
	const srv = createHttpsServer({ cert: CERT, key: KEY }, (req, res) => {
		seen.hosts.push(req.headers.host);
		seen.sni.push(req.socket.servername);
		const json = (status, body, headers = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(JSON.stringify(body));
		};
		if (req.method === "GET" && req.url === METADATA_PATH) return json(200, { resource: `${publicUrl}/mcp`, authorization_servers: [publicUrl] });
		if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
			const full = { issuer: publicUrl, authorization_endpoint: `${publicUrl}/authorize`, token_endpoint: `${publicUrl}/token`, registration_endpoint: `${publicUrl}/register` };
			// "partial": the issuer alone, nowhere to sign in. "elsewhere": the token endpoint on another origin.
			return json(200, authMeta === "partial" ? { issuer: publicUrl } : authMeta === "elsewhere" ? { ...full, token_endpoint: "https://other.example/token" } : full);
		}
		if (req.url === "/mcp") {
			const auth = req.headers.authorization ?? "";
			if (!auth.startsWith("Bearer ")) return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${publicUrl}${METADATA_PATH}"` });
			seen.tokens.push(auth.slice(7));
			if (req.method === "DELETE") return json(200, {});
			seen.authed++;
			onAuthed?.();
			req.resume();
			if (stream === "trickle") {
				// A proxy that dribbles its response headers, one line a second for 6 seconds (so the socket is never idle), then sends
				// the end of the headers and the first event together. Raw bytes on the socket: Node's own writer can't trickle headers.
				const sock = req.socket;
				sock.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n");
				let n = 0;
				const t = setInterval(() => {
					if (++n < 6) return sock.write(`x-pad-${n}: ${n}\r\n`);
					clearInterval(t);
					sock.end(`connection: close\r\n\r\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`);
				}, 1000);
				timers.add(t);
				sock.on("close", () => clearInterval(t));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
			const send = () => res.end(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`);
			if (stream === "now") send();
			else {
				res.flushHeaders();
				const t = setTimeout(send, 10_000);
				timers.add(t);
				res.on("close", () => clearTimeout(t));
			}
			return;
		}
		json(404, {});
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	publicUrl = `https://${HOST}:${srv.address().port}`;
	return {
		publicUrl,
		seen,
		close: () =>
			new Promise((resolve) => {
				for (const t of timers) {
					clearTimeout(t);
					clearInterval(t);
				}
				srv.closeAllConnections();
				srv.close(resolve);
			}),
	};
}

/** Public DNS as DoH JSON: HOST points at `address`, nothing else resolves. */
async function fakeDoh(address = "127.0.0.1") {
	const asked = [];
	const srv = createHttpServer((req, res) => {
		const q = new URL(req.url, "http://x").searchParams;
		asked.push(`${q.get("type")} ${q.get("name")}`);
		res.setHeader("content-type", "application/dns-json");
		res.end(JSON.stringify({ Status: 0, Answer: q.get("type") === "A" && q.get("name") === HOST ? [{ name: `${HOST}.`, type: 1, data: address }] : [] }));
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${srv.address().port}/dns-query`, asked, close: () => new Promise((resolve) => srv.close(resolve)) };
}

/** A temp HOME and config dir with remote.json on the custom route, and one existing token so tokens.json has something to keep. */
function machine(name, publicUrl, doh) {
	const dir = join(root, name);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	symlinkSync(process.execPath, join(bin, "node"));
	const env = {
		HOME: home,
		TABKYRA_CONFIG_DIR: join(home, "cfg"),
		NO_COLOR: "1",
		PATH: bin,
		TABKYRA_APPLICATIONS_DIR: join(dir, "apps"),
		TABKYRA_DOH_URL: doh,
		NODE_EXTRA_CA_CERTS: join(certDir, "cert.pem"),
	};
	const run = (args, extra = {}) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, ["--import", HOOKS, cli, ...args], { env: { ...env, ...extra } });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, json: () => JSON.parse(stdout) }));
		});
	const spawnRaw = (args) => spawn(process.execPath, ["--import", HOOKS, cli, ...args], { env });
	mkdirSync(env.TABKYRA_CONFIG_DIR, { recursive: true });
	if (publicUrl) writeFileSync(join(env.TABKYRA_CONFIG_DIR, "remote.json"), JSON.stringify({ publicUrl, port: 8799, route: "custom" }));
	const made = spawnSync(process.execPath, [cli, "token", "create", "kept", "--scope", "skills.read"], { env, encoding: "utf8" });
	assert.equal(made.status, 0, made.stdout + made.stderr);
	const tokensFile = join(env.TABKYRA_CONFIG_DIR, "tokens.json");
	return { env, run, spawnRaw, tokens: () => (existsSync(tokensFile) ? readFileSync(tokensFile, "utf8") : "") };
}

const byName = (report, name) => report.checks.find((c) => c.name === name);

test("remote test passes against a public server that streams at once, connects to the DoH address with the right SNI and Host, and leaves the token list as it was", async () => {
	const pub = await fakePublic({ stream: "now" });
	const doh = await fakeDoh();
	try {
		const m = machine("pass", pub.publicUrl, doh.url);
		const before = m.tokens();
		const r = await m.run(["remote", "test", "--json"]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const report = r.json();
		assert.equal(report.ok, true);
		assert.equal(report.state, "on");
		assert.deepEqual(
			report.checks.map((c) => `${c.name} ${c.status}`),
			["dns ok", "tls ok", "resource_metadata ok", "auth_metadata ok", "auth_challenge ok", "streaming ok"],
		);
		// The address public DNS gave is the one connected to: the fake lives only there, and every request named HOST.
		assert.ok(doh.asked.includes(`A ${HOST}`), doh.asked.join("\n"));
		assert.ok(pub.seen.hosts.length >= 4);
		assert.ok(pub.seen.hosts.every((h) => h === `${HOST}:${new URL(pub.publicUrl).port}`), pub.seen.hosts.join(", "));
		assert.ok(pub.seen.sni.every((s) => s === HOST), pub.seen.sni.join(", "));
		assert.equal(pub.seen.authed, 1, "one authenticated probe");
		// The probe's token: seen by the server, never printed, gone afterwards.
		assert.equal(new Set(pub.seen.tokens).size, 1);
		const [probe] = pub.seen.tokens;
		assert.ok(!r.stdout.includes(probe) && !r.stderr.includes(probe), "the probe token is never printed");
		assert.equal(m.tokens(), before, "tokens.json is byte for byte what it was");
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("the address actually connected to is DoH's, not this computer's resolver's", async () => {
	const pub = await fakePublic();
	const doh = await fakeDoh();
	try {
		const m = machine("doh-wins", pub.publicUrl, doh.url);
		// The fake listens on 127.0.0.1. DoH says HOST is at a documentation address, so nothing may reach the fake.
		const elsewhere = await fakeDoh("203.0.113.9");
		try {
			const r = await m.run(["remote", "test", "--json"], { TABKYRA_DOH_URL: elsewhere.url });
			assert.equal(r.code, 1, r.stdout);
			assert.equal(byName(r.json(), "dns").status, "ok");
			assert.match(byName(r.json(), "dns").detail, /203\.0\.113\.9/);
			assert.equal(byName(r.json(), "tls").status, "fail");
			assert.equal(pub.seen.hosts.length, 0, "the fake on 127.0.0.1 was never reached");
		} finally {
			await elsewhere.close();
		}
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("a public server that holds the stream's first bytes 10 seconds fails streaming, says what to do, and leaves the token list as it was", async () => {
	const pub = await fakePublic({ stream: "held" });
	const doh = await fakeDoh();
	try {
		const m = machine("held", pub.publicUrl, doh.url);
		const before = m.tokens();
		const started = Date.now();
		const r = await m.run(["remote", "test", "--json"]);
		assert.ok(Date.now() - started < 9000, "the probe gives up at its 5-second limit, not when the server lets go");
		assert.equal(r.code, 1, r.stdout + r.stderr);
		const report = r.json();
		assert.equal(report.ok, false);
		assert.equal(report.state, "problem");
		assert.equal(report.code, "streaming");
		const streaming = byName(report, "streaming");
		assert.equal(streaming.status, "fail");
		assert.match(streaming.detail, /5 seconds/);
		assert.match(streaming.next, /buffering/);
		for (const name of ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge"]) assert.equal(byName(report, name).status, "ok", name);
		assert.ok(!JSON.stringify(report).includes(pub.seen.tokens[0]), "the token is not in the report");
		assert.equal(m.tokens(), before);
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("a proxy that trickles its headers past 5 seconds and then sends the first event at once fails streaming", async () => {
	const pub = await fakePublic({ stream: "trickle" });
	const doh = await fakeDoh();
	try {
		const m = machine("trickle", pub.publicUrl, doh.url);
		const before = m.tokens();
		const started = Date.now();
		const r = await m.run(["remote", "test", "--json"]);
		assert.ok(Date.now() - started < 9000, "the probe gives up at its 5-second deadline");
		assert.equal(r.code, 1, r.stdout + r.stderr);
		const streaming = byName(r.json(), "streaming");
		assert.equal(streaming.status, "fail", r.stdout);
		assert.match(streaming.detail, /5 seconds/);
		assert.equal(m.tokens(), before);
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("authorization metadata with only an issuer, or a token endpoint on another origin, fails auth_metadata", async () => {
	for (const [authMeta, missing] of [
		["partial", /authorization_endpoint.*token_endpoint/],
		["elsewhere", /token_endpoint https:\/\/other\.example\/token/],
	]) {
		const pub = await fakePublic({ authMeta });
		const doh = await fakeDoh();
		try {
			const m = machine(`as-${authMeta}`, pub.publicUrl, doh.url);
			const r = await m.run(["remote", "test", "--json"]);
			assert.equal(r.code, 1, r.stdout + r.stderr);
			const check = byName(r.json(), "auth_metadata");
			assert.equal(check.status, "fail", r.stdout);
			assert.match(check.detail, missing);
			assert.match(check.next, /remote fix/);
		} finally {
			await pub.close();
			await doh.close();
		}
	}
});

test("a probe that throws after its token was made still removes the token", async () => {
	const pub = await fakePublic();
	const doh = await fakeDoh();
	try {
		const m = machine("throw", pub.publicUrl, doh.url);
		const before = m.tokens();
		const r = await m.run(["remote", "test", "--json"], { REMOTE_HOOK_THROW: "1" });
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.equal(byName(r.json(), "streaming").status, "fail");
		assert.match(byName(r.json(), "streaming").detail, /didn't run/);
		assert.equal(m.tokens(), before);
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("a probe token that can't be deleted fails the run, names the token but never its secret, and expires on its own", async () => {
	let tokensFile = "";
	// While the probe is in flight, tokens.json becomes a directory, so deleting the token fails.
	const pub = await fakePublic({
		onAuthed: () => {
			renameSync(tokensFile, `${tokensFile}.held`);
			mkdirSync(tokensFile);
		},
	});
	const doh = await fakeDoh();
	try {
		const m = machine("cleanup-fails", pub.publicUrl, doh.url);
		tokensFile = join(m.env.TABKYRA_CONFIG_DIR, "tokens.json");
		const r = await m.run(["remote", "test", "--json"]);
		rmdirSync(tokensFile);
		renameSync(`${tokensFile}.held`, tokensFile);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		const report = r.json();
		assert.equal(report.ok, false);
		assert.equal(byName(report, "streaming").status, "ok", "the probe itself passed");
		const cleanup = byName(report, "probe_cleanup");
		assert.equal(cleanup?.status, "fail", r.stdout);
		const probe = JSON.parse(m.tokens()).tokens.find((t) => t.name.startsWith("remote-test-"));
		assert.ok(probe, "the record is still there");
		assert.match(cleanup.detail, new RegExp(`${probe.id}.*stops working on its own at ${probe.expiresAt.replaceAll(".", "\\.")}`));
		assert.match(cleanup.next, new RegExp(`token revoke ${probe.id}$`));
		assert.equal(Date.parse(probe.expiresAt) - Date.parse(probe.createdAt), 2 * 60_000, "a two-minute hard expiry");
		const [secret] = pub.seen.tokens;
		assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), "the secret is never printed");
		const text = await m.run(["remote", "test"]);
		assert.ok(!text.stdout.includes(secret) && !text.stderr.includes(secret));
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("Ctrl-C while the probe waits removes the token before exiting", async () => {
	const pub = await fakePublic({ stream: "held" });
	const doh = await fakeDoh();
	try {
		const m = machine("sigint", pub.publicUrl, doh.url);
		const before = m.tokens();
		const child = m.spawnRaw(["remote", "test", "--json"]);
		const deadline = Date.now() + 10_000;
		while (pub.seen.authed === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		assert.equal(pub.seen.authed, 1, "the probe reached the server");
		assert.notEqual(m.tokens(), before, "the token exists while the probe waits");
		const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
		child.kill("SIGINT");
		assert.equal(await exited, 130);
		assert.equal(m.tokens(), before);
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("remote test with nothing set up exits 3 and says to run remote setup", async () => {
	const doh = await fakeDoh();
	try {
		const m = machine("not-set-up", undefined, doh.url);
		const r = await m.run(["remote", "test", "--json"]);
		assert.equal(r.code, 3, r.stdout + r.stderr);
		assert.equal(r.json().code, "not_set_up");
		assert.equal(r.json().next.kind, "run_command");
		assert.match(r.json().next.command, /remote setup$/);
		const text = await m.run(["remote", "test"]);
		assert.equal(text.code, 3);
		assert.match(text.stderr, /remote setup/);
	} finally {
		await doh.close();
	}
});

test("remote test text mode prints one line per check and the next action on a failure", async () => {
	const pub = await fakePublic({ stream: "held" });
	const doh = await fakeDoh();
	try {
		const m = machine("text", pub.publicUrl, doh.url);
		const r = await m.run(["remote", "test"]);
		assert.equal(r.code, 1);
		for (const name of ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming"]) assert.match(r.stdout, new RegExp(name), name);
		assert.match(r.stdout, /buffering/);
		assert.ok(!r.stdout.includes(pub.seen.tokens[0]));
	} finally {
		await pub.close();
		await doh.close();
	}
});

test("a name public DNS only knows as a tailnet address fails dns and says remote fix", async () => {
	const doh = await fakeDoh("100.101.102.103");
	try {
		const m = machine("tailnet-only", `https://${HOST}:8443`, doh.url);
		const r = await m.run(["remote", "test", "--json"]);
		assert.equal(r.code, 1);
		const dns = byName(r.json(), "dns");
		assert.equal(dns.status, "fail");
		assert.match(dns.next, /remote fix/);
		assert.equal(r.json().checks.length, 1, "nothing past dns runs without a public address");
	} finally {
		await doh.close();
	}
});

/** The local side of serve, as setup checks it on 127.0.0.1: the resource metadata for `publicUrl`. */
async function localServe(publicUrl) {
	const srv = createHttpServer((req, res) => {
		if (req.url !== METADATA_PATH) {
			res.statusCode = 404;
			return res.end("not here");
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ resource: `${publicUrl}/mcp`, authorization_servers: [publicUrl] }));
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	return { port: srv.address().port, close: () => new Promise((resolve) => srv.close(resolve)) };
}

test("remote setup ends with the outside proof: a connector that answers but holds the stream fails setup; one that streams is on", async () => {
	for (const stream of ["held", "now"]) {
		const pub = await fakePublic({ stream });
		const doh = await fakeDoh();
		const local = await localServe(pub.publicUrl);
		try {
			const m = machine(`setup-${stream}`, undefined, doh.url);
			const before = m.tokens();
			const r = await m.run(["remote", "setup", "--json", "--no-service", "--public-url", pub.publicUrl, "--port", String(local.port)]);
			const report = r.json();
			assert.ok(Array.isArray(report.checks), r.stdout);
			assert.equal(byName(report, "streaming")?.status, stream === "now" ? "ok" : "fail", r.stdout);
			if (stream === "held") {
				assert.equal(r.code, 1, r.stdout);
				assert.equal(report.ok, false);
				assert.equal(report.state, "problem");
				assert.equal(report.code, "streaming");
				assert.ok(existsSync(join(m.env.TABKYRA_CONFIG_DIR, "remote.json")), "remote.json is kept");
			} else {
				assert.equal(r.code, 0, r.stdout);
				assert.equal(report.state, "on");
			}
			assert.ok(!r.stdout.includes(pub.seen.tokens[0]));
			const after = JSON.parse(m.tokens()).tokens.map((t) => t.name);
			assert.deepEqual(after, JSON.parse(before).tokens.map((t) => t.name), "only the kept token remains");
		} finally {
			await pub.close();
			await doh.close();
			await local.close();
		}
	}
});

test("the old environment seams do nothing: without the preloaded test hooks, loopback is not public and the probe doesn't throw", async () => {
	const doh = await fakeDoh("127.0.0.1");
	try {
		const m = machine("no-env-seam", `https://${HOST}:8443`, doh.url);
		const child = spawn(process.execPath, [cli, "remote", "test", "--json"], { env: { ...m.env, TABKYRA_REMOTE_TEST_LOOPBACK: "1", TABKYRA_REMOTE_TEST_THROW: "1" } });
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d));
		const code = await new Promise((resolve) => child.on("close", resolve));
		assert.equal(code, 1, stdout);
		const report = JSON.parse(stdout);
		assert.equal(byName(report, "dns").status, "fail");
		assert.match(byName(report, "dns").detail, /127\.0\.0\.1, not a public address/);
		assert.equal(report.checks.length, 1);
	} finally {
		await doh.close();
	}
});
