/**
 * Page-level primitives addressed by tab id: navigation with load wait, in-page
 * JavaScript through the userScripts API, and a compact interactive snapshot with
 * stable element refs for click/fill by reference. Everything works on tabs that
 * are not active.
 */

import { cdpSend, isRestrictedUrl } from "./cdp.js";
import { maskUrl } from "./mask-body.js";
import { isUserScriptsGated, userScriptsApi } from "./userscripts-status.js";

const SNAPSHOT_WORLD_ID = "tabkyra-snapshot";
const SNAPSHOT_CSP = "script-src 'unsafe-eval' 'unsafe-inline'; default-src 'none';";

export interface NavigateOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Resolve on DOMContentLoaded (default) or on load complete. */
	waitUntil?: "domcontentloaded" | "load";
}

/**
 * Navigate a tab and wait for its top frame. Returns the final URL.
 *
 * Only events after the new document commits count, so a load still finishing from the
 * previous page cannot satisfy the wait. Same-document navigations (hash or pushState)
 * finish at commit. Network errors reject with Chrome's error code. A page that keeps
 * loading past the timeout resolves with where the tab is; callers report the tab's
 * status so the model knows it may still be loading.
 */
export async function navigateTab(tabId: number, url: string, options: NavigateOptions = {}): Promise<string> {
	return (await navigateTabDetailed(tabId, url, options)).url;
}

/** navigateTab that also says whether the wait ran out before the page was ready. */
export async function navigateTabDetailed(
	tabId: number,
	url: string,
	options: NavigateOptions = {},
): Promise<{ url: string; timedOut: boolean }> {
	const { signal, timeoutMs = 20000, waitUntil = "domcontentloaded" } = options;
	if (signal?.aborted) throw new Error("Aborted");
	return new Promise<{ url: string; timedOut: boolean }>((resolve, reject) => {
		let committed = false;
		const nav = chrome.webNavigation;
		const doneEvent = waitUntil === "load" ? nav.onCompleted : nav.onDOMContentLoaded;
		const cleanup = () => {
			nav.onCommitted.removeListener(onCommitted);
			doneEvent.removeListener(onDone);
			nav.onReferenceFragmentUpdated.removeListener(onSameDocument);
			nav.onHistoryStateUpdated.removeListener(onSameDocument);
			nav.onErrorOccurred.removeListener(onError);
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timer);
		};
		const finish = (fn: () => void) => {
			cleanup();
			fn();
		};
		const top = (d: { tabId: number; frameId: number }) => d.tabId === tabId && d.frameId === 0;
		const onCommitted = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
			if (top(d)) committed = true;
		};
		const onDone = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
			if (top(d) && committed) finish(() => resolve({ url: d.url, timedOut: false }));
		};
		const onSameDocument = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
			if (top(d)) finish(() => resolve({ url: d.url, timedOut: false }));
		};
		const onError = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
			// ERR_ABORTED is a superseded navigation (redirect to a download, a newer navigate).
			if (top(d) && !d.error.includes("ERR_ABORTED"))
				finish(() => reject(new Error(`Navigation to ${url} failed: ${d.error}`)));
		};
		const onAbort = () => finish(() => reject(new Error("Aborted")));
		const timer = setTimeout(() => {
			finish(() => {
				chrome.tabs.get(tabId).then(
					(tab) => resolve({ url: tab.url ?? tab.pendingUrl ?? url, timedOut: true }),
					() => reject(new Error("Navigation timed out and the tab is gone")),
				);
			});
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort);
		nav.onCommitted.addListener(onCommitted);
		doneEvent.addListener(onDone);
		nav.onReferenceFragmentUpdated.addListener(onSameDocument);
		nav.onHistoryStateUpdated.addListener(onSameDocument);
		nav.onErrorOccurred.addListener(onError);
		chrome.tabs.update(tabId, { url }).catch((err: Error) => finish(() => reject(err)));
	});
}

/** Wait for the top frame of a tab to be ready (DOMContentLoaded), bounded. False on timeout. */
export function waitForLoad(tabId: number, timeoutMs = 15000): Promise<boolean> {
	return new Promise((resolve) => {
		let ok = true;
		const done = () => {
			chrome.webNavigation.onCompleted.removeListener(listener);
			chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
			clearTimeout(timer);
			resolve(ok);
		};
		const listener = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
			if (d.tabId === tabId && d.frameId === 0) done();
		};
		const timer = setTimeout(() => {
			ok = false;
			done();
		}, timeoutMs);
		chrome.webNavigation.onCompleted.addListener(listener);
		// DOMContentLoaded is enough to read and act on a page; heavy sites take ages to "complete".
		chrome.webNavigation.onDOMContentLoaded.addListener(listener);
		chrome.tabs.get(tabId).then(
			(tab) => {
				if (tab.status === "complete" && !tab.pendingUrl) done();
			},
			() => done(),
		);
	});
}

export async function goBack(tabId: number): Promise<boolean> {
	await chrome.tabs.goBack(tabId);
	return waitForLoad(tabId);
}

export async function goForward(tabId: number): Promise<boolean> {
	await chrome.tabs.goForward(tabId);
	return waitForLoad(tabId);
}

const configuredWorlds = new Set<string>();

/**
 * Run code in a tab's USER_SCRIPT world and return its JSON-serialisable result.
 * `code` must be an expression or an IIFE; promises are awaited.
 */
export async function runInPage<T = unknown>(tabId: number, code: string, worldId = SNAPSHOT_WORLD_ID): Promise<T> {
	const tab = await chrome.tabs.get(tabId);
	if (tab.url && isRestrictedUrl(tab.url)) {
		throw new Error(`Cannot run scripts on ${tab.url}: browser-internal pages are protected.`);
	}
	const wrapped = `(async () => { try { const __v = await (${code}); return { ok: true, value: __v }; } catch (e) { return { ok: false, error: String(e && e.stack || e) }; } })()`;
	// userScripts needs the "Allow user scripts" toggle; without it, evaluate through the
	// debugger in the main world (CSP does not apply to Runtime.evaluate).
	const api = userScriptsApi();
	if (!api) return cdpEvaluate<T>(tabId, wrapped);
	let results: Awaited<ReturnType<typeof api.execute>>;
	try {
		if (!configuredWorlds.has(worldId)) {
			try {
				await api.configureWorld({ worldId, messaging: true, csp: SNAPSHOT_CSP });
			} catch (err) {
				if (isUserScriptsGated(err)) throw err;
				/* already configured with the same settings */
			}
			configuredWorlds.add(worldId);
		}
		results = await api.execute({
			js: [{ code: wrapped }],
			target: { tabId, allFrames: false },
			world: "USER_SCRIPT",
			worldId,
			injectImmediately: true,
		});
	} catch (err) {
		// Present but refused (permission or toggle): the code never ran, so evaluate it through the debugger.
		if (isUserScriptsGated(err)) return cdpEvaluate<T>(tabId, wrapped);
		throw err;
	}
	const first = results[0];
	if (!first) throw new Error("Script returned no result");
	if (first.error) throw new Error(String((first.error as { message?: string }).message ?? first.error));
	return unwrap<T>(first.result);
}

