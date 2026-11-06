/**
 * `tabkyra skill eval`: the router's regression suite. Cases live in
 * skills-eval/router-cases.jsonl, one `{"task": "...", "skill": "<name>|none"}` per line,
 * and the per-skill accuracy each release must keep is in skills-eval/baseline.json.
 * skills-eval/router-heldout.jsonl holds cases the scorer was never tuned on; it is the
 * honest estimate of accuracy on new phrasings, and it has lower floors of its own.
 *
 * The gates, all checked by CI (the skill-regression job and cli/test/skill-router.test.mjs):
 * top-1 accuracy over positive cases, the false-invoke rate on "none" cases, at least
 * MIN_CASES cases for every bundled skill, p95 match latency, a baseline value for every
 * bundled skill, none of them above what the router measures, and the held-out floors.
 * Cases that name a skill the catalog doesn't have are skipped and listed, so cases for a
 * skill can land before or after the skill itself.
 *
 * `--base <checkout>` is run by the base branch's build in CI. It checks that a pull request
 * kept every base case, didn't loosen a threshold, and didn't lower any skill's baseline,
 * and that under the base code its skills route the base cases at least as well as the base
 * baseline says. The baseline only ratchets up: a lower value passes only when the pull
 * request adds it to skills-eval/accepted-drops.json with a reason, which a maintainer
 * reviews (CODEOWNERS). So a pull request can't lower its own bar, in one step or many.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildRouterIndex, matchSkills, type RouterSkill } from "./skill-router.ts";

/** Rank every task: the top skill (or "none") per task, plus timings. */
export type Ranker = (
	skills: RouterSkill[],
	tasks: string[],
	rounds: number,
) => {
	buildMs: number;
	top: string[];
	timesMs: number[];
	/** Wall-clock time per match measured by the judge around a router process: a floor for p95. */
	wallPerMatchMs?: number;
};

/** The router in this process: what `tabkyra skill eval` uses by default. */
export const inProcessRanker: Ranker = (skills, tasks, rounds) => {
	const started = performance.now();
	const index = buildRouterIndex(skills);
	const buildMs = performance.now() - started;
	const top: string[] = [];
	const timesMs: number[] = [];
	for (let r = 0; r < rounds; r++) {
		for (const task of tasks) {
			const t0 = performance.now();
			const name = matchSkills(index, task, 1)[0]?.name ?? "none";
			timesMs.push(performance.now() - t0);
			if (r === 0) top.push(name);
		}
	}
	return { buildMs, top, timesMs };
};

/**
 * The loader the router process runs: fixed, tiny, and from the judge. It reads the router
 * bundle and the request from stdin and imports the bundle from memory, so the router needs
 * no file access, and a large router isn't limited by the command line.
 */
const ROUTER_LOADER = [
	"const chunks = [];",
	"for await (const chunk of process.stdin) chunks.push(chunk);",
	'const { source, request } = JSON.parse(Buffer.concat(chunks).toString("utf8"));',
	'const router = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);',
	"process.stdout.write(JSON.stringify(router.rank(request)));",
].join("\n");

/**
 * A router built from cli/src/router-worker.ts, run in a child process under Node's
 * permission model: it can't read or write any file or start processes, and none of the
 * judge's code runs in its process. It gets skill texts and tasks, never labels. Every
 * answer is checked before a gate sees it, and the judge times the whole process, so a
 * router can't report itself fast.
 */
