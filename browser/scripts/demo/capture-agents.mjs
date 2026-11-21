// Records the footage for the "Agents" video (media/agents.mp4) from one real run. Nothing here
// is mocked: the built extension runs in a throwaway headless Chromium, three `tabkyra mcp`
// processes (the way three Claude Code agents in one project start them) are driven by scripted
// MCP clients, the side panel is the extension's own sidepanel.html in a tab of that browser,
// and the CLI runs against the same browser.
//
//   npm run build && (cd cli && npm run build) && node scripts/demo/capture-agents.mjs
//
// Writes media/video/public/capture/agents/ (PNG/JPEG frames) and agents.json (tool calls and
// their real results, group titles and colors read from chrome.tabGroups, CLI output and exit
// codes, the shop's order count). The old capture is replaced only when every step and check
// passes.
//
// The side panel's own agent (the `/` and `@` beat) needs a model. The capture uses a local
// OpenAI-compatible server, by default an Ollama on 127.0.0.1:11555 that accepts the extension's
// origin (OLLAMA_ORIGINS='chrome-extension://*'); set TABKYRA_DEMO_MODEL_URL and
// TABKYRA_DEMO_MODEL to use another. The default, qwen3-8b-nothink, is qwen3:8b with its chat
// template's no-thinking path always on (README "Agents video"). No API key or paid service is
// involved.
//
// One gesture is made through the API rather than with a mouse: dragging a tab out of an
// agent's group. Headless Chromium has no tab strip to drag in, so the run calls
// chrome.tabs.ungroup on the tab, which fires the same tabs.onUpdated (groupId -1) event a drag
// out of the group does.
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchFixtureBrowser, sleep, until } from "../../cli/eval/fixture-browser.mjs";
import { Client } from "../../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { connectCdp } from "./panel-cdp.mjs";

if (typeof WebSocket !== "function") {
	throw new Error(`Node ${process.versions.node} has no built-in WebSocket. The capture needs Node 22.4 or newer.`);
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repo, "cli", "dist", "index.js");
const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";
const target = join(repo, "media", "video", "public", "capture", "agents");
const MODEL_URL = process.env.TABKYRA_DEMO_MODEL_URL ?? "http://127.0.0.1:11555/v1";
const MODEL = process.env.TABKYRA_DEMO_MODEL ?? "qwen3-8b-nothink";

for (const [path, fix] of [
	[cli, "cd cli && npm install && npm run build"],
	[join(repo, "dist-chrome", "manifest.json"), "npm run build"],
]) {
	if (!existsSync(path)) throw new Error(`${path} is missing. Run: ${fix}`);
}

// ---- the shop: the project the three agents are testing -------------------------------------

