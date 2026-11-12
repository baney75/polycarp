/**
 * A change report (D43) held to a size. Every report is held to CHANGES_MAX_CHARS when it is made, and the side
 * panel holds it again to the room its model has for one tool result (context-guard.ts), so the report counts against
 * that budget like any read. What goes first: new text lines, then element lines from the longest list, then the
 * opened tabs; what is left out is counted in `more`. A report that still does not fit says only that the page
 * changed and read_page shows it, never "nothing changed".
 */

/** The ceiling on one report as JSON, about 750 tokens: a report is a summary, never the page. */
export const CHANGES_MAX_CHARS = 3000;

export const CHANGES_TOO_LONG = "changed, too much to show here; read_page shows it";

const size = (v: unknown) => JSON.stringify(v).length;

export function fitChanges<T>(changes: T, maxChars: number): T | Record<string, unknown> {
	if (!changes || typeof changes !== "object" || size(changes) <= maxChars) return changes;
	const out: Record<string, unknown> = { ...(changes as Record<string, unknown>) };
	for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = [...(out[k] as unknown[])];
	const before = /^(\d+) more/.exec(String(out.more ?? ""));
	let dropped = before ? Number(before[1]) : 0;
	const arr = (k: string) => (Array.isArray(out[k]) ? (out[k] as unknown[]) : []);
	const fits = () => {
		if (dropped) out.more = `${dropped} more; read_page lists them`;
		return size(out) <= maxChars;
	};
	// New text first: get_page_text shows it, and its lines are the longest.
	while (arr("newText").length && !fits()) {
		arr("newText").pop();
		out.moreText = (Number(out.moreText) || 0) + 1;
		if (!arr("newText").length) delete out.newText;
	}
	for (;;) {
		if (fits()) return out;
		const longest = ["appeared", "changed", "gone"].sort((a, b) => arr(b).length - arr(a).length)[0];
		if (!arr(longest).length) break;
		arr(longest).pop();
		if (!arr(longest).length) delete out[longest];
		dropped++;
	}
	while (arr("tabsOpened").length > 1 && !fits()) arr("tabsOpened").pop();
	if (fits()) return out;
	return { page: CHANGES_TOO_LONG };
}
