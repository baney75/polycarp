/**
 * Which browser session a `tabkyra mcp` process drives. The rule, first match wins:
 *
 * 1. `tabkyra mcp --session <name>`, then TABKYRA_SESSION: a name the user chose. Every client
 *    that gives it shares the session, across restarts of the harness.
 * 2. Otherwise the project: the git root of the working directory (or the directory itself),
 *    as "<folder>-<4 hex of its path>", so two folders with one name stay apart. Restarting the
 *    harness in the same project resumes its tabs instead of growing a new group. A second agent
 *    in the same project at the same time gets its own session ("<name>-2"), never a shared one.
 * 3. Not in a project (the root of the disk or the home folder, which a GUI harness often starts
 *    servers in, or a home folder that is itself a git repository): a session of this process
 *    alone, as before projects counted, so unrelated agents never resume each other's tabs.
 *
 * The extension prefixes the harness ("claude", "codex"), so Claude Code and Codex in one
 * project have separate sessions too.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export interface SessionChoice {
	/** The name sent in the hello; the session's id is "bridge-<harness>-<name>". */
	name: string;
	/** True for the project default (rule 2): the extension gives a concurrent second client its own. */
	auto: boolean;
	/** The project's folder name, for the group title ("claude · tabkyra"). */
	project?: string;
	/** The user chose the name (rule 1): it goes in the group title. */
	named?: boolean;
}

/** A name as the extension keys sessions: lowercase letters, digits, - and _, at most 64. */
export function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "project"
	);
}

/** The git root of `cwd`, or `cwd` when it isn't in a repository. */
export function projectRoot(cwd: string): string {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
		if (root) return resolve(root);
	} catch {
		/* not a repository, or no git */
	}
	return resolve(cwd);
}

export function chooseSession(
	options: { flag?: string; env?: NodeJS.ProcessEnv; cwd?: string; home?: string; pid?: number } = {},
): SessionChoice {
	const env = options.env ?? process.env;
	const named = options.flag || env.TABKYRA_SESSION;
	if (named) return { name: named, auto: false, named: true };
	const root = projectRoot(options.cwd ?? process.cwd());
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	if (real(root) === real(options.home ?? homedir()) || real(root) === real("/"))
		return { name: `p${options.pid ?? process.pid}-${Date.now().toString(36)}`, auto: false };
	const project = basename(root) || "root";
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 4);
	return { name: `${slug(project)}-${hash}`, auto: true, project };
}