let orders = 0;
const STYLE = `<style>
body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#faf7f2;color:#22303a;zoom:1.5}
header{background:#7a3e1d;color:#fff;padding:16px 40px;font-size:22px;font-weight:600;display:flex;justify-content:space-between}
header small{font-size:14px;font-weight:400;opacity:.8}
main{max-width:720px;margin:24px auto;padding:0 24px}
.card{background:#fff;border:1px solid #e8dfd3;border-radius:12px;padding:18px 22px;margin-top:12px}
.row{display:flex;justify-content:space-between;align-items:center}
.price{font-size:22px;font-weight:600;color:#7a3e1d}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#7a3e1d;color:#fff;cursor:pointer}
label{display:block;margin:12px 0 4px;font-weight:600}input,select{font:inherit;padding:9px 12px;border:1px solid #cfc5b6;border-radius:8px;width:320px;background:#fff}
.muted{color:#6b7480;font-size:14px}.ok{background:#e4f3ec;border:1px solid #9fd2b8;border-radius:12px;padding:18px 22px;font-size:18px}
</style>`;
const page = (title, body) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${STYLE}</head><body><header>Fernhill Goods<small>dev build</small></header><main>${body}</main></body></html>`;
/** A product page with the markup shops usually have (schema.org Product, a meta description). */
const product = (name, description, price, note) =>
	page(
		`${name} · Fernhill Goods`,
		`<div class="product" itemscope itemtype="https://schema.org/Product"><h1 class="product-title" itemprop="name">${name}</h1><div class="card"><div class="row"><div class="product-description" itemprop="description">${description}</div><span class="price product-price" itemprop="price">${price}</span></div><p><button>Add to cart</button></p></div><p class="muted">${note}</p></div>`,
	).replace("<title>", `<meta name="description" content="${description}"><title>`);
const PAGES = {
	"/product/kettle": product(
		"Copper Kettle",
		"Hand-hammered copper, 1.7 L, works on gas and induction.",
		"$48",
		"Ships in 2 days.",
	),
	"/product/teapot": product(
		"Stoneware Teapot",
		"Speckled stoneware, 1 L, with a steel infuser. Glazed by hand in small batches, so each one is a little different.",
		"$36",
		"Dishwasher safe. Ships in 3 days.",
	),
	"/cart": page(
		"Cart · Fernhill Goods",
		`<h2>Your cart</h2><div class="card row"><span><b>Copper Kettle</b><br><span class="muted">Qty 1</span></span><span class="price">$48</span></div><div class="card row"><span><b>Linen Tea Towels (2)</b><br><span class="muted">Qty 1</span></span><span class="price">$18</span></div><div class="card row"><b>Total</b><span class="price">$66</span></div><p><button>Check out</button></p>`,
	),
	"/checkout": page(
		"Checkout · Fernhill Goods",
		`<h2>Checkout</h2><form id="f" class="card"><label for="name">Name on order</label><input id="name"><label for="pay">Payment</label><select id="pay"><option>Choose a payment method</option><option>Test card</option><option>PayPal sandbox</option></select><p><button id="place">Place order</button></p></form><p id="msg" class="muted">Total $66</p>
<script>document.getElementById("f").onsubmit=async(e)=>{e.preventDefault();const r=await fetch("/api/order",{method:"POST"});const n=await r.text();document.querySelector("main").innerHTML='<h2>Checkout</h2><div class="ok">Order #'+n+' placed for <b>'+document.getElementById("name").value+'</b>, paid by '+document.getElementById("pay").value+'.</div>'}</script>`,
	),
};

// ---- the run ------------------------------------------------------------------------------

const ATTEMPTS = Number.parseInt(process.env.TABKYRA_DEMO_ATTEMPTS ?? "3", 10);
if (!(ATTEMPTS >= 1) || String(ATTEMPTS) !== (process.env.TABKYRA_DEMO_ATTEMPTS ?? "3").trim())
	throw new Error(
		`TABKYRA_DEMO_ATTEMPTS must be a whole number of 1 or more, not "${process.env.TABKYRA_DEMO_ATTEMPTS}"`,
	);
/** The side panel's model ended without doing the task: worth a fresh attempt. */
class ModelMissed extends Error {}

/** Facts the teapot page's body states and its tab title doesn't (media/video/src/agents/claims.ts, PAGE_FACTS). */
const PAGE_FACTS = ["1 L", "$36", "infuser", "speckled", "glazed"];

let out;
async function main() {
	// A small local model doesn't always finish the side panel task (it may guess a selector
	// and give up). Such a run is thrown away whole, its folder included, and the capture starts
	// over in a fresh browser and a fresh folder; agents.json records which attempt passed.
	for (let attempt = 1; ; attempt++) {
		out = mkdtempSync(join(repo, "media", "video", "public", "capture", ".agents-new-"));
		try {
			orders = 0;
			const capture = await record();
			capture.attempt = attempt;
			writeFileSync(join(out, "agents.json"), `${JSON.stringify(capture, null, "\t")}\n`);
			swapIn(out, target);
			console.log(`wrote ${target}`);
			return;
		} catch (err) {
			if (err instanceof ModelMissed && attempt < ATTEMPTS) {
				console.error(`attempt ${attempt}: ${err.message}; starting over`);
				continue;
			}
			keepFailed(out);
			throw err;
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}
}

/** Moves a failed run's frames to the temp folder for a look; never hides the run's own error. */
function keepFailed(dir) {
	const kept = join(tmpdir(), `tabkyra-agents-failed-${process.pid}`);
	try {
		try {
			renameSync(dir, kept);
		} catch (err) {
			// The repo can sit on another volume than the temp folder: copy, then remove.
			if (err.code !== "EXDEV") throw err;
			cpSync(dir, kept, { recursive: true });
			rmSync(dir, { recursive: true, force: true });
		}
		console.error(`partial capture kept in ${kept}`);
	} catch (err) {
		console.error(`couldn't keep the partial capture: ${err.message}`);
	}
}

