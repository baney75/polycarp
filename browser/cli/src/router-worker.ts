/**
 * The skill router as a module of its own, for `tabkyra skill eval --router`. CI builds this
 * shim (from the base branch) around a pull request's skill-router.ts. The judge runs it in a
 * child process under Node's permission model: a small fixed loader reads the bundle and the
 * request from stdin and imports the bundle from memory, so the router needs no file access
 * and its size isn't limited by the command line. The request holds skill texts and tasks
 * only, never the labels. The reply is the top skill (or "none") for each task, and how long
 * each match took; the judge times the whole process too and doesn't trust these alone.
 */

import { buildRouterIndex, matchSkills, type RouterSkill } from "./skill-router.ts";

export interface RouterRequest {
	skills: RouterSkill[];
	tasks: string[];
	rounds: number;
}

export function rank(request: RouterRequest): { buildMs: number; top: string[]; timesMs: number[] } {
	const started = performance.now();
	const index = buildRouterIndex(request.skills);
	const buildMs = performance.now() - started;
	const top: string[] = [];
	const timesMs: number[] = [];
	for (let r = 0; r < Math.max(1, request.rounds); r++) {
		for (const task of request.tasks) {
			const t0 = performance.now();
			const name = matchSkills(index, task, 1)[0]?.name ?? "none";
			timesMs.push(performance.now() - t0);
			if (r === 0) top.push(name);
		}
	}
	return { buildMs, top, timesMs };
}
