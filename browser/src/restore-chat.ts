/** Which saved chat the side panel shows when it opens. */
export interface RestoreInput {
	/** `?session=` from the panel URL. */
	session: string | null;
	/** `?new=true` from the panel URL. */
	newChat: boolean;
	/** Saved chats, in any order. */
	saved: ReadonlyArray<{ id: string; lastModified: string }>;
}

/**
 * The chat id to open, or undefined for the empty home screen. An explicit `?session=` wins,
 * then `?new=true` (a fresh chat), then the most recently updated saved chat.
 */
export function pickChatToRestore({ session, newChat, saved }: RestoreInput): string | undefined {
	if (session) return session;
	if (newChat) return undefined;
	let latest: { id: string; lastModified: string } | undefined;
	for (const s of saved) if (!latest || s.lastModified > latest.lastModified) latest = s;
	return latest?.id;
}
