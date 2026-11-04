/**
 * The native host's half of the subscription sign-ins: answers the side panel's requests over
 * native messaging, and runs a loopback proxy the side panel sends model requests to. The proxy
 * adds the user's token on the host side, so no token ever reaches the browser.
 *
 * The proxy listens on 127.0.0.1 only, answers only its own Host header (no DNS rebinding),
 * and only callers that present the per-process secret the extension got over native messaging.
 * It forwards exactly two OpenAI routes and the two Copilot routes below; nothing else.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExtSubscription, HostSubscription } from "../../../src/bridge/protocol.ts";
import type { CopilotTurnEvent, CopilotTurnRequest } from "../../../src/subscriptions/copilot-wire.ts";
import { SIWC, siwcRequestBody } from "../../../src/subscriptions/constants.ts";
import { CopilotAuth } from "./copilot.ts";
import { CopilotTurns } from "./copilot-turns.ts";
import { type Fetch, Siwc, SubscriptionError } from "./siwc.ts";

const MAX_BODY = 60 * 1024 * 1024;

export interface ServiceOptions {
	siwc?: Siwc;
	copilot?: CopilotAuth;
	turns?: CopilotTurns;
	fetch?: Fetch;
}

export class SubscriptionService {
	readonly siwc: Siwc;
	readonly copilot: CopilotAuth;
	readonly turns: CopilotTurns;
	private readonly fetch: Fetch;
	private proxy?: Promise<{ server: Server; url: string; secret: string }>;
	/** ChatGPT requests in flight; sign-out stops them first, as OpenAI's docs say. */
	private readonly forwards = new Set<AbortController>();

	constructor(options: ServiceOptions = {}) {
		this.fetch = options.fetch ?? fetch;
		this.siwc = options.siwc ?? new Siwc({ fetch: this.fetch });
		this.copilot = options.copilot ?? new CopilotAuth({ fetch: this.fetch });
		this.turns = options.turns ?? new CopilotTurns(this.copilot);
	}

	/** Answer one request from the side panel; long ones send `progress` first. */
	async handle(message: ExtSubscription, reply: (frame: HostSubscription) => void): Promise<void> {
		const id = message.id;
		try {
			const result = await this.run(message.method, (progress) => reply({ type: "subscription", id, progress }));
			reply({ type: "subscription", id, result });
		} catch (err) {
			const code = err instanceof SubscriptionError ? err.code : "internal";
			reply({ type: "subscription", id, error: { code, message: err instanceof Error ? err.message : String(err) } });
		}
	}

	private async run(method: string, progress: (p: Record<string, unknown>) => void): Promise<unknown> {
		switch (method) {
			case "status": {
				const proxy = await this.startProxy();
				return { proxy: { url: proxy.url, secret: proxy.secret }, chatgpt: this.siwc.status(), copilot: this.copilot.status() };
			}
			case "chatgpt.signin": {
				const wasPlanUsage = this.siwc.status().planUsage;
				const pending = await this.siwc.startSignIn();
				progress({ authorizeUrl: pending.authorizeUrl });
				const status = await pending.result;
				return { ...status, firstPlanUsage: status.planUsage && !wasPlanUsage };
			}
			case "chatgpt.cancel":
				this.siwc.cancelSignIn();
				return { cancelled: true };
			case "chatgpt.signout":
				for (const forward of this.forwards) forward.abort();
				return await this.siwc.signOut();
			case "copilot.signin": {
				const pending = await this.copilot.startSignIn();
				progress({ userCode: pending.userCode, verificationUri: pending.verificationUri, expiresIn: pending.expiresIn });
				return await pending.result;
			}
			case "copilot.cancel":
				this.copilot.cancelSignIn();
				return { cancelled: true };
			case "copilot.signout":
				await this.turns.reset();
				return await this.copilot.signOut();
			default:
				throw new SubscriptionError("bad_params", `Unknown subscription method ${method}`);
		}
	}

	startProxy(): Promise<{ server: Server; url: string; secret: string }> {
		if (!this.proxy) {
			this.proxy = new Promise((resolve, reject) => {
				const secret = randomBytes(32).toString("base64url");
				const server = createServer((req, res) => {
					const port = (server.address() as { port: number }).port;
					this.route(req, res, port, secret).catch((err) => sendError(res, err));
				});
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					const port = (server.address() as { port: number }).port;
					server.unref();
					resolve({ server, url: `http://127.0.0.1:${port}`, secret });
				});
			});
		}
		return this.proxy;
	}

	async stop(): Promise<void> {
		const proxy = await this.proxy?.catch(() => undefined);
		proxy?.server.close();
		await this.turns.reset();
	}

	private async route(req: IncomingMessage, res: ServerResponse, port: number, secret: string): Promise<void> {
		if (req.headers.host !== `127.0.0.1:${port}`) return sendJson(res, 421, { error: { code: "bad_host", message: "Wrong host" } });
		if (!sameSecret(req.headers.authorization, secret)) return sendJson(res, 401, { error: { code: "unauthorized", message: "Not authorized" } });
		const path = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;

		if (req.method === "GET" && path === "/chatgpt/v1/models") {
			const token = await this.siwc.accessToken();
			const upstream = await this.fetch(`${SIWC.apiBase}/models`, { headers: { Authorization: `Bearer ${token}` } });
			return pipe(upstream, res);
		}
		if (req.method === "POST" && path === "/chatgpt/v1/responses") {
			const body = siwcRequestBody(JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>);
			const token = await this.siwc.accessToken();
			const abort = new AbortController();
			this.forwards.add(abort);
			res.on("close", () => abort.abort());
			try {
				const upstream = await this.fetch(`${SIWC.apiBase}/responses`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
					body: JSON.stringify(body),
					signal: abort.signal,
				});
				return await pipe(upstream, res, abort.signal);
			} finally {
				this.forwards.delete(abort);
			}
		}
		if (req.method === "GET" && path === "/copilot/models") {
			return sendJson(res, 200, { models: await this.turns.listModels() });
		}
		if (req.method === "POST" && path === "/copilot/turn") {
			const turn = JSON.parse((await readBody(req)).toString("utf8")) as CopilotTurnRequest;
			const abort = new AbortController();
			res.on("close", () => abort.abort());
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
			const send = (event: CopilotTurnEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
			await this.turns.run(turn, send, abort.signal);
			res.end();
			return;
		}
		sendJson(res, 404, { error: { code: "not_found", message: "Not found" } });
	}
}

