// A model request that goes quiet ends with an error (issue 365, case 2); on main nothing timed one out.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

const { watchStream, stalledMessage } = await import("../src/models/stream-watchdog.ts");
const model = { api: "openai-completions", provider: "cerebras", id: "qwen", contextWindow: 32000, maxTokens: 4096 };
const context = { systemPrompt: "", messages: [], tools: [] };
const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => "still waiting")]);

/** A stream that sends `start` and then nothing, and records the signal it was given. */
function quiet() {
	const seen = {};
	const fn = (_m, _c, options) => {
		seen.signal = options.signal;
		const s = createAssistantMessageEventStream();
		s.push({ type: "start", partial });
		return s;
	};
	return { fn, seen };
}

test("a stream that goes quiet ends with an error, and its request is aborted", async () => {
	const { fn, seen } = quiet();
	const result = await within(watchStream(fn, 40)(model, context, {}).result(), 2000);
	assert.notEqual(result, "still waiting");
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, stalledMessage(40));
	assert.equal(seen.signal.aborted, true);
	const never = () => new Promise(() => {});
	assert.equal((await within(watchStream(never, 40)(model, context, {}).result(), 2000)).stopReason, "error", "no stream at all");
});

test("a stream that keeps sending is never cut, however long it runs", async () => {
	const fn = () => {
		const s = createAssistantMessageEventStream();
		void (async () => {
			s.push({ type: "start", partial });
			for (let i = 0; i < 8; i++) {
				await sleep(20);
				s.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
			}
			s.push({ type: "done", reason: "stop", message: { ...partial, content: [{ type: "text", text: "ok" }] } });
		})();
		return s;
	};
	const out = watchStream(fn, 60)(model, context, {});
	const types = [];
	for await (const e of out) types.push(e.type);
	assert.equal(types.at(-1), "done", "160 ms in all, never 60 ms quiet");
	assert.equal((await out.result()).content[0].text, "ok");
});

test("the person's Stop reaches the request, and a stream that ignores it still ends as aborted", async () => {
	const { fn, seen } = quiet();
	const stop = new AbortController();
	const out = watchStream(fn, 60_000)(model, context, { signal: stop.signal });
	await sleep(5);
	stop.abort();
	assert.equal(seen.signal.aborted, true);
	const result = await within(out.result(), 7000);
	assert.equal(result.stopReason, "aborted");
});

test("the panel's stream function, which the compaction summary uses too, is watched", () => {
	const src = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	assert.match(src, /const streamFn = watchStream\(\s*guardContext\(/);
	assert.match(src, /summarize: streamSummarizer\(streamFn,/);
});
