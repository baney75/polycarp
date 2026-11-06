// The skill router's regression suite (docs/skill-platform.md). `tabkyra skill eval` runs
// skills-eval/router-cases.jsonl through the router and checks every gate: top-1 accuracy,
// false invokes on "none" cases, cases per skill, p95 latency, the committed baseline, and
// the floors on skills-eval/router-heldout.jsonl, which the scorer was never tuned on.
// The cases file is shared: other skills append their own cases, so the runner must take
// extra cases, including cases for a skill that isn't bundled yet.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const repo = join(here, "..", "..");
const casesFile = join(repo, "skills-eval", "router-cases.jsonl");
const heldoutFile = join(repo, "skills-eval", "router-heldout.jsonl");
const catalog = readFileSync(join(here, "..", "src", "skills-catalog.ts"), "utf8");
const bundled = [...catalog.matchAll(/\["([a-z0-9-]+)", [A-Z0-9_]+\]/g)].map((m) => m[1]);
const root = mkdtempSync(join(tmpdir(), "tabkyra-router-"));
after(() => rmSync(root, { recursive: true, force: true }));

function run(args, { home = mkdtempSync(join(root, "home-")), cwd = repo } = {}) {
	const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { HOME: home, PATH: dirname(process.execPath), NO_COLOR: "1" } });
	return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function evalJson(args = [], options) {
	const r = run(["skill", "eval", "--json", ...args], options);
	return { code: r.code, report: JSON.parse(r.stdout), out: r.out };
}

test("the router meets every gate on the shared cases", (t) => {
	const { code, report, out } = evalJson();
	const pct = (x) => `${(x * 100).toFixed(1)}%`;
	t.diagnostic(`top-1 ${pct(report.top1)} over ${report.positives} cases; false invokes ${pct(report.falseInvoke)} of ${report.negatives}`);
	t.diagnostic(`held-out: top-1 ${pct(report.heldout.top1)} over ${report.heldout.positives} cases; false invokes ${pct(report.heldout.falseInvoke)} of ${report.heldout.negatives}`);
	t.diagnostic(`index build ${report.speed.buildMs} ms; p50 ${report.speed.p50Ms} ms, p95 ${report.speed.p95Ms} ms, max ${report.speed.maxMs} ms over ${report.speed.matches} matches`);
	for (const m of report.misses) t.diagnostic(`miss: expected ${m.expected}, got ${m.got}: ${m.task}`);
	assert.ok(report.top1 >= 0.9, `top-1 ${report.top1}`);
	assert.ok(report.falseInvoke <= 0.05, `false invokes ${report.falseInvoke}`);
	for (const name of bundled) assert.ok(report.perSkill[name].cases >= report.thresholds.MIN_CASES, `${name} has ${report.perSkill[name].cases} cases; it needs ${report.thresholds.MIN_CASES}`);
	assert.ok(report.heldout.top1 >= report.thresholds.HELDOUT_TOP1_MIN, `held-out top-1 ${report.heldout.top1}`);
	assert.ok(report.heldout.falseInvoke <= report.thresholds.HELDOUT_FALSE_INVOKE_MAX, `held-out false invokes ${report.heldout.falseInvoke}`);
	assert.ok(report.speed.p95Ms < 10, `p95 ${report.speed.p95Ms} ms`);
	const baseline = report.gates.find((g) => g.gate === "baseline");
	assert.ok(baseline.ok, baseline.detail);
	assert.equal(code, 0, out);
	assert.equal(report.ok, true);
});

test("the case files are valid JSONL, cover every skill and have none cases", () => {
	const { thresholds } = evalJson().report;
	const counts = (file) => {
		const out = new Map();
		for (const line of readFileSync(file, "utf8").split("\n").filter((l) => l.trim())) {
			const c = JSON.parse(line);
			assert.equal(typeof c.task, "string");
			assert.match(c.skill, /^(none|[a-z0-9]+(-[a-z0-9]+)*)$/);
			out.set(c.skill, (out.get(c.skill) ?? 0) + 1);
		}
		return out;
	};
	const main = counts(casesFile);
	assert.ok([...main.values()].reduce((a, b) => a + b, 0) >= 200, "200 or more cases");
	for (const name of bundled) assert.ok((main.get(name) ?? 0) >= thresholds.MIN_CASES, `${name} has ${main.get(name) ?? 0} cases`);
	assert.ok((main.get("none") ?? 0) >= 20, "at least 20 none cases");
	const held = counts(heldoutFile);
	assert.ok([...held.values()].reduce((a, b) => a + b, 0) >= 40, "40 or more held-out cases");
	for (const name of [...bundled, "none"]) assert.ok((held.get(name) ?? 0) >= 1, `no held-out case for ${name}`);
});

function casesDir(extra = "", baseline, { heldout = true } = {}) {
	const dir = mkdtempSync(join(root, "cases-"));
	writeFileSync(join(dir, "router-cases.jsonl"), readFileSync(casesFile, "utf8") + extra);
	if (heldout) copyFileSync(heldoutFile, join(dir, "router-heldout.jsonl"));
	if (baseline === undefined) copyFileSync(join(repo, "skills-eval", "baseline.json"), join(dir, "baseline.json"));
	else if (baseline !== null) writeFileSync(join(dir, "baseline.json"), baseline);
	return dir;
}

test("extra cases, and cases for a skill that isn't bundled yet, don't break the run", () => {
	const dir = casesDir('\n{"task": "Plan my sprint board", "skill": "future-skill"}\n\n{"task": "/autoresearch the history of tea", "skill": "autoresearch"}\n');
	const { code, report } = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.deepEqual(
		report.skipped.map((s) => s.skill),
		["future-skill"],
	);
	assert.equal(report.perSkill["future-skill"], undefined);
	assert.equal(code, 0);
});

