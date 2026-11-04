// The skill-judge-change label approves one version of the judge (cli/src/skill-eval.ts and
// cli/src/skill-router.ts). A push that changes either file voids it: a maintainer must look
// at the new judge and add the label again. This script decides from the GitHub API alone and
// never checks out or runs pull request code.
//
//   node judge-label.mjs check   exit 1 if this push changed the judge (CI, on synchronize)
//   node judge-label.mjs remove  remove the label if this push changed the judge
//                                (pull_request_target, on synchronize)
//
// Environment: GITHUB_TOKEN, REPO (owner/name), PR (number), BEFORE and AFTER (the push's SHAs).
import { pathToFileURL } from "node:url";

export const LABEL = "skill-judge-change";
export const JUDGE_FILES = ["cli/src/skill-eval.ts", "cli/src/skill-router.ts"];
/** GitHub's compare API lists at most this many files; a full list may be cut short. */
export const COMPARE_FILE_LIMIT = 300;

/**
 * Whether a push voids the approval. Fails closed: when the comparison failed or may be
 * incomplete, the answer is yes.
 */
export function pushChangesJudge({ files = [], failed = false }) {
	if (failed || files.length >= COMPARE_FILE_LIMIT) return true;
	return files.some((f) => {
		const names = typeof f === "string" ? [f] : [f.filename, f.previous_filename];
		return names.some((n) => JUDGE_FILES.includes(n));
	});
}

/** Whether there is a push to compare: synchronize events carry two real SHAs. */
export function hasPush(before, after) {
	const sha = /^[0-9a-f]{40}$/;
	return sha.test(before ?? "") && sha.test(after ?? "") && !/^0+$/.test(before);
}

async function api(path, init = {}) {
	return fetch(`https://api.github.com${path}`, {
		...init,
		headers: { accept: "application/vnd.github+json", authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "x-github-api-version": "2022-11-28", ...init.headers },
	});
}

async function compare(repo, before, after) {
	try {
		const r = await api(`/repos/${repo}/compare/${before}...${after}`);
		if (!r.ok) return { failed: true };
		const body = await r.json();
		return { files: Array.isArray(body.files) ? body.files : [], failed: !Array.isArray(body.files) };
	} catch {
		return { failed: true };
	}
}

async function main(mode) {
	const { REPO: repo, PR: pr, BEFORE: before, AFTER: after } = process.env;
	if (!hasPush(before, after)) {
		console.log("No push to compare; the label stands as it is.");
		return 0;
	}
	const changed = pushChangesJudge(await compare(repo, before, after));
	if (!changed) {
		console.log(`This push doesn't change ${JUDGE_FILES.join(" or ")}; an earlier ${LABEL} approval still holds.`);
		return 0;
	}
	if (mode === "check") {
		console.log(`::error::This push changes ${JUDGE_FILES.join(" or ")} (or couldn't be compared), so any earlier ${LABEL} approval no longer holds. A maintainer must review the new judge and add the label again.`);
		return 1;
	}
	if (mode === "remove") {
		const r = await api(`/repos/${repo}/issues/${pr}/labels/${LABEL}`, { method: "DELETE" });
		if (!r.ok && r.status !== 404) {
			console.log(`::error::Couldn't remove ${LABEL} (HTTP ${r.status}).`);
			return 1;
		}
		console.log(`Removed ${LABEL}: this push changes the judge. A maintainer must review it and add the label again.`);
		return 0;
	}
	console.log("Usage: node judge-label.mjs check|remove");
	return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv[2]);
