/**
 * Side panel side of the subscription sign-ins. Asks the native host (through the background
 * relay) for status and to sign in or out. The status carries the host's loopback proxy address
 * and its per-process secret, kept in memory only; tokens never come here.
 */

import { type RelayReply, SUBSCRIPTIONS_PORT } from "./relay-protocol.js";

export interface SubscriptionStatus {
	proxy: { url: string; secret: string };
	chatgpt: { signedIn: boolean; email?: string; planUsage: boolean; registered: boolean };
	copilot: { signedIn: boolean; login?: string; sdkInstalled: boolean };
}

export class SubscriptionRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SubscriptionRequestError";
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
let cached: SubscriptionStatus | undefined;
const listeners = new Set<(status: SubscriptionStatus | undefined) => void>();

function connect(): chrome.runtime.Port {
	if (port) return port;
	const next = chrome.runtime.connect({ name: SUBSCRIPTIONS_PORT });
	next.onMessage.addListener((reply: RelayReply) => {
		const w = waiters.get(reply.id);
		if (!w) return;
		if (reply.progress) w.onProgress?.(reply.progress);
		if (reply.error) {
			// The host went away: its proxy address and secret went with it.
			if (reply.error.code === "no_host") cached = undefined;
			waiters.delete(reply.id);
			w.reject(new SubscriptionRequestError(reply.error.code, reply.error.message));
		} else if (reply.result !== undefined) {
			waiters.delete(reply.id);
			w.resolve(reply.result);
		}
	});
	next.onDisconnect.addListener(() => {
		if (port === next) port = undefined;
		cached = undefined;
		for (const w of waiters.values())
			w.reject(new SubscriptionRequestError("no_host", "Lost the connection to Tabkyra's background worker."));
		waiters.clear();
	});
	port = next;
	return next;
}

export function request<T>(method: string, onProgress?: (progress: Record<string, unknown>) => void): Promise<T> {
	const id = ++seq;
	return new Promise<T>((resolve, reject) => {
		waiters.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
		connect().postMessage({ id, method });
	});
}

/** The host's view of both sign-ins; cached until a sign-in changes or `refresh` is set. */
export async function subscriptionStatus(refresh = false): Promise<SubscriptionStatus> {
	if (cached && !refresh) return cached;
	cached = await request<SubscriptionStatus>("status");
	for (const listener of listeners) listener(cached);
	return cached;
}

/** Status without waiting on, or failing for, a missing host. */
export async function trySubscriptionStatus(refresh = false): Promise<SubscriptionStatus | undefined> {
	try {
		return await subscriptionStatus(refresh);
	} catch {
		return undefined;
	}
}

export function onSubscriptionStatus(listener: (status: SubscriptionStatus | undefined) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function cachedSubscriptionStatus(): SubscriptionStatus | undefined {
	return cached;
}
