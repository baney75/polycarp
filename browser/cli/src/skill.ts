/**
 * `tabkyra skill install|list|print|lint|apply|revert|match|eval|versions|rollback|edit`:
 * teach agents to use Tabkyra well.
 * The skill texts live in skills/<name>/SKILL.md and are bundled into the CLI at build time
 * (skills-catalog.ts), so every harness gets the same words the tests check. The tabkyra
 * skill is tested against the MCP server's instructions (cli/test/skill.test.mjs); every
 * skill passes the lint in skill-lint.ts before it ships, installs or is applied. The router
 * (skill-router.ts) picks the skill for a task; docs/skill-platform.md describes the whole.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { which } from "./harness.ts";
import {
	type ActiveSkill,
	activeCommunity,
	buildCatalog,
	CatalogError,
	communityKey,
	loadCatalog,
	readCommunityCases,
	readCommunityFolder,
	readState,
	removalReason,
	setDisabled,
	setEnabled,
	type SyncResult,
	syncCatalog,
} from "./community-catalog.ts";
import { type EvalCase, EvalError, type EvalReport, formatBaseline, type Gate, inProcessRanker, parseBaseline, parseCases, parseDrops, processRanker, type Ranker, runBaseCheck, runEval } from "./skill-eval.ts";
import { lintCommunity, namesSite, parseSites, scanPersonal } from "./skill-community.ts";
import { type Finding, formatFindings, lintPath, lintText, parseFrontmatter } from "./skill-lint.ts";
import { buildRouterIndex, matchSkills, oneLine, type RouterIndex, type RouterSkill, type SkillMatch } from "./skill-router.ts";
import { SKILLS } from "./skills-catalog.ts";
import { banner, c, sym } from "./ui.ts";

/** Written under the frontmatter, so a later install knows the file is ours to replace. */
const MARKER = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A usable skill name: "none" is reserved for the router's "no skill fits". */
const isName = (n: string) => NAME.test(n) && n !== "none";
/** The skills that govern skill editing change only through a reviewed pull request. */
const PROTECTED_SKILLS = new Set(["rsi", "kyraskillmaker"]);

export class SkillError extends Error {}

/** The community skills in use (community-catalog.ts): verified, on, and not a built-in name. */
export function communitySkills(): Map<string, ActiveSkill> {
	return activeCommunity(new Set(SKILLS.keys()));
}

/** The text a local copy of `name` is based on: the built-in skill, else the community skill. */
function baseText(name: string): string | undefined {
	return SKILLS.get(name) ?? communitySkills().get(name)?.text;
}

/**
 * Why a local copy made from a community skill is off, if it is. It is used only while the
 * community skill it was made from is in use: in the verified catalog, community skills on, not
 * removed by the user. So a pulled skill can't come back through a local copy, however long ago
 * it was pulled, and a missing or refused catalog turns such copies off too. The file is kept.
 */
function communityBaseProblem(name: string): string | undefined {
	if (readIndex()[name]?.base !== "community" || SKILLS.has(name) || communitySkills().has(name)) return undefined;
	if (!readState().enabled) return "community skills are off";
	const reason = removalReason(name);
	if (reason) return reason;
	const { problem } = loadCatalog();
	return problem ? `the community catalog isn't in use (${problem})` : `the community skill ${name} it was made from is not in the verified community catalog`;
}

/** Every name reaches a path, so every name is checked first: no "..", no slashes. */
export function assertName(name: string): string {
	if (!NAME.test(name) || name.length > 64) throw new SkillError(`"${name}" is not a skill name (lowercase-kebab-case).`);
	if (name === "none") throw new SkillError('"none" is reserved: the router answers "none" when no skill fits.');
	return name;
}

export interface SkillTarget {
	id: string;
	name: string;
	detected: boolean;
	/** The harness's skills folder; each skill goes in <dir>/<skill>/SKILL.md. */
	dir: string;
	/** Where the tabkyra skill goes, kept for callers that name one file. */
	file: string;
}

export function skillTargets(): SkillTarget[] {
	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const codexHome = process.env.CODEX_HOME || join(home, ".codex");
	const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	const target = (id: string, name: string, detected: boolean, dir: string): SkillTarget => ({
		id,
		name,
		detected,
		dir,
		file: join(dir, "tabkyra", "SKILL.md"),
	});
	return [
		target("claude", "Claude Code", Boolean(which("claude")) || existsSync(claudeHome), join(claudeHome, "skills")),
		target("codex", "Codex", Boolean(which("codex")) || existsSync(codexHome), join(codexHome, "skills")),
		target("opencode", "OpenCode", Boolean(which("opencode")) || existsSync(join(configHome, "opencode")), join(configHome, "opencode", "skills")),
	];
}

// --- Local edits (overlays) ----------------------------------------------------------------
//
// `tabkyra skill apply` (used by the rsi skill) keeps the user's edited copy of a skill in
// ~/.config/tabkyra/skills-local/<name>/SKILL.md and records it in index.json with the
// bundled text it was based on. A local copy is used only when the index records it, it
// passes lint, it isn't a protected skill, and it keeps every section of the bundled text;
// otherwise install falls back to the bundled skill and says why. Install also says when
// the bundled skill changed underneath an edit, so updates are never silently lost.

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

export function localSkillsDir(): string {
	return join(configDir(), "skills-local");
}

function historyDir(): string {
	return join(configDir(), "skill-history");
}

interface LocalIndex {
	/**
	 * `budget`: applied by a version that enforces the size budget (skill-lint.ts). An edit
	 * applied before then is still used when it's over budget, with a warning; new applies
	 * must fit.
	 */
	[name: string]: { baseSha256: string | null; appliedAt: string; budget?: boolean; base?: "bundled" | "community" };
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function readIndex(): LocalIndex {
	const file = join(localSkillsDir(), "index.json");
	if (!existsSync(file)) return {};
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as LocalIndex;
		return Object.fromEntries(Object.entries(data).filter(([name]) => isName(name)));
	} catch {
		return {};
	}
}

function indexFile(): string {
	return join(localSkillsDir(), "index.json");
}

function writeIndex(index: LocalIndex): void {
	assertNoLinks([configDir(), localSkillsDir(), indexFile()]);
	mkdirSync(localSkillsDir(), { recursive: true });
	// Temp file + rename replaces the path itself, never a file a link points at.
	const tmp = `${indexFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(index, null, "\t")}\n`, { flag: "wx" });
	renameSync(tmp, indexFile());
}

/** The folder for one local skill, proven to sit directly inside skills-local. */
function localSkillDir(name: string): string {
	const root = resolve(localSkillsDir());
	const dir = resolve(root, assertName(name));
	if (relative(root, dir) !== name) throw new SkillError(`${name} resolves outside ${root}.`);
	return dir;
}

function localFile(name: string): string {
	return join(localSkillDir(name), "SKILL.md");
}

