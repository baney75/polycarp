// The compaction eval's checkers (evals/compaction/checks.mjs) and the transcript fields they read, without a model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionCheck } from "../evals/compaction/checks.mjs";

const ok = { stop: "success", final: "Done: 9 items flagged.", compactions: [{ atCall: 4, pre: 31000, post: 6000 }], calls: [] };
const call = (tool, result, error = true, from) => ({ tool, result, error, from });

test("a run that compacted, repeated nothing, lost nothing and replied passes", () => {
	assert.deepEqual(compactionCheck(ok, { repeats: 0 }), { pass: true, why: [] });
});

test("each failure the eval scores is named", () => {
	const why = (run, posted = { repeats: 0 }) => compactionCheck({ ...ok, ...run }, posted).why.join("; ");
	assert.match(why({ compactions: undefined }), /no compaction ran/);
	assert.match(compactionCheck(ok, { repeats: 2 }).why.join(), /done again \(2\)/);
	// A lost ref before compaction is the page's doing, after it the summary's.
	assert.equal(why({ calls: [call("click", "stale_ref: ref 5 is gone")] }), "");
	assert.match(why({ calls: [call("read_page", "x", false), call("read_page", "x", false), call("read_page", "x", false), call("read_page", "x", false), call("click", "stale_ref: gone")] }), /lost a ref or tab: click/);
	assert.match(why({ calls: [...Array(4).fill(call("read_page", "x", false)), call("tabs_select", "no_tab: tab 3 is closed")] }), /tabs_select/);
	// A ref handed out before a compaction is lost; a typo no answer handed out, or a ref handed out again since, is not.
	const reads = Array(4).fill(call("read_page", "x", false));
	assert.match(why({ calls: [...reads, call("click", "stale_ref: gone", true, 2)] }), /lost a ref/);
	assert.equal(why({ calls: [...reads, call("click", "stale_ref: gone", true, -1)] }), "");
	assert.equal(why({ calls: [...reads, call("click", "stale_ref: gone", true, 4)] }), "");
	assert.match(why({ final: "Autocompact is thrashing: the context refilled" }), /dead chat/);
	assert.match(why({ stop: "error_max_turns" }), /dead chat/);
	assert.match(why({ final: "  " }), /dead chat/);
});

test("the transcript records which answer handed out the ref or tab a call names", async () => {
	const { Transcript } = await import("../evals/weak-model/transcript.mjs");
	const t = new Transcript({ copies: false });
	const use = (id, input) => t.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__polycarp__click", input }] } });
	const answer = (id, content) => t.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
	use("a", {});
	answer("a", `e1 checkbox "x" ${"y".repeat(2000)} e2 button tab 269578585`);
	use("b", { ref: "e2" });
	use("c", { tabId: 269578585 });
	use("d", { ref: "e878032878032439" });
	assert.deepEqual(t.calls.map((c) => c.from), [undefined, 0, 0, -1]);
});
