// Free mode runs the side panel on the best free OpenRouter models. These tests hold its
// promises: the shipped ranking matches its recorded scores, a request can only ever name free
// models, private mode refuses rather than sends, and the live list is filtered the way the
// recorded /models fixture says it should be (D26).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertFreeChain,
	FREE_LIMIT_MESSAGE,
	FREE_MAX_PRICE,
	FREE_MODEL_ID,
	FreeModeError,
	fallbackChain,
	freeLabel,
	freePayload,
	isFreeListing,
	isFreeLimitError,
	MAX_CHAIN,
	OPENROUTER_FREE_ROUTER,
	privateFreeChain,
	rankFreeModels,
	shortModelName,
	usableFreeModels,
} from "../src/models/free-mode.ts";
import {
	FREE_LIST_KEY,
	FREE_RANKING,
	freeChains,
	freeModeModel,
	isFreeModeModel,
	loadFreeList,
	resolveFreeModel,
	streamFreeChains,
	withFreePayload,
} from "../src/models/free-runtime.ts";
import { privateModel } from "../src/privacy/private-mode.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(repo, "test/fixtures/openrouter-models-2026-10-28.json"), "utf8")).data;
const zdrFixture = JSON.parse(readFileSync(join(repo, "test/fixtures/openrouter-zdr-2026-10-28.json"), "utf8")).data;
const byId = new Map(fixture.map((m) => [m.id, m]));
const list = { fetchedAt: Date.now(), models: fixture.filter(isFreeListing), zdr: zdrFixture };
const isPaid = (id) => {
	const m = byId.get(id);
	return !m || !isFreeListing(m);
};

// ---- the ranking ratchet ----------------------------------------------------

test("the shipped ranking is in the order its recorded scores give", () => {
	const r = FREE_RANKING;
	assert.match(r.measuredAt, /^\d{4}-\d{2}-\d{2}$/, "measuredAt is a date");
	assert.match(r.method, /cli\/eval\/free-models\.mjs/, "the method names the eval that produced it");
	assert.ok(r.models.length >= 5, "at least five measured models");
	for (const m of r.models) {
		assert.ok(m.id.endsWith(":free"), `${m.id} is a :free variant`);
		assert.ok(m.runs > 0 && m.passed >= 0 && m.passed <= m.runs, `${m.id} has runs`);
		assert.equal(m.score, Number((m.passed / m.runs).toFixed(3)), `${m.id} score is passed/runs`);
	}
	const sorted = [...r.models].sort(
		(a, b) => b.score - a.score || a.meanToolCalls - b.meanToolCalls || a.meanSeconds - b.meanSeconds,
	);
	assert.deepEqual(
		r.models.map((m) => m.id),
		sorted.map((m) => m.id),
		"best first: score, then fewer tool calls, then fewer seconds",
	);
	assert.ok(!r.models.some((m) => m.id === OPENROUTER_FREE_ROUTER), "the router is never ranked; it is always last");
	for (const id of r.unmeasured ?? []) assert.ok(!r.models.some((m) => m.id === id), `${id} is either measured or not`);
});

test("at run time the measured order wins, a model that passed nothing is dropped, the router is last", () => {
	const ranked = rankFreeModels(list.models, FREE_RANKING);
	const measuredLive = FREE_RANKING.models.filter((m) => m.score > 0 && byId.has(m.id)).map((m) => m.id);
	assert.deepEqual(ranked.slice(0, measuredLive.length), measuredLive);
	for (const m of FREE_RANKING.models.filter((m) => m.score === 0)) assert.ok(!ranked.includes(m.id), `${m.id} dropped`);
	assert.equal(ranked.at(-1), OPENROUTER_FREE_ROUTER);
});

// ---- live-list filtering (recorded /models) -----------------------------------

test("the recorded list: only :free models with every price zero and tools support are usable", () => {
	const usable = usableFreeModels(fixture).map((m) => m.id);
	assert.ok(usable.length >= 10, `${usable.length} usable`);
	assert.ok(usable.includes(OPENROUTER_FREE_ROUTER));
	assert.ok(usable.includes("google/gemma-4-31b-it:free"));
	// No tools: a safety classifier and music models.
	assert.ok(!usable.includes("nvidia/nemotron-3.5-content-safety:free"));
	// Zero-priced but not a :free variant: its price can change under the same id.
	assert.ok(!usable.some((id) => id.startsWith("google/lyria")));
	// Paid twins of free models are never usable.
	for (const id of ["google/gemma-4-31b-it", "nvidia/nemotron-3-ultra-550b-a55b", "openai/gpt-5.1-codex"])
		assert.ok(!usable.includes(id), id);
	for (const id of usable) assert.ok(!isPaid(id), id);
});

