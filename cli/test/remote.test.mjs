// Remote MCP (DC-2, DC-9): every request needs a scoped, revocable token; a session sees
// only the tools its scopes grant; there's no wildcard; the server binds loopback only; and
// the tunnel commands call the user's own tailscale and cloudflared with the right args.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
		`#!/bin/sh\necho "$@" >> ${log}\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.example.ts.net."}}'; fi\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const path = `${bin}:${dirname(process.execPath)}`;
	const on = cliRun(["tunnel", "tailscale", "--port", "8787"], { PATH: path });
	assert.equal(on.code, 0, on.out);
	assert.match(on.out, /https:\/\/mac\.example\.ts\.net\/tabkyra\/mcp/);
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
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.example.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"Web":{"mac.example.ts.net:443":{"Handlers":{"/grafana":{}}}}}'; exit 0; fi\necho "$@" >> ${join(root, "funnel.log")}\n`,
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
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.example.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"AllowFunnel":{"mac.example.ts.net:443":true}}'; exit 0; fi\necho "$@" >> ${join(root, "serve-on.log")}\n`,
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
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.example.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo 'warning: something' >&2; exit 1; fi\necho "$@" >> ${join(root, "status-fail.log")}\n`,
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
		const r = spawnSync(process.execPath, [cli, ...args], { env: oenv, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
		return { code: r.status, out: `${r.stdout}${r.stderr}` };
	};
	// A refused serve exits on its own (status 2), not by the timeout (status null).
	assert.equal(run(["serve", "--port", "0", "--public-url", "https://x.example/path"]).code, 2, "a public URL with a path is refused");
	assert.equal(run(["serve", "--port", "0", "--redirect-host", "a.example"]).code, 2, "--redirect-host needs --public-url");
	assert.equal(run(["token", "create", "tkc_x", "--scope", "browser.read"]).code, 2, "token names can't look like OAuth client ids");
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
		assert.equal((await register(["https://claude.ai/some/other/path"])).status, 400, "claude.ai codes go only to its documented callback");
		assert.equal((await register(["https://chatgpt.com/connector/oauth/abc_123"])).status, 201, "ChatGPT's per-connector callback");
		assert.equal((await register(["https://grok.com/any/path"])).status, 201, "grok.com's path isn't documented, so any path on it");
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
		assert.match(html, /registered \d+ seconds ago and returns to <code>https:\/\/claude\.ai\/api\/mcp\/auth_callback<\/code>/);
		assert.match(html, /value="browser\.act" checked/);
		assert.doesNotMatch(html, /value="browser\.script" checked/, "running code as the user is never ticked by default");
		const signed = /name="request" value="([^"]+)"/.exec(html)[1];

		const approve = (fields) => fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
		assert.match(html, /autocomplete="one-time-code"/, "the passcode field isn't a password field a manager would fill");
		const wrong = await approve([["request", signed], ["passcode", "nope"], ["scope", "browser.read"], ["decision", "allow"]]);
		assert.equal(wrong.status, 401);
		const wrongHtml = await wrong.text();
		assert.match(wrongHtml, /Wrong passcode/);
		assert.match(wrongHtml, /value="browser\.read" checked/);
		assert.doesNotMatch(wrongHtml, /value="browser\.act" checked/, "the page shown again keeps what the owner unticked");
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
		// A retry inside the grace window (a lost response) gets a fresh pair and keeps the grant.
		const retry = await (await token({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id })).json();
		assert.match(retry.access_token, /^tko_/);
		const grants = JSON.parse(run(["token", "clients", "--json"]).out).find((cl) => cl.client_id === client_id).grants;
		assert.equal(grants.length, 1);
		assert.match(grants[0].id, /^o-[0-9a-f]{32}$/, "grant ids carry 128 random bits");
		// The pair the retry replaced is spent: using its refresh token now ends the grant.
		const lostPair = await token({ grant_type: "refresh_token", refresh_token: rotated.refresh_token, client_id });
		assert.equal((await lostPair.json()).error, "invalid_grant", "the pair replaced by a retry is spent");
		assert.deepEqual(JSON.parse(run(["token", "clients", "--json"]).out).find((cl) => cl.client_id === client_id).grants, [], "and using it ended the grant");
		// A second use of the same old token is a copy in someone else's hands: the grant ends.
		const reuse = await token({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id });
		assert.equal((await reuse.json()).error, "invalid_grant", "an old refresh token is refused");
		const afterReuse = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${retry.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
		assert.equal(afterReuse.status, 401, "reusing an old refresh token ends the whole grant");

		// A token spent several rotations back still ends the grant.
		const consentR = await (await fetch(`${base}/authorize?${q}`)).text();
		const okR = await approve([["request", /name="request" value="([^"]+)"/.exec(consentR)[1]], ["passcode", passcode], ["scope", "browser.read"], ["decision", "allow"]]);
		let chain = await (await token({ grant_type: "authorization_code", code: new URL(okR.headers.get("location")).searchParams.get("code"), client_id, redirect_uri: callback, code_verifier: verifier })).json();
		const first = chain.refresh_token;
		for (let i = 0; i < 3; i++) chain = await (await token({ grant_type: "refresh_token", refresh_token: chain.refresh_token, client_id })).json();
		assert.match(chain.access_token, /^tko_/);
		const old = await token({ grant_type: "refresh_token", refresh_token: first, client_id });
		assert.equal((await old.json()).error, "invalid_grant");
		const afterOld = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${chain.access_token}`, "content-type": "application/json" }, body: "{}" });
		assert.equal(afterOld.status, 401, "a replay from three rotations back ends the grant");

		// Retention caps never discard a live grant's spent tokens. serve reads oauth.json on every
		// change, so the test adds records to it between requests.
		const oauthPath = join(home, ".config", "tabkyra", "oauth.json");
		const newGrant = async () => {
			const page = await (await fetch(`${base}/authorize?${q}`)).text();
			const res = await approve([["request", /name="request" value="([^"]+)"/.exec(page)[1]], ["passcode", passcode], ["scope", "browser.read"], ["decision", "allow"]]);
			return await (await token({ grant_type: "authorization_code", code: new URL(res.headers.get("location")).searchParams.get("code"), client_id, redirect_uri: callback, code_verifier: verifier })).json();
		};
		const seed = (records) => {
			const state = JSON.parse(readFileSync(oauthPath, "utf8"));
			for (const r of records) state.tokens[randomBytes(32).toString("hex")] = r;
			writeFileSync(oauthPath, JSON.stringify(state), { mode: 0o600 });
		};
		const recordOf = (raw) => JSON.parse(readFileSync(oauthPath, "utf8")).tokens[createHash("sha256").update(raw).digest("hex")];
		const mcpStatus = async (access) => (await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: "{}" })).status;
		const nowS = Math.floor(Date.now() / 1000);

		// Per-grant cap (1500 spent): a grant past it ends rather than forget its oldest spent token.
		const capStart = await newGrant();
		const capNext = await (await token({ grant_type: "refresh_token", refresh_token: capStart.refresh_token, client_id })).json();
		const capRec = recordOf(capNext.refresh_token);
		seed(Array.from({ length: 1500 }, (_, i) => ({ ...capRec, revoked: true, expires: capRec.expires + 10 + i })));
		const overCap = await token({ grant_type: "refresh_token", refresh_token: capNext.refresh_token, client_id });
		assert.equal((await overCap.json()).error, "invalid_grant", "a refresh past the spent cap is refused");
		assert.equal(await mcpStatus(capNext.access_token), 401, "and the grant's access token is dead");
		assert.equal((await token({ grant_type: "refresh_token", refresh_token: capStart.refresh_token, client_id })).status, 400, "an early spent token still gets nothing");
		assert.equal(Object.values(JSON.parse(readFileSync(oauthPath, "utf8")).tokens).filter((t) => t.family === capRec.family).length, 0, "no token of the ended grant remains");

		// Global cap (10,000 tokens): eviction drops whole older grants and keeps a live grant's spent tokens.
		const live = await newGrant();
		const liveNext = await (await token({ grant_type: "refresh_token", refresh_token: live.refresh_token, client_id })).json();
		const liveRec = recordOf(liveNext.refresh_token);
		const filler = { ...liveRec, family: "f".repeat(32), kind: "access", expires: nowS + 86400, rotated_at: undefined };
		seed(Array.from({ length: 10_001 }, () => filler));
		const pressured = await (await token({ grant_type: "refresh_token", refresh_token: liveNext.refresh_token, client_id })).json();
		assert.match(pressured.access_token, /^tko_/, "the live grant survives the cap");
		const remaining = Object.values(JSON.parse(readFileSync(oauthPath, "utf8")).tokens);
		assert.ok(remaining.length <= 10_000, "the cap holds");
		assert.ok(!remaining.some((t) => t.family === filler.family), "the older grant went whole");
		assert.ok(remaining.some((t) => t.family === liveRec.family && t.revoked), "the live grant kept its spent tokens");
		assert.notEqual(await mcpStatus(pressured.access_token), 401, "the live grant works before the replay");
		const replay = await token({ grant_type: "refresh_token", refresh_token: live.refresh_token, client_id });
		assert.equal((await replay.json()).error, "invalid_grant");
		assert.equal(await mcpStatus(pressured.access_token), 401, "a replay after eviction still ends the grant");
		// One grant can be ended on its own.
		const consent3 = await (await fetch(`${base}/authorize?${q}`)).text();
		const ok3 = await approve([["request", /name="request" value="([^"]+)"/.exec(consent3)[1]], ["passcode", passcode], ["scope", "browser.read"], ["decision", "allow"]]);
		const grant3 = await (await token({ grant_type: "authorization_code", code: new URL(ok3.headers.get("location")).searchParams.get("code"), client_id, redirect_uri: callback, code_verifier: verifier })).json();
		const id3 = JSON.parse(run(["token", "clients", "--json"]).out).find((cl) => cl.client_id === client_id).grants[0].id;
		assert.equal(run(["token", "revoke", id3]).code, 0);
		const afterGrantRevoke = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${grant3.access_token}`, "content-type": "application/json" }, body: "{}" });
		assert.equal(afterGrantRevoke.status, 401);
		const listed = JSON.parse(run(["token", "clients", "--json"]).out);
		assert.ok(listed.some((cl) => cl.client_id === client_id));
		assert.equal(run(["token", "revoke", client_id]).code, 0);
		assert.ok(!JSON.parse(run(["token", "clients", "--json"]).out).some((cl) => cl.client_id === client_id), "the revoked client is gone");
		const oauthFile = readFileSync(join(home, ".config", "tabkyra", "oauth.json"), "utf8");
		assert.doesNotMatch(oauthFile, /tko_|tkf_|tks_/, "only hashes are stored");
		assert.doesNotMatch(oauthFile, new RegExp(passcode), "the passcode is stored as a hash");
	} finally {
		srv.kill();
	}
});

// tabkyra remote setup|status|off: one command for Funnel (or a custom HTTPS front door), the
// passcode and a user service. tailscale, launchctl and systemctl are stubs that log their args.
const DNS = "mac.example.ts.net";

/** A scenario with its own HOME and stub tailscale, launchctl and systemctl on PATH. funnelFails: what `tailscale funnel --bg` prints before exiting 1. */
function remoteScenario(name, { lock = "Tailnet lock is NOT enabled.", serveStatus = "{}", funnelFails = "", funnelOffFails = false } = {}) {
	const dir = join(root, name);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	const log = join(dir, "calls.log");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	const script = (file, body) => {
		writeFileSync(join(bin, file), `#!/bin/sh\n${body}`);
		chmodSync(join(bin, file), 0o755);
	};
	const funnelCase = (funnelFails ? `"funnel --bg") echo '${funnelFails}'; exit 1 ;;\n` : "") + (funnelOffFails ? `"funnel --https=8443") echo 'boom' >&2; exit 1 ;;\n` : "");
	script(
		"tailscale",
		`echo "tailscale $*" >> ${log}\ncase "$1 $2" in\n"lock status") echo '${lock}' ;;\n"status --json") echo '{"Self":{"DNSName":"${DNS}."}}' ;;\n"serve status") echo '${serveStatus}' ;;\n${funnelCase}esac\n`,
	);
	// The stub service managers start nothing. launchctl print says "not loaded" (exit 1) unless failStop() ran.
	script("launchctl", `echo "launchctl $*" >> ${log}\ncase "$1" in\nprint) exit 1 ;;\nesac\n`);
	script("systemctl", `echo "systemctl $*" >> ${log}\n`);
	const scenarioEnv = { HOME: home, TABKYRA_CONFIG_DIR: join(home, "cfg"), PATH: `${bin}:${dirname(process.execPath)}` };
	return {
		env: { ...env, ...scenarioEnv },
		home,
		config: scenarioEnv.TABKYRA_CONFIG_DIR,
		run: (args, extra = {}) => cliRun(args, { ...scenarioEnv, ...extra }),
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		remoteJson: () => JSON.parse(readFileSync(join(scenarioEnv.TABKYRA_CONFIG_DIR, "remote.json"), "utf8")),
		hasRemoteJson: () => existsSync(join(scenarioEnv.TABKYRA_CONFIG_DIR, "remote.json")),
		serviceFile: () => (process.platform === "darwin" ? join(home, "Library", "LaunchAgents", "com.tabkyra.serve.plist") : join(home, ".config", "systemd", "user", "tabkyra-serve.service")),
		/** The launcher `tabkyra install` writes: an executable script that runs an existing file. */
		launcher: (homeDir = home) => {
			const path = join(homeDir, ".config", "tabkyra", "tabkyra");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
			chmodSync(path, 0o755);
			return path;
		},
		/** Make stopping the service fail, as it would if the service manager refused. */
		failStop: () => {
			script("launchctl", `echo "launchctl $*" >> ${log}\ncase "$1" in\nbootout) echo 'boom' >&2; exit 1 ;;\nesac\n`);
			script("systemctl", `echo "systemctl $*" >> ${log}\ncase "$2" in\ndisable) echo 'boom' >&2; exit 1 ;;\nesac\n`);
		},
	};
}

