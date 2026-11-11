// `remote fix`: one repair per fault, in order, then the outside proof. Stub tailscale, launchctl and systemctl in a temp HOME;
// the stub service manager starts a fake serve on bootstrap, and a fake public server on 127.0.0.1:8443 (its own throwaway
// certificate, trusted only by the child) stands in for the internet side. Nothing here touches a real Tailscale, service
// manager, cloudflared or ~/.config/tabkyra.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeTailscaleStub } from "./helpers/tailscale-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
// Lets the fake public server on 127.0.0.1 count as public. Only these tests load it; the CLI never reads an environment variable for it.
const HOOKS = join(here, "helpers", "remote-test-hooks.mjs");
const root = mkdtempSync(join(tmpdir(), "tabkyra-remote-fix-"));
const DNS = "mac.example.ts.net";
const RENAMED = "studio.example.ts.net";
const CF_HOST = "polycarp.example.com";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const serviceTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;

const certDir = join(root, "cert");
mkdirSync(certDir);
const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", `/CN=${DNS}`, "-addext", `subjectAltName=DNS:${DNS},DNS:${RENAMED}`, "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { encoding: "utf8" });
assert.equal(made.status, 0, made.stderr);

// The fake serve the stub service manager starts: it reads remote.json once at start, like the real one.
const fakeServe = join(root, "fake-serve.mjs");
writeFileSync(
	fakeServe,
	`import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const [port, remote] = process.argv.slice(2);
const { publicUrl } = JSON.parse(readFileSync(remote, "utf8"));
createServer((req, res) => {
	if (req.url !== "${METADATA_PATH}") { res.statusCode = 404; return res.end(); }
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ resource: publicUrl + "/mcp", authorization_servers: [publicUrl] }));
}).listen(Number(port), "127.0.0.1");
`,
);

const freePort = () =>
	new Promise((resolve) => {
		const srv = createNetServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});

/** The internet side on 127.0.0.1:8443: it answers for whatever remote.json names now, and streams at once. */
async function fakePublic(remoteFile) {
	const srv = createHttpsServer({ cert: readFileSync(join(certDir, "cert.pem")), key: readFileSync(join(certDir, "key.pem")) }, (req, res) => {
		const publicUrl = JSON.parse(readFileSync(remoteFile, "utf8")).publicUrl;
		const json = (status, body, headers = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(JSON.stringify(body));
		};
		if (req.url === METADATA_PATH) return json(200, { resource: `${publicUrl}/mcp`, authorization_servers: [publicUrl] });
		if (req.url === "/.well-known/oauth-authorization-server") return json(200, { issuer: publicUrl });
		if (req.url === "/mcp" && !req.headers.authorization) return json(401, {}, { "www-authenticate": `Bearer resource_metadata="${publicUrl}${METADATA_PATH}"` });
		if (req.url === "/mcp" && req.method === "DELETE") return json(200, {});
		if (req.url === "/mcp") {
			req.resume();
			res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
			return res.end(`data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`);
		}
		json(404, {});
	});
	const listening = await new Promise((resolve) => {
		srv.once("error", () => resolve(false));
		srv.listen(8443, "127.0.0.1", () => resolve(true));
	});
	return { listening, close: () => new Promise((resolve) => (listening ? (srv.closeAllConnections(), srv.close(resolve)) : resolve())) };
}

