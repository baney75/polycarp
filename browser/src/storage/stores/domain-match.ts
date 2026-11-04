import { minimatch } from "minimatch";

/**
 * Does `url` match any of a site skill's domain patterns? A pattern is a host glob with an
 * optional path glob: `calendar.google.com`, `google.*\/search*`, `docs.google.com/spreadsheets/**`.
 * The host must match the whole host name (a leading `www.` is ignored on both sides), so
 * `calendar.google.com` never matches `mail.google.com`. Only http and https pages match.
 */
export function matchesDomainPatterns(url: string, patterns: readonly string[]): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const host = parsed.hostname.replace(/^www\./, "");
	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (!trimmed) continue;
		const slash = trimmed.indexOf("/");
		const hostPattern = (slash < 0 ? trimmed : trimmed.slice(0, slash)).replace(/^www\./, "");
		const pathPattern = slash < 0 ? "" : trimmed.slice(slash);
		if (!hostPattern || !minimatch(host, hostPattern, { nocase: true, dot: true })) continue;
		if (!pathPattern || pathPattern === "/" || minimatch(parsed.pathname, pathPattern, { nocase: true })) return true;
	}
	return false;
}

/** The host a URL belongs to for "once per site visit" (no `www.`), or undefined. */
export function siteOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "") || undefined;
	} catch {
		return undefined;
	}
}
