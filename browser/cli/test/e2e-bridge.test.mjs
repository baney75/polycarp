// End to end: the built extension in a throwaway Chromium profile, the native host the
// browser spawns, and the MCP server, driven by a real MCP client. Opens a local page,
// snapshots it, types, clicks, and reads the result back.
//
// Needs `npm run build` at the repo root (dist-chrome) and a Playwright Chromium
// (`npx playwright-core install chromium`). Uses its own HOME, profile and socket
// directory, so it never touches an installed browser or a running bridge.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const extensionDir = join(here, "..", "..", "dist-chrome");

// From the `key` in static/manifest.chrome.json; cli/test/install.test.mjs checks the derivation.
const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";

const PAGE = `<!doctype html><title>Tabkyra e2e</title>
<label for="name">Name</label> <input id="name" placeholder="Your name">
<button id="go" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value + '!'">Greet</button>
<p id="out">waiting</p>`;

const ONLOAD_PAGE = `<!doctype html><title>Tabkyra onload</title><p id="x">before</p>
<script>alert('Welcome back!'); document.getElementById('x').textContent = 'after';</script>`;

const TYPING_PAGE = `<!doctype html><title>Tabkyra typing</title>
<form id="f"><input id="q" onkeydown="if(!window.asked){window.asked=true;confirm('Start a new search?')}"></form>
<p id="sent">not sent</p>
<script>document.getElementById('f').onsubmit=(e)=>{e.preventDefault();document.getElementById('sent').textContent='sent';};</script>`;

const DIALOG_PAGE = `<!doctype html><title>Tabkyra dialog</title>
<button id="del" onclick="document.getElementById('res').textContent = confirm('Really delete?') ? 'deleted' : 'kept'">Delete</button>
<p id="res">untouched</p>`;

const COUNTER_PAGE = `<!doctype html><title>Tabkyra counter</title>
<button id="hit" onclick="fetch('/hit',{method:'POST'}).then(r=>r.text()).then(t=>document.getElementById('n').textContent=t)">Hit</button><p id="n">0</p>`;
// Re-reading must not move a ref to another element: "Add row" puts a new button in front of Keep.
const REFS_PAGE = `<!doctype html><title>Tabkyra refs</title><h1>Account</h1><label>Notes</label>
<div id="rows"><button id="keep" onclick="document.getElementById('r').textContent='kept'">Keep</button>
<button id="del" onclick="document.getElementById('r').textContent='deleted'">Delete</button></div>
<button id="add" onclick="const b=document.createElement('button');b.textContent='Danger';b.onclick=()=>document.getElementById('r').textContent='danger';document.getElementById('rows').prepend(b)">Add row</button>
<p id="r">untouched</p>`;

// Old refs that must fail: a frame that navigated, a node a list reused, a dialog that closed.
const STALE_PAGE = `<!doctype html><title>Tabkyra stale</title>
<iframe id="fr" src="/frame-a" style="width:300px;height:80px"></iframe>
<button id="swap" onclick="document.getElementById('fr').src='/frame-b'">Swap frame</button>
<button id="row" onclick="document.getElementById('r').textContent='invoice 5 deleted'">Delete invoice 5</button>
<button id="recycle" onclick="const b=document.getElementById('row');b.textContent='Delete invoice 55';b.onclick=()=>document.getElementById('r').textContent='invoice 55 deleted'">Scroll list</button>
<div id="dlg"><button onclick="document.getElementById('r').textContent='confirmed'">Confirm delete</button></div>
<button id="close" onclick="document.getElementById('dlg').style.visibility='hidden'">Close dialog</button>
<p id="r">untouched</p>`;
const FRAME_A = `<!doctype html><button onclick="parent.document.getElementById('r').textContent='frame A saved'">Frame save</button>`;
const FRAME_B = `<!doctype html><button onclick="parent.document.getElementById('r').textContent='frame B other'">Frame other</button>`;

// Where a click lands: a modal over a button, a link that wraps lines, a virtualized row whose
// "Delete" button is reused for another row, a rich editor, a field in a closed dialog.
const HIT_PAGE = `<!doctype html><title>Tabkyra hits</title><style>body{font:16px sans-serif} #col{width:140px}</style>
<button id="under" onclick="document.getElementById('r').textContent='under clicked'">Pay now</button>
<div id="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.3)"><button onclick="this.parentNode.remove()">Dismiss</button></div>
<p id="col">Read the <a href="#wrap" onclick="document.getElementById('r').textContent='wrap clicked'">long policy link that wraps</a> today.</p>
<ul><li data-key="3">Invoice 3 <button onclick="document.getElementById('r').textContent='deleted '+this.parentNode.dataset.key">Delete</button></li></ul>
<button id="virt" onclick="const li=document.querySelector('li');li.dataset.key='40';li.firstChild.textContent='Invoice 40 '">Scroll rows</button>
<div id="ed" contenteditable="true" role="textbox" aria-label="Note" style="border:1px solid;min-height:20px"></div>
<div id="dlg2"><input aria-label="Type DELETE"></div>
<button onclick="document.getElementById('dlg2').style.display='none'">Close prompt</button>
<p id="r">untouched</p>`;

// The cases #88's review named: keyless rows that share a long prefix, a grid row, focus inside a
// row, a checkbox under its label's artwork, a card's overlay link, an off-screen control, and a
// frame under a banner in its parent page.
const R = "document.getElementById('r').textContent";
const LONG = "notifications@github.com [baney75/tabkyra] Pull request review requested on a very long subject line number ";
const HIT2_PAGE = `<!doctype html><title>Tabkyra hits 2</title><style>body{font:16px sans-serif}</style>
<ul><li id="mail">${LONG}1 <button onclick="${R}='archived 1'">Archive mail</button></li></ul>
<button onclick="document.getElementById('mail').firstChild.textContent='${LONG}2 '">Next mail</button>
<div role="grid"><div role="row" aria-rowindex="7"><div role="gridcell"><button onclick="${R}='grid '+this.closest('[role=row]').getAttribute('aria-rowindex')">Archive row</button></div></div></div>
<button onclick="document.querySelector('[role=row]').setAttribute('aria-rowindex','70')">Scroll grid</button>
<ul><li>Buy milk <input type="checkbox" aria-label="Done"> <button onclick="${R}='removed'">Remove item</button></li></ul>
<label><input type="checkbox" aria-label="Agree" onchange="${R}='agreed'"><span style="position:relative;left:-22px;display:inline-block;width:20px;height:20px;background:#ccc"></span>Agree</label>
<div style="position:relative;width:320px;padding:12px;border:1px solid"><a href="/counter">Card title</a> <button onclick="${R}='saved'">Save card</button><a href="/counter" aria-label="Open card" style="position:absolute;inset:0"></a></div>
<button style="position:absolute;left:-10000px" onclick="${R}='skipped'">Off screen</button>
<div style="position:relative;width:320px;height:90px"><iframe src="/frame-a" style="width:300px;height:80px;border:0"></iframe><div style="position:absolute;inset:0;background:rgba(0,0,0,.2)">Banner</div></div>
<p id="r">untouched</p>`;

// #89: a web component's slotted label, a frame inside a shadow root, a clickable row holding
// its own Delete button, and a field in a frame under a banner whose name has an "s".
const HIT3_PAGE = `<!doctype html><title>Tabkyra hits 3</title><style>body{font:16px sans-serif}</style>
<script>
customElements.define("my-btn", class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: "open" });
  r.innerHTML = '<button aria-label="Shadow save" style="padding:6px 20px"><slot></slot></button>';
  r.querySelector("button").onclick = () => { ${R} = "shadow saved"; }; } });
customElements.define("x-frame", class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: "open" }).innerHTML = '<iframe src="/frame-a" style="width:300px;height:60px;border:0"></iframe>'; } });
</script>
<my-btn><span>Save it</span></my-btn>
<x-frame></x-frame>
<div role="option" aria-label="Open order" onclick="${R}='opened'" style="position:relative;width:320px;height:60px;border:1px solid">
<span>Order 12 details</span><button onclick="event.stopPropagation();${R}='deleted order'" style="position:absolute;left:110px;top:15px;width:100px;height:30px">Delete order</button></div>
<div style="position:relative;width:320px;height:70px"><iframe src="/frame-c" style="width:300px;height:60px;border:0"></iframe><div style="position:absolute;inset:0;background:rgba(0,0,0,.2)">Cookie settings</div></div>
<label style="position:relative;display:inline-block;width:240px;height:40px"><input type="checkbox" aria-label="Consent" onchange="${R}='consented'" style="position:absolute;left:0;top:0;width:240px;height:40px;margin:0;z-index:-1"><a href="/counter" style="position:absolute;left:60px;top:0;width:100px;height:40px">Terms of use</a></label>
<input id="plain" aria-label="Plain field">
<p id="r">untouched</p>`;
const FRAME_C = `<!doctype html><input aria-label="Frame field">`;

