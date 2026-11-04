#!/usr/bin/env node
// Bridge and MCP measures that need no model, so they are cheap to repeat after every change:
//
//   tools     the tools/list payload and server instructions an agent pays for on every turn
//             (bytes, and with --claude the real input-token cost measured through `claude -p`)
//   launcher  `tabkyra mcp` started through the launcher harness configs run (~/.config/tabkyra/
//             tabkyra): 15 interleaved starts per arm, with and without Node's compile cache,
//             median and interquartile range
//   cold      cold start: spawn `tabkyra mcp` -> initialize -> first tool result
//   reload    a read and a click sent while the extension reloads, and a read sent while the
//             native host restarts: did each succeed, fail with a clear error, or hang, and did
//             the click run twice?
//   multi     three MCP clients started at once in one project: separate groups, labels that
//             say which agent and project, no tab seen by the wrong client
//   groups    tab group behavior: identity, colors, and what the user's gestures do (close the
//             group, drag a tab out or in, collapse, ungroup), reloads, a tab cap, a closed window
//
//   node cli/eval/bridge-metrics.mjs [--only tools,launcher,cold,reload,multi,groups] [--cycles 3] [--claude] [--out file.json]
//
// Needs the built extension (npm run build) and CLI (cd cli && npm run build) and Playwright's
// Chromium. --claude also needs a signed-in `claude` CLI (subscription; no API key is used).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cli, launchFixtureBrowser, sleep, until } from "./fixture-browser.mjs";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : fallback;
};
const ONLY = new Set((arg("--only", "tools,launcher,cold,reload,multi,groups") ?? "").split(","));
const CYCLES = Number(arg("--cycles", "3"));
const OUT = arg("--out", join(tmpdir(), "tabkyra-bridge-metrics.json"));
const CLAUDE = process.argv.includes("--claude");
/** A call that has not answered by now counts as a hang. */
const HANG_MS = 90000;

// ---- fixture ---------------------------------------------------------------

let hits = 0;
const server = createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	if (req.method === "POST" && url.pathname === "/api/hit") {
		hits++;
		res.end(String(hits));
		return;
	}
	res.writeHead(200, { "content-type": "text/html" });
	if (url.pathname === "/counter")
		res.end(`<!doctype html><title>Counter</title><button id="hit" onclick="fetch('/api/hit',{method:'POST'}).then(r=>r.text()).then(t=>document.getElementById('n').textContent=t)">Hit</button><p id="n">0</p><p id="late"></p><script>setTimeout(()=>{document.getElementById('late').textContent='ready now'},2500)</script>`);
	else res.end(`<!doctype html><title>Page ${url.searchParams.get("agent") ?? ""}</title><h1>Agent page ${url.searchParams.get("agent") ?? ""}</h1>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}`;

const results = { at: new Date().toISOString() };
/** Temp directories to remove however the run ends. */
const temps = [];
/** The throwaway browser, once launched. */
let fx;

// Registered before anything is launched: the browser, the fixture server and the temp
// directories go away however the run ends, an early failure included.
async function cleanup() {
	await fx?.close().catch(() => {});
	server.close();
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}
for (const event of ["uncaughtException", "unhandledRejection"])
	process.on(event, async (err) => {
		console.error(err);
		await cleanup();
		process.exit(1);
	});

async function mcpClient(env, { cwd, name = "metrics" } = {}) {
	const client = new Client({ name, version: "0.0.0" });
	const t0 = performance.now();
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, cwd, stderr: "ignore" }));
	return { client, initMs: Math.round(performance.now() - t0) };
}

/** One tool call with a hang guard; never throws. */
async function call(client, name, args = {}) {
	const t0 = performance.now();
	let timer;
	const hang = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ hang: true }), HANG_MS);
	});
	const res = await Promise.race([
		client.callTool({ name, arguments: args }, undefined, { timeout: HANG_MS + 5000 }).catch((err) => ({ isError: true, content: [{ type: "text", text: `client error: ${err.message}` }] })),
		hang,
	]);
	clearTimeout(timer);
	const ms = Math.round(performance.now() - t0);
	if (res.hang) return { outcome: "hang", ms, text: "", full: "" };
	const text = (res.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	// Score on `full`; `text` is the short form printed and stored in the report.
	return { outcome: res.isError ? "error" : "ok", ms, text: text.slice(0, 300), full: text };
}