export function processRanker(file: string): Ranker {
	const source = readFileSync(file, "utf8");
	return (skills, tasks, rounds) => {
		const permission = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
		const started = performance.now();
		const r = spawnSync(process.execPath, [permission, "--input-type=module", "-e", ROUTER_LOADER], {
			input: JSON.stringify({ source, request: { skills, tasks, rounds } }),
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			timeout: 300_000,
			env: { PATH: process.env.PATH ?? "" },
		});
		const wallMs = performance.now() - started;
		const lines = (r.stderr || String(r.error ?? "")).trim().split("\n");
		const why = (lines.find((l) => /\bERR_[A-Z_]+|Error\b/.test(l)) ?? lines[0] ?? "").trim();
		if (r.status !== 0) throw new EvalError(`The router process failed (exit ${r.status ?? r.signal}): ${why || "no output"}`);
		let reply: { buildMs?: unknown; top?: unknown; timesMs?: unknown };
		try {
			reply = JSON.parse(r.stdout);
		} catch {
			throw new EvalError("The router process didn't answer with JSON.");
		}
		const names = new Set([...skills.map((s) => s.name), "none"]);
		const top = reply.top;
		const times = reply.timesMs;
		if (!Array.isArray(top) || top.length !== tasks.length || !top.every((n) => typeof n === "string" && names.has(n))) {
			throw new EvalError("The router process answered with the wrong number of rankings, or named a skill that doesn't exist.");
		}
		const matches = tasks.length * Math.max(1, rounds);
		if (!Array.isArray(times) || times.length !== matches || !times.every((t) => typeof t === "number" && Number.isFinite(t) && t >= 0) || typeof reply.buildMs !== "number") {
			throw new EvalError(`The router process answered without one valid timing per match (${matches} expected).`);
		}
		return { buildMs: reply.buildMs, top: top as string[], timesMs: times as number[], wallPerMatchMs: matches ? wallMs / matches : 0 };
	};
}

export const TOP1_MIN = 0.9;
export const FALSE_INVOKE_MAX = 0.05;
export const MIN_CASES = 8;
export const P95_MAX_MS = 10;
export const HELDOUT_TOP1_MIN = 0.8;
export const HELDOUT_FALSE_INVOKE_MAX = 0.1;
/** baseline.json keeps four decimals; a difference this small (in points) is rounding. */
const ROUNDING = 0.01;
/** Every case is matched this many times for the latency figures. */
const ROUNDS = 5;

/** Each threshold, and which way is stricter: a pull request may only move it that way. */
export const THRESHOLDS = {
	TOP1_MIN: { value: TOP1_MIN, stricter: "higher" },
	FALSE_INVOKE_MAX: { value: FALSE_INVOKE_MAX, stricter: "lower" },
	MIN_CASES: { value: MIN_CASES, stricter: "higher" },
	P95_MAX_MS: { value: P95_MAX_MS, stricter: "lower" },
	HELDOUT_TOP1_MIN: { value: HELDOUT_TOP1_MIN, stricter: "higher" },
	HELDOUT_FALSE_INVOKE_MAX: { value: HELDOUT_FALSE_INVOKE_MAX, stricter: "lower" },
} as const;

export interface EvalCase {
	task: string;
	skill: string;
	line: number;
}

export interface Baseline {
	/** Accuracy per skill, a finite number from 0 to 1. "none" is the share of none cases routed to no skill. */
	accuracy: Record<string, number>;
}

export interface Gate {
	gate: string;
	ok: boolean;
	detail: string;
}

interface SetScore {
	cases: number;
	positives: number;
	negatives: number;
	top1: number;
	falseInvoke: number;
	misses: Array<{ task: string; expected: string; got: string }>;
}

export interface EvalReport {
	ok: boolean;
	skills: number;
	cases: number;
	positives: number;
	negatives: number;
	top1: number;
	falseInvoke: number;
	perSkill: Record<string, { cases: number; correct: number; accuracy: number; baseline?: number }>;
	misses: Array<{ task: string; expected: string; got: string }>;
	/** Cases naming a skill the catalog doesn't have; skipped. */
	skipped: Array<{ line: number; skill: string }>;
	/** The held-out cases: never used to tune the scorer. */
	heldout?: SetScore;
	speed: { buildMs: number; p50Ms: number; p95Ms: number; maxMs: number; matches: number };
	thresholds: Record<keyof typeof THRESHOLDS, number>;
	gates: Gate[];
}

export class EvalError extends Error {}

