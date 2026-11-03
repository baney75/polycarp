/**
 * Background worker: carries the side panel's Connect requests to the native host and the answers
 * back. Only the side panel document may use it (never a content script, a page, or the panel
 * opened as a tab); that is the boundary. The methods that mint a code or join a hub also need a
 * single-use, short-lived token from the panel, a guard against accidental or scripted calls from
 * the panel's own code paths, not proof of a click (the worker cannot see one). The
 * worker checks the method name and that params is a plain object; the host parses the rest
 * strictly (cli/src/connect-host.ts) and is the authority.
 */

import { onConnectMessage, sendConnect } from "../bridge/native.js";
import { checkConnectRequest } from "./check.js";
import { GestureGate, isSidePanelPort } from "./gate.js";
import { CONNECT_PORT, type ConnectReply } from "./types.js";

/** A request the host never answers (a helper from before Connect drops the frame) is forgotten after this; the panel gave up sooner. */
export const RELAY_WAIT_MS = 60_000;

interface Waiting {
	port: chrome.runtime.Port;
	id: number;
	timer?: ReturnType<typeof setTimeout>;
}

export function startConnectRelay(): void {
	const waiting = new Map<number, Waiting>();
	let seq = 0;
	const forget = (hostId: number): void => {
		clearTimeout(waiting.get(hostId)?.timer);
		waiting.delete(hostId);
	};
	const arm = (hostId: number): void => {
		const w = waiting.get(hostId);
		if (!w) return;
		clearTimeout(w.timer);
		w.timer = setTimeout(() => waiting.delete(hostId), RELAY_WAIT_MS);
	};
	onConnectMessage((message) => {
		if (message === "disconnected") {
			for (const w of waiting.values()) {
				clearTimeout(w.timer);
				w.port.postMessage({
					id: w.id,
					error: { code: "no_host", message: "Tabkyra's native host disconnected. Try again." },
				} satisfies ConnectReply);
			}
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
		if (message.error || reply.result !== undefined) forget(message.id);
		else arm(message.id);
	});
	const origin = chrome.runtime.getURL("");
	const gate = new GestureGate();
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== CONNECT_PORT) return;
		if (!isSidePanelPort(port.sender, origin)) {
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
			if (!gate.allows(request.method, request.gesture)) {
				port.postMessage({
					id: request.id,
					error: { code: "no_gesture", message: "Click the button in the Tabkyra side panel to do that." },
				} satisfies ConnectReply);
				return;
			}
			const hostId = ++seq;
			waiting.set(hostId, { port, id: request.id });
			arm(hostId);
			if (
				!sendConnect({
					type: "connect",
					id: hostId,
					method: request.method,
					...(request.params ? { params: request.params } : {}),
				})
			) {
				forget(hostId);
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
			for (const [hostId, w] of waiting) if (w.port === port) forget(hostId);
		});
	});
}