/** Replaces `target` with `fresh` by renames only, so a failure leaves the old capture in place. */
function swapIn(fresh, target) {
	const old = `${target}.old-${process.pid}`;
	const hadOld = existsSync(target);
	if (hadOld) renameSync(target, old);
	try {
		renameSync(fresh, target);
	} catch (err) {
		if (hadOld) renameSync(old, target);
		throw err;
	}
	if (hadOld) rmSync(old, { recursive: true, force: true });
}

async function record() {
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/api/order") {
			orders++;
			res.end(String(orders));
			return;
		}
		const body = PAGES[new URL(req.url, "http://x").pathname];
		res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
		res.end(body ?? "not found");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const site = `http://127.0.0.1:${server.address().port}`;
	// The project the agents work in: a git repository named "shop".
	const projectParent = mkdtempSync(join(tmpdir(), "tk-agents-"));
	const project = join(projectParent, "shop");
	mkdirSync(project);
	execFileSync("git", ["init", "-q", project]);

	const fx = await launchFixtureBrowser({
		extraEnv: { TABKYRA_AUTO_ALLOW: "" },
		extraArgs: ["--window-size=1120,720", "--lang=en-US"],
	});
	const clients = [];
	let cdp;
	const capture = { recordedAt: new Date().toISOString(), project: "shop", site, agents: {}, cli: {} };
	try {
		await fx.waitConnected();
		fx.tabkyra(["allow", "127.0.0.1"]);

		// Three agents of one harness in one project, no session configured.
		const env = { ...fx.env, TABKYRA_CLIENT_NAME: "claude" };
		delete env.TABKYRA_SESSION;
		delete env.TABKYRA_AUTO_ALLOW;
		const log = [];
		const connect = async (who) => {
			const client = new Client({ name: "claude-code", version: "0.0.0" });
			await client.connect(
				new StdioClientTransport({
					command: process.execPath,
					args: [cli, "mcp"],
					env,
					cwd: project,
					stderr: "ignore",
				}),
			);
			clients.push(client);
			return { who, client };
		};
		/** One tool call; `allowError` keeps an error result instead of throwing. */
		const call = async (agent, name, args = {}, { allowError = false } = {}) => {
			const started = Date.now();
			const result = await agent.client.callTool({ name, arguments: args }, undefined, { timeout: 330_000 });
			const text = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const entry = {
				agent: agent.who,
				name,
				args,
				ms: Date.now() - started,
				isError: result.isError === true,
				text: text.slice(0, 4000),
			};
			log.push(entry);
			if (result.isError && !allowError) throw new Error(`${agent.who} ${name}: ${text}`);
			return entry;
		};
		const shot = async (agent, file) => {
			const result = await agent.client.callTool({ name: "screenshot", arguments: { maxWidth: 1280 } });
			const image = result.content.find((c) => c.type === "image");
			if (result.isError || !image) throw new Error(`screenshot: ${JSON.stringify(result.content).slice(0, 300)}`);
			writeFileSync(join(out, file), Buffer.from(image.data, "base64"));
			return `capture/agents/${file}`;
		};
		/** The browser's own view of the groups: title, color, tabs (not Tabkyra's records). */
		const groups = () =>
			fx.swEval(`(async () => {
				const tabs = await chrome.tabs.query({});
				return (await chrome.tabGroups.query({})).map((g) => ({
					id: g.id, title: g.title, color: g.color,
					tabs: tabs.filter((t) => t.groupId === g.id).map((t) => ({ id: t.id, title: t.title, url: t.url })),
				}));
			})()`);
		const tabInfo = (id) =>
			fx.swEval(
				`chrome.tabs.get(${id}).then((t) => ({ id: t.id, title: t.title, url: t.url, groupId: t.groupId }))`,
			);
		const tabIdOf = (entry) => Number(entry.text.match(/"tabId"\s*:\s*(\d+)/)?.[1]);

		// The side panel, as a page of the same browser, dark and at 2x, with a local model set
		// up the way the Custom providers tab saves one.
		const version = await (await fetch(`http://${fx.devtools}/json/version`)).json();
		cdp = await connectCdp(version.webSocketDebuggerUrl);
		const panel = await cdp.page(`chrome-extension://${EXTENSION_ID}/sidepanel.html`, { width: 440, height: 860 });
		await until(() => panel.eval(`!!document.querySelector("textarea")`), 20_000, "the side panel");
		await panel.eval(setUpModel(MODEL_URL, MODEL));
		await panel.reload();
		await until(() => panel.eval(`!!document.querySelector("textarea")`), 20_000, "the side panel after reload");
		await sleep(1000);
		if (await panel.eval(`document.body.innerText.includes("Welcome to Tabkyra")`)) await panel.key("Escape");
		await sleep(500);

		// ---- Beat 1: three agents at once -------------------------------------------------
		const [a1, a2, a3] = await Promise.all(["agent1", "agent2", "agent3"].map(connect));
		const agents = { agent1: a1, agent2: a2, agent3: a3 };
		const paths = { agent1: "/product/kettle", agent2: "/cart", agent3: "/checkout" };
		// All three are connected at once; their first calls go a moment apart, the way three
		// agents started in three terminals would, so agent 1 opens the first group.
		const navs = [];
		for (const [k, a] of Object.entries(agents)) {
			navs.push(await call(a, "navigate", { url: `${site}${paths[k]}` }));
			await sleep(300);
		}
		for (const [i, k] of ["agent1", "agent2", "agent3"].entries()) {
			const a = agents[k];
			const tabId = tabIdOf(navs[i]);
			const context = await call(a, "tabs_context");
			capture.agents[k] = { navigate: navs[i], tabId, context: context.text, shot: await shot(a, `${k}-page.jpg`) };
		}
		capture.groups = await groups();
		// Each agent's tab sits in its own group, and no tabs_context lists another agent's tab.
		for (const k of Object.keys(agents)) {
			const mine = capture.agents[k];
			const g = capture.groups.find((x) => x.tabs.some((t) => t.id === mine.tabId));
			if (!g) throw new Error(`${k}'s tab ${mine.tabId} isn't in a group`);
			mine.group = { title: g.title, color: g.color };
			for (const other of Object.keys(agents).filter((o) => o !== k))
				if (mine.context.includes(`tab ${capture.agents[other].tabId}`) || mine.context.includes(paths[other]))
					throw new Error(`${k}'s tabs_context lists ${other}'s tab:\n${mine.context}`);
		}
		const titles = Object.values(capture.agents).map((a) => a.group.title);
		if (new Set(titles).size !== 3 || new Set(Object.values(capture.agents).map((a) => a.group.color)).size !== 3)
			throw new Error(`expected three groups with distinct titles and colors: ${JSON.stringify(capture.groups)}`);

		// Agent 2 reaches for agent 1's tab and is refused.
		capture.crossTalk = await call(a2, "tabs_select", { tabId: capture.agents.agent1.tabId }, { allowError: true });
		if (!capture.crossTalk.isError) throw new Error(`agent2 selected agent1's tab: ${capture.crossTalk.text}`);
		const stillOne = await tabInfo(capture.agents.agent1.tabId);
		capture.crossTalk.agent1TabAfter = stillOne;

		// ---- Beat 2: resume ---------------------------------------------------------------
		// Agent 1 opens a second tab, then quits.
		const second = await call(a1, "tabs_create", { url: `${site}/product/teapot` });
		const teapotTab = tabIdOf(second);
		capture.resume = { tabsCreate: second, before: (await call(a1, "tabs_context")).text };
		await a1.client.close();
		await sleep(1500);
		capture.resume.groupsWhileClosed = await groups();
		const a1b = await connect("agent1");
		agents.agent1 = a1b;
		capture.resume.after = (await call(a1b, "tabs_context")).text;
		for (const id of [capture.agents.agent1.tabId, teapotTab])
			if (!capture.resume.after.includes(String(id)))
				throw new Error(`the restarted agent1 lost tab ${id}:\n${capture.resume.after}`);
		capture.resume.groupAfter = (await groups()).find((g) => g.tabs.some((t) => t.id === teapotTab));
		if (capture.resume.groupAfter?.title !== capture.agents.agent1.group.title)
			throw new Error("the resumed tabs changed group");

		// ---- Beat 3: hand-off --------------------------------------------------------------
		// The user drags the teapot tab out of agent 1's group (the API equivalent; see above).
		capture.handoff = { tabId: teapotTab, groupBefore: capture.resume.groupAfter };
		await fx.swEval(`chrome.tabs.ungroup(${teapotTab})`);
		await sleep(1200);
		capture.handoff.context = (await call(a1b, "tabs_context")).text;
		capture.handoff.tabAfter = await tabInfo(teapotTab);
		if (!/The user took .* out of your group; it's theirs now/.test(capture.handoff.context))
			throw new Error(`agent1 wasn't told about the hand-off:\n${capture.handoff.context}`);
		if (capture.handoff.tabAfter.groupId !== -1) throw new Error("the handed-off tab is still grouped");
		capture.handoff.userShot = await shotOfTab(fx, teapotTab, join(out, "teapot.jpg"));

		// The panel runs from a git checkout, so it may offer "Update available: N new commits on
		// main". Not part of this story: hide it with its own dismiss button, as a user would.
		const hideUpdateNotice = async () => {
			if (await panel.eval(`!!document.querySelector('[aria-label="Dismiss update notice"]')`)) {
				await panel.click(`document.querySelector('[aria-label="Dismiss update notice"]')`);
				await sleep(300);
			}
		};
		await hideUpdateNotice();

		// ---- Beat 4: ask_user ---------------------------------------------------------------
		const question = {
			questions: [
				{
					header: "Payment",
					question: "Which payment method should I test checkout with?",
					options: [
						{ label: "Test card (Recommended)", description: "The card form, with the 4242 test number" },
						{ label: "PayPal sandbox", description: "Redirects to the PayPal sandbox and back" },
					],
				},
			],
		};
		const asking = call(a3, "ask_user", question);
		asking.catch(() => {});
		await until(
			() => panel.eval(`!!document.querySelector('[data-testid="bridge-questions"] [data-state="asking"]')`),
			15_000,
			"the question in the side panel",
		);
		await sleep(600);
		await panel.shot(join(out, "panel-ask.png"));
		const cardBox = await panel.box(
			`document.querySelector('[data-testid="bridge-questions"] [data-testid="ask-card"]')`,
		);
		const chosen = question.questions[0].options[0].label;
		const optionBox = await panel.click(`document.querySelector('[data-option=${JSON.stringify(chosen)}]')`);
		await sleep(400);
		await panel.shot(join(out, "panel-ask-picked.png"));
		await panel.click(`document.querySelector('[data-testid="bridge-questions"] [data-action="submit"]')`);
		const answered = await asking;
		await sleep(400);
		capture.ask = {
			call: { args: question },
			chosen,
			result: answered.text,
			ms: answered.ms,
			boxes: { card: cardBox, option: optionBox },
			shots: { asking: "capture/agents/panel-ask.png", picked: "capture/agents/panel-ask-picked.png" },
		};
		if (!answered.text.includes("Test card")) throw new Error(`ask_user didn't return the answer: ${answered.text}`);
		// The agent carries on with that answer.
		const form = await call(a3, "read_page", { filter: "interactive" });
		const ref = (re) =>
			form.text
				.split("\n")
				.find((l) => re.test(l))
				?.match(/\[?(e\d+)/)?.[1];
		const fills = [
			await call(a3, "fill", { ref: ref(/Name on order|textbox/i), value: "Test Buyer" }),
			await call(a3, "fill", { ref: ref(/Payment|combobox/i), value: "Test card" }),
		];
		capture.ask.after = { readPage: form.text, fills, shot: await shot(a3, "agent3-filled.jpg") };

		// ---- Beat 5: the side panel's "/" and "@" menus ------------------------------------
		await until(
			() => panel.eval(`!document.body.innerText.includes("Answer sent to")`),
			15_000,
			"the answer toast to close",
		);
		await hideUpdateNotice();
		capture.composer = await composerBeat(fx, panel, out, teapotTab);

		// ---- Beat 6: the terminal ------------------------------------------------------------
		const run = async (args) => {
			const started = Date.now();
			try {
				const r = await promisify(execFile)(process.execPath, [cli, ...args], {
					env: { ...fx.env, NO_COLOR: "1" },
					encoding: "utf8",
					cwd: project,
				});
				return {
					args,
					shown: `tabkyra ${args.join(" ")}`,
					code: 0,
					ms: Date.now() - started,
					out: `${r.stdout}${r.stderr}`.trimEnd(),
				};
			} catch (err) {
				return {
					args,
					shown: `tabkyra ${args.join(" ")}`,
					code: err.code ?? 1,
					ms: Date.now() - started,
					out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trimEnd(),
				};
			}
		};
		// Mirrors are written a couple of seconds after a chat changes; the bridge reads the panel's
		// own storage, so this works either way.
		await sleep(3000);
		capture.cli.sessions = await run(["sessions"]);
		capture.cli.tabs = await run(["tabs"]);
		capture.cli.threads = await run(["threads", "search", "teapot"]);
		// The whole chat, for checking what the side panel's agent did (not shown in the video).
		const threadId = capture.cli.threads.out.split("\n")[1]?.split(" ")[0];
		if (threadId) capture.threadShown = (await run(["threads", "show", threadId])).out.slice(0, 8000);
		for (const [k, r] of Object.entries(capture.cli))
			if (r.code !== 0) throw new Error(`tabkyra ${k} failed (${r.code}): ${r.out}`);
		// Whole titles: "Tabkyra · claude · shop" must not match the "… shop 2" row.
		for (const t of titles)
			if (!new RegExp(`${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?! \\d)`).test(capture.cli.sessions.out))
				throw new Error(`tabkyra sessions doesn't show ${t}:\n${capture.cli.sessions.out}`);
		// The side panel run counts only if its record shows the page was read and the last reply
		// states facts from the page body (the @ chip only shows the tab title).
		const finalReply = capture.threadShown?.split(/^\[\d+\] assistant: (?!->)/m).at(-1) ?? "";
		if (
			!capture.threadShown?.includes("steel infuser") ||
			PAGE_FACTS.filter((f) => finalReply.includes(f)).length < 2
		)
			throw new ModelMissed(`the side panel's model ended without using the page: ${finalReply.slice(0, 300)}`);
		if (!/teapot/i.test(capture.cli.threads.out))
			throw new Error(`threads search found nothing:\n${capture.cli.threads.out}`);

		// ---- Beat 7: reload mid-click ---------------------------------------------------------
		const before = orders;
		const pending = call(
			a3,
			"actions",
			{ steps: [{ click: { selector: "#place" } }, { wait: 3000 }] },
			{ allowError: true },
		);
		await sleep(800);
		await fx.reloadExtension({ wait: false });
		const cut = await pending;
		await fx.waitConnected();
		await sleep(1500);
		const page3 = await call(a3, "get_page_text");
		capture.reload = {
			call: cut,
			ordersBefore: before,
			ordersAfter: orders,
			page: page3.text,
			shot: await shot(a3, "agent3-placed.jpg"),
		};
		if (orders - before !== 1) throw new Error(`the order ran ${orders - before} times`);
		if (!/check the page/i.test(cut.text))
			throw new Error(`the cut-off call didn't say to check the page: ${cut.text}`);

		capture.panelErrors = panel.errors();
		capture.calls = log;
		return capture;
	} finally {
		cdp?.close();
		for (const c of clients) await c.close().catch(() => {});
		await fx.close();
		server.close();
		rmSync(projectParent, { recursive: true, force: true });
	}
}

/**
 * Stores a custom provider for the local model, its placeholder key and the model as the last
 * one used, in the panel's IndexedDB, the same records CustomProviderEditDialog.save writes.
 */
function setUpModel(baseUrl, id) {
	const model = {
		id,
		name: id,
		api: "openai-completions",
		provider: "Local",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	};
	const provider = { id: "demo-local-model", name: "Local", type: "openai-completions", baseUrl, models: [model] };
	return `new Promise((resolve, reject) => {
		const open = indexedDB.open("tabkyra-storage");
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			const tx = db.transaction(["custom-providers", "provider-keys", "settings"], "readwrite");
			tx.objectStore("custom-providers").put(${JSON.stringify(provider)}, "demo-local-model");
			tx.objectStore("provider-keys").put("-", "Local");
			tx.objectStore("settings").put(${JSON.stringify(model)}, "lastUsedModel");
			tx.oncomplete = () => resolve(true);
			tx.onerror = () => reject(tx.error);
		};
	})`;
}

/** A raw CDP session on one page target, found by URL (never the browser-wide auto-attach). */
async function tabSession(fx, url) {
	const target = (await fx.targets()).find((t) => t.type === "page" && t.url === url);
	if (!target) throw new Error(`no DevTools target for ${url}`);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	let next = 0;
	const waiting = new Map();
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		const w = waiting.get(msg.id);
		if (!w) return;
		waiting.delete(msg.id);
		if (msg.error) w.reject(new Error(msg.error.message));
		else w.resolve(msg.result);
	};
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++next;
			waiting.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	return { send, close: () => ws.close() };
}

