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
	/** Where the owner session's viewport starts in the tab's: points sent to it subtract this. */
	base: { x: number; y: number };
	/** Tab CSS px per frame CSS px: below 1 for a frame drawn smaller (a transform). */
	scale: number;
	/** The same for the owner session's viewport (1 for the tab's own). */
	baseScale: number;
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

const WORLD = "polycarp";
/** At most this many frames are read (readFrames in page.ts), and this deep: an ad grid can't run up the cost. */
export const MAX_FRAMES = 10;
const MAX_DEPTH = 3;
/** Frames placed per look, hidden ones included: those read are picked from them by what the page shows. */
const MAX_PLACED = 30;
/** The most one debugger call about a frame may take: a frame that doesn't answer is left out, not waited on. */
export const FRAME_CALL_MS = 1000;

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
/** Per tab, the frame session an open alert/confirm/prompt came from: only that session can answer it. */
const dialogs = new Map<number, string>();
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
			// A frame inside it announces its own frames. A box it opens is answered in its session (dialogSession).
			void cdpSendSession(tabId, p.sessionId, "Target.setAutoAttach", AUTO).catch(() => undefined);
			void cdpSendSession(tabId, p.sessionId, "Page.enable").catch(() => undefined);
		} else if (method === "Target.detachedFromTarget") {
			const p = params as { sessionId?: string };
			const map = children.get(tabId);
			for (const [id, c] of map ?? []) if (c.sessionId === p.sessionId) map?.delete(id);
		} else if (method === "Page.javascriptDialogOpening") {
			if (source.sessionId) dialogs.set(tabId, source.sessionId);
			else dialogs.delete(tabId);
		} else if (method === "Page.javascriptDialogClosed") {
			dialogs.delete(tabId);
		} else if (method === "Target.targetInfoChanged") {
			const p = params as { targetInfo?: { targetId?: string; url?: string } };
			const c = p.targetInfo?.targetId ? children.get(tabId)?.get(p.targetInfo.targetId) : undefined;
			if (c && p.targetInfo?.url) c.url = p.targetInfo.url;
		}
	});
	const forget = (tabId: number) => {
		children.delete(tabId);
		primed.delete(tabId);
		dialogs.delete(tabId);
	};
	onDebuggerSessionEnd(forget);
	chrome.tabs.onRemoved.addListener(forget);
}

/** The frame session the tab's open dialog came from, for cdp.ts answerDialog; none for the tab's own. */
export function dialogSession(tabId: number): string | undefined {
	return dialogs.get(tabId);
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
const web = (url: string) => /^(https?|file):/.test(url);

/**
 * The tab's cross-origin frames, outermost first: each frame whose origin differs from the
 * document around it. A same-origin frame inside one is read with it, as the top document reads
 * its own. `rule` bars a frame by URL: a guarded one is left out with everything inside it, a
 * blocked one is placed (so read_page can name it) and nothing inside it is.
 */
export async function crossOriginFrames(tabId: number, rule: FrameRule = () => undefined): Promise<PageFrame[]> {
	await prime(tabId);
	// Announcements arrive just after auto-attach turns on: wait until every frame the browser
	// knows of is accounted for, briefly.
	const expected = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null))?.length ?? 0;
	const until = Date.now() + 300;
	let found: { frames: PageFrame[]; seen: number };
	for (;;) {
		found = await collect(tabId, rule);
		if (found.seen >= expected || Date.now() >= until) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	return found.frames;
}

/** Where a frame's contents stand: inside this frame (none: the tab's own document), or "out" (not read). */
type Inside = PageFrame | undefined | "out";