const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

/** A local HTTP server on a free port (or the given one). resource: answer the protected-resource metadata with it; undefined: answer 404 to everything. */
async function localServer(resource, listenOn = 0) {
	const srv = createHttpServer((req, res) => {
		if (resource === undefined || req.url !== METADATA_PATH) {
			res.statusCode = 404;
			res.end("not here");
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ resource }));
	});
	await new Promise((resolve) => srv.listen(listenOn, "127.0.0.1", resolve));
	return { port: srv.address().port, close: () => new Promise((resolve) => srv.close(resolve)) };
}

const FUNNEL_URL = `https://${DNS}:8443`;
const funnelCall = (port) => `tailscale funnel --bg --yes --https=8443 http://127.0.0.1:${port}`;

const PASSCODE = /([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}/;
const managerCalls = (s) => s.calls().filter((x) => /^(systemctl|launchctl)/.test(x));
const serviceTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;

/** Like s.run, but without blocking this process, so a DoH server living in it can answer. */
function runAsync(s, args, extra = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...args], { env: { ...s.env, ...extra } });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => resolve({ code, out }));
	});
}

/** Start `tabkyra serve` and wait until it says OAuth is on. */
async function startServe(s, args) {
	const srv = spawn(process.execPath, [cli, "serve", ...args], { env: s.env });
	await new Promise((resolve, reject) => {
		let out = "";
		srv.stdout.on("data", (d) => {
			out += d;
			if (/OAuth on/.test(out)) resolve();
		});
		srv.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
		setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 15_000);
	});
	return srv;
}

