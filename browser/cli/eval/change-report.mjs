// Tool calls and tokens per task with and without the change report (decision D42). A measurement,
// not a gate: eight multi-step tasks from the DOM benchmark's fixture pages, each solved twice by
// the same scripted agent in a throwaway headless Chromium (no model).
//
//   before: the loop the server instructions taught: read_page, act, read_page again to confirm
//           and to get the refs for the next step. The `changes` field is left out of what it is
//           charged, since the tools did not return one before.
//   after:  read_page once, then act on what each result's `changes` lists (new refs, what
//           changed); read_page again only when the next target is not known or the report says
//           nothing changed.
//
// Tokens are estimated as response bytes / 4. Both modes must pass the case's own check. Times are
// wall clock; for the cost of the report itself, run the before mode on a build without it.
//   cd browser/cli && npm run build && node eval/change-report.mjs [--out file.json]
import { writeFileSync } from "node:fs";
import { startHarness } from "../test/e2e-harness.mjs";
import { parseNodes } from "../test/dom-bench/lib.mjs";

const ids = [
	"08-combobox",
	"10-select-custom",
	"11-multi-chips",
	"17-validation-error",
	"23-tabs",
	"24-accordion",
	"27-modal-focus-trap",
	"41-pagination",
];
// What each task does, as a person would say it: act on the control with this role and name.
const plans = {
	"08-combobox": [
		{ act: "type", role: /combobox/, name: /country/i, text: "Por" },
		{ act: "click", role: /option/, name: /^portugal$/i },
	],
	"10-select-custom": [
		{ act: "click", role: /button|combobox|listbox/, name: /priority|normal/i },
		{ act: "click", role: /option/, name: /^high$/i },
	],
	"11-multi-chips": [
		{ act: "click", role: /button/, name: /^python$/i },
		{ act: "click", role: /button/, name: /^rust$/i },
		{ act: "click", role: /button/, name: /save skills/i },
	],
	"17-validation-error": [
		{ act: "fill", role: /textbox/, name: /zip/i, text: "63101" },
		{ act: "click", role: /button/, name: /place order/i },
	],
	"23-tabs": [
		{ act: "click", role: /tab/, name: /billing/i },
		{ act: "type", role: /textbox/, name: /company name/i, text: "Acme" },
		{ act: "click", role: /button/, name: /save billing/i },
	],
	"24-accordion": [
		{ act: "click", role: /button/, name: /^shipping$/i },
		{ act: "click", role: /button/, name: /track order/i },
	],
	"27-modal-focus-trap": [
		{ act: "click", role: /button/, name: /invite teammate/i },
		{ act: "type", role: /textbox/, name: /email/i, text: "ada@example.com" },
		{ act: "click", role: /button/, name: /send invite/i },
	],
	// Page through until the link shows, then open it.
	"41-pagination": [{ act: "click", role: /link/, name: /^gadget 27$/i, else: { role: /button/, name: /^next$/i }, tries: 4 }],
};