/** A screenshot of a tab no agent owns. */
async function shotOfTab(fx, tabId, path) {
	const tab = await fx.swEval(`chrome.tabs.get(${tabId}).then((t) => ({ url: t.url, title: t.title }))`);
	const t = await tabSession(fx, tab.url);
	try {
		const { data } = await t.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
		writeFileSync(path, Buffer.from(data, "base64"));
	} finally {
		t.close();
	}
	return `capture/agents/${path.split("/").pop()}`;
}

/** The user points at `selector` in a tab and clicks it: a real mouse move and click there. */
async function userClicks(fx, tabId, selector) {
	const tab = await fx.swEval(`chrome.tabs.get(${tabId}).then((t) => ({ url: t.url }))`);
	const t = await tabSession(fx, tab.url);
	try {
		const { result } = await t.send("Runtime.evaluate", {
			expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
			returnByValue: true,
		});
		const { x, y } = result.value;
		const mouse = (type) =>
			t.send("Input.dispatchMouseEvent", {
				type,
				x,
				y,
				button: type === "mouseMoved" ? "none" : "left",
				clickCount: 1,
			});
		await mouse("mouseMoved");
		await sleep(400);
		await mouse("mousePressed");
		await mouse("mouseReleased");
	} finally {
		t.close();
	}
}

