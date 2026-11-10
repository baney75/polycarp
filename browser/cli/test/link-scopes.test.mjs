// What a device behind a hub allows (its cap in link.json): computer use only with a yes typed at this computer's
// terminal, never for a computer that can't serve it, narrowing at once, and nothing on the hub's side can write it.
// Real processes as in hub-link.test.mjs. "Computer use is offered" is POLYCARP_SPACES_BIN naming a file that exists;
// "a Linux box" is one naming a file that doesn't.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocketServer } from "ws";
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

test("computer scopes named with --scope, or added later, are refused without a terminal to say yes", async () => {
	const hub = await hubFor("notty-hub");
	const m = deviceMachine("notty-device", { helper: true });
	const c = code(hub, "mac");
	const named = m.run(["link", hub.url, "--code", c, "--scope", "browser.read,computer.act", "--no-service"]);
	assert.equal(named.code, 1);
	assert.match(named.out, /computer\.act lets agents that come through the hub use this computer, so only a yes typed in a terminal on this computer turns it on/);
	assert.equal(linkJson(m), undefined);
	assert.equal(m.run(["link", hub.url, "--code", c, "--no-service", "--json"]).code, 0);
	const before = readFileSync(m.file("link.json"), "utf8");
	for (const args of [
		["link", "scopes", "--add", "computer.read"],
		["link", "scopes", "--add", "computer.act", "--json"],
	]) {
		const r = m.run(args);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /There is no terminal here to answer, so nothing was changed/);
	}
	assert.equal(readFileSync(m.file("link.json"), "utf8"), before, "link.json is unchanged");
	// Shown, and other scopes still change without a question.
	assert.match(m.run(["link", "scopes"]).out, /Computer use is off here/);
	assert.equal(m.run(["link", "scopes", "--add", "browser.script"]).code, 0);
	assert.ok(linkJson(m).scopes.includes("browser.script"));
});

test("at a terminal: no is the default, and yes adds computer use", async (t) => {
	const hub = await hubFor("tty-hub");
	const m = deviceMachine("tty-device", { helper: true });
	assert.equal(m.run(["link", hub.url, "--code", code(hub, "ttymac"), "--no-service", "--json"]).code, 0);
	const declined = atTerminal(m, ["link", "scopes", "--add", "computer.act"], "");
	if (!declined) return t.skip("python3 with pty isn't here");
	assert.equal(declined.code, 1, declined.out);
	assert.match(declined.out, /click and type in them\?/);
	assert.deepEqual(linkJson(m).scopes, DEFAULT_CAP, "Enter is no");
	const yes = atTerminal(m, ["link", "scopes", "--add", "computer.act"], "y");
	assert.equal(yes.code, 0, yes.out);
	assert.deepEqual(linkJson(m).scopes, [...DEFAULT_CAP, "computer.read", "computer.act"], "act brings read with it");
	// Enrolling at a terminal asks once; Enter keeps computer use off.
	const fresh = deviceMachine("tty-enroll", { helper: true });
	const enrolled = atTerminal(fresh, ["link", hub.url, "--code", code(hub, "ttyfresh"), "--no-service"], "");
	assert.equal(enrolled.code, 0, enrolled.out);
	assert.match(enrolled.out, /May agents that come through the hub use this computer\?/);
	assert.deepEqual(linkJson(fresh).scopes, DEFAULT_CAP);
	const reader = deviceMachine("tty-enroll-read", { helper: true });
	assert.equal(atTerminal(reader, ["link", hub.url, "--code", code(hub, "ttyreader"), "--no-service"], "r").code, 0);
	assert.deepEqual(linkJson(reader).scopes, [...DEFAULT_CAP, "computer.read"]);
});

test("remove narrows at once: the next call that needs it gets the cap error, and new sessions don't get its tools", async () => {
	const hub = await hubFor("remove-hub");
	const device = await addDevice(root, hub, "narrow", { scope: "browser.read,skills.read" });
	cleanup.push(() => device.kill());
	const secret = createToken(hub, "caller", "browser.read,skills.read");
	const { client } = await connect(`${hub.url}/mcp`, secret);
	cleanup.push(() => client.close());
	const task = { task: "background check on a roofing contractor" };
	assert.match((await client.callTool({ name: "skill_match", arguments: task })).content[0].text, /^osint /);
	const removed = device.run(["link", "scopes", "--remove", "skills.read"]);
	assert.equal(removed.code, 0, removed.out);
	const refused = await client.callTool({ name: "skill_match", arguments: task });
	assert.equal(refused.isError, true);
	assert.equal(refused.content[0].text, "narrow doesn't allow skills.read (allows: browser.read). Only its owner can add it, on narrow.");
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
