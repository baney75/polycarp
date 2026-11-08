// Who may start, stop, save and cancel a capture, and for how long: the rules around the browser work.
import assert from "node:assert/strict";
import test from "node:test";
import {
	CaptureError,
	CaptureManager,
	KEEP_ENDED_MS,
	MAX_CAPTURE_MS,
	MAX_FLIGHT_MS,
	MAX_PER_SESSION,
	MAX_VIDEOS,
} from "../src/browser/capture.ts";

/** A browser that records what it was asked and holds a little data per capture. */
function fakeBackend() {
	const log = { started: [], halted: [], discarded: [], finished: [], snapshots: [] };
	const ownership = new Map();
	const runFor = (id, kind) => ({
		async stats() {
			return { bytes: 10, ...(kind === "network" ? { entries: 2 } : { spanMs: 5000 }) };
		},
		async halt() {
			log.halted.push(id);
		},
		async finish() {
			log.finished.push(id);
			return kind === "network"
				? { file: { kind: "har", encoding: "json", data: { log: {} }, bytes: 20 }, notes: [], entries: 2 }
				: { file: { kind: "webm", encoding: "base64", data: "AAAA", bytes: 3 }, notes: [], durationMs: 5000 };
		},
		...(kind === "flight"
			? {
					async snapshot() {
						log.snapshots.push(id);
						return { file: { kind: "webm", encoding: "base64", data: "AAAA", bytes: 3 }, notes: [], durationMs: 60000 };
					},
				}
			: {}),
		async discard() {
			log.discarded.push(id);
		},
	});
	let onEnds = new Map();
	return {
		log,
		ownership,
		onEnds,
		async startNetwork(tabId, id, onEnd) {
			log.started.push(["network", tabId, id]);
			onEnds.set(id, onEnd);
			return runFor(id, "network");
		},
		async startVideo(tabId, id, mode, onEnd) {
			log.started.push([mode, tabId, id]);
			onEnds.set(id, onEnd);
			return runFor(id, mode);
		},
		async owns(sessionId, tabId) {
			return ownership.get(`${sessionId}:${tabId}`) ?? true;
		},
	};
}

function setup() {
	const backend = fakeBackend();
	let t = 1_000_000;
	let n = 0;
	const manager = new CaptureManager(backend, { now: () => t, newId: () => `c${++n}` });
	return { backend, manager, advance: (ms) => (t += ms) };
}
const alice = { id: "alice", tabIds: [10, 11, 12, 13, 14, 15] };
const bob = { id: "bob", tabIds: [20, 21] };

const refused = async (promise, code, pattern) => {
	await assert.rejects(promise, (err) => {
		assert.ok(err instanceof CaptureError, `a CaptureError, got ${err}`);
		assert.equal(err.code, code);
		if (pattern) assert.match(err.message, pattern);
		return true;
	});
};

test("a session cannot start a capture on a tab that is not its own, and nothing starts", async () => {
	const { backend, manager } = setup();
	for (const action of ["network_start", "record_start", "flight_start"])
		await refused(manager.run(bob, { action, tabId: 10 }), "not_found", /Tab 10 is not one of your tabs/);
	assert.deepEqual(backend.log.started, []);
	assert.equal(manager.size, 0);
	// Its own tab works, so the refusal above is about ownership and not a broken fake.
	const ok = await manager.run(bob, { action: "network_start", tabId: 20 });
	assert.equal(ok.tabId, 20);
	assert.equal(backend.log.started.length, 1);
});