function unwrap<T>(raw: unknown): T {
	const outcome = raw as { ok: boolean; value?: T; error?: string } | undefined;
	if (!outcome) throw new Error("Script returned no result");
	if (!outcome.ok) throw new Error(outcome.error ?? "Script failed");
	return outcome.value as T;
}

async function cdpEvaluate<T>(tabId: number, wrapped: string): Promise<T> {
	const result = await cdpSend<{
		result: { value?: unknown };
		exceptionDetails?: { exception?: { description?: string }; text?: string };
	}>(tabId, "Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
		);
	}
	return unwrap<T>(result.result.value);
}

// ---------------------------------------------------------------------------
// Snapshot: compact list of interactive and text nodes with refs
// ---------------------------------------------------------------------------

export interface SnapshotNode {
	ref: string;
	role: string;
	name: string;
	value?: string;
	href?: string;
	/** Viewport-relative center, for CDP clicks. */
	x: number;
	y: number;
	width: number;
	height: number;
	visible: boolean;
}

export interface Snapshot {
	url: string;
	title: string;
	viewport: { width: number; height: number; scrollX: number; scrollY: number; pageHeight: number };
	nodes: SnapshotNode[];
	/** Readable text of the page (truncated). */
	text: string;
}

/**
 * Whether a ref's element is still part of the page: attached, and in a document that is
 * still shown, through every same-origin frame up to the tab. A frame that navigated or was
 * removed leaves its old document attached to itself, so isConnected alone says yes.
 * Stringified and injected, so it must be self-contained.
 */
function refLive(el: Element): boolean {
	if (!el.isConnected) return false;
	let doc: Document = el.ownerDocument;
	for (let hops = 0; hops < 20; hops++) {
		const win = doc.defaultView;
		if (!win) return false;
		if (win === win.parent) return true;
		const frame = win.frameElement;
		if (!frame || !frame.isConnected || (frame as HTMLIFrameElement).contentDocument !== doc) return false;
		doc = frame.ownerDocument;
	}
	return false;
}

/**
 * What an element is, for telling whether a ref still names the same control: tag, role,
 * label attributes, link target and, for anything but a text field, its first 80 characters
 * of text. A list that reuses a row's node for another row changes it. Self-contained.
 */
function refPrint(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const a = (n: string) => el.getAttribute(n) ?? "";
	const role = a("role");
	const editable =
		tag === "input" ||
		tag === "textarea" ||
		tag === "select" ||
		(el as HTMLElement).isContentEditable ||
		role === "textbox" ||
		role === "searchbox" ||
		role === "combobox";
	const squash = (t: string | null) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
	const text = editable ? "" : squash(el.textContent);
	// The row a control sits in: a virtualized list reuses a row's "Delete" button for another
	// row, and only the row's text or key tells them apart. A grid cell is not the row; with no
	// row element, the nearest ancestor that carries a row key stands in.
	const KEYS = ["data-key", "data-id", "data-index", "aria-rowindex", "aria-posinset"];
	const key = (n: Element | null | undefined) => (n ? KEYS.map((k) => n.getAttribute(k) ?? "").join(",") : "");
	const row =
		el.parentElement?.closest("tr,li,[role=row],[role=listitem],[role=option],[role=article]") ??
		el.parentElement?.closest(KEYS.map((k) => `[${k}]`).join(","));
	// The row's own text, not what is typed into it, so focus and typing leave it alone; all of
	// it, hashed, so rows that share a long prefix still differ.
	let rowHash = "";
	if (row) {
		const typed = (n: Node | null) => {
			for (let p = n?.parentElement; p && p !== row; p = p.parentElement)
				if ((p as HTMLElement).isContentEditable || p.getAttribute("role") === "textbox") return true;
			return false;
		};
		const walk = el.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
		let h = 0x811c9dc5;
		for (let n = walk.nextNode(); n; n = walk.nextNode()) {
			if (typed(n)) continue;
			const t = (n.nodeValue ?? "").replace(/\s+/g, " ").trim();
			for (let k = 0; k < t.length; k++) h = Math.imul(h ^ t.charCodeAt(k), 0x01000193) >>> 0;
			h = Math.imul(h ^ 32, 0x01000193) >>> 0;
		}
		rowHash = h.toString(36);
	}
	return [
		tag,
		role,
		a("aria-label"),
		a("title"),
		a("name"),
		a("placeholder"),
		a("type"),
		a("href"),
		text,
		key(el),
		key(row),
		rowHash,
	].join("|");
}

/**
 * Where to click an element so the click lands on it: the center of each line box it
 * occupies, then its box's center and quarter points, taking the first point where the
 * element (or its label) is on top. A link that wraps lines has its box center between the
 * lines, over the paragraph or another link. An overlay link to the same address counts as
 * reaching it. Returns what covers it instead when no point
 * reaches it (a cookie banner, a modal, a closed menu left in the page, or nothing at all
 * when it sits off screen). Coordinates are in the element's own document.
 * Self-contained.
 */