test("a malformed case is an error with its line number", () => {
	const dir = casesDir('{"task": "no skill field"}\n');
	const r = run(["skill", "eval", "--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /line \d+ needs/);
});

test("a baseline can't claim more than the router measures, even by a little; --update-baseline resets it", () => {
	const current = evalJson().report;
	const weak = Object.entries(current.perSkill).find(([name, s]) => name !== "none" && s.accuracy <= 0.85)?.[0];
	assert.ok(weak, "some skill below 85% to test with");
	const raised = JSON.stringify({ accuracy: { ...JSON.parse(readFileSync(join(repo, "skills-eval", "baseline.json"), "utf8")).accuracy, [weak]: 1 } });
	const dir = casesDir("", raised);
	const failed = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(failed.code, 1);
	const gate = failed.report.gates.find((g) => g.gate === "baseline");
	assert.equal(gate.ok, false);
	assert.match(gate.detail, new RegExp(weak));
	const updated = run(["skill", "eval", "--update-baseline", "--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(updated.code, 0, updated.out);
	assert.equal(JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")).accuracy[weak], Math.round(current.perSkill[weak].accuracy * 10000) / 10000);
	// Two points above what it measures is already too much: no tolerance.
	const nudged = JSON.stringify({ accuracy: { ...JSON.parse(readFileSync(join(repo, "skills-eval", "baseline.json"), "utf8")).accuracy, [weak]: current.perSkill[weak].accuracy + 0.02 } });
	const small = evalJson(["--cases", join(casesDir("", nudged), "router-cases.jsonl")]);
	assert.equal(small.code, 1);
	assert.match(small.report.gates.find((g) => g.gate === "baseline").detail, new RegExp(`claims more than the router measures: ${weak}`));
});

test("a missing baseline, or one without a valid value for every skill, fails the run", () => {
	const dir = casesDir("", null);
	const { code, report } = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(code, 1);
	assert.match(report.gates.find((g) => g.gate === "baseline").detail, /no baseline/);
	const full = JSON.parse(readFileSync(join(repo, "skills-eval", "baseline.json"), "utf8")).accuracy;
	for (const accuracy of [{}, { ...full, dorks: undefined }, { ...full, dorks: 1.5 }, { ...full, dorks: -0.1 }, { ...full, dorks: "1" }, { ...full, none: null }]) {
		const bad = casesDir("", JSON.stringify({ accuracy }));
		const r = evalJson(["--cases", join(bad, "router-cases.jsonl")]);
		assert.equal(r.code, 1, JSON.stringify(accuracy));
		assert.match(r.report.gates.find((g) => g.gate === "baseline").detail, /no valid baseline/);
	}
});

test("held-out cases are reported apart from the tuned set, and a missing held-out file fails", () => {
	const { report } = evalJson();
	assert.ok(report.heldout.cases >= 40);
	assert.ok(report.gates.find((g) => g.gate === "held-out top-1").ok);
	const dir = casesDir("", undefined, { heldout: false });
	const r = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(r.code, 1);
	assert.match(r.report.gates.find((g) => g.gate === "held-out top-1").detail, /no router-heldout/);
});

test("eval finds the cases from a subfolder, and says how to point at them from elsewhere", () => {
	assert.equal(run(["skill", "eval"], { cwd: join(repo, "cli") }).code, 0);
	const away = run(["skill", "eval"], { cwd: root });
	assert.equal(away.code, 1, away.out);
	assert.match(away.out, /--cases/);
});

test("skill match ranks skills, says none, and takes --json and --top", () => {
	const best = run(["skill", "match", "find peer-reviewed studies on sleep and memory"]);
	assert.equal(best.code, 0, best.out);
	assert.match(best.stdout, /^academic-research\s/);
	const json = JSON.parse(run(["skill", "match", "--json", "--top", "2", "/rsi", "learn", "from", "this"]).stdout);
	assert.ok(json.length >= 1 && json.length <= 2, JSON.stringify(json));
	assert.equal(json[0].name, "rsi");
	assert.equal(typeof json[0].score, "number");
	assert.match(json[0].description, /\.$/);
	assert.deepEqual(JSON.parse(run(["skill", "match", "--json", "write a haiku about autumn leaves"]).stdout).map((m) => m.name), ["none"]);
	assert.match(run(["skill", "match", "convert 72 degrees Fahrenheit to Celsius"]).out, /none/);
	assert.equal(JSON.parse(run(["skill", "match", "--top=1", "--json", "osint background check on a contractor"]).stdout).length, 1);
	assert.equal(run(["skill", "match", "--top", "0", "x"]).code, 1);
	assert.equal(run(["skill", "match", "--top"]).code, 2);
	assert.equal(run(["skill", "match"]).code, 1);
});

test("phrases made only of common words can't make a match on their own", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("What's new in Python 3.13?"), "none");
	assert.equal(name("What's going on with my Docker build?"), "none");
	assert.equal(name("Fix the artifact upload in my GitHub Actions workflow"), "none");
});

test("a quoted phrase in an excluded sentence never counts", () => {
	const home = mkdtempSync(join(root, "excluded-"));
	const dir = join(home, "drafts", "receipt-filer");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: receipt-filer\ndescription: File receipts into monthly folders. Not for "invoice triage". Use when the user asks to file or sort receipts.\n---\n# Receipt filer\n\n## When to use\n\n- The user has receipts to file.\n\nNot for "supplier statements".\n\n## Steps\n\n1. **List them.** Read each receipt.\n2. **File them.** One folder per month.\n\n## Done when\n\n- Every receipt is filed.\n`,
	);
	assert.equal(run(["skill", "apply", dir, "--yes"], { home }).code, 0);
	const names = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "5", task], { home }).stdout).map((m) => m.name);
	assert.ok(names("file my receipts into monthly folders").includes("receipt-filer"), "the fixture routes at all");
	assert.ok(!names("invoice triage").includes("receipt-filer"));
	assert.ok(!names("supplier statements").includes("receipt-filer"));
});

test("a skill named as the object of the task doesn't count for itself", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("/fix news-research"), "fix");
	assert.equal(name("The osint skill gave my small model a bad result, repair it"), "fix");
});

test("skill match routes to a skill the user applied locally", () => {
	const home = mkdtempSync(join(root, "local-"));
	const dir = join(home, "drafts", "invoice-triage");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: invoice-triage\ndescription: Sort supplier invoices into paid, due and disputed. Use when the user asks to triage, sort or reconcile supplier invoices.\n---\n# Invoice triage\n\n## When to use\n\n- The user has a pile of supplier invoices to sort.\n\n## Steps\n\n1. **List them.** Read each invoice.\n2. **Sort them.** Paid, due or disputed.\n\n## Done when\n\n- Every invoice has a status.\n`,
	);
	const applied = run(["skill", "apply", dir, "--yes"], { home });
	assert.equal(applied.code, 0, applied.out);
	assert.equal(JSON.parse(run(["skill", "match", "--json", "triage my supplier invoices"], { home }).stdout)[0].name, "invoice-triage");
	assert.equal(run(["skill", "revert", "invoice-triage"], { home }).code, 0);
	assert.notEqual(JSON.parse(run(["skill", "match", "--json", "triage my supplier invoices"], { home }).stdout)[0].name, "invoice-triage");
});

/** A fake pull-request checkout: skills-eval files and cli/src/skill-eval.ts, each changeable. */
const EVAL_FILES = ["router-cases.jsonl", "router-heldout.jsonl", "baseline.json", "accepted-drops.json"];
const repoBaseline = () => JSON.parse(readFileSync(join(repo, "skills-eval", "baseline.json"), "utf8")).accuracy;
const dropsFile = (...drops) => JSON.stringify({ drops });

function headCheckout({ evalSource = readFileSync(join(here, "..", "src", "skill-eval.ts"), "utf8"), baseline, drops, cases } = {}) {
	const dir = mkdtempSync(join(root, "head-"));
	mkdirSync(join(dir, "skills-eval"));
	mkdirSync(join(dir, "cli", "src"), { recursive: true });
	for (const f of EVAL_FILES) copyFileSync(join(repo, "skills-eval", f), join(dir, "skills-eval", f));
	if (baseline) writeFileSync(join(dir, "skills-eval", "baseline.json"), baseline);
	if (drops) writeFileSync(join(dir, "skills-eval", "accepted-drops.json"), drops);
	if (cases) writeFileSync(join(dir, "skills-eval", "router-cases.jsonl"), cases);
	if (evalSource !== null) writeFileSync(join(dir, "cli", "src", "skill-eval.ts"), evalSource);
	return dir;
}

/** A fake base-branch checkout with this branch's skills-eval files, optionally changed. */
function baseCheckout(change = {}) {
	const dir = mkdtempSync(join(root, "base-"));
	mkdirSync(join(dir, "skills-eval"));
	for (const f of EVAL_FILES) writeFileSync(join(dir, "skills-eval", f), change[f] ?? readFileSync(join(repo, "skills-eval", f), "utf8"));
	return dir;
}