/** "/" menu, "@" menu, and a message sent with both to the side panel's own agent. */
async function composerBeat(fx, panel, dir, teapotTab) {
	const shots = {};
	const boxes = {};
	const editorBox = () => panel.box(`document.querySelector("message-editor")`);
	// Each shot keeps where the menu and the composer were, so the video crops by recorded boxes.
	const snap = async (name) => {
		await sleep(350);
		await panel.shot(join(dir, `panel-${name}.png`));
		shots[name] = `capture/agents/panel-${name}.png`;
		const menu = await panel.eval(`!!document.querySelector("message-editor [role=listbox]")`);
		const editor = await editorBox();
		// Where the transcript's text ends above the composer, so a crop can stop there.
		const contentBottom = await panel.eval(
			`Math.max(0, ...[...document.querySelectorAll("body *")].filter((e) => e.childElementCount === 0 && e.textContent.trim() && e.offsetParent && !e.closest("message-editor")).map((e) => e.getBoundingClientRect()).filter((r) => r.bottom <= ${editor.y}).map((r) => r.bottom))`,
		);
		boxes[name] = {
			editor,
			contentBottom,
			...(menu ? { menu: await panel.box(`document.querySelector("message-editor [role=listbox]")`) } : {}),
		};
	};
	const menuItems = () =>
		panel.eval(
			`[...document.querySelectorAll("message-editor [role=listbox] [role=option]")].filter((e) => e.offsetParent).map((e) => e.innerText.trim().replace(/\\s+/g, " "))`,
		);
	await panel.click(`document.querySelector("textarea")`);
	await panel.type("/");
	await until(async () => (await menuItems()).length > 0, 5000, "the / menu");
	await snap("slash");
	const slashAll = await menuItems();
	await panel.type("writ");
	await until(
		async () => (await menuItems()).some((t) => t.startsWith("writing")),
		5000,
		"the writing skill in the / menu",
	);
	await snap("slash-filtered");
	const slashFiltered = await menuItems();
	await panel.key("Enter");
	await sleep(300);
	await panel.type("@");
	await until(async () => (await menuItems()).length > 0, 5000, "the @ menu");
	await snap("at");
	const atAll = await menuItems();
	await panel.type("Teapot");
	await until(async () => (await menuItems()).some((t) => /Teapot/.test(t)), 5000, "the teapot tab in the @ menu");
	await panel.key("Enter");
	await sleep(300);
	const task = "Read this teapot's page and write a two-sentence product blurb from what it says.";
	await panel.type(task);
	await snap("composed");
	const composed = await panel.eval(`document.querySelector("textarea").value`);
	await panel.key("Enter");
	const started = Date.now();
	// The run is done when the stop button is gone and an assistant message has text.
	await sleep(2000);
	// The agent may ask the user to point at the part of the page it should use (the element
	// picker). The user answers it: a mouse click on the product description in the teapot tab.
	let picked;
	try {
		await until(
			async () => {
				if (!picked && (await panel.eval(`document.body.innerText.includes("Ask you to pick an element")`))) {
					await sleep(1500);
					await userClicks(fx, teapotTab, ".product-description");
					picked = { selector: ".product-description", afterMs: Date.now() - started };
				}
				return panel.eval(`document.querySelector("message-editor")?.isStreaming === false`);
			},
			300_000,
			"the side panel's agent to finish",
		);
	} catch (err) {
		// What the panel showed when it gave up, kept with the partial capture.
		await panel.shot(join(dir, "panel-timeout.png")).catch(() => {});
		throw new ModelMissed(err.message);
	}
	await sleep(1500);
	await snap("reply");
	const transcript = await panel.eval(
		`document.querySelector("agent-interface, pi-chat-panel, main")?.innerText ?? document.body.innerText`,
	);
	// Whether the reply used the page is checked from the chat's record after the CLI beat.
	return {
		slashAll,
		slashFiltered,
		atAll,
		composed,
		task,
		teapotTab,
		picked,
		ms: Date.now() - started,
		transcript: transcript.slice(-4000),
		boxes,
		shots,
	};
}

await main();
