/**
 * Site edits: changes to how a site looks or loads, kept per site and applied on every visit.
 *
 * - hide: CSS selectors whose elements are hidden (a banner, a sidebar, an ad slot).
 * - block: a request pattern blocked on that site only (a tracker, an ad server, an autoplay video).
 * - script: JavaScript that runs on the site after it loads. It runs with the user's sign-in on every visit, so
 *   an agent can only propose one: it stays off until the person turns it on in Settings > Sites.
 *
 * Ad blocking is one switch for a list of known ad networks (static/ads-rules.json).
 *
 * This file holds the rules and the storage; site-edits/apply.ts makes the browser follow them.
 */

export type EditKind = "hide" | "block" | "script";
/** Who changed it. Only "person" can turn a script on. */
export type Actor = "person" | "agent";

export interface SiteEdit {
	id: string;
	/** Lowercase host without "www.", like "x.com". The edit applies there and on its subdomains. */
	host: string;
	kind: EditKind;
	/** Selectors for hide, a request pattern for block, source code for script. */
	value: string;
	note: string;
	/** "agent:<name>" or "you". */
	addedBy: string;
	on: boolean;
	createdAt: number;
}

export interface SiteEditsState {
	edits: SiteEdit[];
	adBlock: boolean;
}

export const STORAGE_KEY = "tk-site-edits";
export const MAX_EDITS = 300;
const MAX_SELECTORS = 2000;
const MAX_PATTERN = 500;
const MAX_SCRIPT = 50_000;

export class SiteEditError extends Error {}

/** "https://www.X.com/home" or "X.com" -> "x.com". Throws on anything that isn't a plain host. */
/**
 * Suffixes many unrelated sites share. An edit there would reach all of them, so it's refused. Not the whole public suffix list:
 * the common ones, and every two-letter country code with a short second-level name (co.uk, com.au).
 */
const SHARED = new Set([
	"github.io",
	"gitlab.io",
	"blogspot.com",
	"wordpress.com",
	"tumblr.com",
	"substack.com",
	"medium.com",
	"vercel.app",
	"netlify.app",
	"pages.dev",
	"workers.dev",
	"herokuapp.com",
	"web.app",
	"firebaseapp.com",
	"appspot.com",
	"azurewebsites.net",
	"cloudfront.net",
	"s3.amazonaws.com",
	"glitch.me",
	"repl.co",
	"fly.dev",
	"onrender.com",
	"ngrok.io",
	"ngrok-free.app",
	"trycloudflare.com",
	"ts.net",
]);

export function sharedSuffix(host: string): boolean {
	return SHARED.has(host) || /^(co|com|org|net|gov|edu|ac|or|ne|go)\.[a-z]{2}$/.test(host);
}

/** A guarded host ("host" or "host:port") that `host` or one of its subdomains is, if any: an edit on `host` would reach it. */
export function guardedUnder(host: string, guarded: readonly string[]): string | undefined {
	for (const entry of guarded) {
		const h = entry
			.toLowerCase()
			.replace(/^\[|\]$/g, "")
			.replace(/:\d+$/, "")
			.replace(/\.$/, "");
		if (h === host || h.endsWith(`.${host}`)) return h;
	}
	return undefined;
}

export function normalizeHost(raw: string): string {
	let host = raw.trim().toLowerCase();
	try {
		if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
	} catch {
		throw new SiteEditError(`${raw} isn't a site.`);
	}
	host = host.replace(/^www\./, "").replace(/\.$/, "");
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253)
		throw new SiteEditError(`${raw} isn't a site. Use one like example.com.`);
	if (sharedSuffix(host))
		throw new SiteEditError(
			`${host} is shared by many sites, so an edit there would reach all of them. Name the site itself.`,
		);
	return host;
}

/** Whether `url` is on `host` or one of its subdomains. */
export function onHost(url: string | undefined, host: string): boolean {
	if (!url) return false;
	let h: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		h = parsed.hostname.toLowerCase();
	} catch {
		return false;
	}
	return h === host || h.endsWith(`.${host}`);
}

/**
 * Selectors only. A brace, an at-rule or url() would let one edit add any CSS, and CSS can read what is
 * typed into a page (attribute selectors with background images) and send it out.
 */
export function checkSelectors(raw: string): string {
	const selectors = raw.trim();
	if (!selectors) throw new SiteEditError("Give at least one CSS selector to hide.");
	if (selectors.length > MAX_SELECTORS)
		throw new SiteEditError(`Selectors are limited to ${MAX_SELECTORS} characters.`);
	if (/[{};@\\]|url\s*\(|<\/?style/i.test(selectors))
		throw new SiteEditError("Only selectors: no braces, semicolons, @ rules, backslashes or url().");
	// An open comment, bracket, parenthesis or quote would run into the next edit's rule in the same sheet.
	if (/\/\*|\*\//.test(selectors)) throw new SiteEditError("No comments in selectors.");
	if (!balanced(selectors)) throw new SiteEditError("Unbalanced brackets, parentheses or quotes in the selectors.");
	return selectors;
}

function balanced(text: string): boolean {
	const stack: string[] = [];
	let quote = "";
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "(" || ch === "[") stack.push(ch === "(" ? ")" : "]");
		else if ((ch === ")" || ch === "]") && stack.pop() !== ch) return false;
	}
	return !quote && stack.length === 0;
}

