// The community skill loop end to end, in a throwaway browser (docs/decisions.md D27,
// CONTRIBUTING-skills.md). Nothing here touches an installed browser, the user's Tabkyra
// config, their gh sign-in or the network beyond a read-only clone of the target repository.
//
//   node cli/eval/community-loop.mjs [--remote <git url or folder>]
//
// 1. An agent writes a Notion-style navigation skill through MCP skill_manage (lint first; it
//    saves only with apply) and tests it with its router cases.
// 2. It follows the skill on a local Notion-style page through the real Tabkyra MCP tools.
// 3. It prepares a submission: refused in this profile (gh isn't signed in here), then the CLI
//    preview and `--dry-run --confirm <code>` against a clone of the target. No push, no PR.
// 4. A test catalog with the skill, signed with a throwaway key the profile trusts, syncs into
//    the profile through the extension's Settings action and the native host; a tampered
//    catalog is refused, a revoked skill is removed, and opting out empties the list.
//
// Needs `npm run build` at the repo root and in cli/, and a Playwright Chromium.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { signMinisign, throwawayKey } from "../test/helpers/minisign-sign.mjs";
import { cdp, cli, EXTENSION_ID, launchFixtureBrowser, repo, until } from "./fixture-browser.mjs";

const remoteArg = process.argv.indexOf("--remote");
const remote = remoteArg > 0 ? process.argv[remoteArg + 1] : undefined;
const fixture = join(repo, "cli", "test", "fixtures", "community");
const skillText = readFileSync(join(fixture, "notion-navigation", "SKILL.md"), "utf8");
const cases = readFileSync(join(fixture, "notion-navigation.cases.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l));

const results = [];
function pass(step, detail) {
	results.push({ step, ok: true, detail });
	console.log(`PASS ${step}: ${detail}`);
}
function check(cond, step, detail) {
	if (!cond) {
		console.log(`FAIL ${step}: ${detail}`);
		throw new Error(`${step} failed`);
	}
	pass(step, typeof detail === "string" ? detail.split("\n")[0].slice(0, 200) : String(detail));
}

// --- A Notion-style page: sidebar tree with toggles, Quick Find on Meta/Control+P, breadcrumbs.
const PAGES = {
	home: { title: "Home", path: [], body: "<p>Welcome to the workspace.</p>" },
	team: { title: "Team Meetings", path: [], body: "<p>Notes from team meetings.</p>" },
	weekly: {
		title: "Weekly Sync",
		path: ["team"],
		body: "<h2>Action items</h2><ul><li>Ship the beta build</li><li>Book the venue</li><li>Draft the release notes</li></ul><details><summary>Older items</summary><p>Archive the Q2 board.</p></details>",
	},
	archive: { title: "Archive", path: [], body: "<p>Old pages.</p>" },
	weekly2025: { title: "Weekly Sync 2025", path: ["archive"], body: "<p>Last year's notes.</p>" },
	projects: { title: "Projects", path: [], body: "<p>All projects.</p>" },
	launch: { title: "Launch", path: ["projects"], body: "<h2>Launch plan</h2><p>Three phases: beta, press, general availability.</p>" },
};
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Workspace</title>
<style>body{display:flex;font-family:sans-serif;margin:0}nav{width:220px;background:#f7f7f5;padding:8px}main{padding:16px;flex:1}
.row{display:flex;gap:4px;align-items:center}.child{margin-left:18px}#qf{position:fixed;top:60px;left:30%;background:#fff;border:1px solid #ccc;padding:8px;width:40%}</style></head>
<body><nav aria-label="Sidebar"><div role="button" tabindex="0" id="search">Search</div>
<div class="row"><a href="#home">Home</a></div>
<div class="row"><button aria-label="Open Team Meetings" data-open="team">&#9656;</button><a href="#team">Team Meetings</a></div><div id="kids-team" hidden><div class="row child"><a href="#weekly">Weekly Sync</a></div></div>
<div class="row"><button aria-label="Open Projects" data-open="projects">&#9656;</button><a href="#projects">Projects</a></div><div id="kids-projects" hidden><div class="row child"><a href="#launch">Launch</a></div></div>
<div class="row"><button aria-label="Open Archive" data-open="archive">&#9656;</button><a href="#archive">Archive</a></div><div id="kids-archive" hidden><div class="row child"><a href="#weekly2025">Weekly Sync 2025</a></div></div>
</nav><main><div aria-label="Breadcrumb" id="crumbs"></div><h1 id="title"></h1><div id="body"></div><button>Share</button></main>
<div id="qf" role="dialog" aria-label="Quick Find" hidden><input id="q" aria-label="Search pages" placeholder="Search"><div role="listbox" id="results"></div></div>
<script>
const PAGES = ${JSON.stringify(PAGES)};
function render() {
  const id = location.hash.slice(1) || "home"; const p = PAGES[id] || PAGES.home;
  document.getElementById("crumbs").innerHTML = [...p.path, id].map((k) => '<a href="#' + k + '">' + PAGES[k].title + '</a>').join(" / ");
  document.getElementById("title").textContent = p.title; document.getElementById("body").innerHTML = p.body;
  document.getElementById("qf").hidden = true;
}
function openQf() { const qf = document.getElementById("qf"); qf.hidden = false; const q = document.getElementById("q"); q.value = ""; q.focus(); list(""); }
function list(text) {
  const r = document.getElementById("results"); r.innerHTML = "";
  if (!text) return;
  for (const [id, p] of Object.entries(PAGES)) if (p.title.toLowerCase().includes(text.toLowerCase())) {
    const o = document.createElement("div"); o.setAttribute("role", "option"); o.tabIndex = 0;
    o.textContent = p.title + " (in " + (p.path.map((k) => PAGES[k].title).join(" / ") || "Workspace") + ")";
    o.onclick = () => { location.hash = id; }; r.appendChild(o);
  }
}
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") { e.preventDefault(); openQf(); } if (e.key === "Escape") document.getElementById("qf").hidden = true; });
document.getElementById("q").addEventListener("input", (e) => list(e.target.value));
document.getElementById("search").onclick = openQf;
for (const b of document.querySelectorAll("button[data-open]")) b.onclick = () => { const k = document.getElementById("kids-" + b.dataset.open); k.hidden = !k.hidden; b.setAttribute("aria-label", (k.hidden ? "Open " : "Close ") + PAGES[b.dataset.open].title); };
window.addEventListener("hashchange", render); render();
</script></body></html>`;

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const work = mkdtempSync(join(tmpdir(), "tk-community-loop-"));
const key = throwawayKey();
const pubFile = join(work, "test-catalog.pub");
writeFileSync(pubFile, key.publicText);
const catalogDir = join(work, "catalog");
mkdirSync(catalogDir);
const fb = await launchFixtureBrowser({
	extraEnv: {
		TABKYRA_UPDATE_PUBKEY: pubFile,
		TABKYRA_COMMUNITY_URL: catalogDir,
		TABKYRA_CLIENT_NAME: "community-loop",
		TABKYRA_SESSION: "community-loop",
		// Harness folders a saved skill is installed into: inside the throwaway home, whatever the
		// caller's environment points at (a CLAUDE_CONFIG_DIR would otherwise be the real one).
		CLAUDE_CONFIG_DIR: join(work, "home-claude"),
		CODEX_HOME: join(work, "home-codex"),
		XDG_CONFIG_HOME: join(work, "home-xdg"),
	},
});
let mcp;
try {
	await fb.waitConnected();
	mcp = new Client({ name: "community-loop", version: "0.0.0" });
	await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: fb.env, stderr: "ignore" }));
	const call = async (name, args = {}) => {
		const r = await mcp.callTool({ name, arguments: args });
		return { error: Boolean(r.isError), text: r.content.map((c) => c.text ?? "").join("\n") };
	};
	const tool = async (name, args) => {
		const r = await call(name, args);
		if (r.error) throw new Error(`${name}: ${r.text}`);
		return r.text;
	};

	// 1. Write and test the skill through MCP.
	const dry = await call("skill_manage", { action: "write", name: "notion-navigation", text: skillText });
	check(!dry.error && /Nothing changed yet/.test(dry.text), "write (lint, diff, nothing saved)", dry.text);
	const saved = await call("skill_manage", { action: "write", name: "notion-navigation", text: skillText, apply: true });
	check(/Saved notion-navigation/.test(saved.text), "write apply:true (the scripted stand-in for the user's yes)", saved.text);
	const tested = await call("skill_manage", { action: "test", name: "notion-navigation", cases });
	check(/^PASS/.test(tested.text), "test (lint, community rules, router cases)", tested.text.split("\n").slice(0, 3).join(" | "));

	// 2. Follow the skill on the Notion-style page through the real tools.
	await tool("tabs_context");
	await tool("navigate", { url: pageUrl });
	await tool("wait", { text: "Search" });
	await tool("press", { key: process.platform === "darwin" ? "Meta+p" : "Control+p" });
	await tool("type", { text: "Weekly Sync" });
	const options = await tool("read_page", { filter: "interactive" });
	const pick = options.match(/\[?(e\d+)\]?[^\n]*Weekly Sync \(in Team Meetings\)/)?.[1];
	check(pick && /Weekly Sync 2025/.test(options), "Quick Find lists both matches with their paths (step 6)", pick ? `picked ${pick}, the one under Team Meetings` : options);
	await tool("click", { ref: pick });
	await tool("wait", { text: "Action items" });
	const crumbs = await tool("read_page", {});
	check(/Team Meetings[\s\S]{0,200}Weekly Sync/.test(crumbs), "breadcrumb ends with the page asked for (step 8)", "Team Meetings / Weekly Sync");
	const text = await tool("get_page_text", {});
	check(/Ship the beta build/.test(text) && /Book the venue/.test(text) && /Draft the release notes/.test(text), "page read (step 9)", "three action items read");
	const projects = await tool("find", { query: "Open Projects" });
	const toggle = projects.match(/\[?(e\d+)\]?[^\n]*Open Projects/)?.[1];
	check(toggle, "sidebar fallback finds the parent's arrow (step 7)", toggle ?? projects);
	await tool("click", { ref: toggle });
	const launch = (await tool("find", { query: "Launch" })).match(/\[?(e\d+)\]?[^\n]*Launch/)?.[1];
	await tool("click", { ref: launch });
	await tool("wait", { text: "Launch plan" });
	check(/three phases/i.test(await tool("get_page_text", {})), "child page opened from the unfolded sidebar (step 7)", "Launch plan read");

	// 3. Submission: MCP prepares only; gh isn't signed in in this throwaway profile, so it's refused.
	const prepared = await call("skill_manage", { action: "prepare_submit", name: "notion-navigation", cases });
	check(prepared.error && /gh isn't (signed in|installed)[^\n]*Fix:/.test(prepared.text), "prepare_submit refused without a signed-in gh, with the fix", prepared.text);
	const submitEnv = { ...fb.env, ...(remote ? { TABKYRA_SUBMIT_REMOTE: remote } : {}) };
	const preview = spawnSync(process.execPath, [cli, "skill", "submit", "notion-navigation", "--dry-run"], { env: submitEnv, encoding: "utf8" });
	const code = preview.stdout.match(/--confirm ([0-9a-f]{10})/)?.[1];
	check(preview.status === 3 && code && /Nothing was sent/.test(preview.stdout), "submit preview (exit 3, nothing sent)", `code ${code}`);
	writeFileSync(join(work, "preview.txt"), preview.stdout);
	const sent = spawnSync(process.execPath, [cli, "skill", "submit", "notion-navigation", "--dry-run", "--confirm", code], { env: submitEnv, encoding: "utf8" });
	check(sent.status === 0 && /nothing was pushed/.test(sent.stdout), "submit --dry-run --confirm (scratch commit, no push, no PR)", sent.stdout.split("\n").slice(1, 4).join(" | "));
	await tool("skill_manage", { action: "remove", name: "notion-navigation" });

	// 4. A signed test catalog, synced into this profile through the extension.
	const merged = join(work, "merged");
	cpSync(join(repo, "skills"), join(merged, "skills"), { recursive: true });
	mkdirSync(join(merged, "community", "skills", "notion-navigation"), { recursive: true });
	writeFileSync(join(merged, "community", "skills", "notion-navigation", "SKILL.md"), skillText);
	const publish = (serial, tamper = false) => {
		const out = join(catalogDir, "community-catalog.json");
		const r = spawnSync(process.execPath, [cli, "skill", "catalog", merged, "--out", out, "--serial", String(serial), "--source", "dry-run"], { encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stdout + r.stderr);
		const data = readFileSync(out);
		writeFileSync(join(catalogDir, "community-catalog.json.minisig"), signMinisign(data, key, `tabkyra community-catalog ${serial}`));
		if (tamper) writeFileSync(out, data.toString().replace("Quick Find", "Quick  Find"));
	};
	// The Settings action, from an extension page, as the Skills tab sends it.
	const version = await (await fetch(`http://${fb.devtools}/json/version`)).json();
	const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` });
	const page = await until(async () => (await fb.targets()).find((t) => t.id === targetId && t.url.startsWith("chrome-extension://")), 15000, "an extension page");
	const inPage = async (expression) => (await cdp(page.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
	const action = (a) => inPage(`chrome.runtime.sendMessage({ type: "tabkyra-community-action", action: "${a}" })`);
	const status = () => inPage(`chrome.storage.local.get("community.status").then((d) => d["community.status"] ?? null)`);

	publish(100);
	check((await action("sync"))?.ok, "Settings sync action reaches the native host", "ok");
	const synced = await until(async () => {
		const s = await status();
		return s?.serial === 100 && s.skills.some((k) => k.name === "notion-navigation") ? s : undefined;
	}, 30000, "catalog 100 in the profile");
	check(synced, "signed catalog verified and synced into the profile", `serial ${synced.serial}: ${synced.skills.map((k) => `${k.name} [${k.provenance}; ${k.sites.join(", ")}]`).join(", ")}`);
	check(/notion-navigation/.test((await tool("skill_match", { task: "open my Weekly Sync page in Notion" })).split("\n")[0]), "skill_match picks the synced community skill", "notion-navigation");
	check(/^\[community, catalog 100;[^\n]*scoped to notion\.so, notion\.site/.test(await tool("skill_read", { name: "notion-navigation" })), "skill_read names provenance and scope first", "header present");

	publish(101, true);
	await action("sync");
	const refused = await until(async () => {
		const s = await status();
		return s?.error && /Refused the community catalog/.test(s.error) ? s : undefined;
	}, 30000, "the tampered catalog to be refused");
	check(refused.serial === 100 && refused.skills.length === 1, "tampered catalog refused; catalog 100 stays in use", refused.error);

	rmSync(join(merged, "community", "skills", "notion-navigation"), { recursive: true });
	writeFileSync(join(merged, "community", "revoked.json"), JSON.stringify({ revoked: [{ skill: "notion-navigation", reason: "dry run: pulled to test revocation" }] }));
	publish(102);
	await action("sync");
	const pulled = await until(async () => {
		const s = await status();
		return s?.serial === 102 ? s : undefined;
	}, 30000, "catalog 102");
	check(pulled.skills.length === 0 && pulled.removed.some((r) => r.name === "notion-navigation"), "revoked skill removed from the profile", pulled.notes.join(" ") || JSON.stringify(pulled.removed));
	check(!/^notion-navigation/.test(await tool("skill_match", { task: "open my Weekly Sync page in Notion" })), "skill_match no longer picks it", "not matched");

	await action("off");
	const off = await until(async () => {
		const s = await status();
		return s && s.enabled === false ? s : undefined;
	}, 15000, "opt-out");
	check(off.skills.length === 0, "Settings opt-out turns community skills off", "enabled false");
	await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });
} catch (err) {
	console.log(`ERROR ${err.message}`);
	process.exitCode = 1;
} finally {
	await mcp?.close().catch(() => {});
	await fb.close();
	server.close();
	console.log(JSON.stringify({ ok: process.exitCode !== 1, steps: results.length, preview: join(work, "preview.txt") }));
}