test("another session's capture is invisible: status, stop, save and cancel treat its id as unknown", async () => {
	const { backend, manager } = setup();
	const a = await manager.run(alice, { action: "network_start", tabId: 10 });
	const v = await manager.run(alice, { action: "flight_start", tabId: 11 });
	assert.deepEqual((await manager.run(bob, { action: "status" })).captures, []);
	assert.deepEqual((await manager.run(alice, { action: "status" })).captures.map((c) => c.id).sort(), [a.id, v.id].sort());
	const unknown = await manager.run(bob, { action: "network_stop", id: "nope" }).catch((e) => e);
	for (const [action, id] of [["network_stop", a.id], ["flight_save", v.id], ["record_stop", v.id], ["cancel", a.id]]) {
		const err = await manager.run(bob, { action, id }).catch((e) => e);
		assert.ok(err instanceof CaptureError, `${action} by another session was refused`);
		assert.equal(err.code, "not_found");
		assert.equal(err.message.replace(id, "X"), unknown.message.replace("nope", "X"), "no hint that the id exists");
	}
	// Nothing happened to Alice's captures: no stop, no save, no cancel reached the browser.
	assert.deepEqual([backend.log.finished, backend.log.snapshots, backend.log.discarded, backend.log.halted], [[], [], [], []]);
	assert.equal((await manager.run(alice, { action: "status" })).captures.length, 2);
	// Cancel with no id cancels the caller's own, never another session's.
	await manager.run(bob, { action: "network_start", tabId: 20 });
	const cancelled = await manager.run(bob, { action: "cancel" });
	assert.equal(cancelled.cancelled.length, 1);
	assert.equal((await manager.run(alice, { action: "status" })).captures.length, 2);
});

test("stop without an id means the session's only capture of that kind; two need an id", async () => {
	const { manager } = setup();
	await refused(manager.run(alice, { action: "network_stop" }), "bad_params", /no network capture/);
	const a = await manager.run(alice, { action: "network_start", tabId: 10 });
	const b = await manager.run(alice, { action: "network_start", tabId: 11 });
	await refused(manager.run(alice, { action: "network_stop" }), "bad_params", new RegExp(`${a.id}, ${b.id}`));
	await refused(manager.run(alice, { action: "record_stop", id: a.id }), "bad_params", /network capture, not a recording/);
	const done = await manager.run(alice, { action: "network_stop", id: a.id });
	assert.equal(done.file.kind, "har");
	assert.equal((await manager.run(alice, { action: "network_stop" })).id, b.id, "now b is the only one");
});

test("one network capture and one video per tab; saving a flight recorder keeps it recording", async () => {
	const { backend, manager } = setup();
	await manager.run(alice, { action: "network_start", tabId: 10 });
	await refused(manager.run(alice, { action: "network_start", tabId: 10 }), "bad_params", /network capture running/);
	await manager.run(alice, { action: "flight_start", tabId: 10 });
	await refused(manager.run(alice, { action: "record_start", tabId: 10 }), "bad_params", /recording or flight recorder running/);
	const first = await manager.run(alice, { action: "flight_save" });
	assert.equal(first.stillRecording, true);
	assert.equal(first.file.kind, "webm");
	await manager.run(alice, { action: "flight_save" });
	assert.equal(backend.log.snapshots.length, 2);
	assert.equal((await manager.run(alice, { action: "status" })).captures.find((c) => c.kind === "flight").saves, 2);
	// A recording is finished by its stop and is gone after.
	await manager.run(alice, { action: "cancel" });
	await manager.run(alice, { action: "record_start", tabId: 12 });
	const rec = await manager.run(alice, { action: "record_stop" });
	assert.equal(rec.file.kind, "webm");
	assert.equal((await manager.run(alice, { action: "status" })).captures.length, 0);
});

test("limits: captures per session and videos in the browser", async () => {
	const { manager } = setup();
	for (let i = 0; i < MAX_PER_SESSION; i++) await manager.run(alice, { action: "network_start", tabId: 10 + i });
	await refused(manager.run(alice, { action: "network_start", tabId: 14 }), "bad_params", new RegExp(`${MAX_PER_SESSION} captures`));
	await manager.run(alice, { action: "cancel" });
	const many = { id: "many", tabIds: [30, 31, 32, 33] };
	for (let i = 0; i < MAX_VIDEOS; i++) await manager.run(many, { action: "record_start", tabId: 30 + i });
	await refused(manager.run(many, { action: "flight_start", tabId: 33 }), "bad_params", /videos are being recorded/);
	await refused(manager.run(bob, { action: "record_start", tabId: 20 }), "bad_params", /videos are being recorded/);
	// A network capture is not a video.
	await manager.run(bob, { action: "network_start", tabId: 20 });
});