async function fakeDoh() {
	const srv = createHttpServer((req, res) => {
		const q = new URL(req.url, "http://x").searchParams;
		res.setHeader("content-type", "application/dns-json");
		const name = q.get("name");
		res.end(JSON.stringify({ Status: 0, Answer: q.get("type") === "A" && (name === DNS || name === RENAMED) ? [{ name: `${name}.`, type: 1, data: "127.0.0.1" }] : [] }));
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${srv.address().port}/dns-query`, close: () => new Promise((resolve) => srv.close(resolve)) };
}

/**
 * A machine on the Funnel route with the serve service installed. serve: "down" (not running) or "up" (running with remote.json as
 * it is now). funnel: whether Funnel is open for the stub's name. dns: the name Tailscale gives this computer now.
 */
async function machine(name, { serve = "down", funnel = false, dns = DNS, recorded = DNS, doh, route = "funnel" } = {}) {
	const dir = join(root, name);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	const cfg = join(home, "cfg");
	const log = join(dir, "calls.log");
	mkdirSync(bin, { recursive: true });
	mkdirSync(cfg, { recursive: true });
	symlinkSync(process.execPath, join(bin, "node"));
	const port = await freePort();
	const remote = join(cfg, "remote.json");
	writeFileSync(remote, JSON.stringify(route === "cloudflare" ? { publicUrl: `https://${CF_HOST}`, port, route } : { publicUrl: `https://${recorded}:8443`, port, route }));
	const cfRunning = join(dir, "cloudflared.running");
	if (route === "cloudflare") {
		// What an earlier Cloudflare setup leaves: cloudflared, the tunnel's settings and its service file.
		writeFileSync(join(bin, "cloudflared"), `#!/bin/sh\necho "cloudflared $*" >> ${log}\n`);
		chmodSync(join(bin, "cloudflared"), 0o755);
		writeFileSync(join(cfg, "cloudflared.yml"), `tunnel: x\ningress:\n  - hostname: ${CF_HOST}\n    service: http://127.0.0.1:${port}\n  - service: http_status:404\n`);
		const cfFile = process.platform === "darwin" ? join(home, "Library", "LaunchAgents", "com.polycarp.cloudflared.plist") : join(home, ".config", "systemd", "user", "polycarp-cloudflared.service");
		mkdirSync(dirname(cfFile), { recursive: true });
		writeFileSync(cfFile, "left by an earlier setup\n");
	}
	// The launcher the service runs, and the service file an earlier setup left.
	writeFileSync(join(cfg, "polycarp"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
	chmodSync(join(cfg, "polycarp"), 0o755);
	const serviceFile = process.platform === "darwin" ? join(home, "Library", "LaunchAgents", "com.polycarp.serve.plist") : join(home, ".config", "systemd", "user", "polycarp-serve.service");
	mkdirSync(dirname(serviceFile), { recursive: true });
	writeFileSync(serviceFile, "left by an earlier setup\n");
	const serveStatus = JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { [`${dns}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });
	writeTailscaleStub(join(bin, "tailscale"), { dir, log, dns, serveStatus });
	if (funnel) writeFileSync(join(dir, "funnel-on"), "on\n");
	const pidFile = join(dir, "serve.pid");
	const start = `"${process.execPath}" ${fakeServe} ${port} ${remote} >/dev/null 2>&1 & echo $! > ${pidFile}`;
	const stop = `if [ -f ${pidFile} ]; then read p < ${pidFile}; kill $p; /bin/rm -f ${pidFile}; fi`;
	const script = (file, body) => {
		writeFileSync(join(bin, file), `#!/bin/sh\necho "${file} $*" >> ${log}\n${body}`);
		chmodSync(join(bin, file), 0o755);
	};
	script(
		"launchctl",
		`case "$1" in\nprint) case "$2" in *com.polycarp.serve) if [ -f ${pidFile} ]; then echo "state = running"; exit 0; fi ;; *com.polycarp.cloudflared) if [ -f ${cfRunning} ]; then echo "state = running"; exit 0; fi ;; esac; exit 1 ;;\nbootout) case "$2" in *com.polycarp.serve) ${stop} ;; *com.polycarp.cloudflared) /bin/rm -f ${cfRunning} ;; esac ;;\nbootstrap) case "$3" in *com.polycarp.serve.plist) ${start} ;; *com.polycarp.cloudflared.plist) : > ${cfRunning} ;; esac ;;\nesac\n`,
	);
	script(
		"systemctl",
		`case "$2" in\nis-active) if { [ "$3" = polycarp-serve.service ] && [ -f ${pidFile} ]; } || { [ "$3" = polycarp-cloudflared.service ] && [ -f ${cfRunning} ]; }; then echo active; else echo inactive; exit 3; fi ;;\nrestart) if [ "$3" = polycarp-serve.service ]; then ${stop}; ${start}; else : > ${cfRunning}; fi ;;\ndisable) if [ "$4" = polycarp-serve.service ]; then ${stop}; else /bin/rm -f ${cfRunning}; fi ;;\nesac\n`,
	);
	script("loginctl", `echo "Linger=yes"\n`);
	const env = {
		HOME: home,
		TABKYRA_CONFIG_DIR: cfg,
		TABKYRA_SOCKET_DIR: join(dir, "sock"),
		NO_COLOR: "1",
		PATH: bin,
		TABKYRA_APPLICATIONS_DIR: join(dir, "apps"),
		TABKYRA_DOH_URL: doh ?? "http://127.0.0.1:9/dns-query",
		TABKYRA_SERVE_WAIT_MS: "8000",
		NODE_EXTRA_CA_CERTS: join(certDir, "cert.pem"),
	};
	if (serve === "up") {
		spawnSync("/bin/sh", ["-c", start]);
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const r = spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}${METADATA_PATH}").then(()=>process.exit(0),()=>process.exit(1))`]);
			if (r.status === 0) break;
		}
	}
	const run = (args, { input, extra = {} } = {}) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, ["--import", HOOKS, cli, ...args], { env: { ...env, ...extra } });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
			if (input !== undefined) child.stdin.end(input);
			else child.stdin.end();
		});
	return {
		env,
		dir,
		port,
		remote,
		run,
		remoteJson: () => readFileSync(remote, "utf8"),
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		funnelOpen: () => existsSync(join(dir, "funnel-on")),
		serveRunning: () => existsSync(pidFile),
		cleanup: () => {
			if (existsSync(pidFile)) {
				try {
					process.kill(Number(readFileSync(pidFile, "utf8").trim()));
				} catch {
					/* already gone */
				}
				rmSync(pidFile, { force: true });
			}
		},
	};
}

