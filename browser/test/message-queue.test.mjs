// The side panel's message queue: messages sent while the agent runs, and "Send now".
import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageQueue } from "../node_modules/@mariozechner/pi-web-ui/dist/utils/message-queue.js";

const settle = () => new Promise((r) => setTimeout(r, 10));
const end = (stopReason = "stop") => [{ role: "assistant", stopReason }];
const text = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join(""));

/** A fake agent with a run lifecycle; `result` decides what each send reports. */
function setup({ result = () => "started", context } = {}) {
	let idle = Promise.resolve();
	let finish = () => {};
	const agent = {
		state: { isStreaming: false, messages: [] },
		steered: [],
		steer(m) { this.steered.push(m); },
		clearSteeringQueue() { this.steered = []; },
		waitForIdle: () => idle,
	};
	const sent = [];
	const queue = new MessageQueue(
		agent,
		async (item) => { const r = result(item); if (r === "started") { sent.push(item.input); start(); } return r; },
		() => {},
		context,
	);
	function start() { agent.state.isStreaming = true; idle = new Promise((r) => (finish = r)); queue.onAgentStart(); }
	function stop(stopReason) { agent.state.isStreaming = false; queue.onAgentEnd(end(stopReason)); finish(); }
	return { agent, sent, queue, start, stop, finish: () => finish() };
}

test("messages sent while the agent runs go out in order, one per finished run", async () => {
	const { sent, queue, start, stop } = setup();
	start();
	queue.add("first");
	queue.add("second");
	assert.deepEqual(sent, []);
	stop();
	await settle();
	assert.deepEqual(sent, ["first"]);
	stop();
	await settle();
	assert.deepEqual(sent, ["first", "second"]);
	assert.equal(queue.items.length, 0);
});

test("the next item waits for the agent's idle signal", async () => {
	const { agent, sent, queue, start } = setup();
	start();
	queue.add("next");
	let release;
	agent.waitForIdle = () => new Promise((r) => (release = r));
	agent.state.isStreaming = false;
	queue.onAgentEnd(end());
	await settle();
	assert.deepEqual(sent, [], "not before idle");
	release();
	await settle();
	assert.deepEqual(sent, ["next"]);
});

test("Send now steers the running agent; the item leaves the list once injected and can't be removed before", async () => {
	const { agent, sent, queue, start } = setup();
	start();
	queue.add("a");
	queue.add("b");
	await queue.sendNow(queue.items[1].id);
	assert.equal(agent.steered.length, 1);
	assert.equal(text(agent.steered[0]), "b");
	assert.deepEqual(sent, []);
	queue.remove(queue.items[1].id);
	assert.equal(queue.items.length, 2);
	queue.onMessageStart(agent.steered[0]);
	assert.deepEqual(queue.items.map((q) => q.input), ["a"]);
});

test("Send now delivers the page context first", async () => {
	const note = { role: "navigation", url: "https://example.com/" };
	const { agent, queue, start } = setup({ context: async () => [note] });
	start();
	queue.add("what does this page say?");
	await queue.sendNow(queue.items[0].id);
	assert.equal(agent.steered[0], note);
	assert.equal(text(agent.steered[1]), "what does this page say?");
});

test("a Send now the agent never picked up goes out before older items", async () => {
	const { agent, sent, queue, start, stop } = setup();
	start();
	queue.add("a");
	queue.add("b");
	await queue.sendNow(queue.items[1].id);
	stop();
	assert.deepEqual(agent.steered, [], "the agent's steering queue is cleared");
	await settle();
	assert.deepEqual(sent, ["b"]);
	stop();
	await settle();
	assert.deepEqual(sent, ["b", "a"]);
});

test("Send now right after a run ends is sent once, not steered into the finished run", async () => {
	const { agent, sent, queue, start, stop } = setup();
	start();
	queue.add("a");
	queue.add("b");
	stop(); // agent_end has fired; the drain hasn't sent yet
	await queue.sendNow(queue.items[1].id);
	await settle();
	assert.deepEqual(agent.steered, [], "nothing steered into the finished run");
	assert.deepEqual(sent, ["b"], "b first, once");
	assert.deepEqual(queue.items.map((q) => q.input), ["a"]);
});