function baseRun(head, base) {
	const r = run(["skill", "eval", "--json", "--base", base, "--cases", join(head, "skills-eval", "router-cases.jsonl")]);
	const out = JSON.parse(r.stdout);
	return { code: r.code, skills: out.skills, gates: Object.fromEntries(out.gates.map((g) => [g.gate, g])) };
}

test("--base passes a pull request that keeps the base branch's cases, baseline and thresholds", () => {
	const r = baseRun(headCheckout(), baseCheckout());
	assert.equal(r.code, 0, JSON.stringify(r.gates));
	for (const gate of ["base cases kept", "base baseline", "base thresholds", "base-code eval"]) assert.ok(r.gates[gate]?.ok, gate);
	assert.equal(r.skills, bundled.length, "every bundled skill is indexed");
});

test("--base fails a pull request that drops a base case", () => {
	const r = baseRun(headCheckout(), baseCheckout({ "router-heldout.jsonl": `${readFileSync(heldoutFile, "utf8")}{"task": "A case the pull request deleted", "skill": "none"}\n` }));
	assert.equal(r.code, 1);
	assert.equal(r.gates["base cases kept"].ok, false);
	assert.match(r.gates["base cases kept"].detail, /A case the pull request deleted/);
});

test("--base: the baseline only ratchets up; any lower value needs an accepted drop the pull request adds", () => {
	const accuracy = repoBaseline();
	const lowered = (value, drops, base = {}) => baseRun(headCheckout({ baseline: JSON.stringify({ accuracy: { ...accuracy, dorks: value } }), drops }), baseCheckout(base));
	// Any drop fails, even a small one, so small steps can't add up across pull requests.
	for (const value of [0.5, 0.95]) {
		const r = lowered(value);
		assert.equal(r.code, 1, String(value));
		assert.match(r.gates["base baseline"].detail, new RegExp(`dorks ${(value * 100).toFixed(1)}% \\(base 100\\.0%\\)`));
	}
	assert.match(lowered(undefined).gates["base baseline"].detail, /dorks missing/);
	// An entry for the exact new value, with a reason, accepts it.
	const ok = lowered(0.95, dropsFile({ skill: "dorks", value: 0.95, reason: "new skills share its search words" }));
	assert.equal(ok.gates["base baseline"].ok, true, ok.gates["base baseline"].detail);
	assert.match(ok.gates["base baseline"].detail, /accepted drops: dorks 95\.0%/);
	// Not for another value, and not from an entry the base branch already had.
	assert.equal(lowered(0.9, dropsFile({ skill: "dorks", value: 0.95, reason: "x" })).gates["base baseline"].ok, false);
	const stale = dropsFile({ skill: "dorks", value: 0.95, reason: "accepted long ago" });
	assert.equal(lowered(0.95, stale, { "accepted-drops.json": stale }).gates["base baseline"].ok, false);
	// Malformed entries are refused.
	for (const bad of [dropsFile({ skill: "dorks", value: 0.95 }), dropsFile({ skill: "dorks", value: 2, reason: "x" }), "{}"]) {
		const r = run(["skill", "eval", "--json", "--base", baseCheckout(), "--cases", join(headCheckout({ drops: bad }), "skills-eval", "router-cases.jsonl")]);
		assert.equal(r.code, 1);
		assert.match(r.out, /accepted-drops\.json/);
	}
	// Raising a value is always fine.
	assert.ok(baseRun(headCheckout(), baseCheckout({ "baseline.json": JSON.stringify({ accuracy: { ...accuracy, dorks: 0.9 } }) })).gates["base baseline"].ok);
});

test("--base fails a pull request that loosens a threshold or hides them", () => {
	const source = readFileSync(join(here, "..", "src", "skill-eval.ts"), "utf8");
	for (const [from, to] of [
		["export const TOP1_MIN = 0.9;", "export const TOP1_MIN = 0.8;"],
		["export const FALSE_INVOKE_MAX = 0.05;", "export const FALSE_INVOKE_MAX = 0.2;"],
		["export const MIN_CASES = 8;", "export const MIN_CASES = 2;"],
		["export const HELDOUT_TOP1_MIN = 0.8;", "export const HELDOUT_TOP1_MIN = 0.5;"],
	]) {
		assert.ok(source.includes(from), from);
		const r = baseRun(headCheckout({ evalSource: source.replace(from, to) }), baseCheckout());
		assert.equal(r.code, 1, to);
		assert.match(r.gates["base thresholds"].detail, new RegExp(to.split(" ")[2]));
	}
	const stricter = baseRun(headCheckout({ evalSource: source.replace("export const TOP1_MIN = 0.9;", "export const TOP1_MIN = 0.91;") }), baseCheckout());
	assert.ok(stricter.gates["base thresholds"].ok, "a stricter threshold is fine");
	const hidden = baseRun(headCheckout({ evalSource: null }), baseCheckout());
	assert.equal(hidden.gates["base thresholds"].ok, false);
});

test("--base runs the base code's gates on the pull request's skills, with no tolerance below the base baseline", () => {
	const accuracy = repoBaseline();
	// A weak skill with no drop already on record: a drop the base has counts only once.
	const recorded = new Set((JSON.parse(readFileSync(join(repo, "skills-eval", "accepted-drops.json"), "utf8")).drops ?? []).map((d) => d.skill));
	const weak = Object.entries(accuracy).find(([name, v]) => name !== "none" && v <= 0.85 && !recorded.has(name))[0];
	const raised = { "baseline.json": JSON.stringify({ accuracy: { ...accuracy, [weak]: Math.min(1, accuracy[weak] + 0.02) } }) };
	const r = baseRun(headCheckout(), baseCheckout(raised));
	assert.equal(r.code, 1);
	assert.equal(r.gates["base-code eval"].ok, false);
	assert.match(r.gates["base-code eval"].detail, new RegExp(`claims more than the router measures: .*${weak}`));
	// The same drop, accepted by the pull request, passes both gates.
	const accepted = baseRun(headCheckout({ drops: dropsFile({ skill: weak, value: accuracy[weak], reason: "measured the same way" }) }), baseCheckout(raised));
	assert.ok(accepted.gates["base-code eval"].ok, accepted.gates["base-code eval"].detail);
	assert.ok(accepted.gates["base baseline"].ok, accepted.gates["base baseline"].detail);
});

test("--base accepts a valid drop for none, keeping its floor and the false-invoke gate", () => {
	const accuracy = repoBaseline();
	const r = baseRun(
		headCheckout({ baseline: JSON.stringify({ accuracy: { ...accuracy, none: 0.98 } }), drops: dropsFile({ skill: "none", value: 0.98, reason: "more near-miss cases" }) }),
		baseCheckout({ "baseline.json": JSON.stringify({ accuracy: { ...accuracy, none: 1 } }) }),
	);
	for (const gate of ["accepted drops", "base baseline", "base-code eval"]) assert.ok(r.gates[gate].ok, `${gate}: ${r.gates[gate].detail}`);
	assert.doesNotMatch(r.gates["base-code eval"].detail, /no valid baseline/);
});

