/**
 * How a page read looks to a model: one compact line per element, then the text. The MCP server
 * (cli/src/mcp.ts) and the side panel's own tools (src/bridge/page-tools.ts) print reads with these,
 * so both models see the same refs in the same words.
 */

export interface SnapNode {
	ref: string;
	role: string;
	name: string;
	value?: string;
	href?: string;
	visible: boolean;
	/** expanded, pressed, selected, checked, disabled, ... */
	states?: string[];
	/** The same-origin frame the element is in. */
	frame?: string;
}

export interface Snapshot {
	url: string;
	title: string;
	viewport: { width: number; height: number; scrollY: number; pageHeight: number };
	nodes: SnapNode[];
	text: string;
}

/** Page-supplied text on one line: a URL or frame label can't start a fake element line. */
export const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, " ");

/** One line per element; same-origin links shortened to their path. */
export function formatNodes(nodes: SnapNode[], pageUrl: string): string {
	let origin = "";
	try {
		origin = new URL(pageUrl).origin;
	} catch {
		/* no origin */
	}
	return nodes
		.map((n) => {
			let line = `${n.ref} ${oneLine(n.role)} ${JSON.stringify(oneLine(n.name))}`;
			if (n.value) line += ` value=${JSON.stringify(oneLine(n.value))}`;
			if (n.states?.length) line += ` [${oneLine(n.states.join(", "))}]`;
			if (n.href)
				line += ` -> ${oneLine(origin && n.href.startsWith(origin) ? n.href.slice(origin.length) || "/" : n.href)}`;
			if (n.frame) line += ` (in frame ${JSON.stringify(oneLine(n.frame))})`;
			if (!n.visible) line += " (offscreen)";
			return line;
		})
		.join("\n");
}

/** read_page as compact text: a fraction of the tokens of pretty JSON, same information. */
export function formatSnapshot(snap: Snapshot, actWith = "click/type/fill/scroll"): string {
	const v = snap.viewport;
	const parts = [
		`Page: ${snap.title} | ${snap.url}`,
		`Viewport ${v.width}x${v.height}, scrollY ${v.scrollY} of ${v.pageHeight}`,
		`Elements (${snap.nodes.length}; use the ref with ${actWith}):`,
		formatNodes(snap.nodes, snap.url),
	];
	if (snap.text) parts.push("", "Text:", snap.text);
	return parts.join("\n");
}
