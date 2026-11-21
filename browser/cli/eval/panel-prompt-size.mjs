#!/usr/bin/env node
// What the side panel sends its model on every turn: the system prompt and the tool list, measured from a real request.
// The built extension runs in a throwaway Chromium with the network blocked, a stand-in model (cli/test/helpers/
// stub-model.mjs) answers, and the first request it gets is written out. No model, no key, no cost.
//
//   node cli/eval/panel-prompt-size.mjs --extension <built extension dir> --out <file.json>
//
// The output holds characters per part and per tool, plus the request itself. Count tokens from it with any offline
// tokenizer; docs/benchmarks.md uses tiktoken's o200k_base:
//   python3 -c "import json,sys,tiktoken; e=tiktoken.get_encoding('o200k_base'); r=json.load(open(sys.argv[1]))['request']; \
//     print(len(e.encode(r['messages'][0]['content'])), len(e.encode(json.dumps(r['tools']))))" <file.json>
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { seedStubModel, stubModel } from "../test/helpers/stub-model.mjs";

const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const extension = arg("--extension");
const out = arg("--out");
if (!extension || !out) {
	console.error("usage: node cli/eval/panel-prompt-size.mjs --extension <built extension dir> --out <file.json>");
	process.exit(1);
}
const PANEL = "chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/sidepanel.html";

const profile = mkdtempSync(join(tmpdir(), "polycarp-prompt-size-"));
const context = await chromium.launchPersistentContext(profile, {
	channel: "chromium",
	headless: true,
	viewport: { width: 400, height: 860 },
	args: [`--disable-extensions-except=${resolve(extension)}`, `--load-extension=${resolve(extension)}`, "--use-mock-keychain", "--password-store=basic"],
});
try {
	await context.route(/^https?:\/\//, (r) => r.abort());
	const stub = await stubModel(context, () => ({ text: "Hello." }));
	const page = await context.newPage();
	await page.goto(PANEL);
	await page.getByPlaceholder(/Ask about this page/).waitFor({ timeout: 20_000 });
	await seedStubModel(page);
	await page.goto(`${PANEL}?teststeps=${encodeURIComponent(JSON.stringify(["hi"]))}`);
	const deadline = Date.now() + 30_000;
	while (stub.requests.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
	const request = stub.requests[0];
	if (!request) throw new Error("the panel sent no model request");
	const system = request.messages.find((m) => m.role === "system" || m.role === "developer");
	const systemText = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
	const tools = (request.tools ?? []).map((t) => ({ name: t.function.name, chars: JSON.stringify(t).length }));
	const report = {
		systemChars: systemText.length,
		toolsChars: JSON.stringify(request.tools ?? []).length,
		toolCount: tools.length,
		tools,
		request,
	};
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`system prompt ${report.systemChars} chars, ${report.toolCount} tools ${report.toolsChars} chars`);
	for (const t of tools) console.log(`  ${t.name.padEnd(24)} ${t.chars}`);
} finally {
	await context.close();
	rmSync(profile, { recursive: true, force: true });
}