test("--base runs the base code's gates over all of the pull request's cases", () => {
	const ok = baseRun(headCheckout(), baseCheckout());
	assert.ok(ok.gates["base-code full eval"].ok, ok.gates["base-code full eval"].detail);
	// New cases the router gets wrong: the base code's top-1 gate catches them, whatever the
	// pull request's own gate logic says.
	const wrong = Array.from({ length: 40 }, (_, i) => `{"task": "Convert this JSON file number ${i} to YAML", "skill": "dorks"}`).join("\n");
	const r = baseRun(headCheckout({ cases: `${readFileSync(casesFile, "utf8")}${wrong}\n` }), baseCheckout());
	assert.equal(r.gates["base-code full eval"].ok, false);
	assert.match(r.gates["base-code full eval"].detail, /top-1 accuracy/);
	assert.ok(r.gates["base cases kept"].ok, "only new cases were added");
});

test("--base doesn't ask base coverage of a skill the pull request adds", () => {
	// A base branch that never had the weakest skill: no cases, no baseline. The pull request
	// "adds" it. (The weakest, so leaving its cases out doesn't lower top-1 for the rest.)
	const accuracy = repoBaseline();
	const added = Object.entries(accuracy)
		.filter(([name]) => name !== "none")
		.sort((a, b) => a[1] - b[1])[0][0];
	const without = (file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => !l.includes(`"skill": "${added}"`))
			.join("\n");
	const cases = without(casesFile);
	const heldout = without(heldoutFile);
	const { [added]: _dropped, ...rest } = accuracy;
	const r = baseRun(headCheckout(), baseCheckout({ "router-cases.jsonl": cases, "router-heldout.jsonl": heldout, "baseline.json": JSON.stringify({ accuracy: rest }) }));
	assert.ok(r.gates["base-code eval"].ok, r.gates["base-code eval"].detail);
	assert.ok(r.gates["base baseline"].ok, r.gates["base baseline"].detail);
	assert.equal(r.skills, bundled.length, "the new skill is still indexed");
});

test("the catalog script writes exactly the committed catalog from skills/", () => {
	const scratch = mkdtempSync(join(root, "catalog-"));
	mkdirSync(join(scratch, "cli", "src"), { recursive: true });
	mkdirSync(join(scratch, "cli", "scripts"), { recursive: true });
	copyFileSync(join(here, "..", "scripts", "skills-catalog.mjs"), join(scratch, "cli", "scripts", "skills-catalog.mjs"));
	for (const name of bundled) {
		mkdirSync(join(scratch, "skills", name), { recursive: true });
		copyFileSync(join(repo, "skills", name, "SKILL.md"), join(scratch, "skills", name, "SKILL.md"));
	}
	const r = spawnSync(process.execPath, [join(scratch, "cli", "scripts", "skills-catalog.mjs")], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(join(scratch, "cli", "src", "skills-catalog.ts"), "utf8"), catalog);
	// A removed skill drops out of the catalog instead of leaving a broken import.
	rmSync(join(scratch, "skills", "dorks"), { recursive: true });
	mkdirSync(join(scratch, "skills", "new-skill"));
	writeFileSync(join(scratch, "skills", "new-skill", "SKILL.md"), "x");
	spawnSync(process.execPath, [join(scratch, "cli", "scripts", "skills-catalog.mjs")]);
	const regenerated = readFileSync(join(scratch, "cli", "src", "skills-catalog.ts"), "utf8");
	assert.doesNotMatch(regenerated, /dorks/);
	assert.match(regenerated, /import SKILL_NEW_SKILL from "\.\.\/\.\.\/skills\/new-skill\/SKILL\.md";/);
	assert.match(regenerated, /\["new-skill", SKILL_NEW_SKILL\]/);
});

test("naming a skill to use routes to it; naming it to change it doesn't", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("Use the osint skill on the landlord at 12 Elm St"), "osint");
	assert.equal(name("run the dorks skill to find PDFs"), "dorks");
	assert.equal(name("use the tabkyra skill to fill the form"), "tabkyra");
	assert.equal(name("the proton-pass skill, please, for the deploy token"), "proton-pass");
	assert.notEqual(name("Repair the osint skill, it keeps failing on small models"), "osint");
	assert.notEqual(name("Update the dorks skill with a new operator"), "dorks");
});

test("a slash command counts only as the first token, never as part of a path", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("/rsi"), "rsi");
	assert.equal(name("/autoresearch: what caused the 2008 crisis"), "autoresearch");
	for (const task of ["Copy the build output to /artifacts in the container", "cat /bug/report.txt", "ls /fix", "/fix/old.log is too big", "/rsi.json is missing"]) {
		assert.equal(name(task), "none", task);
	}
});

test("common words alone never make a match, however many add up", () => {
	const home = mkdtempSync(join(root, "common-"));
	// Five skills share the same three words, so none of the words is specific (evidence).
	const words = "quartz, lantern, harbor";
	for (const n of ["one", "two", "three", "four", "five"]) {
		const dir = join(home, "drafts", `shared-${n}`);
		mkdirSync(dir, { recursive: true });
		const extra = n === "one" ? `, quartz, lantern, harbor, quartz, lantern, harbor, zephyr` : "";
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: shared-${n}\ndescription: Sorts ${words}${extra}. Use when the user asks about ${words}${extra}.\n---\n# Shared ${n}\n\n## When to use\n\n- The user asks about ${words}.\n\n## Steps\n\n1. **Sort.** Sort them.\n2. **Check.** Check them.\n\n## Done when\n\n- They are sorted.\n`,
		);
		assert.equal(run(["skill", "apply", dir, "--yes"], { home }).code, 0);
	}
	const top = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "5", task], { home }).stdout).map((m) => m.name);
	assert.deepEqual(top("harbor quartz lantern"), ["none"]);
	// One specific word is enough to make them count.
	assert.equal(top("harbor quartz lantern zephyr")[0], "shared-one");
});

test("adding unrelated skills doesn't turn a lone ordinary word into a match", () => {
	const home = mkdtempSync(join(root, "grow-"));
	// Twenty skills about things no case mentions: the catalog grows, so plain IDF would rise.
	for (let i = 0; i < 20; i++) {
		const name = `grown-${String.fromCharCode(97 + i)}`;
		const word = `zq${String.fromCharCode(97 + i)}${String.fromCharCode(122 - i)}x`;
		const dir = join(home, "drafts", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Handles ${word} and ${word}q records. Use when the user asks about ${word} or ${word}q.\n---\n# ${name}\n\n## When to use\n\n- The user asks about ${word}.\n\n## Steps\n\n1. **Read.** Read the ${word} record.\n2. **Answer.** Answer.\n\n## Done when\n\n- The ${word} question is answered.\n`,
		);
		assert.equal(run(["skill", "apply", dir, "--yes"], { home }).code, 0);
	}
	const top = (task) => JSON.parse(run(["skill", "match", "--json", task], { home }).stdout)[0].name;
	// One ordinary word from a bundled skill ("good" in fix, "bug" in bug) stays below the bar.
	assert.equal(top("What's a good name for a golden retriever puppy?"), "none");
	assert.equal(top("There's a bug in my login handler; the session cookie isn't set"), "none");
	// Real matches still route.
	assert.equal(top("Find peer-reviewed studies on sleep and memory"), "academic-research");
	assert.equal(top("compare the zqazx and zqazxq figures"), "grown-a");
});

