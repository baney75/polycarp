/**
 * Cross-origin frames (decision D45). A frame from another origin is closed to the page's own
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
	/** Its <iframe>'s drawn size (CSS px). */
	size: { width: number; height: number };
	/** Where the owner session's viewport starts in the tab's: points sent to it subtract this. */
	base: { x: number; y: number };
	/** The frame and the frames around it, outermost first, for scrolling and cover checks. */
	chain: PageFrame[];
}

/**
 * A cross-origin frame read_page leaves out, and why, so its <iframe> line can say so: a guarded host
 * (no tool reads or acts there), a frame that isn't a web page, or one past MAX_FRAMES or MAX_DEPTH.
 * `box` is where a guarded frame is drawn, so input at a point can't land in it.
 */
export interface LeftFrame {
	tag: string;
	url: string;
	why: "guarded" | "not-web" | "limit";
	box?: { x: number; y: number; width: number; height: number };
}

const WORLD = "polycarp";
/** At most this many frames are read, and this deep: an ad grid can't run up the cost. */
const MAX_FRAMES = 10;
const MAX_DEPTH = 3;

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
			// A frame inside it announces its own frames; its dialogs are the tab's (cdp.ts answers them there).
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
	onDebuggerSessionEnd((tabId) => {
		children.delete(tabId);
		primed.delete(tabId);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		children.delete(tabId);
		primed.delete(tabId);
	});
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
 * its own. `skip` leaves out a frame by URL (the approval page) and everything inside it.
 */
export async function crossOriginFrames(
	tabId: number,
	skip: (url: string) => boolean = () => false,
): Promise<PageFrame[]> {
	return (await frameSurvey(tabId, skip)).frames;
}

/** The frames read_page reads, and those it leaves out with the reason. */
export async function frameSurvey(
	tabId: number,
	skip: (url: string) => boolean = () => false,
): Promise<{ frames: PageFrame[]; left: LeftFrame[] }> {
	await prime(tabId);
	// Announcements arrive just after auto-attach turns on: wait until every frame the browser
	// knows of is accounted for, briefly.
	const expected = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null))?.length ?? 0;
	const until = Date.now() + 300;
	let found: { frames: PageFrame[]; left: LeftFrame[]; seen: number };
	for (;;) {
		found = await collect(tabId, skip);
		if (found.seen >= expected || Date.now() >= until) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	return { frames: found.frames, left: found.left };
}

async function collect(
	tabId: number,
	skip: (url: string) => boolean,
): Promise<{ frames: PageFrame[]; left: LeftFrame[]; seen: number }> {
	const frames: PageFrame[] = [];
	const left: LeftFrame[] = [];
	let seen = 0;
	/** Why a frame isn't read, before it is placed: a guarded one is placed all the same, for its box. */
	const whyNot = (url: string, around: PageFrame | undefined): LeftFrame["why"] | undefined =>
		!web(url)
			? "not-web"
			: skip(url)
				? "guarded"
				: full() || (around?.chain.length ?? 0) >= MAX_DEPTH
					? "limit"
					: undefined;
	const leave = (frameId: string, url: string, why: LeftFrame["why"], f: PageFrame | undefined) =>
		left.push({
			tag: frameTag(frameId),
			url,
			why,
			...(why === "guarded" && f ? { box: { ...f.offset, ...f.size } } : {}),
		});
	const kids = children.get(tabId) ?? new Map<string, Child>();
	const full = () => frames.length >= MAX_FRAMES;
	/** One session's frame tree, then the out-of-process frames whose <iframe> is in it. */
	const session = async (
		sessionId: string | undefined,
		tree: TreeNode,
		root: PageFrame | undefined,
	): Promise<void> => {
		const visit = async (node: TreeNode, around: PageFrame | undefined): Promise<void> => {
			seen++;
			for (const child of node.childFrames ?? []) {
				let inside = around;
				const url = child.frame.url + (child.frame.urlFragment ?? "");
				const cross =
					originOf(child.frame) !== originOf(node.frame) && !/^(about|data|blob):/.test(child.frame.url);
				if (cross) {
					// A frame left out is left out with everything inside it.
					const why = whyNot(child.frame.url, around);
					const f =
						why === "limit" || why === "not-web"
							? undefined
							: await place(tabId, child.frame.id, sessionId, url, around, root);
					if (why) leave(child.frame.id, url, why, f);
					if (!f || why) {
						seen += count(child);
						continue;
					}
					frames.push(f);
					inside = f;
				}
				await visit(child, inside);
			}
		};
		await visit(tree, root);
		for (const [targetId, c] of kids) {
			if (c.parent !== sessionId) continue;
			const sub = await cdpSendSession<{ frameTree: TreeNode }>(tabId, c.sessionId, "Page.getFrameTree").catch(
				() => undefined,
			);
			if (!sub) continue;
			const top = sub.frameTree;
			const url = top.frame.url + (top.frame.urlFragment ?? "");
			const why = whyNot(url, root);
			const f =
				why === "limit" || why === "not-web"
					? undefined
					: await place(tabId, targetId, sessionId, url, root, root, c.sessionId);
			if (why) leave(targetId, url, why, f);
			if (!f || why) {
				seen += count(top);
				continue;
			}
			frames.push(f);
			await session(c.sessionId, top, f);
		}
	};
	const top = await cdpSend<{ frameTree: TreeNode }>(tabId, "Page.getFrameTree");
	await session(undefined, top.frameTree, undefined);
	return { frames, left, seen };
}

