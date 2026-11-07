#!/usr/bin/env node
// The libraries the panel loads on first use, used for real in a throwaway Chromium: a PDF, a spreadsheet, a Word file and
// a slide deck attached and read, then a saved chat with formulas and code in common and rare languages, then a long chat.
//   node scripts/panel-lazy-check.mjs [extension folder]
// Exits 1 if any of them fails or if the page reports an error.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.argv[2] ?? join(here, "../dist-chrome"));
const require = createRequire(join(here, "../package.json"));
const { chromium } = createRequire(join(here, "../cli/package.json"))("playwright-core");
const XLSX = require("xlsx");
const JSZip = require("jszip");

const work = mkdtempSync(join(tmpdir(), "panel-lazy-"));

/** The smallest PDF that holds a line of text. */
function pdf(text) {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		null,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
	objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	let out = "%PDF-1.4\n";
	const offsets = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

const docx = () => {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
	);
	zip.file(
		"_rels/.rels",
		'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
	);
	zip.file(
		"word/document.xml",
		'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>docx marker words</w:t></w:r></w:p></w:body></w:document>',
	);
	return zip.generateAsync({ type: "nodebuffer" });
};
const pptx = () => {
	const zip = new JSZip();
	zip.file(
		"ppt/slides/slide1.xml",
		'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>pptx marker words</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
	);
	zip.file(
		"[Content_Types].xml",
		'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
	);
	return zip.generateAsync({ type: "nodebuffer" });
};
const sheet = () => {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["xlsx marker words", 1]]), "Sheet1");
	return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
};

const files = {
	"a.pdf": pdf("pdf marker words"),
	"b.xlsx": sheet(),
	"c.docx": await docx(),
	"d.pptx": await pptx(),
};
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(work, name), bytes);

