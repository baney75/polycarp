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
}

let port: chrome.runtime.Port | undefined;
let seq = 0;
const waiters = new Map<number, Waiter>();

function connect(): chrome.runtime.Port {
	if (port) return port;
	const next = chrome.runtime.connect({ name: CONNECT_PORT });
	next.onMessage.addListener((reply: ConnectReply) => {
		const w = waiters.get(reply.id);
		if (!w) return;
		if (reply.progress) w.onProgress?.(reply.progress);
		if (reply.error) {
			waiters.delete(reply.id);
			w.reject(new ConnectRequestError(reply.error.code, reply.error.message));
		} else if (reply.result !== undefined) {
			waiters.delete(reply.id);
			w.resolve(reply.result);
		}
	});
	next.onDisconnect.addListener(() => {
		if (port === next) port = undefined;
		for (const w of waiters.values())
			w.reject(new ConnectRequestError("no_host", "Lost the connection to Tabkyra's background worker."));
		waiters.clear();
	});
	port = next;
	return next;
}

function request<T>(method: string, params?: Record<string, unknown>, onProgress?: Waiter["onProgress"]): Promise<T> {
	const id = ++seq;
	return new Promise<T>((resolve, reject) => {
		waiters.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
		connect().postMessage({ id, method, ...(params ? { params } : {}) });
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
export const connectSetTheme = (preset: string, accent: string | null) =>
	request<{ preset: string; accent?: string }>("setTheme", { preset, accent });

/** True when the host is absent: the panel then shows how to set Tabkyra up. */
export const isNoHost = (err: unknown): boolean => err instanceof ConnectRequestError && err.code === "no_host";