test("a network capture or recording stops by itself after 10 minutes, a flight recorder after 30, and the data stays", async () => {
	const { backend, manager, advance } = setup();
	const net = await manager.run(alice, { action: "network_start", tabId: 10 });
	const rec = await manager.run(alice, { action: "record_start", tabId: 11 });
	const fl = await manager.run(alice, { action: "flight_start", tabId: 12 });
	advance(MAX_CAPTURE_MS - 1000);
	await manager.sweep();
	assert.deepEqual(backend.log.halted, [], "still inside the limit");
	advance(1000);
	await manager.sweep();
	assert.deepEqual(backend.log.halted.sort(), [net.id, rec.id].sort());
	const status = (await manager.run(alice, { action: "status" })).captures;
	assert.equal(status.find((c) => c.id === net.id).state, "ended");
	assert.match(status.find((c) => c.id === net.id).endedBy, /10 minute limit/);
	assert.equal(status.find((c) => c.id === fl.id).state, "running");
	// Its owner can still save what it held, and is told why it stopped.
	const saved = await manager.run(alice, { action: "network_stop", id: net.id });
	assert.equal(saved.file.kind, "har");
	assert.match(saved.notes[0], /had ended early: it reached its 10 minute limit/);
	advance(MAX_FLIGHT_MS - MAX_CAPTURE_MS);
	await manager.sweep();
	assert.ok(backend.log.halted.includes(fl.id));
	assert.match((await manager.run(alice, { action: "status" })).captures.find((c) => c.id === fl.id).endedBy, /30 minute limit/);
});

test("an ended capture is thrown away after 30 minutes if nobody saves it", async () => {
	const { backend, manager, advance } = setup();
	const net = await manager.run(alice, { action: "network_start", tabId: 10 });
	advance(MAX_CAPTURE_MS);
	await manager.sweep();
	advance(KEEP_ENDED_MS - 1000);
	await manager.sweep();
	assert.deepEqual(backend.log.discarded, []);
	advance(1000);
	await manager.sweep();
	assert.deepEqual(backend.log.discarded, [net.id]);
	await refused(manager.run(alice, { action: "network_stop", id: net.id }), "not_found");
});

test("a tab that leaves the session ends its captures, and one that closes does too, keeping what they held", async () => {
	const { backend, manager } = setup();
	const a = await manager.run(alice, { action: "network_start", tabId: 10 });
	const v = await manager.run(alice, { action: "record_start", tabId: 11 });
	const keep = await manager.run(alice, { action: "network_start", tabId: 12 });
	backend.ownership.set("alice:10", false); // given away to the user
	await manager.sweep();
	manager.tabClosed(11);
	const status = (await manager.run(alice, { action: "status" })).captures;
	assert.deepEqual(status.map((c) => [c.id, c.state]), [[a.id, "ended"], [v.id, "ended"], [keep.id, "running"]]);
	assert.match(status[0].endedBy, /no longer one of the session's/);
	assert.match(status[1].endedBy, /tab was closed/);
	assert.deepEqual(backend.log.halted.sort(), [a.id, v.id].sort());
	const saved = await manager.run(alice, { action: "record_stop", id: v.id });
	assert.equal(saved.file.kind, "webm");
	assert.match(saved.notes[0], /tab was closed/);
});

test("the browser ending a capture on its own (the debugger left) is the same: kept, ended, saved on request", async () => {
	const { backend, manager } = setup();
	const a = await manager.run(alice, { action: "network_start", tabId: 10 });
	backend.onEnds.get(a.id)("the debugger was detached");
	assert.equal((await manager.run(alice, { action: "status" })).captures[0].state, "ended");
	const saved = await manager.run(alice, { action: "network_stop" });
	assert.match(saved.notes[0], /debugger was detached/);
});

test("a session that is gone loses its captures; others keep theirs", async () => {
	const { backend, manager } = setup();
	const a = await manager.run(alice, { action: "network_start", tabId: 10 });
	await manager.run(bob, { action: "network_start", tabId: 20 });
	await manager.sweep();
	await manager.sessionGone("alice");
	assert.deepEqual(backend.log.discarded, [a.id]);
	assert.equal(manager.size, 1);
});

test("actions are checked: an unknown action, and no tab", async () => {
	const { manager } = setup();
	await refused(manager.run(alice, { action: "stream" }), "bad_params", /action must be one of/);
	await refused(manager.run(alice, {}), "bad_params");
	await refused(manager.run(alice, { action: "network_start" }), "no_tab");
});
