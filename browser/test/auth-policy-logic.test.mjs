// The runtime guard in src/auth/policy.ts: what it refuses and what it clears.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedModel, purgeRemovedSignIns, RemovedSignInError, resolveApiKey } from "../src/auth/policy.ts";

test("plain API keys pass through", () => {
	assert.equal(resolveApiKey("sk" + "-proj-" + "abc", "openai"), "sk" + "-proj-" + "abc");
	assert.equal(resolveApiKey("sk" + "-ant-" + "api03-abc", "anthropic"), "sk" + "-ant-" + "api03-abc");
	assert.equal(resolveApiKey("AIzaSyabc", "google"), "AIzaSyabc");
});

test("leftover sign-ins and subscription tokens are refused", () => {
	const oauth = JSON.stringify({ providerId: "openai-codex", access: "a", refresh: "r", expires: 0 });
	assert.throws(() => resolveApiKey(oauth, "openai-codex"), RemovedSignInError);
	assert.throws(() => resolveApiKey(oauth, "openai"), RemovedSignInError);
	assert.throws(() => resolveApiKey("gh" + "o_" + "token", "github-copilot"), RemovedSignInError);
	assert.throws(() => resolveApiKey("sk" + "-ant-" + "oat01-abc", "anthropic"), RemovedSignInError);
});

test("models on removed providers or subscription APIs never run", () => {
	assert.equal(isBlockedModel({ provider: "openai-codex", api: "openai-responses" }), true);
	assert.equal(isBlockedModel({ provider: "my-proxy", api: "openai-codex-responses" }), true);
	assert.equal(isBlockedModel({ provider: "google", api: "google-gemini-cli" }), true);
	assert.equal(isBlockedModel({ provider: "github-copilot", api: "openai-completions" }), true);
	assert.equal(isBlockedModel({ provider: "openai", api: "openai-responses" }), false);
});

test("purge deletes only what the removed sign-ins left", async () => {
	const store = new Map([
		["openai", "sk" + "-proj-" + "keep"],
		["openai-codex", JSON.stringify({ providerId: "openai-codex" })],
		["github-copilot", JSON.stringify({ providerId: "github-copilot" })],
		["anthropic", "sk" + "-ant-" + "oat01-drop"],
		["google", "AIza-keep"],
	]);
	const keys = {
		list: async () => [...store.keys()],
		get: async (p) => store.get(p),
		delete: async (p) => void store.delete(p),
	};
	const cleared = await purgeRemovedSignIns(keys);
	assert.deepEqual(cleared.sort(), ["anthropic", "github-copilot", "openai-codex"]);
	assert.deepEqual([...store.keys()].sort(), ["google", "openai"]);
});
