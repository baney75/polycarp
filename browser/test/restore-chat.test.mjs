// Which chat the one-per-window side panel shows when it opens.
import assert from "node:assert/strict";
import test from "node:test";
import { pickChatToRestore } from "../src/restore-chat.ts";

const saved = [
	{ id: "old", lastModified: "2026-11-01T10:00:00.000Z" },
	{ id: "newest", lastModified: "2026-11-07T09:00:00.000Z" },
	{ id: "mid", lastModified: "2026-11-05T12:00:00.000Z" },
];

test("with no URL choice, the most recently updated chat opens", () => {
	assert.equal(pickChatToRestore({ session: null, newChat: false, saved }), "newest");
});

test("with no saved chats, the empty home screen opens", () => {
	assert.equal(pickChatToRestore({ session: null, newChat: false, saved: [] }), undefined);
});

test("an explicit ?session wins over the most recent", () => {
	assert.equal(pickChatToRestore({ session: "old", newChat: false, saved }), "old");
	assert.equal(pickChatToRestore({ session: "old", newChat: true, saved }), "old");
});

test("?new=true wins over the most recent", () => {
	assert.equal(pickChatToRestore({ session: null, newChat: true, saved }), undefined);
});

// ---- one panel per window: each window keeps its own chat ----------------------------------

const two = [
	{ id: "a", lastModified: "2026-11-07T09:00:00.000Z" },
	{ id: "b", lastModified: "2026-11-07T08:00:00.000Z" },
];

test("a window reopening gets its own last chat even when another window's chat is newer", () => {
	assert.equal(pickChatToRestore({ session: null, newChat: false, saved: two, remembered: "b", takenByOthers: new Set(["a"]) }), "b");
});

test("a remembered chat the store no longer has is ignored", () => {
	assert.equal(pickChatToRestore({ session: null, newChat: false, saved: two, remembered: "gone" }), "a");
});

test("the most recent chat is not taken by a window while another window shows it", () => {
	assert.equal(pickChatToRestore({ session: null, newChat: false, saved: two, takenByOthers: new Set(["a"]) }), undefined);
});

test("?session and ?new=true still win over a remembered chat", () => {
	assert.equal(pickChatToRestore({ session: "b", newChat: false, saved: two, remembered: "a" }), "b");
	assert.equal(pickChatToRestore({ session: null, newChat: true, saved: two, remembered: "a" }), undefined);
});

test("two windows opening panels get different chats, or one gets none", async () => {
	const { installFakeChrome } = await import("./fake-chrome.mjs");
	installFakeChrome();
	const { chatsOfOtherWindows, rememberChat, rememberedChat } = await import("../src/restore-chat.ts");
	const open = async (windowId) => {
		const pick = pickChatToRestore({
			session: null,
			newChat: false,
			saved: two,
			remembered: await rememberedChat(windowId),
			takenByOthers: await chatsOfOtherWindows(windowId),
		});
		if (pick) await rememberChat(windowId, pick);
		// The worker lists a window once its panel connects.
		const list = (await chrome.storage.session.get("sidepanel_open_windows")).sidepanel_open_windows ?? [];
		await chrome.storage.session.set({ sidepanel_open_windows: [...new Set([...list, windowId])] });
		return pick;
	};
	assert.equal(await open(1), "a");
	assert.equal(await open(2), undefined, "the second window does not take the first window's chat");
	// Window 2 starts its own chat, then both panels reopen: each gets its own.
	await rememberChat(2, "b");
	assert.equal(await open(1), "a");
	assert.equal(await open(2), "b");
	// A new chat in window 1 forgets its old one.
	await rememberChat(1, undefined);
	assert.equal(await rememberedChat(1), undefined);
});