export function refPoint(el: Element): { x: number; y: number } | { cover: string } | { offscreen: true } {
	const root = el.getRootNode() as Document | ShadowRoot;
	const hitAt = (x: number, y: number) =>
		typeof root.elementFromPoint === "function"
			? root.elementFromPoint(x, y)
			: el.ownerDocument.elementFromPoint(x, y);
	// Up the composed tree: slotted content goes to its slot, a shadow root to its host.
	const up = (n: Node): Node | null => (n as Element).assignedSlot ?? n.parentNode ?? (n as ShadowRoot).host ?? null;
	const inside = (node: Node | null, target: Node) => {
		for (let n: Node | null = node; n; n = up(n)) if (n === target) return true;
		return false;
	};
	// A control nested in the target (a row's Delete button, an option's checkbox) takes the
	// click for itself, so a point on it doesn't reach the target.
	const CONTROL =
		"a[href],button,input,select,textarea,summary,[onclick],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=treeitem],[role=option]";
	const nestedControl = (at: Element, stop: Node = el) => {
		for (let n: Node | null = at; n && n !== stop && n !== el; n = up(n))
			if (n.nodeType === 1 && (n as Element).matches(CONTROL)) return n as Element;
		return null;
	};
	const labels = Array.from((el as HTMLInputElement).labels ?? []);
	// A card whose whole area is one overlay link to the same address as the title link under
	// it: the click goes where the agent meant.
	// Only for a link that is itself the target and goes somewhere else: not "#", not
	// javascript:, not this page, and not a button inside a card link.
	const sameLink = (at: Element) => {
		if (!el.matches("a[href]")) return false;
		const mine = (el as HTMLAnchorElement).href;
		const theirs = (at.closest("a[href]") as HTMLAnchorElement | null)?.href;
		if (!theirs || theirs !== mine || /^javascript:/i.test(mine)) return false;
		const here = el.ownerDocument.location.href.split("#")[0];
		return mine.split("#")[0] !== here;
	};
	const reaches = (at: Element | null) =>
		!!at &&
		((inside(at, el) && !nestedControl(at)) ||
			labels.some((l) => inside(at, l) && !nestedControl(at, l)) ||
			sameLink(at));
	const r = el.getBoundingClientRect();
	const points: Array<[number, number]> = [];
	for (const box of Array.from(el.getClientRects()).slice(0, 4))
		if (box.width > 0 && box.height > 0) points.push([box.left + box.width / 2, box.top + box.height / 2]);
	points.push([r.left + r.width / 2, r.top + r.height / 2]);
	for (const [fx, fy] of [
		[0.25, 0.25],
		[0.75, 0.25],
		[0.25, 0.75],
		[0.75, 0.75],
	])
		points.push([r.left + r.width * fx, r.top + r.height * fy]);
	let first: Element | null = null;
	for (const [x, y] of points) {
		const at = hitAt(x, y);
		if (reaches(at)) return { x, y };
		first ??= at;
	}
	// Every point outside the window: a control kept off screen for screen readers, or one
	// positioned outside the page. A click can't reach it.
	if (!first) return { offscreen: true };
	const name = (first.getAttribute("aria-label") || (first.textContent ?? ""))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40);
	const role = first.getAttribute("role");
	return { cover: `${first.tagName.toLowerCase()}${role ? ` (${role})` : ""}${name ? ` "${name}"` : ""}` };
}
/**
 * What covers a same-origin frame at the point a click inside it would use, in any page above
 * it: a banner over the frame takes the click even when nothing covers the element inside.
 * (x, y) is in the element's own document. Hit tests run in the frame's own tree, so a frame
 * inside a shadow root is compared within that root. Null when every level is clear or can't
 * be tested, or offscreen when the point falls outside a page's window. Self-contained.
 */
