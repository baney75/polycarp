/**
 * `tabkyra skill submit`: propose a skill to the community library as a pull request from the
 * user's own GitHub account (docs/decisions.md D27, CONTRIBUTING-skills.md).
 *
 * 1. Refuse without a signed-in `gh` (one-line fix), and refuse any personal data in the skill,
 *    its cases or the note (D6). Nothing is rewritten behind the user's back.
 * 2. Clone the target repository (blobless, sparse) and run what CI runs: the lint, the
 *    community rules and the regression eval with the skill added.
 * 3. Show the preview: the exact files, the pull request title and body with the scrubbed
 *    evidence, and a code. Nothing is sent. Exit 3.
 * 4. Only `--confirm <code>` from that preview sends it: fork, push a branch to the fork, open
 *    the pull request. A changed skill or case file changes the code, so a yes covers exactly
 *    what the user saw. `--dry-run` does everything but the push and the pull request.
 *
 * Agents prepare (MCP skill_manage, action prepare_submit); only the user's yes submits. Merging is a
 * maintainer's call, never automatic.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseSites, privateNames, scanPersonal, scrubOutput } from "./skill-community.ts";
import { parseFrontmatter } from "./skill-lint.ts";
import { assertName, type CheckResult, casesFor, checkSkill, readSkill, SkillError, stagedCasesFile, skillVersion } from "./skill.ts";
import { SKILLS } from "./skills-catalog.ts";
import { c, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_REPO = "baney75/tabkyra";

export class SubmitError extends Error {
	readonly code: number;
	constructor(message: string, code = 1) {
		super(message);
		this.code = code;
	}
}

export interface SubmitOptions {
	/** A skill name in use (local or community), or a folder holding SKILL.md. */
	target: string;
	cases?: string;
	repo?: string;
	branch?: string;
	note?: string;
	dryRun?: boolean;
	confirm?: string;
	json?: boolean;
}

export interface Preview {
	code: string;
	name: string;
	repo: string;
	branch: string;
	update: boolean;
	files: Array<{ path: string; text: string }>;
	title: string;
	body: string;
	check: CheckResult;
	/** The clone the checks ran in; the caller removes it. */
	dir: string;
}

/** `gh` on PATH and signed in to github.com, or why not with the one-line fix. */
export function ghProblem(): string | undefined {
	const version = spawnSync("gh", ["--version"], { encoding: "utf8", timeout: 10000 });
	if (version.error || version.status !== 0) return "GitHub CLI (gh) isn't installed. Fix: install it from https://cli.github.com, then run gh auth login.";
	const auth = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { encoding: "utf8", timeout: 15000 });
	if (auth.status !== 0) return "gh isn't signed in to GitHub. Fix: run gh auth login, then submit again.";
	return undefined;
}