/** Sections by `## ` heading, ignoring headings inside code fences. */
function sections(text: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let current: string[] | undefined;
	let fence = "";
	for (const line of text.split("\n")) {
		const mark = /^ {0,3}(```+|~~~+)/.exec(line)?.[1];
		if (mark && !fence) fence = mark;
		else if (mark && fence && mark[0] === fence[0] && mark.length >= fence.length) fence = "";
		const heading = !fence && !mark ? /^## (.+)$/.exec(line)?.[1]?.trim() : undefined;
		if (heading !== undefined) {
			current = [];
			out.set(heading, current);
		} else current?.push(line);
	}
	return out;
}

const headings = (t: string) => [...sections(t).keys()];

/** Sections whose every line an edit must keep: safety rules, stop conditions, purpose checks. */
const PROTECTED_SECTION = /safety|rules|done when|ethics|purpose check|limits|never/i;

/**
 * Protected sections a draft changed in any way. They are read-only to `skill apply`: an
 * added line can cancel a rule as surely as a removed one, so these change only through a
 * reviewed pull request.
 */
function changedProtectedSections(current: string, draft: string): string[] {
	const before = sections(current);
	const after = sections(draft);
	const norm = (lines: string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter(Boolean).join("\n");
	return [...before.keys()].filter((h) => PROTECTED_SECTION.test(h) && norm(before.get(h)) !== norm(after.get(h)));
}

/** Why a local copy can't be used, or its text. */
function localText(name: string): { text?: string; problem?: string; overBudget?: boolean } {
	const file = localFile(name);
	if (!existsSync(file) && !isLink(file)) return {};
	if (!readIndex()[name]) return { problem: `${file} wasn't added with tabkyra skill apply` };
	if (PROTECTED_SKILLS.has(name)) return { problem: `${name} changes only through a reviewed pull request` };
	const off = communityBaseProblem(name);
	if (off) return { problem: `${off}, so your copy based on it is off too (the file is kept)` };
	if (isLink(file) || isLink(dirname(file))) return { problem: `${file} is a symlink` };
	if (!lstatSync(file).isFile()) return { problem: `${file} is not a file` };
	const text = readFileSync(file, "utf8");
	const all = lintText(file, text, { dirName: name }).filter((f) => f.severity === "error");
	// The budget came after some edits were applied: those stay in use, with a warning.
	const grandfathered = readIndex()[name]?.budget !== true;
	const overBudget = all.some((f) => f.rule === "budget");
	const errors = grandfathered ? all.filter((f) => f.rule !== "budget") : all;
	if (errors.length) return { problem: `${file} fails lint (${errors[0].rule})` };
	const bundled = baseText(name);
	const missing = bundled === undefined ? [] : headings(bundled).filter((h) => !headings(text).includes(h));
	if (missing.length) return { problem: `${file} drops the section "${missing[0]}"` };
	const added = bundled === undefined ? [] : headings(text).filter((h) => !headings(bundled).includes(h));
	if (added.length) return { problem: `${file} adds the section "${added[0]}"` };
	const changed = bundled === undefined ? [] : changedProtectedSections(bundled, text);
	if (changed.length) return { problem: `${file} changes the protected section "${changed[0]}"` };
	return { text, overBudget: overBudget && grandfathered };
}

/** Refuse to touch anything under a symbolic link: a link could lead outside Tabkyra's folders. */
function assertNoLinks(paths: string[]): void {
	for (const p of paths) if (isLink(p)) throw new SkillError(`${p} is a symbolic link; Tabkyra won't read or write through it. Remove it by hand.`);
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Local skill folders that index.json records, valid names only. */
function localNames(): string[] {
	if (!existsSync(localSkillsDir())) return [];
	const index = readIndex();
	return readdirSync(localSkillsDir()).filter((n) => isName(n) && index[n] && existsSync(join(localSkillsDir(), n, "SKILL.md")));
}

/** Bundled skills, community skills in use, plus local-only skills whose copy is usable. */
function allNames(): string[] {
	const community = communitySkills();
	const usableLocal = localNames().filter((n) => SKILLS.has(n) || community.has(n) || localText(n).text !== undefined);
	return [...new Set([...SKILLS.keys(), ...community.keys(), ...usableLocal])];
}

/** What `skill install` with no names installs: everything in use except community skills nobody asked for. */
function defaultInstallNames(): string[] {
	const community = communitySkills();
	return allNames().filter((n) => !community.has(n) || localText(n).text !== undefined);
}

function skillText(name: string): string {
	const local = localText(name);
	if (local.text !== undefined) return local.text;
	const text = baseText(name);
	if (text === undefined) throw new SkillError(`No skill named ${name}.${gone(name)} Run tabkyra skill list.`);
	return text;
}

/** " It was removed: <why>." for a community skill that is gone, else "". */
function gone(name: string): string {
	const why = removalReason(name);
	return why ? ` It was removed: ${why}.` : "";
}

/** Warnings for local edits: unusable, or based on an older bundled version. */
function localWarnings(): string[] {
	const index = readIndex();
	const names = existsSync(localSkillsDir()) ? readdirSync(localSkillsDir()).filter((n) => isName(n)) : [];
	const warnings: string[] = [];
	for (const name of names) {
		const local = localText(name);
		if (local.problem) warnings.push(`Your local copy of ${name} is not used: ${local.problem}. Fix it, re-apply it, or run tabkyra skill revert ${name}.`);
		if (local.overBudget) {
			warnings.push(
				`Your local copy of ${name} (${localFile(name)}) is over the skill budget (lint rule "budget": 150 lines and 8,000 characters). It was applied before the budget, so it is still used; trim it and apply it again, since a new apply must fit.`,
			);
		}
		const bundled = baseText(name);
		const base = index[name]?.baseSha256;
		const kind = SKILLS.has(name) ? "bundled" : "community";
		if (local.text !== undefined && bundled !== undefined && base && base !== sha256(bundled)) {
			warnings.push(`The ${kind} ${name} skill changed since your edit; your local copy is kept and still used. Compare tabkyra skill print ${name} --raw with the ${kind} text, then re-apply or revert.`);
		} else if (local.text !== undefined && kind === "community" && bundled !== undefined) {
			warnings.push(`Your local copy of ${name} overrides the community skill; community updates to it are not applied (tabkyra skill revert ${name} goes back to the community version).`);
		}
	}
	return warnings;
}

// --- Provenance ----------------------------------------------------------------------------

export interface SkillInfo {
	name: string;
	description: string;
	version: string;
	/** Where the text in use comes from. */
	source: "bundled" | "community" | "local";
	/** One line for people: "built-in", "community, catalog 42", "local", "local edit of the built-in skill". */
	provenance: string;
	/** The catalog serial, for a community skill or a local copy of one. */
	catalog?: number;
	/** What a local copy overrides. */
	overrides?: "bundled" | "community";
	/** The sites a community skill is scoped to. */
	sites?: string[];
}

export function skillInfo(name: string): SkillInfo {
	const text = skillText(name);
	const local = localText(name).text !== undefined;
	const community = communitySkills().get(name);
	const description = /^description: (.*)$/m.exec(text)?.[1] ?? "";
	const base = { name, description, version: skillVersion(text) };
	if (!local && SKILLS.has(name)) return { ...base, source: "bundled", provenance: "built-in" };
	if (!local && community) return { ...base, source: "community", provenance: `community, catalog ${community.serial}`, catalog: community.serial, sites: community.sites };
	if (SKILLS.has(name)) return { ...base, source: "local", provenance: "local edit of the built-in skill", overrides: "bundled" };
	if (community) {
		return { ...base, source: "local", provenance: `local override of the community skill (catalog ${community.serial}, version ${community.version})`, overrides: "community", catalog: community.serial, sites: community.sites };
	}
	const sites = sitesOf(text);
	return { ...base, source: "local", provenance: "local", ...(sites.length ? { sites } : {}) };
}

export function listSkills(): SkillInfo[] {
	return allNames().map(skillInfo);
}

// --- Rendering ---------------------------------------------------------------------------

/** SKILL.md as installed: the text with the marker after the frontmatter. */
export function skillFile(name = "tabkyra"): string {
	const text = skillText(name);
	const end = text.indexOf("\n---\n", 4);
	if (!text.startsWith("---\n") || end < 0) return `${MARKER}\n${text}`;
	return `${text.slice(0, end + 5)}${MARKER}\n${text.slice(end + 5)}`;
}

/** The skill without frontmatter, as a section to paste into AGENTS.md or a system prompt. */
export function agentsSnippet(name = "tabkyra"): string {
	const text = skillText(name);
	const end = text.indexOf("\n---\n", 4);
	const body = text.startsWith("---\n") && end >= 0 ? text.slice(end + 5) : text;
	// One level down, so it nests under a project's own headings.
	const nested = body.trim().replace(/^(#{2,5}) /gm, "#$1 ");
	const heading = name === "tabkyra" ? "## Browser: Tabkyra (MCP server `tabkyra`)" : `## Skill: ${name}`;
	return `${nested.replace(/^# .*/, heading)}\n`;
}

// --- Install -----------------------------------------------------------------------------

export type InstallState = "written" | "current" | "kept" | "linked" | "skipped";

export interface InstallResult {
	target: SkillTarget;
	skill: string;
	file: string;
	state: InstallState;
	backup?: string;
}

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Copy a file we're about to replace into skill-history/<name>/. */
function backUp(name: string, file: string, label: string): string {
	const dest = join(historyDir(), assertName(name), `${stamp()}.${label}.md`);
	assertNoLinks([configDir(), historyDir(), dirname(dest)]);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, readFileSync(file));
	return dest;
}

/**
 * Install skills (all, or `only`) into each detected harness. A file without our marker is
 * someone else's and is left alone, unless `force` names it: only skills named on the
 * command line, or tabkyra when none are. Anything replaced is backed up first.
 */
export function installSkills(options: { force: boolean; all: boolean; only?: string[] }): InstallResult[] {
	const names = (options.only?.length ? options.only : defaultInstallNames()).map(assertName);
	for (const name of names) skillText(name);
	const forced = new Set(options.force ? (options.only?.length ? options.only : ["tabkyra"]) : []);
	const results: InstallResult[] = [];
	for (const target of skillTargets()) {
		for (const skill of names) {
			const file = join(target.dir, skill, "SKILL.md");
			if (!target.detected && !options.all) {
				results.push({ target, skill, file, state: "skipped" });
				continue;
			}
			if (isLink(file) || isLink(dirname(file))) {
				results.push({ target, skill, file, state: "linked" });
				continue;
			}
			if (existsSync(file) && !lstatSync(file).isFile()) {
				results.push({ target, skill, file, state: "kept" });
				continue;
			}
			const wanted = skillFile(skill);
			let backup: string | undefined;
			if (existsSync(file)) {
				const existing = readFileSync(file, "utf8");
				if (existing === wanted) {
					results.push({ target, skill, file, state: "current" });
					continue;
				}
				// Someone else's skill of the same name, or hand edits without our marker: leave it unless forced.
				if (!existing.includes(MARKER) && !forced.has(skill)) {
					results.push({ target, skill, file, state: "kept" });
					continue;
				}
				if (!existing.includes(MARKER)) backup = backUp(skill, file, `${target.id}-replaced`);
			}
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, wanted);
			results.push({ target, skill, file, state: "written", backup });
		}
	}
	recordInstalled(results.filter((r) => r.state === "written" || r.state === "current").map((r) => r.file));
	return results;
}

// --- Refresh after an update ---------------------------------------------------------------
//
// After `tabkyra update` installs a new CLI, the skills it bundles may be newer than the copies
// installed in each harness. A copy is refreshed only when it is still exactly what Tabkyra
// wrote: skills-installed.json records the hash of every file install wrote, and the updater
// records the installed copies that match the old CLI's text right before it swaps the new one
// in. Anything else was edited by hand and is reported, never overwritten.

function installedRecordFile(): string {
	return join(configDir(), "skills-installed.json");
}

function readInstalledRecord(): Record<string, string> {
	try {
		const data = JSON.parse(readFileSync(installedRecordFile(), "utf8")) as Record<string, unknown>;
		return Object.fromEntries(Object.entries(data).filter((e): e is [string, string] => typeof e[1] === "string"));
	} catch {
		return {};
	}
}

/**
 * Remember the hash of what is in each of these files now (all written by Tabkyra). Best effort:
 * a record that can't be written only means a later refresh leaves those copies alone.
 */
function recordInstalled(files: string[]): void {
	if (files.length === 0) return;
	try {
		writeInstalledRecord(files);
	} catch {
		/* a linked or unwritable config folder: refresh will skip these copies */
	}
}

function writeInstalledRecord(files: string[]): void {
	const record = readInstalledRecord();
	for (const file of files) {
		try {
			record[file] = sha256(readFileSync(file, "utf8"));
		} catch {
			/* gone meanwhile */
		}
	}
	assertNoLinks([configDir(), installedRecordFile()]);
	mkdirSync(configDir(), { recursive: true });
	const tmp = `${installedRecordFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, "\t")}\n`);
	renameSync(tmp, installedRecordFile());
}

/** Installed skill files of ours (they carry the marker) in every detected harness. */
function installedSkillFiles(): Array<{ skill: string; file: string; target: SkillTarget }> {
	const out: Array<{ skill: string; file: string; target: SkillTarget }> = [];
	for (const target of skillTargets()) {
		if (!target.detected) continue;
		for (const skill of allNames()) {
			const file = join(target.dir, skill, "SKILL.md");
			if (!existsSync(file) || isLink(file) || isLink(dirname(file)) || !lstatSync(file).isFile()) continue;
			if (readFileSync(file, "utf8").includes(MARKER)) out.push({ skill, file, target });
		}
	}
	return out;
}

/**
 * Before an update swaps in a new CLI: record every installed copy that is exactly what this
 * (old) CLI would write, so the new CLI knows it is unedited even if it was installed before
 * skills-installed.json existed.
 */
export function noteUneditedSkills(): number {
	const unedited = installedSkillFiles().filter(({ skill, file }) => readFileSync(file, "utf8") === skillFile(skill));
	recordInstalled(unedited.map((u) => u.file));
	return unedited.length;
}

export interface RefreshResult {
	refreshed: string[];
	current: string[];
	skipped: Array<{ skill: string; file: string; reason: string }>;
}

/** After an update: bring every unedited installed copy up to this CLI's text. */
export function refreshInstalledSkills(): RefreshResult {
	const record = readInstalledRecord();
	const result: RefreshResult = { refreshed: [], current: [], skipped: [] };
	const written: string[] = [];
	for (const { skill, file } of installedSkillFiles()) {
		const existing = readFileSync(file, "utf8");
		const wanted = skillFile(skill);
		if (existing === wanted) {
			result.current.push(file);
			continue;
		}
		if (record[file] !== sha256(existing)) {
			result.skipped.push({ skill, file, reason: "edited since Tabkyra installed it" });
			continue;
		}
		writeFileSync(file, wanted);
		written.push(file);
		result.refreshed.push(file);
	}
	recordInstalled(written);
	return result;
}

// --- Apply and revert --------------------------------------------------------------------

/** A line diff in order (longest common subsequence), so reordered or repeated lines show. */
function lineDiff(before: string, after: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${b[j++]}`);
		else out.push(`- ${a[i++]}`);
	}
	return out.length ? out.join("\n") : "(no changes)";
}

function withoutMarker(text: string): string {
	return text
		.split("\n")
		.filter((l) => l.trim() !== MARKER)
		.join("\n");
}

export interface ApplyPlan {
	name: string;
	text: string;
	current?: string;
	diff: string;
}

/** Check an edited or new skill without changing anything. */
export function planApply(path: string): ApplyPlan {
	const file = basename(path) === "SKILL.md" ? path : join(path, "SKILL.md");
	if (!existsSync(file)) throw new SkillError(`No SKILL.md at ${path}.`);
	if (isLink(file) || isLink(dirname(file))) throw new SkillError(`${file} is a symlink.`);
	const text = withoutMarker(readFileSync(file, "utf8"));
	const name = parseFrontmatter(text)?.name ?? "";
	assertName(name);
	if (PROTECTED_SKILLS.has(name)) throw new SkillError(`The ${name} skill governs skill edits, so it changes only through a reviewed pull request.`);
	if (basename(dirname(file)) !== name) throw new SkillError(`The folder holding SKILL.md must be named ${name}.`);
	const errors = [...lintPath(dirname(file)), ...lintText(file, text, { dirName: name })].filter((f) => f.severity === "error");
	if (errors.length) throw new SkillError(`Lint failed:\n${formatFindings(errors)}`);
	const current = baseText(name) !== undefined || localText(name).text !== undefined ? skillText(name) : undefined;
	// A skill the user wrote themselves has no shipped base to protect; only lint applies to it.
	if (current !== undefined && baseText(name) !== undefined) {
		const missing = headings(current).filter((h) => !headings(text).includes(h));
		if (missing.length) throw new SkillError(`The edit drops section${missing.length > 1 ? "s" : ""} ${missing.map((h) => `"${h}"`).join(", ")}. Edits add or change; they don't remove sections.`);
		const added = headings(text).filter((h) => !headings(current).includes(h));
		if (added.length) {
			throw new SkillError(`The edit adds section${added.length > 1 ? "s" : ""} ${added.map((h) => `"${h}"`).join(", ")}. Edits change existing sections; a new section could override a protected one, so it needs a reviewed pull request.`);
		}
		const changed = changedProtectedSections(current, text);
		if (changed.length) {
			throw new SkillError(`The edit changes a protected section (${changed.map((h) => `"${h}"`).join(", ")}). Safety, rules, purpose-check and done-when sections change only through a reviewed pull request.`);
		}
	}
	return { name, text, current, diff: lineDiff(current ?? "", text) };
}

/** Apply a checked plan: back up, keep the edit, install it where nothing else owns the name. */
export function applySkill(plan: ApplyPlan): { backup?: string; results: InstallResult[] } {
	assertNoLinks([configDir(), localSkillsDir(), indexFile(), historyDir(), join(historyDir(), plan.name), localSkillDir(plan.name), localFile(plan.name)]);
	let backup: string | undefined;
	if (plan.current !== undefined) {
		backup = join(historyDir(), plan.name, `${stamp()}.md`);
		mkdirSync(dirname(backup), { recursive: true });
		writeFileSync(backup, plan.current);
	}
	assertNoLinks([configDir(), localSkillsDir(), historyDir(), localSkillDir(plan.name), localFile(plan.name)]);
	mkdirSync(localSkillDir(plan.name), { recursive: true });
	// Temp file + rename replaces the path itself, never a file a link points at.
	const tmp = `${localFile(plan.name)}.${process.pid}.tmp`;
	writeFileSync(tmp, plan.text, { flag: "wx" });
	renameSync(tmp, localFile(plan.name));
	const index = readIndex();
	const bundled = baseText(plan.name);
	const base = SKILLS.has(plan.name) ? "bundled" : bundled !== undefined ? "community" : undefined;
	index[plan.name] = { baseSha256: bundled === undefined ? null : sha256(bundled), appliedAt: new Date().toISOString(), budget: true, ...(base ? { base } : {}) };
	writeIndex(index);
	return { backup, results: installSkills({ force: false, all: false, only: [plan.name] }) };
}

/** Drop the local edit (kept in history) and reinstall the bundled skill. */
export function revertSkill(name: string): { removed: boolean; results: InstallResult[] } {
	const dir = localSkillDir(name);
	const file = join(dir, "SKILL.md");
	const index = readIndex();
	if (!existsSync(file) && !index[name]) return { removed: false, results: [] };
	assertNoLinks([configDir(), localSkillsDir(), indexFile(), historyDir(), join(historyDir(), name), dir, file]);
	if (existsSync(file)) {
		const kept = join(historyDir(), name, `${stamp()}.reverted.md`);
		mkdirSync(dirname(kept), { recursive: true });
		renameSync(file, kept);
	}
	rmSync(dir, { recursive: true, force: true });
	delete index[name];
	writeIndex(index);
	if (baseText(name) === undefined) {
		// A skill that only ever existed locally: remove the copies we installed, never anyone else's.
		removeInstalledCopies(name);
		return { removed: true, results: [] };
	}
	return { removed: true, results: installSkills({ force: false, all: false, only: [name] }) };
}

/** Delete the copies of `name` Tabkyra installed into harnesses (they carry the marker); never anyone else's. */
export function removeInstalledCopies(name: string): string[] {
	const removed: string[] = [];
	// Built-in skills' copies are refreshed or kept, never deleted by community state.
	if (SKILLS.has(name)) return removed;
	for (const target of skillTargets()) {
		const installed = join(target.dir, assertName(name), "SKILL.md");
		if (isLink(installed) || isLink(dirname(installed))) continue;
		if (existsSync(installed) && lstatSync(installed).isFile() && readFileSync(installed, "utf8").includes(MARKER)) {
			rmSync(installed);
			removed.push(installed);
		}
	}
	return removed;
}

// --- Router ------------------------------------------------------------------------------
//
// skill_match and `tabkyra skill match` route over the skills in use: the bundled ones and
// the user's applied local copies. The index is built once per process and rebuilt only
// when skills-local changes, which a few stat calls detect.

let router: { key: string; index: RouterIndex; full?: RouterIndex; community: Set<string> } | undefined;

/**
 * Changes whenever an apply, revert or rollback changes the local skills. Apply writes through
 * a temp file and a rename, so the inode changes even when two edits of the same size land
 * within one timestamp tick; index.json is hashed for the same reason.
 */
function localStateKey(): string {
	const dir = localSkillsDir();
	if (!existsSync(dir)) return "";
	const stat = (p: string) => {
		try {
			const s = lstatSync(p);
			return `${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
		} catch {
			return "-";
		}
	};
	const index = indexFile();
	const indexHash = existsSync(index) && !isLink(index) ? sha256(readFileSync(index, "utf8")) : "-";
	return `${indexHash};${readdirSync(dir)
		.sort()
		.map((n) => `${n}=${stat(join(dir, n))}/${stat(join(dir, n, "SKILL.md"))}`)
		.join(",")}`;
}

/**
 * Two indexes. The primary one holds the built-in skills and the user's local skills and edits,
 * exactly as before community skills existed. The full one adds the community skills (and local
 * copies of them). A community skill is picked only when the primary index finds nothing, so a
 * community skill never takes a task from a built-in or local skill, and the built-in skills
 * route exactly as CI measured them (D27).
 */
function routerIndexes(): { primary: RouterIndex; full?: RouterIndex; community: Set<string> } {
	const key = `${localStateKey()}#${communityKey()}`;
	if (!router || router.key !== key) {
		const community = new Set(communitySkills().keys());
		const all = allNames().map((name) => ({ name, text: skillText(name) }));
		const primary = buildRouterIndex(all.filter((s) => !community.has(s.name)));
		router = { key, index: primary, full: community.size ? buildRouterIndex(all) : undefined, community };
	}
	return { primary: router.index, full: router.full, community: router.community };
}

let bundledRouter: RouterIndex | undefined;

/** The index over bundled skills only, for remote sessions. */
function bundledIndex(): RouterIndex {
	bundledRouter ??= buildRouterIndex([...SKILLS].map(([name, text]) => ({ name, text })));
	return bundledRouter;
}

/**
 * The best skills for a task, best first; empty when none fits. `bundledOnly` (remote
 * sessions) leaves out the user's local skills and edits, which stay on their devices (D6).
 */
export function matchTask(task: string, top = 3, bundledOnly = false): SkillMatch[] {
	if (bundledOnly) return matchSkills(bundledIndex(), task, top);
	const { primary, full, community } = routerIndexes();
	const first = matchSkills(primary, task, top);
	if (!full) return first;
	const all = matchSkills(full, task, top);
	const lead = all[0];
	if (lead && community.has(lead.name) && (first.length === 0 || namesSite(task, sitesOf(skillText(lead.name))))) {
		return [lead, ...first.filter((m) => m.name !== lead.name)].slice(0, top);
	}
	return first.length ? first : all.filter((m) => community.has(m.name));
}

const sitesOf = (text: string) => parseSites(text)?.sites ?? [];

/**
 * The eval's version of matchTask's rule: `ranker` ranks the primary skills alone and all skills
 * together. A task goes to a community skill when it leads the full ranking and either the
 * primary skills find none or the task names one of the community skill's sites.
 */
export function twoStageRanker(primaryNames: ReadonlySet<string>, ranker: Ranker = inProcessRanker): Ranker {
	return (skills, tasks, rounds) => {
		const a = ranker(
			skills.filter((s) => primaryNames.has(s.name)),
			tasks,
			rounds,
		);
		const b = ranker(skills, tasks, rounds);
		const sites = new Map(skills.filter((s) => !primaryNames.has(s.name)).map((s) => [s.name, sitesOf(s.text)]));
		const pick = (x: string, y: string, task: string) => (y !== "none" && !primaryNames.has(y) && (x === "none" || namesSite(task, sites.get(y) ?? [])) ? y : x);
		return {
			buildMs: a.buildMs + b.buildMs,
			top: a.top.map((x, i) => pick(x, b.top[i] ?? "none", tasks[i] ?? "")),
			timesMs: a.timesMs.map((t, i) => t + (b.timesMs[i] ?? 0)),
			wallPerMatchMs: a.wallPerMatchMs === undefined && b.wallPerMatchMs === undefined ? undefined : (a.wallPerMatchMs ?? 0) + (b.wallPerMatchMs ?? 0),
		};
	};
}

/**
 * The SKILL.md text in use for `name`: the applied local copy, or the bundled skill. With
 * `bundledOnly` (remote sessions) it is always the bundled text, and local-only skills don't exist.
 */
export function readSkill(name: string, bundledOnly = false): string {
	assertName(name);
	if (bundledOnly) {
		const text = SKILLS.get(name);
		if (text === undefined) throw new SkillError(`No bundled skill named ${name}. Call skill_match.`);
		return text;
	}
	if (!allNames().includes(name)) throw new SkillError(`No skill named ${name}.${gone(name)} Call skill_match, or run tabkyra skill list.`);
	return skillText(name);
}

// --- Versions and rollback ---------------------------------------------------------------
//
// A version is the first 12 hex digits of the SHA-256 of a SKILL.md, so the same text has
// the same version wherever it is: bundled, applied locally, or kept in skill-history.

export function skillVersion(text: string): string {
	return sha256(text).slice(0, 12);
}

export interface SkillVersion {
	version: string;
	source: "bundled" | "community" | "local" | "history";
	/** ISO time the history file was written. */
	at?: string;
	/** Why it was kept: "backup" (before an apply), "reverted" or "<harness>-replaced". */
	label?: string;
	file?: string;
	inUse: boolean;
}

const HISTORY_FILE = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:\.([a-z0-9-]+))?\.md$/;

/** The ISO time a history stamp stands for (stamp() writes ":" and "." as "-"). */
function stampTime(stamp: string): string {
	return stamp.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3}Z)$/, "$1:$2:$3.$4");
}

