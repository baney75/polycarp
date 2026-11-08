/**
 * Whether a tab has a password field, in any of its frames. A request sent from such a page may carry
 * the password under any name, so its body is not stored (har.ts, `RequestHint.passwordPage`).
 *
 * The top document is asked first (open shadow roots too). Then every other frame of the tab is asked in
 * an isolated world of its own, which reads the frame's DOM without the page's scripts seeing it. A frame
 * that can't be asked (it left, or it lives in another process) is skipped, except the one the request
 * came from: if that one can't be inspected, the answer is yes. So is the answer when the tab's frames
 * can't be listed.
 */

/** Sends one DevTools command to the tab. */
export type DebuggerSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export const PASSWORD_PAGE = `(() => {
	try {
		const roots = [document];
		for (let n = 0; roots.length && n < 400; n++) {
			const root = roots.pop();
			if (root.querySelector('input[type="password" i]')) return true;
			for (const el of root.querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
		}
		return false;
	} catch {
		return true;
	}
})()`;

/** More frames than this and the tab is not looked through: the answer is yes. */
export const MAX_FRAMES = 64;
const WORLD = "polycarp-capture";

interface FrameTree {
	frame?: { id?: string };
	childFrames?: FrameTree[];
}

/** true or false as the page answered, undefined when the script could not run there. */
async function ask(send: DebuggerSend, contextId?: number): Promise<boolean | undefined> {
	try {
		const r = (await send("Runtime.evaluate", {
			expression: PASSWORD_PAGE,
			returnByValue: true,
			...(contextId === undefined ? {} : { contextId }),
		})) as { result?: { value?: unknown }; exceptionDetails?: unknown };
		const value = r.exceptionDetails ? undefined : r.result?.value;
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

function collect(tree: FrameTree | undefined, into: string[]): void {
	if (!tree) return;
	if (tree.frame?.id) into.push(tree.frame.id);
	for (const child of tree.childFrames ?? []) {
		if (into.length > MAX_FRAMES) return;
		collect(child, into);
	}
}

/**
 * Whether the tab has a password field, or can't be shown to have none. `frameId` is the frame the
 * request came from (`Network.requestWillBeSent` has it).
 */
export async function passwordInTab(send: DebuggerSend, frameId?: string): Promise<boolean> {
	if ((await ask(send)) !== false) return true;
	let ids: string[] = [];
	try {
		const r = (await send("Page.getFrameTree")) as { frameTree?: FrameTree };
		collect(r.frameTree, ids);
		if (ids.length > MAX_FRAMES) return true;
		const top = r.frameTree?.frame?.id;
		if (frameId !== undefined && !ids.includes(frameId)) return true;
		ids = ids.filter((id) => id !== top);
	} catch {
		return true;
	}
	for (const id of ids) {
		let found: boolean | undefined;
		try {
			const world = (await send("Page.createIsolatedWorld", { frameId: id, worldName: WORLD })) as {
				executionContextId?: number;
			};
			found = world.executionContextId === undefined ? undefined : await ask(send, world.executionContextId);
		} catch {
			found = undefined;
		}
		if (found === true || (found === undefined && id === frameId)) return true;
	}
	return false;
}
