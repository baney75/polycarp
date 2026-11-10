/**
 * What the in-use veil shares between extension contexts: its on/off setting (Settings > Agents)
 * and, per tab, the tag name of the element it draws in. The page readers (get_page_html,
 * inspect_page) leave that element out of what they return. The tag is random per document,
 * so a page cannot find the veil by a fixed name, and it lives in session storage, so the side
 * panel and a restarted worker know it too.
 */

export const VEIL_ENABLED_KEY = "veil_enabled";
/** The side panel's Light / Dark / System switch, mirrored where the worker can read it (appearance/mode.ts). */
export const MODE_MIRROR_KEY = "tabkyra.mode";
const TAGS_KEY = "veil_tags";

export async function isVeilEnabled(): Promise<boolean> {
	const data = await chrome.storage.local.get(VEIL_ENABLED_KEY);
	return data[VEIL_ENABLED_KEY] !== false;
}

export async function setVeilEnabled(enabled: boolean): Promise<void> {
	await chrome.storage.local.set({ [VEIL_ENABLED_KEY]: enabled });
}

/** A fresh tag name: two runs of lowercase letters joined by a hyphen (a valid custom element name). */
export function newVeilTag(random: () => number = Math.random): string {
	const letters = (n: number) =>
		Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join("");
	return `${letters(5)}-${letters(6)}`;
}

/** Whether a string is a tag `newVeilTag` makes; anything else is never put into page code. */
export function isVeilTag(tag: unknown): tag is string {
	return typeof tag === "string" && /^[a-z]{5}-[a-z]{6}$/.test(tag);
}

const cache = new Map<number, string>();

async function readTags(): Promise<Record<string, string>> {
	try {
		return ((await chrome.storage.session.get(TAGS_KEY))[TAGS_KEY] as Record<string, string> | undefined) ?? {};
	} catch {
		return {};
	}
}

/** The veil tag in use on a tab, or undefined when no veil is drawn there. */
export async function veilTag(tabId: number): Promise<string | undefined> {
	const known = cache.get(tabId);
	if (known) return known;
	const tag = (await readTags())[tabId];
	return isVeilTag(tag) ? tag : undefined;
}

let writes: Promise<unknown> = Promise.resolve();

/** Record (or with undefined, forget) a tab's veil tag. Writes go one at a time. */
export function rememberVeilTag(tabId: number, tag: string | undefined): Promise<void> {
	if (tag) cache.set(tabId, tag);
	else cache.delete(tabId);
	const write = writes.then(async () => {
		const tags = await readTags();
		if (tag) tags[tabId] = tag;
		else delete tags[tabId];
		await chrome.storage.session.set({ [TAGS_KEY]: tags }).catch(() => undefined);
	});
	writes = write.catch(() => undefined);
	return write;
}

/** Every tab a veil tag is stored for: what a restarted worker clears. */
export async function storedVeilTags(): Promise<Array<[number, string]>> {
	return Object.entries(await readTags())
		.filter(([, tag]) => isVeilTag(tag))
		.map(([id, tag]) => [Number(id), tag]);
}