/** Every version of a skill: bundled, applied local copy, and each file in skill-history, oldest first. */
export function skillVersions(name: string): SkillVersion[] {
	assertName(name);
	const usable = localText(name).text;
	const out: SkillVersion[] = [];
	const bundled = baseText(name);
	if (bundled !== undefined) out.push({ version: skillVersion(bundled), source: SKILLS.has(name) ? "bundled" : "community", inUse: usable === undefined });
	if (usable !== undefined) out.push({ version: skillVersion(usable), source: "local", file: localFile(name), inUse: true });
	const dir = join(historyDir(), name);
	assertNoLinks([configDir(), historyDir(), dir]);
	if (existsSync(dir)) {
		for (const entry of readdirSync(dir).sort()) {
			const m = HISTORY_FILE.exec(entry);
			const file = join(dir, entry);
			if (!m || isLink(file) || !lstatSync(file).isFile()) continue;
			const version = skillVersion(readFileSync(file, "utf8"));
			out.push({ version, source: "history", at: stampTime(m[1]), label: m[2] ?? "backup", file, inUse: false });
		}
	}
	if (out.length === 0) throw new SkillError(`No skill named ${name}, and no history for it. Run tabkyra skill list.`);
	return out;
}

/**
 * Check a rollback to a version kept in skill-history, named by version (6 or more hex
 * digits) or by its time. The text goes through planApply, so a rollback meets every check
 * an edit does: lint, protected skills and protected sections.
 */
