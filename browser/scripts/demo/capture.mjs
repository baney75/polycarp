// Records the README demo from a real run: the built extension in a throwaway headless
// Chromium, the native host it spawns, and `tabkyra mcp` driven by an MCP client, the
// same stack as cli/test/e2e-bridge.test.mjs. Each step's screenshot comes from the
// `screenshot` tool, so the frames are exactly what an agent sees.
//
//   npm run build && node scripts/demo/capture.mjs
//
// Writes media/demo.gif (README), its copy in site/src/frontend/public/img/, and
// media/demo-steps.png (a still sequence). Needs: `cd cli && npm install && npx
// playwright-core install chromium`, `cd site && npm install` (fonts), and ffmpeg.
//
// The agent is a scripted MCP client. Site permissions stay on: the demo allows the
// local page with `tabkyra allow 127.0.0.1` first, the way a user would.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { chromium } from "../../cli/node_modules/playwright-core/index.mjs";
import { SVG } from "../../media/brand/build.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repo, "cli", "dist", "index.js");
const extensionDir = join(repo, "dist-chrome");
const fonts = join(repo, "site", "node_modules", "@fontsource");
for (const [path, fix] of [
	[join(cli), "cd cli && npm install && npm run build"],
	[join(extensionDir, "manifest.json"), "npm run build"],
	[fonts, "cd site && npm install"],
	[chromium.executablePath(), "cd cli && npx playwright-core install chromium"],
]) {
	if (!existsSync(path)) throw new Error(`${path} is missing. Run: ${fix}`);
}
try {
	execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
	throw new Error("ffmpeg is missing. Install it (macOS: brew install ffmpeg).");
}