const outArg = process.argv.indexOf("--out");
const h = await startHarness();
const rows = [];
try {
	await h.connected();
	for (const id of ids) {
		const c = (await import(`../test/dom-bench/pages/${id}.mjs`)).default;
		const row = { id };
		for (const mode of ["before", "after"]) {
			const url = h.mount(`${id}-${mode}`, c.html);
			await h.tool("navigate", { url });
			let calls = 0;
			let bytes = 0;
			let acts = 0;
			let actMs = 0;
			const t0 = Date.now();
			const charge = (text) => {
				calls++;
				bytes += Buffer.byteLength(text);
			};
			let known = [];
			const read = async () => {
				const raw = await h.tool("read_page", { filter: "interactive" });
				charge(raw);
				known = parseNodes(raw);
			};
			const pick = (role, name) => known.find((n) => role.test(n.role) && name.test(n.name));
			let lastChanges;
			const act = async (step, target) => {
				const args = step.act === "click" ? { ref: target.ref } : step.act === "fill" ? { ref: target.ref, value: step.text } : { ref: target.ref, text: step.text };
				const ta = Date.now();
				const raw = await h.tool(step.act === "fill" ? "fill" : step.act, args);
				acts++;
				actMs += Date.now() - ta;
				const result = JSON.parse(raw);
				lastChanges = result.changes;
				if (mode === "before") {
					const { changes, ...rest } = result;
					charge(JSON.stringify(rest));
					await read(); // confirm, and fresh refs for the next step
					return;
				}
				charge(raw);
				const ch = result.changes;
				if (ch && typeof ch === "object") {
					if (ch.page) known = [];
					const lines = [...(ch.appeared ?? []), ...(ch.changed ?? [])].join("\n");
					const fresh = parseNodes(lines);
					known = [...fresh, ...known.filter((n) => !fresh.some((f) => f.ref === n.ref))];
					if (ch.gone) known = known.filter((n) => !ch.gone.some((g) => g.startsWith(`${n.ref} `)));
				}
			};
			await read();
			for (const step of plans[id]) {
				for (let i = 0; i < (step.tries ?? 1); i++) {
					let target = pick(step.role, step.name);
					if (!target && mode === "after" && !(step.else && pick(step.else.role, step.else.name))) {
						await read();
						target = pick(step.role, step.name);
					}
					if (target) {
						await act(step, target);
						break;
					}
					const next = step.else && pick(step.else.role, step.else.name);
					if (!next) throw new Error(`${id} ${mode}: no ${step.name} and no way on`);
					await act({ act: "click" }, next);
				}
			}
			// The after agent confirms with a read only when the last report showed nothing.
			if (mode === "after" && (lastChanges === "nothing changed" || lastChanges?.page)) await read();
			const page = { eval: (expr) => h.evaluate(expr, `${h.origin}/${id}-${mode}/`) };
			let pass = false;
			for (let i = 0; i < 10 && !pass; i++) {
				pass = (await c.check(page).catch(() => false)) === true;
				if (!pass) await new Promise((r) => setTimeout(r, 250));
			}
			row[mode] = { calls, tokens: Math.round(bytes / 4), pass, ms: Date.now() - t0, acts, actMs };
		}
		rows.push(row);
		process.stderr.write(`${id}: before ${row.before.calls} calls ${row.before.tokens} tok, after ${row.after.calls} calls ${row.after.tokens} tok\n`);
	}
} finally {
	await h.stop();
}

const sum = (mode, k) => rows.reduce((n, r) => n + r[mode][k], 0);
console.log(`\n${"task".padEnd(22)} ${"before".padStart(16)} ${"after".padStart(16)}`);
for (const r of rows)
	console.log(
		`${r.id.padEnd(22)} ${`${r.before.calls} calls ${r.before.tokens}`.padStart(16)} ${`${r.after.calls} calls ${r.after.tokens}`.padStart(16)}${r.before.pass && r.after.pass ? "" : "  CHECK FAILED"}`,
	);
const totals = (mode) => ({ calls: sum(mode, "calls"), tokens: sum(mode, "tokens"), ms: sum(mode, "ms"), actMsEach: Math.round(sum(mode, "actMs") / sum(mode, "acts")) });
const total = { before: totals("before"), after: totals("after") };
console.log(`${"total".padEnd(22)} ${`${total.before.calls} calls ${total.before.tokens}`.padStart(16)} ${`${total.after.calls} calls ${total.after.tokens}`.padStart(16)}`);
console.log(`wall time: before ${total.before.ms} ms, after ${total.after.ms} ms; one action: before ${total.before.actMsEach} ms, after ${total.after.actMsEach} ms`);
if (outArg > 0) writeFileSync(process.argv[outArg + 1], `${JSON.stringify({ rows, total }, null, 2)}\n`);
if (rows.some((r) => !r.before.pass || !r.after.pass)) process.exitCode = 1;
