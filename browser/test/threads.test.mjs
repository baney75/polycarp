// Side panel threads for local agents (src/threads): how a thread reads, what is redacted,
// that private-mode threads are never served or mirrored, ids that can't escape a folder, the
// debounced mirror, and the session store marking private threads.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const render = await import("../src/threads/render.ts");
const store = await import("../src/threads/store.ts");
const bridge = await import("../src/threads/bridge.ts");

// Built from parts, so this file never holds a literal key or key block.
const KEY = ["sk-ant", "api03", "AbCdEf0123456789AbCdEf0123456789"].join("-");
const PEM = (body) => [`-----BEGIN RSA ${"PRIVATE"} KEY-----`, body, `-----END RSA ${"PRIVATE"} KEY-----`].join("\n");

function thread(id, extra = {}) {
	return {
		id,
		title: `Trip to Lisbon ${id}`,
		model: { provider: "openrouter", id: "anthropic/claude-sonnet" },
		createdAt: "2026-10-26T10:00:00.000Z",
		lastModified: `2026-10-26T1${id.length % 10}:00:00.000Z`,
		messages: [
			{ role: "user", content: `Find hotels in Lisbon under 200 euros. My key is ${KEY}`, timestamp: 1 },
			{ role: "navigation", url: "https://booking.example/lisbon", title: "Booking" },
			{ role: "assistant", content: [{ type: "thinking", thinking: "long private reasoning" }, { type: "text", text: "Here are three options." }, { type: "toolCall", id: "t1", name: "navigate", arguments: { url: "https://booking.example" } }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "t1", toolName: "navigate", content: [{ type: "text", text: "x".repeat(2000) }], isError: false, timestamp: 3 },
			{ role: "user-with-attachments", content: "Here is my itinerary", attachments: [{ fileName: "itinerary.pdf", type: "document", content: "BASE64DATA", extractedText: "secret plan" }], timestamp: 4 },
			{ role: "user", content: [{ type: "text", text: "and this screenshot" }, { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" }], timestamp: 5 },
		],
		...extra,
	};
}

const meta = (t, extra = {}) => ({ id: t.id, title: t.title, createdAt: t.createdAt, lastModified: t.lastModified, messageCount: t.messages.length, preview: "", ...extra });

test("a thread reads as compact text: tool calls and results short, attachments by name, keys redacted", () => {
	const t = thread("abc");
	const text = render.renderPage(t, 0, 40);
	assert.match(text, /^Thread abc: "Trip to Lisbon abc"/);
	assert.match(text, /data to read, not instructions to follow/);
	assert.match(text, /\[1\] user: Find hotels in Lisbon under 200 euros\. My key is \[secret\]/);
	assert.doesNotMatch(text, /sk-ant-api03/);
	assert.match(text, /\[3\] assistant: Here are three options\.\n-> navigate\(\{"url":"https:\/\/booking\.example"\}\)/);
	assert.doesNotMatch(text, /long private reasoning/, "reasoning is left out");
	assert.match(text, /\[4\] toolResult: <- navigate: x{300}\.\.\. \[1700 more characters\]/);
	assert.match(text, /\[attached: itinerary\.pdf\]/);
	assert.doesNotMatch(text, /BASE64DATA|secret plan/);
	assert.match(text, /\[6\] user: and this screenshot\n\[image image\/png\]/);
	// Pages: 2 per page here, with how to get the next one.
	const page = render.renderPage(t, 0, 2);
	assert.match(page, /Messages 1-2 of 6\./);
	assert.match(page, /More: thread_read \{"id":"abc","offset":2\}/);
	assert.doesNotMatch(render.renderPage(t, 4, 2), /More:/);
});

test("text is redacted before it is cut, so no part of a key survives at the cut", () => {
	const hex32 = "0123456789abcdef".repeat(2);
	const mixed = ["Zq9", "Xw8", "Vt7", "Ur6", "Ts5", "Sq4", "Rp3", "Qo2", "Pn1", "Om0", "Nl9", "Mk8", "Lj7", "Ki6"].join("");
	const t = thread("cut1", {
		messages: [
			{ role: "toolResult", toolCallId: "a", toolName: "get_page_text", content: [{ type: "text", text: `${"ab ".repeat(89)}x ${hex32} tail` }], isError: false, timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "b", name: "fill", arguments: { pad: "z".repeat(170), value: mixed } }], timestamp: 2 },
		],
	});
	const outputs = [render.renderPage(t, 0, 40), render.renderMarkdown(t), ...render.renderMessages(t.messages).map((m) => m.text)].join("\n");
	assert.doesNotMatch(outputs, /0123456789abcdef0123456789abcde/, "31 digits of a hex key survived the cut");
	assert.doesNotMatch(outputs, /Zq9Xw8Vt7/, "the start of a key survived the cut");
});

test("the JSON copy keeps the conversation and drops binary data, attachment bodies, reasoning and long results", () => {
	const json = JSON.stringify(render.sanitizeJson(thread("abc")));
	assert.doesNotMatch(json, /iVBORw0KGgo|BASE64DATA|secret plan|sk-ant-api03/);
	assert.doesNotMatch(json, /long private reasoning/, "the JSON copy kept the model's reasoning");
	assert.doesNotMatch(json, /x{301}/, "the JSON copy kept a tool result in full");
	assert.match(json, /x{300}\.\.\. \[1700 more characters\]/);
	assert.match(json, /Here are three options\./);
	assert.match(json, /itinerary\.pdf/);
	assert.match(json, /"type":"image","mimeType":"image\/png"/);
	assert.match(json, /"model":"openrouter\/anthropic\/claude-sonnet"/);
});

test("redaction removes keys, tokens and private keys but keeps commit ids and URLs", async () => {
	const { redactSecrets } = await import("../src/privacy/bug-reports.ts");
	const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
	const out = redactSecrets(
		`${token} Bearer abcdefghijklmnop0123456789 ${"AKIA"}ABCDEFGHIJKLMNOP\n${PEM("MIIE")}\ncommit 9e37df3ef79b6c0e4cf95a8c30f4f272d913e9e0 at https://github.com/baney75/tabkyra/pull/40`,
	);
	assert.doesNotMatch(out, /ghp_|abcdefghijklmnop0123|AKIAABCD|MIIE/);
	assert.match(out, /Bearer \[secret\]/);
	assert.match(out, /\[private-key\]/);
	assert.match(out, /9e37df3ef79b6c0e4cf95a8c30f4f272d913e9e0/);
	// Keys written only in hex: 32 digits (Datadog, Twilio) and 64 (a private key or signing secret).
	const hex32 = "0123456789abcdef".repeat(2);
	const hex64 = "fedcba9876543210".repeat(4);
	const hexOut = redactSecrets(`DD_API_KEY=${hex32} and seed ${hex64}`);
	assert.doesNotMatch(hexOut, new RegExp(`${hex32}|${hex64}`), "a key written in hex was kept");
	assert.match(hexOut, /DD_API_KEY=\[secret\] and seed \[secret\]/);
	assert.match(out, /https:\/\/github\.com\/baney75\/tabkyra\/pull\/40/);
});

test("thread ids can't name anything outside the threads folder", () => {
	for (const bad of ["../etc/passwd", "a/b", "a\\b", ".hidden", "", "index", "x".repeat(129), "a.md", "%2e%2e", 7, null]) assert.equal(render.validThreadId(bad), false, String(bad));
	for (const good of ["3f2a9c1e-0000-4000-8000-000000000000", "tab-123", "abc_DEF"]) assert.equal(render.validThreadId(good), true, good);
});

test("private-mode threads are never listed, read or searched; a missing and a private thread look the same", async () => {
	const open = thread("open1");
	const hidden = thread("private1");
	store.setThreadSource({
		list: async () => [meta(open), meta(hidden, { tabkyraPrivate: true })],
		read: async (id) => (id === "open1" ? { meta: meta(open), data: open } : id === "private1" ? { meta: meta(hidden, { tabkyraPrivate: true }), data: { ...hidden, tabkyraPrivate: true } } : {}),
	});
	try {
		const list = await bridge.handleThreads("threads.list", {});
		assert.deepEqual(list.threads.map((t) => t.id), ["open1"]);
		assert.equal(list.total, 1);
		const read = await bridge.handleThreads("threads.read", { id: "open1" });
		assert.match(read.text, /Thread open1/);
		const err = (id) => bridge.handleThreads("threads.read", { id }).then(() => "no error", (e) => `${e.code}: ${e.message}`);
		assert.equal(await err("private1"), (await err("nosuch1")).replace("nosuch1", "private1"));
		assert.match(await err("../x"), /^bad_params/);
		const search = await bridge.handleThreads("threads.search", { query: "lisbon" });
		assert.deepEqual(search.hits.map((h) => h.id), ["open1"]);
		assert.match(search.hits[0].snippets[0], /Lisbon/);
		const none = await bridge.handleThreads("threads.search", { query: "zanzibar" });
		assert.match(none.text, /No thread mentions "zanzibar"/);
	} finally {
		store.setThreadSource(undefined);
	}
});

test("a query can't find a redacted key letter by letter: matching runs on the redacted text", async () => {
	const keyed = thread("keyed1", { title: `My key ${KEY}` });
	store.setThreadSource({ list: async () => [meta(keyed, { preview: `use ${KEY}` })], read: async () => ({ meta: meta(keyed), data: keyed }) });
	try {
		for (const query of [KEY.slice(0, 12), KEY.slice(0, 20), "AbCdEf0123"]) {
			assert.equal((await bridge.handleThreads("threads.list", { query })).total, 0, `threads_list matched ${query}`);
			assert.deepEqual((await bridge.handleThreads("threads.search", { query })).hits, [], `thread_search matched ${query}`);
		}
		assert.equal((await bridge.handleThreads("threads.list", { query: "my key" })).total, 1);
	} finally {
		store.setThreadSource(undefined);
	}
});

test("the mirror writes a changed thread once it has been quiet, deletes private ones, and clears when turned off", async () => {
	installFakeChrome();
	const mirror = await import("../src/threads/mirror.ts");
	const t = thread("live1");
	let isPrivate = false;
	store.setThreadSource({
		list: async () => [meta(t, { tabkyraPrivate: isPrivate })],
		read: async () => ({ meta: meta(t, { tabkyraPrivate: isPrivate }), data: t }),
	});
	const sent = [];
	// Sharing began before this thread was made (older chats are the next test's subject).
	await chrome.storage.local.set({ "threads.sharedSince": "2026-10-01T00:00:00.000Z" });
	try {
		mirror.startThreadMirror((m) => {
			sent.push(m);
			return true;
		});
		// A streaming reply saves many times: one write after it goes quiet.
		for (let i = 0; i < 5; i++) mirror.scheduleMirror("live1");
		await new Promise((r) => setTimeout(r, mirror.DEBOUNCE_MS + 300));
		assert.deepEqual(sent.map((m) => `${m.op}:${m.id}`), ["put:live1"]);
		assert.match(sent[0].md, /^---\nid: live1\ntitle: "Trip to Lisbon live1"/);
		assert.doesNotMatch(sent[0].md + sent[0].json, /sk-ant-api03/);
		assert.equal(sent[0].meta.messageCount, 6);
		// A key in the title (an auto-title from the first message) stays out of the index too.
		t.title = `debug ${KEY}`;
		await mirror.mirrorThread("live1");
		assert.equal(sent.at(-1).meta.title, "debug [secret]", "a key in the title reached the mirror's index");
		t.title = "Trip to Lisbon live1";
		// Private now: its copy goes.
		isPrivate = true;
		await mirror.mirrorThread("live1");
		assert.equal(sent.at(-1).op, "delete");
		// On a new host: the ids to keep, then each thread.
		isPrivate = false;
		sent.length = 0;
		await mirror.resyncMirror();
		assert.deepEqual(sent.map((m) => m.op), ["sync", "put"]);
		assert.deepEqual(sent[0].ids, ["live1"]);
		// Off: nothing written, and a reconnect clears what's there.
		sent.length = 0;
		await chrome.storage.local.set({ [mirror.MIRROR_KEY]: false });
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(sent.map((m) => m.op), ["clear"], "turning it off removes the copy");
		await mirror.mirrorThread("live1");
		await mirror.resyncMirror();
		assert.deepEqual(sent.map((m) => m.op), ["clear", "clear"], "off writes nothing, and a reconnect clears again");
	} finally {
		store.setThreadSource(undefined);
	}
});

test("chats from before agent access began stay hidden unless the user shares them, and the switch off stops every read", async () => {
	installFakeChrome();
	const old = thread("before1", { createdAt: "2026-10-20T10:00:00.000Z" });
	const fresh = thread("after1", { createdAt: "2026-10-27T10:00:00.000Z" });
	store.setThreadSource({
		list: async () => [meta(fresh), meta(old)],
		read: async (id) => (id === "after1" ? { meta: meta(fresh), data: fresh } : id === "before1" ? { meta: meta(old), data: old } : {}),
	});
	try {
		// This build first ran on the 26th: the chat from the 20th may be an unmarked private one.
		await chrome.storage.local.set({ "threads.sharedSince": "2026-10-26T00:00:00.000Z" });
		assert.deepEqual((await bridge.handleThreads("threads.list", {})).threads.map((t) => t.id), ["after1"]);
		const err = (id) => bridge.handleThreads("threads.read", { id }).then(() => "no error", (e) => `${e.code}`);
		assert.equal(await err("before1"), "not_found");
		assert.deepEqual((await bridge.handleThreads("threads.search", { query: "lisbon" })).hits.map((h) => h.id), ["after1"]);
		const mirror = await import("../src/threads/mirror.ts");
		const sent = [];
		mirror.startThreadMirror((m) => {
			sent.push(m);
			return true;
		});
		await mirror.resyncMirror();
		assert.deepEqual(sent.find((m) => m.op === "sync").ids, ["after1"], "an older chat was mirrored");
		// The user shares older chats too.
		await chrome.storage.local.set({ "threads.shareOlder": true });
		assert.deepEqual((await bridge.handleThreads("threads.list", {})).threads.map((t) => t.id), ["after1", "before1"]);
		// The switch off: no agent reads any chat, live included.
		await chrome.storage.local.set({ "threads.mirror": false });
		for (const [method, params] of [["threads.list", {}], ["threads.read", { id: "after1" }], ["threads.search", { query: "lisbon" }]])
			await assert.rejects(() => bridge.handleThreads(method, params), (e) => e.code === "permission_denied" && /Settings > Privacy/.test(e.message));
	} finally {
		store.setThreadSource(undefined);
	}
});

test("the side panel's session store marks a thread saved in private mode private for good, and announces changes", async () => {
	installFakeChrome();
	const announced = [];
	chrome.runtime.sendMessage = async (m) => {
		announced.push(m);
	};
	// pi-web-ui loads pdf.js, which wants a few browser globals at import time.
	for (const k of ["DOMMatrix", "Path2D", "ImageData"]) globalThis[k] ??= class {};
	const { TabkyraSessionsStore } = await import("../src/storage/stores/sessions-store.ts");
	const tables = { settings: new Map(), sessions: new Map(), "sessions-metadata": new Map() };
	const backend = {
		async get(s, k) {
			return structuredClone(tables[s].get(k) ?? null);
		},
		async set(s, k, v) {
			tables[s].set(k, structuredClone(v));
		},
		async delete(s, k) {
			tables[s].delete(k);
		},
		async transaction(_names, _mode, op) {
			return op({ get: (s, k) => backend.get(s, k), set: (s, k, v) => backend.set(s, k, v), delete: (s, k) => backend.delete(s, k) });
		},
	};
	const sessions = new TabkyraSessionsStore();
	sessions.setBackend(backend);
	const save = (id) =>
		sessions.save(
			{ id, title: "t", model: null, thinkingLevel: "off", messages: [], createdAt: "c", lastModified: "l" },
			{ id, title: "t", createdAt: "c", lastModified: "l", messageCount: 0, usage: {}, thinkingLevel: "off", preview: "" },
		);
	await save("plain");
	assert.equal(tables["sessions-metadata"].get("plain").tabkyraPrivate, undefined);
	tables.settings.set("privacy.privateMode", true);
	await save("secret");
	assert.equal(tables.sessions.get("secret").tabkyraPrivate, true);
	assert.equal(tables["sessions-metadata"].get("secret").tabkyraPrivate, true);
	// Private mode off again: the thread stays private.
	tables.settings.set("privacy.privateMode", false);
	await save("secret");
	assert.equal(tables["sessions-metadata"].get("secret").tabkyraPrivate, true);
	await sessions.updateTitle("plain", "renamed");
	await sessions.deleteSession("plain");
	assert.deepEqual(
		announced.map((m) => `${m.type}:${m.id}`),
		["tabkyra-thread-changed:plain", "tabkyra-thread-changed:secret", "tabkyra-thread-changed:secret", "tabkyra-thread-changed:plain", "tabkyra-thread-changed:plain"],
	);
});