test("a model that turns paid, drops tools or leaves the list is dropped; new free ones rank after measured ones", () => {
	const top = rankFreeModels(list.models, FREE_RANKING)[0];
	const paid = list.models.map((m) => (m.id === top ? { ...m, pricing: { ...m.pricing, completion: "0.0000004" } } : m));
	assert.ok(!rankFreeModels(paid, FREE_RANKING).includes(top), "turned paid");
	const noTools = list.models.map((m) => (m.id === top ? { ...m, supported_parameters: ["temperature"] } : m));
	assert.ok(!rankFreeModels(noTools, FREE_RANKING).includes(top), "dropped tools");
	const gone = list.models.filter((m) => m.id !== top);
	assert.ok(!rankFreeModels(gone, FREE_RANKING).includes(top), "left the list");

	const newcomers = [
		{ id: "new/small:free", context_length: 32000, created: 2, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
		{ id: "new/big:free", context_length: 900000, created: 1, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
		{ id: "new/big-newer:free", context_length: 900000, created: 3, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
	];
	const ranked = rankFreeModels([...list.models, ...newcomers], FREE_RANKING);
	const measuredCount = FREE_RANKING.models.filter((m) => m.score > 0 && byId.has(m.id)).length;
	const unmeasured = ranked.slice(measuredCount, -1);
	assert.ok(unmeasured.indexOf("new/big-newer:free") < unmeasured.indexOf("new/big:free"), "same context: newer first");
	assert.ok(unmeasured.indexOf("new/big:free") < unmeasured.indexOf("new/small:free"), "longer context first");
	assert.equal(ranked.at(-1), OPENROUTER_FREE_ROUTER);
});

test("the list is cached for a day, refetched when stale, and kept when a refetch fails", async () => {
	const store = new Map();
	const settings = { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) };
	const realFetch = globalThis.fetch;
	let calls = 0;
	let fail = false;
	globalThis.fetch = async (url) => {
		calls++;
		if (fail) throw new Error("offline");
		const data = String(url).endsWith("/endpoints/zdr") ? zdrFixture : fixture;
		return new Response(JSON.stringify({ data }), { status: 200 });
	};
	try {
		const first = await loadFreeList(settings);
		assert.equal(calls, 2);
		assert.ok(first.models.every(isFreeListing), "only free entries are stored");
		await loadFreeList(settings);
		assert.equal(calls, 2, "fresh cache: no fetch");
		store.set(FREE_LIST_KEY, { ...store.get(FREE_LIST_KEY), fetchedAt: Date.now() - 25 * 60 * 60 * 1000 });
		await loadFreeList(settings);
		assert.equal(calls, 4, "a day old: refetched");
		fail = true;
		store.set(FREE_LIST_KEY, { ...store.get(FREE_LIST_KEY), fetchedAt: 0 });
		const stale = await loadFreeList(settings);
		assert.ok(stale.models.length > 0, "a failed refetch keeps the old list");
		store.clear();
		await assert.rejects(loadFreeList(settings), FreeModeError);
	} finally {
		globalThis.fetch = realFetch;
	}
});

// ---- free-only fallback chain ---------------------------------------------------

test("every chain is free, at most three long, with the free router last", () => {
	const chains = freeChains(list, false);
	assert.ok(chains.length >= 1);
	for (const chain of chains) {
		assert.ok(chain.length <= MAX_CHAIN && chain.length >= 2, String(chain));
		assert.equal(chain.at(-1), OPENROUTER_FREE_ROUTER);
		for (const id of chain) assert.ok(!isPaid(id), `${id} is free`);
		assert.doesNotThrow(() => assertFreeChain(chain, list.models));
	}
	assert.notDeepEqual(chains[0], chains[1], "the second chain moves on to the next models");
	assert.deepEqual(fallbackChain(["a:free", OPENROUTER_FREE_ROUTER, "b:free", "c:free"]), ["a:free", "b:free", OPENROUTER_FREE_ROUTER]);
});

test("a chain naming a paid or unlisted model is refused before anything is sent", () => {
	for (const bad of ["openai/gpt-5.1-codex", "google/gemma-4-31b-it", "made/up:free", FREE_MODEL_ID]) {
		assert.throws(() => assertFreeChain(["google/gemma-4-31b-it:free", bad], list.models), FreeModeError, bad);
	}
	assert.throws(() => assertFreeChain([], list.models), FreeModeError);
});

test("whatever the list says, no chain ever names a paid model (randomized prices)", () => {
	let seed = 7;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed / 2 ** 31;
	};
	for (let round = 0; round < 200; round++) {
		const models = fixture.map((m) => {
			const r = rand();
			if (r < 0.2) return { ...m, pricing: { ...m.pricing, prompt: "0.000001" } };
			if (r < 0.3) return { ...m, pricing: { ...m.pricing, request: "0.01" } };
			if (r < 0.35) return { ...m, id: m.id.replace(/:free$/, "") };
			return m;
		});
		const free = new Set(models.filter(isFreeListing).map((m) => m.id));
		let chains;
		try {
			chains = freeChains({ fetchedAt: 0, models, zdr: [] }, false);
		} catch (err) {
			assert.ok(err instanceof FreeModeError);
			continue;
		}
		for (const chain of chains) for (const id of chain) assert.ok(free.has(id), `round ${round}: ${id}`);
	}
});

test("the request body carries the chain as OpenRouter's fallback list and a zero price cap", async () => {
	const chain = ["google/gemma-4-31b-it:free", "poolside/laguna-s-2.1:free", OPENROUTER_FREE_ROUTER];
	const body = freePayload({ model: "x", messages: [], provider: { zdr: true } }, chain);
	assert.equal(body.model, chain[0]);
	assert.deepEqual(body.models, chain);
	assert.deepEqual(body.provider, { zdr: true, max_price: FREE_MAX_PRICE });
	assert.ok(Object.values(FREE_MAX_PRICE).every((v) => v === 0));
	assert.equal(freePayload({ model: "x", models: ["paid/model"] }, [chain[0]]).models, undefined, "a one-model chain sends no list");
	// An earlier payload hook still runs first.
	const opts = withFreePayload({ onPayload: async (p) => ({ ...p, seen: true }) }, chain);
	const out = await opts.onPayload({ model: "x" }, {});
	assert.equal(out.seen, true);
	assert.deepEqual(out.models, chain);
});

test("the model sent takes the first model's id and limits every model in the chain meets", () => {
	const chain = freeChains(list, false)[0];
	const m = resolveFreeModel(freeModeModel(), chain, list);
	assert.equal(m.id, chain[0]);
	assert.equal(m.provider, "openrouter");
	assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const contexts = chain.map((id) => byId.get(id)?.context_length).filter(Boolean);
	assert.equal(m.contextWindow, Math.min(...contexts));
	assert.ok(isFreeModeModel(freeModeModel()) && !isFreeModeModel(m));
});

// ---- the stream: fallback, the limit message ---------------------------------------

function fakeInner(script) {
	const sent = [];
	const inner = async (model, _context, options) => {
		const body = await options.onPayload({ model: model.id, messages: [] }, model);
		sent.push(body);
		const outcome = script[sent.length - 1];
		return (async function* () {
			const base = { role: "assistant", content: [], api: model.api, provider: "openrouter", model: model.id, usage: {}, timestamp: 0 };
			if (outcome === "ok") {
				yield { type: "start", partial: base };
				yield { type: "done", reason: "stop", message: { ...base, stopReason: "stop", responseModel: body.models?.[1] } };
			} else {
				yield { type: "error", reason: "error", error: { ...base, stopReason: "error", errorMessage: outcome } };
			}
		})();
	};
	return { inner, sent };
}

async function collect(stream) {
	const events = [];
	for await (const e of stream) events.push(e);
	return { events, result: await stream.result() };
}

test("a rate-limited chain moves on to the next free models; a real error does not", async () => {
	const chains = freeChains(list, false);
	const limited = fakeInner(["429 Provider returned error", "ok"]);
	const a = await collect(streamFreeChains(limited.inner, (c) => resolveFreeModel(freeModeModel(), c, list), chains, {}, {}));
	assert.equal(limited.sent.length, 2);
	assert.deepEqual(limited.sent[0].models, chains[0]);
	assert.deepEqual(limited.sent[1].models, chains[1]);
	assert.equal(a.result.stopReason, "stop");
	for (const body of limited.sent) for (const id of body.models) assert.ok(!isPaid(id), id);

	const broken = fakeInner(["400 context length exceeded"]);
	const b = await collect(streamFreeChains(broken.inner, (c) => resolveFreeModel(freeModeModel(), c, list), chains, {}, {}));
	assert.equal(broken.sent.length, 1, "not a limit: no retry");
	assert.match(b.result.errorMessage, /context length/);
});

test("when every free model is limited, the turn ends with the free-limit message", async () => {
	const chains = freeChains(list, false);
	const all = fakeInner(chains.map(() => "429 Rate limit exceeded: free-models-per-day"));
	const r = await collect(streamFreeChains(all.inner, (c) => resolveFreeModel(freeModeModel(), c, list), chains, {}, {}));
	assert.equal(all.sent.length, chains.length);
	assert.equal(r.result.stopReason, "error");
	assert.ok(r.result.errorMessage.startsWith(FREE_LIMIT_MESSAGE));
	assert.match(FREE_LIMIT_MESSAGE, /per day|a day/);
	for (const m of ["429", "Rate limit exceeded", "free-models-per-day", "No endpoints found", "x is not a valid model ID", "Upstream error: Service temporarily overloaded", "403 x:free is only available on agentic harnesses"])
		assert.ok(isFreeLimitError(m), m);
	assert.ok(!isFreeLimitError("400 invalid tool schema"));
});

// ---- private mode -------------------------------------------------------------------

test("private mode: nothing is sent when no free model has zero data retention", async () => {
	const noZdr = { ...list, zdr: [] };
	assert.throws(() => freeChains(noZdr, true), FreeModeError);
	assert.throws(() => freeChains(noZdr, true), /no free model guarantees zero data retention right now, so nothing was sent/);
	// A paid ZDR endpoint doesn't count.
	assert.throws(() => privateFreeChain(rankFreeModels(list.models, FREE_RANKING), [{ model_id: "openai/gpt-4o-mini", pricing: { prompt: "0.1", completion: "0.1" } }]), FreeModeError);
});

test("private mode: only free ZDR models, never the router, each sent with ZDR routing", () => {
	const ranked = rankFreeModels(list.models, FREE_RANKING);
	// The recorded ZDR list plus two ranked models given a free ZDR endpoint, and the router listed too.
	const zdr = [...zdrFixture, ...[ranked[0], ranked[1], OPENROUTER_FREE_ROUTER].map((model_id) => ({ model_id, pricing: { prompt: "0", completion: "0" } }))];
	const chains = freeChains({ ...list, zdr }, true);
	const zdrFree = new Set(zdr.filter((e) => e.model_id.endsWith(":free")).map((e) => e.model_id));
	assert.equal(chains[0][0], ranked[0], "the best ZDR model leads");
	for (const chain of chains)
		for (const id of chain) {
			assert.ok(zdrFree.has(id), `${id} has a free ZDR endpoint`);
			assert.notEqual(id, OPENROUTER_FREE_ROUTER);
		}
	const sent = privateModel(resolveFreeModel(freeModeModel(), chains[0], list));
	assert.deepEqual(sent.compat.openRouterRouting, { zdr: true, data_collection: "deny", allow_fallbacks: false });
});

test("the side panel gate runs Free mode through private mode's checks", () => {
	const sidepanel = readFileSync(join(repo, "src/sidepanel.ts"), "utf8");
	const gate = sidepanel.slice(sidepanel.indexOf("function uncappedStreamFn"), sidepanel.indexOf("const createAgent"));
	assert.ok(gate.indexOf("assertPrivateProxy(") < gate.indexOf("isFreeModeModel(model)"), "proxy check first");
	assert.match(gate, /privateMode \? privateModel\(m, trusted\) : m/);
	assert.ok(gate.indexOf("isFreeModeModel(model)") < gate.indexOf("if (privateMode) model = privateModel(model, trusted);"));
});

// ---- labels ---------------------------------------------------------------------------

test("the composer says which model answered", () => {
	assert.equal(freeLabel(), "Free");
	assert.equal(freeLabel({ id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)" }), "Free · Gemma 4 31B");
	assert.equal(freeLabel({ id: "x/y:free" }), "Free · x/y");
	assert.equal(shortModelName("NVIDIA: Nemotron 3 Ultra (free)", "n"), "Nemotron 3 Ultra");
});