test("the single-evidence bar is 4.5 up to 13 skills and 4.8 past it", async () => {
	const { build } = await import("esbuild");
	const out = join(mkdtempSync(join(root, "router-unit-")), "router.mjs");
	await build({ entryPoints: [join(here, "..", "src", "skill-router.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
	const r = await import(out);
	assert.equal(r.SINGLE_SCORE, 4.5);
	assert.equal(r.SINGLE_SCORE_LARGE, 4.8);
	const skill = (name, body) => ({
		name,
		text: `---\nname: ${name}\ndescription: ${body}. Use when the user asks about ${body}.\n---\n# ${name}\n\n## When to use\n\n- ${body}.\n`,
	});
	// Filler skills share one common word, so only the target's own word can be evidence.
	const catalog = (n, reps) => [
		skill("target", `${Array(reps).fill("quillwort").join(" ")} plants and common matters`),
		...Array.from({ length: n - 1 }, (_, i) => skill(`filler-${String.fromCharCode(97 + i)}`, `zz${String.fromCharCode(97 + i)}q records and common matters`)),
	];
	// Find a catalog where the target's one piece of evidence scores in [4.5, 4.8).
	const inBand = (n) => {
		for (let reps = 1; reps <= 12; reps++) {
			const index = r.buildRouterIndex(catalog(n, reps));
			const top = r.scoreSkills(index, "quillwort")[0];
			if (top.name === "target" && top.evidence === 1 && top.score >= 4.5 && top.score < 4.8) return index;
		}
		return undefined;
	};
	for (const n of [13]) {
		const index = inBand(n);
		assert.ok(index, `a ${n}-skill catalog with a score between 4.5 and 4.8`);
		assert.equal(index.single, 4.5);
		assert.equal(r.matchSkills(index, "quillwort", 1)[0]?.name, "target", `${n} skills: one piece of evidence at 4.5 or more matches, as on main`);
	}
	const large = inBand(20);
	assert.ok(large, "a 20-skill catalog with a score between 4.5 and 4.8");
	assert.equal(large.single, 4.8);
	assert.equal(r.matchSkills(large, "quillwort", 1).length, 0, "20 skills: the same evidence below 4.8 is none");
	// isMatch takes the bar from the index, so it agrees with matchSkills at every size.
	assert.equal(r.isMatch.length, 2);
	assert.equal(r.isMatch(large, r.scoreSkills(large, "quillwort")[0]), false);
	assert.equal(r.isMatch(inBand(13), r.scoreSkills(inBand(13), "quillwort")[0]), true);
	// The eval and the judge's router worker decide through matchSkills, never a bar of their own.
	for (const file of ["skill-eval.ts", "router-worker.ts"]) {
		const source = readFileSync(join(here, "..", "src", file), "utf8");
		assert.match(source, /matchSkills\(index, task, 1\)/, file);
		assert.doesNotMatch(source, /isMatch|SINGLE_SCORE/, file);
	}
});

test("an accepted drop is a floor, not an exemption, in the head eval and the base-code eval", () => {
	const accuracy = repoBaseline();
	const weak = Object.entries(accuracy).find(([name, v]) => name !== "none" && v <= 0.85)[0];
	// Head eval: a skill measuring below its accepted value fails, with no tolerance.
	const head = casesDir("");
	writeFileSync(join(head, "accepted-drops.json"), dropsFile({ skill: weak, value: Math.min(1, accuracy[weak] + 0.05), reason: "x" }));
	const own = evalJson(["--cases", join(head, "router-cases.jsonl")]);
	assert.equal(own.code, 1);
	assert.match(own.report.gates.find((g) => g.gate === "baseline").detail, new RegExp(`below the accepted drop: ${weak}`));
	// Base-code eval: the base had the weak skill at 1.0; the pull request claims it now sits at
	// 0.99 and accepts that. Under the base code it measures far less, so it fails.
	const claimed = 0.99;
	const r = baseRun(
		headCheckout({ baseline: JSON.stringify({ accuracy: { ...accuracy, [weak]: claimed } }), drops: dropsFile({ skill: weak, value: claimed, reason: "x" }) }),
		baseCheckout({ "baseline.json": JSON.stringify({ accuracy: { ...accuracy, [weak]: 1 } }) }),
	);
	assert.ok(r.gates["accepted drops"].ok, r.gates["accepted drops"].detail);
	assert.equal(r.gates["base-code eval"].ok, false);
	assert.match(r.gates["base-code eval"].detail, new RegExp(`below the accepted drop: ${weak}`));
});

test("accepted drops are validated: a real skill, its new baseline value, below the base", () => {
	const accuracy = repoBaseline();
	const check = (drop, headAccuracy = accuracy, baseAccuracy = { ...accuracy, dorks: 1 }) =>
		baseRun(headCheckout({ baseline: JSON.stringify({ accuracy: headAccuracy }), drops: dropsFile(drop) }), baseCheckout({ "baseline.json": JSON.stringify({ accuracy: baseAccuracy }) })).gates["accepted drops"];
	assert.match(check({ skill: "no-such-skill", value: 0.5, reason: "x" }).detail, /no such skill/);
	// sol-F1: the baseline is left at the base value while an entry claims a lower one.
	assert.match(check({ skill: "dorks", value: 0.99, reason: "x" }).detail, /baseline\.json has 100\.0%/);
	assert.match(check({ skill: "dorks", value: 1, reason: "x" }, { ...accuracy, dorks: 1 }).detail, /not below the base branch/);
	assert.ok(check({ skill: "dorks", value: 0.9, reason: "x" }, { ...accuracy, dorks: 0.9 }).ok);
});

test("--base holds a skill the pull request adds to the base code's coverage and baseline gates", () => {
	const accuracy = repoBaseline();
	const added = Object.entries(accuracy)
		.filter(([name]) => name !== "none")
		.sort((a, b) => a[1] - b[1])[0][0];
	const without = (file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => !l.includes(`"skill": "${added}"`))
			.join("\n");
	const { [added]: _dropped, ...rest } = accuracy;
	const base = baseCheckout({ "router-cases.jsonl": without(casesFile), "router-heldout.jsonl": without(heldoutFile), "baseline.json": JSON.stringify({ accuracy: rest }) });
	assert.ok(baseRun(headCheckout(), base).gates["base-code full eval"].ok);
	// Only three cases for the new skill: the base code's cases-per-skill gate catches it.
	const lines = readFileSync(casesFile, "utf8").split("\n");
	let kept = 0;
	const few = lines.filter((l) => !l.includes(`"skill": "${added}"`) || kept++ < 3).join("\n");
	const thin = baseRun(headCheckout({ cases: few }), base);
	assert.equal(thin.gates["base-code full eval"].ok, false);
	assert.match(thin.gates["base-code full eval"].detail, new RegExp(`cases per skill: under \\d+: ${added} \\(3\\)`));
	// No baseline for the new skill: caught too.
	const unbased = baseRun(headCheckout({ baseline: JSON.stringify({ accuracy: rest }) }), base);
	assert.match(unbased.gates["base-code full eval"].detail, new RegExp(`no valid baseline .*${added}`));
});

test("a malformed baseline.json is a clean error that names the file", () => {
	const dir = casesDir("", "{ not json");
	const r = run(["skill", "eval", "--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(r.code, 1);
	assert.match(r.out, /baseline\.json is not JSON/);
	assert.doesNotMatch(r.out, /SyntaxError|\n\s+at /);
});

test("a local skill whose trigger starts with a backticked command still routes", () => {
	const home = mkdtempSync(join(root, "backtick-"));
	const dir = join(home, "drafts", "vault-runner");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		"---\nname: vault-runner\ndescription: Runs a job for the user. Use `pass-cli run` to inject vault secrets into database migrations. Use when the user asks for this.\n---\n# Vault runner\n\n## When to use\n\n- Use `pass-cli run` when a database migration needs vault secrets.\n\n## Steps\n\n1. **Find the item.** Ask for the item name.\n2. **Run it.** Inject it.\n\n## Done when\n\n- The migration ran.\n",
	);
	const applied = run(["skill", "apply", dir, "--yes"], { home });
	assert.equal(applied.code, 0, applied.out);
	const names = JSON.parse(run(["skill", "match", "--json", "--top", "5", "inject vault secrets into the database migration"], { home }).stdout).map((m) => m.name);
	// Its only words for this task are in the sentence and bullet that start with a backticked command.
	assert.ok(names.includes("vault-runner"), names.join(","));
});

test("an explicit request survives edit-like words elsewhere; a governing edit verb or a negation doesn't", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("Use the news-research skill for the latest updates on the rail strike"), "news-research");
	assert.equal(name("Use the osint skill on the port authority's new contractor"), "osint");
	assert.equal(name("Run the osint skill and review what you find on the landlord"), "osint");
	assert.equal(name("Use the tabkyra skill to fill in my fixed address"), "tabkyra");
	assert.equal(name("Rewrite the dorks skill to Tabkyra's skill standard"), "kyraskillmaker");
	// A "no" or "not" that doesn't govern the mention is no exclusion.
	assert.equal(name("I have no idea who runs this website so use the osint skill"), "osint");
	assert.equal(name("Why not use the osint skill on this landlord?"), "osint");
	assert.equal(name("No rush, use the osint skill"), "osint");
	assert.equal(name("The proton-pass skill gave my small model a bad result, fix it"), "fix");
	const all = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "5", task]).stdout).map((m) => m.name);
	for (const [task, banned] of [
		["Don't use the osint skill, just search the news for the landlord", "osint"],
		["Instead of the dorks skill, write me a plain search query", "dorks"],
		["Skip the tabkyra skill and fetch the URL directly", "tabkyra"],
		["Without the osint skill, do a background check on this landlord", "osint"],
	]) {
		assert.ok(!all(task).includes(banned), `${task} -> ${all(task)}`);
	}
});

