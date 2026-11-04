// The extension's half of the subscription sign-ins: it never holds or stores a token, only its
// own pages can reach the relay, ChatGPT requests are shaped for the plan route, and the Copilot
// stream turns the host's events into a normal assistant message.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { privateModel } from "../src/privacy/private-mode.ts";
import { explainSubscriptionError, siwcRequestBody } from "../src/subscriptions/constants.ts";
import { isExtensionPage, RELAY_METHODS } from "../src/subscriptions/relay-protocol.ts";
import { routeSubscriptionModel, streamCopilot } from "../src/subscriptions/stream.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function* files(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (/\.(ts|js|mjs|html)$/.test(name)) yield path;
	}
}

test("the extension never handles a subscription token, and keeps nothing of a sign-in in synced storage", () => {
	const hits = [];
	for (const file of files(join(repo, "src"))) {
		// Endpoint URLs (github.com/login/oauth/access_token) name a path, not a token.
		const text = readFileSync(file, "utf8").replace(/https:\/\/\S+/g, "");
		if (/\b(access_token|refresh_token|id_token)\b/.test(text)) hits.push(`${relative(repo, file)}: token field`);
	}
	for (const file of files(join(repo, "src", "subscriptions"))) {
		const text = readFileSync(file, "utf8");
		if (/chrome\.storage\.sync|localStorage|sessionStorage|indexedDB|providerKeys\.set/.test(text)) hits.push(`${relative(repo, file)}: browser storage`);
		// The only thing written locally is whether the one-time ChatGPT note was shown.
		for (const m of text.matchAll(/chrome\.storage\.local\.set\(\{([^}]*)\}/g)) if (!m[1].includes("CHATGPT_WELCOME_KEY")) hits.push(`${relative(repo, file)}: ${m[0]}`);
	}
	assert.deepEqual(hits, []);
});

test("ChatGPT plan requests: store false, stream true, no unsupported fields or system items, tools in a namespace", () => {
	const body = siwcRequestBody({
		model: "m",
		store: true,
		stream: false,
		temperature: 0.2,
		top_p: 1,
		max_output_tokens: 100,
		prompt_cache_retention: "24h",
		previous_response_id: "r1",
		metadata: { a: 1 },
		user: "u",
		prompt_cache_key: "chat",
		input: [{ role: "system", content: "s" }, { role: "developer", content: "d" }, { type: "function_call", call_id: "c", name: "click", arguments: "{}" }],
		tools: [{ type: "function", name: "click", description: "Click", parameters: { type: "object" }, strict: false }],
	});
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	for (const field of ["temperature", "top_p", "max_output_tokens", "prompt_cache_retention", "previous_response_id", "metadata", "user"]) assert.equal(field in body, false, field);
	assert.equal(body.prompt_cache_key, "chat");
	assert.deepEqual(
		body.input.map((i) => i.role ?? i.type),
		["developer", "developer", "function_call"],
	);
	assert.equal(body.input[2].namespace, "tabkyra");
	assert.equal(body.tools.length, 1);
	assert.equal(body.tools[0].type, "namespace");
	assert.equal(body.tools[0].tools[0].name, "click");
	// Shaping twice (extension, then host) changes nothing more.
	assert.deepEqual(siwcRequestBody(body), body);
});

test("a ChatGPT usage-limit error points to ChatGPT's usage settings", () => {
	assert.match(explainSubscriptionError("chatgpt-plan", "subscription_sharing_usage_limit_exceeded: limit"), /chatgpt\.com\/settings\/usage/);
	assert.equal(explainSubscriptionError("openai", "subscription_sharing_usage_limit_exceeded"), "subscription_sharing_usage_limit_exceeded");
});

test("the relay takes only Tabkyra's own pages and only the sign-in methods", () => {
	const origin = "chrome-extension://abc/";
	assert.equal(isExtensionPage({ url: `${origin}sidepanel.html` }, origin), true);
	assert.equal(isExtensionPage({ url: `${origin}sidepanel.html`, origin: "chrome-extension://abc", tab: { id: 1 } }, origin), true, "the panel opened in a tab");
	assert.equal(isExtensionPage({ url: "https://evil.example/", origin: "https://evil.example", tab: { id: 1 } }, origin), false, "a content script");
	assert.equal(isExtensionPage({ url: `${origin}x.html`, origin: "https://evil.example" }, origin), false);
	assert.equal(isExtensionPage(undefined, origin), false);
	assert.deepEqual([...RELAY_METHODS].sort(), [
		"chatgpt.cancel",
		"chatgpt.signin",
		"chatgpt.signout",
		"copilot.cancel",
		"copilot.signin",
		"copilot.signout",
		"status",
	]);
});

