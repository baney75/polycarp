/**
 * Background worker: carries the side panel's subscription requests to the native host and the
 * answers back. Only Tabkyra's own extension pages may use it (never a content script or a page),
 * and nothing passing through holds a token: the host keeps those (cli/src/subscriptions).
 */

import { onSubscriptionMessage, sendSubscription } from "../bridge/native.js";
import {
	isExtensionPage,
	RELAY_METHODS,
	type RelayReply,
	type RelayRequest,
	SUBSCRIPTIONS_PORT,
} from "./relay-protocol.js";

export function startSubscriptionRelay(): void {
	const waiting = new Map<number, { port: chrome.runtime.Port; id: number }>();
	let seq = 0;
	onSubscriptionMessage((message) => {
		if (message === "disconnected") {
			for (const w of waiting.values())
				w.port.postMessage({
					id: w.id,
					error: { code: "no_host", message: "Tabkyra's native host disconnected. Try again." },
				} satisfies RelayReply);
			waiting.clear();
			return;
		}
		const w = waiting.get(message.id);
		if (!w) return;
		const reply: RelayReply = { id: w.id };
		if (message.progress) reply.progress = message.progress;
		if (message.error) reply.error = message.error;
		if ("result" in message && message.result !== undefined) reply.result = message.result;
		w.port.postMessage(reply);
		if (message.error || reply.result !== undefined) waiting.delete(message.id);
	});
	const origin = chrome.runtime.getURL("");
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== SUBSCRIPTIONS_PORT) return;
		if (!isExtensionPage(port.sender, origin)) {
			port.disconnect();
			return;
		}
		port.onMessage.addListener((raw: unknown) => {
			const req = raw as Partial<RelayRequest>;
			if (typeof req?.id !== "number" || typeof req.method !== "string") return;
			if (!RELAY_METHODS.has(req.method)) {
				port.postMessage({
					id: req.id,
					error: { code: "bad_params", message: `Unknown method ${req.method}` },
				} satisfies RelayReply);
				return;
			}
			const hostId = ++seq;
			waiting.set(hostId, { port, id: req.id });
			if (!sendSubscription({ type: "subscription", id: hostId, method: req.method })) {
				waiting.delete(hostId);
				port.postMessage({
					id: req.id,
					error: {
						code: "no_host",
						message:
							"Tabkyra's native host isn't connected. Run `tabkyra setup` (or `tabkyra doctor`), then try again.",
					},
				} satisfies RelayReply);
			}
		});
		port.onDisconnect.addListener(() => {
			for (const [hostId, w] of waiting) if (w.port === port) waiting.delete(hostId);
		});
	});
}