function sameSecret(header: string | undefined, secret: string): boolean {
	const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
	const want = Buffer.from(secret);
	return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new SubscriptionError("too_large", "Request too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * Put an error's code in its message: OpenAI's SDK (inside pi-ai) keeps only `error.message`, and
 * the side panel needs the code (subscription_sharing_usage_limit_exceeded and the like) to show
 * what to do. Returns the line unchanged when it holds no top-level error object.
 */
export function withErrorCode(json: string): string {
	let data: { error?: { code?: unknown; message?: unknown } };
	try {
		data = JSON.parse(json);
	} catch {
		return json;
	}
	const error = data?.error;
	if (!error || typeof error !== "object" || typeof error.code !== "string") return json;
	const message = typeof error.message === "string" ? error.message : "";
	if (message.includes(error.code)) return json;
	error.message = message ? `${error.code}: ${message}` : error.code;
	return JSON.stringify(data);
}

async function pipe(upstream: Response, res: ServerResponse, signal?: AbortSignal): Promise<void> {
	const type = upstream.headers.get("content-type") ?? "application/json";
	const requestId = upstream.headers.get("x-request-id");
	res.writeHead(upstream.status, { "Content-Type": type, "Cache-Control": "no-store", ...(requestId ? { "x-request-id": requestId } : {}) });
	if (!upstream.body) {
		res.end();
		return;
	}
	const write = async (text: string) => {
		if (!res.write(text)) await new Promise((r) => res.once("drain", r));
	};
	// An error body before the stream: one JSON document.
	if (!type.includes("text/event-stream")) {
		await write(withErrorCode(await upstream.text().catch(() => "")));
		res.end();
		return;
	}
	// The event stream passes through line by line; only error events are touched.
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		for (;;) {
			if (signal?.aborted) break;
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			const cut = pending.lastIndexOf("\n");
			if (cut < 0) continue;
			const lines = pending.slice(0, cut + 1);
			pending = pending.slice(cut + 1);
			await write(lines.replace(/^data: (.*)$/gm, (line, json: string) => (json.includes('"error"') ? `data: ${withErrorCode(json)}` : line)));
		}
		if (pending) await write(pending);
	} catch {
		/* the side panel went away or the upstream dropped */
	}
	res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
	const code = err instanceof SubscriptionError ? err.code : "internal";
	const status = code === "not_signed_in" || code === "signed_out" || code === "plan_usage_disabled" ? 401 : code === "sdk_missing" ? 412 : 500;
	sendJson(res, status, { error: { code, message: err instanceof Error ? err.message : String(err) } });
}