test("tabkyra skill <subcommand> is the CLI, not a request for the tabkyra skill", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("tabkyra skill install wrote to the wrong folder, report it"), "bug");
	assert.equal(name("tabkyra skill versions shows nothing for my local skill"), "bug");
	assert.equal(name("how do I use tabkyra skill rollback"), "none");
	assert.equal(name("Use the tabkyra skill to read this page"), "tabkyra");
});

test("the catalog script makes valid, distinct identifiers for any skill name", async () => {
	const { transformSync } = await import("esbuild");
	const scratch = mkdtempSync(join(root, "catalog-names-"));
	mkdirSync(join(scratch, "cli", "src"), { recursive: true });
	mkdirSync(join(scratch, "cli", "scripts"), { recursive: true });
	copyFileSync(join(here, "..", "scripts", "skills-catalog.mjs"), join(scratch, "cli", "scripts", "skills-catalog.mjs"));
	for (const name of ["1password", "skills", "tabkyra", "skill-s", "a-1"]) {
		mkdirSync(join(scratch, "skills", name), { recursive: true });
		writeFileSync(join(scratch, "skills", name, "SKILL.md"), "x");
	}
	assert.equal(spawnSync(process.execPath, [join(scratch, "cli", "scripts", "skills-catalog.mjs")]).status, 0);
	const source = readFileSync(join(scratch, "cli", "src", "skills-catalog.ts"), "utf8");
	assert.doesNotThrow(() => transformSync(source, { loader: "ts", format: "esm" }), "the catalog is valid TypeScript");
	const ids = [...source.matchAll(/^import (\S+) from/gm)].map((m) => m[1]);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(!ids.includes("SKILLS"));
	assert.ok(ids.every((id) => /^[A-Za-z_$][\w$]*$/.test(id)), ids.join(","));
});

/**
 * The CI judge in miniature: this checkout's CLI (the judge, with its skill-eval.ts) runs
 * `skill eval --base --router`, and `routerSource` (the pull request's skill-router.ts) is
 * built into cli/src/router-worker.ts as a script of its own, run in a child process.
 */
