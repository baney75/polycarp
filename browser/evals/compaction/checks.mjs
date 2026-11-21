// The compaction eval's checkers. Each reads only the run's record and the page's last state, never a model's opinion.

/** An error a call gets when what it relied on from before a compaction is gone: a ref, or a tab. */
export const LOST = /^(stale_ref|no_tab):/;

/** A reply that is no answer: claude stopped on the context, or said nothing. */
const DEAD = /Autocompact is thrashing|Prompt is too long|context (window|limit)/i;

/**
 * The four checks, as reasons a run failed (none means it passed):
 * - a compaction ran mid-task (without one the run proves nothing);
 * - no done step was done again (the page counts each repeat in `repeats`);
 * - no call after the first compaction lost a ref or a tab it needed;
 * - the chat ended with a real reply (no dead chat).
 * The task finishing is the task's own `state`, checked by the runner.
 */
export function compactionCheck(run, posted) {
	const why = [];
	const first = run.compactions?.[0];
	if (!first) why.push("no compaction ran");
	if ((posted?.repeats ?? 0) > 0) why.push(`a done step was done again (${posted.repeats})`);
	// Lost: the call's ref or tab came from an answer before a compaction that ran before the call. A ref no answer
	// handed out (from -1, a typo) is the model's slip, not compaction's.
	const before = (c, i) => c.from === undefined || (c.from >= 0 && run.compactions.some((k) => c.from < k.atCall && k.atCall <= i));
	const lost = first ? run.calls.filter((c, i) => i >= first.atCall && c.error && LOST.test(c.result ?? "") && before(c, i)) : [];
	if (lost.length) why.push(`after compaction ${lost.length} call(s) lost a ref or tab: ${lost.map((c) => c.tool).join(", ")}`);
	if (run.stop !== "success" || !run.final?.trim() || DEAD.test(run.final)) why.push(`dead chat (${run.stop}: ${String(run.final ?? "").slice(0, 80)})`);
	return { pass: why.length === 0, why };
}