/** Does an error tell the agent what to do next (retry, or check first)? */
const actionable = (text) => /(repeat|retry|try again|call it again|check the page|in a few seconds|reconnect)/i.test(text);

// ---- tools: payload size -----------------------------------------------------

if (ONLY.has("tools")) {
	const home = mkdtempSync(join(tmpdir(), "tk-metrics-"));
	const env = { HOME: home, PATH: process.env.PATH, TABKYRA_SOCKET_DIR: mkdtempSync("/tmp/tkm-") };
	temps.push(home, env.TABKYRA_SOCKET_DIR);
	const { client } = await mcpClient(env);
	const { tools } = await client.listTools();
	const instructions = client.getInstructions() ?? "";
	const toolsJson = JSON.stringify(tools);
	results.tools = {
		count: tools.length,
		toolsListBytes: Buffer.byteLength(toolsJson),
		instructionsBytes: Buffer.byteLength(instructions),
		// Rough: about 4 bytes per token for English and JSON. --claude measures the real number.
		estTokens: Math.round((Buffer.byteLength(toolsJson) + Buffer.byteLength(instructions)) / 4),
		perTool: Object.fromEntries(tools.map((t) => [t.name, Buffer.byteLength(JSON.stringify(t))])),
	};
	await client.close();
	if (CLAUDE) {
		// The real cost: input tokens of a one-word reply with and without the server.
		const cfg = join(home, "mcp.json");
		writeFileSync(cfg, JSON.stringify({ mcpServers: { tabkyra: { command: process.execPath, args: [cli, "mcp"], env } } }));
		const empty = join(home, "empty.json");
		writeFileSync(empty, JSON.stringify({ mcpServers: {} }));
		const cleanEnv = { ...process.env };
		for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete cleanEnv[k];
		const tokens = (config) => {
			const out = spawnSync(
				"claude",
				["-p", "Reply with the single word ok.", "--model", "haiku", "--output-format", "json", "--strict-mcp-config", "--mcp-config", config, "--tools", "", "--no-session-persistence", "--setting-sources", "project", "--disable-slash-commands"],
				{ cwd: home, env: cleanEnv, encoding: "utf8", timeout: 180000 },
			);
			const u = JSON.parse(out.stdout).usage;
			return u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
		};
		const without = tokens(empty);
		const withServer = tokens(cfg);
		results.tools.claudeTokens = withServer - without;
	}
	console.log(`tools: ${results.tools.count} tools, tools/list ${results.tools.toolsListBytes} B, instructions ${results.tools.instructionsBytes} B, ~${results.tools.estTokens} tokens${results.tools.claudeTokens !== undefined ? `, measured ${results.tools.claudeTokens} tokens` : ""}`);
}

// ---- launcher start ------------------------------------------------------------------

if (ONLY.has("launcher")) {
	const home = mkdtempSync(join(tmpdir(), "tk-launcher-"));
	temps.push(home);
	const sock = join(home, "sock");
	mkdirSync(sock, { mode: 0o700 });
	const env = { HOME: home, PATH: process.env.PATH, TABKYRA_SOCKET_DIR: sock };
	// install exits 1 without a browser profile, after it wrote the launcher.
	spawnSync(process.execPath, [cli, "install"], { env, stdio: "ignore" });
	const launcher = join(home, ".config", "tabkyra", "tabkyra");
	const start = async (extra) => {
		const client = new Client({ name: "launcher", version: "0.0.0" });
		const t0 = performance.now();
		await client.connect(new StdioClientTransport({ command: launcher, args: ["mcp"], env: { ...env, ...extra }, stderr: "ignore" }));
		const ms = performance.now() - t0;
		await client.close();
		return ms;
	};
	// Interleaved, so neither arm gets a warmer machine: 15 starts each, alternating which goes first.
	const off = { NODE_DISABLE_COMPILE_CACHE: "1" };
	await start(off);
	await start({}); // warm the disk and write the cache
	const runs = { off: [], on: [] };
	for (let i = 0; i < 15; i++) {
		const order = i % 2 ? ["on", "off"] : ["off", "on"];
		for (const arm of order) runs[arm].push(await start(arm === "off" ? off : {}));
	}
	const stats = (xs) => {
		const s = [...xs].sort((x, y) => x - y);
		const q = (p) => Math.round(s[Math.floor((s.length - 1) * p)]);
		return { median: q(0.5), p25: q(0.25), p75: q(0.75) };
	};
	results.launcher = { noCache: stats(runs.off), cache: stats(runs.on) };
	const f = (x) => `${x.median} ms (IQR ${x.p25}-${x.p75})`;
	console.log(`launcher: tabkyra mcp initialize ${f(results.launcher.noCache)} without the compile cache, ${f(results.launcher.cache)} with it (15 interleaved starts each)`);
}