test("Stop pauses; removing doesn't resume; Send now resumes, also when it steers a new run", async () => {
	const { sent, queue, start, stop } = setup();
	start();
	queue.add("one");
	queue.add("two");
	queue.add("three");
	stop("aborted");
	await settle();
	assert.equal(queue.paused, true);
	queue.remove(queue.items[0].id);
	await settle();
	assert.deepEqual(sent, []);
	// The user sends a fresh message; the queue stays paused through that run...
	start();
	// ...until Send now, which steers into it and resumes.
	await queue.sendNow(queue.items[1].id);
	assert.equal(queue.paused, false);
	stop(); // ended before the steer was picked up
	await settle();
	assert.deepEqual(sent, ["three"]);
	stop();
	await settle();
	assert.deepEqual(sent, ["three", "two"]);
});

test("a refused send goes back on top and pauses; a busy one goes back without pausing", async () => {
	let answer = "refused";
	const { sent, queue, start, stop } = setup({ result: () => answer });
	start();
	queue.add("x");
	queue.add("y");
	stop();
	await settle();
	assert.deepEqual(queue.items.map((q) => q.input), ["x", "y"]);
	assert.equal(queue.paused, true);
	answer = "busy";
	await queue.sendNow(queue.items[0].id);
	await settle();
	assert.deepEqual(queue.items.map((q) => q.input), ["x", "y"]);
	assert.equal(queue.paused, false);
	answer = "started";
	stop();
	await settle();
	assert.deepEqual(sent, ["x"]);
});

test("an error pauses the queue, and an empty queue is never paused", () => {
	const { queue, start, stop } = setup();
	start();
	queue.add("x");
	stop("error");
	assert.equal(queue.paused, true);
	queue.remove(queue.items[0].id);
	assert.equal(queue.paused, false);
});

test("dispose clears the agent's steering and the list", async () => {
	const { agent, queue, start } = setup();
	start();
	queue.add("a");
	await queue.sendNow(queue.items[0].id);
	queue.dispose();
	assert.deepEqual(agent.steered, []);
	assert.equal(queue.items.length, 0);
});

test("an item queued behind a send that never started goes out on kick", async () => {
	let answer = "busy";
	const { sent, queue, start, stop } = setup({ result: () => answer });
	start();
	queue.add("waiting");
	stop(); // drain tries; another send holds the panel
	await settle();
	assert.deepEqual(sent, []);
	assert.equal(queue.paused, false);
	answer = "started"; // that send ended without a run (key prompt cancelled): it kicks the queue
	queue.kick();
	await settle();
	assert.deepEqual(sent, ["waiting"]);
});

test("Send now whose page context resolves after a Stop still resumes and sends", async () => {
	let release;
	const { sent, queue, start, stop } = setup({ context: () => new Promise((r) => (release = () => r([]))) });
	start();
	queue.add("old");
	queue.add("mine");
	const pressed = queue.sendNow(queue.items[1].id);
	stop("aborted");
	release();
	await pressed;
	await settle();
	assert.deepEqual(sent, ["mine"], "the Send now item goes first");
	assert.equal(queue.paused, true, "the Stop holds the item that wasn't pressed");
});

test("Send now whose page context resolves after a normal end goes before older items", async () => {
	let release;
	const { sent, queue, start, stop } = setup({ context: () => new Promise((r) => (release = () => r([]))) });
	start();
	queue.add("old");
	queue.add("mine");
	const pressed = queue.sendNow(queue.items[1].id);
	stop();
	release();
	await pressed;
	await settle();
	assert.deepEqual(sent, ["mine"]);
});

test("the page context goes with the first Send now in a run only", async () => {
	const note = { role: "navigation", url: "https://example.com/" };
	let calls = 0;
	const { agent, queue, start, stop } = setup({ context: async () => { calls++; return [note]; } });
	start();
	queue.add("a");
	queue.add("b");
	await queue.sendNow(queue.items[0].id);
	await queue.sendNow(queue.items[1].id);
	assert.equal(agent.steered.filter((m) => m === note).length, 1, "the same note isn't steered twice");
	assert.equal(calls, 2, "each Send now looks the page up, to catch a page change");
	stop();
	start();
	queue.add("c");
	await queue.sendNow(queue.items.at(-1).id);
	assert.equal(agent.steered.filter((m) => m === note).length, 1, "a new run gets its own note");
});