/** A request pattern in the browser's own syntax (`||ads.example.com^`, `/banner/`), never the page itself. */
export function checkPattern(raw: string): string {
	const pattern = raw.trim();
	if (!pattern) throw new SiteEditError("Give a request pattern to block, like ||ads.example.com^ or /banner/.");
	if (pattern.length > MAX_PATTERN) throw new SiteEditError(`A pattern is limited to ${MAX_PATTERN} characters.`);
	if (/\s/.test(pattern)) throw new SiteEditError("A pattern has no spaces.");
	// The browser refuses the whole list over one rule it can't take, and every block would stop with it.
	if (!/^[\x21-\x7e]+$/.test(pattern))
		throw new SiteEditError("Plain ASCII only in a pattern. Encode other characters as the URL does (%C3%BC).");
	if (pattern.slice(2).includes("||") || (pattern.includes("||") && !pattern.startsWith("||")))
		throw new SiteEditError("|| goes only at the start, for a domain: ||ads.example.com^");
	// A bare "*", "|", "^" or the like would block everything the site loads.
	// So would a scheme alone ("https://") or a domain that starts with a wildcard ("||*ads").
	if (
		pattern.replace(/[*|^/]/g, "").length < 3 ||
		/^\|?(https?|wss?):?\/*\*?$/i.test(pattern) ||
		/^\|\|\*/.test(pattern)
	)
		throw new SiteEditError("That pattern would block everything on the site. Name what to block.");
	return pattern;
}

function checkScript(raw: string): string {
	if (!raw.trim()) throw new SiteEditError("The script is empty.");
	if (raw.length > MAX_SCRIPT) throw new SiteEditError(`A script is limited to ${MAX_SCRIPT} characters.`);
	return raw;
}

export function checkValue(kind: EditKind, value: string): string {
	if (kind === "hide") return checkSelectors(value);
	if (kind === "block") return checkPattern(value);
	return checkScript(value);
}

/** The state after an addition. A script from an agent starts off; hide and block start on (each is one click to undo). */
export function added(
	state: SiteEditsState,
	input: { host: string; kind: EditKind; value: string; note?: string; actor: Actor; who: string },
	id: string,
	now: number,
): { state: SiteEditsState; edit: SiteEdit } {
	if (!["hide", "block", "script"].includes(input.kind))
		throw new SiteEditError(`Unknown kind ${input.kind}: hide, block or script.`);
	if (state.edits.length >= MAX_EDITS)
		throw new SiteEditError(`There are already ${MAX_EDITS} site edits. Remove some in Settings > Sites.`);
	const host = normalizeHost(input.host);
	const value = checkValue(input.kind, input.value);
	const duplicate = state.edits.find((e) => e.host === host && e.kind === input.kind && e.value === value);
	if (duplicate) return { state, edit: duplicate };
	const edit: SiteEdit = {
		id,
		host,
		kind: input.kind,
		value,
		note: (input.note ?? "").trim().slice(0, 200),
		addedBy: input.actor === "person" ? "you" : `agent:${input.who.slice(0, 60)}`,
		on: input.kind !== "script" || input.actor === "person",
		createdAt: now,
	};
	return { state: { ...state, edits: [...state.edits, edit] }, edit };
}

/** Turning an edit on or off. Only the person turns a script on. */
export function switched(state: SiteEditsState, id: string, on: boolean, actor: Actor): SiteEditsState {
	const edit = state.edits.find((e) => e.id === id);
	if (!edit) throw new SiteEditError(`No site edit ${id}.`);
	if (on && edit.kind === "script" && actor !== "person") {
		throw new SiteEditError(
			"Only the person turns a script on, in Settings > Sites. It runs with their sign-in on every visit.",
		);
	}
	return { ...state, edits: state.edits.map((e) => (e.id === id ? { ...e, on } : e)) };
}

export function removed(state: SiteEditsState, id: string): SiteEditsState {
	if (!state.edits.some((e) => e.id === id)) throw new SiteEditError(`No site edit ${id}.`);
	return { ...state, edits: state.edits.filter((e) => e.id !== id) };
}

/**
 * One stylesheet for a document on `url`: every hide edit that is on and covers it, each its own rule. One selector the browser
 * can't read drops only its own rule, never the other edits on the site.
 */
export function hideCss(state: SiteEditsState, url: string | undefined): string {
	return state.edits
		.filter((e) => e.on && e.kind === "hide" && onHost(url, e.host))
		.map((e) => `${e.value} { display: none !important; }`)
		.join("\n");
}

/** The rule list the browser's network blocker takes for the block edits that are on. Ids come from `base`. */
export function blockRules(
	state: SiteEditsState,
	base: number,
): Array<{ id: number; priority: number; action: { type: "block" }; condition: Record<string, unknown> }> {
	return state.edits
		.filter((e) => e.on && e.kind === "block")
		.map((e, i) => ({
			id: base + i,
			priority: 1,
			action: { type: "block" as const },
			// Only on that site, and never the page itself: a bad pattern can break a page but not stop it opening.
			condition: { urlFilter: e.value, initiatorDomains: [e.host], resourceTypes: SUB_RESOURCES },
		}));
}

export const SUB_RESOURCES = [
	"sub_frame",
	"stylesheet",
	"script",
	"image",
	"font",
	"object",
	"xmlhttprequest",
	"ping",
	"media",
	"websocket",
	"other",
];

/** Storage, through the one key. */
export async function load(): Promise<SiteEditsState> {
	const data = await chrome.storage.local.get(STORAGE_KEY);
	const raw = data[STORAGE_KEY] as Partial<SiteEditsState> | undefined;
	return { edits: Array.isArray(raw?.edits) ? raw.edits : [], adBlock: raw?.adBlock === true };
}

async function save(state: SiteEditsState): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/** Every change goes through here, one at a time, so two changes can't overwrite each other. */
export async function change<T>(fn: (state: SiteEditsState) => { state: SiteEditsState; result: T }): Promise<T> {
	return navigator.locks.request(STORAGE_KEY, async () => {
		const { state, result } = fn(await load());
		await save(state);
		return result;
	});
}

export function newId(): string {
	return crypto.randomUUID().slice(0, 8);
}
