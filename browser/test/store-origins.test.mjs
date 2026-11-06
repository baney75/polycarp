// The native host must accept the unpacked copy and, once Google assigns its id, the store copy.
import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_ID, extensionOrigins, manifestFor, originsCurrent, STORE_EXTENSION_ID } from "../cli/src/install.ts";

const dev = `chrome-extension://${EXTENSION_ID}/`;
const store = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const storeId = "abcdefghijklmnopabcdefghijklmnop";

test("before the first upload only the unpacked copy is allowed", () => {
	assert.deepEqual(extensionOrigins(""), [dev]);
	assert.equal(originsCurrent([dev], ""), true);
});

test("with a store id both copies are allowed", () => {
	assert.deepEqual(extensionOrigins(storeId), [dev, store]);
	assert.equal(originsCurrent([dev, store], storeId), true);
});

test("a manifest from before the store id is out of date, so it gets rewritten", () => {
	assert.equal(originsCurrent([dev], storeId), false);
});

test("an unknown extension is never current", () => {
	assert.equal(originsCurrent([dev, "chrome-extension://zzzz/"], storeId), false);
	assert.equal(originsCurrent(undefined, storeId), false);
});

test("the manifest written today lists what extensionOrigins says", () => {
	const written = JSON.parse(manifestFor("/tmp/launcher"));
	assert.deepEqual(written.allowed_origins, extensionOrigins(STORE_EXTENSION_ID));
});
