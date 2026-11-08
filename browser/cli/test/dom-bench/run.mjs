// The DOM benchmark: every case in pages/ driven through the MCP tools in a throwaway Chromium.
// `node test/dom-bench/run.mjs [ids...] [--update] [--time]`. See browser/AGENTS.md for the ratchet.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness } from "../e2e-harness.mjs";
import { makeT } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const floorPath = join(here, "floor.json");
const args = process.argv.slice(2);
const update = args.includes("--update");
const timed = args.includes("--time");
const wanted = args.filter((a) => !a.startsWith("--"));

const files = readdirSync(join(here, "pages")).filter((f) => f.endsWith(".mjs")).sort();
const cases = [];
for (const f of files) cases.push((await import(`./pages/${f}`)).default);
const chosen = wanted.length ? cases.filter((c) => wanted.includes(c.id)) : cases;
const unknown = wanted.filter((id) => !cases.some((c) => c.id === id));
if (unknown.length) {
	console.error(`unknown case id: ${unknown.join(", ")}`);
	process.exit(2);
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

const h = await startHarness();
const results = [];
try {
	await h.connected();
	for (const c of chosen) {
		const start = Date.now();
		const t = makeT(h);
		let pass = false;
		let error;
		try {
			h.misses.length = 0;
			const url = h.mount(c.id, c.html);
			await t.tool("navigate", { url });
			await withTimeout(c.solve(t), 60_000, "solve").catch((err) => {
				t.cancel();
				throw err;
			});
			const page = { eval: (expr) => h.evaluate(expr, `${h.origin}/${c.id}/`) };
			const end = Date.now() + 2500;
			let why = "check returned false";
			for (;;) {
				try {
					if ((await c.check(page)) === true) {
						pass = true;
						break;
					}
					why = "check returned false";
				} catch (err) {
					why = `check threw: ${err.message}`;
				}
				if (Date.now() > end) break;
				await new Promise((r) => setTimeout(r, 250));
			}
			if (!pass) error = why;
		} catch (err) {
			error = String(err.message ?? err).split("\n")[0].slice(0, 300);
		}
		// Checked after a throw too: a case whose page 404s measured nothing, pass or fail.
		if (h.misses.length) {
			pass = false;
			error = `the page asked for files the case does not serve: ${[...new Set(h.misses)].join(", ")}`;
		}
		// A dialog left open would freeze the next navigation.
		await h.call("handle_dialog", { accept: false }).catch(() => {});
		results.push({ id: c.id, pass, ms: Date.now() - start, calls: t.calls, error });
		process.stderr.write(`${pass ? "ok  " : "FAIL"} ${c.id} ${Date.now() - start} ms\n`);
	}
} finally {
	await h.stop();
}

const idw = Math.max(4, ...results.map((r) => r.id.length));
console.log(`\n${"id".padEnd(idw)}  result  ${"ms".padStart(6)}  calls  error`);
for (const r of results) console.log(`${r.id.padEnd(idw)}  ${r.pass ? "pass  " : "FAIL  "}  ${String(r.ms).padStart(6)}  ${String(r.calls).padStart(5)}  ${r.error ?? ""}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed, ${results.length - passed} failed, ${results.reduce((a, r) => a + r.calls, 0)} tool calls, ${results.reduce((a, r) => a + r.ms, 0)} ms`);
writeFileSync(join(here, "last-run.json"), `${JSON.stringify({ at: new Date().toISOString(), results }, null, "\t")}\n`);

let floor = { passing: [], failing: {}, calls: {}, ms: {} };
try {
	floor = JSON.parse(readFileSync(floorPath, "utf8"));
} catch (err) {
	// Only a missing file starts empty; a broken one (a merge conflict) must not pass as "no floor".
	if (err.code !== "ENOENT") {
		console.error(`floor.json is unreadable: ${err.message}`);
		process.exit(1);
	}
	if (!update) console.log("no floor.json yet: run with --update to write one");
}
const byId = new Map(results.map((r) => [r.id, r]));
const problems = [];
for (const id of floor.passing) {
	const r = byId.get(id);
	if (!r) {
		// A passing case that vanished (file deleted, id renamed) is a drop, unless this run picked ids.
		if (!wanted.length) problems.push(`${id} is in passing but no case has that id`);
		continue;
	}
	if (!r.pass) problems.push(`${id} is in passing but failed: ${r.error}`);
	else if (floor.calls?.[id] && r.calls > floor.calls[id]) problems.push(`${id} took ${r.calls} tool calls, over its ceiling of ${floor.calls[id]}`);
	// Wall time swings several fold when the machine is busy, so it gates only on request (--time, on a quiet machine).
	else if (timed && floor.ms?.[id] && r.ms > floor.ms[id]) problems.push(`${id} took ${r.ms} ms, over its ceiling of ${floor.ms[id]} ms`);
}
const newly = Object.keys(floor.failing).filter((id) => byId.get(id)?.pass);
if (newly.length) console.log(`newly passing: ${newly.join(", ")} (move to passing with --update)`);

if (update) {
	if (problems.length) {
		console.error(`refusing to update: ${problems.join("; ")}`);
		process.exit(1);
	}
	const passing = new Set(floor.passing);
	const failing = { ...floor.failing };
	const ms = { ...(floor.ms ?? {}) };
	const calls = { ...(floor.calls ?? {}) };
	for (const r of results) {
		if (r.pass) {
			passing.add(r.id);
			delete failing[r.id];
			// A ceiling that exists stays: updating never loosens it.
			ms[r.id] ??= Math.max(2000, 3 * r.ms);
			// Fewer calls tightens the ceiling; more never loosens it.
			calls[r.id] = Math.min(calls[r.id] ?? r.calls, r.calls);
		} else if (!passing.has(r.id)) {
			// A reason someone wrote stays: the run's own error is only for a case newly failing.
			failing[r.id] ??= r.error ?? "failed";
		}
	}
	const order = cases.map((c) => c.id);
	const sort = (a) => [...a].sort((x, y) => order.indexOf(x) - order.indexOf(y));
	const out = {
		passing: sort(passing),
		failing: Object.fromEntries(sort(Object.keys(failing)).map((k) => [k, failing[k]])),
		calls: Object.fromEntries(sort(Object.keys(calls).filter((k) => passing.has(k))).map((k) => [k, calls[k]])),
		ms: Object.fromEntries(sort(Object.keys(ms).filter((k) => passing.has(k))).map((k) => [k, ms[k]])),
	};
	writeFileSync(floorPath, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`floor.json updated: ${out.passing.length} passing, ${Object.keys(out.failing).length} failing`);
	process.exit(0);
}
if (problems.length) {
	console.error(`\nratchet broken:\n  ${problems.join("\n  ")}`);
	process.exit(1);
}
console.log("ratchet holds");