/** Frames in a subtree, the root included. */
const count = (n: TreeNode): number => 1 + (n.childFrames ?? []).reduce((s, c) => s + count(c), 0);

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
	const own = await cdpSendSession<{ backendNodeId?: number }>(tabId, ownerSessionId, "DOM.getFrameOwner", {
		frameId,
	}).catch(() => undefined);
	if (!own?.backendNodeId) return undefined;
	const box = await contentBox(tabId, ownerSessionId, own.backendNodeId);
	if (!box) return undefined;
	const base = root?.offset ?? { x: 0, y: 0 };
	const f: PageFrame = {
		tag: frameTag(frameId),
		frameId,
		sessionId,
		ownerSessionId,
		url,
		offset: { x: base.x + box.x, y: base.y + box.y },
		size: { width: box.width, height: box.height },
		base,
		chain: [],
	};
	f.chain = [...(around?.chain ?? []), f];
	return f;
}

/** The content box's top left of an element, in its session's viewport. */
async function contentBox(
	tabId: number,
	sessionId: string | undefined,
	backendNodeId: number,
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
	const quads = await cdpSendSession<{ quads?: number[][] }>(tabId, sessionId, "DOM.getContentQuads", {
		backendNodeId,
	}).catch(() => undefined);
	const model = await cdpSendSession<{ model?: { content: number[]; border: number[] } }>(
		tabId,
		sessionId,
		"DOM.getBoxModel",
		{ backendNodeId },
	).catch(() => undefined);
	const q = quads?.quads?.[0];
	if (!q || !model?.model) return undefined;
	// Quads are in the viewport; the box model gives the border and padding inside them. The size is
	// the drawn border box's, the most input could land in.
	return {
		x: q[0] + model.model.content[0] - model.model.border[0],
		y: q[1] + model.model.content[1] - model.model.border[1],
		width: Math.max(...q.filter((_, i) => i % 2 === 0)) - Math.min(...q.filter((_, i) => i % 2 === 0)),
		height: Math.max(...q.filter((_, i) => i % 2 === 1)) - Math.min(...q.filter((_, i) => i % 2 === 1)),
	};
}

/** Run page code (an expression that runInPage would wrap) in a frame's isolated world. */
export async function evaluateInFrame(tabId: number, frame: PageFrame, expression: string): Promise<unknown> {
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

/** The frame a tagged ref names, among the tab's frames now. */
export async function frameForRef(
	tabId: number,
	ref: string,
	skip?: (url: string) => boolean,
): Promise<{ frame: PageFrame; inner: string } | undefined> {
	const split = splitFrameRef(ref);
	if (!split) return undefined;
	const { frames, left } = await frameSurvey(tabId, skip);
	const frame = frames.find((f) => f.tag === split.tag);
	const guarded = left.find((l) => l.tag === split.tag && l.why === "guarded");
	if (guarded)
		throw new Error(`Ref ${ref} is in a frame on a guarded host (${hostOf(guarded.url)}): no tool acts there.`);
	if (!frame) throw new Error(`Ref ${ref} not found: its frame is gone or changed. Call read_page for fresh refs.`);
	return { frame, inner: split.inner };
}

const hostOf = (url: string) => {
	try {
		return new URL(url).host;
	} catch {
		return url.slice(0, 80);
	}
};

/**
 * The URL of a guarded frame drawn at a point of the tab's viewport (CSS px), if any: input at a point
 * never lands there, even when the page around it is open (a site framing the approval page).
 */
export async function guardedFrameAt(
	tabId: number,
	x: number,
	y: number,
	skip: (url: string) => boolean,
): Promise<string | undefined> {
	// A page with no frame is the common case: one cheap call, no survey.
	const all = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
	if (all && all.length <= 1) return undefined;
	const { left } = await frameSurvey(tabId, skip);
	return left.find(({ why, box }) => {
		return why === "guarded" && box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
	})?.url;
}