// ---- the browser ---------------------------------------------------------------

const needsBrowser = ["cold", "reload", "multi", "groups"].some((k) => ONLY.has(k));
fx = needsBrowser ? await launchFixtureBrowser() : undefined;
if (fx) await fx.waitConnected();
const project = needsBrowser ? mkdtempSync(join(tmpdir(), "tk-project-")) : "";
if (project) {
	temps.push(project);
	execFileSync("git", ["init", "-q", project]);
}


// ---- cold start -----------------------------------------------------------------

if (ONLY.has("cold")) {
	const runs = [];
	for (let i = 0; i < 5; i++) {
		const t0 = performance.now();
		const { client, initMs } = await mcpClient({ ...fx.env, TABKYRA_SESSION: `cold-${i}` }, { cwd: project });
		const first = await call(client, "tabs_context");
		const firstMs = Math.round(performance.now() - t0);
		const nav = await call(client, "navigate", { url: `${site}/page?agent=cold${i}` });
		runs.push({ initMs, firstResultMs: firstMs, firstOutcome: first.outcome, navigateMs: nav.ms });
		const tabId = Number(nav.full.match(/"tabId"\s*:\s*(\d+)/)?.[1]);
		// A tab left open here would sit in the groups the later sections count.
		if (!Number.isInteger(tabId)) throw new Error(`cold run ${i}: no tabId in navigate's result: ${nav.text}`);
		await call(client, "tabs_close", { tabId });
		await client.close();
	}
	const median = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
	results.cold = { runs, medianInitMs: median("initMs"), medianFirstResultMs: median("firstResultMs"), medianNavigateMs: median("navigateMs") };
	console.log(`cold: init ${results.cold.medianInitMs} ms, first tool result ${results.cold.medianFirstResultMs} ms, first navigate ${results.cold.medianNavigateMs} ms (median of 5)`);
}

// ---- forced reload and host restart ------------------------------------------------