// Pages added by the tool-fix tests, served by path (see the server in before()).
const extraPages = {};
extraPages["/edit"] = `<!doctype html><title>Tabkyra edit</title>
<input id="t" aria-label="Task" value="first task"><p id="r">untouched</p>`;

// TodoMVC's markup: item checkboxes carry no label, their text sits in a sibling <label>.
extraPages["/todo"] = `<!doctype html><title>TodoMVC</title>
<section class="todoapp"><header><h1>todos</h1><input class="new-todo" placeholder="What needs to be done?"></header>
<ul class="todo-list">
<li><div class="view"><input class="toggle" type="checkbox"><label>first task</label><button class="destroy"></button></div></li>
<li><div class="view"><input class="toggle" type="checkbox"><label>second task</label><button class="destroy"></button></div></li>
<li class="completed"><div class="view"><input class="toggle" type="checkbox" checked><label>third task</label><button class="destroy"></button></div></li>
</ul>
<footer><span class="todo-count"><strong>2</strong> items left</span>
<ul class="filters"><li><a class="selected" href="#/">All</a></li><li><a href="#/active">Active</a></li><li><a href="#/completed">Completed</a></li></ul>
<button class="clear-completed">Clear completed</button></footer></section>
<footer class="info"><p>Part of <a href="http://todomvc.com/examples/checkbox-guide">TodoMVC</a></p><a href="/docs#first-task-howto">Docs</a></footer>`;

// The first load logs and fetches: capture has to be on before it.
extraPages["/boot"] = `<!doctype html><title>Tabkyra boot</title><p id="x">boot</p>
<script>console.log("boot-log"); fetch("/boot-data").then((r) => r.text());</script>`;

// Radios sharing one parent, each with the label beside it (no `for`), and a checkbox in a big
// container with a lot of text around it.
extraPages["/radios"] = `<!doctype html><title>Radios</title>
<div id="sizes"><input type="radio" name="s"><label>Small</label><input type="radio" name="s"><label>Large</label></div>
<div id="firsts"><label>Medium</label><input type="radio" name="m"><label>Extra</label><input type="radio" name="m"></div>
<div id="values"><input type="radio" name="size" value="tiny"><input type="radio" name="size" value="huge"></div>
<ul><li><input type="checkbox"><a href="#e">Edit</a> Buy milk <span>2 days ago</span></li></ul>
<form><input type="checkbox" name="agree">${"Lots of unrelated text in the same container. ".repeat(12)}<p>More text.</p><input type="text" aria-label="Email"></form>`;

// Clipboard events and key events a clipboard chord would raise are logged; none may fire.
extraPages["/clip"] = `<!doctype html><title>Clip</title>
<input id="t" aria-label="Task" value="">
<script>window.__seen = [];
for (const type of ["paste", "copy", "cut", "keydown", "keyup", "beforeinput"]) document.addEventListener(type, (e) => window.__seen.push(type + ":" + (e.key || "")), true);</script>`;

/** Clicks that reached the page's server: a replayed click shows up here twice. */
let hits = 0;

let home;
let socketDir;
let browser;
let server;
let mcp;
let pageUrl;
let devtools;

function env() {
	return {
		...process.env,
		HOME: home,
		TABKYRA_SOCKET_DIR: socketDir,
		TABKYRA_AUTO_ALLOW: "1",
		TABKYRA_CLIENT_NAME: "e2e",
		TABKYRA_SESSION: "e2e",
	};
}

async function tool(name, args = {}) {
	const result = await mcp.callTool({ name, arguments: args });
	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	assert.ok(!result.isError, `${name} failed: ${text}`);
	return text;
}

/** One CDP command over a target's websocket. */
async function cdp(wsUrl, method, params = {}) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	try {
		const reply = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
			ws.onmessage = (m) => {
				const msg = JSON.parse(m.data);
				if (msg.id !== 1) return;
				clearTimeout(timer);
				resolve(msg);
			};
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
		if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
		return reply.result;
	} finally {
		ws.close();
	}
}

/** The live native host's pid (its socket is named after it). */
function hostPid() {
	for (const name of readdirSync(socketDir)) {
		const pid = Number.parseInt(name, 10);
		try {
			process.kill(pid, 0);
			return pid;
		} catch {
			/* stale */
		}
	}
	return undefined;
}

/** Reload the extension the way `tabkyra reload` does, retrying while a fresh host waits for its hello. */
async function reloadExtension() {
	const old = hostPid();
	await until(() => (execFileSync(process.execPath, [cli, "reload"], { env: env(), stdio: "ignore" }), true), 30_000, "the extension to take a reload");
	return old;
}

async function gone(pid) {
	await until(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, 10_000, `host ${pid} to exit`);
}

async function connected() {
	await until(
		() => {
			try {
				return JSON.parse(execFileSync(process.execPath, [cli, "status", "--json"], { env: env(), encoding: "utf8" })).connected;
			} catch {
				return false;
			}
		},
		45_000,
		"the extension to reconnect",
	);
}

/** Navigate, waiting for the extension to connect first (these tests may run alone). */
async function go(path) {
	await connected();
	await tool("navigate", { url: `${pageUrl}${path}` });
}

async function until(fn, ms, what) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

before(async () => {
	home = mkdtempSync(join(tmpdir(), "tabkyra-e2e-home-"));
	// Unix socket paths are capped near 104 bytes on macOS, so keep this one short.
	socketDir = mkdtempSync("/tmp/tke2e-");
	const profile =
		process.platform === "darwin"
			? join(home, "Library", "Application Support", "Chromium")
			: join(home, ".config", "chromium");
	mkdirSync(profile, { recursive: true });

	server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/hit") {
			hits++;
			res.end(String(hits));
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/counter") return res.end(COUNTER_PAGE);
		if (req.url === "/refs") return res.end(REFS_PAGE);
		if (req.url === "/stale") return res.end(STALE_PAGE);
		if (req.url === "/hits") return res.end(HIT_PAGE);
		if (req.url === "/hits2") return res.end(HIT2_PAGE);
		if (req.url === "/hits3") return res.end(HIT3_PAGE);
		if (req.url === "/frame-c") return res.end(FRAME_C);
		if (req.url === "/frame-a") return res.end(FRAME_A);
		if (req.url === "/frame-b") return res.end(FRAME_B);
		if (extraPages[req.url.split("?")[0]]) return res.end(extraPages[req.url.split("?")[0]]);
		res.end(req.url === "/dialog" ? DIALOG_PAGE : req.url === "/onload" ? ONLOAD_PAGE : req.url === "/typing" ? TYPING_PAGE : PAGE);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	pageUrl = `http://127.0.0.1:${server.address().port}/`;

	// `install` writes the host manifest into the profile's NativeMessagingHosts.
	execFileSync(process.execPath, [cli, "install"], { env: env(), stdio: "ignore" });

	// Launch Playwright's Chromium without Playwright's CDP session: the extension drives
	// tabs through chrome.debugger, and a second automation client attached to every
	// target gets in its way. Targets are listed over the DevTools HTTP endpoint instead.
	browser = spawn(
		chromium.executablePath(),
		[
			`--user-data-dir=${profile}`,
			"--headless=new",
			"--no-first-run",
			"--no-default-browser-check",
			// Keep the macOS keychain prompt and every window off the user's screen.
			"--use-mock-keychain",
			"--password-store=basic",
			"--remote-debugging-port=0",
			`--disable-extensions-except=${extensionDir}`,
			`--load-extension=${extensionDir}`,
			"about:blank",
		],
		{ env: env(), stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	browser.stderr.on("data", (d) => {
		stderr += d;
	});
	devtools = await until(() => stderr.match(/DevTools listening on ws:\/\/([^/]+)\//)?.[1], 20_000, "Chromium to start");
	// Developer mode, set the way the extensions page does: without it this Chromium disables an
	// unpacked extension when it reloads, and the reload tests would unload Tabkyra for good.
	const version = await (await fetch(`http://${devtools}/json/version`)).json();
	const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: "chrome://extensions" });
	const page = await until(
		async () => (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.id === targetId && t.url.startsWith("chrome://extensions")),
		10_000,
		"chrome://extensions",
	);
	await until(
		async () =>
			(await cdp(page.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).then(() => true)", awaitPromise: true, returnByValue: true })).result?.value,
		10_000,
		"developer mode",
	);
	await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });

	mcp = new Client({ name: "tabkyra-e2e", version: "0.0.0" });
	await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: env(), stderr: "inherit" }));
});