/** Parse JSONL cases; a malformed line is an error with its line number, blank lines are skipped. */
export function parseCases(text: string, file = "router-cases.jsonl"): EvalCase[] {
	const out: EvalCase[] = [];
	text.split("\n").forEach((raw, i) => {
		if (raw.trim() === "") return;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new EvalError(`${file} line ${i + 1} is not JSON.`);
		}
		const c = value as { task?: unknown; skill?: unknown };
		if (typeof c.task !== "string" || !c.task.trim() || typeof c.skill !== "string" || !/^(none|[a-z0-9]+(-[a-z0-9]+)*)$/.test(c.skill)) {
			throw new EvalError(`${file} line ${i + 1} needs {"task": "...", "skill": "<name>|none"}.`);
		}
		out.push({ task: c.task, skill: c.skill, line: i + 1 });
	});
	return out;
}

/** Only finite values from 0 to 1 count; anything else is as if the skill had no baseline. */
export function parseBaseline(text: string): Baseline {
	let data: { accuracy?: Record<string, unknown> };
	try {
		data = JSON.parse(text) as { accuracy?: Record<string, unknown> };
	} catch {
		throw new EvalError("baseline.json is not JSON.");
	}
	const accuracy: Record<string, number> = {};
	for (const [name, value] of Object.entries(data.accuracy ?? {})) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) accuracy[name] = value;
	}
	return { accuracy };
}

export function formatBaseline(report: EvalReport): string {
	const accuracy = Object.fromEntries(
		Object.entries(report.perSkill)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, s]) => [name, Math.round(s.accuracy * 10000) / 10000]),
	);
	return `${JSON.stringify({ accuracy }, null, "\t")}\n`;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Top-1 and false invokes of `usable` cases, given the router's answer for each. */
function scoreSet(answers: string[], usable: EvalCase[]): SetScore {
	const misses: SetScore["misses"] = [];
	let correct = 0;
	let falseInvokes = 0;
	for (const [i, c] of usable.entries()) {
		const got = answers[i];
		if (got === c.skill) {
			if (c.skill !== "none") correct++;
		} else {
			if (c.skill === "none") falseInvokes++;
			misses.push({ task: c.task, expected: c.skill, got });
		}
	}
	const negatives = usable.filter((c) => c.skill === "none").length;
	const positives = usable.length - negatives;
	return { cases: usable.length, positives, negatives, top1: positives ? round(correct / positives, 4) : 0, falseInvoke: negatives ? round(falseInvokes / negatives, 4) : 0, misses };
}

export interface EvalOptions {
	/** Skills that must have cases and a baseline; default every skill indexed. */
	covered?: ReadonlySet<string>;
	/**
	 * Points a skill may measure below its baseline; default 0: a committed baseline can't
	 * claim more than the router delivers, so every later comparison is like with like.
	 */
	tolerance?: number;
	/**
	 * Accepted drops: each skill's floor, held with no tolerance. The skill's accuracy must
	 * reach it, whatever the baseline and tolerance say.
	 */
	floors?: ReadonlyMap<string, number>;
	/** Check the none cases' baseline too; default true. */
	checkNone?: boolean;
	/** Who ranks the tasks; default the router in this process. */
	ranker?: Ranker;
}

