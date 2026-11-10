// What a device behind a hub allows (its cap in link.json): the CLI never grants computer use, not even at a real
// terminal, and never for a computer that can't serve it, narrowing at once, and nothing on the hub's side can write it.
// Real processes as in hub-link.test.mjs. "Computer use is offered" is POLYCARP_SPACES_BIN naming a file that exists;
// "a Linux box" is one naming a file that doesn't.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocketServer } from "ws";
import { loadTs } from "./helpers/bundle-ts.mjs";
import { addDevice, cli, connect, createToken, DEFAULT_CAP, endProcess, freePort, INITIALIZE, machine, rawTools, sleep, startHub, teardown, tempRoot } from "./helpers/hub-fixture.mjs";

const root = tempRoot("tabkyra-linkscopes-");
const cleanup = [];
after(() => teardown(cleanup, root));

async function hubFor(name) {
	const hub = await startHub(root, name);
	cleanup.push(() => hub.stop());
	return hub;
}
async function waitFor(check, what, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await check();
		if (v) return v;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** A device machine where computer use is offered (`helper: true`) or not. */
function deviceMachine(name, { helper }) {
	const m = machine(root, name);
	mkdirSync(m.config, { recursive: true });
	const bin = join(root, name, "polycarp-spaces");
	if (helper) writeFileSync(bin, "");
	m.env.POLYCARP_SPACES_BIN = bin;
	return m;
}
const code = (hub, name) => hub.json(["hub", "code", "--name", name, "--json"]).code;
const linkJson = (m) => (existsSync(m.file("link.json")) ? JSON.parse(readFileSync(m.file("link.json"), "utf8")) : undefined);

/** Run the CLI on a pseudo-terminal and type `answer` once the question shows. Undefined without python3. */
function atTerminal(m, args, answer) {
	if (spawnSync("python3", ["-c", "import pty"]).status !== 0) return undefined;
	const script = `
import json, os, pty, sys, time
argv, env, answer = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, env)
out = b""
sent = False
deadline = time.time() + 30
while time.time() < deadline:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not sent and (b"[y/N]" in out or b"[N]o" in out):
        os.write(fd, answer.encode() + b"\\r")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;
	const r = spawnSync("python3", ["-c", script, JSON.stringify([[process.execPath, cli, ...args], m.env, answer])], { encoding: "utf8", timeout: 40_000 });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a default link has no computer scope, even where computer use is offered", async () => {
	const hub = await hubFor("default-hub");
	const m = deviceMachine("default-device", { helper: true });
	const r = m.run(["link", hub.url, "--code", code(hub, "plain"), "--no-service", "--json"]);
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(linkJson(m).scopes, DEFAULT_CAP);
	assert.ok(!linkJson(m).scopes.some((s) => s.startsWith("computer.")));
});

test("a computer without Polycarp's Mac app can't claim computer use, and the code stays unspent", async () => {
	const hub = await hubFor("linux-hub");
	const m = deviceMachine("linux-device", { helper: false });
	const c = code(hub, "linuxbox");
	const r = m.run(["link", hub.url, "--code", c, "--scope", "browser.read,computer.read", "--no-service"]);
	assert.equal(r.code, 1);
	assert.match(r.out, /This computer can't serve computer\.read: computer use needs Polycarp's Mac app, and it isn't on this computer\. Nothing was changed\./);
	assert.equal(linkJson(m), undefined, "nothing was written");
	assert.equal(m.run(["link", hub.url, "--code", c, "--no-service", "--json"]).code, 0, "the code was never sent, so it still works");
	assert.equal(m.run(["link", "scopes", "--add", "computer.act"]).code, 1, "nor can it be added after linking");
	assert.deepEqual(linkJson(m).scopes, DEFAULT_CAP);
});

const NOT_GRANTABLE = /can't be turned on from the command line: granting computer use over a link needs the owner's approval in the Polycarp app, and that approval isn't built yet\. Nothing was changed\./;

test("no CLI path grants a computer scope, and nothing is written", async () => {
	const hub = await hubFor("notty-hub");
	const m = deviceMachine("notty-device", { helper: true });
	const c = code(hub, "mac");
	for (const scope of ["browser.read,computer.act", "computer.read", "browser.read,computer.read,computer.act"]) {
		for (const json of [false, true]) {
			const named = m.run(["link", hub.url, "--code", c, "--scope", scope, "--no-service", ...(json ? ["--json"] : [])]);
			assert.equal(named.code, 1, named.out);
			assert.match(named.out, NOT_GRANTABLE);
			assert.equal(linkJson(m), undefined, `nothing was written for --scope ${scope}`);
		}
	}
	assert.equal(m.run(["link", hub.url, "--code", c, "--no-service", "--json"]).code, 0, "the refused code was never sent, so it still works");
	const before = readFileSync(m.file("link.json"), "utf8");
	for (const args of [
		["link", "scopes", "--add", "computer.read"],
		["link", "scopes", "--add", "computer.act"],
		["link", "scopes", "--add", "computer.act", "--json"],
	]) {
		const r = m.run(args);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, NOT_GRANTABLE);
	}
	assert.equal(readFileSync(m.file("link.json"), "utf8"), before, "link.json is unchanged");
	assert.match(m.run(["link", "scopes"]).out, /Computer use is off here\. It can't be turned on from the command line/);
	assert.equal(m.run(["link", "scopes", "--add", "browser.script"]).code, 0, "other scopes still change");
	assert.ok(linkJson(m).scopes.includes("browser.script"));
});

test("under a real pseudo-terminal a typed yes grants nothing: every add path still refuses", async (t) => {
	const hub = await hubFor("tty-hub");
	const m = deviceMachine("tty-device", { helper: true });
	assert.equal(m.run(["link", hub.url, "--code", code(hub, "ttymac"), "--no-service", "--json"]).code, 0);
	const before = readFileSync(m.file("link.json"), "utf8");
	const added = atTerminal(m, ["link", "scopes", "--add", "computer.act"], "y");
	if (!added) return t.skip("python3 with pty isn't here");
	assert.equal(added.code, 1, added.out);
	assert.match(added.out.replace(/\r?\n/g, " "), NOT_GRANTABLE);
	assert.doesNotMatch(added.out, /\[y\/N\]|\[N\]o/, "no question is asked");
	assert.equal(readFileSync(m.file("link.json"), "utf8"), before, "link.json is unchanged");
	for (const scope of ["computer.act", "computer.read"]) {
		const fresh = deviceMachine(`tty-enroll-${scope}`, { helper: true });
		const c = code(hub, `tty${scope.split(".")[1]}`);
		const named = atTerminal(fresh, ["link", hub.url, "--code", c, "--scope", scope, "--no-service"], "y");
		assert.equal(named.code, 1, named.out);
		assert.match(named.out.replace(/\r?\n/g, " "), NOT_GRANTABLE);
		assert.equal(linkJson(fresh), undefined, `nothing was written for --scope ${scope}`);
	}
	// A plain link at a terminal asks nothing and links with the default grant.
	const plain = deviceMachine("tty-enroll-plain", { helper: true });
	const enrolled = atTerminal(plain, ["link", hub.url, "--code", code(hub, "ttyplain"), "--no-service"], "a");
	assert.equal(enrolled.code, 0, enrolled.out);
	assert.doesNotMatch(enrolled.out, /use this computer\?/);
	assert.deepEqual(linkJson(plain).scopes, DEFAULT_CAP);
});

test("a cap that already holds computer scopes keeps them, and removing one still works", async () => {
	const m = deviceMachine("old-cap", { helper: true });
	const scopes = [...DEFAULT_CAP, "computer.read", "computer.act"];
	writeFileSync(m.file("link.json"), JSON.stringify({ hubUrl: "http://127.0.0.1:9", deviceId: "dv-oldoldoldold", secret: "s".repeat(43), name: "oldmac", manage: false, scopes }));
	assert.deepEqual(JSON.parse(m.run(["link", "scopes", "--json"]).out).scopes, scopes);
	const removed = m.run(["link", "scopes", "--remove", "computer.act"]);
	assert.equal(removed.code, 0, removed.out);
	assert.deepEqual(linkJson(m).scopes, [...DEFAULT_CAP, "computer.read"]);
	assert.equal(m.run(["link", "scopes", "--add", "computer.act"]).code, 1, "and it can't be added back");
	assert.deepEqual(linkJson(m).scopes, [...DEFAULT_CAP, "computer.read"]);
});

test("the cap helpers: an empty stored cap allows nothing, removal is checked under the lock, calls are judged on the parsed method", async () => {
	const mod = await loadTs(`export { capOf, refusedCall, removeScope } from "@src/link.ts"; export { DEFAULT_GRANT } from "@src/oauth.ts";`);
	assert.deepEqual(mod.capOf({ scopes: [] }), [], "an explicit empty cap grants nothing");
	assert.deepEqual(mod.capOf({}), mod.DEFAULT_GRANT, "only an absent cap is the default");
	// refusedCall decodes the method: escaped slashes are the same method, and a batch is refused for that entry.
	const call = (method, id = 2) => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{"name":"skill_match","arguments":{}}}`;
	for (const body of [call("tools/call"), call("tools\\/call"), call("tools\\u002fcall")]) {
		const refused = mod.refusedCall(body, ["browser.read"]);
		assert.ok(refused, body);
		assert.match(JSON.parse(refused).result.content[0].text, /doesn't allow skills\.read \(allows: browser\.read\)/);
	}
	const batch = `[{"jsonrpc":"2.0","id":1,"method":"tools/list"},${call("tools\\/call", 2)}]`;
	const answers = JSON.parse(mod.refusedCall(batch, ["browser.read"]));
	assert.deepEqual(answers.map((a) => [a.id, a.result.isError]), [[1, true], [2, true]]);
	assert.equal(mod.refusedCall(call("tools\\/call"), ["skills.read"]), undefined, "allowed is let through");
	assert.equal(mod.refusedCall("{not json tools/call", ["browser.read"]), undefined, "unparseable passes to the local server");
	// Two removals that both passed the unlocked two-scope look: one wins, the other is refused, one scope is left.
	const m = deviceMachine("race-device", { helper: false });
	const write = () => writeFileSync(m.file("link.json"), JSON.stringify({ hubUrl: "http://127.0.0.1:9", deviceId: "dv-raceraceracer", secret: "s".repeat(43), name: "race", manage: false, scopes: ["browser.read", "skills.read"] }));
	const saved = process.env.POLYCARP_BROWSER_CONFIG_DIR;
	process.env.POLYCARP_BROWSER_CONFIG_DIR = m.config;
	try {
		write();
		assert.deepEqual(await mod.removeScope("browser.read"), ["skills.read"]);
		await assert.rejects(mod.removeScope("skills.read"), /is the only thing this device allows/);
		assert.deepEqual(linkJson(m).scopes, ["skills.read"], "in sequence");
		write();
		const both = await Promise.allSettled([mod.removeScope("browser.read"), mod.removeScope("skills.read")]);
		assert.deepEqual(both.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
		assert.equal(linkJson(m).scopes.length, 1, "at once");
	} finally {
		if (saved === undefined) delete process.env.POLYCARP_BROWSER_CONFIG_DIR;
		else process.env.POLYCARP_BROWSER_CONFIG_DIR = saved;
	}
});

test("remove narrows at once: the next call that needs it gets the cap error, and new sessions don't get its tools", async () => {
	const hub = await hubFor("remove-hub");
	const device = await addDevice(root, hub, "narrow", { scope: "browser.read,skills.read" });
	cleanup.push(() => device.kill());
	const secret = createToken(hub, "caller", "browser.read,skills.read");
	const { client, transport } = await connect(`${hub.url}/mcp`, secret);
	cleanup.push(() => client.close());
	const task = { task: "background check on a roofing contractor" };
	assert.match((await client.callTool({ name: "skill_match", arguments: task })).content[0].text, /^osint /);
	const removed = device.run(["link", "scopes", "--remove", "skills.read"]);
	assert.equal(removed.code, 0, removed.out);
	const refused = await client.callTool({ name: "skill_match", arguments: task });
	assert.equal(refused.isError, true);
	assert.equal(refused.content[0].text, "narrow doesn't allow skills.read (allows: browser.read). Only its owner can add it, on narrow.");
	// The same call on the open session with its method written with an escaped slash, alone and in a batch, is refused too.
	const raw = async (text) => {
		const res = await fetch(`${hub.url}/mcp`, {
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": transport.sessionId, "mcp-protocol-version": "2025-06-18" },
			body: text,
		});
		const body = await res.text();
		return JSON.parse(body.trimStart().startsWith("{") || body.trimStart().startsWith("[") ? body : body.split("\n").find((l) => l.startsWith("data: ")).slice(6));
	};
	const call = (method, id) => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{"name":"skill_match","arguments":${JSON.stringify(task)}}}`;
	for (const [i, method] of ["tools\\/call", "tools\\u002fcall", "tools/call"].entries()) {
		const answer = await raw(call(method, 100 + i));
		assert.equal(answer.result?.isError, true, `${method}: ${JSON.stringify(answer)}`);
		assert.match(answer.result.content[0].text, /narrow doesn't allow skills\.read/);
	}
	const batch = await raw(`[{"jsonrpc":"2.0","id":200,"method":"tools/list"},${call("tools\\/call", 201)}]`);
	const entry = (Array.isArray(batch) ? batch : [batch]).find((a) => a.id === 201);
	assert.equal(entry?.result?.isError, true, JSON.stringify(batch));
	assert.match(entry.result.content[0].text, /doesn't allow skills\.read/);
	const fresh = await rawTools(`${hub.url}/mcp`, secret);
	assert.ok(!fresh.tools.includes("skill_match") && fresh.tools.includes("read_page"), "a new session gets the narrower cap");
	assert.equal(device.run(["link", "scopes", "--remove", "browser.read"]).code, 1, "the last scope can't be removed; link off stops serving");
});

test("no hub frame can write this device's scopes", async () => {
	const m = deviceMachine("frames-device", { helper: true });
	const port = await freePort();
	const wss = new WebSocketServer({ port, host: "127.0.0.1" });
	cleanup.push(() => wss.close());
	const scopes = ["skills.read", "browser.read"];
	writeFileSync(m.file("link.json"), JSON.stringify({ hubUrl: `http://127.0.0.1:${port}`, deviceId: "dv-fakefakefake", secret: "s".repeat(43), name: "frames", manage: false, scopes }));
	const before = readFileSync(m.file("link.json"), "utf8");
	const frames = [];
	const connected = new Promise((resolve) =>
		wss.on("connection", (ws) => {
			ws.on("message", (data) => frames.push(JSON.parse(data.toString("utf8"))));
			resolve(ws);
		}),
	);
	const proc = spawn(process.execPath, [cli, "link", "run"], { env: m.env });
	cleanup.push(() => endProcess(proc));
	const ws = await connected;
	await waitFor(() => frames.some((f) => f.t === "status"), "the device's first status");
	const linkRecord = () => JSON.parse(readFileSync(m.file("tokens.json"), "utf8")).tokens.find((t) => t.kind === "link" && !t.revokedAt);
	const tokenScopes = linkRecord().scopes;
	const all = "browser.read,browser.navigate,browser.act,browser.script,computer.read,computer.act,skills.read,threads.read";
	const hubHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-polycarp-hub-scopes": all, "x-polycarp-hub-caller": "tester" };
	const send = (f) => ws.send(typeof f === "string" ? f : JSON.stringify(f));
	const everything = [
		{ t: "req", id: "i1", method: "POST", path: "/mcp", headers: hubHeaders, body: JSON.stringify(INITIALIZE) },
		{ t: "req", id: "c1", method: "POST", path: "/mcp", headers: { ...hubHeaders, "mcp-session-id": "nope" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "computer_click", arguments: {} } }) },
		{ t: "req", id: "g1", method: "GET", path: "/mcp", headers: hubHeaders, body: "" },
		{ t: "req", id: "d1", method: "DELETE", path: "/mcp", headers: { ...hubHeaders, "mcp-session-id": "nope" }, body: "" },
		{ t: "cancel", id: "g1" },
		{ t: "roster", devices: [{ id: "dv-fakefakefake", name: "frames", online: true, lastSeen: null, scopes: all.split(","), computer: true, extension: true, platform: "darwin" }] },
		{ t: "scopes", scopes: all.split(",") },
		{ t: "config", scopes: all.split(","), link: { scopes: all.split(",") } },
		{ t: "status", extensionConnected: true, sessions: 0, busy: false, version: "9", browser: null, sessionCap: 24, scopes: all.split(",") },
		{ t: "head", id: "i1", status: 200, headers: {} },
		"not json",
	];
	for (const f of everything) send(f);
	await waitFor(() => frames.some((f) => f.t === "end" && f.id === "i1"), "the initialize to finish");
	await sleep(500);
	assert.equal(readFileSync(m.file("link.json"), "utf8"), before, "link.json is byte for byte the same");
	assert.deepEqual(linkRecord().scopes, tokenScopes, "the link token's scopes are the same");
	const status = frames.filter((f) => f.t === "status").at(-1);
	assert.deepEqual(status.scopes, scopes, "and the device still reports only its own cap");
	// The initialize that asked for everything got only the cap's tools.
	const sid = frames.find((f) => f.t === "head" && f.id === "i1").headers["mcp-session-id"];
	send({ t: "req", id: "l1", method: "POST", path: "/mcp", headers: { ...hubHeaders, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
	await waitFor(() => frames.some((f) => f.t === "end" && f.id === "l1"), "the tool list");
	const body = frames.filter((f) => f.t === "chunk" && f.id === "l1").map((f) => f.data).join("");
	const json = body.trimStart().startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data: ")).slice(6);
	const tools = JSON.parse(json).result.tools.map((x) => x.name);
	assert.ok(tools.includes("skill_match") && tools.includes("read_page"));
	assert.ok(!tools.some((x) => x.startsWith("computer_") || x === "click" || x === "run_js"), tools.join(","));
});