/** Changes a run made: service starts and stops, Funnel calls, remote.json writes. */
const changes = (m) => m.calls().filter((x) => /^(launchctl (bootstrap|bootout)|systemctl --user (restart|enable|disable)|tailscale funnel)/.test(x));
const never = (m) => {
	for (const call of m.calls()) {
		assert.ok(!/sudo|tailscale lock (?!status)|funnel --https=8443 off|route dns|token revoke|tailscale (up|down|logout)/.test(call), call);
	}
};

serviceTest("remote fix --dry-run with serve down and Funnel closed lists both repairs in order and changes nothing", async () => {
	const m = await machine("dry-run");
	try {
		const before = m.remoteJson();
		const r = await m.run(["remote", "fix", "--dry-run", "--json"]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const report = r.json();
		assert.deepEqual(
			report.actions.map((a) => `${a.kind} ${a.status}`),
			["restart_serve planned", "open_funnel planned"],
		);
		assert.deepEqual(changes(m), [], m.calls().join("\n"));
		assert.equal(m.remoteJson(), before);
		assert.equal(m.funnelOpen(), false);
		assert.equal(m.serveRunning(), false);
		const text = await m.run(["remote", "fix", "--dry-run"]);
		assert.equal(text.code, 0);
		assert.match(text.stdout, /1\. Restart .* serve's service[\s\S]*2\. Open Tailscale Funnel/);
		assert.deepEqual(changes(m), []);
	} finally {
		m.cleanup();
	}
});

serviceTest("remote fix with no terminal and no --yes changes nothing and exits 3 with the list", async () => {
	const m = await machine("no-tty");
	try {
		const before = m.remoteJson();
		const r = await m.run(["remote", "fix", "--json"]);
		assert.equal(r.code, 3, r.stdout + r.stderr);
		assert.equal(r.json().code, "fix_pending");
		assert.deepEqual(r.json().actions.map((a) => a.kind), ["restart_serve", "open_funnel"]);
		assert.match(r.json().next.command, /remote fix --yes$/);
		const text = await m.run(["remote", "fix"]);
		assert.equal(text.code, 3);
		assert.match(text.stdout, /nothing was changed/);
		assert.deepEqual(changes(m), []);
		assert.equal(m.remoteJson(), before);
	} finally {
		m.cleanup();
	}
});

serviceTest("remote fix --yes restarts serve, then opens Funnel, and ends ok from outside", async (t) => {
	const doh = await fakeDoh();
	const m = await machine("yes", { doh: doh.url });
	const pub = await fakePublic(m.remote);
	try {
		const r = await m.run(["remote", "fix", "--yes", "--json"]);
		const report = r.json();
		assert.deepEqual(
			report.actions.map((a) => `${a.kind} ${a.status}`),
			["restart_serve done", "open_funnel done"],
			r.stdout,
		);
		// In that order: the service started before Funnel was opened.
		const order = changes(m).filter((x) => /bootstrap|restart|funnel --bg/.test(x));
		assert.ok(/launchctl bootstrap|systemctl --user restart/.test(order[0]) && /tailscale funnel --bg/.test(order.at(-1)), order.join("\n"));
		assert.equal(m.serveRunning(), true);
		assert.equal(m.funnelOpen(), true);
		never(m);
		assert.ok(!report.oldUrl && !report.newUrl);
		if (!pub.listening) {
			t.diagnostic("127.0.0.1:8443 is taken on this machine, so the outside proof can't be stood up here");
			return;
		}
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.equal(report.ok, true);
		assert.equal(report.state, "on");
		assert.ok(report.checks.every((c) => c.status === "ok"), JSON.stringify(report.checks));
		// Nothing is left to do: a second run changes nothing.
		const again = await m.run(["remote", "fix", "--yes", "--json"]);
		assert.equal(again.code, 0);
		assert.deepEqual(again.json().actions, []);
	} finally {
		m.cleanup();
		await pub.close();
		await doh.close();
	}
});

serviceTest("a renamed computer: remote fix rewrites remote.json, restarts serve for the new name, and reports oldUrl and newUrl", async (t) => {
	const doh = await fakeDoh();
	const m = await machine("renamed", { serve: "up", funnel: true, dns: RENAMED, recorded: DNS, doh: doh.url });
	const pub = await fakePublic(m.remote);
	try {
		const r = await m.run(["remote", "fix", "--yes", "--json"]);
		const report = r.json();
		assert.deepEqual(report.actions.map((a) => `${a.kind} ${a.status}`), ["rename done", "restart_serve done"], r.stdout);
		assert.equal(report.oldUrl, `https://${DNS}:8443`);
		assert.equal(report.newUrl, `https://${RENAMED}:8443`);
		assert.equal(JSON.parse(m.remoteJson()).publicUrl, `https://${RENAMED}:8443`);
		assert.equal(JSON.parse(m.remoteJson()).port, m.port, "the port is kept");
		never(m);
		const text = await m.run(["remote", "fix", "--dry-run"]);
		assert.doesNotMatch(text.stdout, /rename/i, "done once, it isn't planned again");
		if (!pub.listening) {
			t.diagnostic("127.0.0.1:8443 is taken on this machine, so the outside proof can't be stood up here");
			return;
		}
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(report.message, /add the new URL in each assistant; the old one no longer works/);
	} finally {
		m.cleanup();
		await pub.close();
		await doh.close();
	}
});

serviceTest("a renamed computer in text mode prints the old URL, the new URL and what to do in each assistant", async () => {
	const m = await machine("renamed-text", { serve: "up", funnel: true, dns: RENAMED, recorded: DNS });
	try {
		const r = await m.run(["remote", "fix", "--yes"]);
		assert.match(r.stdout, new RegExp(`https://${DNS.replace(/\./g, "\\.")}:8443/mcp -> https://${RENAMED.replace(/\./g, "\\.")}:8443/mcp`));
		assert.match(r.stdout, /Add the new URL in each assistant; the old one no longer works\./);
	} finally {
		m.cleanup();
	}
});

serviceTest("in a terminal, remote fix asks before each repair; a no stops there and changes nothing after it", async () => {
	const m = await machine("ask");
	try {
		const before = m.remoteJson();
		const no = await m.run(["remote", "fix"], { input: "n\n", extra: { TABKYRA_ASSUME_TTY: "1" } });
		assert.equal(no.code, 3, no.stdout + no.stderr);
		assert.match(no.stdout, /Restart .* serve's service.*\? \[y\/N\]/);
		assert.match(no.stdout, /you said no/);
		assert.deepEqual(changes(m), []);
		assert.equal(m.remoteJson(), before);
		const yes = await m.run(["remote", "fix"], { input: "y\ny\n", extra: { TABKYRA_ASSUME_TTY: "1" } });
		assert.match(yes.stdout, /Open Tailscale Funnel .*\? \[y\/N\]/);
		assert.equal(m.serveRunning(), true);
		assert.equal(m.funnelOpen(), true);
	} finally {
		m.cleanup();
	}
});

serviceTest("remote fix never makes a passcode: it names token passcode instead", async () => {
	const m = await machine("passcode", { serve: "up", funnel: true });
	try {
		const r = await m.run(["remote", "fix", "--yes", "--json"]);
		const advice = r.json().advice.find((a) => a.name === "passcode");
		assert.ok(advice, r.stdout);
		assert.match(advice.command, /token passcode$/);
		const status = spawnSync(process.execPath, [cli, "remote", "status", "--json"], { env: m.env, encoding: "utf8" });
		assert.equal(JSON.parse(status.stdout).passcodeSet, false, "still no passcode after fix");
		assert.ok(!/"passcode":/.test(r.stdout), "no passcode in the report");
		never(m);
	} finally {
		m.cleanup();
	}
});

test("remote fix with nothing set up exits 3 and says remote setup", async () => {
	const dir = join(root, "none");
	mkdirSync(join(dir, "bin"), { recursive: true });
	symlinkSync(process.execPath, join(dir, "bin", "node"));
	const env = { HOME: dir, TABKYRA_CONFIG_DIR: join(dir, "cfg"), PATH: join(dir, "bin"), NO_COLOR: "1", TABKYRA_APPLICATIONS_DIR: join(dir, "apps") };
	const r = spawnSync(process.execPath, [cli, "remote", "fix", "--json"], { env, encoding: "utf8" });
	assert.equal(r.status, 3, r.stdout + r.stderr);
	assert.equal(JSON.parse(r.stdout).code, "not_set_up");
	assert.match(JSON.parse(r.stdout).next.command, /remote setup$/);
});

serviceTest("Tailscale signed out: remote fix changes nothing and says what the person does", async () => {
	const m = await machine("signed-out");
	try {
		writeTailscaleStub(join(m.dir, "bin", "tailscale"), { dir: m.dir, log: join(m.dir, "calls.log"), dns: DNS, status: "{}" });
		const r = await m.run(["remote", "fix", "--yes", "--json"]);
		assert.equal(r.code, 3, r.stdout);
		assert.equal(r.json().state, "tailscale_signed_out");
		assert.deepEqual(changes(m), []);
		never(m);
	} finally {
		m.cleanup();
	}
});

serviceTest("the Cloudflare tunnel's service installed but not running: status says so, and remote fix starts it", async () => {
	const m = await machine("cf-stopped", { route: "cloudflare", serve: "up" });
	try {
		const status = spawnSync(process.execPath, [cli, "remote", "status", "--json"], { env: m.env, encoding: "utf8" });
		const line = JSON.parse(status.stdout).checks.find((c) => c.name === "cloudflare");
		assert.equal(line.status, "fail", status.stdout);
		assert.match(line.detail, /isn't running\. Run .* remote fix/);
		const dry = await m.run(["remote", "fix", "--dry-run", "--json"]);
		assert.deepEqual(dry.json().actions.map((a) => a.kind), ["restart_cloudflared"], dry.stdout);
		const r = await m.run(["remote", "fix", "--yes", "--json"]);
		assert.deepEqual(r.json().actions.map((a) => `${a.kind} ${a.status}`), ["restart_cloudflared done"], r.stdout);
		const after = spawnSync(process.execPath, [cli, "remote", "status", "--json"], { env: m.env, encoding: "utf8" });
		assert.equal(JSON.parse(after.stdout).checks.find((c) => c.name === "cloudflare").status, "ok", after.stdout);
		assert.ok(!m.calls().some((x) => /^cloudflared tunnel (route|delete|create)/.test(x)), "no DNS record or tunnel is touched");
		never(m);
	} finally {
		m.cleanup();
	}
});
