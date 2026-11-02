/**
 * Background worker: carries the side panel's Connect requests to the native host and the answers
 * back. Only Tabkyra's own extension pages may use it (never a content script or a page). The
 * worker checks the method name and that params is a plain object; the host parses the rest
 * strictly (cli/src/connect-host.ts) and is the authority.
 */

import { onConnectMessage, sendConnect } from "../bridge/native.js";
import { isExtensionPage } from "../subscriptions/relay-protocol.js";
import { checkConnectRequest } from "./check.js";
import { CONNECT_PORT, type ConnectReply } from "./types.js";

export function startConnectRelay(): void {
	const waiting = new Map<number, { port: chrome.runtime.Port; id: number }>();
	let seq = 0;
	onConnectMessage((message) => {
		if (message === "disconnected") {
			for (const w of waiting.values())
				w.port.postMessage({
					id: w.id,
					error: { code: "no_host", message: "Tabkyra's native host disconnected. Try again." },
				} satisfies ConnectReply);
			waiting.clear();
			return;
		}
		const w = waiting.get(message.id);
		if (!w) return;
		const reply: ConnectReply = { id: w.id };
		if (message.progress) reply.progress = message.progress;
		if (message.error) reply.error = message.error;
		if ("result" in message && message.result !== undefined) reply.result = message.result;
		w.port.postMessage(reply);
		if (message.error || reply.result !== undefined) waiting.delete(message.id);
	});
	const origin = chrome.runtime.getURL("");
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== CONNECT_PORT) return;
		if (!isExtensionPage(port.sender, origin)) {
			port.disconnect();
			return;
		}
		port.onMessage.addListener((raw: unknown) => {
			const checked = checkConnectRequest(raw);
			if (!checked.ok) {
				if (checked.id !== undefined)
					port.postMessage({
						id: checked.id,
						error: { code: "bad_params", message: checked.message },
					} satisfies ConnectReply);
				return;
			}
			const { request } = checked;
			const hostId = ++seq;
			waiting.set(hostId, { port, id: request.id });
			if (
				!sendConnect({
					type: "connect",
					id: hostId,
					method: request.method,
					...(request.params ? { params: request.params } : {}),
				})
			) {
				waiting.delete(hostId);
				port.postMessage({
					id: request.id,
					error: {
						code: "no_host",
						message: "Tabkyra's helper isn't connected. Run `tabkyra setup`, then try again.",
					},
				} satisfies ConnectReply);
			}
		});
		port.onDisconnect.addListener(() => {
			for (const [hostId, w] of waiting) if (w.port === port) waiting.delete(hostId);
		});
	});
}
