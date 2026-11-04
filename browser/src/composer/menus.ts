/**
 * What the composer's "/" (skills) and "@" (tabs) menus list, in what order. Pure, so the
 * ordering and filtering rules are tested on their own (test/composer.test.mjs).
 */

/** The fields of pi-web-ui's SlashCommand this module fills. */
export interface MenuItem {
	id: string;
	title: string;
	description?: string;
	hint?: string;
	value: string;
	disabled?: boolean;
	iconUrl?: string;
	section?: string;
}

export interface SiteSkillInfo {
	name: string;
	shortDescription: string;
	domainPatterns: string[];
}

export interface LibrarySkillInfo {
	name: string;
	description: string;
}

/** The first sentence of a skill description: what `tabkyra skill list` shows. */
export function firstSentence(description: string): string {
	const first = description.split(/(?<=\.)\s/)[0] ?? description;
	return first.trim();
}

/** 0: name starts with the query, 1: name contains it, 2: description does, -1: no match. */
function rank(query: string, name: string, description: string): number {
	if (!query) return 0;
	const n = name.toLowerCase();
	if (n.startsWith(query)) return 0;
	if (n.includes(query)) return 1;
	if (description.toLowerCase().includes(query)) return 2;
	return -1;
}

function filterSection<T>(items: T[], query: string, name: (t: T) => string, desc: (t: T) => string): T[] {
	return items
		.map((t, i) => ({ t, i, r: rank(query, name(t), desc(t)) }))
		.filter((x) => x.r >= 0)
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.map((x) => x.t);
}

/**
 * The "/" menu: site skills that match the current page first, then the bundled library,
 * then site skills for other sites. Each section filters by the query (name first, then
 * description). A name appears once, in its first section. Every skill is listed; the menu
 * scrolls, so none is dropped.
 */
export function skillMenuItems(
	query: string,
	siteSkills: readonly SiteSkillInfo[],
	matchingSite: ReadonlySet<string>,
	library: readonly LibrarySkillInfo[],
): MenuItem[] {
	const q = query.trim().toLowerCase().replace(/^\//, "");
	const seen = new Set<string>();
	const out: MenuItem[] = [];
	const add = (item: MenuItem) => {
		if (seen.has(item.id)) return;
		seen.add(item.id);
		out.push(item);
	};
	const onSite = siteSkills.filter((s) => matchingSite.has(s.name));
	for (const s of filterSection(
		onSite,
		q,
		(s) => s.name,
		(s) => s.shortDescription,
	))
		add({
			id: s.name,
			title: s.name,
			description: s.shortDescription,
			hint: "this site",
			value: `/${s.name}`,
			section: "This site",
		});
	for (const s of filterSection(
		[...library],
		q,
		(s) => s.name,
		(s) => s.description,
	))
		add({
			id: s.name,
			title: s.name,
			description: firstSentence(s.description),
			value: `/${s.name}`,
			section: "Library",
		});
	const elsewhere = siteSkills.filter((s) => !matchingSite.has(s.name));
	for (const s of filterSection(
		elsewhere,
		q,
		(s) => s.name,
		(s) => s.shortDescription,
	))
		add({
			id: s.name,
			title: s.name,
			description: s.shortDescription,
			hint: s.domainPatterns[0],
			value: `/${s.name}`,
			section: "Other sites",
		});
	return out;
}

export interface TabInfoLite {
	id?: number;
	title?: string;
	url?: string;
	favIconUrl?: string;
	incognito?: boolean;
}

export interface TabMenuContext {
	/** Tabs this chat's session owns (listed first). */
	sessionTabIds: ReadonlySet<number>;
	/** Tabs another agent session owns: tab id to that session's label. */
	otherOwners: ReadonlyMap<number, string>;
	isRestricted: (url: string) => boolean;
}

export function hostOf(url: string | undefined): string {
	try {
		return url ? new URL(url).hostname.replace(/^www\./, "") : "";
	} catch {
		return "";
	}
}

/**
 * The "@" menu: the window's tabs, this session's own first. Private (incognito) tabs are never
 * listed. Pages the agent can't use (chrome://, the extension's own) and tabs another agent
 * owns are listed but can't be chosen; the hint says why.
 */
export function tabMenuItems(query: string, tabs: readonly TabInfoLite[], ctx: TabMenuContext): MenuItem[] {
	const q = query.trim().toLowerCase();
	const usable = tabs.filter((t): t is TabInfoLite & { id: number } => typeof t.id === "number" && !t.incognito);
	const matches = (t: TabInfoLite) =>
		!q || (t.title ?? "").toLowerCase().includes(q) || (t.url ?? "").toLowerCase().includes(q) || String(t.id) === q;
	const item = (t: TabInfoLite & { id: number }, section: string): MenuItem => {
		const url = t.url ?? "";
		const restricted = !url || ctx.isRestricted(url);
		const owner = ctx.otherOwners.get(t.id);
		return {
			id: `tab-${t.id}`,
			title: t.title || url || "Browser page",
			description: hostOf(url) || url,
			iconUrl: t.favIconUrl && !t.favIconUrl.startsWith("chrome://") ? t.favIconUrl : undefined,
			value: `@tab:${t.id}`,
			section,
			disabled: restricted || owner !== undefined,
			hint: restricted ? "unavailable" : owner !== undefined ? `used by ${owner}` : undefined,
		};
	};
	const mine = usable.filter((t) => ctx.sessionTabIds.has(t.id) && matches(t));
	const rest = usable.filter((t) => !ctx.sessionTabIds.has(t.id) && matches(t));
	return [...mine.map((t) => item(t, "This chat's tabs")), ...rest.map((t) => item(t, "Other tabs"))];
}
