/**
 * Files a page starts downloading: a click on an attachment link, a blob or data URL, a file a
 * script made (D49). Seen through the debugger's Page.downloadWillBegin and Page.downloadProgress,
 * which come with the Page.enable cdp.ts sends for dialogs: no downloads permission, so the
 * extension asks for nothing new. Limits: Chrome saves the file in the person's download folder
 * and never tells the debugger the path, and the name is the one the page suggested, which Chrome
 * changes (" (1)") when a file of that name is there. Polycarp never opens the file.
 */
import { onDebuggerSessionEnd } from "./cdp.js";
import { maskUrl } from "./mask-body.js";

export interface Download {
	name: string;
	/** The name's extension, a guess at the kind of file. */
	type?: string;
	url: string;
	state: "started" | "completed" | "canceled";
	bytes?: number;
}

/** Said once beside the list: what the agent can and can't know about a download. */
export const DOWNLOAD_NOTE =
	"Saved by the browser in its download folder; the path isn't known. Polycarp doesn't open files. To read one, use files download with the link's ref.";

const byTab = new Map<number, Map<string, Download & { at: number }>>();
let installed = false;

export function watchDownloads(): void {
	if (installed) return;
	installed = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		if (tabId === undefined) return;
		const p = (params ?? {}) as Record<string, unknown>;
		const guid = String(p.guid ?? "");
		if (method === "Page.downloadWillBegin") {
			const list = byTab.get(tabId) ?? new Map();
			byTab.set(tabId, list);
			const name = String(p.suggestedFilename ?? "").slice(0, 120);
			const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
			const raw = String(p.url ?? "");
			// A data: URL holds the file itself; a signed link's token is masked as files does.
			const url = raw.startsWith("data:") ? `${raw.slice(0, raw.indexOf(",") + 1)}...` : maskUrl(raw).slice(0, 300);
			list.set(guid, { name, ...(ext ? { type: ext } : {}), url, state: "started", at: Date.now() });
			if (list.size > 20) list.delete(list.keys().next().value as string);
		} else if (method === "Page.downloadProgress") {
			const d = byTab.get(tabId)?.get(guid);
			if (!d || p.state === "inProgress") return;
			d.state = p.state === "completed" ? "completed" : "canceled";
			const bytes = Number(p.totalBytes) || Number(p.receivedBytes);
			if (d.state === "completed" && bytes > 0) d.bytes = bytes;
		}
	});
	onDebuggerSessionEnd((tabId) => byTab.delete(tabId));
	chrome.tabs.onRemoved.addListener((tabId) => byTab.delete(tabId));
}

/** Downloads the tab began at or after `since`, waiting up to `waitMs` for those still going to end. */
export async function downloadsSince(tabId: number, since: number, waitMs: number): Promise<Download[]> {
	const mine = () => [...(byTab.get(tabId)?.values() ?? [])].filter((d) => d.at >= since);
	const end = Date.now() + waitMs;
	while (mine().some((d) => d.state === "started") && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	return mine().map(({ at: _, ...d }) => ({ ...d }));
}