export function refFrameCover(el: Element, x: number, y: number): string | { offscreen: true } | null {
	for (
		let win: Window | null = el.ownerDocument.defaultView;
		win && win !== win.parent && win.frameElement;
		win = win.parent
	) {
		const fr = win.frameElement as HTMLElement;
		const fr0 = fr.getBoundingClientRect();
		const st = (fr.ownerDocument.defaultView || window).getComputedStyle(fr);
		const kx = fr0.width / (fr.offsetWidth || fr0.width || 1);
		const ky = fr0.height / (fr.offsetHeight || fr0.height || 1);
		x = fr0.left + (fr.clientLeft + Number.parseFloat(st.paddingLeft || "0") + x) * kx;
		y = fr0.top + (fr.clientTop + Number.parseFloat(st.paddingTop || "0") + y) * ky;
		const root = fr.getRootNode() as Document | ShadowRoot;
		const over =
			typeof root.elementFromPoint === "function"
				? root.elementFromPoint(x, y)
				: fr.ownerDocument.elementFromPoint(x, y);
		// The point is outside this page's window: the click would reach nothing.
		if (!over) return { offscreen: true };
		if (over !== fr && !fr.contains(over)) {
			const name = (over.getAttribute("aria-label") || over.textContent || "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 40);
			return over.tagName.toLowerCase() + (name ? ` "${name}"` : "");
		}
	}
	return null;
}

/**
 * The element a ref names, or an error the agent can act on. Refuses a ref whose element left
 * the page or now shows something else, rather than acting on whatever holds it now.
 * Self-contained; refLive and refPrint come in as arguments.
 */
function resolveRef(ref: string, live: (el: Element) => boolean, print: (el: Element) => string): Element {
	const w = window as unknown as { __tabkyraRefs?: unknown; __tabkyraRefPrints?: unknown };
	const refs = w.__tabkyraRefs instanceof Map ? (w.__tabkyraRefs as Map<string, Element>) : undefined;
	const prints = w.__tabkyraRefPrints instanceof Map ? (w.__tabkyraRefPrints as Map<string, string>) : undefined;
	const el = refs?.get(ref);
	if (!el || !live(el)) throw new Error(`Ref ${ref} not found: the page changed. Call read_page for fresh refs.`);
	if (prints?.get(ref) !== print(el))
		throw new Error(`Ref ${ref} now shows something else: the page reused it. Call read_page for fresh refs.`);
	return el;
}

/**
 * Page-side snapshot function. Stringified and injected, so it must be
 * self-contained. Stores element refs on window.__tabkyraRefs (same world),
 * so a later click/fill by ref resolves without a second scan.
 *
 * A ref names one element for the life of the document: a second read_page, or the
 * whole-page read find does, gives an element it already named the same ref, and a new
 * element the next unused number. Restarting at e1 each read moved old refs onto other
 * elements, so a click by a ref from an earlier read could land on the wrong control.
 * Numbering starts at a random block per document, so a ref kept from the previous page
 * is very unlikely to name anything on the next one.
 */
function pageSnapshot(
	maxNodes: number,
	maxTextChars: number,
	filter: string,
	live: (el: Element) => boolean,
	print: (el: Element) => string,
): unknown {
	const w = window as unknown as {
		__tabkyraRefs?: unknown;
		__tabkyraRefPrints?: unknown;
		__tabkyraRefOf?: unknown;
		__tabkyraRefSeq?: unknown;
	};
	// Adopt earlier state only when it is what this function wrote.
	const refs = w.__tabkyraRefs instanceof Map ? (w.__tabkyraRefs as Map<string, Element>) : new Map<string, Element>();
	const prints =
		w.__tabkyraRefPrints instanceof Map ? (w.__tabkyraRefPrints as Map<string, string>) : new Map<string, string>();
	const refOf =
		w.__tabkyraRefOf instanceof WeakMap
			? (w.__tabkyraRefOf as WeakMap<Element, string>)
			: new WeakMap<Element, string>();
	w.__tabkyraRefs = refs;
	w.__tabkyraRefPrints = prints;
	w.__tabkyraRefOf = refOf;
	// Forget elements that left the page, so their refs fail instead of piling up.
	for (const [ref, el] of refs)
		if (!live(el)) {
			refs.delete(ref);
			prints.delete(ref);
		}
	// A random start among about a billion, so a ref kept from the last page almost never
	// names something on this one.
	let seq =
		typeof w.__tabkyraRefSeq === "number" && Number.isSafeInteger(w.__tabkyraRefSeq) && w.__tabkyraRefSeq > 0
			? w.__tabkyraRefSeq
			: 1_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900_000_000);
	const interactiveSel =
		"a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=textbox],[role=searchbox],[role=combobox],[role=slider],[role=spinbutton],[role=treeitem],[contenteditable=true],[onclick],[tabindex]:not([tabindex='-1'])";
	const headingSel = "h1,h2,h3,h4,h5,h6,label,[role=heading],[role=alert],[role=status],[role=dialog]";
	const selector = filter === "interactive" ? interactiveSel : `${interactiveSel},${headingSel}`;
	const tagOf = (el: Element) => el.tagName.toLowerCase();
	// Elements from a frame belong to another realm, so `instanceof` against this window's
	// classes is false for them: everything below goes by tag name instead.
	const field = (el: Element) =>
		el as unknown as {
			type?: string;
			value?: string;
			checked?: boolean;
			disabled?: boolean;
			required?: boolean;
			placeholder?: string;
			href?: string;
			selectedIndex?: number;
			options?: ArrayLike<{ text: string }>;
		};
	const isVisible = (el: Element) => {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return false;
		const style = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
		return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
	};
	const roleOf = (el: Element): string => {
		// The page writes this attribute: only a plain role token, so it can't break the line.
		const role = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0];
		if (role) return /^[a-z-]{1,30}$/.test(role) ? role : "generic";
		const tag = tagOf(el);
		if (tag === "a") return "link";
		if (tag === "input") {
			const type = field(el).type;
			if (type === "submit" || type === "button" || type === "reset") return "button";
			if (type === "checkbox" || type === "radio") return type;
			if (type === "range") return "slider";
			return "textbox";
		}
		if (tag === "textarea") return "textbox";
		if (tag === "select") return "combobox";
		if (tag === "button" || tag === "summary") return "button";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "label") return "label";
		if (tag === "iframe" || tag === "frame") return "iframe";
		if (el.getAttribute("contenteditable") === "true") return "textbox";
		return "generic";
	};
	const nameOf = (el: Element): string => {
		const root = el.getRootNode() as Document | ShadowRoot;
		const byId = (id: string) => root.getElementById?.(id) ?? el.ownerDocument.getElementById(id);
		const aria = el.getAttribute("aria-label");
		if (aria) return aria.trim();
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			const t = labelledBy
				.split(/\s+/)
				.map((id) => byId(id)?.textContent ?? "")
				.join(" ")
				.trim();
			if (t) return t;
		}
		const tag = tagOf(el);
		if (tag === "input" || tag === "textarea" || tag === "select") {
			const f = field(el);
			const id = el.id;
			if (id) {
				const label = root.querySelector(`label[for="${CSS.escape(id)}"]`);
				if (label?.textContent?.trim()) return label.textContent.trim();
			}
			const parentLabel = el.closest("label");
			if (parentLabel?.textContent?.trim()) return parentLabel.textContent.trim();
			if (tag === "input" && (f.type === "checkbox" || f.type === "radio")) {
				// No label of its own (TodoMVC's item toggle). Text a person would call its name, best first.
				const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
				const isControl = (c: Element) =>
					c.tagName === "INPUT" &&
					((c as HTMLInputElement).type === "checkbox" || (c as HTMLInputElement).type === "radio");
				const isPlainLabel = (c: Element | null): c is Element =>
					!!c && c.tagName === "LABEL" && !c.hasAttribute("for");
				// 1. The label beside it. A group lays out one way (label before each control, or after):
				//    settle that from its first member, so a label is never taken by its neighbour.
				const siblings = Array.from(el.parentElement?.children ?? []);
				const firstMember = siblings.find((c) => isControl(c) || isPlainLabel(c));
				const labelFirst = !!firstMember && isPlainLabel(firstMember);
				const beside = labelFirst ? el.previousElementSibling : el.nextElementSibling;
				if (isPlainLabel(beside) && clean(beside.textContent)) return clean(beside.textContent);
				// 2. The text of its row, when the row is one control's: a real row container holding
				//    this control alone, or its parent when nothing else there takes input and the
				//    text is short. Links, other labels and buttons in the row are not its name.
				const real = el.closest("li,tr,[role=row],[role=listitem],[role=option],[role=menuitemcheckbox]");
				const parent = el.parentElement;
				const row =
					real && real.querySelectorAll("input[type=checkbox],input[type=radio]").length === 1
						? real
						: !real && parent && parent.querySelectorAll("input,select,textarea,button").length === 1
							? parent
							: null;
				if (row) {
					const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
					const parts: string[] = [];
					for (let n = walker.nextNode(); n; n = walker.nextNode()) {
						if (
							n.parentElement?.closest(
								"a,label[for],[role=link],button,select,textarea,[role=button],script,style",
							)
						)
							continue;
						const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
						if (t) parts.push(t);
					}
					const text = parts.join(" ");
					// A parent that is not a real row must be short: long text is the page's, not the label's.
					if (text && (real || text.length <= 80)) return clean(text);
				}
				// 3. A value that means something ("on" is what a checkbox without one reports), a title, a name.
				if (f.value && f.value !== "on") return clean(f.value);
				return el.getAttribute("title") ?? el.getAttribute("name") ?? "";
			}
			if (tag === "input" && (f.placeholder || f.value) && f.type !== "password")
				return (f.placeholder || f.value) ?? "";
			if (tag === "textarea" && f.placeholder) return f.placeholder;
			return el.getAttribute("name") ?? el.getAttribute("title") ?? "";
		}
		if (tag === "iframe" || tag === "frame") return el.getAttribute("title") ?? el.getAttribute("name") ?? "";
		const img = el.querySelector("img[alt]");
		if (img && !el.textContent?.trim()) return img.getAttribute("alt") ?? "";
		return (el.textContent ?? "").replace(/\s+/g, " ").trim() || (el.getAttribute("title") ?? "");
	};
	/** What a control is doing right now: open, on, picked, unavailable. */
	const statesOf = (el: Element): string[] => {
		const at = (n: string) => el.getAttribute(n);
		const out: string[] = [];
		const expanded =
			at("aria-expanded") ??
			(tagOf(el) === "summary" ? String(!!(el.parentElement as { open?: boolean } | null)?.open) : null);
		if (expanded === "true") out.push("expanded");
		else if (expanded === "false") out.push("collapsed");
		if (at("aria-pressed") === "true") out.push("pressed");
		if (at("aria-selected") === "true") out.push("selected");
		if (at("aria-checked") === "true") out.push("checked");
		else if (at("aria-checked") === "mixed") out.push("mixed");
		if (at("aria-current") && at("aria-current") !== "false") out.push("current");
		if (el.matches(":disabled") || at("aria-disabled") === "true") out.push("disabled");
		if (field(el).required || at("aria-required") === "true") out.push("required");
		if (at("aria-invalid") === "true") out.push("invalid");
		return out;
	};

	// Every place elements live: the document, each open shadow root (web components), and
	// each same-origin frame. A frame's own transform (scale), border and padding map its
	// coordinates to the tab's: x_tab = dx + sx * x_frame.
	type Root = { root: Document | ShadowRoot; dx: number; dy: number; sx: number; sy: number; frame?: string };
	const roots: Root[] = [];
	const crossFrames: Array<{ el: Element; at: Root }> = [];
	const isShadow = (root: Node) => root.nodeType === 11;
	// A frame's address without its query or fragment, which can carry a token (?secret=...).
	const frameUrl = (el: Element) =>
		String((el as HTMLIFrameElement).src || el.getAttribute("src") || "").split(/[?#]/)[0];
	const inner = (fr: Element, at: Root) => {
		const r = fr.getBoundingClientRect();
		const style = (fr.ownerDocument.defaultView ?? window).getComputedStyle(fr);
		const layoutW = (fr as HTMLElement).offsetWidth || r.width || 1;
		const layoutH = (fr as HTMLElement).offsetHeight || r.height || 1;
		const kx = r.width / layoutW;
		const ky = r.height / layoutH;
		return {
			dx: at.dx + at.sx * (r.left + (fr.clientLeft + Number.parseFloat(style.paddingLeft || "0")) * kx),
			dy: at.dy + at.sy * (r.top + (fr.clientTop + Number.parseFloat(style.paddingTop || "0")) * ky),
			sx: at.sx * kx,
			sy: at.sy * ky,
		};
	};
	const visit = (at: Root, depth: number) => {
		roots.push(at);
		if (depth > 12) return;
		for (const el of Array.from(at.root.querySelectorAll("*"))) {
			const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
			// A web component with display:none adds nothing a user sees. Any other host is entered,
			// even one with no box (display:contents, a zero-size fixed overlay): each element inside
			// is checked on its own, and text is kept only where it renders.
			if (shadow && (el.ownerDocument.defaultView ?? window).getComputedStyle(el).display !== "none")
				visit({ ...at, root: shadow }, depth + 1);
			const tag = tagOf(el);
			if (tag !== "iframe" && tag !== "frame") continue;
			let doc: Document | null = null;
			try {
				doc = (el as HTMLIFrameElement).contentDocument;
			} catch {
				doc = null;
			}
			if (doc?.documentElement) {
				if (isVisible(el))
					visit({ root: doc, ...inner(el, at), frame: frameUrl(el) || "(inline frame)" }, depth + 1);
			} else crossFrames.push({ el, at });
		}
	};
	visit({ root: document, dx: 0, dy: 0, sx: 1, sy: 1 }, 0);
	const cross = new Set(crossFrames.map((c) => c.el));

	const nodes: unknown[] = [];
	// Elements in the viewport first, then the rest in document order: on long pages the
	// cap used to be spent on navigation chrome above the fold and the content was cut.
	const inView: Array<{ el: Element; at: Root }> = [];
	const offView: Array<{ el: Element; at: Root }> = [];
	const box = (el: Element, at: Root) => {
		const r = el.getBoundingClientRect();
		const left = at.dx + at.sx * r.left;
		const top = at.dy + at.sy * r.top;
		const width = r.width * at.sx;
		const height = r.height * at.sy;
		const onScreen = top + height > 0 && top < window.innerHeight && left + width > 0 && left < window.innerWidth;
		return { left, top, width, height, onScreen };
	};
	const place = (el: Element, at: Root) => {
		if (!isVisible(el)) return;
		(box(el, at).onScreen ? inView : offView).push({ el, at });
	};
	for (const at of roots)
		for (const el of Array.from(at.root.querySelectorAll(selector))) if (!cross.has(el)) place(el, at);
	// A frame Tabkyra can't look into (another site) is still listed, so the agent knows it's there.
	for (const { el, at } of crossFrames) place(el, at);
	for (const { el, at } of [...inView, ...offView]) {
		if (nodes.length >= maxNodes) break;
		const b = box(el, at);
		// The same element keeps its ref; one that now shows something else (a reused list
		// row) gets a new one, and its old ref stops resolving.
		const fp = print(el);
		let ref = refOf.get(el);
		if (ref && prints.get(ref) !== fp) {
			refs.delete(ref);
			prints.delete(ref);
			ref = undefined;
		}
		if (!ref) {
			do ref = `e${++seq}`;
			while (refs.has(ref));
			refOf.set(el, ref);
		}
		refs.set(ref, el);
		prints.set(ref, fp);
		const tag = tagOf(el);
		const f = field(el);
		const node: Record<string, unknown> = {
			ref,
			role: roleOf(el),
			name: nameOf(el).slice(0, 120),
			x: Math.round(b.left + b.width / 2),
			y: Math.round(b.top + b.height / 2),
			width: Math.round(b.width),
			height: Math.round(b.height),
			visible: b.onScreen,
		};
		if (tag === "a" && f.href) node.href = String(f.href).slice(0, 200);
		if (cross.has(el)) {
			node.href = frameUrl(el).slice(0, 200);
			node.states = ["cross-origin: read it with navigate to its URL"];
		}
		if (tag === "input") {
			if (f.type === "checkbox" || f.type === "radio") node.value = f.checked ? "checked" : "unchecked";
			else if (f.type !== "password" && f.value) node.value = String(f.value).slice(0, 120);
		} else if (tag === "textarea" && f.value) node.value = String(f.value).slice(0, 120);
		else if (tag === "select" && f.options && f.selectedIndex !== undefined)
			node.value = f.options[f.selectedIndex]?.text ?? "";
		const states = statesOf(el);
		if (states.length && !node.states) node.states = states;
		if (at.frame) node.frame = at.frame.slice(0, 120);
		nodes.push(node);
	}
	w.__tabkyraRefSeq = seq;

	// Text: the document, then what shadow roots and same-origin frames render, which
	// document.body.innerText leaves out. Rendered text only: nothing hidden reaches the agent.
	// Hidden includes visibility:hidden and opacity:0; display:contents has no box of its own,
	// so the nearest ancestor with one decides.
	const rendered = (c: Element): boolean => {
		const view = c.ownerDocument.defaultView ?? window;
		const style = view.getComputedStyle(c);
		if (style.display === "contents") {
			// No box, but its visibility still applies to what it holds.
			if (style.visibility !== "visible") return false;
			const up = c.parentElement ?? ((c.getRootNode() as ShadowRoot).host as Element | undefined);
			return up ? rendered(up) : true;
		}
		const check = (c as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
		return check ? check.call(c, { visibilityProperty: true, opacityProperty: true }) : isVisible(c);
	};
	// A shadow root's own text: element children that render, and text written straight into it
	// when the host renders.
	const shadowText = (root: Document | ShadowRoot) =>
		Array.from(root.childNodes)
			.map((c) =>
				c.nodeType === 3
					? isShadow(root) && rendered((root as ShadowRoot).host)
						? (c.textContent ?? "").trim()
						: ""
					: c.nodeType === 1 &&
							tagOf(c as Element) !== "style" &&
							tagOf(c as Element) !== "script" &&
							rendered(c as Element)
						? ((c as HTMLElement).innerText ?? "")
						: "",
			)
			.filter(Boolean)
			.join("\n");
	const parts = [document.body?.innerText ?? ""];
	for (const at of roots.slice(1)) {
		const own = isShadow(at.root) ? shadowText(at.root) : ((at.root as Document).body?.innerText ?? "");
		if (own.trim()) parts.push(at.frame && !isShadow(at.root) ? `[frame ${at.frame}]\n${own}` : own);
	}
	const text = parts
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.slice(0, maxTextChars);
	return {
		url: location.href,
		title: document.title,
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			scrollX: Math.round(window.scrollX),
			scrollY: Math.round(window.scrollY),
			pageHeight: document.documentElement.scrollHeight,
		},
		nodes,
		text,
	};
}

/**
 * A map of how the page is built, for an agent working out where its data comes from: the
 * framework, embedded JSON (names and top-level keys, not contents), forms (field names, never
 * values), frames, web components, script hosts and storage key names (never values).
 * Self-contained: it runs in the page.
 */
function pageInspect(): unknown {
	const all = Array.from(document.querySelectorAll("*"));
	const has = (sel: string) => !!document.querySelector(sel);
	const scripts = Array.from(document.scripts);
	const srcs = scripts.map((x) => x.src).filter(Boolean);
	const anySrc = (re: RegExp) => srcs.some((u) => re.test(u));
	const frameworks: string[] = [];
	if (has("#__next") || has("script#__NEXT_DATA__") || anySrc(/\/_next\//)) frameworks.push("Next.js");
	if (has("#__nuxt") || anySrc(/\/_nuxt\//)) frameworks.push("Nuxt");
	// Modern React leaves no markup; the bridge checks its expando properties in the page's own world.
	if (has("[data-reactroot]")) frameworks.push("React");
	if (has("[ng-version]"))
		frameworks.push(`Angular ${document.querySelector("[ng-version]")?.getAttribute("ng-version") ?? ""}`.trim());
	if (has("[data-v-app]") || all.some((el) => Array.from(el.attributes).some((a) => a.name.startsWith("data-v-"))))
		frameworks.push("Vue");
	if (all.some((el) => /\bsvelte-/.test(el.getAttribute("class") ?? ""))) frameworks.push("Svelte");
	if (anySrc(/wp-content|wp-includes/)) frameworks.push("WordPress");
	if (anySrc(/cdn\.shopify\.com/)) frameworks.push("Shopify");
	const generator = document.querySelector('meta[name="generator"]')?.getAttribute("content");
	if (generator) frameworks.push(`generator: ${generator.slice(0, 60)}`);

	const keysOf = (text: string): string => {
		try {
			const v = JSON.parse(text);
			if (Array.isArray(v)) return `array of ${v.length}`;
			if (v && typeof v === "object") {
				// A schema.org type name (Product, Recipe) says what the blob is; any other value stays out.
				const type = (v as Record<string, unknown>)["@type"];
				const schemaType = typeof type === "string" && /^[A-Z][A-Za-z]{1,40}$/.test(type) ? type : undefined;
				const keys = Object.keys(v).slice(0, 12).join(", ");
				return schemaType ? `@type ${schemaType}; keys ${keys}` : `keys ${keys}`;
			}
			return typeof v;
		} catch {
			return "not JSON";
		}
	};
	const data = scripts
		.filter((x) => /json/i.test(x.type))
		.slice(0, 20)
		.map((x) => ({ id: x.id || undefined, type: x.type, chars: x.text.length, shape: keysOf(x.text) }));

	const forms = Array.from(document.forms)
		.slice(0, 15)
		.map((f) => ({
			action: f.getAttribute("action") ?? "",
			method: (f.getAttribute("method") ?? "get").toLowerCase(),
			fields: Array.from(f.elements)
				.map((e) => {
					const name = e.getAttribute("name") ?? e.id;
					const type = e.getAttribute("type") ?? e.tagName.toLowerCase();
					return name ? `${name}:${type}` : "";
				})
				.filter(Boolean)
				.slice(0, 25),
		}));

	const frames = Array.from(document.querySelectorAll("iframe,frame"))
		.slice(0, 15)
		.map((f) => {
			let sameOrigin = false;
			try {
				sameOrigin = !!(f as HTMLIFrameElement).contentDocument;
			} catch {
				sameOrigin = false;
			}
			return { src: f.getAttribute("src") ?? "", sameOrigin };
		});

	const hosts = all.filter((el) => (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot);
	const shadowTags = [...new Set(hosts.map((el) => el.tagName.toLowerCase()))].slice(0, 12);
	const customTags = [...new Set(all.map((el) => el.tagName.toLowerCase()).filter((t) => t.includes("-")))].slice(
		0,
		15,
	);

	const scriptHosts: Record<string, number> = {};
	for (const u of srcs) {
		try {
			const h = new URL(u).host;
			scriptHosts[h] = (scriptHosts[h] ?? 0) + 1;
		} catch {
			/* not a URL */
		}
	}
	// Names only, and a name's account-specific parts (an email, a UUID, a long id) become [id]:
	// some sites put the signed-in user in key names.
	const anonymous = (name: string) =>
		name
			.replace(/[^\s.:/|]*@[^\s.:/|]+(?:\.[^\s.:/|]+)*/g, "[id]")
			.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
			.replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "[id]")
			.slice(0, 120);
	// Reading window.localStorage itself throws on some pages (sandboxed, storage blocked).
	const storageKeys = (get: () => Storage | undefined) => {
		try {
			const st = get();
			return st
				? Array.from({ length: Math.min(st.length, 30) }, (_, i) => anonymous(st.key(i) ?? "")).filter(Boolean)
				: [];
		} catch {
			return [];
		}
	};
	let cookieNames: string[] = [];
	try {
		cookieNames = document.cookie
			.split(";")
			.map((c) => anonymous(c.split("=")[0]?.trim() ?? ""))
			.filter(Boolean)
			.slice(0, 30);
	} catch {
		cookieNames = [];
	}
	return {
		url: location.href,
		title: document.title,
		frameworks,
		data,
		forms,
		frames,
		shadowRoots: hosts.length,
		shadowTags,
		customTags,
		scripts: { inline: scripts.filter((x) => !x.src).length, hosts: scriptHosts },
		storage: {
			local: storageKeys(() => window.localStorage),
			session: storageKeys(() => window.sessionStorage),
			cookies: cookieNames,
		},
		serviceWorker: !!navigator.serviceWorker?.controller,
		elements: all.length,
	};
}

export async function inspectPage(tabId: number): Promise<Record<string, unknown>> {
	const map = await runInPage<Record<string, unknown>>(tabId, `(${pageInspect.toString()})()`);
	// Addresses can carry tokens (/reset?token=..., an embed's ?secret=...).
	if (typeof map.url === "string") map.url = maskUrl(map.url);
	for (const f of (map.forms ?? []) as Array<{ action: string }>) f.action = maskUrl(f.action);
	for (const f of (map.frames ?? []) as Array<{ src: string }>) f.src = maskUrl(f.src).slice(0, 160);
	return map;
}

export async function snapshot(
	tabId: number,
	options: { maxNodes?: number; maxTextChars?: number; filter?: "interactive" | "all" } = {},
): Promise<Snapshot> {
	const { maxNodes = 300, maxTextChars = 20000, filter = "all" } = options;
	const snap = await runInPage<Snapshot>(
		tabId,
		`(${pageSnapshot.toString()})(${maxNodes}, ${maxTextChars}, ${JSON.stringify(filter)}, ${refLive.toString()}, ${refPrint.toString()})`,
	);
	if (typeof snap?.url === "string") snap.url = maskUrl(snap.url);
	return snap;
}

/** Resolve a ref (from a snapshot) or CSS selector to its viewport center. */
export async function locate(
	tabId: number,
	target: { ref?: string; selector?: string },
): Promise<{ x: number; y: number; width: number; height: number }> {
	const code = `(async () => {
		let el = null;
		const ref = ${JSON.stringify(target.ref ?? "")};
		const sel = ${JSON.stringify(target.selector ?? "")};
		// A ref that no longer resolves falls back to a selector given with it, as before.
		if (ref) {
			try { el = (${resolveRef.toString()})(ref, ${refLive.toString()}, ${refPrint.toString()}); }
			catch (e) { if (!sel) throw e; }
		}
		if (!el && sel) el = document.querySelector(sel);
		if (!el) throw new Error("Selector not found: " + sel + ". read_page or find gives refs.");
		if (!el.isConnected) throw new Error("Element is no longer in the page. Call read_page for fresh refs.");
		// An element in a same-origin frame: bring the frame into view, then the element, and
		// add each frame's offset so the point is in the tab's coordinates.
		const frames = [];
		for (let win = el.ownerDocument.defaultView; win && win !== window && win.frameElement; win = win.parent) frames.push(win.frameElement);
		for (const fr of frames.slice().reverse()) fr.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		// Let the page react to the scroll (a header that slides in, a banner, content that moves)
		// before testing what is on top. A tab in the background draws no frames; don't wait there.
		if (document.visibilityState === "visible")
			await Promise.race([new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))), new Promise((ok) => setTimeout(ok, 200))]);
		// Innermost frame outward: each frame scales the point by its transform, then adds its own
		// position, border and padding (the same mapping read_page uses).
		const r = el.getBoundingClientRect();
		const st0 = (el.ownerDocument.defaultView || window).getComputedStyle(el);
		if ((r.width === 0 && r.height === 0) || st0.visibility === "hidden")
			throw new Error((ref ? "Ref " + ref : "That element") + " isn't shown now (hidden or closed). Call read_page for fresh refs.");
		const spot = (${refPoint.toString()})(el);
		const who = ref ? "Ref " + ref : "That element";
		const covered = (by) => new Error(who + " is covered by " + by + ", which would take the click. Close or dismiss it, or click that instead, then call read_page.");
		if (spot.offscreen) throw new Error(who + " is outside the visible page (kept off screen), so a click can't reach it.");
		if (spot.cover) throw covered(spot.cover);
		const frameCover = (${refFrameCover.toString()})(el, spot.x, spot.y);
		if (frameCover && typeof frameCover === "object") throw new Error(who + " is outside the visible page (kept off screen), so a click can't reach it.");
		if (frameCover) throw covered(frameCover);
		let x = spot.x;
		let y = spot.y;
		let w = r.width;
		let h = r.height;
		for (const fr of frames) {
			const fr0 = fr.getBoundingClientRect();
			const st = (fr.ownerDocument.defaultView || window).getComputedStyle(fr);
			const kx = fr0.width / (fr.offsetWidth || fr0.width || 1);
			const ky = fr0.height / (fr.offsetHeight || fr0.height || 1);
			x = fr0.left + (fr.clientLeft + parseFloat(st.paddingLeft || "0") + x) * kx;
			y = fr0.top + (fr.clientTop + parseFloat(st.paddingTop || "0") + y) * ky;
			w *= kx;
			h *= ky;
		}
		return { x, y, width: w, height: h };
	})()`;
	return runInPage(tabId, code);
}

/** Set a form control's value the way frameworks expect (native setter + input/change). */
export async function fillElement(
	tabId: number,
	target: { ref?: string; selector?: string },
	value: string,
): Promise<void> {
	const code = `(async () => {
		let el = null;
		let byRef = false;
		const ref = ${JSON.stringify(target.ref ?? "")};
		const sel = ${JSON.stringify(target.selector ?? "")};
		// A ref that no longer resolves falls back to a selector given with it, as before.
		if (ref) {
			try { el = (${resolveRef.toString()})(ref, ${refLive.toString()}, ${refPrint.toString()}); byRef = true; }
			catch (e) { if (!sel) throw e; }
		}
		if (!el && sel) el = document.querySelector(sel);
		if (!el) throw new Error("Selector not found: " + sel + ". read_page or find gives refs.");
		if (byRef) {
			// Bring the field into view and let the page react, then make sure the ref still names
			// it: a list that re-renders on scroll can hand the node to another row meanwhile.
			el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
			if (document.visibilityState === "visible")
				await Promise.race([new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))), new Promise((ok) => setTimeout(ok, 200))]);
			const again = (${resolveRef.toString()})(ref, ${refLive.toString()}, ${refPrint.toString()});
			if (again !== el) throw new Error("Ref " + ref + " now shows something else: the page reused it. Call read_page for fresh refs.");
			// A field in a dialog that closed keeps its ref; writing into it would put a value
			// the user can't see into the next submit.
			const r0 = el.getBoundingClientRect();
			const st0 = (el.ownerDocument.defaultView || window).getComputedStyle(el);
			if ((r0.width === 0 && r0.height === 0) || st0.visibility === "hidden")
				throw new Error("Ref " + ref + " isn't shown now (hidden or closed). Call read_page for fresh refs.");
			// A field under a modal, or one a dialog slid off screen as it closed.
			const spot = (${refPoint.toString()})(el);
			const frame = spot.offscreen || spot.cover ? null : (${refFrameCover.toString()})(el, spot.x, spot.y);
			if (spot.offscreen || (frame && typeof frame === "object"))
				throw new Error("Ref " + ref + " is outside the visible page, so it can't be filled. Call read_page for fresh refs.");
			const cover = spot.cover || frame;
			if (cover) throw new Error("Ref " + ref + " is covered by " + cover + ". Close or dismiss it, then call read_page.");
		}
		const value = ${JSON.stringify(value)};
		// The element's own window: one in a frame belongs to another realm, where this
		// window's HTMLInputElement and its value setter don't apply.
		const W = el.ownerDocument.defaultView || window;
		el.focus();
		if (el instanceof W.HTMLSelectElement) {
			const opt = Array.from(el.options).find(o => o.value === value || o.text.trim() === value);
			if (!opt) throw new Error("No option matches " + value + ". read_page lists the options (value=...).");
			el.value = opt.value;
			el.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
			el.dispatchEvent(new W.Event("change", { bubbles: true }));
			return true;
		}
		if (el instanceof W.HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
			const want = value === "true" || value === "checked" || value === "1";
			if (el.checked !== want) el.click();
			return true;
		}
		if (el instanceof W.HTMLInputElement || el instanceof W.HTMLTextAreaElement) {
			const proto = el instanceof W.HTMLTextAreaElement ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value");
			if (setter && setter.set) setter.set.call(el, value); else el.value = value;
			el.dispatchEvent(new W.InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
			el.dispatchEvent(new W.Event("change", { bubbles: true }));
			return true;
		}
		if (el.isContentEditable) {
			el.textContent = value;
			el.dispatchEvent(new W.InputEvent("input", { bubbles: true, composed: true }));
			return true;
		}
		throw new Error("Element is not a form control: use click or type on it instead of fill.");
	})()`;
	await runInPage(tabId, code);
}

export async function pageText(tabId: number, selector?: string, maxChars = 50000): Promise<string> {
	const code = `(() => {
		const sel = ${JSON.stringify(selector ?? "")};
		const el = sel ? document.querySelector(sel) : document.body;
		if (!el) throw new Error("Selector not found: " + sel + ". read_page or find gives refs.");
		// Text inside web components (open shadow roots) and same-origin frames, which innerText
		// leaves out, follows the element's own text. Rendered text only: nothing hidden.
		// Hidden includes visibility:hidden and opacity:0; display:contents has no box, so the
		// nearest ancestor with one decides.
		const shown = (c) => {
			const view = c.ownerDocument && c.ownerDocument.defaultView;
			const style = view && view.getComputedStyle(c);
			if (style && style.display === "contents") {
				if (style.visibility !== "visible") return false;
				const up = c.parentElement || (c.getRootNode && c.getRootNode().host);
				return up ? shown(up) : true;
			}
			return c.checkVisibility ? c.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : !!(c.getClientRects && c.getClientRects().length);
		};
		const parts = [el.innerText || ""];
		const own = (root) => Array.from(root.childNodes).map((c) => c.nodeType === 3 ? (c.textContent || "").trim() : c.nodeType === 1 && !/^(style|script)$/i.test(c.tagName) && shown(c) ? (c.innerText ?? "") : "").filter(Boolean).join("\\n");
		const visit = (root, depth) => {
			if (depth > 12) return;
			const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
			// The selected element itself can be the host or the frame.
			if (depth === 0 && root.nodeType === 1) nodes.unshift(root);
			for (const node of nodes) {
				if (node.shadowRoot && shown(node)) {
					const t = own(node.shadowRoot);
					if (t.trim()) parts.push(t);
					visit(node.shadowRoot, depth + 1);
				}
				if (/^i?frame$/i.test(node.tagName) && shown(node)) {
					let doc = null;
					try { doc = node.contentDocument; } catch { doc = null; }
					if (doc && doc.body) {
						parts.push("[frame " + (String(node.src || node.getAttribute("src") || "inline").split(/[?#]/)[0]) + "]\\n" + (doc.body.innerText || ""));
						visit(doc, depth + 1);
					}
				}
			}
		};
		visit(el, 0);
		return parts.join("\\n").slice(0, ${maxChars});
	})()`;
	return runInPage<string>(tabId, code);
}

export async function pageHtml(tabId: number, selector?: string, maxChars = 200000): Promise<string> {
	const code = `(() => {
		const sel = ${JSON.stringify(selector ?? "")};
		const el = sel ? document.querySelector(sel) : document.documentElement;
		if (!el) throw new Error("Selector not found: " + sel + ". read_page or find gives refs.");
		return el.outerHTML.slice(0, ${maxChars});
	})()`;
	return runInPage<string>(tabId, code);
}

/** Scroll the page or an element; returns the new scroll position. */
export async function scrollPage(
	tabId: number,
	options: { dx?: number; dy?: number; selector?: string; ref?: string; to?: "top" | "bottom" },
): Promise<{ scrollX: number; scrollY: number; pageHeight: number }> {
	const code = `(() => {
		const o = ${JSON.stringify(options)};
		let target = null;
		// A ref that no longer resolves falls back to a selector given with it, as click and fill do.
		if (o.ref) {
			try { target = (${resolveRef.toString()})(o.ref, ${refLive.toString()}, ${refPrint.toString()}); }
			catch (e) { if (!o.selector) throw e; }
		}
		if (!target && o.selector) target = document.querySelector(o.selector);
		if (!target && o.selector) throw new Error("Selector not found: " + o.selector + ". read_page or find gives refs.");
		if (target) target.scrollIntoView({ block: "center", behavior: "instant" });
		else if (o.to === "top") window.scrollTo(0, 0);
		else if (o.to === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
		else window.scrollBy(o.dx || 0, o.dy || 0);
		return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight };
	})()`;
	return runInPage(tabId, code);
}

/** Wait until a selector appears, text is present, or the URL matches. */
export async function waitFor(
	tabId: number,
	condition: { selector?: string; text?: string; urlIncludes?: string },
	timeoutMs = 10000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (condition.urlIncludes && (tab.url ?? "").includes(condition.urlIncludes)) return true;
			if (condition.selector || condition.text) {
				const found = await runInPage<boolean>(
					tabId,
					`(() => { const s = ${JSON.stringify(condition.selector ?? "")}; const t = ${JSON.stringify(condition.text ?? "")};
					if (s && document.querySelector(s)) return true;
					if (t && (document.body?.innerText || "").includes(t)) return true;
					return false; })()`,
				);
				if (found) return true;
			}
		} catch {
			/* page is navigating; try again */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}
