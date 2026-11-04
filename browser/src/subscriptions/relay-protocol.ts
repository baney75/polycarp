/** Messages between the side panel and the background relay (relay.ts). */

export const SUBSCRIPTIONS_PORT = "tabkyra-subscriptions";

/** side panel -> background */
export interface RelayRequest {
	id: number;
	method: string;
}

/** background -> side panel */
export interface RelayReply {
	id: number;
	result?: unknown;
	error?: { code: string; message: string };
	progress?: Record<string, unknown>;
}

/** Methods the side panel may ask for; everything else is refused here before the host sees it. */
export const RELAY_METHODS = new Set([
	"status",
	"chatgpt.signin",
	"chatgpt.cancel",
	"chatgpt.signout",
	"copilot.signin",
	"copilot.cancel",
	"copilot.signout",
]);

/**
 * True for Tabkyra's own pages (the side panel, or the same page opened in a tab). A content
 * script's sender URL is the web page's, so it never passes.
 */
export function isExtensionPage(sender: chrome.runtime.MessageSender | undefined, origin: string): boolean {
	return Boolean(sender?.url?.startsWith(origin) && (sender.origin === undefined || `${sender.origin}/` === origin));
}
