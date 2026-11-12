/**
 * Outside agents' document tools (cli/src/mcp.ts: document_get, document_search, document_read, documents). The work
 * runs in the offscreen page (offscreen/documents.ts), which can start PDF.js; this side checks what only the service
 * worker can: the site permission before a download, and the agent's own tab.
 */

import { DOCUMENTS_MESSAGE, type DocumentsReply } from "../documents/protocol.js";
import { tabSource } from "../documents/tab.js";
import { ensureOffscreen } from "../offscreen/document.js";
import { BridgeError } from "./errors.js";
import { ERR } from "./protocol.js";
import type { HandlerContext } from "./tools.js";

type Params = Record<string, unknown>;
type Handler = (ctx: HandlerContext, params: Params) => Promise<unknown>;
type ResolveTab = (ctx: HandlerContext, params: Params, attach: boolean) => Promise<number>;

async function ask(method: string, params: Params): Promise<Record<string, unknown>> {
	await ensureOffscreen();
	const answer = (await chrome.runtime.sendMessage({ type: DOCUMENTS_MESSAGE, method, params })) as
		| DocumentsReply
		| undefined;
	if (!answer) throw new BridgeError(ERR.INTERNAL, "The document store didn't answer. Try again.");
	if (!answer.ok) throw new BridgeError(ERR.BAD_PARAMS, answer.error);
	return answer.result;
}

export function documentHandlers(resolveTab: ResolveTab): Record<string, Handler> {
	return {
		"documents.get": async (ctx, params) => {
			const extra = { library: params.library, docTitle: params.title, refresh: params.refresh };
			if (typeof params.transfer === "string")
				return ask("get", { transfer: params.transfer, name: params.name, mime: params.mime, ...extra });
			if (params.tab === true || typeof params.tabId === "number") {
				const tabId = await resolveTab(ctx, params, false);
				const source = await tabSource(tabId);
				return ask("get", { ...source, ...extra });
			}
			const url = typeof params.url === "string" ? params.url.trim() : "";
			if (!url) throw new BridgeError(ERR.BAD_PARAMS, "Give one of url, tab or path.");
			if (!/^https?:\/\//i.test(url))
				throw new BridgeError(
					ERR.BAD_PARAMS,
					`Only web addresses can be downloaded: ${JSON.stringify(url)}. For a file on this computer, pass path.`,
				);
			if (ctx.isGuarded(url)) throw new BridgeError(ERR.PERMISSION_DENIED, "Agents can't open that address.");
			// The same rule as navigate: a site not allowed yet is asked about first, and a no stops here.
			await ctx.checkUrl(url);
			return ask("get", { url, ...extra });
		},
		"documents.put": async (_ctx, params) => ask("put", { transfer: params.transfer, data: params.data }),
		"documents.search": async (_ctx, params) => ask("search", params),
		"documents.read": async (_ctx, params) => ask("read", params),
		"documents.list": async () => ask("list", {}),
		"documents.rename": async (_ctx, params) => ask("rename", params),
		"documents.delete": async (_ctx, params) => ask("delete", params),
	};
}