/** Run every case through a fresh index of `skills` and check each gate. */
export function runEval(skills: RouterSkill[], cases: EvalCase[], baseline?: Baseline, heldout?: EvalCase[], options: EvalOptions = {}): EvalReport {
	const names = new Set(skills.map((s) => s.name));
	const known = (c: EvalCase) => c.skill === "none" || names.has(c.skill);
	const usable = cases.filter(known);
	const heldUsable = heldout?.filter(known) ?? [];
	const skipped = cases.filter((c) => !known(c)).map((c) => ({ line: c.line, skill: c.skill }));
	// One call ranks every task, held-out included; the gates below work only from the answers.
	const ranked = (options.ranker ?? inProcessRanker)(skills, [...usable, ...heldUsable].map((c) => c.task), ROUNDS);
	const answers = ranked.top.slice(0, usable.length);
	const buildMs = ranked.buildMs;
	const times = [...ranked.timesMs];

	const perSkill: EvalReport["perSkill"] = {};
	for (const name of [...names, "none"]) perSkill[name] = { cases: 0, correct: 0, accuracy: 0 };
	const misses: EvalReport["misses"] = [];
	for (const [i, c] of usable.entries()) {
		const got = answers[i];
		const entry = perSkill[c.skill];
		entry.cases++;
		if (got === c.skill) entry.correct++;
		else misses.push({ task: c.task, expected: c.skill, got });
	}
	for (const [name, entry] of Object.entries(perSkill)) {
		entry.accuracy = entry.cases ? entry.correct / entry.cases : 0;
		const base = baseline?.accuracy[name];
		if (base !== undefined) entry.baseline = base;
	}
	times.sort((a, b) => a - b);

	const positive = Object.entries(perSkill).filter(([name]) => name !== "none");
	const positives = positive.reduce((n, [, s]) => n + s.cases, 0);
	const top1 = positives ? positive.reduce((n, [, s]) => n + s.correct, 0) / positives : 0;
	const none = perSkill.none;
	const falseInvoke = none.cases ? 1 - none.accuracy : 0;
	// A router process's own timings are checked against the judge's clock: p95 is at least
	// the wall-clock time per match, so a router can't report itself fast.
	const p95 = Math.max(percentile(times, 0.95), ranked.wallPerMatchMs ?? 0);
	const speed = { buildMs: round(buildMs), p50Ms: round(percentile(times, 0.5), 4), p95Ms: round(p95, 4), maxMs: round(times.at(-1) ?? 0, 4), matches: times.length };
	const held = heldout ? scoreSet(ranked.top.slice(usable.length), heldUsable) : undefined;

	const covered = options.covered ?? names;
	const checked = (name: string) => (name === "none" ? options.checkNone !== false : covered.has(name));
	const tolerance = options.tolerance ?? 0;
	const tooFew = [...names].filter((n) => covered.has(n) && perSkill[n].cases < MIN_CASES);
	const regressions = Object.entries(perSkill).filter(([name, s]) => checked(name) && s.baseline !== undefined && s.cases > 0 && (s.baseline - s.accuracy) * 100 > tolerance + ROUNDING);
	const underFloor = Object.entries(perSkill).filter(([name, s]) => {
		const floor = options.floors?.get(name);
		return floor !== undefined && s.cases > 0 && (floor - s.accuracy) * 100 > ROUNDING;
	});
	const unbased = baseline ? [...names, "none"].filter((n) => checked(n) && baseline.accuracy[n] === undefined) : [];
	const gates: Gate[] = [
		{ gate: "top-1 accuracy", ok: positives > 0 && top1 >= TOP1_MIN, detail: `${pct(top1)} over ${positives} cases (needs ${pct(TOP1_MIN)})` },
		{ gate: "false invokes", ok: none.cases > 0 && falseInvoke <= FALSE_INVOKE_MAX, detail: `${pct(falseInvoke)} of ${none.cases} none cases (allows ${pct(FALSE_INVOKE_MAX)})` },
		{ gate: "cases per skill", ok: tooFew.length === 0, detail: tooFew.length ? `under ${MIN_CASES}: ${tooFew.map((n) => `${n} (${perSkill[n].cases})`).join(", ")}` : `every skill has ${MIN_CASES} or more` },
		{ gate: "p95 latency", ok: speed.p95Ms < P95_MAX_MS, detail: `${speed.p95Ms} ms per match (under ${P95_MAX_MS} ms); index build ${speed.buildMs} ms` },
		{
			gate: "baseline",
			ok: baseline !== undefined && unbased.length === 0 && regressions.length === 0 && underFloor.length === 0,
			detail: !baseline
				? "no baseline.json; run tabkyra skill eval --update-baseline and commit it"
				: unbased.length
					? `no valid baseline (a number from 0 to 1) for ${unbased.join(", ")}; run tabkyra skill eval --update-baseline and commit it`
					: regressions.length || underFloor.length
						? [
								regressions.length ? `${tolerance ? `dropped more than ${tolerance} points` : "the baseline claims more than the router measures"}: ${regressions.map(([n, s]) => `${n} ${pct(s.accuracy)} (baseline ${pct(s.baseline ?? 0)})`).join(", ")}` : "",
								underFloor.length ? `below the accepted drop: ${underFloor.map(([n, s]) => `${n} ${pct(s.accuracy)} (accepted ${pct(options.floors?.get(n) ?? 0)})`).join(", ")}` : "",
							]
								.filter(Boolean)
								.join("; ")
						: tolerance
							? `no skill more than ${tolerance} points below its baseline`
							: "every skill measures at least its baseline",
		},
		{
			gate: "held-out top-1",
			ok: held !== undefined && held.positives > 0 && held.top1 >= HELDOUT_TOP1_MIN,
			detail: held ? `${pct(held.top1)} over ${held.positives} held-out cases (needs ${pct(HELDOUT_TOP1_MIN)})` : "no router-heldout.jsonl next to the cases",
		},
		{
			gate: "held-out none",
			ok: held !== undefined && held.negatives > 0 && held.falseInvoke <= HELDOUT_FALSE_INVOKE_MAX,
			detail: held ? `${pct(held.falseInvoke)} false invokes of ${held.negatives} held-out none cases (allows ${pct(HELDOUT_FALSE_INVOKE_MAX)})` : "no router-heldout.jsonl next to the cases",
		},
	];
	return {
		ok: gates.every((g) => g.ok),
		skills: names.size,
		cases: usable.length,
		positives,
		negatives: none.cases,
		top1: round(top1, 4),
		falseInvoke: round(falseInvoke, 4),
		perSkill,
		misses,
		skipped,
		heldout: held,
		speed,
		thresholds: Object.fromEntries(Object.entries(THRESHOLDS).map(([k, t]) => [k, t.value])) as EvalReport["thresholds"],
		gates,
	};
}