test("remote setup (funnel) runs the exact funnel command, writes remote.json and prints the passcode once", async () => {
	const s = remoteScenario("funnel-setup");
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await runAsync(s, ["remote", "setup", "--no-service", "--port", String(local.port)]);
		assert.equal(r.code, 0, r.out);
		assert.ok(s.calls().includes(funnelCall(local.port)), s.calls().join("\n"));
		assert.deepEqual(s.remoteJson(), { publicUrl: FUNNEL_URL, port: local.port, route: "funnel" });
		assert.equal(statSync(join(s.config, "remote.json")).mode & 0o777, 0o600);
		assert.match(r.out, new RegExp(`Connector URL: https://${DNS}:8443/mcp`));
		assert.match(r.out, /Settings > Connectors > Add custom connector/);
		assert.match(r.out, /grok\.com\/connectors > New Connector > Custom/);
		assert.match(r.out, /Approve with your Tabkyra passcode\./);
		assert.match(r.out, /Check it with: tabkyra remote status/);
		assert.match(r.out, PASSCODE, "the passcode is printed");
		const again = await runAsync(s, ["remote", "setup", "--no-service"]);
		assert.equal(again.code, 0, again.out);
		assert.doesNotMatch(again.out, PASSCODE, "an existing passcode is not replaced or shown again");
		assert.equal(s.remoteJson().port, local.port, "the port defaults to the one in remote.json");
	} finally {
		await local.close();
	}
});

