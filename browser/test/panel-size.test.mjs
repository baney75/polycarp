// What the side panel must load before it can show anything. Donovan called the panel slow on 2026-11-07, when this was
// 8.1 MB parsed on every open; code splitting and loading libraries on first use took it to 1.8 MB. This stops it creeping back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPEN_BYTES_LIMIT = 1_900_000;
// Each of these is large and needed only by some chats. None may load with the panel.
const ON_FIRST_USE = ["pdfjs-dist", "xlsx", "docx-preview", "jszip", "katex", "chart.js", "@lmstudio/sdk", "@mistralai", "@google/genai", "openai/", "@anthropic-ai/sdk", "library-skills", "highlight.js/lib/languages/1c", "ajv/"];

const siblings = existsSync(join(root, "../pi-mono/packages")) && existsSync(join(root, "node_modules"));

test("the panel opens with less than the budget, and without the libraries that load on first use", { skip: !siblings }, () => {
	const out = mkdtempSync(join(tmpdir(), "panel-size-"));
	try {
		execFileSync("node", ["scripts/build.mjs"], {
			cwd: root,
			env: { ...process.env, TABKYRA_META: "1", TABKYRA_NO_BUMP: "1", TABKYRA_OUT_DIR: out },
			stdio: "pipe",
		});
		const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
		const entry = Object.keys(meta.outputs).find((name) => name.endsWith("/sidepanel.js"));
		const seen = new Set();
		const walk = (name) => {
			if (seen.has(name)) return;
			seen.add(name);
			for (const i of meta.outputs[name].imports) if (i.kind === "import-statement") walk(i.path);
		};
		walk(entry);
		const outputs = [...seen].map((name) => meta.outputs[name]);
		const bytes = outputs.reduce((sum, o) => sum + o.bytes, 0);
		assert.ok(bytes <= OPEN_BYTES_LIMIT, `the panel loads ${bytes} bytes at open; the budget is ${OPEN_BYTES_LIMIT}`);
		const inputs = outputs.flatMap((o) => Object.entries(o.inputs).filter(([, i]) => i.bytesInOutput > 0).map(([path]) => path));
		for (const library of ON_FIRST_USE) {
			// src/lazy/ holds the small stand-ins that load the real thing.
			const found = inputs.filter((path) => path.includes(library) && !path.startsWith("src/lazy/"));
			assert.deepEqual(found.slice(0, 3), [], `${library} loads with the panel`);
		}
		// A service worker can't run import(), so its file must hold everything.
		assert.ok(!/\bimport\(/.test(readFileSync(join(out, "background.js"), "utf8")), "background.js has a dynamic import");
		// PDF.js finds its worker next to the file holding it, so chunks stay beside the pages.
		assert.ok(existsSync(join(out, "pdfjs-dist/build/pdf.worker.min.mjs")));
		assert.ok(readdirSync(out).some((f) => /^chunk-.*\.js$/.test(f)), "no chunks beside the pages");
		// The dev server's hot reload must never run in a real install.
		const open = outputs.map((_, i) => readFileSync(join(out, [...seen][i].split("/").pop()), "utf8")).join("\n");
		assert.ok(!open.includes("ws://localhost:8765"), "the hot reload loads with the panel");
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("the panel's outline paints before any script, in the saved colors", () => {
	const page = readFileSync(join(root, "static/sidepanel.html"), "utf8");
	assert.ok(page.indexOf('id="panel-shell"') > 0 && page.indexOf('id="panel-shell"') < page.indexOf("sidepanel.js"));
	assert.ok(readFileSync(join(root, "static/theme-loader.js"), "utf8").includes("tk-colors-dark"));
	assert.ok(readFileSync(join(root, "src/appearance/apply.ts"), "utf8").includes('"tk-colors-dark"'));
	assert.ok(readFileSync(join(root, "src/sidepanel.ts"), "utf8").includes('getElementById("panel-shell")?.remove()'));
});

test("text shown before a library arrives can't become markup", async () => {
	globalThis.document ??= { querySelectorAll: () => [] };
	const { escapeHtml } = await import("../src/lazy/refresh.ts");
	assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), "&#60;img src=x onerror=&#34;a(&#39;b&#39;)&#34;&#62;&#38;");
});

test("a library that failed to load can be tried again, since an update can replace files under an open panel", () => {
	for (const file of ["src/dialogs/chart-lib.ts", "src/lazy/highlight.ts", "src/lazy/katex.ts"]) {
		assert.match(readFileSync(join(root, file), "utf8"), /(lib|all|loading) = undefined;/, file);
	}
	assert.match(readFileSync(join(root, "../pi-mono/packages/web-ui/src/utils/lazy-documents.ts"), "utf8"), /pdfjs = undefined;/);
});

test("the model button opens the picker before anything that waits on the network or the helper", () => {
	const panel = readFileSync(join(root, "src/sidepanel.ts"), "utf8");
	const start = panel.indexOf("onModelSelect: async () => {");
	const open = panel.indexOf("ModelSelector.open(", start);
	assert.ok(start > 0 && open > start);
	const before = panel.slice(start, open);
	assert.doesNotMatch(before, /await refreshDiscoveredModels/, "a stale provider's list held the picker for up to 4 seconds");
	assert.doesNotMatch(before, /\.\.\.\(await refreshSubscriptionModels/, "the helper's answer held the picker");
	assert.match(panel.slice(open, open + 1400), /selector\.refreshed\(/, "fresh lists still reach the open picker");
});

test("the welcome dialog shows once, and its X opens nothing", () => {
	const panel = readFileSync(join(root, "src/sidepanel.ts"), "utf8");
	const seen = panel.indexOf("[WELCOME_SEEN_KEY]: true");
	const show = panel.indexOf("await WelcomeSetupDialog.show()");
	assert.ok(seen > 0 && seen < show, "remembered before it can be closed by the panel going away");
	assert.match(panel, /!\(await chrome\.storage\.local\.get\(WELCOME_SEEN_KEY\)\)\[WELCOME_SEEN_KEY\]/);
	assert.match(panel, /choice === "dismissed"\) return/);
	const dialog = readFileSync(join(root, "src/dialogs/WelcomeSetupDialog.ts"), "utf8");
	assert.match(dialog, /private choice: WelcomeChoice = "dismissed"/);
});