function hostPid() {
	const socks = readdirSync(fx.socketDir).filter((n) => n.endsWith(".sock"));
	return socks.map((n) => Number.parseInt(n, 10)).find((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
}

/** Reload the extension and return once the old native host is gone (the bridge is down). */
async function reloadAndWaitDown() {
	// A host must be up first: with no pid to watch, "gone" would be true at once.
	const old = await until(async () => hostPid(), 30000, "a native host to watch");
	await fx.reloadExtension({ wait: false });
	await until(async () => {
		try {
			process.kill(old, 0);
			return false;
		} catch {
			return true;
		}
	}, 30000, "the old native host to exit"); // a loaded machine can take a while to reload
}

/** Start `work`, reload the extension `afterMs` into it, and return the call's outcome. */
async function reloadDuring(work, afterMs = 800) {
	const pending = work();
	await sleep(afterMs);
	await fx.reloadExtension({ wait: false });
	return pending;
}

if (ONLY.has("reload")) {
	const { client } = await mcpClient({ ...fx.env, TABKYRA_SESSION: "reload-probe" }, { cwd: project });
	const cycles = [];
	for (let i = 0; i < CYCLES; i++) {
		await fx.waitConnected();
		await call(client, "navigate", { url: `${site}/counter` });
		const row = {};

		// Sent while the bridge is down (extension reloading, no host yet).
		await reloadAndWaitDown();
		row.readWhileDown = await call(client, "read_page", { filter: "interactive" });
		await fx.waitConnected();
		let before = hits;
		await reloadAndWaitDown();
		row.clickWhileDown = await call(client, "click", { selector: "#hit" });
		await fx.waitConnected();
		await sleep(1000);
		row.clickWhileDown.runs = hits - before;

		// In flight when the reload lands: the reply is lost. A click must never run twice.
		await call(client, "tabs_context");
		before = hits;
		row.clickInFlight = await reloadDuring(() => call(client, "actions", { steps: [{ click: { selector: "#hit" } }, { wait: 3000 }] }));
		await fx.waitConnected();
		await sleep(1000);
		row.clickInFlight.runs = hits - before;
		// A read in flight: wait for text the page shows 2.5 s after it loads.
		await call(client, "navigate", { url: `${site}/counter` });
		row.readInFlight = await reloadDuring(() => call(client, "wait", { text: "ready now", timeoutMs: 10000 }), 300);
		await fx.waitConnected();

		// The native host killed (the extension respawns it).
		await call(client, "tabs_context");
		const pid = hostPid();
		if (pid) process.kill(pid, "SIGKILL");
		row.readAfterHostKill = await call(client, "read_page", { filter: "interactive" });
		await fx.waitConnected();

		// After it all: does the session still have its tab?
		const after = await call(client, "tabs_context");
		row.keptTab = /\/counter/.test(after.full);
		cycles.push(row);
		console.log(
			`reload cycle ${i + 1}: ${["readWhileDown", "clickWhileDown", "clickInFlight", "readInFlight", "readAfterHostKill"]
				.map((k) => `${k} ${row[k].outcome} ${row[k].ms}ms${row[k].runs !== undefined ? ` runs=${row[k].runs}` : ""}`)
				.join(" | ")} | tab kept=${row.keptTab}`,
		);
		for (const k of ["readWhileDown", "clickWhileDown", "clickInFlight", "readInFlight", "readAfterHostKill"])
			if (row[k].outcome === "error") console.log(`   ${k}: ${row[k].text.split("\n")[0].slice(0, 200)}`);
	}
	await client.close();
	const all = cycles.flatMap((c) => [c.readWhileDown, c.clickWhileDown, c.clickInFlight, c.readInFlight, c.readAfterHostKill]);
	const reads = cycles.flatMap((c) => [c.readWhileDown, c.readInFlight, c.readAfterHostKill]);
	results.reload = {
		cycles,
		calls: all.length,
		ok: all.filter((c) => c.outcome === "ok").length,
		readsOk: `${reads.filter((c) => c.outcome === "ok").length}/${reads.length}`,
		clearErrors: all.filter((c) => c.outcome === "error" && actionable(c.text)).length,
		unclearErrors: all.filter((c) => c.outcome === "error" && !actionable(c.text)).length,
		hangs: all.filter((c) => c.outcome === "hang").length,
		duplicateClicks: cycles.filter((c) => c.clickWhileDown.runs > 1 || c.clickInFlight.runs > 1).length,
		maxMs: Math.max(...all.map((c) => c.ms)),
		tabKept: cycles.filter((c) => c.keptTab).length,
	};
	const r = results.reload;
	console.log(
		`reload: ${r.calls} calls: ${r.ok} ok (reads ${r.readsOk}), ${r.clearErrors} clear errors, ${r.unclearErrors} unclear errors, ${r.hangs} hangs, ${r.duplicateClicks} cycles with a duplicate click, slowest ${r.maxMs} ms, tab kept ${r.tabKept}/${CYCLES}`,
	);
}

// ---- three agents at once -------------------------------------------------------------

if (ONLY.has("multi")) {
	// Three agents of one harness in one project, no session configured: the common case.
	const env = { ...fx.env, TABKYRA_CLIENT_NAME: "claude" };
	delete env.TABKYRA_SESSION;
	const agents = await Promise.all(["a", "b", "c"].map((id) => mcpClient(env, { cwd: project, name: id }).then((m) => ({ id, ...m }))));
	await Promise.all(agents.map((a) => call(a.client, "navigate", { url: `${site}/page?agent=${a.id}` })));
	const contexts = await Promise.all(agents.map((a) => call(a.client, "tabs_context")));
	const tabs = await fx.tabsWithGroups();
	const mine = agents.map((a, i) => ({
		id: a.id,
		seesOwn: contexts[i].full.includes(`agent=${a.id}`),
		seesOthers: agents.filter((b) => b.id !== a.id).some((b) => contexts[i].full.includes(`agent=${b.id}`)),
		group: tabs.find((t) => t.url.includes(`agent=${a.id}`))?.group ?? null,
	}));
	const groups = new Set(mine.map((m) => m.group));
	const projectName = project.split("/").pop();
	results.multi = {
		agents: mine,
		separateGroups: groups.size === 3 && !groups.has(null),
		crossTalk: mine.filter((m) => m.seesOthers || !m.seesOwn).length,
		labelsNameProject: mine.filter((m) => m.group?.includes(projectName)).length,
	};
	console.log(`multi: separate groups=${results.multi.separateGroups} cross-talk=${results.multi.crossTalk} labels naming the project=${results.multi.labelsNameProject}/3 groups=${[...groups].join(" | ")}`);
	await Promise.all(agents.map((a) => a.client.close()));
}

// ---- tab groups -------------------------------------------------------------------------

/** The session's stored record and its group as the browser sees it. */
async function groupOf(name) {
	const sessions = await fx.storedSessions();
	const s = sessions.find((x) => x.id.endsWith(`-${name}`) || x.id.includes(`-${name}-`));
	if (!s) return { session: undefined, group: undefined };
	const group = s.groupId === undefined ? undefined : await fx.swEval(`chrome.tabGroups.get(${s.groupId}).catch(() => null)`);
	return { session: s, group: group ?? undefined };
}

const pageTabs = async (filter) => (await fx.tabsWithGroups()).filter((t) => t.url.startsWith(site) && (!filter || t.url.includes(filter)));

if (ONLY.has("groups")) {
	const checks = {};
	const check = (id, pass, detail) => {
		checks[id] = { pass: Boolean(pass), detail };
		console.log(`groups ${pass ? "PASS" : "FAIL"} ${id}: ${detail}`);
	};
	const projectName = project.split("/").pop();
	// Every check, declared up front: the score is always out of these thirteen. A scenario that
	// throws fails the checks it hadn't reached, not the others.
	const ALL = {
		identity: ["identity", "stable-after-reload", "resume-same-project", "resume-keeps-color"],
		colors: ["distinct-colors"],
		close: ["close-group-ends-session"],
		"drag-out": ["drag-out-hands-to-user", "drag-out-agent-told"],
		"drag-in": ["drag-in-gives-to-agent"],
		collapse: ["collapse-respected"],
		ungroup: ["ungroup-releases"],
		cap: ["tab-cap"],
		window: ["window-close-survives"],
	};
	const scenario = async (label, fn) => {
		try {
			await fn();
		} catch (err) {
			for (const id of ALL[label]) if (!checks[id]) check(id, false, `threw: ${err.message.slice(0, 160)}`);
		}
	};
	const agent = async (session, extra = {}) =>
		(await mcpClient({ ...fx.env, TABKYRA_CLIENT_NAME: "claude", ...(session ? { TABKYRA_SESSION: session } : {}), ...extra }, { cwd: project })).client;

	// Identity, and stability across a reload and a restart of the harness.
	await scenario("identity", async () => {
		const env = { ...fx.env, TABKYRA_CLIENT_NAME: "claude" };
		delete env.TABKYRA_SESSION;
		let c = (await mcpClient(env, { cwd: project })).client;
		await call(c, "navigate", { url: `${site}/page?agent=identity` });
		const tab = (await pageTabs("agent=identity"))[0];
		check("identity", tab?.group?.includes("claude") && tab?.group?.includes(projectName), `title ${JSON.stringify(tab?.group)} (project ${projectName})`);
		const color = (await fx.swEval(`chrome.tabs.get(${tab.id}).then((t) => chrome.tabGroups.get(t.groupId)).then((g) => g.color)`)) ?? null;
		await fx.reloadExtension();
		await call(c, "tabs_context");
		const titled = (await fx.swEval("chrome.tabGroups.query({})")).filter((g) => g.title === tab.group);
		const after = (await pageTabs("agent=identity"))[0];
		check("stable-after-reload", titled.length === 1 && after?.group === tab.group, `${titled.length} group(s) titled ${JSON.stringify(tab.group)} after reload; tab now in ${JSON.stringify(after?.group)}`);
		await c.close();
		c = (await mcpClient(env, { cwd: project })).client;
		const ctx = await call(c, "tabs_context");
		const resumedColor = await fx.swEval(`chrome.tabs.get(${tab.id}).then((t) => t.groupId === -1 ? null : chrome.tabGroups.get(t.groupId)).then((g) => g && g.color)`);
		const resumed = ctx.full.includes("agent=identity");
		check("resume-same-project", resumed, "a new harness process in the same project sees the old tab");
		check("resume-keeps-color", resumed && resumedColor === color, `resumed ${resumed}; color ${color} -> ${resumedColor}`);
		await c.close();
	});

	// Distinct colors for concurrent sessions.
	await scenario("colors", async () => {
		const cs = await Promise.all(["c1", "c2", "c3", "c4"].map((n) => agent(`colors-${n}`)));
		await Promise.all(cs.map((c, i) => call(c, "navigate", { url: `${site}/page?agent=color${i}` })));
		const colors = [];
		for (let i = 0; i < cs.length; i++) colors.push((await groupOf(`colors-c${i + 1}`)).group?.color);
		check("distinct-colors", new Set(colors).size === colors.length, colors.join(","));
		await Promise.all(cs.map((c) => c.close()));
	});

	// The user closes the whole group.
	await scenario("close", async () => {
		const c = await agent("gesture-close");
		await call(c, "navigate", { url: `${site}/page?agent=close1` });
		await call(c, "tabs_create", { url: `${site}/page?agent=close2` });
		const { session } = await groupOf("gesture-close");
		await fx.swEval(`chrome.tabs.remove(${JSON.stringify(session.tabIds)})`);
		await sleep(1500);
		const gone = !(await groupOf("gesture-close")).session;
		const next = await call(c, "read_page");
		check("close-group-ends-session", gone, `record ${gone ? "gone" : "still stored"}; next call: ${next.outcome} ${next.text.slice(0, 120)}`);
		await c.close();
	});

	// The user drags a tab out of the group (ungroups it).
	await scenario("drag-out", async () => {
		const c = await agent("gesture-out");
		await call(c, "navigate", { url: `${site}/page?agent=out1` });
		await call(c, "tabs_create", { url: `${site}/page?agent=out2` });
		const out = (await pageTabs("agent=out2"))[0];
		await fx.swEval(`chrome.tabs.ungroup(${out.id})`);
		await sleep(1000);
		const ctx = await call(c, "tabs_context");
		const now = (await pageTabs("agent=out2"))[0];
		const listed = ctx.full.includes("agent=out2");
		check("drag-out-hands-to-user", !listed && now?.group === null, `agent still lists it: ${listed}; tab group now ${JSON.stringify(now?.group)}`);
		// Told: a message about the move, and the tab no longer among the agent's tabs.
		const told = /(took|handed|released|moved|dragged)[^\n]*out of your group|theirs now/i.test(ctx.full);
		check("drag-out-agent-told", told && !listed, `tabs_context: ${ctx.text.slice(0, 160)}`);
		await c.close();
	});

	// The user drags one of their tabs into the agent's group.
	await scenario("drag-in", async () => {
		const c = await agent("gesture-in");
		await call(c, "navigate", { url: `${site}/page?agent=in1` });
		const { session } = await groupOf("gesture-in");
		const userTab = await fx.swEval(`chrome.tabs.create({ url: "${site}/page?agent=user-in", active: false }).then((t) => t.id)`);
		await sleep(500);
		await fx.swEval(`chrome.tabs.group({ tabIds: [${userTab}], groupId: ${session.groupId} })`);
		await sleep(1000);
		const ctx = await call(c, "tabs_context");
		check("drag-in-gives-to-agent", ctx.full.includes("agent=user-in"), `agent lists the dragged-in tab: ${ctx.full.includes("agent=user-in")}`);
		await c.close();
	});

	// The user collapses the group; the agent keeps working.
	await scenario("collapse", async () => {
		const c = await agent("gesture-collapse");
		await call(c, "navigate", { url: `${site}/page?agent=col1` });
		const { session } = await groupOf("gesture-collapse");
		await fx.swEval(`chrome.tabGroups.update(${session.groupId}, { collapsed: true })`);
		await call(c, "tabs_create", { url: `${site}/page?agent=col2` });
		await call(c, "navigate", { url: `${site}/page?agent=col3` });
		const g = (await groupOf("gesture-collapse")).group;
		check("collapse-respected", g?.collapsed === true, `collapsed after agent work: ${g?.collapsed}`);
		await c.close();
	});

	// The user ungroups the whole group.
	await scenario("ungroup", async () => {
		const c = await agent("gesture-ungroup");
		await call(c, "navigate", { url: `${site}/page?agent=ug1` });
		await call(c, "tabs_create", { url: `${site}/page?agent=ug2` });
		const { session } = await groupOf("gesture-ungroup");
		await fx.swEval(`chrome.tabs.ungroup(${JSON.stringify(session.tabIds)})`);
		await sleep(1000);
		const ctx = await call(c, "tabs_context");
		const tabs = await pageTabs("agent=ug");
		check("ungroup-releases", !/agent=ug/.test(ctx.full) && tabs.every((t) => t.group === null), `agent lists ${(/agent=ug1/.test(ctx.full) ? 1 : 0) + (/agent=ug2/.test(ctx.full) ? 1 : 0)} of 2; groups now ${tabs.map((t) => t.group).join(",")}`);
		await c.close();
	});

	// A cap on tabs per group.
	await scenario("cap", async () => {
		const c = await agent("cap");
		let opened = 0;
		let error = "";
		for (let i = 0; i < 30; i++) {
			const r = await call(c, "tabs_create", { url: `${site}/page?agent=cap${i}` });
			if (r.outcome !== "ok") {
				error = r.text;
				break;
			}
			opened++;
		}
		check("tab-cap", opened < 30 && /tabs_close|limit|at most/i.test(error), `opened ${opened} of 30 before an error: ${error.slice(0, 160)}`);
		const { session } = await groupOf("cap");
		await fx.swEval(`chrome.tabs.remove(${JSON.stringify(session?.tabIds ?? [])})`);
		await c.close();
	});

	// The session's window closes.
	await scenario("window", async () => {
		const c = await agent("window");
		await call(c, "navigate", { url: `${site}/page?agent=win1` });
		const { session } = await groupOf("window");
		const other = await fx.swEval(`chrome.windows.create({ url: "about:blank", focused: true }).then((w) => w.id)`);
		await fx.swEval(`chrome.windows.remove(${session.windowId})`);
		await sleep(1000);
		const nav = await call(c, "navigate", { url: `${site}/page?agent=win2` });
		const after = await groupOf("window");
		const tab = (await pageTabs("agent=win2"))[0];
		const tabWindow = tab ? await fx.swEval(`chrome.tabs.get(${tab.id}).then((t) => t.windowId)`) : undefined;
		check("window-close-survives", nav.outcome === "ok" && after.session && tabWindow === other && tab?.group, `navigate ${nav.outcome}; new tab in window ${tabWindow} (open window ${other}), group ${JSON.stringify(tab?.group)}`);
		await c.close();
	});

	const total = Object.values(ALL).flat().length;
	results.groups = { checks, passed: Object.values(checks).filter((c) => c.pass).length, total };
	console.log(`groups: ${results.groups.passed}/${results.groups.total} behaviors as specified`);
}

if (fx) results.reloadsSent = fx.reloads();
writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nRaw results: ${OUT}`);
await cleanup();
process.exit(0);