function run(cmd: string, args: string[], options: { cwd?: string; input?: string } = {}): string {
	const r = spawnSync(cmd, args, { cwd: options.cwd, input: options.input, encoding: "utf8", timeout: 180000 });
	if (r.error) throw new SubmitError(`${cmd} didn't run: ${r.error.message}`);
	if (r.status !== 0) throw new SubmitError(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
	return r.stdout.trim();
}

/** A blobless, sparse clone of the target: only skills/, skills-eval/ and community/ are checked out. */
function cloneTarget(repo: string, branch: string): string {
	const url = process.env.TABKYRA_SUBMIT_REMOTE || `https://github.com/${repo}.git`;
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-submit-"));
	try {
		run("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--filter=blob:none", "--sparse", "--branch", branch, url, join(dir, "repo")]);
		run("git", ["sparse-checkout", "set", "skills", "skills-eval", "community"], { cwd: join(dir, "repo") });
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
	return join(dir, "repo");
}

/** The skill to submit: from a folder, or the text in use (a local skill or a local copy of a community one). */
function resolveSkill(target: string): { name: string; text: string } {
	const isFolder = target.includes("/") || existsSync(target);
	if (isFolder) {
		const file = basename(target) === "SKILL.md" ? target : join(target, "SKILL.md");
		if (!existsSync(file)) throw new SubmitError(`No SKILL.md at ${target}.`);
		const text = readFileSync(file, "utf8");
		const name = parseFrontmatter(text)?.name ?? "";
		assertName(name);
		if (basename(dirname(file)) !== name) throw new SubmitError(`The folder holding SKILL.md must be named ${name}.`);
		return { name, text };
	}
	const name = assertName(target);
	return { name, text: readSkill(name) };
}

/** Normalize cases to one JSON object per line, in the order given. */
function normalizeCases(text: string): string {
	return `${text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			const v = JSON.parse(l) as { task: string; skill: string };
			return JSON.stringify({ task: v.task, skill: v.skill });
		})
		.join("\n")}\n`;
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Everything up to the preview. Throws SubmitError when the skill can't be submitted. */
export function prepareSubmission(options: SubmitOptions, ghLogin?: string): Preview {
	const repo = options.repo ?? DEFAULT_REPO;
	const branch = options.branch ?? "main";
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SubmitError(`--repo takes owner/name, not ${repo}.`);
	if (!/^[\w./-]+$/.test(branch) || branch.includes("..")) throw new SubmitError(`--branch ${branch} is not a branch name.`);
	const { name, text } = resolveSkill(options.target);
	if (SKILLS.has(name)) {
		throw new SubmitError(`${name} is a built-in skill. Changes to it go through a pull request to skills/${name} (the fix skill writes one); community submissions take a name of their own.`);
	}
	const casesText = casesFor(name, options.cases);
	if (!casesText?.trim()) {
		throw new SubmitError(
			`No router cases for ${name}. Write 8 or more, one {"task": "...", "skill": "${name}"} per line in the user's words, plus near misses as {"task": "...", "skill": "none"}, then pass --cases <file> (MCP skill_manage takes them as a list).`,
		);
	}
	let cases: string;
	try {
		cases = normalizeCases(casesText);
	} catch {
		throw new SubmitError("The cases file must hold one JSON object per line.");
	}
	// D6: personal data refuses the submission outright, in the skill, its cases and the note.
	const names = privateNames(ghLogin ? [ghLogin] : []);
	const personal = [
		...scanPersonal(text, names).map((p) => `SKILL.md line ${p.line}: ${p.kind} (${p.match})`),
		...scanPersonal(cases, names).map((p) => `cases line ${p.line}: ${p.kind} (${p.match})`),
		...scanPersonal(options.note ?? "", names).map((p) => `note: ${p.kind} (${p.match})`),
	];
	if (personal.length) {
		throw new SubmitError(`Not submitted: it holds personal data, and a skill with personal data is never shared (decision D6).\n${personal.map((p) => `  ${p}`).join("\n")}\nRewrite those lines in general terms (tabkyra skill write), then try again.`);
	}
	const dir = cloneTarget(repo, branch);
	try {
		const check = checkSkill({ name, text }, { cases, root: dir, community: true, names });
		if (!check.ok) throw new SubmitError(`Not submitted: the checks CI runs failed. Fix these, then try again.\n${stripAnsi(check.lines.join("\n"))}`);
		const update = existsSync(join(dir, "community", "skills", name, "SKILL.md"));
		const files = [
			{ path: `community/skills/${name}/SKILL.md`, text },
			{ path: `community/cases/${name}.jsonl`, text: cases },
		];
		const code = createHash("sha256").update(JSON.stringify({ repo, branch, name, text, cases, note: options.note ?? "" })).digest("hex").slice(0, 10);
		const description = parseFrontmatter(text)?.description ?? "";
		const sites = parseSites(text)?.sites ?? [];
		const evidence = scrubOutput(stripAnsi(check.lines.join("\n")), names);
		const caseCount = cases.split("\n").filter((l) => l.trim()).length;
		const title = `Community skill: ${name}${update ? " (update)" : ""}`;
		const body = [
			`Submitted with \`tabkyra skill submit\` (Tabkyra ${VERSION}).`,
			"",
			`- **Skill:** \`${name}\` (${update ? "update" : "new"}), version \`${skillVersion(text)}\``,
			`- **Sites:** ${sites.join(", ")}`,
			`- **What it does:** ${description}`,
			"",
			`The submitter saw this exact preview (code \`${code}\`) and approved it. A maintainer reviews and merges; CI runs the lint, the community safety rules, the regression eval and the judge.`,
			"",
			"### Checks run before submitting",
			"",
			"```text",
			evidence,
			"```",
			"",
			"### Tested on a page",
			"",
			options.note ? scrubOutput(options.note, names) : "Not stated.",
			"",
			"### Files",
			"",
			`- \`community/skills/${name}/SKILL.md\``,
			`- \`community/cases/${name}.jsonl\` (${caseCount} cases)`,
		].join("\n");
		return { code, name, repo, branch, update, files, title, body, check, dir };
	} catch (err) {
		rmSync(dirname(dir), { recursive: true, force: true });
		throw err;
	}
}

/** The preview a person reads before saying yes. */
export function renderPreview(p: Preview, options: { target: string; cases?: string; dryRun?: boolean; ghProblem?: string }): string {
	const rule = "-".repeat(72);
	const command = ["tabkyra skill submit", options.target, ...(options.cases ? ["--cases", options.cases] : []), ...(p.repo !== DEFAULT_REPO ? ["--repo", p.repo] : []), ...(p.branch !== "main" ? ["--branch", p.branch] : []), ...(options.dryRun ? ["--dry-run"] : []), "--confirm", p.code].join(" ");
	return [
		`${c.bold("Submission preview")} ${options.dryRun ? "(dry run)" : ""}`,
		`Pull request to ${p.repo} (base ${p.branch}) from a fork on your GitHub account, branch community/${p.name}-${p.code}.`,
		"",
		...p.files.flatMap((f) => [c.bold(`${f.path}`), rule, f.text.trimEnd(), rule, ""]),
		c.bold(`Title: ${p.title}`),
		rule,
		p.body,
		rule,
		"",
		...(options.ghProblem ? [`${sym.warn} ${options.ghProblem}`] : []),
		`${sym.arrow} Nothing was sent. Show this preview to the user. Only if they say yes to it, run:`,
		`  ${command}`,
		`Code: ${p.code}`,
	].join("\n");
}

/** Push the clone's commit to the user's fork and open the pull request; returns its URL. */
function openPullRequest(p: Preview): string {
	const login = run("gh", ["api", "user", "--jq", ".login"]);
	const repoName = p.repo.split("/")[1];
	run("gh", ["repo", "fork", p.repo, "--clone=false", "--remote=false"]);
	let fork = "";
	for (let i = 0; i < 15 && !fork; i++) {
		const r = spawnSync("gh", ["api", `repos/${login}/${repoName}`, "--jq", ".parent.full_name // \"\""], { encoding: "utf8", timeout: 15000 });
		if (r.status === 0) {
			if (r.stdout.trim().toLowerCase() !== p.repo.toLowerCase()) throw new SubmitError(`${login}/${repoName} exists but is not a fork of ${p.repo}. Rename it, then submit again.`);
			fork = `${login}/${repoName}`;
		} else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
	}
	if (!fork) throw new SubmitError(`GitHub didn't create the fork ${login}/${repoName} in time. Try again in a minute.`);
	const branch = `community/${p.name}-${p.code}`;
	commit(p, login);
	run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "--quiet", `https://github.com/${fork}.git`, `HEAD:refs/heads/${branch}`], { cwd: p.dir });
	const bodyFile = join(dirname(p.dir), "body.md");
	writeFileSync(bodyFile, p.body);
	return run("gh", ["pr", "create", "--repo", p.repo, "--base", p.branch, "--head", `${login}:${branch}`, "--title", p.title, "--body-file", bodyFile]);
}