export function planRollback(name: string, to: string): { plan: ApplyPlan; from: SkillVersion } {
	const history = skillVersions(name).filter((v) => v.source === "history");
	const wanted = to.trim().toLowerCase();
	const hits = history.filter((v) => (/^[0-9a-f]{6,12}$/.test(wanted) && v.version.startsWith(wanted)) || v.at?.toLowerCase() === wanted || (v.file && basename(v.file).startsWith(`${to.trim()}.`)));
	const versions = new Set(hits.map((v) => v.version));
	if (versions.size === 0) {
		const known = history.map((v) => `${v.version} (${v.at})`).join(", ") || "none";
		throw new SkillError(`${name} has no version ${to} in its history. Versions in history: ${known}. Run tabkyra skill versions ${name}.`);
	}
	if (versions.size > 1) throw new SkillError(`${to} matches more than one version of ${name} (${[...versions].join(", ")}). Give more of the version.`);
	const from = hits[hits.length - 1];
	const work = mkdtempSync(join(tmpdir(), "tabkyra-rollback-"));
	try {
		const dir = join(work, name);
		mkdirSync(dir);
		writeFileSync(join(dir, "SKILL.md"), readFileSync(from.file ?? "", "utf8"));
		return { plan: planApply(dir), from };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// --- Editor ------------------------------------------------------------------------------

function draftsDir(): string {
	return join(configDir(), "skill-drafts");
}

/**
 * The draft folder for `name`, holding the exact source in use. The version a draft was
 * taken from is kept in skill-drafts/.bases/<name>, outside the skill folder. A draft that
 * differs from the current source is resumed only when it was taken from that source; a
 * draft taken from an older version (an apply or rollback has happened since) would drop
 * those changes, so it is moved to skill-drafts/.backups/<name>/ and a fresh draft started.
 */
export function prepareDraft(name: string, options: { keepExisting?: boolean } = {}): { dir: string; file: string; resumed: boolean; stale?: string; held?: boolean } {
	assertName(name);
	if (PROTECTED_SKILLS.has(name)) throw new SkillError(`The ${name} skill governs skill edits, so it changes only through a reviewed pull request.`);
	const source = readSkill(name);
	const root = resolve(draftsDir());
	const dir = resolve(root, name);
	if (relative(root, dir) !== name) throw new SkillError(`${name} resolves outside ${root}.`);
	const file = join(dir, "SKILL.md");
	const basesDir = join(root, ".bases");
	const baseFile = join(basesDir, name);
	const backupsDir = join(root, ".backups", name);
	assertNoLinks([configDir(), draftsDir(), dir, file, basesDir, baseFile, join(root, ".backups"), backupsDir]);
	if (existsSync(file) && !lstatSync(file).isFile()) throw new SkillError(`${file} is not a file.`);
	const current = skillVersion(source);
	let stale: string | undefined;
	if (existsSync(file)) {
		const draft = readFileSync(file, "utf8");
		const base = existsSync(baseFile) ? readFileSync(baseFile, "utf8").trim() : undefined;
		// Changed by someone: the draft differs from the version it was taken from (or, with no
		// record of that, from the current source). An untouched draft holds nothing to keep.
		const changed = base === undefined ? draft !== source : skillVersion(draft) !== base;
		// keepExisting (--draft-only, for agents): a draft with unapplied changes is the user's
		// work. Leave it exactly as it is, and let the caller stop and ask.
		if (options.keepExisting && changed) return { dir, file, resumed: false, held: true };
		if (draft !== source && base === current) return { dir, file, resumed: true };
		// Anything the user typed is moved aside, never replaced; an untouched draft is refreshed.
		if (changed) {
			mkdirSync(backupsDir, { recursive: true });
			stale = join(backupsDir, `${stamp()}.md`);
			renameSync(file, stale);
		}
	}
	mkdirSync(dir, { recursive: true });
	mkdirSync(basesDir, { recursive: true });
	writeFileSync(file, source);
	writeFileSync(baseFile, `${current}\n`);
	return { dir, file, resumed: false, stale };
}

/** Open `file` in the user's editor; the editor string may carry arguments ("code --wait"). */
function openEditor(editor: string, file: string): number {
	const r =
		process.platform === "win32"
			? spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true })
			: spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
	return r.status ?? 1;
}

/** One line from the terminal, read synchronously. */
function askLine(question: string): string {
	process.stdout.write(question);
	const buf = Buffer.alloc(1);
	let line = "";
	for (;;) {
		let n = 0;
		try {
			n = readSync(0, buf, 0, 1, null);
		} catch {
			break;
		}
		if (n === 0 || buf[0] === 10) break;
		line += String.fromCharCode(buf[0]);
	}
	return line.trim();
}

/** The community rules for every SKILL.md at or under `path` (a skill folder or a folder of them). */
function lintCommunityPath(path: string): Finding[] {
	const bundled = new Set(SKILLS.keys());
	const one = (dir: string) => {
		const file = join(dir, "SKILL.md");
		if (!existsSync(file) || isLink(file)) return [];
		return lintCommunity(file, readFileSync(file, "utf8"), { bundled, name: basename(dir) });
	};
	if (basename(path) === "SKILL.md") return one(dirname(path));
	if (existsSync(join(path, "SKILL.md"))) return one(path);
	if (!existsSync(path) || !lstatSync(path).isDirectory()) return [];
	return readdirSync(path)
		.sort()
		.flatMap((n) => (lstatSync(join(path, n)).isDirectory() ? one(join(path, n)) : []));
}