/** The threshold constants a skill-eval.ts source declares, by name. */
export function thresholdsIn(source: string): Partial<Record<keyof typeof THRESHOLDS, number>> {
	const out: Partial<Record<keyof typeof THRESHOLDS, number>> = {};
	for (const name of Object.keys(THRESHOLDS) as Array<keyof typeof THRESHOLDS>) {
		const m = new RegExp(`^export const ${name} = ([0-9][0-9_.]*);$`, "m").exec(source);
		if (m) out[name] = Number(m[1].replace(/_/g, ""));
	}
	return out;
}

export interface BaseFiles {
	cases?: string;
	heldout?: string;
	baseline?: string;
	/** skills-eval/accepted-drops.json. */
	drops?: string;
}

export interface AcceptedDrop {
	skill: string;
	/** The new, lower baseline value the pull request accepts. */
	value: number;
	reason: string;
}

/** Parse accepted-drops.json: `{"drops": [{"skill", "value", "reason"}]}`. */
export function parseDrops(text: string | undefined): AcceptedDrop[] {
	if (text === undefined) return [];
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new EvalError("accepted-drops.json is not JSON.");
	}
	const drops = (data as { drops?: unknown }).drops;
	if (!Array.isArray(drops)) throw new EvalError('accepted-drops.json needs {"drops": [...]}.');
	return drops.map((d, i) => {
		const e = d as Partial<AcceptedDrop>;
		const ok =
			typeof e.skill === "string" &&
			/^(none|[a-z0-9]+(-[a-z0-9]+)*)$/.test(e.skill) &&
			typeof e.value === "number" &&
			Number.isFinite(e.value) &&
			e.value >= 0 &&
			e.value <= 1 &&
			typeof e.reason === "string" &&
			e.reason.trim().length > 0;
		if (!ok) throw new EvalError(`accepted-drops.json entry ${i + 1} needs {"skill": "<name>|none", "value": 0..1, "reason": "..."}.`);
		return { skill: e.skill as string, value: e.value as number, reason: (e.reason as string).trim() };
	});
}

/** The `removed` list of accepted-drops.json: skills a pull request deletes on purpose, each with a reason. */
export function parseRemoved(text: string | undefined): Array<{ skill: string; reason: string }> {
	if (text === undefined) return [];
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new EvalError("accepted-drops.json is not JSON.");
	}
	const removed = (data as { removed?: unknown }).removed ?? [];
	if (!Array.isArray(removed)) throw new EvalError('accepted-drops.json "removed" must be a list.');
	return removed.map((r, i) => {
		const e = r as { skill?: unknown; reason?: unknown };
		if (typeof e.skill !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.skill) || typeof e.reason !== "string" || !e.reason.trim()) {
			throw new EvalError(`accepted-drops.json removed entry ${i + 1} needs {"skill": "<name>", "reason": "..."}.`);
		}
		return { skill: e.skill, reason: e.reason.trim() };
	});
}

