/** Which saved chat the side panel shows when it opens. */
export interface RestoreInput {
	/** `?session=` from the panel URL. */
	session: string | null;
	/** `?new=true` from the panel URL. */
	newChat: boolean;
	/** Saved chats, in any order. */
	saved: ReadonlyArray<{ id: string; lastModified: string }>;
	/** The chat this window's panel last showed, if any. */
	remembered?: string;
	/** Chats other open panel windows are showing right now. */
	takenByOthers?: ReadonlySet<string>;
}

/**
 * The chat id to open, or undefined for the empty home screen. In order: an explicit
 * `?session=`; `?new=true` (a fresh chat); this window's own last chat, if the store still has
 * it; the most recently updated saved chat, only when no other open window is showing it (two
 * panels on one chat would overwrite each other's turns).
 */
export function pickChatToRestore({
	session,
	newChat,
	saved,
	remembered,
	takenByOthers = new Set(),
}: RestoreInput): string | undefined {
	if (session) return session;
	if (newChat) return undefined;
	if (remembered && saved.some((s) => s.id === remembered)) return remembered;
	let latest: { id: string; lastModified: string } | undefined;
	for (const s of saved) if (!latest || s.lastModified > latest.lastModified) latest = s;
	return latest && !takenByOthers.has(latest.id) ? latest.id : undefined;
}

const LAST_CHAT_PREFIX = "panel_last_chat_";
/** Written by background.ts: windows with a connected panel. */
const OPEN_WINDOWS_KEY = "sidepanel_open_windows";

/** Remember (or with no id, forget) the chat this window's panel shows. */
export async function rememberChat(windowId: number, chatId: string | undefined): Promise<void> {
	const key = `${LAST_CHAT_PREFIX}${windowId}`;
	if (chatId) await chrome.storage.session.set({ [key]: chatId });
	else await chrome.storage.session.remove(key);
}

/** The chat this window's panel last showed. */
export async function rememberedChat(windowId: number): Promise<string | undefined> {
	const key = `${LAST_CHAT_PREFIX}${windowId}`;
	const value = (await chrome.storage.session.get(key))[key];
	return typeof value === "string" ? value : undefined;
}

/** Chats the other open panel windows are showing. */
export async function chatsOfOtherWindows(windowId: number): Promise<Set<string>> {
	const data = await chrome.storage.session.get(OPEN_WINDOWS_KEY);
	const open = ((data[OPEN_WINDOWS_KEY] as number[] | undefined) ?? []).filter((w) => w !== windowId);
	const taken = new Set<string>();
	for (const w of open) {
		const id = await rememberedChat(w);
		if (id) taken.add(id);
	}
	return taken;
}