after(async () => {
	await mcp?.close().catch(() => {});
	browser?.kill();
	if (browser) await new Promise((r) => browser.once("exit", r));
	server?.close();
	if (home) rmSync(home, { recursive: true, force: true });
	if (socketDir) rmSync(socketDir, { recursive: true, force: true });
});

test("extension loads with the id the host manifest allows", async () => {
	const worker = await until(
		async () => {
			const targets = await (await fetch(`http://${devtools}/json/list`)).json();
			// Chromium's own component extensions run workers too; ours is the one named in
			// the host manifest, so a match here means the key produced the expected id.
			return targets.find((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXTENSION_ID}/background.js`);
		},
		20_000,
		"the extension service worker",
	);
	assert.ok(worker);
});

test("MCP server lists the browser tools under the tabkyra name", async () => {
	assert.equal(mcp.getServerVersion()?.name, "tabkyra");
	const { tools } = await mcp.listTools();
	const names = tools.map((t) => t.name);
	for (const name of ["navigate", "read_page", "click", "type", "get_page_text"]) assert.ok(names.includes(name), name);
});

test("open a page, snapshot, type, click and read back through MCP", async () => {
	// The extension dials the host on start and on its keepalive alarm; wait for it.
	const nav = await until(
		async () => {
			const result = await mcp.callTool({ name: "navigate", arguments: { url: pageUrl } });
			return result.isError ? undefined : result.content.map((c) => c.text).join("\n");
		},
		45_000,
		"the extension to connect and open the page",
	);
	assert.match(nav, /Tabkyra e2e/);

	const status = JSON.parse(await tool("status"));
	assert.equal(status.connected, true);
	assert.equal(status.tabGroup, "Tabkyra · e2e");
	assert.equal(status.permissionMode, "ask");
	assert.ok(status.tabs.some((t) => t.current && t.url.startsWith(pageUrl)), JSON.stringify(status.tabs));

	const snapshot = await tool("read_page", { filter: "interactive" });
	const inputRef = snapshot.match(/\[(e\d+)\][^\n]*textbox/i)?.[1] ?? snapshot.match(/(e\d+)[^\n]*(textbox|input)/i)?.[1];
	const buttonRef = snapshot.match(/\[(e\d+)\][^\n]*Greet/)?.[1] ?? snapshot.match(/(e\d+)[^\n]*Greet/)?.[1];
	assert.ok(inputRef, `no textbox ref in snapshot:\n${snapshot}`);
	assert.ok(buttonRef, `no Greet button ref in snapshot:\n${snapshot}`);

	await tool("type", { ref: inputRef, text: "Donovan" });
	await tool("click", { ref: buttonRef });

	const text = await until(
		async () => {
			const t = await tool("get_page_text");
			return t.includes("Hello, Donovan!") ? t : undefined;
		},
		10_000,
		"the greeting",
	);
	assert.match(text, /Hello, Donovan!/);
});

/** The ref of the first line in a read_page result that names `label`. */
function refFor(snapshot, label) {
	const line = snapshot.split("\n").find((l) => l.includes(label));
	return line?.match(/\b(e\d+)\b/)?.[1];
}

test("a ref keeps pointing at its element after find and after the page adds an element", async () => {
	await tool("navigate", { url: `${pageUrl}refs` });
	const first = await tool("read_page", { filter: "interactive" });
	const keep = refFor(first, "Keep");
	const del = refFor(first, "Delete");
	assert.ok(keep && del, first);

	// find reads the whole page (headings and labels too); before stable refs it renumbered,
	// so Delete's old ref landed on the "Notes" label and nothing happened.
	await tool("find", { query: "account" });
	await tool("click", { ref: del });
	assert.match(await tool("get_page_text"), /deleted/);

	// A new button in front of Keep: before stable refs, Keep's old ref clicked "Danger".
	await tool("click", { ref: refFor(first, "Add row") });
	const second = await tool("read_page", { filter: "interactive" });
	assert.equal(refFor(second, "Keep"), keep, second);
	await tool("click", { ref: keep });
	const text = await tool("get_page_text");
	assert.match(text, /kept/);
	assert.doesNotMatch(text, /danger/);
});

test("an old ref fails, never acting elsewhere: navigated frame, reused node, closed dialog", async () => {
	await tool("navigate", { url: `${pageUrl}stale` });
	const first = await until(async () => {
		const t = await tool("read_page", { filter: "interactive" });
		return t.includes("Frame save") ? t : undefined;
	}, 10_000, "the frame's button");
	const frameSave = refFor(first, "Frame save");
	const row = refFor(first, "Delete invoice 5");
	const confirm = refFor(first, "Confirm delete");
	assert.ok(frameSave && row && confirm, first);
	const clickFails = async (ref, why) => {
		const res = await mcp.callTool({ name: "click", arguments: { ref } });
		assert.equal(res.isError, true, `${why}: ${res.content.map((c) => c.text).join("\n")}`);
		assert.match(res.content.map((c) => c.text).join("\n"), /read_page/, why);
	};

	await tool("click", { ref: refFor(first, "Swap frame") });
	await until(async () => ((await tool("read_page", { filter: "interactive" })).includes("Frame other") ? true : undefined), 10_000, "frame B");
	await clickFails(frameSave, "a ref into the frame's old document");

	await tool("click", { ref: refFor(first, "Scroll list") });
	await tool("read_page", { filter: "interactive" });
	await clickFails(row, "a ref to a node now showing invoice 55");

	await tool("click", { ref: refFor(first, "Close dialog") });
	await clickFails(confirm, "a ref to a button in a closed dialog");

	assert.match(await tool("get_page_text"), /untouched/);
});

test("a click lands on its element or fails: modal, wrapped link, reused row, editor, closed field", async () => {
	await tool("navigate", { url: `${pageUrl}hits` });
	const page = await tool("read_page", { filter: "interactive" });
	const call = async (name, args) => {
		const res = await mcp.callTool({ name, arguments: args });
		return { error: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
	};
	const pay = await call("click", { ref: refFor(page, "Pay now") });
	assert.equal(pay.error, true, pay.text);
	assert.match(pay.text, /covered by/);
	await tool("click", { ref: refFor(page, "Dismiss") });
	await tool("click", { ref: refFor(page, "Pay now") });
	assert.match(await tool("get_page_text"), /under clicked/);

	await tool("click", { ref: refFor(page, "long policy link") });
	assert.match(await tool("get_page_text"), /wrap clicked/);

	const del = refFor(page, "Delete");
	await tool("click", { ref: refFor(page, "Scroll rows") });
	const reused = await call("click", { ref: del });
	assert.equal(reused.error, true, reused.text);
	assert.match(reused.text, /now shows something else/);
	assert.doesNotMatch(await tool("get_page_text"), /deleted 40/);

	const note = refFor(page, "Note");
	await tool("fill", { ref: note, value: "Ada" });
	await tool("type", { ref: note, text: "!" });
	assert.match(await tool("get_page_text"), /Ada!/);

	const field = refFor(page, "Type DELETE");
	await tool("click", { ref: refFor(page, "Close prompt") });
	const hidden = await call("fill", { ref: field, value: "DELETE" });
	assert.equal(hidden.error, true, hidden.text);
	assert.match(hidden.text, /isn't shown now/);
});

test("refs follow rows and clicks reach only their target: prefix rows, grid, focus, label, card, off screen, frame", async () => {
	await tool("navigate", { url: `${pageUrl}hits2` });
	const page = await until(async () => {
		const t = await tool("read_page", { filter: "interactive" });
		return t.includes("Frame save") ? t : undefined;
	}, 10_000, "the frame's button");
	const call = async (name, args) => {
		const res = await mcp.callTool({ name, arguments: args });
		return { error: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
	};
	const refused = async (ref, pattern, why) => {
		const res = await call("click", { ref });
		assert.equal(res.error, true, `${why}: ${res.text}`);
		assert.match(res.text, pattern, why);
	};

	const mail = refFor(page, "Archive mail");
	await tool("click", { ref: refFor(page, "Next mail") });
	await refused(mail, /now shows something else/, "a keyless row whose text changed after a long shared prefix");

	const grid = refFor(page, "Archive row");
	await tool("click", { ref: refFor(page, "Scroll grid") });
	await refused(grid, /now shows something else/, "a grid row reused for row 70");

	await tool("click", { ref: refFor(page, "Done") });
	await tool("click", { ref: refFor(page, "Remove item") });
	assert.match(await tool("get_page_text"), /removed/);

	await tool("click", { ref: refFor(page, "Agree") });
	assert.match(await tool("get_page_text"), /agreed/);

	await refused(refFor(page, "Save card"), /covered by a/, "a button under the card's overlay link");
	await refused(refFor(page, "Off screen"), /outside the visible page/, "an off-screen button");
	await refused(refFor(page, "Frame save"), /covered by div "Banner"/, "a frame under a banner");
	assert.doesNotMatch(await tool("get_page_text"), /saved|skipped|frame A/);

	// The title link under an overlay to the same address: the click goes where it meant.
	const title = await call("click", { ref: refFor(page, "Card title") });
	assert.equal(title.error, false, title.text);
	await until(async () => ((await tool("get_page_text")).includes("Tabkyra counter") ? true : undefined), 10_000, "the card's page");
});

test("web components, a frame in a shadow root, a row's own button, a frame field under a banner", async () => {
	await tool("navigate", { url: `${pageUrl}hits3` });
	const page = await until(async () => {
		const t = await tool("read_page", { filter: "interactive" });
		return t.includes("Frame save") && t.includes("Frame field") ? t : undefined;
	}, 10_000, "both frames");
	const call = async (name, args) => {
		const res = await mcp.callTool({ name, arguments: args });
		return { error: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
	};
	const text = () => tool("get_page_text");

	const save = await call("click", { ref: refFor(page, "Shadow save") });
	assert.equal(save.error, false, save.text);
	assert.match(await text(), /shadow saved/);

	const frame = await call("click", { ref: refFor(page, "Frame save") });
	assert.equal(frame.error, false, frame.text);
	assert.match(await text(), /frame A saved/);

	await tool("click", { ref: refFor(page, "Open order") });
	assert.match(await text(), /opened/);
	assert.doesNotMatch(await text(), /deleted order/);

	// A checkbox under its label, where the label also holds a link: the click ticks the box.
	await tool("click", { ref: refFor(page, "Consent") });
	assert.match(await text(), /consented/);
	assert.doesNotMatch(await text(), /Tabkyra counter/);

	// A dead ref with a selector falls back to the selector, as before.
	const plain = await call("fill", { ref: "e1", selector: "#plain", value: "fallback" });
	assert.equal(plain.error, false, plain.text);

	const field = await call("fill", { ref: refFor(page, "Frame field"), value: "x" });
	assert.equal(field.error, true, field.text);
	assert.match(field.text, /covered by div "Cookie settings"/);
});

test("a click that opens a confirm() box succeeds and says so; calls after it fail with dialog_open until handle_dialog answers", async () => {
	await go("dialog");
	const started = Date.now();
	const clicked = await mcp.callTool({ name: "click", arguments: { selector: "#del" } });
	const message = clicked.content.map((c) => c.text).join("\n");
	// The click worked: an error here made agents repeat it.
	assert.ok(!clicked.isError, message);
	const result = JSON.parse(message);
	assert.equal(result.dialog.type, "confirm");
	assert.equal(result.dialog.message, "Really delete?");
	assert.match(result.dialog.tabId.toString(), /^\d+$/);
	assert.match(result.note, /confirm dialog is now open on tab \d+: "Really delete\?"/);
	assert.match(result.note, /handle_dialog/);
	assert.ok(Date.now() - started < 10_000, "the call must not wait for the 90 s handler timeout");
	// While it is open, page calls fail instead of hanging, and a second click did not run.
	const frozen = await mcp.callTool({ name: "get_page_text", arguments: {} });
	assert.ok(frozen.isError);
	assert.match(frozen.content[0].text, /dialog_open: A confirm dialog is open on tab \d+: "Really delete\?"/);
	const again = await mcp.callTool({ name: "click", arguments: { selector: "#del" } });
	assert.ok(again.isError, again.content[0].text);
	assert.match(again.content[0].text, /^dialog_open: /);

	const answered = JSON.parse(await tool("handle_dialog", { accept: false }));
	assert.equal(answered.type, "confirm");
	assert.equal(answered.accepted, false);
	assert.match(await tool("get_page_text"), /kept/);

	await mcp.callTool({ name: "click", arguments: { selector: "#del" } });
	await tool("handle_dialog", { accept: true });
	assert.match(await tool("get_page_text"), /deleted/);
	const none = await mcp.callTool({ name: "handle_dialog", arguments: { accept: true } });
	assert.ok(none.isError);
	assert.match(none.content[0].text, /No dialog is open/);
});

test("a click step in actions that opens a dialog succeeds and says how many steps did not run", async () => {
	await go("dialog");
	const res = await mcp.callTool({ name: "actions", arguments: { steps: [{ click: { selector: "#del" } }, { wait: 100 }, { wait: 100 }] } });
	const text = res.content.map((c) => c.text).join("\n");
	assert.ok(!res.isError, text);
	assert.match(text, /^1 steps done\. /);
	assert.match(text, /confirm dialog is now open on tab \d+: "Really delete\?"/);
	assert.match(text, /The 2 later steps did not run/);
	assert.match(text, /handle_dialog/);
	await tool("handle_dialog", { accept: false });
	assert.match(await tool("get_page_text"), /kept/);
});

test("an alert() fired while the page loads is reported, not a 90 s hang", async () => {
	const started = Date.now();
	const nav = await mcp.callTool({ name: "navigate", arguments: { url: `${pageUrl}onload` } });
	let message = nav.content.map((c) => c.text).join("\n");
	if (!nav.isError) {
		const read = await mcp.callTool({ name: "get_page_text", arguments: {} });
		assert.ok(read.isError, read.content[0].text);
		message = read.content[0].text;
	}
	assert.match(message, /dialog_open: An alert dialog is open on tab \d+: "Welcome back!"/);
	assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
	await tool("handle_dialog", { accept: true });
	assert.match(await tool("get_page_text"), /after/);
});

test("a call that ran into a dialog sends no more input once it is answered", async () => {
	await tool("navigate", { url: `${pageUrl}typing` });
	const typed = await mcp.callTool({ name: "type", arguments: { selector: "#q", text: "hello world", submit: true } });
	assert.ok(typed.isError);
	assert.match(typed.content[0].text, /dialog_open/);
	await tool("handle_dialog", { accept: false });
	// Give a still-running handler time to misbehave.
	await new Promise((r) => setTimeout(r, 1500));
	const value = await tool("run_js", { code: "document.getElementById('q').value + '|' + document.getElementById('sent').textContent" });
	assert.match(value, /\|not sent/, `the old call kept typing or submitted: ${value}`);
	assert.doesNotMatch(value, /ello world/, `the old call kept typing: ${value}`);
});

test("a click in flight when the extension reloads runs once, and the agent is told it may have run", async () => {
	await tool("navigate", { url: `${pageUrl}counter` });
	await connected();
	const before = hits;
	// The click runs first; the reload lands while the step after it is still going.
	const pending = mcp.callTool({ name: "actions", arguments: { steps: [{ click: { selector: "#hit" } }, { wait: 3000 }] } }, undefined, { timeout: 120_000 });
	await new Promise((r) => setTimeout(r, 800));
	await reloadExtension();
	const started = Date.now();
	const result = await pending;
	const message = result.content.map((c) => c.text).join("\n");
	assert.equal(result.isError, true, message);
	assert.match(message, /^interrupted: The browser connection dropped while actions was running .*may have run/);
	assert.ok(Date.now() - started < 30_000, "the interrupted call must not wait out a timeout");
	await connected();
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(hits - before, 1, "the click ran twice: a cut-off request was replayed");
	// The session kept its tab across the reload.
	assert.match(await tool("tabs_context"), /\/counter/);
});

test("a read sent while the extension is reloading waits for it and succeeds", async () => {
	await tool("navigate", { url: `${pageUrl}counter` });
	await connected();
	await gone(await reloadExtension());
	const started = Date.now();
	const text = await tool("read_page", { filter: "interactive" });
	assert.match(text, /Hit/);
	assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
});

test("a read after the native host is killed reconnects to the host the browser respawns", async () => {
	await connected();
	process.kill(hostPid(), "SIGKILL");
	const started = Date.now();
	const text = await tool("get_page_text");
	assert.match(text, /Hit/);
	assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
});

async function sw(expression) {
	const target = await until(
		async () => (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXTENSION_ID}/background.js`),
		20_000,
		"the service worker",
	);
	const r = await cdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
	return r.result.value;
}

const groupsOf = () =>
	sw(`(async () => { const g = new Map((await chrome.tabGroups.query({})).map((x) => [x.id, x])); return (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, group: t.groupId === -1 ? null : g.get(t.groupId)?.title, color: t.groupId === -1 ? null : g.get(t.groupId)?.color })); })()`);

/** An MCP client the way a harness starts one: no session configured, in a project folder. */
async function agentIn(project) {
	const e = { ...env(), TABKYRA_CLIENT_NAME: "claude" };
	delete e.TABKYRA_SESSION;
	const client = new Client({ name: "e2e-agent", version: "0.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: e, cwd: project, stderr: "ignore" }));
	return client;
}

async function on(client, name, args = {}) {
	const result = await client.callTool({ name, arguments: args });
	const text = result.content.map((c) => c.text).join("\n");
	assert.ok(!result.isError, `${name} failed: ${text}`);
	return text;
}

const tk = (...args) => execFileSync(process.execPath, [cli, ...args], { env: env(), encoding: "utf8" });

test("three agents in one project at once: a group each, titled with agent and project, no cross-talk", async () => {
	await connected();
	const project = join(home, "projects", "demo-shop");
	mkdirSync(project, { recursive: true });
	execFileSync("git", ["init", "-q", project]);
	const agents = await Promise.all([0, 1, 2].map(() => agentIn(project)));
	try {
		await Promise.all(agents.map((a, i) => on(a, "navigate", { url: `${pageUrl}?agent=${i}` })));
		const contexts = await Promise.all(agents.map((a) => on(a, "tabs_context")));
		contexts.forEach((ctx, i) => {
			assert.match(ctx, new RegExp(`agent=${i}`));
			for (const j of [0, 1, 2].filter((x) => x !== i)) assert.doesNotMatch(ctx, new RegExp(`agent=${j}\\b`), `agent ${i} sees agent ${j}'s tab`);
		});
		const tabs = (await groupsOf()).filter((t) => /\?agent=\d/.test(t.url));
		const titles = new Set(tabs.map((t) => t.group));
		assert.equal(titles.size, 3, JSON.stringify(tabs));
		for (const title of titles) assert.match(title, /^Tabkyra · claude · demo-shop( \d)?$/);
		assert.equal(new Set(tabs.map((t) => t.color)).size, 3, "two concurrent sessions share a color");
		// The CLI sees all three, connected.
		const listed = JSON.parse(tk("sessions", "--json")).filter((s) => s.project === "demo-shop");
		assert.equal(listed.length, 3);
		assert.ok(listed.every((s) => s.connected === 1 && s.tabCount === 1));
	} finally {
		await Promise.all(agents.map((a) => a.close()));
	}
	// A new harness process in the same project resumes the first session's tab.
	const again = await agentIn(project);
	try {
		assert.match(await on(again, "tabs_context"), /agent=\d/);
	} finally {
		await again.close();
	}
});

test("the user drags a tab out of the agent's group: it's theirs, and the agent is told", async () => {
	const project = join(home, "projects", "drag");
	mkdirSync(project, { recursive: true });
	const agent = await agentIn(project);
	try {
		await on(agent, "navigate", { url: `${pageUrl}?drag=1` });
		const second = JSON.parse(await on(agent, "tabs_create", { url: `${pageUrl}?drag=2` })).tabId;
		await sw(`chrome.tabs.ungroup(${second})`);
		await new Promise((r) => setTimeout(r, 800));
		const ctx = await on(agent, "tabs_context");
		assert.match(ctx, /News: The user took tab \d+ .*out of your group; it's theirs now/);
		assert.doesNotMatch(ctx, /drag=2/);
		assert.equal((await groupsOf()).find((t) => t.id === second)?.group, null, "the tab was pulled back into the group");
		// The current tab was the one taken: the agent must pick, not land on another page.
		const read = await agent.callTool({ name: "read_page", arguments: {} });
		assert.equal(read.isError, true);
		assert.match(read.content[0].text, /You have no current tab/);
	} finally {
		await agent.close();
	}
});

test("tabs_release, a capped group, and ending and renaming a session from the CLI", async () => {
	const project = join(home, "projects", "release");
	mkdirSync(project, { recursive: true });
	const agent = await agentIn(project);
	try {
		const first = JSON.parse(await on(agent, "navigate", { url: `${pageUrl}?r=0` })).tabId;
		const released = JSON.parse(await on(agent, "tabs_release", { tabId: first }));
		assert.equal(released.released, first);
		assert.equal((await groupsOf()).find((t) => t.id === first)?.group, null);
		// The 16th tab is refused, with what to do.
		for (let i = 1; i <= 15; i++) await on(agent, "tabs_create", { url: `${pageUrl}?r=${i}` });
		const over = await agent.callTool({ name: "tabs_create", arguments: { url: `${pageUrl}?r=16` } });
		assert.equal(over.isError, true);
		assert.match(over.content[0].text, /^tab_limit: Your tab group already has 15 tabs.*tabs_close/);
		const name = JSON.parse(tk("sessions", "--json")).find((s) => s.project === "release").name;
		assert.match(tk("sessions", "rename", name, "release-demo"), /is now release-demo/);
		assert.match(await on(agent, "tabs_context"), /^Session release-demo \| group "Tabkyra · claude · release-demo"/);
		assert.match(tk("sessions", "end", "release-demo", "--close"), /Ended release-demo: 15 tabs closed/);
		assert.match(await on(agent, "tabs_context"), /News: The user ended your session from the terminal and closed its tabs/);
	} finally {
		await agent.close();
	}
});

// ---- threads: past side panel chats, live ---------------------------------------------------

test("a side panel chat is readable live through the CLI and MCP, and as files; a private-mode one nowhere", async () => {
	await connected();
	// The real side panel page creates its database, as it does for the user.
	const version = await (await fetch(`http://${devtools}/json/version`)).json();
	const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` });
	const panel = await until(async () => (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.id === targetId && t.url.includes("sidepanel.html")), 15_000, "the side panel page");
	const inPanel = async (expression) => {
		const r = await cdp(panel.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
		return r.result.value;
	};
	await until(() => inPanel(`indexedDB.databases().then((d) => d.some((x) => x.name === "tabkyra-storage"))`), 20_000, "the panel's database");
	// A finished chat with a scripted model, stored the way the panel's session store stores it.
	const now = new Date().toISOString();
	const chat = (id, title, extra) => ({
		data: { id, title, model: { provider: "mock", id: "scripted-model" }, thinkingLevel: "off", createdAt: now, lastModified: now, ...extra, messages: [
			{ role: "user", content: "What is the cheapest flight to Lisbon in May?", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "The cheapest I found is 212 euros on May 14." }, { type: "toolCall", id: "c1", name: "navigate", arguments: { url: "https://flights.example/lis" } }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "c1", toolName: "navigate", content: [{ type: "text", text: "Flights to LIS" }], isError: false, timestamp: 3 },
		] },
		meta: { id, title, createdAt: now, lastModified: now, messageCount: 3, usage: {}, thinkingLevel: "off", preview: "", ...extra },
	});
	const store = (c) =>
		inPanel(`new Promise((resolve, reject) => { const r = indexedDB.open("tabkyra-storage"); r.onsuccess = () => { const tx = r.result.transaction(["sessions", "sessions-metadata"], "readwrite"); tx.objectStore("sessions").put(${JSON.stringify(c.data)}); tx.objectStore("sessions-metadata").put(${JSON.stringify(c.meta)}); tx.oncomplete = () => { chrome.runtime.sendMessage({ type: "tabkyra-thread-changed", id: ${JSON.stringify(c.data.id)} }).catch(() => {}); resolve(true); }; tx.onerror = () => reject(tx.error); }; r.onerror = () => reject(r.error); })`);
	await store(chat("e2e-flights", "Flights to Lisbon"));
	await store(chat("e2e-private", "Private medical question", { tabkyraPrivate: true }));
	// The mirror writes after the debounce; the file is under the test's HOME.
	const root = join(home, ".local", "share", "tabkyra", "threads");
	// One folder per browser profile, named by its browser id.
	const files = await until(() => (existsSync(root) ? readdirSync(root).map((n) => join(root, n)).find((d) => existsSync(join(d, "e2e-flights.md"))) : undefined), 15_000, "the mirrored file");
	const md = readFileSync(join(files, "e2e-flights.md"), "utf8");
	assert.equal(statSync(root).mode & 0o777, 0o700);
	assert.match(md, /^---\nid: e2e-flights\ntitle: "Flights to Lisbon"/);
	assert.match(md, /212 euros on May 14/);
	assert.equal(statSync(files).mode & 0o777, 0o700);
	assert.equal(statSync(join(files, "e2e-flights.md")).mode & 0o777, 0o600);
	assert.equal(existsSync(join(files, "e2e-private.md")), false, "a private-mode chat was mirrored");
	// Live through the bridge: the CLI and MCP.
	const list = execFileSync(process.execPath, [cli, "threads", "--json"], { env: env(), encoding: "utf8" });
	assert.deepEqual(JSON.parse(list).threads.map((t) => t.id), ["e2e-flights"]);
	assert.match(execFileSync(process.execPath, [cli, "threads", "show", "e2e-flights"], { env: env(), encoding: "utf8" }), /\[2\] assistant: The cheapest I found is 212 euros on May 14\./);
	const read = await tool("thread_read", { id: "e2e-flights" });
	assert.match(read, /Thread e2e-flights: "Flights to Lisbon"/);
	assert.match(read, /<- navigate: Flights to LIS/);
	const hidden = await mcp.callTool({ name: "thread_read", arguments: { id: "e2e-private" } });
	assert.equal(hidden.isError, true);
	assert.match(await tool("thread_search", { query: "lisbon flight" }), /e2e-flights/);
	await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });
});

// ---- the side panel header: no share button ---------------------------------------------------

test("the side panel has no share button: the tab in front goes with the message", async () => {
	await connected();
	const version = await (await fetch(`http://${devtools}/json/version`)).json();
	const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` });
	const panel = await until(async () => (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.id === targetId && t.url.includes("sidepanel.html")), 15_000, "the side panel page");
	const inPanel = async (expression) => {
		const r = await cdp(panel.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
		return r.result.value;
	};
	await until(() => inPanel(`!!document.querySelector("textarea")`), 20_000, "the side panel");
	// A page the agent doesn't have comes to the front: still no button to press.
	const tabId = await inPanel(`chrome.tabs.create({ url: ${JSON.stringify(`${pageUrl}?share`)}, active: true }).then((t) => t.id)`);
	await new Promise((r) => setTimeout(r, 800));
	assert.equal(await inPanel(`!!document.querySelector("[data-share-tab]")`), false);
	assert.equal(await inPanel(`!!document.querySelector('[title="Share the tab you are viewing with the agent"]')`), false);
	assert.equal(await inPanel(`[...document.querySelectorAll("button")].some((b) => /share this tab/i.test(b.innerText))`), false);
	await inPanel(`chrome.tabs.remove(${tabId}).then(() => true)`);
	await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });
});

test("subscription sign-ins: the side panel reaches the native host through the relay and gets a proxy, never a token", async () => {
	await connected();
	const version = await (await fetch(`http://${devtools}/json/version`)).json();
	const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` });
	const panel = await until(async () => (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.id === targetId && t.url.includes("sidepanel.html")), 15_000, "the side panel page");
	const inPanel = async (expression) => {
		const r = await cdp(panel.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
		return r.result.value;
	};
	const ask = (method) =>
		inPanel(`new Promise((resolve) => { const p = chrome.runtime.connect({ name: "tabkyra-subscriptions" }); p.onDisconnect.addListener(() => resolve({ error: { code: "disconnected" } })); p.onMessage.addListener((m) => { if (m.result !== undefined || m.error) { p.disconnect(); resolve(m); } }); p.postMessage({ id: 1, method: ${JSON.stringify(method)} }); })`);
	const status = await until(async () => {
		const reply = await ask("status");
		return reply.result ? reply.result : undefined;
	}, 20_000, "the subscription status");
	assert.match(status.proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.equal(status.chatgpt.signedIn, false);
	assert.equal(status.copilot.signedIn, false);
	assert.doesNotMatch(JSON.stringify(status), /access_token|refresh_token|id_token/);
	// Not a method the relay forwards.
	assert.equal((await ask("chatgpt.token")).error.code, "bad_params");
	// The proxy answers the panel only with the secret, and without a sign-in it refuses.
	const probe = (auth) =>
		inPanel(`fetch(${JSON.stringify(`${status.proxy.url}/chatgpt/v1/models`)}, { headers: ${JSON.stringify(auth ? { Authorization: `Bearer ${auth}` } : {})} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
	assert.equal((await probe()).status, 401);
	const signedOut = await probe(status.proxy.secret);
	assert.equal(signedOut.status, 401);
	assert.equal(signedOut.body.error.code, "not_signed_in");
	await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });
});

// ---- tool fixes (2026-11-02 live test) ------------------------------------------------------

/** run_js in the page, parsed. */
async function js(code, args = {}) {
	return JSON.parse(await tool("run_js", { code, ...args })).value;
}

test("press select-all (Meta+a and Control+a) selects the field's text, so typing replaces it", async () => {
	await go("edit");
	for (const chord of ["Meta+a", "Control+a"]) {
		await tool("fill", { selector: "#t", value: "first task" });
		await tool("click", { selector: "#t" });
		await tool("press", { key: chord });
		await tool("type", { text: "edited task" });
		assert.equal(await js("document.getElementById('t').value"), "edited task", `${chord} did not select all`);
	}
});

/**
 * Make the extension's next `count` chrome.debugger.sendCommand calls of `method` fail with
 * `message`, before they reach the page: the errors Chromium gives when the debugger detaches.
 */
async function failNext(method, message, count = 1) {
	await sw(`(() => {
		const g = globalThis;
		g.__faults = g.__faults || [];
		if (!g.__faultWrapped) {
			g.__faultWrapped = true;
			const original = chrome.debugger.sendCommand.bind(chrome.debugger);
			chrome.debugger.sendCommand = (target, m, p) => {
				const i = g.__faults.findIndex((f) => f.method === m && f.left > 0);
				if (i >= 0) { g.__faults[i].left--; return Promise.reject(new Error(g.__faults[i].message)); }
				return original(target, m, p);
			};
		}
		g.__faults.push({ method: ${JSON.stringify(method)}, message: ${JSON.stringify(message)}, left: ${count} });
		return true;
	})()`);
}

/** The id of the tab showing `path` of the test server. */
async function tabOn(path) {
	return sw(`(async () => (await chrome.tabs.query({})).find((t) => t.url === ${JSON.stringify(pageUrl + path)})?.id)()`);
}

/** The text of a failed tool call. */
async function failure(name, args) {
	const res = await mcp.callTool({ name, arguments: args });
	const text = res.content.map((c) => c.text).join("\n");
	assert.ok(res.isError, `${name} should have failed: ${text}`);
	return text;
}

test("type after the debugger detached before any key was sent re-attaches and types", async () => {
	await go("edit");
	await tool("fill", { selector: "#t", value: "" });
	await tool("click", { selector: "#t" });
	// A detach nobody was told about: Tabkyra still believes it is attached.
	await sw(`chrome.debugger.detach({ tabId: ${await tabOn("edit")} }).then(() => true)`);
	await tool("type", { selector: "#t", text: "abc" });
	assert.equal(await js("document.getElementById('t').value"), "abc");
});

test("type that hits 'Detached while handling command' before its first key retries once and types", async () => {
	await go("edit");
	await tool("fill", { selector: "#t", value: "" });
	await failNext("Input.dispatchMouseEvent", "Detached while handling command.");
	await tool("type", { selector: "#t", text: "abc" });
	assert.equal(await js("document.getElementById('t').value"), "abc");
});

test("type that detaches once keys may have been sent is interrupted, never the raw CDP message", async () => {
	await go("edit");
	await tool("fill", { selector: "#t", value: "" });
	await failNext("Input.dispatchKeyEvent", "Detached while handling command.");
	const message = await failure("type", { selector: "#t", text: "abc" });
	assert.match(message, /^interrupted: /);
	assert.match(message, /Check the page with read_page before you repeat it/);
	assert.doesNotMatch(message, /Detached while handling command/);
});

test("expected failures carry their own code and no stack trace; internal is for real bugs", async () => {
	await go("stale");
	const first = await tool("read_page", { filter: "interactive" });
	const row = refFor(first, "Delete invoice 5");
	await tool("click", { ref: refFor(first, "Scroll list") });
	await tool("read_page", { filter: "interactive" });
	const cases = [
		["a ref the page reused", "stale_ref", () => failure("click", { ref: row })],
		["a selector with no element (click)", "not_found", () => failure("click", { selector: "#nope" })],
		["a selector with no element (fill)", "not_found", () => failure("fill", { selector: "#nope", value: "x" })],
		["tabs_select of no such tab", "not_found", () => failure("tabs_select", { tabId: 987654 })],
		["tabs_close of no such tab", "not_found", () => failure("tabs_close", { tabId: 987654 })],
		["a read on no such tab", "not_found", () => failure("get_page_text", { tabId: 987654 })],
		["a run_js that throws (isolated world)", "script_error", () => failure("run_js", { code: "(() => { throw new Error('boom') })()" })],
		["a run_js that throws (main world)", "script_error", () => failure("run_js", { code: "(() => { throw new Error('boom') })()", world: "main" })],
		["a bad regex", "bad_params", () => failure("read_console", { pattern: "(" })],
		// The page's own SyntaxError reads like Tabkyra's bad-regex message but is the page's.
		["a run_js whose own regex is invalid", "script_error", () => failure("run_js", { code: "new RegExp('(')" })],
		["a run_js error that reads like a missing selector", "script_error", () => failure("run_js", { code: "(() => { throw new Error('Selector not found: x') })()", world: "main" })],
		["a wait that timed out", "timeout", () => failure("wait", { text: "never appears", timeoutMs: 300 })],
		["a host that does not resolve", "navigation_failed", () => failure("navigate", { url: "https://example.invalid/" })],
		["a stale ref inside actions", "stale_ref", () => failure("actions", { steps: [{ click: { ref: row } }] })],
	];
	for (const [what, code, run] of cases) {
		const text = await run();
		assert.ok(text.startsWith(`${code}: `), `${what}: expected ${code}, got ${text}`);
		assert.doesNotMatch(text, /\n\s+at /, `${what} carries a stack trace: ${text}`);
		assert.doesNotMatch(text, /^internal/, what);
	}
	const thrown = await failure("run_js", { code: "(() => { throw new Error('boom') })()" });
	assert.match(thrown, /^script_error: Error: boom$/);
	// The element is there but a click can't reach it: its own code.
	await go("hits");
	const hits = await tool("read_page", { filter: "interactive" });
	assert.match(await failure("click", { ref: refFor(hits, "Pay now") }), /^not_actionable: .*covered by/);
});

test("find ranks exact and whole-word name matches first, names unlabeled checkboxes from their row, and skips URL-only links", async () => {
	await go("todo");
	const lines = (text) => text.split("\n").filter(Boolean);
	// The item checkboxes have no label of their own: they are named after their row.
	const boxes = lines(await tool("find", { query: "checkbox" }));
	assert.equal(boxes.length, 3, boxes.join("\n"));
	assert.ok(boxes.every((l) => / checkbox "/.test(l)), boxes.join("\n"));
	assert.ok(boxes.some((l) => /checkbox "first task"/.test(l)), boxes.join("\n"));
	assert.ok(boxes.some((l) => /checkbox "third task".*checked/.test(l)), boxes.join("\n"));
	// read_page names them the same way (it printed "on", the checkbox's default value).
	assert.match(await tool("read_page", { filter: "interactive" }), /checkbox "second task"/);
	// A link whose only match is a piece of its URL ("checkbox-guide", "first-task-howto") is not an answer.
	assert.ok(!boxes.some((l) => /TodoMVC|Docs/.test(l)), boxes.join("\n"));
	// Name the row and get its checkbox first.
	const first = lines(await tool("find", { query: "first task checkbox" }));
	assert.match(first[0], /checkbox "first task"/, first.join("\n"));
	// An exact name beats a longer name that merely contains the word.
	const completed = lines(await tool("find", { query: "completed" }));
	assert.match(completed[0], /link "Completed"/, completed.join("\n"));
	// Without a better match, a link found only by its URL is still returned.
	const urlOnly = lines(await tool("find", { query: "howto" }));
	assert.match(urlOnly.join("\n"), /link "Docs"/);
	// Radios that share a parent are named by the label beside each, not the first label among siblings.
	await go("radios");
	const radios = lines(await tool("find", { query: "Large" }));
	assert.equal(radios.filter((l) => / radio "/.test(l)).length, 1, radios.join("\n"));
	assert.match(radios.join("\n"), /radio "Large"/);
	const small = lines(await tool("find", { query: "Small" }));
	assert.equal(small.filter((l) => / radio "/.test(l)).length, 1, small.join("\n"));
	// A group laid out label-first is named the same way: each label belongs to the control after it.
	const medium = lines(await tool("find", { query: "Medium" })).filter((l) => / radio "/.test(l));
	assert.equal(medium.length, 1, medium.join("\n"));
	assert.match(medium[0], /radio "Medium"/);
	assert.match(await tool("read_page", { filter: "interactive" }), /radio "Extra"/);
	assert.doesNotMatch(await tool("read_page", { filter: "interactive" }), /radio "Medium"[\s\S]*radio "Medium"/);
	// Radios that differ only by value are told apart by it.
	const page = await tool("read_page", { filter: "interactive" });
	assert.match(page, /radio "tiny"/);
	assert.match(page, /radio "huge"/);
	// A row's link and its other small text are not its name: the link is found as the link.
	assert.match(page, /checkbox "Buy milk 2 days ago"/);
	const edit = lines(await tool("find", { query: "edit" }));
	assert.match(edit[0], /link "Edit"/, edit.join("\n"));
	assert.ok(!edit.some((l) => / checkbox "/.test(l)), edit.join("\n"));
	// A control alone in a form full of other text is not named with that text: its own name is.
	assert.match(page, /checkbox "agree"/);
	await go("todo");
	// And it is the checkbox, not the row's label, that click and fill need: both are listed.
	const task = lines(await tool("find", { query: "second task" }));
	assert.ok(task.some((l) => /checkbox "second task"/.test(l)), task.join("\n"));
});


/** The console entries of a read_console result, as their texts. */
const texts = (result) => result.entries.map((e) => e.text);
const readConsole = async (args = {}) => JSON.parse(await tool("read_console", args));
const readNetwork = async (args = {}) => JSON.parse(await tool("read_network", args));
const logInPage = (message) => js(`console.log(${JSON.stringify(message)}); 1`, { world: "main" });
const fetchInPage = (path) => js(`fetch(${JSON.stringify(path)}).then((r) => r.status)`, { world: "main" });

test("capture that stopped (a detach nobody announced) is reported by the next read, and resumes", async () => {
	await go("edit");
	await readConsole();
	await readNetwork();
	await logInPage("before-gap");
	await fetchInPage("/before-gap");
	const first = await readConsole();
	assert.deepEqual(texts(first), ["before-gap"]);
	assert.equal(first.capture, undefined, "nothing had stopped yet");

	// The debugger leaves without an onDetach event; the next input re-attaches silently.
	await sw(`chrome.debugger.detach({ tabId: ${await tabOn("edit")} }).then(() => true)`);
	await logInPage("during-gap");
	await fetchInPage("/during-gap");

	const afterGap = await readConsole();
	assert.ok(afterGap.capture, "the read must say capture stopped, not return old data as live");
	assert.match(afterGap.capture.stopped[0].reason, /detached without notice/);
	assert.ok(afterGap.capture.stopped[0].at && afterGap.capture.resumedAt);
	assert.match(afterGap.capture.note, /on again/);
	assert.equal(texts(afterGap).filter((t) => t === "before-gap").length, 1, "a replayed entry doubled an old one");
	const net = await readNetwork();
	assert.ok(net.capture, "network capture stopped too");
	assert.match(net.capture.stopped[0].reason, /detached without notice/);
	assert.ok(net.entries.some((e) => e.url.endsWith("/before-gap")));
	assert.ok(!net.entries.some((e) => e.url.endsWith("/during-gap")), "a request from the gap cannot be there");

	// Reported once; events after the gap are captured.
	await logInPage("after-gap");
	await fetchInPage("/after-gap");
	const later = await readConsole();
	assert.equal(later.capture, undefined);
	assert.ok(texts(later).includes("after-gap"));
	const laterNet = await readNetwork();
	assert.equal(laterNet.capture, undefined);
	assert.ok(laterNet.entries.some((e) => e.url.endsWith("/after-gap")));
});

test("after a gap, messages already read and cleared do not come back, and the same text on a new page is kept", async () => {
	await go("edit");
	await readConsole({ clear: true });
	await logInPage("cleared-msg");
	assert.deepEqual(texts(await readConsole({ clear: true })), ["cleared-msg"]);
	await logInPage("ready");
	const id = await tabOn("edit");
	await sw(`chrome.debugger.detach({ tabId: ${id} }).then(() => true)`);
	await logInPage("during-gap");
	const first = await readConsole();
	assert.ok(first.capture);
	assert.ok(!texts(first).includes("cleared-msg"), `a cleared message came back: ${JSON.stringify(first.entries)}`);
	assert.equal(texts(first).filter((t) => t === "ready").length, 1, "the buffered entry was doubled by the replay");

	// A new page (another document) logs the same text while the debugger is away.
	await sw(`chrome.debugger.detach({ tabId: ${id} }).then(() => true)`);
	await tool("navigate", { url: `${pageUrl}edit?b` });
	await logInPage("ready");
	const second = await readConsole();
	assert.ok(second.capture);
	assert.equal(texts(second).filter((t) => t === "ready").length, 2, "the new page's message was taken for the old one");
	assert.ok(!texts(second).includes("cleared-msg"));
});

test("a navigation under type's focusing click is reported, not retried on the new page; capture keeps running", async () => {
	await go("edit");
	await tool("fill", { selector: "#t", value: "" });
	await readConsole({ clear: true });
	await readNetwork({ clear: true });
	await failNext("Input.dispatchMouseEvent", "Inspected target navigated or closed");
	const message = await failure("type", { selector: "#t", text: "abc" });
	assert.match(message, /^interrupted: The page navigated while type was running, so it may have run \(no key was typed\)/);
	assert.equal(await js("document.getElementById('t').value"), "", "type must not have typed after the navigation");
	await logInPage("still-captured");
	const result = await readConsole();
	assert.equal(result.capture, undefined, "the debugger never detached: nothing stopped");
	assert.ok(texts(result).includes("still-captured"));
	assert.equal((await readNetwork()).capture, undefined);
	// And when keys may already have gone out, the agent hears about the navigation, not a detach.
	await failNext("Input.dispatchKeyEvent", "Inspected target navigated or closed");
	const later = await failure("type", { selector: "#t", text: "x" });
	assert.match(later, /^interrupted: The page navigated while type was running/);
});

test("a silent detach is reported once when read_console is the first call after it", async () => {
	await go("edit");
	await readConsole();
	await readNetwork();
	await sw(`chrome.debugger.detach({ tabId: ${await tabOn("edit")} }).then(() => true)`);
	// No input between the detach and the read: nothing has noticed it yet.
	const first = await readConsole();
	assert.ok(first.capture, "the first read after a silent detach reports it");
	assert.equal((await readConsole()).capture, undefined, "and only once: nothing stopped in between");
	const net = await readNetwork();
	assert.ok(net.capture);
	assert.equal((await readNetwork()).capture, undefined);
});

test("capture that stopped because the page crashed is reported, and resumes after the reload", async () => {
	await go("edit");
	await readConsole();
	await logInPage("before-crash");
	const id = await tabOn("edit");
	const page = (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.type === "page" && t.url === `${pageUrl}edit`);
	await cdp(page.webSocketDebuggerUrl, "Page.crash").catch(() => {});
	await until(() => sw(`chrome.tabs.get(${id}).then(() => true)`), 5000, "the crashed tab");
	await sw(`chrome.tabs.reload(${id}).then(() => true)`);
	await until(async () => (await js("document.readyState")) === "complete", 30_000, "the reloaded page");
	await logInPage("after-crash");
	const result = await readConsole();
	assert.ok(result.capture, "a crash must be reported");
	assert.match(result.capture.stopped[0].reason, /crashed/);
	assert.ok(texts(result).includes("after-crash"));
	assert.equal((await readConsole()).capture, undefined);
});

test("capture lost to a worker restart is reported, and resumes", async () => {
	await go("edit");
	await readConsole();
	await logInPage("before-restart");
	const version = await (await fetch(`http://${devtools}/json/version`)).json();
	const worker = (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.type === "service_worker" && t.url.includes(EXTENSION_ID));
	await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId: worker.id });
	await connected();
	const result = await readConsole();
	assert.ok(result.capture, "a restart must be reported, not look like a first call");
	assert.match(result.capture.stopped[0].reason, /background worker restarted/);
	// Anything from before the restart that the browser replays is flagged, never passed off as live.
	const old = result.entries.filter((x) => x.text === "before-restart");
	assert.equal(old.length, 1, `the browser's history should bring the pre-restart message back: ${JSON.stringify(result.entries)}`);
	assert.equal(old[0].replayed, true, JSON.stringify(old[0]));
	// What is logged from here on is captured again.
	await logInPage("after-restart");
	const later = await readConsole();
	assert.equal(later.capture, undefined);
	assert.ok(texts(later).includes("after-restart"));
});

test("a tab the tool opens captures its first load: tabs_create and the first navigate of a session", async () => {
	await connected();
	const created = await tool("tabs_create", { url: `${pageUrl}boot` });
	const tabId = Number(created.match(/"tabId":(\d+)/)?.[1] ?? created.match(/\b(\d{6,})\b/)?.[1]);
	assert.ok(tabId, created);
	const net = await readNetwork({ tabId });
	assert.ok(net.entries.some((e) => e.url.endsWith("/boot") && e.type === "Document"), JSON.stringify(net.entries));
	assert.ok(net.entries.some((e) => e.url.endsWith("/boot-data")), "the first load's fetch was missed");
	assert.ok(texts(await readConsole({ tabId })).includes("boot-log"));
	await tool("tabs_close", { tabId });

	// A fresh session's first navigate opens its tab on the URL.
	const project = join(home, "projects", "first-load");
	mkdirSync(project, { recursive: true });
	execFileSync("git", ["init", "-q", project]);
	const agent = await agentIn(project);
	try {
		await on(agent, "navigate", { url: `${pageUrl}boot` });
		const net2 = JSON.parse(await on(agent, "read_network", {}));
		assert.ok(net2.entries.some((e) => e.url.endsWith("/boot-data")), JSON.stringify(net2.entries));
		assert.ok(JSON.parse(await on(agent, "read_console", {})).entries.some((e) => e.text === "boot-log"));
	} finally {
		await agent.close();
	}
});

test("the first navigate of a session that cannot load the page fails with navigation_failed, and the tab stays", async () => {
	await connected();
	const project = join(home, "projects", "first-nav-fails");
	mkdirSync(project, { recursive: true });
	execFileSync("git", ["init", "-q", project]);
	const agent = await agentIn(project);
	try {
		const res = await agent.callTool({ name: "navigate", arguments: { url: "https://example.invalid/" } });
		const text = res.content.map((c) => c.text).join("\n");
		assert.ok(res.isError, `a page that did not load must not be reported as loaded: ${text}`);
		assert.match(text, /^navigation_failed: /);
		// Same answer as for a session that already had a tab; the tab it opened is still the agent's.
		assert.match(await on(agent, "tabs_context"), /about:blank|example\.invalid/);
	} finally {
		await agent.close();
	}
});

test("a new tab says so when capture could not start on it, instead of silently missing the first load", async () => {
	await connected();
	await failNext("Runtime.enable", "Cannot attach to this target");
	const created = JSON.parse(await tool("tabs_create", { url: `${pageUrl}boot` }));
	assert.match(created.note, /capture could not start on this tab \(console: Cannot attach to this target\)/);
	assert.match(created.note, /first load was not captured/);
	await tool("tabs_close", { tabId: created.tabId });
	// And a tab where it started carries no note.
	const fine = JSON.parse(await tool("tabs_create", { url: `${pageUrl}boot` }));
	assert.equal(fine.note, undefined);
	await tool("tabs_close", { tabId: fine.tabId });
});

test("press refuses clipboard chords before any key event: no paste/copy/cut or keydown reaches the page", async () => {
	await go("clip");
	await tool("click", { selector: "#t" });
	const chords = ["Control+v", "Meta+v", "Control+c", "Meta+c", "Control+x", "Meta+x", "Control+Shift+v", "Shift+Insert", "Control+Insert", "Shift+Delete", "ctrl+V"];
	for (const key of chords) {
		const text = await failure("press", { key });
		assert.match(text, /^bad_params: .*clipboard chords are not supported; use fill or type/, key);
	}
	assert.match(await failure("actions", { steps: [{ press: "Control+v" }] }), /^bad_params: .*step 0 \(press\).*clipboard chords are not supported/);
	assert.deepEqual(await js("window.__seen", { world: "main" }), [], "a key event or clipboard event reached the page");
	assert.equal(await js("document.getElementById('t').value"), "");
	// Other chords still go through.
	await tool("press", { key: "Control+a" });
	assert.ok((await js("window.__seen", { world: "main" })).includes("keydown:a"));
});

test("an actions step that is interrupted keeps the extension's own message, not 'connection dropped'", async () => {
	await go("edit");
	await tool("fill", { selector: "#t", value: "" });
	await failNext("Input.dispatchKeyEvent", "Detached while handling command.");
	const message = await failure("actions", { steps: [{ type: { selector: "#t", text: "abc" } }] });
	assert.match(message, /^interrupted: step 0 \(type\) failed after 0 steps succeeded: /);
	assert.match(message, /Check the page with read_page before you repeat it/);
	assert.doesNotMatch(message, /connection dropped/);
});

test("tabs_create on a page that cannot load opens the tab and says the page did not load", async () => {
	await connected();
	const created = JSON.parse(await tool("tabs_create", { url: "https://example.invalid/" }));
	assert.match(created.note, /^The page did not load: Navigation to https:\/\/example\.invalid\/ failed: /);
	await tool("tabs_close", { tabId: created.tabId });
});
