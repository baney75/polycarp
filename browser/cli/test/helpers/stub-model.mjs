import { createServer } from "node:http";

// A stand-in model for the side panel: an OpenAI-compatible chat endpoint answered from a script. No network, no key,
// no cost. Every request the panel sends arrives here, with the exact system prompt and tool list the model would get.
//
//   const stub = await stubModel(context, (body, turn) => ({ toolCalls: [{ name: "read_page", arguments: {} }] }));
//   await seedStubModel(panelPage);   // once the panel has made its database; then reload
//   stub.requests                     // every request body the panel sent, oldest first
//
// stubModel answers inside a Playwright context (a route). A browser the extension drives with chrome.debugger can't
// have Playwright attached, so stubModelServer answers from a local HTTP server instead; seed with seedStubScript.
//
// A script step returns { text } for a final answer or { toolCalls: [{ name, arguments }] } for tool calls.

export const STUB_BASE_URL = "http://stub-model.test/v1";
export const STUB_PROVIDER = "stub";

export const STUB_MODEL = {
	id: "stub-1",
	name: "Stub model",
	api: "openai-completions",
	provider: STUB_PROVIDER,
	baseUrl: STUB_BASE_URL,
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
};

/** Server-sent events for one streamed chat completion. */
function sse(step, turn) {
	const base = { id: `stub-${turn}`, object: "chat.completion.chunk", created: 0, model: STUB_MODEL.id };
	const chunks = [];
	if (step.text) chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] });
	(step.toolCalls ?? []).forEach((call, index) => {
		chunks.push({
			...base,
			choices: [
				{
					index: 0,
					delta: {
						...(index === 0 && !step.text ? { role: "assistant" } : {}),
						tool_calls: [{ index, id: `call_${turn}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }],
					},
					finish_reason: null,
				},
			],
		});
	});
	chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: step.toolCalls?.length ? "tool_calls" : "stop" }] });
	chunks.push({ ...base, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
	return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

const SSE_HEADERS = { "content-type": "text/event-stream", "access-control-allow-origin": "*" };

/** The stream for one request: the script's step, or its failure as the model's text. */
async function answer(requests, body, script) {
	requests.push(body);
	const turn = requests.length - 1;
	let step;
	try {
		step = (await script(body, turn)) ?? { text: "Done." };
	} catch (err) {
		step = { text: `stub script failed: ${err.message}` };
	}
	return sse(step, turn);
}

/** Answer the panel's model requests from `script(body, turn)`. Register after any catch-all route: the last match wins. */
export async function stubModel(context, script) {
	const requests = [];
	await context.route(`${STUB_BASE_URL}/**`, async (route) => {
		const body = await answer(requests, JSON.parse(route.request().postData() ?? "{}"), script);
		await route.fulfill({ status: 200, headers: SSE_HEADERS, body });
	});
	return { requests };
}

/** The same stand-in on 127.0.0.1, for a browser without Playwright attached. `model` is what to seed. */
export async function stubModelServer(script) {
	const requests = [];
	const server = createServer(async (req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" });
			return res.end();
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = await answer(requests, JSON.parse(raw || "{}"), script);
		res.writeHead(200, SSE_HEADERS);
		res.end(body);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const model = { ...STUB_MODEL, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
	return { requests, model, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Make the stub the panel's model: the saved model and a key for its provider, in the panel's own database. An
 * expression to evaluate in the panel page (it resolves when written), for a page reached over raw CDP.
 */
export function seedStubScript(model = STUB_MODEL) {
	return `(async (model) => {
		const db = await new Promise((resolve, reject) => {
			const open = indexedDB.open("tabkyra-storage");
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		await new Promise((resolve, reject) => {
			const tx = db.transaction(["settings", "provider-keys"], "readwrite");
			tx.objectStore("settings").put(model, "lastUsedModel");
			tx.objectStore("provider-keys").put("stub-key", model.provider);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
		await chrome.storage.local.set({ "tk-welcome-seen": true });
		return true;
	})(${JSON.stringify(model)})`;
}

/** seedStubScript in a Playwright page. */
export async function seedStubModel(page, model = STUB_MODEL) {
	await page.evaluate(seedStubScript(model));
}

/** The text of the last tool result in a request, or "" (what the model saw from its last call). */
export function lastToolResult(body) {
	const tool = [...(body.messages ?? [])].reverse().find((m) => m.role === "tool");
	if (!tool) return "";
	return typeof tool.content === "string" ? tool.content : (tool.content ?? []).map((c) => c.text ?? "").join("\n");
}