function commit(p: Preview, login?: string): void {
	for (const f of p.files) {
		mkdirSync(dirname(join(p.dir, f.path)), { recursive: true });
		writeFileSync(join(p.dir, f.path), f.text);
	}
	run("git", ["add", "--sparse", "--", ...p.files.map((f) => f.path)], { cwd: p.dir });
	// The user's own git identity; without one, their GitHub noreply address (or a dry-run name).
	const hasIdentity = spawnSync("git", ["config", "user.email"], { cwd: p.dir, encoding: "utf8" }).stdout.trim() !== "";
	const identity = hasIdentity ? [] : ["-c", `user.name=${login ?? "Tabkyra dry run"}`, "-c", `user.email=${login ? `${login}@users.noreply.github.com` : "dry-run@example.invalid"}`];
	run("git", [...identity, "commit", "--quiet", "-m", `${p.title}\n\nSubmitted with tabkyra skill submit; preview code ${p.code}.`], { cwd: p.dir });
}

export async function runSubmit(options: SubmitOptions): Promise<number> {
	let preview: Preview | undefined;
	try {
		// A real submission needs gh first, so nothing is cloned or checked for a submit that can't happen.
		const gh = ghProblem();
		if (gh && !options.dryRun) throw new SubmitError(`Not submitted: ${gh}`);
		const login = gh ? undefined : spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 15000 }).stdout?.trim() || undefined;
		preview = prepareSubmission(options, login);
		if (!options.confirm) {
			if (options.json) console.log(JSON.stringify({ state: "preview", code: preview.code, title: preview.title, body: preview.body, files: preview.files }));
			else console.log(renderPreview(preview, { target: options.target, cases: options.cases, dryRun: options.dryRun, ghProblem: gh }));
			return 3;
		}
		if (options.confirm !== preview.code) {
			throw new SubmitError(`Not submitted: code ${options.confirm} doesn't match this submission (now ${preview.code}). The skill, its cases or the note changed since that preview, or the code is wrong. Show the new preview to the user and ask again.`);
		}
		if (options.dryRun) {
			commit(preview);
			const stat = run("git", ["show", "--stat", "--format=%s", "HEAD"], { cwd: preview.dir });
			console.log(`${sym.ok} Dry run: committed in a scratch clone; nothing was pushed and no pull request was opened.\n${stat}`);
			console.log(`${sym.dot} A real run pushes community/${preview.name}-${preview.code} to your fork of ${preview.repo} and opens the pull request "${preview.title}".`);
			return 0;
		}
		const url = openPullRequest(preview);
		console.log(`${sym.ok} Opened ${url}`);
		console.log(`${sym.dot} A maintainer reviews it; CI runs the same checks. Nothing merges on its own.`);
		return 0;
	} catch (err) {
		if (!(err instanceof SubmitError) && !(err instanceof SkillError)) throw err;
		console.error(`${sym.fail} ${err.message}`);
		return err instanceof SubmitError ? err.code : 1;
	} finally {
		if (preview) rmSync(dirname(preview.dir), { recursive: true, force: true });
	}
}

/** For MCP skill_manage prepare_submit: keep the cases where `skill submit` finds them. */
export function stageCases(name: string, cases: Array<{ task: string; skill: string }>): string {
	const file = stagedCasesFile(name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${cases.map((c) => JSON.stringify({ task: c.task, skill: c.skill })).join("\n")}\n`);
	return file;
}