/** Build cli/src/router-worker.ts around `routerSource`, as CI does; returns the script. */
async function routerWorker(routerSource) {
	const { build } = await import("esbuild");
	const dir = mkdtempSync(join(root, "router-"));
	const router = join(dir, "skill-router.ts");
	writeFileSync(router, routerSource);
	const worker = join(dir, "router-worker.mjs");
	await build({
		entryPoints: [join(here, "..", "src", "router-worker.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: worker,
		logLevel: "silent",
		plugins: [{ name: "pr-router", setup: (b) => b.onResolve({ filter: /skill-router\.ts$/ }, () => ({ path: router })) }],
	});
	return worker;
}

async function baseCodeWith(routerSource) {
	const worker = await routerWorker(routerSource);
	return baseRunWith(worker);
}

function baseRunWith(worker) {
	return (head, base) => {
		const r = run(["skill", "eval", "--json", "--base", base, "--router", worker, "--cases", join(head, "skills-eval", "router-cases.jsonl")]);
		let out;
		try {
			out = JSON.parse(r.stdout);
		} catch {
			return { code: r.code, out: r.out, gates: {} };
		}
		return { code: r.code, out: r.out, gates: Object.fromEntries(out.gates.map((g) => [g.gate, g])) };
	};
}


const routerSource = readFileSync(join(here, "..", "src", "skill-router.ts"), "utf8");
/** Forty cases only a router that knows the word "zorblax" means OSINT gets right. */
const zorblaxCases = Array.from({ length: 40 }, (_, i) => `{"task": "Zorblax check number ${i} on the Acme supplier", "skill": "osint"}`).join("\n");
/** The same router, improved: "zorblax" asks for the osint skill. */
const improvedRouter = routerSource.replace(
	"\tfor (const name of excluded) invoked.delete(name);",
	'\tif (/\\bzorblax\\b/.test(text)) invoked.add("osint");\n\tfor (const name of excluded) invoked.delete(name);',
);

test("base-code full eval: base gate logic over the PR's router, so a router improvement can merge", async () => {
	assert.notEqual(improvedRouter, routerSource, "the improvement applied");
	const head = headCheckout({ cases: `${readFileSync(casesFile, "utf8")}${zorblaxCases}\n` });
	// Judged with the PR's improved router, the new cases pass under the base gates.
	const improved = (await baseCodeWith(improvedRouter))(head, baseCheckout());
	assert.ok(improved.gates["base-code full eval"].ok, improved.gates["base-code full eval"].detail);
	// Judged with the old router, the same cases fail: the full eval really uses the PR's router.
	const old = (await baseCodeWith(routerSource))(head, baseCheckout());
	assert.equal(old.gates["base-code full eval"].ok, false);
	assert.match(old.gates["base-code full eval"].detail, /top-1 accuracy/);
});

test("base-code full eval: a PR that weakens a gate in its own skill-eval.ts still fails it", async () => {
	const source = readFileSync(join(here, "..", "src", "skill-eval.ts"), "utf8");
	const weakened = source.replace("top1 >= TOP1_MIN", "top1 >= TOP1_MIN - 0.5");
	assert.notEqual(weakened, source, "the weakening applied");
	const wrong = Array.from({ length: 40 }, (_, i) => `{"task": "Convert this JSON file number ${i} to YAML", "skill": "dorks"}`).join("\n");
	const head = headCheckout({ evalSource: weakened, cases: `${readFileSync(casesFile, "utf8")}${wrong}\n` });
	const r = (await baseCodeWith(routerSource))(head, baseCheckout());
	assert.equal(r.gates["base thresholds"].ok, true, "the constants are untouched, so only the logic changed");
	assert.equal(r.gates["base-code full eval"].ok, false, "the base gate logic judges the cases, not the PR's");
	assert.match(r.gates["base-code full eval"].detail, /top-1 accuracy/);
});

test("a pair of words that many skills share isn't evidence either", () => {
	const home = mkdtempSync(join(root, "common-pairs-"));
	// Five skills hold the same adjacent words, so the words and their pairs are all common.
	for (const n of ["one", "two", "three", "four", "five"]) {
		const dir = join(home, "drafts", `pairs-${n}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: pairs-${n}\ndescription: Sorts quartz lantern harbor items. Use when the user asks about quartz lantern harbor items.\n---\n# Pairs ${n}\n\n## When to use\n\n- The user asks about quartz lantern harbor items.\n\n## Steps\n\n1. **Sort.** Sort them.\n2. **Check.** Check them.\n\n## Done when\n\n- They are sorted.\n`,
		);
		assert.equal(run(["skill", "apply", dir, "--yes"], { home }).code, 0);
	}
	assert.deepEqual(JSON.parse(run(["skill", "match", "--json", "--top", "5", "quartz lantern harbor"], { home }).stdout).map((m) => m.name), ["none"]);
});

test("curly apostrophes read as straight ones, so a typed-on-a-phone negation still excludes", () => {
	const all = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "5", task]).stdout).map((m) => m.name);
	for (const [task, banned] of [
		["Don’t use the osint skill, just search the news for the landlord", "osint"],
		["Don’t run the dorks skill, write me a plain search query", "dorks"],
		["Don’t use the tabkyra skill; fetch the URL directly", "tabkyra"],
		["Don’t apply the osint skill, just tell me what you know about the landlord", "osint"],
	]) {
		assert.ok(!all(task).includes(banned), `${task} -> ${all(task)}`);
	}
});

test("'..., debug it' after a use-verb is about the work, not the skill", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("Use the tabkyra skill to open localhost:3000 and debug it"), "tabkyra");
	assert.equal(name("Run the osint skill on the landlord and review it"), "osint");
	// Without a use-verb, "fix it" still points back at the skill.
	assert.equal(name("The proton-pass skill gave my small model a bad result, fix it"), "fix");
	assert.equal(name("The autoresearch skill gave a weak report on my 8B model. Fix it"), "fix");
});

test("--base checks the pull request's baseline for every skill against what the base gates measure", () => {
	// An existing skill's baseline raised above what the router measures fails, even though the
	// base cases and the aggregate gates still pass.
	const accuracy = repoBaseline();
	const weak = Object.entries(accuracy).find(([name, v]) => name !== "none" && v <= 0.9)[0];
	const r = baseRun(headCheckout({ baseline: JSON.stringify({ accuracy: { ...accuracy, [weak]: Math.min(1, accuracy[weak] + 0.03) } }) }), baseCheckout());
	assert.equal(r.gates["base-code full eval"].ok, false);
	assert.match(r.gates["base-code full eval"].detail, new RegExp(`claims more than the router measures: ${weak}`));
	// An accepted floor above what it measures fails there too.
	const floor = baseRun(headCheckout({ drops: dropsFile({ skill: weak, value: Math.min(1, accuracy[weak] + 0.03), reason: "x" }) }), baseCheckout());
	assert.match(floor.gates["base-code full eval"].detail, new RegExp(`below the accepted drop: ${weak}`));
});

test("--base fails a pull request that deletes a measured skill without saying so", () => {
	const accuracy = repoBaseline();
	// The base measured a skill this checkout doesn't have, as if the pull request deleted it.
	const base = baseCheckout({ "baseline.json": JSON.stringify({ accuracy: { ...accuracy, "old-skill": 0.9 } }) });
	const r = baseRun(headCheckout(), base);
	assert.equal(r.gates["skills kept"].ok, false);
	assert.match(r.gates["skills kept"].detail, /old-skill/);
	const said = baseRun(headCheckout({ drops: JSON.stringify({ drops: [], removed: [{ skill: "old-skill", reason: "merged into osint" }] }) }), base);
	assert.ok(said.gates["skills kept"].ok, said.gates["skills kept"].detail);
	assert.match(said.gates["skills kept"].detail, /removed on purpose: old-skill/);
	const bad = run(["skill", "eval", "--json", "--base", base, "--cases", join(headCheckout({ drops: JSON.stringify({ drops: [], removed: [{ skill: "old-skill" }] }) }), "skills-eval", "router-cases.jsonl")]);
	assert.equal(bad.code, 1);
	assert.match(bad.out, /removed entry 1 needs/);
});

test("the PR's router runs in its own process: patching the judge's built-ins does nothing", async () => {
	// A router that makes every "every" return true. In the judge's process this would turn
	// every gate green; in its own process it changes only itself.
	const patched = `Array.prototype.every = function () { return true; };\n${routerSource}`;
	const wrong = Array.from({ length: 40 }, (_, i) => `{"task": "Convert this JSON file number ${i} to YAML", "skill": "dorks"}`).join("\n");
	const r = (await baseCodeWith(patched))(headCheckout({ cases: `${readFileSync(casesFile, "utf8")}${wrong}\n` }), baseCheckout());
	assert.equal(r.code, 1, r.out);
	assert.equal(r.gates["base-code full eval"].ok, false);
});

test("the PR's router can't read the labels: a router that memorises the case file fails", async () => {
	const head = headCheckout();
	const labels = join(head, "skills-eval", "router-cases.jsonl");
	assert.ok(readFileSync(labels, "utf8").length > 0, "the file is there to steal");
	// A router that answers every case from the labelled file.
	const cheat = `import { readFileSync as readLabels } from "node:fs";
const LABELS = new Map(readLabels(${JSON.stringify(labels)}, "utf8").split("\\n").filter(Boolean).map((l) => { const c = JSON.parse(l); return [c.task, c.skill]; }));
${routerSource.replace("export function matchSkills(", "function realMatchSkills(")}
export function matchSkills(index, task, top = 3) {
	const label = LABELS.get(task);
	if (label) return label === "none" ? [] : [{ name: label, score: 99, description: "" }];
	return realMatchSkills(index, task, top);
}
`;
	const r = (await baseCodeWith(cheat))(head, baseCheckout());
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /router process failed/);
	assert.match(r.out, /ERR_ACCESS_DENIED|permission/i);
});