/** A chrome.runtime.connect stand-in whose host answers "status". */
function fakeChrome(status) {
	globalThis.chrome = {
		runtime: {
			connect: () => {
				const listeners = [];
				return {
					onMessage: { addListener: (l) => listeners.push(l) },
					onDisconnect: { addListener: () => undefined },
					postMessage: (msg) => queueMicrotask(() => listeners.forEach((l) => l({ id: msg.id, result: status }))),
				};
			},
		},
	};
}

test("routing: a ChatGPT plan model goes to the host proxy with the proxy secret; other models are untouched", async () => {
	fakeChrome({
		proxy: { url: "http://127.0.0.1:5555", secret: "s3cret" },
		chatgpt: { signedIn: true, planUsage: true, registered: true },
		copilot: { signedIn: true, sdkInstalled: true },
	});
	const model = { id: "gpt-test", provider: "chatgpt-plan", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
	const routed = await routeSubscriptionModel(model, { apiKey: "ignored" });
	assert.equal(routed.model.baseUrl, "http://127.0.0.1:5555/chatgpt/v1");
	assert.equal(routed.options.apiKey, "s3cret");
	const shaped = await routed.options.onPayload({ store: true, temperature: 1, input: [] }, routed.model);
	assert.equal(shaped.store, false);
	assert.equal(shaped.temperature, undefined);
	const copilot = await routeSubscriptionModel({ id: "x", provider: "copilot-plan", api: "tabkyra-copilot-sdk", baseUrl: "https://github.com" }, {});
	assert.equal(copilot.model.baseUrl, "http://127.0.0.1:5555");
	assert.equal(await routeSubscriptionModel({ id: "gpt", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }, {}), undefined);
});

test("Copilot stream: the turn goes to the proxy with the secret and comes back as text plus a tool call", async () => {
	const sent = [];
	const events = [
		{ type: "text", delta: "Opening " },
		{ type: "text", delta: "it." },
		{ type: "tool_call", id: "t1", name: "navigate", arguments: { url: "https://example.com" } },
		{ type: "done", reason: "toolUse" },
	];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		sent.push({ url, init });
		return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
	};
	try {
		const model = { id: "gpt-x", provider: "copilot-plan", api: "tabkyra-copilot-sdk", baseUrl: "http://127.0.0.1:5555" };
		const context = {
			systemPrompt: "sys",
			messages: [{ role: "user", content: [{ type: "text", text: "open" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 }],
			tools: [{ name: "navigate", description: "Open", parameters: { type: "object" } }],
		};
		const stream = streamCopilot(model, context, { apiKey: "s3cret" });
		const types = [];
		for await (const e of stream) types.push(e.type);
		const message = await stream.result();
		assert.equal(sent[0].url, "http://127.0.0.1:5555/copilot/turn");
		assert.equal(sent[0].init.headers.Authorization, "Bearer s3cret");
		const turn = JSON.parse(sent[0].init.body);
		assert.equal(turn.model, "gpt-x");
		assert.deepEqual(turn.messages, [{ role: "user", text: "open", images: [{ data: "AAAA", mimeType: "image/png" }] }]);
		assert.match(turn.conversation, /^[0-9a-f]{64}$/);
		assert.deepEqual(types, ["start", "text_start", "text_delta", "text_delta", "text_end", "toolcall_start", "toolcall_end", "done"]);
		assert.equal(message.stopReason, "toolUse");
		assert.equal(message.content[0].text, "Opening it.");
		assert.deepEqual(message.content[1], { type: "toolCall", id: "t1", name: "navigate", arguments: { url: "https://example.com" } });
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("private mode refuses both subscription providers before they are routed to the loopback proxy", () => {
	assert.throws(() => privateModel({ id: "gpt", provider: "chatgpt-plan", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }));
	assert.throws(() => privateModel({ id: "x", provider: "copilot-plan", api: "tabkyra-copilot-sdk", baseUrl: "https://github.com" }));
});
