/**
 * Side panel side of Settings > Connect. Asks the native host, through the background relay, for
 * the route and devices, one-time codes, joining a hub and the page theme. No answer carries a
 * secret (cli/src/connect-host.ts).
 */

import {
	type ApprovalCode,
	CONNECT_PORT,
	type ConnectReply,
	type ConnectStatus,
	type DeviceCode,
	type JoinResult,
} from "./types.js";

export class ConnectRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ConnectRequestError";
	}
}

interface Waiter {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	onProgress?: (progress: Record<string, unknown>) => void;
	/** Restarts the wait; called when the host reports progress, which proves it is alive. */
	rearm: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

/** How long a request may go unanswered. A helper from before Connect drops the frame and never replies. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** joinHub talks to the hub, whose own timeout is 15 seconds. */
export const JOIN_TIMEOUT_MS = 30_000;
export const NO_REPLY_MESSAGE = "Tabkyra's helper didn't answer. Update it: tabkyra update";

let port: chrome.runtime.Port | undefined;
let seq = 0;
const waiters = new Map<number, Waiter>();

function connect(): chrome.runtime.Port {
	if (port) return port;
	const next = chrome.runtime.connect({ name: CONNECT_PORT });
	next.onMessage.addListener((reply: ConnectReply) => {
		const w = waiters.get(reply.id);
		if (!w) return;
		if (reply.progress) {
			w.rearm();
			w.onProgress?.(reply.progress);
		}
		if (reply.error) {
			waiters.delete(reply.id);
			clearTimeout(w.timer);
			w.reject(new ConnectRequestError(reply.error.code, reply.error.message));
		} else if (reply.result !== undefined) {
			waiters.delete(reply.id);
			clearTimeout(w.timer);
			w.resolve(reply.result);
		}
	});
	next.onDisconnect.addListener(() => {
		if (port === next) port = undefined;
		for (const w of waiters.values()) {
			clearTimeout(w.timer);
			w.reject(new ConnectRequestError("no_host", "Lost the connection to Tabkyra's background worker."));
		}
		waiters.clear();
	});
	port = next;
	return next;
}

function request<T>(method: string, params?: Record<string, unknown>, onProgress?: Waiter["onProgress"]): Promise<T> {
	const id = ++seq;
	const limit = method === "joinHub" ? JOIN_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
	return new Promise<T>((resolve, reject) => {
		const waiter: Waiter = {
			resolve: resolve as (value: unknown) => void,
			reject,
			onProgress,
			rearm: () => {
				clearTimeout(waiter.timer);
				waiter.timer = setTimeout(expire, limit);
			},
		};
		const expire = () => {
			waiters.delete(id);
			reject(new ConnectRequestError("no_reply", NO_REPLY_MESSAGE));
		};
		waiters.set(id, waiter);
		waiter.rearm();
		try {
			connect().postMessage({ id, method, ...(params ? { params } : {}) });
		} catch (err) {
			waiters.delete(id);
			clearTimeout(waiter.timer);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

export const connectStatus = () => request<ConnectStatus>("status");
export const connectApprovalCode = () => request<ApprovalCode>("approvalCode");
export const connectDeviceCode = () => request<DeviceCode>("deviceCode");
export const connectSetBusy = (busy: boolean) => request<{ busy: boolean }>("setBusy", { busy });
export const connectJoinHub = (
	hubUrl: string,
	code: string,
	name: string | undefined,
	onProgress: (step: string) => void,
) =>
	request<JoinResult>("joinHub", { hubUrl, code, ...(name ? { name } : {}) }, (p) => {
		if (typeof p.step === "string") onProgress(p.step);
	});
export const connectSetTheme = (preset: string, accent: string | null, mode?: "light" | "dark" | "system") =>
	request<{ preset: string; accent?: string; mode?: string }>("setTheme", {
		preset,
		accent,
		...(mode ? { mode } : {}),
	});

/** True when the host is absent: the panel then shows how to set Tabkyra up. */
export const isNoHost = (err: unknown): boolean => err instanceof ConnectRequestError && err.code === "no_host";