async function collect(tabId: number, rule: FrameRule): Promise<{ frames: PageFrame[]; seen: number }> {
	const frames: PageFrame[] = [];
	// Every frame looked at or left out is counted, so the caller stops waiting once all are.
	let seen = 0;
	const kids = [...(children.get(tabId) ?? new Map<string, Child>())];
	const kidsOf = (sessionId: string | undefined) => kids.filter(([, c]) => c.parent === sessionId);
	const tree = (sessionId: string | undefined) =>
		bounded(cdpSendSession<{ frameTree: TreeNode }>(tabId, sessionId, "Page.getFrameTree")).then((t) => t?.frameTree);
	/** A session left out with the frame that holds it: its frames and those of every session inside it are counted. */
	const leaveOut = async (sessionId: string, known?: TreeNode | null): Promise<void> => {
		const t = known === undefined ? await tree(sessionId) : known;
		seen += t ? count(t) : 1;
		for (const [, c] of kidsOf(sessionId)) await leaveOut(c.sessionId);
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
		const f = await place(tabId, frameId, ownerSessionId, url, around, root, sessionId);
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
		for (const [targetId, c] of kidsOf(sessionId)) {
			// The frame whose document holds this one's <iframe>: what is around it, and whether it is read at all.
			const owner = await ownerFrame(tabId, sessionId, targetId, top);
			const inside: Inside = owner !== undefined && where.has(owner) ? where.get(owner) : root;
			const sub = await tree(c.sessionId);
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
	const top = await cdpSend<{ frameTree: TreeNode }>(tabId, "Page.getFrameTree");
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
): Promise<string | undefined> {
	if (!top.childFrames?.length) return top.frame.id;
	const own = await bounded(
		cdpSendSession<{ backendNodeId?: number }>(tabId, sessionId, "DOM.getFrameOwner", { frameId: targetId }),
	);
	if (!own?.backendNodeId) return undefined;
	const at = await resolveOwner(tabId, sessionId, own.backendNodeId, top);
	if (at)
		void cdpSendSession(tabId, sessionId, "Runtime.releaseObjectGroup", { objectGroup: WORLD }).catch(
			() => undefined,
		);
	return at?.frameId;
}

/**
 * An element of one session, as an object in Polycarp's world of the frame that holds it (in any
 * other frame's context it resolves to null). The caller releases the WORLD object group.
 */
async function resolveOwner(
	tabId: number,
	sessionId: string | undefined,
	backendNodeId: number,
	top: TreeNode,
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
		);
		if (!world) continue;
		const got = await bounded(
			cdpSendSession<{ object?: { subtype?: string; objectId?: string } }>(tabId, sessionId, "DOM.resolveNode", {
				backendNodeId,
				executionContextId: world.executionContextId,
				objectGroup: WORLD,
			}),
		);
		if (got?.object?.objectId && got.object.subtype !== "null")
			return { frameId: n.frame.id, objectId: got.object.objectId };
	}
	return undefined;
}

/**
 * Whether a person can see an <iframe>: at least 4 px each way, drawn (not hidden or see-through,
 * on it or above it), not kept off the page, and not fully covered. Self-contained: it runs in a
 * page, in read_page's snapshot and, through frameShownNow, before an action in the frame.
 */
export function frameShown(el: Element): boolean {
	const r = el.getBoundingClientRect();
	if (r.width < 4 || r.height < 4) return false;
	const view = el.ownerDocument.defaultView ?? window;
	const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
	if (check && !check.call(el, { visibilityProperty: true, opacityProperty: true })) return false;
	if (r.right + view.scrollX <= 0 || r.bottom + view.scrollY <= 0) return false;
	const points = [
		[0.5, 0.5],
		[0.1, 0.1],
		[0.9, 0.1],
		[0.1, 0.9],
		[0.9, 0.9],
	]
		.map(([a, b]) => [r.left + a * r.width, r.top + b * r.height])
		.filter(([x, y]) => x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight);
	// Out of view (below the fold): nothing to test until it is scrolled to.
	return !points.length || points.some(([x, y]) => el.ownerDocument.elementFromPoint(x, y) === el);
}

/**
 * Whether the frame and each frame around it is still shown (frameShown), tested where its
 * <iframe> is, in Polycarp's world, so the page can't answer for it. A frame the debugger
 * can't find there is no evidence either way, as in frameTakesPoint.
 */
