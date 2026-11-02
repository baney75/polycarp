/** Small text helpers for Settings > Connect. */

/** "9:41" for the time left on a code, or "" once it has expired. */
export function countdown(expiresAt: number, now: number): string {
	const left = Math.ceil((expiresAt - now) / 1000);
	if (left <= 0) return "";
	return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** "never", "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function lastSeen(iso: string | null, now: number): string {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "never";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
	if (seconds < 60) return "just now";
	if (seconds < 3600) return unit(Math.round(seconds / 60), "minute");
	if (seconds < 86_400) return unit(Math.round(seconds / 3600), "hour");
	return unit(Math.round(seconds / 86_400), "day");
}

/** The connector URL for an origin. */
export const connectorUrl = (origin: string): string => `${origin}/mcp`;

/** The command another device runs to join a hub. */
export const linkCommand = (hubUrl: string, code: string): string => `tabkyra link ${hubUrl} --code ${code}`;
