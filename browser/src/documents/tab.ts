/**
 * A tab as a document source. A PDF in Chrome's viewer is its file, downloaded again with the person's sign-in (the
 * viewer's own copy can't be read); any other page is its HTML as it is now, so a page behind a sign-in or built by
 * script comes in as the person sees it.
 */
import { pageHtml } from "../browser/page.js";
import { isPdfTab } from "../offscreen/pdf-client.js";
import type { GetSource } from "./service.js";

const PAGE_CHARS = 8_000_000;

export async function tabSource(tabId: number): Promise<GetSource> {
	const tab = await chrome.tabs.get(tabId);
	const url = tab.url ?? "";
	if (await isPdfTab(tabId)) return { url };
	const page = await pageHtml(tabId, undefined, PAGE_CHARS);
	return { text: page.text, format: "html", title: tab.title ?? "", url, source: "tab" };
}