const ctx = await chromium.launchPersistentContext(join(work, "profile"), {
	headless: false,
	viewport: { width: 420, height: 800 },
	colorScheme: "dark",
	args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const failures = [];
const check = async (name, run) => {
	const started = Date.now();
	try {
		await run();
		console.log(`ok   ${name} (${Date.now() - started} ms)`);
	} catch (error) {
		failures.push(name);
		console.log(`FAIL ${name}: ${String(error.message).split("\n")[0]}`);
	}
};

try {
	const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
	const id = new URL(sw.url()).host;
	const panel = `chrome-extension://${id}/sidepanel.html`;
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(panel);
	await page.waitForSelector("textarea");
	await page.waitForTimeout(600);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	const close = page.getByRole("button", { name: /back|close/i }).first();
	if (await close.count()) await close.click().catch(() => {});

	await check("attachments read a PDF, a spreadsheet, a Word file and a deck", async () => {
		const input = page.locator('input[type="file"]').first();
		await input.setInputFiles(Object.keys(files).map((name) => join(work, name)));
		await page.waitForFunction(
			() => {
				const editor = document.querySelector("message-editor");
				return editor?.attachments?.length === 4;
			},
			null,
			{ timeout: 20000 },
		);
		const texts = await page.evaluate(() =>
			document.querySelector("message-editor").attachments.map((a) => `${a.fileName}: ${a.extractedText}`),
		);
		for (const kind of ["pdf", "xlsx", "docx", "pptx"]) {
			assert.ok(
				texts.some((t) => t.includes(`${kind} marker words`)),
				`no ${kind} text in: ${texts.join(" | ").slice(0, 300)}`,
			);
		}
	});

	await check("opening an attachment draws the PDF, the spreadsheet and the Word file", async () => {
		const tiles = page.locator("attachment-tile");
		for (const [index, drawn] of [
			[0, "canvas"],
			[1, "table"],
			[2, ".docx-wrapper-custom, .docx"],
		]) {
			await tiles.nth(index).locator("img, div").first().click({ timeout: 5000 });
			await page.waitForSelector(drawn, { state: "attached", timeout: 15000 });
			await page.keyboard.press("Escape");
			await page.waitForTimeout(150);
		}
	});

	await page.close();
	const seed = await ctx.newPage();
	await seed.goto(panel);
	await seed.waitForSelector("textarea");
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const model = {
		id: "claude-sonnet-4-6",
		name: "Sonnet",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8000,
	};
	const reply = (text) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: 1,
	});
	const question = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
	const save = (sessionId, messages) =>
		seed.evaluate(
			({ sessionId, messages, model }) =>
				new Promise((done, fail) => {
					const open = indexedDB.open("tabkyra-storage");
					open.onerror = () => fail(open.error);
					open.onsuccess = () => {
						try {
							const db = open.result;
							const now = new Date().toISOString();
							const tx = db.transaction(["sessions", "sessions-metadata"], "readwrite");
							tx.objectStore("sessions").put({
								id: sessionId,
								title: "Check",
								model,
								thinkingLevel: "off",
								messages,
								createdAt: now,
								lastModified: now,
							});
							tx.objectStore("sessions-metadata").put({
								id: sessionId,
								title: "Check",
								createdAt: now,
								lastModified: now,
								messageCount: messages.length,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								thinkingLevel: "off",
								preview: "x",
							});
							tx.oncomplete = () => done();
							tx.onerror = () => fail(tx.error);
						} catch (error) {
							fail(error);
						}
					};
				}),
			{ sessionId, messages, model },
		);
	await save("saved-rich", [
		question("Show me"),
		reply(
			"Formula: $$E = mc^2$$\n\n```python\nprint('hello')\n```\n\n```haskell\nmain :: IO ()\nmain = putStrLn \"hi\"\n```\n\n```\nplain block with no language\n```\n",
		),
	]);
	const code = "```python\nfor i in range(10):\n    print(i)\n```\n\n";
	const long = [];
	for (let i = 0; i < 200; i++)
		long.push(
			question(`Question ${i}`),
			reply(`Answer ${i} with **bold**, a [link](https://example.com), and a list:\n\n- one\n- two\n\n${code}`),
		);
	await save("saved-long", long);
	await seed.close();

	const rich = await ctx.newPage();
	rich.on("pageerror", (e) => errors.push(e.message));
	await check(
		"a saved chat draws its formula with KaTeX, highlights Python and Haskell, and shows a plain block",
		async () => {
			await rich.goto(`${panel}?session=saved-rich`);
			await rich.waitForSelector(".katex", { timeout: 10000 });
			await rich.waitForSelector("code.language-python .hljs-keyword, code.language-python .hljs-built_in", {
				timeout: 10000,
			});
			// Outside the code block's own set: it arrives with the rest of the languages and the block is drawn again.
			await rich.waitForSelector("code.language-haskell [class*='hljs-']", { timeout: 10000 });
			const plain = await rich.locator("code.language-text").innerText({ timeout: 10000 });
			assert.ok(plain.includes("plain block with no language"));
		},
	);
	await check("a chat's cost view draws its chart with Chart.js", async () => {
		await rich.keyboard.press("Meta+Shift+K");
		await rich.waitForSelector("canvas#cost-chart", { state: "attached", timeout: 10000 });
		await rich.waitForFunction(
			() => {
				const canvas = document.querySelector("canvas#cost-chart");
				return canvas
					?.getContext("2d")
					.getImageData(0, 0, canvas.width, canvas.height)
					.data.some((v) => v !== 0);
			},
			null,
			{ timeout: 10000 },
		);
	});
	await rich.close();

	await check("a chat of 400 messages opens", async () => {
		const longPage = await ctx.newPage();
		longPage.on("pageerror", (e) => errors.push(e.message));
		await longPage.goto(`${panel}?session=saved-long`, { waitUntil: "commit" });
		const ready = await longPage.evaluate(
			() =>
				new Promise((done) => {
					const check = () => {
						if (!document.querySelector("textarea") || !document.querySelector("markdown-block"))
							return requestAnimationFrame(check);
						requestAnimationFrame(() => done(performance.now()));
					};
					check();
				}),
		);
		console.log(
			`     long chat ready at ${Math.round(ready)} ms, ${await longPage.locator("markdown-block").count()} blocks drawn`,
		);
		await longPage.close();
	});

	await check("Settings opens Skills with the library, and the panel reports no errors", async () => {
		const page2 = await ctx.newPage();
		page2.on("pageerror", (e) => errors.push(e.message));
		await page2.goto(panel);
		await page2.waitForSelector("textarea");
		await page2.waitForTimeout(600);
		await page2.keyboard.press("Escape");
		await page2.waitForTimeout(400);
		await page2.getByText("Skills", { exact: true }).first().click({ timeout: 5000 });
		await page2.waitForFunction(() => /Library\s*·\s*\d+/.test(document.body.innerText), null, { timeout: 5000 });
		await page2.close();
		assert.deepEqual(errors, []);
	});
} finally {
	await ctx.close();
	rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
	console.log(`${failures.length} failed`);
	process.exit(1);
}
console.log("all passed");
