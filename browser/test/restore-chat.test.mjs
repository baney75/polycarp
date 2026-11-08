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