// --- Manage: write, check, remove ----------------------------------------------------------
//
// What agents call (CLI and MCP) so nobody edits files by hand. Every write goes through
// planApply, so the lint runs on every write; nothing lands without --yes (CLI) or apply:true
// (MCP, after the user saw the diff).

/** Check new or edited SKILL.md text for `name`, and apply it when `apply` is set. */
export function writeSkill(name: string, text: string, apply: boolean): { plan: ApplyPlan; applied: boolean; backup?: string; results?: InstallResult[] } {
	assertName(name);
	const declared = parseFrontmatter(text)?.name;
	if (declared !== name) throw new SkillError(`The frontmatter says name: ${declared ?? "(none)"}, but you are writing ${name}. They must match.`);
	const work = mkdtempSync(join(tmpdir(), "tabkyra-write-"));
	try {
		const dir = join(work, name);
		mkdirSync(dir);
		writeFileSync(join(dir, "SKILL.md"), text);
		const plan = planApply(dir);
		if (!apply) return { plan, applied: false };
		const { backup, results } = applySkill(plan);
		return { plan, applied: true, backup, results };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Remove a skill from use. A local skill or edit is reverted (kept in skill-history); a
 * community skill is turned off on this device until `skill enable`; a built-in one can't be.
 */
export function removeSkill(name: string): string {
	assertName(name);
	const hasLocal = readIndex()[name] !== undefined || existsSync(localFile(name));
	if (hasLocal) {
		const kind = SKILLS.has(name) ? "the built-in skill" : communitySkills().has(name) ? "the community skill" : undefined;
		revertSkill(name);
		return kind ? `Removed your local copy of ${name}; ${kind} is in use again. The copy is kept in ${join(historyDir(), name)}.` : `Removed ${name}. It is kept in ${join(historyDir(), name)}.`;
	}
	if (communitySkills().has(name)) {
		setDisabled(name, true);
		const removed = removeInstalledCopies(name);
		return `Turned off the community skill ${name} on this device${removed.length ? ` and removed ${removed.length} installed cop${removed.length === 1 ? "y" : "ies"}` : ""}. tabkyra skill enable ${name} brings it back.`;
	}
	if (SKILLS.has(name)) throw new SkillError(`${name} is a built-in skill; it ships with Tabkyra and can't be removed. An agent that shouldn't use it can skip it.`);
	throw new SkillError(`No skill named ${name}.${gone(name)} Run tabkyra skill list.`);
}

export interface CheckResult {
	ok: boolean;
	name: string;
	text: string;
	community: boolean;
	findings: Finding[];
	report?: CommunityReport;
	/** This skill's share of its own cases when no checkout was at hand. */
	own?: { cases: number; correct: number; noneCases: number; falseInvokes: number; misses: Array<{ task: string; expected: string; got: string }> };
	lines: string[];
}

function skillsIn(root: string): RouterSkill[] {
	const dir = join(root, "skills");
	return readdirSync(dir)
		.filter((n) => NAME.test(n) && existsSync(join(dir, n, "SKILL.md")) && !isLink(join(dir, n)) && !isLink(join(dir, n, "SKILL.md")))
		.sort()
		.map((name) => ({ name, text: readFileSync(join(dir, name, "SKILL.md"), "utf8") }));
}

/**
 * Lint a skill, run the community rules when it is (or will be) a community skill, and run
 * the router eval CI runs. With `root` (a Tabkyra checkout) that is the full regression with
 * the skill added; without one, only its own cases are routed.
 */
export function checkSkill(
	input: { name?: string; folder?: string; text?: string },
	options: { cases?: string; root?: string; community?: boolean; names?: string[] } = {},
): CheckResult {
	let text: string;
	let file: string;
	if (input.text !== undefined) {
		text = input.text;
		file = `${input.name ?? "skill"}/SKILL.md`;
	} else if (input.folder) {
		file = basename(input.folder) === "SKILL.md" ? input.folder : join(input.folder, "SKILL.md");
		if (!existsSync(file)) throw new SkillError(`No SKILL.md at ${input.folder}.`);
		if (isLink(file) || isLink(dirname(file))) throw new SkillError(`${file} is a symlink.`);
		text = withoutMarker(readFileSync(file, "utf8"));
	} else {
		const n = assertName(input.name ?? "");
		if (!allNames().includes(n)) throw new SkillError(`No skill named ${n}.${gone(n)} Run tabkyra skill list.`);
		text = skillText(n);
		file = `${n}/SKILL.md`;
	}
	const name = parseFrontmatter(text)?.name ?? input.name ?? "";
	assertName(name);
	const community = options.community ?? (parseSites(text) !== undefined || communitySkills().has(name));
	const findings: Finding[] = input.folder && input.text === undefined ? lintPath(dirname(file)) : lintText(file, text, { dirName: name });
	if (community) {
		findings.push(...lintCommunity(file, text, { bundled: new Set(SKILLS.keys()), name }));
		for (const p of scanPersonal(text, options.names ?? []).filter((p) => p.kind.startsWith("your name"))) {
			findings.push({ file, line: p.line, rule: "personal-data", severity: "error", message: `${p.kind}: ${p.match}.` });
		}
	}
	const errors = findings.filter((f) => f.severity === "error");
	const lines: string[] = [];
	lines.push(errors.length ? `${sym.fail} lint: ${errors.length} problem${errors.length === 1 ? "" : "s"}${community ? " (lint and community rules)" : ""}` : `${sym.ok} lint: clean${community ? ", community rules included" : ""}`);
	if (findings.length) lines.push(formatFindings(findings));
	const cases = options.cases === undefined ? undefined : parseCases(options.cases, `${name} cases`);
	const positives = (cases ?? []).filter((c) => c.skill === name).length;
	if (cases && cases.some((c) => c.skill !== name && c.skill !== "none")) throw new SkillError(`The cases for ${name} may name only ${name} or none.`);
	let ok = errors.length === 0;
	let report: CommunityReport | undefined;
	let own: CheckResult["own"];
	if (community && positives < 8) {
		ok = false;
		lines.push(`${sym.fail} cases: ${positives} for ${name}; a community skill needs 8 or more router cases, one {"task": "...", "skill": "${name}"} per line, written the way users ask, plus near misses as {"task": "...", "skill": "none"}.`);
	}
	if (options.root && cases) {
		const root = options.root;
		const others = readCommunityFolder(root).filter((s) => s.name !== name);
		const evalDir = join(root, "skills-eval");
		const communityCases = readCommunityCases(root)
			.split("\n")
			.filter((l) => l.trim() && (JSON.parse(l) as { skill?: string }).skill !== name)
			.join("\n");
		report = communityReport(skillsIn(root), [...others, { name, text }], {
			cases: readFileSync(join(evalDir, "router-cases.jsonl"), "utf8"),
			community: [communityCases, options.cases ?? ""].filter((t) => t.trim()).join("\n"),
			heldout: readIfExists(join(evalDir, "router-heldout.jsonl")),
			baseline: readIfExists(join(evalDir, "baseline.json")),
			drops: readIfExists(join(evalDir, "accepted-drops.json")),
		});
		ok &&= report.ok;
		const s = report.report.perSkill[name];
		lines.push(`${report.ok ? sym.ok : sym.fail} eval: ${name} routes ${s?.correct ?? 0} of ${s?.cases ?? 0} of its cases; ${report.report.skills} skills, ${report.report.cases} cases`);
		for (const m of report.report.misses.filter((m) => m.expected === name || m.got === name)) lines.push(`  ${sym.dot} expected ${m.expected}, got ${m.got}: ${m.task}`);
		for (const g of report.gates) lines.push(`${g.ok ? sym.ok : sym.fail} ${g.gate}: ${g.detail}`);
	} else if (cases?.length) {
		const primary = [...SKILLS].map(([n, t]) => ({ name: n, text: t })).filter((s) => s.name !== name);
		const ranked = twoStageRanker(new Set(primary.map((s) => s.name)))([...primary, ...[...communitySkills().values()].filter((s) => s.name !== name), { name, text }], cases.map((c) => c.task), 1).top;
		own = { cases: positives, correct: 0, noneCases: 0, falseInvokes: 0, misses: [] };
		for (const [i, c] of cases.entries()) {
			const got = ranked[i] ?? "none";
			if (c.skill === "none") {
				own.noneCases++;
				if (got !== "none") own.falseInvokes++;
			} else if (got === name) own.correct++;
			if (got !== c.skill) own.misses.push({ task: c.task, expected: c.skill, got });
		}
		const share = own.cases ? own.correct / own.cases : 0;
		const good = share >= COMMUNITY_TOP1_MIN && own.falseInvokes === 0;
		ok &&= good || !community;
		lines.push(`${good ? sym.ok : sym.fail} router: ${own.correct} of ${own.cases} cases route to ${name}; ${own.falseInvokes} of ${own.noneCases} none cases route to a skill`);
		for (const m of own.misses) lines.push(`  ${sym.dot} expected ${m.expected}, got ${m.got}: ${m.task}`);
		lines.push(`${sym.dot} The full regression (every case, every skill) runs in a Tabkyra checkout and at submit time.`);
	}
	return { ok, name, text, community, findings, report, own, lines };
}

// --- Sync ----------------------------------------------------------------------------------

export interface CommunitySync extends SyncResult {
	/** What changed for the user: removals, kept local copies. */
	notes: string[];
}

/**
 * Fetch and verify the community catalog (community-catalog.ts), then bring this device in
 * line: pulled skills lose their installed copies, a local copy of a pulled skill is turned
 * off, a local copy of an updated skill is kept and the user told, and unedited installed
 * copies are refreshed.
 */
export async function syncCommunity(options: { due?: boolean } = {}): Promise<CommunitySync> {
	const result = await syncCatalog(options);
	const notes: string[] = [];
	// Every pass, whatever the fetch did: a cleanup an earlier process skipped or didn't finish
	// happens now (it only deletes copies Tabkyra installed, of skills no longer in use).
	const deleted = reconcileInstalled();
	for (const r of result.removed) {
		const local = readIndex()[r.name]?.base === "community" ? " Your local copy of it is turned off too; tabkyra skill revert removes it." : "";
		notes.push(`Removed the community skill ${r.name}: ${r.reason}.${local}`);
	}
	if (deleted.length) notes.push(`Deleted ${deleted.length} installed cop${deleted.length === 1 ? "y" : "ies"} of community skills no longer in use.`);
	for (const name of result.updated) {
		if (localText(name).text !== undefined) notes.push(`Kept your local copy of ${name}; the community version changed. tabkyra skill revert ${name} switches to it.`);
	}
	if (result.updated.length) refreshInstalledSkills();
	return { ...result, notes };
}

/**
 * Delete the installed copies (ours, with the marker) of community skills that aren't in use:
 * pulled, removed by the user, or all of them when community skills are off. Never a built-in
 * skill's copy, and never a copy of the user's own skill that happens to share a name.
 */
export function reconcileInstalled(): string[] {
	const state = readState();
	const { catalog } = loadCatalog();
	const active = communitySkills();
	const candidates = new Set([...state.removed.map((r) => r.name), ...(catalog?.revoked.map((r) => r.skill) ?? []), ...state.disabled, ...(state.enabled ? [] : (catalog?.skills.map((s) => s.name) ?? []))]);
	const index = readIndex();
	const deleted: string[] = [];
	for (const name of candidates) {
		if (!isName(name) || SKILLS.has(name) || active.has(name)) continue;
		if (index[name] && index[name].base !== "community") continue;
		deleted.push(...removeInstalledCopies(name));
	}
	return deleted;
}

export async function runSkillSync(args: string[], flags: SkillFlags): Promise<number> {
	try {
		if (args.length) throw new SkillError("Usage: tabkyra skill sync [--on|--off] [--json]");
		if (flags.on && flags.off) throw new SkillError("Pick one of --on and --off.");
		if (flags.on || flags.off) {
			setEnabled(Boolean(flags.on));
			if (flags.off) reconcileInstalled();
			console.log(flags.on ? `${sym.ok} Community skills are on. They are checked about once a day; run tabkyra skill sync to check now.` : `${sym.ok} Community skills are off: none is matched or read, and Tabkyra stops checking for them.`);
			return 0;
		}
		const result = await syncCommunity();
		if (flags.json) console.log(JSON.stringify(result));
		else {
			const mark = result.state === "refused" || result.state === "failed" ? sym.fail : result.state === "off" ? sym.dot : sym.ok;
			console.log(`${mark} ${result.message}`);
			if (result.added.length) console.log(`${sym.ok} New: ${result.added.join(", ")}`);
			if (result.updated.length) console.log(`${sym.ok} Updated: ${result.updated.join(", ")}`);
			for (const n of result.notes) console.log(`${sym.dot} ${n}`);
		}
		return result.state === "refused" || result.state === "failed" ? 1 : 0;
	} catch (err) {
		if (!(err instanceof SkillError) && !(err instanceof CatalogError)) throw err;
		console.error(`${sym.fail} ${err.message}`);
		return 1;
	}
}

// --- CLI ---------------------------------------------------------------------------------

function printInstall(results: InstallResult[]): void {
	for (const target of skillTargets()) {
		const mine = results.filter((r) => r.target.id === target.id);
		if (mine.length === 0) continue;
		if (mine.every((r) => r.state === "skipped")) {
			console.log(`${sym.dot} ${target.name.padEnd(12)} ${c.dim("not found (--all installs anyway)")}`);
			continue;
		}
		const changed = mine.filter((r) => r.state === "written").map((r) => r.skill);
		const current = mine.filter((r) => r.state === "current").map((r) => r.skill);
		if (changed.length) console.log(`${sym.ok} ${target.name.padEnd(12)} wrote ${changed.join(", ")} ${c.dim(target.dir)}`);
		if (current.length) console.log(`${sym.ok} ${target.name.padEnd(12)} current ${current.join(", ")}`);
		for (const r of mine.filter((r) => r.backup)) console.log(`${sym.dot} ${target.name.padEnd(12)} replaced ${r.file}; the old file is in ${c.dim(r.backup ?? "")}`);
		for (const r of mine.filter((r) => r.state === "linked")) {
			console.log(`${sym.warn} ${target.name.padEnd(12)} left alone: ${c.dim(r.file)} is a symbolic link, and Tabkyra won't write through one. Replace the link by hand to install it.`);
		}
		for (const r of mine.filter((r) => r.state === "kept")) {
			console.log(`${sym.warn} ${target.name.padEnd(12)} left alone: ${c.dim(r.file)} is not ours ${c.dim(`(tabkyra skill install ${r.skill} --force replaces it)`)}`);
		}
	}
}

export interface SkillFlags {
	force: boolean;
	all: boolean;
	raw?: boolean;
	yes?: boolean;
	json?: boolean;
	updateBaseline?: boolean;
	draftOnly?: boolean;
	/** Values of --top, --to, --cases, --base and --router. */
	top?: string;
	to?: string;
	cases?: string;
	base?: string;
	router?: string;
	/** --file for write; --community for lint; --on/--off for sync; --out, --serial, --source for catalog. */
	file?: string;
	community?: boolean;
	on?: boolean;
	off?: boolean;
	out?: string;
	serial?: string;
	source?: string;
}

export function runSkill(sub: string | undefined, args: string[], flags: SkillFlags): number {
	try {
		return runSkillCommand(sub, args, flags);
	} catch (err) {
		if (!(err instanceof SkillError) && !(err instanceof EvalError) && !(err instanceof CatalogError)) throw err;
		console.error(`${sym.fail} ${err.message}`);
		return 1;
	}
}

/** Print the outcome of an apply, the way `skill apply --yes` does. */
function reportApplied(plan: ApplyPlan, what: string): number {
	const { backup, results } = applySkill(plan);
	console.log(`${sym.ok} ${what}${backup ? ` Backup: ${backup}` : ""}`);
	printInstall(results);
	console.log(`${sym.arrow} Undo: tabkyra skill revert ${plan.name}`);
	return results.some((r) => r.state === "kept" || r.state === "linked") ? 1 : 0;
}

/** skills-eval/router-cases.jsonl in this folder or the nearest one above it. */
function findCases(start: string): string | undefined {
	for (let dir = resolve(start); ; dir = dirname(dir)) {
		const file = join(dir, "skills-eval", "router-cases.jsonl");
		if (existsSync(file)) return file;
		if (dirname(dir) === dir) return undefined;
	}
}

function readIfExists(file: string): string | undefined {
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function runEvalCommand(flags: SkillFlags): number {
	const casesFile = flags.cases ? resolve(flags.cases) : findCases(process.cwd());
	if (!casesFile || !existsSync(casesFile)) throw new SkillError("No skills-eval/router-cases.jsonl here or above. Run this in a Tabkyra checkout, or pass --cases <file>.");
	const dir = dirname(casesFile);
	const baselineFile = join(dir, "baseline.json");
	const heldoutText = readIfExists(join(dir, "router-heldout.jsonl"));
	const skills = [...SKILLS].map(([name, text]) => ({ name, text }));
	// --router: a router built as its own script (cli/src/router-worker.ts), run in a child process.
	if (flags.router && !existsSync(resolve(flags.router))) throw new SkillError(`No router script at ${flags.router}.`);
	const ranker = flags.router ? processRanker(resolve(flags.router)) : undefined;
	if (flags.base) return runBaseCommand(flags, skills, casesFile, heldoutText, ranker);
	const cases = parseCases(readFileSync(casesFile, "utf8"));
	const heldout = heldoutText === undefined ? undefined : parseCases(heldoutText, "router-heldout.jsonl");
	// Each accepted drop is that skill's floor, with no tolerance (the last entry for a skill wins).
	const floors = new Map(parseDrops(readIfExists(join(dir, "accepted-drops.json"))).map((d) => [d.skill, d.value]));
	let baseline = existsSync(baselineFile) ? parseBaseline(readFileSync(baselineFile, "utf8")) : undefined;
	if (flags.updateBaseline) {
		writeFileSync(baselineFile, formatBaseline(runEval(skills, cases, undefined, undefined, { ranker })));
		baseline = parseBaseline(readFileSync(baselineFile, "utf8"));
	}
	const report = runEval(skills, cases, baseline, heldout, { floors, ranker });
	// Community skills join the index as they do on a client; their gates come after the bundled ones.
	const root = dirname(dir);
	const community = readCommunityFolder(root);
	const extra = community.length
		? communityReport(skills, community, { cases: readFileSync(casesFile, "utf8"), community: readCommunityCases(root), heldout: heldoutText, baseline: readIfExists(baselineFile), drops: readIfExists(join(dir, "accepted-drops.json")) }, ranker)
		: undefined;
	if (flags.json) {
		console.log(JSON.stringify(extra ? { ...report, ok: report.ok && extra.ok, community: extra } : report, null, "\t"));
		return report.ok && (extra?.ok ?? true) ? 0 : 1;
	}
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	console.log(`${c.bold("Skill router")} ${report.skills} skills, ${report.cases} cases (${report.positives} positive, ${report.negatives} none) ${c.dim(casesFile)}`);
	for (const [name, s] of Object.entries(report.perSkill)) {
		const base = s.baseline === undefined ? "" : c.dim(` baseline ${pct(s.baseline)}`);
		console.log(`  ${name.padEnd(20)} ${pct(s.accuracy).padStart(6)}  ${String(s.correct).padStart(3)}/${s.cases}${base}`);
	}
	for (const m of report.misses) console.log(`  ${sym.dot} ${c.dim(`expected ${m.expected}, got ${m.got}:`)} ${m.task}`);
	if (report.heldout) {
		console.log(`${c.bold("Held-out")} ${report.heldout.cases} cases the scorer was never tuned on: top-1 ${pct(report.heldout.top1)}, false invokes ${pct(report.heldout.falseInvoke)}`);
		for (const m of report.heldout.misses) console.log(`  ${sym.dot} ${c.dim(`expected ${m.expected}, got ${m.got}:`)} ${m.task}`);
	}
	for (const k of report.skipped) console.log(`  ${sym.warn} line ${k.line}: no bundled skill named ${k.skill}; skipped`);
	for (const g of report.gates) console.log(`${g.ok ? sym.ok : sym.fail} ${g.gate.padEnd(16)} ${g.detail}`);
	if (extra) printCommunityReport(extra);
	if (flags.updateBaseline) console.log(`${sym.arrow} Wrote ${baselineFile}. Commit it with the change that moved the numbers.`);
	return report.ok && (extra?.ok ?? true) ? 0 : 1;
}

/** Each community skill routes at least this share of its own cases to itself. */
export const COMMUNITY_TOP1_MIN = 0.75;

export interface CommunityReport {
	ok: boolean;
	skills: string[];
	report: EvalReport;
	gates: Gate[];
}

/**
 * The regression eval with community skills routed as on a client (twoStageRanker): every gate
 * of `skill eval` over the router cases plus community/cases, every built-in skill still at its
 * baseline and `none` too (a community skill that answers a none case fails here), and each
 * community skill at COMMUNITY_TOP1_MIN or more on its own cases, with 8 or more of them.
 */
export function communityReport(
	bundled: RouterSkill[],
	community: RouterSkill[],
	files: { cases: string; community: string; heldout?: string; baseline?: string; drops?: string },
	ranker?: Ranker,
): CommunityReport {
	const names = new Set(community.map((s) => s.name));
	const skills = [...bundled.filter((s) => !names.has(s.name)), ...community];
	const cases: EvalCase[] = [...parseCases(files.cases), ...parseCases(files.community, "community/cases")];
	const heldout = files.heldout === undefined ? undefined : parseCases(files.heldout, "router-heldout.jsonl");
	// Community skills claim no baseline of their own; built-in skills keep theirs.
	const baseline = files.baseline === undefined ? undefined : parseBaseline(files.baseline);
	if (baseline) for (const n of names) baseline.accuracy[n] = 0;
	const floors = new Map(parseDrops(files.drops).map((d) => [d.skill, d.value]));
	const report = runEval(skills, cases, baseline, heldout, { floors, ranker: twoStageRanker(new Set(bundled.filter((s) => !names.has(s.name)).map((s) => s.name)), ranker) });
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	const weak = [...names].filter((n) => (report.perSkill[n]?.accuracy ?? 0) < COMMUNITY_TOP1_MIN);
	const gates: Gate[] = [
		...report.gates.map((g) => ({ ...g, gate: `community: ${g.gate}` })),
		{
			gate: "community: own cases",
			ok: weak.length === 0,
			detail: weak.length
				? `under ${pct(COMMUNITY_TOP1_MIN)} on their own cases: ${weak.map((n) => `${n} ${pct(report.perSkill[n]?.accuracy ?? 0)} of ${report.perSkill[n]?.cases ?? 0}`).join(", ")}`
				: `every community skill routes ${pct(COMMUNITY_TOP1_MIN)} or more of its own cases to itself`,
		},
	];
	return { ok: gates.every((g) => g.ok), skills: [...names], report, gates };
}

function printCommunityReport(r: CommunityReport): void {
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	console.log(`${c.bold("Community skills")} ${r.skills.join(", ")}`);
	for (const n of r.skills) {
		const s = r.report.perSkill[n];
		console.log(`  ${n.padEnd(20)} ${pct(s?.accuracy ?? 0).padStart(6)}  ${String(s?.correct ?? 0).padStart(3)}/${s?.cases ?? 0}`);
	}
	for (const m of r.report.misses.filter((m) => r.skills.includes(m.expected) || r.skills.includes(m.got))) console.log(`  ${sym.dot} ${c.dim(`expected ${m.expected}, got ${m.got}:`)} ${m.task}`);
	for (const g of r.gates) console.log(`${g.ok ? sym.ok : sym.fail} ${g.gate.padEnd(16)} ${g.detail}`);
}

/**
 * `skill eval --base <checkout>`: run by the base branch's build, with the pull request's
 * skills bundled, from the pull request's checkout. The pull request's eval source sits at
 * cli/src/skill-eval.ts beside its skills-eval folder.
 */
function runBaseCommand(flags: SkillFlags, skills: RouterSkill[], casesFile: string, heldoutText: string | undefined, ranker?: Ranker): number {
	const baseDir = join(resolve(flags.base ?? ""), "skills-eval");
	if (!existsSync(baseDir)) throw new SkillError(`No skills-eval folder in ${flags.base}.`);
	const headRoot = dirname(dirname(casesFile));
	const headDir = dirname(casesFile);
	const { ok, skills: indexed, gates } = runBaseCheck(
		skills,
		{
			cases: readFileSync(casesFile, "utf8"),
			heldout: heldoutText,
			baseline: readIfExists(join(headDir, "baseline.json")),
			drops: readIfExists(join(headDir, "accepted-drops.json")),
			evalSource: readIfExists(join(headRoot, "cli", "src", "skill-eval.ts")),
		},
		{
			cases: readIfExists(join(baseDir, "router-cases.jsonl")),
			heldout: readIfExists(join(baseDir, "router-heldout.jsonl")),
			baseline: readIfExists(join(baseDir, "baseline.json")),
			drops: readIfExists(join(baseDir, "accepted-drops.json")),
		},
		ranker,
	);
	// The pull request's community skills, judged by this (base) code: read as data from the head files.
	const community = readCommunityFolder(headRoot);
	const extra = community.length
		? communityReport(skills, community, { cases: readFileSync(casesFile, "utf8"), community: readCommunityCases(headRoot), heldout: heldoutText, baseline: readIfExists(join(headDir, "baseline.json")), drops: readIfExists(join(headDir, "accepted-drops.json")) }, ranker)
		: undefined;
	const all = [...gates, ...(extra?.gates ?? [])];
	const allOk = ok && (extra?.ok ?? true);
	if (flags.json) console.log(JSON.stringify({ ok: allOk, skills: indexed, gates: all }, null, "\t"));
	else {
		console.log(`${c.bold("Base check")} ${indexed} skills indexed`);
		for (const g of all) console.log(`${g.ok ? sym.ok : sym.fail} ${g.gate.padEnd(16)} ${g.detail}`);
	}
	return allOk ? 0 : 1;
}

function readInput(file: string | undefined): string {
	if (file && file !== "-") {
		if (!existsSync(file)) throw new SkillError(`No file at ${file}.`);
		return readFileSync(file, "utf8");
	}
	if (process.stdin.isTTY) throw new SkillError("Give the SKILL.md text with --file <path>, or pipe it in.");
	return readFileSync(0, "utf8");
}

/** The cases for a check or submit: --cases, else the ones staged for this skill by MCP skill_manage prepare_submit. */
export function casesFor(name: string, file?: string): string | undefined {
	if (file) {
		if (!existsSync(file)) throw new SkillError(`No cases file at ${file}.`);
		return readFileSync(file, "utf8");
	}
	return readIfExists(stagedCasesFile(name));
}

export function stagedCasesFile(name: string): string {
	return join(configDir(), "skill-submissions", assertName(name), "cases.jsonl");
}

/** The Tabkyra checkout holding the working folder, if any (it has skills-eval/router-cases.jsonl). */
function checkoutRoot(): string | undefined {
	const cases = findCases(process.cwd());
	return cases ? dirname(dirname(cases)) : undefined;
}

function runSkillCommand(sub: string | undefined, args: string[], flags: SkillFlags): number {
	if (sub === "write") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill write <name> [--file <SKILL.md>|-] [--yes]");
		const { plan, applied, backup, results } = writeSkill(args[0], withoutMarker(readInput(flags.file)), Boolean(flags.yes));
		console.log(`${sym.ok} Lint passed.\n${c.bold(`Change to ${plan.name}:`)}\n${plan.diff}\n`);
		if (!applied) {
			console.log(`${sym.arrow} Nothing changed yet. Show this to the user; run again with --yes once they approve.`);
			return 3;
		}
		console.log(`${sym.ok} Saved ${plan.name} as a local skill.${backup ? ` Backup: ${backup}` : ""}`);
		printInstall(results ?? []);
		console.log(`${sym.arrow} Undo: tabkyra skill remove ${plan.name}`);
		return 0;
	}
	if (sub === "test") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill test <name|folder> [--cases <file>] [--json]");
		const isFolder = args[0].includes("/") || existsSync(args[0]);
		const file = basename(args[0]) === "SKILL.md" ? args[0] : join(args[0], "SKILL.md");
		if (isFolder && !existsSync(file)) throw new SkillError(`No SKILL.md at ${args[0]}.`);
		const name = isFolder ? (parseFrontmatter(readFileSync(file, "utf8"))?.name ?? "") : args[0];
		const result = checkSkill(isFolder ? { folder: args[0] } : { name }, { cases: isName(name) ? casesFor(name, flags.cases) : undefined, root: checkoutRoot() });
		if (flags.json) console.log(JSON.stringify({ ok: result.ok, name: result.name, community: result.community, findings: result.findings, gates: result.report?.gates, own: result.own }));
		else console.log(result.lines.join("\n"));
		return result.ok ? 0 : 1;
	}
	if (sub === "remove") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill remove <name>");
		console.log(`${sym.ok} ${removeSkill(args[0])}`);
		return 0;
	}
	if (sub === "enable") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill enable <name>");
		const name = assertName(args[0]);
		if (!readState().disabled.includes(name)) {
			console.log(`${sym.dot} ${name} wasn't turned off.`);
			return 0;
		}
		setDisabled(name, false);
		console.log(`${sym.ok} ${communitySkills().has(name) ? `The community skill ${name} is in use again.` : `${name} is no longer turned off; it comes back when the community catalog has it.`}`);
		return 0;
	}
	if (sub === "catalog") {
		// Run by .github/workflows/community-catalog.yml on main: build the catalog the release job signs.
		if (args.length !== 1 || !flags.out || !flags.serial) throw new SkillError("Usage: tabkyra skill catalog <checkout> --out <file> --serial N [--source <commit>]");
		const { catalog, text } = buildCatalog(resolve(args[0]), { serial: Number(flags.serial), source: flags.source ?? "" });
		writeFileSync(flags.out, text);
		console.log(`${sym.ok} ${catalog.skills.length} community skill${catalog.skills.length === 1 ? "" : "s"}, ${catalog.revoked.length} revoked, serial ${catalog.serial}: ${flags.out}`);
		return 0;
	}
	if (sub === "refresh") {
		// Run by the updater with the new CLI; also safe to run by hand.
		if (args.length !== 0) throw new SkillError("Usage: tabkyra skill refresh [--json]");
		const result = refreshInstalledSkills();
		if (flags.json) {
			console.log(JSON.stringify(result));
			return 0;
		}
		for (const file of result.refreshed) console.log(`${sym.ok} refreshed ${c.dim(file)}`);
		for (const s of result.skipped) console.log(`${sym.warn} left alone: ${c.dim(s.file)} (${s.reason}). tabkyra skill install ${s.skill} --force replaces it.`);
		if (result.refreshed.length + result.skipped.length === 0) console.log(`${sym.ok} Installed skills are current.`);
		return 0;
	}
	if (sub === "match") {
		const task = args.join(" ").trim();
		if (!task) throw new SkillError('Usage: tabkyra skill match "<task>" [--json] [--top N]');
		const top = flags.top === undefined ? 3 : Number(flags.top);
		if (!Number.isInteger(top) || top < 1 || top > 20) throw new SkillError("--top takes a whole number from 1 to 20.");
		const matches = matchTask(task, top);
		if (flags.json) console.log(JSON.stringify(matches.length ? matches : [{ name: "none", score: 0, description: "No skill fits this task." }]));
		else if (matches.length === 0) console.log(`${sym.dot} none: no skill fits this task.`);
		else for (const m of matches) console.log(`${c.bold(m.name.padEnd(20))} ${String(m.score).padStart(6)}  ${m.description}`);
		return 0;
	}
	if (sub === "eval") return runEvalCommand(flags);
	if (sub === "versions") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill versions <name> [--json]");
		const versions = skillVersions(args[0]);
		if (flags.json) {
			console.log(JSON.stringify(versions));
			return 0;
		}
		for (const v of versions) {
			const where = v.source === "history" ? `history  ${v.at} ${c.dim(`${v.label} ${v.file}`)}` : v.source === "local" ? `local    ${c.dim(v.file ?? "")}` : v.source;
			console.log(`${v.inUse ? sym.ok : sym.dot} ${c.bold(v.version)}  ${where}${v.inUse ? " (in use)" : ""}`);
		}
		if (versions.some((v) => v.source === "history")) console.log(`${sym.arrow} Restore one: tabkyra skill rollback ${args[0]} --to <version>`);
		return 0;
	}
	if (sub === "rollback") {
		if (args.length !== 1 || !flags.to) throw new SkillError("Usage: tabkyra skill rollback <name> --to <version|time> [--yes]");
		const { plan, from } = planRollback(args[0], flags.to);
		if (plan.current === plan.text) {
			console.log(`${sym.ok} ${plan.name} is already at version ${from.version}.`);
			return 0;
		}
		console.log(`${c.bold(`Roll ${plan.name} back to ${from.version} (${from.at}):`)}\n${plan.diff}\n`);
		// The bundled text isn't kept as a local copy: that would pin it and stop updates.
		const toBundled = plan.text === SKILLS.get(plan.name);
		if (!flags.yes) {
			console.log(
				toBundled
					? `${sym.arrow} That is the bundled version, so --yes removes your local edit (as tabkyra skill revert ${plan.name} does) and updates reach you again. Nothing changed yet.`
					: `${sym.arrow} Lint passed. Nothing changed yet. Show this to the user; run again with --yes once they approve.`,
			);
			return 3;
		}
		if (toBundled) {
			const { results } = revertSkill(plan.name);
			console.log(`${sym.ok} Rolled ${plan.name} back to the bundled version ${from.version}; your edit is kept in ${join(historyDir(), plan.name)}.`);
			printInstall(results);
			return 0;
		}
		return reportApplied(plan, `Rolled ${plan.name} back to ${from.version}.`);
	}
	if (sub === "edit") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill edit <name> [--yes] [--draft-only]");
		const { dir, file, resumed, stale, held } = prepareDraft(args[0], { keepExisting: flags.draftOnly });
		if (held) {
			console.log(`${sym.fail} ${file} holds unapplied changes to ${args[0]}. It was left as it is. Don't overwrite or delete it: ask the user whether to finish and apply it, or to discard it themselves.`);
			return 1;
		}
		const name = basename(dir);
		const source = readSkill(name);
		const editor = process.env.VISUAL || process.env.EDITOR;
		const later = `tabkyra skill apply ${dir}`;
		if (stale) console.log(`${sym.warn} Your earlier draft was taken from an older version of ${name}, so it would undo changes made since. It is kept at ${stale}; starting a fresh draft.`);
		console.log(`${sym.ok} ${resumed ? "Your earlier draft" : "Draft"} of ${name}: ${file}`);
		// --draft-only: for agents, whose shell may be a terminal with the user's $EDITOR.
		if (flags.draftOnly || !process.stdin.isTTY || !process.stdout.isTTY || !editor) {
			if (!flags.draftOnly && process.stdin.isTTY && !editor) console.log(`${sym.dot} Set $VISUAL or $EDITOR to open it from here.`);
			console.log(`${sym.arrow} Edit it, then check it with: ${c.bold(later)} (add --yes to apply)`);
			return 0;
		}
		const status = openEditor(editor, file);
		if (status !== 0) {
			console.log(`${sym.fail} The editor exited with ${status}. Nothing applied; the draft is kept at ${file}.`);
			return 1;
		}
		if (readFileSync(file, "utf8") === source) {
			console.log(`${sym.dot} No changes.`);
			return 0;
		}
		// Another apply, revert or rollback while the editor was open would be undone by this one.
		const changedUnderneath = () => {
			if (readSkill(name) === source) return false;
			console.log(
				`${sym.fail} ${name} changed while you were editing (now version ${skillVersion(readSkill(name))}, you started from ${skillVersion(source)}). Nothing applied, so that change isn't undone. Your draft is kept at ${file}; run tabkyra skill edit ${name} to start again from the new version (your draft moves to skill-drafts/.backups).`,
			);
			return true;
		};
		if (changedUnderneath()) return 1;
		const plan = planApply(dir);
		console.log(`${c.bold(`Change to ${plan.name}:`)}\n${plan.diff}\n`);
		if (!flags.yes && !/^y(es)?$/i.test(askLine("Apply? [y/N] "))) {
			console.log(`${sym.dot} Not applied. The draft is kept; apply it later with ${c.bold(later)} --yes`);
			return 3;
		}
		if (changedUnderneath()) return 1;
		return reportApplied(plan, `Applied your edit of ${plan.name}.`);
	}
	if (sub === "print") {
		const name = assertName(args[0] ?? "tabkyra");
		if (!allNames().includes(name)) throw new SkillError(`No skill named ${name}.${gone(name)} Run tabkyra skill list.`);
		// --raw: the exact SKILL.md source in use, the starting point for an edit.
		process.stdout.write(flags.raw ? skillText(name) : agentsSnippet(name));
		return 0;
	}
	if (sub === "list") {
		const list = listSkills();
		if (flags.json) {
			console.log(JSON.stringify(list));
			return 0;
		}
		for (const s of list) {
			const label = s.source === "community" ? s.provenance : s.overrides === "community" ? "your edit of the community skill" : s.overrides ? "your edit" : "your skill";
			const tag = s.source === "bundled" ? "" : c.dim(` (${label})`);
			console.log(`${c.bold(s.name.padEnd(18))} ${oneLine(s.description)}${tag}`);
		}
		const { problem } = loadCatalog();
		if (problem) console.log(`${sym.warn} Community skills are not in use: ${problem}`);
		for (const w of localWarnings()) console.log(`${sym.warn} ${w}`);
		return 0;
	}
	if (sub === "lint") {
		const findings = args.length === 0 ? [...SKILLS].flatMap(([name, text]) => lintText(`(bundled) ${name}`, text, { dirName: name })) : args.flatMap((p) => lintPath(p));
		// --community: also the community rules (skill-community.ts) for every SKILL.md under the paths.
		if (flags.community) for (const p of args) findings.push(...lintCommunityPath(p));
		const errors = findings.filter((f) => f.severity === "error");
		if (findings.length) console.log(formatFindings(findings));
		console.log(errors.length ? `${sym.fail} ${errors.length} problem${errors.length === 1 ? "" : "s"}. Fix each one; lint allows no exceptions.` : `${sym.ok} Clean.`);
		return errors.length ? 1 : 0;
	}
	if (sub === "apply") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill apply <folder with SKILL.md> [--yes]");
		const plan = planApply(args[0]);
		console.log(`${c.bold(`Change to ${plan.name}:`)}\n${plan.diff}\n`);
		if (!flags.yes) {
			console.log(`${sym.arrow} Lint passed. Nothing changed yet. Show this to the user; run again with --yes once they approve.`);
			return 3;
		}
		return reportApplied(plan, `Applied your edit of ${plan.name}.`);
	}
	if (sub === "revert") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill revert <name>");
		const name = assertName(args[0]);
		const { removed, results } = revertSkill(name);
		if (!removed) {
			console.log(`${sym.dot} ${name} has no local edit.`);
			return 1;
		}
		console.log(`${sym.ok} Reverted ${name}; the edit is kept in ${join(historyDir(), name)}.`);
		printInstall(results);
		return 0;
	}
	console.log(banner("skill"));
	for (const a of args) assertName(a);
	const unknown = args.find((a) => !allNames().includes(a));
	if (unknown) {
		console.log(`${sym.fail} No skill named ${unknown}.${gone(unknown)} Run tabkyra skill list.`);
		return 2;
	}
	const results = installSkills({ ...flags, only: args });
	printInstall(results);
	for (const w of localWarnings()) console.log(`${sym.warn} ${w}`);
	console.log(`\n${sym.arrow} Other agents: ${c.bold("tabkyra skill print [name] >> AGENTS.md")} adds the same text to a project.`);
	if (results.every((r) => r.state === "skipped")) {
		console.log(`${sym.fail} No Claude Code, Codex or OpenCode found.`);
		return 1;
	}
	return results.some((r) => r.state === "kept" || r.state === "linked") ? 1 : 0;
}
