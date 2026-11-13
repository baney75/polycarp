/**
 * Cross-origin frames (decision D46). A frame from another origin is closed to the page's own
 * script, so the snapshot only listed it. Through the debugger every frame is reachable:
 * - one from another site runs in its own process: `Target.setAutoAttach` (flatten) gives it a
 *   child session, and commands go to `{tabId, sessionId}`;
 * - one from the same site (another port or subdomain) runs in the tab's process, in its tree.
 * Code runs in a "polycarp" isolated world of the frame (`Page.createIsolatedWorld`, which reuses
 * the world by name), so its refs live where the page's script can't reach them, as they do in
 * the top document. A frame's elements get refs with the frame's tag in front ("fk3z9e123"); the
 * tag is a hash of the frame's id, so a ref finds its frame again with no state kept here.
 */
import { cdpSend, cdpSendSession, onDebuggerSessionEnd } from "./cdp.js";

export interface PageFrame {
	/** Ref prefix: "f" and four base-36 characters. */
	tag: string;
	frameId: string;
	/** The session the frame's document answers in; none for the tab's own process. */
	sessionId?: string;
	/** The session whose document holds the frame's <iframe> element. */
	ownerSessionId?: string;
	url: string;
	/** The frame's content box, top left, in the tab's viewport (CSS px). */
	offset: { x: number; y: number };
	/** Its <iframe>'s border box as drawn, center and size in the tab's viewport: what read_page lists it with. */
	box: { x: number; y: number; width: number; height: number };
	/** Where the owner session's viewport starts in the tab's: points sent to it subtract this. */
	base: { x: number; y: number };
	/** Tab CSS px per frame CSS px: below 1 for a frame drawn smaller (a transform). */
	scale: number;
	/** The same for the owner session's viewport (1 for the tab's own). */
	baseScale: number;
	/**
	 * The frame the owner session measures from (none for the tab's): kept by id, since a same-process
	 * frame shares its owner's session and can't be told from it by session.
	 */
	rootFrameId?: string;
	/** The frame and the frames around it, outermost first, for scrolling and cover checks. */
	chain: PageFrame[];
	/** On a host not allowed for agents: listed by its host, never read or acted in. */
	blocked?: boolean;
}

/**
 * Why a frame is not read, by its URL: "guarded" (the approval page, #94) leaves it out with
 * everything inside it; "blocked" (a host not allowed for agents) lists it by its host only.
 */
export type FrameBar = "guarded" | "blocked" | undefined;
export type FrameRule = (url: string) => FrameBar | Promise<FrameBar>;
/** The rule for a caller that gave none: no frame is read or acted in. */
export const FRAMES_CLOSED: FrameRule = () => "guarded";

const WORLD = "polycarp";
/** At most this many frames are read (readFrames in page.ts), and this deep: an ad grid can't run up the cost. */
export const MAX_FRAMES = 10;
export const MAX_DEPTH = 3;
/** Frames placed per look, hidden ones included: those read are picked from them by what the page shows. */
const MAX_PLACED = 30;
/** The most one debugger call about a frame may take: a frame that doesn't answer is left out, not waited on. */
export const FRAME_CALL_MS = 1000;
/** The most finding a tab's frames may take, all calls together: a frame that hasn't answered by then is left out. */
export const FRAMES_MS = 1500;

/** A call's time limit, FRAME_CALL_MS or what is left before `end`, whichever is less. */
const callMs = (end?: number) =>
	end === undefined ? FRAME_CALL_MS : Math.max(0, Math.min(FRAME_CALL_MS, end - Date.now()));
let groups = 0;
/** An object group of its own, so one call releasing its objects never frees another's. */
const group = () => `${WORLD}-${++groups}`;

/** A call's value, or undefined when it fails or takes longer than `ms`. */
export function bounded<T>(work: Promise<T>, ms = FRAME_CALL_MS): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work.catch(() => undefined),
		new Promise<undefined>((done) => {
			timer = setTimeout(done, ms, undefined);
		}),
	]).finally(() => clearTimeout(timer));
}

