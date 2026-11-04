/**
 * Bridge methods that let local agents read the side panel's chat threads: threads.list,
 * threads.read (paginated) and threads.search. They run for any client without opening a
 * browser session. Private threads are never listed, read or searched; text is redacted
 * (render.ts). Remote sessions reach these only through the threads.read token scope.
 */

import { ERR } from "../bridge/protocol.js";
import { BridgeError } from "../bridge/tools.js";
import { redactSecrets } from "../privacy/bug-reports.js";
import { MIRROR_KEY } from "./keys.js";
import {
	matches,
	modelOf,
	renderMessages,
	renderPage,
	sanitizeJson,
	snippets,
	summaryLine,
	type ThreadData,
	type ThreadMeta,
	validThreadId,
} from "./render.js";
import { agentsMayRead, listThreadMeta, readThread } from "./store.js";

type Params = Record<string, unknown>;

function int(params: Params, key: string, fallback: number, max: number): number {
	const v = params[key];
	if (v === undefined || v === null) return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0)
		throw new BridgeError(ERR.BAD_PARAMS, `${key} must be a whole number of 0 or more`);
	return Math.min(n, max);
}

async function visible(): Promise<ThreadMeta[]> {
	const may = await agentsMayRead();
	return (await listThreadMeta()).filter((m) => may(m) && validThreadId(m.id));
}

/** Settings > Privacy > "Let my coding agents read my past chats": off means no agent reads any. */
async function allowed(): Promise<void> {
	if (typeof chrome === "undefined" || !chrome.storage?.local) return;
	const got = (await chrome.storage.local.get(MIRROR_KEY)) as Record<string, unknown>;
	if (got[MIRROR_KEY] === false)
		throw new BridgeError(
			ERR.PERMISSION_DENIED,
			"The user turned off agent access to past chats (Tabkyra Settings > Privacy). Ask them if you need it.",
		);
}

async function load(id: unknown): Promise<ThreadData> {
	if (!validThreadId(id))
		throw new BridgeError(ERR.BAD_PARAMS, "id is a thread id from threads_list (letters, digits, - and _).");
	const { meta, data } = await readThread(id);
	// A private thread (or one from before sharing began) answers exactly like a missing one.
	if (!data || !(await agentsMayRead())(meta, data))
		throw new BridgeError(ERR.NOT_FOUND, `No thread ${id}. threads_list shows the ones you can read.`);
	return data;
}

export async function handleThreads(method: string, params: Params): Promise<unknown> {
	await allowed();
	switch (method) {
		case "threads.list": {
			const offset = int(params, "offset", 0, 100000);
			const limit = int(params, "limit", 20, 100);
			const query = typeof params.query === "string" ? params.query : "";
			const all = (await visible()).filter(
				(m) => !query || matches(redactSecrets(`${m.title} ${m.preview ?? ""}`), query),
			);
			const page = all.slice(offset, offset + limit);
			return {
				total: all.length,
				offset,
				threads: page.map((m) => ({
					id: m.id,
					title: redactSecrets(m.title),
					createdAt: m.createdAt,
					lastModified: m.lastModified,
					messageCount: m.messageCount,
				})),
				text: [
					`${all.length} thread${all.length === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""}, newest first${all.length > page.length ? `; showing ${offset + 1}-${offset + page.length}` : ""}.`,
					...page.map((m) => summaryLine(m)),
					...(offset + page.length < all.length ? [`More: threads_list {"offset":${offset + page.length}}`] : []),
				].join("\n"),
			};
		}
		case "threads.read": {
			const data = await load(params.id);
			if (params.format === "json") return { thread: sanitizeJson(data) };
			const offset = int(params, "offset", 0, 100000);
			const limit = Math.max(1, int(params, "limit", 40, 200));
			return {
				id: data.id,
				title: redactSecrets(data.title),
				model: modelOf(data),
				total: renderMessages(data.messages).length,
				offset,
				text: renderPage(data, offset, limit),
			};
		}
		case "threads.search": {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			if (!query) throw new BridgeError(ERR.BAD_PARAMS, 'query is required, e.g. {"query":"flight prices"}');
			const limit = int(params, "limit", 10, 50);
			const hits: Array<{ id: string; title: string; lastModified: string; snippets: string[] }> = [];
			const may = await agentsMayRead();
			for (const meta of await visible()) {
				if (hits.length >= limit) break;
				const { data } = await readThread(meta.id);
				if (!data || !may(meta, data)) continue;
				const found = snippets(data, query);
				if (found.length || matches(redactSecrets(meta.title ?? ""), query))
					hits.push({
						id: meta.id,
						title: redactSecrets(meta.title),
						lastModified: meta.lastModified,
						snippets: found,
					});
			}
			return {
				hits,
				text: hits.length
					? [
							`${hits.length} thread${hits.length === 1 ? "" : "s"} mention "${query}":`,
							...hits.flatMap((h) => [
								`${h.id} | ${JSON.stringify(h.title)} | ${h.lastModified}`,
								...h.snippets.map((s) => `  ${s}`),
							]),
						].join("\n")
					: `No thread mentions "${query}". threads_list shows them all.`,
			};
		}
	}
	throw new BridgeError(ERR.NOT_FOUND, `Unknown method ${method}`);
}
