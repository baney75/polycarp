// How big a first look is: read_page {"filter":"interactive"} and {} on 8 public pages, and the size of tools/list,
// in tokens counted as chars / 4. Runs the throwaway headless browser from the e2e harness, never the user's own.
// Public pages change, so this is a measurement, not a CI test: test/read-budget.test.mjs holds the ratchet on fixtures.
//   node evals/weak-model/measure-read.mjs <label>   (writes results/read-size-<label>.json)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, startHarness } from "../../cli/test/e2e-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] ?? "now";
const PAGES = [
	["example", "https://example.com/"],
	["hn", "https://news.ycombinator.com/"],
	["wikipedia", "https://en.wikipedia.org/wiki/Computer_accessibility"],
	["github_repo", "https://github.com/trycua/cua"],
	["mdn_shadow", "https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM"],
	["form", "https://httpbin.org/forms/post"],
	["react_spa", "https://react.dev/learn"],
	["iframe_demo", "https://www.w3schools.com/html/tryit.asp?filename=tryhtml_iframe"],
];
const tok = (s) => Math.round(s.length / 4);
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const h = await startHarness();
const out = { label, pages: [], tools: {} };
try {
	await h.connected();
	const list = await h.mcp.listTools();
	out.tools = { count: list.tools.length, tokens: tok(JSON.stringify(list.tools)) };
	const dir = join(here, "results", `read-size-${label}`);
	mkdirSync(dir, { recursive: true });
	for (const [key, url] of PAGES) {
		const nav = await h.call("navigate", { url });
		if (!nav.ok) {
			out.pages.push({ page: key, error: nav.text.slice(0, 200) });
			continue;
		}
		await sleep(2000);
		const interactive = await h.call("read_page", { filter: "interactive" });
		const all = await h.call("read_page", {});
		writeFileSync(join(dir, `${key}.interactive.txt`), interactive.text);
		writeFileSync(join(dir, `${key}.all.txt`), all.text);
		const row = { page: key, interactive: tok(interactive.text), all: tok(all.text) };
		out.pages.push(row);
		console.log(JSON.stringify(row));
	}
	const sizes = out.pages.filter((p) => p.interactive !== undefined).map((p) => p.interactive);
	out.interactive = { median: median(sizes), max: Math.max(...sizes) };
	console.log(JSON.stringify({ tools: out.tools, interactive: out.interactive }));
	writeFileSync(join(here, "results", `read-size-${label}.json`), `${JSON.stringify(out, null, "\t")}\n`);
} finally {
	await h.stop();
}