test("unpicked Send now items go out in the order they were pressed", async () => {
	const { sent, queue, start, stop } = setup();
	start();
	queue.add("a");
	queue.add("b");
	await queue.sendNow(queue.items[1].id); // b first
	await queue.sendNow(queue.items[0].id); // then a
	stop();
	await settle();
	assert.deepEqual(sent, ["b"]);
	stop();
	await settle();
	assert.deepEqual(sent, ["b", "a"]);
});

test("a Stop with nothing queued doesn't pause what is queued later", async () => {
	const { sent, queue, start, stop } = setup();
	start();
	stop("aborted"); // the user stops a run with an empty queue
	assert.equal(queue.paused, false);
	start(); // later run
	queue.add("follow-up");
	stop();
	await settle();
	assert.deepEqual(sent, ["follow-up"]);
	// an error with an empty queue doesn't pause either
	start();
	stop("error");
	assert.equal(queue.paused, false);
});

test("Send now items promoted while the run ended keep press order", async () => {
	const releases = [];
	const { sent, queue, start, stop } = setup({ context: () => new Promise((r) => releases.push(() => r([]))) });
	start();
	queue.add("a");
	queue.add("b");
	queue.add("c");
	const pressA = queue.sendNow(queue.items[0].id);
	const pressB = queue.sendNow(queue.items[1].id); // contextSent is still false: both look up
	stop();
	releases[0]?.();
	await pressA;
	releases[1]?.();
	await pressB;
	await settle();
	assert.deepEqual(sent, ["a"], "a was pressed first");
	stop();
	await settle();
	assert.deepEqual(sent, ["a", "b"]);
});

test("an item removed while its Send now context was built doesn't stall the rest", async () => {
	let release;
	const { sent, queue, start, stop } = setup({ context: () => new Promise((r) => (release = () => r([]))) });
	start();
	queue.add("x");
	queue.add("y");
	const pressed = queue.sendNow(queue.items[0].id);
	stop(); // drain stands down for the pending Send now
	queue.remove(queue.items[0].id);
	release();
	await pressed;
	await settle();
	assert.deepEqual(sent, ["y"]);
});

test("sync after missed events recovers a queue that thought a run was still going", async () => {
	const { agent, sent, queue, start, finish } = setup();
	start();
	queue.add("waiting");
	await queue.sendNow(queue.items[0].id); // steered into the run
	// The panel was disconnected; the run ended without the queue hearing agent_end.
	agent.state.isStreaming = false;
	finish();
	queue.sync();
	await settle();
	assert.deepEqual(agent.steered, []);
	assert.deepEqual(sent, ["waiting"]);
});

test("a Send now message injected while the panel wasn't listening isn't sent again", async () => {
	const { agent, sent, queue, start, finish } = setup();
	start();
	queue.add("x");
	await queue.sendNow(queue.items[0].id);
	agent.state.messages.push(agent.steered[0]); // injected, but message_start was missed
	agent.state.isStreaming = false;
	agent.state.messages.push({ role: "assistant", stopReason: "stop" });
	finish();
	queue.sync();
	await settle();
	assert.deepEqual(sent, [], "not sent twice");
	assert.equal(queue.items.length, 0);
});

test("a Stop holds only what was waiting; later items still go out", async () => {
	const { sent, queue, start, stop } = setup();
	start();
	queue.add("x");
	stop("aborted");
	assert.equal(queue.paused, true);
	start(); // the user sends something fresh
	queue.add("z");
	stop();
	await settle();
	assert.deepEqual(sent, ["z"]);
	assert.deepEqual(queue.items.map((q) => q.input), ["x"], "x stays held");
	assert.equal(queue.paused, true);
});

test("a Stop missed while the panel wasn't listening still holds the queue", async () => {
	const { agent, sent, queue, start, finish } = setup();
	start();
	queue.add("x");
	agent.state.isStreaming = false;
	agent.state.messages.push({ role: "assistant", stopReason: "aborted" });
	finish();
	queue.sync();
	await settle();
	assert.deepEqual(sent, []);
	assert.equal(queue.paused, true);
});

