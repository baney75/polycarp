// Console capture after a gap: Runtime.enable replays the page's history, and the buffer must keep
// what it has, add what it missed (marked replayed), and not bring back what was read and cleared.
import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleBuffer, MAX_ENTRIES } from "../src/browser/console-buffer.ts";

const e = (text, timestamp, contextId = 1, level = "log") => ({ text, timestamp, contextId, level });
const texts = (entries) => entries.map((x) => x.text);

test("a replayed entry already in the buffer (same time and document) is not added twice", () => {
	const b = new ConsoleBuffer();
	b.add(e("one", 100));
	b.startReplay(1000, true);
	b.add(e("one", 100));
	b.add(e("two", 200));
	const out = b.read(false, 2000);
	assert.deepEqual(texts(out), ["one", "two"]);
	assert.equal(out[0].replayed, undefined);
	assert.equal(out[1].replayed, true);
	assert.equal(out[1].timestamp, 200, "the page's time, not the replay's");
});

test("the same text from a new page during the gap is kept, not mistaken for the old entry", () => {
	const b = new ConsoleBuffer();
	b.add(e("ready", 100, 1));
	b.startReplay(1000, true);
	b.add(e("ready", 500, 2));
	assert.deepEqual(
		b.read(false, 2000).map((x) => [x.text, x.contextId === undefined, x.replayed]),
		[["ready", true, undefined], ["ready", true, true]],
	);
});

test("messages that were read and cleared do not come back in a replay", () => {
	const b = new ConsoleBuffer();
	b.add(e("old", 100));
	assert.deepEqual(texts(b.read(true, 150)), ["old"]);
	b.startReplay(1000, true);
	b.add(e("old", 100));
	b.add(e("during-gap", 300));
	assert.deepEqual(texts(b.read(false, 2000)), ["during-gap"]);
});

test("history older than the capped buffer is not added back as if from the gap", () => {
	const b = new ConsoleBuffer();
	for (let i = 1; i <= MAX_ENTRIES + 10; i++) b.add(e(`m${i}`, i));
	b.startReplay(10_000, true);
	for (let i = 1; i <= 10; i++) b.add(e(`m${i}`, i));
	const out = b.read(false, 20_000);
	assert.equal(out.length, MAX_ENTRIES);
	assert.equal(out[0].text, "m11");
	assert.ok(out.every((x) => !x.replayed));
});

test("after a restart the buffer is empty and everything replayed is marked replayed", () => {
	const b = new ConsoleBuffer();
	b.startReplay(1000, true);
	b.add(e("before-restart", 100));
	b.add(e("also-before", 200));
	assert.ok(b.read(false, 2000).every((x) => x.replayed === true));
});

test("the first start keeps history unmarked, and live entries after it are plain", () => {
	const b = new ConsoleBuffer();
	b.startReplay(1000, false);
	b.add(e("history", 100));
	b.add(e("live", 1500));
	const out = b.read(false, 2000);
	assert.deepEqual(texts(out), ["history", "live"]);
	assert.ok(out.every((x) => x.replayed === undefined));
});

test("the context id is internal: reads do not show it", () => {
	const b = new ConsoleBuffer();
	b.add(e("x", 1, 7));
	assert.equal("contextId" in b.read(false, 2)[0], false);
});