// A small library catalog: search, place a hold, confirm. Plain HTML, served locally.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pinecrest Library</title><style>
body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#f7f5f0;color:#1d2a33;zoom:1.55}
header{background:#24433b;color:#fff;padding:18px 40px;font-size:22px;font-weight:600}
header small{display:block;font-size:13px;font-weight:400;opacity:.75}
main{max-width:720px;margin:28px auto;padding:0 24px}
form.search{display:flex;gap:10px}input,select{font:inherit;padding:10px 12px;border:1px solid #c9c4b8;border-radius:8px;background:#fff}
input[type=search]{flex:1}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#24433b;color:#fff;cursor:pointer}
.book{display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid #e3dfd5;border-radius:10px;padding:16px 20px;margin-top:14px}
.book b{display:block}.muted{color:#6b7480;font-size:14px}label{display:block;margin:14px 0 6px;font-weight:600}
.ok{background:#e4f3ec;border:1px solid #9fd2b8;border-radius:10px;padding:20px 24px;font-size:18px}
</style></head><body><header>Pinecrest Library<small>Catalog and holds</small></header><main id="app"></main><script>
const books=[["Moby-Dick","Herman Melville, 1851","2 copies on the shelf"],["Moby-Dick: A Graphic Novel","Will Eisner, 1998","1 copy"]];
const app=document.getElementById("app");
function home(){app.innerHTML='<h2>Find a book</h2><form class="search"><input type="search" name="q" placeholder="Title or author" aria-label="Search the catalog"><button>Search</button></form><p class="muted">Holds are ready at your branch in two days.</p>';
app.querySelector("form").onsubmit=e=>{e.preventDefault();results(e.target.q.value)}}
function results(q){app.innerHTML='<h2>Results for "'+q+'"</h2>'+books.map((b,i)=>'<div class="book"><span><b>'+b[0]+'</b><span class="muted">'+b[1]+' · '+b[2]+'</span></span><button data-i="'+i+'">Place hold</button></div>').join("");
app.querySelectorAll("button").forEach(btn=>btn.onclick=()=>hold(books[btn.dataset.i]))}
function hold(b){app.innerHTML='<h2>Place a hold</h2><p><b>'+b[0]+'</b><br><span class="muted">'+b[1]+'</span></p><form><label for="card">Library card name</label><input id="card" style="width:320px"><label for="branch">Pickup branch</label><select id="branch"><option>Choose a branch</option><option>Main Street</option><option>Riverside</option></select><p><button>Confirm hold</button></p></form>';
app.querySelector("form").onsubmit=e=>{e.preventDefault();app.innerHTML='<div class="ok">Hold placed for <b>'+card.value+'</b>: '+b[0]+'. Pick it up at <b>'+branch.value+'</b> after Thursday.</div>'}}
home();
</script></body></html>`;

const font = (pkg, file) =>
	`url(data:font/woff2;base64,${readFileSync(join(fonts, pkg, "files", file)).toString("base64")})`;
const svgUrl = (body) => `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`;

async function until(fn, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await fn().catch(() => undefined);
		if (value) return value;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function main() {
	const work = mkdtempSync(join(tmpdir(), "tabkyra-demo-"));
	try {
		await record(work);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function record(work) {
	const home = join(work, "home");
	const socketDir = mkdtempSync("/tmp/tkdemo-");
	const profile =
		process.platform === "darwin"
			? join(home, "Library", "Application Support", "Chromium")
			: join(home, ".config", "chromium");
	mkdirSync(profile, { recursive: true });
	const env = {
		...process.env,
		HOME: home,
		TABKYRA_SOCKET_DIR: socketDir,
		TABKYRA_CLIENT_NAME: "claude",
		TABKYRA_SESSION: "demo",
		// Keep every config lookup inside the throwaway HOME.
		XDG_CONFIG_HOME: join(home, ".config"),
	};
	delete env.TABKYRA_AUTO_ALLOW;

	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(PAGE);
	});
	const mcp = new Client({ name: "tabkyra-demo", version: "0.0.0" });
	const frames = [];
	let group = "Tabkyra";
	let browser;
	// Everything that can fail sits inside the try, so the socket dir, server and browser
	// are always cleaned up.
	try {
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${server.address().port}/`;
		execFileSync(process.execPath, [cli, "install"], { env, stdio: "ignore" });
		// Headless, with a mock keychain: no window and no macOS keychain prompt on screen.
		browser = spawn(
			chromium.executablePath(),
			[
				`--user-data-dir=${profile}`,
				"--headless=new",
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				"--password-store=basic",
				`--disable-extensions-except=${extensionDir}`,
				`--load-extension=${extensionDir}`,
				"about:blank",
			],
			{ env, stdio: "ignore" },
		);
		await mcp.connect(
			new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "ignore" }),
		);
		const call = async (name, args = {}) => {
			const result = await mcp.callTool({ name, arguments: args });
			const text = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (result.isError) throw new Error(`${name}: ${text}`);
			return text;
		};
		const shot = async (calls, note) => {
			const result = await mcp.callTool({ name: "screenshot", arguments: { maxWidth: 1024 } });
			const image = result.content.find((c) => c.type === "image");
			if (result.isError || !image) {
				throw new Error(`screenshot: ${result.content.map((c) => c.text ?? "").join(" ")}`);
			}
			frames.push({ calls, note, image: `data:${image.mimeType};base64,${image.data}` });
		};
		const ref = (snapshot, pattern) =>
			snapshot
				.split("\n")
				.find((l) => pattern.test(l))
				?.match(/^\[?(e\d+)/)?.[1];

		// Wait for the extension, then allow the demo site the way a user would.
		await until(async () => JSON.parse(await call("status")).connected, 45_000, "the extension to connect");
		execFileSync(process.execPath, [cli, "allow", "127.0.0.1"], { env, stdio: "ignore" });
		await call("navigate", { url });
		await shot(
			["# you, beforehand: tabkyra allow 127.0.0.1", `navigate { url: "${url}" }`],
			"Opens the allowed catalog in its own background tab",
		);

		// Captions show the refs this run actually used.
		let page = await call("read_page", { filter: "interactive" });
		const search = ref(page, /search|textbox/i);
		await call("type", { ref: search, text: "Moby-Dick", submit: true });
		await shot(
			['read_page { filter: "interactive" }', `type { ref: "${search}", text: "Moby-Dick", submit: true }`],
			"Reads the page, then searches by ref",
		);

		page = await call("read_page", { filter: "interactive" });
		const holdButton = ref(page, /Place hold/);
		await call("click", { ref: holdButton });
		page = await call("read_page", { filter: "interactive" });
		const card = ref(page, /card/i);
		const branch = ref(page, /branch|combobox/i);
		await call("fill", { ref: card, value: "Ada Lovelace" });
		await call("fill", { ref: branch, value: "Main Street" });
		await shot(
			[
				`click { ref: "${holdButton}" }  // Place hold`,
				'read_page { filter: "interactive" }',
				`fill { ref: "${card}", value: "Ada Lovelace" }`,
				`fill { ref: "${branch}", value: "Main Street" }`,
			],
			"Fills the form like a person would",
		);

		const confirm = ref(page, /Confirm hold/);
		await call("click", { ref: confirm });
		const text = await until(
			async () => {
				const t = await call("get_page_text");
				return t.includes("Hold placed") ? t : undefined;
			},
			10_000,
			"the confirmation",
		);
		if (!text.includes("Ada Lovelace")) throw new Error(`unexpected confirmation: ${text}`);
		await shot(
			[`click { ref: "${confirm}" }  // Confirm hold`, 'get_page_text → "Hold placed for Ada Lovelace…"'],
			"Confirms, then reads the result back",
		);
		group = JSON.parse(await call("status")).tabGroup;
	} finally {
		await mcp.close().catch(() => {});
		browser?.kill();
		server.close();
		rmSync(socketDir, { recursive: true, force: true });
	}

	// Compose each frame: a quiet browser frame with the agent's tab group, the page, and
	// the tool calls that produced it.
	const render = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
	const framePngs = [];
	try {
		const page = await render.newPage({ viewport: { width: 1200, height: 580 }, deviceScaleFactor: 1 });
		for (const [i, f] of frames.entries()) {
			await page.setContent(`<!doctype html><html><head><style>
@font-face{font-family:"Instrument Sans";font-weight:600;src:${font("instrument-sans", "instrument-sans-latin-600-normal.woff2")}}
@font-face{font-family:"Instrument Sans";font-weight:400;src:${font("instrument-sans", "instrument-sans-latin-400-normal.woff2")}}
@font-face{font-family:"JetBrains Mono";src:${font("jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2")}}
body{margin:0;width:1200px;height:580px;background:#0F1B24;font-family:"Instrument Sans";color:#F6F2EA;display:flex;gap:28px;padding:32px;box-sizing:border-box}
.win{flex:none;align-self:flex-start;width:760px;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 30px 60px -20px #000a}
.bar{height:38px;background:#e9ecef;display:flex;align-items:center;gap:8px;padding:0 12px}
.dot{width:11px;height:11px;border-radius:50%;background:#cfd3d8}
.group{margin-left:10px;display:flex;align-items:center;gap:6px;font:600 12px "Instrument Sans";color:#5a4310;background:#f4dfae;border-radius:6px;padding:3px 9px}
.group img{width:13px;height:13px}
.shot{display:block;width:760px}
.side{display:flex;flex-direction:column;min-width:0;flex:1}
.step{font:600 13px "Instrument Sans";letter-spacing:.08em;text-transform:uppercase;color:#E3A93B}
.note{font-size:26px;line-height:1.2;font-weight:600;margin:8px 0 22px}
.calls{font:14px/1.7 "JetBrains Mono";color:#cfd8de;background:#0a141b;border:1px solid #1f3140;border-radius:10px;padding:14px 16px;white-space:pre-wrap;word-break:break-word}
.calls span{color:#E3A93B}.calls i{color:#6f8796;font-style:normal}
.foot{margin-top:auto;display:flex;align-items:center;gap:10px;color:#9FB0BC;font-size:14px}
.foot img{width:22px;height:22px}
</style></head><body>
<div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="group"><img src="${svgUrl(SVG["icon-16"])}">${group}</span></div><img class="shot" src="${f.image}"></div>
<div class="side"><div class="step">Step ${i + 1} of ${frames.length}</div><div class="note">${f.note}</div>
<div class="calls">${f.calls.map((c) => (c.startsWith("#") ? `<i>${c.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</i>` : `<span>›</span> ${c.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}`)).join("\n")}</div>
<div class="foot"><img src="${svgUrl(SVG.icon)}">A scripted MCP client driving the real stack: MCP server, native host and extension, headless.</div></div>
</body></html>`);
			await page.evaluate(() => document.fonts.ready);
			const out = join(work, `frame-${i}.png`);
			await page.screenshot({ path: out });
			framePngs.push(out);
		}
		// A still sequence for places that don't play GIFs.
		const strip = await render.newPage({
			viewport: { width: 1200, height: 580 * frames.length },
			deviceScaleFactor: 0.5,
		});
		await strip.setContent(
			`<body style="margin:0">${framePngs.map((p) => `<img style="display:block" src="data:image/png;base64,${readFileSync(p).toString("base64")}">`).join("")}</body>`,
		);
		await strip.screenshot({ path: join(repo, "media", "demo-steps.png") });
	} finally {
		await render.close();
	}

	// GIF: 2.6 s per frame, palette generated from the frames themselves.
	const list = join(work, "frames.txt");
	writeFileSync(list, `${framePngs.map((p) => `file '${p}'\nduration 2.6`).join("\n")}\nfile '${framePngs.at(-1)}'\n`);
	execFileSync("ffmpeg", [
		"-y",
		"-loglevel",
		"error",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		list,
		"-vf",
		"scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=sierra2_4a",
		join(repo, "media", "demo.gif"),
	]);
	copyFileSync(join(repo, "media", "demo.gif"), join(repo, "site", "src", "frontend", "public", "img", "demo.gif"));
	console.log(`wrote media/demo.gif (and the site copy) and media/demo-steps.png (${frames.length} steps)`);
}

await main();