interface Child {
	sessionId: string;
	url: string;
	/** The session that announced it: the tab's (undefined) or a parent frame's. */
	parent?: string;
}

/** Out-of-process frames per tab: target id (the frame's id) to its session. */
const children = new Map<number, Map<string, Child>>();
/** Tabs whose auto-attach this worker turned on, so every frame was announced to it. */
const primed = new Set<number>();
let installed = false;

const AUTO = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

function install(): void {
	if (installed) return;
	installed = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		if (tabId === undefined) return;
		if (method === "Target.attachedToTarget") {
			const p = params as { sessionId?: string; targetInfo?: { targetId?: string; type?: string; url?: string } };
			if (p.targetInfo?.type !== "iframe" || !p.sessionId || !p.targetInfo.targetId) return;
			const map = children.get(tabId) ?? new Map<string, Child>();
			children.set(tabId, map);
			map.set(p.targetInfo.targetId, {
				sessionId: p.sessionId,
				url: p.targetInfo.url ?? "",
				parent: source.sessionId,
			});
			// A frame inside it announces its own frames. A box it opens keeps its session (cdp.ts PageDialog.sessionId).
			void cdpSendSession(tabId, p.sessionId, "Target.setAutoAttach", AUTO).catch(() => undefined);
			void cdpSendSession(tabId, p.sessionId, "Page.enable").catch(() => undefined);
		} else if (method === "Target.detachedFromTarget") {
			const p = params as { sessionId?: string };
			const map = children.get(tabId);
			for (const [id, c] of map ?? []) if (c.sessionId === p.sessionId) map?.delete(id);
		} else if (method === "Target.targetInfoChanged") {
			const p = params as { targetInfo?: { targetId?: string; url?: string } };
			const c = p.targetInfo?.targetId ? children.get(tabId)?.get(p.targetInfo.targetId) : undefined;
			if (c && p.targetInfo?.url) c.url = p.targetInfo.url;
		}
	});
	const forget = (tabId: number) => {
		children.delete(tabId);
		primed.delete(tabId);
	};
	onDebuggerSessionEnd(forget);
	chrome.tabs.onRemoved.addListener(forget);
}

async function prime(tabId: number): Promise<void> {
	install();
	if (primed.has(tabId)) return;
	// A worker that restarted lost the sessions while the browser kept auto-attach on: off and on
	// again, so each frame is announced to this worker.
	await cdpSend(tabId, "Target.setAutoAttach", { ...AUTO, autoAttach: false }).catch(() => undefined);
	children.delete(tabId);
	await cdpSend(tabId, "Target.setAutoAttach", AUTO);
	primed.add(tabId);
}

