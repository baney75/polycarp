// ask_user: the schema, the answer mapping, the no-answer paths (skip, Stop, timeout, a closed
// panel, a client that hangs up), and the bridge routing that keeps one agent's question from
// being answered by or for another.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnswer, noAnswer, outcomeText, validateAskParams } from "../src/ask/core.ts";
import { answerWaiting, isWaiting, skipWaiting, waitForAnswer } from "../src/ask/pending.ts";
import { browserMessageTransformer } from "../src/messages/message-transformer.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const q = (over = {}) => ({
	header: "Format",
	question: "Which format?",
	options: [
		{ label: "PDF (Recommended)", description: "Prints cleanly" },
		{ label: "Markdown", description: "Plain text" },
	],
	...over,
});

// ---- schema -------------------------------------------------------------------------------

test("valid questions pass, trimmed, with only the known fields", () => {
	const out = validateAskParams({ questions: [{ ...q(), header: "  Format ", extra: "x" }], other: 1 });
	assert.deepEqual(out, {
		questions: [
			{
				header: "Format",
				question: "Which format?",
				options: [
					{ label: "PDF (Recommended)", description: "Prints cleanly" },
					{ label: "Markdown", description: "Plain text" },
				],
				multiSelect: false,
			},
		],
	});
});

test("the schema refuses what the card can't show", () => {
	const bad = [
		[undefined, /object with a questions array/],
		[{ questions: [] }, /1 to 4 questions/],
		[{ questions: [q(), q({ question: "b" }), q({ question: "c" }), q({ question: "d" }), q({ question: "e" })] }, /1 to 4 questions/],
		[{ questions: [q({ options: [{ label: "Only", description: "" }] })] }, /2 to 4 options/],
		[{ questions: [q({ options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}`, description: "" })) })] }, /2 to 4 options/],
		[{ questions: [q({ header: "" })] }, /header must not be empty/],
		[{ questions: [q({ header: "x".repeat(25) })] }, /header is longer/],
		[{ questions: [q({ multiSelect: "yes" })] }, /multiSelect must be true or false/],
		[{ questions: [q({ options: [{ label: "A", description: "" }, { label: "other", description: "" }] })] }, /added automatically/],
		[{ questions: [q({ options: [{ label: "A", description: "" }, { label: "A", description: "" }] })] }, /repeats an earlier option/],
		[{ questions: [q(), q()] }, /repeats an earlier question/],
		[{ questions: [q({ options: [{ label: 3, description: "" }, { label: "B", description: "" }] })] }, /label must be a string/],
	];
	for (const [input, message] of bad) assert.throws(() => validateAskParams(input), message, JSON.stringify(input));
});

// ---- answer mapping ------------------------------------------------------------------------

test("answers map question to answer, for single, multiSelect and Other", () => {
	const questions = validateAskParams({
		questions: [
			q(),
			q({
				header: "Sections",
				question: "Which sections?",
				multiSelect: true,
				options: [
					{ label: "Summary", description: "" },
					{ label: "Prices", description: "" },
					{ label: "Sources", description: "" },
				],
			}),
			q({ header: "Tone", question: "Tone?" }),
		],
	}).questions;
	const out = buildAnswer(questions, [
		{ selected: ["Markdown"] },
		// Clicked out of order, and one twice: kept once, in the order offered.
		{ selected: ["Sources", "Summary", "Sources"], other: "  a chart " },
		{ selected: [], other: "Friendly but brief" },
	]);
	assert.deepEqual(out.answers, {
		"Which format?": "Markdown",
		"Which sections?": "Summary, Sources, Other: a chart",
		"Tone?": "Other: Friendly but brief",
	});
	assert.deepEqual(out.selections[1], { selected: ["Summary", "Sources"], other: "a chart" });
	const text = outcomeText(out);
	assert.match(text, /^The user answered:\n"Which format\?" = "Markdown"\n/);
	assert.match(text, /"Which sections\?" = "Summary, Sources, Other: a chart"/);
});

test("answers that don't fit the question are refused", () => {
	const questions = validateAskParams({ questions: [q()] }).questions;
	assert.throws(() => buildAnswer(questions, [{ selected: ["PDF (Recommended)", "Markdown"] }]), /takes one answer/);
	assert.throws(() => buildAnswer(questions, [{ selected: ["Markdown"], other: "and this" }]), /takes one answer/);
	assert.throws(() => buildAnswer(questions, [{ selected: ["Word"] }]), /unknown option/);
	assert.throws(() => buildAnswer(questions, [{ selected: [], other: "   " }]), /no answer/);
	assert.throws(() => buildAnswer(questions, []), /One selection per question/);
	assert.throws(() => buildAnswer(questions, [{ selected: [], other: "x".repeat(2001) }]), /longer than 2000/);
});

test("a no-answer result tells the model not to assume one", () => {
	for (const reason of ["skipped", "aborted", "timeout", "closed", "disconnected"]) {
		const text = outcomeText(noAnswer([], reason));
		assert.match(text, /^No answer: /);
		assert.match(text, /Do not assume an answer/);
	}
});

// ---- the side panel tool's wait -----------------------------------------------------------

const questions1 = validateAskParams({ questions: [q()] }).questions;

test("the card's answer settles the waiting tool call", async () => {
	const wait = waitForAnswer("call-1", questions1);
	assert.ok(isWaiting("call-1"));
	assert.throws(() => answerWaiting("call-1", [{ selected: ["Nope"] }]), /unknown option/);
	assert.ok(isWaiting("call-1"), "a bad answer leaves the question open");
	answerWaiting("call-1", [{ selected: ["Markdown"] }]);
	const out = await wait;
	assert.equal(out.status, "answered");
	assert.deepEqual(out.answers, { "Which format?": "Markdown" });
	assert.ok(!isWaiting("call-1"));
});

test("Skip and Stop end the wait with no answer", async () => {
	const skipped = waitForAnswer("call-2", questions1);
	skipWaiting("call-2");
	assert.deepEqual(await skipped, { status: "no_answer", reason: "skipped", questions: questions1 });

	const controller = new AbortController();
	const stopped = waitForAnswer("call-3", questions1, controller.signal);
	controller.abort();
	assert.equal((await stopped).reason, "aborted");
	// An answer after Stop changes nothing.
	answerWaiting("call-3", [{ selected: ["Markdown"] }]);

	const pre = new AbortController();
	pre.abort();
	assert.equal((await waitForAnswer("call-4", questions1, pre.signal)).reason, "aborted");
	assert.ok(!isWaiting("call-4"));
});

test("a question the panel closed on gets a no-answer result for the model", async () => {
	const call = { type: "toolCall", id: "t1", name: "ask_user", arguments: { questions: [q()] } };
	const messages = [
		{ role: "user", content: "pick one", timestamp: 1 },
		{ role: "assistant", content: [call], stopReason: "toolUse", timestamp: 2 },
		{ role: "user", content: "hello again", timestamp: 3 },
	];
	const out = await browserMessageTransformer(messages);
	assert.deepEqual(
		out.map((m) => m.role),
		["user", "assistant", "toolResult", "user"],
	);
	assert.equal(out[2].toolCallId, "t1");
	assert.match(out[2].content[0].text, /^No answer: the side panel was closed/);
	// An answered call is left alone.
	// A call in a message the user stopped mid-stream is dropped by pi-ai with its message; a result
	// for it would be an orphan.
	const stoppedMidStream = await browserMessageTransformer([
		messages[0],
		{ ...messages[1], stopReason: "aborted" },
		messages[2],
	]);
	assert.equal(stoppedMidStream.filter((m) => m.role === "toolResult").length, 0);
	const answered = await browserMessageTransformer([
		...messages.slice(0, 2),
		{ role: "toolResult", toolCallId: "t1", toolName: "ask_user", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
	]);
	assert.equal(answered.filter((m) => m.role === "toolResult").length, 1);
});

// ---- over the bridge ----------------------------------------------------------------------

async function startBridge() {
	const fake = installFakeChrome();
	const native = await import(`../src/bridge/native.ts?ask=${Math.random()}`);
	const askWorker = await import("../src/ask/bridge-worker.ts");
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	try {
		native.startBridge();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	const port = fake.ports[0];
	let nextId = 1;
	const replies = (clientId, id) => port.sent.filter((m) => m.type === "response" && m.clientId === clientId && m.id === id);
	const send = (clientId, method, params = {}) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId, id, method, params });
		return id;
	};
	const reply = async (clientId, id, ms = 2500) => {
		for (let i = 0; i < ms / 5; i++) {
			const r = replies(clientId, id)[0];
			if (r) return r;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`no reply ${clientId}#${id}`);
	};
	const until = async (fn, what) => {
		for (let i = 0; i < 400; i++) {
			const v = await fn();
			if (v) return v;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`timed out: ${what}`);
	};
	const settle = () => new Promise((r) => realSetTimeout(r, 60));
	const connect = (clientId, name, session) => port.deliver({ type: "client_connected", clientId, client: { name, session } });
	const pendingList = () => fake.session().bridge_pending_questions ?? [];
	return { fake, port, send, reply, replies, until, settle, connect, pendingList, askWorker };
}

test("a bridge question waits in the panel with a badge, and only its own client gets the answer", async () => {
	const b = await startBridge();
	b.connect("c1", "claude", "s1");
	b.connect("c2", "codex", "s2");
	const ask = b.send("c1", "ask_user", { questions: [q()] });
	const [p] = await b.until(() => (b.pendingList().length === 1 ? b.pendingList() : undefined), "pending question");
	assert.equal(p.clientId, "c1");
	assert.equal(p.agentName, "Claude Code");
	assert.ok(p.requestId.startsWith("c1:"));
	assert.equal(b.fake.badge().text, "1");
	assert.match(b.fake.badge().title, /Claude Code is asking/);

	// Another client can't answer it: no bridge method takes an answer.
	const viaPermission = await b.reply("c2", b.send("c2", "permission.respond", { requestId: p.requestId, decision: "allow_once" }));
	assert.equal(viaPermission.result?.accepted, false);
	const viaMethod = await b.reply("c2", b.send("c2", "ask.respond", { requestId: p.requestId, selections: [{ selected: ["Markdown"] }] }));
	assert.equal(viaMethod.error?.code, "not_found");
	// An answer under another id, or one that doesn't fit, is ignored.
	await chrome.storage.session.set({ "bridge_answer_c2:forged": { selections: [{ selected: ["Markdown"] }] } });
	await chrome.storage.session.set({ [`bridge_answer_${p.requestId}`]: { selections: [{ selected: ["Word"] }] } });
	await b.settle();
	assert.equal(b.replies("c1", ask).length, 0, "the question is still open");

	// The panel's answer goes to c1, and to nobody else.
	await chrome.storage.session.set({ [`bridge_answer_${p.requestId}`]: { selections: [{ selected: ["Markdown"] }] } });
	const r = await b.reply("c1", ask);
	assert.equal(r.result.status, "answered");
	assert.deepEqual(r.result.answers, { "Which format?": "Markdown" });
	assert.match(r.result.text, /^The user answered:/);
	assert.equal(b.port.sent.filter((m) => m.type === "response" && m.clientId === "c2" && m.result?.status).length, 0);
	await b.until(() => b.pendingList().length === 0, "pending cleared");
	await b.until(() => b.fake.badge().text === "", "badge cleared");
	assert.equal(b.fake.session()[`bridge_answer_${p.requestId}`], undefined);
});

test("a bridge question ends with no answer on Skip, on a hang-up and on bad arguments", async () => {
	const b = await startBridge();
	b.connect("c1", "claude", "s1");
	const skipped = b.send("c1", "ask_user", { questions: [q()] });
	const [p] = await b.until(() => (b.pendingList().length ? b.pendingList() : undefined), "pending");
	await chrome.storage.session.set({ [`bridge_answer_${p.requestId}`]: { skip: true } });
	const r1 = await b.reply("c1", skipped);
	assert.equal(r1.result.reason, "skipped");
	assert.match(r1.result.text, /^No answer: the user skipped/);

	await b.until(() => b.pendingList().length === 0, "cleared");
	const gone = b.send("c1", "ask_user", { questions: [q()] });
	await b.until(() => b.pendingList().length === 1, "pending again");
	b.port.deliver({ type: "client_disconnected", clientId: "c1" });
	const r2 = await b.reply("c1", gone);
	assert.equal(r2.result.reason, "disconnected");
	await b.until(() => b.pendingList().length === 0, "cleared after hang-up");

	b.connect("c3", "mcp", "s3");
	const bad = await b.reply("c3", b.send("c3", "ask_user", { questions: [q({ options: [] })] }));
	assert.equal(bad.error?.code, "bad_params");
	assert.match(bad.error.message, /2 to 4 options/);
});

test("a bridge question times out with a no-answer result", async () => {
	const b = await startBridge();
	const out = await b.askWorker.handleBridgeAsk({ clientId: "c9", name: "remote-cloud" }, { questions: [q()] }, 80);
	assert.equal(out.result.status, "no_answer");
	assert.equal(out.result.reason, "timeout");
	assert.match(out.result.text, /timed out/);
	await b.until(() => b.pendingList().length === 0, "cleared after timeout");
});

test("a waiting question doesn't hold up its client's other calls, and a cancel ends only that call", async () => {
	const b = await startBridge();
	b.connect("c1", "claude", "s1");
	b.connect("c2", "codex", "s2");
	const askA = b.send("c1", "ask_user", { questions: [q()], askId: "a" });
	const askB = b.send("c1", "ask_user", { questions: [q({ question: "Second?" })], askId: "b" });
	await b.until(() => b.pendingList().length === 2, "pending");
	const ctx = await b.reply("c1", b.send("c1", "tabs.context"));
	assert.equal(ctx.error, undefined, "a browser call goes on while the questions wait");

	// Another client naming c1's askId cancels nothing: the client id comes from the host.
	const other = await b.reply("c2", b.send("c2", "ask_user.cancel", { askId: "a" }));
	assert.equal(other.result.cancelled, 0);
	const none = await b.reply("c1", b.send("c1", "ask_user.cancel", {}));
	assert.equal(none.result.cancelled, 0, "a cancel names its call");
	await b.settle();
	assert.equal(b.replies("c1", askA).length + b.replies("c1", askB).length, 0, "both still open");

	const own = await b.reply("c1", b.send("c1", "ask_user.cancel", { askId: "a" }));
	assert.equal(own.result.cancelled, 1);
	assert.equal((await b.reply("c1", askA)).result.reason, "aborted");
	await b.settle();
	assert.equal(b.replies("c1", askB).length, 0, "the other call keeps waiting");
	await b.until(() => b.pendingList().length === 1, "one left");

	// Turning the bridge off ends what is left.
	await chrome.storage.local.set({ bridge_enabled: false });
	assert.equal((await b.reply("c1", askB)).result.reason, "disconnected");
	await b.until(() => b.pendingList().length === 0, "cleared");
});

test("a cancel that beats its question in ends it unseen, and one client can't flood the panel", async () => {
	const b = await startBridge();
	b.connect("c1", "claude", "s1");
	b.connect("c2", "codex", "s2");
	// The cancel skips the checks ask_user waits on, so it can arrive first.
	const early = await b.reply("c1", b.send("c1", "ask_user.cancel", { askId: "late" }));
	assert.equal(early.result.cancelled, 0);
	// The same askId from another client is a different call.
	const theirs = b.send("c2", "ask_user", { questions: [q()], askId: "late" });
	const r = await b.reply("c1", b.send("c1", "ask_user", { questions: [q()], askId: "late" }));
	assert.equal(r.result.reason, "aborted");
	await b.until(() => b.pendingList().length === 1, "only c2's question shows");
	assert.equal(b.pendingList()[0].clientId, "c2");
	assert.equal(b.replies("c2", theirs).length, 0);

	// At most MAX_OPEN_PER_CLIENT open questions per client.
	b.send("c1", "ask_user", { questions: [q()] });
	b.send("c1", "ask_user", { questions: [q()] });
	await b.until(() => b.pendingList().length === 3, "two from c1");
	const third = await b.reply("c1", b.send("c1", "ask_user", { questions: [q()] }));
	assert.equal(third.error?.code, "bad_params");
	assert.match(third.error.message, /already have 2 questions waiting/);
	assert.equal(b.pendingList().length, 3);
	b.port.deliver({ type: "client_disconnected", clientId: "c1" });
	b.port.deliver({ type: "client_disconnected", clientId: "c2" });
	await b.until(() => b.pendingList().length === 0, "cleared");
});
