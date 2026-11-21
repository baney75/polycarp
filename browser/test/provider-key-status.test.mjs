// Settings > Providers reads which providers have a key once, in one round (src/dialogs/provider-key-status.ts).
// It used to read each key one after another and then each row read its own again: 1 + 2 x 3 + 1 reads for three
// saved keys, four of them in a row. scripts/settings-speed.mjs times the open; this holds the count.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { knownProvidersWithKeys, providersWithKeys } from "../src/dialogs/provider-key-status.ts";

/** A key store that counts reads and answers each get only when released, to see what is in flight together. */
function fakeStore(keys) {
	const calls = { list: 0, get: [] };
	const waiting = [];
	return {
		calls,
		waiting,
		list: async () => {
			calls.list++;
			return Object.keys(keys);
		},
		get: (name) => {
			calls.get.push(name);
			return new Promise((resolve) => waiting.push(() => resolve(keys[name] ?? null)));
		},
	};
}

test("one list and one read per saved provider, all sent before any answers", async () => {
	const store = fakeStore({ anthropic: "k1", openai: "k2", openrouter: "k3" });
	const result = providersWithKeys(store);
	// Let the list answer and the reads go out.
	for (let i = 0; i < 5; i++) await Promise.resolve();
	assert.equal(store.calls.list, 1);
	assert.deepEqual(store.calls.get, ["anthropic", "openai", "openrouter"], "every read is in flight at once");
	for (const release of store.waiting) release();
	assert.deepEqual([...(await result)].sort(), ["anthropic", "openai", "openrouter"]);
	assert.equal(store.calls.get.length, 3, "no second read of any key");
});

test("a provider whose stored key is empty has no key", async () => {
	const store = fakeStore({ anthropic: "k1", google: "" });
	const result = providersWithKeys(store);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	for (const release of store.waiting) release();
	assert.deepEqual([...(await result)], ["anthropic"]);
});

test("rows in Settings > Providers take the list's answer instead of reading their own key", () => {
	const tab = readFileSync(new URL("../src/dialogs/ApiKeysTab.ts", import.meta.url), "utf8");
	assert.match(tab, /<tabkyra-provider-key [^>]*\.knownHasKey=\$\{this\.saved\.has\(provider\)\}/);
	const row = readFileSync(new URL("../src/components/ProviderKeyRow.ts", import.meta.url), "utf8");
	assert.match(row, /if \(this\.knownHasKey === undefined\) void this\.loadStatus\(this\.provider\);/);
});

test("the panel's own read is kept, so Settings draws the rows in order before it reads again", async () => {
	const store = fakeStore({ openai: "k" });
	const result = providersWithKeys(store);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	for (const release of store.waiting) release();
	await result;
	assert.deepEqual([...knownProvidersWithKeys()], ["openai"]);
	const panel = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	assert.match(panel, /return \[\.\.\.\(await providersWithKeys\(storage\.providerKeys\)\)\];/);
	assert.doesNotMatch(panel, /for \(const provider of providers\) \{\s*const key = await storage\.providerKeys\.get/, "the panel reads no key list one at a time");
});
