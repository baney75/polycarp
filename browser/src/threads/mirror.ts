/**
 * The local mirror of the side panel's threads (service worker side). The panel's session store
 * announces each save, rename and delete; this module waits for a quiet moment (streaming saves
 * come many per second), renders the thread and hands it to the native host, which writes
 * ~/.local/share/tabkyra/threads/<id>.md and <id>.json and keeps index.json. When a host
 * connects, the whole set is sent again (and files of threads deleted meanwhile go). Private
 * threads are never sent, and an existing copy is deleted. Settings > Privacy turns it off,
 * which removes the mirror.
 */

import type { ExtThreadsMirror } from "../bridge/protocol.js";
import { redactSecrets } from "../privacy/bug-reports.js";
import { THREAD_CHANGED } from "./events.js";
import { MIRROR_KEY } from "./keys.js";
import { modelOf, renderMarkdown, sanitizeJson, validThreadId } from "./render.js";
import { agentsMayRead, listThreadMeta, markSharingStart, readThread, SHARE_OLDER_KEY } from "./store.js";

export { MIRROR_KEY };
/** Quiet time before a changed thread is written; a streaming reply saves many times. */
export const DEBOUNCE_MS = 2000;
/** Threads sent when a host connects, newest first. */
const RESYNC_LIMIT = 500;

type Send = (message: ExtThreadsMirror) => boolean;

let send: Send = () => false;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export async function mirrorEnabled(): Promise<boolean> {
	const data = await chrome.storage.local.get(MIRROR_KEY).catch(() => ({}) as Record<string, unknown>);
	return (data as Record<string, unknown>)[MIRROR_KEY] !== false;
}

/** Render one thread and send it, or send its deletion when it's gone or private. */
export async function mirrorThread(id: string): Promise<void> {
	if (!validThreadId(id) || !(await mirrorEnabled())) return;
	const { meta, data } = await readThread(id);
	if (!data || !meta || !(await agentsMayRead())(meta, data)) {
		send({ type: "threads_mirror", op: "delete", id });
		return;
	}
	send({
		type: "threads_mirror",
		op: "put",
		id,
		md: renderMarkdown(data),
		json: `${JSON.stringify(sanitizeJson(data), null, 2)}\n`,
		meta: {
			id,
			title: redactSecrets(data.title ?? ""),
			createdAt: data.createdAt,
			lastModified: data.lastModified,
			messageCount: data.messages.length,
			model: modelOf(data),
		},
	});
}

/** A thread changed: write it once it has been quiet for DEBOUNCE_MS. */
export function scheduleMirror(id: string): void {
	if (!validThreadId(id)) return;
	clearTimeout(timers.get(id));
	timers.set(
		id,
		setTimeout(() => {
			timers.delete(id);
			void mirrorThread(id).catch(() => undefined);
		}, DEBOUNCE_MS),
	);
}

/** Send every readable thread, and the list of ids so the host drops files of deleted ones. */
export async function resyncMirror(): Promise<void> {
	// Off: make sure no copy is left, even one written before it was turned off while no host ran.
	if (!(await mirrorEnabled())) {
		send({ type: "threads_mirror", op: "clear" });
		return;
	}
	const may = await agentsMayRead();
	const metas = (await listThreadMeta()).filter((m) => validThreadId(m.id) && may(m)).slice(0, RESYNC_LIMIT);
	send({ type: "threads_mirror", op: "sync", ids: metas.map((m) => m.id) });
	for (const m of metas) await mirrorThread(m.id).catch(() => undefined);
}

/** Wire the mirror into the worker. `sender` posts to the native host (false when there is none). */
export function startThreadMirror(sender: Send): void {
	send = sender;
	void markSharingStart().catch(() => undefined);
	chrome.runtime.onMessage?.addListener((message: { type?: string; id?: string }) => {
		if (message?.type === THREAD_CHANGED && typeof message.id === "string") scheduleMirror(message.id);
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !(MIRROR_KEY in changes || SHARE_OLDER_KEY in changes)) return;
		if (changes[MIRROR_KEY]?.newValue === false) send({ type: "threads_mirror", op: "clear" });
		else void resyncMirror().catch(() => undefined);
	});
}
