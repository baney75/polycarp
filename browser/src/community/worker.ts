/** Community skills in the service worker: forwards the side panel's buttons to the native host. */

import { sendCommunityAction } from "../bridge/native.js";
import { PANEL_COMMUNITY_MESSAGE } from "./status.js";

function onPanelMessage(
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: { ok: boolean; message?: string }) => void,
): boolean | undefined {
	const m = message as { type?: unknown; action?: unknown } | null;
	if (!m || m.type !== PANEL_COMMUNITY_MESSAGE) return undefined;
	// Only Tabkyra's own pages, never a content script on a web page.
	if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
		sendResponse({ ok: false, message: "Refused" });
		return undefined;
	}
	if (m.action !== "on" && m.action !== "off" && m.action !== "sync") {
		sendResponse({ ok: false, message: "Unknown community action" });
		return undefined;
	}
	if (sendCommunityAction(m.action)) sendResponse({ ok: true });
	else
		sendResponse({
			ok: false,
			message: "The Tabkyra native host isn't connected. Run tabkyra doctor in a terminal.",
		});
	return undefined;
}

export function startCommunityWorker(): void {
	chrome.runtime.onMessage.addListener(onPanelMessage);
}