test("inline code around a skill name reads as the name, for requests and exclusions alike", () => {
	const all = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "5", task]).stdout).map((m) => m.name);
	assert.ok(!all("Don't use the `osint` skill; do a background check on this landlord.").includes("osint"));
	assert.equal(all("Use the `dorks` skill to find PDFs about flood maps")[0], "dorks");
	assert.notEqual(all("Fix the `osint` skill, it keeps failing on small models")[0], "osint");
});

test("the judge times the router process itself: a slow router can't report itself fast", async () => {
	// A router that takes 12 ms a match and stops the clock it reports with.
	const slow = `globalThis.performance.now = () => 0;\n${routerSource.replace(
		"export function matchSkills(index: RouterIndex, task: string, top = 3): SkillMatch[] {",
		"export function matchSkills(index: RouterIndex, task: string, top = 3): SkillMatch[] {\n\tconst until = Date.now() + 12;\n\twhile (Date.now() < until);",
	)}`;
	assert.notEqual(slow.indexOf("const until"), -1, "the slowdown applied");
	const worker = await routerWorker(slow);
	const dir = mkdtempSync(join(root, "slow-"));
	writeFileSync(join(dir, "router-cases.jsonl"), '{"task": "Find peer-reviewed studies on sleep", "skill": "academic-research"}\n{"task": "Write a haiku", "skill": "none"}\n');
	writeFileSync(join(dir, "router-heldout.jsonl"), '{"task": "/rsi", "skill": "rsi"}\n');
	const r = run(["skill", "eval", "--json", "--router", worker, "--cases", join(dir, "router-cases.jsonl")]);
	const report = JSON.parse(r.stdout);
	assert.ok(report.speed.p95Ms >= 10, `p95 ${report.speed.p95Ms} ms`);
	assert.equal(report.gates.find((g) => g.gate === "p95 latency").ok, false);
});

test("a router script past 128 KiB runs: it reaches the router process over stdin, not argv", async () => {
	// A side effect, so the bundler keeps it: a router with a big table of its own.
	const padded = `globalThis.routerTable = ${JSON.stringify("x".repeat(200 * 1024))};\n${routerSource}`;
	const worker = await routerWorker(padded);
	assert.ok(readFileSync(worker, "utf8").length > 128 * 1024);
	const r = run(["skill", "eval", "--json", "--router", worker]);
	assert.equal(r.code, 0, r.out.slice(0, 500));
	assert.ok(JSON.parse(r.stdout).ok);
});

test("--router with a missing script is a clean error", () => {
	const r = run(["skill", "eval", "--router", join(root, "no-such-router.mjs")]);
	assert.equal(r.code, 1);
	assert.match(r.out, /No router script at/);
	assert.doesNotMatch(r.out, /ENOENT|\n\s+at /);
});

test("the catalog script refuses a skill folder named none", () => {
	const scratch = mkdtempSync(join(root, "catalog-none-"));
	mkdirSync(join(scratch, "cli", "src"), { recursive: true });
	mkdirSync(join(scratch, "cli", "scripts"), { recursive: true });
	copyFileSync(join(here, "..", "scripts", "skills-catalog.mjs"), join(scratch, "cli", "scripts", "skills-catalog.mjs"));
	for (const name of ["tabkyra", "none"]) {
		mkdirSync(join(scratch, "skills", name), { recursive: true });
		writeFileSync(join(scratch, "skills", name, "SKILL.md"), "x");
	}
	const r = spawnSync(process.execPath, [join(scratch, "cli", "scripts", "skills-catalog.mjs")], { encoding: "utf8" });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /"none" is reserved/);
	assert.equal(existsSync(join(scratch, "cli", "src", "skills-catalog.ts")), false);
});

test("'<name> skill(s)' about a person's abilities names no skill; lists, negations and pointed mentions still do", () => {
	const top = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "3", task]).stdout).map((m) => m.name);
	for (const task of [
		"How can I improve my writing skills?",
		"How can I improve my writing skill?",
		"Recommend a course to build my video editing skills",
		"What chemistry skills do employers want?",
		"What chemistry skill is most useful for a lab job?",
		"I want to sharpen my biology skill before the exam",
		"I want to sharpen my chemistry and biology skills before the exam",
		"How can I improve my writing and video editing skills?",
		"Don't use the osint skills; do a background check on this landlord",
		"Don't use the `osint` skill; do a background check on this landlord.",
	]) {
		assert.deepEqual(top(task), ["none"], task);
	}
	// A negated list rules out every name in it.
	const ruledOut = top("Don't use the osint and dorks skills; search the news for the landlord");
	assert.ok(!ruledOut.includes("osint") && !ruledOut.includes("dorks"), ruledOut.join(","));
	// A list of names, spaced or hyphenated, with "and", "or" or commas, invokes every name.
	assert.deepEqual(top("Use the osint and dorks skills on this landlord").sort(), ["dorks", "osint"]);
	assert.deepEqual(top("Use the video editing and biology skills.").sort(), ["biology", "video-editing"]);
	assert.deepEqual(top("Use the video editing and osint skills on this clip of the landlord").sort(), ["osint", "video-editing"]);
	assert.deepEqual(top("Use the maps, osint or dorks skills for this").sort(), ["dorks", "maps", "osint"]);
	// A determiner points at a skill: use, edit and back-reference still work.
	assert.equal(top("use the video-editing skill to trim talk.mp4")[0], "video-editing");
	assert.equal(top("Improve the osint skill so a small model follows it")[0], "kyraskillmaker");
	assert.equal(top("The autoresearch skill gave a weak report on my 8B model. Fix it")[0], "fix");
	// "a Tabkyra skill" is a kind of skill to make, not a request for the tabkyra skill.
	assert.ok(!top("Port my Cursor rule into a Tabkyra skill that passes lint").includes("tabkyra"));
});

test("past 32 skills the single-evidence bar grows with a two-skill word's weight", async () => {
	const { build } = await import("esbuild");
	const out = join(mkdtempSync(join(root, "router-unit-")), "router.mjs");
	await build({ entryPoints: [join(here, "..", "src", "skill-router.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
	const r = await import(out);
	const skill = (name, body) => ({
		name,
		text: `---\nname: ${name}\ndescription: ${body}. Use when the user asks about ${body}.\n---\n# ${name}\n\n## When to use\n\n- ${body}.\n`,
	});
	// Two skills hold "quillwort", so it is evidence; the rest are filler.
	const index = (n) =>
		r.buildRouterIndex([
			skill("target-a", "quillwort plants"),
			skill("target-b", "quillwort ferns"),
			...Array.from({ length: n - 2 }, (_, i) => skill(`filler-${i}`, `zz${i}q records`)),
		]);
	const ratio = (n) => {
		const ix = index(n);
		const key = [...ix.idf.keys()].find((k) => k.startsWith("quillwort"));
		return { single: ix.single, ratio: ix.idf.get(key) / ix.single };
	};
	assert.equal(ratio(20).single, 4.8);
	assert.equal(ratio(32).single, 4.8);
	assert.ok(ratio(52).single > 4.8);
	// The word's weight relative to the bar is the same at 52 skills as at 32.
	assert.ok(Math.abs(ratio(52).ratio - ratio(32).ratio) < 1e-9, `${ratio(32).ratio} vs ${ratio(52).ratio}`);
});