/** A short, stable tag for a frame id. */
export function frameTag(frameId: string): string {
	let h = 2166136261;
	for (let i = 0; i < frameId.length; i++) h = Math.imul(h ^ frameId.charCodeAt(i), 16777619);
	return `f${((h >>> 0) % 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** A frame ref ("fk3z9e123") split into its frame tag and the ref inside the frame. */
export function splitFrameRef(ref: string): { tag: string; inner: string } | undefined {
	const m = /^(f[0-9a-z]{4})(e\d+)$/.exec(ref);
	return m ? { tag: m[1], inner: m[2] } : undefined;
}

interface TreeNode {
	frame: { id: string; url: string; urlFragment?: string; securityOrigin?: string };
	childFrames?: TreeNode[];
}

const originOf = (f: TreeNode["frame"]) => f.securityOrigin ?? "";
/** Only web pages are read: never an extension page, an error page or a browser page. */
export const web = (url: string) => /^(https?|file):/.test(url);

/**
 * The tab's cross-origin frames, outermost first: each frame whose origin differs from the
 * document around it. A same-origin frame inside one is read with it, as the top document reads
 * its own. `rule` bars a frame by URL: a guarded one is left out with everything inside it, a
 * blocked one is placed (so read_page can name it) and nothing inside it is.
 */
export async function crossOriginFrames(tabId: number, rule: FrameRule = FRAMES_CLOSED): Promise<PageFrame[]> {
	const end = Date.now() + FRAMES_MS;
	await prime(tabId);
	// Announcements arrive just after auto-attach turns on: wait until every frame the browser
	// knows of is accounted for, briefly.
	const expected = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null))?.length ?? 0;
	const until = Date.now() + 300;
	let found: { frames: PageFrame[]; seen: number };
	for (;;) {
		found = await collect(tabId, rule, end);
		if (found.seen >= expected || Date.now() >= Math.min(until, end)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	return found.frames;
}

/** Where a frame's contents stand: inside this frame (none: the tab's own document), or "out" (not read). */
type Inside = PageFrame | undefined | "out";

async function collect(tabId: number, rule: FrameRule, end: number): Promise<{ frames: PageFrame[]; seen: number }> {
	const frames: PageFrame[] = [];
	// Every frame looked at or left out is counted, so the caller stops waiting once all are.
	let seen = 0;
	const kids = [...(children.get(tabId) ?? new Map<string, Child>())];
	const kidsOf = (sessionId: string | undefined) => kids.filter(([, c]) => c.parent === sessionId);
	const tree = (sessionId: string | undefined) =>
		bounded(cdpSendSession<{ frameTree: TreeNode }>(tabId, sessionId, "Page.getFrameTree"), callMs(end)).then(
			(t) => t?.frameTree,
		);
	/** A session left out with the frame that holds it: its frames and those of every session inside it are counted. */
	const leaveOut = async (sessionId: string, known?: TreeNode | null): Promise<void> => {
		const t = known === undefined ? await tree(sessionId) : known;
		seen += t ? count(t) : 1;
		await Promise.all(kidsOf(sessionId).map(([, c]) => leaveOut(c.sessionId)));
	};
	/** Place a cross-origin frame unless something bars it; a blocked one is placed but read no further. */
	const admit = async (
		frameId: string,
		ownerSessionId: string | undefined,
		url: string,
		around: PageFrame | undefined,
		root: PageFrame | undefined,
		sessionId?: string,
	): Promise<PageFrame | undefined> => {
		if (frames.length >= MAX_PLACED || (around?.chain.length ?? 0) >= MAX_DEPTH) return undefined;
		const bar = await rule(url);
		if (bar === "guarded") return undefined;
		const f = await place(tabId, frameId, ownerSessionId, url, around, root, sessionId, end);
		if (!f) return undefined;
		if (bar === "blocked") f.blocked = true;
		frames.push(f);
		return f;
	};
	/** One session's frame tree, then the out-of-process frames whose <iframe> is in it. */
	const session = async (sessionId: string | undefined, top: TreeNode, root: PageFrame | undefined): Promise<void> => {
		const where = new Map<string, Inside>();
		const visit = async (node: TreeNode, inside: Inside): Promise<void> => {
			seen++;
			where.set(node.frame.id, inside);
			for (const child of node.childFrames ?? []) {
				const url = child.frame.url + (child.frame.urlFragment ?? "");
				const cross =
					originOf(child.frame) !== originOf(node.frame) && !/^(about|data|blob):/.test(child.frame.url);
				if (inside === "out" || !cross) await visit(child, inside);
				// A frame that isn't a web page is left out with everything inside it.
				else if (!web(child.frame.url)) await visit(child, "out");
				else {
					const f = await admit(child.frame.id, sessionId, url, inside, root);
					await visit(child, f && !f.blocked ? f : "out");
				}
			}
		};
		await visit(top, root);
		// Every frame session is asked at once, so frames that don't answer cost one time limit, not one each.
		const asked = await Promise.all(
			kidsOf(sessionId).map(async ([targetId, c]) => {
				// The frame whose document holds this one's <iframe>: what is around it, and whether it is read at all.
				const [owner, sub] = await Promise.all([
					ownerFrame(tabId, sessionId, targetId, top, end),
					tree(c.sessionId),
				]);
				return { targetId, c, owner, sub };
			}),
		);
		for (const { targetId, c, owner, sub } of asked) {
			// An owner the debugger couldn't name (out of time, no answer) may be a guarded or non-web frame:
			// the frame is left out rather than placed as if it sat in the session's own document.
			const inside: Inside = owner !== undefined && where.has(owner) ? where.get(owner) : "out";
			if (!sub) {
				await leaveOut(c.sessionId, null);
				continue;
			}
			const url = sub.frame.url + (sub.frame.urlFragment ?? "");
			const f =
				inside === "out" || !web(url)
					? undefined
					: await admit(targetId, sessionId, url, inside, root, c.sessionId);
			if (!f || f.blocked) await leaveOut(c.sessionId, sub);
			else await session(c.sessionId, sub, f);
		}
	};
	const top = await bounded(cdpSend<{ frameTree: TreeNode }>(tabId, "Page.getFrameTree"), callMs(end));
	if (!top) return { frames, seen: Number.POSITIVE_INFINITY };
	await session(undefined, top.frameTree, undefined);
	return { frames, seen };
}

/** Frames in a subtree, the root included. */
const count = (n: TreeNode): number => 1 + (n.childFrames ?? []).reduce((s, c) => s + count(c), 0);

/**
 * Which frame of a session's tree holds an out-of-process frame's <iframe>: the one whose document
 * the element resolves in. Undefined when the debugger can't say.
 */
async function ownerFrame(
	tabId: number,
	sessionId: string | undefined,
	targetId: string,
	top: TreeNode,
	end?: number,
): Promise<string | undefined> {
	if (!top.childFrames?.length) return top.frame.id;
	const own = await bounded(
		cdpSendSession<{ backendNodeId?: number }>(tabId, sessionId, "DOM.getFrameOwner", { frameId: targetId }),
		callMs(end),
	);
	if (!own?.backendNodeId) return undefined;
	const objects = group();
	const at = await resolveOwner(tabId, sessionId, own.backendNodeId, top, objects, end);
	void cdpSendSession(tabId, sessionId, "Runtime.releaseObjectGroup", { objectGroup: objects }).catch(() => undefined);
	return at?.frameId;
}

/**
 * An element of one session, as an object in Polycarp's world of the frame that holds it (in any
 * other frame's context it resolves to null). The caller releases `objectGroup`.
 */
async function resolveOwner(
	tabId: number,
	sessionId: string | undefined,
	backendNodeId: number,
	top: TreeNode,
	objectGroup: string,
	end?: number,
): Promise<{ frameId: string; objectId: string } | undefined> {
	const all: TreeNode[] = [];
	const walk = (n: TreeNode) => {
		all.push(n);
		for (const c of n.childFrames ?? []) walk(c);
	};
	walk(top);
	for (const n of all) {
		const world = await bounded(
			cdpSendSession<{ executionContextId: number }>(tabId, sessionId, "Page.createIsolatedWorld", {
				frameId: n.frame.id,
				worldName: WORLD,
				grantUniveralAccess: false,
			}),
			callMs(end),
		);
		if (!world) continue;
		const got = await bounded(
			cdpSendSession<{ object?: { subtype?: string; objectId?: string } }>(tabId, sessionId, "DOM.resolveNode", {
				backendNodeId,
				executionContextId: world.executionContextId,
				objectGroup,
			}),
			callMs(end),
		);
		if (got?.object?.objectId && got.object.subtype !== "null")
			return { frameId: n.frame.id, objectId: got.object.objectId };
	}
	return undefined;
}

/**
 * Whether a person can see an <iframe>: "shown"; "hidden" when it is under 4 px either way, not
 * drawn, see-through (its opacity times every box's around it, filters included, under 0.1), kept
 * off the page or covered wherever it is in view; "away" when no part of it is in view, so nothing
 * there can be tested until it is scrolled to. Self-contained: it runs in a page, in read_page's
 * snapshot and, through frameShownNow, before a frame is read and before an action in it.
 */
export function frameShown(el: Element): "shown" | "hidden" | "away" {
	const r = el.getBoundingClientRect();
	if (r.width < 4 || r.height < 4) return "hidden";
	const view = el.ownerDocument.defaultView ?? window;
	const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
	if (check && !check.call(el, { visibilityProperty: true, opacityProperty: true })) return "hidden";
	let alpha = 1;
	for (let n: Element | null = el; n; ) {
		const st = (n.ownerDocument.defaultView ?? view).getComputedStyle(n);
		const own = Number.parseFloat(st.opacity);
		if (Number.isFinite(own)) alpha *= own;
		for (const m of String(st.filter || "").matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g))
			alpha *= m[2] ? Number(m[1]) / 100 : Number(m[1]);
		const up: Node = n.parentElement ?? n.getRootNode();
		n = up.nodeType === 1 ? (up as Element) : ((up as ShadowRoot).host ?? null);
	}
	if (alpha < 0.1) return "hidden";
	if (r.right + view.scrollX <= 0 || r.bottom + view.scrollY <= 0) return "hidden";
	const points = [
		[0.5, 0.5],
		[0.1, 0.1],
		[0.9, 0.1],
		[0.1, 0.9],
		[0.9, 0.9],
	]
		.map(([a, b]) => [r.left + a * r.width, r.top + b * r.height])
		.filter(([x, y]) => x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight);
	if (!points.length) return "away";
	// Hit-tested in its own tree: in a shadow root the document would only ever answer the host.
	const root = el.getRootNode() as Document | ShadowRoot;
	const at = typeof root.elementFromPoint === "function" ? root : el.ownerDocument;
	return points.some(([x, y]) => at.elementFromPoint(x, y) === el) ? "shown" : "hidden";
}

/**
 * Whether the frame and each frame around it is shown (frameShown), tested where its <iframe> is,
 * in Polycarp's world, so the page can't answer for it: "hidden" when any level is, "away" when a
 * level is only out of view, and undefined when the debugger gave no answer by `end`.
 */
export async function frameState(
	tabId: number,
	frame: PageFrame,
	end?: number,
): Promise<"shown" | "hidden" | "away" | undefined> {
	let state: "shown" | "away" = "shown";
	for (const f of frame.chain) {
		const [own, top] = await Promise.all([
			bounded(
				cdpSendSession<{ backendNodeId?: number }>(tabId, f.ownerSessionId, "DOM.getFrameOwner", {
					frameId: f.frameId,
				}),
				callMs(end),
			),
			bounded(cdpSendSession<{ frameTree: TreeNode }>(tabId, f.ownerSessionId, "Page.getFrameTree"), callMs(end)),
		]);
		if (!own?.backendNodeId || !top?.frameTree) return undefined;
		const objects = group();
		const at = await resolveOwner(tabId, f.ownerSessionId, own.backendNodeId, top.frameTree, objects, end);
		const shown = at
			? await bounded(
					cdpSendSession<{ result?: { value?: unknown } }>(tabId, f.ownerSessionId, "Runtime.callFunctionOn", {
						objectId: at.objectId,
						functionDeclaration: `function () { return (${frameShown.toString()})(this); }`,
						returnByValue: true,
					}),
					callMs(end),
				)
			: undefined;
		void cdpSendSession(tabId, f.ownerSessionId, "Runtime.releaseObjectGroup", { objectGroup: objects }).catch(
			() => undefined,
		);
		const value = shown?.result?.value;
		if (value === "hidden") return "hidden";
		if (value === "away") state = "away";
		else if (value !== "shown") return undefined;
	}
	return state;
}

/**
 * Whether the frame and each frame around it is shown. A frame the debugger can't test counts as
 * not shown: it is never read or acted in on no evidence.
 */
export async function frameShownNow(tabId: number, frame: PageFrame, end?: number): Promise<boolean> {
	return (await frameState(tabId, frame, end)) === "shown";
}

/**
 * Where a frame's content box is, in the tab's viewport; undefined when it isn't drawn.
 * `ownerSessionId` holds its <iframe>; `root` is that session's own frame (none for the tab),
 * whose corner the session measures from. `sessionId` is the frame's own, when another process.
 */
async function place(
	tabId: number,
	frameId: string,
	ownerSessionId: string | undefined,
	url: string,
	around: PageFrame | undefined,
	root: PageFrame | undefined,
	sessionId = ownerSessionId,
	end?: number,
): Promise<PageFrame | undefined> {
	const own = await bounded(
		cdpSendSession<{ backendNodeId?: number }>(tabId, ownerSessionId, "DOM.getFrameOwner", { frameId }),
		callMs(end),
	);
	if (!own?.backendNodeId) return undefined;
	const box = await contentBox(tabId, ownerSessionId, own.backendNodeId, end);
	if (!box) return undefined;
	const base = root?.offset ?? { x: 0, y: 0 };
	const baseScale = root?.scale ?? 1;
	const f: PageFrame = {
		tag: frameTag(frameId),
		frameId,
		sessionId,
		ownerSessionId,
		url,
		offset: { x: base.x + baseScale * box.x, y: base.y + baseScale * box.y },
		box: {
			x: base.x + baseScale * box.border.x,
			y: base.y + baseScale * box.border.y,
			width: baseScale * box.border.width,
			height: baseScale * box.border.height,
		},
		base,
		scale: baseScale * box.scale,
		baseScale,
		...(root ? { rootFrameId: root.frameId } : {}),
		chain: [],
	};
	f.chain = [...(around?.chain ?? []), f];
	return f;
}

/** The content box's top left of an element, in its session's viewport, and how much smaller or larger it is drawn. */
async function contentBox(
	tabId: number,
	sessionId: string | undefined,
	backendNodeId: number,
	end?: number,
): Promise<
	{ x: number; y: number; scale: number; border: { x: number; y: number; width: number; height: number } } | undefined
> {
	const [quads, model] = await Promise.all([
		bounded(
			cdpSendSession<{ quads?: number[][] }>(tabId, sessionId, "DOM.getContentQuads", { backendNodeId }),
			callMs(end),
		),
		bounded(
			cdpSendSession<{ model?: { content: number[]; border: number[]; width?: number } }>(
				tabId,
				sessionId,
				"DOM.getBoxModel",
				{ backendNodeId },
			),
			callMs(end),
		),
	]);
	const q = quads?.quads?.[0];
	const m = model?.model;
	if (!q || !m) return undefined;
	// The quad is the box as drawn, the model's width its size in layout: their ratio is the frame's
	// transform. Quads are in the viewport; the box model gives the border and padding inside them.
	const k = q.length >= 4 && m.width ? Math.hypot(q[2] - q[0], q[3] - q[1]) / m.width : 1;
	const scale = Number.isFinite(k) && k > 0 ? k : 1;
	const xs = [q[0], q[2], q[4], q[6]].filter(Number.isFinite);
	const ys = [q[1], q[3], q[5], q[7]].filter(Number.isFinite);
	const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
	return {
		x: q[0] + m.content[0] - m.border[0],
		y: q[1] + m.content[1] - m.border[1],
		scale,
		border: { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top },
	};
}

/** Run page code (an expression that runInPage would wrap) in a frame's isolated world. */
export async function evaluateInFrame(
	tabId: number,
	frame: Pick<PageFrame, "frameId" | "sessionId">,
	expression: string,
): Promise<unknown> {
	const world = await cdpSendSession<{ executionContextId: number }>(
		tabId,
		frame.sessionId,
		"Page.createIsolatedWorld",
		{
			frameId: frame.frameId,
			worldName: WORLD,
			grantUniveralAccess: false,
		},
	);
	const r = await cdpSendSession<{
		result: { value?: unknown };
		exceptionDetails?: { exception?: { description?: string }; text?: string };
	}>(tabId, frame.sessionId, "Runtime.evaluate", {
		expression,
		contextId: world.executionContextId,
		returnByValue: true,
		awaitPromise: true,
	});
	if (r.exceptionDetails)
		throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Evaluation failed");
	return r.result.value;
}

/** Bring a frame's <iframe> (and those around it) into view, outermost first. */
export async function scrollFrameIntoView(tabId: number, frame: PageFrame): Promise<void> {
	for (const f of frame.chain) {
		const own = await bounded(
			cdpSendSession<{ backendNodeId?: number }>(tabId, f.ownerSessionId, "DOM.getFrameOwner", {
				frameId: f.frameId,
			}),
		);
		if (own?.backendNodeId)
			await bounded(
				cdpSendSession(tabId, f.ownerSessionId, "DOM.scrollIntoViewIfNeeded", {
					backendNodeId: own.backendNodeId,
				}),
			);
	}
}

/**
 * Wait until the page has drawn twice (at most 200 ms), after a scroll that moved a frame. The browser routes a
 * click to an out-of-process frame by where it was last drawn, so a click sent sooner can miss it. The wait runs
 * in Polycarp's world of the top document, out of the page's reach, and never past 300 ms here.
 */
export async function framePainted(tabId: number): Promise<void> {
	const wait = (async () => {
		const top = await cdpSend<{ frameTree: TreeNode }>(tabId, "Page.getFrameTree");
		await evaluateInFrame(
			tabId,
			{ frameId: top.frameTree.frame.id },
			"Promise.race([new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))), new Promise((ok) => setTimeout(ok, 200))])",
		);
	})();
	await bounded(wait, 300);
}

/** The most frameTakesPoint may take, all levels together: a slow session refuses the action, not the handler cap. */
export const POINT_MS = 2 * FRAME_CALL_MS;

/**
 * Whether a point in the tab's viewport lands in the frame: at every level, what is drawn there
 * is the frame's own <iframe>. A banner over the frame takes the click instead. Each level is
 * tested from its own stored base, so levels in different sessions are tested at once.
 */
export async function frameTakesPoint(
	tabId: number,
	frame: PageFrame,
	x: number,
	y: number,
	end = Date.now() + POINT_MS,
): Promise<boolean> {
	const level = async (f: PageFrame): Promise<boolean> => {
		const [own, view] = await Promise.all([
			bounded(
				cdpSendSession<{ backendNodeId?: number }>(tabId, f.ownerSessionId, "DOM.getFrameOwner", {
					frameId: f.frameId,
				}),
				callMs(end),
			),
			// The hit test takes document coordinates: on a scrolled page a viewport point is elsewhere, or nowhere.
			bounded(
				cdpSendSession<{ cssLayoutViewport?: { pageX?: number; pageY?: number } }>(
					tabId,
					f.ownerSessionId,
					"Page.getLayoutMetrics",
				),
				callMs(end),
			),
		]);
		if (!own?.backendNodeId || !view?.cssLayoutViewport) return false;
		const base = f.base;
		const hit = await bounded(
			cdpSendSession<{ backendNodeId?: number; frameId?: string }>(
				tabId,
				f.ownerSessionId,
				"DOM.getNodeForLocation",
				{
					// The owner session measures in its own frame's CSS px, drawn at baseScale in the tab.
					x: Math.round((x - base.x) / f.baseScale + (view.cssLayoutViewport.pageX ?? 0)),
					y: Math.round((y - base.y) / f.baseScale + (view.cssLayoutViewport.pageY ?? 0)),
					includeUserAgentShadowDOM: true,
					// A click goes through a layer with pointer-events: none (the in-use veil, a page's
					// own overlay), so the hit test does too.
					ignorePointerEventsNone: false,
				},
			),
			callMs(end),
		);
		// No answer is no evidence the point is clear: the action is not sent on it.
		if (!hit?.backendNodeId) return false;
		if (hit.backendNodeId === own.backendNodeId) return true;
		// A frame in the same process is hit-tested through: the node is inside it, or inside a frame it holds.
		return !!hit.frameId && (await within(tabId, f.ownerSessionId, hit.frameId, f.frameId, end));
	};
	// Levels in one session go in turn (its renderer answers one at a time anyway); sessions go at once.
	const sessions = new Map<string | undefined, PageFrame[]>();
	for (const f of frame.chain) sessions.set(f.ownerSessionId, [...(sessions.get(f.ownerSessionId) ?? []), f]);
	const inTurn = async (fs: PageFrame[]) => {
		for (const f of fs) if (!(await level(f))) return false;
		return true;
	};
	return (await Promise.all([...sessions.values()].map(inTurn))).every(Boolean);
}

/** Whether frame `id` is frame `outer` or inside it, in one session's frame tree. */
async function within(
	tabId: number,
	sessionId: string | undefined,
	id: string,
	outer: string,
	end?: number,
): Promise<boolean> {
	if (id === outer) return true;
	const tree = await bounded(
		cdpSendSession<{ frameTree: TreeNode }>(tabId, sessionId, "Page.getFrameTree"),
		callMs(end),
	);
	const find = (n: TreeNode, inside: boolean): boolean => {
		const here = inside || n.frame.id === outer;
		if (n.frame.id === id) return here;
		return (n.childFrames ?? []).some((c) => find(c, here));
	};
	return tree ? find(tree.frameTree, false) : false;
}

/** A frame's host, as read_page and the errors name it. */
export function frameHost(url: string): string {
	try {
		return new URL(url).host || "(frame)";
	} catch {
		return "(frame)";
	}
}

/** The frame a tagged ref names, among the tab's frames now. One on a host not allowed for agents refuses. */
export async function frameForRef(
	tabId: number,
	ref: string,
	rule: FrameRule = FRAMES_CLOSED,
): Promise<{ frame: PageFrame; inner: string } | undefined> {
	const split = splitFrameRef(ref);
	if (!split) return undefined;
	const frame = (await crossOriginFrames(tabId, rule)).find((f) => f.tag === split.tag);
	if (!frame) throw new Error(`Ref ${ref} not found: its frame is gone or changed. Call read_page for fresh refs.`);
	if (frame.blocked) {
		const host = frameHost(frame.url);
		throw new Error(
			`Not allowed to open ${host}: ref ${ref} is in a frame from a site not allowed for agents. ` +
				`The user can allow it in the Polycarp side panel under Settings > Agents, or with \`polycarp browser allow ${new URL(frame.url).hostname}\`.`,
		);
	}
	return { frame, inner: split.inner };
}

/**
 * Where a frame is now, measured again level by level without looking for the tab's frames again:
 * after a scroll moved it. Undefined when a level has gone.
 */
export async function remeasure(tabId: number, frame: PageFrame): Promise<PageFrame | undefined> {
	const chain: PageFrame[] = [];
	for (const f of frame.chain) {
		// The frame whose session holds this one's <iframe>: the session measures from its corner.
		const root = f.rootFrameId ? chain.find((g) => g.frameId === f.rootFrameId) : undefined;
		if (f.rootFrameId && !root) return undefined;
		const g = await place(tabId, f.frameId, f.ownerSessionId, f.url, chain.at(-1), root, f.sessionId);
		if (!g) return undefined;
		if (f.blocked) g.blocked = true;
		chain.push(g);
	}
	return chain.at(-1);
}