test("Send now then Stop: the pressed item still goes, whatever the page lookup's timing", async () => {
	for (const slowContext of [false, true]) {
		let release = () => {};
		const context = slowContext ? () => new Promise((r) => (release = () => r([]))) : async () => [];
		const { sent, queue, start, stop } = setup({ context });
		start();
		queue.add("other");
		queue.add("pressed");
		const pressed = queue.sendNow(queue.items[1].id);
		stop("aborted");
		release();
		await pressed;
		await settle();
		assert.deepEqual(sent, ["pressed"], `slow context: ${slowContext}`);
		assert.equal(queue.paused, true, "the unpressed item is held");
	}
});

test("an item that comes back from a send stays behind items pressed meanwhile", async () => {
	let finishSend;
	let answer = "busy";
	const { sent, queue, start, stop } = setup({ result: () => answer });
	// a send that takes a while (key dialog), then reports busy
	start();
	queue.add("x");
	queue.add("y");
	const realSend = queue["send"];
	queue["send"] = (item) => new Promise((r) => (finishSend = () => r(realSend(item))));
	stop();
	await settle(); // drain took x and is waiting on its send
	await queue.sendNow(queue.items.find((q) => q.input === "y").id); // y pressed while x is out
	finishSend(); // x comes back busy; it goes behind y, and the drain asked for by Send now runs
	await settle();
	assert.deepEqual(queue.items.map((q) => q.input), ["x"], "y is out next, x waits behind it");
	answer = "started";
	finishSend(); // y's send goes through
	await settle();
	assert.deepEqual(sent, ["y"]);
});

test("the page note goes again when the page changed between two Send nows", async () => {
	let url = "https://a.example/";
	const { agent, queue, start } = setup({ context: async () => [{ role: "navigation", url }] });
	start();
	queue.add("one");
	queue.add("two");
	queue.add("three");
	await queue.sendNow(queue.items[0].id);
	await queue.sendNow(queue.items[1].id); // same page: no second note
	url = "https://b.example/";
	await queue.sendNow(queue.items[2].id); // page changed: note again
	assert.deepEqual(agent.steered.filter((m) => m.role === "navigation").map((m) => m.url), ["https://a.example/", "https://b.example/"]);
});

test("Send now pressed while the drain is mid-send isn't lost when that send is refused", async () => {
	let answerX;
	const { sent, queue, start, stop } = setup({ result: (item) => (item.input === "x" ? answerX : "started") });
	const realSend = queue["send"];
	let finishX;
	queue["send"] = (item) => (item.input === "x" ? new Promise((r) => (finishX = () => r(realSend(item)))) : realSend(item));
	start();
	queue.add("x");
	queue.add("y");
	stop();
	await settle(); // drain took x; its send waits on a key dialog
	await queue.sendNow(queue.items.find((q) => q.input === "y").id); // asks for a drain while one runs
	answerX = "refused"; // the user cancels the dialog
	finishX();
	await settle();
	assert.deepEqual(sent, ["y"], "y still goes");
	assert.equal(queue.paused, true, "x is held");
});

test("after the page note is injected, a later Send now on that page gets a note again if the agent moved away", async () => {
	const noteA = () => ({ role: "navigation", url: "https://a.example/" });
	let next = noteA();
	const { agent, queue, start } = setup({ context: async () => [next] });
	start();
	queue.add("one");
	queue.add("two");
	await queue.sendNow(queue.items[0].id);
	const first = agent.steered[0];
	queue.onMessageStart(first); // note A injected
	// the agent navigated to B, the tab came back to A: the panel's check returns a fresh note for A
	next = noteA();
	await queue.sendNow(queue.items[1].id);
	assert.equal(agent.steered.filter((m) => m.role === "navigation").length, 2);
});

test("a queue disposed while its send was out doesn't take the item back", async () => {
	let finishSend;
	const { queue, start, stop } = setup({ result: () => "busy" });
	const realSend = queue["send"];
	queue["send"] = (item) => new Promise((r) => (finishSend = () => r(realSend(item))));
	start();
	queue.add("x");
	stop();
	await settle(); // x is out
	queue.dispose(); // the panel switched chats
	finishSend();
	await settle();
	assert.equal(queue.items.length, 0);
});
