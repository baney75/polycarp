// Remote MCP (DC-2, DC-9): every request needs a scoped, revocable token; a session sees
// only the tools its scopes grant; there's no wildcard; the server binds loopback only; and
// the tunnel commands call the user's own tailscale and cloudflared with the right args.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-remote-"));
const env = { HOME: join(root, "home"), PATH: dirname(process.execPath), NO_COLOR: "1", TABKYRA_SOCKET_DIR: join(root, "sock") };
mkdirSync(env.HOME, { recursive: true });
mkdirSync(env.TABKYRA_SOCKET_DIR, { mode: 0o700 });
let server;
let url;

function cliRun(args, extraEnv = {}) {
	const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function token(name, scopes) {
	const r = cliRun(["token", "create", name, "--scope", scopes]);
	assert.equal(r.code, 0, r.out);
	return /tkr_[A-Za-z0-9_-]+/.exec(r.out)[0];
}

before(async () => {
	server = spawn(process.execPath, [cli, "serve", "--port", "0"], { env });
	url = await new Promise((resolve, reject) => {
		let out = "";
		server.stdout.on("data", (d) => {
			out += d;
			const m = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(out);
			if (m) resolve(m[0]);
		});
		server.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
		setTimeout(() => reject(new Error(`serve printed no URL: ${out}`)), 15_000);
	});
});

after(() => {
	server?.kill();
	rmSync(root, { recursive: true, force: true });
});

async function connect(secret) {
	const client = new Client({ name: "remote-test", version: "0.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: secret ? { Authorization: `Bearer ${secret}` } : {} } }));
	return client;
}

test("token create refuses no scope, unknown scopes and wildcards", () => {
	for (const scopes of ["", "*", "all", "browser.*", "browser.read,admin"]) {
		const r = cliRun(["token", "create", "bad", "--scope", scopes]);
		assert.equal(r.code, 2, `${scopes}: ${r.out}`);
	}
	const secret = token("hash-check", "browser.read");
	const stored = readFileSync(join(env.HOME, ".config", "tabkyra", "tokens.json"), "utf8");
	assert.ok(!stored.includes(secret), "the secret itself is never written");
	assert.doesNotMatch(stored, /tkr_/, "only hashes are stored");
});

test("a request without a valid token is refused", async () => {
	await assert.rejects(connect(undefined), /401|bearer|token/i);
	await assert.rejects(connect("tkr_notarealtokennotarealtoken"), /401|bearer|token/i);
	const raw = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(raw.status, 401);
});

test("a session lists and calls only the tools its scopes grant", async () => {
	const secret = token("reader", "library.read");
	const client = await connect(secret);
	try {
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["library_cite", "library_search"]);
		const denied = await client.callTool({ name: "click", arguments: { ref: "e1" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
		assert.equal(denied.isError, true, "a tool outside the scopes can't be called");
		const allowed = await client.callTool({ name: "library_search", arguments: { query: "" } });
		assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
	} finally {
		await client.close();
	}
});

test("skills.read grants skill_match and skill_read, and only that scope does", async () => {
	const withSkills = await connect(token("skill-reader", "skills.read"));
	try {
		const names = (await withSkills.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["skill_match", "skill_read"]);
		const match = await withSkills.callTool({ name: "skill_match", arguments: { task: "background check on a roofing contractor" } });
		assert.notEqual(match.isError, true, JSON.stringify(match));
		assert.match(match.content[0].text, /^osint /);
		const read = await withSkills.callTool({ name: "skill_read", arguments: { name: "osint" } });
		assert.match(read.content[0].text, /^---\nname: osint\n/);
	} finally {
		await withSkills.close();
	}
	const without = await connect(token("browser-only", "browser.read,library.read"));
	try {
		const names = (await without.listTools()).tools.map((t) => t.name);
		assert.ok(!names.includes("skill_match") && !names.includes("skill_read"), names.join(","));
		const denied = await without.callTool({ name: "skill_read", arguments: { name: "osint" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
		assert.equal(denied.isError, true);
	} finally {
		await without.close();
	}
});

test("a read-only session can't rename its tab group through session_info", async () => {
	const reader = await connect(token("reader-label", "browser.read"));
	try {
		const r = await reader.callTool({ name: "session_info", arguments: { label: "Totally legit" } });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /^permission_denied: .*without label/);
	} finally {
		await reader.close();
	}
});

test("a read-only session sees inspect_page but can't read response bodies through read_network", async () => {
	const reader = await connect(token("reader-bodies", "browser.read"));
	try {
		const { tools } = await reader.listTools();
		assert.ok(tools.some((t) => t.name === "inspect_page"), "inspect_page is a read tool");
		const r = await reader.callTool({ name: "read_network", arguments: { requestId: "1.2" } });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /^permission_denied: .*browser\.script/);
	} finally {
		await reader.close();
	}
});

test("a revoked token is refused at once, and another token can't reuse a session", async () => {
	const a = token("alpha", "browser.read");
	const b = token("beta", "library.read");
	const client = await connect(a);
	const sessionId = client.transport.sessionId;
	const hijack = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${b}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
	});
	assert.equal(hijack.status, 403);
	assert.equal(cliRun(["token", "revoke", "alpha"]).code, 0);
	await assert.rejects(client.listTools(), /401|token/i);
	await client.close().catch(() => {});
	assert.match(cliRun(["token", "list"]).out, /alpha\s+revoked/);
});

test("tunnel tailscale serves the tailnet path; --public uses funnel; --off stops it", () => {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(root, "tailscale.log");
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\necho "$@" >> ${log}\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; fi\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const path = `${bin}:${dirname(process.execPath)}`;
	const on = cliRun(["tunnel", "tailscale", "--port", "8787"], { PATH: path });
	assert.equal(on.code, 0, on.out);
	assert.match(on.out, /https:\/\/mac\.tail1234\.ts\.net\/tabkyra\/mcp/);
	const pub = cliRun(["tunnel", "tailscale", "--public"], { PATH: path });
	assert.match(pub.out, /anyone on the internet/);
	cliRun(["tunnel", "tailscale", "--off"], { PATH: path });
	const calls = readFileSync(log, "utf8");
	assert.match(calls, /^serve --bg --yes --https=443 --set-path=\/tabkyra http:\/\/127\.0\.0\.1:8787$/m);
	assert.match(calls, /^funnel --bg --yes --https=443 --set-path=\/tabkyra http:\/\/127\.0\.0\.1:8787$/m);
	assert.match(calls, /^serve --https=443 --set-path=\/tabkyra off$/m);
});

test("tunnel cloudflare without cloudflared says how to get it and exposes nothing", () => {
	// A PATH holding only node: a real cloudflared (Homebrew puts it beside node) can't be found.
	const bin = join(root, "node-only");
	mkdirSync(bin, { recursive: true });
	symlinkSync(process.execPath, join(bin, "node"));
	const r = cliRun(["tunnel", "cloudflare"], { PATH: bin });
	assert.equal(r.code, 1);
	assert.match(r.out, /cloudflared isn't installed/);
});

test("token names can't collide or look like ids", () => {
	token("unique-name", "browser.read");
	assert.equal(cliRun(["token", "create", "unique-name", "--scope", "browser.read"]).code, 2);
	assert.equal(cliRun(["token", "create", "3f9a01bc", "--scope", "browser.read"]).code, 2);
});

test("only an initialize request opens a session; unknown sessions get 404; serving never rewrites tokens.json", async () => {
	const secret = token("probe", "library.read");
	const file = join(env.HOME, ".config", "tabkyra", "tokens.json");
	const before = readFileSync(file, "utf8");
	const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}` };
	const notInit = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
	assert.equal(notInit.status, 400);
	const unknown = await fetch(url, { method: "POST", headers: { ...headers, "mcp-session-id": "nope" }, body: "{}" });
	assert.equal(unknown.status, 404);
	const bad = await fetch(url, { method: "POST", headers, body: "{not json" });
	assert.equal(bad.status, 400);
	const client = await connect(secret);
	await client.listTools();
	await client.close();
	assert.equal(readFileSync(file, "utf8"), before, "tokens.json is only written by token commands");
});

test("user.ask grants ask_user, and only that scope does", async () => {
	const asker = await connect(token("asker", "user.ask"));
	try {
		const names = (await asker.listTools()).tools.map((t) => t.name);
		assert.deepEqual(names, ["ask_user"]);
		assert.match(asker.getInstructions() ?? "", /call ask_user instead of guessing/);
	} finally {
		await asker.close();
	}
	assert.match(cliRun(["token", "scopes"]).out, /user\.ask\s+Ask the user multiple-choice questions[^\n]*\n\s+ask_user/);
	const others = await connect(token("no-ask", "browser.read,browser.navigate,browser.act,browser.script,library.read,library.write,skills.read"));
	try {
		const names = (await others.listTools()).tools.map((t) => t.name);
		assert.ok(!names.includes("ask_user"), names.join(","));
		assert.doesNotMatch(others.getInstructions() ?? "", /ask_user/);
		const valid = { questions: [{ header: "Format", question: "Which format?", options: [{ label: "PDF", description: "" }, { label: "Markdown", description: "" }] }] };
		const denied = await others.callTool({ name: "ask_user", arguments: valid }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
		assert.equal(denied.isError, true);
		assert.match(denied.content[0].text, /not found|unknown tool/i, "refused as a tool the session doesn't have, not on its arguments");
	} finally {
		await others.close();
	}
});

test("a scoped session's instructions mention only its tools", async () => {
	const client = await connect(token("instr", "library.read"));
	try {
		const text = client.getInstructions() ?? "";
		assert.doesNotMatch(text, /Call status before any browser tool|handle_dialog|tabs_show/);
		assert.match(text, /This session's tools: library_cite, library_search\./);
		assert.match(text, /untrusted data/);
	} finally {
		await client.close();
	}
});

test("tunnel ports are validated, and Funnel is refused when other paths share port 443", () => {
	assert.equal(cliRun(["tunnel", "tailscale", "--port", "87x7"]).code, 2);
	const bin = join(root, "bin-funnel");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/grafana":{}}}}}'; exit 0; fi\necho "$@" >> ${join(root, "funnel.log")}\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const r = cliRun(["tunnel", "tailscale", "--public"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /\/grafana/);
	assert.throws(() => readFileSync(join(root, "funnel.log"), "utf8"), "funnel was never called");
});

test("safety rules reach every scoped session, with a sign-in fallback when tabs_show is missing", async () => {
	const client = await connect(token("actor", "browser.read,browser.act"));
	try {
		const text = client.getInstructions() ?? "";
		assert.match(text, /Do not enter passwords or payment details\./);
		assert.match(text, /Ask the user before you act under their sign-in/);
		assert.match(text, /stop and ask the user to handle it in their browser/);
		assert.doesNotMatch(text, /call tabs_show/);
	} finally {
		await client.close();
	}
});

test("a token can hold at most 8 sessions, and a malformed record doesn't break auth", async () => {
	const secret = token("many", "library.read");
	const clients = [];
	try {
		for (let i = 0; i < 8; i++) clients.push(await connect(secret));
		await assert.rejects(connect(secret), /429|open sessions/);
	} finally {
		for (const c of clients) await c.close().catch(() => {});
	}
	const file = join(env.HOME, ".config", "tabkyra", "tokens.json");
	const data = JSON.parse(readFileSync(file, "utf8"));
	data.tokens.push({ id: "badbadba", name: "broken", scopes: ["library.read"], sha256: "zz", createdAt: "x" });
	writeFileSync(file, JSON.stringify(data));
	const c = await connect(token("after-bad", "library.read"));
	await c.close();
});

test("tailscale serve is refused while Funnel is on for 443; the cloudflare URL is never the API host", () => {
	const bin = join(root, "bin-funnel-on");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"AllowFunnel":{"mac.tail1234.ts.net:443":true}}'; exit 0; fi\necho "$@" >> ${join(root, "serve-on.log")}\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const r = cliRun(["tunnel", "tailscale"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Funnel is on/);
	const cf = join(root, "bin-cf");
	mkdirSync(cf, { recursive: true });
	symlinkSync(process.execPath, join(cf, "node"));
	writeFileSync(join(cf, "cloudflared"), `#!/bin/sh\necho 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'\nexec /bin/sleep 30\n`);
	chmodSync(join(cf, "cloudflared"), 0o755);
	const res = cliRun(["tunnel", "cloudflare"], { PATH: cf, TABKYRA_TUNNEL_TIMEOUT_MS: "1500" });
	assert.equal(res.code, 1, res.out);
	assert.match(res.out, /printed no URL in time, so it was stopped/);
	assert.doesNotMatch(res.out, /reachable at https:\/\/api\./);
	// The live child was stopped, and nothing is left for --off to find.
	const pidFile = join(env.HOME, ".config", "tabkyra", "cloudflared.pid");
	assert.throws(() => readFileSync(pidFile, "utf8"), "the pid file is removed");
});

test("scopes named like Object.prototype members are refused", () => {
	for (const scope of ["constructor", "toString", "__proto__"]) assert.equal(cliRun(["token", "create", `p-${scope.replace(/_/g, "")}`, "--scope", scope]).code, 2, scope);
});

test("tailscale changes nothing when serve status can't be read", () => {
	const bin = join(root, "bin-status-fail");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo 'warning: something' >&2; exit 1; fi\necho "$@" >> ${join(root, "status-fail.log")}\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const r = cliRun(["tunnel", "tailscale"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Couldn't read tailscale serve status/);
	assert.throws(() => readFileSync(join(root, "status-fail.log"), "utf8"), "serve was never changed");
});

test("remote sessions read bundled skills only, never the user's local edits", async () => {
	const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
	const draft = join(root, "drafts", "dorks");
	mkdirSync(draft, { recursive: true });
	const text = readFileSync(join(skillsDir, "dorks", "SKILL.md"), "utf8");
	writeFileSync(join(draft, "SKILL.md"), text.replace("## When something goes wrong", "## When something goes wrong\n\n| Private local note | Only on this machine |"));
	const applied = cliRun(["skill", "apply", draft, "--yes"]);
	assert.equal(applied.code, 0, applied.out);
	// A local-only skill, which only exists on this machine.
	const own = join(root, "drafts", "invoice-triage");
	mkdirSync(own, { recursive: true });
	writeFileSync(
		join(own, "SKILL.md"),
		"---\nname: invoice-triage\ndescription: Sort supplier invoices into paid, due and disputed. Use when the user asks to triage, sort or reconcile supplier invoices.\n---\n# Invoice triage\n\n## When to use\n\n- The user has a pile of supplier invoices to sort.\n\n## Steps\n\n1. **List them.** Read each invoice.\n2. **Sort them.** Paid, due or disputed.\n\n## Done when\n\n- Every invoice has a status.\n",
	);
	const ownApplied = cliRun(["skill", "apply", own, "--yes"]);
	assert.equal(ownApplied.code, 0, ownApplied.out);
	const task = "triage my supplier invoices";
	assert.match(cliRun(["skill", "match", task]).out, /^invoice-triage\s/, "the local router sees it, so the remote check below means something");
	const client = await connect(token("skills-reader", "skills.read"));
	try {
		const r = await client.callTool({ name: "skill_read", arguments: { name: "dorks" } });
		assert.doesNotMatch(r.content[0].text, /Private local note/);
		assert.equal(r.content[0].text.trim(), text.trim());
		for (const top of [1, 5]) {
			const m = await client.callTool({ name: "skill_match", arguments: { task, top } });
			assert.doesNotMatch(m.content[0].text, /invoice-triage/);
		}
		const hidden = await client.callTool({ name: "skill_read", arguments: { name: "invoice-triage" } });
		assert.equal(hidden.isError, true);
		assert.doesNotMatch(hidden.content[0].text, /supplier invoices/);
	} finally {
		await client.close();
	}
});

// OAuth for web connectors (claude.ai, ChatGPT, grok.com): serve --public-url runs a single-owner
// authorization server. A grant needs the owner's passcode, carries only the scopes ticked on the
// consent page, rotates refresh tokens and ends the whole grant when an old one comes back.
async function freePort() {
	return await new Promise((resolve) => {
		const s = createNetServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

function rawRequest(target, host) {
	return new Promise((resolve, reject) => {
		const u = new URL(target);
		const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: "GET", headers: { host } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode));
		});
		req.on("error", reject);
		req.end();
	});
}

test("serve --public-url: register, approve with the passcode, use only the ticked scopes, rotate and revoke", async () => {
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const home = join(root, "oauth-home");
	mkdirSync(home, { recursive: true });
	const oenv = { ...env, HOME: home };
	const run = (args) => {
		const r = spawnSync(process.execPath, [cli, ...args], { env: oenv, encoding: "utf8" });
		return { code: r.status, out: `${r.stdout}${r.stderr}` };
	};
	assert.notEqual(run(["serve", "--public-url", "https://x.example/path"]).code, 0, "a public URL with a path is refused");
	assert.notEqual(run(["serve", "--redirect-host", "a.example"]).code, 0, "--redirect-host needs --public-url");
	const passcode = /([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}/.exec(run(["token", "passcode"]).out)?.[0];
	assert.ok(passcode, "token passcode prints a passcode");
	const srv = spawn(process.execPath, [cli, "serve", "--port", String(port), "--public-url", base], { env: oenv });
	try {
		await new Promise((resolve, reject) => {
			let out = "";
			srv.stdout.on("data", (d) => {
				out += d;
				if (/OAuth on/.test(out)) resolve();
			});
			srv.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
			setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 15_000);
		});

		const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		assert.equal(unauth.status, 401);
		assert.match(unauth.headers.get("www-authenticate"), new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
		const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
		assert.equal(prm.resource, `${base}/mcp`);
		const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
		assert.equal(asm.authorization_response_iss_parameter_supported, true);
		assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
		assert.equal(await rawRequest(`${base}/.well-known/oauth-authorization-server`, "evil.example"), 421, "a foreign Host header is refused");

		const register = (uris) => fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: uris }) });
		assert.equal((await register(["https://evil.example/cb"])).status, 400, "only known connector hosts may receive codes");
		assert.equal((await register(["https://claude.ai:8443/cb"])).status, 400, "no custom ports on a connector host");
		const callback = "https://claude.ai/api/mcp/auth_callback";
		const reg = await register([callback]);
		assert.equal(reg.status, 201);
		const { client_id } = await reg.json();

		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${base}/mcp` });
		const noPkce = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: callback })}`, { redirect: "manual" });
		assert.equal(noPkce.status, 302);
		assert.match(noPkce.headers.get("location"), /error=invalid_request/);
		const consent = await fetch(`${base}/authorize?${q}`);
		assert.equal(consent.status, 200);
		const html = await consent.text();
		assert.match(html, /Allow Claude to use your browser/);
		assert.match(html, /value="browser\.act" checked/);
		assert.doesNotMatch(html, /value="browser\.script" checked/, "running code as the user is never ticked by default");
		const signed = /name="request" value="([^"]+)"/.exec(html)[1];

		const approve = (fields) => fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
		const wrong = await approve([["request", signed], ["passcode", "nope"], ["scope", "browser.read"], ["decision", "allow"]]);
		assert.equal(wrong.status, 401);
		assert.match(await wrong.text(), /Wrong passcode/);
		const forged = await approve([["request", `${signed.split(".")[0]}.AAAA`], ["passcode", passcode], ["scope", "browser.read"], ["decision", "allow"]]);
		assert.equal(forged.status, 400, "a tampered approval form is refused");
		const ok = await approve([["request", signed], ["passcode", passcode], ["scope", "browser.read"], ["decision", "allow"]]);
		assert.equal(ok.status, 302);
		const back = new URL(ok.headers.get("location"));
		assert.equal(back.origin + back.pathname, callback);
		assert.equal(back.searchParams.get("state"), "s1");
		assert.equal(back.searchParams.get("iss"), base);
		const code = back.searchParams.get("code");

		const token = (fields) => fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
		const badVerifier = await token({ grant_type: "authorization_code", code, client_id, redirect_uri: callback, code_verifier: "x".repeat(43) });
		assert.equal((await badVerifier.json()).error, "invalid_grant");
		// The failed exchange used the code up; get a fresh one.
		const consent2 = await (await fetch(`${base}/authorize?${q}`)).text();
		const signed2 = /name="request" value="([^"]+)"/.exec(consent2)[1];
		const ok2 = await approve([["request", signed2], ["passcode", passcode], ["scope", "browser.read"], ["decision", "allow"]]);
		const code2 = new URL(ok2.headers.get("location")).searchParams.get("code");
		const grant = await (await token({ grant_type: "authorization_code", code: code2, client_id, redirect_uri: callback, code_verifier: verifier, resource: `${base}/mcp` })).json();
		assert.equal(grant.scope, "browser.read");
		assert.match(grant.access_token, /^tko_/);
		assert.equal((await token({ grant_type: "authorization_code", code: code2, client_id, redirect_uri: callback, code_verifier: verifier })).status, 400, "a code works once");

		const mcp = new Client({ name: "oauth-test", version: "0.0.0" });
		await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${grant.access_token}` } } }));
		const names = (await mcp.listTools()).tools.map((t) => t.name);
		assert.ok(names.includes("read_page"));
		assert.ok(!names.includes("click") && !names.includes("navigate") && !names.includes("run_js"), `only browser.read tools: ${names}`);
		await mcp.close();

		const rotated = await (await token({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id })).json();
		assert.match(rotated.access_token, /^tko_/);
		const reuse = await token({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id });
		assert.equal((await reuse.json()).error, "invalid_grant", "an old refresh token is refused");
		const afterReuse = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${rotated.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
		assert.equal(afterReuse.status, 401, "reusing an old refresh token ends the whole grant");

		const listed = JSON.parse(run(["token", "clients", "--json"]).out);
		assert.equal(listed[0].client_id, client_id);
		assert.equal(run(["token", "revoke", client_id]).code, 0);
		assert.deepEqual(JSON.parse(run(["token", "clients", "--json"]).out), []);
		const oauthFile = readFileSync(join(home, ".config", "tabkyra", "oauth.json"), "utf8");
		assert.doesNotMatch(oauthFile, /tko_|tkf_|tks_/, "only hashes are stored");
		assert.doesNotMatch(oauthFile, new RegExp(passcode), "the passcode is stored as a hash");
	} finally {
		srv.kill();
	}
});