test("remote setup refuses on a Tailnet Lock tailnet and changes nothing", () => {
	const s = remoteScenario("funnel-lock", { lock: "Tailnet lock is ENABLED." });
	const r = s.run(["remote", "setup"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Tailnet Lock/);
	assert.match(r.out, /--public-url/);
	assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")), s.calls().join("\n"));
	assert.equal(s.hasRemoteJson(), false);
	assert.equal(existsSync(s.serviceFile()), false);
	assert.equal(managerCalls(s).length, 0);
});

test("remote setup refuses when port 8443 already serves something else", () => {
	const serveStatus = JSON.stringify({ Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
	const s = remoteScenario("funnel-busy", { serveStatus });
	const r = s.run(["remote", "setup"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Port 8443 on this machine already serves something else/);
	assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")));
	assert.equal(s.hasRemoteJson(), false);
});

test("remote setup without Tailscale on PATH says what to do and exits 1", () => {
	const s = remoteScenario("no-tailscale");
	const bare = join(root, "no-tailscale", "node-only");
	mkdirSync(bare, { recursive: true });
	symlinkSync(process.execPath, join(bare, "node"));
	const r = s.run(["remote", "setup"], { PATH: bare });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Tailscale isn't installed.*--public-url/);
	assert.equal(s.hasRemoteJson(), false);
});

test("remote setup --public-url: a URL with a path is refused; an origin is stored as route custom without changing tailscale", () => {
	const s = remoteScenario("custom-setup");
	const bad = s.run(["remote", "setup", "--public-url", "https://tabkyra.example.com/mcp", "--no-service"]);
	assert.equal(bad.code, 2, bad.out);
	assert.equal(s.hasRemoteJson(), false);
	const ok = s.run(["remote", "setup", "--public-url", "https://tabkyra.example.com", "--port", "9100", "--no-service"]);
	assert.equal(ok.code, 0, ok.out);
	assert.deepEqual(s.remoteJson(), { publicUrl: "https://tabkyra.example.com", port: 9100, route: "custom" });
	assert.deepEqual(s.calls().filter((x) => x.startsWith("tailscale funnel") || /^(systemctl|launchctl)/.test(x)), [], "a custom route with --no-service never changes tailscale or a service manager");
	assert.match(ok.out, /Connector URL: https:\/\/tabkyra\.example\.com\/mcp/);
});

test("remote setup --no-service writes no service file", () => {
	const s = remoteScenario("no-service");
	assert.equal(s.run(["remote", "setup", "--no-service"]).code, 0);
	assert.equal(existsSync(s.serviceFile()), false);
	assert.equal(managerCalls(s).length, 0);
});

serviceTest("remote setup installs a service that runs serve, opens Funnel only after serve answers, and twice converges to the same state", async () => {
	const s = remoteScenario("service");
	const binary = s.launcher();
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const first = await runAsync(s, ["remote", "setup", "--port", String(local.port)]);
		assert.equal(first.code, 0, first.out);
		const unit = readFileSync(s.serviceFile(), "utf8");
		const firstJson = JSON.stringify(s.remoteJson());
		assert.deepEqual(s.remoteJson(), { publicUrl: FUNNEL_URL, port: local.port, route: "funnel" });
		if (process.platform === "linux") {
			assert.ok(unit.split("\n").includes(`ExecStart=${binary} serve`), unit);
			assert.ok(unit.split("\n").includes("Restart=always"), unit);
			assert.ok(unit.split("\n").includes("RestartSec=10"), unit);
			assert.ok(unit.split("\n").includes("WantedBy=default.target"), unit);
			assert.ok(unit.split("\n").includes(`Environment=TABKYRA_CONFIG_DIR=${s.config}`), unit);
			assert.ok(unit.split("\n").includes(`Environment=TABKYRA_SOCKET_DIR=${env.TABKYRA_SOCKET_DIR}`), unit);
			assert.deepEqual(managerCalls(s), ["systemctl --user daemon-reload", "systemctl --user enable tabkyra-serve.service", "systemctl --user restart tabkyra-serve.service"]);
		} else {
			assert.ok(unit.includes(`<string>${binary}</string>\n\t\t<string>serve</string>`), unit);
			assert.ok(unit.includes(`<key>TABKYRA_CONFIG_DIR</key>\n\t\t<string>${s.config}</string>`), unit);
			assert.match(unit, /<key>RunAtLoad<\/key>\s*<true\/>/);
			assert.match(unit, /<key>KeepAlive<\/key>\s*<true\/>/);
			assert.match(unit, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
			assert.ok(unit.includes(join(s.home, "Library", "Logs", "tabkyra-serve.log")));
			const uid = process.getuid();
			assert.deepEqual(managerCalls(s), [`launchctl bootout gui/${uid}/com.tabkyra.serve`, `launchctl print gui/${uid}/com.tabkyra.serve`, `launchctl bootstrap gui/${uid} ${s.serviceFile()}`]);
		}
		const calls = s.calls();
		assert.ok(calls.indexOf(funnelCall(local.port)) > calls.findIndex((x) => /^(systemctl --user restart|launchctl bootstrap)/.test(x)), `Funnel opens after the service starts:\n${calls.join("\n")}`);
		const second = await runAsync(s, ["remote", "setup", "--port", String(local.port)]);
		assert.equal(second.code, 0, second.out);
		assert.equal(readFileSync(s.serviceFile(), "utf8"), unit, "the service file is the same after a second run");
		assert.equal(JSON.stringify(s.remoteJson()), firstJson);
		assert.equal(s.calls().filter((x) => x === funnelCall(local.port)).length, 2);
		assert.equal(managerCalls(s).length, 6);
	} finally {
		await local.close();
	}
});

serviceTest("remote setup with a service that never answers exits 1, names the log and never opens Funnel", () => {
	const s = remoteScenario("service-silent");
	s.launcher();
	const port = 1; // nothing listens here
	const r = s.run(["remote", "setup", "--port", String(port)]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /isn't answering on 127\.0\.0\.1:1 with https:\/\/mac\.example\.ts\.net:8443\/mcp after 15 seconds, so Funnel was not opened/);
	assert.match(r.out, process.platform === "linux" ? /journalctl --user -u tabkyra-serve\.service/ : /tabkyra-serve\.log/);
	assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")), s.calls().join("\n"));
	assert.ok(s.hasRemoteJson(), "remote.json is kept");
});

test("remote setup with a service requested and no working launcher exits 1 and installs nothing", () => {
	const s = remoteScenario("no-launcher");
	const r = s.run(["remote", "setup"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Run tabkyra install first, then tabkyra remote setup again\./);
	assert.equal(existsSync(s.serviceFile()), false);
	assert.equal(s.hasRemoteJson(), false);
	assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")), s.calls().join("\n"));
	assert.equal(managerCalls(s).length, 0);
});

test("remote setup refuses when a foreign process answers on the port: nothing is changed and Funnel stays closed", async () => {
	const s = remoteScenario("foreign");
	const foreign = await localServer(undefined);
	try {
		const r = await runAsync(s, ["remote", "setup", "--no-service", "--port", String(foreign.port)]);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, new RegExp(`Something already listens on 127\\.0\\.0\\.1:${foreign.port} and isn't Tabkyra serve for ${FUNNEL_URL}`));
		assert.match(r.out, /Nothing was changed\. Stop it/);
		assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")), s.calls().join("\n"));
		assert.equal(s.hasRemoteJson(), false);
		assert.doesNotMatch(r.out, PASSCODE);
	} finally {
		await foreign.close();
	}
});

test("remote setup --no-service opens Funnel only when serve already answers with this URL; with nothing listening it writes remote.json and leaves Funnel closed", async () => {
	const ready = remoteScenario("ready");
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await runAsync(ready, ["remote", "setup", "--no-service", "--port", String(local.port)]);
		assert.equal(r.code, 0, r.out);
		assert.ok(ready.calls().includes(funnelCall(local.port)), ready.calls().join("\n"));
		assert.doesNotMatch(r.out, /start tabkyra serve now/);
	} finally {
		await local.close();
	}
	const idle = remoteScenario("idle");
	const port = await freePort();
	const r = idle.run(["remote", "setup", "--no-service", "--port", String(port)]);
	assert.equal(r.code, 0, r.out);
	assert.ok(!idle.calls().some((x) => x.startsWith("tailscale funnel")), idle.calls().join("\n"));
	assert.deepEqual(idle.remoteJson(), { publicUrl: FUNNEL_URL, port, route: "funnel" });
	assert.match(r.out, /Start tabkyra serve \(it reads remote\.json\), then run tabkyra remote setup --no-service again to open Funnel\./);
	assert.doesNotMatch(r.out, /Funnel is open/);
});

test("remote setup refuses a switch from Funnel to a custom URL and leaves remote.json as it was", () => {
	const s = remoteScenario("switch");
	const port = 9123;
	assert.equal(s.run(["remote", "setup", "--no-service", "--port", String(port)]).code, 0);
	const before = readFileSync(join(s.config, "remote.json"), "utf8");
	const r = s.run(["remote", "setup", "--public-url", "https://tabkyra.example.com", "--no-service"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Funnel from an earlier setup is on\. Run tabkyra remote off first\./);
	assert.equal(readFileSync(join(s.config, "remote.json"), "utf8"), before);
	assert.deepEqual(s.remoteJson(), { publicUrl: FUNNEL_URL, port, route: "funnel" });
});

test("remote setup says so when Funnel isn't enabled for the tailnet, and keeps remote.json", async () => {
	const s = remoteScenario("funnel-disabled", { funnelFails: "Funnel not available; visit https://login.tailscale.com/f/funnel?node=n123 to enable it" });
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await runAsync(s, ["remote", "setup", "--no-service", "--port", String(local.port)]);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /Funnel isn't enabled for this tailnet or node yet\. Open https:\/\/login\.tailscale\.com\/f\/funnel\?node=n123, enable it, then run tabkyra remote setup again\./);
		assert.ok(s.hasRemoteJson());
	} finally {
		await local.close();
	}
});

test("the systemd unit escapes % and $ in ExecStart and % in environment values", { skip: process.platform !== "linux" }, async () => {
	const s = remoteScenario("percent");
	const home = join(s.home, "h$ome%x");
	const binary = s.launcher(home);
	const config = join(s.home, "100%", "cfg");
	const local = await localServer(`${FUNNEL_URL}/mcp`);
	try {
		const r = await runAsync(s, ["remote", "setup", "--port", String(local.port)], { HOME: home, TABKYRA_CONFIG_DIR: config });
		assert.equal(r.code, 0, r.out);
	} finally {
		await local.close();
	}
	const lines = readFileSync(join(home, ".config", "systemd", "user", "tabkyra-serve.service"), "utf8").split("\n");
	assert.ok(lines.includes(`ExecStart="${binary.replace("$", "$$$$").replace("%", "%%")}" serve`), lines.join("\n"));
	assert.ok(lines.includes(`Environment="TABKYRA_CONFIG_DIR=${config.replace("%", "%%")}"`), lines.join("\n"));
});

test("remote setup accepts a port 8443 that is already ours, including its HTTPS TCP entry", async () => {
	const port = await freePort();
	const serveStatus = JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });
	const s = remoteScenario("funnel-again", { serveStatus });
	const local = await localServer(`${FUNNEL_URL}/mcp`, port);
	try {
		const r = await runAsync(s, ["remote", "setup", "--no-service", "--port", String(port)]);
		assert.equal(r.code, 0, r.out);
		assert.ok(s.calls().includes(funnelCall(port)));
	} finally {
		await local.close();
	}
});

test("remote setup refuses when port 8443 forwards plain TCP, and changes nothing", () => {
	const serveStatus = JSON.stringify({ TCP: { 8443: { TCPForward: "127.0.0.1:22" } } });
	const s = remoteScenario("funnel-tcp", { serveStatus });
	const r = s.run(["remote", "setup", "--no-service"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Port 8443 on this machine already forwards TCP traffic to 127\.0\.0\.1:22/);
	assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")));
	assert.equal(s.hasRemoteJson(), false);
});

test("remote setup refuses on an unreadable remote.json and changes nothing", () => {
	const s = remoteScenario("setup-bad-file");
	mkdirSync(s.config, { recursive: true });
	writeFileSync(join(s.config, "remote.json"), "{ not json");
	const r = s.run(["remote", "setup", "--no-service"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Nothing was changed; run tabkyra remote off first\./);
	assert.equal(readFileSync(join(s.config, "remote.json"), "utf8"), "{ not json");
	assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")));
});

test("remote setup --public-url refuses while Funnel on 8443 is on or can't be read", () => {
	const on = remoteScenario("custom-stray", { serveStatus: JSON.stringify({ Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } }) });
	const r = on.run(["remote", "setup", "--public-url", "https://tabkyra.example.com", "--no-service"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Funnel on 8443 is on; run tabkyra remote off first/);
	assert.equal(on.hasRemoteJson(), false);
	const unreadable = remoteScenario("custom-unreadable", { serveStatus: "oops" });
	const u = unreadable.run(["remote", "setup", "--public-url", "https://tabkyra.example.com", "--no-service"]);
	assert.equal(u.code, 1, u.out);
	assert.match(u.out, /Funnel on 8443 is on \(Couldn't read tailscale serve status.*run tabkyra remote off first/);
	assert.equal(unreadable.hasRemoteJson(), false);
});

serviceTest("remote setup --no-service refuses while a service from an earlier setup is installed", () => {
	const s = remoteScenario("no-service-installed");
	mkdirSync(dirname(s.serviceFile()), { recursive: true });
	writeFileSync(s.serviceFile(), "# an earlier service\n");
	const r = s.run(["remote", "setup", "--no-service", "--port", "9124"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Run tabkyra remote off first\. Nothing was changed\./);
	assert.equal(s.hasRemoteJson(), false);
	assert.equal(readFileSync(s.serviceFile(), "utf8"), "# an earlier service\n");
});

test("serve with no flags reads remote.json: its public URL and port; --port wins", async () => {
	const s = remoteScenario("serve-reads");
	const port = await freePort();
	const publicUrl = `http://127.0.0.1:${port}`;
	assert.equal(s.run(["remote", "setup", "--public-url", publicUrl, "--port", String(port), "--no-service"]).code, 0);
	const srv = await startServe(s, []);
	try {
		const prm = await (await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`)).json();
		assert.equal(prm.resource, `${publicUrl}/mcp`);
	} finally {
		srv.kill();
	}
	const other = await freePort();
	const flagged = await startServe(s, ["--port", String(other)]);
	try {
		const prm = await (await fetch(`http://127.0.0.1:${other}/.well-known/oauth-protected-resource/mcp`)).json();
		assert.equal(prm.resource, `${publicUrl}/mcp`, "--port wins; the public URL still comes from remote.json");
	} finally {
		flagged.kill();
	}
});

test("remote status --json reports a tailnet-only DNS answer as failed, and a public one as ok", async () => {
	const s = remoteScenario("status");
	const port = await freePort();
	const publicUrl = `http://localhost:${port}`;
	assert.equal(s.run(["remote", "setup", "--public-url", publicUrl, "--port", String(port), "--no-service"]).code, 0);
	let answer = "100.64.1.2";
	const queries = [];
	const doh = createHttpServer((req, res) => {
		queries.push({ url: req.url, accept: req.headers.accept });
		res.setHeader("content-type", "application/dns-json");
		res.end(JSON.stringify({ Status: 0, Answer: [{ name: "localhost", type: 1, TTL: 60, data: answer }] }));
	});
	await new Promise((resolve) => doh.listen(0, "127.0.0.1", resolve));
	const dohUrl = `http://127.0.0.1:${doh.address().port}/dns-query`;
	const byName = (report, name) => report.checks.find((x) => x.name === name);
	try {
		const down = JSON.parse((await runAsync(s, ["remote", "status", "--json"], { TABKYRA_DOH_URL: dohUrl })).out);
		assert.equal(byName(down, "remote.json").status, "ok");
		assert.equal(byName(down, "passcode").status, "ok");
		assert.equal(byName(down, "local serve").status, "fail", "serve isn't running yet");
		assert.equal(byName(down, "public DNS").status, "fail");
		assert.match(byName(down, "public DNS").detail, /100\.64\.1\.2/);
		assert.equal(down.ok, false);
		assert.deepEqual(queries[0], { url: "/dns-query?name=localhost&type=A", accept: "application/dns-json" });
		assert.equal((await runAsync(s, ["remote", "status"], { TABKYRA_DOH_URL: dohUrl })).code, 1);

		const srv = await startServe(s, []);
		try {
			const stillDown = JSON.parse((await runAsync(s, ["remote", "status", "--json"], { TABKYRA_DOH_URL: dohUrl })).out);
			assert.equal(byName(stillDown, "local serve").status, "ok");
			assert.equal(byName(stillDown, "public fetch").status, "ok");
			assert.equal(byName(stillDown, "public DNS").status, "fail", "the public fetch passing doesn't hide a tailnet-only name");
			answer = "203.0.113.9";
			const up = await runAsync(s, ["remote", "status", "--json"], { TABKYRA_DOH_URL: dohUrl });
			assert.equal(up.code, 0, up.out);
			const report = JSON.parse(up.out);
			assert.equal(byName(report, "public DNS").status, "ok");
			assert.equal(report.ok, true);
			assert.equal(report.oauthClients, 0);
			assert.equal(report.route, "custom");
		} finally {
			srv.kill();
		}
	} finally {
		doh.close();
	}
});

test("remote status without remote.json fails and says to run setup", () => {
	const s = remoteScenario("status-empty");
	const r = s.run(["remote", "status"]);
	assert.equal(r.code, 1);
	assert.match(r.out, /not found\. Run tabkyra remote setup/);
});

const stopCall = process.platform === "linux" ? "systemctl --user disable --now tabkyra-serve.service" : `launchctl bootout gui/${process.getuid?.()}/com.tabkyra.serve`;
const proxyStatus = (port) => JSON.stringify({ Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });

/** Set up Funnel plus a service in a scenario whose tailscale already shows our handler on 8443. */
async function funnelWithService(name, options = {}) {
	const port = await freePort();
	const s = remoteScenario(name, { serveStatus: proxyStatus(port), ...options });
	s.launcher();
	const local = await localServer(`${FUNNEL_URL}/mcp`, port);
	try {
		assert.equal((await runAsync(s, ["remote", "setup", "--port", String(port)])).code, 0);
	} finally {
		await local.close();
	}
	return { s, port };
}

serviceTest("remote off turns Funnel off first, then removes the service and remote.json, and keeps oauth.json", async () => {
	const { s } = await funnelWithService("off");
	assert.ok(existsSync(s.serviceFile()));
	const r = s.run(["remote", "off"]);
	assert.equal(r.code, 0, r.out);
	const calls = s.calls();
	assert.ok(calls.includes("tailscale funnel --https=8443 off"), calls.join("\n"));
	assert.ok(calls.indexOf("tailscale funnel --https=8443 off") < calls.indexOf(stopCall), `Funnel closes before the service stops:\n${calls.join("\n")}`);
	assert.equal(existsSync(s.serviceFile()), false);
	assert.equal(s.hasRemoteJson(), false);
	assert.ok(existsSync(join(s.config, "oauth.json")), "grants stay");
	assert.match(r.out, /oauth\.json/);
	assert.match(r.out, /tabkyra token revoke/);
});

serviceTest("remote off leaves the service running and the files in place when Funnel won't turn off", async () => {
	const { s, port } = await funnelWithService("off-funnel-stuck", { funnelOffFails: true });
	const r = s.run(["remote", "off"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Couldn't turn Funnel off: boom/);
	assert.match(r.out, /The service and remote\.json are kept/);
	assert.ok(existsSync(s.serviceFile()), "the service file is kept");
	assert.ok(!s.calls().includes(stopCall), "the service is not stopped while Funnel is open");
	assert.deepEqual(s.remoteJson(), { publicUrl: FUNNEL_URL, port, route: "funnel" });
});

serviceTest("remote off exits 1 and keeps the service file and remote.json when the service won't stop", async () => {
	const { s, port } = await funnelWithService("off-stuck");
	s.failStop();
	const r = s.run(["remote", "off"]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, process.platform === "linux" ? /systemctl --user disable --now tabkyra-serve\.service failed: boom/ : /launchctl bootout failed: boom/);
	assert.match(r.out, /then tabkyra remote off again/);
	assert.ok(existsSync(s.serviceFile()), "the service file is kept");
	assert.deepEqual(s.remoteJson(), { publicUrl: FUNNEL_URL, port, route: "funnel" });
});

test("remote off on a custom route never turns Funnel off and says your own tunnel still forwards", () => {
	const s = remoteScenario("off-custom");
	assert.equal(s.run(["remote", "setup", "--public-url", "https://tabkyra.example.com", "--no-service"]).code, 0);
	const r = s.run(["remote", "off"]);
	assert.equal(r.code, 0, r.out);
	assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")), s.calls().join("\n"));
	assert.equal(s.hasRemoteJson(), false);
	assert.match(r.out, /Your own front door for https:\/\/tabkyra\.example\.com still forwards to this machine\. Stop it there \(for example, stop cloudflared\)/);
});

test("remote off on a custom route also closes a Funnel on 8443 that proxies to Tabkyra", async () => {
	const port = await freePort();
	const s = remoteScenario("off-custom-stray");
	assert.equal(s.run(["remote", "setup", "--public-url", "https://tabkyra.example.com", "--no-service"]).code, 0);
	const withFunnel = remoteScenario("off-custom-stray", { serveStatus: proxyStatus(port) });
	const local = await localServer("https://tabkyra.example.com/mcp", port);
	try {
		const r = await runAsync(withFunnel, ["remote", "off"]);
		assert.equal(r.code, 0, r.out);
		assert.ok(withFunnel.calls().includes("tailscale funnel --https=8443 off"), withFunnel.calls().join("\n"));
	} finally {
		await local.close();
	}
});

test("remote off with an unreadable remote.json turns off a Funnel that proxies to Tabkyra, then deletes the file", async () => {
	const port = await freePort();
	const s = remoteScenario("off-bad-file", { serveStatus: proxyStatus(port) });
	mkdirSync(s.config, { recursive: true });
	writeFileSync(join(s.config, "remote.json"), "{ not json");
	const local = await localServer(`${FUNNEL_URL}/mcp`, port);
	try {
		const r = await runAsync(s, ["remote", "off"]);
		assert.equal(r.code, 0, r.out);
		assert.ok(s.calls().includes("tailscale funnel --https=8443 off"), s.calls().join("\n"));
		assert.equal(s.hasRemoteJson(), false);
	} finally {
		await local.close();
	}
});

test("remote off leaves a Funnel on 8443 alone when what it proxies to doesn't answer like Tabkyra", async () => {
	const port = await freePort();
	const foreign = await localServer(undefined, port);
	try {
		const bad = remoteScenario("off-bad-file-foreign", { serveStatus: proxyStatus(port) });
		mkdirSync(bad.config, { recursive: true });
		writeFileSync(join(bad.config, "remote.json"), "{ not json");
		const a = await runAsync(bad, ["remote", "off"]);
		assert.equal(a.code, 1, a.out);
		assert.match(a.out, /not everything there answers like Tabkyra serve, so it was left on/);
		assert.ok(!bad.calls().includes("tailscale funnel --https=8443 off"));
		const none = remoteScenario("off-no-file-foreign", { serveStatus: proxyStatus(port) });
		const b = await runAsync(none, ["remote", "off"]);
		assert.equal(b.code, 1, b.out);
		assert.ok(!none.calls().includes("tailscale funnel --https=8443 off"));
	} finally {
		await foreign.close();
	}
});

test("remote off with no remote.json closes a Tabkyra Funnel on 8443, and says there is nothing to remove when there is none", async () => {
	const port = await freePort();
	const stray = remoteScenario("off-stray", { serveStatus: proxyStatus(port) });
	const local = await localServer(`${FUNNEL_URL}/mcp`, port);
	try {
		const r = await runAsync(stray, ["remote", "off"]);
		assert.equal(r.code, 0, r.out);
		assert.ok(stray.calls().includes("tailscale funnel --https=8443 off"), stray.calls().join("\n"));
	} finally {
		await local.close();
	}
	const clean = remoteScenario("off-clean");
	const ok = clean.run(["remote", "off"]);
	assert.equal(ok.code, 0, ok.out);
	assert.match(ok.out, /No remote\.json; nothing else to remove\./);
});

test("remote lists its subcommands in help and rejects unknown flags", () => {
	const help = cliRun(["remote", "--help"]).out;
	assert.match(help, /tabkyra remote setup \[--public-url https:\/\/host\] \[--port N\] \[--no-service\]/);
	assert.match(help, /tabkyra remote status \[--json\]/);
	assert.match(help, /tabkyra remote off/);
	assert.equal(cliRun(["remote", "setup", "--bogus"]).code, 2);
	assert.equal(cliRun(["remote"]).code, 2);
});