/**
 * Checks a pull request against its base branch, run by the base branch's build with the
 * pull request's skills bundled. `head` is the pull request's files and its skill-eval.ts
 * source; `base` is the base branch's files. The running code's thresholds are the base's.
 * Drops are accepted only from entries the pull request added to accepted-drops.json.
 */
export function runBaseCheck(
	skills: RouterSkill[],
	head: BaseFiles & { evalSource?: string },
	base: BaseFiles,
	ranker?: Ranker,
): { ok: boolean; skills: number; gates: Gate[]; report?: EvalReport } {
	const gates: Gate[] = [];
	const key = (c: EvalCase) => `${c.skill}\u0000${c.task}`;
	const missing: string[] = [];
	for (const [label, baseText, headText] of [
		["router-cases.jsonl", base.cases, head.cases],
		["router-heldout.jsonl", base.heldout, head.heldout],
	] as const) {
		if (baseText === undefined) continue;
		const kept = new Set(parseCases(headText ?? "", label).map(key));
		for (const c of parseCases(baseText, label)) if (!kept.has(key(c))) missing.push(`${label}: ${JSON.stringify(c.task)} (${c.skill})`);
	}
	gates.push({ gate: "base cases kept", ok: missing.length === 0, detail: missing.length ? `removed or relabeled: ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? `; and ${missing.length - 5} more` : ""}` : "every base case is still there" });

	const names = new Set(skills.map((s) => s.name));
	const baseBaseline = base.baseline === undefined ? undefined : parseBaseline(base.baseline);
	// A skill the base measures must still exist, or be listed as removed on purpose: deleting
	// a folder would otherwise erase its cases' coverage without a trace.
	const removedOk = new Set(parseRemoved(head.drops).map((r) => r.skill));
	const gone = Object.keys(baseBaseline?.accuracy ?? {}).filter((n) => n !== "none" && !names.has(n));
	const unexplained = gone.filter((n) => !removedOk.has(n));
	gates.push({
		gate: "skills kept",
		ok: unexplained.length === 0,
		detail: unexplained.length
			? `missing from skills/ without a "removed" entry in accepted-drops.json: ${unexplained.join(", ")}`
			: gone.length
				? `removed on purpose: ${gone.join(", ")}`
				: "every skill the base measures is still there",
	});
	const headBaseline = head.baseline === undefined ? { accuracy: {} } : parseBaseline(head.baseline);
	const old = new Set(parseDrops(base.drops).map((d) => `${d.skill}\u0000${d.value}`));
	const added = parseDrops(head.drops).filter((d) => !old.has(`${d.skill}\u0000${d.value}`));
	const close = (a: number, b: number) => Math.abs(a - b) < 1e-4;
	// An added entry is valid only for a skill that exists, at its new baseline value, below the base's.
	const invalid = added.flatMap((d) => {
		const problems: string[] = [];
		if (d.skill !== "none" && !names.has(d.skill)) problems.push("no such skill");
		const now = headBaseline.accuracy[d.skill];
		if (now === undefined || !close(now, d.value)) problems.push(`baseline.json has ${now === undefined ? "no value" : pct(now)}`);
		const was = baseBaseline?.accuracy[d.skill];
		if (was === undefined || d.value >= was - 1e-9) problems.push(was === undefined ? "the base branch has no baseline for it" : `not below the base branch's ${pct(was)}`);
		return problems.length ? [`${d.skill} ${pct(d.value)}: ${problems.join(", ")}`] : [];
	});
	gates.push({ gate: "accepted drops", ok: invalid.length === 0, detail: invalid.length ? `invalid entries: ${invalid.join("; ")}` : added.length ? `${added.length} added, each a skill's new baseline below the base` : "none added" });
	const acceptedValue = new Map(added.filter((d) => !invalid.some((i) => i.startsWith(`${d.skill} `))).map((d) => [d.skill, d.value]));
	const lowered = Object.entries(baseBaseline?.accuracy ?? {})
		.filter(([name]) => name === "none" || names.has(name))
		.filter(([name, value]) => {
			const now = headBaseline.accuracy[name];
			if (now === undefined) return true;
			if ((value - now) * 100 <= ROUNDING) return false;
			const accepted = acceptedValue.get(name);
			return accepted === undefined || !close(accepted, now);
		})
		.map(([name, value]) => `${name} ${headBaseline.accuracy[name] === undefined ? "missing" : pct(headBaseline.accuracy[name])} (base ${pct(value)})`);
	gates.push({
		gate: "base baseline",
		ok: lowered.length === 0,
		detail: lowered.length
			? `lower than the base branch without an entry in accepted-drops.json for the new value: ${lowered.join(", ")}`
			: `no skill below the base branch's baseline${added.length ? ` except accepted drops: ${added.map((d) => `${d.skill} ${pct(d.value)} (${d.reason})`).join("; ")}` : ""}`,
	});

	const declared = thresholdsIn(head.evalSource ?? "");
	const looser = (Object.entries(THRESHOLDS) as Array<[keyof typeof THRESHOLDS, (typeof THRESHOLDS)[keyof typeof THRESHOLDS]]>)
		.filter(([name, t]) => {
			const v = declared[name];
			return v === undefined || (t.stricter === "higher" ? v < t.value : v > t.value);
		})
		.map(([name, t]) => `${name} ${declared[name] ?? "missing"} (base ${t.value})`);
	gates.push({ gate: "base thresholds", ok: looser.length === 0, detail: looser.length ? `looser than the base branch: ${looser.join(", ")}` : "no threshold looser than the base branch's" });

	// The pull request's skills (new ones indexed too), the base branch's code, cases and
	// baseline. Skills the base knows must route the base cases at least as well as the base
	// baseline says, or, for an accepted drop, as well as the accepted value.
	let report: EvalReport | undefined;
	const known = new Set([...names].filter((n) => baseBaseline?.accuracy[n] !== undefined));
	if (base.cases !== undefined) {
		const floorBaseline = baseBaseline && { accuracy: Object.fromEntries(Object.entries(baseBaseline.accuracy).filter(([n]) => !acceptedValue.has(n))) };
		report = runEval(skills, parseCases(base.cases), floorBaseline, base.heldout === undefined ? undefined : parseCases(base.heldout, "router-heldout.jsonl"), {
			covered: new Set([...known].filter((n) => !acceptedValue.has(n))),
			floors: acceptedValue,
			// An accepted drop for none replaces its baseline with the floor; false invokes stay gated.
			checkNone: !acceptedValue.has("none"),
			ranker,
		});
		const failed = report.gates.filter((g) => !g.ok && !(g.gate.startsWith("held-out") && base.heldout === undefined));
		gates.push({
			gate: "base-code eval",
			ok: failed.length === 0,
			detail: failed.length ? failed.map((g) => `${g.gate}: ${g.detail}`).join("; ") : `top-1 ${pct(report.top1)}, false invokes ${pct(report.falseInvoke)} on the base cases, ${names.size} skills indexed`,
		});
	}
	// The base code's gates and thresholds over the pull request's whole case files and its
	// baseline, accepted floors included: every skill and none must measure at least what the
	// pull request's baseline claims, skills it adds included, and have enough cases.
	if (head.cases !== undefined && base.cases !== undefined) {
		const floors = new Map(parseDrops(head.drops).map((d) => [d.skill, d.value]));
		const all = runEval(skills, parseCases(head.cases), headBaseline, head.heldout === undefined ? undefined : parseCases(head.heldout, "router-heldout.jsonl"), { floors, ranker });
		const failed = all.gates.filter((g) => !g.ok);
		gates.push({
			gate: "base-code full eval",
			ok: failed.length === 0,
			detail: failed.length ? failed.map((g) => `${g.gate}: ${g.detail}`).join("; ") : `top-1 ${pct(all.top1)}, false invokes ${pct(all.falseInvoke)} on all ${all.cases} cases of the pull request, and its baseline holds`,
		});
	}
	return { ok: gates.every((g) => g.ok), skills: names.size, gates, report };
}