export async function frameShownNow(tabId: number, frame: PageFrame): Promise<boolean> {
	for (const f of frame.chain) {
		const own = await bounded(
			cdpSendSession<{ backendNodeId?: number }>(tabId, f.ownerSessionId, "DOM.getFrameOwner", {
				frameId: f.frameId,
			}),
		);
		const top = await bounded(cdpSendSession<{ frameTree: TreeNode }>(tabId, f.ownerSessionId, "Page.getFrameTree"));
		if (!own?.backendNodeId || !top?.frameTree) continue;
		const at = await resolveOwner(tabId, f.ownerSessionId, own.backendNodeId, top.frameTree);
		if (!at) continue;
		const shown = await bounded(
			cdpSendSession<{ result?: { value?: unknown } }>(tabId, f.ownerSessionId, "Runtime.callFunctionOn", {
				objectId: at.objectId,
				functionDeclaration: `function () { return (${frameShown.toString()})(this); }`,
				returnByValue: true,
			}),
		);
		void cdpSendSession(tabId, f.ownerSessionId, "Runtime.releaseObjectGroup", { objectGroup: WORLD }).catch(
			() => undefined,
		);
		if (shown?.result?.value === false) return false;
	}
	return true;
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
): Promise<PageFrame | undefined> {
	const own = await bounded(
		cdpSendSession<{ backendNodeId?: number }>(tabId, ownerSessionId, "DOM.getFrameOwner", { frameId }),
	);
	if (!own?.backendNodeId) return undefined;
	const box = await contentBox(tabId, ownerSessionId, own.backendNodeId);
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
		base,
		scale: baseScale * box.scale,
		baseScale,
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
): Promise<{ x: number; y: number; scale: number } | undefined> {
	const quads = await bounded(
		cdpSendSession<{ quads?: number[][] }>(tabId, sessionId, "DOM.getContentQuads", { backendNodeId }),
	);
	const model = await bounded(
		cdpSendSession<{ model?: { content: number[]; border: number[]; width?: number } }>(
			tabId,
			sessionId,
			"DOM.getBoxModel",
			{ backendNodeId },
		),
	);
	const q = quads?.quads?.[0];
	const m = model?.model;
	if (!q || !m) return undefined;
	// The quad is the box as drawn, the model's width its size in layout: their ratio is the frame's
	// transform. Quads are in the viewport; the box model gives the border and padding inside them.
	const k = q.length >= 4 && m.width ? Math.hypot(q[2] - q[0], q[3] - q[1]) / m.width : 1;
	return {
		x: q[0] + m.content[0] - m.border[0],
		y: q[1] + m.content[1] - m.border[1],
		scale: Number.isFinite(k) && k > 0 ? k : 1,
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
		const own = await cdpSendSession<{ backendNodeId?: number }>(tabId, f.ownerSessionId, "DOM.getFrameOwner", {
			frameId: f.frameId,
		}).catch(() => undefined);
		if (own?.backendNodeId)
			await cdpSendSession(tabId, f.ownerSessionId, "DOM.scrollIntoViewIfNeeded", {
				backendNodeId: own.backendNodeId,
			}).catch(() => undefined);
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

/**
 * Whether a point in the tab's viewport lands in the frame: at every level, what is drawn there
 * is the frame's own <iframe>. A banner over the frame takes the click instead.
 */
export async function frameTakesPoint(tabId: number, frame: PageFrame, x: number, y: number): Promise<boolean> {
	for (const f of frame.chain) {
		const own = await cdpSendSession<{ backendNodeId?: number }>(tabId, f.ownerSessionId, "DOM.getFrameOwner", {
			frameId: f.frameId,
		}).catch(() => undefined);
		const base = f.base;
		const hit = await cdpSendSession<{ backendNodeId?: number; frameId?: string }>(
			tabId,
			f.ownerSessionId,
			"DOM.getNodeForLocation",
			{
				x: Math.round(x - base.x),
				y: Math.round(y - base.y),
				includeUserAgentShadowDOM: true,
				// A click goes through a layer with pointer-events: none (the in-use veil, a page's
				// own overlay), so the hit test does too.
				ignorePointerEventsNone: false,
			},
		).catch(() => undefined);
		// No answer: no evidence of a cover, as with a frame the browser won't hit-test.
		if (!own?.backendNodeId || !hit?.backendNodeId || hit.backendNodeId === own.backendNodeId) continue;
		// A frame in the same process is hit-tested through: the node is inside it, or inside a frame it holds.
		if (hit.frameId && (await within(tabId, f.ownerSessionId, hit.frameId, f.frameId))) continue;
		return false;
	}
	return true;
}

/** Whether frame `id` is frame `outer` or inside it, in one session's frame tree. */
async function within(tabId: number, sessionId: string | undefined, id: string, outer: string): Promise<boolean> {
	if (id === outer) return true;
	const tree = await cdpSendSession<{ frameTree: TreeNode }>(tabId, sessionId, "Page.getFrameTree").catch(
		() => undefined,
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
	rule?: FrameRule,
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
